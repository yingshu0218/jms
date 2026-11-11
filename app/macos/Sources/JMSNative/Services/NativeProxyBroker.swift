import Foundation
import CoreFoundation

@MainActor protocol NativeProxyHelperDriver: AnyObject {
    var isActive: Bool { get }
    func request(_ request: [String: Any]) async throws -> [String: Any]
    func cancelBeforeCommit() async
    func complete() async
}

/// Deliberately no AuthorizationServices or Process launcher in this first phase.
@MainActor final class UnavailableNativeProxyHelper: NativeProxyHelperDriver {
    var isActive: Bool { false }
    func request(_ request: [String: Any]) async throws -> [String: Any] {
        throw NativeProxyCodec.error("AUTHORIZATION_REQUIRED")
    }
    func cancelBeforeCommit() async { }
    func complete() async { }
}

@MainActor final class NativeProxyBroker {
    private let launchId: String
    private let isolated: Bool
    private let isAlive: () -> Bool
    private let sendFrame: ([String: Any]) async throws -> Void
    private let driver: NativeProxyHelperDriver
    private var gate: NativeProxyUserActionGate
    private var hello = false
    private var pending: CheckedContinuation<Void, Error>?
    private var operationId: String?
    private var timeout: Task<Void, Never>?
    private let sleep: (UInt64) async throws -> Void
    private var handling = false
    private var uncertain = false
    private var closingOperation = false
    init(isolated: Bool, launchId: String, isAlive: @escaping () -> Bool,
         sendFrame: @escaping ([String: Any]) async throws -> Void,
         helperDriver: NativeProxyHelperDriver? = nil,
         now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime },
         sleep: @escaping (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }) {
        self.isolated = isolated; self.launchId = launchId; self.isAlive = isAlive
        self.sendFrame = sendFrame; self.driver = helperDriver ?? UnavailableNativeProxyHelper()
        self.sleep = sleep
        gate = NativeProxyUserActionGate(isolated: isolated, now: now)
    }
    func perform(action: String) async throws {
        guard !isolated else { throw NativeProxyCodec.error("ISOLATED") }
        guard hello, isAlive() else { throw NativeProxyCodec.error("ENGINE_LEASE_INVALID") }
        guard pending == nil, !handling, !closingOperation, !driver.isActive else { throw NativeProxyCodec.error("NATIVE_CONTROL_BUSY") }
        guard !uncertain || action == "disconnect" else { throw NativeProxyCodec.error("NATIVE_PROXY_UNKNOWN") }
        let id = UUID().uuidString
        try gate.begin(launchId: launchId, operationId: id, action: action, helperInactive: !driver.isActive)
        operationId = id
        try await withTaskCancellationHandler(operation: {
          try await withCheckedThrowingContinuation { continuation in
            pending = continuation
            armTimeout(seconds: 240)
            Task { [weak self] in
                guard let self, self.operationId == id, self.pending != nil else { return }
                do { try await self.sendFrame(["version": 1, "type": "begin", "launchId": self.launchId, "operationId": id, "action": action]) }
                catch { await self.fail(code: "NATIVE_CONTROL_CLOSED") }
            }
          }
        }, onCancel: { [weak self] in
            Task { @MainActor in
                guard let self, self.operationId == id else { return }
                await self.fail(code: "NATIVE_CONTROL_CANCELLED")
            }
        })
    }
    func receive(_ frame: [String: Any]) async {
        guard isAlive() else { await revoke(); return }
        if frame["type"] as? String == "hello" {
            guard !hello, Set(frame.keys) == ["version", "type", "launchId"], Self.isVersionOne(frame["version"]),
                  frame["launchId"] as? String == launchId else { await revoke(); return }
            hello = true; return
        }
        guard pending != nil, !handling else { await fail(code: "NATIVE_CONTROL_INVALID"); return }
        handling = true
        defer { handling = false }
        do {
            switch frame["type"] as? String {
            case "helper":
                let request = try gate.validateHelperRequest(frame)
                let sequence = frame["sequence"] as? Int ?? 0
                if sequence == 2 { armTimeout(seconds: 60) }
                let response: [String: Any]
                do { response = try await driver.request(request) }
                catch {
                    var failure: [String: Any] = ["ok": false, "phase": "finished", "operationId": operationId ?? "", "planDigest": frame["planDigest"] ?? "", "code": sequence == 1 ? "AUTHORIZATION_REQUIRED" : "UNKNOWN", "committed": sequence == 1 ? (false as Any) : ("unknown" as Any)]
                    if let digest = request["preparedDigest"] { failure["preparedDigest"] = digest }
                    response = failure
                }
                guard pending != nil, isAlive() else { await fail(code: "NATIVE_CONTROL_CLOSED"); return }
                try gate.acceptHelperResponse(response, sequence: sequence)
                if sequence == 2 && response["ok"] as? Bool != true { uncertain = true }
                try await sendFrame(["version": 1, "type": "helper-result", "launchId": launchId, "operationId": operationId ?? "", "sequence": sequence, "planDigest": frame["planDigest"] ?? "", "response": response])
            case "complete":
                try gate.complete(frame)
                if frame["ok"] as? Bool != true && gate.commitPermitted { uncertain = true }
                await driver.complete()
                if frame["ok"] as? Bool == true { uncertain = false; finish(error: nil) }
                else {
                    let allowed = ["AUTHORIZATION_REQUIRED", "SYS_PROXY_AUTHORIZATION_REQUIRED", "NATIVE_PROXY_UNKNOWN"]
                    let requested = frame["code"] as? String ?? ""
                    let code = uncertain ? "NATIVE_PROXY_UNKNOWN" : (allowed.contains(requested) ? requested : "NATIVE_PROXY_FAILED")
                    finish(error: NativeProxyCodec.error(code))
                }
            default: throw NativeProxyCodec.error()
            }
        } catch { await fail(code: "NATIVE_CONTROL_INVALID") }
    }
    private func armTimeout(seconds: UInt64) {
        timeout?.cancel()
        let operation = operationId
        timeout = Task { [weak self] in
            guard let self else { return }
            do { try await self.sleep(seconds * 1_000_000_000) } catch { return }
            guard !Task.isCancelled, self.operationId == operation else { return }
            await self.fail(code: "NATIVE_CONTROL_TIMEOUT")
        }
    }
    private static func isVersionOne(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        return number.doubleValue == 1
    }
    func revoke() async { hello = false; await fail(code: "ENGINE_LEASE_INVALID") }
    private func fail(code: String) async {
        let committed = gate.commitPermitted
        uncertain = uncertain || committed
        let cancelledOperation = operationId
        closingOperation = true
        gate.revoke()
        finish(error: NativeProxyCodec.error(committed ? "NATIVE_PROXY_UNKNOWN" : code))
        if !committed {
            if let cancelledOperation, isAlive() {
                try? await sendFrame(["version": 1, "type": "cancel", "launchId": launchId, "operationId": cancelledOperation])
            }
            await driver.cancelBeforeCommit()
        }
        closingOperation = false
    }
    private func finish(error: Error?) {
        timeout?.cancel(); timeout = nil
        let continuation = pending; pending = nil; operationId = nil
        if let error { continuation?.resume(throwing: error) } else { continuation?.resume() }
    }
}
