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
        Button(model.snapshot?.status.connected == true ? "断开" : "连接") { model.toggleConnection() }.disabled(!model.ready || model.working)
        Menu("节点") {
            if let snapshot = model.snapshot, !snapshot.subscription.nodes.isEmpty {
                Picker("当前节点", selection: Binding(
                    get: { snapshot.settings.selected },
                    set: { model.post("api/node", ["index": $0]) }
                )) {
                    ForEach(snapshot.subscription.nodes.indices, id: \.self) { index in
                        Text(shortTitle(snapshot.subscription.nodes[index].name)).tag(index)
                    }
                }.pickerStyle(.inline)
            } else {
                Text("暂无节点，请先添加订阅")
            }
        }.disabled(!model.ready || model.working)
        Divider()
        ForEach([("rule", "规则"), ("global", "全局"), ("direct", "直连")], id: \.0) { mode in
            Button(mode.1) { model.post("api/routing-mode", ["mode": mode.0]) }.disabled(!model.ready || model.working)
        }
        Divider()
        Button("退出 JMS Client") { NSApp.terminate(nil) }
    }
}
