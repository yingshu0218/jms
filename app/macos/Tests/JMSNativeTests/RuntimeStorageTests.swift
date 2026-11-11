import XCTest
@testable import JMSNative

final class RuntimeStorageTests: XCTestCase {
    @MainActor func testInjectedDirectoriesDoNotResolveToUserStateOrCreateFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let support = root.appendingPathComponent("support")
        let logs = root.appendingPathComponent("logs")
        let config = RuntimeConfiguration(info: ["JMSIsolatedMode": true, "JMSAPIPort": 49999, "JMSDataDirectoryName": "Smoke"])
        let runtime = EngineRuntime(configuration: config, applicationSupportDirectory: support, isolatedLogDirectory: logs)
        XCTAssertEqual(try runtime.stateDirectoryURL(), try config.stateDirectory(applicationSupport: support))
        XCTAssertEqual(runtime.isolatedLogDirectory, logs)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        XCTAssertNil(runtime.process)
    }
    func testControlSessionHasExplicitDirectNonpersistentConfiguration() {
        let session = EngineClient().session
        defer { session.invalidateAndCancel() }
        let config = session.configuration
        XCTAssertNotNil(config.connectionProxyDictionary)
        XCTAssertTrue(config.connectionProxyDictionary?.isEmpty == true)
        XCTAssertNil(config.urlCredentialStorage)
        XCTAssertNil(config.httpCookieStorage)
        XCTAssertFalse(config.httpShouldSetCookies)
    }
    func testProbeOnlyInheritsInjectedProtocolClasses() {
        let polluted = URLSessionConfiguration.ephemeral
        polluted.connectionProxyDictionary = ["HTTPEnable": 1, "HTTPProxy": "127.0.0.1", "HTTPPort": 9999]
        polluted.httpAdditionalHeaders = ["Authorization": "fixture-only", "Cookie": "fixture-only"]
        polluted.httpShouldSetCookies = true
        polluted.urlCredentialStorage = .shared
        polluted.httpCookieStorage = .shared
        polluted.protocolClasses = [StorageTestProtocol.self]
        let source = URLSession(configuration: polluted)
        let probe = EngineControlSession.probe(for: source)
        defer { source.invalidateAndCancel(); probe.invalidateAndCancel() }
        let config = probe.configuration
        XCTAssertNotNil(config.connectionProxyDictionary)
        XCTAssertTrue(config.connectionProxyDictionary?.isEmpty == true)
        XCTAssertNil(config.urlCredentialStorage)
        XCTAssertNil(config.httpCookieStorage)
        XCTAssertFalse(config.httpShouldSetCookies)
        XCTAssertTrue(config.httpAdditionalHeaders?.isEmpty != false)
        if let injected = config.protocolClasses?.first {
            XCTAssertTrue(ObjectIdentifier(injected) == ObjectIdentifier(StorageTestProtocol.self))
        } else { XCTFail("Probe lost its explicitly injected test transport") }
    }
}

private final class StorageTestProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { false }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { }
    override func stopLoading() { }
}
