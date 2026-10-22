import SwiftUI
import AppKit

struct TunPermissionView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var permission: TunPermission?
    @State private var failure: String?
    @State private var loading = false
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("TUN 权限检查").font(.title2.bold())
            Text("TUN 需要创建虚拟网卡、修改路由表；授权对象是业务引擎，原生界面保持普通用户权限。").foregroundStyle(.secondary)
            if loading { ProgressView("正在检查…").controlSize(.small) }
            if let failure { Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
            if let permission {
                Label(permission.title, systemImage: permission.ok ? "checkmark.shield" : "lock.shield")
                    .font(.headline).foregroundStyle(permission.ok ? Color.green : Color.orange)
                if permission.ok {
                    Text("权限检查通过后仍需选择节点并连接。连接失败时请检查日志中的内核启动和路由错误。")
                } else {
                    Text(permission.hint ?? permission.error ?? "无法确认当前权限，请重试检查。")
                    GroupBox("手动提权顺序") {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("1. 先保存配置，断开代理，再从菜单明确退出 JMS Client，等待引擎停止。")
                            Text("2. 在终端执行下方引擎命令，按系统提示授权。不要以 root 启动原生界面。")
                            Text("3. 引擎就绪后重新打开应用，再次检查权限并连接。")
                            Text("4. 退出应用会先断开代理；手动启动的外部引擎需要另行停止。")
                        }.font(.callout).padding(6).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if let command = permission.command {
                        ScrollView { Text(command).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(8) }
                            .frame(height: 90).background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
                        Button(copied ? "已复制引擎命令" : "复制引擎提权命令") {
                            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(command, forType: .string); copied = true
                        }
                    }
                }
            }
            Text("首版采用手动命令流程，尚未安装特权辅助服务。此面板不会执行命令或自动启用 TUN。").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("重新检查") { Task { await check() } }.disabled(loading || !model.ready)
                if model.snapshot?.settings.mode == "tun-per-app" {
                    Button("改用系统代理") { model.settings(["mode": "sysproxy"]); dismiss() }.disabled(model.working)
                }
                Spacer()
                Button("完成") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }.padding(22).frame(width: 600)
        .task { await check() }
    }
    @MainActor private func check() async {
        guard !loading else { return }; loading = true; copied = false; failure = nil; permission = nil
        defer { loading = false }
        do {
            var client = model.client; client.timeout = 10
            let data = try await client.request("api/elevate", body: ["mode": "tun-per-app"])
            permission = try JSONDecoder().decode(TunPermission.self, from: data)
        } catch { failure = error.localizedDescription }
    }
}
