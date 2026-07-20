# Deft Attention and Notification System

Status: implementation contract

## Product contract

Deft has four distinct responsibilities:

1. Native surfaces hold the work and its local state.
2. Inbox holds durable items that need a person's attention.
3. Web Push interrupts only when waiting would materially hurt the work.
4. Activity and receipts preserve the audit trail without demanding attention.

An event may appear in more than one place, but it is represented by one durable
attention item with one identity and one lifecycle. Chat and Inbox never create
independent approval records.

## Lanes and lifecycle

Inbox has two primary lanes:

- `needs_you`: unresolved work that requires the recipient to decide, answer, or act.
- `updates`: useful changes that do not currently block on the recipient.

Items move through these states:

- `open_unseen`: delivered but not viewed.
- `open_seen`: viewed, still unresolved.
- `acknowledged`: the recipient accepted responsibility, still unresolved.
- `snoozed`: hidden until `snoozed_until`.
- `resolved`: the underlying request was completed, rejected, cancelled, or became irrelevant.
- `expired`: its explicit decision window ended.
- `superseded`: a newer item replaced it.

`seen` is not `resolved`. A source-domain transition resolves the item wherever it
is projected. Approval in Chat therefore resolves the matching Inbox item.

## Ownership and audience

- A direct mention belongs to the mentioned person.
- A direct message belongs to the other participant.
- A task assignment belongs to the assignee.
- A task update belongs to active watchers and directly affected assignees, excluding the actor.
- An approval belongs to the action requester by default. Explicit approvers may be added.
- Workspace owners/admins are fallback approvers only for orphaned or administrative actions.
- Calendar requests belong to required attendees; ordinary event changes are updates.
- Agent health and credential failures belong to owners/admins and the employee's manager when known.
- Broad channel messages remain in Chat unless they contain a structured mention or a deterministic request.

Private-space membership is checked both when an item is created and when it is read.
Removing access resolves or hides the projection without leaking its source preview.

## Surface event catalog

| Source event | Native surface | Inbox lane | Push default | Dedupe key | Resolution |
| --- | --- | --- | --- | --- | --- |
| Chat direct mention | Chat | needs_you | on after 2 min if unseen | `mention:{message}:{user}` | reply, explicit done, or mark resolved |
| Direct message | Chat | updates; needs_you only for a structured request | off | `dm:{conversation}:{last-message}` | read for update; reply/done for request |
| Thread reply to the user | Chat | updates | off | `thread:{root}:{user}` | thread viewed |
| Huddle invite/start | Chat | needs_you while live | on immediately | `huddle:{session}:{user}` | join, decline, or huddle ends |
| Task assigned | Tasks | needs_you | on for P0/P1, otherwise off | `task-assigned:{task}:{user}` | accepted, reassigned, done, or cancelled |
| Task due/overdue | Tasks | needs_you | due soon after 15 min; overdue P0/P1 immediately | `task-due:{task}:{user}` | due date changes, done, cancelled, or snoozed |
| Task comment mention | Tasks | needs_you | on after 5 min if unseen | `task-mention:{comment}:{user}` | reply or mark resolved |
| Task field/status update | Tasks | updates | off | `task-update:{task}:{user}:{digest-window}` | viewed or superseded |
| Approval requested | Source + Inbox | needs_you | on after 5 min; destructive immediately | `approval:{action}:{user}` | approve, reject, expire, cancel |
| Approval completed elsewhere | Source + Inbox | updates receipt only | off | same approval item | atomically resolved |
| Calendar invitation | Calendar | needs_you | on when response required | `calendar-rsvp:{event}:{user}` | accept, decline, tentative, cancel |
| Event starting soon | Calendar | updates | on at configured lead time | `calendar-start:{event}:{user}` | event starts/cancels |
| Calendar feed failure | Calendar/Settings | needs_you for owner | on after 2 consecutive failures | `calendar-feed:{feed}:failure` | successful sync or disconnect |
| Knowledge mention/review request | Knowledge | needs_you | off by default | `wiki-review:{page}:{user}` | review completed or request cancelled |
| Knowledge capture/update | Knowledge | updates | off | `wiki-update:{page}:{user}:{digest-window}` | viewed or superseded |
| Agent asks a human question | Chat/Agent | needs_you | on after 5 min if unseen | `agent-question:{run}:{user}` | answer, cancel, run ends |
| Agent action failed | Agent/source | needs_you for requester; admin for configuration failures | on for blocked runs | `agent-failure:{run}:{step}:{user}` | retry succeeds, dismissed, run cancelled |
| Agent disconnected/unhealthy | Agent settings | needs_you for owner/admin | on after health threshold | `agent-health:{employee}` | healthy or disabled |
| Integration credential expired | Settings | needs_you for owner/admin | on | `integration-auth:{connection}` | reconnect or disconnect |
| Weekly digest/manager pulse | Dashboard/Inbox | updates | off | `digest:{kind}:{period}:{user}` | viewed or superseded |
| Security/admin alert | Settings | needs_you | on immediately | stable alert identity | fixed or acknowledged |

## Urgency and interruption policy

Urgency is deterministic. AI may extract a request from ambiguous conversation, but
it may not upgrade a normal item to critical by itself.

- `critical`: security risk, destructive approval, P0 blocker, live huddle invite, or system outage affecting the recipient. Push immediately.
- `high`: explicit human request with a deadline under four hours, P1 overdue work, agent run blocked on a human, calendar response due soon. Push after 2-5 minutes if unseen.
- `normal`: mentions, assignments, ordinary approvals, due-soon work. Inbox immediately; push only if the user's category setting enables it.
- `low`: status changes, digests, capture receipts, informational activity. Updates lane only; no push.

Quiet hours defer all pushes except user-enabled critical alerts. Deferred pushes are
coalesced by attention item and sent at most once when quiet hours end.

## Dedupe and batching

- Producers supply a stable domain dedupe key whenever possible.
- One attention row exists per `(org_id, user_id, dedupe_key)`; repeated events append history and update `last_event_at` and `event_count`.
- Updates for the same task/page/space within 15 minutes coalesce into one item.
- Delivery attempts are idempotent by `(attention_item_id, channel, delivery_version)`.
- Reopening a resolved condition reuses the item, increments its version, and records a `reopened` event.

## Source resolution contract

Domain code owns truth. The attention layer subscribes to or is called after these
transitions:

- approval approve/reject/expire/cancel;
- task done/cancel/reassign/due-date change;
- calendar response/cancel/start;
- message/thread read or reply;
- agent run resumed/completed/cancelled;
- connection or employee health restored.

Deleting or hiding an Inbox projection never mutates the source object. Resolving the
source resolves every projection.

## Retention

- Active items: retained until resolved or explicitly expired.
- Resolved item summaries: 180 days by default.
- Attention event history and delivery receipts: 365 days by default.
- Push subscription records: deleted immediately on unsubscribe or terminal push error.
- Push payloads contain a short title, safe preview, route, and opaque item ID. They do not contain private source bodies when visibility cannot be rechecked.

Retention windows are organization policy settings in a later admin pass; v1 ships
with the defaults above and a scheduled cleanup job.

## Operational budgets

- Inbox list p95: under 300 ms at 10,000 retained items per user.
- Unread count p95: under 100 ms.
- Source transition to realtime Inbox update p95: under 2 seconds.
- Eligible source transition to queued push p95: under 5 seconds.
- No more than one non-critical push per attention item per hour.
- No more than eight non-critical pushes per user per rolling hour; overflow is summarized.
- Queue recovery must be idempotent after worker restart.

## Browser and device matrix

- Chromium desktop installed/PWA or browser tab: service worker push supported.
- Chromium Android: service worker push supported.
- Safari macOS 16+: supported for installed web apps where the browser permits it.
- Safari iOS/iPadOS 16.4+: supported only for Home Screen web apps.
- Firefox desktop/Android: supported when the browser grants permission.
- Unsupported or denied browsers retain in-app and Inbox delivery with plain guidance, never a broken enable control.

Permission is requested only after a user clicks `Enable browser notifications`.
Each subscription is named and revocable independently.

## Migration and rollback

1. Create attention/event/delivery/subscription tables behind `ATTENTION_V2_ENABLED`.
2. Dual-write existing notifications and approval requests into attention items.
3. Backfill unresolved legacy notifications and pending approvals with stable dedupe keys.
4. Compare legacy and v2 counts, ownership, and source links in shadow reads.
5. Switch Inbox reads to v2 while continuing legacy writes for one release.
6. Enable push only after v2 lifecycle and dedupe certification passes.
7. Rollback flips reads to legacy; v2 rows remain append-only and can be replayed.
8. Remove legacy union/read mutation only after production parity evidence.

## Bounded AI use

AI is allowed only for conversation episodes that deterministic rules cannot classify.
It returns structured fields: `is_request`, `requested_people`, `requested_action`,
`deadline`, `confidence`, and source evidence. Low-confidence results stay in Chat.
AI never selects an approver, grants access, overrides quiet hours, or sends a push
without deterministic policy validation.

## Definition of done

- Chat, Tasks, Calendar, Knowledge, Agent, integration, and system events follow the catalog.
- Approval audience is explicit and unauthorized members cannot list or act on it.
- Chat and Inbox projections share one action and resolve together.
- Inbox pagination and unread counts operate on one durable model.
- Web Push survives reload/restart, respects settings and quiet hours, and is device-revocable.
- MCP exposes the same list, counts, resolve, acknowledge, and snooze semantics as the UI.
- Load, recovery, privacy, dedupe, and browser-matrix tests meet the budgets above.
