import Foundation

/// Structural preflight before Foundation decoding, which otherwise accepts
/// duplicate keys. Escaped key spellings are decoded before duplicate comparison.
struct StrictAuthorizationJSON {
    private let bytes: [UInt8]
    private var cursor = 0
    static func validate(_ data: Data) throws {
        guard !data.isEmpty, data.count <= 8 * 1024 * 1024 else { throw invalid() }
        var parser = Self(bytes: Array(data))
        try parser.value(depth: 1)
        parser.space()
        guard parser.cursor == parser.bytes.count else { throw invalid() }
    }
    private mutating func space() { while cursor < bytes.count && [9, 10, 13, 32].contains(bytes[cursor]) { cursor += 1 } }
    private mutating func take(_ byte: UInt8) -> Bool {
        space(); guard cursor < bytes.count, bytes[cursor] == byte else { return false }; cursor += 1; return true
    }
    private mutating func value(depth: Int) throws {
        guard depth <= 64 else { throw Self.invalid() }
        space(); guard cursor < bytes.count else { throw Self.invalid() }
        switch bytes[cursor] {
        case 123:
            cursor += 1; var keys = Set<String>()
            if take(125) { return }
            while true {
                let key = try string()
                guard keys.insert(key).inserted, take(58) else { throw Self.invalid() }
                try value(depth: depth + 1)
                if take(125) { return }
                guard take(44) else { throw Self.invalid() }
            }
        case 91:
            cursor += 1
            if take(93) { return }
            while true {
                try value(depth: depth + 1)
                if take(93) { return }
                guard take(44) else { throw Self.invalid() }
            }
        case 34: _ = try string()
        default:
            let begin = cursor
            while cursor < bytes.count && ![9, 10, 13, 32, 44, 93, 125].contains(bytes[cursor]) { cursor += 1 }
            guard cursor > begin else { throw Self.invalid() }
            // Full scalar grammar is checked by JSONSerialization immediately
            // after this scan; scalars cannot introduce structural nesting.
        }
    }
    private mutating func string() throws -> String {
        space(); guard cursor < bytes.count, bytes[cursor] == 34 else { throw Self.invalid() }
        let begin = cursor; cursor += 1
        while cursor < bytes.count {
            let byte = bytes[cursor]; cursor += 1
            if byte == 92 {
                guard cursor < bytes.count else { throw Self.invalid() }
                cursor += 1
            } else if byte == 34 {
                let token = Data(bytes[begin..<cursor])
                guard let decoded = try? JSONSerialization.jsonObject(with: token, options: [.fragmentsAllowed]),
                      let string = decoded as? String else { throw Self.invalid() }
                return string
            } else if byte < 32 { throw Self.invalid() }
        }
        throw Self.invalid()
    }
    private static func invalid() -> APIError { APIError(message: "授权计划格式无效，未请求系统权限。", code: "AUTHORIZATION_REQUIRED") }
}
