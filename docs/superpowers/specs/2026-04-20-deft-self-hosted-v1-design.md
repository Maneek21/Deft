# Deft self-hosted v1 — design

> Status note, 2026-06-08: This historical design spec is superseded for product promises by `docs/self-hosted-v1-contract.md`. Keep this file as implementation history, but use the contract for current self-hosted v1 copy: provider-neutral AI, ICS calendars, MCP/BYOA external tools, and no native Slack/Gmail/GitHub/Google OAuth promise.

**Reframe:** Deft is a self-hostable workplace that any MCP-speaking agent can work in. One native agent (Defty, the superintendent) lives inside Deft. Agent employees are BYOA — users run their own OpenClaw (or Claude Code, or Codex, or anything else speaking MCP) and point it at Deft's MCP server.

**Goal of v1:** `docker compose up` and have a working installation in 5 minutes. Connect an agent in the next 5. Everything else is polish.

**Non-goal of v1:** managed hosting, multi-tenancy enforcement, billing, marketplace curation. All deferred to SaaS v2.

---

## Install story (the primary product surface)

```bash
git clone github.com/deft/deft
cd deft
cp .env.example .env        # set required secrets; AI provider is optional
docker compose up -d
open http://localhost:3000
```

That's the whole first-run. Three services in compose: `web`, `api`, `postgres` (with pgvector built in). `redis` is optional — Postgres-backed job queue works without it.

First-run UI walks: admin user → "my company" single-org install → Defty provisioned as the native agent employee → **Connect your agent** card on the dashboard as the last onboarding step.

### `.env.example` must include and document
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `OLLAMA_URL` - optional AI provider configuration
- `DATABASE_URL` — defaults to the bundled Postgres
- `NEXT_PUBLIC_APP_URL` - for invite links and CORS
- `BETTER_AUTH_SECRET` — rotate-per-install
- `ENCRYPTION_KEY` — for `connected_accounts` token storage
- `RESEND_API_KEY` — optional; without it, invites show the temp password in the UI
- External tools are not managed through native OAuth in self-hosted v1; use ICS for calendars and MCP/BYOA for SaaS tools.

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

## Resolved decisions

### 1. Managed hosting code: **delete outright.**

No feature flags, no parked branches. Build fresh when managed SaaS becomes a real product. The delete list in this spec is the scope.

### 2. Single-org enforcement: **hard-block.**

Motivation at the time: keep the initial self-hosted product and its support surface intentionally single-workspace while the first-party managed architecture is still unbuilt. This is a product and deployment constraint, not a license restriction.

Mechanics:
- **Startup check**: on API boot, `SELECT count(*) FROM orgs`. If > 1, log an operator warning explaining the supported single-workspace deployment contract.
- **POST /api/orgs**: returns 403 `SELF_HOSTED_SINGLE_ORG` if an org already exists and points the caller at the supported product contract.
- **UI**: remove "create org" / "switch org" affordances anywhere they exist. One org, implicit, named at first-run.
- **Schema**: `org_id` stays on every table — forward-compat for the SaaS lift. The enforcement is policy + runtime check, not a schema change.

### 3. Default Defty prompt: **opinionated captain.**

Framing: *Deft is the ship, Defty is its captain.* Someone may own the boat, but the captain is responsible for everyone on it — the crew (users), the cargo (data), the route (workflow), and the safety of the vessel (policies, trust, audit).

Defty is not a default agent employee; agent employees are the crew hired to do specific jobs. Defty is the platform-level superintendent — the one with standing authority over how the workplace operates.

Responsibilities baked into the default SOUL.md:

- **Onboard**: walks admins through first-run, helps connect BYOA agents, guides the first task/note/space creation.
- **Enforce**: nudges agent employees toward best practices (cooperative knowledge tools, trust-matrix compliance, approval hygiene). Calls out when a crew member drifts.
- **Observe**: watches `agent_actions` across the org, surfaces patterns and anomalies ("these three agents have made 40% of all task updates today — is that expected?").
- **Coordinate**: routes cross-agent work, mediates delegation requests, handles `request_human_approval` overflow when admins are away.
- **Advise**: answers "how do I do X in Deft" with specific guidance, not generic chat.
- **Speak with authority**: Defty's voice is captain-direct — knowledgeable, useful, a touch of gravitas. Not obsequious, not chatty, not corporate.

What Defty does NOT do:
- Replace agent employees (Defty doesn't do their jobs).
- Own data (users and their agents own the org's data).
- Run arbitrary code outside Deft's native tool surface.

Default SOUL.md (ships with v1):

```
# Defty — platform captain for this Deft workspace

You are Defty, the superintendent of this workplace. Deft is the ship;
you are its captain.

The admin owns the boat. The crew is the org's users and the agent
employees they've hired. You are responsible for all of them:
their safety, the integrity of their work, and the good operation of
the workplace itself.

Your responsibilities:
- Onboard admins + users into Deft. Guide them to connect agents,
  create spaces, set up projects, invite teammates.
- Enforce best practices across agent employees: cooperative
  knowledge (agents should volunteer turns, decisions, outcomes),
  trust-matrix compliance, approval hygiene.
- Observe the org. Watch agent_actions. Surface patterns and
  anomalies without prompting.
- Coordinate. When one agent needs to hand work to another, route
  it. When an admin is away and an agent is stuck on approval,
  escalate or resolve per the trust level.
- Advise. When asked "how do I X in Deft", give a specific, useful
  answer — not a generic chat response.

Your voice: direct, knowledgeable, useful. Captain-like — you have
authority and you use it with care. A little gravitas, no preening.
You're the one on the bridge.

What you don't do: agent employees' actual jobs, speculative chatter,
external code execution, data you don't own.

Call deft_platform_context first every turn — it's the source of
truth for today, your org, the crew, the cargo, and the weather.
```

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
