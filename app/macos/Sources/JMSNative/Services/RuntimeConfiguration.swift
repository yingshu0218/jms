import Foundation

/// Build metadata, not the app's filename, determines its engine namespace.
struct RuntimeConfiguration: Equatable {
    let apiPort: Int
    let dataDirectoryName: String
    let isolated: Bool

    init(info: [String: Any] = Bundle.main.infoDictionary ?? [:]) {
        isolated = info["JMSIsolatedMode"] as? Bool ?? false
        apiPort = info["JMSAPIPort"] as? Int ?? (isolated ? 17788 : 7788)
        dataDirectoryName = info["JMSDataDirectoryName"] as? String ?? (isolated ? "JMS Client Candidate" : "JMS Client")
    }

    var baseURL: URL {
        // Validation occurs before any I/O; malformed build metadata must not trap during init.
        let safePort = (1...65535).contains(apiPort) ? apiPort : 1
        return URL(string: "http://127.0.0.1:\(safePort)")!
    }

    func validate() throws {
        guard (1...65535).contains(apiPort), !dataDirectoryName.isEmpty,
              dataDirectoryName != ".", dataDirectoryName != "..",
              !dataDirectoryName.contains("/"), !dataDirectoryName.contains("\\"),
              !dataDirectoryName.contains("\0") else {
            throw APIError(message: "应用引擎配置无效，请重新构建")
        }
        guard !isolated || (apiPort != 7788 && Self.pathKey(dataDirectoryName) != Self.pathKey("JMS Client")) else {
            throw APIError(message: "Candidate 必须使用独立端口和数据目录")
        }
    }
    private static func pathKey(_ value: String) -> String {
        value.precomposedStringWithCanonicalMapping.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
    }
    func stateDirectory(applicationSupport: URL) throws -> URL {
        try validate()
        let base = applicationSupport.resolvingSymlinksInPath().standardizedFileURL
        let target = base.appendingPathComponent(dataDirectoryName).standardizedFileURL
        if isolated {
            let resolved = target.resolvingSymlinksInPath().standardizedFileURL
            let formal = base.appendingPathComponent("JMS Client").resolvingSymlinksInPath().standardizedFileURL
            let attributes = try? FileManager.default.attributesOfItem(atPath: target.path)
            let kind = attributes?[.type] as? FileAttributeType
            guard kind != .typeSymbolicLink,
                  Self.pathKey(resolved.path) == Self.pathKey(target.path),
                  Self.pathKey(resolved.path) != Self.pathKey(formal.path) else {
                throw APIError(message: "Candidate 数据目录不能指向正式目录或符号链接")
            }
        }
        return target
    }

}
