import XCTest
@testable import JMSNative

/// Opt-in integration of real anonymous pipes with the isolated bundled SEA only.
/// Does not establish production authorization, helper execution or GUI behavior.
final class NativeControlPipeSmokeTests: XCTestCase {
    @MainActor func testPrivatePipeToIsolatedBundledSEA() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["JMS_NATIVE_IPC_SMOKE"] == "1", let path = environment["JMS_NATIVE_IPC_BUNDLE"] else {
            XCTFail("Explicit native IPC smoke configuration is required"); return
        }
        let bundle = URL(fileURLWithPath: path, isDirectory: true)
        let metadata = try Data(contentsOf: bundle.appendingPathComponent("Contents/Info.plist"))
        guard let info = try PropertyListSerialization.propertyList(from: metadata, format: nil) as? [String: Any],
              info["CFBundleIdentifier"] as? String == "app.jms.client.native.candidate",
              info["CFBundleExecutable"] as? String == "JMSNative",
              info["JMSIsolatedMode"] as? Bool == true,
              info["JMSAPIPort"] as? Int == 17788,
              info["JMSDataDirectoryName"] as? String == "JMS Client Candidate" else { throw PrivatePipeSmokeFailure() }
        let engine = bundle.appendingPathComponent("Contents/Resources/engine/jms-engine")
        guard FileManager.default.isExecutableFile(atPath: engine.path) else { throw PrivatePipeSmokeFailure() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("jms-private-ipc-\(UUID().uuidString)")
        let formal = root.appendingPathComponent("JMS Client")
        try FileManager.default.createDirectory(at: formal, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let sentinel = formal.appendingPathComponent("sentinel")
        let originalSentinel = Data("Untouched formal state fixture".utf8)
        try originalSentinel.write(to: sentinel)
        let state = root.appendingPathComponent("Isolated-\(UUID().uuidString)")
        let port = Int.random(in: 20000...60000)
        let child = Process()
        let pipe = try NativeProxyPipe()
        let lease = EngineLease()
        let credentials = lease.begin(isAlive: { [weak child] in child?.isRunning == true })
        var client = EngineClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, lease: lease)
        client.timeout = 1
        let driver = NeverLaunchPrivateSmokeHelper()
        let deadline = ProcessInfo.processInfo.systemUptime + 30
        var sawHello = false, sawIsolationRefusal = false, sawPipeEnded = false, watchdogFired = false
        var operationID: String?
        let broker = NativeProxyBroker(isolated: false, launchId: credentials.instanceId,
            isAlive: { child.isRunning && lease.instanceId == credentials.instanceId },
            sendFrame: { frame in
                if frame["type"] as? String == "begin" { operationID = frame["operationId"] as? String }
                try await pipe.send(frame)
            }, helperDriver: driver, sleep: { requested in
                let remaining = max(0.001, deadline - ProcessInfo.processInfo.systemUptime)
                try await Task.sleep(nanoseconds: min(requested, UInt64(remaining * 1_000_000_000)))
            })
        child.executableURL = engine
        child.arguments = ["--isolated", "--native-control", "--dir", state.path, "--port", String(port)]
        var childEnvironment = environment
        childEnvironment["JMS_API_TOKEN"] = credentials.token
        childEnvironment["JMS_INSTANCE_ID"] = credentials.instanceId
        childEnvironment["JMS_TEST_NO_CORE"] = "1"
        childEnvironment.removeValue(forKey: "JMS_PROXY_HELPER")
        child.environment = childEnvironment
        child.standardInput = pipe.childInput; child.standardOutput = pipe.childOutput
        child.standardError = FileHandle.nullDevice
        child.terminationHandler = { _ in lease.revoke(instanceId: credentials.instanceId) }
        let watchdog = Task { @MainActor in
            do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
            watchdogFired = true
            // Failure path only. Never signal any process other than this exact child.
            await broker.revoke()
            pipe.close()
            if child.isRunning { child.terminate() }
        }
        defer { watchdog.cancel(); client.session.invalidateAndCancel() }
        do {
            // Refuse collisions without a credential and without adopting any service.
            do { try await client.probeOccupiedPort(); throw PrivatePipeSmokeFailure() }
            catch let error as URLError where error.code == .cannotConnectToHost { }
            try child.run()
            let ownedPID = child.processIdentifier
            pipe.start(receive: { frame in
                if frame["type"] as? String == "hello", frame["launchId"] as? String == credentials.instanceId { sawHello = true }
                if frame["type"] as? String == "complete", frame["launchId"] as? String == credentials.instanceId,
                   frame["operationId"] as? String == operationID, frame["ok"] as? Bool == false,
                   frame["code"] as? String == "ISOLATED" { sawIsolationRefusal = true }
                await broker.receive(frame)
            }, ended: { sawPipeEnded = true; await broker.revoke() })
            var ready = false
            while ProcessInfo.processInfo.systemUptime < deadline - 3 {
                guard child.isRunning else { throw PrivatePipeSmokeFailure() }
                // This real PID/loopback check must succeed before any bearer is sent.
                if try await client.verifyListenerOwnership(using: { try await EngineListenerOwnership.check(pid: ownedPID, port: port) }) {
                    do {
                        try await client.verifyIdentity(instanceId: credentials.instanceId, isolated: true)
                        ready = true; break
                    } catch let error as APIError where error.code == "STARTING" { }
                }
                try await Task.sleep(nanoseconds: 25_000_000)
            }
            guard ready else { throw PrivatePipeSmokeFailure() }
            while !sawHello && ProcessInfo.processInfo.systemUptime < deadline - 3 { try await Task.sleep(nanoseconds: 10_000_000) }
            guard sawHello else { throw PrivatePipeSmokeFailure() }
            let before = try await client.snapshot()
            XCTAssertFalse(before.subscription.hasUrl)
            XCTAssertTrue(before.subscription.nodes.isEmpty)
            XCTAssertFalse(before.status.connected || before.status.running || before.status.pendingProxyJournal)
            do { try await broker.perform(action: "connect"); XCTFail("Isolated private begin was accepted") }
            catch let error as APIError { XCTAssertEqual(error.code, "NATIVE_PROXY_FAILED") }
            guard sawIsolationRefusal else { throw PrivatePipeSmokeFailure() }
            XCTAssertEqual(driver.calls, 0)
            let after = try await client.snapshot()
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            XCTAssertTrue(try encoder.encode(before) == encoder.encode(after))
            XCTAssertTrue(try Data(contentsOf: sentinel) == originalSentinel)
            _ = try await client.request("api/shutdown", body: [:])
            // Keep parent's stdin writer open until exit: it must not pin the SEA.
            if child.isRunning { child.terminate() }
            try await waitForOwnedExit(child, deadline: min(deadline + 3, ProcessInfo.processInfo.systemUptime + 3))
            XCTAssertFalse(child.isRunning)
            XCTAssertEqual(child.terminationStatus, 0)
            while !sawPipeEnded && ProcessInfo.processInfo.systemUptime < deadline + 3 {
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            XCTAssertTrue(sawPipeEnded, "Owned child must close its private output, not rely on parent cleanup")
            XCTAssertFalse(watchdogFired, "Watchdog cleanup is not a successful lifecycle")
            XCTAssertThrowsError(try client.makeRequest("api/state"))
            pipe.close()
            XCTAssertTrue(try Data(contentsOf: sentinel) == originalSentinel)
            try FileManager.default.removeItem(at: root)
        } catch {
            if child.isRunning { child.terminate() }
            try? await waitForOwnedExit(child, deadline: min(deadline + 3, ProcessInfo.processInfo.systemUptime + 2))
            pipe.close()
            if !child.isRunning { try? FileManager.default.removeItem(at: root) }
            XCTFail("Private isolated IPC smoke failed; no production helper or authorization was requested")
            throw PrivatePipeSmokeFailure()
        }
    }
    @MainActor private func waitForOwnedExit(_ child: Process, deadline: Double) async throws {
        while child.isRunning {
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw PrivatePipeSmokeFailure() }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
    }
}
@MainActor private final class NeverLaunchPrivateSmokeHelper: NativeProxyHelperDriver {
    var calls = 0
    var isActive: Bool { false }
    func request(_ request: [String: Any]) async throws -> [String: Any] {
        calls += 1
        throw PrivatePipeSmokeFailure()
    }
    func cancelBeforeCommit() async { }
    func complete() async { }
}
private struct PrivatePipeSmokeFailure: Error {}
