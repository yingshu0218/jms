import SwiftUI
import AppKit

/// Observe mouse-down without consuming it: selection is immediate, while
/// SwiftUI still handles double clicks and the row's own buttons normally.
struct ImmediateRowSelection: NSViewRepresentable {
    var select: () -> Void
    func makeNSView(context: Context) -> ObserverView { ObserverView() }
    func updateNSView(_ view: ObserverView, context: Context) { view.select = select }
    static func dismantleNSView(_ view: ObserverView, coordinator: ()) { view.stop() }
    final class ObserverView: NSView {
        var select: (() -> Void)?
        private var monitor: Any?
        override init(frame: NSRect) {
            super.init(frame: frame)
            monitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
                guard let self, let window = self.window, event.window === window,
                      !self.isHiddenOrHasHiddenAncestor,
                      self.visibleRect.contains(self.convert(event.locationInWindow, from: nil)) else { return event }
                self.select?()
                return event
            }
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        func stop() { if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil }
        deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
    }
}
