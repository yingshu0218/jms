import Foundation
import Security

/// Injectable boundaries only for pure tests. Constructing `.system` stores
/// closures; it does not call Security or SystemConfiguration.
struct AuthorizationCalls {
    let create: (UnsafePointer<AuthorizationRights>?, UnsafePointer<AuthorizationEnvironment>?, AuthorizationFlags, UnsafeMutablePointer<AuthorizationRef?>) -> OSStatus
    let makeStore: (AuthorizationRef) throws -> ClosablePreferencesStore
    let free: (AuthorizationRef, AuthorizationFlags) -> OSStatus
    static var system: AuthorizationCalls {
        AuthorizationCalls(
            create: { AuthorizationCreate($0, $1, $2, $3) },
            makeStore: { try SystemPreferencesStore(authorization: $0) },
            free: { AuthorizationFree($0, $1) })
    }
}

/// SOURCE ONLY: no default factory, CLI or Candidate calls this provider.
/// A caller must first establish an explicit, fresh Native user-action gate.
/// SC requests its own rights and can prompt again at Lock, Commit or Apply.
/// This does not promise unattended recovery or one prompt per connection.
public final class SystemAuthorizationProvider: InteractiveAuthorizationProvider {
    private let calls: AuthorizationCalls
    public init() { calls = .system }
    init(calls: AuthorizationCalls) { self.calls = calls }

    public func withStore<T>(_ body: (PreferencesStore) throws -> T) throws -> T {
        var reference: AuthorizationRef?
        let status = calls.create(nil, nil, AuthorizationFlags(rawValue: 0), &reference)
        guard status == errAuthorizationSuccess, let reference else {
            // Defensively release a reference returned by our own create call,
            // even when the API reports failure. Never manufacture or reuse one.
            if let reference { _ = calls.free(reference, AuthorizationFlags(rawValue: 0)) }
            throw Failure(.authorizationRequired, .no)
        }
        let store: ClosablePreferencesStore
        do { store = try calls.makeStore(reference) }
        catch {
            _ = calls.free(reference, AuthorizationFlags(rawValue: 0))
            if let failure = error as? Failure { throw failure }
            throw Failure(.authorizationRequired, .no)
        }
        // Capturing the body result lets cleanup finish before propagating errors
        // or returning even an escaped store. close invalidates its SC session.
        let result: Result<T, Error>
        do { result = .success(try body(store)) }
        catch { result = .failure(error) }
        store.close()
        let released = calls.free(reference, AuthorizationFlags(rawValue: 0))
        switch result {
        case .failure(let error):
            if let failure = error as? Failure { throw failure }
            throw Failure(.unsupported, .unknown)
        case .success(let value):
            guard released == errAuthorizationSuccess else { throw Failure(.unsupported, .unknown) }
            return value
        }
    }
}
