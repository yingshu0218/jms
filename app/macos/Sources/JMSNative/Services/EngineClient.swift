import Foundation

struct EngineClient {
    var timeout: TimeInterval = 90
    var session: URLSession = .shared
    var baseURL = URL(string: "http://127.0.0.1:7788")!
    func request(_ path: String, body: [String: Any]? = nil) async throws -> Data {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.timeoutInterval = timeout
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let transport = session, request = req, deadline = timeout
        let (data, response) = try await withThrowingTaskGroup(of: (Data, URLResponse).self) { group in
            group.addTask { try await transport.data(for: request) }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(max(0.01, deadline) * 1_000_000_000))
                throw APIError(message: "操作超时，请查看当前连接状态和日志后重试；未完成的操作不会被当作成功。", code: "TIMEOUT")
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let privilege = json?["privilege"] as? [String: Any]
            let elevation = privilege?["elevation"] as? [String: Any]
            let detail = [json?["error"] as? String, privilege?["hint"] as? String, elevation?["command"] as? String].compactMap { $0 }.joined(separator: "\n\n")
            throw APIError(message: detail.isEmpty ? "引擎响应无效" : detail, code: json?["code"] as? String)
        }
        return data
    }
    func snapshot() async throws -> EngineSnapshot {
        try JSONDecoder().decode(EngineSnapshot.self, from: await request("api/state"))
    }
}
