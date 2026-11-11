import XCTest
@testable import JMSNative

func authorizedTestLease() -> EngineLease {
    let lease = EngineLease()
    let credentials = lease.begin(isAlive: { true })
    try! lease.confirmListener(instanceId: credentials.instanceId)
    try! lease.confirm(instanceId: credentials.instanceId)
    return lease
}

final class StubProtocol: URLProtocol {
    static var failure: URLError.Code?
    static var requests: [URLRequest] = []
    static var reply: (Int, String) = (200, "{}")
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        if let failure = Self.failure { client?.urlProtocol(self, didFailWithError: URLError(failure)); return }
        let (status, text) = Self.reply
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class EngineTests: XCTestCase {
    func client() -> EngineClient {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubProtocol.self]
        return EngineClient(session: URLSession(configuration: config), lease: authorizedTestLease())
    }
    func testDecodeRealEngineShape() throws {
        let json = #"{"settings":{"selected":0,"mode":"tun-per-app","port":2080,"clashApi":"127.0.0.1:9090","autoRefreshMinutes":360,"routingMode":"rule","localDns":"system","remoteDns":"https://1.1.1.1/dns-query","customRules":[],"apps":["chrome"],"reverseApps":true},"subscription":{"url":"https://example.com/…","hasUrl":true,"nodes":[],"updatedAt":null},"status":{"connected":false,"running":false,"pendingProxyJournal":false,"node":null,"busy":null}}"#
        let snapshot = try JSONDecoder().decode(EngineSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(snapshot.settings.apps, ["chrome"]); XCTAssertTrue(snapshot.settings.reverseApps)
    }
    func testRejectUnrelatedService() async {
        StubProtocol.reply = (200, #"{"hello":"world"}"#)
        do { _ = try await client().snapshot(); XCTFail("应拒绝其他服务") } catch {}
    }
    func testPermissionErrorIncludesCommand() async {
        StubProtocol.reply = (400, #"{"error":"需要权限","code":"NEED_ELEVATION","privilege":{"hint":"TUN 需要 root","elevation":{"command":"sudo example"}}}"#)
        do { _ = try await client().request("api/connect", body: [:]); XCTFail() }
        catch { XCTAssertTrue(error.localizedDescription.contains("sudo example")); XCTAssertTrue(error.localizedDescription.contains("root")) }
    }
    func testRuleFileRoundTripPreservesDisabledAndOrder() throws {
        let rules = [Rule(type: "domain", value: "a.example", outbound: "direct", enabled: false), Rule(value: "b.example")]
        let document = RulesDocument(format: "jms-rules", version: 1, rules: rules, apps: ["chrome"], reverseApps: true)
        let restored = try JSONDecoder().decode(RulesDocument.self, from: JSONEncoder().encode(document))
        XCTAssertEqual(restored.rules, rules); XCTAssertEqual(restored.reverseApps, true)
    }
    func testLegacyRulesWithoutIdentityOrEnabled() throws {
        let rule = try JSONDecoder().decode(Rule.self, from: Data(#"{"type":"domain","value":"example.com"}"#.utf8))
        XCTAssertTrue(rule.enabled); XCTAssertEqual(rule.outbound, "proxy"); XCTAssertFalse(rule.id.isEmpty)
    }
    func testLegacyRuleDocumentWithoutApps() throws {
        let data = Data(#"{"format":"jms-rules","version":1,"rules":[]}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(RulesDocument.self, from: data).apps)
    }
    func testShutdownRestoresBeforeStopping() async throws {
        var events: [String] = []; var active = true
        try await ShutdownCoordinator.run(status: { events.append("status"); return self.status(active) }, disconnect: { events.append("restore"); active = false }, stop: { events.append("stop") })
        XCTAssertEqual(events, ["status", "restore", "status", "stop"])
    }
    func testRestoreFailureNeverStopsEngine() async {
        var stopped = false
        do { try await ShutdownCoordinator.run(status: { self.status(true) }, disconnect: { throw APIError(message: "还原失败") }, stop: { stopped = true }); XCTFail() } catch {}
        XCTAssertFalse(stopped)
    }
    func testPendingJournalBlocksExitEvenAfterDisconnect() async {
        var stopped = false
        do { try await ShutdownCoordinator.run(status: { self.status(true) }, disconnect: {}, stop: { stopped = true }); XCTFail() } catch {}
        XCTAssertFalse(stopped)
    }
    @MainActor func testStartupMissingEngineIsActionable() async {
        StubProtocol.failure = .cannotConnectToHost
        defer { StubProtocol.failure = nil }
        let runtime = EngineRuntime(client: client(), resourcesDirectory: URL(fileURLWithPath: "/nonexistent/jms-test"))
        do { try await runtime.start(); XCTFail() }
        catch { XCTAssertTrue(error.localizedDescription.contains("缺失")) }
        XCTAssertNil(runtime.process)
    }
    func testNodeSearchAndSortingKeepOriginalIndices() {
        let nodes = [Node(name: "Zeta", type: "vless", server: "192.0.2.1", server_port: 443),
                     Node(name: "Alpha", type: "trojan", server: "192.0.2.2", server_port: 443),
                     Node(name: "Alpha", type: "vless", server: "192.0.2.3", server_port: 443)]
        XCTAssertEqual(NodeBrowser.rows(nodes, search: " alpha ", protocolFilter: "vless", sort: "name", latency: [:]).map { $0.0 }, [2])
        XCTAssertEqual(NodeBrowser.rows(nodes, search: "", protocolFilter: "all", sort: "name", latency: [:]).map { $0.0 }, [1, 2, 0])
        let latency = ["0": NodeLatency(ok: false, delay: nil, error: "超时"), "2": NodeLatency(ok: true, delay: 20, error: nil)]
        XCTAssertEqual(NodeBrowser.rows(nodes, search: "", protocolFilter: "all", sort: "latency", latency: latency).map { $0.0 }, [2, 0, 1])
    }
    func testProfileMetadataDoesNotRequireCredentialsOrRawNodes() throws {
        let data = Data(#"{"id":"a","name":"订阅","url":"https://example.com/…","nodeCount":3,"updatedAt":null,"lastError":null}"#.utf8)
        let profile = try JSONDecoder().decode(SubscriptionProfile.self, from: data)
        XCTAssertEqual(profile.nodeCount, 3); XCTAssertEqual(profile.id, "a")
    }
    private func status(_ active: Bool) -> EngineStatus { EngineStatus(connected: active, running: active, pendingProxyJournal: active, node: nil, busy: nil) }
}
