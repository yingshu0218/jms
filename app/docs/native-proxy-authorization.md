# macOS system-proxy authorization: phased implementation

## Current boundary

The private transaction protocol, state machine, and source-only platform
adapters are implemented. **No production path selects an AuthorizationServices
provider or real helper driver.**
`UnavailableInteractiveAuthorization`, `UnavailableNativeProxyHelper`, and the
helper's `--interactive` rejection prevent a forged flag, HTTP request, or
Candidate from obtaining rights. Mock success is not proof that a normal macOS
user can connect or restore system proxy settings.

The unselected adapter source can create a short-lived AuthorizationRef inside
a directly launched bundled helper only after a future explicitly reviewed
activation. It uses a non-nil reference
with SCPreferencesCreateWithAuthorization, never an arbitrary command runner,
sudo, setuid, changed authorization database, credentials in argv/environment,
or AuthorizationExternalForm in our HTTP, files or logs. Apple's own framework
may legitimately pass authorization to its system helper over Mach. No rights
reference is retained across transactions, and shared system rights must not be
revoked with destroyRights merely to force another prompt.

## Source-only platform adapter stage

`SystemAuthorizationProvider` stores system-call closures without calling them
at construction. A future explicit scope creates a new reference with nil rights,
nil environment and default flags, creates a fixed authorized SC session, then
invalidates/closes that session before freeing the reference with default flags.
Escaped store objects cannot access the session after scope end. There is no
CopyRights preflight, shared-right revocation, external form or reusable ref.

`ProcessNativeProxyHelperDriver` and its real transport are present but are not
referenced by default Broker/Runtime factories. A future typed confirmation must
be consumed once within thirty monotonic seconds before process creation. The
review model verifies exact SHA-256 bytes, strict schemas/identities and
unambiguous bounded JSON, and retains only the action, apply loopback port,
service-name/count summary and binding identifiers. Restore does not decode or
display opaque endpoints or infer a port from pending settings.

The real factory only accepts formal nonisolated bundle metadata and the fixed,
non-symlink bundled helper path, with constant `--interactive`, no shell, a
minimal environment allowlist/fixed PATH and discarded raw stderr. It owns its
anonymous pipes/process. It records possible permission delivery before writing
any commit byte. Once permission may have been sent, timeout/EOF/partial write or
cancellation stays unknown: no replay and no helper kill; data is boundedly
drained until confirmed owned exit. Old process generations cannot finalize a
new operation. Before permission, cancellation can stop only this owned helper.

This is not a connected authorization experience. The default helper CLI still
rejects `--interactive` before reading stdin or creating either session; the
production two-line helper transport with a hard five-second ACK read and the
actual Native confirmation presenter are not wired. Adding source/fixtures does
not authorize enabling them. Ordinary tests inject every factory, authorization
and store call; no test may use the real factory or real system preferences.

## Explicit activation blockers

The fixed bundle metadata, path and build-time codesign checks are **not a
runtime identity trust anchor**. Before production activation, Native must
validate the helper's running designated requirement and same trusted signing
identity. In the other direction the helper must authenticate the requesting
Native process/peer, not merely accept an anonymous stdin pipe. Otherwise any
local process could launch `--interactive` directly, potentially using OS-cached
rights without a new password dialog. The current unconditional CLI rejection
preserves this boundary. Environment tokens, replayable credentials, bundle-ID
strings or a fresh authorization reference are not substitutes.

A successful helper frame is not an exit proof. Production cleanup must wait
boundedly for the corresponding owned helper to exit, without killing a process
that may have received commit permission. Native's cleanup/Quit checks must cover
active helpers even if Node has no journal or its engine has already died, and
must not discard an older broker while its helper still owns an operation.
These pure lifetime models are not real crash/authorization acceptance.

The actual confirmation presenter and bounded helper-side interactive reader
remain unconnected. Any future confirmation must describe the full apply
scope, including HTTP/HTTPS/SOCKS loopback target, PAC/discovery and bypass effects,
services affected, and manual-recovery limits. Neither these source adapters nor
passing mocks authorize enabling a production path.

## Product choice and recovery guarantee

A temporary-reference implementation supports a user explicitly initiating a
connection or restoration. It **cannot guarantee unattended crash recovery** or
one authorization dialog per connection. Apple's helper may request interaction
again during Lock, Commit or Apply; an earlier noninteractive probe is not a
promise that later operations will stay noninteractive.

If recovery must survive Native/Node crashes without a user, a separately
threat-modeled, signed, user-approved persistent helper is required. That helper
would own the authoritative journal and recovery state, not race with a second
Node journal owner. Installation, signing, permissions and real network tests
are not part of this phase.

The current ownership policy never adopts an unrelated listener or process.
After parent failure, a retained engine/core or inaccessible old control channel
may require manual review/restoration in System Settings. Limited-ready does
not prove the old core still exists or the current proxy path still works. We do
not claim that every Native/Node crash window is recoverable in the GUI yet.

## Implemented private protocol

* Native creates anonymous stdin/stdout pipes for its recorded Node child.
  `--native-control` reserves stdout exclusively for bounded NDJSON; diagnostic
  output goes to stderr. Candidate Runtime does not enable the channel and both
  Native and Node independently reject Candidate begin requests.
* HTTP never arms, commits or finalizes an interactive transaction. Raw proxy
  dictionaries and restore plans stay on the private pipes and in the existing
  0600 recovery journal, not in public API responses, URLs, environment or logs.
* Every message binds protocol version, current launch, operation, action,
  sequence, exact plan-byte SHA-256 and prepared-byte SHA-256. A user operation
  permits at most one prepare and one exact commit. Frames are capped at 8 MiB.
  Extra keys, wrong scope, replay, deadlines and EOF fail closed.
* Node finishes downloads and confirms its owned core before offering apply.
  Before commit permission and before marking connected it rechecks the same
  session/PID and exact loopback listener ownership. A replacement/dead core
  cannot inherit an authorization window's permission.
* Apply first obtains two fresh read-only observations. Their expected snapshot
  is part of the immutable plan/digest; authorization-time changes must
  fail the subsequent lock-time CAS rather than silently becoming a new original.
  A future production provider also requires a separate Native confirmation UI
  generated from the typed plan (action, port and target-service summary). This
  prototype has not implemented that reviewed authorization experience yet.
* The helper model authorizes through an injectable provider, acquires the SC
  lock, validates the original raw tree and target identities, rejects aliases
  and unsupported/authentication fields, then returns a prepared state. No
  persistent system write occurs before an exact, once-only journal ACK.
* Node's reviewed journal ordering remains authoritative: begin/update, file
  fsync, rename and directory fsync precede commit permission. The helper's
  prepared lock wait is limited to five seconds; a future transport must enforce
  that bound on the blocking read as well as reject late-returned responses.
* Same-lock state is checked again before staging. Commit false is unknown;
  Apply/readback failure after Commit is committed, not a no-op. Success needs
  two actual helper readbacks and an independent stable read-only observation
  before restoration evidence can be cleared. Equal-value restoration still
  runs Commit/Apply.

The model's synchronous injected ACK closure cannot interrupt arbitrary hung
code. A real interactive pipe adapter is deliberately absent until its bounded
transport and cancellation behavior have been reviewed separately.

## Startup, cancellation and Quit

A nonisolated Darwin journal now boots into `recoveryRequired` limited-ready
instead of trying to obtain rights or closing the control server. Authenticated
state/identity/events remain accessible; normal mutation and automatic refresh
are blocked, while an explicit private restore can be attempted. Corrupt,
incomplete and unsupported journals remain untouched. Complete legacy
base2/darwin1 journals are also intentionally unsupported by this new interactive
raw-only path: they remain on disk and cause zero helper/writer calls. The prior
strict legacy dispatcher still exists for its explicit non-Native callers; there
is no interactive networksetup fallback. A separately reviewed legacy recovery
authorization design is required before claiming Native backward compatibility.

Before commit permission, cancellation cannot write system preferences. After
permission may have been delivered, cancellation, timeout, lost IPC or late
response means unknown: retain the journal and any owned core, never replay a
commit or report restoration success. An inactive helper and a new explicit
restore operation are required to attempt convergence. A new connect is blocked.

Quit first waits for in-flight work. If restoration is required, it uses an
explicit Native operation. Cancellation, denial or unknown result cancels Quit
and preserves evidence/owned processes. A successful exit still requires
restoration, journal absence, two authenticated status checks, owned-child exit
and a launch-bound cleanup proof. Signals and background give-up do not arm an
interactive authorization flow.

## Tests and remaining platform gates

The new Node, Swift and helper model tests use fake stores, fake authorizers,
fake transports or an explicitly isolated owned loopback Node child. Ordinary
CI must not invoke AuthorizationCreate or write SystemConfiguration. The real
Candidate IPC smoke remains isolated and is not GUI/system-proxy acceptance.

Before enabling the production provider, separately verify on isolated Macs:

* admin and standard users, denied/cancelled/expired/MDM-controlled rights;
* repeated prompts, every Native/Node/helper crash/EOF/commit window and Quit;
* actual Commit/Apply effects and full restoration, sleep/logout/multiple users;
* Keychain-only authentication recognition, VPN/service scope, old journals;
* supported macOS versions, signing and distribution identity.

VPN/no-DeviceName and unknown authentication forms remain fail-closed. This
phase must not silently broaden target scope or make a legacy command fallback.

Official references:

* [configd helper authorization](https://github.com/apple-oss-distributions/configd/blob/585b7f2fca293f4642d21d15c5daf187f63c4796/SystemConfiguration.fproj/helper/SCHelper_server.c#L1689)
* [Apple DTS: network authorization and cache boundary](https://developer.apple.com/forums/thread/805149)
* [AuthorizationFree](https://developer.apple.com/documentation/security/authorizationfree(_:_:))
* [SCPreferencesSynchronize](https://developer.apple.com/documentation/systemconfiguration/scpreferencessynchronize(_:))
* [SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)
