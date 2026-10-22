// JMS Client · macOS 原生窗口宿主（Swift + WKWebView）
//
// 为什么有这个文件：Tauri 外壳需要完整 Rust 工具链，装 rustup + 编译依赖往往要十几分钟，
// 而且 Tauri 2 的依赖在部分 Xcode 版本上会卡住。这个宿主只用系统自带的 WebKit，
// 用 swiftc 编译（Xcode Command Line Tools 自带），几十秒出成品，产出的是**真正的原生
// 窗口应用**：有标题栏、有 Dock 图标、Cmd+Q 可退出。
//
// 它负责：
//   1. 把引擎 sidecar 作为子进程拉起，并等它就绪；
//   2. 开一个 WKWebView 窗口加载引擎提供的界面（同源，无需 CORS）；
//   3. 退出时**先让引擎断连**（还原系统代理），再收掉子进程。
//      顺序不能反 —— 直接杀进程会把用户的系统代理永久留在我们改过的状态上。

import Cocoa
import WebKit

let engineHost = "127.0.0.1"
let enginePort = 7788
let engineBaseURL = URL(string: "http://\(engineHost):\(enginePort)")!

// ── 定位随包资源 ────────────────────────────────────────────────────────
// 可执行文件在 Contents/MacOS/ 下，资源在 Contents/Resources/ 下。
// 用可执行文件自身路径反推，比依赖 BUNDLE 环境变量可靠（命令行直接调用时后者为空）。
func resourceURL(_ name: String) -> URL? {
    let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    let contents = exe.deletingLastPathComponent().deletingLastPathComponent()
    let url = contents.appendingPathComponent("Resources").appendingPathComponent(name)
    return FileManager.default.fileExists(atPath: url.path) ? url : nil
}

/// 同步发一个 POST 到引擎。用于退出前的收尾 —— 那时已经不能依赖异步回调了。
@discardableResult
func enginePost(_ path: String, timeout: TimeInterval = 5) -> Bool {
    var req = URLRequest(url: engineBaseURL.appendingPathComponent(path))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = "{}".data(using: .utf8)
    req.timeoutInterval = timeout
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: req) { _, resp, _ in
        if let http = resp as? HTTPURLResponse { ok = http.statusCode < 400 }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + timeout + 1)
    return ok
}

func engineAlive() -> Bool {
    var req = URLRequest(url: engineBaseURL.appendingPathComponent("api/state"))
    req.timeoutInterval = 1.5
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: req) { _, resp, _ in
        if let http = resp as? HTTPURLResponse { ok = http.statusCode == 200 }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 2)
    return ok
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var engine: Process?
    var shuttingDown = false

    // ── 启动 ────────────────────────────────────────────────────────────
    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()

        // 已经有了引擎（比如用户同时开着命令行版）就直接连 —— 引擎自己有单实例锁，
        // 抢第二个实例只会弹错误，不如先探测一下。
        if engineAlive() {
            loadUI()
            return
        }
        startEngine()
    }

    func startEngine() {
        guard let exe = resourceURL("engine/jms-engine") else {
            showError("随包引擎缺失：Contents/Resources/engine/jms-engine\n请重新执行 tools/make-macos-app.sh")
            return
        }
        let core = resourceURL("core/sing-box")

        // 状态目录：~/Library/Application Support/JMS Client
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("JMS Client", isDirectory: true)
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])

        var args = ["--dir", support.path, "--host", engineHost, "--port", String(enginePort)]
        if let ui = resourceURL("ui/index.html") {
            // 引擎默认在 ../ui/ 找界面，随包后位置不同，必须显式指定
            args += ["--ui", ui.path]
        }

        let p = Process()
        p.executableURL = exe
        p.arguments = args
        var env = ProcessInfo.processInfo.environment
        if let core = core { env["SING_BOX"] = core.path }
        p.environment = env
        // 引擎的日志直接丢掉：界面上有「内核日志」面板，走的是事件流，
        // 不需要把 stdout 也捞回来，避免管道写满把子进程卡死。
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice

        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self = self, !self.shuttingDown else { return }
                // 引擎自己挂了：告诉用户，不要把界面留在"看起来连着"的状态
                self.showError("引擎进程意外退出（退出码 \(proc.terminationStatus)）。\n"
                    + "请重启应用；若反复出现，查看 ~/Library/Application Support/JMS Client/logs/core.log")
            }
        }

        do {
            try p.run()
            engine = p
        } catch {
            showError("无法启动引擎：\(error.localizedDescription)")
            return
        }

        waitForEngine(attempts: 80)
    }

    /// 等引擎就绪。sidecar 是自带运行时的单文件二进制，冷启动通常 1 秒内。
    func waitForEngine(attempts: Int) {
        if engineAlive() {
            loadUI()
            return
        }
        if attempts <= 0 {
            showError("引擎启动超时。\n请确认已给随包引擎签名（Apple Silicon 上未签名的二进制会被系统直接杀掉）：\n"
                + "  codesign --force --sign - \"<应用路径>/Contents/Resources/engine/jms-engine\"")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.waitForEngine(attempts: attempts - 1)
        }
    }

    // ── 窗口 ────────────────────────────────────────────────────────────
    func buildWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1180, height: 840)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "JMS Client"
        window.minSize = NSSize(width: 940, height: 620)
        window.center()
        window.delegate = self
        window.setFrameAutosaveName("JMSMainWindow")
        window.makeKeyAndOrderFront(nil)
    }

    func loadUI() {
        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: window.contentView!.bounds, configuration: cfg)
        webView.autoresizingMask = [.width, .height]
        window.contentView?.addSubview(webView)
        webView.load(URLRequest(url: engineBaseURL))
        NSApp.activate(ignoringOtherApps: true)
    }

    func showError(_ message: String) {
        // 先弹窗，再加载界面 —— 让用户看到原因，而不是一个空白窗口
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "JMS Client"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
        if webView == nil, window.contentView?.subviews.isEmpty ?? true {
            NSApp.terminate(nil)
        }
    }

    // ── 退出收尾 ────────────────────────────────────────────────────────
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        shuttingDown = true
        // 顺序不可颠倒：先让引擎断连（它会精确还原用户的系统代理设置），再收进程。
        enginePost("api/disconnect")
        if let p = engine, p.isRunning {
            p.terminate() // SIGTERM：引擎自己也挂了处理器会做一遍清理，两道保险
            let deadline = Date().addingTimeInterval(3)
            while p.isRunning && Date() < deadline { usleep(50_000) }
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        }
    }

    /// 关窗口 = 退出应用。这个宿主没有托盘，所以不能像 Tauri 版那样收进后台，
    /// 否则用户会以为关了、其实代理还开着。
    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }

    // ── 菜单 ────────────────────────────────────────────────────────────
    /// 没有菜单栏的话 Cmd+Q / Cmd+C 都不生效。复制项尤其重要 ——
    /// 提权提示里那条命令用户是要复制出去执行的。
    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 JMS Client", action: #selector(about), keyEquivalent: "")
            .target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 JMS Client", action: #selector(NSApplication.terminate(_:)),
                        keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: "显示")
        view.addItem(withTitle: "重新载入界面", action: #selector(reload), keyEquivalent: "r").target = self
        viewItem.submenu = view

        NSApp.mainMenu = main
    }

    @objc func about() {
        let a = NSAlert()
        a.messageText = "JMS Client"
        a.informativeText = "版本 \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")"
            + "\n\n本地代理客户端：按应用分流，三档路由，系统代理 / 进程级 TUN 两种接管方式。"
        a.runModal()
    }

    @objc func reload() {
        webView?.reload()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
