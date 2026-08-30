# App Platform Phase 3 — Closeout and Release Loops

| Field | Value |
|---|---|
| **Status** | In execution; Loops 0–5 complete, Loop 6 consolidated delta certification next |
| **Date** | 2026-08-30 |
| **Architecture source** | `docs/superpowers/plans/2026-08-29-full-surface-app-platform.md` |
| **Delivery source** | `docs/superpowers/plans/2026-08-30-full-surface-app-platform-delivery-plan.md` |
| **Merged base** | PR C merge on `origin/master` at `9c8e9ac9` |
| **Local closeout baseline** | PR D C4–D2 replay at `ee513a35`, plus split-control checkpoint `5cf88c51`; local-only and unreleased |
| **Outcome** | Merge and release the guarded Phase 3 execution substrate with Run draining separated from legacy MCP intake, then hand Phase 4 one immutable supported baseline. |

## Decision

Close Phase 3 before beginning Phase 4 implementation.

Use two review trains:

1. **PR C — trust and data completion:** existing C0–C3 commits through
   `d5192c55`, followed by one docs-only commit that persists the reviewed
   architecture, delivery, and closeout plan sources.
2. **PR D — guarded runtime and execution closeout:** existing C4–D2 work,
   rebuilt on PR C's actual merge commit when necessary, plus one narrow rollout
   control change and truthful closeout documentation.

Do not redesign the completed engine. Do not begin ResourceRef, App grants,
App-origin execution, connected App UI, or Authoring Kit beta work inside these
trains.

## Current immutable facts

- `origin/master` includes the Phase 3 foundation, engine, and PR C trust/data
  completion through merge `9c8e9ac9`.
- The original Phase 3 source worktree carried this historical local chain:
  - `4c4f48c1` — C0 engine/cutover hardening;
  - `e6274c41` — C1 live authority and budget evidence;
  - `c3670207` — C2 approval compatibility projection;
  - `d5192c55` — C3 receipts, Attention, ancestry, and internal operations;
  - `ffdab418` — C4 runtime/worker composition;
  - `944b265f` — C5 legacy capability cutover;
  - `5050b0f1` — local certification documentation.
- PR C replayed C0–C3 and merged as #273. Original hashes remain historical;
  PR D was rebuilt from the merge as `1e4ac5a7` (C4), `bd28ff6f` (C5), and
  `ee513a35` (historical certification), then added split controls at
  `5cf88c51`. No PR D hash is released or an operational rollback floor.
- Before Loop 0, the revised delivery and closeout plans plus the intended
  canonical-plan header/pointer edits existed only in the dirty main worktree.
  The dirty main copy of the canonical plan predates newer Phase 1–3 evidence,
  so only its reviewed header/pointer intent may be applied to the current
  tracked body; the dirty originals and unrelated Hermes work remain untouched.
- Additive migrations `.19`–`.21` are implemented and tested. Preserve them;
  rewriting their history provides no functional value and invalidates useful
  evidence.
- `DEFT_APP_RUNS_ENABLED` now controls Run runtime/key availability and draining;
  `DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED` independently controls new legacy
  MCP admission. The invalid off/on state is rejected at startup.
- App origin, system origin, and automation origin remain fail-closed.
- The current local host lacks pgvector and a running Docker release
  environment. Do not retry those known local limitations; run their gates once
  on release-capable infrastructure.

## Frozen rollout-control contract

Keep the existing variable as the engine/drain control:

- `DEFT_APP_RUNS_ENABLED=false`: no Run keyring required; durable Run workers
  defer without spending attempts; existing MCP behavior remains legacy.
- `DEFT_APP_RUNS_ENABLED=true`: valid Run keyrings are required; the runtime may
  decrypt, resume, and drain already accepted governed work.

Add one new exact default-false legacy intake control:

- `DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=false`: new MCP capability requests
  continue through the legacy path.
- `DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=true`: supported legacy MCP requests
  enter the governed Run path.
- Legacy cutover `true` while the Run engine is `false` is an invalid startup
  configuration and fails closed.

| Run engine | Legacy MCP intake | Supported meaning |
|---|---|---|
| Off | Off | Existing behavior; no keyrings required |
| On | Off | Run service can drain/resume; new MCP calls remain legacy |
| On | On | Exact default-off legacy MCP canary enters App Runs |
| Off | On | Invalid; startup rejects the configuration |

Do not add an App-origin flag in Phase 3. Phase 5 adds that control with the
first real grant/binding entrance and persisted App installation/version/grant
authority.

## Frozen transition semantics

- App Runs are canonical execution state for governed work.
- `agent_actions` remains the current approval-inbox projection for the legacy
  compatibility path; it is not independent execution authority.
- Legacy action receipts remain historical compatibility. New App paths may not
  depend on the dual ledger after native App approval/Run UI and Phase 6 parity
  are certified.
- `AppRunOperationsService` remains an internal, production-denied repair
  primitive. Present operator access is the bounded runbook/SQL path; Phase 3
  makes no public operations API or UI claim.
- `944b265f` may be named only as a local source checkpoint. The operational
  rollback floor becomes the first released image containing the final closeout
  contract.

## Loop 0 — Persist plan sources and freeze merge mechanics

**Mode:** one docs-only preservation commit, then read-only audit.

### Work

- Create a clean PR C worktree/branch from the C3 tip. Do not use the dirty main
  worktree as the execution checkout.
- Preserve the reviewed revised delivery and closeout plans in that worktree.
  Apply the reviewed status/current-delivery pointer to the current tracked
  `2026-08-29-full-surface-app-platform.md`; do not replace its newer Phase 1–3
  implementation evidence with the older dirty-main body. Inspect and commit
  the three results as one docs-only plan-source change. Do not delete, move, or
  rewrite the copies in the dirty main worktree or any unrelated Hermes
  material.
- Fetch and inspect current `origin/master`, migration manifest, branch ancestry,
  and both worktrees without changing the dirty main worktree.
- Freeze PR C as `399cd030..d5192c55` plus that one plan-source commit.
- Freeze PR D as C4–D2 plus the rollout-control and closeout corrections in this
  plan.
- Prefer a merge commit for PR C so the reviewed local ancestry remains useful.
  If repository policy or the final merge uses squash/rebase, stop and rebuild
  PR D from the actual merged default branch.
- Freeze the final validation matrix now; later loops do not add unrelated
  certification.

### Evidence

- Clean Phase 3 worktree.
- Correct merge base and bounded name-status diffs.
- No migration-number conflict with current default branch.
- All three plan sources are tracked in PR C and their cross-links resolve.
- Written PR boundaries and flag truth table agree with this plan.

**Loop 0 result (2026-08-30):** `origin/master` remained `399cd030`; PR C
remained based on that commit through C3 `d5192c55`; upgrade slots `.19`–`.21`
were unclaimed on the base; the worker factory remained production-unregistered;
and the three plan sources were isolated on `codex/app-platform-phase-3-pr-c`
without modifying the dirty main worktree.

### Stop conditions

- Default branch moved in a way that conflicts with migrations `.19`–`.21`.
- C4/C5 behavior is required merely to make PR C schema boot safely.
- PR C contains a reachable provider entrance.
- The flag split would require changing the certified attempt/state model rather
  than only entrance selection.

## Loop 1 — Review and certify PR C

**Outcome:** the trust/data train is independently safe, additive, and dormant.

### Included work

- C0 release fencing, exact attempt jobs, result classification, and budget
  evidence hooks.
- C1 live membership, employee, token, connector, assignment, provider-schema,
  and budget authority versions.
- C2 App Run-owned approval resolution with one safe compatibility projection.
- C3 tenant-bound ancestry constraints, receipts, Attention projections, and
  internal repair invariants.
- Migrations `.19`–`.21` exactly as currently reviewed unless Loop 0 discovers
  an actual defect.

### Excluded work

- Runtime construction, worker registration, provider entrance, legacy MCP
  selection, App routes, or App-origin authority.
- Refactors, renames, generalized operation surfaces, or new retention/ancestry
  behavior.

### Focused evidence

- Shared App Run contract tests.
- Database upgrade representation for `.19`–`.21`.
- Disposable-database Run lifecycle, live-authority, approval, ancestry,
  receipt, leakage, and repair tests.
- App Run architecture checks and focused approval/trust sentinels.
- API typecheck.

Do not run browser, Docker, production image, pgvector fresh bootstrap,
capability flag parity, or a repository-wide production build in PR C.

**Loop 1 result (2026-08-30):** shared App Run contracts passed 10/10;
upgrade/schema representation passed 23/23; the complete C3 App Run database
suite passed 19/19; approval-resolver database behavior passed 23/23; focused
keyring, architecture, approval-matrix, and MCP trust-boundary suites passed;
and the API typecheck passed. The disposable database used the current schema
with only the two unrelated embedding columns represented as `bytea`, then
applied and verified extras `.16`–`.21`; no `CREATE EXTENSION vector`, browser,
Docker, production build, or supported fresh-schema claim was made.

## Loop 2 — Open, review, and merge PR C

### Work

- Inspect the final diff and untracked files from the PR C worktree.
- Confirm every new persistent object has a production writer, bounded reader,
  tenant check, retention/cleanup owner, and a known runtime consumer in PR D.
- Open PR C and wait for required CI/review.
- Merge only when required checks pass.
- Record the actual merge commit and migration checksums.

### Rebase rule

If PR C is squash/rebase merged, no later local hash is treated as proof against
the new default branch. Create a fresh PR D branch from the actual merge and
replay only C4, C5, certification docs, and the closeout changes. Update every
affected hash/reference once.

## Loop 3 — Re-anchor PR D

**Mode:** structural only unless conflicts require a correction.

### Work

- Fetch the merged default branch.
- Rebase/rebuild the runtime closeout train according to Loop 2's merge result.
- Prove the resulting review diff begins with runtime/worker composition rather
  than repeating PR C.
- Update source-checkpoint references if ancestry changed.

### Evidence

- Clean status.
- Bounded `origin/master...HEAD` diff.
- PR C files appear only where C4/C5 genuinely modify them.
- No test rerun when the re-anchor is conflict-free; changed conflicts receive
  only their mapped focused tests.

## Loop 4 — Split Run draining from legacy MCP intake

**Outcome:** operators can enable the Run engine to drain accepted work without
routing new legacy MCP calls into it.

### Production changes

- `apps/api/src/lib/env.ts`
  - parse/export `DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED`;
  - reject legacy cutover when `DEFT_APP_RUNS_ENABLED` is not enabled;
  - keep keyring validation bound to the Run engine flag.
- `apps/api/src/lib/capability-service.ts`
  - choose governed versus legacy execution from the legacy intake flag;
  - never shadow-call or fall back after governed execution begins.
- `apps/api/src/lib/agent-actions.ts`
  - skip the legacy employee budget reservation only when legacy MCP intake is
    actually routed through App Runs.

`app-run-runtime.ts` and `app-run-worker-handler.ts` continue to use
`DEFT_APP_RUNS_ENABLED` as the engine/drain gate. Change only misleading
comments unless a focused test proves a behavior defect.

### Test changes

- Update the shared immediate/action disposable-database fixture to select
  governed cases from the intake flag, not the engine flag.
- Add Capability Service coverage for engine-on/intake-off and
  engine-on/intake-on with one selected path and no fallback.
- Add a small configuration test for invalid engine-off/intake-on startup.
- Add architecture assertions that engine consumers and intake consumers use
  the correct controls.
- Touch worker queue coverage only to prove the new intake flag does not pause
  draining; preserve the existing engine-off defer/no-attempt behavior.

### Configuration and documentation

- Update `.env.example`, self-hosting, the App Run runbook, rollout decision,
  Phase 3 loop plan, and certification audit.
- Add explicit Compose wiring only if repository policy requires documented
  variables to be repeated; the existing `.env` pass-through is otherwise
  sufficient.

### Acceptance

- Engine off/intake off preserves exact legacy behavior and requires no Run
  keys.
- Engine on/intake off leaves new MCP calls legacy while accepted Run work can
  resume.
- Engine on/intake on creates one Run/attempt and at most one provider call.
- Engine off/intake on fails startup.
- All unspecified/malformed values fail closed.

### Completed evidence

- Split-control implementation checkpoint: `5cf88c51`.
- Capability Service, architecture, and rollout configuration: 27 passed.
- Real isolated startup rejects off/on; malformed uppercase intake fails closed.
- API typecheck passed.
- Shared disposable fixture with engine on/intake off: 10 legacy cases passed,
  6 governed cases skipped.
- Same fixture with engine on/intake on: 6 governed cases passed, 10 legacy
  cases skipped.
- Runtime and worker-handler source remain engine-controlled and have no intake
  flag dependency. Dynamic drain/defer certification remains in Loop 6.

## Loop 5 — Correct closeout truth and ownership

**Outcome:** documentation describes the shipped boundary rather than local
checkpoint assumptions.

### Work

- Record the dual-ledger exit and native App transition gate.
- Mark Operations as an internal production-denied primitive.
- Replace local-source rollback claims with the future released-image floor.
- Correct any schema/code comment that still calls the post-C5 engine only a
  dormant foundation.
- Record the supported flag combinations and distinct merge versus publication
  gates.
- Create a new certification checkpoint because the flag contract is newer than
  `5050b0f1`.

### Evidence

- Documentation/link checks when available.
- `git diff --check`.
- No database, browser, Docker, or build rerun for prose-only changes.

### Completed record

- The four-state matrix, drain-first rollback sequence, dual-ledger exit,
  internal-only Operations boundary, App-origin deferral, and future immutable
  released-image floor are recorded in the environment example, self-hosting
  guide, operations runbook, ADR, canonical/delivery/Phase 3 plans, and
  certification audit.
- Compose already passes `.env` to services, so no duplicate variable wiring is
  required.

## Loop 6 — Run one PR D delta certification

**Outcome:** fresh evidence covers exactly the runtime/cutover and split-control
boundaries.

### Required matrix

1. Capability Service unit and architecture tests.
2. One shared disposable database/provider fixture in three supported modes:
   - engine off, intake off — exact legacy parity;
   - engine on, intake off — new calls legacy plus focused durable-job
     drain/resume;
   - engine on, intake on — governed safe/read and reviewed-action cases.
3. One accepted-approval drain transition:
   - create a Run that is pending approval with engine and intake on;
   - restart with engine on and intake off, then approve and prove exactly one
     Run execution, no second budget reservation, and no legacy fallback;
   - prove engine off leaves the approval pending/fail-closed rather than
     resolving it through the legacy path.
4. Engine off/intake on startup rejection.
5. The complete existing `apps/api/test/app-run-engine-db.test.ts` suite once at
   the final PR D tip; C4/C5 materially change runtime composition and intake.
6. Focused worker defer/resume, connector, trust, approval, keyring, leakage,
   and low-level MCP-boundary tests.
7. API and participating-package typecheck.
8. `git diff --check` and final worktree inspection.
9. One final production source build only if normal PR CI does not already run
   the equivalent build against the exact tip.

### Evidence reuse

- Preserve PR C evidence for unchanged C0–C3 boundaries through merge ancestry,
  but do not use it to skip the final full engine database suite required above.
- Treat evidence at `5050b0f1` as historical review support, not proof of the
  new split-control contract.
- Reuse one provider stub, database setup, and parity assertion suite across all
  modes.

### Explicitly excluded local repetition

- No browser visual audit; no web UI changes exist.
- No Docker image or Compose build before the release candidate.
- No retry of `CREATE EXTENSION vector` on the known deficient local host.
- No repeated fresh-schema bootstrap locally.
- No unrelated Hermes or full API certification outside normal CI.

### Completed evidence (2026-08-31)

- The shared immediate/action fixture passed in all three supported modes:
  off/off 10 legacy cases, on/off 10 legacy cases, and on/on 6 governed cases.
- Cross-process transition test `app-run-rollout-transition-db.test.ts` passed
  at `fe66113f`. It uses the production approval resolver, runtime composition,
  worker settlement, and provider adapter to prove one pending approval survives
  intake shutoff, engine pause, and drain-only restart with one attempt, one
  budget reservation, one provider call, and no legacy fallback.
- The complete App Run engine database suite passed 20/20 at that checkpoint.
- The focused shared contract, Capability Service, architecture, rollout,
  keyring, connector, trust, leakage, worker-routing, and MCP-boundary group
  passed 117/117. The focused approval and worker-reliability database group
  passed 27/27.
- Repository typecheck passed for every participating package. Final diff and
  database residue checks passed; the fixture left zero Runs, nonterminal Runs,
  active App Run jobs, or test identities.
- The production source build remains assigned to normal PR CI against the exact
  pushed tip, as allowed by item 9. The explicit local exclusions above were not
  repeated.

## Loop 7 — Open, review, and merge PR D default-off

### Work

- Inspect the complete runtime/cutover diff and untracked files.
- Confirm only provider adapters call the low-level MCP client.
- Confirm App, system, and automation origins remain denied.
- Confirm no new App manifest, Resource, scope/token, UI, public API, or hosted
  dependency surface entered the diff.
- Open PR D and wait for required CI/review.
- Merge default-off only after all required checks pass.

### Result

The merged commit is the authoritative source floor and a release candidate.
It is not yet the operational rollback floor and does not permit an opt-in,
default-on, or community App claim.

## Loop 8 — Run the release-candidate operational gate once

**Environment:** release-capable CI or a designated host with Docker,
pgvector/current schema, a deterministic MCP provider, and authority to perform
backup/restore and image rollback. Do not use the known deficient local host.

### Frozen release inputs

- The current repository candidate for the supported predecessor is
  `v0.3.0-preview.12` at `23694ef8`. Before running this gate, verify that its
  corresponding published immutable image/digest still exists and is the
  documented supported upgrade and rollback source.
- Record that source digest, its database migration ledger, its required
  configuration/key contract, and the exact quiescence query from
  `docs/app-run-operations.md` covering nonterminal Runs, pending compatibility
  approvals, and active App Run jobs.
- If no supported immutable predecessor artifact exists, stop the release gate
  and repair the release inputs. Do not substitute a local build of `399cd030`
  or any other unreleased commit as rollback evidence.

### Work

1. Build the immutable production image from the merged candidate.
2. Prove a fresh pgvector-backed installation.
3. On the frozen predecessor, create one legacy compatibility fixture containing
   an MCP connection, encrypted credential, assignment, pending approval,
   previously approved action, and legacy receipt. Record stable identifiers,
   authority/scope, and ciphertext fingerprints before upgrade.
4. Prove the supported upgrade from the frozen predecessor through the complete
   pending manifest path `.14`–`.21`; assert the Phase 3 `.17`–`.21` objects and
   current Agent Channel approval projections explicitly.
5. After upgrade, prove the preserved connector fixture still supports
   engine-off legacy execution and the opt-in governed canary without ciphertext
   rewrite, authority widening, duplicate provider effect, or receipt/history
   corruption.
6. Exercise all four flag combinations and their startup/runtime behavior.
7. Run one deterministic-provider approval/browser smoke without claiming a
   public Run UI.
8. Reuse the existing Hello Workspace reference fixture to install, activate,
   open, and disable the declarative App on the upgraded release image.
9. Back up and restore database, uploads/App artifacts where applicable, and
   all required keyrings at consistent points.
10. Rotate encryption, fingerprint, and signing keys; prove retained payload/
    receipt reads and referenced-key retirement refusal.
11. Prove intake-off drain, engine-off pause, and engine-on resume without
    attempt debit or duplicate provider dispatch.
12. Use the frozen quiescence query to prove no nonterminal Runs, pending
   compatibility approvals, or active Run jobs remain, then perform the actual
   supported rollback drill between the recorded immutable source and target
   images.
13. Record the immutable image digest and normal release security/provenance
    evidence.

### Failure rule

A failed gate keeps the affected entrance unsupported/off. Repair only the
failed boundary and rerun its dependent evidence; do not widen or restart the
whole phase. If repair would change the frozen Run state machine, provider-call
boundary, approval source of truth, secret-envelope/key contract, migration
checksums or constraints, or rollout truth table, stop closeout and reopen the
architecture gate before editing those contracts.

## Loop 9 — Seal Phase 3 and hand off Phase 4 planning

### Phase 3 decision record

- Record the merged and released revision and immutable image as the operational
  rollback floor.
- Record whether the legacy MCP canary is supported as opt-in or remains
  rejected based on release evidence.
- Keep App origin off until Phase 5.
- Publish the exact control matrix, key-loss limits, backup/restore contract,
  and remaining non-claims.
- Link the reviewed per-plane evidence record required by the proof-debt gate.

### Phase 4 planning handoff

Create a read-only Phase 4 loop plan against the exact released baseline. Freeze:

- independent Contacts and Campaigns artifacts and deterministic sandbox MCP
  provider;
- exact Campaign-to-Contact resource operations and caller surfaces;
- host-bound `ResourceRef` shape and additive Module reference schema version;
- ResourceAuthorizationService delegation boundary and closed adapter map;
- reference disable/archive/delete/dangling semantics;
- whether Task belongs in the first proof or the immediately following
  heterogeneous fixture;
- search/context shadow comparison and cutover/rollback rules;
- next available migration slot;
- focused acceptance matrix, release environment, exclusions, and stop
  conditions.

No Phase 4 code begins before the Phase 3 release evidence record exists.

## Phase 3 closeout exclusions

Route any request for the following to its owning phase rather than accepting it
as closeout follow-up work:

- ResourceRef, resource adapters, cross-App relations, picker, or search/context
  cutover — Phase 4.
- App resource/capability/dependency/action manifest fields, grants, connector
  bindings, persisted App-origin authority, AppActionService, action UI, safe
  Run APIs, or App token scopes — Phase 5.
- Sandbox-email interface expansion, connected templates/simulator, or external
  Contacts/Campaigns proof — Phases 5–6.
- Removing the approval compatibility projection or legacy receipt history —
  only after native App UI and Phase 6 parity.
- Connector ciphertext migration/re-encryption or legacy-key retirement.
- New App/system/automation/runtime origins or expansion of ancestry,
  reconciliation, retention, repair, Attention, or operator surfaces.
- Default-on rollout, arbitrary code, custom UI, automation, runtime, sync,
  public ingress, hosted KMS, marketplace, billing, or SaaS infrastructure.

## Completion definition

Phase 3 is complete only when both PRs are merged, the release-candidate gate
passes, the immutable rollback floor and control matrix are recorded, and the
Phase 4 handoff is based on that exact released state. A default-off code merge
without the operational gate is merged infrastructure, not completed rollout.
