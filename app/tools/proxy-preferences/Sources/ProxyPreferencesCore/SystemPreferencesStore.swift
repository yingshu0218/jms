import Foundation
import SystemConfiguration
import Security

/// Close revokes this Swift object's access to its SC session, even if the object
/// escapes an authorization scope. It never commits or applies during cleanup.
public protocol ClosablePreferencesStore: PreferencesStore {
    func close()
}

/// No arbitrary path API is exposed to IPC callers. All access is serialized so
/// close waits for an in-flight call and later calls cannot use a freed session.
public final class SystemPreferencesStore: ClosablePreferencesStore {
    private var preferences: SCPreferences?
    private let access = NSRecursiveLock()
    private var locked = false
    private var validatedIDs: Set<String> = []
    public init() throws {
        guard let preferences = SCPreferencesCreate(nil, "JMS Proxy Preferences" as CFString, nil) else { throw Failure(.unsupported, .no) }
        self.preferences = preferences
    }
    // Pure invalidation fixture: nil never calls a SystemConfiguration function.
    init(invalidatedSession: Void) { preferences = nil }
    // Source-only provider entry; never selected by the CLI or default runner.
    init(authorization: AuthorizationRef) throws {
        guard let preferences = SCPreferencesCreateWithAuthorization(nil, "JMS Proxy Preferences" as CFString, nil, authorization) else {
            throw Failure(.authorizationRequired, .no)
        }
        self.preferences = preferences
    }
    deinit { close() }
    public func close() {
        access.lock(); defer { access.unlock() }
        validatedIDs.removeAll()
        if let preferences, locked {
            SCPreferencesSynchronize(preferences)
            SCPreferencesUnlock(preferences)
        }
        locked = false
        preferences = nil // release the SC session BEFORE its AuthorizationRef
    }
    public func lock() throws {
        access.lock(); defer { access.unlock() }
        validatedIDs.removeAll()
        guard let preferences, !locked else { throw Failure(.invalidRequest, .no) }
        guard SCPreferencesLock(preferences, false) else { throw Self.lockFailure(status: SCError()) }
        locked = true
    }
    static func lockFailure(status: Int32) -> Failure {
        Failure(status == kSCStatusAccessError ? .authorizationRequired : .conflict, .no)
    }
    public func unlock() {
        access.lock(); defer { access.unlock() }
        validatedIDs.removeAll()
        if let preferences, locked { SCPreferencesUnlock(preferences) }
        locked = false
    }
    public func synchronize() {
        access.lock(); defer { access.unlock() }
        validatedIDs.removeAll()
        if let preferences { SCPreferencesSynchronize(preferences) }
    }
    public func read() throws -> Snapshot {
        access.lock(); defer { access.unlock() }
        validatedIDs.removeAll()
        guard let preferences, locked else { throw Failure(.invalidRequest, .no) }
        // Direct raw-tree access rejects aliases before any path write occurs.
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
        access.lock(); defer { access.unlock() }
        guard let preferences, locked, validatedIDs.contains(id), Snapshot.validID(id) else { throw Failure(.invalidRequest, .no) }
        let path = "/NetworkServices/\(id)/Proxies" as CFString
        if let dictionary = try proxies.dictionary() {
            guard SCPreferencesPathSetValue(preferences, path, dictionary as CFDictionary) else { throw Failure(.commitFailed, .no) }
        } else if SCPreferencesPathGetValue(preferences, path) != nil {
            guard SCPreferencesPathRemoveValue(preferences, path) else { throw Failure(.commitFailed, .no) }
        }
    }
    public func commit() -> Bool {
        access.lock(); defer { access.unlock() }
        guard let preferences, locked else { return false }
        return SCPreferencesCommitChanges(preferences)
    }
    public func apply() -> Bool {
        access.lock(); defer { access.unlock() }
        guard let preferences, locked else { return false }
        return SCPreferencesApplyChanges(preferences)
    }
}
