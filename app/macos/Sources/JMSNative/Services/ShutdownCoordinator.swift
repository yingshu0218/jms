import Foundation

struct ShutdownCoordinator {
    static func run(status: () async throws -> EngineStatus,
                    disconnect: () async throws -> Void,
                    stop: () async throws -> Void) async throws {
        let before = try await status()
        if before.connected || before.running || before.pendingProxyJournal { try await disconnect() }
        let after = try await status()
        guard !after.connected, !after.running, !after.pendingProxyJournal else {
            throw APIError(message: "网络尚未恢复，请重试退出")
        }
        try await stop()
    }
}
