import Foundation
import CoreFoundation

/// Deterministic bplist00 encoder for the deliberately narrow supported proxy
/// dictionary types. Fixed 8-byte references/offsets and sorted dictionary keys
/// keep journal blobs stable across Foundation dictionary enumeration orders.
enum StablePlist {
    static func bytes(_ value: UInt64) -> [UInt8] {
        (0..<8).reversed().map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) }
    }
    static func header(_ type: UInt8, _ count: Int) -> [UInt8] {
        count < 15 ? [type | UInt8(count)] : [type | 15, 0x13] + bytes(UInt64(count))
    }
    static func encode(_ dictionary: [String: Any]) throws -> Data {
        var objects: [[UInt8]] = []
        func append(_ object: [UInt8]) -> UInt64 { objects.append(object); return UInt64(objects.count - 1) }
        func add(_ value: Any) throws -> UInt64 {
            if let n = value as? NSNumber {
                if CFGetTypeID(n) == CFBooleanGetTypeID() { return append([n.boolValue ? 0x09 : 0x08]) }
                let type = String(cString: n.objCType)
                if type == "f" || type == "d" { return append([0x23] + bytes(n.doubleValue.bitPattern)) }
                return append([0x13] + bytes(UInt64(bitPattern: n.int64Value)))
            }
            if let string = value as? String {
                let units = Array(string.utf16)
                let body = units.flatMap { [UInt8(truncatingIfNeeded: $0 >> 8), UInt8(truncatingIfNeeded: $0)] }
                return append(header(0x60, units.count) + body)
            }
            if let array = value as? [Any] {
                let ids = try array.map(add)
                return append(header(0xA0, ids.count) + ids.flatMap(bytes))
            }
            if let dict = value as? [String: Any] {
                let keys = dict.keys.sorted()
                let keyIDs = try keys.map { try add($0) }
                let valueIDs = try keys.map { try add(dict[$0]!) }
                return append(header(0xD0, keys.count) + (keyIDs + valueIDs).flatMap(bytes))
            }
            throw Failure(.unsupported, .no)
        }
        let top = try add(dictionary)
        var result = Array("bplist00".utf8), offsets: [UInt64] = []
        for object in objects { offsets.append(UInt64(result.count)); result += object }
        let offsetTable = UInt64(result.count)
        result += offsets.flatMap(bytes)
        result += [0, 0, 0, 0, 0, 0, 8, 8] + bytes(UInt64(objects.count)) + bytes(top) + bytes(offsetTable)
        return Data(result)
    }
}
