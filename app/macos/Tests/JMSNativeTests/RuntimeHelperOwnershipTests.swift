import XCTest
@testable import JMSNative

final class RuntimeHelperOwnershipTests: XCTestCase {
    @MainActor func testLiveHelperBlocksRestartStopAndCleanupProofWithoutIO() async throws {
        HelperOwnershipProbe.requests = 0
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HelperOwnershipProbe.self]
        let lease = EngineLease(); let credentials = lease.begin(isAlive: { false })
        let client = EngineClient(session: URLSession(configuration: configuration), lease: lease)
        var safety = EngineExitSafety(); safety.recordLaunch(instanceId: credentials.instanceId)
        let runtime = EngineRuntime(client: client, resourcesDirectory: nil, exitSafety: safety)
        var live = true
        runtime.helperActivityCheck = { live }
        do { try await runtime.start(); XCTFail("Live helper replaced") } catch { }
        do { try await runtime.stopOwnedProcess(); XCTFail("Live helper stop bypassed") } catch { }
        XCTAssertEqual(HelperOwnershipProbe.requests, 0)
        XCTAssertNil(runtime.process)
        XCTAssertFalse(runtime.recordVerifiedCleanup(instanceId: credentials.instanceId))
        XCTAssertFalse(runtime.canExitWithoutLiveEngine)
        live = false
        do { try await runtime.start(); XCTFail("Fixture should stop at injected probe error") } catch { }
        XCTAssertEqual(HelperOwnershipProbe.requests, 1)
        XCTAssertNil(runtime.process)
        try await runtime.stopOwnedProcess()
        XCTAssertTrue(runtime.recordVerifiedCleanup(instanceId: credentials.instanceId))
        XCTAssertTrue(runtime.canExitWithoutLiveEngine)
        client.session.invalidateAndCancel()
    }
    @MainActor func testCleanupProofRejectsStaleIDAndMismatchedRecordedLaunch() {
        let lease = EngineLease(); let original = lease.begin(isAlive: { false })
        let client = EngineClient(lease: lease)
        defer { client.session.invalidateAndCancel() }
        var safety = EngineExitSafety(); safety.recordLaunch(instanceId: original.instanceId)
        let runtime = EngineRuntime(client: client, exitSafety: safety)
        XCTAssertFalse(runtime.recordVerifiedCleanup(instanceId: UUID().uuidString))
        XCTAssertFalse(runtime.canExitWithoutLiveEngine)
        let rotated = lease.begin(isAlive: { false })
        XCTAssertFalse(runtime.recordVerifiedCleanup(instanceId: original.instanceId))
        XCTAssertFalse(runtime.recordVerifiedCleanup(instanceId: rotated.instanceId))
        XCTAssertFalse(runtime.canExitWithoutLiveEngine)
    }
    @MainActor func testCleanupProofRejectsNeverLaunchedRuntimeEvenWithCurrentLeaseID() {
        let lease = EngineLease(); let credentials = lease.begin(isAlive: { false })
        let client = EngineClient(lease: lease)
        defer { client.session.invalidateAndCancel() }
        let runtime = EngineRuntime(client: client)
        XCTAssertFalse(runtime.recordVerifiedCleanup(instanceId: credentials.instanceId))
        XCTAssertFalse(runtime.hasLaunchedOwnedEngine)
        XCTAssertNil(runtime.process)
    }

}
private final class HelperOwnershipProbe: URLProtocol {
    static var requests = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests += 1
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }
    override func stopLoading() { }
}
