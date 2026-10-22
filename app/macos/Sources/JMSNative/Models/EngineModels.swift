import Foundation

struct Rule: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var type: String = "domain_suffix"
    var value: String = ""
    var outbound: String = "proxy"
    var enabled: Bool = true
}
extension Rule {
    private enum CodingKeys: String, CodingKey { case id, type, value, outbound, enabled }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(String.self, forKey: .type)
        value = try c.decode(String.self, forKey: .value)
        outbound = try c.decodeIfPresent(String.self, forKey: .outbound) ?? "proxy"
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? "\(type):\(value):\(outbound)"
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }
}
struct EngineSettings: Codable {
    var selected: Int; var mode: String; var port: Int; var clashApi: String
    var autoRefreshMinutes: Int; var routingMode: String; var localDns: String
    var remoteDns: String; var customRules: [Rule]; var apps: [String]; var reverseApps: Bool
}
struct Node: Codable, Identifiable {
    var id: String { "\(name)|\(type)|\(server):\(server_port)" }
    let name: String; let type: String; let server: String; let server_port: Int
}
struct Subscription: Codable { let url: String; let hasUrl: Bool; let nodes: [Node]; let updatedAt: String? }
struct EngineStatus: Codable { let connected: Bool; let running: Bool; let pendingProxyJournal: Bool; let node: String?; let busy: String?; var pointingAtUs: Bool? = nil }
struct SubscriptionProfile: Codable, Identifiable {
    let id: String; let name: String; let url: String; let nodeCount: Int
    let updatedAt: String?; let lastError: String?
    var pendingUpdate: Bool? = nil
}
struct NodeLatency: Codable { let ok: Bool; let delay: Int?; let error: String? }
struct EngineSnapshot: Codable {
    var settings: EngineSettings; let subscription: Subscription; let status: EngineStatus
    let profiles: [SubscriptionProfile]?; let activeProfileId: String?; let nodeLatency: [String: NodeLatency]?
}
struct APIError: LocalizedError {
    let message: String
    var code: String? = nil
    var errorDescription: String? { message }
}
struct RulesDocument: Codable { let format: String; let version: Int; let rules: [Rule]; let apps: [String]?; let reverseApps: Bool? }
