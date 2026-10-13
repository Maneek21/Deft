# Gmail connection milestone

The native Email Settings Accounts section now calls authenticated host connection
routes. These routes dispatch only an operator-configured, digest-pinned module
for the exact organization, owner, installation and reviewed target. The retired
`/api/connections` routes remain retired. This milestone is not a live-provider
or full Email replacement certification.

The smallest implemented option is a private deployment registry over existing
reviewed resources/actions. A browser-nominated provider/module configuration
would cross the trust boundary; restoring native provider logic would couple
Email to core. The registry needs no schema migration and can be disabled by
removing its configuration on restart. Retain encrypted custody and uncertain
operation evidence when disabling admission.

## Operator configuration

Set `DEFT_APP_CONNECTION_ADAPTERS_CONFIG` to an absolute private JSON file outside
the repository. Its schema is `deft.app_connection_adapters.v1`, with `entries`
containing `pins`, `module_path`, `module_sha256` and `options`. See the actual
[registry](../../../../apps/api/src/lib/app-connection-registry.ts) and
[pin contract](../../../../apps/api/src/lib/app-connection-contract.ts).
Configuration is read once per process; changes require a restart. The module
hash pins its entry file; dependency files remain trusted deployment code.

Each entry pins organization/owner/installation/version/grant, target,
resource key/binding and paired optional action key/binding. Derive these from
existing reviewed host configuration. Browser bodies cannot supply or alter them.
The host independently rereads current owner, web session, accepted exposure and
resource authority under existing locks. Connect additionally rederives the
configured live action. The closed host purpose (`connect`, `status`, or
`disconnect`) comes from the validated route/body and remains fixed through
module work and every authority recheck; browser input cannot supply it.

The Email entry point is `createAppConnectionAdapter` in `connection-http.mjs`.
Private options contain `origin`, `account_id`, `provider`, `authority_epoch`,
`connection_target`, `resource_binding_id`, `action_binding_id`, `capabilities`,
`clients`, `encryption_key_hex`, `key_id`, and `custody_root`. The account epoch
is separate from the host runtime epoch. Provider clients use the existing
[OAuth contract](oauth-custody.md), including fixed provider endpoints and a
registered frontend redirect at `/apps/connections/callback` on the configured
Deft origin. Never paste real client secrets, custody keys or credentials into
chat, public source, screenshots or reports.

Default custody requires reviewed private POSIX storage with the existing
encrypted, fsynced CAS/lock contract. It refuses unsupported Windows durability.
No private registry, OAuth client or credential was configured by these changes.
A Deft sender is distinct from an account connected to Codex's Gmail connector.

## Human flow and authority

After deployment configuration, use Email → Settings → Accounts → Connect
account. The same authenticated session must complete provider sign-in. The
browser keeps only a bounded session pointer and exact OAuth state, then removes
the callback code/state from the URL. A response is connected only after verified
provider identity and encrypted custody acknowledgement. Status does not refresh
credentials; local disconnect does not revoke a whole provider project grant.

Read/thread require current `read_one`, search requires current `search`, and Send
requires the configured current reviewed action. A summary permission alone
cannot mint full mailbox read. Legacy setup remains owner/admin-only. The
preview.60 host adds default-off, admin-admitted owner setup for active human
members; the Email 1.5.9 manifest opts into that contract. Resource consent and
each action are reviewed independently. Exact provider registry entries still
require operator configuration for each new target. Configured Send
withdrawal or a disabled action plane blocks connect, but current resource
authority still permits status and local disconnect. The Email handler rejects
cross-purpose use before custody/provider effects. Cleanup never begins OAuth,
refreshes or returns a token, sends mail, or revokes a provider grant. It retains
the original custody action pins and capability ceiling as immutable nominations,
preserving ciphertext associated data and verified identity continuity. If the
original connection used only a subset of the configured ceiling, cleanup retains
that exact stored subset when resource/action pins and account epoch match. A
later reduction to summary-only operations does not rebind ciphertext, authorize
mailbox reads, or prevent local discard; a changed pin/epoch remains stale. Any
returned account capabilities describe stored provider scopes rather than live
Send admission. Local disconnect discards credentials and advances setup
generation, fencing earlier callbacks.

Revoked/expired resource or Experience consent, a foreign or expired SID, wrong
owner/target, or withdrawn deployment still denies cleanup. Teardown after source
consent expires remains unimplemented. The purpose split itself adds no migration or custody format;
rolling back restores the former action coupling without resurrecting credentials
or consumed setup state. Deploy the matching host and digest-pinned adapter
together; an absent/unknown purpose fails closed.

Host module work is bounded by the original conservative authority deadline and
30 seconds. No response bytes or identity may escape after withdrawal, epoch
change, abort or expiry. Public views omit credentials, subject identifiers and
binding pins. Publication uncertainty requires checking durable status.

## Send and recipient verification

`outgoing-send-runtime.mjs` joins trusted Run/effect references with exact retained
draft/MIME/file snapshots. It uses one operation `mail-${run_id}` through reservation,
provider start and outcome reconciliation. An unknown result never permits resend.
The matching host now implements encrypted PostgreSQL draft-file and immutable
payload custody, exact human confirmation and authenticated Runtime release.
The [Send integration](send-integration.md) connects these to a one-shot executor
and encrypted durable journal. Deployment, automatic member-target provider
configuration and live provider certification remain unfinished.

`recipient-verification.mjs` creates a fresh nonce probe. For native Send, use
`bindRecipientProbeToPayload(probe, metadata)` with retained metadata obtained
through the authenticated host payload channel. It checks the original sender,
recipient, subject, body and file digests before recording the production
Message-ID and payload digest in a version2 expectation. The helper does not
authenticate the metadata source or authorize Send; never use email content as
that source. Legacy version1 probes retain their strict nonce-based Message-ID.
The verifier reads only the exact recipient/sender/Message-ID query. Receipt
requires the exact body and attachment digests. Duplicate, mismatched, incomplete
and absent observations remain distinct.
It sends nothing and does not certify independent cryptographic sender authentication.
The actual recipient connector can be queried only after a real Deft probe exists.

The component milestone test joins the actual OAuth, encrypted custody, MIME
snapshot, Send adapter and verifier with explicit memory-host/provider fixtures.
The authenticated HTTP/DB connection test uses real host projection and routes
with encrypted memory custody and mocked Google endpoints. A separate real
HTTP/PostgreSQL test covers retained files, snapshots and Runtime bytes. These
checks do not prove live delivery or deployment configuration.
