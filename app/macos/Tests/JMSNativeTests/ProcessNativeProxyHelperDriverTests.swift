import XCTest
import CryptoKit
@testable import JMSNative

final class ProcessNativeProxyHelperDriverTests: XCTestCase {
    @MainActor func testInitAndUnreviewedPrepareNeverSpawn() async throws {
        let fixture = try DriverFixture()
        XCTAssertEqual(fixture.factory.makes, 0)
        do { _ = try await fixture.driver.request(fixture.prepare); XCTFail("Unreviewed plan accepted") } catch { }
        XCTAssertEqual(fixture.factory.makes, 0)
        await fixture.driver.cancelBeforeCommit()
        XCTAssertEqual(fixture.factory.makes, 0)
    }
    @MainActor func testReviewedPrepareCommitSuccessWaitsForConfirmedOwnedExit() async throws {
        let fixture = try DriverFixture()
        try fixture.driver.confirmReview(fixture.review)
        let prepared = try await fixture.driver.request(fixture.prepare)
        var returned = false
        let commit = Task { let result = try await fixture.driver.request(fixture.commit(prepared)); returned = true; return result }
        defer { commit.cancel() }
        try await wait { fixture.process.commits == 1 }
        await Task.yield(); XCTAssertFalse(returned)
        XCTAssertTrue(fixture.driver.isActive)
        XCTAssertEqual(fixture.process.aborts, 0)
        fixture.process.exit()
        let result = try await commit.value
        XCTAssertTrue(result["ok"] as? Bool == true)
        try await fixture.driver.complete()
        XCTAssertFalse(fixture.driver.isActive)
    }
    @MainActor func testPrepermitCancellationAbortsOnlyFakeOwnedProcess() async throws {
        let fixture = try DriverFixture()
        try fixture.driver.confirmReview(fixture.review)
        _ = try await fixture.driver.request(fixture.prepare)
        await fixture.driver.cancelBeforeCommit()
        XCTAssertEqual(fixture.process.aborts, 1)
        XCTAssertEqual(fixture.process.commits, 0)
    }
    @MainActor func testCommitPartialWriteAndEOFRemainUnknownAndNeverTerminate() async throws {
        for mode in [FakeOwnedHelper.Mode.partialWrite, .eof] {
            let fixture = try DriverFixture()
            try fixture.driver.confirmReview(fixture.review)
            let prepared = try await fixture.driver.request(fixture.prepare)
            fixture.process.mode = mode
            do { _ = try await fixture.driver.request(fixture.commit(prepared)); XCTFail("Unverified commit succeeded") }
            catch let error as APIError { XCTAssertEqual(error.code, "NATIVE_PROXY_UNKNOWN") }
            XCTAssertTrue(fixture.driver.isActive)
            XCTAssertEqual(fixture.process.aborts, 0)
            await fixture.driver.cancelBeforeCommit(); try? await fixture.driver.complete()
            XCTAssertEqual(fixture.process.aborts, 0)
            XCTAssertThrowsError(try fixture.driver.confirmReview(fixture.review))
            let writes = fixture.process.sends
            do { _ = try await fixture.driver.request(fixture.commit(prepared)); XCTFail("Commit replay accepted") } catch { }
            XCTAssertEqual(fixture.process.sends, writes)
            fixture.process.exit(); XCTAssertFalse(fixture.driver.isActive)
        }
    }
    @MainActor func testCommitTimeoutAndLateSuccessCannotBecomeVerified() async throws {
        let fixture = try DriverFixture()
        try fixture.driver.confirmReview(fixture.review)
        let prepared = try await fixture.driver.request(fixture.prepare)
        fixture.process.mode = .silent; fixture.clock.hold = true
        let operation = Task { try await fixture.driver.request(fixture.commit(prepared)) }
        defer { operation.cancel() }
        try await wait { fixture.process.commits == 1 && fixture.clock.hasCommitWaiter }
        fixture.clock.now = 61; fixture.clock.fire()
        do { _ = try await operation.value; XCTFail("Timed-out commit succeeded") }
        catch let error as APIError { XCTAssertEqual(error.code, "NATIVE_PROXY_UNKNOWN") }
        fixture.process.emitSuccess(fixture.commit(prepared))
        XCTAssertTrue(fixture.driver.isActive)
        XCTAssertEqual(fixture.process.aborts, 0)
        let completion = Task { try await fixture.driver.complete() }
        defer { completion.cancel() }
        try await wait { fixture.clock.hasCompletionWaiter }
        fixture.clock.now = 64 // Beyond complete()'s own two-second deadline (61 + 2).
        fixture.clock.fire()
        do { try await completion.value; XCTFail("Live helper completion succeeded") }
        catch let error as APIError { XCTAssertEqual(error.code, "NATIVE_PROXY_UNKNOWN") }
        XCTAssertTrue(fixture.driver.isActive)
        XCTAssertEqual(fixture.process.aborts, 0)
        fixture.process.exit()
    }
    @MainActor func testCancelledCommitWaitKeepsOwnedHelperActiveWithoutKill() async throws {
        let fixture = try DriverFixture()
        try fixture.driver.confirmReview(fixture.review)
        let prepared = try await fixture.driver.request(fixture.prepare)
        fixture.process.mode = .silent
        let operation = Task { try await fixture.driver.request(fixture.commit(prepared)) }
        defer { operation.cancel() }
        try await wait { fixture.process.commits == 1 }
        operation.cancel()
        do { _ = try await operation.value; XCTFail("Cancelled commit became success") }
        catch let error as APIError { XCTAssertEqual(error.code, "NATIVE_PROXY_UNKNOWN") }
        XCTAssertTrue(fixture.driver.isActive)
        XCTAssertEqual(fixture.process.aborts, 0)
        fixture.process.emitSuccess(fixture.commit(prepared))
        XCTAssertTrue(fixture.driver.isActive)
        fixture.process.exit()
    }
    @MainActor func testSuccessCandidateWithLiveHelperTimesOutAndLateExitCannotSucceed() async throws {
        let fixture = try DriverFixture()
        try fixture.driver.confirmReview(fixture.review)
        let prepared = try await fixture.driver.request(fixture.prepare)
        fixture.clock.hold = true
        let commit = Task { try await fixture.driver.request(fixture.commit(prepared)) }
        defer { commit.cancel() }
        try await wait { fixture.process.commits == 1 && fixture.clock.hasCommitWaiter }
        XCTAssertTrue(fixture.driver.isActive)
        fixture.clock.now = 61; fixture.clock.fire()
        do { _ = try await commit.value; XCTFail("Live helper proof escaped") }
        catch let error as APIError { XCTAssertEqual(error.code, "NATIVE_PROXY_UNKNOWN") }
        XCTAssertEqual(fixture.process.aborts, 0)
        fixture.process.exit()
        XCTAssertFalse(fixture.driver.isActive)
        let fresh = try DriverFixture()
        try fixture.driver.confirmReview(fresh.review) // New explicit confirmation only; no old proof returned.
    }
    @MainActor func testFalseExitNotificationCannotFinalizeLiveHelperCandidate() async throws {
        let fixture = try DriverFixture()
        try fixture.driver.confirmReview(fixture.review)
        let prepared = try await fixture.driver.request(fixture.prepare)
        let commit = Task { try await fixture.driver.request(fixture.commit(prepared)) }
        defer { commit.cancel() }
        try await wait { fixture.process.commits == 1 }
        fixture.process.falseExit()
        do { _ = try await commit.value; XCTFail("False helper exit accepted") }
        catch let error as APIError { XCTAssertEqual(error.code, "NATIVE_PROXY_UNKNOWN") }
        XCTAssertTrue(fixture.driver.isActive); XCTAssertEqual(fixture.process.aborts, 0)
        fixture.process.exit()
    }
    @MainActor func testPreparedAckExpiryHasNoCommitAndSafelyAborts() async throws {
        let fixture = try DriverFixture()
        try fixture.driver.confirmReview(fixture.review)
        let prepared = try await fixture.driver.request(fixture.prepare)
        fixture.clock.now = 5
        do { _ = try await fixture.driver.request(fixture.commit(prepared)); XCTFail("Expired ACK accepted") } catch { }
        XCTAssertEqual(fixture.process.commits, 0)
        XCTAssertGreaterThan(fixture.process.aborts, 0)
    }
    @MainActor func testWrongDigestAndChangedPlanNeverReachFactory() async throws {
        let fixture = try DriverFixture()
        try fixture.driver.confirmReview(fixture.review)
        var wrong = fixture.prepare; wrong["planDigest"] = String(repeating: "0", count: 64)
        do { _ = try await fixture.driver.request(wrong); XCTFail("Wrong plan accepted") } catch { }
        XCTAssertEqual(fixture.factory.makes, 0)
    }
    @MainActor func testDoubleClickAndReplayNeverSpawnSecondOwnedProcess() async throws {
        let fixture = try DriverFixture()
        try fixture.driver.confirmReview(fixture.review)
        _ = try await fixture.driver.request(fixture.prepare)
        XCTAssertThrowsError(try fixture.driver.confirmReview(fixture.review))
        do { _ = try await fixture.driver.request(fixture.prepare); XCTFail("Replay accepted") } catch { }
        XCTAssertEqual(fixture.factory.makes, 1)
    }
    @MainActor func testUnderlyingErrorsRemainGenericAndNoRawDiagnosticsExpose() async throws {
        let fixture = try DriverFixture()
        fixture.process.mode = .privateError
        try fixture.driver.confirmReview(fixture.review)
        do { _ = try await fixture.driver.request(fixture.prepare); XCTFail("Error ignored") }
        catch { XCTAssertFalse(error.localizedDescription.contains("PRIVATE_STDERR")) }
        XCTAssertEqual(fixture.process.commits, 0)
    }
    @MainActor func testReviewConfirmationExpiresAndInvalidClocksNeverSpawn() async throws {
        for time in [30.0, Double.infinity, Double.nan, -1.0] {
            let fixture = try DriverFixture()
            try fixture.driver.confirmReview(fixture.review)
            fixture.clock.now = time
            do { _ = try await fixture.driver.request(fixture.prepare); XCTFail("Stale confirmation accepted") } catch { }
            XCTAssertEqual(fixture.factory.makes, 0)
        }
        let invalid = try DriverFixture(); invalid.clock.now = .nan
        XCTAssertThrowsError(try invalid.driver.confirmReview(invalid.review))
        XCTAssertEqual(invalid.factory.makes, 0)
    }
    @MainActor func testUnconsumedReviewCannotBeReconfirmedOrReplaced() throws {
        let fixture = try DriverFixture(), replacement = try DriverFixture()
        try fixture.driver.confirmReview(fixture.review)
        XCTAssertThrowsError(try fixture.driver.confirmReview(fixture.review))
        XCTAssertThrowsError(try fixture.driver.confirmReview(replacement.review))
        XCTAssertEqual(fixture.factory.makes, 0)
    }
    func testOwnedHelperEnvironmentIsMinimalAndNeverInheritsLoaderOrSecrets() {
        let source = ["HOME": "/Users/fixture", "TMPDIR": "/tmp/fixture", "USER": "fixture", "LOGNAME": "fixture", "LANG": "en_US.UTF-8", "LC_ALL": "C", "PATH": "/malicious", "DYLD_INSERT_LIBRARIES": "private", "LD_PRELOAD": "private", "NODE_OPTIONS": "private", "JMS_API_TOKEN": "private", "JMS_INSTANCE_ID": "private", "JMS_PROXY_HELPER": "private", "API_KEY": "private", "LC_API_TOKEN": "private", "OTHER": "private"]
        let result = OwnedHelperEnvironment.make(from: source)
        XCTAssertEqual(Set(result.keys), ["HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "PATH"])
        XCTAssertEqual(result["HOME"], source["HOME"])
        XCTAssertEqual(result["LC_ALL"], "C")
        XCTAssertEqual(result["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin")
        for value in ["bad\nvalue", "bad\tvalue", "bad\u{001b}value", "bad\0value"] {
            XCTAssertNil(OwnedHelperEnvironment.make(from: ["LANG": value])["LANG"])
        }
    }
    @MainActor func testAmbiguousReviewCannotReachFactory() throws {
        let fixture = try DriverFixture()
        let original = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(fixture.prepare["planData"] as? String)))
        let text = String(decoding: original, as: UTF8.self)
        let candidates = [
            text.replacingOccurrences(of: #""version":1"#, with: #""version":1,"version":1"#),
            text.replacingOccurrences(of: #""version":1"#, with: #""version":1,"\u0076ersion":1"#),
            text.replacingOccurrences(of: #""schema":3"#, with: #""schema":3,"\u0073chema":3"#),
            String(repeating: "[", count: 65) + "true" + String(repeating: "]", count: 65)
        ]
        for candidate in candidates {
            let data = Data(candidate.utf8)
            XCTAssertThrowsError(try ProxyAuthorizationReview(planData: data, planDigest: hash(data), launchId: fixture.review.launchId, operationId: fixture.review.operationId, action: "connect")) { error in
                XCTAssertFalse(error.localizedDescription.contains("schema"))
                XCTAssertFalse(error.localizedDescription.contains(fixture.review.operationId))
            }
        }
        XCTAssertEqual(fixture.factory.makes, 0)
    }
    @MainActor func testOldExitedGenerationCannotCompleteOrCancelNewOwnedProcess() async throws {
        let old = FakeOwnedHelper(), fresh = FakeOwnedHelper(), clock = DriverClock()
        let factory = GenerationOwnedFactory([old, fresh])
        let driver = ProcessNativeProxyHelperDriver(factory: factory, now: { clock.now }, sleep: { try await clock.sleep($0) })
        let launch = UUID().uuidString, expectedSnapshot = old.snapshot
        func preparation(_ operation: String) throws -> (ProxyAuthorizationReview, [String: Any]) {
            let plan: [String: Any] = ["version": 1, "launchId": launch, "operationId": operation, "action": "apply", "target": ["host": "127.0.0.1", "port": 2080, "bypass": ["localhost"]], "expected": expectedSnapshot]
            let data = try JSONSerialization.data(withJSONObject: plan, options: [.sortedKeys]), digest = hash(data)
            return (try ProxyAuthorizationReview(planData: data, planDigest: digest, launchId: launch, operationId: operation, action: "connect"), ["operation": "interactivePrepare", "operationId": operation, "planDigest": digest, "planData": data.base64EncodedString()])
        }
        let (firstReview, firstRequest) = try preparation(UUID().uuidString)
        try driver.confirmReview(firstReview)
        let prepared = try await driver.request(firstRequest)
        let firstCommit = Task { try await driver.request(["operation": "interactiveCommit", "operationId": firstReview.operationId, "planDigest": firstReview.planDigest, "preparedDigest": prepared["preparedDigest"]!]) }
        defer { firstCommit.cancel() }
        try await wait { old.commits == 1 }
        let stale = try XCTUnwrap(old.callbackSnapshot())
        old.exit()
        _ = try await firstCommit.value
        XCTAssertFalse(driver.isActive)
        let (secondReview, secondRequest) = try preparation(UUID().uuidString)
        fresh.mode = .silent
        try driver.confirmReview(secondReview)
        var completed = false
        let pending = Task { defer { completed = true }; return try await driver.request(secondRequest) }
        defer { pending.cancel() }
        try await wait { factory.makes == 2 && fresh.sends == 1 }
        stale(.closed)
        stale(.frame(["ok": false, "phase": "finished", "operationId": firstReview.operationId, "planDigest": firstReview.planDigest, "code": "CANCELLED", "committed": false]))
        stale(.exited)
        await Task.yield()
        XCTAssertFalse(completed)
        XCTAssertTrue(driver.isActive)
        XCTAssertEqual(fresh.aborts, 0)
        fresh.emitSuccess(secondRequest)
        _ = try await pending.value
        XCTAssertTrue(completed)
        await driver.cancelBeforeCommit()
        XCTAssertFalse(driver.isActive)
    }
    @MainActor func testOldCompleteTimeoutCannotFailNewRecoveryGeneration() async throws {
        let old = FakeOwnedHelper(), fresh = FakeOwnedHelper(), clock = DriverClock()
        let factory = GenerationOwnedFactory([old, fresh])
        let driver = ProcessNativeProxyHelperDriver(factory: factory, now: { clock.now }, sleep: { try await clock.sleep($0) })
        let initial = try DriverFixture()
        try driver.confirmReview(initial.review)
        let prepared = try await driver.request(initial.prepare)
        old.mode = .partialWrite
        do { _ = try await driver.request(initial.commit(prepared)); XCTFail("Partial commit succeeded") } catch { }
        clock.hold = true
        let oldCompletion = Task { try await driver.complete() }
        defer { oldCompletion.cancel() }
        try await wait { clock.hasCompletionWaiter }
        // Simulate Broker's watchdog returning without cancelling the driver's
        // old completion task, then a confirmed old exit and explicit recovery.
        old.exit()
        let recoveryID = UUID().uuidString, launch = initial.review.launchId
        let plan: [String: Any] = ["version": 1, "launchId": launch, "operationId": recoveryID, "action": "restore", "original": fresh.snapshot, "proxyTarget": fresh.snapshot]
        let data = try JSONSerialization.data(withJSONObject: plan, options: [.sortedKeys]), digest = hash(data)
        let review = try ProxyAuthorizationReview(planData: data, planDigest: digest, launchId: launch, operationId: recoveryID, action: "disconnect")
        try driver.confirmReview(review)
        fresh.mode = .silent
        let request: [String: Any] = ["operation": "interactivePrepare", "operationId": recoveryID, "planDigest": digest, "planData": data.base64EncodedString()]
        var recoveryReturned = false
        let recovery = Task { defer { recoveryReturned = true }; return try await driver.request(request) }
        defer { recovery.cancel() }
        try await wait { factory.makes == 2 && fresh.sends == 1 }
        clock.now = 3
        clock.fireCompletion() // Wake ONLY the stale complete, not new prepare timers.
        do { try await oldCompletion.value; XCTFail("Stale completion reported new helper success") }
        catch let error as APIError { XCTAssertEqual(error.code, "NATIVE_PROXY_UNKNOWN") }
        XCTAssertFalse(recoveryReturned)
        XCTAssertTrue(driver.isActive)
        XCTAssertEqual(fresh.aborts, 0)
        fresh.emitSuccess(request)
        let recoveredPreparation = try await recovery.value
        XCTAssertTrue(recoveredPreparation["operationId"] as? String == recoveryID)
        await driver.cancelBeforeCommit()
        XCTAssertFalse(driver.isActive)
    }
    @MainActor private func wait(_ predicate: () -> Bool) async throws {
        for _ in 0..<10000 { if predicate() { return }; await Task.yield() }
        throw APIError(message: "Fake helper did not reach expected state")
    }
}

@MainActor private final class DriverFixture {
    let process: FakeOwnedHelper
    let clock: DriverClock
    let factory: FakeOwnedFactory
    let driver: ProcessNativeProxyHelperDriver
    let review: ProxyAuthorizationReview
    let prepare: [String: Any]
    init() throws {
        let process = FakeOwnedHelper(), clock = DriverClock()
        self.process = process; self.clock = clock
        factory = FakeOwnedFactory(process: process)
        driver = ProcessNativeProxyHelperDriver(factory: factory, now: { [clock] in clock.now }, sleep: { [clock] in try await clock.sleep($0) })
        let launch = UUID().uuidString, operation = UUID().uuidString
        let plan: [String: Any] = ["version": 1, "launchId": launch, "operationId": operation, "action": "apply", "target": ["host": "127.0.0.1", "port": 2080, "bypass": ["localhost"]], "expected": process.snapshot]
        let data = try JSONSerialization.data(withJSONObject: plan, options: [.sortedKeys])
        let digest = hash(data)
        review = try ProxyAuthorizationReview(planData: data, planDigest: digest, launchId: launch, operationId: operation, action: "connect")
        prepare = ["operation": "interactivePrepare", "operationId": operation, "planDigest": digest, "planData": data.base64EncodedString()]
    }
    func commit(_ prepared: [String: Any]) -> [String: Any] {
        ["operation": "interactiveCommit", "operationId": review.operationId, "planDigest": review.planDigest, "preparedDigest": prepared["preparedDigest"]!]
    }
}
@MainActor private final class FakeOwnedFactory: OwnedHelperProcessFactory {
    let process: FakeOwnedHelper
    var makes = 0
    init(process: FakeOwnedHelper) { self.process = process }
    func make() throws -> OwnedHelperProcess { makes += 1; return process }
}
@MainActor private final class GenerationOwnedFactory: OwnedHelperProcessFactory {
    private let processes: [FakeOwnedHelper]
    private(set) var makes = 0
    init(_ processes: [FakeOwnedHelper]) { self.processes = processes }
    func make() throws -> OwnedHelperProcess {
        guard makes < processes.count else { throw APIError(message: "Fake process budget exceeded") }
        defer { makes += 1 }
        return processes[makes]
    }
}
@MainActor private final class FakeOwnedHelper: OwnedHelperProcess {
    enum Mode { case success, partialWrite, eof, silent, privateError }
    var mode = Mode.success, isRunning = false
    var sends = 0, commits = 0, aborts = 0
    private var events: ((OwnedHelperEvent) -> Void)?
    let snapshot: [String: Any] = ["schema": 3, "services": [["id": "11111111-1111-1111-1111-111111111111", "name": "Fixture", "device": "en0", "proxies": ["present": false, "blob": NSNull()]]]]
    func start(events: @escaping (OwnedHelperEvent) -> Void) throws { self.events = events; isRunning = true }
    func send(_ frame: [String: Any]) async throws {
        sends += 1
        if frame["operation"] as? String == "interactiveCommit" { commits += 1 }
        switch mode {
        case .partialWrite: throw APIError(message: "PRIVATE_STDERR partial write")
        case .eof: events?(.closed)
        case .silent: break
        case .privateError: throw APIError(message: "PRIVATE_STDERR should not escape")
        case .success: emitSuccess(frame)
        }
    }
    func emitSuccess(_ frame: [String: Any]) {
        if frame["operation"] as? String == "interactivePrepare" {
            let data = try! JSONSerialization.data(withJSONObject: ["original": snapshot, "target": snapshot, "current": snapshot, "desired": snapshot], options: [.sortedKeys])
            events?(.frame(["ok": true, "phase": "prepared", "operationId": frame["operationId"]!, "planDigest": frame["planDigest"]!, "preparedDigest": hash(data), "preparedData": data.base64EncodedString()]))
        } else {
            events?(.frame(["ok": true, "phase": "finished", "operationId": frame["operationId"]!, "planDigest": frame["planDigest"]!, "preparedDigest": frame["preparedDigest"]!, "snapshot": snapshot, "verifiedSnapshot": snapshot, "committed": true, "applied": true]))
        }
    }
    func callbackSnapshot() -> ((OwnedHelperEvent) -> Void)? { events }
    func abortOwnedBeforePermit() { aborts += 1; exit() }
    func falseExit() { events?(.exited) }
    func exit() { isRunning = false; let handler = events; events = nil; handler?(.exited) }
}
@MainActor private final class DriverClock {
    var now: Double = 0, hold = false
    private var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]
    private var durations: [UUID: UInt64] = [:]
    var hasCommitWaiter: Bool { durations.values.contains(60_000_000_000) }
    var hasCompletionWaiter: Bool { durations.values.contains(10_000_000) }
    func sleep(_ nanoseconds: UInt64) async throws {
        guard hold else { throw CancellationError() }
        let id = UUID()
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { waiters[id] = $0; durations[id] = nanoseconds }
        }, onCancel: { Task { @MainActor in self.durations.removeValue(forKey: id); self.waiters.removeValue(forKey: id)?.resume(throwing: CancellationError()) } })
        try Task.checkCancellation()
    }
    func fireCompletion() {
        let matching = durations.filter { $0.value == 10_000_000 }.map { $0.key }
        for id in matching { durations.removeValue(forKey: id); waiters.removeValue(forKey: id)?.resume() }
    }
    func fire() { let saved = waiters; waiters.removeAll(); durations.removeAll(); for waiter in saved.values { waiter.resume() } }
}
private func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
