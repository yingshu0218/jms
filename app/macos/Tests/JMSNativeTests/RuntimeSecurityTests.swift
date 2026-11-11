import XCTest
@testable import JMSNative

final class RuntimeSecurityTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubProtocol.requests = []
        StubProtocol.failure = nil
        StubProtocol.reply = (200, "{}")
    }
    override func tearDown() {
        StubProtocol.requests = []
        StubProtocol.failure = nil
        StubProtocol.reply = (200, "{}")
        super.tearDown()
    }
    private func client() -> EngineClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return EngineClient(session: URLSession(configuration: config), lease: authorizedTestLease())
    }
    func testCandidateNamespaceIsSeparate() throws {
        let normal = RuntimeConfiguration(info: [:])
        let candidate = RuntimeConfiguration(info: ["JMSIsolatedMode": true])
        try normal.validate(); try candidate.validate()
        XCTAssertNotEqual(normal.apiPort, candidate.apiPort)
        XCTAssertNotEqual(normal.dataDirectoryName, candidate.dataDirectoryName)
        XCTAssertEqual(candidate.apiPort, 17788)
        XCTAssertEqual(candidate.baseURL.host, "127.0.0.1")
    }
    func testRejectSharedOrUnsafeCandidateConfiguration() {
        let configurations: [[String: Any]] = [
            ["JMSIsolatedMode": true, "JMSAPIPort": 7788],
            ["JMSIsolatedMode": true, "JMSDataDirectoryName": "JMS Client"],
            ["JMSIsolatedMode": true, "JMSDataDirectoryName": "jms client"],
            ["JMSDataDirectoryName": "../JMS Client"],
            ["JMSAPIPort": -1], ["JMSAPIPort": 65536]
        ]
        for info in configurations {
            let configuration = RuntimeConfiguration(info: info)
            _ = configuration.baseURL
            XCTAssertThrowsError(try configuration.validate())
        }
    }
    func testCandidateRejectsSymlinkToFormalDirectoryWithoutWritingState() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let formal = root.appendingPathComponent("JMS Client")
        try FileManager.default.createDirectory(at: formal, withIntermediateDirectories: true)
        let candidate = root.appendingPathComponent("JMS Client Candidate")
        try FileManager.default.createSymbolicLink(at: candidate, withDestinationURL: formal)
        let configuration = RuntimeConfiguration(info: ["JMSIsolatedMode": true])
        XCTAssertThrowsError(try configuration.stateDirectory(applicationSupport: root))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: formal.path), [])
    }
    func testEveryAPIRequestIncludingSSECarriesHeaderNotURLToken() throws {
        let client = client()
        XCTAssertGreaterThanOrEqual(client.token.count, 32)
        XCTAssertNotEqual(client.token, self.client().token)
        for path in ["api/identity", "api/state", "api/events"] {
            let request = try client.makeRequest(path)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + client.token)
            XCTAssertFalse(request.url!.absoluteString.contains(client.token))
        }
        XCTAssertEqual(try client.makeRequest("api/shutdown", body: [:]).httpMethod, "POST")
    }
    func testRejectNonLoopbackCredentialDestination() {
        var client = client()
        client.baseURL = URL(string: "https://example.com")!
        XCTAssertThrowsError(try client.makeRequest("api/state"))
    }
    func testIdentityMustMatchAllFields() async throws {
        let validClient = client()
        // Use the exact launch identity rather than a fixed reusable credential.
        let id = validClient.lease.instanceId
        StubProtocol.reply = (200, "{\"name\":\"jms-engine\",\"protocolVersion\":1,\"instanceId\":\"\(id)\",\"isolated\":true}")
        try await validClient.verifyIdentity(instanceId: id, isolated: true)
        for variant in ["instance", "mode", "version", "name"] {
            let candidate = client()
            let expectedId = candidate.lease.instanceId
            let reply: [String: Any] = ["name": variant == "name" ? "other" : "jms-engine",
                "protocolVersion": variant == "version" ? 2 : 1,
                "instanceId": variant == "instance" ? "other" : expectedId,
                "isolated": variant != "mode"]
            StubProtocol.reply = (200, String(data: try JSONSerialization.data(withJSONObject: reply), encoding: .utf8)!)
            do { try await candidate.verifyIdentity(instanceId: expectedId, isolated: true); XCTFail("必须拒绝身份不符") }
            catch { XCTAssertEqual((error as? APIError)?.code, "IDENTITY_MISMATCH") }
        }
    }
    func testStartingResponsePreservesStructuredCode() async {
        StubProtocol.reply = (503, #"{"error":"引擎正在启动","code":"STARTING"}"#)
        do { _ = try await client().request("api/identity"); XCTFail() }
        catch { XCTAssertEqual((error as? APIError)?.code, "STARTING") }
    }
    @MainActor func testExistingServiceNeverTriggersReplacementLaunch() async {
        for reply in [(200, "{}"), (302, "redirect"), (401, #"{"error":"unauthorized"}"#),
                      (503, #"{"error":"引擎正在启动","code":"STARTING"}"#),
                      (200, #"{"name":"jms-engine","protocolVersion":1,"instanceId":"ours","isolated":false}"#)] {
            StubProtocol.reply = reply
            StubProtocol.requests = []
            let runtime = EngineRuntime(client: client(), resourcesDirectory: URL(fileURLWithPath: "/nonexistent/jms-test"))
            do { try await runtime.start(); XCTFail("不能复用现有服务") }
            catch { XCTAssertFalse(error.localizedDescription.contains("缺失"), "不应尝试启动替代引擎") }
            XCTAssertNil(runtime.process)
            XCTAssertEqual(StubProtocol.requests.count, 1)
            XCTAssertNil(StubProtocol.requests.first?.value(forHTTPHeaderField: "Authorization"))
            XCTAssertFalse(StubProtocol.requests.first?.url?.absoluteString.contains(runtime.client.token) == true)
        }
    }
    func testDeadOwnedEngineCannotSendCredentials() async throws {
        let alive = FakeEngineLiveness()
        var candidate = client()
        candidate.lease = EngineLease()
        let credentials = candidate.lease.begin(isAlive: { alive.isAlive })
        XCTAssertThrowsError(try candidate.makeRequest("api/state"), "未确认身份不能发普通请求")
        try candidate.lease.confirmListener(instanceId: credentials.instanceId)
        try candidate.lease.confirm(instanceId: credentials.instanceId)
        _ = try candidate.makeRequest("api/events")
        alive.stop()
        StubProtocol.requests = []
        XCTAssertThrowsError(try candidate.makeRequest("api/events"))
        do { _ = try await candidate.request("api/state"); XCTFail() }
        catch { XCTAssertEqual((error as? APIError)?.code, "ENGINE_LEASE_INVALID") }
        XCTAssertTrue(StubProtocol.requests.isEmpty, "退出后不得向可被替代的端口发送请求")
    }
    func testEveryLaunchRotatesCapabilityAndRejectsOldRequests() throws {
        var candidate = client()
        candidate.lease = EngineLease()
        let first = candidate.lease.begin(isAlive: { true })
        try candidate.lease.confirmListener(instanceId: first.instanceId)
        try candidate.lease.confirm(instanceId: first.instanceId)
        let staleRequest = try candidate.makeRequest("api/state")
        candidate.lease.revoke(instanceId: first.instanceId)
        let second = candidate.lease.begin(isAlive: { true })
        XCTAssertNotEqual(first.token, second.token)
        XCTAssertNotEqual(first.instanceId, second.instanceId)
        try candidate.lease.confirmListener(instanceId: second.instanceId)
        try candidate.lease.confirm(instanceId: second.instanceId)
        candidate.lease.revoke(instanceId: first.instanceId)
        XCTAssertNoThrow(try candidate.makeRequest("api/state"), "旧子进程退出不能撤销新租约")
        XCTAssertThrowsError(try candidate.lease.validate(staleRequest))
    }
    func testUnconfirmedListenerCannotSendHandshakeCredential() async throws {
        var candidate = client(); candidate.lease = EngineLease()
        let credentials = candidate.lease.begin(isAlive: { true })
        let verified = try await candidate.verifyListenerOwnership(using: { false })
        XCTAssertFalse(verified)
        StubProtocol.requests = []
        do { try await candidate.verifyIdentity(instanceId: credentials.instanceId, isolated: true); XCTFail() }
        catch { XCTAssertEqual((error as? APIError)?.code, "ENGINE_LEASE_INVALID") }
        XCTAssertTrue(StubProtocol.requests.isEmpty)
    }
    func testListenerOwnershipRequiresExclusiveExactLoopbackPID() {
        XCTAssertTrue(EngineListenerOwnership.matches("p42\nn127.0.0.1:17788\n", pid: 42, port: 17788))
        for output in ["", "p43\nn127.0.0.1:17788\n", "p42\nn*:17788\n", "p42\nn127.0.0.1:17788\np43\nn127.0.0.1:17788\n"] {
            XCTAssertFalse(EngineListenerOwnership.matches(output, pid: 42, port: 17788))
        }
    }
    func testPortProbeDoesNotInheritAuthenticatedSessionHeaders() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        config.httpAdditionalHeaders = ["Authorization": "Bearer session-credential", "Cookie": "secret=value"]
        let client = EngineClient(session: URLSession(configuration: config), lease: authorizedTestLease())
        try await client.probeOccupiedPort()
        XCTAssertEqual(StubProtocol.requests.count, 1)
        XCTAssertNil(StubProtocol.requests.first?.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(StubProtocol.requests.first?.value(forHTTPHeaderField: "Cookie"))
    }
    @MainActor func testConnectionLostDoesNotTriggerLaunch() async {
        StubProtocol.failure = .networkConnectionLost
        let runtime = EngineRuntime(client: client(), resourcesDirectory: URL(fileURLWithPath: "/nonexistent/jms-test"))
        do { try await runtime.start(); XCTFail() }
        catch { XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost) }
        XCTAssertNil(runtime.process)
    }
    func testRedirectDelegateRefusesEvenSameOriginRedirect() {
        let url = URL(string: "http://127.0.0.1:7788/api/state")!
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: url) // Never resumed; no network access.
        let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: nil, headerFields: ["Location": "/api/other"])!
        var called = false
        RejectEngineRedirects().urlSession(session, task: task, willPerformHTTPRedirection: response,
                                           newRequest: URLRequest(url: url)) { request in
            called = true; XCTAssertNil(request)
        }
        XCTAssertTrue(called)
    }
    @MainActor func testLostEngineReopensControlsForRecovery() async {
        var safety = EngineExitSafety()
        safety.recordLaunch(instanceId: "lost-launch")
        let runtime = EngineRuntime(client: client(), exitSafety: safety)
        let model = AppModel(runtime: runtime)
        model.ready = true
        let result = await model.shutdown()
        XCTAssertFalse(result)
        XCTAssertFalse(model.shuttingDown)
        XCTAssertTrue(model.shutdownError?.contains("无法确认系统代理已恢复") == true)
        XCTAssertNil(runtime.process)
    }
    @MainActor func testShutdownWaitsForMutationAndBlocksNewWork() async {
        let model = AppModel(runtime: EngineRuntime(client: client()))
        model.ready = true
        let started = expectation(description: "mutation started")
        var release: CheckedContinuation<Void, Never>?
        model.perform {
            await withCheckedContinuation { continuation in
                release = continuation; started.fulfill()
            }
        }
        await fulfillment(of: [started], timeout: 2)
        let draining = expectation(description: "shutdown scheduled")
        let shutdown = Task { draining.fulfill(); return await model.shutdown() }
        await fulfillment(of: [draining], timeout: 2)
        XCTAssertTrue(model.shuttingDown)
        var accepted = false
        model.perform { accepted = true }
        release?.resume()
        let result = await shutdown.value
        XCTAssertTrue(result)
        XCTAssertFalse(accepted)
    }
}

private final class FakeEngineLiveness: @unchecked Sendable {
    private let lock = NSLock()
    private var value = true
    var isAlive: Bool { lock.lock(); defer { lock.unlock() }; return value }
    func stop() { lock.lock(); value = false; lock.unlock() }
}
