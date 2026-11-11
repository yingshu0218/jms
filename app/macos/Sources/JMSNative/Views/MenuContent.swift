import SwiftUI
import AppKit

struct MenuContent: View {
    @EnvironmentObject var model: AppModel
    private func shortTitle(_ name: String) -> String {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = name.isEmpty ? "未命名节点" : name
        return title.count > 30 ? String(title.prefix(29)) + "…" : title
    }
    var body: some View {
        Button("显示主窗口") { MainWindowPresenter.shared.show() }
        Button(model.snapshot?.status.connected == true ? "断开" : "连接") { model.toggleConnection() }.disabled(!model.canSwitch)
        Menu("节点") {
            if let snapshot = model.snapshot, !snapshot.subscription.nodes.isEmpty {
                ForEach(snapshot.subscription.nodes.indices, id: \.self) { index in
                    Button((model.effectiveSelection == index ? "✓ " : "") + shortTitle(snapshot.subscription.nodes[index].name)) {
                        model.setNode(index)
                    }.disabled(!model.canSwitch)
                }
                Text(model.selectionSummary)
            } else {
                Text("暂无节点，请先添加订阅")
            }
        }.disabled(!model.canSwitch)
        Divider()
        ForEach([("rule", "规则"), ("global", "全局"), ("direct", "直连")], id: \.0) { mode in
            Button((model.effectiveRoutingMode == mode.0 ? "✓ " : "") + mode.1) { model.post("api/routing-mode", ["mode": mode.0]) }.disabled(!model.canSwitch)
        }
        Divider()
        Button("退出 JMS Client") { NSApp.terminate(nil) }
    }
}
