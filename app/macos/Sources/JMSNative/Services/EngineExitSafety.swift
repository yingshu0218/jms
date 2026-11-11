import Foundation

/// Process absence is not proof that the previous launch restored system networking.
struct EngineExitSafety {
    private(set) var hasLaunchedOwnedEngine = false
    private(set) var launchId: String?
    private var verifiedCleanupId: String?

    mutating func recordLaunch(instanceId: String) {
        hasLaunchedOwnedEngine = true
        launchId = instanceId
        verifiedCleanupId = nil
    }
    mutating func recordVerifiedCleanup(instanceId: String) {
        guard hasLaunchedOwnedEngine, launchId == instanceId else { return }
        verifiedCleanupId = instanceId
    }
    func canExitWithoutLiveEngine(isolated: Bool) -> Bool {
        isolated || !hasLaunchedOwnedEngine || (launchId != nil && verifiedCleanupId == launchId)
    }
}
