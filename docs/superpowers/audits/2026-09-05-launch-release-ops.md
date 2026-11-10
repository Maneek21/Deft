# Public self-hosted preview: release and operations audit

Date: 2026-09-05. Scope: diagnosis and launch roadmap; no product fixes or service changes.

This report reviews GitHub master `7355c90a0ab5630b839440e8e25133b63853835c`, using an isolated archive at `tmp/launch-audit-2026-09-05/current`. The original checkout is older (`2d478aee`, preview.12); conclusions below use the current archive unless explicitly stated otherwise. The latest published release identified by the coordinating audit is preview.14 at `6d39e0e0413c82d36c9481849ae582fdf805d1a6`.

The public-preview release path is well developed, but I would close the three P1 operational defects below before promoting a new release to unfamiliar self-hosters. Green CI does not cover these failure paths. Broader feature work should not displace these fixes and the final customer-path certification.

## Findings

### OPS-1 — P1: Download-only installation references an unpublished initialization file

The named-release guide tells users to download only `docker-compose.yml`, `compose.prod.yml`, `compose.release.yml`, and `default.env.example` into a directory. The resulting Compose configuration still bind mounts `./scripts/docker/enable-pgvector.sql` into PostgreSQL. That file is neither one of those downloads nor separately packaged by the release workflow; the release overlay does not remove the mount.

Sources at the audited commit:

- [docs/self-hosting.md:43](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/docs/self-hosting.md#L43): four-asset download instructions.
- [docker-compose.yml:149](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/docker-compose.yml#L149): missing host bind.
- [.github/workflows/release.yml:312](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/.github/workflows/release.yml#L312): release asset packaging.

Fresh reproduction: copied precisely those assets to an isolated directory, supplied a disposable placeholder database password and the preview.14 image name, and ran `docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml config --format json`. No image pull, container start, or database write occurred. Compose exited 0, but its resolved PostgreSQL mount reported:

```json
{
  "target": "/docker-entrypoint-initdb.d/01-enable-pgvector.sql",
  "sourceExists": false,
  "postgresPublishedPorts": []
}
```

The missing dependency is confirmed. Full first-boot failure was not run because the Docker engine is unavailable. The likely failure follows directly from Docker's documented behavior: a missing short-syntax bind source becomes a directory; PostgreSQL's entrypoint processes names ending in `.sql` with `psql -f`. See [Docker Compose volume semantics](https://docs.docker.com/reference/compose-file/services/#volumes) and the [official PostgreSQL image entrypoint](https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh#L173).

Fix options: make the release Compose package self-contained, or remove this host-file dependency for the release path and let the existing `db:push-full` extension initializer handle it. Requiring a clone/source extraction is also possible, but then change the stated download-only contract. Verify the chosen solution from a completely empty directory and fresh volume with only the published artifacts.

### OPS-2 — P1: Upgrade failures can restart old code against an already changed schema

`selfhost-upgrade.ts` tracks whether the application stopped and whether recreation completed. On any intervening error it starts the previous container. It does not track whether migrations started or committed. The database upgrader commits each migration independently, so both a later migration failure and an application recreation failure can leave an advanced schema behind.

Sources:

- [scripts/selfhost-upgrade.ts:166](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/scripts/selfhost-upgrade.ts#L166): state tracking and unconditional previous-container restart.
- [packages/db/scripts/upgrade.ts:206](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/packages/db/scripts/upgrade.ts#L206): per-migration transaction.
- [packages/db/scripts/upgrade.ts:294](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/packages/db/scripts/upgrade.ts#L294): separately committed migration loop.

Fresh reproduction executed the current exported `main()` after TypeScript transpilation, with `child_process.spawn` replaced by an in-memory event emitter. Every external command was mocked. Injected exit code 1 at each stage gave:

| Failure injected | Commands observed | Old app restarted |
|---|---|---|
| Backup | stop, backup, restart_previous | Yes; schema has not been touched |
| Migration | stop, backup, migration, restart_previous | Yes; earlier migrations may already have committed |
| Recreation after migration success | stop, backup, migration, recreation, restart_previous | Yes; target schema has already been applied |

This is a recovery-policy defect, not a claim that every additive migration breaks every older build. It contradicts the documented forward-only upgrade and explicit rollback-floor discipline when schema compatibility is unknown. Treat migration-started failures as requiring a known-compatible target or explicit restore, and automatically resume the old container only when there is evidence the schema remained unchanged. Add failure-injection coverage for backup failure, first migration failure, later migration failure after a commit, recreation failure, and post-upgrade health failure.

### OPS-3 — P1: The container does not supervise API failure

The entrypoint launches the API in the background and `exec`s Next.js. The Compose app service has `restart: unless-stopped`, but no API-aware container health check or supervisor. If the API exits while Next remains alive, Docker still sees a live container; users can load the UI while auth, chat, tasks, and workers are unavailable. The same process arrangement lacks explicit forwarding of shutdown signals to the API, despite the API implementing a bounded graceful drain.

Sources:

- [scripts/docker-entrypoint.sh:6](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/scripts/docker-entrypoint.sh#L6): background API and foreground web.
- [docker-compose.yml:36](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/docker-compose.yml#L36): restart policy; the only declared health check is PostgreSQL's.
- [apps/api/src/server.ts:92](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/api/src/server.ts#L92): API shutdown implementation.

Fresh reproduction ran the shell structure under Git Bash with only hard-coded paths and the Node executable replaced by harmless fixture paths. The fake API exited 7 immediately, while the fake web process stayed alive for three seconds. At one second: `apiExitCode=7`, `webRunning=true`, `containerMainStillAlive=true`. The entrypoint ultimately exited 0 when the web fixture finished. No real server was started or stopped. This verifies process supervision behavior, not Linux container signal delivery.

Use a minimal supervisor/entrypoint that observes both processes, exits/restarts the container on unexpected child death, forwards signals, and bounds shutdown; or separate the two services with explicit lifecycle management. Test API crash, web crash, SIGTERM during startup, active WebSockets, and an in-flight leased job using an isolated production image. Adding a health check alone does not make ordinary Compose restart unhealthy containers.

### OPS-4 — P2, complete before advertising safe upgrades: Public recovery instructions are incomplete

The backup wrapper writes a PostgreSQL dump only. The guide correctly says uploads must also be backed up and that recovery requires the previous image digest, but it does not provide an upload backup/restore procedure. Its plain-SQL restore examples run `psql` against the existing `deft` database without a clean-target setup or `ON_ERROR_STOP`. Following them against an initialized database risks duplicate-object/data errors and partial restoration. They also omit consistent release/prod overlays from the examples.

The download-only release path requires no host Node/pnpm, yet its later named-release upgrade instructions require `pnpm selfhost:upgrade` and repository scripts that are absent from the downloaded asset directory. Provide either a packaged operator wrapper or the equivalent safe Docker-only sequence.

Sources: [self-hosting backup/restore guide:467](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/docs/self-hosting.md#L467), [upgrade instructions:526](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/docs/self-hosting.md#L526), and [backup implementation:347](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/scripts/selfhost-reset.ts#L347).

This is a public runbook gap, not absence of all restore testing. The App Run operations guide already requires matching keyring backups, and internal certification performs fail-fast restore onto an isolated target with cryptographic continuity checks. Turn that internal discipline into an executable operator procedure: stop/drain writes, record exact image/config, back up DB/uploads/required secrets as one recovery point, restore to a fresh isolated target, verify counts and file hashes, verify provider-key/App Run-key decryptability where configured, inspect pending/unknown outcomes, then switch traffic. State measured recovery time and what writes could be lost.

### OPS-5 — P2: Final certification should cover the exact public artifact and default feature set

The standard production-image job builds Apps enabled and seeds the demo database, bypassing the public fresh-owner `init` journey and downloaded Compose assets. Release publishing rebuilds its own image with the release flags, and directly gates on Hermes certification rather than re-running the complete public installation/upgrade journey against the published digest. The documented requirement to release from green master is valuable; keep it and bind final smoke evidence to the artifact actually shipped.

Sources: [.github/workflows/ci.yml:354](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/.github/workflows/ci.yml#L354), [demo-seeded image startup:412](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/.github/workflows/ci.yml#L412), [release publish dependency:142](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/.github/workflows/release.yml#L142).

The manual Track A workflow pins candidate `121aa7c0b332819abc039874dc421b390d5ed106`, while its certifier can run at current master `7355c90a`. The coordinating audit compared these revisions and found only four certification/orchestration files changed, with no product-source delta. Its product evidence therefore remains relevant to current master; the SHA difference alone is not an untested-product finding. Preserve that strong candidate-specific evidence and run the final customer gate again after the launch fixes against the chosen release digest.

## What is already strong

- The product contract explicitly limits support to one workspace per deployment, BYO providers/runtimes, and core operation without AI keys. Hosted SaaS, managed OAuth connectors, and a marketplace are not promised.
- The production overlay removes PostgreSQL publishing; the fresh Compose-config probe confirmed an empty PostgreSQL port list.
- Fresh initialization refuses existing application tables before schema push. Destructive resets require explicit force and stronger authorization for public/production targets.
- The release upgrader rejects unknown versions and changed checksums, takes an advisory lock, and rolls back a failed migration transaction. Existing migration files shipped in preview.14 are unchanged in current master; the release-to-master delta adds migrations `.22`–`.26` and manifest entries.
- Standard CI has a real pgvector baseline upgrade from preview.1, idempotency, and before/after snapshots of representative messages, tasks, wiki, teams, and action data.
- Internal App-platform certification includes isolated backup/restore, exact candidate/baseline identities, key continuity, predecessor reads, browser evidence, and disposable-resource cleanup. The coordinating audit independently retrieved a successful Track A run with 375 matched rows across 22 tables and 24 receipts. This report inspected the corresponding scripts but did not re-run that database certification locally.
- Release publication includes exact source, AGPL-3.0-only metadata, NOTICE/third-party attribution, SBOM, checksums, digest-bound provenance, signing/verification, and matched Hermes archive/certificate digests. This review found no missing top-level licensing asset; it is not a legal or exhaustive transitive-license audit.
- Security CI includes dependency audit/review, CodeQL, and a production-image critical-vulnerability gate. Current limitations candidly state the absence of an independent security audit and capacity guarantees.

## Fresh local validation

Executed on the current isolated archive with Node `24.14.0`; CI uses Node 22 and pnpm 11.10.0. Direct Node/tsx invocation avoided this host's different pnpm wrapper. Results are not represented as exact CI-runtime parity.

| Check | Result | What it proves |
|---|---|---|
| `node --test scripts/release-workflow.test.mjs scripts/app-platform-certification-workflow.test.mjs scripts/inject-public-env.test.mjs` | 19 passed; 0 failed/skipped | Publishing/certification structure, carried artifact checks, URL injection fixtures |
| `node node_modules/tsx/dist/cli.mjs --test packages/db/scripts/upgrade.test.ts scripts/selfhost-upgrade.test.ts scripts/selfhost-reset.test.ts` | 44 passed; 0 failed/skipped | Schema/manifest assertions, reset safety, command plans |
| Download-only Compose configuration probe | Valid config; missing bind dependency confirmed | OPS-1 packaging gap; production database port isolation |
| Mocked exported upgrade `main()` failure probe | Old app restarted after migration/recreation errors | OPS-2 recovery behavior without external commands |
| Harmless entrypoint subprocess fixture | API exited 7 while main stayed alive | OPS-3 missing child supervision |

Distinct automated tests: **63 passed**. These structural/unit tests did not run migrations against PostgreSQL. Docker CLI configuration works, but the Docker engine was unavailable (`docker_engine` pipe absent); no production-image build/boot, live DB upgrade, actual restore, live API crash, or Linux signal test was performed locally. Existing workspace data and services were not modified. Probe files are under `tmp/launch-audit-2026-09-05/ops-probes`; the only durable authored report is this file.

## Launch sequence and acceptance evidence

1. **Freeze scope and identify the candidate.** Select the exact launch commit and supported feature flags. Keep experimental Apps/automation intake disabled unless intentionally included and separately certified. Preserve local unrelated work; do not launch from the stale root checkout by accident.
2. **Close OPS-1 through OPS-3 with focused regressions.** Add a packaged-assets install check, mocked failure-stage upgrade tests, and production-image process-death/signal tests. Update the recovery instructions in the same stabilization window.
3. **Run the documented install on a clean Linux amd64 host.** Use only downloadable release artifacts, no repository files or pre-existing volumes. Verify default-off AI operation, first owner creation, invite/member login, chat/task/wiki/calendar/file workflows, refresh/restart persistence, and doctor plus authenticated MCP smoke. Repeat with the documented HTTPS/reverse-proxy setup and representative desktop/mobile browsers.
4. **Certify both supported upgrade lanes.** Upgrade a seeded preview.1 baseline and a realistic preview.14 deployment to the exact candidate. Include uploads, credentials, private resources, approvals/receipts, and pending jobs. Record counts/hashes/invariants, migration ledger, repeated-upgrade idempotency, and rejection of unknown/checksum-altered histories. The existing baseline job provides part of this proof; the wrapper and latest-release lane need explicit end-to-end evidence.
5. **Rehearse failure recovery.** Inject backup failure, later-migration failure, image recreation failure, API child death, and database outage. Restore DB/files/secrets onto a new target, use the prior compatible digest, and verify the same invariants. Measure recovery duration and inspect leased/pending/unknown work before resuming writes. Never practice on the only copy of real data.
6. **Run an overnight small-pilot soak.** Use the documented 2-vCPU/4-GB class or publish the actual tested minimum. Exercise multiple users, WebSockets, file volume, scheduled work, provider unavailable/rate-limited behavior, log growth, memory, disk consumption, and recovery after restart. Keep capacity claims bounded to observed results.
7. **Publish and verify the immutable release.** Require all selected-commit checks, package/sign once, verify source/manifest/SBOM/checksums/signature, pin by digest, then repeat the short download-only install smoke against that digest. Publish tested platform/resources, known limitations, exact upgrade/recovery instructions, and a clear issue/security-reporting route.

The April release-readiness report and August preview.12 Hermes certification describe different revisions and environments. They are useful regression prompts, not evidence that current issues remain open or that the current launch is certified.


## Appendix: local worktree inventory

Read-only inventory of all 25 registered worktrees, compared with current master 7355c90a. No fetch, prune, checkout, reset, or cleanup was performed. Status checks intentionally excluded untracked files; this is a tracked-work inventory, not a claim that every directory contains no unpublished files. External worktrees required an exact per-command safe.directory override; no Git configuration was persisted.

| Group | Count / identity | Interpretation |
|---|---|---|
| Tips already ancestors of current master | 15, including root master, phase3 PR C, phase4, phase5 foundation/idempotency/cutover/planning/audit/certifier, phase6 authoring/audit/certifier, phase2 engine, and two historical detached checkouts | Completed history, not 15 launch tasks |
| All unique patches already upstream | 2: remove-internal-hermes-guide and phase6-lifecycle | git cherry reports zero plus entries; old tips do not represent open code |
| Current master plus one actual fix | Track A mobile overflow, 3a8bd1b0 | Three files, +17/-3: Apps nested overflow and certification evidence. Reconcile with its GitHub PR and validate before merging |
| Unmerged planning commit | Email Lite plan, 9e244ff4 | One 270-line planning document, 28 commits behind and one ahead; future scope rather than a reason to delay a core preview |
| Historical work with non-equivalent commit identities | Pilot receipts (2 plus), Hermes candidate/spike (21/11 plus), phase3 D1 operations docs (1 plus, 2 minus), phase1 (3 plus) | git cherry alone cannot recognize combined squash merges. Current master contains pilot receipts #218, native Hermes #266, and governed operations docs ee513a35. Do not blindly merge historical tips; compare the intended feature and final files |
| Missing/prunable registration | .codex-pr-review-266 | Directory missing; Git reports its gitdir points to a nonexistent location. No cleanup performed |

Two existing worktrees have tracked modifications:

- Main repo: pre-existing AGENTS.md and CLAUDE.md edits; root master is 157 commits behind current master.
- Deft Hermes Native Channel Candidate: 17 modified tracked files, 1,050 insertions and 193 deletions. Changes cover onboarding preflight, Agent Channel/employees, release gate/tests, Hermes adapter/readiness/tests/manifest, integration packaging, and roadmap/spec documents. All 17 working files differ from current master, but the branch predates a squash integration and subsequent work; this does not establish that every hunk is missing upstream. Preserve it and reconcile hunk-by-hunk before deciding whether it is retained work, superseded experimentation, or another launch dependency.

The other 22 existing worktrees are clean for tracked files. One registration is missing. A small documentation correction is also available: CONTRIBUTING.md still permits Node 20/pnpm 9 while package.json requires Node >=22.13 and pins pnpm 11.10.0.
