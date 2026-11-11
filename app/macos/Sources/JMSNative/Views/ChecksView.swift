import SwiftUI

struct ChecksView: View {
    @AppStorage("autoLinkCheck") private var autoLinkCheck = true
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            GroupBox {
                PreferenceRow(title: "连接后自动检测", subtitle: "未连接时检查直连，连接后检查代理链路") {
                    Toggle("连接后自动检测", isOn: $autoLinkCheck).labelsHidden().toggleStyle(.switch)
                }
                Divider()
                HStack {
                    if model.checking { ProgressView().controlSize(.small); Text("正在检测…").foregroundStyle(.secondary) }
                    else { Text("检查常用站点的连通性").foregroundStyle(.secondary) }
                    Spacer()
                    Button("开始检测") { model.checkLinks() }.buttonStyle(.borderedProminent).disabled(model.checking || !model.canSwitch)
                }.padding(.vertical, 5)
            }
            ScrollView {
                Text(model.checks).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(18)
            }.softListSurface()
        }
    }
}
