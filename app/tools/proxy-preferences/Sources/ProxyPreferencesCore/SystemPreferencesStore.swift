import Foundation
import SystemConfiguration

/// No arbitrary path API is exposed to IPC callers. Each write is a validated
/// UUID's Proxies value in a single locked SCPreferences session.
public final class SystemPreferencesStore: PreferencesStore {
    private let preferences: SCPreferences
    public init() throws {
        guard let preferences = SCPreferencesCreate(nil, "JMS Proxy Preferences" as CFString, nil) else { throw Failure(.unsupported, .no) }
        self.preferences = preferences
    }
    public func lock() throws {
        // Fail rather than waiting indefinitely on another system writer.
        guard SCPreferencesLock(preferences, false) else { throw Failure(.conflict, .no) }
    }
    public func unlock() { SCPreferencesUnlock(preferences) }
    public func synchronize() { SCPreferencesSynchronize(preferences) }
    public func read() throws -> Snapshot {
        guard let entries = SCPreferencesPathGetValue(preferences, "/NetworkServices" as CFString) as? [String: Any] else { throw Failure(.unsupported, .no) }
        var services: [Service] = []
        for id in entries.keys.sorted() {
            guard Snapshot.validID(id), let entry = entries[id] as? [String: Any],
                  let name = entry["UserDefinedName"] as? String,
                  let interface = entry["Interface"] as? [String: Any],
                  let device = interface["DeviceName"] as? String else { throw Failure(.unsupported, .no) }
            let raw = SCPreferencesPathGetValue(preferences, "/NetworkServices/\(id)/Proxies" as CFString)
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
        guard Snapshot.validID(id) else { throw Failure(.invalidRequest, .no) }
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
