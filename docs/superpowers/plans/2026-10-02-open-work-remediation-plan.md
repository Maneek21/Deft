# Deft open work remediation plan

This plan covers every open GitHub PR and issue, active local Platform and Email work, and the defects found in the renewed code review. Fix authorization and disclosure defects first. Run core hardening from current master while a separate lane freezes and repairs the Platform and Email candidate. Certify the exact combined candidate before release.

Status: planning only, reviewed on October 2, 2026. No application fix, migration, merge, deployment or provider action was performed for this plan. Prior local changes are preserved. Proposed owner roles below are execution responsibilities, not assignments to named people.

## Baseline and evidence limits

| Source | Reviewed state | Consequence for execution |
| --- | --- | --- |
| GitHub master | `94626051299decb231b48bead1144a716cd7873d`, product `0.3.0-preview.15` | Start core fixes here and refresh the remote SHA at kickoff. |
| Main local checkout | `2d478aee4bba23b34266e29247c1a0901f5b6d58`, 205 commits behind reviewed master; 9 modified tracked files and 149 untracked entries before this plan | Do not pull, reset or treat its old application code as the current implementation. Preserve documentation and nested worktrees. |
| Active Platform and Email worktree | `C:/tmp/deft-gate-g-integration-20260924`, HEAD `0c611bb4b1a000e8b4a066f71974137e5c0f31cd`; 76 modified tracked files and 188 untracked paths at review | Remote PR heads omit substantial local work. Curate a separate candidate without overwriting this tree. |
| Open worktree database model | 181 schema tables versus 147 on master; four untracked migrations numbered 57 through 60 | Freeze schema, fresh creation and upgrade paths together. Table count is scope evidence, not readiness evidence. |
| Current master CI | [Run 36968368026](https://github.com/Maneek21/Deft/actions/runs/36968368026), required checks green; API 1452 passed and 7 skipped of 1459 | Existing green CI does not cover the newly identified defects. Add focused regressions. |
| Latest Email milestone | October 2 at 12:04 IST; Send4 accepted and delivered, strict paired verification false; Stage 1 in progress and Stage 2 paused | This supersedes older paragraphs saying Send4 was unexecuted. Preserve historical evidence without treating it as current status. |

Review evidence includes current-master typecheck and web lint, shared 66, Author Kit 63, web 234, focused backend 51, transcription 4 and pinned Hermes 27 passing checks. Actual-source probes confirmed task visibility, bootstrap concurrency, socket/chat routing, request-order and calendar date defects. These probes used mocks and focused harnesses; they are not live database exploit or rendered UI certification.

Local release checks produced 17 passes, 3 failures and 1 skip of 21. Failures include a CRLF-sensitive assertion and two repeatable Windows process timeouts. The reviewed local Platform architecture checks produced 12 passes and 5 failures of 17. No Docker daemon was available in this review, so production container, live database and full browser gates still need execution in suitable infrastructure.

## Every open PR and issue

| Open item | Current status | Planned disposition |
| --- | --- | --- |
| [PR 349 CodeQL action update](https://github.com/Maneek21/Deft/pull/349) | Non-draft, head `68e61ebd`, current checks green | Refresh against latest master, run required checks and merge through the usual process. It can precede other fixes; it does not resolve Platform CodeQL findings by itself. |
| [PR 348 Production JWT validation](https://github.com/Maneek21/Deft/pull/348) | Non-draft, head `b1df0d63`; Production Image and Browser Smoke failing | Complete the existing PR with production-safe test credentials in every container invocation and subprocess validation. Keep strict production rejection. |
| [PR 345 Governed app platform](https://github.com/Maneek21/Deft/pull/345) | Draft, head `7fe25abe`; 599 files; 13 API failures, 5 CodeQL annotations; Build skipped in its last reviewed CI | Freeze current local work, retain generic Platform scope, repair and certify the exact new head. Remains a release blocker for Platform. |
| [PR 346 Release preparation](https://github.com/Maneek21/Deft/pull/346) | Draft, head `153614ee`, base PR 345 branch; title says preview.16 and Kit alpha.6; no checks | Reconcile against the candidate's actual Kit alpha.9 and chosen release identity. Enable required CI for the stacked head. Retarget after Platform lands. |
| [PR 347 Email example](https://github.com/Maneek21/Deft/pull/347) | Draft, head `0c611bb4`, base PR 346 branch; no checks | Include only reviewed Email successor work after generic contracts stabilize. Keep its full launch requirements and milestone gates. Retarget after release preparation lands. |
| [Issue 179 Accessibility](https://github.com/Maneek21/Deft/issues/179) | Open, scoped to core setup workflows | Complete the keyboard and named screen-reader certification in the frontend batch below. |
| [Issue 177 Curated release notes](https://github.com/Maneek21/Deft/issues/177) | Open | Add release-specific checked notes input and non-publishing workflow tests before the next release. |
| [Issue 175 README image regression coverage](https://github.com/Maneek21/Deft/issues/175) | Open; path checker and docs CI already exist | Add temporary image fixtures to the existing checker, including rename and missing-path failures. |
| [Issue 174 Weekly 60-person certification](https://github.com/Maneek21/Deft/issues/174) | Open; harness exists, performance owner needed | Wire weekly and manual isolated CI runs with retained reports and honest failure propagation. |
| [Issue 172 ARM64 images](https://github.com/Maneek21/Deft/issues/172) | Explicitly deferred outside the next preview; owner and demand needed | Keep deferred. Define an owner, provider demand and certification environment before implementing. |

PR 346 and PR 347 have no check runs because the reviewed PR workflow targets master/main bases. An empty check list is not a pass. Make required jobs run for the relevant stack bases, or add a required combined-candidate job that attests each exact stacked head; retargeted PRs still need fresh checks.

## Execution order

1. **Freeze the starting evidence.** Record master, all five PR heads, dirty file inventories, applied migrations and current deployment/module identities. Preserve worktree data and produce a curated candidate with all intended untracked source files. Do not copy provider secrets into commits, source offers or public artifacts.
2. **Close core access and startup defects.** Task privacy, historical watcher access, space event delivery, JWT production configuration, bootstrap atomicity and honest readiness are the first core lane. These can ship independently of Email after their gates pass.
3. **Repair frontend correctness in parallel.** Fix stale request state and wiki save identity, calendar date parsing, keyboard access, thread updates and truthful approval copy. Reproduce the session-cache concern before changing its architecture. Complete CSP policy work against the production image.
4. **Repair generic Platform and its test infrastructure.** Resolve required fixtures, authorization contracts, retained key versions, architecture boundaries and CodeQL findings. Prove migrations and owner/target/session revocation on the frozen candidate.
5. **Close Email Stage 1, then finish the mapped launch scope.** Review undeployed recovery fixes, resolve the provider transformation contract, prove the second real account and complete X06. Stage 2 begins only after the existing Stage 1 exit gate is recorded as satisfied.
6. **Certify and release the chosen scope.** Run a consolidated validation pass, upgrade and restore rehearsals, desktop/mobile inspections, source-offer and artifact checks. Retarget the stack in order PR 345, PR 346, PR 347. Publishing and live external writes remain separate execution actions.

Backend core, frontend and release/CI work can run concurrently with Platform fixture repair. Assign one integrator to shared authorization helpers, schema/migrations, Runtime contracts and release identity. Avoid parallel edits to those files. Do not make the next core security release wait for the full Email replacement roadmap; do not include uncertified Platform or Email features merely to preserve a proposed version number.

## Core fixes and acceptance evidence

### Task privacy and historical watcher access

Priority: immediate release blocker. Owner: backend authorization lead. Current-master source: [task routes](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/routes/tasks.ts#L904) and [visibility helper](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/lib/task-visibility.ts#L19).

The watch endpoint inserts a watcher without first checking task organization or visibility. Watchers themselves confer visibility. A caller with a restricted task ID can therefore grant themselves access. The duplicate project task list also bypasses the visibility predicate and returns restricted task data.

Guard watch creation with the same live organization, non-deleted task and visibility checks used for reads. Invisible, cross-org and deleted tasks must return the established 404 shape without inserting a watcher; duplicate authorized watches remain successful and idempotent. Apply consistent visibility to both list paths while preserving their response contracts, and inspect inline predicates in project routes and human MCP tools. Regression evidence must include list/detail/search/aggregate parity and attachment access through native REST, personal MCP and employee MCP.

An endpoint guard alone leaves historical unauthorized watcher grants effective. The existing watcher schema has no grant provenance, so it cannot distinguish approved watcher-only access from an exploit. Proposed decision: make watchers subscriptions rather than authorization grants. Inventory restricted watcher-only access for owner review, express approved intended access through the existing explicit visibility metadata, retain watcher records for subscriptions, then remove watcher-as-ACL predicates everywhere. Unknown grants fail closed; do not automatically bless or delete them.

Compare that option with adding verified grant provenance before implementation. The subscription option needs no new schema but does require reviewed, backed-up data changes and a clear operator note. If historical intent cannot be resolved immediately, ship the endpoint/list fix first and explicitly keep historical remediation open. Do not claim complete closure or roll back to the vulnerable authorization predicate.

### Space events and chat routing

Priority: immediate release blocker. Owners: backend realtime and frontend chat maintainers. [Standup producer](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/lib/standup-automation.ts#L269) sends full space messages to the organization room; users removed from a space can remain in that room. [Space chat](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/web/src/components/space-chat.tsx#L1016) also accepts new-message events without checking the active space.

Route full content through authorized space membership. Keep any organization-wide counters free of private content. Reject mismatched space events before updating message, thread or reply state. Verify a current member receives one event while removed members, non-members and guests receive none; include reconnect and revocation cases. In a two-user browser test, unrelated space/DM messages must leave the current conversation unchanged during rapid navigation. No migration is expected.

### Production JWT validation

Priority: immediate release blocker. Owner: existing PR 348 maintainer plus CI maintainer. Complete PR 348 rather than opening a competing implementation.

Production must reject missing, blank, placeholder, known-default or short JWT secrets before serving HTTP or touching the database. Set distinct generated secrets meeting the validation threshold in every production-mode CI container, including init, seed, browser smoke, upgrade and certification commands. The reviewed smoke job supplies short secrets and its seed containers omit them.

Use subprocess tests for invalid production configurations and a valid startup path; retain development behavior. Run the Production Image and Browser Smoke plus Versioned Upgrade gates on the updated PR. Document required operator configuration before upgrade. Secret rotation invalidates existing tokens unless a separately designed rotation mechanism exists; do not promise seamless session retention. No database migration is needed.

### Atomic first workspace creation

Priority: high. Owner: backend authentication maintainer. [Bootstrap route](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/routes/auth.ts#L78) counts users before several separate writes. The review probe allowed two requests to create two initial organizations.

Proposed smallest fix: hash the password before locking, take a fixed PostgreSQL transaction advisory lock, repeat the bootstrap eligibility check inside the transaction, and atomically create the initial human owner, organization and membership. Use the existing transaction-lock pattern. Create the web session after commit because it owns its own transaction; optional agent setup must not compromise human bootstrap atomicity.

On a separate initially empty disposable database, race simultaneous requests: one organization and one owner should be created, losers receive the established single-organization error, and injected insertion failure leaves no partial rows and permits a later retry. Verify existing invitation/signup behavior. Do not reconcile already-created organizations by deleting or merging data. No schema change is proposed; serializable retry or a database singleton are larger alternatives requiring separate justification.

### Honest readiness

Priority: high. Owner: API and operations maintainer. [Readiness](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/index.ts#L261) currently proves schema state while [server startup](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/server.ts#L61) can continue after worker failure.

Keep liveness for the running HTTP process. Return readiness 503 during initialization, required worker or scheduler startup failure, and shutdown; return 200 only after explicit startup completion and required components are running. Surface safe component states without secrets. Make doctor and self-host smoke inspect readiness as well as health.

Test worker and scheduler failures, shutdown, successful startup, long jobs and transient database failures. Do not derive readiness from a 15-second shared poll timestamp that a valid 120-second job can exceed; per-queue heartbeat semantics would need a separate design. No migration is expected.

### Approval descriptions and receipt guarantees

Priority: high for misleading claims; durable receipt enhancement follows separately. Owners: shared policy, frontend settings and backend audit maintainers.

Use one set of descriptions matching the tested trust matrix across settings, agent creation and backend comments: conservative review behavior, standard automatic quick actions, autonomous broader execution with destructive actions still requiring review, and mandatory App review. Personal MCP authorization remains a separate contract. Keep policy defaults and behavior unchanged while correcting the copy; verify representative task, chat, destructive and App actions against existing matrix tests and rendered settings.

Native receipt recording is currently best effort and can return null. Narrow universal audit claims before release and distinguish effect success from missing receipt evidence. Add an org-scoped gap diagnostic and idempotent repair only where actor, intent and outcome can be reconstructed from durable evidence. Ambiguous outcomes stay unresolved; do not fabricate receipts or convert an already-completed effect into a retryable failure.

If universal durable native receipts are required, compare a transactionally written audit intent/outbox with synchronous failure coupling. Prefer an additive durable intent with idempotent materialization, uniqueness and redaction checks; rehearse fresh creation, upgrade, pending intent preservation and rollback before rollout. External writes continue to use the Run ledger and retain unknown outcomes. This is an architecture follow-up, not a claim that a new receipt defect was reproduced.

## Frontend fixes and certification

All frontend changes must consult the installed Next.js documentation and `apps/web/AGENTS.md`. Use the existing browser smoke harness and representative desktop 1440 by 900, mobile 390 by 844, and 200 percent zoom inspections. A build alone does not complete a UI change.

| Batch | Change and dependency | Required evidence |
| --- | --- | --- |
| Request identity | Add cancellation plus request-generation/identity guards to task table, board and fallback loading and wiki detail. Check identity after response and parsing; stale errors and loading updates must also be ignored. Clear project-scoped selection and old wiki detail before edit/save. | Deferred A then B responses, B-before-A resolution, late completion after abort, stale failures, unmount and My Tasks/filter changes. Actual browser editing and saving B must never use A's slug. Current source: [task page](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/web/src/app/%28app%29/tasks/page.tsx#L294) and [knowledge page](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/web/src/app/%28app%29/knowledge/page.tsx#L534). |
| Calendar dates | Parse validated date-only URL values into local calendar components. Reuse or narrowly extract the existing local ISO helper; keep event timestamp semantics. | UTC, Los Angeles and Kolkata; day/week/month, leap day, impossible input, DST and year boundaries, bookmarked links and back/forward. The reviewed UTC parse changed October 2 to October 1 in Los Angeles. |
| Accessibility and issue 179 | Make Notes toolbar actions keyboard-activatable through click while preserving pointer selection behavior. Reuse AppDialog/ConfirmDialog for relevant legacy dialogs; inspect labels, busy/errors, focus trap and restoration. Certify login, main navigation, task creation, governed approval, personal MCP setup and revocation. | Keyboard-only runs plus an actually available named reader/browser/version pair, such as NVDA with Chrome. Desktop/mobile, zoom, light/dark, validation errors and nested dialog behavior. Record results per workflow; avoid a broader WCAG claim. |
| Thread synchronization | After space routing is fixed, update open threads on message edits/deletes through scoped parent/reply state and existing ChatContext patterns. Clean up listeners and removed attachment state. | Two users edit/delete parent and replies, unrelated events, space switch, close/reopen and agent metadata. No duplicated subscriptions or stale content. |
| Session cache investigation | First reproduce warm Attention/Inbox/approval/activity data from user A, logout and login as B, including late A responses, cross-tab changes, offline state and failed B requests. Only if reproduced, extend existing session-scoped SWR key and invalidation helpers consistently. | Real browser evidence before a fix. Stable token refresh retains its namespace; a new session ID changes it. No unauthenticated fetches or old-session data. The prior SSR harness did not establish a disclosure, so this remains an unconfirmed concern. |
| Approval copy | Use the shared descriptions from the core policy batch without changing the trust matrix or defaults. | Rendered settings and agent creation plus policy examples. |
| Production CSP | Remove unnecessary production unsafe-eval, bound API and WebSocket origins while retaining runtime public-environment injection. Decide nonce/dynamic-rendering/cache tradeoffs versus compatible hash handling before tightening inline script rules. Token storage changes are a separate architecture decision. | Production image on two configured origins; login/refresh, editor, files, calendar and MCP work. Forbidden eval/inline fixtures are blocked, allowed runtime bootstrap works, and dev/production headers are checked. Report-only measurements inform enforcement but do not count as completed enforcement. No XSS exploit was established in this review. |

## Platform repair before merging PR 345

First reproduce each old-head CI failure on the frozen successor; several local refactors differ from the remote PR. Fix production behavior when it is wrong and update stale structural assertions only when the reviewed boundary still holds. Do not weaken a security check merely to turn CI green.

| Failure group | Concrete work |
| --- | --- |
| Authority adapter imports | Review appVersions/appRuns access in agent routes and appVersions in attachments. Use the intended scoped authority adapter or explicitly justify the boundary change and test denial. |
| Automation transaction assertion | The regex expects a particular deliverFire transaction shape; local code has a transaction wrapper. Prove atomic effects and receipts with failure injection before aligning the structural assertion. |
| Hardcoded renewal database | Replace the one dated localhost database allowlist with a safe disposable fixture or dedicated required job/test manifest. Retain the rule that destructive tests cannot target application or important databases. Do not silently skip it in ordinary CI. |
| Standalone provider consumer | Resolve the expected Kit alpha.5 versus old-head alpha.3 and local alpha.9 mismatch. Pack the exact candidate, pin consumer lock and digest, and test outside the workspace. Never rewrite bytes under an already-published version. |
| Private state adoption and state operations | Two HTTP500 failures report APP_RUN_KEY_VERSION_UNAVAILABLE. Provision fixtures containing every referenced retained key version and check the real path; preserve production missing-key guards. |
| Secret and environment architecture checks | Review legitimate attachment, private Defty, private MCP and state broker access. Restrict allowlists to reviewed custody services and verify secrets remain inaccessible through public routes/logs. |
| Run submission boundary checks | Review the new Runtime route and adapter boundary before updating assertions. Preserve human authorization, exact target, lease/attempt and snapshot binding. |
| Rollout transition seed | Include retained referenced keys in the isolated fixture and prove upgrade behavior without deleting historical encrypted rows or outcomes. |
| Direct file and task adjunct privacy | The old tests receive 401 where resource denial expects 404. Establish a legitimate authenticated fixture first, then test inaccessible resources. Do not hide a broken session fixture by changing the expected denial. |
| MCP operational contract | Give app_runtime_action_list an explicit scope/classification and consistent advertisement contract. Do not broaden every tool's access. |

These groups account for the 13 reviewed API failures. Inventory the 343 skipped API tests on that PR: identify required security/database cases, optional cases and the job that actually executes each. Provision namespaced disposable databases, canonical retained keyring fixtures and safe cleanup. Required tiers must execute and produce results; a green job with skipped required coverage is insufficient.

Review all five CodeQL annotations independently. One concerns SHA hashing a server-generated random 32-byte bearer token in OAuth MCP; four concern wildcard postMessage with opaque sandbox frames. Confirm cryptographic intent, exact sender window/origin bootstrap validation, one transferred port and Worker boundaries with adversarial tests. Fix an actual weakness or document a narrow reviewed disposition. Do not use blanket suppression or add allow-same-origin to weaken the sandbox.

Certification must exercise owner/organization/member admission, exact resource target and purpose projections, private file/payload access, PDF Runtime handshake, current session ID, connection epochs, refresh and revocation. Hold I/O across revoke/expiry/target changes and prove denial both before and after I/O. Preserve the generic/core versus provider-domain boundary: Email OAuth, MIME, folders and mail index remain module/provider concerns.

Migrations 57 through 60 cover owner targeting, PDF-related contracts, private file custody and owner connections in the active tree. Freeze their SQL and prove fresh-schema parity with `pnpm db:push-full` on a fresh disposable database plus `pnpm db:upgrade` from the published baseline and relevant intermediate deployment baseline. Historical deployment evidence reports 33 byte overrides among 53 applied migrations, including CRLF/LF differences. Preserve the applied byte/checksum history through the supported upgrade plan; do not rewrite applied files or waive mismatch checks.

For rollback, rehearse backup/restore to a compatible image, schema, configuration and complete retained keyrings in isolation. Disable new admission if needed while preserving pending Runs, encrypted payloads, files and unknown outcomes. A raw down migration is not the default rollback.

## Email current milestone and remaining work

The existing [Email execution plan](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/docs/superpowers/plans/2026-09-30-email-launch-execution-plan.md>) remains the source for X00 through X19 and the 90-requirement map. This plan supplies cross-repository dependencies and fix priorities; it does not create a competing completion percentage or reduce the promised Gmail/Outlook replacement scope.

The latest checkpoint records one trusted Send4 confirmation and one native provider_accepted dispatch. The controlled recipient received the message in Spam. Sender and recipient attachment bytes match exactly, the sender body matches, recipient/subject fields match, and the two provider-observed Message-IDs agree. Strict paired verification is still false because Gmail replaced the sealed Message-ID and introduced a recipient plain-body line break. Native reconstruction already matches the sealed MIME and uses base64; forced encoding would not address the observed failure.

Preserve the strict failed verdict, original sealed payload, authenticated accepted journal and paired evidence. Investigate which transformations are provider behavior and what the product contract should promise. If canonicalization is proposed, separately bind the original sealed identity and provider-observed identity and retain byte-level evidence; obtain the architecture decision before changing the verifier. Do not weaken the check simply to report success, and do not blindly resend an accepted operation.

Two candidate fixes are not deployed: composer reservation recovery has 31 passing worker checks, and signed resource-target recovery parsing has 2 passing parser checks plus web typecheck and affected lint. Integrate and review exact successors, preserve reservation state on cancellation, and run real host/UI recovery against the frozen candidate. The sender-copy filename repair has offline and one accepted-message GET evidence; staged deletion/reset helpers are not proof of live deletion, reset or Sync behavior.

| Existing stage | Remaining gate and planned sequence |
| --- | --- |
| Stage 0 and X05 | Baseline and known correctness work are recorded complete. Carry the evidence forward without reopening completed work unless the candidate changes it. |
| Stage 1 X01 through X06 | Complete two real accounts, including the second Google connection; target bindings alone are not provider consent. Prove full Inbox/Sent conversation coverage, lazy reader, trusted Reply all and Cc, PDF draft reload, correct sender selection, one send and revoke-one-account isolation. Resolve strict provider transformation semantics, genuine deletion/expired-history and accepted response-loss behavior. Finish desktop/mobile/zoom/file-picker evidence. |
| Stage 2 X07 through X10 | After Stage 1 closes, complete triage and reversible bulk operations, search/read and safe HTML without passive remote fetches, raw EML/files, full To/Cc/Bcc/reply/forward composition, rich/plain bodies, signatures and draft conflicts, plus account and service permission/health UX. |
| Stage 3 X11 through X13 | Offline outbox and recovery, undo delay/scheduling/cancel-once, rules/snooze/preferences/notifications with honest provider-versus-local behavior, contacts/invitations/account timezone handling. |
| Stage 4 X14 and X15 | Private AI context, MCP renewal and explicit task/note/knowledge linking without implicit shared copying. Treat mail content as untrusted; changed recipients/files require a new review. Any promised delegated triage needs named account/agent scope, bounded reversible actions and deny/ask behavior; no implied Send or permanent-delete authority. |
| Stage 5 X16 through X18 | Reliability and declared provider/cohort matrix: Gmail consumer and Workspace, Outlook/M365, advertised IMAP/SMTP and any promised shared mailbox/enterprise needs. Decide cohort-dependent X18 scope early. Test limits, large mailboxes, interruption/restart, MIME/files, access races, backup/restore and devices. Then exact packaging, compatibility docs and source-offer/release evidence. |
| X19 | VIP categories, richer saved search and relationship context stay optional unless explicitly promised to the launch cohort. |

OAuth acceptance must cover session-bound one-use state, denied and replayed callbacks, supersession, disconnect before callback, provider subject and reduced scopes, independent account epochs, unknown refresh outcomes, reauthentication, owner teardown and expired consent. Local disconnect must not be represented as global provider revocation. Do not let a member request silently broaden an operator-provisioned account registry.

Freeze source and artifacts together. Current identities differ: Email package 1.5.9, build output 1.6.0-preview.1, live milestone 1.6.0-stage1.1, Kit alpha.9 and PR 346's alpha.6 title. Select coherent new identities and bind source SHA, package locks/tarball digests, module pins, deployed image, schema/key versions and evidence to them. Keep operator credential backups private and separate from the AGPL corresponding source offer.

## Release operations and the remaining issues

| Work | Acceptance gate |
| --- | --- |
| Issue 175 README images | Add temporary fixtures for existing, missing and renamed local images to the current checker. A failure names the README and broken path. Run `pnpm docs:check`; avoid another checker or changes to actual screenshots. |
| Issue 177 release notes | Check in a release-specific curated body with changes, install/upgrade guidance, limitations, comparison and attribution. Make missing/wrong-release notes fail. Render/test the workflow without publishing. Keep tag identity, digest-first recovery and the existing single release publisher. |
| Issue 174 scale CI | Use the existing 60-person harness in weekly and manual jobs with isolated infrastructure, exact commit/workload/budgets/environment, JSON verdict, readable summary and diagnostics. Define timeout, concurrency, cleanup and artifact retention. Demonstrate pass and controlled failure; missing report or failed verdict must fail CI. Keep this workload off ordinary PRs. Assign a performance owner before claiming ongoing operation. |
| Windows release tests | Reproduce the CRLF assertion and process timeouts on the chosen source. Make textual assertions newline-portable and diagnose process startup/cleanup with bounded evidence before changing deadlines. Retain strict Linux entrypoint child supervision and failure propagation; rerun both environments. |
| Core and Platform recovery | Rehearse fresh install, supported upgrade and isolated restore of database, encrypted files/payloads, retained keys, runtime/module configuration and pending/unknown outcomes. Verify restored behavior, health and readiness; a successful archive command is not restore proof. |
| Release source and image | Verify exact source archive, locks/module pins, AGPL license/notice, manifest, SBOM, checksums, signature and provenance for the selected image digest. No reused version with different bytes, moved tag or docs pointing at an absent image. |
| Issue 172 ARM64 | Deferred. When accepted, build/sign/provide provenance for the architecture images or manifest and certify install, doctor and browser on actual ARM hardware or explicitly identified emulation. Preserve amd64. It is not a next-preview blocker. |
| Hermes optional certification | Separate track if a new Hermes compatibility claim is planned. Reconcile pinned upstream/native adapter, manifest and bundle product version, then require two clean exact-release live-provider certification passes. The reviewed 27 passing pinned tests do not establish a new release certification; the current bundle version mismatch must be fixed before such a claim. |

Release preparation must use the current `RELEASING.md`, self-hosting contract and scripts from the execution candidate, not the stale main checkout. Select the actual next unused release identity after inspecting published tags and reserved preview.16 work; do not invent or reuse a tag in this plan.

## Retained local work and cleanup

The worktree audit found 60 registrations: 46 clean, 13 dirty and one missing/prunable PR 266 checkout. The active Platform/Email tree is ongoing implementation. Hearth core PR 342, PR 343 and PR 344 and CRM PR 334 are already merged; old settings, pilot receipt, Hermes spike and preview stabilization copies are predominantly retained history or superseded work. Some dirty CRM copies are equivalent after newline normalization, which is not permission to reset them.

At execution kickoff, compare any candidate files against master and active successors before carrying them forward. Preserve genuinely unique changes and required ignored artifacts. Do not reimplement merged work or make cleanup a prerequisite for fixes. Archive/prune/remove retained worktrees only in a separately requested cleanup, with recoverable snapshots and exact path checks.

## Completion ledger and release gates

For each batch, record exact source SHA and dirty-file digest if applicable, scoped problem/reproduction, final diff, test command and result, skipped coverage disposition, database/image/module versions, UI evidence where required, and remaining limitations. Tests that write fixtures must use a distinct, fresh disposable database; bootstrap races require their own empty database. Never run seed, reset or raw migration commands against the active operator database as a validation shortcut.

After focused checks pass, run one consolidated relevant pass on the integrated candidate: typecheck, lint, affected package/API suites, build, docs, release/public-env checks, production image/browser smoke, Versioned Upgrade and CodeQL. Run required Platform database/security tiers and actual rendered desktop/mobile journeys. Expand or repeat tests only for new changes, failures or unresolved risks. Include private-resource revocation and accepted response-loss cases where the release claims them.

Core release gate: task disclosure and historical access disposition, authorized space events, strict production secrets, atomic bootstrap, honest readiness, corrected approval/receipt claims, frontend data identity/date correctness and scoped accessibility evidence. An unconfirmed cache concern must have a completed investigation and an honest disposition; a confirmed disclosure becomes a release blocker. CSP completion must state the enforced policy and remaining inline-script constraint rather than claim a stronger policy than shipped.

Platform release gate: all required CI runs on exact heads, resolved CodeQL dispositions, executed required database tests, complete retained key coverage, reviewed trust boundaries, supported migration/fresh parity and demonstrated restore. Email Stage 1 gate and the full declared launch matrix remain separate; do not relabel a WIP example as a certified mail replacement.

Before marking any batch done, inspect the final diff and untracked inventory, verify the deliverable from fresh evidence and report every unverified requirement. Keep implementation, deployment and provider effects distinct in the ledger. For this planning deliverable, completion means every open item has a disposition, dependencies and acceptance evidence; it does not mean the proposed fixes are implemented.

## Evidence references

- [Current master source](https://github.com/Maneek21/Deft/tree/94626051299decb231b48bead1144a716cd7873d), [open PRs](https://github.com/Maneek21/Deft/pulls), [open issues](https://github.com/Maneek21/Deft/issues).
- [Email Stage 1 checkpoint](<C:/tmp/deft-gate-g-integration-20260924/docs/superpowers/plans/2026-09-30-email-launch-stage1.md>) and [Email closure ledger](<C:/Users/Osheen Pradhan/Documents/Codex/2026-09-30/email-launch-audit/stage1/closure-20261001/milestone.json>).
- [Send4 paired verification](<C:/tmp/deft-email-stage1-host-reader-20261001/send4-preparation/live-receipt/paired-verification.json>), retaining the failed strict verdict and accepted delivery evidence.
- Current-master review snapshot: `C:/Users/Osheen Pradhan/AppData/Local/Temp/deft-review2-36c4a8f19f1841f6943da7ef80289f2d`. Focused logs include `analysis-core-security-probes.log`, `analysis-production-jwt-probe.log`, `analysis-core-security-tests.log`, `analysis-web-product-tests.log`, `analysis-native-hermes-pinned-python.log`, `review2-open-platform-architecture.log`, `review2-release-tests.log`, `review2-entrypoint-recheck.log`, `review2-typecheck.log` and `review2-lint.log`. This temporary snapshot is review evidence, not a long-term artifact store; retain relevant sanitized logs with execution evidence.
