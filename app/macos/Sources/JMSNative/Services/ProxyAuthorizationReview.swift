import Foundation
import CoreFoundation
import CryptoKit

/// Presentation-only review of one digest-bound plan. No provider acquisition,
/// process creation, raw plist retention, or authorization happens in this type.
struct ProxyAuthorizationReview: Equatable, Sendable {
    let action: String
    let loopbackPort: Int?
    let serviceNames: [String]
    var serviceCount: Int { serviceNames.count }
    let planDigest: String
    let launchId: String
    let operationId: String

    init(planData: Data, planDigest: String, launchId: String, operationId: String, action: String) throws {
        do {
            guard !planData.isEmpty, planData.count <= 8 * 1024 * 1024,
                  String(data: planData, encoding: .utf8) != nil,
                  planDigest.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                  SHA256.hash(data: planData).map({ String(format: "%02x", $0) }).joined() == planDigest,
                  Self.validID(launchId), Self.validID(operationId) else { throw Self.invalid() }
            try StrictAuthorizationJSON.validate(planData)
            guard let plan = try JSONSerialization.jsonObject(with: planData) as? [String: Any],
                  Self.integer(plan["version"]) == 1,
                  plan["launchId"] as? String == launchId,
                  plan["operationId"] as? String == operationId else { throw Self.invalid() }
            let identities: [ServiceIdentity]
            let port: Int?
            switch action {
            case "connect":
                guard Self.keys(plan, ["version", "launchId", "operationId", "action", "target", "expected"]),
                      plan["action"] as? String == "apply",
                      let target = plan["target"] as? [String: Any],
                      Self.keys(target, ["host", "port", "bypass"]), target["host"] as? String == "127.0.0.1",
                      let targetPort = Self.integer(target["port"]), (1...65535).contains(targetPort),
                      let bypass = target["bypass"] as? [String], bypass.count <= 256,
                      bypass.allSatisfy({ Self.safeText($0, maximum: 1024) }) else { throw Self.invalid() }
                identities = try Self.snapshot(plan["expected"])
                port = targetPort
            case "disconnect":
                guard Self.keys(plan, ["version", "launchId", "operationId", "action", "original", "proxyTarget"]),
                      plan["action"] as? String == "restore" else { throw Self.invalid() }
                identities = try Self.snapshot(plan["original"])
                guard identities == (try Self.snapshot(plan["proxyTarget"])) else { throw Self.invalid() }
                // Restored endpoints are opaque and are deliberately not displayed.
                port = nil
            default: throw Self.invalid()
            }
            self.action = action
            self.loopbackPort = port
            self.serviceNames = identities.map(\.name)
            self.planDigest = planDigest
            self.launchId = launchId
            self.operationId = operationId
        } catch {
            // Never interpolate parser errors, plan bytes, proxy blobs or URLs.
            throw Self.invalid()
        }
    }

    private struct ServiceIdentity: Equatable {
        let id: String
        let name: String
        let device: String
    }
    private static func snapshot(_ value: Any?) throws -> [ServiceIdentity] {
        guard let snapshot = value as? [String: Any], keys(snapshot, ["schema", "services"]),
              integer(snapshot["schema"]) == 3,
              let services = snapshot["services"] as? [[String: Any]], !services.isEmpty, services.count <= 512 else { throw invalid() }
        var identities: [ServiceIdentity] = []
        var seen = Set<String>()
        for service in services {
            guard keys(service, ["id", "name", "device", "proxies"]),
                  let id = service["id"] as? String, validID(id), seen.insert(id.lowercased()).inserted,
                  let name = service["name"] as? String, safeText(name, maximum: 256),
                  let device = service["device"] as? String,
                  device.range(of: "^[A-Za-z0-9._-]{1,128}$", options: .regularExpression) != nil,
                  let proxies = service["proxies"] as? [String: Any], keys(proxies, ["present", "blob"]),
                  let present = boolean(proxies["present"]) else { throw invalid() }
            if present {
                guard let blob = proxies["blob"] as? String, !blob.isEmpty, blob.utf8.count <= 1_048_576,
                      let bytes = Data(base64Encoded: blob), !bytes.isEmpty,
                      bytes.base64EncodedString() == blob else { throw invalid() }
                // Opaque data is validated by the authorized helper, never decoded for UI.
            } else {
                guard proxies["blob"] is NSNull else { throw invalid() }
            }
            identities.append(ServiceIdentity(id: id.lowercased(), name: name, device: device))
        }
        return identities.sorted { $0.id < $1.id }
    }
    private static func safeText(_ value: String, maximum: Int) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf8.count <= maximum &&
        value.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
    }
    private static func keys(_ value: [String: Any], _ expected: Set<String>) -> Bool { Set(value.keys) == expected }
    private static func validID(_ value: String) -> Bool {
        value.range(of: "^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", options: .regularExpression) != nil
    }
    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= 0, number.doubleValue < Double(Int.max) else { return nil }
        return number.intValue
    }
    private static func invalid() -> APIError {
        APIError(message: "代理授权摘要未获验证，已拒绝请求授权。", code: "AUTHORIZATION_REVIEW_INVALID")
    }
}
