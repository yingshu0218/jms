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
    @Published private(set) var selectionPending: Int?
    @Published private(set) var effectiveTrusted = false
    @Published var switchNotice = ""
    @Published var checks = "尚未检测"
    let runtime: EngineRuntime
    // Test injection never carries an authorization reference. Production only
    // reaches the owned Runtime's private Native pipe from an explicit action.
    var nativeProxyAction: ((String) async throws -> Void)?
    // Pure test seam. Production always asks the owned Runtime, never a PID lookup.
    var proxyHelperExitCheck: (() async throws -> Void)?
    init(runtime: EngineRuntime? = nil) {
        self.runtime = runtime ?? EngineRuntime()
        self.runtime.onTermination = { [weak self] in
            guard let self else { return }
            self.polling?.cancel(); self.events?.cancel()
            self.polling = nil; self.events = nil; self.ready = false
            self.snapshotGate.invalidate(); self.effectiveTrusted = false
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
        guard polling == nil, !shuttingDown, !working, !checking else { return }
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
        guard !ready, !startingEngine, !shuttingDown, !working, !checking else { return }
        error = nil; shutdownError = nil
        start()
    }
    private var snapshotGate = SnapshotGate()
    var recoveryRequired: Bool { snapshot?.status.recoveryRequired == true }
    var canControlConnection: Bool { ready && !working && !shuttingDown && snapshot?.status.busy == nil }
    var canSwitch: Bool { canControlConnection && !recoveryRequired }
    var effectiveSelection: Int? { effectiveTrusted && ready ? snapshot?.status.confirmedSelection : nil }
    var effectiveRoutingMode: String? { effectiveTrusted && ready ? snapshot?.status.confirmedMode : nil }
    var effectiveNodeName: String? {
        guard effectiveTrusted, ready, snapshot?.status.running == true, snapshot?.status.effective?.selectionKnown == true else { return nil }
        return snapshot?.status.effective?.node
    }
    var selectionSummary: String {
        if selectionPending != nil || routingModePending != nil { return "正在确认切换…" }
        guard ready else { return "引擎离线，当前状态未知" }
        if recoveryRequired { return "系统代理恢复尚未确认；仅可查看状态或明确发起恢复，原日志已保留" }
        if snapshot?.status.busy == "recovering" { return "内核正在恢复，当前生效状态尚未确认" }
        if snapshot?.status.running != true {
            guard let snapshot else { return "正在加载状态" }
            let index = snapshot.settings.selected
            let name = snapshot.subscription.nodes.indices.contains(index) ? snapshot.subscription.nodes[index].name : "未选择节点"
            return "尚未连接；下次连接：\(name) · \(snapshot.settings.routingMode)"
        }
        if !effectiveTrusted || snapshot?.status.effective?.known != true { return "当前生效状态尚未确认，可重新选择以重试" }
        if let message = snapshot?.status.persistenceError { return "当前已生效，但设置未保存：" + message }
        return switchNotice
    }
    func refresh(reconciling: Bool = false) async throws {
        if working && !reconciling { return }
        let active = client
        let ticket = snapshotGate.issue(lease: active.lease.instanceId)
        let result = try await active.snapshot()
        let credentials = try active.lease.authorize()
        guard snapshotGate.accepts(ticket, lease: runtime.instanceId), credentials.instanceId == runtime.instanceId else { return }
        snapshot = result
        effectiveTrusted = true
    }
    func perform(label: String = "正在执行操作", command: String = "本地引擎请求", allowRecovery: Bool = false, _ action: @escaping () async throws -> Void) {
        guard (allowRecovery ? canControlConnection : canSwitch) else { return }
        working = true; workingTitle = label; workingCommand = command; workingStarted = Date()
        snapshotGate.invalidate(); effectiveTrusted = false
        let switching = selectionPending != nil || routingModePending != nil
        if switching { switchNotice = "正在确认本次切换…" }
        let launch = runtime.instanceId
        mutationTask = Task {
            defer { working = false; mutationTask = nil; selectionPending = nil; routingModePending = nil }
            var requestFailed = false
            do { try await action() }
            catch {
                requestFailed = true
                if launch == runtime.instanceId {
                    if switching { switchNotice = "本次切换请求失败，结果尚待确认" }
                    if (error as? APIError)?.code == "NEED_ELEVATION" { self.showTunPermission = true }
                    else { self.error = error.localizedDescription }
                }
            }
            snapshotGate.invalidate()
            guard launch == runtime.instanceId else {
                if switching { switchNotice = "引擎会话已变化，本次切换结果未知，请重新确认" }
                return
            }
            do {
                try await refresh(reconciling: true)
                if switching && requestFailed {
                    switchNotice = effectiveTrusted && snapshot?.status.effective?.known == true
                        ? "本次切换请求失败，当前生效状态已重新确认；保存结果未确认，可重试"
                        : "本次切换结果未知，可重新确认或重试"
                }
            } catch {
                effectiveTrusted = false; self.error = error.localizedDescription
                if switching { switchNotice = "本次切换结果未知，可重新确认或重试" }
            }
        }
    }
    func post(_ path: String, _ body: [String: Any] = [:]) {
        if path == "api/routing-mode", let mode = body["mode"] as? String { setRoutingMode(mode); return }
        if path == "api/node", let index = body["index"] as? Int { setNode(index); return }
        let restoring = path == "api/disconnect"
        let nativeProxy = !runtime.configuration.isolated && (path == "api/connect" || restoring) &&
            (snapshot?.settings.mode == "sysproxy" || (restoring && snapshot?.status.pendingProxyJournal == true))
        perform(label: path == "api/connect" ? "准备授权并连接代理" : restoring ? "准备授权并恢复系统代理" : "正在执行操作",
                command: nativeProxy ? "原生私有系统代理事务" : "POST /" + path, allowRecovery: restoring) {
            if nativeProxy {
                try await self.runNativeProxyAction(restoring ? "disconnect" : "connect")
                return
            }
            let data = try await self.client.request(path, body: body)
            if let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], let reason = result["reason"] as? String {
                self.logs.append(reason)
                if self.snapshot?.status.running == true { self.error = reason }
            }
        }
    }
    private func switchValue(path: String, body: [String: Any]) {
        let active = client
        let launch = runtime.instanceId
        perform(label: "正在确认切换", command: "POST /" + path) {
            let data = try await active.request(path, body: body)
            guard launch == self.runtime.instanceId else { return }
            _ = try active.lease.authorize()
            let result = try JSONDecoder().decode(HotSwitchResult.self, from: data)
            self.switchNotice = result.summary
            if !result.applied || !result.persisted { self.logs.append(result.summary) }
            // Desired settings and current selection are never guessed from the request.
            // A fresh, authenticated snapshot reconciles both success and failure.
        }
    }
    func setNode(_ index: Int) {
        guard canSwitch, let count = snapshot?.subscription.nodes.count, (0..<count).contains(index) else { return }
        selectionPending = index
        switchValue(path: "api/node", body: ["index": index])
    }
    func setRoutingMode(_ mode: String) {
        guard canSwitch, ["rule", "global", "direct"].contains(mode) else { return }
        routingModePending = mode
        switchValue(path: "api/routing-mode", body: ["mode": mode])
    }
    func settings(_ patch: [String: Any]) { post("api/settings", ["settings": patch]) }
    func toggleConnection() { post(recoveryRequired || snapshot?.status.connected == true ? "api/disconnect" : "api/connect") }
    func recoverProxy() { post("api/disconnect") }
    private func runNativeProxyAction(_ action: String) async throws {
        if let nativeProxyAction { try await nativeProxyAction(action) }
        else { try await runtime.performProxyAction(action) }
    }
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
        guard ready, !checking, !shuttingDown, !working, !recoveryRequired else { return }; checking = true
        checkingTask = Task {
            defer { checking = false; checkingTask = nil }
            do {
            let data = try await self.client.request("api/linkcheck", body: [:])
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            let results = json["results"] as? [[String: Any]] ?? []
            let via = json["via"] as? String == "proxy" ? (json["routeScope"] as? String == "selected-node" ? "指定节点链路（独立于业务分流）" : "本地代理入口（按当前路由，未必经过远端节点）") : "直连（未验证代理）"
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
                    try activeClient.lease.validate(request)
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
    private static let helperExitMessage = "退出未完成：代理助手或恢复结果尚未确认，请等待操作完成并重新检查后重试。"
    private func checkProxyHelperExit() async throws {
        do {
            if let proxyHelperExitCheck { try await proxyHelperExitCheck() }
            else { try await runtime.ensureProxyHelperInactive() }
        } catch {
            // Never expose helper stderr, private frames, or an injected raw error.
            throw APIError(message: Self.helperExitMessage, code: "PROXY_HELPER_EXIT_UNCONFIRMED")
        }
    }
    private func helperExitBlocked() -> Bool {
        shuttingDown = false
        shutdownError = Self.helperExitMessage
        error = Self.helperExitMessage
        return false
    }
    func shutdown() async -> Bool {
        guard !shuttingDown else { return false }
        shuttingDown = true
        do { try await checkProxyHelperExit() }
        catch { return helperExitBlocked() }
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
        // Mutations may have created an owned helper while they were draining.
        do { try await checkProxyHelperExit() }
        catch { return helperExitBlocked() }
        if runtime.process?.isRunning != true {
            if runtime.canExitWithoutLiveEngine { return true }
            shuttingDown = false
            shutdownError = "引擎已退出，无法确认系统代理已恢复。请点击“重新启动并检查恢复”，明确完成恢复后再退出。"
            error = shutdownError
            return false
        }
        let shutdownInstanceId = runtime.instanceId
        do {
            // Quit is an explicit recovery action, not permission for a silent
            // background prompt. Cancellation/unknown returns false below and
            // leaves the core, engine and journal available for manual recovery.
            if !runtime.configuration.isolated, snapshot?.status.pendingProxyJournal == true {
                try await runNativeProxyAction("disconnect")
            }
            try await checkProxyHelperExit()
            _ = try await client.request("api/shutdown", body: [:])
            try await ShutdownCoordinator.run(
                status: { try await self.client.snapshot().status },
                disconnect: { _ = try await self.client.request("api/disconnect", body: [:]) },
                stop: {
                    try await self.checkProxyHelperExit()
                    try await self.runtime.stopOwnedProcess()
                })
            try await checkProxyHelperExit()
            // Mark only after the authenticated shutdown, both status checks and
            // owned process stop have all completed for this exact launch.
            guard runtime.recordVerifiedCleanup(instanceId: shutdownInstanceId) else {
                throw APIError(message: Self.helperExitMessage, code: "PROXY_HELPER_EXIT_UNCONFIRMED")
            }
            polling?.cancel(); events?.cancel()
            return true
        } catch {
            // A live/unknown helper must not be followed by a resume mutation.
            if runtime.hasActiveProxyHelper || ["PROXY_HELPER_EXIT_UNCONFIRMED", "NATIVE_PROXY_UNKNOWN"].contains((error as? APIError)?.code ?? "") { return helperExitBlocked() }
            // Keep the owned engine alive on other restoration failures, then allow retry.
            _ = try? await client.request("api/resume", body: [:])
            shuttingDown = false
            self.shutdownError = "退出未完成：\(error.localizedDescription)"
            return false
        }
    }
}
