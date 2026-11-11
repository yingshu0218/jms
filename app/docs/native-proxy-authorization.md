# macOS system-proxy authorization: phased implementation

## Current boundary

The private transaction protocol and state machine are implemented, but this
phase deliberately has **no production AuthorizationServices provider**.
`UnavailableInteractiveAuthorization`, `UnavailableNativeProxyHelper`, and the
helper's `--interactive` rejection prevent a forged flag, HTTP request, or
Candidate from obtaining rights. Mock success is not proof that a normal macOS
user can connect or restore system proxy settings.

A later, separately reviewed adapter may create a short-lived AuthorizationRef
inside the directly launched bundled helper. It must use a non-nil reference
with SCPreferencesCreateWithAuthorization, never an arbitrary command runner,
sudo, setuid, changed authorization database, credentials in argv/environment,
or AuthorizationExternalForm in our HTTP, files or logs. Apple's own framework
may legitimately pass authorization to its system helper over Mach. No rights
reference is retained across transactions, and shared system rights must not be
revoked with destroyRights merely to force another prompt.

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
