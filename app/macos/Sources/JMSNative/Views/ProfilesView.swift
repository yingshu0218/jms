import SwiftUI
import AppKit

struct ProfilesView: View {
    @EnvironmentObject var model: AppModel
    @State private var editingID: String?
    @State private var name = ""
    @State private var url = ""
    @State private var message = ""
    @FocusState private var nameFocused: Bool
    @State private var deleting: SubscriptionProfile?
    private var profiles: [SubscriptionProfile] { model.snapshot?.profiles ?? [] }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("订阅管理").font(.title2.bold())
                Spacer()
                Button("更新全部") {
                    model.perform(label: "正在更新全部订阅", command: "POST /api/profiles/refresh-all · 每份订阅最多20秒") {
                        var batch = model.client; batch.timeout = max(90, Double(profiles.count) * 25)
                        let data = try await batch.request("api/profiles/refresh-all", body: [:])
                        let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
                        message = "已更新 \(result["updated"] ?? 0) 个订阅，\(result["failed"] ?? 0) 个未完成。连接中的当前订阅会缓存更新，断开后应用。"
                    }
                }.buttonStyle(.bordered).disabled(profiles.isEmpty)
                Button("新建订阅") { editingID = nil; name = ""; url = ""; message = "在下方填写名称和链接后保存。"; nameFocused = true }.buttonStyle(.borderedProminent)
            }
            Text("连接中也可检查订阅更新；当前订阅的新节点会缓存，断开后自动应用，不中断现有连接。切换订阅或修改链接仍需先断开。").font(.caption).foregroundStyle(.secondary)
            List {
                ForEach(profiles) { profile in
                    VStack(alignment: .leading, spacing: 7) {
                        HStack {
                            Text(profile.name).font(.headline)
                            if model.snapshot?.activeProfileId == profile.id { Text("当前使用").font(.caption).foregroundStyle(.blue) }
                            Spacer()
                            Text("\(profile.nodeCount) 个节点").foregroundStyle(.secondary)
                        }
                        Text(profile.url).font(.caption).foregroundStyle(.secondary)
                        Text("最近更新：\(updated(profile.updatedAt))").font(.caption).foregroundStyle(.secondary)
                        if profile.pendingUpdate == true { Text("更新已缓存，断开后应用新节点").font(.caption).foregroundStyle(.secondary) }
                        if let error = profile.lastError { Text(error).font(.caption).foregroundStyle(.red) }
                        HStack {
                            Button("使用此订阅") { model.post("api/profiles/activate", ["id": profile.id]) }
                                .buttonStyle(.borderedProminent).disabled(model.snapshot?.activeProfileId == profile.id || model.snapshot?.status.connected == true)
                            Button("更新") {
                                model.perform(label: "正在检查订阅更新", command: "POST /api/profiles/refresh · 20秒下载超时") {
                                    let data = try await model.client.request("api/profiles/refresh", body: ["id": profile.id, "force": true])
                                    let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
                                    message = result["pendingUpdate"] as? Bool == true ? "订阅更新已缓存，当前连接保持不变，断开后自动应用。" : "订阅已更新。"
                                }
                            }.buttonStyle(.bordered)
                            Button("编辑") { editingID = profile.id; name = profile.name; url = ""; message = "链接留空则保留原链接。" }.buttonStyle(.bordered)
                            Button("删除", role: .destructive) { deleting = profile }.buttonStyle(.bordered)
                        }
                    }.padding(10).buttonStyle(.borderless)
                }
            }.listStyle(.plain).softListSurface().overlay { if profiles.isEmpty { VStack(spacing: 10) { Image(systemName: "link").font(.system(size: 28, weight: .light)); Text("还没有订阅").font(.headline); Text("在下方添加链接，即可导入节点。").font(.callout) }.foregroundStyle(.secondary) } }
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    Text(editingID == nil ? "添加订阅" : "编辑订阅").font(.headline)
                    TextField("订阅名称（如：主订阅）", text: $name).textFieldStyle(.roundedBorder).focused($nameFocused)
                    SecureField(editingID == nil ? "https:// 开头的订阅链接" : "新订阅链接（留空保留原链接）", text: $url).textFieldStyle(.roundedBorder)
                    HStack {
                        Button(editingID == nil ? "保存并导入" : "保存修改") { save() }.buttonStyle(.borderedProminent)
                            .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (editingID == nil && url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                        Button("粘贴链接") {
                            if let pasted = NSPasteboard.general.string(forType: .string) { url = pasted.trimmingCharacters(in: .whitespacesAndNewlines) }
                        }.buttonStyle(.bordered)
                        if editingID != nil { Button("取消编辑") { editingID = nil; name = ""; url = "" } }
                        Text(message).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }
        }.disabled(!model.canSwitch)
        .confirmationDialog("删除订阅“\(deleting?.name ?? "")”？个人分流规则会保留。", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("删除订阅", role: .destructive) {
                guard let id = deleting?.id else { return }; deleting = nil
                model.post("api/profiles/delete", ["id": id])
                if editingID == id { editingID = nil; name = ""; url = "" }
            }
            Button("取消", role: .cancel) { deleting = nil }
        }
    }
    private func save() {
        let becomesActive = model.snapshot?.activeProfileId == nil || editingID == model.snapshot?.activeProfileId
        let id = editingID; let title = name.trimmingCharacters(in: .whitespacesAndNewlines); let link = url.trimmingCharacters(in: .whitespacesAndNewlines)
        model.perform {
            var body: [String: Any] = ["name": title]
            if let id { body["id"] = id }
            if !link.isEmpty { body["url"] = link }
            _ = try await model.client.request("api/profiles", body: body)
            editingID = nil; name = ""; url = ""; message = becomesActive ? "已保存并启用，可到节点页选择节点。" : "已保存，点击“使用此订阅”切换。"
        }
    }
    private func updated(_ raw: String?) -> String {
        guard let raw else { return "尚未更新" }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: raw) else { return raw }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
