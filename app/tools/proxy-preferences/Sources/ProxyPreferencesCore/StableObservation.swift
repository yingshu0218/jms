import Foundation
import SystemConfiguration

/// Two fresh, independently copied read-only observations. This is not a lock or
/// proof against a change occurring after the observations; CAS still rechecks.
public enum StableObservation {
    public static func read(using readFresh: () throws -> Snapshot) throws -> Snapshot {
        let first = try readFresh(); try first.validate()
        let second = try readFresh(); try second.validate()
        guard try first.same(as: second) else { throw Failure(.conflict, .no) }
        return second
    }
    public static func system() throws -> Snapshot {
        try read {
            // Separate session on EACH sample; no cached signature or reused raw
            // reference across Synchronize. Validation converts the plist into
            // immutable Swift strings + owned base64 Data before session release.
            guard let session = SCPreferencesCreate(nil, "JMS Proxy Observation" as CFString, nil) else {
                throw Failure(.unsupported, .no)
            }
            return try SystemPreferencesStore.validateRawTree(SCPreferencesGetValue(session, "NetworkServices" as CFString))
        }
    }
}
