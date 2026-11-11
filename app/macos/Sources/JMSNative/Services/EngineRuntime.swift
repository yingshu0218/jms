import AppKit

@MainActor final class EngineRuntime {
    private(set) var process: Process?
    private(set) var client: EngineClient
    let configuration: RuntimeConfiguration
    private(set) var exitSafety: EngineExitSafety
    var hasLaunchedOwnedEngine: Bool { exitSafety.hasLaunchedOwnedEngine }
    var canExitWithoutLiveEngine: Bool { exitSafety.canExitWithoutLiveEngine(isolated: configuration.isolated) }
    func recordVerifiedCleanup(instanceId: String) { exitSafety.recordVerifiedCleanup(instanceId: instanceId) }
    var instanceId: String { client.lease.instanceId }
    var onTermination: (() -> Void)?
    private let resourcesDirectory: URL?
    private let applicationSupportDirectory: URL
    let isolatedLogDirectory: URL
    func stateDirectoryURL() throws -> URL { try configuration.stateDirectory(applicationSupport: applicationSupportDirectory) }
    private var starting = false
    private let listenerChecker: (Int32, Int) async throws -> Bool
    init(client: EngineClient? = nil, resourcesDirectory: URL? = Bundle.main.resourceURL,
         configuration: RuntimeConfiguration = RuntimeConfiguration(),
         exitSafety: EngineExitSafety = EngineExitSafety(),
         applicationSupportDirectory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0],
         isolatedLogDirectory: URL = FileManager.default.temporaryDirectory,
         listenerChecker: @escaping (Int32, Int) async throws -> Bool = { pid, port in try await EngineListenerOwnership.check(pid: pid, port: port) }) {
        self.applicationSupportDirectory = applicationSupportDirectory
        self.isolatedLogDirectory = isolatedLogDirectory
        self.exitSafety = exitSafety
        self.listenerChecker = listenerChecker
        self.configuration = configuration
        self.client = client ?? EngineClient(baseURL: configuration.baseURL)
        self.resourcesDirectory = resourcesDirectory
    }
    func start() async throws {
        guard !starting else { throw APIError(message: "引擎正在启动，请稍后重试") }
        starting = true
        defer { starting = false }
        try configuration.validate()
        var probe = client; probe.timeout = 2
        if let owned = process, owned.isRunning {
            guard try await probe.verifyListenerOwnership(using: { try await self.listenerChecker(owned.processIdentifier, self.configuration.apiPort) }) else {
                throw APIError(message: "自有引擎尚未独占预期监听端口，已拒绝发送凭据")
            }
            try await probe.verifyIdentity(instanceId: instanceId, isolated: configuration.isolated)
            return
        }
        do {
            try await probe.probeOccupiedPort()
            // Even a compatible engine belongs to another launch. Never adopt it.
            throw APIError(message: "\(configuration.apiPort) 端口已有服务，已拒绝复用；请先安全退出该实例")
        } catch let error as URLError where error.code == .cannotConnectToHost {
            try launch()
        }
        probe = client; probe.timeout = 2
        let started = ProcessInfo.processInfo.systemUptime
        while ProcessInfo.processInfo.systemUptime - started < 15 {
            if process?.isRunning == false { throw APIError(message: "随包引擎提前退出，请查看应用支持目录中的 native-engine.log") }
            do {
                guard let owned = process, owned.isRunning else { throw APIError(message: "随包引擎已退出") }
                guard try await probe.verifyListenerOwnership(using: { try await self.listenerChecker(owned.processIdentifier, self.configuration.apiPort) }) else {
                    try await Task.sleep(nanoseconds: 250_000_000)
                    continue
                }
                try await probe.verifyIdentity(instanceId: instanceId, isolated: configuration.isolated)
                _ = try await probe.snapshot()
                return
            } catch let error as URLError where error.code == .cannotConnectToHost {
                try await Task.sleep(nanoseconds: 250_000_000)
            } catch let error as APIError where error.code == "STARTING" || error.code == "LISTENER_UNCONFIRMED" {
                // Only our own newly launched child may be waiting for boot/recovery.
                // The initial occupied-port probe deliberately does not accept this.
                try await Task.sleep(nanoseconds: 250_000_000)
            }
        }
        throw APIError(message: "引擎启动超时，请查看日志后重试；未强制终止进程")
    }
    private func launch() throws {
        guard let resources = resourcesDirectory else { throw APIError(message: "应用资源缺失") }
        let engine = resources.appendingPathComponent("engine/jms-engine")
        let core = resources.appendingPathComponent("core/sing-box")
        let proxyHelper = resources.appendingPathComponent("engine/JMSProxyPreferences")
        guard FileManager.default.isExecutableFile(atPath: proxyHelper.path) else { throw APIError(message: "随包系统代理恢复工具缺失，请重新构建应用") }
        guard FileManager.default.isExecutableFile(atPath: engine.path), FileManager.default.isExecutableFile(atPath: core.path) else { throw APIError(message: "随包引擎或 sing-box 缺失，请重新构建应用") }
        let dir = try stateDirectoryURL()
        // The isolated Node entry owns directory creation, lock and marker checks.
        // Do not create even a log file there before its empty-directory check.
        let logfile: URL
        if configuration.isolated {
            logfile = isolatedLogDirectory.appendingPathComponent("jms-candidate-\(UUID().uuidString).log")
        } else {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            logfile = dir.appendingPathComponent("native-engine.log")
        }
        if !FileManager.default.fileExists(atPath: logfile.path) { FileManager.default.createFile(atPath: logfile.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        let log = try FileHandle(forWritingTo: logfile); try log.seekToEnd()
        defer { try? log.close() }
        let p = Process(); p.executableURL = engine
        p.arguments = ["--dir", dir.path, "--port", String(configuration.apiPort), "--core", core.path, "--ui", resources.appendingPathComponent("ui/index.html").path]
        if configuration.isolated { p.arguments?.append("--isolated") }
        let lease = client.lease
        let credentials = lease.begin(isAlive: { [weak p] in p?.isRunning == true })
        // Never reuse an invalidated transport from an earlier launch.
        client.session = EngineControlSession.make()
        let transport = client.session
        p.terminationHandler = { [weak self] _ in
            lease.revoke(instanceId: credentials.instanceId)
            transport.invalidateAndCancel()
            Task { @MainActor [weak self] in
                guard let self, self.instanceId == credentials.instanceId else { return }
                self.onTermination?()
            }
        }
        var environment = ProcessInfo.processInfo.environment
        environment["JMS_PROXY_HELPER"] = proxyHelper.path
        environment["JMS_API_TOKEN"] = credentials.token
        environment["JMS_INSTANCE_ID"] = credentials.instanceId
        p.environment = environment
        p.standardOutput = log; p.standardError = log
        do {
            try p.run()
            process = p
            // Boot can already touch a recovery journal before identity becomes ready.
            exitSafety.recordLaunch(instanceId: credentials.instanceId)
        }
        catch { lease.revoke(instanceId: credentials.instanceId); transport.invalidateAndCancel(); throw error }
    }
    func stopOwnedProcess() async throws {
        guard let process, process.isRunning else { self.process = nil; return }
        process.terminate()
        for _ in 0..<40 {
            if !process.isRunning { self.process = nil; return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw APIError(message: "引擎尚未退出，请重试；为保护网络设置，没有强制终止")
    }
}
