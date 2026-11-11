import SwiftUI

struct SettingsView: View {
    @AppStorage("appearance") private var appearance = "system"
    @EnvironmentObject var model: AppModel
    @State private var draft = SettingsDraft()
    private var sourceVersion: [String]? {
        model.snapshot.map { [String($0.settings.port), $0.settings.localDns, $0.settings.remoteDns, String($0.settings.autoRefreshMinutes)] }
    }
    private func binding(_ key: WritableKeyPath<SettingsDraft, String>) -> Binding<String> {
        Binding(get: { draft[keyPath: key] }, set: { draft.edit(key, $0) })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("通用设置").font(.system(size: 23, weight: .semibold))
            GroupBox {
                PreferenceRow(title: "外观") {
                    Picker("外观", selection: $appearance) { Text("跟随系统").tag("system"); Text("浅色").tag("light"); Text("深色").tag("dark") }.labelsHidden().frame(width: 150)
                }
            }
            GroupBox {
                PreferenceRow(title: "本地代理端口") { TextField("2080", text: binding(\.port)).frame(width: 100) }
                Divider()
                PreferenceRow(title: "订阅刷新", subtitle: "检查所有订阅，单位为分钟") { TextField("180", text: binding(\.interval)).frame(width: 100) }
            }
            GroupBox {
                PreferenceRow(title: "本地 DNS", subtitle: "system 或服务器 IP") { TextField("system", text: binding(\.localDns)).frame(width: 210) }
                Divider()
                PreferenceRow(title: "远端 DNS") { TextField("DNS 地址", text: binding(\.remoteDns)).frame(width: 210) }
            }
            Text("端口与 DNS 修改后，重新连接即可生效。").font(.caption).foregroundStyle(.secondary)
            if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                if draft.dirty { Button("放弃编辑并重新加载") { if let settings = model.snapshot?.settings { draft.reload(settings) } } }
                Spacer()
                Button("保存设置") {
                    guard let p = Int(draft.port), (1...65535).contains(p), let minutes = Int(draft.interval), minutes >= 1 else { model.error = "端口必须是 1–65535，刷新间隔至少 1 分钟"; return }
                    let patch: [String: Any] = ["port": p, "localDns": draft.localDns, "remoteDns": draft.remoteDns, "autoRefreshMinutes": minutes]
                    model.perform(label: "正在保存设置") {
                        _ = try await model.client.request("api/settings", body: ["settings": patch])
                        draft.saved()
                    }
                }.buttonStyle(.borderedProminent).controlSize(.large).disabled(!draft.loaded || !draft.dirty)
            }
        }.textFieldStyle(.roundedBorder).groupBoxStyle(SoftGroupBoxStyle()).padding(26)
            .disabled(model.working || !model.ready || !draft.loaded)
            .onAppear { if let settings = model.snapshot?.settings { draft.receive(settings) } }
            .onChange(of: sourceVersion) { _ in if let settings = model.snapshot?.settings { draft.receive(settings) } }
    }
}
