import SwiftUI

struct SettingsView: View {
    @AppStorage("appearance") private var appearance = "system"
    @EnvironmentObject var model: AppModel
    @State private var port = "2080"
    @State private var localDns = "system"
    @State private var remoteDns = "https://1.1.1.1/dns-query"
    @State private var interval = "180"
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("通用设置").font(.system(size: 23, weight: .semibold))
            GroupBox {
                PreferenceRow(title: "外观") {
                    Picker("外观", selection: $appearance) { Text("跟随系统").tag("system"); Text("浅色").tag("light"); Text("深色").tag("dark") }.labelsHidden().frame(width: 150)
                }
            }
            GroupBox {
                PreferenceRow(title: "本地代理端口") { TextField("2080", text: $port).frame(width: 100) }
                Divider()
                PreferenceRow(title: "订阅刷新", subtitle: "检查所有订阅，单位为分钟") { TextField("180", text: $interval).frame(width: 100) }
            }
            GroupBox {
                PreferenceRow(title: "本地 DNS", subtitle: "system 或服务器 IP") { TextField("system", text: $localDns).frame(width: 210) }
                Divider()
                PreferenceRow(title: "远端 DNS") { TextField("DNS 地址", text: $remoteDns).frame(width: 210) }
            }
            Text("端口与 DNS 修改后，重新连接即可生效。").font(.caption).foregroundStyle(.secondary)
            if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("保存设置") {
                    guard let p = Int(port), (1...65535).contains(p), let minutes = Int(interval), minutes >= 1 else { model.error = "端口必须是 1–65535，刷新间隔至少 1 分钟"; return }
                    model.settings(["port": p, "localDns": localDns, "remoteDns": remoteDns, "autoRefreshMinutes": minutes])
                }.buttonStyle(.borderedProminent).controlSize(.large)
            }
        }.textFieldStyle(.roundedBorder).groupBoxStyle(SoftGroupBoxStyle()).padding(26)
            .disabled(model.working || !model.ready)
            .onAppear { if let s = model.snapshot?.settings { port = String(s.port); localDns = s.localDns; remoteDns = s.remoteDns; interval = String(s.autoRefreshMinutes) } }
    }
}
