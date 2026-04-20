# Deft self-hosted v1 — design

**Reframe:** Deft is a self-hostable workplace that any MCP-speaking agent can work in. One native agent (Defty, the superintendent) lives inside Deft. Agent employees are BYOA — users run their own OpenClaw (or Claude Code, or Codex, or anything else speaking MCP) and point it at Deft's MCP server.

**Goal of v1:** `docker compose up` and have a working installation in 5 minutes. Connect an agent in the next 5. Everything else is polish.

**Non-goal of v1:** managed hosting, multi-tenancy enforcement, billing, marketplace curation. All deferred to SaaS v2.

---

## Install story (the primary product surface)

```bash
git clone github.com/deft/deft
cd deft
cp .env.example .env        # paste ANTHROPIC_API_KEY + optional OAuth + SMTP
docker compose up -d
open http://localhost:3000
```

That's the whole first-run. Three services in compose: `web`, `api`, `postgres` (with pgvector built in). `redis` is optional — Postgres-backed job queue works without it.

First-run UI walks: admin user → "my company" single-org install → Defty provisioned as the native agent employee → **Connect your agent** card on the dashboard as the last onboarding step.

### `.env.example` must include and document
- `ANTHROPIC_API_KEY` — for Defty + native classifier
- `DATABASE_URL` — defaults to the bundled Postgres
- `NEXT_PUBLIC_APP_URL` — for OAuth redirect + CORS
- `BETTER_AUTH_SECRET` — rotate-per-install
- `ENCRYPTION_KEY` — for `connected_accounts` token storage
- `RESEND_API_KEY` — optional; without it, invites show the temp password in the UI
- Optional OAuth: `GOOGLE_CLIENT_ID`/SECRET, `GITHUB_APP_*`, Slack, etc. Each optional — missing = feature disabled gracefully.

### Upgrades
```
git pull
docker compose pull
docker compose up -d
pnpm --filter @deft/db migrate
```

The `_journal.json` drift flagged in CLAUDE.md gets resolved as part of v1 so upgrades don't require manual SQL.

---

## The agent integration model

**One sentence:** any MCP client can become an agent employee. Deft is the MCP server; the agent is the client.

### Agent onboarding (the "Connect your agent" flow)

Post-wizard, the user lands on a three-tab "connect" screen:

1. **OpenClaw** — one-line copy command:
   ```
   openclaw mcp set deft '{"url":"http://localhost:3001/api/mcp/v1","headers":{"Authorization":"Bearer <token>"}}'
   ```
2. **Claude Code** — JSON block for `~/.mcp.json` or `.mcp.json` in a project:
   ```json
   {
     "mcpServers": {
       "deft": {
         "url": "http://localhost:3001/api/mcp/v1",
         "headers": { "Authorization": "Bearer <token>" }
       }
     }
   }
   ```
3. **Other MCP client** — raw URL, raw token, link to spec.

Each tab has a **"Verify connection"** button that hits `/api/mcp/v1/initialize` with the token. Green check = the agent can now call Deft. Failure = copy-paste the error, link to troubleshooting.

### What Deft exposes over MCP (`/api/mcp/v1`)

- **Read** — `platform_context`, `memory_recall`, `memory_list`, `task_query`, `thread_fetch`, `member_list`, `space_memory_get`, `events_query`, `task_detail`, `messages_search`, `project_progress`, `team_workload`.
- **Write** — `memory_write`, `memory_update`, `task_create`, `task_update`, `message_post`, `space_memory_set`, `delegation_self_report`, plus the Block 2 additions (notes, canvas, decisions, workflows).
- **Cooperative (aspirational)** — `record_conversation_turn`, `record_decision`, `record_outcome`, `record_reasoning_step`, `record_action_attempt`. Agents that call these help the org knowledge base grow; agents that don't, don't. No gate forces cooperation.
- **Control** — `request_human_approval(action, params, rationale) → {approved, reason?}`, `poll_pending_work(since)`, `ping_alive()`.

Trust matrix, approval tiers, and audit run on every write call — same as today. Nothing below the MCP surface changes.

### What Deft does NOT do
- Does not own any agent runtime.
- Does not push skills, configs, or code to an agent.
- Does not subscribe to gateway events.
- Does not provision containers.
- Does not send data to any LLM on the user's behalf (Defty excepted — that's the one Deft-side agent, with the admin's Anthropic key).

Everything in the "does not" list is deletion target below.

### Cooperative knowledge — aspirational

The five `record_*` tools ship as standard MCP tools.

- Decision: **aspirational, not required**. Calling `memory_recall` does not require prior `record_conversation_turn` volunteering. An agent that writes nothing back gets usable Deft recall. An agent that volunteers gets a richer shared wiki over time.
- Default `SOUL.md` templates shipped with Deft encourage the pattern.
- `deft-mcp-client` skill docs call it out as best practice.
- Network effect (org-wide wiki growing from every agent's cooperation) is the carrot. No stick.

### Presence + triggers (inverted)

- **Presence:** `ping_alive()` MCP call every N minutes. `agent_employees.last_ping_at` column. Dashboard shows online/offline.
- **Triggers:** Deft cron or event → fires the agent's **webhook** (Block 3.3 is already built for this). Agent's runtime handles the POST. Alternative path: agents that prefer polling use `poll_pending_work(since)`.

---

## What survives unchanged

- Block 0 — trust matrix, durable reminders, semantic wiki search, unified wizard, standup fallback retirement, SKILL.md sanitizer (stays useful for config snippets docs), ClawHub allowlist table (becomes an MCP tools directory source), approval badge, edit-agent PATCH. All of it.
- Block 2 — note tools, thread reply, canvas, blocked-message proposal, unblock_dependents, decision linking, member.joined onboarding trigger, dashboard inline approve/reject, heartbeat checklist builder. All of it.
- Block 3 — clone + save-as-template, developer credentials page (rebranded **Connect Agent**), webhook-callable agents, `deft-mcp-client` skill, trace export. All of it.
- Defty — the native superintendent. Unchanged.
- MCP server `/api/mcp/v1` — unchanged plus the new tools.
- Agent employees table, trust levels, approval tiers, audit, spend-cap schema (reinterpreted as data-access budget in v2).

---

## What gets deleted

Directly from the BYOA-primary + self-hosted-first shape. One branch, clear scope:

### Delete
- `apps/api/src/lib/openclaw-gateway.ts` — Gateway RPC client (wrong protocol, wrong direction).
- `apps/api/src/lib/gateway-approval-subscriber.ts` — inverted into `request_human_approval` tool.
- `apps/api/src/lib/gateway-trace-forwarder.ts` — inverted into `record_reasoning_step` tool.
- `apps/api/src/lib/skill-install.ts`, `skill-secret-resolver.ts`, `skill-reconciliation.ts`, `skill-secrets.ts` — Deft doesn't push to agents.
- `apps/api/src/workers/handlers/deploy-provision.ts` — never reachable in self-hosted + BYOA.
- `apps/api/src/lib/deployment/` entire dir — provider abstraction, Railway/Fly/DO shims.
- `apps/api/src/routes/clawhub.ts` — replaced with a docs page.
- `apps/api/src/routes/agent-webhooks.ts` — **keep** (the webhook pattern survives and is now the trigger path).
- Block 1.7 `request_skill_install` native tool.
- `apps/web/src/components/reasoning-trace.tsx` subscriber side + hook — keep the display component, drop the socket listener; drive it from the new `record_reasoning_step` entries on the message.
- `apps/web/src/app/(app)/library/page.tsx` ClawHub tab — replaced with an "MCP tools" docs link.

### Tables / columns
- `skill_secrets` table — drop.
- `clawhub_allowlist` table — keep as a read-only directory seed; stop writing from the cron.
- `agent_employees.gateway_token_encrypted` — drop (no Deft→OpenClaw calls).
- `agent_employees.provider_instance_id`, `deployment_provider`, `last_gateway_ping_at`, `gateway_ping_fail_count`, `capability_packs` — drop (provisioning-era columns).
- `agent_employees.mcp_token_hash` — **keep** (Path C Phase 2 needs it; it's the BYOA auth path).
- `provider_instances` table — drop.
- `org_spend_caps` table + worker — drop (user pays their own LLM bill).
- Skills table — **keep**; interpretation shifts from "installable bundle" to "capability subset scope."

### Workers
- Gateway ping worker — drop.
- Gateway approval subscriber bootstrap in `workers/index.ts` — drop.
- Heartbeat `heartbeat-openclaw` cron — drop (inverts to webhook). `heartbeat-native` stays (Defty still heartbeats).
- Skill update check cron — drop.
- ClawHub allowlist refresh cron — drop (replaced with a docs page).

Rough codebase delta: -5–8k LoC, probably -8 migrations worth of dead schema (we don't delete the migrations, but the tables no longer have writers).

---

## Net-new work

Beyond deletions:

1. **Five cooperative MCP tools** — `record_conversation_turn`, `record_decision`, `record_outcome`, `record_reasoning_step`, `record_action_attempt`. Each is a thin handler → existing classifier/wiki-extract pipelines. Each aspirational.
2. **Three control MCP tools** — `request_human_approval`, `poll_pending_work`, `ping_alive`.
3. **Connect Agent three-tab onboarding UI** — post-wizard success screen. Copy-paste snippets per runtime. "Verify connection" button.
4. **Drizzle `_journal.json` rebuild** — one-time fix so `pnpm db:migrate` works for self-hosters. Documented in CLAUDE.md since 2025.
5. **Docker-compose audit + `.env.example` polish** — cold-install test on a clean VM.
6. **Self-hosted install docs** — README + `docs/install/` tree. Cover: prereqs, `.env`, compose up, first user, first agent, upgrading, backup, restore, troubleshooting.
7. **MCP tools directory page** — replaces ClawHub browse in the Library. Markdown-driven catalog of what Deft exposes over MCP, with copy-paste config snippets for each common runtime.
8. **`deft-mcp-client` docs page** — full integration guide (not just a bundled skill row in the catalog).

---

## Agent-experience → knowledge-base flow (aspirational)

When an agent employee is well-behaved:

| Agent action | Deft response |
|---|---|
| `record_conversation_turn(role, content)` | Row in `agent_conversation_turns`. Runs the message classifier. Extracted facts → wiki. |
| `record_decision(text, context)` | Row in `decisions`. Same wiki-extraction path as today's decision surface. |
| `record_outcome(task_id, result, learnings)` | Appended to task activity. Learnings promoted to wiki (type=resource). |
| `record_reasoning_step(thought, tool_call)` | Appended to the message's `tool_calls` JSONB. `<ReasoningTrace/>` renders it. |
| `record_action_attempt(outcome, error)` | Audit log entry with `source='agent-volunteered'`. |
| `request_human_approval(...)` | Approval card in Deft inbox. Blocks until resolved. |
| `memory_write(title, body, type)` | Wiki page scoped to that agent (agent-owned memory). |
| `task_create / message_post / ...` | Same as today, gated by trust matrix. |

All entries are tagged `source: agent-volunteered` vs `source: observed` (the latter only applies to Defty and direct-chat classification). Two-class evidence base. Queries can filter.

Network effect: five agents in an org all writing decisions + outcomes → shared wiki grows faster than any one agent could fill. Every agent's `memory_recall` benefits.

---

## What explicitly isn't in v1

Preserve the context for future SaaS v2:

- Multi-tenancy enforcement (schema supports it; checks minimal)
- Billing / usage metering
- Managed agent hosting (brings back a deploy-provision concept, built on top of this base — not integrated)
- Per-org LLM spend caps
- Cross-org anything (team directory, shared skills, federation)
- Deft Verified marketplace curation
- `openclaw` ghcr image auto-pull / version bump checker

None of these have to exist to ship self-hosted v1. All get a one-paragraph note in `docs/superpowers/saas-v2-deferred.md` with enough context that future-me understands why they're parked, not gone.

---

## Execution plan

Five PRs, each independently reviewable + mergeable.

1. **Delete sweep** — remove the full delete list above. Keep tests green. Document removed tables in the migration README. ~1 day.
2. **Drizzle journal rebuild** — one-time, separate commit. ~2 hours.
3. **Cooperative + control MCP tools** — eight new tools with schemas, handlers, tests. ~1 day.
4. **Connect Agent UX** — three-tab onboarding screen + verify button. ~0.5 days.
5. **Install polish + self-host docs** — docker-compose audit, `.env.example`, README walkthrough, cold-install test on a clean VM. ~1 day.

Total: ~4.5 engineering days. ~1 week calendar including review + any regressions that surface.

---

## Open questions

1. **Managed hosting code: park behind a flag, or delete outright?**
   - Parked = temptation to un-flag later bites.
   - Delete = clean, requires rebuild when real.
   - Recommendation: delete. Build fresh when managed SaaS becomes a real product.

2. **Single-org enforcement: hard or soft?**
   - Hard: API and UI refuse to create a second org in self-hosted mode.
   - Soft: schema allows multi-org, UI only shows the first one, future SaaS migration is a `select`.
   - Recommendation: soft. Schema is already multi-tenant; don't fight it. Hide the UI.

3. **Default Defty prompt: generic or opinionated?**
   - Generic: "I help you manage your workspace."
   - Opinionated: "I'm your workplace concierge. I help you set up agent employees, debug their behavior, and surface what's happening across your team."
   - Recommendation: opinionated. Positions Defty correctly (concierge, not default employee).

---

## Success criteria for v1

Self-hosted Deft is "done" when:
- [x] A fresh git clone → `docker compose up` → working admin login in ≤ 5 minutes on a clean VM.
- [x] The three-tab "Connect your agent" screen produces a working MCP connection from OpenClaw and Claude Code without additional config.
- [x] Aspirational `record_*` tools are callable and produce wiki entries.
- [x] Trust matrix blocks + approves writes correctly for a BYOA agent.
- [x] The deleted surface area is actually gone (no dead code, no dead routes, no dead tables with live writers).
- [x] README walks a new user from zero to agent-connected without leaving the docs.

Not on the list: managed anything, scale, multi-org, billing. On purpose.
