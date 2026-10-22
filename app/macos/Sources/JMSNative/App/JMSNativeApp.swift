import SwiftUI
import AppKit

@main struct JMSNativeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @AppStorage("appearance") private var appearance = "system"
    @StateObject private var model = AppModel.shared
    var body: some Scene {
        WindowGroup("JMS Client", id: "main") {
            ContentView().environmentObject(model).preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil).frame(minWidth: 850, minHeight: 600)
                .background(MainWindowRegistration())
                .task { model.start() }
        }
        .commands {
            CommandGroup(replacing: .appTermination) {
                Button("退出 JMS Client") { NSApp.terminate(nil) }.keyboardShortcut("q")
            }
        }
        Settings { SettingsView().environmentObject(model).preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil).frame(width: 480) }
        MenuBarExtra("JMS Client", systemImage: model.snapshot?.status.connected == true ? "network.badge.shield.half.filled" : "network") {
            MenuContent().environmentObject(model)
        }
    }
}
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var quitting = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        if let id = Bundle.main.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(withBundleIdentifier: id).first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            existing.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            exit(0)
        }
        NSApp.setActivationPolicy(.regular); NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        MainWindowPresenter.shared.show()
        return false
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !quitting else { return .terminateCancel }; quitting = true
        Task { @MainActor in
            let ok = await AppModel.shared.shutdown()
            if !ok {
                let alert = NSAlert(); alert.messageText = "暂时无法退出"; alert.informativeText = AppModel.shared.shutdownError ?? "请稍后重试"
                alert.addButton(withTitle: "返回应用"); alert.runModal()
            }
            quitting = false; sender.reply(toApplicationShouldTerminate: ok)
        }
        return .terminateLater
    }
}
