import XCTest
import Security
@testable import ProxyPreferencesCore

/// Opaque sentinels are compared only; no test calls Security/SC or dereferences them.
private final class AuthorizationFixture {
    var events: [String] = []
    var createStatus: OSStatus = errAuthorizationSuccess
    var freeStatus: OSStatus = errAuthorizationSuccess
    var returnNil = false, failFactory = false
    var creates = 0, factories = 0, frees = 0
    var references: [AuthorizationRef] = []
    var stores: [FakeClosableStore] = []
    func calls() -> AuthorizationCalls {
        AuthorizationCalls(create: { rights, environment, flags, output in
            XCTAssertNil(rights); XCTAssertNil(environment); XCTAssertEqual(flags.rawValue, 0)
            self.creates += 1; self.events.append("create")
            if !self.returnNil {
                let reference = OpaquePointer(bitPattern: 0x1000 + self.creates)!
                self.references.append(reference); output.pointee = reference
            }
            return self.createStatus
        }, makeStore: { reference in
            self.factories += 1; self.events.append("session")
            XCTAssertTrue(reference == self.references.last)
            if self.failFactory { throw ProviderTestError() }
            let store = FakeClosableStore { self.events.append($0) }
            self.stores.append(store)
            return store
        }, free: { reference, flags in
            XCTAssertEqual(flags.rawValue, 0) // never destroy shared cached rights
            XCTAssertTrue(self.references.contains(reference))
            XCTAssertTrue(self.stores.allSatisfy { $0.closed })
            self.frees += 1; self.events.append("free")
            return self.freeStatus
        })
    }
}
private struct ProviderTestError: Error {}
private final class FakeClosableStore: ClosablePreferencesStore {
    let event: (String) -> Void
    var closed = false, locked = false, validated = false
    var closeCount = 0
    var denyLock = false
    init(event: @escaping (String) -> Void) { self.event = event }
    func close() {
        guard !closed else { return }
        if locked { unlock() }
        validated = false; closed = true; closeCount += 1; event("close")
    }
    func lock() throws {
        guard !closed else { throw Failure(.invalidRequest, .no) }
        if denyLock { throw Failure(.authorizationRequired, .no) }
        locked = true; event("lock")
    }
    func unlock() { if locked { event("unlock") }; locked = false; validated = false }
    func synchronize() { if !closed { validated = false } }
    func read() throws -> Snapshot {
        guard !closed, locked else { throw Failure(.invalidRequest, .no) }
        validated = true
        return Snapshot(services: [Service(id: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", name: "Wi-Fi", device: "en0", proxies: try RawProxies(nil))])
    }
    func write(id: String, proxies: RawProxies) throws {
        guard !closed, locked, validated else { throw Failure(.invalidRequest, .no) }
    }
    func commit() -> Bool { !closed && locked }
    func apply() -> Bool { !closed && locked }
}
final class SystemAuthorizationProviderTests: XCTestCase {
    func testInitializationDoesNotCreateReferenceOrSession() {
        let fixture = AuthorizationFixture()
        _ = SystemAuthorizationProvider(calls: fixture.calls())
        XCTAssertEqual(fixture.events, [])
    }
    func testCreateFailureAndNilReferenceNeverCreateSCSession() {
        for kind in 0..<3 {
            let fixture = AuthorizationFixture()
            fixture.createStatus = kind == 2 ? errAuthorizationSuccess : errAuthorizationDenied
            fixture.returnNil = kind != 1
            let provider = SystemAuthorizationProvider(calls: fixture.calls())
            var called = false
            XCTAssertThrowsError(try provider.withStore { _ in called = true }) {
                XCTAssertEqual(($0 as? Failure)?.code, .authorizationRequired)
                XCTAssertEqual(($0 as? Failure)?.committed, .no)
            }
            XCTAssertFalse(called); XCTAssertEqual(fixture.factories, 0)
            XCTAssertEqual(fixture.frees, kind == 1 ? 1 : 0)
        }
    }
    func testFactoryFailureFreesOwnReferenceExactlyOnce() {
        let fixture = AuthorizationFixture(); fixture.failFactory = true
        XCTAssertThrowsError(try SystemAuthorizationProvider(calls: fixture.calls()).withStore { _ in XCTFail("must not run") }) {
            XCTAssertEqual(($0 as? Failure)?.code, .authorizationRequired)
        }
        XCTAssertEqual(fixture.events, ["create", "session", "free"])
        XCTAssertEqual(fixture.frees, 1)
    }
    func testNormalReturnClosesSessionBeforeFree() throws {
        let fixture = AuthorizationFixture()
        let result = try SystemAuthorizationProvider(calls: fixture.calls()).withStore { store in
            try store.lock(); _ = try store.read(); return 42
        }
        XCTAssertEqual(result, 42)
        XCTAssertEqual(fixture.events, ["create", "session", "lock", "unlock", "close", "free"])
        XCTAssertEqual(fixture.stores.first?.closeCount, 1); XCTAssertEqual(fixture.frees, 1)
    }
    func testThrowAndLockDenialStillCloseBeforeFree() {
        for denial in [true, false] {
            let fixture = AuthorizationFixture()
            XCTAssertThrowsError(try SystemAuthorizationProvider(calls: fixture.calls()).withStore { store in
                fixture.stores[0].denyLock = denial
                try store.lock()
                throw ProviderTestError()
            }) { error in
                XCTAssertEqual((error as? Failure)?.code, denial ? .authorizationRequired : .unsupported)
                XCTAssertEqual((error as? Failure)?.committed, denial ? .no : .unknown)
            }
            XCTAssertEqual(Array(fixture.events.suffix(2)), ["close", "free"])
            XCTAssertEqual(fixture.stores[0].closeCount, 1); XCTAssertEqual(fixture.frees, 1)
        }
    }
    func testEscapedStoreInvalidAfterScopeAndRepeatedCloseIsIdempotent() throws {
        let fixture = AuthorizationFixture()
        let escaped: PreferencesStore = try SystemAuthorizationProvider(calls: fixture.calls()).withStore { store in
            try store.lock(); _ = try store.read(); return store
        }
        XCTAssertThrowsError(try escaped.lock()); XCTAssertThrowsError(try escaped.read())
        XCTAssertThrowsError(try escaped.write(id: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", proxies: RawProxies(nil)))
        XCTAssertFalse(escaped.commit()); XCTAssertFalse(escaped.apply())
        fixture.stores[0].close(); fixture.stores[0].close()
        XCTAssertEqual(fixture.stores[0].closeCount, 1); XCTAssertEqual(fixture.frees, 1)
    }
    func testActualStoreInvalidatedStateRejectsEveryAccessWithoutSystemCalls() throws {
        let store = SystemPreferencesStore(invalidatedSession: ())
        XCTAssertThrowsError(try store.lock())
        XCTAssertThrowsError(try store.read())
        XCTAssertThrowsError(try store.write(id: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", proxies: RawProxies(nil)))
        XCTAssertFalse(store.commit()); XCTAssertFalse(store.apply())
        store.synchronize(); store.unlock(); store.close(); store.close()
        XCTAssertThrowsError(try store.lock())
    }
    func testEachTransactionUsesFreshReferenceAndSession() throws {
        let fixture = AuthorizationFixture(), provider: SystemAuthorizationProvider
        provider = SystemAuthorizationProvider(calls: fixture.calls())
        for _ in 0..<2 { try provider.withStore { store in try store.lock() } }
        XCTAssertEqual(fixture.creates, 2); XCTAssertEqual(fixture.factories, 2); XCTAssertEqual(fixture.frees, 2)
        XCTAssertTrue(fixture.references[0] != fixture.references[1])
        XCTAssertTrue(fixture.stores[0] !== fixture.stores[1])
    }
    func testFreeFailureDoesNotReportSuccessfulScope() {
        let fixture = AuthorizationFixture(); fixture.freeStatus = errAuthorizationInvalidRef
        XCTAssertThrowsError(try SystemAuthorizationProvider(calls: fixture.calls()).withStore { _ in 42 }) {
            XCTAssertEqual(($0 as? Failure)?.code, .unsupported)
            XCTAssertEqual(($0 as? Failure)?.committed, .unknown)
        }
        XCTAssertEqual(fixture.events, ["create", "session", "close", "free"])
    }
}
