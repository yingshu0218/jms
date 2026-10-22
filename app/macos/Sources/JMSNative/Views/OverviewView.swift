import SwiftUI

struct OverviewView: View {
    @EnvironmentObject var model: AppModel
    var onShowNodes: () -> Void
    var onShowProfiles: () -> Void
    var onShowRules: () -> Void
    private var connected: Bool { model.snapshot?.status.connected == true }
    private var nodeCount: Int { model.snapshot?.subscription.nodes.count ?? 0 }
    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 18) {
            Text("你的网络，尽在掌握").font(.system(size: 23, weight: .semibold))
            Text("选择订阅与节点，随时开始连接。").foregroundStyle(.secondary)
            if !model.ready {
                HStack { Text("引擎尚未就绪").foregroundStyle(.secondary); Spacer(); Button("重试启动") { model.start() } }
            }
            GroupBox {
                HStack(spacing: 14) {
                    Image(systemName: connected ? "checkmark.shield.fill" : "network")
                        .font(.system(size: 26, weight: .light)).foregroundStyle(connected ? Color.green : Color.secondary)
                        .frame(width: 42, height: 48)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(connected ? "代理已连接" : "尚未连接").font(.title3.weight(.semibold))
                        Text(model.snapshot?.status.node ?? "添加订阅后选择一个节点").foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 6)
                    Button(connected ? "断开连接" : "连接代理") { model.toggleConnection() }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        .disabled(!model.ready || model.working || (!connected && nodeCount == 0))
                }
                if connected && model.snapshot?.settings.mode == "sysproxy" && model.snapshot?.status.pointingAtUs == false {
                    Label("系统代理未指向 JMS，可能被其他代理或 VPN 覆盖。", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                }
                Divider()
                PreferenceRow(title: "当前节点", subtitle: nodeCount == 0 ? "尚未导入节点" : "共 \(nodeCount) 个可用节点") {
                    Button("选择节点") { onShowNodes() }.buttonStyle(.bordered)
                }
            }
            GroupBox {
                PreferenceRow(title: "订阅", subtitle: model.snapshot?.profiles?.first(where: { $0.id == model.snapshot?.activeProfileId })?.name ?? "还没有订阅，添加后即可导入节点") {
                    Button("管理订阅") { onShowProfiles() }.buttonStyle(.bordered)
                }
            }
            if let settings = model.snapshot?.settings {
                GroupBox {
                    PreferenceRow(title: "路由模式") {
                        Picker("路由模式", selection: Binding(get: { model.routingModePending ?? settings.routingMode }, set: { model.setRoutingMode($0) })) {
                            Text("规则").tag("rule"); Text("全局").tag("global"); Text("直连").tag("direct")
                        }.labelsHidden().pickerStyle(.segmented).frame(width: 230).allowsHitTesting(model.routingModePending == nil)
                    }
                    Divider()
                    PreferenceRow(title: "接管方式", subtitle: "修改后重新连接生效") {
                        Picker("接管方式", selection: Binding(get: { settings.mode }, set: { model.settings(["mode": $0]) })) {
                            Text("系统代理").tag("sysproxy"); Text("按应用 TUN").tag("tun-per-app")
                        }.labelsHidden().frame(width: 150)
                    }
                    if settings.mode == "tun-per-app" {
                        Divider()
                        HStack {
                            Button("应用名单") { onShowRules() }
                            Spacer()
                            Button("检查 TUN 权限") { model.showTunPermission = true }
                        }.buttonStyle(.borderless)
                    }
                }.disabled(model.working || !model.ready)
            }
        }.frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }
}
