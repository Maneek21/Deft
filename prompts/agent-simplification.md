# Agent Architecture Simplification — Phase 9

## Vision

Deft has exactly two agent roles. No exceptions, no overlap.

**Defty is the internal agent.** It is Deft's built-in platform intelligence — the AI that lives inside the product. It runs in-process on Deft's server via the Anthropic API. It has direct SQL access to every table. It answers @mentions in chat, executes multi-step plans, creates tasks, posts messages, searches the wiki — all natively, with zero network hops. Defty is not an "employee." It is the platform itself thinking. There is exactly one Defty per org. Users don't create it, deploy it, or configure its runtime. It's always there.

**Agent employees are external agents.** They are BYOA (Bring Your Own Agent) — Claude Code, Claude Desktop, Codex, Cursor, or any MCP-compatible client the user runs on their own machine or infrastructure. They connect to Deft over the network as MCP clients, authenticate with an API key, and receive tools via `/api/mcp/v1`. They are the user's agents, not Deft's agent. They have their own runtimes, their own models, their own context windows. Deft gives them access to workspace data through MCP tools, gates their write actions through the approval system, and tracks their cost — but Deft does not run them, host them, or manage their lifecycle.

**The boundary is clean:** Defty reads the database directly. Employees read it through MCP. Defty runs on Deft's server. Employees run on the user's machine. Defty's system prompt is managed by the platform. Employees bring their own prompts and personality. Defty is one per org. Employees are many per org.

Everything that blurs this boundary — native employees (in-process agents pretending to be external), OpenClaw deployments (Deft trying to host external agents), claude_sdk and custom_mcp kinds (unnecessary type distinctions) — gets removed.

## Goal

Simplify Deft's agent architecture from 5 kinds down to these 2 clear roles.

**Remove entirely:**
- `kind='native'` employees (redundant with Defty — same in-process runner, same API calls)
- `kind='openclaw'` employees (no live gateway exists; `connection_url IS NULL` on every row)
- `kind='claude_sdk'` employees (deprecated)
- `kind='custom_mcp'` employees (fold into BYOA — they're the same thing)

The `kind` column and all OpenClaw gateway infrastructure get dropped. Every `agent_employees` row is a BYOA agent. If it's in the `agent_employees` table, it's external. If it's Defty, it's not in that table at all.

## Execution Order

Work through these 7 phases in order. Each phase should compile and pass existing tests (minus the ones being deleted) before moving to the next.

---

### Phase 1: Migration + Schema

**Create migration `packages/db/drizzle/0059_remove_openclaw_columns.sql`:**

```sql
-- Phase 9: Agent architecture simplification
-- Remove OpenClaw sidecar columns and provider infrastructure

-- Migrate any legacy native employees to BYOA before dropping columns
UPDATE "agent_employees" SET "is_byoa" = true WHERE "is_byoa" = false;

ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "kind";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "connection_url";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "gateway_token_encrypted";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "connection_status";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "template_slug";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "template_version";
-- NOTE: DO NOT drop trigger_subscriptions. It is the routing key for webhooks,
-- member.joined, and skill-defined cron triggers. It is NOT OpenClaw plumbing.
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "provider_hint";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "provider_instance_id";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "connection_error";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "last_gateway_ping_at";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "gateway_ping_fail_count";

DROP TABLE IF EXISTS "provider_instances";
```

**Update `packages/db/src/schema.ts`:**
- Remove the `kind` column definition and its enum/type from `agentEmployees`
- Remove all 11 columns listed in the migration above from the table definition (NOT `trigger_subscriptions` — that stays)
- Remove the `providerInstances` table definition entirely
- Keep: `is_byoa`, `byoa_model_info`, `mcp_token_hash` (still used for MCP auth), `trigger_subscriptions` (routing key for triggers/webhooks), all heartbeat columns, all skill/approval/cost columns
- Search the file for any indexes or relations referencing dropped columns and remove those too

**Important:** The Drizzle migration journal (`_journal.json`) has been stale since migration 0017. Do NOT try to fix it. This migration will be applied manually via direct SQL, same as 0025–0058.

---

### Phase 2: Archive OpenClaw Lib Files

Move these 3 files to `docs/deprecated/openclaw/` (create the directory):
- `apps/api/src/lib/openclaw-dispatch.ts`
- `apps/api/src/lib/openclaw-client.ts`
- `apps/api/src/lib/openclaw-chat-envelope.ts`

Then grep the entire `apps/api/src/` directory for imports from these three modules. Every import you find must be removed in the subsequent phases. List them in a comment at the top of each archived file so we have a record.

Also move to `docs/deprecated/openclaw/`:
- `apps/api/src/lib/openclaw-gateway.ts` (the WebSocket JSON-RPC client from Block 1)

---

### Phase 3: Backend — API Routes

**File: `apps/api/src/routes/agent-employees.ts`**

1. **Delete the `/provider-readiness` endpoint** — it's a no-op that returns `{ ready: true }`.

2. **Simplify the POST create handler:**
   - Remove the `is_byoa` field from the Zod create schema (or hardcode it to `true`). All employees are BYOA now.
   - Remove any `kind` assignment in the insert. Don't set `kind` at all (column is dropped).
   - Remove the `if (employee.kind !== 'native')` guard around `mcp_token_hash` — always generate and set the token hash for every new employee.
   - Always return the API key in the response (currently only returned for BYOA/custom_mcp).

3. **Simplify the GET detail and list handlers:**
   - Remove `kind`, `connection_url`, `connection_status`, `gateway_token_encrypted`, `provider_instance_id`, `connection_error`, `last_gateway_ping_at`, `gateway_ping_fail_count` from any `select()` calls or response objects.
   - If there's a filter-by-kind query parameter, remove it.

4. **Check all other routes in this file** for references to `kind`, `openclaw`, `native`, `connection_url`, or `gateway`. Remove them all.

**File: `apps/api/src/routes/agent.ts`**
- Search for `kind`, `openclaw`, `is_byoa`, `gateway`, `connection_url`. Remove or simplify any branching.

---

### Phase 4: Backend — Workers

**File: `apps/api/src/workers/handlers/agent-employee-heartbeat.ts`**

This is the biggest refactor. Currently it branches by `kind`:
- `native`/`claude_sdk` → `runAgentQuery()` (in-process Anthropic API call)
- `openclaw`/`custom_mcp` → `dispatchHeartbeat()` (gateway RPC)

After simplification, heartbeat should work like this:
- Load all employees where `heartbeat_enabled = true` and the employee is due (based on `last_heartbeat_at` + `heartbeat_interval_min`)
- For each due employee: BYOA agents don't receive push heartbeats. Instead, queue a `pending_heartbeat` record that the BYOA agent picks up on its next `poll_pending_work` MCP call.
- Remove the `scopeFromJob()` function and the `kindFilter` logic that splits native vs openclaw scopes.
- Remove the `isOpenClawShaped` conditional branch.
- Remove the `dispatchHeartbeat()` call path (it calls the archived `openclaw-dispatch.ts`).
- Remove the import of `dispatchViaOpenClaw` or similar.
- Keep all guard gate logic: budget check, circuit breaker, idempotency (prompt_sha), and loop detector.
- Keep the `agentHeartbeatTurns` logging.

**File: `apps/api/src/workers/handlers/agent-employee-message.ts`**

Currently has 3 branches:
1. BYOA path (`is_byoa || !connection_url`) — queues `agent_actions` for MCP polling
2. OpenClaw path (`kind === 'openclaw'`) — dispatches via gateway
3. Native/fallback path — calls `runAgentQuery()`

After simplification:
- Delete the OpenClaw branch entirely (branch 2).
- The BYOA path (branch 1) becomes the primary path for all employees.
- Keep the native/fallback path (branch 3) — this is used by Defty (the platform agent, which has no `agent_employees` row but still routes through this handler for @mentions).
- Remove `dispatchViaOpenClaw` import.

**File: `apps/api/src/workers/handlers/employee-trigger.ts`**
- Remove any `dispatchViaOpenClaw` calls. Route to BYOA path instead.
- KEEP the `trigger_subscriptions` routing logic — this is how agents declare interest in events. It is NOT OpenClaw plumbing.
- Keep the core trigger dispatch logic.

**File: `apps/api/src/workers/handlers/gateway-ping.ts`**
- **Delete this entire file.** No gateways to ping.

**File: `apps/api/src/workers/index.ts`**
- Remove the `gateway-ping` import.
- Remove the `gateway-ping` cron job registration.
- Remove any `gateway-ping` process handler.
- Keep all other worker registrations (heartbeat, message, trigger, daily-reset, etc.).

---

### Phase 5: Backend — Lib Files

**File: `apps/api/src/lib/mcp-token.ts`**
- Remove any `kind !== 'native'` guard. All employees now have `mcp_token_hash`.
- Simplify `resolveGatewayToken()` (or whatever the function is named) to always use `mcp_token_hash`.

**File: `apps/api/src/lib/agent-approval.ts`**
- Search for `kind`, `is_byoa`, `openclaw`, `gateway`. Remove any agent-type-specific approval routing.
- The trust level matrix (conservative/standard/autonomous × auto/quick/full) stays unchanged.

**File: `apps/api/src/lib/agent-approval-resolver.ts`**
- Search for `openclaw`, `gateway`, `kind`. If there's approval forwarding to an OpenClaw gateway (`gateway.exec.approval.resolve`), remove that code path.

**File: `apps/api/src/lib/skill-secrets.ts`**
- Search for `pushSkillSecretsToGateway`. If this function exists and only serves OpenClaw, remove it.
- Keep `resolveSecretsForInstall` if it's also used for non-gateway skill installation.
- Keep the `skill_secrets` table and CRUD — secrets are still useful for BYOA agents that need API keys.

**Files to check (grep for `kind`, `openclaw`, `gateway`, `connection_url`):**
- `apps/api/src/lib/agent-runner.ts`
- `apps/api/src/lib/agent-context.ts`
- `apps/api/src/lib/agent-stream-loop.ts`
- `apps/api/src/lib/agent-actions.ts`
- `apps/api/src/lib/agent-tools.ts`
- `apps/api/src/lib/capability-packs.ts`
- `apps/api/src/lib/mcp-tools/cooperative.ts`
- `apps/api/src/lib/mcp-tools/index.ts`
- `apps/api/src/lib/render-user-md.ts`

For each: if you find references to `kind`, `openclaw`, `native` (in the agent-kind sense, not the `event_source` sense), `gateway`, or `connection_url`, remove or simplify that code. If it's a conditional branch, collapse it to the BYOA/default path.

---

### Phase 6: Frontend

**Delete:**
- `apps/web/src/components/gateway-health-card.tsx` — no gateways, component is dead.
- Remove all imports of `GatewayHealthCard` from other components.

**File: `apps/web/src/app/(app)/settings/agent-employees/create/page.tsx`**
- Verify the creation wizard is BYOA-only (Identity → done, returns API key).
- If there's a native 3-step flow (Identity → Behavior → Skills), remove it. The behavior/skills steps were for native employees that no longer exist.
- If the page has a mode selector (native vs BYOA vs custom_mcp), remove it. Default to BYOA.

**File: `apps/web/src/app/(app)/settings/agent-employees/[id]/page.tsx`**
- Remove any `kind` display, `connection_url` input, `connection_status` badge, gateway health indicators.
- Keep: name, role, avatar, system prompt, expertise, trust level, heartbeat config, daily action cap.

**File: `apps/web/src/app/(app)/settings/agent-employees/page.tsx` (list page)**
- Remove `kind` column from the table/list if present.
- Remove `connection_status` column if present.
- Keep: name, role, trust level, active/paused status, daily action count.

**File: `apps/web/src/app/(app)/settings/agent-employees/[id]/personality/page.tsx`**
- This is the 7-file markdown editor (SOUL, AGENTS, USER, TOOLS, IDENTITY, HEARTBEAT, BOOT).
- Keep it — it's still useful for BYOA agents whose runtimes support reading these files.
- But search for `kind` or `openclaw` references and remove them.

**File: `apps/web/src/app/(app)/settings/agent-employees/[id]/developer/page.tsx`**
- Keep — this shows the API key, endpoint URL, and connection examples. Essential for BYOA.
- Remove any `kind` checks or gateway-specific developer info (wscat one-liner for gateway WebSocket, etc.).

**General frontend sweep:**
- `grep -r "kind.*native\|kind.*openclaw\|kind.*claude_sdk\|kind.*custom_mcp\|connection_url\|gateway_token\|GatewayHealth\|provider_instance\|connection_status" apps/web/src/`
- For every hit: remove or simplify.

---

### Phase 7: Tests + Cleanup

**Delete these test files:**
- `apps/api/test/openclaw-envelope.test.ts`
- `apps/api/test/openclaw-heartbeat.test.ts`
- `apps/api/test/gateway-ping.test.ts`
- `apps/api/test/agent-deploy-routes.test.ts`

**Modify these test files (remove kind-based test cases):**
- `apps/api/test/agent-employee-schema.test.ts` — remove kind enum validation tests
- `apps/api/test/phase8-heartbeat-routing.test.ts` — remove native/openclaw routing tests, keep budget/idempotency/circuit-breaker tests
- `apps/api/test/employee-trigger.test.ts` — remove openclaw dispatch tests

**Check these test files (grep for `kind`, `openclaw`, `gateway`, `connection_url`):**
- `apps/api/test/byo-provider.test.ts` — if OpenClaw-dependent, delete
- `apps/api/test/railway-provider.test.ts` — if OpenClaw-dependent, delete
- `apps/api/test/mcp-server.test.ts`
- `apps/api/test/agent-approval-resolver.test.ts`
- All other test files — quick grep, fix any references to dropped columns

**Update seed scripts:**
- `apps/api/src/scripts/seed-test-org.ts` — remove `kind` from agent creation, set `is_byoa: true`
- `apps/api/src/scripts/seed-test-org-rich.ts` — same
- `apps/api/src/scripts/issue-token.ts` — if it issues gateway tokens, delete or simplify

**Run the full test suite** after all changes. Fix any remaining failures from dropped columns or removed imports.

---

### Phase 8: Documentation

**Update `CLAUDE.md`:**

1. In the **Agent Architecture** section, replace the current description with:

```
**Two agent types:**
- **Defty** — built-in platform agent. Runs in-process via Anthropic API. Has 42+ native tools with direct SQL access, multi-step planning (`create_plan`), memory (remember/recall), and streaming responses. Operates under the org-wide trust level. No heartbeat (reactive only — responds to @mentions and triggers).
- **BYOA employees** — external agents (Claude Code, Claude Desktop, Codex, Cursor, etc.) connecting via MCP. Authenticate with API key, get tools via `/api/mcp/v1`. Per-employee trust levels, daily action caps, cost tracking, circuit breakers. Can receive heartbeat triggers via `poll_pending_work`.
```

2. Mark the **OpenClaw Unlock — Block 0/1/2/3** sections as `(ARCHIVED — removed in Phase 9 simplification)`. Don't delete them (they document design decisions), but prepend a note that the code has been removed.

3. Add a new section **Phase 9 — Agent Architecture Simplification** documenting:
   - What was removed and why
   - The new 2-agent model
   - Migration notes (0059)

4. In **Known Limitations**, remove the "No live OpenClaw gateway in dev" bullet.

5. In **What NOT To Do**, add: "Don't reintroduce agent kind/type enums — all employees are BYOA. If managed deployments are needed in the future, build it as a separate service, not as a column on `agent_employees`."

---

## Verification Checklist

After all phases are complete:

- [ ] `grep -r "openclaw" apps/ packages/` returns zero hits in source files (only in `docs/deprecated/` and `CLAUDE.md` archive notes)
- [ ] `grep -r "kind.*native" apps/api/src/` returns zero hits (except `event_source` enum which is unrelated)
- [ ] `grep -r "gateway_token\|connection_url\|connection_status\|provider_instance" apps/ packages/` returns zero hits in source files
- [ ] `grep -r "gateway-ping\|gatewayPing\|GatewayHealth" apps/` returns zero hits
- [ ] `grep -r "claude_sdk\|custom_mcp" apps/ packages/` returns zero hits in source files
- [ ] All test suites pass
- [ ] Agent creation wizard creates a BYOA employee and returns an API key
- [ ] Defty @mention in chat still works (platform agent path untouched)
- [ ] Heartbeat cron fires without errors (no gateway dispatch attempted)
- [ ] Approval inbox still shows pending actions
- [ ] MCP tool auth (`/api/mcp/v1`) works with BYOA agent API key

---

## What This Does NOT Change

- Defty's tool set, system prompt, or execution pipeline — untouched
- The approval tier matrix (auto/quick/full × conservative/standard/autonomous) — untouched
- The skills table and ClawHub allowlist — untouched (but skills only apply to Defty now since BYOA agents bring their own tools)
- The `agent_conversations`, `agent_messages`, `agent_actions` tables — untouched
- The MCP tool definitions in `apps/api/src/lib/mcp-tools/` — untouched
- The cooperative log system (`record_*` tools) — untouched
- Heartbeat guard gates (budget, circuit breaker, idempotency, loop detector) — untouched, just simplified routing
