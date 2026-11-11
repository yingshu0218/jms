import Foundation
import Darwin

/// Anonymous pipes to one owned child, never a named socket or HTTP endpoint.
@MainActor final class NativeProxyPipe {
    let childInput = Pipe()
    let childOutput = Pipe()
    private var codec = NativeProxyCodec()
    private var reader: Task<Void, Never>?
    private var closed = false
    private var writer: NativeProxyFrameWriter!
    private var onEnded: (() async -> Void)?
    init() throws {
        for descriptor in [childInput.fileHandleForWriting.fileDescriptor, childOutput.fileHandleForReading.fileDescriptor] {
            let flags = fcntl(descriptor, F_GETFL)
            guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) >= 0 else { throw NativeProxyCodec.error() }
        }
        guard fcntl(childInput.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) >= 0 else { throw NativeProxyCodec.error() }
        let descriptor = childInput.fileHandleForWriting.fileDescriptor
        writer = NativeProxyFrameWriter { data, offset in
            let count = data.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress!.advanced(by: offset), data.count - offset) }
            if count >= 0 { return count }
            if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { return 0 }
            throw NativeProxyCodec.error("NATIVE_CONTROL_CLOSED")
        }
        writer.onFailure = { [weak self] in self?.close() }
    }
    func start(receive: @escaping ([String: Any]) async -> Void, ended: @escaping () async -> Void) {
        onEnded = ended
        // Parent does not hold the child's ends open after Process.run.
        try? childInput.fileHandleForReading.close()
        try? childOutput.fileHandleForWriting.close()
        reader = Task { [weak self] in
            guard let self else { return }
            var bytes = [UInt8](repeating: 0, count: 16384)
            while !Task.isCancelled && !self.closed {
                let count = bytes.withUnsafeMutableBytes { Darwin.read(self.childOutput.fileHandleForReading.fileDescriptor, $0.baseAddress, $0.count) }
                if count > 0 {
                    do {
                        for frame in try self.codec.append(Data(bytes.prefix(count))) { await receive(frame) }
                    } catch { self.close(); return }
                } else if count == 0 {
                    self.close(); return
                } else if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR {
                    self.close(); return
                }
                do { try await Task.sleep(nanoseconds: 10_000_000) } catch { return }
            }
        }
    }
    func send(_ frame: [String: Any]) async throws {
        guard !closed else { throw NativeProxyCodec.error("NATIVE_CONTROL_CLOSED") }
        try await writer.send(NativeProxyCodec.encode(frame))
    }
    func close() {
        guard !closed else { return }; closed = true
        reader?.cancel(); reader = nil
        writer.close()
        let ended = onEnded; onEnded = nil
        if let ended { Task { await ended() } }
        try? childInput.fileHandleForWriting.close()
        try? childOutput.fileHandleForReading.close()
    }
}
