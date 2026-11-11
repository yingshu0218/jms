import SwiftUI

struct ConnectionsView: View {
    @EnvironmentObject var model: AppModel
    @State private var data: ConnectionsSnapshot?
    @State private var failure: String?
    @State private var query = ""
    @State private var selected: String?
    @State private var closing = false
    @State private var confirmCloseAll = false
    private var rows: [ConnectionInfo] { (data?.connections ?? []).filter { $0.matches(query) } }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("当前连接").font(.title2.bold())
                Text("\(data?.connections.count ?? 0) 条").foregroundStyle(.secondary)
                Spacer()
                Button("刷新") { Task { await refresh() } }.disabled(!model.ready)
                Button("关闭全部", role: .destructive) { confirmCloseAll = true }
                    .disabled(!model.canSwitch || closing || data?.connections.isEmpty != false)
            }
            HStack {
                Text("累计上传 \(ConnectionInfo.bytes(data?.uploadTotal))")
                Text("累计下载 \(ConnectionInfo.bytes(data?.downloadTotal))")
                Spacer()
                Text("每 3 秒刷新").foregroundStyle(.secondary)
            }.font(.caption)
            TextField("搜索目标、应用、IP 或路由", text: $query).textFieldStyle(.roundedBorder)
            if let failure {
                Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                Text("上次数据可能已过期，请刷新重试。").font(.caption).foregroundStyle(.secondary)
            }
            if data?.running == false {
                Spacer(); Text("代理内核尚未运行，连接后可在此查看实时连接。").foregroundStyle(.secondary); Spacer()
            } else {
                Table(rows, selection: $selected) {
                    TableColumn("目标") { row in Text(row.destination).help(row.destination) }
                    TableColumn("应用") { row in Text(row.application) }
                    TableColumn("路由") { row in Text(row.route).help(row.route) }
                    TableColumn("下载") { row in Text(ConnectionInfo.bytes(row.download)) }.width(75)
                    TableColumn("上传") { row in Text(ConnectionInfo.bytes(row.upload)) }.width(75)
                }
                .softListSurface()
                .overlay {
                    if rows.isEmpty { Text(data == nil ? "正在读取连接…" : (query.isEmpty ? "当前没有活动连接" : "没有匹配的连接")).foregroundStyle(.secondary) }
                }
                if let row = data?.connections.first(where: { $0.id == selected }) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(row.metadata.network?.uppercased() ?? "—") · \(row.metadata.sourceIP ?? "—") → \(row.destination)")
                        Text("匹配规则：\(row.rule ?? "—") \(row.rulePayload ?? "")")
                        if let start = row.start { Text("开始时间：\(start)") }
                        if let path = row.metadata.processPath, !path.isEmpty { Text(path).textSelection(.enabled) }
                    }.font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                HStack {
                    Text("仅显示活动连接；累计流量由内核提供，重启后重置。").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("关闭所选连接", role: .destructive) { Task { await close(all: false) } }
                        .disabled(!model.canSwitch || closing || selected == nil || !rows.contains(where: { $0.id == selected }))
                }
            }
        }
        .task {
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            }
        }
        .confirmationDialog("关闭全部活动连接？应用可能会自动重新建立连接。", isPresented: $confirmCloseAll) {
            Button("关闭全部", role: .destructive) { Task { await close(all: true) } }
            Button("取消", role: .cancel) {}
        }
    }
    @MainActor private func refresh() async {
        guard model.ready else { return }
        do {
            var client = model.client; client.timeout = 8
            let result = try await client.request("api/connections")
            guard !Task.isCancelled else { return }
            let snapshot = try JSONDecoder().decode(ConnectionsSnapshot.self, from: result)
            data = snapshot
            failure = nil
            if !snapshot.connections.contains(where: { $0.id == selected }) { selected = nil }
        } catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }
    @MainActor private func close(all: Bool) async {
        guard model.canSwitch, !closing else { return }; closing = true
        defer { closing = false }
        do {
            let body: [String: Any] = all ? ["all": true] : ["id": selected ?? ""]
            _ = try await model.client.request("api/connections/close", body: body)
            await refresh()
        } catch { failure = error.localizedDescription }
    }
}
