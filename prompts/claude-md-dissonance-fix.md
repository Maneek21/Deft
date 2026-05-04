# CLAUDE.md Dissonance Fix — Post-Phase-9 Cleanup

## Context

Phase 9 (agent architecture simplification) landed on `feat/phase9-simplify-agents` and rewrote large parts of CLAUDE.md — marking OpenClaw Blocks as archived, adding the 2-agent model, documenting the Phase 9 removal table. That branch should be merged first before running this prompt.

This prompt fixes the remaining dissonance items that Phase 9 did NOT address. These are factual errors and stale claims in CLAUDE.md that have nothing to do with the OpenClaw simplification.

**Before running this prompt:** merge `feat/phase9-simplify-agents` into your working branch so the CLAUDE.md base is the Phase-9-updated version, not the old one.

---

## Fix 1: Phase 8 status — "NOT shipped" is wrong

Phase 8 is partially shipped. Tasks 8.1–8.6 are production code in `agent-employee-heartbeat.ts`:

- Task 8.1: Extended heartbeat handler with kind-aware dispatch (now simplified to BYOA-only post-Phase-9)
- Task 8.4: Per-tick logging to `agent_heartbeat_turns` table + `agent:heartbeat:turn` socket broadcast
- Task 8.5: Cost guardrails — `daily_budget_cents` / `daily_cost_cents` on `agent_employees`, circuit breaker via `unhealthy` flag with `unhealthy_reason`
- Task 8.6: Loop detection — 3-consecutive-error circuit breaker + prompt_sha idempotency deduplication

**What's still missing from Phase 8:** the skill-defined trigger dispatcher (arbitrary triggers from skill manifests beyond the hardcoded set of `cron:standup`, `member.joined`, `webhook`, `task.status_changed`).

**Action:** Find the Phase 8 section in CLAUDE.md. If it still says "Phase 8 has NOT shipped yet" or calls the heartbeat worker "a scaffold," rewrite it to:

```markdown
## Phase 8 — Heartbeat Autonomy (partially shipped)

Tasks 8.1–8.6 shipped on the heartbeat worker:

- **Heartbeat lifecycle** (Task 8.1) — BullMQ cron dispatches due employees based on `heartbeat_interval_min`. Post-Phase-9, all employees are BYOA; heartbeat ticks queue pending work for MCP polling.
- **Per-tick logging** (Task 8.4) — every tick writes to `agent_heartbeat_turns` (fired_at, prompt_sha, action_count, tokens_in/out, cost_cents, outcome, summary) and broadcasts `agent:heartbeat:turn` via Socket.io.
- **Cost guardrails** (Task 8.5) — `daily_budget_cents` per employee (default $100/day), reset at UTC midnight. Circuit breaker: `unhealthy` flag tripped after 3 consecutive errors, blocks all autonomous dispatch until manually cleared via `PATCH /api/agent-employees/:id { mark_healthy: true }`.
- **Loop detection** (Task 8.6) — prompt_sha idempotency skips re-dispatch when nothing changed since last no_op tick. Consecutive identical action detector trips the circuit breaker.

**Not yet shipped:** skill-defined trigger dispatcher (arbitrary triggers from skill manifests, not just the hardcoded set).
```

---

## Fix 2: Bundled skills count — not "six," it's dynamic

CLAUDE.md says "Six day-one bundled skills ship: one per available capability pack."

The actual code in `bundled-skills.ts` dynamically generates bundled skills from `getAvailableCapabilityPacks()` and adds `deft-mcp-client` as an extra. The count is not fixed at 6.

**Action:** In the Agent Architecture section, find the "Six day-one bundled skills" sentence and replace with:

```
Bundled skills are generated dynamically — one per available capability pack (Deft Workspace carries the 9 task tools) plus `deft-mcp-client` (Block 3 on-ramp for BYOA agents to talk back into the workspace via MCP).
```

---

## Fix 3: Migration ceiling — update to current

CLAUDE.md Known Limitations says "Migrations 0025-0052 were applied manually."

The actual ceiling is 0059 (Phase 9's `0059_remove_openclaw_columns.sql`). Migrations 0053–0058 were the self-hosted-v1 cleanup, and 0059 is the Phase 9 column drops.

**Action:** Find the migration journal note and update:

```
Migrations 0025-0059 were applied manually and are not tracked in the journal.
```

Also verify — if Phase 9's CLAUDE.md rewrite already fixed this, skip it.

---

## Fix 4: Add `packages/mcp` to architecture diagram

The architecture tree in CLAUDE.md only lists `packages/db` and `packages/shared`. But `packages/mcp` exists, has a valid `package.json` (`@deft/mcp`), depends on the MCP SDK, and is listed in `pnpm-workspace.yaml`.

**Action:** Add it to the directory tree:

```
├── packages/
│   ├── db/           # Drizzle ORM schema + client + migrations
│   ├── mcp/          # MCP server SDK + tool definitions for BYOA agents
│   └── shared/       # Shared types, Zod schemas, constants
```

---

## Fix 5: Auth wording — "better-auth" doesn't exist in the codebase

CLAUDE.md says "Auth: better-auth (JWT + refresh tokens + Google OAuth)."

`grep -r "better-auth"` across the entire repo returns zero matches. The actual auth implementation uses `jsonwebtoken` (v9.0.3) + `bcryptjs` (v3.0.3) directly — a custom JWT + bcrypt implementation with Google OAuth support.

The "What NOT To Do" section also says "Don't build a custom auth system. Use better-auth" — but a custom system is exactly what exists.

**Action:**

In the Stack section, change:
```
- Auth: better-auth (JWT + refresh tokens + Google OAuth)
```
to:
```
- Auth: Custom JWT + bcrypt (jsonwebtoken + bcryptjs, Google OAuth)
```

In "What NOT To Do," remove or rewrite the better-auth line. Since the custom auth system already exists and works, the instruction is moot. Replace with:
```
- Don't replace the existing auth system without a migration plan. It's custom JWT + bcrypt, not a library — changes affect every authenticated route.
```

---

## Fix 6: Verify reasoning trace components

The dissonance audit flagged `ReasoningTrace` component and `useReasoningTrace` hook as dead UI (they subscribe to OpenClaw gateway session events that no longer exist post-Phase-9).

**Action:** Check if these files still exist after Phase 9 merge:
- `apps/web/src/components/reasoning-trace.tsx`
- `apps/web/src/hooks/use-reasoning-trace.ts`

If they exist and reference gateway subscriptions that were removed, either:
- (a) Delete them (they render nothing without a gateway), or
- (b) Strip them to stubs with a `// TODO: re-implement for BYOA trace export` comment

If Phase 9 already deleted them, no action needed.

---

## Verification

After all fixes, run:

```bash
# Phase 8 should not say "NOT shipped" or "scaffold"
grep -n "NOT shipped\|scaffold" CLAUDE.md

# Should say "custom JWT" not "better-auth"  
grep -n "better-auth" CLAUDE.md

# Migration ceiling should be 0059
grep -n "0025-005" CLAUDE.md

# packages/mcp should appear in the tree
grep -n "packages/mcp\|mcp/" CLAUDE.md | head -5

# Skills count should not say "Six"
grep -in "six.*bundled\|6.*bundled" CLAUDE.md
```

All five greps should confirm the fixes landed. The first two should return zero matches. The middle two should return the updated lines. The last should return zero matches.
