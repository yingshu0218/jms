import Foundation

/// Shared by client copies. A credential is valid only for a live, owned launch.
final class EngineLease: @unchecked Sendable {
    struct Credentials: Sendable { let token: String; let instanceId: String }
    private let lock = NSLock()
    private var credentials = Credentials(token: "", instanceId: "")
    private var alive: (() -> Bool)?
    private var confirmed = false
    private var listenerOwned = false

    var token: String { lock.lock(); defer { lock.unlock() }; return credentials.token }
    var instanceId: String { lock.lock(); defer { lock.unlock() }; return credentials.instanceId }

    @discardableResult func begin(isAlive: @escaping () -> Bool) -> Credentials {
        lock.lock(); defer { lock.unlock() }
        credentials = Credentials(token: UUID().uuidString + UUID().uuidString, instanceId: UUID().uuidString)
        alive = isAlive; confirmed = false; listenerOwned = false
        return credentials
    }
    func revoke(instanceId: String? = nil) {
        lock.lock(); defer { lock.unlock() }
        guard instanceId == nil || instanceId == credentials.instanceId else { return }
        alive = nil; confirmed = false; listenerOwned = false
    }
    func authorize(allowHandshake: Bool = false) throws -> Credentials {
        lock.lock(); defer { lock.unlock() }
        guard alive?() == true, listenerOwned, confirmed || allowHandshake else {
            throw APIError(message: "自有引擎已退出或身份尚未确认，已停止发送请求", code: "ENGINE_LEASE_INVALID")
        }
        return credentials
    }
    func beginListenerCheck() throws -> Credentials {
        lock.lock(); defer { lock.unlock() }
        guard alive?() == true else { throw APIError(message: "自有引擎已退出", code: "ENGINE_LEASE_INVALID") }
        listenerOwned = false
        return credentials
    }
    func confirmListener(instanceId: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard credentials.instanceId == instanceId, alive?() == true else {
            throw APIError(message: "监听端口检查属于已退出的引擎", code: "ENGINE_LEASE_INVALID")
        }
        listenerOwned = true
    }
    func confirm(instanceId: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard credentials.instanceId == instanceId, alive?() == true, listenerOwned else {
            throw APIError(message: "引擎身份已失效", code: "ENGINE_LEASE_INVALID")
        }
        confirmed = true
    }
    func validate(_ request: URLRequest, allowHandshake: Bool = false) throws {
        let current = try authorize(allowHandshake: allowHandshake)
        guard request.value(forHTTPHeaderField: "Authorization") == "Bearer " + current.token else {
            throw APIError(message: "请求属于已失效的引擎实例", code: "ENGINE_LEASE_INVALID")
        }
    }
}
