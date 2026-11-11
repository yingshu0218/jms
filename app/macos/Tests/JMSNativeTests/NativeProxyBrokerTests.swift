import XCTest
import CryptoKit
@testable import JMSNative

final class NativeProxyBrokerTests: XCTestCase {
    private var expectedSnapshot: [String: Any] { ["schema": 3, "services": [["id": "11111111-1111-1111-1111-111111111111", "name": "Fake", "device": "fake0", "proxies": ["present": false, "blob": NSNull()]]]] }
    func testCodecSplitFramesAndPrivateMalformedErrors() throws {
        var codec = NativeProxyCodec()
        let frame: [String: Any] = ["type": "hello", "version": 1, "launchId": "fixture"]
        let data = try NativeProxyCodec.encode(frame)
        XCTAssertTrue(try codec.append(data.prefix(4)).isEmpty)
        let decoded = try codec.append(data.dropFirst(4))
        XCTAssertEqual(decoded.count, 1)
        XCTAssertEqual(decoded.first?["type"] as? String, "hello")
        try codec.finish()
        XCTAssertThrowsError(try codec.append(Data("private-invalid\n".utf8))) { error in
            XCTAssertFalse(error.localizedDescription.contains("private-invalid"))
        }
    }
    func testCodecBoundAndTruncatedEOF() throws {
        var codec = NativeProxyCodec()
        XCTAssertThrowsError(try codec.append(Data(repeating: 120, count: NativeProxyCodec.limit + 1)))
        var truncated = NativeProxyCodec()
        _ = try truncated.append(Data("{".utf8))
        XCTAssertThrowsError(try truncated.finish())
    }
    @MainActor func testIsolatedAndMissingHelloNeverSendOrInvokeDriver() async {
        let driver = FakeNativeProxyDriver()
        var sent = 0
        for isolated in [true, false] {
            let broker = NativeProxyBroker(isolated: isolated, launchId: UUID().uuidString, isAlive: { true }, sendFrame: { _ in sent += 1 }, helperDriver: driver)
            do { try await broker.perform(action: "connect"); XCTFail("Unarmed action accepted") } catch { }
        }
        XCTAssertEqual(sent, 0); XCTAssertEqual(driver.calls, 0)
    }
    @MainActor func testDefaultDriverFailsClosedWithoutAuthorizationOrProcess() async {
        let driver = UnavailableNativeProxyHelper()
        do { _ = try await driver.request([:]); XCTFail("Production authorization unexpectedly enabled") }
        catch let error as APIError { XCTAssertEqual(error.code, "AUTHORIZATION_REQUIRED") }
        catch { XCTFail("Unexpected error category") }
        XCTAssertFalse(driver.isActive)
    }
    @MainActor func testFakePrepareFailureCompletesAndReplayDoesNotInvokeAgain() async throws {
        let launch = UUID().uuidString, driver = FakeNativeProxyDriver()
        var sent: [[String: Any]] = []
        let broker = NativeProxyBroker(isolated: false, launchId: launch, isAlive: { true }, sendFrame: { sent.append($0) }, helperDriver: driver)
        await broker.receive(["version": 1, "type": "hello", "launchId": launch])
        let action = Task { try await broker.perform(action: "connect") }
        try await wait { sent.first?["type"] as? String == "begin" }
        let operation = try XCTUnwrap(sent.first?["operationId"] as? String)
        let plan: [String: Any] = ["version": 1, "launchId": launch, "operationId": operation, "action": "apply", "target": ["host": "127.0.0.1", "port": 2080, "bypass": ["localhost"]], "expected": expectedSnapshot]
        let bytes = try JSONSerialization.data(withJSONObject: plan, options: [.sortedKeys])
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let frame: [String: Any] = ["version": 1, "type": "helper", "launchId": launch, "operationId": operation, "sequence": 1, "planDigest": digest, "request": ["operation": "interactivePrepare", "operationId": operation, "planDigest": digest, "planData": bytes.base64EncodedString()]]
        await broker.receive(frame)
        XCTAssertEqual(driver.calls, 1)
        XCTAssertTrue(sent.contains { $0["type"] as? String == "helper-result" })
        await broker.receive(["version": 1, "type": "complete", "launchId": launch, "operationId": operation, "ok": false, "code": "SYS_PROXY_AUTHORIZATION_REQUIRED", "message": "Raw node message must not display"])
        do { try await action.value; XCTFail("Failed action reported success") }
        catch let error as APIError {
            XCTAssertEqual(error.code, "SYS_PROXY_AUTHORIZATION_REQUIRED")
            XCTAssertFalse(error.message.contains("Raw node message"))
        }
        await broker.receive(frame)
        XCTAssertEqual(driver.calls, 1)
    }
    @MainActor func testOwnedExitRevokesPendingActionWithoutHelperInvocation() async throws {
        let launch = UUID().uuidString, driver = FakeNativeProxyDriver()
        var sent = false, alive = true
        let broker = NativeProxyBroker(isolated: false, launchId: launch, isAlive: { alive }, sendFrame: { _ in sent = true }, helperDriver: driver)
        await broker.receive(["version": 1, "type": "hello", "launchId": launch])
        let action = Task { try await broker.perform(action: "disconnect") }
        try await wait { sent }
        alive = false; await broker.revoke()
        do { try await action.value; XCTFail("Dead launch accepted") } catch { }
        XCTAssertEqual(driver.calls, 0)
        do { try await broker.perform(action: "disconnect"); XCTFail("Dead launch rearmed") } catch { }
    }
    @MainActor func testFakePrepareCommitAndVerifiedCompletion() async throws {
        try await exerciseCommit(failure: nil)
    }
    @MainActor func testPostpermitFailuresRequireExplicitInactiveDisconnectRecovery() async throws {
        for failure in [false as Any, true as Any, "unknown" as Any] { try await exerciseCommit(failure: failure) }
    }
    @MainActor func testCompletionErrorOrTimeoutRetainsPermitAndLateExitCannotSucceed() async throws {
        try await exerciseCommit(failure: nil, completionMode: 1)
        try await exerciseCommit(failure: nil, completionMode: 2)
    }
    @MainActor func testCompletionWaitsForDelayedInactiveProof() async throws {
        try await exerciseCommit(failure: nil, completionMode: 3)
    }
    @MainActor private func exerciseCommit(failure: Any?, completionMode: Int = 0) async throws {
        let launch = UUID().uuidString, driver = SuccessfulFakeNativeProxyDriver()
        driver.failureCommit = failure
        driver.completionMode = completionMode
        let completionTimer = FakeBrokerCompletionTimer()
        defer { completionTimer.cancel(); driver.releaseAfterExit() }
        var sent: [[String: Any]] = []
        let broker = NativeProxyBroker(isolated: false, launchId: launch, isAlive: { true }, sendFrame: { sent.append($0) }, helperDriver: driver, sleep: { duration in
            if duration == 2_000_000_000 && completionMode == 2 { try await completionTimer.wait(); return }
            throw CancellationError() // Other budgets are not advanced in this fixture.
        })
        await broker.receive(["version": 1, "type": "hello", "launchId": launch])
        let action = Task { try await broker.perform(action: "connect") }
        try await wait { !sent.isEmpty }
        let operation = try XCTUnwrap(sent.first?["operationId"] as? String)
        let plan: [String: Any] = ["version": 1, "launchId": launch, "operationId": operation, "action": "apply", "target": ["host": "127.0.0.1", "port": 2080, "bypass": ["localhost"]], "expected": expectedSnapshot]
        let bytes = try JSONSerialization.data(withJSONObject: plan, options: [.sortedKeys])
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        await broker.receive(["version": 1, "type": "helper", "launchId": launch, "operationId": operation, "sequence": 1, "planDigest": digest, "request": ["operation": "interactivePrepare", "operationId": operation, "planDigest": digest, "planData": bytes.base64EncodedString()]])
        XCTAssertEqual(driver.calls, 1)
        let response = try XCTUnwrap(sent.last?["response"] as? [String: Any])
        let preparedDigest = try XCTUnwrap(response["preparedDigest"] as? String)
        await broker.receive(["version": 1, "type": "helper", "launchId": launch, "operationId": operation, "sequence": 2, "planDigest": digest, "request": ["operation": "interactiveCommit", "operationId": operation, "planDigest": digest, "preparedDigest": preparedDigest]])
        XCTAssertEqual(driver.calls, 2)
        if completionMode != 0 {
            let completing = Task { await broker.receive(["version": 1, "type": "complete", "launchId": launch, "operationId": operation, "ok": true, "result": ["confirmed": true, "helperUsed": true]]) }
            if completionMode >= 2 { try await wait { driver.waitingForExit } }
            if completionMode == 2 {
                try await wait { completionTimer.isArmed }
                completionTimer.fire() // Driver is definitely inside complete before watchdog fires.
            }
            if completionMode == 3 {
                XCTAssertThrowsError(try broker.ensureHelperInactive())
                driver.releaseAfterExit()
                await completing.value; try await action.value
                try broker.ensureHelperInactive()
            } else {
                await completing.value
                do { try await action.value; XCTFail("Unconfirmed complete succeeded") }
                catch let error as APIError { XCTAssertEqual(error.code, "NATIVE_PROXY_UNKNOWN") }
                XCTAssertThrowsError(try broker.ensureHelperInactive())
                driver.releaseAfterExit(); await Task.yield()
                do { try await broker.perform(action: "connect"); XCTFail("Late completion erased UNKNOWN") } catch { }
            }
            return
        }
        if failure == nil {
            await broker.receive(["version": 1, "type": "complete", "launchId": launch, "operationId": operation, "ok": true, "result": ["confirmed": true, "helperUsed": true]])
            try await action.value
        } else {
            await broker.receive(["version": 1, "type": "complete", "launchId": launch, "operationId": operation, "ok": false, "code": "UNKNOWN", "message": "Never display this raw message"])
            do { try await action.value; XCTFail("Unknown result accepted") } catch let error as APIError { XCTAssertEqual(error.code, "NATIVE_PROXY_UNKNOWN") }
            do { try await broker.perform(action: "connect"); XCTFail("Unknown transaction reconnected") } catch { }
            driver.isActive = true
            do { try await broker.perform(action: "disconnect"); XCTFail("Live helper recovery accepted") } catch { }
            driver.isActive = false
            let count = sent.count
            let recovery = Task { try await broker.perform(action: "disconnect") }
            try await wait { sent.count > count }
            let recoveryID = try XCTUnwrap(sent.last?["operationId"] as? String)
            await broker.receive(["version": 1, "type": "complete", "launchId": launch, "operationId": recoveryID, "ok": true, "result": ["confirmed": true, "helperUsed": false]])
            try await recovery.value
        }
        XCTAssertFalse(driver.isActive)
    }
    @MainActor func testMissingOrWrongExpectedSnapshotNeverInvokesDriver() async throws {
        let invalidExpected: [[String: Any]?] = [nil, ["schema": 2, "services": [["id": "fake"]]]]
        for expected in invalidExpected {
            let launch = UUID().uuidString, driver = FakeNativeProxyDriver()
            var sent: [[String: Any]] = []
            let broker = NativeProxyBroker(isolated: false, launchId: launch, isAlive: { true }, sendFrame: { sent.append($0) }, helperDriver: driver)
            await broker.receive(["version": 1, "type": "hello", "launchId": launch])
            let action = Task { try await broker.perform(action: "connect") }
            try await wait { !sent.isEmpty }
            let operation = try XCTUnwrap(sent.first?["operationId"] as? String)
            var plan: [String: Any] = ["version": 1, "launchId": launch, "operationId": operation, "action": "apply", "target": ["host": "127.0.0.1", "port": 2080, "bypass": ["localhost"]]]
            if let expected { plan["expected"] = expected }
            let bytes = try JSONSerialization.data(withJSONObject: plan, options: [.sortedKeys])
            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            await broker.receive(["version": 1, "type": "helper", "launchId": launch, "operationId": operation, "sequence": 1, "planDigest": digest, "request": ["operation": "interactivePrepare", "operationId": operation, "planDigest": digest, "planData": bytes.base64EncodedString()]])
            do { try await action.value; XCTFail("Invalid expected snapshot accepted") } catch { }
            XCTAssertEqual(driver.calls, 0)
        }
    }
    @MainActor private func wait(_ predicate: () -> Bool) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        while !predicate() {
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw APIError(message: "Fake broker test timed out") }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
    }
}
@MainActor private final class FakeNativeProxyDriver: NativeProxyHelperDriver {
    var calls = 0
    var isActive = false
    func request(_ request: [String: Any]) async throws -> [String: Any] {
        calls += 1
        return ["ok": false, "phase": "finished", "operationId": request["operationId"] ?? "", "planDigest": request["planDigest"] ?? "", "code": "AUTHORIZATION_REQUIRED", "committed": false]
    }
    func cancelBeforeCommit() async { isActive = false }
    func complete() async { isActive = false }
}

@MainActor private final class SuccessfulFakeNativeProxyDriver: NativeProxyHelperDriver {
    var calls = 0
    var isActive = false
    var failureCommit: Any?
    var completionMode = 0
    private var completionContinuation: CheckedContinuation<Void, Never>?
    var waitingForExit: Bool { completionContinuation != nil }
    func releaseAfterExit() {
        isActive = false
        let saved = completionContinuation; completionContinuation = nil; saved?.resume()
    }
    private let snapshot: [String: Any] = ["schema": 3, "services": [["id": "11111111-1111-1111-1111-111111111111", "name": "Fake", "device": "fake0", "proxies": ["present": false, "blob": NSNull()]]]]
    func request(_ request: [String: Any]) async throws -> [String: Any] {
        calls += 1; isActive = true
        if request["operation"] as? String == "interactivePrepare" {
            let data = try JSONSerialization.data(withJSONObject: ["original": snapshot, "target": snapshot, "current": snapshot, "desired": snapshot], options: [.sortedKeys])
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            return ["ok": true, "phase": "prepared", "operationId": request["operationId"]!, "planDigest": request["planDigest"]!, "preparedDigest": digest, "preparedData": data.base64EncodedString()]
        }
        if let failureCommit {
            return ["ok": false, "phase": "finished", "operationId": request["operationId"]!, "planDigest": request["planDigest"]!, "preparedDigest": request["preparedDigest"]!, "code": "UNKNOWN", "committed": failureCommit]
        }
        return ["ok": true, "phase": "finished", "operationId": request["operationId"]!, "planDigest": request["planDigest"]!, "preparedDigest": request["preparedDigest"]!, "snapshot": snapshot, "verifiedSnapshot": snapshot, "committed": true, "applied": true]
    }
    func cancelBeforeCommit() async { isActive = false }
    func complete() async throws {
        if completionMode == 1 { throw APIError(message: "Private complete error") }
        if completionMode >= 2 { await withCheckedContinuation { completionContinuation = $0 }; return }
        isActive = false
    }
}

@MainActor private final class FakeBrokerCompletionTimer {
    private var continuation: CheckedContinuation<Void, Error>?
    var isArmed: Bool { continuation != nil }
    func wait() async throws {
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation = $0 }
        }, onCancel: { Task { @MainActor in self.cancel() } })
        try Task.checkCancellation()
    }
    func fire() { let saved = continuation; continuation = nil; saved?.resume() }
    func cancel() { let saved = continuation; continuation = nil; saved?.resume(throwing: CancellationError()) }
}
