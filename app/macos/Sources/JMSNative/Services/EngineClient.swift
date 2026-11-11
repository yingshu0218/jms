import Foundation

final class RejectEngineRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // Engine control and its bearer credential must never follow redirects.
        completionHandler(nil)
    }
}

/// Local engine control must not inherit system proxy routing, cookies or credentials.
/// This only configures these URLSession instances; it does not alter macOS settings.
enum EngineControlSession {
    static func make(protocolClasses: [AnyClass]? = nil) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        configuration.urlCredentialStorage = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpAdditionalHeaders = nil
        configuration.protocolClasses = protocolClasses
        return URLSession(configuration: configuration, delegate: RejectEngineRedirects(), delegateQueue: nil)
    }
    static func probe(for session: URLSession) -> URLSession {
        // Test transports are the sole inherited property. No headers/proxies/cookies.
        make(protocolClasses: session.configuration.protocolClasses)
    }
}

struct EngineIdentity: Decodable {
    let name: String
    let protocolVersion: Int
    let instanceId: String
    let isolated: Bool
}

struct EngineClient {
    var timeout: TimeInterval = 90
    var session: URLSession = EngineControlSession.make()
    var baseURL = URL(string: "http://127.0.0.1:7788")!
    var lease = EngineLease()
    var token: String { lease.token }
    private func validateEndpoint() throws {
        guard baseURL.scheme == "http", baseURL.host == "127.0.0.1",
              baseURL.user == nil, baseURL.password == nil,
              baseURL.query == nil, baseURL.fragment == nil else {
            throw APIError(message: "本地引擎请求配置无效")
        }
    }
    /// An occupied port is untrusted. Never disclose the future child's token,
    /// session headers, cookies or stored credentials while probing it.
    func probeOccupiedPort() async throws {
        try validateEndpoint()
        var request = URLRequest(url: baseURL.appendingPathComponent("api/identity"))
        request.timeoutInterval = timeout
        let transport = EngineControlSession.probe(for: session)
        defer { transport.invalidateAndCancel() }
        let (_, response) = try await send(request, using: transport)
        guard response is HTTPURLResponse else { throw APIError(message: "端口响应无效，已拒绝启动") }
        // Any HTTP status, including 401/503/redirect, proves the port is occupied.
    }
    func makeRequest(_ path: String, body: [String: Any]? = nil) throws -> URLRequest {
        try makeRequest(path, body: body, allowHandshake: false)
    }
    private func makeRequest(_ path: String, body: [String: Any]?, allowHandshake: Bool) throws -> URLRequest {
        try validateEndpoint()
        let credential = try lease.authorize(allowHandshake: allowHandshake)
        guard path.hasPrefix("api/"), !path.contains(".."),
              !path.contains("?"), !path.contains("#"),
              token.count >= 32, !token.contains("\r"), !token.contains("\n") else {
            throw APIError(message: "本地引擎请求配置无效")
        }
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.timeoutInterval = timeout
        req.setValue("Bearer " + credential.token, forHTTPHeaderField: "Authorization")
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return req
    }
    private func send(_ request: URLRequest, using transport: URLSession, authenticated: Bool = false, allowHandshake: Bool = false) async throws -> (Data, URLResponse) {
        let deadline = timeout
        return try await withThrowingTaskGroup(of: (Data, URLResponse).self) { group in
            group.addTask {
                if authenticated { try lease.validate(request, allowHandshake: allowHandshake) }
                return try await transport.data(for: request)
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(max(0.01, deadline) * 1_000_000_000))
                throw APIError(message: "操作超时，请查看当前连接状态和日志后重试；未完成的操作不会被当作成功。", code: "TIMEOUT")
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }
    func request(_ path: String, body: [String: Any]? = nil) async throws -> Data {
        try await request(path, body: body, allowHandshake: false)
    }
    private func request(_ path: String, body: [String: Any]?, allowHandshake: Bool) async throws -> Data {
        let request = try makeRequest(path, body: body, allowHandshake: allowHandshake)
        let (data, response) = try await send(request, using: session, authenticated: true, allowHandshake: allowHandshake)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let privilege = json?["privilege"] as? [String: Any]
            let elevation = privilege?["elevation"] as? [String: Any]
            let detail = [json?["error"] as? String, privilege?["hint"] as? String, elevation?["command"] as? String].compactMap { $0 }.joined(separator: "\n\n")
            throw APIError(message: detail.isEmpty ? "引擎响应无效" : detail, code: json?["code"] as? String)
        }
        return data
    }
    func verifyListenerOwnership(using checker: () async throws -> Bool) async throws -> Bool {
        let launch = try lease.beginListenerCheck()
        guard try await checker() else { return false }
        try lease.confirmListener(instanceId: launch.instanceId)
        return true
    }
    func verifyIdentity(instanceId: String, isolated: Bool) async throws {
        let identity = try JSONDecoder().decode(EngineIdentity.self, from: await request("api/identity", body: nil, allowHandshake: true))
        guard identity.name == "jms-engine", identity.protocolVersion == 1,
              identity.instanceId == instanceId, identity.isolated == isolated else {
            lease.revoke(instanceId: instanceId)
            throw APIError(message: "引擎身份不匹配，已拒绝连接", code: "IDENTITY_MISMATCH")
        }
        try lease.confirm(instanceId: instanceId)
    }
    func snapshot() async throws -> EngineSnapshot {
        try JSONDecoder().decode(EngineSnapshot.self, from: await request("api/state"))
    }
}
