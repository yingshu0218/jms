import Foundation
import CoreFoundation
import CryptoKit

/// A user action grants one prepare and one exact commit, never general helper access.
/// All state is local; this type performs no IPC, authorization or system writes.
struct NativeProxyUserActionGate {
    enum Phase: Equatable { case idle, preparing, prepareInFlight, prepared, committing, finished, revoked }
    private(set) var phase: Phase = .idle
    private(set) var commitPermitted = false
    private(set) var activeOperationId: String?
    private var launchId = "", action = "", planDigest = "", preparedDigest = ""
    private var deadline: Double = 0
    private var consumed = Set<String>()
    private var blocked = false
    var recoveryRequired: Bool { blocked }
    private var helperSucceeded = false
    private var desiredData: Data?
    private let isolated: Bool
    private let now: () -> Double
    init(isolated: Bool, now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }) {
        self.isolated = isolated; self.now = now
    }
    mutating func begin(launchId: String, operationId: String, action: String, helperInactive: Bool = false) throws {
        guard !isolated else { throw Self.error("ISOLATED") }
        guard activeOperationId == nil, !blocked || (action == "disconnect" && helperInactive) else { throw Self.error("OPERATION_BUSY") }
        guard UUID(uuidString: launchId) != nil, UUID(uuidString: operationId) != nil,
              ["connect", "disconnect"].contains(action), !consumed.contains(operationId), consumed.count < 1024 else { throw Self.error() }
        consumed.insert(operationId)
        self.launchId = launchId; activeOperationId = operationId; self.action = action
        planDigest = ""; preparedDigest = ""; commitPermitted = false; helperSucceeded = false; desiredData = nil
        phase = .preparing; deadline = now() + 240
    }
    mutating func validateHelperRequest(_ frame: [String: Any]) throws -> [String: Any] {
        do {
            try checkTime()
            guard Self.keys(frame, ["version", "type", "launchId", "operationId", "sequence", "planDigest", "request"]),
                  Self.integer(frame["version"]) == 1, frame["type"] as? String == "helper",
                  frame["launchId"] as? String == launchId, frame["operationId"] as? String == activeOperationId,
                  let digest = frame["planDigest"] as? String, Self.digestValid(digest),
                  let request = frame["request"] as? [String: Any],
                  request["operationId"] as? String == activeOperationId, request["planDigest"] as? String == digest else { throw Self.error() }
            let sequence = Self.integer(frame["sequence"])
            if sequence == 1 {
                guard phase == .preparing, Self.keys(request, ["operation", "operationId", "planDigest", "planData"]),
                      request["operation"] as? String == "interactivePrepare" else { throw Self.error() }
                let data = try Self.checkedData(request["planData"], digest: digest)
                guard let plan = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      Self.integer(plan["version"]) == 1, plan["launchId"] as? String == launchId,
                      plan["operationId"] as? String == activeOperationId else { throw Self.error() }
                if action == "connect" {
                    guard Self.keys(plan, ["version", "launchId", "operationId", "action", "target", "expected"]),
                          plan["action"] as? String == "apply", Self.snapshot(plan["expected"]), let target = plan["target"] as? [String: Any],
                          Self.keys(target, ["host", "port", "bypass"]), target["host"] as? String == "127.0.0.1",
                          let port = Self.integer(target["port"]), (1...65535).contains(port),
                          let bypass = target["bypass"] as? [String], bypass.count <= 256,
                          bypass.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 && $0.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) } }) else { throw Self.error() }
                } else {
                    guard Self.keys(plan, ["version", "launchId", "operationId", "action", "original", "proxyTarget"]),
                          plan["action"] as? String == "restore", Self.snapshot(plan["original"]), Self.snapshot(plan["proxyTarget"]) else { throw Self.error() }
                }
                planDigest = digest; phase = .prepareInFlight
            } else if sequence == 2 {
                guard phase == .prepared, digest == planDigest,
                      Self.keys(request, ["operation", "operationId", "planDigest", "preparedDigest"]),
                      request["operation"] as? String == "interactiveCommit",
                      request["preparedDigest"] as? String == preparedDigest else { throw Self.error() }
                commitPermitted = true; phase = .committing; deadline = now() + 60
            } else { throw Self.error() }
            return request
        } catch { revoke(); throw Self.error() }
    }
    mutating func acceptHelperResponse(_ response: [String: Any], sequence: Int) throws {
        do {
            try checkTime()
            guard response["operationId"] as? String == activeOperationId,
                  response["planDigest"] as? String == planDigest, let ok = Self.boolean(response["ok"]) else { throw Self.error() }
            if !ok {
                let allowed: Set<String> = ["ok", "phase", "operationId", "planDigest", "preparedDigest", "code", "committed"]
                guard Set(response.keys).isSubset(of: allowed), response["phase"] as? String == "finished",
                      response["code"] is String,
                      (sequence == 1 && phase == .prepareInFlight) || (sequence == 2 && phase == .committing),
                      response["committed"] as? String == "unknown" || Self.boolean(response["committed"]) != nil else { throw Self.error() }
                if sequence == 1 { guard Self.boolean(response["committed"]) == false else { throw Self.error() } }
                if sequence == 2 { guard response["preparedDigest"] as? String == preparedDigest else { throw Self.error() } }
                if commitPermitted { blocked = true }
                phase = .finished; return
            }
            if sequence == 1 {
                guard phase == .prepareInFlight, Self.keys(response, ["ok", "phase", "operationId", "planDigest", "preparedDigest", "preparedData"]),
                      response["phase"] as? String == "prepared", let digest = response["preparedDigest"] as? String else { throw Self.error() }
                let data = try Self.checkedData(response["preparedData"], digest: digest)
                guard let prepared = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      Self.keys(prepared, ["original", "target", "current", "desired"]), prepared.values.allSatisfy(Self.snapshot) else { throw Self.error() }
                desiredData = try JSONSerialization.data(withJSONObject: prepared["desired"]!, options: [.sortedKeys])
                preparedDigest = digest; phase = .prepared; deadline = now() + 5
            } else {
                guard sequence == 2, phase == .committing,
                      Self.keys(response, ["ok", "phase", "operationId", "planDigest", "preparedDigest", "snapshot", "verifiedSnapshot", "committed", "applied"]),
                      response["phase"] as? String == "finished", response["preparedDigest"] as? String == preparedDigest,
                      Self.boolean(response["committed"]) == true, Self.boolean(response["applied"]) == true,
                      Self.snapshot(response["snapshot"]), Self.snapshot(response["verifiedSnapshot"]) else { throw Self.error() }
                guard try JSONSerialization.data(withJSONObject: response["snapshot"]!, options: [.sortedKeys]) == desiredData,
                      try JSONSerialization.data(withJSONObject: response["verifiedSnapshot"]!, options: [.sortedKeys]) == desiredData else { throw Self.error() }
                helperSucceeded = true; phase = .finished
            }
        } catch { revoke(); throw Self.error() }
    }
    mutating func complete(_ frame: [String: Any]) throws {
        do {
            try checkTime()
            guard frame["type"] as? String == "complete", Self.integer(frame["version"]) == 1,
                  frame["launchId"] as? String == launchId, frame["operationId"] as? String == activeOperationId,
                  let ok = Self.boolean(frame["ok"]) else { throw Self.error() }
            if ok {
                guard Self.keys(frame, ["version", "type", "launchId", "operationId", "ok", "result"]),
                      let result = frame["result"] as? [String: Any], Self.keys(result, ["confirmed", "helperUsed"]),
                      Self.boolean(result["confirmed"]) == true, let helperUsed = Self.boolean(result["helperUsed"]) else { throw Self.error() }
                if helperUsed {
                    guard phase == .finished, commitPermitted, helperSucceeded else { throw Self.error() }
                } else {
                    guard phase == .preparing, !commitPermitted else { throw Self.error() }
                }
                blocked = false; commitPermitted = false
            } else {
                guard Self.keys(frame, ["version", "type", "launchId", "operationId", "ok", "code", "message"]),
                      frame["code"] is String, frame["message"] is String, phase != .committing else { throw Self.error() }
                if commitPermitted { blocked = true }
            }
            activeOperationId = nil; phase = .finished
        } catch { revoke(); throw Self.error() }
    }
    mutating func revoke() {
        if commitPermitted { blocked = true }
        activeOperationId = nil; phase = .revoked
    }
    private func checkTime() throws {
        guard activeOperationId != nil, now().isFinite, now() < deadline else { throw Self.error("OPERATION_EXPIRED") }
    }
    private static func keys(_ object: [String: Any], _ keys: Set<String>) -> Bool { Set(object.keys) == keys }
    private static func digestValid(_ digest: String) -> Bool { digest.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
    private static func checkedData(_ value: Any?, digest: String) throws -> Data {
        guard digestValid(digest), let encoded = value as? String, encoded.utf8.count <= 8 * 1024 * 1024,
              let data = Data(base64Encoded: encoded), data.count <= 6 * 1024 * 1024,
              SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == digest else { throw error() }
        return data
    }
    private static func integer(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
              n.doubleValue.isFinite, n.doubleValue.rounded() == n.doubleValue,
              n.doubleValue >= Double(Int.min), n.doubleValue < Double(Int.max) else { return nil }
        return n.intValue
    }
    private static func boolean(_ value: Any?) -> Bool? {
        guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }; return n.boolValue
    }
    private static func snapshot(_ value: Any?) -> Bool {
        guard let snapshot = value as? [String: Any], keys(snapshot, ["schema", "services"]),
              integer(snapshot["schema"]) == 3, let services = snapshot["services"] as? [[String: Any]], !services.isEmpty, services.count <= 512 else { return false }
        return true // Native does not expose/decode raw proxy plists; helper and Node validate their semantics.
    }
    private static func error(_ code: String = "NATIVE_PROXY_PROTOCOL") -> APIError { APIError(message: "本地代理操作未获验证，已拒绝继续。", code: code) }
}
