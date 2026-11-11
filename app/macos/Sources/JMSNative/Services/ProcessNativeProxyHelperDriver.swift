import Foundation

/// Source-only opt-in driver, never installed by the default Broker or Runtime.
/// A future explicit UI action must confirm a locally derived typed review first.
@MainActor final class ProcessNativeProxyHelperDriver: NativeProxyHelperDriver {
    private enum Phase { case idle, preparing, prepared, committing, finished, unknown, cancelled }
    private let factory: OwnedHelperProcessFactory
    private let now: () -> Double
    private let sleep: (UInt64) async throws -> Void
    private var owned: OwnedHelperProcess?
    private var approval: ProxyAuthorizationReview?
    private var approvalTime: Double?
    private var consumed = Set<String>()
    private var phase = Phase.idle
    private var gate = NativeProxyUserActionGate(isolated: false)
    private var binding: (launch: String, operation: String, digest: String)?
    private var permitMayHaveBeenSent = false
    private var deadline: Double = 0
    private var timer: Task<Void, Never>?
    private var pending: CheckedContinuation<[String: Any], Error>?
    private var preparedDigest: String?
    private var sequence = 0
    private var generation = UUID()
    private var exitConfirmed = true
    private var successCandidate: [String: Any]?
    var isActive: Bool { owned != nil && (!exitConfirmed || owned?.isRunning == true) }
    init(factory: OwnedHelperProcessFactory? = nil,
         now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime },
         sleep: @escaping (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }) {
        self.factory = factory ?? FixedBundleOwnedHelperFactory(); self.now = now; self.sleep = sleep
        gate = NativeProxyUserActionGate(isolated: false, now: now)
    }
    func confirmReview(_ review: ProxyAuthorizationReview) throws {
        let confirmedAt = now()
        guard !isActive, pending == nil, approval == nil, confirmedAt.isFinite, (confirmedAt + 30).isFinite,
              !consumed.contains(review.operationId), consumed.count < 1024 else { throw safe() }
        approval = review; approvalTime = confirmedAt
    }
    func request(_ request: [String: Any]) async throws -> [String: Any] {
        guard pending == nil else { throw safe() }
        let operation = request["operation"] as? String
        var operationGeneration = generation
        do {
            if operation == "interactivePrepare" {
                guard !isActive, let approval, let approvalTime, now().isFinite, now() >= approvalTime, now() < approvalTime + 30, let dataString = request["planData"] as? String,
                      dataString.utf8.count <= NativeProxyCodec.limit, let bytes = Data(base64Encoded: dataString),
                      request["operationId"] as? String == approval.operationId,
                      request["planDigest"] as? String == approval.planDigest,
                      !consumed.contains(approval.operationId) else { throw safe() }
                _ = try ProxyAuthorizationReview(planData: bytes, planDigest: approval.planDigest,
                    launchId: approval.launchId, operationId: approval.operationId, action: approval.action)
                gate = NativeProxyUserActionGate(isolated: false, now: now)
                try gate.begin(launchId: approval.launchId, operationId: approval.operationId, action: approval.action)
                binding = (approval.launchId, approval.operationId, approval.planDigest)
                _ = try gate.validateHelperRequest(frame(request, sequence: 1))
                consumed.insert(approval.operationId); self.approval = nil; self.approvalTime = nil
                permitMayHaveBeenSent = false; preparedDigest = nil; successCandidate = nil; sequence = 1; phase = .preparing
                let process = try factory.make(); owned = process
                generation = UUID(); operationGeneration = generation
                let generation = self.generation
                exitConfirmed = false
                do { try process.start { [weak self] event in
                    guard let self, self.generation == generation else { return }
                    self.receive(event)
                } } catch { exitConfirmed = !process.isRunning; throw error }
                guard process.isRunning else { throw safe() }
                return try await exchange(request, seconds: 240)
            } else if operation == "interactiveCommit" {
                guard phase == .prepared, isActive, now().isFinite, now() < deadline,
                      request["preparedDigest"] as? String == preparedDigest else { throw safe() }
                _ = try gate.validateHelperRequest(frame(request, sequence: 2))
                // Set BEFORE the transport can write even one commit byte. A partial
                // write/EOF/cancellation can never be classified as pre-commit again.
                permitMayHaveBeenSent = true; phase = .committing; sequence = 2
                return try await exchange(request, seconds: 60)
            } else { throw safe() }
        } catch {
            guard generation == operationGeneration else {
                throw NativeProxyCodec.error(operation == "interactiveCommit" ? "NATIVE_PROXY_UNKNOWN" : "AUTHORIZATION_REQUIRED")
            }
            fail()
            throw safe()
        }
    }
    private func exchange(_ request: [String: Any], seconds: UInt64) async throws -> [String: Any] {
        deadline = now() + Double(seconds)
        let operation = binding?.operation, exchangeGeneration = generation
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                pending = continuation
                arm(seconds)
                Task { [weak self] in
                    guard let self, self.pending != nil, self.binding?.operation == operation, self.generation == exchangeGeneration else { return }
                    do { try await self.owned?.send(request) }
                    catch { if self.binding?.operation == operation && self.generation == exchangeGeneration { self.fail() } }
                }
            }
        }, onCancel: { [weak self] in Task { @MainActor in
            guard let self, self.binding?.operation == operation, self.generation == exchangeGeneration else { return }; self.fail()
        } })
    }
    private func frame(_ request: [String: Any], sequence: Int) -> [String: Any] {
        ["version": 1, "type": "helper", "launchId": binding?.launch ?? "", "operationId": binding?.operation ?? "",
         "sequence": sequence, "planDigest": binding?.digest ?? "", "request": request]
    }
    private func receive(_ event: OwnedHelperEvent) {
        switch event {
        case .frame(let response):
            // Keep consuming transport data after failure, but never accept a late
            // successful result as verification of an already unknown operation.
            guard pending != nil, phase == .preparing || phase == .committing else { return }
            guard now().isFinite, now() < deadline else { fail(); return }
            do {
                try gate.acceptHelperResponse(response, sequence: sequence)
                if sequence == 2, response["ok"] as? Bool == true {
                    // This is only a candidate. Keep the original 60s budget and
                    // continuation until the owned helper has exited AND drained.
                    successCandidate = response
                    return
                }
                timer?.cancel()
                if sequence == 1, response["ok"] as? Bool == true {
                    preparedDigest = response["preparedDigest"] as? String
                    phase = .prepared; deadline = now() + 5; arm(5)
                } else { phase = .finished }
                let continuation = pending; pending = nil
                continuation?.resume(returning: response)
            } catch { fail() }
        case .closed:
            if successCandidate == nil && phase != .finished { fail() }
        case .invalid:
            if phase != .finished { fail() }
        case .exited:
            guard owned?.isRunning != true else { fail(); return }
            exitConfirmed = true
            if let successCandidate, phase == .committing, pending != nil,
               now().isFinite, now() < deadline {
                self.successCandidate = nil; phase = .finished
                timer?.cancel(); timer = nil
                let continuation = pending; pending = nil
                continuation?.resume(returning: successCandidate)
            } else if pending != nil || phase == .prepared { fail() }
            // No late exit can revive an unknown operation or return its proof.
        }
    }
    private func arm(_ seconds: UInt64) {
        timer?.cancel()
        let operation = binding?.operation, expectedPhase = phase, timerGeneration = generation
        timer = Task { [weak self] in
            guard let self else { return }
            do { try await self.sleep(seconds * 1_000_000_000) } catch { return }
            guard !Task.isCancelled, self.binding?.operation == operation, self.phase == expectedPhase, self.generation == timerGeneration else { return }
            self.fail()
        }
    }
    private func fail() {
        timer?.cancel(); timer = nil
        gate.revoke(); approval = nil; approvalTime = nil; successCandidate = nil
        phase = permitMayHaveBeenSent ? .unknown : .cancelled
        let continuation = pending; pending = nil
        continuation?.resume(throwing: safe())
        // Once any commit byte may have been sent, never abort/terminate. The
        // transport continues bounded draining and isActive stays true until exit.
        if !permitMayHaveBeenSent { owned?.abortOwnedBeforePermit() }
    }
    func cancelBeforeCommit() async { fail() }
    func complete() async throws {
        let completingGeneration = generation
        let completingOperation = binding?.operation
        let completionError = safe() // Capture the old operation's classification.
        if !permitMayHaveBeenSent && isActive { owned?.abortOwnedBeforePermit() }
        let until = now() + 2
        while true {
            guard generation == completingGeneration, binding?.operation == completingOperation else { throw completionError }
            guard isActive else { return }
            guard now().isFinite, now() < until else { fail(); throw completionError }
            do { try await sleep(10_000_000) }
            catch {
                guard generation == completingGeneration, binding?.operation == completingOperation else { throw completionError }
                fail(); throw completionError
            }
            // A Broker watchdog can finish this call's outer operation while this
            // task still sleeps. Never inspect/fail/complete a replacement helper.
            guard generation == completingGeneration, binding?.operation == completingOperation else { throw completionError }
        }
    }
    private func safe() -> APIError {
        NativeProxyCodec.error(permitMayHaveBeenSent ? "NATIVE_PROXY_UNKNOWN" : "AUTHORIZATION_REQUIRED")
    }
}
