import XCTest
import CoreFoundation
@testable import ProxyPreferencesCore

final class MemoryStore: PreferencesStore {
    var current: Snapshot
    var staged: Snapshot
    var writes = 0, commits = 0, applies = 0
    var failWrite = false, failCommit = false, failApply = false, corruptReadback = false
    init(_ snapshot: Snapshot) { current = snapshot; staged = snapshot }
    func lock() throws {}
    func unlock() {}
    func synchronize() { staged = current }
    func read() throws -> Snapshot {
        if corruptReadback && applies > 0 { return Snapshot(services: []) }
        return current
    }
    func write(id: String, proxies: RawProxies) throws {
        writes += 1
        if failWrite { throw Failure(.commitFailed, .no) }
        staged.services[staged.services.firstIndex(where: { $0.id == id })!].proxies = proxies
    }
    func commit() -> Bool { commits += 1; if failCommit { return false }; current = staged; return true }
    func apply() -> Bool { applies += 1; return !failApply }
}
final class TransactionTests: XCTestCase {
    let id = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
    func snapshot(_ dictionary: [String: Any]?) throws -> Snapshot {
        Snapshot(services: [Service(id: id, name: "Wi-Fi", device: "en0", proxies: try RawProxies(dictionary))])
    }
    func testStableBinaryPlistRoundTripAndDictionaryOrder() throws {
        var a: [String: Any] = [:], b: [String: Any] = [:]
        a["HTTPEnable"] = true; a["HTTPProxy"] = "localhost"; a["HTTPPort"] = 2080
        b["HTTPPort"] = 2080; b["HTTPProxy"] = "localhost"; b["HTTPEnable"] = true
        let raw = try RawProxies(a)
        XCTAssertEqual(raw.blob, try RawProxies(b).blob)
        let decoded = try XCTUnwrap(raw.dictionary())
        XCTAssertEqual(decoded["HTTPProxy"] as? String, "localhost")
        XCTAssertEqual(decoded["HTTPPort"] as? Int, 2080)
        XCTAssertEqual(raw.blob, try RawProxies(decoded).blob)
        XCTAssertTrue(Data(base64Encoded: raw.blob!)!.starts(with: Data("bplist00".utf8)))
    }
    func testErrorSerializationDoesNotContainValues() throws {
        let data = try JSONEncoder().encode(Failure(.applyFailed, .yes))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["committed"] as? Bool, true)
        XCTAssertEqual(object["message"] as? String, "Proxy preferences transaction could not be verified.")
    }
    func testAbsentBlobIsExplicitJSONNull() throws {
        let data = try JSONEncoder().encode(RawProxies(nil))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["present"] as? Bool, false)
        XCTAssertTrue(object["blob"] is NSNull)
        let decoded = try JSONDecoder().decode(RawProxies.self, from: data)
        XCTAssertFalse(decoded.present)
        XCTAssertNil(decoded.blob)
    }
    func testIntegerWidthsNormalizeButBoolAndRealRemainDistinct() throws {
        let narrow = try snapshot(["HTTPPort": NSNumber(value: Int32(2080))])
        let wide = try snapshot(["HTTPPort": NSNumber(value: Int64(2080))])
        XCTAssertTrue(try narrow.same(as: wide))
        XCTAssertEqual(narrow.services[0].proxies.blob, wide.services[0].proxies.blob)
        for value in [NSNumber(value: Int32(0)), NSNumber(value: Int64(2080)), NSNumber(value: 65535), NSNumber(value: true), NSNumber(value: 1.0)] {
            let key = CFGetTypeID(value) == CFBooleanGetTypeID() ? "HTTPEnable" : "HTTPPort"
            let raw = try RawProxies([key: value])
            XCTAssertEqual(raw.blob, try RawProxies(raw.dictionary()).blob)
        }
    }
    func testAbsentAndEmptyRoundTrips() throws {
        for original in [try snapshot(nil), try snapshot([:])] {
            let store = MemoryStore(original), engine = Transaction(store: MemoryStore(original))
            let target = try engine.prepare(Target(host: "127.0.0.1", port: 2080, bypass: ["localhost"])).target
            let tx = Transaction(store: store)
            _ = try tx.compareAndSet(expected: original, desired: target)
            _ = try tx.compareAndSet(expected: target, desired: original)
            XCTAssertTrue(try original.same(as: store.current))
        }
    }
    func testExternalChangeAndIdentityChangeNeverWrite() throws {
        let original = try snapshot(nil)
        for variant in 0..<4 {
            let store = MemoryStore(original)
            if variant == 0 { store.current.services[0].proxies = try RawProxies(["HTTPEnable": 0]) }
            if variant == 1 { store.current.services[0].name = "changed" }
            if variant == 2 { store.current.services[0].device = "en9" }
            if variant == 3 { store.current.services = [] }
            XCTAssertThrowsError(try Transaction(store: store).compareAndSet(expected: original, desired: original))
            XCTAssertEqual(store.writes, 0)
        }
    }
    func testApplyFailureRetryMustApplyAgain() throws {
        let original = try snapshot(nil), store = MemoryStore(try snapshot(nil))
        let tx = Transaction(store: store), target = try tx.prepare(Target(host: "127.0.0.1", port: 2080, bypass: [])).target
        store.failApply = true
        XCTAssertThrowsError(try tx.compareAndSet(expected: original, desired: target)) { error in
            XCTAssertEqual((error as? Failure)?.committed, .yes)
        }
        store.failApply = false
        _ = try tx.compareAndSet(expected: target, desired: target)
        XCTAssertEqual(store.applies, 2)
    }
    func testEveryFailurePreservesEvidence() throws {
        for stage in 0..<4 {
            let original = try snapshot(nil), store = MemoryStore(try snapshot(nil)), tx: Transaction
            tx = Transaction(store: store)
            let target = try tx.prepare(Target(host: "127.0.0.1", port: 2080, bypass: [])).target
            store.failWrite = stage == 0; store.failCommit = stage == 1
            store.failApply = stage == 2; store.corruptReadback = stage == 3
            XCTAssertThrowsError(try tx.compareAndSet(expected: original, desired: target))
            if stage == 0 { XCTAssertEqual(store.commits, 0) }
        }
    }
    func testUnsafeConfigurationsAndPathInjectionRejected() throws {
        for key in ["HTTPUser", "HTTPPassword", "HTTPProxyAuthenticated", "Unexpected"] {
            XCTAssertThrowsError(try RawProxies([key: "secret"]).dictionary())
        }
        var bad = try snapshot(nil); bad.services[0].id = "../../Other"
        let store = MemoryStore(try snapshot(nil))
        XCTAssertThrowsError(try Transaction(store: store).compareAndSet(expected: bad, desired: bad))
        XCTAssertEqual(store.writes, 0)
    }
    func testTypedEqualityAndPreservedDisabledValues() throws {
        XCTAssertFalse(try snapshot(["HTTPEnable": true]).same(as: snapshot(["HTTPEnable": 1])))
        let original = try snapshot(["HTTPEnable": 0, "HTTPProxy": "", "HTTPPort": 0, "ProxyAutoConfigURLString": "https://private.invalid/pac"])
        let store = MemoryStore(original), tx = Transaction(store: MemoryStore(original))
        let target = try tx.prepare(Target(host: "127.0.0.1", port: 2080, bypass: [])).target
        _ = try Transaction(store: store).compareAndSet(expected: original, desired: target)
        _ = try Transaction(store: store).compareAndSet(expected: target, desired: original)
        XCTAssertTrue(try store.current.same(as: original))
    }
}
