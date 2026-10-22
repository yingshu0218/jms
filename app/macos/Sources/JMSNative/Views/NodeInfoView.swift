import SwiftUI

struct NodeInfoView: View {
    @Environment(\.dismiss) private var dismiss
    let node: Node
    let latency: String
    let current: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("节点详情").font(.title2.weight(.semibold))
            Text(node.name).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            GroupBox {
                LabeledContent("协议", value: node.type.uppercased())
                Divider()
                LabeledContent("服务器", value: node.server).textSelection(.enabled)
                Divider()
                LabeledContent("端口", value: String(node.server_port))
                Divider()
                LabeledContent("延迟", value: latency)
                Divider()
                LabeledContent("状态", value: current ? "当前使用" : "未使用")
            }
            HStack { Spacer(); Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction) }
        }.padding(24).frame(width: 420).groupBoxStyle(SoftGroupBoxStyle())
    }
}
