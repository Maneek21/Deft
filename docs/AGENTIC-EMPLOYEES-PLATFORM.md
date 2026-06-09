# Agentic Employees Platform — Master Plan

> Status note, 2026-06-09: This is a historical master plan, not the current self-hosted v1 product contract. Use `docs/self-hosted-v1-contract.md` for buyer-facing promises: native workspace, ICS calendar subscriptions, BYOA/MCP employees, provider-neutral AI, and no native Slack/Gmail/GitHub/Google OAuth promise.

## Vision

Transform Deft from an AI-native workspace into an **agentic employee platform** — where AI teammates share the same spaces, tasks, and communication channels as humans. Not personal assistants that help one user at a time, but persistent, role-based agents that operate as first-class team members.

**The pitch:** "Give your team AI teammates that actually understand your work."

---

## Part 1: What We Have Today

### Agent Engine (Production-Ready)

| Component | File | Status |
|---|---|---|
| Conversational agent | `apps/api/src/routes/agent.ts` (723 lines) | Shipping |
| 32 tools (26 read, 6 write) | `apps/api/src/lib/agent-tools.ts` (533 lines) | Shipping |
| Tool execution (direct SQL) | `apps/api/src/lib/agent-context.ts` (1800+ lines) | Shipping |
| Action approval workflow | `apps/api/src/lib/agent-actions.ts` (408 lines) | Shipping |
| Non-streaming agent runner | `apps/api/src/lib/agent-runner.ts` (232 lines) | Shipping |
| SSE streaming with citations | `apps/api/src/routes/agent.ts` lines 270-405 | Shipping |
| Undo capability | `apps/api/src/routes/agent.ts` lines 538-671 | Shipping |
| Message classifier | `apps/api/src/lib/classifier.ts` (96 lines) | Shipping |
| Multi-model LLM router | `apps/api/src/lib/llm.ts` (264 lines) | Shipping |
| Agent chat UI | `apps/web/src/components/agent-chat.tsx` (777 lines) | Shipping |

### People Analytics (Production-Ready, Unique Advantage)

| Component | Tables | Status |
|---|---|---|
| Team interactions graph | `peopleInteractions` | Shipping |
| Expertise tracking | `peopleExpertise` | Shipping |
| Behavioral patterns | `peoplePatterns` | Shipping |
| Relationship mapping | `peopleRelationships` | Shipping |
| Burnout detection | `burnoutAlerts` (privacy-guarded) | Shipping |
| Manager-only tools | 8 tools (health, performance, workload, 1:1 prep, dynamics, skills gap, burnout, expert finder) | Shipping |

### Infrastructure (Production-Ready)

| Component | File | Status |
|---|---|---|
| Postgres job queue | `apps/api/src/lib/queues.ts` (176 lines) | Shipping |
| Cron job scheduler | `apps/api/src/lib/job-scheduler.ts` | Shipping |
| 12+ background workers | `apps/api/src/workers/handlers/` | Shipping |
| OAuth connection framework | `apps/api/src/routes/connections.ts` | Shipping (Google, GitHub) |
| Unified events table | `events` table (source: google_calendar, ics, github, linear) | Schema ready |
| Wiki with full-text search | `wikiPages`, `wikiLinks`, `wikiCitations` | Shipping |
| Encrypted token storage | `connectedAccounts` table | Shipping |
| Audit trail | `apps/api/src/lib/audit.ts` | Shipping |

### What's Stubbed But Not Built

| Component | What exists | What's missing |
|---|---|---|
| Trust level enforcement | `orgs.trust_level` enum (conservative/standard/autonomous) | Only `conservative` is implemented. Standard and autonomous have no routing logic. |
| Approval tier routing | `agentActions.approval_tier` field (auto/quick/full) | All actions follow same flow regardless of tier. |
| Tool registry tables | `tools` and `skills` tables in schema | Not connected to agent engine. Tools are hardcoded in `agent-tools.ts`. |
| Trigger system | `triggers` table (event_type, condition, actions, schedule) | Table exists, no execution engine reads it. |
| Linear integration | `linear` in events source enum | No OAuth flow, no sync handler. |
| GitHub write | `create_github_issue` mentioned | Not implemented. |
| Org model overrides | `orgConfig.ai_models` in LLM router | Not wired to settings UI. |
| Wiki suggestion review | `wiki_suggest_update` tool | No UI for reviewing suggestions. |

### Our Structural Advantages

These are moats that Claude Cowork, OpenClaw, and NemoClaw cannot easily replicate:

1. **Direct SQL access to native data.** Our agent queries a relational database with joins and aggregations. Competitors read files or call APIs. We see everything in one query.

2. **Unified workspace context.** Chat + tasks + knowledge + wiki + calendar events in one database. Competitors stitch together files or apps. We have a single source of truth.

3. **Team-aware intelligence.** Burnout detection, skills gaps, workload balance, relationship mapping, expertise graphs. No competitor has anything close. Privacy-guarded by design.

4. **Domain-specific semantics.** Our agent understands project management: blockers, velocity, sprint goals, dependencies. Generic agents don't.

5. **Multi-tenant from day 1.** `org_id` on every table. Agents are scoped to organizations, not individuals.

---

## Part 2: The Four-Tier Evolution

### Tier 1: Background Automation — "The Agent Comes Alive"

**Goal:** The agent does things without being asked. It monitors the workspace and takes action when conditions are met.

**What to build:**

| Trigger | Action | Infrastructure |
|---|---|---|
| Task overdue | DM assignee + alert lead in space | Cron worker → agent-runner → post_message |
| Task stalled 48h | Ask for update in linked space | Cron worker → agent-runner → post_message |
| PR merged (GitHub webhook) | Move linked task to Done + post in space | Webhook handler → agent-actions → update_task_status |
| Meeting in 15min | Generate prep briefing from tasks/messages | Cron worker → agent-runner → post_message |
| 9am daily | Auto-generate standup from activity | Cron worker (exists: `standup-generate`) → connect to agent |
| New message classified as actionable | Suggest task creation | Classifier → notification → quick-approve card |
| Decision detected in chat | Auto-capture to knowledge base | Classifier → agent-actions → add_knowledge |

**What already exists:**
- Job queue with cron support (`queues.ts`)
- 7 cron jobs registered in `job-scheduler.ts` (standup, nudge, meeting-prep, people-graph, manager-pulse, burnout-detect, weekly-digest)
- Worker handlers for most of these in `apps/api/src/workers/handlers/`
- `agent-runner.ts` for non-streaming execution
- Classifier extracts `memorable_facts` and `decision` from messages

**What needs connecting:**
- Wire worker handlers to use `agent-runner.ts` for generating responses
- Route generated messages through `post_message` action (with appropriate trust level)
- Add notification feed: "Your agent posted the daily standup in #engineering"
- Build GitHub webhook receiver for PR events
- Wire classifier's `decision` extraction to `add_knowledge` action

### Tier 2: Multi-Step Plans — "The Agent Becomes Capable"

**Goal:** The agent decomposes complex requests into ordered steps, shows the plan, gets approval, then executes step by step with live progress.

**What to build:**

```
User: "Prepare for the sprint review"

Agent creates plan:
  Step 1: Gather completed tasks this sprint          [read — auto]
  Step 2: Summarize unfinished work and blockers      [read — auto]
  Step 3: Check PR status on GitHub                   [read — auto]
  Step 4: Draft summary message                       [generate — auto]
  Step 5: Post summary in #engineering                [write — needs approval]

User reviews plan → edits Step 5 to also post in #general → approves

Agent executes:
  ✓ Step 1: Found 12 completed tasks
  ✓ Step 2: 3 tasks blocked, 2 in review
  ✓ Step 3: 5 PRs merged, 2 open
  ✓ Step 4: Draft ready
  ⏸ Step 5: Awaiting approval to post...
  → User approves → ✓ Posted in #engineering and #general
```

**Architecture:**

New table: `agent_plans`
```
id, org_id, user_id, conversation_id
title, steps (jsonb — array of { description, tool, params, status, result })
status (draft | approved | executing | paused | completed | failed)
current_step (integer)
created_at, updated_at
```

**Agent changes:**
- Add `create_plan` tool — agent builds a plan instead of executing immediately
- Add plan approval UI — user can reorder, edit, remove, add steps
- Add plan execution loop — iterate steps, pause on write actions or failures
- Add plan status streaming — SSE events for step progress

**What already exists:**
- The approval UX pattern (pending actions with approve/reject)
- SSE streaming infrastructure
- Tool registry with clear read/write separation

### Tier 3: External Integrations — "The Agent Reaches Out"

**Goal:** The agent can read from and write to external tools, not just native data.

**Two integration paths:**

#### Path A: Native MCP Client

Add an MCP client to the agent engine. This is the universal adapter.

```
Agent Engine
  └── MCP Client
        ├── Zapier MCP → 8,000 apps, 30,000 actions (instant breadth)
        ├── Official MCP servers (GitHub, Google Workspace, etc.)
        └── Custom/org-specific MCP servers
```

**Why MCP:** It's the standard. 10,000+ public servers, 97M monthly SDK downloads, adopted by every major AI company. Anthropic created it, OpenAI adopted it, Microsoft built it into Copilot Studio. One protocol, universal tool access.

**Why Zapier MCP specifically:** One connection gives you Ahrefs, Mailchimp, QuickBooks, Keka, HubSpot, Xero, Gusto, Buffer, Stripe, Razorpay, Freshbooks, BambooHR, and 7,990 more apps. No individual OAuth flows needed.

**Architecture:**

```typescript
// New: packages/ai/src/mcp-client.ts

interface MCPConnection {
  id: string;
  org_id: string;
  name: string;             // "Zapier MCP", "GitHub MCP", "Custom: Ahrefs"
  server_url: string;       // MCP server endpoint
  auth: MCPAuth;            // API key, OAuth token, etc.
  enabled_tools: string[];  // Which tools from this server are active
  trust_tier: 'auto' | 'quick' | 'full';  // Default approval level
  created_by: string;
}

interface MCPTool {
  // MCP tools map directly to our existing tool shape
  name: string;
  description: string;
  inputSchema: JSONSchema;
  source: 'native' | 'mcp';
  mcp_connection_id?: string;
  approval_tier: 'auto' | 'quick' | 'full';
}
```

**How it connects to the existing engine:**

1. When building the tool list for a conversation, merge native tools + MCP tools from active connections
2. Tool execution in `agent-context.ts` routes MCP tools through the MCP client instead of SQL
3. MCP tool results flow through the same citation + approval pipeline
4. MCP write actions follow the same approval workflow as native write actions

#### Path B: Native OAuth Integrations (for deep, real-time access)

For tools where we need deeper integration than MCP provides (real-time sync, webhooks, embedded UI):

| Integration | Read | Write | Sync |
|---|---|---|---|
| GitHub | Issues, PRs, actions, releases | Create issues, comment on PRs | Webhook: PR events → events table |
| Linear | Issues, projects, cycles | Create/update issues | Webhook: issue changes → events table |
| Google Calendar | Already built | Already built | Already built |

These use the existing `connectedAccounts` + `events` infrastructure. The `events` table already has source enums for all of these.

**Path A vs Path B is not either/or.** Use MCP for breadth (thousands of apps via Zapier). Use native integrations for depth (real-time sync, webhooks, embedded UI for the tools your users use daily).

### Tier 4: Agentic Employees — "The Agent Becomes a Teammate"

**Goal:** Multiple persistent, role-based agents that appear as team members in the workspace.

This is the full vision. Covered in detail in Part 4.

---

## Part 3: The Five Architecture Layers

### Layer 1: MCP Client (Universal Tool Adapter)

**Status:** Not built. No MCP support exists.

**What to build:**

New package: `packages/mcp/` or add to `packages/ai/`
- MCP client library (use `@modelcontextprotocol/sdk`)
- Connection manager: store server configs, auth, manage lifecycle
- Tool discovery: list available tools from connected MCP servers
- Tool execution: call MCP tools, return results in our citation format
- Error handling: timeouts, auth failures, rate limits

New DB table: `mcp_connections`
```
id, org_id
name, server_url, transport ('stdio' | 'sse' | 'streamable-http')
auth_type ('api_key' | 'oauth' | 'none')
auth_config_encrypted (jsonb)
enabled_tools (text[])  — null means all
default_trust_tier ('auto' | 'quick' | 'full')
is_active (boolean)
last_connected_at, connection_error
created_by, created_at, updated_at
```

New DB table: `mcp_tool_overrides`
```
id, org_id, mcp_connection_id
tool_name
trust_tier_override ('auto' | 'quick' | 'full')
is_disabled (boolean)
```

**Integration with agent engine:**

```
agent-tools.ts (existing)
  ├── getNativeTools() → current 32 tools
  └── getMCPTools(orgId) → query mcp_connections → discover tools → merge

agent-context.ts (existing)
  ├── executeNativeTool(name, params) → current switch statement
  └── executeMCPTool(connectionId, name, params) → MCP client call

agent.ts (existing, line ~260)
  tools = [...getNativeTools(org, user), ...await getMCPTools(org.id)]
```

**Settings UI:**

New settings tab: **Settings > Integrations > MCP Connections**
- "Add MCP Server" → enter URL, auth config, test connection
- "Connect Zapier" → guided setup with Zapier MCP URL
- Per-connection: toggle tools on/off, set default trust tier
- Connection status: last connected, error state, tool count

### Layer 2: Background Triggers (Always-On Engine)

**Status:** Infrastructure exists (job queue, cron scheduler, 12+ worker handlers). Triggers table exists but has no execution engine. Workers exist but are not all connected to the agent for generating responses.

**What to build:**

Trigger execution engine: reads `triggers` table, evaluates conditions, dispatches jobs.

```typescript
// Trigger types
type TriggerEvent =
  | 'task.overdue'           // Task past due date
  | 'task.stalled'           // No activity for N hours
  | 'task.status_changed'    // Status transition
  | 'task.assigned'          // New assignment
  | 'message.actionable'     // Classifier flagged as actionable
  | 'message.decision'       // Classifier extracted a decision
  | 'message.agent_mention'  // @agent in chat
  | 'pr.merged'              // GitHub PR merged
  | 'pr.opened'              // GitHub PR opened
  | 'calendar.upcoming'      // Event in N minutes
  | 'schedule.cron'          // Cron expression (e.g., "0 9 * * 1-5")
  | 'webhook.received'       // External webhook hit
  | 'mcp.event'              // Event from MCP server

interface TriggerRule {
  id: string;
  agent_employee_id: string;  // Which agent handles this
  event: TriggerEvent;
  condition: JSONLogic;        // e.g., { "==": [{ "var": "task.priority" }, "urgent"] }
  action: {
    type: 'run_agent' | 'execute_tool' | 'post_message';
    prompt?: string;           // For run_agent: what to tell the agent
    tool?: string;             // For execute_tool: which tool
    params?: Record<string, any>;
  };
  trust_tier: 'auto' | 'quick' | 'full';
  is_active: boolean;
  last_fired_at: Date;
  fire_count: number;
}
```

**What to wire:**
- `standup-generate` handler → use `agent-runner.ts` to generate standup text → post via `post_message`
- `nudge-check` handler → find stalled tasks → use agent to compose context-aware nudge → DM assignee
- `meeting-prep-check` handler → find upcoming meetings → use agent to gather context → post prep
- `burnout-detect` handler → already generates signals → use agent to compose sensitive manager DM
- Classifier pipeline → on `decision` detected → auto-create knowledge entry (or suggest)
- GitHub webhook → on PR merge → match to task → update status → post in space

**Notification feed:**

New component in dashboard: **"Agent Activity"**
- "Marketing Agent posted the weekly SEO report in #marketing" — 2 min ago
- "Engineering Agent moved DEFT-42 to Done after PR #87 merged" — 15 min ago
- "HR Agent flagged burnout risk for review" — 1 hour ago

### Layer 3: Agent Employee Profiles (The "Who")

**Status:** Not built. The `skills` table exists but is not connected to agents.

**What to build:**

New DB table: `agent_employees`
```
id, org_id
name                        -- "Alex — Marketing Lead"
slug                        -- "marketing-lead"
role                        -- 'marketing' | 'engineering' | 'hr' | 'finance' | 'executive_assistant' | 'custom'
avatar_url                  -- Generated or uploaded
system_prompt               -- Role-specific instructions and personality
expertise_description       -- What this agent knows about (shown to users)

-- Tool access
native_tool_scopes          -- jsonb: which spaces, projects it can access
mcp_connection_ids          -- text[]: which MCP connections it can use
disabled_tools              -- text[]: tools explicitly blocked for this role

-- Behavior
trust_level                 -- conservative | standard | autonomous
max_daily_actions           -- Rate limit (prevent runaway agents)
working_hours               -- jsonb: { start: "09:00", end: "18:00", timezone: "Asia/Kolkata" }
is_active                   -- Can be paused

-- Identity
appears_as_member           -- boolean: show in space member lists
can_be_mentioned            -- boolean: respond to @name in chat
can_be_assigned_tasks       -- boolean: appear in assignee dropdown

-- Metadata
created_by, created_at, updated_at
```

New DB table: `agent_employee_triggers`
```
id, agent_employee_id
event, condition, action, trust_tier
is_active, last_fired_at, fire_count
```

**How employees appear in the platform:**

An agent employee is a special type of org member. It has a `user_id` in the `users` table with `is_agent: true`. This means:

- It appears in the member list of spaces it's added to
- It can be @mentioned in chat (routes to agent-runner with the employee's system prompt)
- It can be assigned tasks (triggers the employee to work on it)
- It can post messages (attributed to its name/avatar)
- It shows up in the "online" indicator (when active/within working hours)

**Pre-built role templates:**

| Role | System Prompt Focus | Default Tools | Default Triggers |
|---|---|---|---|
| **Project Manager** | Sprint tracking, blocker detection, team coordination | All native read + task write + post_message | Daily standup, task overdue, stalled task, weekly digest |
| **Engineering Lead** | Code review, PR management, technical decisions | Native + GitHub MCP | PR merged, PR opened, task status change, weekly velocity |
| **Marketing Manager** | Campaign tracking, content calendar, SEO monitoring | Native + Zapier (Ahrefs, Mailchimp, Buffer) | Weekly SEO report, campaign metrics, content due dates |
| **Bookkeeper** | Invoice management, expense tracking, financial reporting | Native + Zapier (QuickBooks/Xero, Stripe) | Invoice overdue, month-end report, payment received |
| **HR Manager** | Onboarding, team health, performance reviews | Native + Zapier (Keka/BambooHR) + Google Calendar | New hire onboard, leave request, burnout signal, quarterly review |
| **Executive Assistant** | Calendar management, email triage, briefings | Native + Google Calendar | Morning briefing, meeting prep, email summary |

### Layer 4: Deft MCP Server (Open Platform)

**Status:** Not built.

**What to build:**

Publish `@deft/mcp-server` — an MCP server that exposes Deft's native data and actions to external agents.

```
External Agent (NemoClaw, OpenClaw, Claude Cowork, custom)
  └── connects to → Deft MCP Server
        ├── search_tasks(query, filters)
        ├── get_task(id)
        ├── create_task(title, description, ...)
        ├── search_messages(query, space)
        ├── post_message(space, content)
        ├── search_knowledge(query, type)
        ├── get_team_workload()
        ├── get_project_progress(project)
        └── ... (subset of native tools, permission-gated)
```

**Authentication:** API keys per org, scoped to specific tool sets. Admin creates a key in Settings > Integrations > API Access, assigns permissions.

**Why this matters:**
- Enterprises running NemoClaw on their own infrastructure can connect to Deft for workspace data
- Claude Cowork users can add Deft as an MCP connection
- Custom agents built with any framework can integrate
- Deft becomes a data layer in the broader agent ecosystem, not a walled garden

### Layer 5: Multi-Agent Orchestration (The "Team")

**Status:** Not built. Most complex layer. Build last.

**What to build:**

Agents that can work together:

```
User: "Onboard the new engineer, Priya"

HR Agent (lead):
  Step 1: Create Priya's account → [native: create user]
  Step 2: Add to #engineering and #general spaces → [native: add member]
  Step 3: Create onboarding task list → [native: create tasks]
  Step 4: Schedule 1:1 with manager → [delegate to Executive Assistant agent]
  Step 5: Create a welcome task in Deft
  Step 6: Set up GitHub access → [delegate to Engineering Lead agent]
  Step 7: Post welcome in #general → [native: post message]
```

**Agent-to-agent communication:**
- Agents post in shared spaces (visible to humans)
- Agents can @mention other agents (triggers their handler)
- Agent actions are attributed to the specific agent employee
- Humans can see the full chain: who requested what, who did what

**Oversight dashboard:**

New page: `/agents` (or section in dashboard)
- List of active agent employees with status (active, paused, error)
- Recent actions per agent
- Pending approvals across all agents
- Daily action count and token spend per agent
- "Pause all agents" emergency button

---

## Part 4: Platform Integration Map

How agentic employees integrate across every surface of Deft:

### Dashboard

**Current:** Static widgets showing tasks, calendar, GitHub activity.

**With agents:**
- **Agent Activity Feed** — real-time stream of what agents are doing
  - "Marketing Agent posted weekly SEO report" — 2 min ago
  - "Engineering Agent updated 3 tasks from merged PRs" — 15 min ago
- **Pending Approvals Widget** — all agents' pending actions in one place
- **Agent Health** — which agents are active, error states, token spend today
- **Morning Briefing** — Executive Assistant agent's daily summary (auto-generated)
- **Agent-Generated Insights** — "3 tasks overdue in Project Alpha. Marketing has no blockers. Engineering velocity is up 20% this week."

### Chat (Spaces)

**Current:** Humans chat. @agent triggers read-only agent response.

**With agents:**
- Agent employees appear as space members with avatars
- @Marketing-Agent in #marketing → Marketing agent responds with campaign context
- Agents post proactively: standup summaries, blocker alerts, meeting prep
- Agents can be in multiple spaces (scoped by their `native_tool_scopes`)
- Thread awareness: agent responds in threads, not just top-level
- Message classification feeds agent triggers (decision → knowledge, actionable → task suggestion)

### Tasks

**Current:** Humans create and manage tasks.

**With agents:**
- Agent employees appear in the assignee dropdown
- Assigning a task to an agent triggers it to work on the task
  - Engineering Agent assigned "Review PR #87" → checks GitHub, posts review summary
  - Marketing Agent assigned "Draft blog post outline" → uses knowledge base + Ahrefs data → posts draft
- Agents create tasks from triggers (overdue nudge, PR merged, actionable message)
- Agent-created tasks are attributed to the creating agent
- Task activity log shows agent actions alongside human actions

### Calendar

**Current:** Google Calendar events displayed. Agent can read and create events.

**With agents:**
- Executive Assistant agent manages calendar proactively
  - Meeting in 15min → auto-generate prep (attendee context, related tasks, last meeting notes)
  - Double-booking detected → alert in DM
  - Reschedule request → propose alternatives based on availability
- HR Agent creates onboarding meetings
- Engineering Agent schedules sprint ceremonies

### Knowledge Base

**Current:** Manual knowledge entries. Wiki with full-text search.

**With agents:**
- Agents auto-capture decisions from chat (classifier already extracts these)
- Agents maintain wiki pages (update outdated info, add new pages from conversations)
- Knowledge entries cite source messages and agents that created them
- Agent employees have read access to knowledge base for context in all interactions
- Marketing Agent maintains brand guidelines wiki from team discussions
- HR Agent maintains policy wiki from compliance conversations

### Settings

**Current:** Profile, theme, integrations (Google, GitHub), agent trust level.

**With agents, new sections:**

**Settings > Agent Employees**
- List of org's agent employees with status toggle
- "Create Agent Employee" wizard:
  1. Pick role template (or custom)
  2. Name and avatar
  3. Connect MCP tools (Zapier, specific servers)
  4. Set space access (which spaces can it see/post in)
  5. Configure triggers (which events activate it)
  6. Set trust level (conservative/standard/autonomous)
  7. Set working hours and rate limits
- Per-agent: edit config, view action log, pause/resume, delete

**Settings > MCP Connections**
- "Add MCP Server" — URL, auth, test connection
- "Connect Zapier MCP" — guided setup
- Per-connection: tool list, toggle tools, set default trust tier
- Connection health: last connected, errors, tool count

**Settings > API Access** (for Deft MCP Server)
- Create API keys for external agents
- Per-key: name, permissions, rate limits, last used
- Usage dashboard: requests per day, which tools called

### Notes

**Current:** TipTap editor for personal and shared notes.

**With agents:**
- Agent can be asked to draft notes (meeting notes, project summaries)
- Agent can reference notes as context for other tasks
- No deep integration needed — notes are primarily a human-authored surface

### Sidebar

**Current:** Navigation + user menu.

**With agents:**
- Agent employees section in sidebar (below spaces, above settings)
  - Shows active agents with status indicators
  - Click to open agent's conversation/activity view
  - Quick-access to pending approvals badge
- Or: agents appear within spaces they're members of (alongside human members)

---

## Part 5: MCP Integration Strategy

### Connecting MCP Servers

Three ways users connect MCP tools to Deft:

#### 1. Zapier MCP (Instant Breadth)

**Setup:** User enters Zapier MCP URL + API key in Settings > MCP Connections.

**Result:** 8,000 apps, 30,000 actions immediately available as agent tools. Each Zapier action costs 2 Zapier tasks (Zapier's pricing, not ours).

**Best for:** Long-tail integrations (Ahrefs, Mailchimp, QuickBooks, Keka, HubSpot, Buffer, etc.). Apps where you need occasional read/write but not real-time sync.

**Limitation:** No webhooks/real-time events from Zapier MCP. Agent must poll or be triggered by other events.

#### 2. Official MCP Servers (Deep Integration)

**Setup:** Admin adds MCP server URL in Settings > MCP Connections. Some servers need OAuth (GitHub, Google), others need API keys.

**Available servers (from Anthropic's official list):**
- GitHub MCP — repos, issues, PRs, actions, create issues, comment
- Google Drive MCP — files, folders, search, read
- Google Maps MCP — geocoding, directions, places
- PostgreSQL MCP — (we don't need this — we have direct access)
- Sentry MCP — errors, issues, events
- And 50+ more official servers

**Best for:** Core tools the team uses daily. Better performance, real-time capability, richer schemas than Zapier.

#### 3. Custom MCP Servers (Org-Specific)

**Setup:** Engineering team deploys a custom MCP server for internal tools (internal APIs, databases, custom systems). Adds URL in Settings.

**Best for:** Proprietary systems, internal tools, custom workflows. This is how enterprises extend Deft to their specific stack.

### Internal Agent Builder

For power users who want to create custom agent employees without code:

**Agent Builder Wizard (Settings > Agent Employees > Create)**

```
Step 1: Role & Identity
  - Name: "Campaign Tracker"
  - Role: Custom
  - Avatar: [upload or generate]
  - Description: "Monitors marketing campaigns and reports performance weekly"

Step 2: Knowledge & Personality
  - System prompt: [textarea with template suggestions]
  - Expertise: "Digital marketing, SEO, email campaigns, social media"
  - Tone: Professional / Casual / Technical

Step 3: Tool Access
  - Native tools: [checklist — search_tasks, search_messages, post_message, etc.]
  - MCP connections: [select from connected MCPs]
    - Zapier: [select specific actions — "Ahrefs: Get keywords", "Mailchimp: Get campaign stats"]
  - Trust per tool: [auto / needs approval]

Step 4: Space Access
  - Spaces this agent can see: [multi-select]
  - Spaces this agent can post in: [multi-select]
  - Projects this agent can access: [multi-select]

Step 5: Triggers
  - [+ Add trigger]
    - When: [task overdue / message contains / cron schedule / PR merged / ...]
    - Condition: [optional filter]
    - Do: [run with prompt / execute tool / post message]
  
  Example triggers:
    - Every Monday 9am → "Generate weekly SEO performance report from Ahrefs and post in #marketing"
    - When task overdue in "Content Calendar" → "DM the assignee with a friendly reminder"

Step 6: Limits & Schedule
  - Working hours: 9am-6pm IST (or always on)
  - Max daily actions: 50
  - Trust level: Conservative
  - [Create Agent]
```

### Deft-Hosted vs. Bring-Your-Own-Agent

#### Deft-Hosted Agents (Default)

Agent employees run inside Deft's infrastructure:
- Use our agent engine (`agent-runner.ts`)
- Execute against our LLM router (`llm.ts`) — Anthropic, OpenAI, or org-configured model
- Direct SQL access to native data (the core advantage)
- MCP client calls for external tools
- Managed by Deft — we handle scaling, monitoring, error recovery

**Pricing model:** Token usage per agent per month. Orgs on higher tiers get more agent employees and higher action limits.

#### Bring-Your-Own-Agent (Enterprise)

External agent instances connect to Deft via our MCP server:

```
Enterprise Infrastructure
  ├── NemoClaw instance (on NVIDIA hardware)
  │     └── connects to → Deft MCP Server
  │           └── reads/writes tasks, messages, knowledge
  │
  ├── OpenClaw instance (self-hosted)
  │     └── connects to → Deft MCP Server
  │
  ├── Claude Cowork (user's desktop)
  │     └── connects to → Deft MCP Server
  │
  └── Custom agent (any MCP-compatible framework)
        └── connects to → Deft MCP Server
```

**What they get:** Access to Deft's native data through MCP tools. Same search, create, and update capabilities as Deft-hosted agents, but through the MCP protocol.

**What they don't get:** Direct SQL access (they go through the MCP API layer). People analytics tools (privacy-sensitive, not exposed via MCP). Background triggers (they manage their own scheduling). Agent employee identity in the workspace (they appear as the connected user, not as a named agent).

**Why enterprises want this:**
- Compliance: run AI on their own infrastructure
- Model choice: use their own fine-tuned models
- Security: NemoClaw's OpenShell provides policy-based guardrails
- Existing investment: teams already running OpenClaw/NemoClaw

**Hybrid approach:** An enterprise could run NemoClaw for heavy-compute tasks (code review, document analysis) while using Deft-hosted agents for workspace automation (standups, task management). Both connect to the same data.

---

## Part 6: Build Sequence

### Phase 1: Foundation (Weeks 1-4)

**Goal:** Background automation + trust level enforcement. The agent comes alive.

1. Implement trust level routing in `agent.ts` — `standard` auto-executes read + low-risk writes, `autonomous` auto-executes everything except external
2. Implement approval tier logic — route actions through `auto/quick/full` based on tier field
3. Wire existing cron workers to `agent-runner.ts` for generating contextual messages
4. Build notification feed component for dashboard ("Agent Activity")
5. Add GitHub webhook receiver for PR events → task status updates
6. Wire classifier `decision` extraction → knowledge auto-capture (with quick-approve)

### Phase 2: MCP Client (Weeks 5-8)

**Goal:** Universal tool adapter. Instant access to thousands of apps.

1. Add `@modelcontextprotocol/sdk` to `packages/ai/`
2. Build MCP client wrapper: connect, discover tools, execute, handle errors
3. Create `mcp_connections` table and CRUD API
4. Integrate MCP tools into agent tool list (merge with native tools)
5. Route MCP tool execution through existing approval pipeline
6. Build Settings > MCP Connections UI
7. Zapier MCP guided setup flow
8. Test with 3-5 MCP servers (Zapier, GitHub, Sentry)

### Phase 3: Agent Employees (Weeks 9-14)

**Goal:** Multiple role-based agents as team members.

1. Create `agent_employees` table and schema
2. Add `is_agent` flag to users table — agent employees are special users
3. Build agent employee CRUD API
4. Agent appears in space member lists, assignee dropdowns, @mention suggestions
5. Route @mentions of agent employees to agent-runner with employee's system prompt
6. Build task assignment handler — assigning task to agent triggers execution
7. Build agent employee triggers table and execution engine
8. Build Settings > Agent Employees UI with creation wizard
9. Build 6 pre-built role templates (PM, Engineering, Marketing, Finance, HR, EA)
10. Add agent activity feed to dashboard
11. Add pending approvals widget (across all agents)

### Phase 4: Multi-Step Plans (Weeks 15-18)

**Goal:** Agent decomposes complex requests into executable plans.

1. Create `agent_plans` table
2. Add `create_plan` tool to agent
3. Build plan approval UI (reorder, edit, approve steps)
4. Build plan execution loop with step-by-step progress streaming
5. Add plan pause/resume on write actions
6. Add plan failure handling (retry step, skip step, abort plan)

### Phase 5: Open Platform (Weeks 19-22)

**Goal:** Deft as a data layer in the agent ecosystem.

1. Build Deft MCP server (`@deft/mcp-server`)
2. Expose subset of native tools via MCP protocol
3. API key management UI (Settings > API Access)
4. Permission scoping per API key
5. Rate limiting and usage tracking
6. Documentation and setup guides for NemoClaw, OpenClaw, Claude Cowork

### Phase 6: Multi-Agent Orchestration (Weeks 23-26)

**Goal:** Agents that work together.

1. Agent-to-agent @mention routing
2. Task delegation between agents
3. Shared plan execution (one agent creates plan, assigns steps to others)
4. Agent oversight dashboard (`/agents` page)
5. Emergency controls (pause all, rate limit, kill switch)
6. Token spend tracking and budget per agent

---

## Part 7: Competitive Positioning

### vs. Claude Cowork

| | Claude Cowork | Deft |
|---|---|---|
| **Model** | Personal desktop agent | Team-native agent platform |
| **Data** | Local files | Relational DB with org context |
| **Agents** | One (Claude) | Multiple role-based employees |
| **Team awareness** | None | Full (workload, health, expertise) |
| **Persistence** | Projects with memory | Native database + triggers |
| **Background work** | Scheduled tasks | Event-driven + scheduled |
| **Open platform** | MCP consumer only | MCP consumer AND server |

**Deft wins on:** Team intelligence, multi-agent, native data depth.
**Cowork wins on:** Desktop integration, computer use, individual productivity.

### vs. OpenClaw / NemoClaw

| | OpenClaw/NemoClaw | Deft |
|---|---|---|
| **Model** | Personal agent with skills | Workspace with agent employees |
| **Data** | Files + APIs | Relational DB with org context |
| **Integration** | 100+ skills, any app | MCP (same breadth) + native SQL (more depth) |
| **Security** | OpenShell guardrails (NemoClaw) | Approval tiers + privacy guard + org scoping |
| **Team** | Single user | Multi-user, multi-agent, role-based |
| **Enterprise** | NemoClaw (self-hosted) | Deft-hosted + BYOA via MCP server |

**Deft wins on:** Team context, workspace-native, multiple agents per org.
**OpenClaw wins on:** General-purpose flexibility, messaging platform UI.
**NemoClaw wins on:** Enterprise security, GPU-optimized inference.

**The key differentiator:** OpenClaw and NemoClaw are personal agents that can do anything. Deft agents are team agents that understand your work. A personal agent with Ahrefs access can pull SEO data. A Deft Marketing Agent with Ahrefs access can pull SEO data *and* correlate it with your content calendar tasks, team discussions about strategy, and the knowledge base entry about brand guidelines — then post a contextualized report in the right space.

### The Moat

1. **Native SQL on organizational data** — no other agent platform has this
2. **People analytics** — burnout detection, skills gaps, expertise graphs
3. **Multi-agent with shared workspace context** — agents collaborate through the same spaces humans use
4. **Both MCP consumer and server** — participate in the ecosystem from both sides
5. **Trust/privacy by design** — approval tiers, manager-only tools, `org_id` on everything

---

## Part 8: Decisions (Resolved)

### Pricing

**Human seats:**
- Monthly: $15/month (includes $5 AI credits)
- Annual: $12/month (includes $5 AI credits/month)

**Agent employees:**
- Monthly: $25/month (includes $15 AI credits)
- Annual: $20/month (includes $15 AI credits/month)

**AI credits:** Consumed by LLM token usage. Orgs can buy additional credits as needed. Token budgets are allocatable per employee (human or agent) by org admins.

### Agent Identity

Full user accounts. Agent employees are first-class users in the system with `is_agent: true`. They have profiles, avatars, appear in member lists, can be @mentioned, can be assigned tasks, and own the content they create.

### Agent-Generated Content Ownership

The agent owns content it creates (messages, tasks, knowledge entries). Every agent has one or more designated **managers** — humans who are accountable for the agent's output. The buck stops with the manager. Managers receive notifications for agent actions and can configure trust levels.

### Agent Marketplace

Free and open marketplace. Community building angle. Orgs can publish custom agent templates (role profile, system prompt, recommended MCP connections, trigger configurations) for other orgs to install and customize. Templates don't include org-specific data, credentials, or MCP auth — just the configuration blueprint.

### Audit and Compliance

Retain all agent action logs indefinitely by default. Give orgs the option to configure their own retention policies (30d, 90d, 1y, indefinite). GDPR: agent memory is deletable per-user on request. Audit trail is append-only.

### Model Selection Per Agent

Model routing is a scale problem to solve later. For now, all agents use the org's configured LLM router (`llm.ts`). Future: per-agent model overrides, task-based routing (Haiku for classification, Sonnet for reasoning, GPT-4o for summarization), cost-optimized routing based on task complexity.

### Rate Limiting

Org admins set limits. Options:
- Per-agent daily action cap
- Per-agent token budget (from org's AI credit pool)
- Org-wide daily spend ceiling
- Buy more AI credits on demand when budget exhausted

### Failure Recovery

Tiered escalation:
1. **System flaky** (network timeout, 503, rate limit) → retry silently with backoff
2. **Agent error** (wrong tool params, unexpected response) → retry with reasoning (include error in context so agent learns)
3. **Ambiguous intent** (agent unsure what user meant) → ask the user
4. **External write failed** (API error on create_task, post_message, etc.) → escalate immediately to manager
5. **Budget exhausted** → stop immediately, notify manager

**Iron rule:** Never retry a write action without an idempotency check. Duplicate task creation or double-posting is worse than failing.

### NemoClaw / External Agents

NemoClaw is Apache 2.0. We integrate freely — no partnership needed. Build the Deft MCP server, document how to connect NemoClaw/OpenClaw/any MCP client, and let the community drive adoption.

---

## Part 9: Decisions (Resolved — Round 2)

### Free Tier

No free tier. AI features cost money and there's no funding to subsidize free usage. Instead: a **public demo account** where prospects can explore the workspace and see how things work, but AI-powered features (agent conversations, background automation, MCP tool calls) require a paid seat.

### Seat Billing

Separate line items. Simple math:

| | Monthly | Annual |
|---|---|---|
| Human seat | $15/mo ($5 AI credits) | $12/mo ($5 AI credits) |
| Agent seat | $25/mo ($15 AI credits) | $20/mo ($15 AI credits) |

Example: 5 humans + 3 agents on annual = (5 x $12) + (3 x $20) = **$120/month**.

### Self-Hosted Pricing

Fully free. Self-hosted orgs bring their own LLM API keys, run their own infrastructure, pay nothing to Deft. The BSL 1.1 license allows any use except hosting as a service for third parties.

### Marketplace Moderation

Two-layer system:
1. **AI approval gate** — automated review of submitted templates for malicious prompts, prompt injection attempts, and policy violations before publishing
2. **Community ratings** — 5-star rating system by users who install and use the template. Low-rated templates surface warnings. Flagged templates go to review queue.

No manual Deft team curation required. Community self-polices with AI as the first gate.

### Manager Assignment

Two levels of oversight:

1. **Org-wide admins** — owner/admin role users can manage all agents (create, pause, delete, configure). This is the existing role system.
2. **Working managers** — humans designated as an agent's manager who work with it day-to-day. They receive notifications for agent actions, can approve/reject pending actions, and are accountable for the agent's output. An agent can have multiple working managers. A human can manage multiple agents.

### Agent Onboarding

No trial flow. Commit to the $25/month seat. The agent builder wizard guides setup (role template → tools → triggers → trust level), and the agent is live immediately. If it's not useful, cancel the seat.

### Credit Pooling

Two modes, org chooses:

1. **Individual credits** (default) — each seat keeps its own included credits ($5 human, $15 agent). No sharing. Buy more credits per-seat if exhausted.
2. **Pool and divide** — all seat credits flow into an org-wide pool. Admins can allocate budgets from the pool to any seat (human or agent). Unused human credits can flow to agents and vice versa. Total pool = sum of all seat credits. Buy additional credits added to the pool.

Credits are fungible in pool mode — human and agent credits are treated identically.

### BYOA Billing

Free. External agents connecting via Deft MCP Server don't count as agent seats and aren't billed. The MCP server is an open API — rate-limited by API key, but no per-request charges. This encourages ecosystem adoption. The value is that enterprises using NemoClaw/OpenClaw still need human seats to manage the workspace.

---

All product decisions are now resolved. No remaining open questions.
