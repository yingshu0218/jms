import XCTest
@testable import JMSNative

final class AppModelHelperExitTests: XCTestCase {
    @MainActor func testLiveHelperBlocksNeverLaunchedExitThenInactiveRetrySucceeds() async {
        let runtime = EngineRuntime()
        let model = AppModel(runtime: runtime)
        var live = true, calls = 0
        model.proxyHelperExitCheck = {
            calls += 1
            if live { throw HelperExitFixtureFailure() }
        }
        let first = await model.shutdown()
        XCTAssertFalse(first)
        XCTAssertFalse(model.shuttingDown)
        XCTAssertEqual(calls, 1)
        XCTAssertNotNil(model.shutdownError)
        XCTAssertFalse(model.shutdownError?.contains("private helper detail") == true)
        XCTAssertNil(runtime.process)
        live = false
        let retry = await model.shutdown()
        XCTAssertTrue(retry)
        XCTAssertEqual(calls, 3) // Before draining and immediately before no-process exit.
        XCTAssertNil(runtime.process)
    }
    @MainActor func testOldVerifiedCleanupCannotBypassLiveHelper() async {
        let lease = EngineLease(); let credentials = lease.begin(isAlive: { false })
        let client = EngineClient(lease: lease)
        defer { client.session.invalidateAndCancel() }
        var safety = EngineExitSafety()
        safety.recordLaunch(instanceId: credentials.instanceId)
        safety.recordVerifiedCleanup(instanceId: credentials.instanceId)
        let runtime = EngineRuntime(client: client, exitSafety: safety)
        let model = AppModel(runtime: runtime)
        var live = true, calls = 0
        model.proxyHelperExitCheck = {
            calls += 1
            if live { throw HelperExitFixtureFailure() }
        }
        XCTAssertTrue(runtime.canExitWithoutLiveEngine)
        let blocked = await model.shutdown()
        XCTAssertFalse(blocked)
        XCTAssertFalse(model.shuttingDown)
        XCTAssertEqual(calls, 1)
        live = false
        let retry = await model.shutdown()
        XCTAssertTrue(retry)
        XCTAssertEqual(calls, 3)
        XCTAssertNil(runtime.process)
    }
    @MainActor func testSecondCheckBlocksHelperAppearingAfterDrainAndAllowsRetry() async {
        let runtime = EngineRuntime()
        let model = AppModel(runtime: runtime)
        var calls = 0
        model.proxyHelperExitCheck = {
            calls += 1
            if calls == 2 { throw HelperExitFixtureFailure() }
        }
        let blocked = await model.shutdown()
        XCTAssertFalse(blocked)
        XCTAssertFalse(model.shuttingDown)
        XCTAssertEqual(calls, 2)
        let retry = await model.shutdown()
        XCTAssertTrue(retry)
        XCTAssertEqual(calls, 4)
        XCTAssertNil(runtime.process)
    }
    @MainActor func testIsolatedExitAlsoRequiresHelperInactiveProof() async {
        let runtime = EngineRuntime(configuration: RuntimeConfiguration(info: ["JMSIsolatedMode": true]))
        let model = AppModel(runtime: runtime)
        var calls = 0
        model.proxyHelperExitCheck = { calls += 1; throw HelperExitFixtureFailure() }
        let blocked = await model.shutdown()
        XCTAssertFalse(blocked)
        XCTAssertFalse(model.shuttingDown)
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(model.error, model.shutdownError)
        XCTAssertNil(runtime.process)
    }
}
private struct HelperExitFixtureFailure: LocalizedError {
    var errorDescription: String? { "private helper detail must never reach UI" }
}
