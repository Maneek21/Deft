# Email launch Stage 0 contracts and decisions

Prepared on 30 September 2026 against `0c611bb4b1a000e8b4a066f71974137e5c0f31cd` on `codex/email-wip-example`. These are the minimum implementation contracts for X01–X06, not shipped SDK exports or a provider certification. [Stage 0 handoff](../plans/2026-09-30-email-launch-stage0.md) records checks, ownership and blockers.

## Boundary and data flow

The host owns authentication, connection custody, current authority, file handles, trusted controls and action receipts. Email owns provider semantics, logical mail identity, conversation assembly and mail presentation, using declarative modules or governed capabilities. Keep mail-specific records out of bespoke core tables. Workers receive bounded typed references and purpose-specific runtime credentials; they never receive owner Web tokens or provider secrets through the Experience bridge.

```text
Authenticated owner -> trusted host account selection / draft controls
                    -> current account + binding authority
                    -> immutable outgoing snapshot -> exact Send authorization
                    -> governed run -> selected adapter -> provider
Scoped sync service -> same account mapping -> lazy private mail index/files
Untrusted mail      -> bounded parsing -> safe host reader / selected AI context
```

Request-supplied organization, owner, account, message and file IDs only nominate resources. Every lookup rederives membership, ownership, installation/version/grant and current binding authority server-side. No identifier is a grant. Revalidate on read, snapshot creation, confirmation and dispatch/claim. Revocation stops future dispatch; it cannot reverse a provider effect already accepted.

## Minimum DTOs

The following field sets are agreed for the first journey. Names are design DTOs until the lead introduces strict versioned Zod contracts in the Kit/host. Keep existing v1 consumers working; new rich behavior requires an explicit capability/version. IDs are opaque host-issued strings, bounded at the public parser; fixture scenario labels are not production IDs.

| DTO | Required fields and behavior |
| --- | --- |
| Account view | `account_id`, display label, primary address, provider kind (`gmail`, `microsoft`, `imap_smtp`), connection health, verified sender identities and supported capabilities. Scope internally includes organization, owner, installation, connection target, resource/action binding and authority epoch. Do not expose tokens or accept a caller-supplied binding as authority. |
| Message summary | `logical_message_id`, `account_id`, `conversation_id`, sender/recipient display, subject, received/sent time, folder/label memberships, flags, body/file availability and per-message failure. Detail references are lazy. Counts and freshness describe their actual coverage; they are not totals inferred from one page. |
| Provider locator | An account-scoped tagged value: Gmail message/thread/label IDs; Graph message/conversation/folder IDs; IMAP mailbox, UIDVALIDITY and UID. Provider Message-ID/References/In-Reply-To are evidence, not globally unique keys. A logical message can have historical/current locators. |
| Conversation page | `account_id`, stable conversation ID, ordered message summaries, opaque cursor, completeness/freshness and individual failures. Fetch across supported folders/pages, including Sent. The unified inbox aggregates account-scoped conversations; equal subjects or Message-IDs never merge accounts. |
| Draft | `draft_id`, `account_id`, revision, compose/reply/reply-all/forward mode, verified sender identity, ordered To/Cc/Bcc address lists, subject, body reference and format, file references, optional logical reply parent, saved time and lifecycle. Persist through reload. Saves use compare-and-swap revision; an old autosave cannot resurrect a submitted draft. |
| File handle | `file_id`, owning account and authorized message/draft parent, filename, media type, byte count, immutable content digest, availability/scan state and expiry. Host verifies finalized bytes, parent access and account before download or snapshot use. Cross-account attachment copying requires an explicit authorized import into the destination draft. |
| Outgoing snapshot | Host-issued `snapshot_id`, draft/revision, account and verified From identity, all To/Cc/Bcc, subject, body bytes/format/digest, ordered immutable file handles/digests, reply headers and timing. Immutable after creation. Any edit creates a new snapshot and invalidates the old Send preparation. |
| Action preparation | Exact snapshot reference/digest plus durable idempotency key. The trusted host resolves and displays sender, recipients, content and files; confirmation binds the resolved payload and current authority. An opaque reference alone is not an adequate human review surface. |
| Operation status | Durable operation/run ID, account, snapshot digest, transport outcome, Sent-copy outcome, independently observed delivery status if available, reconciliation state and safe available actions. `unknown` survives restart/history eviction. Activity is a view, not the authority for draft terminal state. |
| Sync service grant | Organization/owner/installation/account/binding, permitted read/sync/file operations, authority epoch, expiry, cadence/budget and revocation. No Send, workspace administration, another account or private AI sharing by implication. Cursor/checkpoint and worker journal are account-scoped. |

Address lists must use a strict typed mailbox representation with a display name separated from the validated address; reject control characters/header injection. Deduplicate reply candidates without revealing received Bcc. Exclude the selected account's verified own addresses from Reply all. Provider-returned sender aliases require validation; typing a From address cannot authorize send-as. Large bodies and file bytes stay outside the bounded Worker message transport. Limits are declared by the host capability and provider, checked before effects, and displayed honestly. Do not silently truncate recipients, body or subject.

Draft states for the first journey are `editing`, `submitting`, `submitted`, `failed` and `uncertain`. A definite failure can return to editing through an explicit revision transition. An uncertain operation remains pinned for reconciliation; another click must not reserve another send. Scheduled/undo-send/outbox states extend this in X11, preserving the same immutable payload and idempotency guarantees.

## Architecture decisions

### A01 Account routing and identity

Use an Email-owned logical index with generic host connection custody and account-target routing. Keeping raw folder/UID projections would require less code, but breaks moved-message links and complete conversations. Installing one Email app per account avoids one collision but fragments drafts/settings and does not meet the multi-account promise.

Current `connectedAccounts` has a unique `(user_id, provider)` index (`packages/db/src/schema.ts:3768`), so it cannot represent two Gmail connections. Resource consent also has one current binding per owner/resource key (`:2481`). `apps/api/src/lib/app-experience-exposure.ts:65` selects exactly one runtime binding for an action. Do not append an unchecked `account_id` scalar to the current action or relax these uniqueness/authority checks in isolation.

The lead will first prove a generic mapping from a selected account to its owner-scoped resource/action target. Extend or replace the legacy connection boundary only after auditing its callers and uniqueness assumptions. Email maintains the mail index under the governed module boundary. Use authoritative provider move/copy results to update locators, preserve old links as aliases and treat ambiguous matching conservatively. A subject or Message-ID match alone never authorizes a merge.

Proof: two same-provider accounts route independently; revoking one does not change the other; a moved IMAP message retains its logical/task link; an expired cursor rebuilds without silent loss or cross-account deduplication.

### A02 Trusted rich controls and files

Add the smallest generic trusted host controls for recipient lists, body editing, safe mail documents and typed files. Reuse Deft's editor pieces, overlays and attachment presentation in the host, with Email-specific behavior in the app. A fully bespoke native Email package increases core coupling. An unchecked JSON string in a scalar input evades the current validation boundary.

The current Runtime input schema accepts scalar properties only (`packages/app-kit/src/runtime-authoring.ts:6`); the bridge has a 64 KiB message cap and bounded strings (`apps/web/src/lib/app-experience-bridge.ts:40`). The renderer uses plain inputs/text content. Email currently has a 4096-character plain body and no outgoing files. The Kit attachment media schema excludes PDF. These are current limitations, not reasons to disable bounds or inject arbitrary HTML into the Worker DOM.

Use lazy host-owned bodies/file handles and a versioned safe-document reader. Sanitize active content, isolate its execution context, block remote images/tracking by default and keep navigation explicit. Host-side file import/download must preserve parent access, byte/digest checks, media validation and declared limits. PDF support requires the Kit, broker, storage and viewer contract to agree; changing the example allowlist alone is insufficient.

Proof: the hostile fixture cannot execute scripts, event handlers or unsafe URLs; it cannot trigger automatic remote requests or actions. The PDF opens/downloads through owner/account checks. Rich input respects bridge budgets, and inaccessible or expired files cannot be substituted at Send.

### A03 Exact outgoing snapshot and human Send

Use a host-resolved immutable outgoing snapshot rather than carrying all body/file bytes through expanded scalar input. Typed bounded inline inputs remain adequate for small existing v1 actions; keep that compatibility path. The snapshot reference must resolve to the exact trusted preview and dispatch payload.

Preserve the existing one-click human Send/Reply: the host composer already prepares a sealed ticket and confirms/releases the run inside current authority checks (`apps/api/src/lib/app-experience-human-action-service.ts:100`). Do not add a second approval queue for this direct human action. Include account, sender identity, every recipient, content, file digests, revision and timing in the resolved payload digest; maintain ticket/session/current grant checks and durable run idempotency. Agent sends remain governed by the explicit agent/action policy and reviewed exact contents.

An SMTP acceptance receipt is not delivery proof. Provider acceptance, delivery evidence and Sent-copy outcome remain separate. A lost acknowledgement produces an uncertain operation and reconciliation, never an automatic resend. Reconciliation may compare provider-specific stable operation/message evidence; absence from Sent is not proof that no send occurred.

Proof: changing account, From, Cc/Bcc, body, file bytes or revision after preparation fails; replay cannot duplicate the effect; acceptance with lost Sent-copy/result acknowledgement stays understandable and recoverable without a second transport call.

### A04 Background service authority

Use revocable account/binding-scoped service authority and supervised token refresh. Retaining an owner bearer for a daemon is simpler initially but gives the wrong trust and expiry boundary. Do not extend owner sessions indefinitely or label service/agent actions as trusted human clicks.

App read consent, runtime operation authority and private AI/MCP context are distinct. Ordinary human mail should not require redundant approvals; agent access should not inherit human access. Keep default deny/ask for agents, selected private context, explicit renewal and current revocation. Human Archive becomes a direct trusted reversible operation in X07; permanent deletion retains a specific destructive confirmation. Technical consent refresh must preserve the durable grant instead of prompting every minute.

Proof: service restart resumes a checkpoint; refresh cannot broaden scopes; a revoked account stops future claims and disclosure; no service grant sends mail, reads a second account, changes workspace administration or shares mail with AI.

## Migration, rollback and implementation gate

Stage 0 makes no production schema or permission changes. In X01–X03 introduce capabilities and schema through expand-and-contract migrations: backfill the existing single-account configuration into the new account target, preserve legacy resource IDs/links as aliases, preserve drafts/history/unknown operations and keep v1 consumers readable. Audit legacy connection callers before changing the unique index. A new account target needs matching foreign-key and authorization scope, not only a broader uniqueness constraint.

Use `pnpm db:push-full` for a verified empty disposable database, and `pnpm db:upgrade` for supported existing deployments. Test fresh and supported upgrade paths before enabling new writes. Rollback disables unsupported new capabilities/writes and retains the expanded data for safe roll-forward; it does not delete accounts, draft revisions, receipts or uncertain operations. Do not reuse a published Kit version for changed bytes.

X01 must prove A01's routing spike before parallel adapters depend on it. X03 must prove A02/A03's bounded control and snapshot spike before rich Send is exposed. A04's supervised service proof precedes real background operation. Fixture-backed UI can use these DTOs meanwhile; it cannot label the underlying behavior implemented. DB-backed tenant, owner, revocation and concurrency tests remain required once the disposable database is ready.
