import XCTest
@testable import JMSNative

final class ProxyAuthorizationTests: XCTestCase {
    private let message = "系统代理授权尚未接入；本次操作未写入系统设置。若有待恢复记录，请保留并检查原设置。"
    private func client() -> EngineClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        StubProtocol.failure = nil
        StubProtocol.reply = (400, #"{"error":"系统代理授权尚未接入；本次操作未写入系统设置。若有待恢复记录，请保留并检查原设置。","code":"SYS_PROXY_AUTHORIZATION_REQUIRED"}"#)
        return EngineClient(session: URLSession(configuration: configuration), lease: authorizedTestLease())
    }
    private func reset() { StubProtocol.failure = nil; StubProtocol.reply = (200, "{}"); StubProtocol.requests = [] }
    func testClientPreservesSystemProxyAuthorizationCode() async {
        defer { reset() }
        do { _ = try await client().request("api/connect", body: [:]); XCTFail("Expected authorization error") }
        catch {
            XCTAssertEqual((error as? APIError)?.code, "SYS_PROXY_AUTHORIZATION_REQUIRED")
            XCTAssertEqual(error.localizedDescription, message)
        }
    }
    @MainActor func testModelShowsSystemProxyErrorWithoutTUNAuthorization() async throws {
        defer { reset() }
        let model = AppModel(runtime: EngineRuntime(client: client(), resourcesDirectory: nil))
        model.ready = true
        model.post("api/connect")
        for _ in 0..<200 {
            if !model.working { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertFalse(model.working, "Mock request must finish within bounded time")
        XCTAssertFalse(model.showTunPermission)
        XCTAssertEqual(model.error, message)
        XCTAssertFalse(StubProtocol.requests.isEmpty)
    }
}
