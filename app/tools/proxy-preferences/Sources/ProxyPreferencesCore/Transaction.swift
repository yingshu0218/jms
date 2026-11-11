import Foundation
import CoreFoundation

public enum CommitState: Equatable, Codable {
    case yes, no, unknown
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) { self = b ? .yes : .no }
        else if try c.decode(String.self) == "unknown" { self = .unknown }
        else { throw Failure(.invalidRequest, .no) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .yes: try c.encode(true); case .no: try c.encode(false); case .unknown: try c.encode("unknown") }
    }
}
public enum FailureCode: String, Codable {
    case authorizationRequired = "AUTHORIZATION_REQUIRED"
    case cancelled = "CANCELLED", commitPermissionTimeout = "COMMIT_PERMISSION_TIMEOUT"
    case conflict = "CONFLICT", commitFailed = "COMMIT_FAILED", applyFailed = "APPLY_FAILED", readbackFailed = "READBACK_FAILED", unsupported = "UNSUPPORTED_CONFIG", invalidRequest = "INVALID_REQUEST"
}
public struct Failure: Error, Encodable {
    public let ok = false
    public let code: FailureCode
    public let committed: CommitState
    public let message = "Proxy preferences transaction could not be verified."
    public init(_ code: FailureCode, _ committed: CommitState) { self.code = code; self.committed = committed }
}
public struct RawProxies: Codable {
    public var present: Bool
    public var blob: String?
    private enum CodingKeys: String, CodingKey { case present, blob }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(present, forKey: .present)
        if let blob { try container.encode(blob, forKey: .blob) }
        else { try container.encodeNil(forKey: .blob) }
    }
    public init(_ dictionary: [String: Any]?) throws {
        present = dictionary != nil
        blob = try dictionary.map { try StablePlist.encode($0).base64EncodedString() }
    }
    public func dictionary() throws -> [String: Any]? {
        guard present else { guard blob == nil else { throw Failure(.invalidRequest, .no) }; return nil }
        guard let blob, blob.count <= 1_048_576, let data = Data(base64Encoded: blob),
              let decoded = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
              let dict = decoded as? [String: Any] else { throw Failure(.invalidRequest, .no) }
        let strings: Set<String> = ["HTTPProxy", "HTTPSProxy", "SOCKSProxy", "FTPProxy", "GopherProxy", "RTSPProxy", "ProxyAutoConfigURLString"]
        let numbers: Set<String> = ["HTTPEnable", "HTTPPort", "HTTPSEnable", "HTTPSPort", "SOCKSEnable", "SOCKSPort", "FTPEnable", "FTPPort", "GopherEnable", "GopherPort", "RTSPEnable", "RTSPPort", "ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable", "ExcludeSimpleHostnames", "FTPPassive"]
        for (key, value) in dict {
            if strings.contains(key), value is String { continue }
            if numbers.contains(key), let number = value as? NSNumber {
                let numeric = number.doubleValue
                let boolean = CFGetTypeID(number) == CFBooleanGetTypeID()
                if key.hasSuffix("Port") {
                    if !boolean && numeric.isFinite && numeric.rounded() == numeric && (0...65535).contains(numeric) { continue }
                } else if numeric == 0 || numeric == 1 { continue }
            }
            if key == "ExceptionsList", value is [String] { continue }
            throw Failure(.unsupported, .no)
        }
        return dict
    }
}
public struct Service: Codable {
    public var id: String, name: String, device: String
    public var proxies: RawProxies
    public init(id: String, name: String, device: String, proxies: RawProxies) { self.id = id; self.name = name; self.device = device; self.proxies = proxies }
}
public struct Snapshot: Codable {
    public var schema = 3
    public var services: [Service]
    public init(services: [Service]) { self.services = services }
    public func validate() throws {
        guard schema == 3, !services.isEmpty, services.count <= 512, Set(services.map(\.id)).count == services.count else { throw Failure(.invalidRequest, .no) }
        for service in services {
            guard Self.validID(service.id), !service.name.isEmpty, !service.device.isEmpty else { throw Failure(.invalidRequest, .no) }
            _ = try service.proxies.dictionary()
        }
    }
    public static func validID(_ id: String) -> Bool {
        id.range(of: "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$", options: .regularExpression) != nil
    }
    public func same(as other: Snapshot) throws -> Bool {
        guard schema == other.schema, services.count == other.services.count else { return false }
        for (a, b) in zip(services.sorted { $0.id < $1.id }, other.services.sorted { $0.id < $1.id }) {
            guard a.id == b.id, a.name == b.name, a.device == b.device, a.proxies.present == b.proxies.present else { return false }
            if try canonical(a.proxies.dictionary() ?? [:]) != canonical(b.proxies.dictionary() ?? [:]) { return false }
        }
        return true
    }
}
// Explicit type tags avoid NSNumber's true == 1 equality. Length-prefixed strings
// and sorted dictionary keys prevent delimiter collisions and ordering ambiguity.
private func canonical(_ value: Any) throws -> String {
    if let n = value as? NSNumber {
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "b1" : "b0" }
        let type = String(cString: n.objCType)
        if type == "f" || type == "d" { return "r\(n.doubleValue.bitPattern);" }
        return "i\(n.int64Value);"
    }
    if let s = value as? String { return "s\(s.utf8.count):\(s)" }
    if let a = value as? [Any] { return "[" + (try a.map(canonical).joined()) + "]" }
    if let d = value as? [String: Any] { return "{" + (try d.keys.sorted().map { try canonical($0) + canonical(d[$0]!) }.joined()) + "}" }
    throw Failure(.unsupported, .no)
}
public struct Target: Codable {
    public let host: String
    public let port: Int
    public let bypass: [String]
    public init(host: String, port: Int, bypass: [String]) { self.host = host; self.port = port; self.bypass = bypass }
}
public protocol PreferencesStore {
    func lock() throws
    func unlock()
    func synchronize()
    func read() throws -> Snapshot
    func write(id: String, proxies: RawProxies) throws
    func commit() -> Bool
    func apply() -> Bool
}
public final class Transaction {
    let store: PreferencesStore
    public init(store: PreferencesStore) { self.store = store }
    public func snapshot() throws -> Snapshot {
        try store.lock(); defer { store.unlock() }
        store.synchronize()
        let result = try store.read(); try result.validate(); return result
    }
    public func prepare(_ target: Target) throws -> (original: Snapshot, target: Snapshot) {
        guard target.host == "127.0.0.1", (1...65535).contains(target.port), target.bypass.count <= 256,
              target.bypass.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 && !$0.contains("\n") && !$0.contains("\0") }) else { throw Failure(.invalidRequest, .no) }
        let original = try snapshot()
        var desired = original
        for index in desired.services.indices {
            var dictionary = try desired.services[index].proxies.dictionary() ?? [:]
            for prefix in ["HTTP", "HTTPS", "SOCKS"] {
                dictionary[prefix + "Enable"] = 1; dictionary[prefix + "Proxy"] = target.host; dictionary[prefix + "Port"] = target.port
            }
            dictionary["ProxyAutoConfigEnable"] = 0; dictionary["ProxyAutoDiscoveryEnable"] = 0
            dictionary["ExceptionsList"] = target.bypass
            desired.services[index].proxies = try RawProxies(dictionary)
        }
        return (original, desired)
    }
    public func compareAndSet(expected: Snapshot, desired: Snapshot) throws -> Snapshot {
        try expected.validate(); try desired.validate()
        let identities: (Snapshot) -> [String] = { $0.services.map { "\($0.id.count):\($0.id)\($0.name.utf8.count):\($0.name)\($0.device.utf8.count):\($0.device)" }.sorted() }
        guard identities(expected) == identities(desired) else { throw Failure(.invalidRequest, .no) }
        try store.lock(); defer { store.synchronize(); store.unlock() }
        store.synchronize()
        guard try store.read().same(as: expected) else { throw Failure(.conflict, .no) }
        do { for service in desired.services { try store.write(id: service.id, proxies: service.proxies) } }
        catch { throw Failure(.commitFailed, .no) }
        guard store.commit() else { throw Failure(.commitFailed, .unknown) }
        guard store.apply() else { throw Failure(.applyFailed, .yes) }
        store.synchronize()
        do {
            let result = try store.read()
            guard try result.same(as: desired) else { throw Failure(.readbackFailed, .yes) }
            return result
        } catch { throw Failure(.readbackFailed, .yes) }
    }
}
