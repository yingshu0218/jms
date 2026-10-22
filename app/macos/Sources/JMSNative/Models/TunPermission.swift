import Foundation

struct TunPermission: Decodable {
    let ok: Bool
    let needed: Bool?
    let elevated: Bool?
    let hint: String?
    let why: String?
    let error: String?
    let elevation: Command?
    let relaunch: Command?
    struct Command: Decodable {
        let command: String
        let note: String?
    }
    var command: String? { relaunch?.command ?? elevation?.command }
    var title: String { ok ? "引擎已具备 TUN 权限" : "引擎尚未具备 TUN 权限" }
}
