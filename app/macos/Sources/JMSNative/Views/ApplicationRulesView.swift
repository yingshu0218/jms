import SwiftUI

struct ApplicationRulesView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("应用分流").font(.title2.weight(.semibold))
            if let settings = model.snapshot?.settings {
                Text("选择需要分流的应用，站点规则决定它们的具体出口。").foregroundStyle(.secondary)
                GroupBox {
                    PreferenceRow(title: "反向应用名单", subtitle: settings.reverseApps ? "名单内直连，名单外按站点规则分流" : "名单内按站点规则分流，名单外直连") {
                        Toggle("反向应用名单", isOn: Binding(get: { settings.reverseApps }, set: { model.settings(["reverseApps": $0]) })).labelsHidden().toggleStyle(.switch)
                    }
                }
                GroupBox {
                    VStack(spacing: 10) {
                        ForEach(Array([("antigravity", "Google Antigravity"), ("vscode", "VS Code"), ("chrome", "Google Chrome")].enumerated()), id: \.offset) { index, app in
                            if index > 0 { Divider() }
                            PreferenceRow(title: app.1) {
                                Toggle(app.1, isOn: Binding(get: { settings.apps.contains(app.0) }, set: { enabled in
                                    var apps = settings.apps.filter { $0 != app.0 }; if enabled { apps.append(app.0) }; model.settings(["apps": apps])
                                })).labelsHidden().toggleStyle(.switch)
                            }
                        }
                    }
                }
                HStack {
                    if settings.mode != "tun-per-app" {
                        Button("切换到按应用 TUN") { model.settings(["mode": "tun-per-app"]) }.buttonStyle(.bordered)
                    } else {
                        Button("切回系统代理") { model.settings(["mode": "sysproxy"]) }.buttonStyle(.bordered)
                    }
                    Spacer()
                    Button("检查 TUN 权限") { model.showTunPermission = true }.buttonStyle(.bordered)
                }
                Text("当前接管：\(settings.mode == "tun-per-app" ? "按应用 TUN" : "系统代理")。设置自动保存；切换后重新连接生效。").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }.disabled(!model.canSwitch)
    }
}
