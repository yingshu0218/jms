import AppKit

@MainActor final class EngineRuntime {
    private(set) var process: Process?
    let client: EngineClient
    private let resourcesDirectory: URL?
    init(client: EngineClient = EngineClient(), resourcesDirectory: URL? = Bundle.main.resourceURL) {
        self.client = client; self.resourcesDirectory = resourcesDirectory
    }
    func start() async throws {
        // 接口存在但结构不匹配时拒绝复用，也不覆盖占用端口的服务。
        var probe = client; probe.timeout = 2
        do {
            _ = try await probe.request("api/state")
        } catch let error as URLError where [.cannotConnectToHost, .networkConnectionLost].contains(error.code) {
            try launch()
            for _ in 0..<60 {
                if process?.isRunning == false { throw APIError(message: "随包引擎提前退出，请查看应用支持目录中的 native-engine.log") }
                if (try? await probe.snapshot()) != nil { return }
                try await Task.sleep(nanoseconds: 250_000_000)
            }
            throw APIError(message: "引擎启动超时，请退出后重试")
        }
        do { _ = try await probe.snapshot() }
        catch { throw APIError(message: "7788 端口已有不兼容服务，无法复用：\(error.localizedDescription)") }
    }
    private func launch() throws {
        guard let resources = resourcesDirectory else { throw APIError(message: "应用资源缺失") }
        let engine = resources.appendingPathComponent("engine/jms-engine")
        let core = resources.appendingPathComponent("core/sing-box")
        guard FileManager.default.isExecutableFile(atPath: engine.path), FileManager.default.isExecutableFile(atPath: core.path) else { throw APIError(message: "随包引擎或 sing-box 缺失，请重新构建应用") }
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("JMS Client")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let logfile = dir.appendingPathComponent("native-engine.log")
        if !FileManager.default.fileExists(atPath: logfile.path) { FileManager.default.createFile(atPath: logfile.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        let log = try FileHandle(forWritingTo: logfile); try log.seekToEnd()
        let p = Process(); p.executableURL = engine
        p.arguments = ["--dir", dir.path, "--core", core.path, "--ui", resources.appendingPathComponent("ui/index.html").path]
        p.standardOutput = log; p.standardError = log
        try p.run(); process = p
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
