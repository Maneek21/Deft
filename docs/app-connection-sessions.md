# Generic external connection sessions (candidate)

Author Kit alpha.32 supplies the closed public connection v1/v2, independent
action-consent, upgrade/reattachment, consent-continuation and credential-repair
contracts. The matching Host PR implements the corresponding current-authority
routes; the Kit cannot grant custody, consent, Send permission or execution.
Connection v2 binds independently reviewed actions to the current owner/resource
session. Foreground resource reads and reviewed App Runs use separate governed
channels; a profile's ordered `action_keys` alone grants neither.

For the external Email browser alpha.30/Runtime E5.9 alpha.32 enrollment, use the
[exact reviewed setup](https://github.com/Maneek21/deft-email/blob/4c33dca127f799ff43a318625319808266799366/docs/setup.md).
Its registry explicitly sets `connection_protocol: "v2"`, profile key
`gmail_readwrite`, provider `gmail`, and ordered actions
`mirror_drafts`, `organize_messages`, `send_message`. Runtime connection transport
is HTTPS `/v1/connections`; the protocol7 Host channel at
`/api/app-runtime/channel` has a different purpose. Use actual public signup,
installation/grant/admission/resource/action/session responses, not demo IDs or
copied authority. Private draft store consent is separate from account custody.

The registry below documents the earlier v1 read-only shape. It is not the Email
v2 enrollment recipe; omission of `connection_protocol` selects the legacy
contract. Provider credentials remain in the independent Runtime, never in the
Host, App bundle or browser. No provider adapter is added to the Host.

## Deployment review

Enable the existing App/attachment/runtime/owner-connection feature gates. Set
`DEFT_APP_CONNECTION_HTTP_CONFIG` to an absolute path containing private,
deployment-reviewed data with this shape (all example IDs/keys are placeholders):

```json
{
  "schema_version": "deft.app_connection_http_registrations.v1",
  "entries": [{
    "org_id": "<organization UUID>",
    "installation_id": "<installed App UUID>",
    "runtime_registration_id": "<owner resource registration UUID>",
    "runtime_epoch": 1,
    "profile": {
      "schema_version": "deft.app_connection_profile.v1",
      "key": "google_mail",
      "provider_id": "google_mail",
      "operator_user_id": "<current human operator UUID>",
      "runtime_requirement_key": "sync_provider",
      "resource_key": "inbox",
      "action_keys": [],
      "authorization_origin": "https://accounts.google.com",
      "credential_custody": "runtime",
      "executable": false
    },
    "endpoint": "https://<reviewed runtime>/v1/connections",
    "runtime_auth_token": "<independent random base64url token of at least 32 bytes>",
    "authority_token_sha256": "sha256:<SHA256 hex of independent runtime authority token>"
  }]
}
```

POSIX file access must exclude group/other permissions; use restricted Windows
ACLs on Windows. Never put these transport credentials in App bundles, browser
configuration, provider profile responses or source control. The endpoint must
be HTTPS, with exactly `/v1/connections`, no userinfo/query/fragment and no
redirects. Provider secrets stay in the independently operated runtime.

The App's `owner_connections` declaration nominates the profile key and runtime
requirement. The existing public `/api/app-owner-connections/admissions/review`
and `/activate` routes require admin review of exact installation/version/grant
pins, profile and a transport digest. The digest includes the endpoint and
directional transport credential digests. Configuration alone grants nothing.

After admin admission, the owner uses the existing resource review/activation
routes. They issue a per-owner registration ID; bind that ID and its current
epoch in the deployment registry before connection setup. The initial registry
may carry a reserved UUID while admin/profile review occurs. Registration ID and
epoch are checked against the real owner binding on every connection operation.
Multiple owner/account registrations may share the same profile/operator only
when their reviewed profile and transport digests are identical. Each
registration/epoch pair remains distinct; ambiguous or conflicting entries fail.
Changing the profile, endpoint or transport credentials requires renewed admin
admission and owner consent. Removing the configuration immediately fails
current authority checks; it does not delete retained sessions or Email data.

## Public routes and runtime boundary

All bodies are strict public Kit schemas. Browser operations use the exact
human web-access bearer, checked against the current SID and membership:

Both audiences require the current App and owner-connection rollout flags and
have separate process-local socket-peer/global limits of 600 requests per
minute. Human management allows 32 concurrent requests globally; runtime
authority allows 60. Each audience allows 16 concurrent requests per socket
peer and bounds peer buckets to 1,024. Forwarded headers and credential rotation
cannot create new buckets. Runtime checks do not consume the human budget.

| POST route under `/api/app-connection-sessions` | Body |
| --- | --- |
| `/begin` | `{ installation_id, target_key }` |
| `/callback` | `{ session_id, state, outcome: "authorized", code }` or `{ session_id, state, outcome: "denied" }` |
| `/status` | `{ session_id }` |
| `/disconnect` | `{ session_id }` |

The owner application uses the returned authorization URL and callback state,
then submits the callback through its authenticated host UI. Provider callback
codes are never stored in the host session table. Callback state is retained only
as SHA256 and atomically consumed before provider IO. This API does not accept a
provider webhook as human authority or forward a host cookie/bearer to runtime.

The host sends `AppConnectionRuntimeRequestSchema` JSON to the configured
endpoint with `Authorization: Bearer <runtime_auth_token>`. Runtime authenticates
that token, then calls `/api/app-connection-sessions/runtime/authority` with its
distinct authority token and `AppConnectionRuntimeAuthorityRequestSchema`.
Successful introspection returns the exact session/operation/scope envelope plus
`allowed: true` and a possibly shortened expiry. Runtime must recheck before
provider IO and before disclosing results. The authority token grants only this
introspection operation for its configured registration/profile/epoch.

The host bounds runtime IO to 30 seconds and earlier current web/owner expiry;
callback lifetime is at most ten minutes. JSON input/output is at most 16 KiB,
request reads at most ten seconds. Responses are strict Kit results, without
provider tokens or URLs containing credential query fields. Redirects fail.

## Durable state and migration

### Reviewed account continuity across app upgrades

An upgrade changes the current package, grant and resource binding. A connected
historical session can nominate the same runtime-owned account for a new reviewed
session; it cannot supply current authorization. The host and runtime must both
support `deft.app_connection_reattach_runtime.v1`. This is upgrade continuity for
app-owned custody, not adoption of retained native Email data.

| POST route under `/api/app-connection-sessions` | Body | Purpose |
| --- | --- | --- |
| `/reattach/review` | `{ installation_id, target_key, source_session_id, request_id }` | Resolve the historical account and prepare a short-lived current-scope review. |
| `/reattach/activate` | `{ session_id, review_digest }` | Advance exactly the reviewed custody generation once. |
| `/reattach/status` | `{ session_id }` | Resolve this durable operation without repeating activation. |

The reviewed account must retain its organization, owner, installation, target,
resource, operator, provider profile, deployment transport and credential-holder
identity. The independent runtime retains the provider token; the host receives
only opaque account/session references and generation/digest receipts. Current
read consent and any separately granted action consent are independently checked.
Old grants, old data authority and old Send channels are never copied forward.

The host writes the new operation before contacting the runtime. Activation uses
the exact review digest and runtime compare-and-set generation, with a durable
receipt. Pending or unknown provider effects fence account movement; a completed
Send remains historical and is not replayed. After a lost acknowledgement, use
the same session's status. Status may resolve a retained receipt after the short
review expires, but still requires current owner, session, installation, grant
and operator authority. It cannot activate, reseal or repeat provider work.

The runtime validates the exact envelope against the separate
`/api/app-connection-sessions/runtime/reattach-authority` audience. Prepare and
activate cannot exceed the review deadline or current consent; read-only status
is bounded by current consent. The original source and review remain immutable.
No browser OAuth code, provider token or host cookie is part of this protocol.

Preview97 adds validation to the retained connection-session record rather than
rewriting historical sessions. Its initial slice rejects same-version
reattachment. Background synchronization, delegated actors and historical native
account adoption require their own current authority and acceptance evidence.
These candidate interfaces are not a claim of public release or deployed parity.

`app_connection_sessions` persists before IO. All reads and atomic revision CAS
scope by organization, owner and session. The database guard preserves authority,
profile and hashed callback identity while permitting each newly authorized
operation to bind its current SID/access deadline. Crashed/inflight or unknown
effects remain indeterminate and cannot be replayed by status or service restart.

Append-only preview94 adds this dormant table and updates the latest preview60
grant/admission validation functions to recognize closed external profiles.
Historical migration SQL stays unchanged. The current review stack targets
schema117; the image metadata preview16 is not the schema head. A matching fresh
schema/production-seed rehearsal has passed. The fresh public Email
sideload/OAuth/visible journey is still a separate acceptance gate, and package
or schema validation does not authorize an existing account move. Native-history
inspection and App private-state adoption are separate explicit contracts; no
old grant or native account authority is inferred from retained bytes.
