# Email-owned OAuth and credential custody

These server modules implement Gmail and Microsoft delegated authorization-code
flows, provider identity verification and encrypted access/refresh custody. They
fit the existing supervised `getAccessToken({scope,account,account_id,operation,
authority_epoch})` port. They send no mail. They are independent of workspace
login OAuth, which remains retired. Host HTTP/UI integration and deployment OAuth
registration are separate requirements; this document does not claim a completed
Deft connection or live delivery.

## Decision and trust flow

The smallest adequate design keeps provider behavior inside Email and injects
current generic host authority plus durable storage. Browser IDs nominate an
account. The authenticated host resolves organization/owner/installation, stable
account/provider/target, binding IDs, reviewed capabilities and authority epoch.
The browser follows a fixed provider authorization URL; its callback carries a
random one-use state and code. The server consumes browser/owner-bound state,
uses its encrypted PKCE verifier, reads identity from the provider, and persists
an AES-256-GCM envelope with exact account-binding associated data.

A shared generic credential framework would add core interfaces before a second
consumer needs them. Reusing retired workspace OAuth would couple mailbox grants
to login. The Email modules avoid both changes, require no schema migration or
new dependencies, and can be removed without affecting workspace authentication.
Rollback must retain ciphertext, replay tombstones and encryption keys; replacing
code does not justify replaying a consumed callback or an uncertain refresh.

## Host contract

`createEmailOAuth({clients,host,custody,fetch?,now?})` exports:

| Method | Input and result |
| --- | --- |
| `begin` | `{scope,account_id,browser_binding}` -> `{authorization_url,expires_at}` |
| `complete` | `{scope,state,code,browser_binding}` -> verified standard `EmailAccount` descriptor, no credentials |
| `getAccessToken` | existing supervised request above -> bearer bytes only to the trusted provider service |
| `disconnect` | `{scope,account_id}` -> local revoked health; no provider request |
| `revokeProviderGrant` | separate explicit `{scope,account_id}` operation; fences local custody first, then one Google project-grant revoke or Microsoft portal instructions |

`host.resolveAccount({scope,account_id,purpose})` must authenticate the calling
human/runtime independently of these input IDs and return this exact binding:

```ts
type EmailOAuthBinding = {
  scope: { org_id: string; owner_id: string; installation_id: string };
  account_id: string;
  provider: 'gmail' | 'microsoft';
  connection_target: string;
  resource_binding_id: string;
  action_binding_id: string | null;
  authority_epoch: number;
  capabilities: ('read' | 'search' | 'thread' | 'send')[];
};
```

`host.assertAuthority({binding,purpose})` must rederive the exact current target
and named-purpose consent and return `{allowed:true,expires_at:number}` with a
trusted Unix-millisecond deadline. Purposes are `connect`, each mail operation,
`disconnect`, and the separately authorized `revoke_provider_grant`. No default
permissive port exists. The captured deadline never extends during an operation;
checks follow provider I/O, ciphertext writes and lock release before delivery.
Host endpoints parse external inputs with existing Zod contracts and return the
existing `{error,code}` shape. Email's strict bounded validators follow its
dependency-free account/provider contract; provider descriptions and raw errors
never enter errors or logs.

The current Sync v3 SDK claim/start/heartbeat contract alone cannot implement
these host ports. `resource-sync-client-v3.ts` supplies `org_id`, installation,
runtime registration/epoch, resource binding, attempt and lease, but does not
attest current `owner_user_id`, `target_key`/connection target or the Email account
`authority_epoch`. A deployment map is a reviewed nomination, rather than a fresh
host attestation of those missing fields. Do not equate `runtime_epoch` with the
account epoch or infer current ownership from mailbox metadata/config. No
`oauth-sync-custody` adapter is supplied: a reviewed opt-in host custody projection
of exact current owner/target/account epoch and named read purpose is required
before automatic supervised OAuth refresh can be connected to that SDK alone.
The existing injected custody seam remains compatible when backed by independent
trusted authority satisfying the contract above. Browser onboarding additionally
requires its own authenticated connect purpose; a Sync lease cannot provide it.

The binding's capabilities are the reviewed ceiling. Returned account capabilities
are their intersection with verified provider scopes. Keep those roles distinct:
scope reduction cannot grant authority and need not destroy still-usable reads.
The host must maintain stable account IDs/provider/target as enforced by
`EmailAccountRegistry`, advance epochs for reviewed reconnection, and reject
foreign owner/target/runtime sessions. Use its existing trust, approval and receipt
boundaries for actions; an OAuth connection never authorizes Send by itself.

`browser_binding` must come from the host's authenticated secure browser session
or host-generated HttpOnly setup cookie, including session revocation/expiry. Do
not accept a Worker-supplied browser binding as authentication. Apply normal host
CSRF/origin protection, callback/no-store/referrer policy, state initiation quotas,
bounded callback parsing and safe navigation. A denied provider callback should
burn the matching state through `custody.takeState` under the same authenticated
browser binding; it must not guess an account from `login_hint`, email, code or
token claims.

## Deployment configuration and provider behavior

The operator supplies confidential web clients outside source control:

```js
const clients = {
  gmail: {client_id, client_secret, redirect_uri, verify_aliases: true},
  microsoft: {client_id, client_secret, redirect_uri, tenant: 'common'},
};
```

Redirects must be registered exactly, HTTPS except explicit loopback development
HTTP. The tenant is deployment-owned `common`, `organizations`, `consumers` or a
UUID; callers cannot supply provider URLs. Microsoft registration must support
the intended personal/work account audience and use a confidential **Web** redirect,
rather than a browser SPA redirect. Enable Gmail API, configure the Google consent
screen/test users and any required verification, configure delegated Graph
permissions/admin consent where applicable, and keep client secrets on the server.
These external prerequisites have not been completed by the module tests.

Gmail requests `openid email gmail.readonly` plus `gmail.send` when Send is reviewed.
Its profile endpoint requires a mailbox read scope; a send-only Gmail binding is
rejected. Gmail primary identity requires fixed userinfo `sub`, verified email and
a matching `/users/me/profile` address. Optional alias reads accept only
`verificationStatus: accepted`; `gmail.readonly` already permits this read, so no
settings-write scope is added. Microsoft requests `offline_access User.Read`, plus
reviewed `Mail.Read`/`Mail.Send`, and verifies fixed Graph `/me` `id` and `mail`.
UPNs, proxy-address lists and caller assertions do not verify Microsoft SendAs
aliases. A missing Graph mail address fails onboarding; additional governed alias
verification remains outside this implementation.

The code uses S256 PKCE plus client authentication. Google requests offline access
and explicit consent/account choice to obtain a new refresh grant; Microsoft
requests offline access explicitly. Token scopes omitted by a compliant response
retain the verified request/prior scope set under RFC6749; returned scopes are
normalized only for the fixed known permissions. JWT/ID-token claims are never
used as account or host authority. Reconnect requires the same provider subject,
including after local disconnect; a changed deployment registration needs a fresh
flow and still must verify that subject. Refresh rechecks identity, rotates any
returned refresh token, and retains an existing refresh token only when the
provider omits a replacement.

Before one refresh, custody durably records `refresh_pending`. Provider error,
lost response, failed identity check or failed persistence is fail-closed:
`reauth_required` discards token bytes when a write is possible; a surviving
pending marker also requires reconnect. Concurrent service instances use the
same fenced account lock and observe the settled credential instead of refreshing
again. Ordinary disconnect discards credentials locally while retaining encrypted
identity continuity; it leaves other account keys alone. Google remote revoke
removes a wider project grant and is a separate explicit operation. Microsoft
returns fixed personal/work portal instructions and makes no invented per-token
revocation call. Unknown remote revoke is not retried by the module.

Each `begin` advances a durable per-account setup generation and captures it in
encrypted one-use state. Callback consumption checks that generation under the
same account lock **before** code exchange. Local disconnect and explicit grant
revoke advance it atomically with credential discard, even if broader host consent
and its epoch remain active. A newer begin also supersedes earlier callbacks.
Starting setup preserves the previous credential binding until a verified
reconnect; it cannot silently rebind old tokens to a new host epoch. Generations
survive durable reopen and are authenticated even for empty/revoked accounts.

## Encrypted and durable storage

`createEncryptedEmailCustody({encryption_key,key_id,store,now?})` requires a 32-byte
server key and a configured key ID. It stores only bounded encrypted secret
payloads. Canonical key-sorted AAD includes schema/purpose, complete binding/epoch,
state digest, browser-binding digest/expiry for state, and health/setup generation
for account custody, so opaque JSON key reordering does not break decryption. All
account rows use an authenticated encrypted nullable-credential wrapper; an empty
credential set does not leave its lifecycle metadata unauthenticated. Tokens,
PKCE verifiers, provider subject, verified addresses and labels are encrypted.
No token belongs in an Experience/browser/private App state or a log. Keep the
key with protected backups; missing/wrong key IDs fail closed. Automated key
rotation, backup/restore and production loss recovery are not certified here.

The `EmailCustodyStore` JSDoc in `custody-encrypted.mjs` describes opaque persisted
objects and this port:

```ts
withLock({key}, async tx => {
  const row = await tx.read(); // null or {revision:number,value:opaqueJSON|null}
  const committed = await tx.compareAndSwap({expected_revision:row?.revision??null,
                                            value:opaqueJSON}); // boolean
});
```

Every successful CAS must commit durably **before** returning while a fenced
cross-process lock remains held. A delayed-commit database transaction around
the entire callback is insufficient: a crash after provider refresh must retain
the already-acknowledged pending marker. Null values are durable replay tombstones.
Do not delete/reuse them as part of routine connection setup. A reviewed DB
implementation must enforce this contract and tenancy rather than exposing raw
ciphertext storage to the browser.

`await createEmailFileCustodyStore({root})` is a concrete implementation for an
absolute, canonical, service-owned private POSIX directory on a local persistent
filesystem. It creates only the nominated final directory/children at 0700, files
at 0600, rejects permissive existing roots, symlinks/hardlinks, traversal keys,
network/DrvFS/tmpfs roots and non-envelope payloads, and writes atomically with
file and directory fsync before CAS acknowledgement. Store filenames contain only
fixed prefixes and SHA256 account/state keys. A random owner nonce fences each
cross-process directory lock; default lock lifetime is 120 seconds and bounded wait
is 15 seconds. Expiry/process death never grants takeover. Windows is explicitly
unsupported by this file store because parent-directory fsync cannot be promised;
Windows hosts must inject a reviewed durable DB store or run custody on Linux.

For an orphan lock, an operator must first prove the owning service/process cannot
resume, inspect the exact private root/owner nonce and durable row, then remove
only that exact orphan. Preserve any `refresh_pending` row and require OAuth
reconnect. Do not remove a lock based on its age or reuse its refresh token. Failed
fsync/fence checks can retain a lock even if data was committed; do not infer
provider failure or credentials from a missing acknowledgement. Root capacity,
retention/tombstone cleanup, encryption-key backup and deployment rollback remain
operator policies that require review; the module does not auto-delete uncertain
credential history.

## Fresh evidence and limits

Run `node providers/test-custody-posix.mjs` from the Email directory for combined
evidence; the wrapper refuses Windows rather than treating skipped storage tests
as a pass. `node --test providers/oauth-account.test.mjs` runs the portable mocked
provider suite on either platform. Provider tests use injected mock HTTP only. Store tests
use private temporary files and real child processes, including SIGKILL after the
durable refresh marker; test cleanup verifies its exact temporary-root boundary.
POSIX tests skip on Windows, and the Windows guard proves its explicit refusal.
Full no-skip storage proof was executed in the existing WSL distro with portable
official Node 24.14.0; its Linux-x64 tarball SHA256
`41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df`
matches the official distribution checksum. No package/system install or database
change was needed. Host HTTP/UI, live provider registration, callback/refresh
provider acceptance, Send/delivery, power-loss and production backup/restore still
require their own evidence.

Final focused evidence: Linux combined wrapper **39 passed, 0 failed, 0 skipped**;
Windows portable OAuth suite **30 passed, 0 failed, 0 skipped**. Linux proof used:

```powershell
wsl.exe -d Deft-CRM-Test --cd /mnt/c/tmp/deft-gate-g-integration-20260924/examples/apps/email -- /tmp/deft-email-oauth-test-node-v24.14.0/node-v24.14.0-linux-x64/bin/node providers/test-custody-posix.mjs
```

The independent review reproduced a revoked account becoming connected after an
old callback while host epoch remained unchanged. Setup generation now rejects
that exact case before any token exchange, and the real-file reopen/race tests
preserve revocation. Review also caught the wrong Microsoft organizational revoke
portal; tenant routing now tests consumers, organizations, tenant UUID and common
using fixed labeled portals and no network revocation call.

## Official references checked 2026-09-30

- [Google web-server OAuth/offline access and project revocation](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google's PKCE verifier/S256 protocol parameters](https://developers.google.com/identity/protocols/oauth2/native-app#step1-code-verifier) (documented for installed apps using the same endpoints; this confidential deployment still needs live callback certification)
- [Google OpenID userinfo/discovery](https://developers.google.com/identity/openid-connect/openid-connect)
- [Gmail profile scopes](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)
- [Gmail SendAs list read scopes](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs/list) and [verification status](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs)
- [Microsoft confidential authorization-code/PKCE and refresh protocol](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Microsoft refresh-token rotation/expiry](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)
- [Graph delegated /me identity permissions](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0)
- [Microsoft work/school consent revocation](https://support.microsoft.com/en-au/accounts-billing/work-school/edit-or-revoke-application-permissions-in-the-my-apps-portal)
- [RFC6749 response scopes and refresh-token replacement](https://www.rfc-editor.org/rfc/rfc6749)
- [Official Node 24.14.0 checksums](https://nodejs.org/dist/v24.14.0/SHASUMS256.txt)
