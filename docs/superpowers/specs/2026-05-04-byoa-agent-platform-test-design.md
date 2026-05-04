# BYOA Agent Platform Test — Design

**Date:** 2026-05-04
**Status:** Spec, awaiting review
**Author:** Maneek + Claude Opus 4.7

## Goal

Verify that the **Deft platform** correctly hosts a BYOA agent — i.e. the live "maneek's claude code" employee in the test org. The agent is the fuzzer; the System Under Test is Deft's MCP contract, approval routing, trigger dispatch, knowledge surface, and UI reflection of agent activity.

This is **not** a test of LLM reasoning quality. Layer B uses a real LLM only to exercise the tool surface in realistic ways; assertions are still platform-observable (right rows, right UI state, right approval routing), not "did the model produce a good answer."

## Non-goals

- Reasoning/answer-quality scoring of the LLM
- Skill-defined trigger dispatcher (still un-shipped — see CLAUDE.md Phase 8)
- Long-horizon multi-turn dialogue. Each Layer B scenario is single-turn from a kickoff message.
- Production load / concurrency
- Coverage of every conceivable platform feature in one pass. This spec ships an initial deep test; follow-on tests will be designed from this run's results.

## Architecture

### Two layers, both Playwright-driven

**Layer A — deterministic contract test.** A Node MCP streamable-HTTP client wearing the agent's bearer token. For each scenario:

1. Playwright drives the Deft UI to set up state (post @mention, assign task, seed wiki page, fire webhook).
2. Harness polls the DB until the expected `agent_actions` row lands (or asserts no row, depending on scenario).
3. The MCP client calls `poll_pending_work`; harness asserts the row shape.
4. The MCP client makes the canonical tool calls a real agent would make for that scenario (`task_query`, `task_update`, `message_post`, etc.).
5. Playwright verifies the UI reflects the calls.

No LLM is involved. Tool calls are scripted. Result: deterministic, fast, free.

**Layer B — live LLM smoke.** Same Playwright setup + verify, but step 3-4 is replaced by an Anthropic SDK tool-call loop. The 27 MCP tools are auto-converted to Anthropic tool-use schemas; the loop runs until the model emits `stop_reason: "end_turn"` or hits a step cap (default 8 steps). Assertions remain platform-observable; reply text gets minimum verification (exists, has correct author, threads correctly).

### Token sourcing

`mcp_token_hash` is bcrypt — the raw token cannot be recovered from the DB and there is currently no `regenerate-token` endpoint despite a comment referencing one. Rotating the token would break the user's live Claude Code config.

**Decision:** the harness reads the token from `DEFT_TEST_AGENT_TOKEN` env var. The user pulls it from their existing Claude Code MCP server config and exports it locally. The harness never writes to the agent's token state.

A pre-flight script (`audit:byoa-preflight`) validates `DEFT_TEST_AGENT_TOKEN` works against `/api/mcp/v1/tools/list` and that the call resolves to the expected employee id, before any other tests run. This is the credit-burn guard from the existing audit pattern.

### State isolation despite a shared live agent

Because we're testing the live agent (per the user's choice), state contamination is a real concern. Mitigations:

- **Scratch space per test:** every test creates `#harness-<scenario-slug>-<ms-timestamp>` and tears it down in a `try/finally`. Messages live and die in the scratch space.
- **Scratch project per test:** same pattern, prefix `harness-`. Tasks created during the test are tied to a scratch project that gets soft-deleted at end.
- **Wiki page prefix:** all seeded wiki content uses titles starting with `harness:`. Suite teardown deletes any page matching that prefix.
- **Memory writes:** layer A writes to memory under titles starting with `harness:` and cleans them up. Layer B is allowed to write freely (we want to verify writes work), but suite teardown still cleans `harness:`-prefixed and recently-created (`> suite_start_ts`) memories owned by the agent.
- **Daily budget:** layer B is bounded by an internal step cap and the agent's existing `max_daily_actions`. We do not raise the cap.

### Token budget for Layer B

Per user direction (2026-05-04), no spend cap is enforced. Default model is `claude-sonnet-4-6` but configurable via `DEFT_TEST_LAYER_B_MODEL`. Per-scenario step cap of 8 prevents runaway loops. Total worst-case spend per full Layer B run ≈ 6 scenarios × 8 steps × ~3K tokens = ~150K tokens, comfortably under $1 even on Opus.

## Coverage matrix

### Tier 1 — Discovery (Layer A, 5 scenarios)

| # | Scenario | Setup | Tool call | Assertion |
|---|----------|-------|-----------|-----------|
| 1 | @mention dispatch | Playwright posts `@<agent> <prompt>` in scratch space | `poll_pending_work` | Returned row has `source='mention'`, `action='chat_mention'`, `space_id` matches scratch, `triggering_message_id` set |
| 2 | Task assignment dispatch | Playwright assigns scratch task to agent's shadow user | `poll_pending_work` | Row has `source='task_assignment'`, `action='task_assigned'`, task_id resolves |
| 3 | Webhook trigger dispatch | Direct POST to `/api/agent-webhooks/<slug>` with HMAC | `poll_pending_work` | Row has `source='trigger'`, `action='trigger_dispatch'`, `trigger_kind='webhook'`, payload preserved |
| 4 | Heartbeat tick dispatch | Force a heartbeat tick via `BullMQ.add('agent-employee-heartbeat', ...)` | `poll_pending_work` | Row has `source='heartbeat'`, `action='heartbeat_tick'` |
| 5 | Idempotency | Repeat scenario 1, then call `poll_pending_work` twice | second poll | Second poll does NOT re-deliver the row from the first poll |

### Tier 2 — Read tools (Layer A, 10 scenarios)

| # | Tool | Setup | Assertion |
|---|------|-------|-----------|
| 6 | `platform_context` | none (env-derived) | Returns `today`, agent's role, ≥1 teammate, ≥1 project; org_id matches expected |
| 7 | `memory_recall` | Seed two wiki pages (one matching, one decoy) | Top result is the matching page; FTS+vector blend score > 0 |
| 8 | `task_query` filtered | Create 3 scratch tasks, 2 assigned to agent | `task_query{ filter:{ assignee_id: agent_user } }` returns exactly those 2 |
| 9 | `task_detail` | Create scratch task with comment | Returns task + comment text |
| 10 | `thread_fetch` | Post parent + 2 replies in scratch space | Returns 3 messages in chronological order |
| 11 | `messages_search` | Post a message with rare token in scratch space | Search by token returns exactly that message |
| 12 | `events_query` | Insert a synthetic `pr_merged` event for org | Returns the event when `type='pr_merged'` |
| 13 | `member_list` | none | Includes seeded test users (`rahul@test.com`, `priya@test.com`) with roles |
| 14 | `team_workload` | Create 3 tasks across 2 assignees | Counts match per assignee |
| 15 | `project_progress` | Create 5 tasks in scratch project across 3 statuses | Status counts match |

### Tier 3 — Write tools + approval cycle (Layer A, 9 scenarios)

| # | Tool | Setup | Assertion |
|---|------|-------|-----------|
| 16 | `task_create` at current trust | Trust-aware: snapshot current trust at suite start | If current trust ≥ standard for `quick`-tier, expect immediate execution; else `queued_for_approval`. Assert returned shape matches |
| 17 | Approval cycle | Continue from 16, if queued: Playwright clicks Approve in `/agent/inbox` | After approve, scratch task exists with correct `title`/`project_id`/`assignee_id` |
| 18 | `task_update` round-trip | Create scratch task in `todo`. Call `task_update{ patch:{ status:'done' } }` | (Approve if queued.) Task detail page shows `done` status with correct activity entry |
| 19 | `message_post` | Call `message_post{ space_id: scratch, content: '...' }` | (Approve if queued.) Playwright sees the message in the space, authored by agent's shadow user |
| 20 | `memory_write` | Call with `title:'harness: <ts>'`, `body:'...'`, `type:'fact'` | Wiki page exists in `/knowledge`, scoped to agent (not org) |
| 21 | `memory_update` scope promotion | Call `memory_update{ slug, patch:{ scope:'org' } }` | At standard trust, returns queued; after approval, page visible org-wide. At conservative, queued. |
| 22 | `space_memory_set/get` | Set key=val, then get | Returned value matches |
| 23 | `request_human_approval` | Custom action `summary:'do X'` | New `agent_actions` row visible in `/agent/inbox` with `tier='full'` |
| 24 | Approval rejection path | After 23, reject in UI | `poll_pending_work` returns the row marked rejected |

### Tier 4 — Cooperative + telemetry (Layer A, 3 scenarios)

| # | Tool | Assertion |
|---|------|-----------|
| 25 | `record_decision` | Row written to `agent_cooperative_log` with `kind='decision'` and matching summary |
| 26 | `ping_alive` | `agent_employees.last_heartbeat_at` advances within 5s of call |
| 27 | `delegation_self_report` | Activity timeline (`/agent-employees/:id/activity`) shows the delegation |

### Tier 5 — Guards (Layer A, 5 scenarios)

| # | Guard | Setup | Assertion |
|---|-------|-------|-----------|
| 28 | Trust enforcement | Temporarily lower agent trust to `conservative` via PATCH (restore in finally). Call a `quick`-tier tool | Returns `queued_for_approval`, NOT auto-executed |
| 29 | Daily budget | Temporarily set `daily_budget_cents` to current consumed + 0 (restore in finally). Trigger any chargeable action | Action blocked / fails fast with budget-exhausted shape |
| 30 | Wrong caller_employee_slug | Call any tool with `caller_employee_slug='nonexistent'` | Tool returns 401-shaped error; no DB write |
| 31 | Org isolation | Insert a task in a different org via direct DB. `task_query` for that task's id | Not returned. `task_detail` returns 404-shaped result |
| 32 | Circuit breaker | Force 3 consecutive errored actions via direct DB write to `agent_actions` (status='error'). Wait for next health check | `agent_employees.unhealthy=true`. UI agent badge shows unhealthy |

### Tier 6 — Live LLM end-to-end (Layer B, 6 scenarios)

| # | Scenario | Kickoff | Platform-observable assertions |
|---|----------|---------|--------------------------------|
| 33 | @mention thread reply | Playwright posts "@agent what's the status of the auth migration?" in scratch space (with seeded wiki page on auth migration) | (a) ≥1 `message_post` queued, (b) approved (or auto if trust permits), (c) reply message visible in space, threaded under kickoff, authored by agent shadow user, (d) reply length ≥ 50 chars |
| 34 | Task pickup | Assign scratch task "draft RFC response" with description, to agent. Wait for dispatch | (a) Agent calls `task_detail` ≥1 time, (b) ≥1 `message_post` (task comment) queued + executed, (c) ≥1 `task_update` to `in_progress` queued + executed, (d) task status reflects in UI |
| 35 | KB-grounded answer | Seed wiki page `harness: refund-policy` with distinctive phrase "REFUND-PHRASE-7Q4". @mention agent asking the policy | (a) `memory_recall` called ≥1 time, (b) reply message contains "REFUND-PHRASE-7Q4" (literal substring) |
| 36 | Multi-tool plan | @mention "make a p1 task for X assigned to Rahul and tell him in #scratch-space" | (a) `task_create` queued, (b) `message_post` queued, (c) both visible in `/agent/inbox`, (d) approving both lands the task with priority=p1 + assignee=rahul AND the message in the space |
| 37 | Memory write | @mention "remember that we use 4-space indent in this codebase" | (a) `memory_write` queued+executed, (b) wiki page exists in `/knowledge` containing "4-space" |
| 38 | Escalation | @mention "delete every backlog task in this project" | (a) ≤ 1 destructive `task_update` attempted, (b) ≥1 `request_human_approval` row created, (c) reply mentions needing approval (assert via substring like "approval" / "permission" / "confirm") |

## Failure handling

- Each scenario wraps its own setup + verification in `try/finally`. Cleanup runs even on assertion failure. A scenario failing does not skip subsequent scenarios.
- Layer A and Layer B are separate audit binaries. Layer A failure does not block Layer B from running; the runner reports both.
- A pre-flight failure (token invalid, MCP endpoint down, expected employee not found) **aborts** the whole suite — this is the credit-burn guard.

## File layout

```
docs/superpowers/audits/agent-byoa/
├── lib/
│   ├── mcp-client.ts          # streamable-HTTP MCP client (~150 LOC)
│   ├── llm-loop.ts            # Anthropic SDK loop, MCP→Anthropic-tool adapter
│   ├── fixtures.ts            # withScratchSpace/Project/Wiki + cleanup helpers
│   ├── assertions.ts          # platform-observable matchers (assertActionRowExists, assertTaskInState, …)
│   ├── preflight.ts           # token + tools/list + employee-id sanity check
│   └── env.ts                 # required-env-var loader with clear error messages
├── agent-byoa-layer-a.audit.ts    # tiers 1–5 (~32 assertions)
├── agent-byoa-layer-b.audit.ts    # tier 6 (~6 scenarios, multiple assertions each)
├── agent-byoa-layer-a.last-run.txt
└── agent-byoa-layer-b.last-run.txt
```

### `package.json` scripts

```json
"audit:byoa-preflight": "tsx docs/superpowers/audits/agent-byoa/lib/preflight.ts",
"audit:byoa-a": "pnpm audit:byoa-preflight && tsx docs/superpowers/audits/agent-byoa/agent-byoa-layer-a.audit.ts",
"audit:byoa-b": "pnpm audit:byoa-preflight && tsx docs/superpowers/audits/agent-byoa/agent-byoa-layer-b.audit.ts",
"audit:byoa": "pnpm audit:byoa-a && pnpm audit:byoa-b"
```

### Required env vars

| Var | Purpose | Required for |
|-----|---------|--------------|
| `DEFT_TEST_EMAIL` / `DEFT_TEST_PASSWORD` | UI login (existing audits already use these) | A + B |
| `DEFT_TEST_AGENT_ID` | UUID of "maneek's claude code" agent | A + B |
| `DEFT_TEST_AGENT_TOKEN` | Agent's MCP bearer token, from user's Claude Code config | A + B |
| `DEFT_TEST_AGENT_SLUG` | Slug used as `caller_employee_slug` in MCP calls | A + B |
| `ANTHROPIC_API_KEY` | LLM API key | B only |
| `DEFT_TEST_AGENT_LIVE` | Must be `1` to opt in to Layer B (guards against accidental runs) | B only |
| `DEFT_TEST_LAYER_B_MODEL` | Model id, default `claude-sonnet-4-6` | B optional |
| `DEFT_WEB_URL` / `DEFT_API_URL` | Defaults to `localhost:3000` / `localhost:3001` | A + B optional |
| `DATABASE_URL` | For DB seeding + verification | A + B |

## Open questions / risks

1. **Layer A scenario 32 (circuit breaker)** assumes there's a health-check pass that flips `unhealthy=true` after 3 consecutive errored actions. Need to verify the exact mechanism is still wired post-Phase-9 — if not, this scenario shifts to "verify the field exists and a manual flip works" rather than "errors auto-trip it."
2. **Scenario 4 (heartbeat tick)** depends on the BullMQ queue accepting an out-of-band push. If the queue is sealed to the cron registrar, the harness will need to call into the worker directly.
3. **Scenario 17/19 (approval execution)** assumes the approve flow in `/agent/inbox` runs the action synchronously enough that the next `poll_pending_work` sees the resolved state. If async, the harness needs a polling wait.
4. **Token shown once** — if the user has lost the token from their Claude Code config, they'll need to recreate the agent (since there's no rotate endpoint). Spec assumes the token is recoverable.
5. The implementation plan should add `POST /:id/regenerate-token` only if user explicitly requests it. Default: do not change platform code, just consume what's there.

## Out of scope for follow-on tests (deliberate, will iterate)

Per user direction (2026-05-04), this spec ships an initial deep test; specific extra coverage (skill flows, more trigger types, specific KB structures) will be designed based on this run's findings.

## Reviewer checklist

- [ ] Scope matches "test the platform via the agent" framing
- [ ] No Layer B assertion scores LLM quality
- [ ] Layer A is deterministic — no test depends on LLM output
- [ ] Cleanup is `try/finally`, not best-effort
- [ ] Pre-flight aborts the suite on token / MCP failure (credit-burn guard)
- [ ] Live agent token is read-only — never rotated by the harness
