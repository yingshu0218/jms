# JMSProxyPreferences

Private stdin/stdout schema-3 IPC helper. Build using `swift build -c release`;
run only mock unit tests with `swift test`. **Do not execute the CLI against a
user's system as a test.** Its compareAndSet operation changes system preferences.
The binary does not elevate itself. Lack of write rights is a transaction failure.

Exact raw Proxies property-list dictionaries (including absent versus empty) are
kept as opaque base64 binary plists. IPC must remain private and journals must be
0600. No raw values belong in diagnostics. Unsupported keys, authentication keys,
and network services without a complete UUID/name/device identity fail closed.
Snapshot and prepare acquire a nonblocking preference lock but never write.

CAS stages all service paths while locked, commits once, applies once, and checks
persistent preferences after synchronizing. Commit failure has unknown durability;
apply or readback failure after commit reports committed=true. Retain the journal
on every error. A retry with current==desired still commits/applies/readbacks;
only a successful verified result permits journal cleanup. This verifies saved
SCPreferences values and successful Apply, not subsequent third-party mutations.

Linux authoring environment has no Swift toolchain: compilation and mock tests
must pass restricted macOS CI before adoption. No live-system test was performed.
Non-root SCPreferences rights, actual Apply behavior, Keychain-only authentication
detection, and VPN/no-device compatibility remain live-use gates. Rejecting known
authentication/unknown keys is not proof that every authentication form is detected.
