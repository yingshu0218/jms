import AppKit
import SwiftUI

@MainActor final class AppModel: ObservableObject {
    static let shared = AppModel()
    @Published var snapshot: EngineSnapshot?
    @Published var error: String?
    @Published var working = false
    @Published var workingTitle = "正在执行"
    @Published var workingCommand = ""
    @Published var workingStarted = Date()
    @Published var showTunPermission = false
    var shutdownError: String?
    @Published var ready = false
    @Published private(set) var startingEngine = false
    @Published private(set) var shuttingDown = false
    @Published var logs: [String] = []
    @Published var latency = ""
    @Published var checking = false
    @Published var routingModePending: String?
    @Published var checks = "尚未检测"
    let runtime: EngineRuntime
    init(runtime: EngineRuntime? = nil) {
        self.runtime = runtime ?? EngineRuntime()
        self.runtime.onTermination = { [weak self] in
            guard let self else { return }
            self.polling?.cancel(); self.events?.cancel()
            self.polling = nil; self.events = nil; self.ready = false
            if !self.shuttingDown { self.error = "自有引擎已退出，已停止轮询与事件重连" }
        }
    }
    var client: EngineClient { runtime.client }
    private var polling: Task<Void, Never>?
    private var events: Task<Void, Never>?
    private var mutationTask: Task<Void, Never>?
    private var routingTask: Task<Void, Never>?
    private var checkingTask: Task<Void, Never>?
    func start() {
        guard polling == nil, !shuttingDown else { return }
        startingEngine = true
        polling = Task {
            do { try await runtime.start(); try Task.checkCancellation(); ready = true; startingEngine = false }
            catch { self.error = error.localizedDescription; startingEngine = false; polling = nil; return }
            events = Task { await subscribe() }
            while !Task.isCancelled {
                do { try await refresh() } catch { self.error = error.localizedDescription }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }
    func retryEngineRecovery() {
        guard !ready, !startingEngine, !shuttingDown else { return }
        error = nil; shutdownError = nil
        start()
    }
    private var stateRevision = 0
    func refresh() async throws {
        let revision = stateRevision
        let result = try await client.snapshot()
        if revision == stateRevision { snapshot = result }
    }
    func perform(label: String = "正在执行操作", command: String = "本地引擎请求", _ action: @escaping () async throws -> Void) {
        guard !working, !shuttingDown else { return }; working = true; workingTitle = label; workingCommand = command; workingStarted = Date()
        mutationTask = Task {
            defer { working = false; mutationTask = nil }
            do {
                try await action()
                stateRevision += 1
                working = false
                Task { do { try await self.refresh() } catch { self.error = error.localizedDescription } }
            }
            catch {
                if (error as? APIError)?.code == "NEED_ELEVATION" { self.showTunPermission = true }
                else { self.error = error.localizedDescription }
            }
        }
    }
    func post(_ path: String, _ body: [String: Any] = [:]) {
        if path == "api/routing-mode", let mode = body["mode"] as? String {
            setRoutingMode(mode)
            return
        }
        perform(label: path == "api/connect" ? "正在连接代理" : path == "api/disconnect" ? "正在恢复系统网络设置" : "正在执行操作", command: "POST /" + path) {
            let data = try await self.client.request(path, body: body)
            if path == "api/node", let index = body["index"] as? Int, let count = self.snapshot?.subscription.nodes.count, (0..<count).contains(index) {
                self.snapshot?.settings.selected = index
            }
            if let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], let reason = result["reason"] as? String {
                self.logs.append(reason)
                if self.snapshot?.status.running == true { self.error = reason }
            }
        }
    }
    func setRoutingMode(_ mode: String) {
        guard ready, !shuttingDown, !working, routingModePending == nil,
              ["rule", "global", "direct"].contains(mode), snapshot?.settings.routingMode != mode else { return }
        routingModePending = mode
        stateRevision += 1
        routingTask = Task {
            defer { routingModePending = nil; routingTask = nil }
            do {
                let data = try await client.request("api/routing-mode", body: ["mode": mode])
                let result = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                snapshot?.settings.routingMode = mode
                stateRevision += 1
                if let reason = result?["reason"] as? String {
                    logs.append(reason)
                    if snapshot?.status.running == true { error = reason }
                }
                Task { try? await self.refresh() }
            } catch {
                stateRevision += 1
                self.error = error.localizedDescription
            }
        }
    }
    func settings(_ patch: [String: Any]) { post("api/settings", ["settings": patch]) }
    func toggleConnection() { post(snapshot?.status.connected == true ? "api/disconnect" : "api/connect") }
    func saveRules(_ rules: [Rule]) {
        perform {
            let data = try JSONEncoder().encode(rules)
            let json = try JSONSerialization.jsonObject(with: data)
            _ = try await self.client.request("api/settings", body: ["settings": ["customRules": json]])
        }
    }
    func measure(_ index: Int? = nil) {
        perform {
            var client = self.client
            let count = index == nil ? (self.snapshot?.subscription.nodes.count ?? 0) : 1
            client.timeout = max(90, ceil(Double(count) / 4) * 10 + 20)
            let data = try await client.request("api/latency", body: index.map { ["index": $0] } ?? ["all": true])
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let results = json?["latency"] as? [String: [String: Any]] ?? [:]
            self.latency = results.keys.sorted().map { name in
                let result = results[name] ?? [:]
                return "\(name)：\(result["ok"] as? Bool == true ? "\(result["delay"] ?? result["ms"] ?? "—") ms" : "\(result["error"] ?? "不可用")")"
            }.joined(separator: "\n")
        }
    }
    func checkLinks() {
        guard !checking, !shuttingDown else { return }; checking = true
        checkingTask = Task {
            defer { checking = false; checkingTask = nil }
            do {
            let data = try await self.client.request("api/linkcheck", body: [:])
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            let results = json["results"] as? [[String: Any]] ?? []
            let via = json["via"] as? String == "proxy" ? "代理链路" : "直连（未验证代理）"
            let summary = json["summary"] as? [String: Any] ?? [:]
            let conclusion = json["via"] as? String == "proxy" ? "\(summary["verdict"] ?? "")" : "\(results.filter { $0["ok"] as? Bool == true }.count)/\(results.count) 个站点直连可达，本次未验证代理链路。"
            self.checks = "检测方式：\(via)\n\(conclusion)\n\n" + results.map { r in
                let status = r["ok"] as? Bool == true ? "可达 · \(r["latencyMs"] ?? "—") ms" : "\(r["error"] ?? "不可达")"
                return "\(r["label"] ?? r["url"] ?? "站点")：\(status)\n\(r["diagnosis"] ?? "")"
            }.joined(separator: "\n")
            } catch { self.error = error.localizedDescription }
        }
    }
    private func subscribe() async {
        while !Task.isCancelled {
            do {
                var request = try client.makeRequest("api/events"); request.timeoutInterval = 86400
                let activeClient = client
                try activeClient.lease.validate(request)
                let (bytes, response) = try await activeClient.session.bytes(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw APIError(message: "事件流连接失败") }
                var kind = "message"
                for try await line in bytes.lines {
                    if Task.isCancelled { return }
                    if line.hasPrefix("event: ") { kind = String(line.dropFirst(7)) }
                    if line.hasPrefix("data: ") {
                        let value = String(line.dropFirst(6))
                        if kind == "operation-progress", self.working,
                           let data = value.data(using: .utf8), let progress = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
                            workingTitle = progress["stage"] ?? workingTitle
                            workingCommand = progress["command"] ?? workingCommand
                        }
                        let decoded = (try? JSONSerialization.jsonObject(with: Data(value.utf8), options: [.fragmentsAllowed])) as? String ?? value
                        logs.append("[\(kind)] \(decoded)"); if logs.count > 2000 { logs.removeFirst(logs.count - 2000) }
                        if kind == "connected" && (UserDefaults.standard.object(forKey: "autoLinkCheck") == nil || UserDefaults.standard.bool(forKey: "autoLinkCheck")) { checkLinks() }
                        if kind != "core-log" { try? await refresh() }
                    }
                }
            } catch { if Task.isCancelled { return } }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }
    func shutdown() async -> Bool {
        guard !shuttingDown else { return false }
        shuttingDown = true
        // Cancelling an HTTP request does not cancel its server-side operation.
        // Drain in-flight mutations before asking the engine to reject new ones.
        if !ready {
            polling?.cancel()
            await polling?.value
            polling = nil
        }
        await mutationTask?.value
        await routingTask?.value
        await checkingTask?.value
        if runtime.process?.isRunning != true {
            if runtime.canExitWithoutLiveEngine { return true }
            shuttingDown = false
            shutdownError = "引擎已退出，无法确认系统代理已恢复。请点击“重新启动并恢复”，完成恢复后再退出。"
            error = shutdownError
            return false
        }
        let shutdownInstanceId = runtime.instanceId
        do {
            _ = try await client.request("api/shutdown", body: [:])
            try await ShutdownCoordinator.run(
                status: { try await self.client.snapshot().status },
                disconnect: { _ = try await self.client.request("api/disconnect", body: [:]) },
                stop: { try await self.runtime.stopOwnedProcess() })
            // Mark only after the authenticated shutdown, both status checks and
            // owned process stop have all completed for this exact launch.
            runtime.recordVerifiedCleanup(instanceId: shutdownInstanceId)
            polling?.cancel(); events?.cancel()
            return true
        } catch {
            // Keep the owned engine alive on restoration failure, then allow retry.
            _ = try? await client.request("api/resume", body: [:])
            shuttingDown = false
            self.shutdownError = "退出未完成：\(error.localizedDescription)"
            return false
        }
    }
}
