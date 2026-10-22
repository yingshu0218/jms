import XCTest
@testable import JMSNative

final class StalledProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {}
    override func stopLoading() {}
}

final class RequestTimeoutTests: XCTestCase {
    func testStalledTransportHasHardDeadline() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StalledProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let client = EngineClient(timeout: 0.05, session: session)
        let started = Date()
        do { _ = try await client.request("api/state"); XCTFail("应超时") }
        catch { XCTAssertTrue(error.localizedDescription.contains("超时")) }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
    }
}
