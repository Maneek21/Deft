# App-neutral Host and Author Kit boundaries

Status: proposed; C/D/E are design only. Audited base:
`0d6275650d244411ed2203d561ce137a4845e0e1` (includes background-refresh PR #373).
No deployment, schema migration, SDK publication, or removal of public exports is
authorized by this plan. The separate B cleanup removes unreachable implementation.

## Outcome and invariants

Email (`Maneek21/deft-email`) should exercise the same published contracts as a
second, unrelated sideloaded app. Host owns workspace permissions, retained copies,
reviews, receipts and Calendar storage. Apps own domain parsing, presentation,
provider credentials and external effects. App names must never select authority.
Preserve org isolation, current user/employee authority, audience restrictions,
source revocation, retained-copy semantics, key retention, and historical links.

## C: app-source Knowledge and Calendar

### Existing seams

| Current code | Responsibility that must survive |
| --- | --- |
| `email-knowledge-visibility.ts`, used by agent-runner, retrieve-context and native-wiki-owner | Prevent private captured content entering shared answers; require current membership and valid employee authority |
| `email-knowledge-citations.ts`, used by wiki routes and native-wiki-owner | Authorize the retained page separately from opening its original source; route adopted sources only when active |
| `email-calendar-projection.ts`, used by Calendar and dashboard | Bounded recurrence, exceptions, cancellations, time zones and stable editable event identity |
| `email-mailbox-key-references.ts`, used by app-run-runtime | Prevent retirement of keys still protecting retained ciphertext, including disconnected accounts |
| `app-integration-source*`, `app-integration-capture*`, `app-integration-destination*` | Already implement installation/account/store source identities, current source guards, capture policies and reviewed destination receipts |
| `app-integration-calendar.ts`, `calendar-invitation.ts`, `native-calendar-invitation-create.ts` | Already import app-provided ICS into native Calendar with review, idempotency and separately reviewed reply intent |

The generic capture contracts still carry domain fields (`sender`, `folders`,
`is_bulk`, `excluded_senders`, `excluded_folders`). Merely renaming Email helpers
would leave the same coupling in place. The existing Calendar integration currently
rejects recurrence in its inspect support result; do not silently lose the legacy
projection's behavior while moving callers.

### Decision

Extend the existing integration source/destination contracts with versioned,
domain-neutral payloads and native owner services. Keep an explicit temporary
legacy adapter for retained Email data. This is smaller than a new integration
framework and makes ownership enforceable in one place.

An app callback for every Knowledge read is the alternative. Reject it: it makes
retained-copy access depend on runtime availability and invites an app to decide
Host audience policy. A blanket origin rename is also insufficient: it does not
migrate citation identity or Calendar semantics.

### Knowledge contract

1. Reuse `AppIntegrationSourceIdentity` (installation, account reference, store and
   opaque resource reference/digest). Host supplies org, owner, publication and
   authority revision; none are trusted from app presentation text.
2. Extend the existing `app_integration_capture_sources` provenance association
   and `app-integration-knowledge-citations.ts`; do not add a parallel source table.
   Version the association for legacy backfill and future source kinds. It records
   the source identity, immutable capture digest/time,
   destination page/version and declared audience. A citation ID identifies this
   association, not a provider locator. Keep workspace-native citations unchanged.
3. Centralize an `appSourceKnowledgeAudienceCondition` in native Knowledge
   ownership. Apply it to direct reads, keyword/vector retrieval, citations,
   agent prompts and final shared answers. Intersect page ACL, active org/space
   membership, current employee authority and the answer's audience. A requester's
   private page can enter their personal agent DM, never a shared answer simply
   because they can read it. A space capture is usable only in its permitted space.
4. Extend capture nominations to a versioned neutral body/digest, source title,
   observed time, grouping key, eligibility/reason and explicit completeness.
   Apps implement sender/folder/bulk rules in their own policy UI/runtime.
   Host validates destination consent, limits, delivery lease, digests and policy
   revision, and stores the authorized excerpt. Keep a bounded legacy decoder
   during migration; do not reinterpret old payloads as the new version.
5. Decorate citations only after page authorization. Use verified installed-app
   metadata for labels and Host-generated source routes. Opening a source performs
   a fresh source guard and declared navigation check. Missing/uninstalled/
   disconnected apps yield an unavailable link without erasing the retained
   excerpt or leaking locators, credentials or private account labels.

### Calendar destination contract

Extend `AppIntegrationDestinationSchema` with an explicitly versioned Calendar
destination handled by the existing native Calendar owner. The review nominates
an app source plus a normalized event: opaque source event/series key and revision,
title/body, start/end (all-day or zoned date-time), recurrence/exceptions and local
status. Initial audience is the current user's Calendar; broader audiences require
an explicit later capability. Host validates bounded sizes, dates and recurrence.
An app may produce that model from mail, bookings, travel or incident schedules.

Use the existing review/commit receipt flow: digest source publication, destination
authority, normalized event and current event revision; recheck at commit under
transaction lock. Idempotency is scoped by org, owner, installation, account and
source event identity. Replays return the original result; same request ID with
different intent conflicts. Provider updates cannot overwrite a user's local edit
without a new review. Cancellation/withdrawal is scoped to the original source
and cannot cancel another app's or a manually created event.

Extract recurrence projection into the native Calendar owner, retaining bounded
window/row/occurrence limits, DST and all-day semantics, EXDATE, moved exceptions,
cancellations and stable event/occurrence IDs. The legacy Email model gets an
adapter; new destinations do not store `email_invitation` metadata. Keep existing
ICS import working as one adapter. Domain RSVP/transport delivery remains in the
app; a local Calendar mutation never sends a provider reply implicitly.

### Migration, failure behavior and removal order

- Add contracts and adapters first. Inventory existing page origins, citations,
  adopted links, Calendar metadata and retained key references per org.
- Backfill provenance with deterministic IDs and resumable, idempotent batches.
  Preserve page ACLs, source ownership and destination IDs. Unknown legacy
  mappings fail closed; never widen an audience to make a backfill succeed.
- During rollout, read both versions through one owner service, deduplicate by
  preserved identity, and write the new version only for opted-in app contracts.
  Record parity evidence before switching agent/wiki/Calendar/dashboard callers.
- Keep old provenance and a reversible mapping until rollback and restore tests
  pass. Rollback selects the legacy reader; do not destructively rewrite payloads
  or delete keys. Migrate the shared capture budget currently stored in
  `email_knowledge_budgets` and the `email_knowledge_*` org configuration keys
  through aliases to neutral names, preserving reservations and caps. Despite its
  name, that table is already used by generic capture and is not Email-only.
  Older Host compatibility must be declared before enabling new
  writes; disabling a feature is not proof an old binary understands new data.
- Replace the key-reference import with a Host custody inventory interface whose
  providers are trusted Host storage owners. The legacy Email inventory remains
  registered until its data is migrated or explicitly purged. Never delegate key
  retention decisions to app code or omit paused/revoked/soft-deleted data.
- Retained adoption/recovery routes and their transitive Email helpers need their
  own retirement gate after migration. These designs do not make them unreachable
  today. Keep DB tables and historical migrations; evaluate drops separately.

Acceptance: a non-mail app and Email use the same source/capture/Calendar APIs;
no core caller imports an Email helper after the migration gates. Test cross-org,
cross-user, revoked membership/employee, private-to-shared answer, uninstall and
offline-runtime cases; citation retained-copy vs source access; review/commit
authority races, idempotency and local edits; recurrence/DST/cancel parity; old
link resolution, interrupted backfill, restore/rollback and key-retirement refusal.
Run these against a disposable database with representative legacy rows.

## D: remove Email-shaped Kit exports

Inventory both root and `@deft/app-kit/experience` exports. On alpha.38,
`safe-compose-html` and `mailbox-list` are exposed at the root; raster helpers are
exposed through `experience-sdk.ts`. Both entry points matter to consumers.
Also trace `runtime-authoring.ts`, `experience-capabilities.ts`, compose editor
controls, generated package declarations and CLI/conformance output. The
`SandboxEmailSend*` schemas sit alongside sandbox action/provider/automation
constants, semantic validation and conformance fixtures in `index.ts`.

| Surface | Recommended destination |
| --- | --- |
| Mailbox address parsing/formatting | `deft-email` author/runtime library |
| Native mail compose, signature/CID/inline-attachment semantics and raster profile | `deft-email` author library; a narrow generic Host rich-text validation contract remains Host-owned |
| Generic safe rich-text/URL/image validation needed by Host | Domain-neutral Kit module with explicit security tests; no import back into Email code |
| Sandbox Email send schemas, provider/action/automation templates and vectors | Optional `@deft/app-kit/examples/email` subpath, isolated from core imports, or app-owned example package |

Recommend app ownership for production Email modules and the optional subpath
only for educational sandbox fixtures. An optional `@deft/app-kit/email` for all
modules is a viable smaller transition, but it leaves domain maintenance in Kit
and is not the desired final ownership. Do not just move filenames while keeping
core transitive dependencies or Email-specific validator branches.

Compatibility sequence:

1. The external app package currently pins the local tarball
   `file:deft-app-kit-0.1.0-alpha.38.tgz` (inspected 2026-10-20).
   Pin and test that published alpha.38 consumer baseline, including Email's build
   and runtime imports from both root and `/experience`. Audit external
   `Maneek21/deft-email` independently of the in-repo historical example.
2. Add app-owned replacements and the optional example subpath with parity tests.
   Separate Host rich-text safety enforcement before removing compose helpers;
   Host must still reject unsafe app output independently of the app's parser.
3. In a future additive Kit alpha, mark old root/experience names deprecated and
   keep compatibility re-exports for a documented transition window. They remain
   explicit boundary exceptions during that window. Migrate Email imports/build
   and example consumers, then certify packed artifacts, not workspace aliases.
4. Remove compatibility exports only in a separately announced breaking alpha
   release. State its exact version/window when scheduling that release; this PR
   assigns neither. Pin alpha.38 consumers until migrated. Updating past removal
   without changing imports causes TypeScript missing exports and ESM import
   errors even though the package is prerelease. Do not republish alpha.38.
5. Treat author-library changes separately from Host wire/protocol versions.
   Already-built artifacts can continue only if their serialized contracts are
   unchanged and accepted by the target Host; test this, including bundled versus
   external SDK imports. Rollback restores previous app/Kit artifacts without
   weakening validation or requiring a data migration.

Acceptance: packed alpha.38 fixture still builds during the transition; migrated
Email builds using public app/Kit entry points; non-mail app build never imports
mailbox/sandbox-send code; post-removal exports and dependency graph contain no
compatibility leak. Preserve XSS, URL, malformed address, inline file/CID, image
limits and rendered-output parity tests at their new owners. No Kit version bump
or code move is part of this docs PR.

## E: proposed CI boundary gate

Add a future `check-app-boundary` job before expensive builds. This PR specifies
it only. Its full-tree scan covers Host API/web source, core shared contracts,
core Kit entry points and their transitive imports, including generated build
declarations. Also scan tests/scripts/workflows for Host import references; keep
example fixtures a separate explicitly reviewed scope, not a route back into core.

Fail on case-insensitive Email-named path segments (including `email`, `emails`,
`native-email`, `email-*`) or new mailbox-specific tokens: `mailbox`, IMAP/SMTP
protocol identifiers, `email_accounts`, `email_messages`, `email_invitation`,
`email_knowledge_auto`, `/api/email`, `SandboxEmailSend`, mail-provider IDs and
the native-compose/safe-compose/mailbox-list module family. Scan added/renamed
files and changed content, but validate the complete tree against a baseline so
renames, existing files and imported optional modules cannot bypass the check.

Do not ban ordinary authentication/contact email fields, `z.email()`, `mailto:`
links or transactional notification delivery. Specify patterns narrowly and
allow exact legitimate matches with a reason. Historical DB schemas/migrations,
retained adoption/key inventory, reviewed fixtures, and temporary compatibility
exports require explicit records; no blanket `apps/api/**` or whole-core carveout.

An allowlist record contains exact path + rule + matched token/context digest,
reason, owner, tracking issue and review/removal milestone (legacy migrations may
have permanent historical status). Reject missing, stale, duplicate and changed
entries; never automatically bless the current scan. Baseline B's remaining
dependencies, then shrink exceptions after C/D; unrelated new matches still fail.
Changes to the allowlist require ordinary code review with before/after findings.

Use AST import/export traversal as well as text scanning: core cannot import an
optional Email subpath directly, through a barrel, literal dynamic import or a
renamed neutral-looking wrapper. Flag computed imports for explicit review;
preserve the approved hash-pinned generic external-runtime loader boundary.
Report file/line, rule, matched token and applicable exception.

Gate fixtures must prove rejection of an Email filename, a mailbox string added
to an existing neutral file, case/rename bypasses, barrel/dynamic import leakage,
and stale/broadened exceptions. Positive fixtures cover normal login email,
Contacts, retained migrations and a self-contained optional example. Run the gate
on PRs and master with no secrets/network and document how to add a justified
exception. It supplements security/behavior tests; it cannot prove semantic
neutrality by vocabulary alone.
