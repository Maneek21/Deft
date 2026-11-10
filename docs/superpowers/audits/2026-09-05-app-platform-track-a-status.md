# Deft Apps: Track A status and continuation review

Reviewed 2026-09-05 for a public self-hosted preview. This is a read-only implementation and evidence review; it does not authorize or begin the later tracks. No product source, migrations, branches, PRs, deployments, or workspace data were changed.

## Finding

The Apps work stopped after Track A's immutable certification passed. Phases 0–6 and the bounded daily automation implementation are on GitHub master. The remaining work is release closure, public authoring distribution, operator usability, and stronger explicit scheduled-execution evidence. Custom experiences, App runtimes, specialized sync, broader private capabilities, and public ingress remain future platform work.

“Track A complete” is a valid historical milestone statement. “The entire Apps platform is ready for arbitrary community integrations” is not supported by the current contracts.

## Where the work stopped

The original Codex task is **Complete phase 1 app platform**, task ID `01a04e01-fe3a-7500-ac45-e3f0d74401de`. Its September 2 stop instruction explicitly says Track A is complete and certified and to stop implementation before the subsequent tracks. The response records that no final release audit was committed after that instruction. Later discussion covered the ecosystem report and a one-link public authoring experience; that discussion did not implement the proposed experience.

| State | Verified revision / result |
|---|---|
| Root local checkout | `2d478aee`, 157 commits behind GitHub master; original AGENTS.md and CLAUDE.md modifications preserved |
| GitHub master / certifier | `7355c90a0ab5630b839440e8e25133b63853835c` |
| Certified Track A product | `121aa7c0b332819abc039874dc421b390d5ed106` |
| Phase 6 baseline | `16875df2f6c9dc2bc3d850de6758b7dd56767a05` |
| Latest published preview | `v0.3.0-preview.14`, commit `6d39e0e`; master contains 132 subsequent commits |
| Track A certificate | [Run 33590482418](https://github.com/Maneek21/Deft/actions/runs/33590482418), passed; `published: false` |
| Remaining Apps PR | [#317 — fix(web): prevent nested Apps mobile overflow](https://github.com/Maneek21/Deft/pull/317), open and mergeable; all 10 returned check runs succeeded |
| PR #317 worktree | `.codex-worktrees/app-platform-track-a-foundation`, branch `codex/app-platform-track-a-mobile-overflow-proof`, head `3a8bd1b0`, clean |
| Unmerged continuation proposal | `9e244ff4`, branch `codex/app-platform-email-lite-plan`, 28 behind master and one planning commit ahead |

The certified product and master differ only in four certification/workflow files. There is no intervening product-source difference to explain away. PR #317 does change product source and is outside the frozen certificate.

The root checkout is an unreliable place to infer current Apps functionality: it predates most of this work. This review inspected an archive of the verified master at `tmp/launch-audit-2026-09-05/current`, preserving the root and existing worktrees.

## Current implementation, mapped to the plan

| Area | What exists | Important boundary |
|---|---|---|
| Declarative Apps | Deterministic packages, manifest validation, module binding, native navigation and installation lifecycle | No executable App code |
| Capability and App Run foundation | Governed provider resolution, preparation, approvals, encrypted retained inputs, budgets, idempotency, receipts and recovery | Host owns effective authority |
| Resource participation | Cross-App Module references and relations, Task adapter, permission-aware search/context resolution | ResourceRef v1 is closed to Module and Task providers; it is not yet a universal adapter for all workspace entities |
| Connected lifecycle | Requested/effective grant separation, exact connector and action bindings, review, activation, upgrade, disable and recovery | Public action contract remains the frozen sandbox-email interface |
| Independent authoring | App Kit, generated guidance and brief, three templates, deterministic build/permission diff, doctor, single-use developer pairing | Public npm installation is not available; the guide currently uses a matching packed tarball |
| A.0–A.1: contracts and persistence | Additive Protocol v2 automation requests; immutable approved definitions; tenant-scoped fire ledger and Run lineage; migration preview.26 | One daily schedule over exact record inputs; staging grants no authority |
| A.2: execution authority | Closed automation principal and separate code-owned definition-approval policy; existing AppAction/AppRun path reused | The older per-invocation policy remains automation-forbidden |
| A.3: scheduling and recovery | Minute recurrence, cursor-paged scans, durable fires, deduplicated queue delivery, leases/epoch fencing, misfires and bounded orchestration retries | The fire ledger stops at Run creation; the App Run owns provider outcome and retry thereafter |
| A.4: authoring and management | Connected-automation template, simulator sharing host schedule functions, exact input review, Settings summary, pause/resume, budgets and dead-letter information | Manual dead-letter replay is always unavailable; no public per-definition revoke endpoint |
| A.5: certificate | Exact image, database tests, authoring, upgrade/fresh parity, predecessor reads, recovery hashes, browser/offline checks and cleanup | Passed evidence is bounded; see the end-to-end execution gap below |

Key implementation sources: [App Kit contracts](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/packages/app-kit/src/index.ts), [automation definition service](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/api/src/lib/app-automation-definition-service.ts), [scanner](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/api/src/lib/app-automation-scanner.ts), [queue/runtime adapter](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/api/src/lib/app-automation-runtime.ts), and [live Run authorization](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/api/src/lib/app-run-live-authorization.ts#L979).

### What bounded automation means in practice

- One exact action, one placement record, one selected related record; no unresolved user input.
- Daily local `HH:mm` in a canonical IANA timezone. DST gaps skip; folds choose the earlier instant once.
- Catch-up is allowed within 15 minutes. Resume excludes work missed while paused.
- Maximum definition validity is 30 days. Changed inputs, schedule, provider, permissions or policy require fresh review.
- One action per fire, one active fire per definition, at most 100 automation Run creations per organization per UTC day and 25 pending/claimed fires per organization, with lower approved limits possible.
- Three safe orchestration attempts. Once a Run exists, its provider policy determines whether another dispatch is safe; ambiguous effects must not be blindly replayed.
- App, grant, connector, membership, definition epoch, resource revision/content and policy pins are rechecked. A record edit can intentionally invalidate a schedule, even when the edited field seems unrelated to the send.
- Apps, App Runs, App-origin Runs and automations require explicit opt-ins. The browser Apps flag is baked into the web build. A runtime environment change alone does not expose Apps in an image built with that flag false.

This is a governed daily-action plane, not cron syntax, branching workflows, bulk campaigns, event-triggered automation, or a newsletter delivery system.

## Findings that matter before public use

### 1. The connected capability contract is much narrower than the architecture

**Verified by execution.** The published schema at `packages/app-kit/src/index.ts:515` accepts only private interface `sandbox_email_send`; action inputs at line 565 are exactly `to`, `subject`, and `body_text`. A scratch validation against built App Kit accepted the current scheduled Campaign manifest, rejected changing the interface to `create_support_ticket`, and rejected a cron trigger. No files were changed by this probe.

Generic provider internals do not automatically expose an open-ended public App action language. A new community App cannot just declare arbitrary MCP operations. Non-email capabilities need a versioned public contract, policy and conformance work, plus a second independent proof. This belongs to the relevant Gate G work, even if pulled forward before custom UI.

Launch implication: structured declarative domain Apps are useful now. Describe connected actions and automation as the certified bounded proof surface. Do not advertise arbitrary external actions, arbitrary providers, or production email delivery.

### 2. The public authoring journey is still unfinished

**Verified external result.** `npm view @deft/app-kit@0.1.0-alpha.2 version dist.tarball --json` returned E404 from the public registry on September 5. `publishConfig.access: public` is packaging intent, not evidence of publication. The current guide explicitly tells authors to pack a matching checkout or obtain an exact artifact.

The [public Modules documentation](https://deft.ing/docs/modules/) is still marked against preview.7 and describes the newer platform as pre-implementation. The proposed `deft.ing/build-app` front door was not verified as accessible in this review. Historical task discussion proposed it, its Markdown equivalent, a public package, and a copyable in-product prompt; those proposals should not be reported as shipped.

Before an Apps-focused launch, publish one exact, versioned App Kit artifact through a documented public channel; provide a concise public bootstrap page and current author guide; prove that an author starting outside the monorepo can build and stage an App using only that material. npm is convenient, but a public release tarball with verified commands and checksums is an adequate first distribution channel.

### 3. The mobile follow-up is real, despite the earlier green browser summary

**Existing defect and patch verified.** PR #317 adds `min-w-0` to the App card and checks the nearest scrolling ancestor as well as document width. Its product change is one CSS class; the other edits strengthen certification.

The downloaded certified mobile screenshot visibly clips the right side of content. The old evidence says no horizontal overflow because it checked document width, missing nested overflow. The screenshot and PR explain this discrepancy. All PR checks now pass, including Hermes, which was still running at the historical stop.

Before shipping this follow-up, inspect the rendered Apps management surface at mobile sizes using the stronger assertion. If creating a new full Track A certificate, update the candidate pin deliberately: dispatching the existing workflow unchanged would still build the old frozen candidate.

### 4. Explicit scheduled provider completion needs stronger proof

**Coverage gap, not a reproduced runtime failure.** The database test at `apps/api/test/apps-connected-grants-db.test.ts:919` proves a real persisted automation Run, unique claims, replay convergence, budgets, pause/disable races and dead-letter transitions. Scanner and dispatch tests use injected ports. The release browser fixture schedules 120 minutes ahead and proves review/create/pause/resume/management; it does not wait for that schedule to deliver.

The recovery artifact verifies 24 receipts, but reports aggregate App-origin Runs rather than a separate completed automation-origin provider action. The inherited Run engine has valuable execution/recovery tests; these should not be silently described as an assertion of the whole scheduled journey.

Add one explicit release-image test of: approved definition → due scanner occurrence → durable queue claim → automation Run → sandbox-provider call → terminal result → verifiable receipt. Assert a single provider effect across duplicate scans and worker restart, denial after revocation between Run creation and dispatch, and safe unknown-outcome behavior. Repeat the due-fire assertion after restoring the database and required keyrings. This is the highest-value additional test before enabling unattended use.

### 5. Older schedules can disappear from management

**Static implementation finding; not reproduced against a live database.** `listManagedAppAutomations` requests exactly 50 definitions at `app-automation-management-service.ts:221`. The repository orders newest first and applies that limit without a cursor. The endpoint has no pagination contract. The scheduler separately pages all eligible definitions.

Consequently an older active definition can continue to be eligible while disappearing from the normal list after 50 newer definitions, including historical/paused definitions. Add cursor pagination or an explicit enforceable supported limit that cannot hide active work. Regression case: create more than 50 definitions with an old active schedule and verify it remains discoverable and pausable.

### 6. Lifecycle and blocked-state presentation needs completion

**Static implementation finding.** Revoke and expire functions exist in the definition service, but source search found no production callers. Public management offers review/create/list/pause/resume only. Expired definitions are excluded from scheduling by validity checks, but their persisted state need not become `expired`.

The UI renders that persisted state directly, does not show the approved validity window, and shows little explanation for a skipped fire. The API returns a terminal reason, but the row principally displays state/date. An expired or invalidated schedule can therefore be difficult to distinguish from an active schedule waiting to run. Runtime authorization remains fail-closed; the issue is operator understanding and control.

Add derived expired/blocked eligibility and reasons, visible validity/renewal guidance, and a Run/receipt drilldown. Decide whether permanent per-definition revocation should be exposed. Test expiry, changed record content, connector disable, membership removal and permission change in the rendered management flow.

### 7. Retry and scale claims need restraint

Manual retry is hardcoded `eligible: false` at `app-automation-management-service.ts:315`; dead letters tell the operator to create a freshly reviewed definition. This is conservative behavior, not a missing generic retry button to add casually. Document it and preserve unsafe-effect protection if a future reviewed retry path is added.

The management endpoint performs one latest-fire query per displayed definition, and the browser polls it every ten seconds. The scanner also revisits eligible historical dates within the bounded validity window. This merits a measured query/latency/backlog budget before broader adoption; no performance regression has been reproduced here. Test several tenants, more than 100 definitions across pages, history near the 30-day limit, an offline provider, and unrelated healthy schedules.

## Evidence reviewed and tests run

### Fresh local checks for this Apps follow-up

- 21/21 automation tests passed, zero skips: definition contract, schedule/DST/misfire, scanner paging/recovery, dispatch lease/race handling. Log: `tmp/launch-audit-2026-09-05/track-a-focused-tests.log`.
- Public-schema probes: valid scheduled package accepted; arbitrary capability and cron rejected.
- Fresh GitHub reads: master revision, open PR #317 state and all returned checks, certification artifact inventory.
- Downloaded and read the small safe certificate artifact, including source/recovery hashes, browser outcomes, provider-offline outcomes and mobile screenshot. No image archive or production database was downloaded.
- Fresh public package lookup returned E404; public website documentation still describes the older Module flow.

The earlier launch audit also passed App Kit's 35 tests, web/shared/focused API checks, typechecking, lint and production builds. Those are existing evidence from this same audit session, not additional new test counts here.

### Historical immutable release-host evidence

[Run 33590482418](https://github.com/Maneek21/Deft/actions/runs/33590482418) reports `deft.app_platform.track_a.release_host.v1`, `passed`, `published: false`. Its recovery verification reports 22 tables / 375 rows, 24 migrations through preview.26, pgvector 0.8.6, 24/24 verified receipts, 5/5 retained input payloads decrypted and matching continuity hashes. These are mixed foundation/connected/automation fixtures, not 375 real customer records or 24 scheduled sends.

Safe artifact SHA-256: `5465c72b92a2d8f7daf31864ed05e56abc1f093af74a38e55bea4df6caa48352`. The downloaded files are in `tmp/launch-audit-2026-09-05/track-a-evidence`.

No new live-DB, multi-worker, restore, actual scheduled-provider or rendered PR #317 run was performed locally in this follow-up. The disposable Docker/pgvector environment was unavailable in the broader audit. Static findings above are explicitly distinguished from reproduced behavior and existing CI evidence.

## Work remaining after Track A

The committed delivery plan permits selecting privileged tracks independently after Phase 6. It does not require all of them for a bounded self-hosted preview.

| Work | Remaining implementation / exit evidence |
|---|---|
| Gate G generalization | Additional resource adapters as consumed; user-private/team/explicit-share contexts; inherited blob authorization; broader lineage-private capabilities; heterogeneous dependency/lifecycle/export/retention proofs |
| Track B: custom experiences | Isolation decision first; immutable static bundles; per-App/version isolation; closed MessageChannel bridge; resource/action SDK; live revocation; CSP, hostile content/egress, accessibility and mobile proof |
| Track C: runtime | Operator registration and App binding; short-lived pull claims; leases, heartbeats, cancellation and signed bounded callbacks; health/budgets/revocation; recovery and compromise tests |
| Track C: specialized sync | Canonical ownership; one-way provider projection; cursor/checkpoint/tombstone/freshness model; private resource and attachment authorization; resync/export/restore truth |
| Track D: Public Gateway | Cookie-independent public principal; bounded durable ingress; abuse limits; signature/replay protection; idempotent booking claims; failure and double-booking proof |
| Final platform claim | Independent heterogeneous Apps, Email Lite and public-automation compound proofs, compatibility policy, performance budgets, focused security review and exact release-image operations |

### The unmerged Email Lite proposal

The one outstanding commit `9e244ff4` contains a 270-line plan, not an App implementation:

`.codex-worktrees/app-platform-email-lite/docs/superpowers/plans/2026-09-01-app-platform-email-lite-shortest-path-loops.md`

Its proposed sequence is BC.0 isolation/runtime decisions → BC.1 isolated Email Lite shell (Track B) → BC.2 runtime kernel → BC.3 specialized sync (Track C) → BC.4 compound Email Lite → BC.5 release evidence → Track D and remaining Gate G stabilization. It reuses one evolving Email Lite proof instead of first building a separate Agent Operations Console.

Proposed Protocol/package v3 and v4 in that branch are future design choices, not implemented or frozen current contracts. The branch predates the final Track A closeout and must be reconciled with current master before adoption. Do not merge it expecting Email Lite functionality.

## Recommended resume order for the coming preview

1. **Set the Apps claim and release source.** Use current reviewed master, not the stale root checkout; preserve local work. Keep later tracks outside this preview. Clarify whether Apps is a developer preview alongside the core workspace.
2. **Close the existing mobile follow-up.** Review #317 and inspect desktop/mobile behavior with nested overflow coverage. Retain the existing certificate as historical evidence and attach fresh validation to any changed candidate.
3. **Make external authoring usable.** Publish the exact kit artifact; provide one public bootstrap link, updated guide, compatibility matrix and reference package. Test the complete outside-repository journey using only public instructions.
4. **Close unattended-operation gaps.** Add the explicit scheduled-provider/receipt recovery proof; fix or explicitly bound the management pagination issue; expose expiry and blocked reasons. Keep automation opt-in until this evidence passes.
5. **Seal and publish a named preview.** Link the Track A certificate and follow-up findings, correct stale status summaries, verify the Apps-enabled image/build flags and supported upgrade path, publish immutable artifacts, and retain explicit non-claims. This Apps work does not replace the core launch fixes listed in the separate launch-readiness audit.
6. **Then choose the next product capability.** If arbitrary connected actions matter most, take the consumed Gate G capability slice first. If Email Lite remains the goal, reconcile the existing proposal and start its isolation decision, then separately certify B, C and the compound proof. No later implementation was started by this review.

Completion evidence should be observable: an outside author can obtain the kit, build and stage a supported App; an operator can review, enable, observe, pause and understand blocked work; a real bounded schedule produces exactly the expected sandbox effect and verifiable receipt; and an ordinary self-host upgrade/restore retains that behavior.
