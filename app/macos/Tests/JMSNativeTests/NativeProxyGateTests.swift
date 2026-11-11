import XCTest
import CryptoKit
@testable import JMSNative

final class NativeProxyGateTests: XCTestCase {
    private let launch = UUID().uuidString, operation = UUID().uuidString
    private var raw: [String: Any] { ["schema": 3, "services": [["id": "00000000-0000-0000-0000-000000000001"]]] }
    private func encoded(_ object: [String: Any]) throws -> (String, String) {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return (data.base64EncodedString(), SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
    }
    private func frame(host: String = "127.0.0.1", action: String = "apply") throws -> [String: Any] {
        let (data, hash) = try encoded(["version": 1, "launchId": launch, "operationId": operation, "action": action,
                                      "target": ["host": host, "port": 2080, "bypass": ["localhost"]], "expected": raw])
        return ["version": 1, "type": "helper", "launchId": launch, "operationId": operation, "sequence": 1, "planDigest": hash,
                "request": ["operation": "interactivePrepare", "operationId": operation, "planDigest": hash, "planData": data]]
    }
    private func begun(now: @escaping () -> Double = { 0 }) throws -> NativeProxyUserActionGate {
        var gate = NativeProxyUserActionGate(isolated: false, now: now)
        try gate.begin(launchId: launch, operationId: operation, action: "connect"); return gate
    }
    private func prepare(_ gate: inout NativeProxyUserActionGate) throws -> [String: Any] {
        let f = try frame(); _ = try gate.validateHelperRequest(f)
        let (data, hash) = try encoded(["original": raw, "target": raw, "current": raw, "desired": raw])
        try gate.acceptHelperResponse(["ok": true, "phase": "prepared", "operationId": operation,
                                      "planDigest": f["planDigest"]!, "preparedDigest": hash, "preparedData": data], sequence: 1)
        return ["version": 1, "type": "helper", "launchId": launch, "operationId": operation, "sequence": 2,
                "planDigest": f["planDigest"]!, "request": ["operation": "interactiveCommit", "operationId": operation,
                "planDigest": f["planDigest"]!, "preparedDigest": hash]]
    }
    func testCandidateAndDoubleClickCannotGrantHelperAccess() throws {
        var candidate = NativeProxyUserActionGate(isolated: true)
        XCTAssertThrowsError(try candidate.begin(launchId: launch, operationId: operation, action: "connect"))
        var gate = try begun()
        XCTAssertThrowsError(try gate.begin(launchId: launch, operationId: UUID().uuidString, action: "disconnect"))
        XCTAssertEqual(gate.phase, .preparing)
    }
    func testPrepareConsumedExactlyOnce() throws {
        var gate = try begun(); let f = try frame()
        _ = try gate.validateHelperRequest(f)
        XCTAssertThrowsError(try gate.validateHelperRequest(f))
        XCTAssertThrowsError(try gate.validateHelperRequest(f))
        XCTAssertFalse(gate.commitPermitted)
    }
    func testWrongIdentityActionTargetDigestAndUnknownKeysReject() throws {
        var variants = [try frame(host: "example.invalid"), try frame(action: "restore")]
        var wrong = try frame(); wrong["launchId"] = UUID().uuidString; variants.append(wrong)
        wrong = try frame(); wrong["planDigest"] = String(repeating: "0", count: 64); variants.append(wrong)
        wrong = try frame(); wrong["extra"] = true; variants.append(wrong)
        wrong = try frame(); wrong["sequence"] = true; variants.append(wrong)
        for f in variants { var gate = try begun(); XCTAssertThrowsError(try gate.validateHelperRequest(f)); XCTAssertNil(gate.activeOperationId) }
    }
    func testApplyExpectedSnapshotRequiredAndIncludedInExactDigest() throws {
        let invalidExpected: [[String: Any]?] = [nil, ["schema": 2, "services": [["id": "fake"]]], ["schema": 3, "services": []]]
        for expected in invalidExpected {
            var plan: [String: Any] = ["version": 1, "launchId": launch, "operationId": operation, "action": "apply",
                                       "target": ["host": "127.0.0.1", "port": 2080, "bypass": ["localhost"]]]
            if let expected { plan["expected"] = expected }
            let (data, hash) = try encoded(plan)
            let invalid: [String: Any] = ["version": 1, "type": "helper", "launchId": launch, "operationId": operation, "sequence": 1, "planDigest": hash,
                                          "request": ["operation": "interactivePrepare", "operationId": operation, "planDigest": hash, "planData": data]]
            var gate = try begun()
            XCTAssertThrowsError(try gate.validateHelperRequest(invalid))
            XCTAssertFalse(gate.commitPermitted)
            XCTAssertNil(gate.activeOperationId)
        }
    }
    func testPreparedDigestMustHashExactBytes() throws {
        var gate = try begun(); let f = try frame(); _ = try gate.validateHelperRequest(f)
        XCTAssertThrowsError(try gate.acceptHelperResponse(["ok": true, "phase": "prepared", "operationId": operation,
                             "planDigest": f["planDigest"]!, "preparedDigest": String(repeating: "0", count: 64), "preparedData": "e30="], sequence: 1))
        XCTAssertFalse(gate.commitPermitted)
    }
    func testFiveSecondCommitDeadlineAndCommitReplay() throws {
        let clock = GateClock(); var gate = try begun(now: { clock.now }); let commit = try prepare(&gate)
        clock.now = 5
        XCTAssertThrowsError(try gate.validateHelperRequest(commit)); XCTAssertFalse(gate.commitPermitted)
        gate = try begun(); let fresh = try prepare(&gate); _ = try gate.validateHelperRequest(fresh)
        XCTAssertTrue(gate.commitPermitted)
        XCTAssertThrowsError(try gate.validateHelperRequest(fresh))
        XCTAssertThrowsError(try gate.begin(launchId: launch, operationId: UUID().uuidString, action: "connect"))
    }
    func testPostcommitRevokeRetainsUnknownAndBlocksNextAction() throws {
        var gate = try begun(); let commit = try prepare(&gate); _ = try gate.validateHelperRequest(commit)
        gate.revoke(); XCTAssertTrue(gate.commitPermitted)
        XCTAssertThrowsError(try gate.begin(launchId: launch, operationId: UUID().uuidString, action: "disconnect"))
    }
    func testProductionAuthorizationRefusalCompletesWithoutCommit() throws {
        var gate = try begun(); let f = try frame(); _ = try gate.validateHelperRequest(f)
        try gate.acceptHelperResponse(["ok": false, "phase": "finished", "operationId": operation, "planDigest": f["planDigest"]!,
                                      "code": "AUTHORIZATION_REQUIRED", "committed": false], sequence: 1)
        try gate.complete(["version": 1, "type": "complete", "launchId": launch, "operationId": operation,
                           "ok": false, "code": "AUTHORIZATION_REQUIRED", "message": "Unavailable"])
        XCTAssertNil(gate.activeOperationId); XCTAssertFalse(gate.commitPermitted)
        XCTAssertThrowsError(try gate.begin(launchId: launch, operationId: operation, action: "connect"))
    }
    func testSuccessfulExactCommitCanFinish() throws {
        var gate = try begun(); let commit = try prepare(&gate); _ = try gate.validateHelperRequest(commit)
        let request = try XCTUnwrap(commit["request"] as? [String: Any])
        try gate.acceptHelperResponse(["ok": true, "phase": "finished", "operationId": operation, "planDigest": commit["planDigest"]!,
                                      "preparedDigest": request["preparedDigest"]!, "snapshot": raw, "verifiedSnapshot": raw,
                                      "committed": true, "applied": true], sequence: 2)
        try gate.complete(["version": 1, "type": "complete", "launchId": launch, "operationId": operation, "ok": true, "result": ["confirmed": true, "helperUsed": true]])
        XCTAssertNil(gate.activeOperationId)
    }
    func testNoopSuccessRequiresStrictTypedConfirmationAndNoHelper() throws {
        var gate = try begun()
        try gate.complete(["version": 1, "type": "complete", "launchId": launch, "operationId": operation, "ok": true,
                           "result": ["confirmed": true, "helperUsed": false]])
        XCTAssertNil(gate.activeOperationId)
        let invalidResults: [[String: Any]] = [["confirmed": 1, "helperUsed": false], ["confirmed": true, "helperUsed": 0], ["confirmed": false, "helperUsed": false], ["confirmed": true, "helperUsed": false, "extra": true]]
        for result in invalidResults {
            var invalid = try begun()
            XCTAssertThrowsError(try invalid.complete(["version": 1, "type": "complete", "launchId": launch, "operationId": operation, "ok": true, "result": result]))
        }
        var used = try begun(); _ = try prepare(&used)
        XCTAssertThrowsError(try used.complete(["version": 1, "type": "complete", "launchId": launch, "operationId": operation, "ok": true, "result": ["confirmed": true, "helperUsed": false]]))
    }
    func testEveryPostpermitFailureBlocksConnectButAllowsExplicitInactiveRecovery() throws {
        for committed in [false as Any, true as Any, "unknown" as Any] {
            var gate = try begun(); let commit = try prepare(&gate); _ = try gate.validateHelperRequest(commit)
            let request = try XCTUnwrap(commit["request"] as? [String: Any])
            try gate.acceptHelperResponse(["ok": false, "phase": "finished", "operationId": operation, "planDigest": commit["planDigest"]!,
                                           "preparedDigest": request["preparedDigest"]!, "code": "UNKNOWN", "committed": committed], sequence: 2)
            try gate.complete(["version": 1, "type": "complete", "launchId": launch, "operationId": operation, "ok": false, "code": "UNKNOWN", "message": "Unverified"])
            XCTAssertTrue(gate.recoveryRequired)
            XCTAssertThrowsError(try gate.begin(launchId: launch, operationId: UUID().uuidString, action: "connect", helperInactive: true))
            XCTAssertThrowsError(try gate.begin(launchId: launch, operationId: UUID().uuidString, action: "disconnect", helperInactive: false))
            let recovery = UUID().uuidString
            try gate.begin(launchId: launch, operationId: recovery, action: "disconnect", helperInactive: true)
            XCTAssertTrue(gate.recoveryRequired)
            try gate.complete(["version": 1, "type": "complete", "launchId": launch, "operationId": recovery, "ok": true, "result": ["confirmed": true, "helperUsed": false]])
            XCTAssertFalse(gate.recoveryRequired)
        }
    }
    func testCommitBudgetIsSixtySecondsWithInjectedClock() throws {
        let clock = GateClock(); var gate = try begun(now: { clock.now })
        let commit = try prepare(&gate); _ = try gate.validateHelperRequest(commit)
        clock.now = 60
        let request = try XCTUnwrap(commit["request"] as? [String: Any])
        XCTAssertThrowsError(try gate.acceptHelperResponse(["ok": false, "phase": "finished", "operationId": operation, "planDigest": commit["planDigest"]!, "preparedDigest": request["preparedDigest"]!, "code": "UNKNOWN", "committed": "unknown"], sequence: 2))
        XCTAssertTrue(gate.recoveryRequired)
    }
    func testPrecommitExpiryAndRevocationCannotResumeOldOperation() throws {
        let clock = GateClock(); var gate = try begun(now: { clock.now }); clock.now = 240
        XCTAssertThrowsError(try gate.validateHelperRequest(frame()))
        XCTAssertFalse(gate.commitPermitted)
        XCTAssertThrowsError(try gate.begin(launchId: launch, operationId: operation, action: "connect"))
    }
}
private final class GateClock { var now: Double = 0 }
