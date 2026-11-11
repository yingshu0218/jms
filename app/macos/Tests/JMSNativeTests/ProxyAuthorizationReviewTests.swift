import XCTest
import CryptoKit
@testable import JMSNative

final class ProxyAuthorizationReviewTests: XCTestCase {
    private let launch = "10000000-0000-0000-0000-000000000001"
    private let operation = "20000000-0000-0000-0000-000000000001"
    private var service: [String: Any] {
        ["id": "3abcdef0-abcd-abcd-abcd-000000000001", "name": "Wi-Fi", "device": "en0", "proxies": ["present": false, "blob": NSNull()]]
    }
    private var snapshot: [String: Any] { ["schema": 3, "services": [service]] }
    private var apply: [String: Any] {
        ["version": 1, "launchId": launch, "operationId": operation, "action": "apply",
         "target": ["host": "127.0.0.1", "port": 2080, "bypass": ["localhost"]], "expected": snapshot]
    }
    private var restore: [String: Any] {
        ["version": 1, "launchId": launch, "operationId": operation, "action": "restore", "original": snapshot, "proxyTarget": snapshot]
    }
    private func encode(_ plan: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: plan, options: [.sortedKeys]) }
    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func review(_ plan: [String: Any], action: String = "connect") throws -> ProxyAuthorizationReview {
        let data = try encode(plan)
        return try ProxyAuthorizationReview(planData: data, planDigest: digest(data), launchId: launch, operationId: operation, action: action)
    }
    func testStrictStructuralScanRejectsEscapedDuplicatesAndExcessiveDepth() throws {
        let invalid = [
            #"{"version":1,"version":1}"#,
            #"{"version":1,"\u0076ersion":1}"#,
            #"{"expected":{"schema":3,"\u0073chema":3}}"#,
            "{\"value\":" + String(repeating: "[", count: 65) + "true" + String(repeating: "]", count: 65) + "}"
        ]
        for text in invalid { XCTAssertThrowsError(try StrictAuthorizationJSON.validate(Data(text.utf8))) }
        try StrictAuthorizationJSON.validate(Data(#"{"value":"escaped \"key\"", "nested":{"a":1}}"#.utf8))
    }
    func testApplySummaryIsTypedAndHasNoRawBlobProperty() throws {
        let result = try review(apply)
        XCTAssertEqual(result.action, "connect")
        XCTAssertEqual(result.loopbackPort, 2080)
        XCTAssertEqual(result.serviceCount, 1)
        XCTAssertEqual(result.serviceNames, ["Wi-Fi"])
        XCTAssertEqual(Set(Mirror(reflecting: result).children.compactMap { $0.label }), ["action", "loopbackPort", "serviceNames", "planDigest", "launchId", "operationId"])
    }
    func testRestoreRequiresSameIdentitiesAndDoesNotDisplayEndpoints() throws {
        let result = try review(restore, action: "disconnect")
        XCTAssertEqual(result.action, "disconnect"); XCTAssertNil(result.loopbackPort)
        var differentService = service; differentService["device"] = "en1"
        var bad = restore; bad["proxyTarget"] = ["schema": 3, "services": [differentService]]
        XCTAssertThrowsError(try review(bad, action: "disconnect"))
    }
    func testDigestMatchesExactBytesAndCannotRebindIdentityOrAction() throws {
        let data = try encode(apply)
        XCTAssertThrowsError(try ProxyAuthorizationReview(planData: data + Data([32]), planDigest: digest(data), launchId: launch, operationId: operation, action: "connect"))
        XCTAssertThrowsError(try ProxyAuthorizationReview(planData: data, planDigest: digest(data).uppercased(), launchId: launch, operationId: operation, action: "connect"))
        XCTAssertThrowsError(try ProxyAuthorizationReview(planData: data, planDigest: digest(data), launchId: UUID().uuidString, operationId: operation, action: "connect"))
        XCTAssertThrowsError(try review(apply, action: "disconnect"))
    }
    func testMissingExpectedWrongSchemaAndUnknownPathOrRightsAreRejected() throws {
        var missing = apply; missing.removeValue(forKey: "expected")
        var old = apply; old["expected"] = ["schema": 2, "services": [service]]
        var path = apply; path["path"] = "/NetworkServices/private"
        var rights = apply; rights["rights"] = ["system.preferences"]
        var nested = snapshot; nested["path"] = "/private"
        var nestedPlan = apply; nestedPlan["expected"] = nested
        for plan in [missing, old, path, rights, nestedPlan] { XCTAssertThrowsError(try review(plan)) }
    }
    func testOnlyLoopbackPortAndStrictTargetTypesAccepted() throws {
        let targets: [[String: Any]] = [
            ["host": "example.invalid", "port": 2080, "bypass": []],
            ["host": "127.0.0.1", "port": true, "bypass": []],
            ["host": "127.0.0.1", "port": 65536, "bypass": []],
            ["host": "127.0.0.1", "port": 2080, "bypass": ["line\nbreak"]],
            ["host": "127.0.0.1", "port": 2080, "bypass": [], "path": "/private"]
        ]
        for target in targets { var plan = apply; plan["target"] = target; XCTAssertThrowsError(try review(plan)) }
    }
    func testServiceIdentityIsUniqueAndPresentationFieldsAreBounded() throws {
        var uppercase = service; uppercase["id"] = (service["id"] as! String).uppercased()
        var duplicate = apply; duplicate["expected"] = ["schema": 3, "services": [service, uppercase]]
        XCTAssertThrowsError(try review(duplicate))
        for (key, value) in [("id", "../../private"), ("name", "secret\ntext"), ("name", String(repeating: "x", count: 257)), ("device", "../../en0")] {
            var altered = service; altered[key] = value
            var plan = apply; plan["expected"] = ["schema": 3, "services": [altered]]
            XCTAssertThrowsError(try review(plan))
        }
    }
    func testOpaqueProxiesHaveStrictPresentBlobShapeWithoutDecoding() throws {
        let invalid: [[String: Any]] = [["present": false], ["present": 0, "blob": NSNull()], ["present": false, "blob": "c2VjcmV0"], ["present": true, "blob": "not base64"], ["present": true, "blob": ""], ["present": false, "blob": NSNull(), "right": "private"]]
        for proxies in invalid {
            var item = service; item["proxies"] = proxies
            var plan = apply; plan["expected"] = ["schema": 3, "services": [item]]
            XCTAssertThrowsError(try review(plan))
        }
        var opaque = service; opaque["proxies"] = ["present": true, "blob": Data("opaque fixture".utf8).base64EncodedString()]
        var plan = apply; plan["expected"] = ["schema": 3, "services": [opaque]]
        XCTAssertEqual(try review(plan).serviceNames, ["Wi-Fi"])
    }
    func testErrorsAreFixedAndNeverIncludeInput() throws {
        let data = Data("private-url-and-credential-not-json".utf8)
        XCTAssertThrowsError(try ProxyAuthorizationReview(planData: data, planDigest: digest(data), launchId: launch, operationId: operation, action: "connect")) { error in
            XCTAssertEqual((error as? APIError)?.code, "AUTHORIZATION_REVIEW_INVALID")
            XCTAssertFalse(error.localizedDescription.contains("private-url"))
        }
    }
}
