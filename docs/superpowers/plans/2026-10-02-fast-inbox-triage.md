# Fast inbox triage implementation plan

Build a dependable keyboard and mobile triage flow over Deft's existing Core attention system. A person should be able to open a mixed queue, inspect an item, clear an eligible notice or choose when to return to it, and continue without losing their place. Personal triage must preserve the source task, conversation, approval and agent run.

Status: proposed implementation plan, compatibility-reviewed October 2, 2026 against current source, worktree diffs, open PR file lists and relevant task progress. Application implementation, database reproduction and rendered certification have not been performed. Concurrent branches remain in motion; this review identifies overlap and integration gates, rather than certifying a conflict-free future merge. The scope is a Core release with an estimated effort of 3/5 and product win of 4/5; these are relative scope judgments, not delivery dates.

## Outcome and scope

The completion demo starts with a human request, a task update, a pending agent approval and an agent result. The user handles them using J/K, Enter, E and Z, recovers an accidental clear, and returns to the queue after opening a source. A second client changing an item never redirects an in-flight operation to a neighboring item.

Include keyboard navigation, existing source opening and approval review, explicit per-item seen state, eligible clear, selectable snooze, Later, return now, rescheduling, guarded undo, source visibility, dependable error feedback and mobile controls. Reuse current lanes, attention identity, event history, native review controls and PostgreSQL workers.

Exclude universal mentions and classification tags, with native mentions already being implemented in another thread; full source previews and split panes; swipe gestures; bulk clear or approval; AI importance ranking; new notification categories; agent execution or retry shortcuts; App Kit notification extensions; and a replacement inbox store. Existing App Run attention must remain compatible when that feature is enabled. The separate Documents assessment does not authorize replacing Notes or adding a new document source contract here.

## Execution baseline

| Source | Observed state | Execution consequence |
| --- | --- | --- |
| Remote master | `94626051299decb231b48bead1144a716cd7873d`, verified with `git ls-remote` during this review | Refresh at kickoff and start implementation from the current merged baseline. |
| Main local checkout | `2d478aee4bba23b34266e29247c1a0901f5b6d58`, with existing documentation changes and other work | Preserve it. Do not pull, reset or implement against its old application code. This plan is the only file created here by this task. |
| Native mentions implementation | `C:/Users/Osheen Pradhan/.codex/worktrees/native-mentions/Deft Main Repo`, branch `feat/native-mentions`, based on the reviewed master with active uncommitted work | Read-only review. Consume an accepted immutable foundation commit before editing its overlapping backend files; do not copy its moving worktree. |
| Platform and Email candidate | `C:/tmp/deft-gate-g-integration-20260924`, HEAD `0c611bb4b1a000e8b4a066f71974137e5c0f31cd`, with existing unrelated changes | Read-only comparison. Inbox page, row, hook, routes and maintenance match reviewed master; `attention.ts` has additional candidate changes that must be preserved during integration. |

At kickoff, inspect attached worktrees and reuse a suitable clean checkout or create an isolated `codex/` worktree. Record the exact SHA, source-policy dependency status and relevant dirty-file inventory. Follow `CONTRIBUTING.md` for tracking substantial implementation. This feature need not wait for full Email certification.

### Work ownership and integration order

| Work | Existing ownership and overlap | Inbox boundary |
| --- | --- | --- |
| Universal Tagging | Native reference/delivery ledgers, publication, source visibility, human writer context, passive employee attention, worker handlers and upgrade `0.3.0-preview.61-native-mentions.sql`; overlaps attention, human MCP, worker registration, schema, upgrade manifest and shared exports | Reuse its `native_mention` delivery adapter and source policies. Do not redesign its ledger, picker, editor, publication, notification delivery or employee MCP acknowledgment. See the [native mentions plan](2026-10-02-universal-native-mentions.md). |
| Governed Platform and Review unfinished email work | [PR #345](https://github.com/Maneek21/Deft/pull/345) changes attention, App Run projection, scheduler, human MCP, worker registration, schema/upgrades, shared exports, layout and `AgentActionCard`; Email work preserves uncertain-outcome handling | Preserve transaction hooks, governed source transitions, review cards and receipts. Personal triage cannot approve, retry or reconcile a run. Integrate and test these paths on their accepted revision without requiring all unrelated Email milestones. |
| Assess Deft documents app | Feasibility assessment of a Documents app built with App Kit; no accepted replacement source/storage interface at review time | Keep current Notes and native links working. Do not create a Documents adapter, change editors or migrate content in this feature. |
| Existing task privacy remediation | Shared task visibility and watcher access affect trustworthy source reads | Reuse the accepted source policy. Do not independently change workspace-wide task ACLs or make watcher membership a new grant. |
| Other open PRs | #346 release preparation, #347 Email example, #348 JWT validation and #349 CodeQL dependency update have no direct inbox-file overlap in the reviewed file lists | Refresh the lists at kickoff; source/runtime compatibility is still required after integration. |

Inbox-owned files are the inbox page, ordinary attention row, attention/count hooks, a new personal-triage helper, its focused contracts and tests. Shared edits to `attention.ts`, `mcp-tools/human.ts`, `workers/index.ts`, `job-scheduler.ts`, database schema/upgrade manifest and shared exports must be integrated serially on a known revision. Do not edit `AgentActionCard` internals, global layout shortcuts, mention editors, native reference/delivery storage, native publication or notification policy as part of this feature. Count invalidation belongs in the existing hook, not a layout rewrite.

First freeze the source/contract baseline. Independent inbox UI and helper work can proceed in an isolated branch against fixed fixtures. Before changing shared backend files, rebase onto an accepted native-mentions foundation commit and preserve its source predicates and passive employee bindings. If that foundation is still uncommitted, leave the overlapping implementation queued; do not build a competing mention adapter. For Platform overlap, choose an accepted combined integration revision or explicitly review the later merge before release. Do not transplant dirty candidate files. Recheck the relevant diff before each shared-file change and repeat compatibility validation after each integration.

The native mention branch reserves preview upgrade 61; Platform work includes committed upgrades through 56 and candidate upgrades 57–60. Allocate the snooze-index upgrade only after the combined manifest is known. Do not reuse, renumber or assume the next number is 62. These boundaries avoid unmanaged concurrent ownership; they do not remove the need to resolve and test an actual merge.

## Current implementation and evidence

These are source findings, not reproduced production defects. Add focused reproductions before changing the corresponding behavior.

| Current implementation | Planned delta |
| --- | --- |
| `apps/web/src/app/(app)/inbox/page.tsx` renders Needs you, Updates and Activity through `useAttention` | Add Later as a state view and one selection model across ordinary rows and approval cards. |
| Entering a lane calls `markAllSeen` for the lane, including unloaded items | Make bulk seen explicit; opening one item marks only that item seen. Selection alone has no persistence effect. |
| `AttentionRow` wraps controls inside a source link and discards action promises | Separate the real source link from buttons; add pending, failure and retry feedback per item. |
| Generic rows offer Later/Clear in terminal history; an unhydrated approval falls back to generic controls | Derive capabilities from source type and live state. A missing approval payload cannot enable clear. |
| `useAttention` refreshes on sockets and every 30 seconds, concatenating cursor pages | Deduplicate by ID and reconcile versions; retain selection and reject older responses. |
| REST supports seen, acknowledge, future-time snooze, resolve, feedback, state filtering and cursor reads | Add one guarded personal-operation path and reuse it from existing routes and personal MCP tools. |
| `transitionAttentionItem` checks allowed prior states but not an expected version; no resolved-to-open restore exists | Add atomic personal operations and narrowly bounded undo without weakening trusted source transitions. |
| `upsertAttentionItem` resets state and snooze on each distinct event | Preserve snooze for ordinary updates; use deterministic request/escalation semantics for reopening. Apply the rule to both single and batched projection paths. |
| Due snoozes are handled by the 15-minute maintenance job | Add a lightweight 60-second due-snooze scan and leave expiry/retention on the existing maintenance schedule. |
| Source visibility primarily covers messages, spaces and action records; approval hydration exposes action params | Reuse live native source and review authorization for reads, counts, hydration, mutations and restore. |
| `humanAttention*` MCP functions also invoke transitions and have a separate cached-result idempotency wrapper | Route these callers through the same personal-operation policy and return a fresh authorized projection on replay. |

Immutable reviewed sources: [Inbox page](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/web/src/app/%28app%29/inbox/page.tsx), [attention routes](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/routes/attention.ts), [attention service](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/lib/attention.ts), [personal MCP tools](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/lib/mcp-tools/human.ts), [schema](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/packages/db/src/schema.ts), and [workers](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/workers/index.ts).

## Architecture decision

| Option | Benefit | Limit |
| --- | --- | --- |
| Add keyboard controls and presets over current endpoints | Smallest UI change; effort 2/5 | Leaves missing undo, permissive approval clearing, inconsistent retries and snooze behavior. Adequate as an internal prototype only. |
| Extend existing Core attention with guarded personal transitions | Reuses storage and callers while making mixed triage dependable; effort 3/5 | Requires focused backend, worker, migration and UI validation. Recommended release scope. |

Core owns attention lifecycle and permission policy. Source domains remain authoritative for completion, expiry and approval decisions. Apps provide their existing governed events and source identities; they cannot interpret personal clear as acknowledgment of execution. No new broker, notification store or runtime is needed.

Keep trusted source transitions separate from personal triage. An approval route or source worker must still resolve every matching projection when the source changes. Public REST and MCP callers may perform only the personal operations authorized for their own attention items.

## Product contract

### Views and counts

Needs you and Updates remain the two lanes. Later queries `state=snoozed` across lanes. Activity queries terminal states and preserves existing work-capture history. Add an authorized snoozed total to the response instead of treating loaded-page length as its count or inventing a third lane.

Needs you displays its unresolved count; unseen remains a separate dot or secondary count. The existing sidebar badge uses unseen Needs-you count and should retain that meaning, with a plain accessible label. Opening an item reduces unseen, not unresolved. Acknowledge remains unresolved and changes no task ownership. Rename the current Own this label to Acknowledge.

Activity contains no personal triage buttons. Show Cleared for a personal dismissal and the actual source result for a source transition. Never describe a user-cleared assignment as a completed task. Later displays the exact return time, original lane and source status. Empty Needs you should still indicate deferred work when Later is nonempty.

### Item actions

| Item | Open | Clear | Snooze |
| --- | --- | --- | --- |
| Ordinary message, task, wiki or calendar notice | Existing authorized native link | Dismiss personal attention only | Allowed while source and attention remain eligible |
| Acknowledged notice | Existing source | Dismiss personal attention only | Allowed |
| Pending approval | Existing reviewed approval flow | Denied, including when hydration is missing | Allowed only before its effective source expiry |
| Ordinary agent failure or completion | Existing run/source/receipt where available | Personal dismissal when source policy permits | Allowed when source policy permits |
| Unknown App Run outcome or repair requirement | Existing operator review | Denied while the source requires reconciliation | Preserve existing source restrictions; no automatic retry |
| Snoozed eligible notice | Existing source or review | Same source restrictions | Change time or return now |
| Terminal, deleted or revoked source | Safe authorized history where available | No active mutation | No active mutation |

Pending approvals cannot be cleared from the personal-operation API. E on one displays a review instruction and leaves it selected. Approve and Reject remain explicit native controls; snooze never extends an approval's validity. Guard kinds and source identities before hydration, so a stale or unavailable review cannot fall through to ordinary Clear.

### Keyboard and mobile behavior

Use J/K and ArrowDown/ArrowUp to move focused selection, Enter to open, E to clear an eligible notice, Z to choose snooze, Escape to close local menus/review and restore focus, and Ctrl/Cmd+Z to undo the last eligible clear or snooze. Extend existing shortcut help through `?`. Do not add Space preview or a read-toggle shortcut in V1.

Require focus within the Inbox list. Ignore editable ancestors, inputs, selects, IME composition, open dialogs and review forms. Ignore repeated mutation keys and unrelated modifiers. Preserve ordinary Tab access and browser behavior for real links and modified clicks. Add context-specific triage help through the existing mechanism. Keep global G,A navigation, Shift+Escape legacy mark-read behavior and Ctrl/Cmd+K unchanged; this release must not silently retarget them or make Shift+Escape clear durable attention. Any existing global help mismatch belongs in a separate focused change.

Use list/article semantics and a roving row focus target. Keep buttons outside links and avoid listbox semantics around arbitrary interactive controls. Complete the lane navigation's accessibility pattern or use normal navigation buttons. Announce one result or failure through a polite live region. On mobile, provide the same actions with at least 44px touch targets and an accessible snooze sheet with focus return.

Selection is an attention ID, never an array index. Capture the action's item ID and version before sending. Only a successful response advances focus; choose the next surviving neighbor from the pre-action ordering, then the previous neighbor, then the view's empty state. New arrivals do not steal focus. Do not issue an operation for a neighboring item if the selected source disappears.

Persist only selection ID, lane and scroll position under an organization/user-scoped navigation key when opening a source. Restore them on return, subject to a fresh authorized read. Do not persist private previews. Honor `?item=<attention-id>` through the existing single-item read. Resolve existing `?action=<action-id>` approval links with an organization/recipient-scoped source lookup even when the item is not on the loaded page; terminal decisions open safe history instead of a stale approval form.

### Snooze and incoming events

Offer one hour, tomorrow at 09:00, next Monday at 09:00, and custom date/time. Display the concrete return time in the signed-in user's timezone, using existing time utilities. Convert to UTC and validate on the server. Next Monday is the first Monday after today's local calendar date, including a seven-day jump when today is Monday. Reject past or nonexistent local times; for an ambiguous custom time, show the concrete timezone offset resolved by the existing utility before confirmation. Show approval expiry and disallow choices past it.

While snoozed, an ordinary edit/progress event updates content and event history but retains snooze. A fresh request uses its own durable request identity; a material escalation may wake the existing item with a visible reason. A closed, expired, deleted or revoked request never returns as actionable. Ordinary updates after a user clear may legitimately create new attention, but retries of an already recorded event do not.

Classify wake behavior deterministically in trusted Core producers. Extend the existing draft/projection path with a small internal event intent such as update, new request or escalation; do not trust arbitrary agent text or client metadata to choose urgency. Unknown legacy producers default to preserving an active snooze. Preserve personal timestamps on a routine update; only a genuine reopening resets appropriate state. Keep attention-event dedupe and coalescing identities unchanged except where the native mentions contract supplies a corrected source identity.

## Backend contracts and concurrency

Add shared Zod schemas and types for the attention projection, capabilities and personal-operation request. Proposed public projection additions are `version`, `resolution`, `capabilities` and effective approval expiry; expose only authorized safe data. Keep lane and state names stable. Add `totals.snoozed` and optional authorized source lookup filters without removing existing fields.

A proposed `POST /api/attention/:id/triage` accepts a discriminated request:

```ts
{ operation_id, expected_version, action: 'seen' | 'clear' | 'acknowledge' | 'return_now' }
{ operation_id, expected_version, action: 'snooze', until }
{ operation_id, expected_version, action: 'undo', undo_operation_id }
```

The signed-in principal supplies organization, recipient identity, membership and scopes. The request supplies neither authority nor previous state. Return the current authorized item and operation metadata, including the committed version and server-calculated undo eligibility. A replay returns current state rather than a cached private body or an instruction to hide a newly reopened item.

Implement substantial behavior in a narrow Core helper, provisionally `attention-triage.ts`, used by REST and existing `humanAttention*` MCP functions:

1. Validate the request and obtain current organization membership and caller scopes.
2. Lock the recipient's organization-scoped attention item in a transaction. Apply live source authorization and allowed-action policy before reading a private preview or accepting a replay.
3. Look up the operation identity in existing attention event history. Replaying the same normalized request returns its recorded outcome plus a current authorized projection. Reusing an ID for a different item or payload returns a structured conflict.
4. Check the expected version and current capability. A stale version returns 409 with a refresh instruction; invisible resources retain the established 404 shape. No mutation occurs on a conflict.
5. Apply the personal state change and insert its event atomically. Use one reserved event type and `triage:<operation-id>` identity so the existing unique event index covers retries across operation kinds. Store a normalized request fingerprint, before-state timestamps, committed version and undo deadline; store no source body.
6. Publish socket invalidation after commit. A lost HTTP response can be retried with the same operation ID without applying another transition or incrementing event counts.

Handle a uniqueness race by rolling back the losing transaction and rereading the recorded operation. Snapshot restoration never rewinds source-event counters, source content or receipts. Recheck any source version needed to authorize a domain-sensitive decision under its existing lock/fence; an attention lock alone does not prevent a concurrent source revocation.

Keep the existing signatures and trusted behavior of `transitionAttentionItem`, `upsertAttentionItem` and `resolveAttentionBySource`. Require operation/version fields only at the new personal-service boundary, not from source workers or passive employee acknowledgments. Preserve the Platform candidate's optional executor and after-commit hooks, and preserve source-event dedupe in both single and batched projection paths. Patch only the human attention MCP adapters; do not change the generic MCP idempotency implementation or native mention publication context.

Keep existing seen/acknowledge/snooze/resolve routes and MCP names as compatibility adapters to this policy. Already-seen requests are successful no-ops. Legacy callers may omit revision/operation fields during the compatibility window, but still receive source and action guards; they intentionally act on current eligible state and do not gain stale-version protection. New UI requests require the complete contract. Document this difference rather than claiming revision protection for every old client.

New personal clears use server-defined dismissal provenance and display Cleared. Preserve existing legacy `resolution` strings, response fields and accepted reason semantics; do not silently rewrite stored reasons or convert them into a different response contract. Legacy text is not authority to change a source or bypass the approval guard. Derive the new personal-dismissal label from operation provenance rather than arbitrary text. MCP scope checks remain intact. Adapt only the human attention operations to the shared operation record and fresh authorized projection, retaining their idempotency-key compatibility and normal audit logging; unrelated MCP tools keep their current wrapper.

### Undo

V1 offers one-level undo of the latest successful personal clear or snooze for five minutes. Show a ten-second toast and keep keyboard undo available while eligible. Store operation identity in memory; the server is authoritative for the deadline and eligibility.

Undo restores the previous attention state, seen/acknowledged timestamps, snooze time and personal resolution fields only when the current item still matches the operation's committed version. Also recheck membership, source visibility and request validity. A new source event, source closure, expiry or permission removal invalidates restoration even if the attention version alone did not change. A prior snooze already due returns open; an expired source becomes safe history. Undoing a source approval, rejection, execution or task change is never allowed. Undo itself is retry-safe and is not placed back on the undo stack.

## Source authorization and integration

Reuse the accepted source policies rather than extracting a second universal policy catalog or copying ACLs into UI handlers. List, item lookup, counts, hydration, personal operations, undo and worker wake must agree on source eligibility. Preserve personal MCP scopes and App feature gates. An unrecognized source cannot gain a new mutating capability or private hydration by default. Do not blanket-remove working legacy reads merely because their type lacks a new adapter: document existing adapters, reproduce any access defect and make a bounded security correction with regression coverage.

The native mention implementation emits `source_type = 'native_mention'` with `source_id = deliveryId`, `dedupe_key = native-mention:<deliveryId>` and metadata containing `native_mention_delivery_id`, `native_mention_source` and `passive: true`. This ID addresses the delivery ledger, not the underlying task, message or document. Reuse `nativeDeliveryAccessSql(userId, deliveryId, orgId)` and the existing safe source projection/link. Never reinterpret that ID, parse display text to rebuild the source or emit a second notification when reading, clearing, snoozing, waking or undoing it. Those operations also cannot publish references, retry delivery or invoke an agent.

Keep the employee-facing mention path separate from personal human triage. Its bound employee/user identity, `read:workspace` and source-read scopes, `write:workspace` acknowledgment scope, passive result shape, feature gate and acknowledged-item filtering remain unchanged. Its low-level acknowledgment continues to work without a human operation ID. The new human service must not supply authenticated publication intent or broaden those scopes. Retain the native implementation's reader/feature-flag compatibility for persisted attention; do not force flags on as an integration workaround.

Prefer filtering authorized native items in SQL so pagination and counts agree. If a projection requires a second filter, advance the cursor by the last scanned row and continue a bounded scan; do not end pagination because filtered results are fewer than the page size. Hydrate actions through current review authorization and safe presentation, with explicit organization predicates.

At kickoff, reproduce source-mapping and visibility cases on the accepted combined revision. Reviewed master maps some task-origin mentions as message sources; the in-flight native delivery adapter owns the new source contract. Verify its correction after integration instead of rebuilding that mapping here. Existing task privacy/watcher remediation also constrains trustworthy source reads. Reuse the corrected shared policy when accepted; do not certify affected task previews against an unresolved access defect or rewrite unrelated task authorization in this feature.

Preserve `resolveAttentionBySource` for trusted completion and existing candidate App Run terminalization. Recheck their behavior against a snoozed or user-cleared projection. One person clearing a notice never affects another recipient. A source decision resolves all relevant active projections without recreating an executable approval in history.

## Snooze scheduler and migration

Use one new lightweight due-snooze scan on the existing PostgreSQL job queue at a 60-second cadence. Read due rows ordered by `snoozed_until, id`, process at most 200 per batch and use bounded transactional batches with lock skipping. Recheck the current snooze timestamp and live source before waking. Routine source updates may change the attention version, so do not fence wake-up against the version originally recorded when snoozing.

Keep the existing maintenance schedule for expiry and retention. Remove its wake responsibility after the dedicated scan is enabled; any temporary overlap must be idempotent. On worker restart, scan due rows from durable attention state, including snoozes created before this release. This avoids one delayed job per snooze and stale-job invalidation during rescheduling.

Add an additive partial index on due snoozes, provisionally `(snoozed_until, id) WHERE state = 'snoozed'`. Generate its schema migration and supported upgrade together; allocate its number after integrating the native mention and Platform manifests described above. Preserve all existing worker registrations, including native mention reconcile/publish/deliver handlers. No new table, enum or destructive backfill is planned. Verify the global due-query plan at representative retained-item volume.

A healthy, uncongested worker should normally return an item within one scan interval plus processing time; use 90 seconds as the initial rendered acceptance bound. Under a backlog, retain the original chosen time and expose delayed return honestly. Waking never invokes an agent. Push remains under existing delivery preferences and dedupe; add no new push interruption behavior in this feature.

Fresh disposable schemas use `pnpm db:push-full`; supported upgrades use `pnpm db:upgrade`. Prove an existing snooze, terminal history and operation replay survive upgrade. Keep the index on application rollback. A prior binary may not understand new operation records or prevent unsafe clear, so use a small corrective patch to disable new controls if needed; do not promise safe rollback to a version with the old approval-clear behavior. Follow existing backup/restore policy for actual database recovery.

## Frontend implementation

Extend `useAttention` to consume shared projections, perform guarded operations, reconcile items by ID/version and update all affected count caches. Include organization/user identity in attention cache and navigation-state keys. Integrate the sidebar count hook with attention events so clear, seen, snooze and source decisions do not leave stale badges. Preserve the old polling fallback.

Keep operations pending in place until acknowledged by the server for V1. This makes failure and retry behavior clear without building an optimistic rollback engine. After success, use the returned current item to update/remove the row and revalidate list/counts. Do not discard promises. Retry an uncertain operation with the same ID; retrying after a stale-version conflict requires refreshing and a new deliberate user action.

Deduplicate cursor pages and prefer newer versions. Revalidate loaded pages after state or ordering changes. Track request generation so a delayed response from a different user, organization or view cannot overwrite the active view. Preserve selected ID and viewport anchoring; new arrivals can be applied without moving the focused row. Source opening must not wait for a seen mutation to navigate, but failure to mark seen must remain retryable and must not fabricate a cleared state.

Use an Inbox-local triage hook only if it owns selection, focus and action coordination substantially; otherwise keep this logic in the page. Reuse existing overlay primitives, time helpers and `AgentActionCard` without changing its internals or its chat callers. Give its existing review controls an outer selection/focus wrapper. Preserve full review routes, safe parameters and receipts for native actions and App Runs, including uncertain and reconciled outcomes. Render capability-driven actions for ordinary rows. No universal action registry or document preview engine is required.

Read `apps/web/AGENTS.md` and installed Next.js accessibility/navigation guides at implementation time. Inspect the result at approximately 1280px desktop and 390px mobile, in light and dark themes. Exercise zoom, long titles, an empty lane, a large approval, a failing mutation and a custom-time picker.

## Delivery batches and exit evidence

| Batch | Implementation | Exit evidence |
| --- | --- | --- |
| 0 Establish baseline and regressions | Clean current-master checkout; record accepted native foundation and Platform integration revisions, shared-file ownership and upgrade reservations; reproduce source, approval-clear and snooze cases using fixtures | Frozen SHA, serial integration decisions and unchanged-behavior fixtures; focused failing regressions demonstrate the behavior to change. |
| 1 Core policy and operations | Shared contracts; live source eligibility; personal-operation transaction; approval guard; compatibility REST/MCP adapters; replay and restore | REST and personal MCP cannot bypass policy; retries are atomic; stale operations and revoked sources leave state unchanged. |
| 2 Current inbox interaction | Explicit seen behavior; separate links/buttons; pending/error states; approval deep links; stable selection; keyboard controls/help | Keyboard-only mixed queue works; Enter preserves native review; failed actions retain focus; terminal history has no invalid controls. |
| 3 Later and timing | Presets/custom timezone handling; authorized snoozed total; return now/reschedule; incoming-event preservation; indexed scan and upgrade | Existing and new snoozes return predictably after restart; ordinary progress does not wake them; resolved/expired sources stay closed. |
| 4 Integrated certification | Undo toast/keyboard, realtime and pagination cases, mobile review, sidebar parity, native mention and Platform compatibility, full relevant validation and final diff review | Exact combined candidate meets acceptance below and contains no unrelated edits; shared-file changes preserve both source foundations. |

UI work against fixed contracts can proceed while backend work is implemented, but keyboard clear/snooze must not ship against the permissive old transition path. Each batch should be independently reviewable; the mixed-queue promise ships only after all batches pass. No staffing or calendar estimate is asserted before baseline and regressions are established.

## Validation

| Case | Required observable evidence |
| --- | --- |
| Meaning of seen | J/K changes focus only; Enter marks the opened item seen; unrelated and unloaded items remain unseen. |
| Meaning of clear | Task/agent state and other recipients remain unchanged; pending approval and unresolved reconciliation cannot be cleared through REST, MCP or a stale UI. |
| Replay and races | Lost-response replay applies once; simultaneous same-operation requests produce one event; reused ID with changed payload conflicts; stale expected version cannot hide a new request. |
| Undo | Personal state restores once; a newer event, completed/expired approval, source deletion, membership removal or changed access prevents stale restoration. |
| Snooze | Presets/custom times use the user's timezone, including DST; rescheduling and return-now work; routines preserve snooze; overdue choices and approval-expiry violations are rejected. |
| Worker recovery | Restart and duplicate scan execution do not duplicate wake events; old snoozes survive upgrade; source terminalization racing wake cannot reopen an approval. |
| Privacy | List/get/counts/hydration/lookup/actions agree for cross-org, restricted task, private space, revoked source and absent approver cases; replay reveals no cached private body. |
| Navigation and realtime | New arrivals, changed sort order, socket updates, multiple pages and another client removing the selection preserve identity/focus; back navigation and off-page approval links resolve correctly. |
| Accessibility | Keyboard-only queue, normal link behavior, shortcut suppression in editors/IME/dialogs, visible focus, screen-reader result announcements and mobile touch controls pass. |
| Compatibility | Existing URLs, REST adapters, personal MCP scopes, source completion, backfill dedupe and enabled App Run attention retain their required behavior. |

### Preserve existing behavior across integration

These are regression requirements, not claims that the current branches have passed them together:

| Existing behavior | Required compatibility evidence |
| --- | --- |
| Native mention delivery and visibility | Authorized human mentions from the supported native surfaces create one durable delivery/attention identity. Source deletion, private-space membership loss and cross-organization access remain denied; list, counts and personal mutations use the delivery adapter. Existing Notes links still open. |
| Passive employee attention | The employee can list and acknowledge only its own authorized mention attention under the existing scopes and feature gate. Acknowledgment remains passive, changes no source and triggers no execution. |
| Publication and delivery authority | Seen, clear, snooze, return-now, worker wake and undo do not publish content references, enqueue mention delivery or fabricate authenticated human intent. Legacy notification/attention backfill does not duplicate native deliveries. |
| Source lifecycle and governed review | Approve/reject and terminal source events still resolve all active recipient projections, including snoozed items. Native and App Run full review routes/cards remain intact; uncertain outcomes retain reconciliation controls and receipts. |
| Existing public clients | Legacy URLs, resolution strings, MCP names/scopes, idempotency keys and unrelated cached-result wrappers remain compatible; only unsafe personal clearing is intentionally denied by the new guard. |
| Existing navigation and counts | G,A, Shift+Escape and Ctrl/Cmd+K retain their current meaning. Sidebar unseen counts do not become unresolved counts. Chat review cards and ordinary native links continue to work. |
| Combined database and workers | Upgrade the accepted combined schema with all existing migrations intact, preserving native ledgers and prior snoozes. Native worker jobs still register and execute; wake scanning is idempotent alongside old maintenance during rollout. |

The intentional interaction changes are explicit seen instead of lane-entry bulk seen, guarded personal clear, routine-update snooze preservation, Later and undo. Keep these separate in regression expectations from the behavior preserved above. Inbox does not implement a new document platform or change tagging semantics to make its tests pass.

Extend existing API tests such as `attention-system.test.ts`, `attention-signal-policy.test.ts`, `notification-policy.test.ts`, source-specific privacy tests and personal MCP tests. Proposed new API entry points are `attention-triage.test.ts`, `attention-route-triage.test.ts` and `attention-snooze.test.ts` for transaction/restore, public caller parity and scheduler behavior. Proposed web entry points are `src/lib/inbox-triage.test.ts` and `src/lib/inbox-snooze.test.ts` for selection reconciliation and timezone calculations. Extend the existing browser smoke flow for actual focus and review. Avoid tests that merely duplicate a key-to-action map.

Use a disposable `DEFT_TEST_DATABASE_URL` through the API test runner; it seeds and writes data. Do not run these tests against the active development or important database. At implementation time, verify script availability and use the narrow test files actually added, then one consolidated relevant pass:

```text
pnpm --filter @deft/shared test
pnpm --filter @deft/api test test/attention-system.test.ts test/attention-signal-policy.test.ts test/attention-triage.test.ts test/attention-route-triage.test.ts test/attention-snooze.test.ts
pnpm --filter @deft/web exec tsx --test src/lib/inbox-triage.test.ts src/lib/inbox-snooze.test.ts
pnpm typecheck
pnpm --filter @deft/web lint
pnpm build
pnpm test:product-browser
pnpm test:upgrade
git diff --check
```

These commands are planned validation, not a report of passing checks. Add the new transaction, route, source and worker files to the focused API invocation and retain rendered evidence. Before release, run the repository's required CI gates on the exact integrated revision and follow `RELEASING.md`.

## Release and measurement

Release copy should promise: Process team requests and agent updates quickly, defer them to a chosen time, and recover an accidental clear while approvals retain explicit review.

Certify the exact Core candidate independently of unrelated Email milestones, then run compatibility checks with the current Platform candidate when it is integrated. Preserve a small rollback patch that disables new UI operations without removing permission or approval protections. Review the final tracked diff and untracked files; only this feature's source, tests, index/upgrade and documentation belong in its change.

Use existing event history or bounded pilot observations for successful actions, failures, conflicts, undo and delayed wakes. Do not add analytics infrastructure or capture private previews. Compare time to process a fixed mixed queue, successful keyboard completion, accidental-clear recovery and chosen-time return latency. The product benefit is demonstrated by these behaviors; an empty inbox alone is not evidence of completed underlying work.
