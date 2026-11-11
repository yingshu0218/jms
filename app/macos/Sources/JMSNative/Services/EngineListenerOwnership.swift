import Foundation

/// Read-only proof that the exact loopback listener belongs exclusively to our child.
enum EngineListenerOwnership {
    static func matches(_ output: String, pid: Int32, port: Int) -> Bool {
        var owner: String?
        var found = false
        for line in output.split(separator: "\n") {
            if line.hasPrefix("p") { owner = String(line.dropFirst()) }
            if line.hasPrefix("n") {
                guard owner == String(pid), String(line.dropFirst()) == "127.0.0.1:\(port)" else { return false }
                found = true
            }
        }
        return found
    }
    static func check(pid: Int32, port: Int) async throws -> Bool {
        try await ListenerProbe(pid: pid, port: port).run()
    }
}

private final class ListenerProbe: @unchecked Sendable {
    private let process = Process()
    private let output = Pipe()
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Error>?
    private let pid: Int32
    private let port: Int
    init(pid: Int32, port: Int) { self.pid = pid; self.port = port }
    func run() async throws -> Bool {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock(); self.continuation = continuation; lock.unlock()
            process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
            process.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpn"]
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { [weak self] process in
                guard let self else { return }
                let data = self.output.fileHandleForReading.readDataToEndOfFile()
                if process.terminationStatus == 0 {
                    self.finish(.success(EngineListenerOwnership.matches(String(decoding: data, as: UTF8.self), pid: self.pid, port: self.port)))
                } else if process.terminationStatus == 1 { self.finish(.success(false)) }
                else { self.finish(.failure(APIError(message: "无法核对引擎监听端口归属，已拒绝发送凭据", code: "LISTENER_UNCONFIRMED"))) }
            }
            // Only this owned, read-only lsof helper may be terminated on timeout.
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [self] in
                if finish(.failure(APIError(message: "监听端口归属检查超时，已拒绝发送凭据", code: "LISTENER_UNCONFIRMED"))) && process.isRunning { process.terminate() }
            }
            do { try process.run() }
            catch { finish(.failure(APIError(message: "无法运行系统 lsof 核对端口归属，已拒绝发送凭据", code: "LISTENER_UNCONFIRMED"))) }
        }
    }
    @discardableResult private func finish(_ result: Result<Bool, Error>) -> Bool {
        lock.lock(); let pending = continuation; continuation = nil; lock.unlock()
        guard let pending else { return false }
        pending.resume(with: result)
        return true
    }
}
