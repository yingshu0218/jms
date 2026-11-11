import Foundation

/// One drain owns the complete frame until its final byte is written. Caller task
/// cancellation cannot abandon a partially written frame or interleave a cancel frame.
@MainActor final class NativeProxyFrameWriter {
    static let maximumBytes = 16 * 1024 * 1024
    static let maximumFrames = 32
    private final class Entry {
        let data: Data
        private var continuation: CheckedContinuation<Void, Error>?
        init(_ data: Data, _ continuation: CheckedContinuation<Void, Error>) {
            self.data = data; self.continuation = continuation
        }
        func finish(_ error: Error?) {
            let pending = continuation; continuation = nil
            if let error { pending?.resume(throwing: error) } else { pending?.resume() }
        }
    }
    private let write: (Data, Int) throws -> Int // zero means would-block/retry
    private let sleep: () async throws -> Void
    private let now: () -> Double
    private let timeout: Double
    private var queue: [Entry] = []
    private var pendingBytes = 0
    var queuedFrameCount: Int { queue.count }
    var queuedByteCount: Int { pendingBytes }
    private var draining: Task<Void, Never>?
    private var closed = false
    var onFailure: (() -> Void)?
    init(timeout: Double = 2,
         now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime },
         sleep: @escaping () async throws -> Void = { try await Task.sleep(nanoseconds: 10_000_000) },
         write: @escaping (Data, Int) throws -> Int) {
        self.timeout = timeout; self.now = now; self.sleep = sleep; self.write = write
    }
    func send(_ data: Data) async throws {
        guard !closed else { throw NativeProxyCodec.error("NATIVE_CONTROL_CLOSED") }
        guard !data.isEmpty, data.count <= Self.maximumBytes,
              queue.count < Self.maximumFrames, pendingBytes <= Self.maximumBytes - data.count else {
            throw NativeProxyCodec.error("NATIVE_CONTROL_BUSY")
        }
        try await withCheckedThrowingContinuation { continuation in
            queue.append(Entry(data, continuation)); pendingBytes += data.count
            if draining == nil { draining = Task { [weak self] in await self?.drain() } }
        }
    }
    private func drain() async {
        defer { draining = nil }
        while !closed, let entry = queue.first {
            let deadline = now() + timeout
            var offset = 0
            do {
                while offset < entry.data.count {
                    guard !closed else { return }
                    guard now().isFinite, now() < deadline else { throw NativeProxyCodec.error("NATIVE_CONTROL_TIMEOUT") }
                    let count = try write(entry.data, offset)
                    guard count >= 0, count <= entry.data.count - offset else { throw NativeProxyCodec.error("NATIVE_CONTROL_INVALID") }
                    offset += count
                    if offset < entry.data.count { try await sleep() }
                }
                guard !closed else { return }
                queue.removeFirst(); pendingBytes -= entry.data.count
                entry.finish(nil)
            } catch {
                close(error: error)
                onFailure?()
                return
            }
        }
    }
    func close(error: Error = NativeProxyCodec.error("NATIVE_CONTROL_CLOSED")) {
        guard !closed else { return }; closed = true
        draining?.cancel()
        let entries = queue; queue.removeAll(); pendingBytes = 0
        let code = (error as? APIError)?.code == "NATIVE_CONTROL_TIMEOUT" ? "NATIVE_CONTROL_TIMEOUT" : "NATIVE_CONTROL_CLOSED"
        let safeError = NativeProxyCodec.error(code)
        for entry in entries { entry.finish(safeError) }
    }
}
