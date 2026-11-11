import Foundation

struct EffectiveState: Codable {
    var selected: Int?
    var routingMode: String?
    var node: String?
    var selectionTag: String?
    var known: Bool?
    var selectionKnown: Bool?
    var modeKnown: Bool?
}
extension EngineStatus {
    var confirmedSelection: Int? { running && effective?.selectionKnown == true ? effective?.selected : nil }
    var confirmedMode: String? { running && effective?.modeKnown == true ? effective?.routingMode : nil }
}
struct HotSwitchResult: Decodable {
    let applied: Bool
    let persisted: Bool
    let effective: EffectiveState?
    let reason: String?
    let code: String?
    var summary: String {
        if applied && !persisted { return "已生效，但未保存；下次连接仍使用原设置" }
        if !applied && persisted { return reason ?? "已保存，将在下次连接生效" }
        if !applied { return reason ?? "未确认生效，请重试" }
        return "已确认生效并保存"
    }
}
struct SnapshotGate {
    struct Ticket { let revision: UInt64; let sequence: UInt64; let lease: String }
    private var revision: UInt64 = 0
    private var sequence: UInt64 = 0
    mutating func invalidate() { revision &+= 1 }
    mutating func issue(lease: String) -> Ticket {
        sequence &+= 1
        return Ticket(revision: revision, sequence: sequence, lease: lease)
    }
    func accepts(_ ticket: Ticket, lease: String) -> Bool {
        ticket.revision == revision && ticket.sequence == sequence && ticket.lease == lease
    }
}

enum BoundedRulesReader {
    static func read(_ url: URL) throws -> String {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        // One extra byte detects oversize including files that grow after selection.
        let limit = 128 * 1024
        var data = Data()
        while data.count <= limit {
            let chunk = try handle.read(upToCount: min(8192, limit + 1 - data.count)) ?? Data()
            if chunk.isEmpty { break }
            data.append(chunk)
        }
        guard data.count <= limit, let text = String(data: data, encoding: .utf8) else {
            throw APIError(message: "请选择 128 KB 以内的 UTF-8 JSON 文件")
        }
        return text
    }
}

struct SettingsDraft {
    private(set) var loaded = false
    private(set) var dirty = false
    var port = ""
    var localDns = ""
    var remoteDns = ""
    var interval = ""
    mutating func edit(_ key: WritableKeyPath<SettingsDraft, String>, _ value: String) {
        self[keyPath: key] = value; dirty = true
    }
    mutating func receive(_ settings: EngineSettings) {
        guard !dirty else { return }
        port = String(settings.port); localDns = settings.localDns; remoteDns = settings.remoteDns
        interval = String(settings.autoRefreshMinutes); loaded = true
    }
    mutating func saved() { dirty = false }
    mutating func reload(_ settings: EngineSettings) { dirty = false; receive(settings) }
}
