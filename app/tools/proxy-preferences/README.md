# JMSProxyPreferences

Private stdin/stdout schema-3 IPC helper. Build using `swift build -c release`;
run only mock unit tests with `swift test`. **Do not execute the CLI against a
user's system as a test.** Its compareAndSet operation changes system preferences.
The binary does not elevate itself. SCPreferencesCreate carries no authorization
reference; Apple SCPLock denies non-root access, including ordinary administrators.
The formal user-authorization path is not implemented. A known pre-write access
denial is AUTHORIZATION_REQUIRED/committed=false, not lock contention. Errors after
a potentially committed operation remain recovery errors, never a "no write" claim.

Exact raw Proxies property-list dictionaries (including absent versus empty) are
kept as opaque base64 binary plists. IPC must remain private and journals must be
0600. No raw values belong in diagnostics. Unsupported keys, authentication keys,
and network services without a complete UUID/name/device identity fail closed.
Snapshot and prepare acquire a nonblocking preference lock but never write.
Read the original NetworkServices tree with SCPreferencesGetValue, not PathGet
which follows __LINK__. Reject aliases at every relevant ancestor/proxy dictionary.
Writes require a locked session and a UUID validated by that session's complete
read; synchronize/unlock clears the allowlist. No prefsID/path input is exposed.

CAS stages all service paths while locked, commits once, applies once, and checks
persistent preferences after synchronizing. Commit failure has unknown durability;
apply or readback failure after commit reports committed=true. Retain the journal
on every error. A retry with current==desired still commits/applies/readbacks;
only a successful verified result permits journal cleanup. This verifies saved
SCPreferences values and successful Apply, not subsequent third-party mutations.

Linux authoring environment has no Swift toolchain: compilation and mock tests
must pass restricted macOS CI before adoption. No live-system test was performed.
The missing non-root authorization path, actual Apply behavior, Keychain-only authentication
detection, and VPN/no-device compatibility remain live-use gates. Rejecting known
authentication/unknown keys is not proof that every authentication form is detected.

### Interactive transaction model (not an authorization implementation)

`InteractiveTransactionRunner` is a single-use, injected model: exact plan bytes
are SHA-256 bound (including the apply plan’s pre-authorization expected
snapshot), a locked CAS recheck rejects changes during the authorization wait.
A locked prepare precedes a five-second durable-journal ACK,
and only the matching ACK permits staging/Commit/Apply plus two readbacks. Its
transport callback must enforce the supplied monotonic deadline; the model also
rejects late callbacks. Tests use only `MemoryStore` and fake authorization.
The only selected/default provider is `UnavailableInteractiveAuthorization`.
`--interactive` deliberately returns `AUTHORIZATION_REQUIRED` without creating
an authorization reference. No privilege helper, permission prompt, or system
write is enabled by this model. A platform authorizer and bounded private-pipe
adapter require a separate audit and actual isolated-Mac validation.

`observe` uses two fresh **read-only** SCPreferences sessions and validates/copies
the raw `NetworkServices` dictionaries. It does not lock, authorize, commit, or
apply. Equal observations are only a stable candidate, never a transactional
snapshot or a guarantee against changes after the samples. Tests inject reads
and never observe the host's actual preferences.

### Source-only scoped platform authorizer (not enabled)

`SystemAuthorizationProvider` now contains the platform adapter **source**, but
nothing selects it: the default runner remains unavailable and `--interactive`
still rejects before reading input or creating a preferences/authorization
session. Candidate is unchanged. Building this source is not an authorization
or system-proxy acceptance test.

Constructing the provider only stores closures. An eventual explicitly gated
`withStore` call creates a fresh reference using `AuthorizationCreate` with no
rights, environment, or flags, then a non-nil reference is passed to
`SCPreferencesCreateWithAuthorization`. SC requests its own rights. There is no
hardcoded right, preflight CopyRights, external form, cached reference, daemon,
setuid, authorization-database edit, or `destroyRights`. macOS can ask again at
Lock, Commit, or Apply; this does not guarantee one prompt or unattended recovery.

Each scope closes and invalidates its SC session before freeing the reference
with default flags, on success or failure. Escaping store objects cannot perform
later reads/writes/commit/apply. Store access and close are serialized. Tests
inject all authorization/session calls and use opaque non-dereferenced sentinels;
they never call Security, inspect host preferences, or alter the network.

Activation remains a separate reviewed step and requires expressly approved
isolated-Mac validation: admin and standard accounts, denial/cancel/expiry/repeat
prompts, MDM restrictions, actual Commit/Apply/readback/restoration, every crash
window, sleep/logout/multiple users, and supported macOS versions. Existing VPN
scope and Keychain-only authentication limits remain unchanged.
