import Foundation

/// Bounded private NDJSON. Parsing errors never contain frame bytes.
struct NativeProxyCodec {
    static let limit = 8 * 1024 * 1024
    private var pending = Data()
    mutating func append(_ bytes: Data) throws -> [[String: Any]] {
        var frames: [[String: Any]] = []
        for byte in bytes {
            if byte == 10 {
                guard !pending.isEmpty,
                      let object = try? JSONSerialization.jsonObject(with: pending),
                      let frame = object as? [String: Any] else { pending.removeAll(); throw Self.error() }
                pending.removeAll(keepingCapacity: true)
                frames.append(frame)
            } else {
                guard pending.count < Self.limit else { pending.removeAll(); throw Self.error() }
                pending.append(byte)
            }
        }
        return frames
    }
    mutating func finish() throws {
        defer { pending.removeAll() }
        guard pending.isEmpty else { throw Self.error() }
    }
    static func encode(_ frame: [String: Any]) throws -> Data {
        guard JSONSerialization.isValidJSONObject(frame),
              let data = try? JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys]),
              data.count <= limit else { throw error() }
        return data + Data([10])
    }
    static func error(_ code: String = "NATIVE_CONTROL_INVALID") -> APIError {
        let message: String
        switch code {
        case "AUTHORIZATION_REQUIRED", "SYS_PROXY_AUTHORIZATION_REQUIRED":
            message = "系统代理操作需要本机授权；当前授权入口尚未启用。"
        case "NATIVE_PROXY_UNKNOWN":
            message = "代理事务结果尚未确认，请先明确执行断开并恢复，不要重新连接。"
        default:
            message = "本地代理操作未获验证，请检查当前状态后重试。"
        }
        return APIError(message: message, code: code)
    }
}
