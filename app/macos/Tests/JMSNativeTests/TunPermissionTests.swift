import XCTest
@testable import JMSNative

final class TunPermissionTests: XCTestCase {
    func testMissingPrivilegeAndRelaunchCommand() throws {
        let json = #"{"ok":false,"needed":true,"elevated":false,"hint":"需要 root","elevation":{"command":"old"},"relaunch":{"command":"engine --dir 'folder'","note":"授权引擎"}}"#
        let value = try JSONDecoder().decode(TunPermission.self, from: Data(json.utf8))
        XCTAssertFalse(value.ok)
        XCTAssertEqual(value.command, "engine --dir 'folder'")
        XCTAssertEqual(value.hint, "需要 root")
    }
    func testPrivilegeSuccessAndProbeFailureHaveNoCommand() throws {
        for text in [#"{"ok":true,"needed":false,"elevated":true}"#, #"{"ok":false,"error":"检测失败"}"#] {
            let value = try JSONDecoder().decode(TunPermission.self, from: Data(text.utf8))
            XCTAssertNil(value.command)
        }
    }
    func testStructuredPermissionErrorCode() async {
        StubProtocol.failure = nil
        StubProtocol.reply = (400, #"{"error":"权限不足","code":"NEED_ELEVATION","privilege":{"hint":"需要 root"}}"#)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubProtocol.self]
        let client = EngineClient(session: URLSession(configuration: config), lease: authorizedTestLease())
        do { _ = try await client.request("api/connect", body: [:]); XCTFail("应拒绝连接") }
        catch let error as APIError { XCTAssertEqual(error.code, "NEED_ELEVATION"); XCTAssertTrue(error.message.contains("需要 root")) }
        catch { XCTFail("错误类型不符") }
    }
}
