# How Agents Work in Deft

> Status note, 2026-06-09: This document describes the agent vision. For current self-hosted v1 pilot promises, external tools should be framed as BYOA/MCP-provided capabilities, not native Slack/Gmail/GitHub/Google OAuth integrations owned by Deft.

## The Core Idea

Deft agents are AI teammates, not chatbots. They have user accounts, appear in member lists, get assigned tasks, post in channels, and learn from every interaction. They share one brain (the wiki), operate under org-defined trust levels, and proactively monitor their domain through heartbeats.

---

## Two Types of Agents

### Defty — The Superintendent

Free with every org. Defty is the platform itself talking to you. It manages agent employees, configures MCP connections, reports on agent economics, and handles general workspace queries. Defty has access to all tools including superintendent tools that employees never see. It uses the org's credit pool.

### Agent Employees — The Workers

Paid seats ($25/mo). Each is a specialist with a role, system prompt, tool scopes, and trust level. They appear as real teammates — in the sidebar, in @mention suggestions, in the assignee dropdown. They can be a Project Manager, Engineering Lead, Executive Assistant, or any custom role.

---

## The Agent Loop

Every agent interaction follows the same cycle:

```
Context Assembly → Reasoning → Tool Use → Verification → Response → Memory
```

**Context Assembly:** Load the employee's system prompt, their tagged wiki pages (personal knowledge), top org wiki pages matching the query (shared knowledge), and conversation history.

**Reasoning:** The LLM plans what to do — search for data, check external tools, create or update resources.

**Tool Use:** Execute tools in a loop (up to 25 iterations for background tasks, 50 for streaming chat). Tools include native workspace tools (search, create, update), MCP tools from connected servers, and wiki tools.

**Verification:** After generating a response, a fast critic model reviews: Does this answer the question? Are citations real? Anything missing? Corrections applied before the user sees the response.

**Response:** Deliver the result — in a DM, a channel thread, a task comment, or a plan step.

**Memory:** Write key findings back to the wiki. Update preference pages if the user gives feedback. The agent gets smarter with every interaction.

---

## The Wiki Brain

One shared knowledge graph, multiple scoped views.

**Auto-population:** Every chat message is classified. Facts and decisions are extracted by a classifier (Haiku), then an LLM decides whether to create a new wiki page or update an existing one. Related pages are cascade-updated for consistency.

**Self-maintenance:** A daily linter detects orphaned pages, decays confidence on stale pages, auto-deletes pages below 0.3 confidence, and uses an LLM to detect contradictions between linked pages.

**Seven knowledge types:** concept, entity, decision, resource, procedure, preference, fact.

**Agent context injection:** Before every response, the agent's system prompt is augmented with:
1. Employee's own tagged wiki pages (personal knowledge, up to 2)
2. Top org-wide wiki pages matching the query (shared knowledge, up to 3)

**Procedural memory:** When an agent gets feedback ("include PR links in standups"), it writes a `preference` page tagged to itself. Next time, that preference loads automatically. Agents learn without fine-tuning.

**Skill templates:** `procedure` type wiki pages serve as reusable workflows. "How to Generate a Standup" is a procedure page that any agent can find and follow. Procedures evolve through use — agents can update them with better approaches.

---

## The Heartbeat

What makes agents proactive instead of reactive.

Each employee has a configurable heartbeat — a plain-English checklist of things to monitor. Every N minutes (default 30), the agent wakes up:

1. Read the heartbeat checklist
2. Evaluate: does anything need attention right now?
3. If yes → take action (post alert, create task, DM someone)
4. If no → `HEARTBEAT_OK` (silence, minimal token cost)

**Examples:**
- PM Agent every 30 min: "Check for tasks overdue >24h. Check for blockers stalled >48h. If morning, generate standup."
- Engineering Lead every hour: "Check for PRs with no review >24h. Check if any merged PRs have no linked task update."
- EA every 30 min: "Check for meetings in the next 30 minutes. If found, generate prep brief and DM the attendee."

Token-efficient: heartbeat sessions use minimal context (just the checklist + relevant wiki pages, not full conversation history). 60-80% cheaper than continuous monitoring.

---

## MCP — Universal Tool Access

MCP (Model Context Protocol) gives agents access to external tools without custom integrations.

### How It Works

1. Admin connects an MCP server in Settings > Integrations (URL + auth)
2. Deft discovers available tools from the server (cached 5 minutes)
3. Tools merge into the agent's native tool list — the agent sees one flat list, doesn't know which tools are native vs MCP
4. MCP tool calls flow through the same approval pipeline (trust levels, daily limits)

### Three Transports

- **SSE / Streamable HTTP** — For SaaS (connect to remote MCP servers)
- **Stdio** — For self-hosted (spawn local processes)

### Connection Pooling

- Connect on first tool call, keep alive 5 minutes, then disconnect
- Shared within an org (two employees using the same MCP server share one connection)
- Max 3 concurrent connections per org
- Health tracking: 3 failures in 5 min → 10 min backoff

### What MCP Enables

| MCP Server | What Agents Can Do |
|-----------|-------------------|
| Zapier | 7,000+ app actions — email, CRM, finance, marketing |
| Playwright / Browserbase | Browse the web, research, fill forms, verify information |
| GitHub | Read PRs, create issues, search code, review diffs |
| Google Drive | Read/create documents, sheets, slides |
| Sentry | Monitor errors, investigate incidents |
| n8n | Custom workflow automation |

### Per-Tool Trust Tiers

Each MCP tool gets an approval tier:
- **auto** — executes immediately (read-only tools)
- **quick** — needs approval in standard mode (moderate-risk creates)
- **full** — always needs approval (external writes, messages)

Admins can override tiers per tool in Settings.

---

## Deft MCP Server — The Other Direction

Deft also exposes its own tools via MCP, so external agents can use Deft's data.

**How:** Admin creates an API key scoped to an agent employee. The external agent (NemoClaw, OpenClaw, Claude Desktop) connects to `https://your-deft.com/mcp` with the API key. It inherits the linked employee's tool scopes, trust level, and daily action budget.

**14 exposed tools:** 8 read (search tasks, messages, knowledge, wiki, workload, progress) + 6 write (create task, update status, assign, post message, add knowledge, wiki write).

**Not exposed:** Manager-only tools (burnout, team health), memory tools, people analytics (privacy).

**Why it matters:** Enterprises running their own agent infrastructure can connect to Deft for workspace data without switching platforms. Deft becomes a data layer in the broader agent ecosystem.

---

## Trust & Safety

### Three Trust Levels (per employee)

| Level | Behavior |
|-------|----------|
| Conservative | Every write action needs explicit approval |
| Standard | Low-risk actions auto-execute (status updates, assignments). Creates and posts need approval |
| Autonomous | Most actions auto-execute. Only external writes (messages, calendar events) need approval |

### Daily Action Limits

Each employee has a `max_daily_actions` budget (default 50). Every tool call counts as 1 action. Atomic SQL prevents race conditions. When exhausted, the agent tells the user and stops.

### Safety Guards

- Agent-to-agent mentions blocked (no circular loops)
- MCP outputs scanned for prompt injection before feeding to agent
- Shared-space posts validated before publishing
- All actions logged with full before/after state for undo
- Soft delete on employee removal — pending actions expired, plans aborted, history preserved

---

## Self-Hosted vs SaaS

| | SaaS | Self-Hosted |
|---|---|---|
| Agent builder wizard | Yes | No (BYOA only) |
| MCP client | All transports | All transports (stdio native) |
| Deft MCP server | Yes | Yes |
| Trust levels | Yes | Yes |
| Heartbeat | Yes | Yes |
| Wiki brain | Yes | Yes |
| Pre-built templates | Yes | No |

Self-hosted users bring their own agents via the MCP server. They get full workspace data access but don't get the wizard or templates. This is intentional — self-hosted is for teams that already have agent infrastructure.
