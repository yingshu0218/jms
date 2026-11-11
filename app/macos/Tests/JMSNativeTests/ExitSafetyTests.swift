import XCTest
@testable import JMSNative

final class ExitSafetyTests: XCTestCase {
    @MainActor private func makeModel(safety: EngineExitSafety = EngineExitSafety(), isolated: Bool = false, ready: Bool = false) -> AppModel {
        let runtime = EngineRuntime(configuration: RuntimeConfiguration(info: ["JMSIsolatedMode": isolated]), exitSafety: safety)
        let model = AppModel(runtime: runtime)
        model.ready = ready
        return model
    }
    @MainActor func testNeverLaunchedCanCloseWithoutClaimingNetworkRecovery() async {
        let result = await makeModel().shutdown()
        XCTAssertTrue(result)
    }
    @MainActor func testDeathBeforeReadyStillRequiresRecovery() async {
        var safety = EngineExitSafety(); safety.recordLaunch(instanceId: "before-ready")
        let model = makeModel(safety: safety)
        let result = await model.shutdown()
        XCTAssertFalse(result)
        XCTAssertFalse(model.shuttingDown)
        XCTAssertTrue(model.shutdownError?.contains("无法确认系统代理已恢复") == true)
    }
    @MainActor func testDeathAfterReadyStillRequiresRecovery() async {
        var safety = EngineExitSafety(); safety.recordLaunch(instanceId: "after-ready")
        let model = makeModel(safety: safety, ready: true)
        let result = await model.shutdown()
        XCTAssertFalse(result)
        XCTAssertFalse(model.shuttingDown)
    }
    @MainActor func testIsolatedLaunchCanExitAfterEngineDeath() async {
        var safety = EngineExitSafety(); safety.recordLaunch(instanceId: "isolated")
        let result = await makeModel(safety: safety, isolated: true).shutdown()
        XCTAssertTrue(result)
    }
    @MainActor func testVerifiedCleanupAllowsExitAfterProcessIsGone() async {
        var safety = EngineExitSafety(); safety.recordLaunch(instanceId: "clean")
        safety.recordVerifiedCleanup(instanceId: "clean")
        let result = await makeModel(safety: safety).shutdown()
        XCTAssertTrue(result)
    }
    func testNewLaunchAndStaleCleanupCannotInheritSafetyProof() {
        var safety = EngineExitSafety(); safety.recordLaunch(instanceId: "old")
        safety.recordVerifiedCleanup(instanceId: "old")
        XCTAssertTrue(safety.canExitWithoutLiveEngine(isolated: false))
        safety.recordLaunch(instanceId: "new")
        safety.recordVerifiedCleanup(instanceId: "old")
        XCTAssertFalse(safety.canExitWithoutLiveEngine(isolated: false))
    }
}
