import XCTest
@testable import JMSNative

/// Actual model flows, with only URLProtocol and an in-memory Native action.
/// No child, helper, AuthorizationServices, or system preferences are invoked.
final class RecoveryModelTests: XCTestCase {
    private func state(pending: Bool = true, mode: String = "sysproxy") -> String {
        """
        {"settings":{"selected":0,"mode":"\(mode)","port":2080,"clashApi":"127.0.0.1:9090","autoRefreshMinutes":0,"routingMode":"rule","localDns":"system","remoteDns":"https://fixture.invalid/dns-query","customRules":[],"apps":[],"reverseApps":false},"subscription":{"url":"","hasUrl":false,"nodes":[]},"status":{"connected":false,"running":false,"pendingProxyJournal":\(pending),"recoveryRequired":\(pending),"node":null,"busy":null}}
        """
    }
    private func reset() { StubProtocol.failure = nil; StubProtocol.reply = (200, "{}"); StubProtocol.requests = [] }
    @MainActor private func model(mode: String = "sysproxy", isolated: Bool = false) throws -> AppModel {
        reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = EngineClient(session: URLSession(configuration: configuration), lease: authorizedTestLease())
        let runtime = EngineRuntime(client: client, resourcesDirectory: nil, configuration: RuntimeConfiguration(info: ["JMSIsolatedMode": isolated]))
        let model = AppModel(runtime: runtime)
        model.snapshot = try JSONDecoder().decode(EngineSnapshot.self, from: Data(state(mode: mode).utf8))
        model.ready = true
        StubProtocol.reply = (200, state(mode: mode))
        return model
    }
    @MainActor private func settle(_ model: AppModel) async throws {
        for _ in 0..<200 {
            if !model.working { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("Pure recovery action must finish within the bounded fixture")
    }
    @MainActor func testLimitedReadyBlocksOrdinaryMutationWithoutLosingRecoveryEntry() throws {
        defer { reset() }
        let model = try model()
        XCTAssertTrue(model.ready)
        XCTAssertTrue(model.recoveryRequired)
        XCTAssertFalse(model.canSwitch)
        XCTAssertTrue(model.canControlConnection)
        XCTAssertTrue(model.selectionSummary.contains("原日志已保留"))
        model.settings(["port": 3456]); model.setRoutingMode("direct"); model.setNode(0)
        XCTAssertFalse(model.working)
        XCTAssertTrue(StubProtocol.requests.isEmpty)
    }
    @MainActor func testCancelledExplicitRecoveryKeepsPendingEvidenceAndDoesNotOpenTUNPrompt() async throws {
        defer { reset() }
        let model = try model()
        var actions: [String] = []
        model.nativeProxyAction = { action in actions.append(action); throw APIError(message: "用户取消，恢复未确认", code: "CANCELLED") }
        model.recoverProxy()
        try await settle(model)
        XCTAssertEqual(actions, ["disconnect"])
        XCTAssertTrue(model.snapshot?.status.pendingProxyJournal == true)
        XCTAssertTrue(model.recoveryRequired)
        XCTAssertFalse(model.canSwitch)
        XCTAssertFalse(model.showTunPermission)
        XCTAssertEqual(model.error, "用户取消，恢复未确认")
        XCTAssertTrue(StubProtocol.requests.allSatisfy { $0.url?.path == "/api/state" })
    }
    @MainActor func testVerifiedExplicitRecoveryReconcilesActualSnapshotBeforeReenablingControls() async throws {
        defer { reset() }
        let model = try model()
        var actions: [String] = []
        let recovered = state(pending: false)
        model.nativeProxyAction = { action in actions.append(action); StubProtocol.reply = (200, recovered) }
        model.recoverProxy()
        try await settle(model)
        XCTAssertEqual(actions, ["disconnect"])
        XCTAssertFalse(model.recoveryRequired)
        XCTAssertTrue(model.snapshot?.status.pendingProxyJournal == false)
        XCTAssertTrue(model.canSwitch)
        XCTAssertFalse(model.showTunPermission)
    }
    @MainActor func testPendingSysproxyJournalUsesRecoveryEvenWhenDesiredModeWasChangedToTUN() async throws {
        defer { reset() }
        let model = try model(mode: "tun-per-app")
        var actions: [String] = []
        model.nativeProxyAction = { action in actions.append(action); throw APIError(message: "待恢复", code: "RECOVERY_REQUIRED") }
        model.toggleConnection()
        try await settle(model)
        XCTAssertEqual(actions, ["disconnect"])
        XCTAssertFalse(model.showTunPermission)
        XCTAssertTrue(model.snapshot?.status.pendingProxyJournal == true)
    }
    @MainActor func testCandidateNeverUsesTheNativeInteractiveAction() async throws {
        defer { reset() }
        let model = try model(isolated: true)
        var actions = 0
        model.nativeProxyAction = { _ in actions += 1 }
        model.recoverProxy()
        try await settle(model)
        XCTAssertEqual(actions, 0)
    }
}
