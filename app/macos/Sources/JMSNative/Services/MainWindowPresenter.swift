import AppKit
import SwiftUI

/// SwiftUI owns creation; this bridge restores and raises that same main window.
@MainActor final class MainWindowPresenter {
    static let shared = MainWindowPresenter()
    private weak var window: NSWindow?
    private var openMain: (() -> Void)?

    func register(_ window: NSWindow, open: @escaping () -> Void) {
        self.window = window
        self.openMain = open
    }

    func show() {
        NSApp.unhide(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let window, window.isVisible || window.isMiniaturized {
            raiseWindow()
            return
        }
        openMain?()
        // SwiftUI may need one run-loop turn to recreate a closed scene.
        DispatchQueue.main.async { [weak self] in self?.raiseWindow() }
    }

    private func raiseWindow() {
        guard let window else { return }
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

struct MainWindowRegistration: NSViewRepresentable {
    @Environment(\.openWindow) private var openWindow
    func makeNSView(context: Context) -> RegistrationView { RegistrationView() }
    func updateNSView(_ view: RegistrationView, context: Context) {
        view.openMain = { openWindow(id: "main") }
        view.registerWindow()
    }
    final class RegistrationView: NSView {
        var openMain: (() -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            registerWindow()
        }
        func registerWindow() {
            guard let window, let openMain else { return }
            MainWindowPresenter.shared.register(window, open: openMain)
        }
    }
}
