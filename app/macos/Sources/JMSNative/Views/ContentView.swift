import SwiftUI
import AppKit

struct ContentView: View {
    @EnvironmentObject var model: AppModel
    @State private var page: String? = "概览"
    @State private var showSidebar = true
    private let pages = [("概览", "network"), ("订阅", "link"), ("节点", "server.rack"), ("分流规则", "line.3.horizontal.decrease.circle"), ("连接", "arrow.left.arrow.right"), ("连接检测", "waveform.path.ecg"), ("日志", "text.alignleft")]
    var body: some View {
        GeometryReader { geometry in
        HStack(spacing: 0) {
        if showSidebar {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(pages, id: \.0) { item in
                    Button { page = item.0 } label: {
                        Text(item.0).font(.system(size: 15, weight: page == item.0 ? .semibold : .medium))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12).padding(.vertical, 10)
                            .background(page == item.0 ? Color.primary.opacity(0.13) : .clear, in: RoundedRectangle(cornerRadius: 10))
                            .contentShape(Rectangle())
                    }.buttonStyle(.plain)
                        .accessibilityAddTraits(page == item.0 ? [.isSelected] : [])
                }
                Spacer()
                Button { NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil) } label: {
                    HStack { Text("设置"); Spacer(); Image(systemName: "gearshape").foregroundStyle(.secondary) }
                        .font(.system(size: 14, weight: .medium)).padding(12).contentShape(Rectangle())
                }.buttonStyle(.plain)
                Text("JMS Client").font(.caption).foregroundStyle(.tertiary).padding(.horizontal, 12).padding(.bottom, 8)
            }.padding(.horizontal, 12).padding(.top, 16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .frame(width: 185, height: geometry.size.height)
                .background(.regularMaterial)
            Divider()
        }
        VStack {
            if model.working {
                HStack(alignment: .top, spacing: 10) {
                    ProgressView().controlSize(.small)
                    VStack(alignment: .leading, spacing: 4) {
                        TimelineView(.periodic(from: model.workingStarted, by: 1)) { context in
                            Text("\(model.workingTitle) · 已用 \(Int(max(0, context.date.timeIntervalSince(model.workingStarted)))) 秒").font(.callout)
                        }
                        Text(model.workingCommand).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                        Text("请求有超时限制；超时后会显示错误，不会把未完成操作显示为成功。").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                }.padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 8)).padding(.horizontal, 24).padding(.top, 12)
            }
            Group {
                switch page {
                case "订阅": ProfilesView()
                case "节点": NodesView()
                case "分流规则": RulesView()
                case "连接": ConnectionsView()
                case "连接检测": ChecksView()
                case "日志": LogsView()
                default: OverviewView(onShowNodes: { page = "节点" }, onShowProfiles: { page = "订阅" }, onShowRules: { page = "分流规则" })
                }
            }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .groupBoxStyle(SoftGroupBoxStyle()).navigationTitle(page ?? "JMS Client")
        }
        }
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Button { showSidebar.toggle() } label: { Image(systemName: "sidebar.left") }.help("显示或隐藏侧边栏")
            }
            ToolbarItem(placement: .automatic) {
            if model.working { ProgressView().controlSize(.small) }
            Button(model.snapshot?.status.connected == true ? "断开" : "连接", systemImage: "power") { model.toggleConnection() }.labelStyle(.titleAndIcon).help("连接或断开代理").disabled(!model.ready || model.working)
            }
        }
        .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .sheet(isPresented: $model.showTunPermission) { TunPermissionView() }
        .alert("操作提示", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("复制说明") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(model.error ?? "", forType: .string) }
            Button("好") { model.error = nil }
        } message: { Text(model.error ?? "") }
    }
}
