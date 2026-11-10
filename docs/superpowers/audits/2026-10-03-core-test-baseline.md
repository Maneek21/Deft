# Deft core: executed test baseline — 3 October 2026

This baseline supports the decision to keep Chat, Tasks, Calendar, Knowledge and Dashboard in core and move domain applications through the general App Authoring Kit platform. It is an assessment, not an implementation or release approval. No application source was changed. Notes has real working persistence; removing it will not resolve the access-control and consistency defects reproduced elsewhere in core.

## Scope and reproducibility

Tested GitHub/master revision: `b567af6ff12e5e4c61dbc54eddde17a81b986a28`. The main checkout remains at `2d478aee4bba23b34266e29247c1a0901f5b6d58`; its nine pre-existing tracked changes and unrelated files were preserved. Tests ran in a clean, isolated managed checkout at `C:/Users/Osheen Pradhan/.codex/worktrees/core-baseline-tests-20261003/Deft Main Repo`. Three GPT-6.1 Sol agents covered attention/search, identity/governance, and files/apps.

Real PostgreSQL, real HTTP routes, authenticated browser sessions, Socket.IO clients, queue workers, concurrent writes and receipt-storage fault injection were exercised. Synthetic fixtures were used exclusively. No customer data, installed PostgreSQL service, production credentials, paid AI calls or external provider writes were used.

The disposable runtime was Cybertec PostgreSQL 16.14 EE1.3.11+demo with pgvector 0.8.2, bound to `127.0.0.1:55433`. This is a real database but differs from the shipping Docker runtime. Own databases were provisioned using the supported schema command or schema-only clones. Node and the relevant disposable databases were set to UTC after non-UTC failures were reproduced. Raw failed attempts remain in the evidence directory.

The native-mentions browser checkout has commit `a0cd499d6fb6a33c2217ed58adcb7acc239bd7c1`; its Git tree `9def613431b27241d839a3bb2484133a00ac6d2e` is identical to the pinned baseline tree. Its browser checks used a development server; the broader smoke and Notes/Dashboard checks used the production build.

Durable summaries and the hash inventory are in [the evidence bundle](2026-10-03-core-test-baseline/evidence-manifest.json). Full local logs, reproduction scripts and retained database fixtures are at `C:/tmp/deft-core-baseline-20261003`. Suite counts below overlap in focused reruns and must not be added into a single unique-test total.

## Executed results

| Check | Actual result | Interpretation |
| --- | --- | --- |
| Frozen install, App Kit build, workspace typecheck, web lint, API build, web production build | Passed | Web build generated 43 routes. No application source changes required. |
| Web/shared/Kit/scripts collection | 549 passed, 3 failed, 1 skipped; 91 files | Web 258/258, shared 80/80, Kit 63/63. Three script failures classified separately below. |
| Full local API collection | 1,462 passed, 1 failed, 11 skipped; 281 files; 36.2 minutes | Only failure was a disposable-database name guard before a session test file ran. Gated cases received focused followups; see manifest. |
| API collection after focused coverage closure | 1,482 effective passes, no remaining gated coverage gaps | Replaces the failed parent wrapper with its nine passing tests and each of the eleven skips with a passing focused case. Reconstructed coverage across runs, not a single green stock-suite invocation. |
| Same-revision GitHub API job | 1,474 passed, 0 failed, 8 skipped | Independent Linux/PostgreSQL CI evidence; not a substitute for adversarial probes. |
| App-origin ancestry and flag-on MCP cutover followups | 1 + 6 passed, no skips | Real DB governance with provider contract seams, not real external connector execution. |
| Native mentions database tests | 21 passed, no skips | Includes eight concurrent publication/retry workers producing exactly one durable attention effect. |
| Resource composition / live authorization followups | 3/3 passed, no skips | Contacts/Campaigns composition, Module/Task live authorization and revisioned/replay-safe Module v2 relations. |
| Web session family followup | 9/9 raw passes, no skips | Eight behavior subtests plus parent wrapper; actual rotation/replay, concurrent refresh, logout, password/reset and Socket.IO eviction/reconnect denial. Correctly named owned database satisfied the guard. |
| Production browser smoke | 13 checks passed | Actual login, chat, task creation/status, approval and destination effect, personal connection lifecycle, Contacts tabs, mobile routes. Local Huddles was explicitly built OFF. |
| Targeted Notes, Tasks and Dashboard UI | 15 assertions passed; supplemental captures inspected | Notes create/autosave/edit/reload matched SQL and preserved both existing notes. Mobile Tasks loaded. Dashboard API and rendered counts matched SQL at desktop and mobile sizes. |
| Unchanged native-mentions browser harness | Failed at Knowledge Save → Notify, HTTP 409 | Desktop chat/thread/task steps passed first. Reload workaround succeeded; this is not a full browser certification. |
| Identity/governance authenticated adversarial probes | 9 controls passed, 3 expected denials failed | Real login, JWT/session middleware, routes and database. |
| Attention/search/calendar/wiki/ICS probes | 22 verified controls passed, 13 mismatch observations | Production routes and real DB access checks; authenticated user context injected. Thirteen observations are not thirteen distinct bugs. |
| Attachments authenticated probes | Expected 401/200/404/403 controls passed; deleted-project download remained 200 | Real login/session and file authorization. |
| Receipt normal/fault pair | Normal receipt signature verified; fault returned success without a receipt | Real approved native write; database trigger fault limited to one synthetic action and removed afterward. |
| Knowledge retrieval evaluation | 8/8 seeded retrieval cases passed | Establishes seeded full-text retrieval, not semantic relevance or model answer quality. |
| Database upgrade unit collection | 28/28 passed | Supported local upgrade applied 28 migrations; repeat had zero pending. |
| Local backup/restore | Database canaries and both attachment SHA-256 checks matched | Actual custom-format pg_dump/pg_restore into an owned separate database; not certification of shipping Docker backup commands. |

Same-revision [GitHub run 37026892933](https://github.com/Maneek21/Deft/actions/runs/37026892933) also passed Type Check, Build, Production Image + Browser Smoke, and Versioned Upgrade. CI production smoke covered Huddles ON. The upgrade job seeded a prior preview image, captured representative data, upgraded twice, and compared preserved data. The Hermes Employee Release Gate was skipped.

## Capacity and recovery measurements

The completed Windows lab run used 60 actual authenticated sessions, 60 simultaneous message writes, 120 staggered writes, 120 deterministic queue jobs, five stale running jobs, and a forced API restart. Its original budgets were preserved. Scratch harness changes supplied current session-bearing login tokens and restricted attention counting to run-correlated notifications for the 60 seeded people. All earlier failed attempts are retained; the repository harness was not edited.

| Measure | Observed | Existing budget / expected result |
| --- | --- | --- |
| Accepted load writes | 180/180 | All accepted |
| Message events delivered | 10,800/10,800 | 100% |
| Human notification events delivered | 10,620/10,620 | 100% |
| Simultaneous write p95 | 4,044.7 ms | ≤5,000 ms |
| Sustained write p95 | 357.1 ms | ≤5,000 ms |
| Concurrent inbox-read p95 | 583 ms | ≤3,000 ms |
| Human attention projection | 10,620/10,620; 24.3 s post-load drain | ≤30 s |
| Projection end-to-end p95 | 1,068.6 ms | ≤5,000 ms |
| Queue drain after restart | All 125 jobs completed; 5 s | ≤90 s |
| API health recovery | 7.3 s | ≤45 s |
| Post-restart message delivery | 60/60 clients | 100% |

The **raw overall verdict remains FAIL**: the policy assertion expected 55 recipients but counted 56, with **zero blocked-policy leaks**. SQL independently identified 10,620 notifications for seeded humans and 180 for an additional system agent during load. The policy query also counts non-seeded recipients, unlike its human-only expectation. This is a harness scope mismatch, not demonstrated notification-preference leakage. It still needs an explicit policy-recipient inventory before calling the stock certification green. No thresholds were relaxed. A single Windows instance with deterministic no-op jobs does not certify multi-instance scaling or external AI latency.

## Reproduced product defects, ordered for remediation

| Priority / boundary | Observed behavior and control | Source at tested revision | Evidence |
| --- | --- | --- | --- |
| P0: private audit payload | Ordinary member received private message content and private space name from `/api/audit`; direct message request was 403. Foreign organization saw no canary. | `routes/audit.ts:58,124`; `lib/agent-actions.ts:2262` | `identity-governance-results.json` |
| P0: task self-watch and list authorization | Restricted detail was 404, self-watch returned 200, then detail became 200. Legacy project task list exposed a restricted task while the table endpoint correctly hid it. Cross-org watch inserted a relation, but task detail still returned 404; no cross-org task-content leak was proven. | `routes/tasks.ts:907,1665`; `lib/task-visibility.ts:21` | `attention-real-db-effective-summary.json` |
| P0: reinvite lifecycle | Offboarding correctly blocked login and an existing session. Reinviting restored password login before acceptance; revoking that pending invite left membership active and login working. | `routes/members.ts:1118,1300`; `routes/invites.ts:142` | `identity-governance-results.json` |
| P1: attention revocation/deletion | Copied confidential task body stayed readable in attention after access restriction and deletion; task detail correctly became 404. | `lib/attention.ts:57,193,578`; `routes/tasks.ts:2487` | `attention-real-db-effective-summary.json` |
| P1: deleted project boundaries | Search retained tasks under a deleted project; an authenticated attachment download also remained 200 after project deletion. Deleted-task download and revoked-membership controls denied access correctly. Attachment probe used the owner; unrelated-member access was not tested. | `routes/search.ts:45`; `lib/human-attachment-access.ts:36` | Attention summary; `attachment-project-access-result.json` |
| P1: receipt durability | A normal approval produced one message and one verifiable receipt. With receipt INSERT forced to fail, approval still returned 200 with executed=true/error=null, one message and zero receipts. No degraded state was exposed. | `lib/receipts.ts:232`; `routes/agent.ts:1902` | `receipt-fault-result.json` |
| P1: Calendar validation and tenant context | Create rejected reversed dates and other-user PATCH was denied. PATCH accepted a reversed range, malformed date produced 500, and same-user/different-org context PATCH succeeded. Org probe injected authenticated context; credential middleware was not exercised there. | `routes/events.ts:94` | Attention summary |
| P1: ICS reconciliation | Two real loopback feeds sharing a UID stayed isolated, and update replaced only the correct feed event. Successful empty-feed sync reported zero but retained the removed event in SQL. | `workers/handlers/ics-sync.ts:67` | `attention-ics-followup-summary.json` |
| P1: Knowledge edit concurrency | Two actual simultaneous PATCH requests from version 2 both returned 200; stored version became 3 and one edit disappeared from history. The attempted synchronized row-wait monitor did not pass; no controlled barrier claim is made. | `routes/wiki.ts:965` | Attention summary |
| P1: Knowledge Save → Notify | Immediate publication used stale version/hash and returned 409 after a successful save. Reproduced twice; reload made publication succeed. | Web Knowledge `page.tsx:584,587,988`; `lib/native-mentions.ts:83` | `identity-native-summary.json`; `wiki-publish-diagnostic.json` |
| P2: repeated Inbox seen transition | Item already open_seen was still visible, but repeating POST seen returned 404; browser emitted an unhandled “Not found” error. This was not an access leak. | API `lib/attention.ts:823,853`; Web Inbox `page.tsx:79,195` | `seen404-route-repro.json` |

Source paths in this table are under `apps/api/src/` unless explicitly labeled Web. P0 denotes the first repair batch because the observations concern disclosure or restored access; it is not a claim about production exploitation.

Do not repair missing receipts by simply returning an error after the external/native effect and automatically retrying it: the effect has already happened. Preserve durable effect identity and expose recoverable receipt failure without repeating the write.

## Harness and environment findings

- Track A setup test pins an obsolete expected commit (`ff5a…` versus hook `121aa…`). Classified as a stale assertion.
- Release workflow test requires literal LF while this Windows checkout contains CRLF; the actual fail-closed release-scope condition is present. Classified as line-ending sensitivity.
- Docker entrypoint child-failure test exceeded its fixed 1,500 ms timeout under Windows Git sh. Product implication remains unverified; its SIGTERM test explicitly skips Windows. Same-revision image/browser CI passed but does not prove this exact child-failure assertion.
- Root unit invocation omitted the web alias tsconfig, and packed-package tests needed `npm_execpath`. Only failed-to-load cases were rerun with the required harness settings; effective counts replace those failures rather than double-counting them.
- App-origin cutoff assertion failed in Asia/Calcutta twice and passed in UTC. The initial broad API run also had clock-related failures. This is a deployment timezone dependency requiring an explicit contract and non-UTC verification, not an unconditional grant-merge defect. The completed broad run used UTC.
- The 60-person script manually minted JWTs without the current session identity; actual login tokens were required. Counting all organization recipients against a 60-human expectation also caused projection/policy false failures. Preserve the original logs and fix the harness separately from product work.
- Docker Desktop could not start because of a locked stale startup socket. Automatic approval review blocked removal of that socket. No file was removed or Docker reset attempted; the isolated PostgreSQL runtime provided the database fallback.

## What to preserve and what to test next

Protect these passing workflows while repairing boundaries: chat persistence and realtime delivery, ordinary task table visibility and status changes, normal offboarding and session rejection, signed normal receipts, Inbox native approval destination effects, seeded knowledge retrieval, Notes autosave/reload, Dashboard SQL-backed counts, connection token non-disclosure/revocation, packed external App Kit authoring, governed app activation and grants, reviewed upgrades, rollback/data preservation, MCP replay/unknown-outcome handling, native mention publication idempotency, and backup/upgrade preservation.

First complete a focused security batch: private audit filtering, watcher authorization plus project-list parity, and pending/revoked invite semantics. For each fix, rerun the exact canary reproduction, the authorized positive control, the denied ordinary-member/foreign-org control and the relevant existing suite. Then repair attention/deletion consistency and receipt failure recovery, followed by Calendar and Knowledge integrity. Keep harness repairs and architectural extraction separately reviewable.

The platform has substantial passing behavior. Proceeding directly to a broad extraction would carry core boundary defects into every connected app. Build the general platform against the protected workflows, and use a Documents vertical slice after the security batch. Other work need not all stop; avoid simultaneous edits to the same authorization, resource, receipt and migration contracts while those defects are being repaired.

Still unverified: live OAuth/email/provider writes, real AI/Hermes end-to-end behavior and cost, semantic knowledge quality, hardware audio/video meetings, Safari/Firefox, multi-instance realtime, and every unmerged branch or ongoing thread's private working tree. Huddles ON has pinned CI smoke evidence, not local hardware certification. Mobile Dashboard works but its three narrow My work columns truncate task titles. Repeated native-reference React key warnings were observed without a demonstrated authorization defect. This baseline is broad actual execution, not a claim that every production scenario is correct.

All owned API/browser processes were stopped and the isolated PostgreSQL cluster was cleanly shut down after testing. Database files and evidence were retained for inspection. The user's installed PostgreSQL service was not stopped or modified.
