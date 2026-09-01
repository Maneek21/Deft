# App Platform Phase 5 — Connected grants and App-origin actions

| Field | Value |
|---|---|
| Status | PR C merged at `161ca65f`; Loop 7 local and exact-merge CI passed; immutable non-publishing release-host certification remains |
| Base candidate | Merged Phase 4 commit `ec79592e669bdf915fad8a5d2480f0625d819a4c` |
| Outcome | One installed App can request, receive, expose, and invoke one exact governed capability through the same host-owned path on every interactive actor surface |
| Proof | Campaign resource + selected Contact resource -> approved sandbox MCP email -> one App Run, provider call, receipt, and result identity |
| Exclusions | Automation, schedules, bulk/newsletter delivery, sync, runtimes, custom UI, public ingress, marketplace, billing, and SaaS control plane |

## Why this phase exists

Phases 1–4 provide deterministic declarative Apps, provider-neutral capability
discovery/execution, governed Runs, and live-authorized resources. The missing
link is installation-scoped authority. An App still cannot ask for an external
capability, bind an existing connector, turn authorized resource fields into a
governed input, or create an App-origin Run.

Phase 5 adds that link without creating another executor. It proves one narrow
connected action end to end and keeps every existing owner intact:

- App Service owns installation, version, review, dependency, and grant
  lifecycle.
- Resource owners and ResourceAuthorizationService own live resource access.
- CapabilityService remains the only production provider-call seam.
- App Run Service remains the source of truth for effects, approval, replay,
  attempts, receipts, and unknown outcomes.
- AppActionService becomes the only App-binding orchestration seam used by UI,
  Defty, employees, and human MCP.

This phase does not make newsletter automation possible. It makes a single
explicit email action safe and native. Scheduling and fan-out remain Phase 7.

## Architecture gate

### Options considered

| Option | Result |
|---|---|
| Expose CapabilityService directly to Apps and infer authority from installation ownership | Rejected. Installation is not execution authority, provider metadata is untrusted, and this would bypass exact grants, actor intersection, and App Run ancestry. |
| Build a generic workflow/mapping runtime with grants, expressions, transforms, and provider plugins | Rejected. It combines Phase 5 with automation/runtime work, expands the attack surface, and freezes abstractions before a second proof exists. |
| Add one deep AppActionService over exact immutable grants, closed input sources, Resource authorization, CapabilityService, and App Runs | Selected. It is the smallest seam that proves connected Apps while remaining reversible and testable. |

### Decision

Implement one vertical slice: a Campaign action selects one related Contact and
sends one sandbox email through an already configured MCP connector. Use a
workspace-lineage-namespaced private capability interface first. Do not promote
it to a global `deft.*` standard until Phase 6 supplies independent author or
provider evidence.

The App declaration can request an interface and describe display copy, but it
cannot set the effective risk, review floor, egress class, retry policy,
retention, automation eligibility, provider identity, connector identity, or
grant. Those remain Deft-owned facts.

### Proof data and trust flow

1. Campaigns App v1 declares exact dependencies, resource field requirements,
   one private email capability requirement, one existing-MCP-connector
   requirement, and one closed action binding.
2. Staging parses and persists requests but grants no authority.
3. An owner/admin selects an existing MCP connection and accepts Deft's
   classification. Activation pins the App installation/version, dependency
   lineage/version, resource rights, provider snapshot, operation/schema
   digest, action binding, and immutable effective grant snapshot.
4. A caller supplies a Campaign ResourceRef, one related Contact ResourceRef,
   and an idempotency key through a shallow surface adapter.
5. AppActionService reauthorizes the caller, installation, grant, dependency,
   relation, resource fields, connector, provider schema, and actor-specific
   authority. It resolves only the declared fields live and creates a redacted
   preview plus encrypted canonical Run input.
6. App Run approval is authoritative. The approval inbox is only a projection.
7. Immediately before claim and provider dispatch, the same live authority
   vector is checked again. CapabilityService invokes the exact MCP operation.
8. Every surface observes the same Run, replay, receipt, and result identity
   model; a given invocation resolves to one identity, while distinct actors
   remain distinct principals.

## Frozen proof boundary

Loop 1 must freeze exact names and schemas, but the semantic boundary is fixed:

- Input: one recipient address, one subject, one plain-text body, and a
  host-generated/provider-bound idempotency value.
- Output: one deterministic sandbox message identity and bounded safe status.
- Policy floor: `external_write`, `review_requirement: always`,
  `review_scope: per_invocation`, no unattended automation, and no automatic
  retry unless the exact provider contract proves idempotency-key support.
- Resource inputs: Campaign subject/body fields and one selected related
  Contact email field. No arbitrary JSONPath, templates, expressions,
  constants containing secrets, transforms, joins, queries, or bulk arrays.
- Provider: existing `mcp` provider kind only. Activation cannot create or
  alter a connector.
- Placement: generic host-rendered action on the Campaign record detail
  surface. No App-authored UI.

Contacts may remain an App Protocol v0 installation so the proof exercises the
v0-to-v1 dependency adapter. Campaigns becomes the minimal Protocol v1 App and
adds a plain-text body field through a compatible Module upgrade.

## Execution rules for speed

- Reuse Phase 3 Run, approval, secret, authority-version, replay, and provider
  fixtures. Do not create a second action engine or approval ledger.
- Reuse Phase 4 Contacts/Campaigns, ResourceRef, relation, owner-adapter, and
  disposable-database fixtures.
- Keep one disposable pgvector PostgreSQL environment from the first schema
  loop through the compound proof. Recreate it only for the fresh/upgrade gate.
- Run focused package tests while developing. Run the broad matrix, final
  production build, packaging determinism, browser pass, self-host image, and
  rollback once in the certification loop.
- Do browser work only after the generic action and Settings surfaces exist.
- Every loop keeps App origin disabled until Loop 5's exact cutover gate.
- No loop may add domain-specific Contact, Campaign, or email branches to core.

## Loop 0 — Merge and seal the Phase 4 base

**Purpose:** prevent authority work from landing on an unsealed resource base.

- Merge Phase 4 PR #277 after confirming its head and green checks are
  unchanged.
- Record the immutable merged commit and candidate image.
- Complete the remaining Phase 4 backup/restore and predecessor-image rollback
  evidence. Reuse the already-green CI fresh-pgvector, versioned-upgrade, API,
  production-image, and browser evidence where it proves the exact merged
  revision.
- Rebase this Phase 5 plan branch onto the merged base without changing the
  Phase 4 commits.
- Freeze the Phase 5 fixture IDs, completion matrix, supported migration base,
  and feature-flag defaults.

**Stop condition:** do not begin authority schema work if Phase 4 cannot be
restored with relations retained and authorization still live.

**Closeout:** passed on the isolated release host. The matched projection hash,
live restored relation read, exact predecessor read, candidate restoration,
and cleanup are recorded in
`docs/superpowers/audits/2026-08-31-app-platform-phase-4-release-host-certification.md`.

## Loop 1 — Protocol v1 and the first private capability contract

**Purpose:** freeze only the public atoms consumed by the proof; grant nothing.

- Add a new strict App Protocol/manifest version rather than changing v0
  canonical bytes, digests, defaults, or rejection behavior.
- Add only these bounded atoms:
  - exact App dependency requirement;
  - exact Module resource/field requirement;
  - capability interface requirement;
  - existing connector/provider-kind requirement; and
  - one closed host-rendered action binding.
- Freeze closed input-source variants for current resource fields, one selected
  declared relation target, and explicit user input. Reject arbitrary paths,
  transforms, scripts, templates, URLs, environment variables, and secrets.
- Freeze the sandbox email input/output schemas and Deft-owned classification.
- Use a lineage-namespaced private interface identity. Claimed publisher text
  remains display metadata and cannot become authority.
- Add one code-owned supported-plane registry consumed by parsing, persistence,
  review, routing, lifecycle, and conformance tests. CI must fail if a manifest
  atom is accepted without all required handlers.
- Extend App Kit check/build and JSON schema generation for v1 while keeping all
  v0 tests byte-identical.
- Continue rejecting runtime, code, sync, automation, schedule, custom UI,
  public ingress, token, and connector-creation declarations.

**Evidence:** strict/canonical contract tests, malicious manifest tests, v0
digest fixtures, App Kit determinism, and a registry completeness architecture
test.

**Stop condition:** reopen the gate if the proof needs a general expression
language, a second provider kind, or an App-controlled policy field.

**Closeout:** passed without granting authority or changing persistence. App
Protocol v1 is authoring-only; the support registry leaves inspection,
staging, routing, activation, review, and invocation unavailable until their
registered handlers exist, and the API independently gates every existing
path. The contract suite pins deterministic v0/v1 packages, exact invalid-v0
dispatch, lineage-scoped private identity, closed current-resource/relation
inputs, included-Module resource integrity, malicious declarations, and
sandbox email idempotency conflicts.

## Loop 2 — Additive grant, binding, and dependency substrate

**Purpose:** persist exact authority inputs while App origin remains impossible.

- Add an additive foundation migration for tenant-bound:
  - immutable requested/effective grant snapshots;
  - exact action/provider bindings;
  - selected dependency locks and ownership provenance; and
  - active grant/binding pointers or equivalent installation-scoped state.
- Pin the App installation/version, action key, interface identity, existing MCP
  connection, provider snapshot, operation name/schema digest, dependency
  installation/version, resource rights, classification, reviewer, and full
  canonical digests.
- Add nullable App-origin identity columns to `app_runs`, but preserve the
  database and service deny gate. No App-origin row may persist in this loop.
- Use composite organization-scoped foreign keys, append-only guards, bounded
  JSON checks, exact identity patterns, and reserved/confusable key rejection.
- Stage Protocol v1 requests and the v0 compatibility projection with zero
  authority. Do not create connectors, tokens, Runs, approvals, or provider
  calls.
- Keep grant revocation as pointer/epoch advancement; never mutate a historical
  effective snapshot into a different grant.

**Evidence:** fresh-schema and supported-upgrade parity, cross-tenant FK
rejection, append-only snapshot tests, duplicate/ambiguous dependency rejection,
and proof that staging produces zero provider calls and zero executable grant.

**Stop condition:** do not continue if a Run can reference an unpinned slug,
mutable provider discovery result, or grant JSON without database lineage.

**Closeout:** passed on the dormant-authority boundary. Protocol v1 staging now
writes one exact requested snapshot whose fixture digest is pinned, while v0
staging writes an empty compatibility request. Migration `.23` was applied
idempotently to both the disposable fresh-schema database and a database built
from predecessor commit `c1508a06`; the pre-migration pointerless v0 row was
preserved and another pointerless v0 version remained insertable after upgrade.
Focused database proofs reject cross-tenant grant/dependency/action lineage,
unauthorized reviewers, v0 effective grants, self-supersession, duplicate or
ambiguous dependency locks, private-interface lineage substitution, and child
row mutation. Historical App bindings now block MCP hard deletion before the
live client is disconnected. App-origin submission remains denied in both the
service and database, and staging imports no provider, approval, connector
runtime, or App Run seam. The local PostgreSQL proof used the previously
documented test-only `vector` type shim because pgvector is not installed;
real-pgvector release-host certification remains Loop 7 work.

## Loop 3 — Explicit review, activation, upgrade, and revocation

**Purpose:** produce an exact effective grant and lifecycle without executing it.

- Add owner/admin review that selects an existing MCP connector and accepts the
  host-owned policy classification. Installing ownership is not ongoing
  execution authority.
- Resolve Campaigns -> Contacts to one selected installed lineage and exact
  active version. Do not auto-install, auto-upgrade, or solve general ranges.
- Validate the declared resource fields and action input sources against the
  pinned Module manifests and relation interface.
- Activate atomically only after every requirement is healthy. Failed review or
  activation leaves the old App/Module pointers and data unchanged.
- Compute a deterministic permission/requirement diff. Widening or incompatible
  upgrades restage for review; an unchanged/non-widening binding may be carried
  only when all action, interface, dependency, provider, schema, and resource
  requirements are identical.
- Disable, grant revocation, connector rebinding, dependency change, or
  security-sensitive upgrade advances the relevant installation epoch and
  supersedes the active snapshot without deleting history.
- Add bounded management APIs for requested/effective review, connector
  selection, activation, health, disable, and provenance. UI waits for Loop 6.

**Evidence:** lifecycle database tests for staging, activation, failed
activation, widening/non-widening upgrades, disable/re-enable, connector/schema
drift, dependency loss, ownership, data retention, and concurrent review CAS.

**Stop condition:** activation must fail if it would create a connector, widen
a token, follow a newer dependency/provider implicitly, or inherit grants from
a different lineage.

**Closeout:** passed on the no-execution boundary. Owner/admin review now pins
one exact installed dependency version, declared resources and fields, an
existing MCP connector, alias-normalized connector policy, one fresh provider
snapshot/schema, the private action binding, and Deft's immutable host policy.
Activation revalidates those facts under sorted tenant-bound locks and swaps
the App, effective-grant, and additive App-owned Module pointers in one
transaction. Permission carry-forward is limited to a byte-equivalent
authority surface; widening or incompatible changes require explicit policy
acceptance. Disable clears the live grant pointer and advances both lifecycle
epochs, while re-enable requires a fresh review and creates a linear immutable
successor snapshot.

The database now enforces one effective-grant root and one successor per node,
append-only App/Module binding history, immutable App-version supersession,
tenant-bound connector overrides, exact grant/version coherence, and mandatory
lifecycle/grant epoch advancement. Upgrade proof preserved existing Campaign
records while adding the optional body field, retained both historical
App-version bindings, rejected Module-set shrink, and rolled every pointer and
record version back after an injected failure. Connector, override, dependency,
provider-schema, reviewer, cross-tenant, stale-CAS, and concurrent-activation
paths fail closed. Protocol v0 activation/disable/re-enable remains compatible,
and App-origin submission is still denied by both service and database.

Focused certification passed on a newly recreated disposable PostgreSQL
database: schema push, ordered extras, a second idempotent extras pass, Protocol
v0 lifecycle, connected staging/review/revocation/upgrade, connector and
Capability Service regressions, App-origin denial, App Kit contracts, database
upgrade checks, and API typecheck. Local PostgreSQL still lacks pgvector, so the
already documented test-only `vector` shim was used; real-pgvector supported
upgrade and release-host evidence remain Loop 7 work.

## Loop 4 — AppActionService dry-run and live input resolution

**Purpose:** establish one deep caller seam before enabling effects.

- Add AppActionService with small list/resolve/prepare operations. All surface
  adapters call it; it cannot call the low-level MCP client.
- Resolve the current Campaign, selected related Contact, declared fields, and
  revisions through owner authorization. Add only the narrow internal Module
  field-read port required by this proof; do not expose generic record fields
  through a new public Resource API.
- Require the Contact to be present in the Campaign's declared relation at
  invocation time. A caller cannot substitute an unrelated authorized Contact.
- Intersect the installation grant with the live human membership, Defty
  execution identity, employee health/assignment/budget, or human-MCP token.
  The App never runs as the owner who installed or bound it.
- Produce a bounded redacted preview, encrypted-input candidate, resource
  refs/revisions, exact authority vector, and deterministic replay identity.
  Never log or return the recipient/body as generic safe metadata.
- Add architecture tests preventing routes, agents, MCP tools, App Service, and
  AppActionService from bypassing Resource authorization, CapabilityService, or
  App Run Service.
- Keep invoke disabled and assert zero provider calls.

**Evidence:** equivalent list/resolve/prepare results for UI, Defty, employee,
and human MCP test adapters under equivalent authority; membership, relation,
field, dependency, grant, connector, and schema revocation fails before input
materialization.

**Stop condition:** reopen the gate if two surfaces need different policy code
or if sensitive resolved values must enter previews, logs, events, or receipts.

**Closeout:** passed on the dry-run/no-effect boundary. One AppActionService now
owns list, resolve, and prepare for UI, Defty, employee-runtime, and human-MCP
callers. It rechecks exact installation/grant/binding/dependency/provider
membership, live caller and token authority, the current Campaign relation, and
declared scalar fields before sealing a short-lived Run-owned input candidate.
All returned resource labels and field evidence are explicitly projected so
recipient, subject, and body values remain confined to the provider-input and
encryption boundary. The focused disposable-PostgreSQL proof covers four-surface
parity, unrelated selection, membership/token-scope/relation/schema/field
revocation, and zero Capability invocation, Run, approval, or provider effect.
The reused connected-grant lifecycle suite covers dependency, grant, and
connector invalidation; architecture tests prove those checks precede scalar
materialization and prevent App lifecycle/surface bypasses. Local certification
used the documented test-only `vector` shim; real pgvector remains Loop 7.

## Loop 5 — Exact App-origin Run cutover

**Purpose:** allow one effect path and no other App-origin path.

- Add a separate cutover migration that replaces the App-origin database deny
  check with an exact coherence check and composite foreign keys for App
  installation, version, binding, and grant snapshot identity.
- Add a trusted App-origin submission method to App Run Service. Raw callers
  cannot set App origin fields or manufacture grant snapshots.
- AppActionService invoke rechecks the prepared inputs and submits one Run with
  the pinned binding/grant/provider/resource identities and current authority
  versions.
- Use an immutable provider-ID ingress into CapabilityService; never reuse the
  legacy slug-selected path.
- Recheck installation, version, grant, actor, dependency, resources, connector,
  provider schema, and policy before approval linkage, attempt claim, provider
  dispatch, and result delivery.
- Make App Run approval authoritative. The sandbox email classification always
  requires per-invocation review regardless of employee trust.
- Preserve Phase 3 replay, budget, cancellation, retry, drain, retention,
  receipt, and unknown-outcome behavior. Concurrent replay must create one Run
  identity and at most one provider call.
- Add actor-scoped safe Run inspect/result operations backed by App Run Service.
- Exercise App origin only through a test/certification flag in Loops 5-7.
  Keep the production default disabled until Loop 7 certification enables it
  deliberately.

**Evidence:** immediate/reviewed/rejected/expired/revoked/concurrent/unknown
outcome tests, one provider call after approval, no call before approval, exact
Run/receipt identity, crash recovery, and stale claim/session denial.

**Stop condition:** no cutover if any App-origin Run can persist without all
four installation/version/binding/grant identities or can reach a provider
without CapabilityService.

**Closeout:** passed on the exact one-action cutover. Raw App-origin submission
remains denied, while the authenticated AppActionService path re-prepares the
candidate, rederives its tenant-bound installation/version/effective-grant/
binding/dependency/resource/relation authority in the Run transaction, and
persists the four exact App ancestry fields under composite foreign keys. The
default-off App-origin flag is composed only at the Run boundary. Approval,
claim, provider-call, and result delivery all recheck live authority; approval
also reserves employee budget atomically. Replay requires the same canonical
App authority snapshot, not merely the same provider input.

The retained-database compound proof creates one Run and one approval under
concurrent invocation, performs no effect before approval, dispatches once
through CapabilityService using the immutable provider ID plus reviewed
connector-version/provider-snapshot/operation-schema pin, records approval and
terminal receipts, returns the authorized retained result, and then blocks
delivery and a second approved Run after connector revocation. The focused
shared/AppAction/Capability/architecture/rollout/Run-engine matrix and API
typecheck pass. The test fixture now tolerates retained foreign key-version
references without weakening the production key check. Real pgvector and the
release-host matrix remain deliberately deferred to Loop 7.

## Loop 6 — Native management and four-surface parity

**Purpose:** make the governed action usable without creating surface-specific
authority paths.

- Add the minimum Settings UI for requested/effective permission diff, selected
  connector, dependency/provenance, health, activate/disable/review, and recent
  Run status.
- Add one generic host-rendered action on Campaign detail with selected Contact,
  approval state, retry-safe submission, Run status, and safe result.
- Add a small stable generic operation set for action discovery, invocation,
  and Run inspection. Do not generate a top-level tool per App/action.
- Wire UI, Defty, employee, and human MCP as shallow AppActionService callers.
- Add explicit App discovery/invocation/Run scopes. Existing broad OAuth/MCP
  scopes remain blind until reauthorized; no legacy token is silently widened.
- Preserve actor differences: discovery may differ when membership, assignment,
  budget, connector access, or token scopes differ, but equivalent authority
  yields the same binding and Run identity semantics.
- Inspect rendered behavior at representative desktop and mobile sizes,
  including loading, approval, disabled/unhealthy, stale, success, and failure
  states.

**Evidence:** parity tests across four surfaces, token non-discovery tests,
employee assignment/budget tests, approval projection tests, Settings/action UI
tests, and rendered desktop/mobile verification with no console errors.

**Closeout:** passed on the native-surface boundary. Settings now exposes the
requested/effective authority diff, exact connector binding, dependency and
provenance evidence, health, lifecycle controls, and recent safe Run states.
Campaign detail renders one descriptor-driven action with related-resource
selection, a redacted review, retry-stable submission, App Run approval, and
safe status/result polling. UI, Defty, employee runtime, employee MCP, and human
MCP use the same fixed `capability_list`, `capability_get`,
`app_binding_invoke`, and `app_run_get` operations over AppActionService; no
per-App tools or execution path were introduced. App scopes are explicit and
legacy/default credentials remain App-blind. Focused contract, scope, parity,
approval, architecture, API/web typecheck, lint, and UI tests pass. A disposable
browser stack proved loading, healthy/unhealthy and stale denial, approval,
disabled, succeeded, and failed states at desktop and 390x844 mobile sizes.
That pass also caught and closed the final integration gap: App Run approve and
reject buttons now enter the governed approval resolver rather than the legacy
agent executor. The disposable visual database was removed; the retained Phase
5 certification database remains for Loop 7.

## Loop 7 — Compound proof, certification, and release

**Purpose:** prove Phase 5 as a community-relevant connected kernel, not a set of
isolated contracts.

- Install the existing Contacts v0 App and upgrade Campaigns to Protocol v1 with
  the compatible Module body-field change. Preserve all existing records and
  relations.
- Stage Campaigns and prove zero rights. Review/bind one sandbox MCP connector,
  activate, choose a related Contact, invoke, approve, and observe exactly one
  provider effect, App Run, receipt, and safe result.
- Run the same semantic action through UI, Defty, employee, and human MCP. Each
  surface must use the same binding identity model and replay semantics under
  equivalent authority, while distinct actors remain distinct Run principals.
- Revoke or change membership, employee assignment/health/budget, token scope,
  App state, dependency, relation, grant, connector, provider schema, and App
  version at each pre-effect boundary. Every stale path fails closed; a
  post-provider ambiguity records `unknown_outcome` truthfully.
- Prove widening upgrade review, unchanged compatible upgrade carry-forward,
  failed activation pointer preservation, disable/re-enable data retention,
  dependency-aware uninstall refusal, and no silent cascade.
- Assert no Contact, Campaign, or email-domain service/route branch and no
  dynamic provider loader entered core.
- Run the consolidated shared/App Kit/database/API/web architecture and
  regression matrix, repository typecheck, and one final production build.
- Build both proof Apps twice and compare exact package/lock digests.
- Run one release-host pass for fresh pgvector schema, supported upgrade from
  the immutable Phase 4 baseline, backup/restore, production image/browser
  smoke, predecessor-image rollback read, candidate restoration, and final
  commit/image digest.
- Record the immutable release evidence and exact Phase 6 authoring-kit handoff.

**Local closeout:** the connected Campaigns proof now uses the exact checked
Contacts and Campaigns source packages and lockfiles. The four interactive
surfaces share AppActionService, exact grant/binding ancestry, and governed App
Runs while replay authority remains isolated by surface and token. Review,
revocation, upgrade/rollback, uninstall refusal, developer pairing, deterministic
proof packages, capability/resource seams, operator rollback, and the
Apps-enabled candidate lane are covered by the focused certification matrix.
Repository typecheck passes. The official release default remains off until the
Phase 6 beta gate. The immutable release-host pass cannot run truthfully before
PR C is merged and an exact commit/image digest exists, so Phase 5 is not yet
marked complete. See
`docs/superpowers/audits/2026-09-01-app-platform-phase-5-release-certification.md`.

## PR train

Use three review boundaries, developed as a stack so review latency does not
block implementation:

1. **PR A — contracts and dormant authority substrate:** Loops 0–2. App origin
   remains denied by database and service.
2. **PR B — review lifecycle and AppActionService dry-run:** Loops 3–4. Exact
   grants can become active, but no provider call can originate from an App.
3. **PR C — cutover, native surfaces, and certification:** Loops 5–7. This is
   the only PR that enables App-origin execution.

Each PR receives focused checks. Run the expensive complete API suite,
production image/browser, backup/restore, and rollback once on PR C unless an
earlier PR directly changes those surfaces.

## Phase 5 acceptance matrix

Phase 5 passes only when all are true:

- Protocol v0 bytes, digests, packages, installed Apps, Module data, and Phase 4
  relations remain compatible.
- Staging has zero authority and activation cannot create connectors, widen
  tokens, select runtimes, or enable schedules.
- Requested metadata cannot lower Deft-owned policy.
- Every App-origin Run is tenant-bound by database foreign keys to one exact
  installation, version, action binding, effective grant snapshot, provider
  snapshot/schema, and dependency lock.
- The caller's live membership/token/employee authority intersects with the App
  grant at preparation, approval, claim, dispatch, and delivery.
- Resource values come only from currently authorized declared fields and one
  currently related selected Contact; they do not leak into safe metadata.
- Disabled, revoked, ambiguous, cross-tenant, stale, widened, or schema-drifted
  bindings fail before an effect.
- Concurrent replay produces one Run and at most one provider call.
- `always` review cannot be bypassed by an Autonomous employee or owner binding.
- UI, Defty, employee, and human MCP are shallow adapters over the same service
  and use the same binding/Run/replay model under equivalent authority.
- Existing OAuth/MCP tokens cannot discover or invoke Apps until explicit App
  scopes are granted.
- Widening upgrades require fresh review; failed activation leaves current
  pointers/data untouched; dependency disable/uninstall never cascades
  silently.
- App Run Service is authoritative for approval and effects; CapabilityService
  is the sole provider-call seam; no second action/approval engine exists.
- Core contains no Contacts, Campaigns, email, provider-specific, or generated
  per-App branch.
- Fresh install, supported upgrade, backup/restore, image smoke, rollback, and
  immutable commit/image evidence pass.

## Explicit deferrals

- Recurring newsletters, audience queries, fan-out, schedules, triggers,
  automation definitions, and unattended approvals remain Phase 7.
- Custom interfaces and iframe/experience hosting remain the custom Experience
  Host track.
- External runtimes and arbitrary server-side App code remain the isolated
  runtime track.
- Bidirectional connector sync, remote identity maps, conflicts, cursors, and
  webhook ingestion remain the sync track.
- Anonymous booking/forms, public pages, and webhook ingress remain the public
  gateway track.
- General dependency solving, semver ranges, heterogeneous ownership policy,
  standard-interface promotion, and broader resource field/mutation adapters
  remain evidence-led Gate G work.

## Completion and pause rule

Phase 5 is complete only when the immutable released evidence proves one
connected App action across all four interactive surfaces with exact grants,
live revocation, authoritative approval, one provider effect, and rollback.
Contracts, Settings screens, or a passing App Kit package alone are not
completion.

Pause and reopen the architecture gate if implementation requires a new tenant
selector, dynamic provider registration, App-controlled risk or approval,
generated executable code, arbitrary input transforms, a second effect engine,
raw connector access, implicit dependency upgrade, reusable App bearer token,
or public disclosure of resolved sensitive resource fields.
