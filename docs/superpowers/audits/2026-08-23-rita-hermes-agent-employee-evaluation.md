# Rita (Hermes) agent-employee evaluation — 2026-08-23

## Verdict

Rita can deliver the requested agent-employee loop when the Hermes gateway and Deft Agent Channel bridge are both running: she chats in Deft, distinguishes people and conversation scopes, starts assigned work, makes durable workspace changes, reports evidence, asks for missing information instead of inventing it, and resumes after a human replies.

The current state is **functionally capable but not yet a fully reliable production employee**. The core behavior passed every ordinary product-path scenario in this run, but three platform gaps still make the experience conditional:

1. the channel bridge can report healthy/connected while the Hermes API is not running;
2. human MCP-originated message/task writes do not wake the Agent Channel, while equivalent product API writes do;
3. completed and blocked work is not persisted into the employee outcome telemetry (`last_work_outcome_at` remained null).

## Test environment

- Deft: `https://demo.deft.ing`, release `v0.3.0-preview.3`
- Employee: Rita (`b8b36159-3e6c-4ce9-8401-0c20f6027a71`)
- Employee user: `a010bb37-b837-4b48-95a3-a2b8340c436a`
- Runtime: Hermes, polling Agent Channel, verified certification, Standard trust
- Model: `gpt-5.6-sol`
- Reasoning effort: `medium`
- Hermes provider: `openai-codex`
- Bridge poll interval: 3 seconds
- Test window: 2026-08-22 19:17–19:26 UTC (2026-08-23 00:47–00:56 IST)

The Hermes config was persisted at `C:\Users\Osheen Pradhan\AppData\Local\hermes\config.yaml`. A live provider request and Hermes agent logs confirmed that the runtime initialized and executed `gpt-5.6-sol`; this was not inferred only from the config file. The configured reasoning effort was verified as `medium` before the scenarios ran.

## Scenario results

| Scenario | Expected behavior | Result | Durable evidence | End-to-end time |
|---|---|---|---|---:|
| Diego DM identity | Reply in the Rita DM, address Diego, retrieve the exact SAFE project name | Pass | Message `58d4cb44-f6a8-4441-9afd-15b77c7cdb14`: “Diego, the exact current SAFE project name is Food Safety Claims Review.” | 15.46 s |
| Lina DM identity | Keep Lina's private conversation separate from Diego's and identify Lina's responsibility | Pass | Lina–Rita DM `e85e1720-1c4d-40a4-9b8b-4691a2ac0818`; Rita reply `5ca8f24d-daba-4047-8063-b680559af93b` begins “Lina,” and describes her go-to-market responsibility | 16.46 s |
| Marigold public mention | Reply in the originating public thread and identify Marigold rather than Diego/Lina | Pass | `#operations` thread parent `e8fe5fc2-7bd8-4f7b-92db-1193ae9bbbd1`; Rita reply `ed15f948-06ec-42c0-8678-ac4a8235da81`: “Marigold, you are an admin and lead the Farm Operations team.” | 14.77 s |
| Diego assigned work | Start a task, inspect real SAFE work, create a wiki artifact, comment evidence, move to review | Pass | `SAFE-8` (`1be041dc-1345-40df-a370-7bed7d211fde`) moved `backlog → in_progress → in_review`; Rita comment `fed96e1f-23c6-4c92-a215-e06a7edaa7fa`; wiki slug `hermes-qa-safe-open-work-brief-2026-08-23` | 52.23 s |
| Missing-information behavior | Detect absent carrier/window, avoid invention, ask Diego, remain in progress | Pass | `OPS-12` (`69e9cfcd-2098-460c-ae7e-926c3b265eaf`) stayed `in_progress`; Rita comment `b70467e6-389b-4517-862c-8d89253c69ad` explicitly requests both facts | 23.35 s |
| Resume after assistance | Consume Diego's follow-up task comment, finish with supplied facts, move to review | Pass | Diego comment `9c8db721-74b4-4006-b329-1c0319d679f8`; Rita handoff `e6ef25cb-1f54-4adf-9bc4-5cc766687da6`; task moved `in_progress → in_review` | 28.81 s |
| Lina assigned work | Recognize the task creator, retrieve live project facts, report to Lina, move to review | Pass | `MKT-41` (`285da228-7fe2-46cc-8a82-70b6c0d67893`) moved `backlog → in_progress → in_review`; Rita comment `7886dff3-46ed-464b-82a0-58a202cc6b88` begins “Lina,” and reports the correct lead and 14 open tasks | 56.01 s |

Every fresh Agent Channel event was delivered once and completed once. Pickup latency was 0.22–2.89 seconds. No duplicate Rita replies appeared.

## What works now

### Chat behavior

- Rita replies in the correct DM or public thread.
- Direct messages do not require an explicit mention.
- Plain `@Rita` in a public channel is normalized to the structured mention and wakes the employee.
- Conversation scoping works across Diego's DM, Lina's DM, Marigold's public thread, and individual task IDs.

### Assigned work

- Rita responds to `task.assigned` events created through the ordinary product API.
- She reads task and project context with Deft MCP tools rather than fabricating facts.
- She performs real writes: task status transitions, task comments, and wiki creation.
- She follows the requested work-state progression and does not claim completion before evidence exists.
- Standard trust was sufficient for the tested native workspace writes; no approval deadlock occurred.

### Blocked work and assistance

- Rita correctly classified the missing carrier and pickup window as blockers.
- She requested both facts from the correct person and kept the task in progress.
- A later `task.commented` event reused the task-scoped Hermes conversation and caused Rita to resume without a new assignment.
- She attributed the supplied facts to Diego and moved the finished work to review.

### Human differentiation

- Diego, Lina, and Marigold were addressed correctly in three independent contexts.
- No response reused another person's name or private-DM details.
- Task creator identity was preserved: a Lina-created assignment was reported to Lina even though Diego owns the workspace.

## Gaps and risks

### P1 — Channel readiness is a false positive when the Hermes gateway is down

At the beginning of the run, the scheduled Deft channel bridge reported `Healthy=True` and Deft showed the channel as connected, but nothing was listening on Hermes port 8642. Five older events were already recorded as failed with `fetch failed`. The bridge heartbeat proves that it can poll Deft; it does not prove that it can execute a Hermes turn.

The test only became valid after starting `hermes gateway run --force`. The gateway is running now, but it is a manually started process and is not covered by the existing channel-service health result.

Required fix:

- supervise the Hermes gateway alongside the bridge;
- include an authenticated `/v1/models` or minimal inference probe in readiness;
- show degraded, not connected/healthy, when the execution API is unavailable;
- provide retry/replay semantics for events that fail during an outage.

### P1 — Human MCP writes do not emit employee wake events

Two equivalent control attempts were made through the connected human MCP surface:

- Diego sent message `3d9e7da0-7e11-4b84-8a96-0af697520a9c` to Rita via `send_message`;
- Diego created `SAFE-8` already assigned to Rita via `task_create`.

Neither operation created an `agent_channel_events` row, so Rita did not wake. Posting the same chat through `POST /api/messages/:spaceId`, and unassigning/reassigning the task through `PATCH /api/tasks/:id`, immediately emitted `message.created` and `task.assigned` events and Rita completed them.

This means assignments or messages created by connected AI clients can be invisible to onboarded employees even though the resulting message/task is visible in Deft.

Required fix:

- move message/task write side effects into shared domain services used by REST and MCP;
- add contract tests asserting that UI, REST, and MCP writes publish identical Agent Channel events;
- make idempotency cover both the record write and its wake event.

### P1 — Work outcome telemetry does not reflect real work

After the run, Rita had nine counted daily actions and fresh MCP activity, but `last_work_outcome_at` was still null. No new `record_outcome`, `record_conversation_turn`, or `record_decision` cooperative-log entries were written.

The bridge asks Hermes to return an `outcome`, but `processEvent()` does not persist that value. It marks an event completed whether the parsed outcome is `completed` or `needs_human`. The blocked task was behaviorally correct, but the channel/audit layer recorded the event as completed rather than waiting on a human.

Required fix:

- persist the parsed outcome through `record_outcome` or an equivalent server-side receipt;
- update `last_work_outcome_at` for completed work;
- represent `needs_human` as a first-class event/task handoff state;
- include the runtime summary, source event, task, requester, and resulting artifact IDs in the receipt.

### P2 — Tool-call recovery is useful but inefficient

During the Lina task, Rita called `project_progress` twice with an undefined project value. Both calls failed with `Project "undefined" not found`. Rita recovered by using `team_context` and `task_query`, produced the correct answer, and completed the task.

This is not a scenario failure, but it indicates a tool-schema or model-visible argument mismatch. The same run also showed a lifetime count of 1,485 `tools/list` calls for Rita, which is operationally noisy.

Required fix:

- make required project resolution arguments unambiguous in the Hermes tool schema;
- avoid rediscovering the complete MCP tool list unnecessarily;
- surface recovered tool errors in trace/audit UI without marking successful work as failed.

### P2 — Rita is reactive, not autonomous

Rita's direct message, mention, task assignment, task comment, and task status delivery paths work. However, `heartbeat_enabled=false` and `trigger_subscriptions` is empty. This run therefore validates a strong event-driven employee, not scheduled self-directed work or proactive follow-through without a new event.

If the intended product claim includes proactive autonomy, heartbeat scheduling, cost limits, and unattended continuation need a separate certification.

### P3 — QA markers are incorrectly linkified in chat

The chat renderer interpreted pieces of `[HERMES-QA-20260823-...]` as task keys and rendered broken task links such as `QA-20260823` and `DIEGO-2`. This did not affect Rita, but it makes synthetic and real hyphenated identifiers noisy in chat.

## Readiness recommendation

Rita is ready for **supervised pilot use** as an event-driven Hermes employee. The behavioral core is real and passed repeated scenarios across three humans and three task turns.

Do not yet describe the integration as a fully dependable, unattended employee. Close the gateway-readiness, MCP-event parity, and outcome-telemetry P1s first. After those fixes, rerun this exact battery plus a reboot/recovery test and a several-hour unattended soak.

## Test artifacts left in demo

The following records are intentionally retained and clearly labeled as synthetic QA evidence:

- `SAFE-8` — in review
- `OPS-12` — in review
- `MKT-41` — in review
- wiki page `hermes-qa-safe-open-work-brief-2026-08-23`
- three identity test conversations/replies for Diego, Lina, and Marigold

They should remain available until the findings are triaged, then can be archived or removed using marker-scoped cleanup.
