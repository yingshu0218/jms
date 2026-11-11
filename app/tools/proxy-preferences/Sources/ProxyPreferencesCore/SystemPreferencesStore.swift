import Foundation
import SystemConfiguration

/// No arbitrary path API is exposed to IPC callers. Each write is a validated
/// UUID's Proxies value in a single locked SCPreferences session.
public final class SystemPreferencesStore: PreferencesStore {
    private let preferences: SCPreferences
    private var locked = false
    private var validatedIDs: Set<String> = []
    public init() throws {
        guard let preferences = SCPreferencesCreate(nil, "JMS Proxy Preferences" as CFString, nil) else { throw Failure(.unsupported, .no) }
        self.preferences = preferences
    }
    public func lock() throws {
        // Fail rather than waiting indefinitely on another system writer.
        validatedIDs.removeAll()
        guard SCPreferencesLock(preferences, false) else { throw Self.lockFailure(status: SCError()) }
        locked = true
    }
    // SCPreferencesCreate has no authorization reference. Non-root access denial
    // is a missing authorization path, not contention. Lock precedes all writes.
    static func lockFailure(status: Int32) -> Failure {
        Failure(status == kSCStatusAccessError ? .authorizationRequired : .conflict, .no)
    }
    public func unlock() { validatedIDs.removeAll(); locked = false; SCPreferencesUnlock(preferences) }
    public func synchronize() { validatedIDs.removeAll(); SCPreferencesSynchronize(preferences) }
    public func read() throws -> Snapshot {
        validatedIDs.removeAll()
        guard locked else { throw Failure(.invalidRequest, .no) }
        // GetValue is deliberately non-path-based: PathGetValue follows __LINK__
        // and would hide aliases before we could validate the write boundary.
        let snapshot = try Self.validateRawTree(SCPreferencesGetValue(preferences, "NetworkServices" as CFString))
        validatedIDs = Set(snapshot.services.map(\.id))
        return snapshot
    }
    static func validateRawTree(_ raw: Any?) throws -> Snapshot {
        guard let entries = raw as? [String: Any], entries["__LINK__"] == nil else { throw Failure(.unsupported, .no) }
        var services: [Service] = []
        for id in entries.keys.sorted() {
            guard Snapshot.validID(id), let entry = entries[id] as? [String: Any], entry["__LINK__"] == nil,
                  let name = entry["UserDefinedName"] as? String,
                  let interface = entry["Interface"] as? [String: Any], interface["__LINK__"] == nil,
                  let device = interface["DeviceName"] as? String else { throw Failure(.unsupported, .no) }
            let raw = entry["Proxies"]
            if let raw, !(raw is [String: Any]) { throw Failure(.unsupported, .no) }
            let proxies = try RawProxies(raw as? [String: Any])
            // Validate BEFORE returning even opaque IPC data. Authentication and
            // unknown dictionary keys are never exported into journals.
            _ = try proxies.dictionary()
            services.append(Service(id: id, name: name, device: device, proxies: proxies))
        }
        let snapshot = Snapshot(services: services)
        try snapshot.validate()
        return snapshot
    }
    public func write(id: String, proxies: RawProxies) throws {
        guard locked, validatedIDs.contains(id), Snapshot.validID(id) else { throw Failure(.invalidRequest, .no) }
        let path = "/NetworkServices/\(id)/Proxies" as CFString
        if let dictionary = try proxies.dictionary() {
            guard SCPreferencesPathSetValue(preferences, path, dictionary as CFDictionary) else { throw Failure(.commitFailed, .no) }
        } else if SCPreferencesPathGetValue(preferences, path) != nil {
            guard SCPreferencesPathRemoveValue(preferences, path) else { throw Failure(.commitFailed, .no) }
        }
    }
    public func commit() -> Bool { SCPreferencesCommitChanges(preferences) }
    public func apply() -> Bool { SCPreferencesApplyChanges(preferences) }
}
