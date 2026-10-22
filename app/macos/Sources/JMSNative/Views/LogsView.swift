import SwiftUI

struct LogsView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Button("读取内核日志") {
                    model.perform {
                        let data = try await model.client.request("api/logs")
                        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                        model.logs = json?["lines"] as? [String] ?? []
                    }
                }.disabled(model.working || !model.ready)
                Button("清屏") { model.logs = [] }
            }
            ScrollView { Text(model.logs.isEmpty ? "暂无日志。连接后，事件会显示在这里。" : model.logs.joined(separator: "\n")).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(16) }.softListSurface()
        }
    }
}
