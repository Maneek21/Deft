# App Platform Phase 3 certification checkpoints

- Date: 2026-08-30
- Historical pre-split baseline: `5050b0f1` with C5 source checkpoint
  `944b265f`; useful review evidence, superseded for rollout certification
- Current PR D control checkpoint: `5cf88c51` on PR C merge `9c8e9ac9`
- Current result: split-control delta acceptance passed; consolidated PR D and
  immutable release-artifact gates remain
- Rollout decision: off/off by default; merge alone does not make the legacy MCP
  canary supported

## Current split-control delta

| Boundary | Evidence | Result |
|---|---|---|
| Three safe flag states, malformed intake, and invalid engine-off/intake-on startup | real isolated environment imports plus pure configuration checks | 3 passed |
| Capability Service one-path selection, no shadow call, and no governed-to-legacy fallback | focused unit tests | passed |
| Engine versus intake consumers | architecture scan plus runtime/handler assertions | passed |
| Capability, architecture, and rollout configuration group | focused API tests | 27 passed |
| Engine on/intake off | shared immediate/action disposable-database fixture | 10 legacy cases passed; 6 governed cases skipped |
| Engine on/intake on | same fixture, provider stubs, and parity assertions | 6 governed cases passed; 10 legacy cases skipped |
| API TypeScript | `pnpm --filter @deft/api typecheck` | passed |
| Diff hygiene at the code checkpoint | `git diff --check` and bounded inspection | passed |

The engine flag remains the only runtime/keyring/worker drain control. The
legacy intake flag is consumed only by Capability Service and the legacy
employee-budget bridge. A governed selection calls no legacy fallback even when
the governed path throws. No UI, migration, token, connector-ciphertext, hosted
dependency, or App-origin authority changed in the split.

## Historical evidence retained through ancestry

The pre-split certification at `5050b0f1` covered shared App Run contracts,
additive migrations `.17`–`.21`, key separation and rotation, lifecycle and
crash recovery, live authority and budgets, approval ownership, ancestry,
receipts, Attention, provider pinning, worker registration, leakage boundaries,
repository typecheck, and a production source build. PR C independently passed
required CI after merge-train reconstruction, including a real pgvector fresh
schema, supported upgrade, production image, self-host smoke, browser smoke,
CodeQL, dependency checks, API tests, typecheck, and build.

That evidence remains valid for unchanged trust/data boundaries. It does not
prove the newer control matrix, worker drain transition, or final PR D tip;
those belong to the consolidated delta run and release gate below.

## Execution and UI ownership

`app_runs` is canonical execution state. `agent_actions` is the current
approval-inbox projection for the legacy compatibility entrance, and legacy
action receipts remain historical compatibility. After native App approval/Run
UI and Phase 6 parity are certified, no new App-origin path may depend on this
dual ledger.

`AppRunOperationsService` is an internal, production-denied repair primitive.
Phase 3 exposes no public operations route or UI. Present operator access is the
bounded, tenant-scoped SQL and procedure contract in
`docs/app-run-operations.md`.

## Remaining PR D consolidated gate

- Run engine off/intake off exact legacy parity.
- Engine on/intake off durable-job drain/resume and engine-off defer without an
  attempt debit.
- Accepted-approval transition across intake-on, drain-only, and engine-off
  process states with one Run, one provider effect, and no fallback.
- Complete `apps/api/test/app-run-engine-db.test.ts` at the final PR D tip.
- Focused worker, connector, trust, approval, keyring, leakage, and MCP-boundary
  tests; participating typecheck; final diff inspection.
- One production source build only if normal PR CI does not run the equivalent
  build against the exact tip.

## Remaining release-artifact gates

- Build and identify the immutable merged candidate image and its supported
  predecessor; record both digests and migration ledgers.
- Prove a current pgvector-backed fresh install and supported upgrade through
  `.21` on release-capable infrastructure.
- Run deterministic-provider canary and approval/browser smoke without claiming
  a public Run UI.
- Back up and restore database, uploads/App artifacts where applicable, and all
  Run keyrings at consistent points; exercise rotation and referenced-key
  retirement refusal.
- Disable intake, drain and quiesce governed work, then perform the actual
  supported image rollback drill.
- Record the first released image containing the final split-control contract as
  the operational rollback floor.

Until those gates pass, App origin remains disabled, the legacy MCP canary stays
default-off and unsupported for production widening, and no local source hash
is an operational rollback floor.
