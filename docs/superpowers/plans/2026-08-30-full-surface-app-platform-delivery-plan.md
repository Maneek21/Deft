# Deft Full-Surface App Platform — Revised Delivery Plan

| Field | Value |
|---|---|
| **Status** | Active execution plan; Phases 0–2 and Phase 3 PR C merged, guarded PR D closeout in progress |
| **Date** | 2026-08-30 |
| **Architecture source** | `docs/superpowers/plans/2026-08-29-full-surface-app-platform.md` |
| **Execution baseline** | Phase 1 `bdb137ee`; Phase 2 `9ba7b7c8`; Phase 3 PR C merge `9c8e9ac9`; PR D replay `ee513a35` plus split-control checkpoint `5cf88c51` (unreleased) |
| **North star** | A community member can ask Codex to build any feasible Deft App, install it on an ordinary self-hosted workspace, and have it participate through governed resources, knowledge, agents, capabilities, experiences, automation, runtimes, sync, and public ingress as required by that App. |

## Decision

Keep the full-surface architecture. Change its delivery shape.

The architecture document remains the capability map and threat model. This
document supersedes only its mostly linear implementation sequence. Work now
follows a **foundation -> independent proof -> evidence-led generalization**
rhythm. A necessary trust boundary may be built for its first consumer; broad
provider, resource, workflow, or ecosystem abstractions wait for evidence from
multiple heterogeneous consumers.

This is not an MVP reduction. It is a durability rule: public contracts are
small when first published, every privileged plane proves its own safety and
self-host operation, and later Apps compose proven planes instead of depending
on speculative protocol surface.

## Product boundary

"Any feasible App" does not mean arbitrary installed code runs inside Deft's
trusted API, web, or worker processes.

- Tier 1 declarative Apps use Deft-owned resources and rendering.
- Tier 2 connected Apps add exact grants, connector bindings, governed actions,
  and native actor surfaces.
- Tier 3 full-surface Apps compose isolated custom UI, operator-managed
  runtimes, specialized resources/sync, automation, and public ingress.
- Apps may request authority. Deft owns effective authorization, risk,
  approval floors, retry policy, retention ceilings, and revocation.
- Self-hosting never requires a hosted Deft service, registry, marketplace, or
  managed runtime merely to use the protocol.
- A future SaaS deployment implements replaceable operational providers around
  the same App protocol and authorization model; it does not fork them.

## Non-negotiable invariants

1. Tenant, actor, installation, provider, and resource identity come from
   authenticated host context and live records, never App-supplied claims.
2. Installed artifacts cannot execute code in Deft's trusted processes, create
   connectors, widen tokens, select runtimes, or enable automation implicitly.
3. Every App-defined capability and App-mediated external effect uses
   CapabilityService and one governed App Run with approval, idempotency,
   attempt, unknown-outcome, receipt, and revocation semantics appropriate to
   its host-owned classification. Existing native Deft actions retain their
   certified path unless a separately justified migration moves them.
4. Every resource disclosure or mutation resolves and authorizes live. Cached
   labels, search projections, provider assertions, and App metadata never
   authorize.
5. Disable and revocation stop future Deft-mediated access. Documentation and
   UI state honestly when already delivered data or independently held
   credentials cannot be clawed back.
6. Public protocol contracts are versioned, closed, bounded, independently
   buildable, and additive until an explicit compatibility policy says
   otherwise.
7. Core remains domain-neutral. Reference Apps prove behavior without adding
   CRM, marketing, booking, newsletter, email, or agent-console branches to
   Deft core.
8. Fresh installs, supported upgrades, backup/restore, rollback floors, and
   ordinary self-host operation are release properties, not SaaS-only work.

## Current state and immediate decision

### Completed and preserved

- **Phase 0:** architecture, terminology, trust boundaries, licensing, and
  disabled-by-default plane policy.
- **Phase 1:** deterministic declarative App packages, lifecycle, lineage,
  developer pairing, Authoring Kit alpha, and Hello Workspace proof.
- **Phase 2:** actor-neutral CapabilityService with MCP as the first adapter and
  behavior-parity coverage.
- **Phase 3 PR A/B:** dormant App Run contracts, schema, secrets, lifecycle,
  attempts, replay, failure classification, and fake-provider engine merged
  through `399cd030`.
- **Phase 3 PR C (#273):** C0–C3 trust/data completion merged at `9c8e9ac9`,
  preserving additive `.19`–`.21`, release/budget evidence, approval ownership,
  ancestry, receipts, Attention, and internal repair invariants.

The remaining PR D chain is local-only and unreleased: `1e4ac5a7` (C4 replay)
-> `bd28ff6f` (C5 replay) -> `ee513a35` (historical certification replay) ->
`5cf88c51` (split controls) -> `a6f2eed2` (closeout contract) -> `fe66113f`
(restart-transition certification). Original C0–D2 hashes remain historical
review evidence. None of these hashes is a supported rollback floor; the floor
is the eventual immutable released image revision recorded by the release gate.

No completed phase is restarted or redesigned. Later work must consume these
deep services rather than create parallel execution, package, or authorization
paths.

### Phase 3 closeout gate

The historical C0–D2 work through `5050b0f1` is preserved as review evidence,
not treated as proof of the newer split-control contract or as an App-facing
feature. PR D's new checkpoint and consolidated matrix own closeout evidence.

Before it merges:

1. Record the dual-ledger exit: App Runs are canonical execution state;
   `agent_actions` is the current approval projection and legacy receipts remain
   historical compatibility. After native App approval/Run UI and Phase 6
   parity are proven, no new App path may depend on the compatibility ledger.
2. Preserve the already tested additive `.19`–`.21` migrations by default.
   Consolidate them only if repository policy requires one unreleased train to
   equal one migration, no supported or retained environment has recorded
   their checksums, disposable environments are reset, and the resulting
   upgrade/engine evidence is rerun.
3. Describe `AppRunOperationsService` as an internal repair primitive with a
   runbook/SQL operator path. Do not claim a public operations surface until
   one exists.
4. Keep `origin = app`, system/automation origins, and broad rollout fail-closed
   until later phases provide their host-owned authority sources.
5. Keep the exact legacy MCP intake path default-off, with no shadow provider
   call and no fallback after a governed attempt begins.
6. Keep Run runtime/key availability separate from legacy-connector cutover;
   reject intake-on/engine-off and document the three safe combinations. Add an
   App-origin control only with Phase 5's real grants/bindings entrance.
   Enabling community Apps must not implicitly migrate all existing MCP traffic.
7. Split-control checkpoint `5cf88c51` supersedes `5050b0f1` for rollout
   evidence. Complete its flag-combination, startup, queue-deferral, keyring,
   rollback, and compatibility delta before PR D is certified.

Recommended review shape:

- **PR C — trust and data completion:** C0–C3 release fencing, live authority,
  budget evidence, approval adapter, selected ancestry constraints, receipts,
  Attention, and repair invariants.
- **PR D — guarded runtime and certification:** C4–C5 composition, exact
  default-off legacy canary, rollback/key runbook, and the certification record.

PR D may stack on PR C only while commit ancestry is preserved. If PR C is
squash-merged or rewritten, rebuild/rebase PR D on the resulting default branch
and recertify the changed delta rather than treating old hashes as evidence.

Merge evidence is limited to changed boundaries plus one consolidated delta
matrix: shared contracts, final upgrade representation, App Run database suite,
engine-off/intake-off, engine-on/intake-off, and engine-on/intake-on modes in one
disposable-database fixture, focused
approval/trust/connector/worker/crypto/architecture tests, repository typecheck,
and one production source build. Browser testing is required only if web code
changes. Production-image, current-schema, backup/restore, rollback, and
deterministic-provider browser drills remain rollout gates and run once on the
release candidate.

## Revised delivery graph

```text
Phases 0–3: governed foundation
              |
              v
Phase 4: Resource participation kernel
              |
              v
Phase 5: Connected grants, bindings, and App-origin Runs
              |
              v
Phase 6: Independent connected-App proof and beta
              |
              +--> Track A: governed automation
              +--> Track B: isolated custom experiences
              +--> Track C: runtime --> specialized resources and sync
              +--> Track D: public ingress
                              |
                              v
                Compound full-surface proofs
                              |
                              v
              Protocol and operations stabilization
                              |
                              v
                    Optional ecosystem work
```

Phases 4–6 remain sequential because they establish the connected kernel.
Tracks A–D are independently selectable after Phase 6. Track C's sync work
depends on its runtime/resource-provider kernel; the other tracks do not depend
on one another unless a selected proof explicitly combines them.

## Phase 4 — Resource participation kernel

**Outcome:** independently authored Apps can address and relate authorized Deft
resources through a stable, live-checked contract without forcing every core
resource through a universal rewrite.

### Loop 4.0 — Freeze the connected proof

- Freeze independently authored Contacts and Campaigns Apps plus a deterministic
  sandbox email provider.
- Make cross-App composition an explicit first connected-platform claim: one
  community App can depend on and reference resources from another without
  copying them or knowing its source. The added reference/dependency work is
  therefore intentional, not incidental test scaffolding.
- List the exact resource reads, mutations, links, search/context reads, and
  caller surfaces required by the proof.
- Keep unrelated core-resource adapters and specialized-provider behavior out
  of the phase gate.

### Loop 4.1 — ResourceRef and authorization seam

- Add a bounded, versioned `ResourceRef` with provider, resource type, and
  opaque resource identity. Organization always comes from authenticated host
  context. If a persisted or serialized reference carries a tenant component,
  it is host-minted, must exactly match that context, and can never select the
  tenant.
- Add a closed host-owned adapter map/resolver and one
  `ResourceAuthorizationService` entry point with stable structured errors.
  Do not publish generalized registry/discovery semantics until Task or a
  specialized provider becomes the second real resource consumer.
- Delegate actual authorization to current resource owners; do not duplicate
  Module or Task access rules in the registry.
- Treat provider security facts as inputs or denials only. The host makes the
  final allow decision.

### Loop 4.2 — First heterogeneous adapters

- Implement the Module-record adapter first. Add Task as the first
  heterogeneous core adapter when the proof links work or as the immediately
  following connected-kernel generalization fixture; it does not block the
  initial Campaign action.
- Support only bounded resolve, safe projection, authorized create/update/
  archive where the underlying resource already supports it, and optimistic
  concurrency where required.
- Route network or independently operated mutations through CapabilityService
  and App Runs; Resource `update` cannot conceal an external effect.

### Loop 4.3 — Cross-App relations

- Add tenant-bound, typed reference edges with authorized endpoint resolution.
- Add them through a new versioned Module reference contract/schema rather than
  changing schema `1` parsing or digest behavior.
- Support Campaign-to-Contact references without copying records.
- Keep reference storage/resolution separate from Phase 5 App dependency and
  grant binding. Phase 4 fixtures may reference two already installed Modules;
  Phase 5 pins an App requirement to an exact installed lineage/version.
- Define installation disable, resource archive/delete, App upgrade, dangling
  reference, picker, and search/citation behavior.
- Cached labels and snippets remain presentation hints, never authority.

### Loop 4.4 — Search, context, and compatibility

- Route only the proof's Module search, context, and citation reads through the
  Resource seam. Do not cut over unrelated existing callers merely for
  architectural symmetry.
- Shadow-compare against existing authorized results before selecting the new
  path.
- Preserve current Module relations, task links, IDs, APIs, and agent behavior.

### Phase 4 acceptance

- Cross-organization and cross-security-context resolution fails at database
  and service boundaries.
- Membership/resource-ACL loss and Module/App disable or archive immediately
  remove resolve/search/context visibility. App-grant revocation begins in
  Phase 5.
- Stale projections and malicious-provider access claims cannot authorize.
- Relation lifecycle is deterministic across disable, upgrade, archive, and
  deletion.
- Module parity passes; Task parity becomes mandatory in the merge that adds
  the Task adapter.
- Existing Module schema `1` parsing, canonicalization, and manifest digests are
  unchanged. A later schema version is additive and cannot reinterpret v1.
- No message, wiki, note, file, calendar, people, team, sync, generalized blob,
  or CRM-specific implementation is required to pass this phase.

Those adapters remain required for the full platform, but are added when a
proof consumes them or during evidence-led connected-kernel generalization.

## Phase 5 — Connected grants, bindings, and App-origin Runs

**Outcome:** an installed App can request, receive, expose, and invoke one exact
governed capability through the same host-owned authorization path on every
interactive actor surface.

### Loop 5.0 — Freeze the first capability contract

- Freeze the smallest useful sandbox-email send contract with strict
  input/output schemas and code-owned risk, review, egress,
  retry/idempotency, retention, and automation eligibility. Keep it namespaced
  and App-private unless independent provider/App evidence already justifies a
  reviewed standard interface.
- Implement the first sandbox provider through the existing `mcp` provider
  kind. A second provider kind or runtime abstraction is outside the connected
  kernel.
- Provider descriptions and App copy cannot lower those floors.
- Keep the interface narrow; attachments, bulk delivery, templates, tracking,
  suppression, and provider-specific extensions remain absent unless the proof
  requires them.

### Loop 5.1 — Manifest atoms

- Extend `deft.app.json` only with the resource requirement, capability
  requirement, existing-connector requirement, dependency, and closed action
  binding used by the proof.
- A manifest atom lands only with strict parsing, immutable persistence,
  permission review, enforcement, lifecycle revocation, App Kit support, and
  conformance coverage.
- Maintain one host-owned supported-plane registry used by parser, persistence,
  review, routing, lifecycle, and conformance tests. CI rejects a manifest key
  that is accepted without all required handlers. Phase 5 ships the
  authoritative schema/types/parser and minimum install/review tooling;
  Phase 6 adds the external template, simulator, guidance, and author trial.
- Continue rejecting custom code, runtime, sync, automation, and public-ingress
  fields.

### Loop 5.2 — Exact grants and provider binding

- Add immutable requested/effective grant snapshots.
- Bind exact installation version + capability interface + connector/provider
  instance + operation/schema snapshot.
- Include exact rights for App-owned Module resource reads/mutations needed by
  the binding; a capability grant does not silently confer resource authority.
- Staging grants zero authority. An owner/admin explicitly selects an existing
  connector and accepts the Deft-owned classification.
- Reject ambiguous providers, cycles, implicit dependency upgrades, and
  cross-lineage grant inheritance.
- Pin App dependencies/resource requirements to selected installed lineage and
  compatible version locks. Do not auto-install or auto-upgrade dependencies.

### Loop 5.3 — Live lifecycle authorization

- Bind work to installation, actor, membership/token, connector/provider, App
  version, interface, and grant authorization versions.
- Freeze caller-to-connector authority per surface: the current human
  membership, Defty execution identity, employee health/assignment/budget, or
  human-MCP token scopes remain live requirements. Owner selection during
  binding is not continuing execution authority, and an App never runs as the
  owner who installed or bound it.
- Persist tenant-bound installation ID, App version ID, binding key, and grant
  snapshot ID on every App-origin Run with exact database/repository
  validation. Recheck them before approval, claim, provider dispatch, and
  result delivery.
- Pin exact provider operation identity and schema digest. Schema drift makes
  the binding unhealthy and fail-closed; owner review/rebinding creates a new
  immutable grant snapshot rather than silently following a slug or discovery
  result.
- Disable, revocation, security-sensitive upgrade, or reassignment advances the
  relevant epoch and invalidates stale sessions, approvals, claims, and
  invocations.
- Define bounded drain, expiry, cancellation, and unknown-outcome behavior;
  never silently rebind old work to a new version or provider.
- Keep the beta lifecycle closed: staged -> active -> disabled, with an atomic
  version-pointer upgrade from a separately staged version. Uninstall requires
  disabled state, no unresolved dependent references, an explicit decision for
  retained/exported data, and safe expiry or retention of pinned Runs/receipts.

### Loop 5.4 — AppActionService and native bindings

- Add one deep `AppActionService` used by all callers.
- Limit it to binding/grant/input resolution and list/resolve/invoke
  orchestration. App Service owns lifecycle, resource providers own resource
  authorization, CapabilityService owns provider policy/execution, and App Run
  Service owns effect state. Architecture tests prevent surface adapters from
  bypassing it and prevent it from calling the low-level MCP client.
- Resolve binding inputs only from authorized resource fields/references and
  explicit user input. Do not add arbitrary mapping, templating, or expression
  languages, JSONPath, hidden secret constants, or author-defined transforms.
  Resolve fields live at invocation and pin the effective values and relevant
  resource revisions into the Run while keeping sensitive values out of safe
  previews and logs.
- Use a host-owned binding ingress that resolves immutable connector/provider
  IDs and actor/token context. App execution never reuses the legacy
  slug-selected CapabilityService ingress.
- Add generic host-rendered action placement and stable small App discovery/
  invocation/Run operations rather than generated top-level tools.
- Enable `origin = app` only through the exact grant/binding path into
  CapabilityService and App Runs.
- Make App Run approval authoritative for native App actions. Any approval
  inbox row is an idempotent projection and cannot independently authorize or
  execute the effect.

### Loop 5.5 — Review and management surfaces

- Add the minimum Settings surfaces for requested/effective grants, exact
  connector selection, provenance, health, disable, and Run status.
- Add approval/Run state to the host-rendered action surface.
- Add actor-scoped safe Run inspect/result operations backed by App Run Service,
  not the dormant deny-all internal operations primitive.
- Add explicit App scopes; broad pre-App OAuth/MCP scopes remain blind until
  separately reauthorized.

### Phase 5 acceptance

- Staging cannot invoke and activation cannot create a connector, widen a
  token, select a runtime, or enable a schedule.
- Manifest/provider metadata cannot lower host policy.
- Disabled, ambiguous, revoked, cross-tenant, or stale bindings fail before the
  effect; post-boundary ambiguity is recorded truthfully.
- Concurrent replay produces one provider call and one terminal Run identity.
- A widening upgrade requires fresh review and failed activation leaves the old
  version active.
- A non-widening connected-App upgrade preserves bindings only when action,
  interface, dependency, and provider requirements remain compatible and
  unchanged; otherwise it restages for review. Transform-requiring Module
  upgrades leave active pointers/data untouched.
- Phase 1 App/module bindings migrate through a tested v0-to-v1 adapter. Hello
  Workspace and existing Module data remain usable.
- Dependency ownership distinguishes pre-existing, App-installed, and shared
  artifacts; disable/uninstall never cascades silently and requires explicit
  export/retention decisions where data would become unreachable.
- For the beta, bound dependency, upgrade, drain, export/retention, and
  uninstall behavior to the exact Contacts -> Campaigns graph and its current
  lifecycle state machine. General dependency solving and heterogeneous
  ownership policy remain Gate G work.
- App-owned route, command, binding, resource, and action keys are lineage-
  namespaced and reject reserved-core, ambiguous, and Unicode-confusable
  collisions.
- UI, Defty, employee, and human MCP adapters are shallow callers of the same
  AppActionService and use the same binding identity, Run identity model, and
  replay semantics under equivalent actor, installation, assignment, and token
  grants. Discovery may correctly differ when effective authority differs.
- Existing tokens cannot discover App bindings, provider schemas, or Run
  metadata and cannot invoke Apps until explicit App scopes are reauthorized.
- Core contains no Contacts, Campaign, or email-domain service branch.

## Phase 6 — Independent connected-App proof and beta

**Outcome:** a community-style external author can build, install, operate,
upgrade, disable, and recover a Tier 2 connected App using only published Deft
contracts and tooling.

### Loop 6.0 — Connected Authoring Kit

- Extend schemas, generated types, CLI, lock format, templates, `doctor`, host
  simulator, and fake provider fixtures only for supported Phase 4–5 contracts.
- Keep the beta kit narrow: manifest/types/build/install and the connected
  example are mandatory; a generalized simulator, dependency solver, interface
  registry, or large fixture matrix requires a demonstrated second consumer.
- Publish Codex/AGENTS guidance with safe extension choices and explicit
  non-claims.

### Loop 6.1 — Independent proof artifacts

- Build Contacts and Campaigns from clean external directories/repositories
  using version-matched packed artifacts and no monorepo-private imports.
- Consume local packed/versioned artifacts rather than workspace links. Public
  registry publication is a separate release decision and does not block this
  proof.
- Implement the sandbox provider against the frozen interface.
- Keep all domain behavior in the Apps/provider.

### Loop 6.2 — Native workflow

- Stage, review, bind, activate, open, search, cite, relate, invoke, approve,
  inspect the receipt, upgrade, disable, and re-enable.
- Campaign references Contact without copying it.
- Keep the first send single-recipient or tightly bounded and human-initiated.
  The App Run receipt is its durable send audit. A domain send-log projection
  requires a separately designed idempotent result-projection/workflow contract
  and is not implemented ad hoc before the automation/event plane.

### Loop 6.3 — Adversarial and parity proof

- Exercise approval/revocation races, provider timeout and ambiguous outcome,
  replay, result expiry, post-provider finalization failure, App disable,
  connector disable, membership removal, upgrade, restart, and restore.
- Run one shared native-equivalence harness across human UI, Defty, employee,
  and human MCP. All surfaces must share binding identity, policy floor, Run
  identity model, idempotency, receipt, and result semantics; replaying the
  same logical invocation returns the same Run without another provider call
  only inside the same initiating actor, execution actor, installation/version,
  grant, binding, provider, and idempotency scope. Cross-actor, cross-token, and
  cross-tenant keys cannot collide, reveal a retained result, or suppress a
  separately authorized invocation.

### Loop 6.4 — External author trial and beta gate

- Give a clean Codex task only the published kit, contracts, documentation, and
  self-host endpoint.
- Record authoring friction and change public contracts only for demonstrated
  blockers.
- Run one release certification: Phase 4–6 conformance, supported upgrade from
  the Phase 3 release, fresh-schema release-image check, production image and
  Compose smoke, desktop/mobile journey, repository typecheck/build, and
  database + key-material backup/restore.

### Phase 6 acceptance

- A clean external author builds and installs the proof without core edits.
- Self-hosting requires no hosted account, registry, or managed runtime.
- The App and its local data surface install and open without network access;
  an offline connector is reported as unhealthy rather than preventing boot.
- Grant and package diffs are deterministic and understandable.
- Disable/revocation is live across every interactive surface.
- Failure and recovery claims match durable evidence.
- Key generation, validation, storage, backup inclusion, rotation, retirement,
  lost-key behavior, and startup diagnostics are usable by an ordinary
  self-host operator without a hosted KMS or ephemeral production keys.
- Runs, retained ciphertext, provider snapshots, action discovery, pending
  approvals, queue backlog, retry, payload, and retention behavior have bounded
  operator-visible ceilings and cleanup/degraded-mode behavior.
- This permits the claim **Connected App Platform beta**. It does not yet permit
  automated, custom-experience, runtime, sync, public-ingress, or arbitrary
  full-surface claims.

## Gate G — Evidence-led connected-kernel generalization

Phase 6 proves the minimum kernel; it does not erase the canonical platform's
broader resource, privacy, lifecycle, or private-capability requirements. Gate
G is an incremental ownership list, not another big-bang phase. Each privileged
track completes the Gate G items it consumes. All applicable items must be
complete before the general full-surface platform claim.

- Add Task, messages/chat, wiki/notes, files/blobs, calendar, people, and teams
  adapters when a proof first consumes each type. Complete live ACL/search/
  context/citation parity for every resource named in a product claim.
- Add reusable organization, team, user-private, explicit-share, and role-
  restricted security contexts as heterogeneous resources require them.
- Make attachments/blobs inherit parent authorization; broker access without
  exposing storage credentials and enforce size, MIME/sniffing, disposition,
  active-content, and quarantine hooks.
- Add lineage-namespaced App-private capability contracts with fail-closed host
  defaults so community Apps do not depend on Deft standardizing every domain
  verb. Promote a private interface only after repeated compatible provider/App
  evidence and review.
- Generalize dependency ownership, upgrade compatibility, drain/supersede,
  uninstall/export/retention, and namespace policy only where a second
  heterogeneous package/resource/runtime proves the shared rule.
- Preserve exact v0 compatibility and current data. No generalized adapter may
  reinterpret an existing identifier, digest, grant, visibility rule, or
  lifecycle outcome without migration and rollback evidence.

A track may start after Phase 6 with its declared Gate G dependencies. It may
not silently change shared `ResourceRef`, manifest, grant, binding, or App Run
contracts. Such a change requires a common-kernel rebaseline and conformance
run for every active dependent track.

## Privileged-plane tracks after Phase 6

Each track follows the same cadence: pre-proof using existing contracts, one
new capability claim, deterministic fixture, independent App, adversarial
revocation/failure proof, self-host operations proof, and only then contract
promotion. Completing one track does not automatically start another.

### Track A — Governed automation

Minimum first slice:

- transactional event/outbox record only where the producer needs it;
- distinct non-admin automation principal;
- immutable approved schedule/action definition;
- timezone/DST/misfire behavior, unique fire claims, pause/resume, budgets,
  retry/dead-letter, loop detection, and kill switch;
- one App Run/receipt per external effect;
- manifest, review UI, Authoring Kit, simulator, and conformance together.

Event-delivery retry and external-effect retry are separate decisions. Replaying
an event may rediscover an existing Run; it must not retry an unsafe effect
whose dispatch outcome is ambiguous.

First proof: bounded Scheduled Campaign. Rich branching, general expression
languages, durable arbitrary waits, and compensation remain deferred until
multiple Apps require them.

### Track B — Isolated custom experiences

Minimum first slice:

- complete the browser-isolation spike before freezing the manifest contract;
- immutable content-addressed static bundle;
- per-App/version isolation with no ambient Deft cookie or reusable bearer
  token;
- restrictive CSP/sandbox/Permissions Policy and closed MessageChannel bridge;
- no shared App storage, parent DOM access, general network proxy, mutable
  remote bundle, or browser egress channel;
- resource/action SDK backed by live Resource/App Run authorization;
- accessibility, mobile, storage clearing, hostile-content, egress, and
  revocation tests.

First proof: custom Agent Operations Console.

### Track C — Runtime and specialized resources/sync

Runtime kernel first:

- operator-administered runtime registration and explicit credential ownership;
- short-lived pull claims, leases, heartbeat/cancel/reconcile, bounded signed
  callbacks, budgets, health, revocation, and SSRF/target validation;
- no connector credentials, installing-user impersonation, or manifest-created
  process/network targets.

Sync/resource-provider slice second:

- declare canonical ownership, recovery/resync support, freshness, cursors,
  tombstones, and retention;
- provider-authoritative one-way projection first;
- specialized-resource authorization, live permission-aware search/context/
  citation resolution, inherited attachment/blob ACLs, and safe attachment
  handoff;
- Deft-owned push and bidirectional sync require separate conflict/loop proofs.

First compound proof: Email Lite with isolated UI plus one operator-owned
sandbox or standards-based provider. Runtime and sync may ship separately, but
Email Lite is not claimed until both recovery models are proven.

### Track D — Public Gateway

Minimum first slice:

- isolated public principal and public-only middleware that ignores ambient
  workspace cookies;
- opaque enable/disable endpoints, strict schemas, payload/rate limits,
  retention, consent, abuse controls, and deduplicated durable ingress;
- transactional public resource claims;
- raw-byte signature profiles and replay windows for reviewed webhook types;
- App-specific verification code runs only in an operator-managed runtime.

For a Deft-canonical booking slot, commit the deduplicated ingress row, unique
idempotent slot reservation, and outbox event in one database transaction;
success means the reservation committed, and a conflict never returns a
confirmation. For an externally canonical calendar, `202 Accepted` means only
that the request was durably accepted—not that a meeting was booked—and a later
governed capability confirms or rejects it. Never claim transactional remote
booking across a provider call.

The proof includes cookie isolation, double-book protection, raw-byte signature
verification, crash-before/after the durable response boundary, replay,
disable, retention, payload/rate ceilings, and public-log leakage tests.
Ordinary workspace mutation unrelated to the bounded slot-claim transaction
does not occur inline; later governed work handles it.

First proof: Booking. Newsletter unsubscribe/bounce/complaint handling is a
separate compound proof with Track A and must serialize suppression against
send claims.

## Cumulative certification and platform stabilization

Certification is attached to each plane rather than deferred until a late
construction phase. A completed subset permits claims only for Apps composed
from that subset. After all four tracks and their applicable Gate G items pass,
run two compound proofs:

1. **Email Lite:** Experience Host + Runtime + specialized resources/sync.
2. **Public automated workflow:** Automation + Public Gateway through Booking or
   newsletter compliance flows.

Then permit the general **full-surface App platform** claim and freeze
compatibility/deprecation policy only after:

- at least two independently authored heterogeneous Apps use the same public
  kernel without core changes;
- fresh install, supported upgrade, rollback, backup/restore, provider outage,
  restart, lease expiry, runtime compromise, and unknown outcomes pass on
  release images;
- tenant isolation covers database, queue, blobs, search, logs, key hierarchy,
  runtime claims, and operator tooling;
- performance budgets exist for resource resolution/search, Runs, event
  backlog, sync, iframe startup, and runtime callbacks;
- focused independent security review covers the highest-risk published
  boundaries;
- README, self-hosting, and product claims match only certified planes.

## Optional ecosystem and hosted work

Do not begin marketplace work merely because the protocol can describe Apps.
Require stable package identity, compatibility evidence, and multiple external
publishers first.

Optional ecosystem work includes publisher signatures, portable provenance,
registry metadata, community conformance CI, install-by-URL, update policy,
managed runtime offers, reviews, entitlements, payments, and marketplace UX.

Hosted SaaS work begins after the corresponding protocol is useful self-hosted:

- hosted KMS, object storage, runtime scheduling, email, and other services are
  replaceable provider implementations;
- tenant quotas, rate limits, metering, abuse controls, and kill switches are
  operational policy, not App-granted authority;
- multi-replica API/worker evidence covers idempotency, attempt leases, approval
  races, queue fairness, revocation, result delivery, and key access; in-process
  composition or caches are never assumed globally unique;
- rolling mixed-version migration, regional failure, key-loss, and fleet
  backup/restore drills precede hosted claims;
- tenant deletion defines and tests the fate of App artifacts, encrypted Run
  payloads, receipts, provider-owned data, blobs, logs, backups, keys, and
  runtime-held copies. One tenant's deletion or key rotation cannot affect
  another tenant;
- hosted operators cannot silently broaden grants or impersonate an installing
  owner;
- community Apps remain locally installable unless a capability is truthfully
  declared hosted-only;
- billing and marketplace metadata never become execution authority.

## Execution rules

1. **Zero proof debt:** do not start another privileged plane while the previous
   published plane lacks an independent end-to-end proof.
2. **Foundation/proof pairing:** a structural merge must be followed by a
   behavioral merge that exercises it; do not accumulate schema-only trains.
3. **Persistent-object ownership:** every table/object needs a current writer,
   reader, authorization/revocation path, retention/cleanup owner, and proof
   consumer. Tests cover its production writer, bounded reader, tenant
   isolation, lifecycle cleanup, and upgrade preservation; architecture checks
   flag App-platform tables referenced only by schema, migrations, tests, or
   docs.
4. **Two-consumer generalization:** use a narrow adapter for the first
   implementation. Create a universal provider/registry/DSL only after two
   heterogeneous consumers expose the same invariant. Concrete security
   boundaries are the exception; the architecture decision must name whether a
   seam is security centralization or convenience generalization and identify
   its consumers.
5. **One privileged plane per proof:** combine planes only for a deliberate
   compound conformance proof.
6. **Manifest atom:** parser, persistence, review, enforcement, revocation,
   authoring support, and conformance land together.
7. **Host-owned policy:** Apps request; Deft classifies and authorizes.
8. **No premature expression language:** explicit inputs and bounded authorized
   field mappings precede templates, expressions, or workflow DSLs.
9. **Deep shared entrances:** every caller surface uses the same Resource or
   AppAction service. Surface-specific copies of authorization are forbidden.
10. **Feature flags are rollout gates:** each has an owner, enablement evidence,
    supported combination matrix, compatible released-image floor, rollback
    evidence, and removal-or-permanent-control decision. Startup rejects unsafe
    combinations.
11. **Proportional evidence:** always test tenant isolation, live revocation,
    approval, replay, provider-boundary crash, disable, and leakage. Add broader
    combinations only for distinct code paths.
12. **Stop decision:** after every proof, record what worked, what required
    manual glue, which invariant failed, and which single next plane unlocks the
    most leverage. Numbering alone never authorizes the next track.
13. **Hard proof-debt gate:** a plane is not supported and the next plane does
    not begin until one clean external App, deterministic provider/runtime
    fixture, revocation/crash evidence, released-image self-host smoke, and a
    supported/non-supported decision have an owner and evidence link. Maintain
    one reviewed evidence record per plane containing the external revision,
    package digests, deterministic fixture result, adversarial matrix,
    release-image/self-host evidence, claim status, and owner. A PR adding the
    next privileged manifest/runtime surface must link its completed predecessor
    record or fail review/CI.
14. **No dormant expansion:** guarded Phase 3 ancestry, reconciliation,
    retention, and operator primitives may remain, but receive no generalized
    extension until a connected or automation proof consumes them.

## Claim ladder

| Gate | Permitted claim |
|---|---|
| Phase 1 | Codex can build and install a declarative Deft App. |
| Phase 3 internal gate | Deft has a guarded governed-effect substrate; no new App claim. |
| Phase 6 | Codex can build connected Apps using resources, agents, approvals, and external capabilities. |
| Track A | Apps can schedule and react through bounded governed automation. |
| Track B | Apps can provide isolated custom UI. |
| Track C | Apps can use operator-managed computation and synchronized specialized resources. |
| Track D | Apps can expose governed public workflows. |
| Compound proofs | Deft supports independently authored full-surface Apps by composing certified planes. |
| Stabilization | Community protocol compatibility is supported. |
| Ecosystem | Registry/marketplace claims are evidence-backed. |

## Next action

The executable closeout sequence is
`docs/superpowers/plans/2026-08-30-app-platform-phase-3-closeout-loops.md`.

Close Phase 3 through the two guarded review trains above. Do not begin a
maximal universal Resource Service in parallel. Once Phase 3 is merged
default-off, establish one released connected-kernel merge base and plan Phase
4 Loops 4.0–4.4 against the exact Contacts/Campaigns proof and current schema.
Then execute Phase 4–6 as one connected-kernel program with separate reviewable
merges and one final release certification. Every later track declares that
released connected-kernel revision as its minimum dependency, starts from and
continuously integrates the latest security-supported default branch, and
records shared-contract rebases. No optional track starts from an unmerged
local stack or remains pinned to an obsolete release.
