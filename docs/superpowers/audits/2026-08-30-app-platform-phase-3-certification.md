# App Platform Phase 3 local certification

- Date: 2026-08-30
- Runtime candidate: `944b265f`
- Result: local code acceptance passed; release-only infrastructure gates remain
- Rollout decision: disabled by default, self-host opt-in only; do not widen
  further until the external gates below pass on a released image

## Verified matrix

| Boundary | Evidence | Result |
|---|---|---|
| Shared capability and App Run contracts | `@deft/shared` tests | 55 passed |
| Fresh-schema/upgrade representation and additive migrations `.17`–`.21` | `@deft/db` upgrade contract tests | 23 passed |
| Key configuration, AEAD/AAD, rotation, fingerprints, receipt signing, retirement refusal | App Run secret tests | passed |
| Capability Service, pinned MCP adapter, one-path flag selection, no shadow/fallback | focused API tests | passed |
| Architecture and leakage boundaries | App Run and Capability architecture tests | passed |
| Trust, approval matrix, connector network/credential safety, provider-text boundary | focused API tests | passed |
| Worker registry, lifecycle, lease fencing, retry exhaustion, and flag-off defer | focused worker and queue tests | passed |
| Run lifecycle, concurrency, release, live authority, budgets, crash recovery, ancestry, receipts, Attention, operations, and atomic jobs | disposable-database engine tests | 20 passed |
| Exact flag-off Phase 2 immediate/action/approval compatibility | same disposable fixture with flag false | 10 passed; 6 governed cases skipped |
| Exact flag-on safe read, unrepresentable result, post-effect membership revocation, concurrent action replay, reviewed approval replay, and ambiguous transport | same disposable fixture with valid keyrings and flag true | 6 passed; 10 legacy cases skipped |
| API discovery routes and legacy approval resolver assertions | disposable-database focused group | passed with the stale-fixture caveat below |
| Repository TypeScript | `pnpm typecheck` | passed for all participating workspaces |
| Production source build | `pnpm build` | API and optimized Next.js build passed; 43 web routes generated |

The consolidated runs reported 55 shared tests, 23 upgrade tests, 104 focused
non-database API tests, 69 selected flag-off database tests, and 6 selected
flag-on database tests with no assertion failures. Exact provider results,
inputs, retry keys, ciphertext, and key material remained outside safe ledgers
in the explicit leakage assertions.

## Rollback and operations decision

`docs/app-run-operations.md` is the operator contract. It covers initial key
generation, additive current-key rotation, read/verify overlap, reference-based
retirement refusal, database-plus-keyring backup/restore, disaster recovery,
flag-off pause behavior, downgrade queries, and the future hosted KMS seam.

The source-level execution rollback floor is `944b265f`. Exact flag-off on that
floor routes new calls through the unchanged legacy path and defers durable App
Run jobs without spending attempts. Downgrade below that floor is not allowed
until there are no nonterminal Runs, pending `app_run_invoke` approvals, or
active `app-run-attempt` jobs.

Existing connector ciphertext and legacy action-receipt writers remain
unchanged. There was no in-place re-encryption, token migration, new hosted
dependency, or default enablement.

## Explicitly unverified release gates

- The Docker daemon is not running on this host, so no production image,
  Compose self-host smoke, rolling-image drill, or scripted backup/restore was
  executed. The production source build passed.
- Local PostgreSQL has no pgvector installation. Per the established test
  constraint, `CREATE EXTENSION vector` and another `db:push-full` bootstrap
  were not retried. Static fresh/upgrade convergence tests passed, and the
  disposable database exercised the Phase 3 `.17`–`.21` objects, but a final
  pgvector-backed fresh install and supported-upgrade drill remains a release
  gate.
- The disposable clone has no upgrade ledger and predates current Agent Channel
  lease columns. The legacy approval-resolver assertions passed, but its
  best-effort `approval.resolved` Agent Channel projection logged the missing
  `claim_owner` column. A current-schema environment must rerun that projection
  before release; the Phase 3 compatibility fixture's approval/receipt path was
  clean.
- No browser approval/Run-inspection pass was run. Phase 3 changes no web UI and
  has no App Run operator UI; API/database compatibility and the production web
  build passed. A released-image browser smoke with a deterministic MCP provider
  remains a widening gate.
- No actual downgrade to an older released image was performed. The source
  rollback behavior and queue pause are tested; the image-level drill remains
  blocked by Docker and by the absence of a released C5-floor image.

These omissions do not invalidate the local implementation result. They do
block default-on rollout, broad opt-in recommendation, and hosted-service
enablement. Phase 3 should merge as additive guarded work, then complete the
listed image/current-schema gates before a release announcement widens use.
