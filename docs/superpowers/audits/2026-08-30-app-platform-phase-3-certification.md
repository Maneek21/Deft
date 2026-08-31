# App Platform Phase 3 certification checkpoints

- Date: 2026-08-30; consolidated PR D and immutable release gates 2026-08-31
- Historical pre-split baseline: `5050b0f1` with C5 source checkpoint
  `944b265f`; useful review evidence, superseded for rollout certification
- Current PR D certification checkpoint: `fe66113f` on PR C merge `9c8e9ac9`;
  split-control source checkpoint `5cf88c51`
- Released baseline: `v0.3.0-preview.14` at `6d39e0e`, image digest
  `sha256:e565cc64ee22b5b9f6f99973e3762b639c27e026dc8824852145035acdacf788`
- Current result: PASS. PR D, fix-forward App compatibility, remote CI/security,
  immutable publishing, upgrade, recovery, rotation, drain, quiescence, and
  rollback gates passed.
- Rollout decision: off/off remains the default. The legacy MCP canary is
  supported only as an explicit self-host opt-in using the documented split
  controls. App origin remains disabled until Phase 5 grants and bindings.
- Detailed release record:
  `2026-08-31-app-platform-phase-3-release-certification.md`

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

## Consolidated PR D local gate

The 2026-08-31 run used PostgreSQL 16 database
`deft_phase3_prc_20260830_01`. It ended with zero App Runs, zero nonterminal
Runs, zero active App Run jobs, and no transition or approval-resolver fixture
residue.

| Boundary | Evidence | Result |
|---|---|---|
| Engine off/intake off | shared immediate/action fixture | 10 legacy cases passed; 6 governed cases skipped |
| Engine on/intake off | same fixture | 10 legacy cases passed; 6 governed cases skipped |
| Engine on/intake on | same fixture | 6 governed cases passed; 10 legacy cases skipped |
| Accepted approval across restart states | `app-run-rollout-transition-db.test.ts` using the production approval resolver, runtime, worker, and provider adapter | 1 passed; one Run, one attempt, one budget reservation, one provider call, no legacy receipt/fallback |
| Complete App Run engine database suite | `app-run-engine-db.test.ts` at `fe66113f` | 20 passed |
| Shared contract, architecture, rollout configuration, keyring, Capability Service, connector, trust, worker routing, leakage, and MCP boundary | focused serial group | 117 passed |
| Approval and worker defer/retry compatibility | focused database group | 27 passed |
| Participating TypeScript packages | repository `pnpm typecheck` | passed for web, API, shared, and App Kit |
| Diff and residue hygiene | `git diff --check`, bounded full-delta inspection, and database residue queries | passed |

The transition proof starts with intake and engine enabled, persists a pending
approval, proves engine-off approval fails closed, approves after restart in
drain-only mode, proves engine-off returns the durable job to pending without a
retry debit, and resumes it in drain-only mode. A replay through the registered
handler does not call the provider again.

No browser, fresh-schema, pgvector retry, Docker image, or self-host smoke was
run locally because this delta changes no UI or migration and those checks are
explicit release-candidate gates. The one production source build is delegated
to normal PR CI against the exact pushed tip; run it locally only if that CI job
does not execute.

## PR D remote gate — complete

- PR D #274 merged after the required typecheck, API, upgrade, production-image,
  browser, Hermes, dependency, and CodeQL checks passed.
- The Hello Workspace release gate then exposed a package-byte versus parsed-
  manifest digest mismatch. The smallest boundary repair shipped in #275 with
  a deterministic red/green regression and the same full remote check set.
- The merged fix-forward revision is `6d39e0e`; no Run state machine, migration,
  token, connector, UI, or rollout-control contract changed.

## Release-artifact gates — complete

- The supported predecessor is `v0.3.0-preview.12` at `23694ef8`, digest
  `sha256:34b306e53e5c959468a973a50aaeb3b59235c56e631d67003f7780d18002d24b`.
- The target is `v0.3.0-preview.14` at `6d39e0e`, digest
  `sha256:e565cc64ee22b5b9f6f99973e3762b639c27e026dc8824852145035acdacf788`.
- Upgrade through `.21`, deterministic-provider canary, App lifecycle,
  matched backup/restore, three-purpose key rotation, retirement refusal,
  pause/drain/resume, exact quiescence, and immutable image rollback passed.
- This target image is the first operational rollback floor containing the
  final split-control and durable job-pause contract.

App origin remains disabled. The legacy MCP canary may be enabled only through
the documented self-host controls after a matched backup and canary; the
release does not authorize default-on production widening.
