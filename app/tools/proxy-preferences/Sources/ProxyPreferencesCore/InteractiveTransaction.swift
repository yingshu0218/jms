import Foundation
import CryptoKit

/// A future platform implementation must release the SC session before releasing
/// its short-lived authorization reference. The source-only system provider is
/// not selected by the default runner, CLI, or Candidate.
public protocol InteractiveAuthorizationProvider {
    func withStore<T>(_ body: (PreferencesStore) throws -> T) throws -> T
}
public final class UnavailableInteractiveAuthorization: InteractiveAuthorizationProvider {
    public init() {}
    public func withStore<T>(_ body: (PreferencesStore) throws -> T) throws -> T { throw Failure(.authorizationRequired, .no) }
}
public struct InteractivePreparedState: Codable {
    public let original: Snapshot, target: Snapshot, current: Snapshot, desired: Snapshot
}
public struct InteractivePreparedResponse: Encodable {
    public let ok = true
    public let phase = "prepared"
    public let operationId: String, planDigest: String, preparedDigest: String, preparedData: String
}
public struct InteractiveFinishedResponse: Encodable {
    public let ok = true
    public let phase = "finished"
    public let operationId: String, planDigest: String, preparedDigest: String
    public let snapshot: Snapshot, verifiedSnapshot: Snapshot
    public let committed = true, applied = true
}
private struct InteractiveRequest: Decodable {
    let operation: String, operationId: String, planDigest: String, planData: String
}
private struct InteractivePlan: Decodable {
    let version: Int
    let launchId: String, operationId: String, action: String
    let target: Target?
    let original: Snapshot?, proxyTarget: Snapshot?, expected: Snapshot?
}
private struct InteractivePermit: Decodable {
    let operation: String, operationId: String, planDigest: String, preparedDigest: String
}

/// Pure injectable transaction model. Ordinary builds/tests never obtain system
/// authorization. The future pipe adapter must bound its read by the supplied
/// monotonic deadline; the runner also rejects a response arriving after it.
public final class InteractiveTransactionRunner {
    public static let maximumBytes = 8 * 1024 * 1024
    private let authorizer: InteractiveAuthorizationProvider
    private let now: () -> TimeInterval
    private var consumed = false
    public init(authorizer: InteractiveAuthorizationProvider = UnavailableInteractiveAuthorization(),
                now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.authorizer = authorizer; self.now = now
    }
    public static func digest(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    public func run(request bytes: Data,
                    awaitCommit: (InteractivePreparedResponse, TimeInterval) throws -> Data) throws -> InteractiveFinishedResponse {
        guard !consumed else { throw Failure(.invalidRequest, .no) }
        consumed = true
        let request: InteractiveRequest = try decode(bytes, keys: ["operation", "operationId", "planDigest", "planData"])
        guard request.operation == "interactivePrepare", validID(request.operationId),
              validDigest(request.planDigest), let planBytes = strictBase64(request.planData),
              Self.digest(planBytes) == request.planDigest else { throw Failure(.invalidRequest, .no) }
        let planObject = try object(planBytes)
        guard let action = planObject["action"] as? String else { throw Failure(.invalidRequest, .no) }
        let keys: Set<String> = action == "apply"
            ? ["version", "launchId", "operationId", "action", "target", "expected"]
            : ["version", "launchId", "operationId", "action", "original", "proxyTarget"]
        let plan: InteractivePlan = try decode(planBytes, keys: keys)
        guard plan.version == 1, validID(plan.launchId), plan.operationId == request.operationId,
              ["apply", "restore"].contains(plan.action) else { throw Failure(.invalidRequest, .no) }
        if plan.action == "apply" {
            guard let target = plan.target, let expected = plan.expected else { throw Failure(.invalidRequest, .no) }
            guard let rawTarget = planObject["target"] as? [String: Any], Set(rawTarget.keys) == ["host", "port", "bypass"] else { throw Failure(.invalidRequest, .no) }
            try strictSnapshotObject(planObject["expected"]); try expected.validate()
            try validateTarget(target)
        } else {
            guard let original = plan.original, let target = plan.proxyTarget else { throw Failure(.invalidRequest, .no) }
            try strictSnapshotObject(planObject["original"]); try strictSnapshotObject(planObject["proxyTarget"])
            try original.validate(); try target.validate()
            guard sameIdentities(original, target) else { throw Failure(.invalidRequest, .no) }
        }
        do {
            return try authorizer.withStore { store in
                try execute(store: store, plan: plan, request: request, awaitCommit: awaitCommit)
            }
        } catch let failure as Failure { throw failure }
        catch { throw Failure(.unsupported, .unknown) }
    }
    private func execute(store: PreferencesStore, plan: InteractivePlan, request: InteractiveRequest,
                         awaitCommit: (InteractivePreparedResponse, TimeInterval) throws -> Data) throws -> InteractiveFinishedResponse {
        do { try store.lock() } catch let failure as Failure { throw failure }
        catch { throw Failure(.conflict, .no) }
        defer { store.synchronize(); store.unlock() }
        store.synchronize()
        let current = try store.read(); try current.validate()
        let original: Snapshot, target: Snapshot, desired: Snapshot
        if plan.action == "apply" {
            // Consent binds the pre-authorization observation. Never silently
            // replace it with a new state observed after an authorization wait.
            guard let expected = plan.expected, try current.same(as: expected) else { throw Failure(.conflict, .no) }
            original = expected
            target = try applying(plan.target!, to: original)
            desired = target
        } else {
            original = plan.original!; target = plan.proxyTarget!; desired = original
            guard try current.same(as: original) || current.same(as: target) else { throw Failure(.conflict, .no) }
        }
        let state = InteractivePreparedState(original: original, target: target, current: current, desired: desired)
        let preparedBytes = try JSONEncoder().encode(state)
        guard preparedBytes.count <= Self.maximumBytes else { throw Failure(.invalidRequest, .no) }
        let prepared = InteractivePreparedResponse(operationId: request.operationId, planDigest: request.planDigest,
            preparedDigest: Self.digest(preparedBytes), preparedData: preparedBytes.base64EncodedString())
        guard try JSONEncoder().encode(prepared).count <= Self.maximumBytes else { throw Failure(.invalidRequest, .no) }
        let deadline = now() + 5
        let ack: Data
        do { ack = try awaitCommit(prepared, deadline) }
        catch { throw Failure(.cancelled, .no) }
        guard now() < deadline else { throw Failure(.commitPermissionTimeout, .no) }
        let permit: InteractivePermit = try decode(ack, keys: ["operation", "operationId", "planDigest", "preparedDigest"])
        guard permit.operationId == request.operationId, permit.planDigest == request.planDigest,
              permit.preparedDigest == prepared.preparedDigest else { throw Failure(.invalidRequest, .no) }
        if permit.operation == "interactiveAbort" { throw Failure(.cancelled, .no) }
        guard permit.operation == "interactiveCommit" else { throw Failure(.invalidRequest, .no) }
        // Recheck while still holding the same lock. A fake store or uncooperative
        // writer must not turn the journal ACK delay into a stale overwrite.
        guard try store.read().same(as: current) else { throw Failure(.conflict, .no) }
        do { for service in desired.services { try store.write(id: service.id, proxies: service.proxies) } }
        catch { throw Failure(.commitFailed, .no) }
        guard store.commit() else { throw Failure(.commitFailed, .unknown) }
        guard store.apply() else { throw Failure(.applyFailed, .yes) }
        let first: Snapshot, second: Snapshot
        do {
            store.synchronize(); first = try store.read(); try first.validate()
            guard try first.same(as: desired) else { throw Failure(.readbackFailed, .yes) }
            store.synchronize(); second = try store.read(); try second.validate()
            guard try second.same(as: desired) else { throw Failure(.readbackFailed, .yes) }
        } catch { throw Failure(.readbackFailed, .yes) }
        return InteractiveFinishedResponse(operationId: request.operationId, planDigest: request.planDigest,
            preparedDigest: prepared.preparedDigest, snapshot: first, verifiedSnapshot: second)
    }
    private func applying(_ target: Target, to original: Snapshot) throws -> Snapshot {
        var desired = original
        for i in desired.services.indices {
            var dictionary = try desired.services[i].proxies.dictionary() ?? [:]
            for prefix in ["HTTP", "HTTPS", "SOCKS"] {
                dictionary[prefix + "Enable"] = 1; dictionary[prefix + "Proxy"] = target.host; dictionary[prefix + "Port"] = target.port
            }
            dictionary["ProxyAutoConfigEnable"] = 0; dictionary["ProxyAutoDiscoveryEnable"] = 0
            dictionary["ExceptionsList"] = target.bypass
            desired.services[i].proxies = try RawProxies(dictionary)
        }
        return desired
    }
    private func validateTarget(_ target: Target) throws {
        guard target.host == "127.0.0.1", (1...65535).contains(target.port), target.bypass.count <= 256,
              target.bypass.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 && !$0.contains("\n") && !$0.contains("\0") }) else { throw Failure(.invalidRequest, .no) }
    }
    private func strictSnapshotObject(_ raw: Any?) throws {
        guard let value = raw as? [String: Any], Set(value.keys) == ["schema", "services"],
              let services = value["services"] as? [[String: Any]] else { throw Failure(.invalidRequest, .no) }
        for service in services {
            guard Set(service.keys) == ["id", "name", "device", "proxies"],
                  let proxies = service["proxies"] as? [String: Any], Set(proxies.keys) == ["present", "blob"] else { throw Failure(.invalidRequest, .no) }
        }
    }
    private func sameIdentities(_ a: Snapshot, _ b: Snapshot) -> Bool {
        let identity: (Service) -> String = { "\($0.id.utf8.count):\($0.id)\($0.name.utf8.count):\($0.name)\($0.device.utf8.count):\($0.device)" }
        return a.services.map(identity).sorted() == b.services.map(identity).sorted()
    }
    private func validID(_ value: String) -> Bool { UUID(uuidString: value) != nil }
    private func validDigest(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
    private func strictBase64(_ value: String) -> Data? {
        guard value.utf8.count <= Self.maximumBytes, let bytes = Data(base64Encoded: value),
              bytes.base64EncodedString() == value, String(data: bytes, encoding: .utf8) != nil else { return nil }
        return bytes
    }
    private func object(_ bytes: Data) throws -> [String: Any] {
        guard bytes.count <= Self.maximumBytes else { throw Failure(.invalidRequest, .no) }
        try rejectDuplicateKeys(bytes)
        guard let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw Failure(.invalidRequest, .no) }
        return value
    }
    // JSONSerialization/JSONDecoder otherwise accept repeated object keys. Scan
    // strings structurally first, then let Foundation validate the full grammar.
    private func rejectDuplicateKeys(_ data: Data) throws {
        struct Frame { let object: Bool; var expectsKey = true; var keys = Set<String>() }
        let bytes = Array(data)
        var stack: [Frame] = [], index = 0
        while index < bytes.count {
            switch bytes[index] {
            case 123, 91: // { [
                guard stack.count < 64 else { throw Failure(.invalidRequest, .no) }
                stack.append(Frame(object: bytes[index] == 123)); index += 1
            case 125, 93:
                guard !stack.isEmpty else { throw Failure(.invalidRequest, .no) }
                stack.removeLast(); index += 1
            case 44:
                if !stack.isEmpty && stack[stack.count - 1].object { stack[stack.count - 1].expectsKey = true }
                index += 1
            case 34:
                let start = index; index += 1
                var closed = false
                while index < bytes.count {
                    if bytes[index] == 92 { index += 2; continue }
                    if bytes[index] == 34 { index += 1; closed = true; break }
                    index += 1
                }
                guard closed else { throw Failure(.invalidRequest, .no) }
                if !stack.isEmpty && stack[stack.count - 1].object && stack[stack.count - 1].expectsKey {
                    guard let key = try? JSONDecoder().decode(String.self, from: Data(bytes[start..<index])),
                          stack[stack.count - 1].keys.insert(key).inserted else { throw Failure(.invalidRequest, .no) }
                    stack[stack.count - 1].expectsKey = false
                }
            default: index += 1
            }
        }
        guard stack.isEmpty else { throw Failure(.invalidRequest, .no) }
    }
    private func decode<T: Decodable>(_ bytes: Data, keys: Set<String>) throws -> T {
        guard Set(try object(bytes).keys) == keys,
              let value = try? JSONDecoder().decode(T.self, from: bytes) else { throw Failure(.invalidRequest, .no) }
        return value
    }
}
