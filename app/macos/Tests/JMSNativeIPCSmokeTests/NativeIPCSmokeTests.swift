import XCTest
import Network
@testable import JMSNative

/// No GUI, subscriptions, core launch, helper execution, elevation or system network writes.
/// Built only with JMS_NATIVE_IPC_SMOKE=1 and never skips a missing prerequisite.
final class NativeIPCSmokeTests: XCTestCase {
    @MainActor func testBundledIsolatedEngineLifecycle() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["JMS_NATIVE_IPC_SMOKE"] == "1", let bundlePath = env["JMS_NATIVE_IPC_BUNDLE"] else {
            XCTFail("Explicit IPC smoke configuration is required"); return
        }
        let bundle = URL(fileURLWithPath: bundlePath, isDirectory: true)
        let resources = bundle.appendingPathComponent("Contents/Resources")
        let plist = try Data(contentsOf: bundle.appendingPathComponent("Contents/Info.plist"))
        guard var info = try PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any],
              info["CFBundleIdentifier"] as? String == "app.jms.client.native.candidate",
              info["CFBundleExecutable"] as? String == "JMSNative",
              info["JMSIsolatedMode"] as? Bool == true,
              info["JMSAPIPort"] as? Int == 17788,
              info["JMSDataDirectoryName"] as? String == "JMS Client Candidate" else { throw SmokeFailure() }
        try RuntimeConfiguration(info: info).validate()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("jms-ipc-smoke-\(UUID().uuidString)")
        let support = root.appendingPathComponent("support"), logs = root.appendingPathComponent("logs")
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let formal = support.appendingPathComponent("JMS Client")
        try FileManager.default.createDirectory(at: formal, withIntermediateDirectories: false)
        let sentinel = formal.appendingPathComponent("sentinel.txt")
        let sentinelBytes = Data("Formal state must remain untouched.".utf8)
        try sentinelBytes.write(to: sentinel)
        // Collision is safe: Runtime's unauthenticated probe refuses an occupied port.
        // Never adopt a service or kill a listener to make this test pass.
        info["JMSAPIPort"] = Int.random(in: 20000...60000)
        info["JMSDataDirectoryName"] = "State-\(UUID().uuidString)"
        let config = RuntimeConfiguration(info: info)
        let runtime = EngineRuntime(resourcesDirectory: resources, configuration: config, applicationSupportDirectory: support, isolatedLogDirectory: logs)
        do {
            try await checkOccupiedPort(info: info, resources: resources, support: support, logs: logs)
            XCTAssertTrue(try Data(contentsOf: sentinel) == sentinelBytes)
            try await runtime.start()
            var client = runtime.client; client.timeout = 5
            guard let owned = runtime.process, owned.isRunning else { throw SmokeFailure() }
            let listenerOwned = try await EngineListenerOwnership.check(pid: owned.processIdentifier, port: config.apiPort)
            XCTAssertTrue(listenerOwned)
            let oldToken = client.token, oldInstance = runtime.instanceId
            let oldRequest = try client.makeRequest("api/identity")
            let state = try await client.snapshot()
            XCTAssertFalse(state.subscription.hasUrl)
            XCTAssertTrue(state.subscription.nodes.isEmpty)
            XCTAssertFalse(state.status.connected)
            XCTAssertFalse(state.status.running)
            XCTAssertFalse(state.status.pendingProxyJournal)
            try await checkEventStream(client)
            guard state.settings.autoRefreshMinutes != 0 else { throw SmokeFailure() }
            let refreshMinutes = 0 // Disable refresh; never schedule any external request.
            _ = try await client.request("api/settings", body: ["settings": ["autoRefreshMinutes": refreshMinutes]])
            let updated = try await client.snapshot()
            XCTAssertEqual(updated.settings.autoRefreshMinutes, refreshMinutes)
            for path in ["api/connect", "api/latency", "api/linkcheck", "api/elevate"] {
                do { _ = try await client.request(path, body: [:]); XCTFail("Isolated operation must be rejected") }
                catch let error as APIError { XCTAssertEqual(error.code, "ISOLATED") }
            }
            _ = try await client.request("api/shutdown", body: [:])
            let stopped = try await client.snapshot()
            XCTAssertFalse(stopped.status.connected || stopped.status.running || stopped.status.pendingProxyJournal)
            let stoppedSecond = try await client.snapshot()
            XCTAssertFalse(stoppedSecond.status.connected || stoppedSecond.status.running || stoppedSecond.status.pendingProxyJournal)
            try await runtime.stopOwnedProcess()
            XCTAssertFalse(owned.isRunning)
            try await assertPortClosed(client)
            XCTAssertThrowsError(try client.makeRequest("api/state"))

            try await runtime.start()
            client = runtime.client; client.timeout = 5
            // Do not use XCTAssertNotEqual: failure diagnostics must not print tokens.
            XCTAssertTrue(client.token != oldToken)
            XCTAssertTrue(runtime.instanceId != oldInstance)
            XCTAssertThrowsError(try client.lease.validate(oldRequest))
            // Listener/identity was verified by Runtime before this request to its new child.
            let (_, response) = try await client.session.data(for: oldRequest)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 401)
            _ = try await client.snapshot()
            _ = try await client.request("api/shutdown", body: [:])
            let stoppedAgain = try await client.snapshot()
            XCTAssertFalse(stoppedAgain.status.connected || stoppedAgain.status.running || stoppedAgain.status.pendingProxyJournal)
            let stoppedAgainSecond = try await client.snapshot()
            XCTAssertFalse(stoppedAgainSecond.status.connected || stoppedAgainSecond.status.running || stoppedAgainSecond.status.pendingProxyJournal)
            try await runtime.stopOwnedProcess()
            XCTAssertNil(runtime.process)
            try await assertPortClosed(client)
            XCTAssertTrue(try Data(contentsOf: sentinel) == sentinelBytes)
            try FileManager.default.removeItem(at: root)
        } catch {
            // Only the Process created by this Runtime may be terminated, even on failure.
            if runtime.process?.isRunning == true {
                var client = runtime.client; client.timeout = 3
                _ = try? await client.request("api/shutdown", body: [:])
                try? await runtime.stopOwnedProcess()
            }
            if runtime.process?.isRunning != true { try? FileManager.default.removeItem(at: root) }
            // Never include raw state, credentials, or child log output in CI diagnostics.
            XCTFail("Isolated native IPC smoke failed; no system-network operation was requested")
            throw SmokeFailure()
        }
    }
    private func assertPortClosed(_ client: EngineClient) async throws {
        var probe = client; probe.timeout = 2
        do { try await probe.probeOccupiedPort(); throw SmokeFailure() }
        catch let error as URLError where error.code == .cannotConnectToHost { }
    }
    @MainActor private func checkOccupiedPort(info: [String: Any], resources: URL, support: URL, logs: URL) async throws {
        let fixture = try OccupiedLoopbackFixture()
        defer { fixture.stop() }
        let port = try await fixture.start()
        var occupiedInfo = info; occupiedInfo["JMSAPIPort"] = port
        let runtime = EngineRuntime(resourcesDirectory: resources, configuration: RuntimeConfiguration(info: occupiedInfo), applicationSupportDirectory: support, isolatedLogDirectory: logs)
        var rejected = false
        do { try await runtime.start() }
        catch is APIError { rejected = true }
        catch { try? await runtime.stopOwnedProcess(); throw SmokeFailure() }
        if runtime.process != nil {
            try? await runtime.stopOwnedProcess()
            throw SmokeFailure()
        }
        guard rejected else { throw SmokeFailure() }
        XCTAssertNil(runtime.process)
        let observation = fixture.observation
        XCTAssertTrue(observation.received)
        XCTAssertFalse(observation.authorization || observation.cookie)
        XCTAssertTrue(observation.alive)
        // A second credential-free HTTP probe proves the fixture still serves.
        var probe = runtime.client; probe.timeout = 2
        try await probe.probeOccupiedPort()
    }
    private func checkEventStream(_ client: EngineClient) async throws {
        // Hard transport invalidation backs up cooperative task cancellation.
        let deadline = DispatchWorkItem { client.session.invalidateAndCancel() }
        DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: deadline)
        defer { deadline.cancel() }
        try await withThrowingTaskGroup(of: Bool.self) { group in
            group.addTask {
                let request = try client.makeRequest("api/events")
                try client.lease.validate(request)
                let (bytes, response) = try await client.session.bytes(for: request)
                guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                      response.value(forHTTPHeaderField: "Content-Type")?.contains("text/event-stream") == true else { throw SmokeFailure() }
                for try await line in bytes.lines {
                    if line == ": connected" { return true }
                }
                throw SmokeFailure()
            }
            group.addTask {
                try await Task.sleep(nanoseconds: 5_000_000_000)
                throw SmokeFailure()
            }
            defer { group.cancelAll() }
            guard try await group.next() == true else { throw SmokeFailure() }
        }
    }
}
private struct SmokeFailure: Error {}

/// Owns only a loopback listener and accepted test connections. Never logs request bytes.
private final class OccupiedLoopbackFixture: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "jms.ipc-smoke.fixture")
    private let lock = NSLock()
    private var port: Int?
    private var failed = false
    private var stopped = false
    private var alive = false
    private var received = false
    private var authorization = false
    private var cookie = false
    private var connections: [NWConnection] = []
    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        listener = try NWListener(using: parameters)
    }
    var observation: (received: Bool, authorization: Bool, cookie: Bool, alive: Bool) {
        lock.lock(); defer { lock.unlock() }
        return (received, authorization, cookie, alive)
    }
    private var readiness: (Int?, Bool) {
        lock.lock(); defer { lock.unlock() }; return (port, failed)
    }
    func start() async throws -> Int {
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            guard !self.stopped else { return }
            switch state {
            case .ready: self.port = self.listener.port.map { Int($0.rawValue) }; self.alive = true
            case .failed: self.failed = true; self.alive = false
            case .cancelled: self.alive = false
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            self.lock.lock()
            guard !self.stopped else { self.lock.unlock(); connection.cancel(); return }
            self.connections.append(connection)
            self.lock.unlock()
            connection.start(queue: self.queue)
            self.receive(connection, prefix: Data())
        }
        listener.start(queue: queue)
        let deadline = ProcessInfo.processInfo.systemUptime + 3
        while ProcessInfo.processInfo.systemUptime < deadline {
            let (port, failed) = readiness
            if failed { throw SmokeFailure() }
            if let port { return port }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        throw SmokeFailure()
    }
    private func receive(_ connection: NWConnection, prefix: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, complete, error in
            guard let self else { connection.cancel(); return }
            var bytes = prefix
            if let data { bytes.append(data) }
            guard bytes.count <= 8192, error == nil else { connection.cancel(); return }
            if let text = String(data: bytes, encoding: .utf8), text.contains("\r\n\r\n") {
                // Retain only booleans, not headers or credential values.
                let names = text.components(separatedBy: "\r\n").dropFirst().compactMap { $0.split(separator: ":", maxSplits: 1).first?.lowercased() }
                self.lock.lock()
                self.received = true
                self.authorization = self.authorization || names.contains("authorization")
                self.cookie = self.cookie || names.contains("cookie")
                self.lock.unlock()
                let reply = Data("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8)
                connection.send(content: reply, completion: .contentProcessed { _ in connection.cancel() })
            } else if complete { connection.cancel() }
            else { self.receive(connection, prefix: bytes) }
        }
    }
    func stop() {
        lock.lock(); stopped = true; let owned = connections; connections = []; alive = false; lock.unlock()
        listener.cancel()
        for connection in owned { connection.cancel() }
    }
}
