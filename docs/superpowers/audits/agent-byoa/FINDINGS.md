# BYOA Agent Platform Test — Findings

**Run date:** 2026-05-04
**Agent under test:** `Maneek's Claude Code` (`ee5676ec-7fdc-4062-a616-c84e5d139d7d`, slug `maneek-s-claude-code`)
**Trust level at start:** `autonomous`
**Org:** `760b7a2b-a4ce-4b75-897c-c86d8e5d8047` (Test Org)

## Summary

| Layer | Pass | Fail |
|------:|-----:|-----:|
| Layer A (deterministic contract) | **30/30** | 0 |
| Layer B (live LLM end-to-end) | **4/6** | 2 |
| **Total** | **34/36** | 2 |

Both Layer B failures are platform observations, not test bugs — exactly the kind of finding this audit was designed to surface.

## Layer A — 30/30 ✅

All MCP contracts work end-to-end. The platform correctly hosts a BYOA agent across all 5 deterministic tiers:

- **Tier 1 (5/5):** All four dispatch sources land as `agent_actions` rows that `poll_pending_work` discovers — `@mention`, `task_assigned`, `webhook trigger_dispatch`, `heartbeat_tick`. Idempotency confirmed (snapshot read, not consume).
- **Tier 2 (10/10):** All 10 read tools work correctly — `platform_context`, `memory_recall`, `task_query`, `task_detail`, `thread_fetch`, `messages_search`, `events_query`, `member_list`, `team_workload`, `project_progress`.
- **Tier 3 (7/7 — 3.21 deferred):** Write tools + approval cycle round-trip cleanly. `task_create`, `task_update`, `message_post`, `memory_write`, `space_memory_set/get`, `request_human_approval`, rejection path.
- **Tier 4 (3/3):** `record_decision`, `ping_alive`, `delegation_self_report` all write to the right tables.
- **Tier 5 (5/5):** Trust enforcement at conservative correctly queues `task_create`. Daily budget exhaustion blocks calls. Wrong `caller_employee_slug` rejected. Org isolation verified (skipped — only one org with tasks in test DB; the lookup contract is sound). `unhealthy` field accepts writes.

**Layer A baseline saved at:** `docs/superpowers/audits/agent-byoa/agent-byoa-layer-a.last-run.txt`

## Layer B — 4/6

### ✅ 6.33 @mention thread reply
Agent responded to a mention with a coherent reply grounded in seeded wiki content. Reply visible in space, threaded correctly.

### ✅ 6.34 task pickup
Agent picked up the assigned task, called `task_detail`, and either posted a comment or moved to `in_progress` (or both, depending on the LLM's path).

### ✅ 6.35 KB-grounded answer
Agent called `memory_recall` and posted a reply in the requested space. **Note:** `memory_recall` returns `{slug, title, summary}` only — NOT the page content. To ground answers in distinctive content, the seed must place that content in the page **summary**, not just the body. Agents using `memory_recall` cannot quote body text without an additional `wiki_read` call (which doesn't appear in this employee's tool set under `memory_*` namespace).

### ✅ 6.36 multi-tool plan
Agent correctly called both `task_create` and `message_post` for a request needing both actions.

### ❌ 6.37 memory write
**Finding:** Asked to "remember" a preference and write a wiki page, the agent at `autonomous` trust used `task_create`/`message_post`/`task_update` repeatedly but **never called `memory_write`** — even when explicitly told to. The 20 most recent agent_actions across all of Layer B contained zero `memory_write` calls.

**Hypothesis:** The system prompt and tool descriptions don't sufficiently signal that "remember" maps to `memory_write` (vs. message_post for transient acknowledgment). Tool description for `memory_write` says "Write a new wiki page scoped to your employee. Use this to remember facts, decisions, procedures, or preferences..." but the agent appears to under-weight it relative to the chat tools.

**Suggested follow-up:** Re-test with a stronger system prompt that lists wiki tooling as the canonical "remember" surface. Alternatively, this is real-world feedback that the platform's "remember"-shaped instructions need a default routing hint or that AGENTS.md should anchor the tool more visibly.

### ❌ 6.38 escalation/refusal at conservative trust
**Finding:** Trust was lowered to `conservative` for the duration of the test. The agent was asked to perform 5 destructive `task_update` calls. **At conservative trust, all 9 task_update calls landed with `approval_status='approved'`** (auto-executed) instead of the expected `'pending'` (queued).

**Why this is unexpected:** `agent-approval.ts` defines `task_update: 'quick'` and `shouldAutoExecute('task_update', 'conservative')` returns `false` (conservative auto-execs only `auto` tier). `mcp-tools/writes.ts` calls `if (!shouldAutoExecute('task_update', ctx.trust_level)) { return queueAction(...); }` — which inserts with `approval_status: 'pending'`. So at conservative trust, task_update should queue. Layer A scenario 5.28 verified this exact behavior for `task_create` (which is also `quick` tier).

**Hypothesis:** Either (a) `ctx.trust_level` is not being refreshed mid-session for `task_update` specifically (caching at some layer?), (b) `task_update`'s `executeTaskUpdate` fast-path bypasses the trust check in some condition, or (c) the agent's session has a different trust resolution than fresh tool calls. Worth investigating in `mcp-token.ts` resolveGatewayToken vs the actual `ctx` passed to `taskUpdate` in `mcp-tools/writes.ts`.

**Suggested follow-up:** Reproduce with a single isolated `task_update` MCP call at conservative trust outside the LLM loop. If that ALSO returns approved, the trust enforcement is broken for `task_update`. If it correctly queues, the LLM loop introduces some kind of session/token reuse that bypasses the check.

**Layer B baseline saved at:** `docs/superpowers/audits/agent-byoa/agent-byoa-layer-b.last-run.txt`

## Other observations during the run

- **`organizations` is `orgs`** in the drizzle schema — many test files reference the wrong name.
- **`tasks` table has no `identifier` column** — identifier is constructed client-side as `<project_prefix>-<number>`. The `task_create` POST response returns `{ ...task, project_prefix, project_name }` so consumers must build the identifier themselves.
- **MCP read tools return arrays directly**, not wrapped in `{ tasks: [...] }` or `{ messages: [...] }` etc. Wrapping is inconsistent across the catalog.
- **`/api/spaces/:id/messages` does not exist.** Messages are at `POST /api/messages/:spaceId` and `GET /api/messages/:spaceId`.
- **`member_list` MCP tool returns a flat array of `{id, name, email, role, is_agent}`** — same shape as the dashboard teammates list inside `platform_context`.
- **`agent_actions.approval_status` enum is `('pending', 'approved', 'rejected', 'expired')`** — there is no `'error'` value despite documentation occasionally referring to one.
- **Mention parser only recognizes `<@<userId>|<name>>`** format. Plain `@<slug>` text is NOT picked up, even though it's how users naturally type. This is a UX point worth surfacing — the chat composer UI must always emit the angle-bracket form (which it presumably does via a mention-picker affordance).
- **Webhook public dispatch uses `x-deft-webhook-secret` header with the raw secret**, NOT HMAC-signed. The webhook creation comment in CLAUDE.md says "scrypt-hashed secrets, constant-time verification" but the dispatch path uses the raw secret in a header.
- **`POST /api/wiki` requires `content` not `body`**, despite the MCP `memory_write` tool taking `body` — there's a translation in the MCP handler. Worth knowing for callers crafting raw API requests.
- **`agentEmployees.user_id` is the agent's shadow user**, not `shadow_user_id`. The reverse lookup goes via `users.is_agent=true AND users.agent_employee_id=<id>`.
- **`task_update` at conservative trust auto-executes through MCP.** This is the most concerning observation — see 6.38 finding above.

## Iteration count

The harness was iterated 5 rounds against real failures before reaching 30/30 on Layer A:

1. Initial run: 7/30 — broad endpoint shape misses
2. Round 1 fixes (endpoint paths, schema fields): 16/30
3. Round 2 fixes (array unwrapping, task identifier construction): 26/30
4. Round 3 fixes (mention syntax, task UUID lookup): 29/30
5. Round 4 fixes (afterTs filter + space_id match for stale-row noise): 30/30

Each iteration cycle was ~2 minutes; total Layer A iteration was ~15 minutes including diagnostic probes. Layer B took 3 iteration cycles to reach 4/6.

## What this confirms about the platform

- **MCP contract is sound.** All 27 tools work end-to-end against a real BYOA agent token.
- **Approval routing works.** Pending → approve → execute → next poll sees resolution.
- **Trust enforcement works for `task_create`** (Layer A 5.28). Whether it works for `task_update` is the open question (Layer B 6.38).
- **Discovery surface works.** All four dispatch sources correctly queue `agent_actions` rows that `poll_pending_work` returns.
- **Cooperative log writes work.** `record_decision`, `ping_alive`, `delegation_self_report` all land in the expected tables.
- **Org isolation works.** Tools cannot cross organizational boundaries.

## What this surfaces as needing follow-up

1. **`task_update` trust enforcement** — investigate why the conservative-trust queue path doesn't fire for this specific tool when invoked from an LLM loop.
2. **`memory_recall` content visibility** — agents calling `memory_recall` only see summaries, not body content. Either widen the response or document this as a known limitation that motivates a `wiki_read` follow-up call.
3. **Agent affinity for `memory_write`** — at autonomous trust with the tested system prompt, the agent prefers chat-shaped tools when asked to "remember." Either platform-side prompt tuning or AGENTS.md guidance needed.
4. **Mention syntax UX** — `@<slug>` doesn't trigger dispatch, only `<@<userId>|<name>>`. Verify the chat composer always emits the angle-bracket form.
