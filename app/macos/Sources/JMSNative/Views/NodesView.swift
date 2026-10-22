import SwiftUI

struct NodesView: View {
    @EnvironmentObject var model: AppModel
    @State private var search = ""
    @State private var protocolFilter = "all"
    @State private var sort = "original"
    @State private var inspected: Int?
    @State private var showingInfo = false
    private var nodes: [(Int, Node)] {
        NodeBrowser.rows(model.snapshot?.subscription.nodes ?? [], search: search, protocolFilter: protocolFilter, sort: sort, latency: model.snapshot?.nodeLatency ?? [:])
    }
    private var inspectedNode: Node? {
        guard let inspected, nodes.contains(where: { $0.0 == inspected }) else { return nil }
        return model.snapshot?.subscription.nodes[inspected]
    }
    private func delay(_ index: Int) -> String {
        guard let result = model.snapshot?.nodeLatency?[String(index)] else { return "未测速" }
        return result.ok ? result.delay.map { "\($0) ms" } ?? "未测速" : result.error ?? "不可用"
    }
    private func switchNode(_ index: Int) {
        guard model.ready, !model.working, model.snapshot?.settings.selected != index else { return }
        model.post("api/node", ["index": index])
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                TextField("搜索节点名称或服务器", text: $search).textFieldStyle(.roundedBorder)
                Picker("协议", selection: $protocolFilter) {
                    Text("全部").tag("all")
                    ForEach(Array(Set((model.snapshot?.subscription.nodes ?? []).map(\.type))).sorted(), id: \.self) { Text($0).tag($0) }
                }.frame(width: 140)
                Picker("排序", selection: $sort) { Text("原始顺序").tag("original"); Text("名称").tag("name"); Text("延迟").tag("latency") }.frame(width: 150)
            }
            HStack {
                Text("\(nodes.count) 个节点 · 单击查看，双击切换").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("全部测速") { model.measure() }.disabled(model.working || !model.ready || (model.snapshot?.subscription.nodes.isEmpty ?? true))
            }
            List(selection: $inspected) {
                ForEach(nodes, id: \.0) { index, node in
                    NodeRow(node: node, delay: delay(index), current: model.snapshot?.settings.selected == index, inspected: inspected == index,
                            enabled: model.ready && !model.working,
                            switchNode: { switchNode(index) }, measure: { model.measure(index) },
                            info: { inspected = index; showingInfo = true })
                        .tag(index)
                        .contentShape(Rectangle())
                        .onTapGesture(count: 2) { inspected = index; switchNode(index) }
                        .background(ImmediateRowSelection { if inspected != index { inspected = index } })
                        .contextMenu {
                            Button("查看详情") { inspected = index; showingInfo = true }
                            Button("切换到此节点") { switchNode(index) }.disabled(model.working || !model.ready || model.snapshot?.settings.selected == index)
                            Button("测试延迟") { model.measure(index) }.disabled(model.working || !model.ready)
                        }
                }
            }.listStyle(.plain).softListSurface()
                .overlay {
                    if nodes.isEmpty { Text((model.snapshot?.subscription.nodes.isEmpty ?? true) ? "还没有节点，请先添加订阅" : "没有匹配的节点").foregroundStyle(.secondary) }
                }
            if let node = inspectedNode, let inspected {
                GroupBox {
                    HStack(alignment: .top, spacing: 16) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(node.name).font(.callout.weight(.medium)).lineLimit(1).help(node.name)
                            Text("\(node.type.uppercased()) · \(node.server):\(String(node.server_port)) · \(delay(inspected))").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                        Spacer(minLength: 0)
                        Text(model.snapshot?.settings.selected == inspected ? "当前使用" : "仅查看").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Text("✓ 表示当前使用节点，蓝色高亮仅表示选中查看。测速无需连接。").font(.caption).foregroundStyle(.secondary)
        }
        .onChange(of: model.snapshot?.activeProfileId) { _ in inspected = nil; showingInfo = false }
        .onChange(of: model.snapshot?.subscription.nodes.map(\.id)) { _ in inspected = nil; showingInfo = false }
        .sheet(isPresented: $showingInfo) {
            if let node = inspectedNode, let inspected {
                NodeInfoView(node: node, latency: delay(inspected), current: model.snapshot?.settings.selected == inspected)
            }
        }
    }
}

private struct NodeRow: View {
    let node: Node
    let delay: String
    let current: Bool
    let inspected: Bool
    let enabled: Bool
    let switchNode: () -> Void
    let measure: () -> Void
    let info: () -> Void
    private var title: String {
        let suffix = node.name.split(separator: "@").last.map(String.init) ?? node.name
        let ending = ":\(node.server_port)"
        if node.name.contains("@"), suffix.contains("."), suffix.hasSuffix(ending) { return String(suffix.dropLast(ending.count)) }
        return node.name
    }
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(inspected ? Color.primary : Color.accentColor)
                .opacity(current ? 1 : 0).frame(width: 18).accessibilityLabel(current ? "当前使用" : "")
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body.weight(.medium)).lineLimit(1).truncationMode(.middle).help(node.name)
                Text(node.type.uppercased()).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 6)
            Text(delay).font(.caption).monospacedDigit().foregroundStyle(.secondary)
            if inspected && !current {
                Button("切换", action: switchNode).buttonStyle(.bordered).disabled(!enabled)
            }
            Button(action: measure) { Image(systemName: "arrow.clockwise") }.help("测试此节点延迟").accessibilityLabel("测试此节点延迟").disabled(!enabled)
            Button(action: info) { Image(systemName: "info.circle") }.help("查看节点详情").accessibilityLabel("查看节点详情")
        }.padding(.vertical, 8).buttonStyle(.borderless)
    }
}
