# App Platform Phase 6 and Track A — efficient execution loops

| Field | Value |
|---|---|
| Status | Loop 6.0 sealed from merged Phase 5 audit `c0da089d`; Phase 6 PR A implemented and locally validated, merge certification pending |
| Architecture source | `docs/superpowers/plans/2026-08-29-full-surface-app-platform.md` |
| Delivery source | `docs/superpowers/plans/2026-08-30-full-surface-app-platform-delivery-plan.md` |
| Phase 6 outcome | An independent author can build, stage, install, operate, upgrade, disable, recover, and inspect a Tier 2 connected App using published contracts and tooling only |
| Track A outcome | An installed App can run bounded scheduled work through the same grants, AppAction, approval, AppRun, receipt, budget, and revocation path as an interactive action |
| Claim after both | Connected App Platform beta with bounded governed automation |
| Still excluded | Custom App UI, arbitrary runtimes, specialized sync, anonymous/public ingress, marketplace, billing, and the general full-surface App-platform claim |

## Why this shape

Phase 5 proves the internal connected kernel. Phase 6 must prove that the kernel
is usable outside the monorepo and operable by a self-hosted administrator. It
must not create a second author-only authority model, simulator-only execution
engine, or test-only provider contract.

The next privileged plane is the revised delivery plan's **Track A**, not a new
linear Phase 7. Track A starts only after immutable Phase 6 evidence. Its first
consumer is one bounded scheduled Campaign action; it does not introduce a
general workflow language, event bus, arbitrary expressions, or compensation
runtime.

This plan uses five review trains:

1. Phase 6 PR A — independent authoring and zero-authority staging.
2. Phase 6 PR B — complete native lifecycle and operator inspection.
3. Phase 6 PR C — conformance, independent trial, and beta certification.
4. Track A PR A — dormant automation contracts, persistence, and service seam.
5. Track A PR B — durable scheduling, proof App, management surface, adversarial
   evidence, and release certification.

Each train is independently reviewable and preserves a deny-by-default cutover.

For speed, Phase 6 executes as three bounded review trains rather than seven
serial handoffs. PR A freezes contracts first, then parallelizes the App Kit
template, Protocol v1 stage-only API path, and packed proof/provider work before
one integration pass. PR B freezes safe lifecycle response shapes first, then
parallelizes API wiring, Settings reuse, and only the newly exposed adversarial
cases. PR C is evidence-only: product changes are allowed only for a blocker
demonstrated by the independent trial or immutable gate. A Phase 5 evidence
coverage map is created in Loop 6.0 so unchanged kernel proofs are referenced,
not rerun during ordinary implementation.

## Shared invariants

- Preserve Protocol v0 package, lock, install, activation, digest, and rejection
  bytes. Preserve Protocol v1 schema/package/lock/digest and frozen-interface
  bytes when Track A adds an explicit Protocol v2 dispatch path.
- Staging is not authority. A staged Protocol v1 package cannot discover or
  call providers, create Runs, bind connectors, or activate itself.
- One pure requested-authority projection is shared by author lockfiles and the
  host's requested grant snapshot. Effective authority remains host-owned.
- AppActionService remains the only App action orchestration seam.
- AppRunService remains the only effect, approval, replay, attempt, result,
  receipt, and unknown-outcome ledger.
- CapabilityService remains the only production provider-call seam.
- Every persisted identity and query is organization-scoped; actor, token,
  membership, installation/version, grant, binding, provider, and idempotency
  dimensions remain part of execution authority.
- Connected proof artifacts use packed, version-matched public files from clean
  directories. Workspace links and monorepo-private imports are forbidden.
- Feature flags remain off by default. Migration and rollback evidence precede
  behavior cutover.
- No Contact, Campaign, email, or newsletter branch enters Deft core.

## Phase 6 — Independent connected-App proof and beta

### Loop 6.0 — Seal the Phase 5 dependency

**Purpose:** start external-author work only from a release-host-certified
connected kernel.

- Require the exact Phase 5 candidate, certifier commit, workflow run, safe
  artifact hashes, pgvector version, backup/restore continuity, predecessor
  read, desktop/mobile connected proof, and isolated cleanup in the audit.
- Freeze the Phase 6 base commit, current Protocol v0/v1 golden fixtures,
  private sandbox interface, proof App digests, supported predecessor, flags,
  and certification matrix.
- Record existing gaps rather than redesigning completed Phase 4–5 contracts.

**Stop condition:** do not merge Phase 6 behavior if Phase 5 restore, receipt,
predecessor, browser, or cleanup evidence is missing.

**Sealed dependency (2026-09-01):** Phase 5 product candidate `438a283a`,
certifier `70a4b984`, definitive run `33469721507`, and audit merge `c0da089d`
all passed. The safe artifact is
`sha256:40689d1ab9c914477a2efa8efb8528d2a53a6019d400f18962a8ed119876d256`;
the separately retained image artifact is
`sha256:f28bc0188de4880dbb57b162246f97aaf9f4996545737537460c39703bfb680d`.
Real pgvector `0.8.6`, 23 migrations through `0.3.0-preview.25`, matching
source/restored continuity hash
`sha256:de8535e3fcb94e312a640392910e40af3ec8e191c14c650cee3e952c65343eda`,
9/9 verified receipts, predecessor read, desktop/mobile proof, and isolated
cleanup are recorded in the Phase 5 audit.

The unchanged kernel evidence reused by Phase 6 is frozen as follows:

- Contacts v0 package:
  `sha256:1471f0b94da9f6851bd978c315bc22a2dd0343b61a87477e4293b144c54248d8`.
- Connected Campaigns v1 package:
  `sha256:973ec7076daf7405a7a4d8b48509ef6f99b1b1cc4b787961104c73f23b7f770d`.
- Connected Module v2 artifact:
  `sha256:5dc2a978506eb2917a3a99021831d62d94112a60615292e4b32e03e480cff208`.
- Existing v1 requested-grant snapshot:
  `sha256:2464c10f3a480c8d5d7f75c7923f8231a311bcdeb6dbfb584c8a0d7449572bed`.
- Supported predecessor:
  `ghcr.io/maneek21/deft@sha256:e565cc64ee22b5b9f6f99973e3762b639c27e026dc8824852145035acdacf788`.
- `DEFT_APPS_ENABLED`, developer pairing, App Runs, App-origin intake, and
  legacy MCP cutover remain separate exact-`true`, default-off flags.

Phase 6 ordinary development references these immutable proofs and reruns only
changed contracts. Its final beta gate repeats the compound release evidence
once from the exact merged candidate.

### Loop 6.1 — Shared authoring contract and connected template

**Purpose:** make the existing Protocol v1 contract understandable and
deterministic to an external author without granting authority.

- Add one public pure `projectDeftAppRequestedAuthority`-style helper in App
  Kit. It returns only requested requirements, read-only resource rights, and
  Deft-owned classification; it never includes host IDs, connectors, tokens,
  private lineage, or effective grants.
- Make AppGrantService consume the same projection before adding host-owned
  identities and digests only if the existing v1 requested snapshot canonical
  bytes and digest remain exact. Otherwise leave the host projection in place
  and share lower-level pure atoms rather than rewriting persisted history.
- Add strict `deft app init --template declarative|connected`; keep declarative
  as the compatibility default and reject malformed template arguments.
- Generate the connected scaffold from code-owned template content, including
  a Module v2 Campaign resource, exact Contacts dependency, one sandbox action,
  an App brief, and scoped AGENTS guidance.
- Keep Protocol v0 and Protocol v1 lock bytes unchanged. Emit the clearly named
  requested-authority projection as a separate deterministic author report;
  never write it into the v1 lock or label it effective authority.
- Assign the changed packed App Kit a unique prerelease version. Developer
  status advertises an additive protocol/flow/tooling compatibility structure
  while retaining the legacy `app_protocol: "0"` scalar exactly.
- Pin projection clone safety, deterministic canonical bytes, absence of
  secrets/host IDs, and the exact host-policy floor in tests.

**Evidence:** App Kit protocol/CLI tests, AppGrant projection parity, v0 golden
digests, connected proof package determinism, and repository typecheck.

### Loop 6.2 — Protocol v1 doctor and zero-authority local staging

**Purpose:** let a local author deliver a connected package to Deft without
crossing review, binding, or activation.

- Keep the existing expiring, revocable, manager-rechecked, audience-bound,
  single-use developer pairing contract.
- Inspect the package before consuming the pairing token.
- Preserve Protocol v0 stage-and-activate behavior exactly.
- For Protocol v1, reuse `stageAppPackage` and stop in `staged` with no active
  version, effective grant, dependency lock, action binding, connector change,
  provider call, approval, or App Run.
- Extend the additive developer status response with supported protocol flows
  while retaining the legacy Protocol v0 scalar.
- Make `doctor` compare the local package protocol with the exact flow advertised
  by the host. A v0-only host rejects a v1 package before token consumption.
- Add a thin public contract checker for package/host-flow compatibility,
  requested-authority review, static binding validation, and frozen provider
  vectors. It must call the exact exported validators and conformance vectors;
  it must not simulate live authorization, activation, relations, AppAction,
  AppRun, or the database-bound input resolver. Use a tiny HTTP fixture only
  for transport tests.

**Evidence:** v0 pairing compatibility, v1 stage-only database proof,
single-use/revocation tests, CLI host compatibility tests, zero executable
authority assertions, and API/App Kit typecheck.

### Loop 6.3 — Clean packed proof, standalone sandbox provider, and guide

**Purpose:** prove that the authoring surface is public and version-matched,
not an artifact of workspace links.

- Pack the exact App Kit tarball and install it into clean temporary directories
  outside the repository.
- Run the installed binary to initialize, check, and build Contacts and
  Campaigns twice; compare lock/package bytes and digests and prove resolution
  stays under the temporary directory.
- Reject undeclared files, workspace paths, and private imports in the tarball.
- Keep contract/schema constants and conformance vectors in App Kit. Package a
  separate narrow proof-only stdio sandbox provider artifact exposing only
  `send_email`; do not make the portable App Kit own a Node/MCP runtime.
- Freeze one public proof bundle containing the exact Contacts dependency and
  the separately packed provider, including their digests and retrieval path.
  The connected template never relies on an unpublished workspace package.
- For the self-host proof only, mount the packed provider read-only and
  explicitly allowlist its pinned `node` launcher. Document that narrow
  operator wiring; do not broaden the production container into a generic
  runtime or silently rely on a host workspace path.
- Keep the API fixture and external provider as independent implementations
  against the same conformance vectors so the proof does not pass by sharing
  implementation code.
- Test real stdio discovery/call through the official MCP transport, exact
  schemas, replay, conflicting idempotency, invalid input, and clean shutdown.
- Publish the connected author guide: packed-kit quickstart, doctor/stage,
  administrator review/bind/activate handoff, requested versus effective
  authority, offline connector health, safe extension choices, backup/key
  requirements, and explicit non-claims.
- Enforce App Kit and flagged v1 pairing tests in CI.

**Evidence:** clean packed-directory test, stdio provider integration test,
documentation links, deterministic proof digests, and unchanged v0 fixtures.

**PR A exit:** an external directory can create and stage the connected proof
using only packed public artifacts, but cannot self-authorize or invoke it.

### Loop 6.4 — Complete native lifecycle and operator inspection

**Purpose:** remove the remaining monorepo/test-harness shortcuts from the
supported administrator and author journey.

- Project staged Protocol v1 version, requested authority, deterministic diff,
  dependency requirements, provider requirement, and missing bindings in
  Settings without leaking provider secrets.
- Show exact compatible App Kit/protocol versions and local unsigned provenance
  in Settings and `doctor`; never imply registry signature or hosted trust.
- Add the supported staged-upgrade path and reload it after upgrade.
- Make disable and re-enable explicit; re-enable revalidates live membership,
  dependency, connector, provider schema, grant, binding, and authority version
  rather than reviving stale authority.
- Expose receipt verification and bounded safe Run/result metadata only after
  verifying the receipt signature plus tenant and caller authorization; no
  provider secret, ciphertext, or cross-actor metadata crosses the response.
- Exercise stage, review, bind, activate, open, search, cite, relate, invoke,
  approve, inspect receipt, upgrade, disable, and re-enable with Campaign
  referencing Contact rather than copying it.
- Keep sending single-recipient, human-initiated, and sandboxed. Do not add a
  domain send-log projection before Track A.

**Evidence:** focused service/route tests, Settings component tests, one
desktop/mobile connected lifecycle proof, and no unauthorized receipt or
provider visibility.

**PR B exit:** the complete connected lifecycle is supported through native
surfaces with no manual database edits or private test harness calls.

### Loop 6.5 — Conformance, failure, and operator ceilings

**Purpose:** prove that published semantics survive real failure and parity
conditions.

- Close App-origin gaps for provider timeout, ambiguous outcome, result expiry,
  post-provider finalization failure, approval/revocation race, restart,
  restore, App disable, connector disable, membership removal, stale authority,
  upgrade, and second-token/cross-actor isolation.
- Run one shared equivalence harness across human UI, Defty, employee, and
  human MCP. Equivalent authority shares binding/policy/Run/receipt semantics;
  actor and token identity remain distinct replay boundaries.
- Make queue backlog, pending approval, attempts/retry, retained ciphertext,
  provider snapshots, action discovery, payload limits, retention, cleanup,
  degraded mode, and referenced-key inventory observable with bounded safe
  summaries. Implement this as one manager-only projection over existing Run
  operations, queue health, key inventory, and connected health—not a second
  generic operations framework.
- Prove offline boot: the App/local resources open without network, while the
  connector is reported unhealthy and invocation fails safely.
- Prove the ordinary self-host operator path for key generation, validation,
  durable storage, startup diagnostics, rotation, retirement, backup inclusion,
  restore, and explicit lost-key behavior. Reuse exact Phase 3/5 evidence where
  immutable; add only the missing operator-facing assertions.

**Evidence:** focused adversarial tests plus the shared parity matrix; no new
executor, approval ledger, retry loop, or provider route.

### Loop 6.6 — Independent trial and immutable beta gate

**Purpose:** earn the Connected App Platform beta claim from external evidence.

- Give a clean Codex task only the packed kit, public contracts, guide, and a
  disposable self-host endpoint. Record friction and change contracts only for
  demonstrated blockers.
- Build/install the independent App and separately packed sandbox provider with
  no Deft core edits and no hosted account, registry, or managed runtime. Run
  the public simulator before staging and retain its deterministic result.
- Run one consolidated release gate: Phase 4–6 conformance, supported upgrade
  from the Phase 3 release, fresh pgvector schema, exact candidate image,
  Compose/self-host smoke, desktop/mobile lifecycle, offline provider behavior,
  repository typecheck/build, database plus key backup/restore, predecessor
  read, and cleanup.
- Retain safe evidence and the exact candidate image separately. Publish
  nothing unless separately authorized.

**PR C exit:** the audit permits only the claim **Connected App Platform beta**.

## Track A — Bounded governed automation

### Loop A.0 — Freeze the first automated proof

**Purpose:** add one useful unattended plane without inventing a workflow
platform.

- Require the immutable Phase 6 beta audit.
- Preserve the Phase 5 sandbox interface and its
  `automation_eligibility: forbidden` policy byte-for-byte. Freeze an additive
  lineage-private interface
  and code-owned policy version that permits only an
  `approved_automation_definition` and still uses an exact AppAction binding.
  An App or schedule cannot select, author, or lower that policy; owner/admin
  acceptance is explicit.
- Freeze timezone, DST, misfire, unique-fire, pause, resume, retry,
  dead-letter, budget, loop/recursion, and kill-switch semantics.
- Gate G scope is frozen to existing organization-scoped Module v2 Campaign and
  Contact resources plus the lineage-private capability policy. The first proof
  pins one exact Contact and does not consume Task, message, file, calendar,
  private-context, audience-query, or new privacy adapters. Do not add an event
  outbox without a concrete producer/consumer proof.

### Loop A.1 — Dormant contracts and additive persistence

**Purpose:** persist definitions and fires while unattended dispatch remains
impossible.

- Add strict Protocol v2 for one package-authored schedule/action request that
  stages with zero authority. Keep v0/v1 canonical bytes and rejection shapes
  unchanged. Continue rejecting expressions, scripts, arbitrary events,
  dynamic provider selection, unresolved user input, and compensation code.
- Distinguish that package request from a host-created, owner/admin-approved,
  immutable definition instance. The instance pins the exact Campaign
  ResourceRef, record revision and content digest, exact selected Contact
  ResourceRef, binding and provider snapshot, schedule/timezone, budgets,
  validity window, and authorization vector. Any widening or content/input
  change creates a new definition and requires fresh approval.
- Add only organization-scoped `app_automation_definitions` and
  `app_automation_fires` tables with installation/version/grant/binding/
  authority lineage, immutable input/revision/content/provider pins, canonical
  schedule, state/epoch, validity and budget, unique fire identity, claim/lease
  metadata, bounded attempts, and terminal reason.
- Add composite foreign keys, immutable historical fields, bounded JSON/text,
  unique fire constraints, and deny-by-default flags.
- Stage/review definitions with zero execution authority. Upgrade, disable,
  grant revocation, and connector disable invalidate future eligibility live.

**Evidence:** contract/golden tests, migration fresh/upgrade parity,
cross-tenant rejection, immutable lineage, and proof of zero unattended Runs.

### Loop A.2 — One automation principal over the existing action path

**Purpose:** reuse interactive governance rather than create a cron executor.

- Introduce a closed automation execution principal derived from the exact
  active definition, installation/version, effective grant, action binding,
  and organization.
- Resolve each eligible fire through AppActionService and AppRunService with
  the same resource authorization, provider snapshot, approval policy, budget,
  idempotency, receipt, result, and unknown-outcome semantics.
- Automation never receives connector credentials or calls CapabilityService
  directly.
- Only the additive code-owned policy can replace per-fire review with explicit
  owner/admin approval of the fully pinned definition. A schedule cannot lower
  the review floor, reuse Phase 5's automation-forbidden binding, or execute
  unresolved `user_input`.

**Evidence:** immediate/action/scheduled parity, no bypass tests, actor lineage,
receipt verification, and live revocation before claim and dispatch.

**PR A exit:** automation can be declared and reviewed, but remains globally
disabled until the scheduler cutover.

### Loop A.3 — Durable schedule scan, claims, and recovery

**Purpose:** make scheduled firing restart-safe and horizontally safe.

- Reuse the existing durable job queue and worker ownership model.
- Compute canonical next-fire instants with explicit timezone/DST behavior.
- Insert one unique fire before enqueue; claim with lease/epoch fencing; create
  the App Run idempotently; finalize the fire from the Run outcome.
- Implement explicit misfire handling, bounded retry only where existing Run
  policy permits it, dead-letter state, pause/resume, per-definition and
  organization budgets, backlog ceilings, kill switches, and crash recovery.
- A lost lease, restart, duplicate scan, clock boundary, or second worker cannot
  produce a second provider call for the same logical fire.

**Evidence:** deterministic time/DST fixtures, duplicate-worker claims,
restart/lease expiry, queue outage, budget exhaustion, pause/disable race,
unknown outcome, and dead-letter recovery.

### Loop A.4 — Independent scheduled Campaign and management surface

**Purpose:** prove the plane from a packed App rather than a core special case.

- Extend the independent Campaign App with one bounded scheduled-send
  declaration and deterministic authority diff.
- Extend App Kit schema/types/lock, permission diff, `doctor`, connected
  template, public simulator, and conformance together. The simulator exercises
  deterministic timezone/DST/misfire and pinned-input outcomes using the exact
  pure schedule/contract functions, never a duplicate scheduler or executor.
- Add generic host-rendered list/detail controls for definition state,
  schedule/timezone, next fire, last fire/Run, pause/resume, retry eligibility,
  budget/dead-letter summary, and kill-switch status.
- Keep provider/domain behavior in the App/provider. No Campaign-specific
  scheduler or UI branch enters core.
- Prove disabled or offline providers do not prevent workspace/App resource
  access; pending work degrades visibly and safely.

**Evidence:** clean packed build, native Settings journey, desktop/mobile
management proof, and generic architecture test.

### Loop A.5 — Adversarial and immutable automation gate

**Purpose:** earn the bounded governed automation claim.

- Exercise duplicate scans, DST folds/gaps, long downtime/misfire, pause and
  kill races, grant/connector/App/member revocation, provider timeout,
  ambiguous result, restart, restore, stale versions, budget exhaustion,
  dead-letter retry, and cleanup.
- Prove interactive and scheduled invocations share action binding, policy
  floor, Run ancestry, result/receipt, and revocation semantics while retaining
  distinct principal and idempotency scopes.
- Run fresh/upgrade/backup/restore/predecessor, exact candidate image,
  self-host/offline, typecheck/build, and browser certification once.
- Record safe hashes, counts, bounded summaries, cleanup, and explicit
  non-claims in the release audit.

**PR B exit:** permit **bounded governed automation** for the certified schedule
plane. Do not claim arbitrary workflow automation or the general full-surface
platform.

## Consolidated validation policy

- During implementation, run only the smallest affected contract/service/DB/UI
  checks.
- Each PR runs repository CI and security once after its focused matrix passes.
- Phase 6 PR C and Track A PR B each run one immutable release-host gate with
  real pgvector, exact images, supported upgrade, backup/restore, predecessor,
  browser evidence where UI changed, and cleanup.
- Do not repeat Docker, fresh-schema, browser, or production builds in every
  loop. Report a genuinely unavailable requirement instead of substituting a
  weaker proof.

## Program continuation

Phase 6 plus Track A is a meaningful public beta, not the final vision. The
general “build any feasible full-surface App” claim remains blocked until Track
B isolated custom experiences, Track C operator-managed runtimes and specialized
sync, Track D Public Gateway, all consumed Gate G items, compound independent
proofs, and final security/performance/compatibility certification pass.
