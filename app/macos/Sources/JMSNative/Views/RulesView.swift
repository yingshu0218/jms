import SwiftUI
import UniformTypeIdentifiers

struct JSONDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data = Data()
    init(data: Data = Data()) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
struct SiteRulesView: View {
    @EnvironmentObject var model: AppModel
    @State private var rule = Rule()
    @State private var importing = false
    @State private var exporting = false
    @State private var document = JSONDocument()
    @State private var replace = false
    @State private var pendingImport: String?
    @State private var confirmImport = false
    @State private var notice = ""
    private let types = [("domain", "精确域名"), ("domain_suffix", "域名后缀"), ("domain_keyword", "域名关键词"), ("domain_regex", "域名正则"), ("ip_cidr", "IP 网段"), ("process_name", "进程名"), ("process_path", "进程路径")]
    var rules: [Rule] { model.snapshot?.settings.customRules ?? [] }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("规则模式自动识别中国大陆 IP：大陆及内网直连，其余走代理。内置大陆 IP 数据，规则集自动缓存更新，无需手动填写网段。下面的个人规则优先，应用名单边界始终有效。").foregroundStyle(.secondary)
            HStack {
                Toggle("替换现有规则", isOn: $replace).toggleStyle(.checkbox)
                Button("导入 JSON") { importing = true }
                Button("导出 JSON") {
                    model.perform {
                        document = JSONDocument(data: try await model.client.request("api/rules")); exporting = true
                    }
                }
                Spacer()
            }
            Text("导入文件中的应用名单与反向开关也会恢复；修改后重新连接生效。").font(.caption).foregroundStyle(.secondary)
            List {
                ForEach(Array(rules.enumerated()), id: \.offset) { index, item in
                    HStack {
                        Toggle("启用", isOn: Binding(get: { item.enabled }, set: { enabled in var copy = rules; copy[index].enabled = enabled; model.saveRules(copy) })).labelsHidden()
                        Text(types.first { $0.0 == item.type }?.1 ?? item.type).frame(width: 80, alignment: .leading)
                        Text(item.value).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        Text(item.outbound == "direct" ? "直连" : "代理").foregroundStyle(.secondary)
                        Button { move(index, -1) } label: { Image(systemName: "arrow.up") }.disabled(index == 0).help("提高优先级")
                        Button { move(index, 1) } label: { Image(systemName: "arrow.down") }.disabled(index == rules.count - 1).help("降低优先级")
                        Button(role: .destructive) { var copy = rules; copy.remove(at: index); model.saveRules(copy) } label: { Image(systemName: "trash") }.help("删除规则")
                    }.buttonStyle(.borderless).accessibilityElement(children: .contain)
                }
            }.listStyle(.plain).softListSurface()
                .overlay { if rules.isEmpty { Text("还没有自定义站点规则").foregroundStyle(.secondary) } }
            HStack {
                Picker("匹配", selection: $rule.type) { ForEach(types, id: \.0) { Text($0.1).tag($0.0) } }.frame(width: 170)
                TextField("域名或匹配内容", text: $rule.value)
                Picker("出口", selection: $rule.outbound) { Text("代理").tag("proxy"); Text("直连").tag("direct") }.frame(width: 130)
                Button("添加") {
                    let candidate = rule
                    model.perform {
                        let data = try JSONEncoder().encode([candidate])
                        _ = try await model.client.request("api/rules/import", body: ["text": String(decoding: data, as: UTF8.self), "mode": "append"])
                        rule = Rule(); notice = "已保存，重新连接后生效"
                    }
                }.buttonStyle(.borderedProminent).disabled(rule.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Text(notice).font(.caption).foregroundStyle(.secondary)
        }.disabled(model.working || !model.ready)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            do {
                let url = try result.get(); let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                let data = try Data(contentsOf: url)
                guard data.count <= 128 * 1024, let text = String(data: data, encoding: .utf8) else { throw APIError(message: "请选择 128 KB 以内的 UTF-8 JSON 文件") }
                pendingImport = text
                if replace { confirmImport = true } else { importPending() }
            } catch { model.error = error.localizedDescription }
        }
        .confirmationDialog("替换全部规则并恢复文件中的应用设置？", isPresented: $confirmImport) {
            Button("替换", role: .destructive) { importPending() }
            Button("取消", role: .cancel) { pendingImport = nil }
        }
        .fileExporter(isPresented: $exporting, document: document, contentType: .json, defaultFilename: "jms-rules") { result in
            switch result { case .success: notice = "已导出"; case .failure(let error): model.error = error.localizedDescription }
        }
    }
    private func move(_ index: Int, _ delta: Int) { var copy = rules; copy.swapAt(index, index + delta); model.saveRules(copy) }
    private func importPending() {
        guard let text = pendingImport else { return }; pendingImport = nil
        let mode = replace ? "replace" : "append"
        model.perform {
            let data = try await model.client.request("api/rules/import", body: ["text": text, "mode": mode])
            let out = (try JSONSerialization.jsonObject(with: data)) as? [String: Any]
            notice = "已导入 \(out?["imported"] ?? 0) 条，跳过重复 \(out?["duplicates"] ?? 0) 条。重新连接后生效。"
        }
    }
}

struct RulesView: View {
    @State private var section = "sites"
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Picker("规则分类", selection: $section) {
                Text("站点规则").tag("sites")
                Text("应用名单").tag("apps")
            }.pickerStyle(.segmented).labelsHidden().frame(width: 240)
            if section == "sites" { SiteRulesView() }
            else { ApplicationRulesView() }
        }
    }
}
