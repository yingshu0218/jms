import XCTest
@testable import JMSNative

final class EffectiveStateTests: XCTestCase {
    @MainActor func testRecoveryDoesNotRotateLeaseUnderAnInflightOperation() {
        let runtime = EngineRuntime(resourcesDirectory: URL(fileURLWithPath: "/nonexistent/jms-fixture"))
        let model = AppModel(runtime: runtime)
        model.working = true
        model.start(); model.retryEngineRecovery()
        XCTAssertFalse(model.startingEngine)
        model.working = false; model.checking = true
        model.start(); model.retryEngineRecovery()
        XCTAssertFalse(model.startingEngine)
        XCTAssertNil(runtime.process)
    }

    func testLegacyStatusNeverClaimsDesiredNodeIsCurrent() throws {
        let status = try JSONDecoder().decode(EngineStatus.self, from: Data(#"{"connected":true,"running":true,"pendingProxyJournal":false,"node":"legacy","busy":null}"#.utf8))
        XCTAssertNil(status.confirmedSelection)
        XCTAssertNil(status.confirmedMode)
    }
    func testUnknownAndPartialEffectiveState() throws {
        let status = try JSONDecoder().decode(EngineStatus.self, from: Data(#"{"connected":true,"running":true,"pendingProxyJournal":false,"node":null,"busy":null,"effective":{"selected":2,"routingMode":"global","known":false,"selectionKnown":false,"modeKnown":true}}"#.utf8))
        XCTAssertNil(status.confirmedSelection)
        XCTAssertEqual(status.confirmedMode, "global")
    }
    func testSnapshotGateRejectsOlderRefreshAndMutationOverlap() {
        var gate = SnapshotGate()
        let first = gate.issue(lease: "A")
        let second = gate.issue(lease: "A")
        XCTAssertFalse(gate.accepts(first, lease: "A"))
        XCTAssertTrue(gate.accepts(second, lease: "A"))
        gate.invalidate()
        XCTAssertFalse(gate.accepts(second, lease: "A"))
        let third = gate.issue(lease: "A")
        XCTAssertFalse(gate.accepts(third, lease: "B"))
    }
    func testBoundedRuleReadRejectsOversizeAndInvalidUTF8() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        try Data(repeating: 65, count: 128 * 1024 + 1).write(to: url)
        XCTAssertThrowsError(try BoundedRulesReader.read(url))
        try Data([0xff]).write(to: url)
        XCTAssertThrowsError(try BoundedRulesReader.read(url))
        try Data("[]".utf8).write(to: url)
        XCTAssertEqual(try BoundedRulesReader.read(url), "[]")
    }
}

final class DesiredSettingsTests: XCTestCase {
    private func settings(_ port: Int = 3080) -> EngineSettings {
        EngineSettings(selected: 0, mode: "sysproxy", port: port, clashApi: "127.0.0.1:9090", autoRefreshMinutes: 60, routingMode: "rule", localDns: "system", remoteDns: "https://dns.invalid/query", customRules: [], apps: [], reverseApps: false)
    }
    func testDelayedSettingsLoadAndDirtyRefresh() {
        var draft = SettingsDraft()
        XCTAssertFalse(draft.loaded)
        draft.receive(settings())
        XCTAssertTrue(draft.loaded)
        XCTAssertEqual(draft.port, "3080")
        draft.edit(\.port, "4080")
        draft.receive(settings(5080))
        XCTAssertEqual(draft.port, "4080")
        draft.reload(settings(5080))
        XCTAssertFalse(draft.dirty)
        XCTAssertEqual(draft.port, "5080")
    }
    func testSaveFailureDoesNotEraseDirtyDraft() {
        var draft = SettingsDraft()
        draft.receive(settings())
        draft.edit(\.remoteDns, "https://edited.invalid/query")
        draft.receive(settings())
        XCTAssertTrue(draft.dirty)
        XCTAssertEqual(draft.remoteDns, "https://edited.invalid/query")
    }
    func testAppliedButUnsavedAndDeferredResults() throws {
        let unsaved = try JSONDecoder().decode(HotSwitchResult.self, from: Data(#"{"applied":true,"persisted":false,"effective":null}"#.utf8))
        XCTAssertTrue(unsaved.summary.contains("未保存"))
        let deferred = try JSONDecoder().decode(HotSwitchResult.self, from: Data(#"{"applied":false,"persisted":true}"#.utf8))
        XCTAssertTrue(deferred.summary.contains("下次连接"))
    }
    func testHotResultThroughAuthenticatedMockTransport() async throws {
        StubProtocol.failure = nil
        StubProtocol.reply = (200, #"{"applied":false,"persisted":false,"effective":{"selected":null,"selectionKnown":false},"reason":"readback mismatch"}"#)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let client = EngineClient(session: URLSession(configuration: config), lease: authorizedTestLease())
        let data = try await client.request("api/node", body: ["index": 2])
        let result = try JSONDecoder().decode(HotSwitchResult.self, from: data)
        XCTAssertFalse(result.applied)
        XCTAssertFalse(result.persisted)
        XCTAssertNil(result.effective?.selected)
    }
}

// Scripted URLProtocol drives the actual model mutation/reconciliation pipeline.
// No child process, listening socket, real subscription or host setting is used.
private struct ModelReply {
    var status = 200
    var text = "{}"
    var error: URLError.Code?
    var held = false
}
private final class ModelScenario: @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [ModelReply]
    private var pending: [(ModelProtocol, ModelReply)] = []
    private var count = 0
    init(_ replies: [ModelReply]) { self.replies = replies }
    var requestCount: Int { lock.lock(); defer { lock.unlock() }; return count }
    func receive(_ transport: ModelProtocol) {
        lock.lock()
        count += 1
        let reply = replies.isEmpty ? ModelReply(status: 500, text: "{\"error\":\"unexpected fixture request\"}") : replies.removeFirst()
        if reply.held { pending.append((transport, reply)); lock.unlock(); return }
        lock.unlock()
        transport.complete(reply)
    }
    func releaseFirst() {
        lock.lock()
        let item = pending.isEmpty ? nil : pending.removeFirst()
        lock.unlock()
        if let (transport, reply) = item { transport.complete(reply) }
    }
}
private final class ModelProtocol: URLProtocol {
    static var scenario: ModelScenario?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.scenario?.receive(self) }
    override func stopLoading() {}
    func complete(_ reply: ModelReply) {
        if let error = reply.error { client?.urlProtocol(self, didFailWithError: URLError(error)); return }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
final class AppModelSwitchTests: XCTestCase {
    private func snapshot(_ selected: Int) -> String {
        """
        {"settings":{"selected":\(selected),"mode":"sysproxy","port":2080,"clashApi":"127.0.0.1:9090","autoRefreshMinutes":180,"routingMode":"rule","localDns":"system","remoteDns":"https://fixture.invalid/dns-query","customRules":[],"apps":[],"reverseApps":false},"subscription":{"url":"","hasUrl":false,"nodes":[{"name":"A","type":"vless","server":"192.0.2.1","server_port":443},{"name":"B","type":"vless","server":"192.0.2.2","server_port":443},{"name":"C","type":"vless","server":"192.0.2.3","server_port":443}]},"status":{"connected":true,"running":true,"pendingProxyJournal":false,"effective":{"selected":\(selected),"routingMode":"rule","known":true,"selectionKnown":true,"modeKnown":true}}}
        """
    }
    private var success: ModelReply { ModelReply(text: #"{"applied":true,"persisted":true}"#) }
    @MainActor private func model(_ replies: [ModelReply]) async throws -> (AppModel, ModelScenario) {
        let scenario = ModelScenario([ModelReply(text: snapshot(0))] + replies)
        ModelProtocol.scenario = scenario
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ModelProtocol.self]
        let client = EngineClient(session: URLSession(configuration: configuration), lease: authorizedTestLease())
        let model = AppModel(runtime: EngineRuntime(client: client, resourcesDirectory: nil))
        model.ready = true
        try await model.refresh()
        return (model, scenario)
    }
    @MainActor private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<5000 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("Mock model operation did not settle")
        throw APIError(message: "fixture deadline")
    }
    @MainActor func testSuccessThenFailedSwitchDoesNotReuseSuccessNotice() async throws {
        let (model, scenario) = try await model([success, ModelReply(text: snapshot(1)), ModelReply(status: 502, text: #"{"error":"fixture failure"}"#), ModelReply(text: snapshot(1))])
        model.setNode(1); try await until { !model.working }
        XCTAssertEqual(model.effectiveSelection, 1)
        XCTAssertEqual(model.switchNotice, "已确认生效并保存")
        model.setNode(2); try await until { !model.working }
        XCTAssertEqual(scenario.requestCount, 5)
        XCTAssertEqual(model.effectiveSelection, 1)
        XCTAssertFalse(model.switchNotice.contains("已确认生效并保存"))
        XCTAssertTrue(model.switchNotice.contains("失败"))
        XCTAssertTrue(model.canSwitch)
    }
    @MainActor func testTimedOutSwitchUsesReconciledEffectiveValueWithoutClaimingSaved() async throws {
        let (model, _) = try await model([ModelReply(error: .timedOut), ModelReply(text: snapshot(2))])
        model.setNode(2); try await until { !model.working }
        XCTAssertEqual(model.effectiveSelection, 2)
        XCTAssertTrue(model.effectiveTrusted)
        XCTAssertFalse(model.switchNotice.contains("生效并保存"))
        XCTAssertTrue(model.switchNotice.contains("失败"))
    }
    @MainActor func testRequestAndReconciliationFailureLeaveUnknownAndAllowRetry() async throws {
        let (model, scenario) = try await model([ModelReply(error: .timedOut), ModelReply(error: .cannotConnectToHost), success, ModelReply(text: snapshot(1))])
        model.setNode(1); try await until { !model.working }
        XCTAssertFalse(model.effectiveTrusted)
        XCTAssertNil(model.effectiveSelection)
        XCTAssertTrue(model.canSwitch)
        XCTAssertTrue(model.switchNotice.contains("未知"))
        model.setNode(1); try await until { !model.working }
        XCTAssertEqual(model.effectiveSelection, 1)
        XCTAssertEqual(scenario.requestCount, 5)
    }
    @MainActor func testPendingSwitchRejectsSecondClickThenAllowsSameTargetRetry() async throws {
        var delayed = success; delayed.held = true
        let (model, scenario) = try await model([delayed, ModelReply(text: snapshot(1)), success, ModelReply(text: snapshot(1))])
        model.setNode(1); try await until { scenario.requestCount == 2 }
        XCTAssertTrue(model.working)
        model.setNode(2)
        XCTAssertEqual(scenario.requestCount, 2)
        scenario.releaseFirst(); try await until { !model.working }
        model.setNode(1); try await until { !model.working }
        XCTAssertEqual(scenario.requestCount, 5)
        XCTAssertEqual(model.effectiveSelection, 1)
    }
    @MainActor func testOutOfOrderRefreshCannotReplaceNewerSnapshot() async throws {
        let (model, scenario) = try await model([ModelReply(text: snapshot(1), held: true), ModelReply(text: snapshot(2))])
        let older = Task { try await model.refresh() }
        try await until { scenario.requestCount == 2 }
        try await model.refresh()
        XCTAssertEqual(model.effectiveSelection, 2)
        scenario.releaseFirst(); try await older.value
        XCTAssertEqual(model.effectiveSelection, 2)
    }
    @MainActor func testRefreshStartedBeforeMutationCannotUndoReconciliation() async throws {
        let (model, scenario) = try await model([ModelReply(text: snapshot(0), held: true), success, ModelReply(text: snapshot(1))])
        let older = Task { try await model.refresh() }
        try await until { scenario.requestCount == 2 }
        model.setNode(1); try await until { !model.working }
        XCTAssertEqual(model.effectiveSelection, 1)
        scenario.releaseFirst(); try await older.value
        XCTAssertEqual(model.effectiveSelection, 1)
    }
    @MainActor func testSuccessfulReplyWithFailedReconciliationStillDisplaysUnknown() async throws {
        let (model, _) = try await model([success, ModelReply(error: .cannotConnectToHost)])
        model.setNode(1); try await until { !model.working }
        XCTAssertNil(model.effectiveSelection)
        XCTAssertFalse(model.effectiveTrusted)
        XCTAssertTrue(model.switchNotice.contains("未知"))
        XCTAssertTrue(model.canSwitch)
    }
    @MainActor func testOldLeaseRefreshCannotReplaceNewLaunchSnapshot() async throws {
        let (model, scenario) = try await model([ModelReply(text: snapshot(1), held: true), ModelReply(text: snapshot(2))])
        let older = Task { try await model.refresh() }
        try await until { scenario.requestCount == 2 }
        let lease = model.client.lease
        let credentials = lease.begin(isAlive: { true })
        try lease.confirmListener(instanceId: credentials.instanceId)
        try lease.confirm(instanceId: credentials.instanceId)
        try await model.refresh()
        scenario.releaseFirst(); try await older.value
        XCTAssertEqual(model.effectiveSelection, 2)
    }
}
