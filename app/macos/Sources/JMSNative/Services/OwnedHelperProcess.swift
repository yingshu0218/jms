import Foundation
import Darwin

/// Pure allowlist; launch never inherits loader hooks, Node options or API secrets.
enum OwnedHelperEnvironment {
    static func make(from source: [String: String]) -> [String: String] {
        let allowed: Set<String> = ["HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME", "LC_PAPER", "LC_NAME", "LC_ADDRESS", "LC_TELEPHONE", "LC_MEASUREMENT", "LC_IDENTIFICATION"]
        var result = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        for (key, value) in source {
            if allowed.contains(key), value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) { result[key] = value }
        }
        return result
    }
}

@MainActor enum OwnedHelperEvent { case frame([String: Any]), closed, invalid, exited }
@MainActor protocol OwnedHelperProcess: AnyObject {
    var isRunning: Bool { get }
    func start(events: @escaping (OwnedHelperEvent) -> Void) throws
    func send(_ frame: [String: Any]) async throws
    func abortOwnedBeforePermit()
}
@MainActor protocol OwnedHelperProcessFactory {
    func make() throws -> OwnedHelperProcess
}

/// Source-only platform transport factory. No call site in Broker/Runtime selects it.
/// ACTIVATION BLOCKER: metadata/path checks are not runtime signing identity.
/// Both Native->helper and helper->Native requester identity need a reviewed
/// same-team/designated-requirement or authenticated-peer boundary before use.
@MainActor struct FixedBundleOwnedHelperFactory: OwnedHelperProcessFactory {
    func make() throws -> OwnedHelperProcess {
        guard Bundle.main.bundleIdentifier == "app.jms.client.native",
              Bundle.main.infoDictionary?["JMSIsolatedMode"] as? Bool == false else {
            throw NativeProxyCodec.error("AUTHORIZATION_REQUIRED")
        }
        return try FixedBundleOwnedHelperProcess()
    }
}

@MainActor private final class FixedBundleOwnedHelperProcess: OwnedHelperProcess {
    private let process = Process()
    private let input = Pipe(), output = Pipe()
    private var writer: NativeProxyFrameWriter!
    private var reader: Task<Void, Never>?
    private var events: ((OwnedHelperEvent) -> Void)?
    private var started = false
    private var exitObservedAt: Double?
    var isRunning: Bool { process.isRunning }
    init() throws {
        guard let resources = Bundle.main.resourceURL else { throw NativeProxyCodec.error() }
        let executable = resources.appendingPathComponent("engine/JMSProxyPreferences").standardizedFileURL
        guard executable.resolvingSymlinksInPath() == executable,
              FileManager.default.isExecutableFile(atPath: executable.path) else { throw NativeProxyCodec.error() }
        process.executableURL = executable
        process.arguments = ["--interactive"]
        process.environment = OwnedHelperEnvironment.make(from: ProcessInfo.processInfo.environment)
        process.standardInput = input; process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        for fd in [input.fileHandleForWriting.fileDescriptor, output.fileHandleForReading.fileDescriptor] {
            let flags = fcntl(fd, F_GETFL)
            guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) >= 0 else { throw NativeProxyCodec.error() }
        }
        let fd = input.fileHandleForWriting.fileDescriptor
        guard fcntl(fd, F_SETNOSIGPIPE, 1) >= 0 else { throw NativeProxyCodec.error() }
        writer = NativeProxyFrameWriter { data, offset in
            let count = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: offset), data.count - offset) }
            if count >= 0 { return count }
            if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { return 0 }
            throw NativeProxyCodec.error("NATIVE_CONTROL_CLOSED")
        }
        // Closing stdin is permitted on transport failure; never signal a process
        // here. In particular a helper with commit permission must drain/exit itself.
        writer.onFailure = { [weak self] in
            try? self?.input.fileHandleForWriting.close()
            self?.events?(.invalid)
        }
    }
    func start(events: @escaping (OwnedHelperEvent) -> Void) throws {
        guard !started else { throw NativeProxyCodec.error() }; started = true
        self.events = events
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor in self?.exitObservedAt = ProcessInfo.processInfo.systemUptime }
        }
        do { try process.run() } catch { throw NativeProxyCodec.error("AUTHORIZATION_REQUIRED") }
        try? input.fileHandleForReading.close(); try? output.fileHandleForWriting.close()
        reader = Task { [weak self] in
            guard let self else { return }
            var codec = NativeProxyCodec(), buffer = [UInt8](repeating: 0, count: 16384)
            var discard = false, eof = false
            while !Task.isCancelled {
                if let exited = self.exitObservedAt, (eof || ProcessInfo.processInfo.systemUptime - exited >= 1) { self.didExit(); return }
                if !eof {
                    let count = buffer.withUnsafeMutableBytes { Darwin.read(self.output.fileHandleForReading.fileDescriptor, $0.baseAddress, $0.count) }
                    if count > 0 && !discard {
                        do { for frame in try codec.append(Data(buffer.prefix(count))) { self.events?(.frame(frame)) } }
                        catch { discard = true; self.events?(.invalid) }
                    } else if count == 0 { eof = true; self.events?(.closed) }
                    else if count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR { eof = true; self.events?(.invalid) }
                    // After invalid output, keep draining bounded chunks without
                    // retaining/decoding any raw data until confirmed child exit.
                }
                do { try await Task.sleep(nanoseconds: 5_000_000) } catch { return }
            }
        }
    }
    func send(_ frame: [String: Any]) async throws {
        guard started, process.isRunning else { throw NativeProxyCodec.error("NATIVE_CONTROL_CLOSED") }
        try await writer.send(NativeProxyCodec.encode(frame))
    }
    func abortOwnedBeforePermit() {
        writer.close(); try? input.fileHandleForWriting.close()
        if started && process.isRunning { process.terminate() }
    }
    private func didExit() {
        reader?.cancel(); reader = nil
        writer.close()
        try? input.fileHandleForWriting.close(); try? output.fileHandleForReading.close()
        events?(.exited)
        events = nil
    }
}
