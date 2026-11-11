import XCTest
@testable import ProxyPreferencesCore

private final class FakeAuthorization: InteractiveAuthorizationProvider {
    let store: PreferencesStore
    var acquires = 0, releases = 0
    var denied = false
    var beforeBody: (() throws -> Void)?
    init(_ store: PreferencesStore) { self.store = store }
    func withStore<T>(_ body: (PreferencesStore) throws -> T) throws -> T {
        acquires += 1
        if denied { throw Failure(.authorizationRequired, .no) }
        defer { releases += 1 }
        try beforeBody?()
        return try body(store)
    }
}
final class InteractiveTransactionTests: XCTestCase {
    let operationId = "AAAAAAAA-1111-2222-3333-EEEEEEEEEEEE"
    let launchId = "BBBBBBBB-1111-2222-3333-EEEEEEEEEEEE"
    func original() throws -> Snapshot {
        Snapshot(services: [Service(id: "CCCCCCCC-1111-2222-3333-EEEEEEEEEEEE", name: "Wi-Fi", device: "en0", proxies: try RawProxies(nil))])
    }
    func request(restore: (Snapshot, Snapshot)? = nil, override: [String: Any] = [:]) throws -> Data {
        var plan: [String: Any] = ["version": 1, "launchId": launchId, "operationId": operationId, "action": "apply",
            "target": ["host": "127.0.0.1", "port": 2080, "bypass": ["localhost"]],
            "expected": try JSONSerialization.jsonObject(with: JSONEncoder().encode(original()))]
        if let (original, target) = restore {
            plan.removeValue(forKey: "target"); plan.removeValue(forKey: "expected"); plan["action"] = "restore"
            plan["original"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(original))
            plan["proxyTarget"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(target))
        }
        for (key, value) in override { plan[key] = value }
        let data = try JSONSerialization.data(withJSONObject: plan)
        return try JSONSerialization.data(withJSONObject: ["operation": "interactivePrepare", "operationId": operationId,
            "planDigest": InteractiveTransactionRunner.digest(data), "planData": data.base64EncodedString()])
    }
    func permit(_ prepared: InteractivePreparedResponse, operation: String = "interactiveCommit", override: [String: Any] = [:]) throws -> Data {
        var result: [String: Any] = ["operation": operation, "operationId": prepared.operationId,
            "planDigest": prepared.planDigest, "preparedDigest": prepared.preparedDigest]
        for (key, value) in override { result[key] = value }
        return try JSONSerialization.data(withJSONObject: result)
    }
    func testUnavailableProviderNeverInvokesCommitCallback() throws {
        var callback = false
        XCTAssertThrowsError(try InteractiveTransactionRunner().run(request: request()) { _, _ in callback = true; return Data() }) {
            XCTAssertEqual(($0 as? Failure)?.code, .authorizationRequired)
            XCTAssertEqual(($0 as? Failure)?.committed, .no)
        }
        XCTAssertFalse(callback)
    }
    func testPreparedBindingWALBeforeCommitAndTwoReadbacks() throws {
        let store = MemoryStore(try original()), provider = FakeAuthorization(store)
        let result = try InteractiveTransactionRunner(authorizer: provider).run(request: request()) { prepared, _ in
            XCTAssertEqual(store.writes, 0); XCTAssertEqual(store.commits, 0)
            let bytes = try XCTUnwrap(Data(base64Encoded: prepared.preparedData))
            XCTAssertEqual(prepared.preparedDigest, InteractiveTransactionRunner.digest(bytes))
            let state = try JSONDecoder().decode(InteractivePreparedState.self, from: bytes)
            XCTAssertTrue(try state.current.same(as: state.original))
            return try permit(prepared) // represents successful durable journal ACK
        }
        XCTAssertTrue(try result.snapshot.same(as: result.verifiedSnapshot))
        XCTAssertEqual(store.commits, 1); XCTAssertEqual(store.applies, 1)
        XCTAssertEqual(provider.acquires, 1); XCTAssertEqual(provider.releases, 1)
    }
    func testAbortMalformedWrongDigestReplayAndJournalFailureNeverCommit() throws {
        for variant in 0..<6 {
            let store = MemoryStore(try original()), provider = FakeAuthorization(store)
            let runner = InteractiveTransactionRunner(authorizer: provider)
            XCTAssertThrowsError(try runner.run(request: request()) { prepared, _ in
                switch variant {
                case 0: return try permit(prepared, operation: "interactiveAbort")
                case 1: return try permit(prepared, override: ["operationId": UUID().uuidString])
                case 2: return try permit(prepared, override: ["preparedDigest": String(repeating: "0", count: 64)])
                case 3: return Data()
                case 4: throw Failure(.commitFailed, .no) // journal fsync failed
                default: return try permit(prepared, override: ["extra": true])
                }
            }) { XCTAssertEqual(($0 as? Failure)?.committed, .no) }
            XCTAssertEqual(store.writes, 0); XCTAssertEqual(store.commits, 0); XCTAssertEqual(store.applies, 0)
            XCTAssertThrowsError(try runner.run(request: request()) { prepared, _ in try permit(prepared) })
            XCTAssertEqual(provider.acquires, 1); XCTAssertEqual(provider.releases, 1)
        }
    }
    func testLatePermissionRejectedAndNoReauthorization() throws {
        var time: TimeInterval = 10
        let store = MemoryStore(try original()), provider = FakeAuthorization(store)
        XCTAssertThrowsError(try InteractiveTransactionRunner(authorizer: provider, now: { time }).run(request: request()) { prepared, deadline in
            XCTAssertEqual(deadline, 15); time = 15
            return try permit(prepared)
        }) { XCTAssertEqual(($0 as? Failure)?.code, .commitPermissionTimeout) }
        XCTAssertEqual(store.writes, 0); XCTAssertEqual(provider.acquires, 1)
    }
    func testChangedStateDuringACKRejectsBeforeWrite() throws {
        let store = MemoryStore(try original())
        XCTAssertThrowsError(try InteractiveTransactionRunner(authorizer: FakeAuthorization(store)).run(request: request()) { prepared, _ in
            store.current.services[0].device = "en9"
            return try permit(prepared)
        }) { XCTAssertEqual(($0 as? Failure)?.code, .conflict) }
        XCTAssertEqual(store.writes, 0)
    }
    func testAuthorizationWaitCannotReplaceConfirmedExpectedState() throws {
        for change in 0..<3 {
            let store = ReadbackFailureStore(try original(), failureRead: nil)
            let provider = FakeAuthorization(store)
            provider.beforeBody = {
                if change == 0 { store.base.current.services[0].name = "Renamed service" }
                if change == 1 { store.base.current.services[0].proxies = try RawProxies(["HTTPEnable": 0]) }
                if change == 2 { store.base.current.services[0].device = "en9" }
            }
            var prepared = false
            XCTAssertThrowsError(try InteractiveTransactionRunner(authorizer: provider).run(request: request()) { _, _ in
                prepared = true; return Data()
            }) {
                XCTAssertEqual(($0 as? Failure)?.code, .conflict)
                XCTAssertEqual(($0 as? Failure)?.committed, .no)
            }
            XCTAssertFalse(prepared)
            XCTAssertEqual(store.base.writes, 0); XCTAssertEqual(store.base.commits, 0); XCTAssertEqual(store.base.applies, 0)
            XCTAssertEqual(store.locks, 1); XCTAssertEqual(store.unlocks, 1)
            XCTAssertEqual(provider.releases, 1)
        }
    }
    func testApplyPlanRequiresExpectedField() throws {
        var wire = try XCTUnwrap(JSONSerialization.jsonObject(with: request()) as? [String: Any])
        let bytes = try XCTUnwrap(Data(base64Encoded: wire["planData"] as! String))
        var plan = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        plan.removeValue(forKey: "expected")
        let updated = try JSONSerialization.data(withJSONObject: plan)
        wire["planData"] = updated.base64EncodedString()
        wire["planDigest"] = InteractiveTransactionRunner.digest(updated)
        let store = MemoryStore(try original()), provider = FakeAuthorization(store)
        XCTAssertThrowsError(try InteractiveTransactionRunner(authorizer: provider).run(request: JSONSerialization.data(withJSONObject: wire)) { prepared, _ in try permit(prepared) })
        XCTAssertEqual(provider.acquires, 0); XCTAssertEqual(store.writes, 0)
    }
    func testInvalidExpectedNeverObtainsAuthorization() throws {
        let invalid: [Any] = [NSNull(), ["schema": 3, "services": []]]
        for value in invalid {
            let store = MemoryStore(try original()), provider = FakeAuthorization(store)
            XCTAssertThrowsError(try InteractiveTransactionRunner(authorizer: provider).run(request: request(override: ["expected": value])) { prepared, _ in try permit(prepared) })
            XCTAssertEqual(provider.acquires, 0); XCTAssertEqual(store.writes, 0)
        }
    }
    func testInvalidPlansNeverAcquireAuthorization() throws {
        for override in [["launchId": "invalid"], ["action": "arbitrary"], ["prefsID": "/tmp/other"], ["target": ["host": "remote.invalid", "port": 2080, "bypass": []]]] as [[String: Any]] {
            let store = MemoryStore(try original()), provider = FakeAuthorization(store)
            XCTAssertThrowsError(try InteractiveTransactionRunner(authorizer: provider).run(request: request(override: override)) { prepared, _ in try permit(prepared) })
            XCTAssertEqual(provider.acquires, 0); XCTAssertEqual(store.writes, 0)
        }
    }
    func testCommitApplyReadbackFailuresPreserveOutcome() throws {
        for stage in 0..<4 {
            let store = MemoryStore(try original())
            store.failWrite = stage == 0; store.failCommit = stage == 1
            store.failApply = stage == 2; store.corruptReadback = stage == 3
            XCTAssertThrowsError(try InteractiveTransactionRunner(authorizer: FakeAuthorization(store)).run(request: request()) { prepared, _ in try permit(prepared) }) {
                XCTAssertEqual(($0 as? Failure)?.committed, stage == 0 ? .no : stage == 1 ? .unknown : .yes)
            }
        }
    }
    func testInvalidEncodedPlanAndDigestNeverAcquire() throws {
        for variant in 0..<3 {
            var wire = try XCTUnwrap(JSONSerialization.jsonObject(with: request()) as? [String: Any])
            if variant == 0 { wire["planDigest"] = String(repeating: "0", count: 64) }
            if variant == 1 { wire["planData"] = (wire["planData"] as! String) + "!" }
            if variant == 2 { wire["unknown"] = true }
            let store = MemoryStore(try original()), provider = FakeAuthorization(store)
            XCTAssertThrowsError(try InteractiveTransactionRunner(authorizer: provider).run(request: JSONSerialization.data(withJSONObject: wire)) { prepared, _ in try permit(prepared) })
            XCTAssertEqual(provider.acquires, 0); XCTAssertEqual(store.writes, 0)
        }
    }
    func testDuplicatePlanKeysRejectBeforeAuthorization() throws {
        let expectedJSON = String(data: try JSONEncoder().encode(original()), encoding: .utf8)!
        let plan = "{\"version\":1,\"launchId\":\"\(launchId)\",\"operationId\":\"\(operationId)\",\"action\":\"apply\",\"expected\":\(expectedJSON),\"target\":{\"host\":\"127.0.0.1\",\"port\":2080,\"port\":2081,\"bypass\":[]}}"
        let bytes = Data(plan.utf8)
        let wire = try JSONSerialization.data(withJSONObject: ["operation": "interactivePrepare", "operationId": operationId,
            "planDigest": InteractiveTransactionRunner.digest(bytes), "planData": bytes.base64EncodedString()])
        let store = MemoryStore(try original()), provider = FakeAuthorization(store)
        XCTAssertThrowsError(try InteractiveTransactionRunner(authorizer: provider).run(request: wire) { prepared, _ in try permit(prepared) })
        XCTAssertEqual(provider.acquires, 0)
    }
    func testAuthorizationCancelAndLockFailureArePreWrite() throws {
        for denied in [true, false] {
            let store = MemoryStore(try original()), provider = FakeAuthorization(store)
            provider.denied = denied
            if !denied { store.lockFailure = Failure(.conflict, .no) }
            var called = false
            XCTAssertThrowsError(try InteractiveTransactionRunner(authorizer: provider).run(request: request()) { _, _ in called = true; return Data() }) {
                XCTAssertEqual(($0 as? Failure)?.committed, .no)
            }
            XCTAssertFalse(called); XCTAssertEqual(store.writes, 0); XCTAssertEqual(store.commits, 0)
            XCTAssertEqual(provider.releases, denied ? 0 : 1)
        }
    }
    func testSecondReadbackFailureCannotReturnSuccess() throws {
        let store = ReadbackFailureStore(try original())
        XCTAssertThrowsError(try InteractiveTransactionRunner(authorizer: FakeAuthorization(store)).run(request: request()) { prepared, _ in try permit(prepared) }) {
            XCTAssertEqual(($0 as? Failure)?.code, .readbackFailed)
            XCTAssertEqual(($0 as? Failure)?.committed, .yes)
        }
        XCTAssertEqual(store.reads, 4)
        XCTAssertEqual(store.base.commits, 1); XCTAssertEqual(store.base.applies, 1)
    }
    func testSameValueRestoreStillCommitsAndApplies() throws {
        let source = try original(), store = MemoryStore(try original())
        let target = try Transaction(store: MemoryStore(source)).prepare(Target(host: "127.0.0.1", port: 2080, bypass: [])).target
        let result = try InteractiveTransactionRunner(authorizer: FakeAuthorization(store)).run(request: request(restore: (source, target))) { prepared, _ in try permit(prepared) }
        XCTAssertTrue(try result.snapshot.same(as: source)); XCTAssertEqual(store.commits, 1); XCTAssertEqual(store.applies, 1)
    }
    func testRestoreExternalMutationCannotBeOverwritten() throws {
        let source = try original(), store = MemoryStore(try original())
        let target = try Transaction(store: MemoryStore(source)).prepare(Target(host: "127.0.0.1", port: 2080, bypass: [])).target
        store.current.services[0].proxies = try RawProxies(["HTTPProxy": "elsewhere.invalid"])
        XCTAssertThrowsError(try InteractiveTransactionRunner(authorizer: FakeAuthorization(store)).run(request: request(restore: (source, target))) { prepared, _ in try permit(prepared) })
        XCTAssertEqual(store.writes, 0); XCTAssertEqual(store.commits, 0)
    }
}
final class StableObservationTests: XCTestCase {
    func testTwoFreshReadOnlySamplesAndChangedStateRejection() throws {
        let original = Snapshot(services: [Service(id: "CCCCCCCC-1111-2222-3333-EEEEEEEEEEEE", name: "Wi-Fi", device: "en0", proxies: try RawProxies(nil))])
        var calls = 0
        XCTAssertTrue(try StableObservation.read { calls += 1; return original }.same(as: original))
        XCTAssertEqual(calls, 2)
        calls = 0
        XCTAssertThrowsError(try StableObservation.read {
            calls += 1; var value = original
            if calls == 2 { value.services[0].device = "changed" }
            return value
        }) { XCTAssertEqual(($0 as? Failure)?.code, .conflict) }
    }
    func testInvalidObservationAndReadFailureStayReadOnly() throws {
        XCTAssertThrowsError(try StableObservation.read { Snapshot(services: []) })
        XCTAssertThrowsError(try StableObservation.read { throw Failure(.authorizationRequired, .no) })
    }
}

private final class ReadbackFailureStore: PreferencesStore {
    let base: MemoryStore
    var reads = 0, locks = 0, unlocks = 0
    let failureRead: Int?
    init(_ snapshot: Snapshot, failureRead: Int? = 4) { base = MemoryStore(snapshot); self.failureRead = failureRead }
    func lock() throws { locks += 1; try base.lock() }
    func unlock() { unlocks += 1; base.unlock() }
    func synchronize() { base.synchronize() }
    func read() throws -> Snapshot {
        reads += 1
        if let failureRead, reads == failureRead { throw Failure(.authorizationRequired, .no) }
        return try base.read()
    }
    func write(id: String, proxies: RawProxies) throws { try base.write(id: id, proxies: proxies) }
    func commit() -> Bool { base.commit() }
    func apply() -> Bool { base.apply() }
}
