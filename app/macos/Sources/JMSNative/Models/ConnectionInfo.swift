import Foundation

struct ConnectionsSnapshot: Decodable {
    var running: Bool
    var connections: [ConnectionInfo]
    var uploadTotal: Int64
    var downloadTotal: Int64
}

struct ConnectionInfo: Decodable, Identifiable {
    var id: String
    var metadata: Metadata
    var upload: Int64?
    var download: Int64?
    var start: String?
    var chains: [String]?
    var rule: String?
    var rulePayload: String?
    struct Metadata: Decodable {
        var network: String?
        var host: String?
        var sourceIP: String?
        var destinationIP: String?
        var process: String?
        var processPath: String?
    }
    var destination: String { [metadata.host, metadata.destinationIP].compactMap { $0 }.first { !$0.isEmpty } ?? "未知目标" }
    var application: String {
        if let process = metadata.process, !process.isEmpty { return process }
        if let path = metadata.processPath, !path.isEmpty { return URL(fileURLWithPath: path).lastPathComponent }
        return "未知应用"
    }
    var route: String { chains?.joined(separator: " → ") ?? "—" }
    func matches(_ query: String) -> Bool {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty || [destination, metadata.destinationIP ?? "", metadata.sourceIP ?? "", application, route, rule ?? "", rulePayload ?? ""].joined(separator: " ").localizedCaseInsensitiveContains(query)
    }
    static func bytes(_ value: Int64?) -> String {
        let bytes = max(0, value ?? 0)
        return bytes == 0 ? "0 B" : ByteCountFormatter.string(fromByteCount: bytes, countStyle: .binary)
    }
}
