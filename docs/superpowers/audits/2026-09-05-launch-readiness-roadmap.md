# Deft public-preview launch audit and roadmap

**Assessment date:** 5 September 2026  
**Intended launch:** public self-hosted preview, as confirmed by the owner.  
**Decision:** **Do not promote the current build to a broad public launch yet.** The project has substantial working features and meaningful CI, but this audit found reproducible data-loss, login, packaging, and recovery defects. A focused stabilization release is a credible next step. A date becomes credible only after the acceptance gates below pass.

This was an assessment. No product fixes, commits, merges, releases, GitHub comments/issues, migrations, resets, or writes to an existing application database were performed. Existing user changes were preserved. Temporary servers and test artifacts were confined to the isolated audit directory; the temporary web servers were stopped after verification.

## 1. What state is the project actually in?

| State | Exact revision / version | Interpretation |
|---|---|---|
| Main local checkout | `2d478aee4bba23b34266e29247c1a0901f5b6d58`, package preview.12 | **157 commits behind** verified GitHub master; do not use its behavior as today's release assessment |
| Live GitHub master | [7355c90a](https://github.com/Maneek21/Deft/commit/7355c90a0ab5630b839440e8e25133b63853835c), 2 September | Current source inspected and tested in an isolated archive |
| Latest published preview | [v0.3.0-preview.14](https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.14), published 31 August, commit `6d39e0e` | **132 commits behind master**; publishing and merging are different milestones |
| Release-to-master delta | 241 files, +42,340 / −683 lines | Includes code, tests, docs and certification; line count is not a defect metric |
| Current package / schema state | Root package still preview.14; new migration IDs through preview.26; App Kit `0.1.0-alpha.2` | Choose a new release identity and accurate changelog; migration IDs are not proof that matching releases were published |
| Current GitHub backlog | 8 open PRs, 6 open issues | Most PRs are dependency updates; the backlog does not capture the new audit defects |
| Local worktrees | 25 registered, 24 existing; one missing/prunable registration | Most are historical, not 25 active feature projects |

Live GitHub and the cached `origin/master` matched exactly. The current code was extracted into `tmp/launch-audit-2026-09-05/current`; the user's root checkout was not switched, pulled, reset, or stashed.

The local root has pre-existing edits to AGENTS.md and CLAUDE.md and pre-existing untracked plans/audits. A separate Hermes candidate worktree has 17 modified files (+1,050 / −193) requiring deliberate reconciliation. Fifteen worktree tips are ancestors of current master; two more are fully patch-equivalent. Squash merges explain several apparent unmerged histories. See the [worktree appendix in the operations review](2026-09-05-launch-release-ops.md).

The related public [Contacts module repository](https://github.com/Maneek21/deft-module-contacts) has release v1.1.0 and no open issues/PRs in the retrieved open-issue collection. Deft's vendored lock names v1.1.0 and an exact source commit; fresh module provenance verification passed. This was an integration/provenance review, not a second full application audit.

## 2. Product readiness by area

| Area | Evidence-supported state | Launch implication |
|---|---|---|
| Human workspace | Chat/tasks/knowledge/calendar/notes/settings have implemented breadth and real production smoke; Notes and login negative paths fail | Stabilize everyday persistence and recovery before adding scope |
| Tenant permissions / agents / MCP | Significant API permission coverage, live membership checks, governed execution, receipts and separate credentials | Preserve existing gates; close identified auth edges and run two-user negative paths on the release |
| Modules | Contacts vendoring/provenance and collection navigation covered | Reasonable bounded preview surface |
| Connected Apps | Deep candidate-specific authoring, activation, lifecycle, provider, receipt and restore proof exists | Describe as the exact certified beta, with explicit configuration requirements |
| Bounded automation | Scheduler/definition/management code and a successful manual Track A certification exist | Opt-in; do not present as a general workflow engine |
| Packaging / operator recovery | Signing, SBOM, source, checksums and versioned migration machinery exist | Customer-facing install and failure recovery still need fixes |
| Accessibility / cross-browser | Some accessible primitives and Chromium coverage | Core keyboard/screen-reader, Firefox/WebKit and real-device media checks remain incomplete |
| Scale / long-running operations | Synthetic harness exists; single app instance and in-memory realtime state | No fresh capacity or overnight-soak certification from this audit |

The latest Track A certification uses product candidate `121aa7c0` and certifier `7355c90a`. Comparing those revisions showed only four certification/orchestration files changed, **no product source change**. Its successful product evidence remains relevant to current master. Re-run after launch fixes and against the actual artifact that will ship.

Apps, App Runs, App-origin execution, developer pairing and automation are false by default in the example configuration. Public browser feature flags are build-time decisions. Enabling one runtime variable is not equivalent to shipping a fully configured, certified connected platform.

## 3. Launch fixes, in order

“P1” here means a recommended release blocker for this public-preview scope. “P2” means important but capable of explicit scope restriction or documented deferral. Confidence is shown separately from priority.

| ID | Priority / evidence | Finding and required outcome |
|---|---|---|
| L01 | **P1, production browser + callback probes** | **Notes loses pending body edits and falsely says Saved.** Title/icon saves cancel the body's pending timer; HTTP 500 also reaches Saved. Preserve dirty state and require persistence success. |
| L02 | **P1, real client with simulated lost response** | **Non-idempotent writes retry automatically.** One accepted event creation can repeat after its response is lost. Retry only safe/idempotent operations; otherwise reconcile uncertain outcomes. |
| L03 | **P1, exact Compose asset probe** | **Download-only install references an unshipped SQL file.** Make the published assets self-contained and prove empty-directory, fresh-volume installation. |
| L04 | **P1, executed upgrade orchestration with fake subprocesses** | **Upgrade failure can restart old code after schema changes.** Only resume the previous app when schema compatibility is established; otherwise use explicit recovery. |
| L05 | **P1, harmless process fixture** | **API death leaves the web container alive.** Supervise both processes, propagate termination and recover without abandoning leased work. |
| L06 | **P1 remediation decision; moderate advisory confirmed** | **TipTap dependency graph remains vulnerable.** Repair PR318 across direct and transitive packages; preserve types and editor behavior. No end-to-end Deft exploit is claimed. |
| L07 | **P1, source-confirmed auth hardening** | **Web refresh/revocation and public OAuth registration have gaps.** Implement session-family rotation/revocation, strict malformed-input handling, and limits on public registration/token routes. |
| L08 | **Conditional P1, source-confirmed** | **Native GitHub account-linking callback trusts unbound state.** Disable this unsupported connector or repair its state/session/org binding before enabling it. Practical provider exchange requires configured credentials. |
| L09 | **P2; fix before launch, production browser** | **Wrong password then correct password can strand the user on login.** Exclude auth endpoints from session-expiry interception and validate post-login destinations. |
| L10 | **P2; fix before launch, production browser** | **Uploaded Notes images do not send file authorization.** Use authenticated file-ID/Blob loading; do not make protected files public or embed bearer tokens in saved content. |
| L11 | **P2; required before claiming recoverable upgrades** | **Public recovery runbook omits essential steps.** Provide complete DB/uploads/keys/config/digest backup and clean-target restore; make it executable from the advertised installation mode. |
| L12 | **P2, open reviewed change / CI evidence** | **Apps inner-container mobile overflow remains open in PR317.** Integrate the focused fix and retain its nested-container browser assertion. |

Detailed source locations, affected conditions and reproduction methods are in:

- [Frontend and product review](2026-09-05-launch-frontend-product.md)
- [Release, operations and worktree review](2026-09-05-launch-release-ops.md)
- [Security remediation review](2026-09-05-launch-backend-security.md)

The highest-impact source areas are Notes `page.tsx:294–358,468–482`, client `api.ts:76–130`, `selfhost-upgrade.ts:166–180`, `docker-entrypoint.sh:6–9`, auth refresh `auth.ts:225–250`, public OAuth registration `oauth-mcp.ts:98–130`, and account linking `connections.ts:71–165`. The detailed reviews link to immutable GitHub source because the root checkout's line contents are older.

### Why these findings matter even with green checks

In a production-built Chromium browser, Notes and images were tested at **1440×900** and **390×844**; the login sequence was tested on desktop:

- Editing a note body then its title sent only the title PATCH, yet the UI showed Saved.
- Returning HTTP 500 for body persistence still showed Saved.
- A saved image made a protected-file request without Authorization and remained broken.
- A wrong-password login navigated to `/login?expired=1` and cleared the email; the following correct login stored a token but remained at `/login`.
- Both browser “no uncaught page errors” assertions passed.

These were actual React/TipTap/UI executions with intercepted API responses and fixture persistence. They verify client behavior, not a live database. Eight correctness assertions failed; two page-error assertions passed. The [structured browser results](../../../tmp/launch-audit-2026-09-05/frontend-browser/results.json) and [mobile false-Saved screenshot](../../../tmp/launch-audit-2026-09-05/frontend-browser/notes-http500-390.png) record the evidence. The audit also used five deterministic callback/client probes to distinguish the timing and transport causes.

## 4. GitHub open work: disposition

| PR | Current evidence | Recommended disposition |
|---|---|---|
| [317 — Apps mobile overflow](https://github.com/Maneek21/Deft/pull/317) | Mergeable, clean; required checks passed at its head | Include in stabilization, then verify with the final candidate |
| [318 — TipTap core 3.30.4](https://github.com/Maneek21/Deft/pull/318) | Type Check and Dependency Audit failed; downstream jobs skipped | Repair as a coordinated dependency update. Direct-only bump leaves 17 vulnerable transitive paths and mixed core types |
| [296 — SBOM action](https://github.com/Maneek21/Deft/pull/296) | Checks passed at its existing head | Refresh/rebase if needed; optional before freeze, no reason to block launch solely for this update |
| [295 — CodeQL action](https://github.com/Maneek21/Deft/pull/295) | Checks passed at its existing head | Same: maintenance update, verify against current base |
| [263 — setup-python v7](https://github.com/Maneek21/Deft/pull/263) | Checks passed at its existing head | Defer or integrate early enough to recertify the Hermes runtime lane |
| [260 — download-artifact v8](https://github.com/Maneek21/Deft/pull/260) | Checks passed at its existing head | Coordinate with artifact-consumer assumptions and relevant workflow tests |
| [261 — upload-artifact v7](https://github.com/Maneek21/Deft/pull/261) | Type Check job failed in certification workflow assertion; dependent jobs skipped | Update the hard-coded workflow contract test with the intended action semantics; do not bypass the check |
| [265 — ESLint 10](https://github.com/Maneek21/Deft/pull/265) | Lint crashes in react/display-name / getFilename compatibility | Defer the major tooling upgrade until the React/Next lint stack supports it |

The Type Check job name includes lint and workflow tests; a red job does not always mean a TypeScript compiler failure. The actual failed step was inspected for the three red PRs.

Six open issues are mostly launch polish or deferred scope:

| Issue | Launch treatment |
|---|---|
| [179 — keyboard and screen-reader checks](https://github.com/Maneek21/Deft/issues/179) | Cover login, navigation, task creation, approval and MCP setup in the launch gate |
| [176 — five-minute external MCP walkthrough](https://github.com/Maneek21/Deft/issues/176) | Reconcile with existing website client docs; verify one real current client, governed write, receipt and revoke |
| [177 — curated preview release notes](https://github.com/Maneek21/Deft/issues/177) | Ship a short install/upgrade/known-limits summary and link the full diff |
| [175 — README image checks](https://github.com/Maneek21/Deft/issues/175) | All six local README image paths exist now; automate path validation, then separately assess screenshot freshness |
| [174 — recurring 60-person certification](https://github.com/Maneek21/Deft/issues/174) | Run once on the launch candidate; recurring execution is useful follow-up, not evidence already earned |
| [172 — arm64 images](https://github.com/Maneek21/Deft/issues/172) | Defer if the launch explicitly supports linux/amd64 only |

Local Email Lite work is a planning commit rather than a launch-ready email product. The broader full-surface plan explicitly leaves isolated custom experiences, managed runtimes/sync, public ingress and compound proofs to later tracks. Do not make those tracks prerequisites for a narrow preview, and do not market them as shipped.

## 5. What was tested

### Fresh local evidence at GitHub master

Runtime: Windows, Node **24.14.0**, pnpm wrapper **11.19.0**. CI uses Node 22 and pnpm 11.10.0. The candidate lockfile was installed frozen in an isolated snapshot; install lifecycle scripts were disabled. No dependency versions or product source were changed.

| Validation | Result |
|---|---|
| `pnpm typecheck` | Pass: API, web, App Kit, shared, including App Kit prerequisite build |
| `pnpm --filter @deft/web lint` | Pass |
| Production web build via Next's CLI | Pass |
| `pnpm --filter @deft/api build` | Pass |
| All 31 web test files | **114 passed**, 0 failed/skipped |
| Shared contract suite | **63 passed**, 0 failed/skipped |
| Five focused API test files | **40 passed**, 0 failed/skipped; intentionally invalid disposable DB address prevents application-data access |
| Supported `pnpm --filter @deft/app-kit test` | **35 passed**, including packed external install/authoring |
| Upgrade/reset/unit/manifest tests | **44 passed**, 0 failed/skipped |
| Release/certification/public-env tests | **19 passed**, 0 failed/skipped |
| `pnpm module:verify` | Pass, 1 vendored module |
| Fresh `pnpm audit --json` | **Fail: 1 moderate TipTap advisory**, 0 high/critical |
| Production-browser fault scenarios | **8 failed correctness assertions**, 2 passed page-error assertions |
| Upgrade/process/package failure probes | Three concrete operational gaps confirmed, within the evidence limits above |
| README local image path check | Six local images exist; visual freshness not certified |

**315 distinct existing automated tests passed.** This count excludes the intentionally failing diagnostic assertions and excludes historical GitHub runs. The first direct App Kit invocation failed its “run through pnpm” precondition; rerunning through the supported command passed. Direct module verification likewise lacked pnpm's workspace resolution; the supported script passed. An initial web `pnpm exec` path problem was resolved with direct local tsx. These invocation issues are recorded, not counted as product failures or hidden as successful checks.

Logs are under `tmp/launch-audit-2026-09-05/`: `typecheck.log`, `lint.log`, `build-web.log`, `build-api.log`, `web-tests-direct.log`, `shared-tests.log`, `api-focused.log`, `app-kit-pnpm-tests.log`, `module-verify-script.log`, `dependency-audit.json`, `ops-contracts.log`, `ops-upgrade.log`, and `ops-probes/`. The final 63-test operations pass was recorded directly by the primary auditor to verify the consolidated count.

### Existing GitHub evidence, inspected fresh but not rerun here

At exact master `7355c90a`:

- [CI run 33590470249](https://github.com/Maneek21/Deft/actions/runs/33590470249): Type Check, Test API, Build, Production Image + Browser Smoke, Versioned Upgrade, and Hermes Employee Release Gate all succeeded.
- API log: **1,337 tests, 1,325 passed, 12 skipped, zero failed**.
- [Security run 33590470123](https://github.com/Maneek21/Deft/actions/runs/33590470123): CodeQL and Dependency Audit succeeded at that time; Dependency Review was correctly skipped on push. The later advisory explains why today's fresh audit is red without any source change.
- [Track A run 33590482418](https://github.com/Maneek21/Deft/actions/runs/33590482418): candidate typecheck/build, external authoring, host/browser/offline and restore proof succeeded. Restore matched **375 rows across 22 tables**, **24 receipts**, and migration ledger ending at preview.26.
- Master requires seven named checks, but its returned protection summary enforces them for **non-admins**. Dependency Audit and the separate Hermes/manual certification gates are not in that seven-context list. Keep the release checklist authoritative; do not assume every useful gate is enforced for every actor.
- Published preview.14 includes the expected top-level license, source, SBOM, checksums, Compose, manifest and Hermes certificate/archive assets. Their existence was checked; signatures and image contents were not reverified locally.

The 12 skipped API tests concern cross-surface App action preparation, App-origin ancestry/revocation, resource composition/authorization/relations, and six legacy-MCP-cutover cases. Some are intentionally exercised by separate certification lanes. The Track A log itself still skipped the six legacy-cutover cases. **Require the relevant lane when that feature is enabled; do not describe all these paths as covered by the green API aggregate.**

### Unverified requirements

Docker's Linux engine was not running. The configured local application DB endpoint refused connection, and no disposable pgvector DB was available for this audit. Existing PostgreSQL service/data was not repurposed. Consequently this audit did **not** freshly run the full DB-writing API suite, Docker install/init, real database upgrades/restores, Linux crash/signal recovery, or the 60-person/overnight soak.

It also did not certify Firefox/WebKit, real email delivery, real AI-provider behavior/cost, real external MCP vendor clients, two-device huddle audio, all authorization endpoints, all migrations under all historical data, all secrets in Git history, or an independent penetration test. The browser tests intentionally intercepted the backend. No live production environment is certified by this report.

## 6. Missing tests that would most change the launch decision

| Journey / risk | Required test | Observable acceptance |
|---|---|---|
| Fresh operator | Empty Linux amd64 host/directory, only shipped files, no keys for AI, default flags | Install → init → doctor → owner signup → invite/member → core work succeeds |
| Persistence | Notes/Canvas edits, overlapping fields, rapid switching, reload | Every acknowledged save survives; unsaved content remains visible/recoverable |
| Lost-response writes | Commit then interrupt response for event/task/message/upload | Exactly one accepted mutation, or explicit uncertain state with reconciliation |
| Sessions | Wrong→correct login, real expiry, refresh concurrency, logout/replay, member removal | Correct destination; revocation works; no silent loops or stale authority |
| Tenant/private resources | Two orgs in test DB and owner/member/guest identities; private space/tasks/files | Reads, searches, tools, realtime delivery and writes reject the wrong identity consistently |
| Approvals/receipts | Duplicate approval, revoke before dispatch, connector outage, ambiguous provider completion | No duplicate effect; clear pending/failed/unknown state and attributable receipt |
| Files/editors | Upload/paste image, reload, sharing/revocation, malformed/large files | Authorized files render; denied files do not; no token persisted in documents |
| Supported upgrade | Preview.1 baseline and realistic preview.14 → final candidate | Preserved counts/hashes/permissions/files; valid ledger; repeat upgrade no-op |
| Recovery | Fail after an earlier migration commits; fail container recreation; restore to new target | No unsafe auto-resume; DB/files/keys/digest restore as one recovery point |
| Runtime failure | Kill API child, kill web, restart DB, SIGTERM with jobs/WebSockets active | Visible failure/recovery; no permanently live-but-broken container or duplicate effect |
| UI access | 1440px,390px,360px; Firefox/WebKit; keyboard-only core dialogs | Usable controls/focus/labels; no inner-container clipping; completion without mouse |
| Small-team capacity | Existing 60-person harness plus 12–24h realistic bounded soak | Record hardware, p95/p99, errors, queue age, recovery, memory/disk trend; publish only measured claims |

Adopt explicit pass thresholds before running the soak. Suggested launch criteria: zero unexpected failed core writes, zero duplicate accepted effects, zero unauthorized deliveries, no unbounded queue/memory growth, recovery within the documented operator target, and latency acceptable on the advertised minimum hardware. These are proposed acceptance criteria, not measurements already achieved.

Main CI currently executes only **5 of 31 web test files**. Bring the complete 114-test suite into CI, then add the missing behavior tests; adding only more source-text assertions will not catch the browser races demonstrated here.

## 7. A practical launch roadmap

This is a **five-day stabilization target with parallel engineering**, not a guarantee. One engineer or failures in restore/soak testing can extend it. Protect the acceptance gates rather than the date.

| Window | Workstream / accountable role | Exit evidence |
|---|---|---|
| Day 0 | Maintainer: freeze scope, preserve/reconcile worktrees, choose candidate lineage and issue list | One authoritative release checklist; no launch from the stale root; default/optional features explicit |
| Days 1–2 | Frontend owner: L01/L02/L09/L10; incorporate PR317 | Red→green regression tests; browser persistence/reload and login destinations pass at desktop/mobile |
| Days 1–2, parallel | Release/backend owner: L03/L04/L05/L11 | Self-contained assets, safe failure-stage recovery, supervised process behavior; executable operator runbook |
| Days 1–2, parallel | Security owner: L06/L07; disable or repair L08 | Clean compatible TipTap graph; fresh audit; auth/input/resource-limit regressions; conditional connector state explicit |
| Day 3 | QA/release owner: clean install + latest-release and baseline upgrades + real-client workflow | Recorded DB/file/key/digest invariants; fresh owner/member/no-AI journey; approval/write/receipt/revoke |
| Day 4 | QA/operator: failure injection, accessibility/cross-browser, load and overnight soak | Declared latency/resource/recovery results; all P1s closed; justified documented P2 deferrals |
| Day 5 | Maintainer: freeze exact release commit, build/sign/publish artifact, certify its digest | Green selected-commit checks, matching artifacts/provenance, final download-only smoke, clear release notes/support path |

Treat the security and operational fixes as separate focused changes where that makes review and rollback clearer. A new App/automation feature, infrastructure replacement, mass dependency-major upgrade, or general refactor should not consume this stabilization window.

### Recommended launch promise

Launch a **linux/amd64, single-workspace, self-hosted public preview** of the human workspace and the explicitly supported MCP/agent workflows. Core operation without AI keys is a mandatory acceptance path. Keep experimental connected-App/automation features opt-in unless their exact flags, keyrings, provider requirements and final-artifact certification are included in the launch materials.

Defer arm64, generalized workflows, public gateway/anonymous ingress, arbitrary custom App UI, hosted multi-tenant SaaS, production email/newsletter claims, and broad huddle quality claims. These are scope choices, not defects that need to be built in the coming days.

### Ship / do not ship checklist

Ship only when the following are true:

1. L01–L07 are closed or demonstrably removed from the launch surface; L08 is disabled or correctly certified. Login and protected Notes images pass.
2. The final code revision—not a historical branch—passes the relevant tests and has no unresolved required check.
3. A stranger can follow the advertised install using only the published files.
4. Preview.14 upgrade and recovery work with realistic DB/files/secrets, and the baseline lane remains green.
5. The exact published digest is verified and smoke-tested with the launch defaults.
6. No known core data-loss or duplicate-effect failure remains; deferred limitations are explicit.
7. A responsible maintainer can monitor errors/queue/backups, triage launch reports, and execute the rehearsed recovery procedure.

If the coming-days deadline arrives before these are true, limit access to a controlled pilot and move the broad announcement. More feature breadth will not compensate for lost notes or unsafe upgrade recovery.

## 8. Low-cost cleanup and public presentation

- Correct CONTRIBUTING's Node20/pnpm9 requirements to match the actual engine/package manager and tested runtime.
- Refresh ROADMAP's “next preview” items that already shipped, and review the July16 limitations date.
- The live [website quick start](https://deft.ing/docs/quick-start/) still says it was verified against preview.7; align it with the launch artifact and the repository operator guide. The [homepage](https://deft.ing/) correctly identifies the product as alpha and single-workspace self-hosted; retain that boundary.
- Keep the README's current preview.14 instructions accurate until the new image exists; update atomically with the next release. All six local image paths currently resolve.
- Curate release notes around install, upgrade, concrete changes, supported platforms and known limits.
- Check open issue176 against the existing client docs before duplicating them; prove one complete current-client flow.
- Convert confirmed audit findings into tracked work with an owner and acceptance evidence. No issues were created by this assessment.
- Reconcile the dirty Hermes candidate hunk by hunk; archive/prune only after useful work is accounted for. Branch cleanup itself is not a launch blocker.

## 9. Evidence handling and completion

Supporting reports and the isolated evidence folder remain local for review. Source claims use the verified master revision, not the old root checkout. Existing tracked root modifications remain AGENTS.md and CLAUDE.md; intended durable additions are this report and the three focused reports. Temporary dependencies/builds/probes are under the audit directory. Final archive comparison checked all 1,543 original snapshot files and found zero changes; all four reports' local links resolve. GitHub master was rechecked and remained `7355c90a`.

Fresh local evidence establishes both substantial passing coverage and concrete failures. Existing upstream Linux certification supplies additional context but is not represented as a fresh local rerun. The remaining unverified gates are explicit above; this report is a roadmap to launch readiness, not a release certificate.
