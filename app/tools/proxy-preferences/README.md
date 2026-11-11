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
The only supplied provider is `UnavailableInteractiveAuthorization`.
`--interactive` deliberately returns `AUTHORIZATION_REQUIRED` without creating
an authorization reference. No privilege helper, permission prompt, or system
write is enabled by this model. A platform authorizer and bounded private-pipe
adapter require a separate audit and actual isolated-Mac validation.

`observe` uses two fresh **read-only** SCPreferences sessions and validates/copies
the raw `NetworkServices` dictionaries. It does not lock, authorize, commit, or
apply. Equal observations are only a stable candidate, never a transactional
snapshot or a guarantee against changes after the samples. Tests inject reads
and never observe the host's actual preferences.
