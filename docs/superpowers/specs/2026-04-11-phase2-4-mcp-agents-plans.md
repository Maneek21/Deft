# Phase 2-4: MCP Client + Agent Employees + Multi-Step Plans + Deft MCP Server

> Unified spec for transforming Deft from a single-agent workspace into an agentic employee platform.
> Builds on Phase 1 (trust levels, approval routing, background execution, dashboard activity feed).

---

## 1. What We're Building

Four integrated layers shipped as one cohesive system:

1. **MCP Client** — Universal tool adapter connecting Deft agents to external MCP servers (Zapier, n8n, Slack, GitHub, Sentry, custom). All three transports: stdio (self-hosted), SSE, streamable-http (SaaS).
2. **Agent Employees** — Persistent, role-based AI agents that are full workspace citizens. Real user accounts, appear in member lists, get @mentioned, get assigned tasks, post messages. SaaS gets the agent builder wizard; self-hosted gets BYOA only.
3. **Multi-Step Plans** — Agent decomposes complex requests into ordered steps with conditional branching. Write steps that are dependencies pause execution; non-blocking writes batch for approval. Agent reasons through alternatives when stuck, escalates to humans when out of scope.
4. **Deft MCP Server** — Exposes Deft's native tools + org's connected MCP tools via MCP protocol. Per-agent API keys so external agents (NemoClaw, OpenClaw, Claude Desktop) connect as specific agent employees with that employee's tool scopes and trust level.

---

## 1.1 Key Architectural Decisions

### Defty — The Platform Superintendent

Every org gets **Defty** for free. Defty is NOT an employee — it is the **platform-native superintendent**, the control plane for the entire agentic system. Agent employees are the data plane — they do the work. Defty manages, configures, and oversees everything.

**Defty consumes employee AI credits** — not a separate budget. This keeps the pricing model simple: orgs buy human seats ($15/mo with $5 credits) and agent employee seats ($25/mo with $15 credits). Defty draws from the org's credit pool, same as employees. No hidden costs.

**Defty's unique role:**
- Build and configure agent employees: "Create me a Marketing agent that monitors Ahrefs weekly"
- Manage agent operations: "Pause all agents until Monday"
- Investigate agent behavior: "Why did the PM agent post that message in #engineering?"
- Report on agent economics: "Which agent is burning the most credits?"
- Reconfigure employees: "Update the Engineering Lead to also watch Linear"
- General-purpose workspace queries: everything it does today (search, analyze, report)

**What Defty is NOT:**
- Not an employee record — no `agent_employees` row, no daily action limit, no trust level override (uses org-level)
- Not replaceable by an employee — employees never see platform internals or manage other agents
- Not a paid seat — included free with every org

**The agent page** stays as Defty's interface. Users talk to Defty for platform management and general queries. A dropdown/tabs allow switching to specific employees for specialized conversations.

### Agent Employee Conversations — Chat as Source of Truth

Agent employees are workspace citizens. Their messages live where all messages live.

- **DMs with agents** and **@mentions in channels** use the `spaces` + `messages` tables (not agentConversations/agentMessages)
- Agent reasoning metadata (tool calls, citations, token counts) stored in a new `metadata` jsonb column on the `messages` table
- **The agent page** is a view layer for employee conversations — it queries messages where the counterpart is an agent employee and renders with rich agent UI (citations, tool calls, plan progress) using `metadata`
- Chat search finds agent conversations naturally. Activity feeds include agent actions. One notification pipeline.
- The existing `agentConversations` / `agentMessages` tables remain for Defty (backward compatible)

### Plan Resumption — Auto-Resume with Review Window

When a plan pauses for a write step approval:
1. User approves the action
2. UI shows "Resuming plan in 10s..." with a "Pause" button
3. If user doesn't pause → plan auto-resumes
4. If user pauses → stays paused until manual resume

For batch approvals (multiple non-blocking writes): approving the batch auto-resumes immediately.

### MCP Connection Lifecycle — On-Demand with Warm Pool

Neither fully persistent nor fully on-demand:
- **Connect on first tool call**, keep alive for **5 minutes of inactivity**, then disconnect
- **Pool by org** — if two employees in the same org use the same MCP server, they share one connection
- **Max 3 concurrent MCP connections per org** (configurable via env var). Exceeded → queue and wait
- **Stdio:** spawn process on first call, keep alive 5 minutes, then kill. Pool by command config
- **Health tracking:** 3 failures in 5 minutes → mark errored, stop attempting for 10 minutes
- The 5-minute warm window matches tool cache TTL — a typical agent conversation stays fast

---

## 2. Schema Changes

### 2.1 Modify: `users` table

Add columns:

```
is_agent          boolean     DEFAULT false NOT NULL
agent_employee_id text        REFERENCES agent_employees(id)   -- links user back to employee config
```

`email` becomes nullable for agent users (internal agents don't need real emails). External agents may have emails configured by the org admin.

Migration: `ALTER TABLE users ALTER COLUMN email DROP NOT NULL; ADD COLUMN is_agent ...`

Unique constraint on email stays but only applies to non-null values (Postgres handles this natively — NULL is never equal to NULL in unique indexes).

### 2.1b Modify: `messages` table

Add column for agent reasoning metadata:

```
metadata          jsonb                                        -- agent tool calls, citations, tokens, plan refs
```

Schema for metadata when message is from an agent employee:

```typescript
interface AgentMessageMetadata {
  tool_calls?: { tool: string; params: any; result: any; status: string }[];
  citations?: { type: string; id: string; title: string }[];
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  plan_id?: string;           // if this message relates to a plan
  agent_employee_id?: string; // which employee produced this message
  confidence?: 'high' | 'medium' | 'low';
}
```

NULL for regular human messages. Only populated when the message author is an agent employee.

### 2.2 New enum: `mcp_transport`

```
'stdio' | 'sse' | 'streamable-http'
```

### 2.3 New enum: `agent_employee_role`

```
'project_manager' | 'engineering_lead' | 'executive_assistant' | 'custom'
```

Starting with 3 pre-built templates (PM, Engineering Lead, EA) + custom. Additional roles (`marketing_manager`, `hr_manager`, `finance_manager`) added to the enum when their templates are built alongside Zapier/n8n MCP foundations.

### 2.4 New enum: `plan_status`

```
'draft' | 'approved' | 'executing' | 'paused' | 'completed' | 'failed'
```

### 2.5 New enum: `plan_step_status`

```
'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting_approval'
```

### 2.6 New table: `mcp_connections`

```sql
mcp_connections (
  id                      text PRIMARY KEY
  org_id                  text NOT NULL REFERENCES orgs(id)
  name                    text NOT NULL                        -- "Zapier", "Company Slack MCP", etc.
  slug                    text NOT NULL                        -- auto-generated kebab-case from name, used in tool prefixing
  server_url              text                                 -- for SSE/streamable-http
  transport               mcp_transport NOT NULL
  stdio_command           text                                 -- for stdio: "npx", "node", etc.
  stdio_args              jsonb                                -- for stdio: ["-y", "@mcp/slack"]
  auth_type               text NOT NULL DEFAULT 'none'         -- 'api_key' | 'oauth' | 'none'
  auth_config_encrypted   jsonb                                -- encrypted tokens/keys
  is_active               boolean DEFAULT true NOT NULL
  last_connected_at       timestamp
  connection_error        text
  tools_cache             jsonb                                -- cached tool schemas from discovery
  tools_cached_at         timestamp
  default_trust_tier      approval_tier DEFAULT 'full' NOT NULL -- safe default: everything needs approval
  enabled_tools           text[]                               -- NULL = all tools enabled
  created_by              text NOT NULL REFERENCES users(id)
  created_at              timestamp DEFAULT now() NOT NULL
  updated_at              timestamp DEFAULT now() NOT NULL

  UNIQUE INDEX: (org_id, slug)
  INDEX: org_id
)
```

### 2.7 New table: `mcp_tool_overrides`

```sql
mcp_tool_overrides (
  id                  text PRIMARY KEY
  org_id              text NOT NULL REFERENCES orgs(id)
  mcp_connection_id   text NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE
  tool_name           text NOT NULL
  trust_tier_override approval_tier                            -- override connection's default
  is_disabled         boolean DEFAULT false NOT NULL

  UNIQUE INDEX: (mcp_connection_id, tool_name)
)
```

### 2.8 New table: `agent_employees`

```sql
agent_employees (
  id                      text PRIMARY KEY
  org_id                  text NOT NULL REFERENCES orgs(id)
  user_id                 text NOT NULL REFERENCES users(id)   -- the agent's user account
  name                    text NOT NULL                        -- "Alex — Project Manager"
  slug                    text NOT NULL                        -- "project-manager"
  role                    agent_employee_role NOT NULL
  avatar_url              text
  system_prompt           text NOT NULL                        -- role-specific instructions
  expertise_description   text                                 -- what this agent knows about
  native_tools            text[]                               -- tool name strings e.g. ['search_tasks','create_task'] (NULL = all)
  mcp_connection_ids      text[]                               -- which MCP connections it can use
  disabled_tools          text[]                               -- tools explicitly blocked
  space_ids               text[]                               -- spaces it can see/post in (NULL = all)
  project_ids             text[]                               -- projects it can access (NULL = all)
  trust_level             trust_level DEFAULT 'conservative' NOT NULL
  max_daily_actions       integer DEFAULT 50 NOT NULL
  daily_action_count      integer DEFAULT 0 NOT NULL           -- reset daily by cron
  daily_action_reset_at   timestamp
  is_active               boolean DEFAULT true NOT NULL
  is_byoa                 boolean DEFAULT false NOT NULL       -- true = external agent via MCP server
  byoa_model_info         text                                 -- "NemoClaw v2.1" — for display
  created_by              text NOT NULL REFERENCES users(id)
  created_at              timestamp DEFAULT now() NOT NULL
  updated_at              timestamp DEFAULT now() NOT NULL

  UNIQUE INDEX: (org_id, slug)
  INDEX: org_id
)
```

### 2.9 New table: `agent_employee_triggers`

Uses the existing `triggers` table pattern but scoped to agent employees. We extend the existing `triggers` table rather than creating a new one — add `agent_employee_id` column:

```sql
ALTER TABLE triggers ADD COLUMN agent_employee_id text REFERENCES agent_employees(id);
```

This keeps all trigger infrastructure unified. When `agent_employee_id` is NULL, it's an org-level trigger (legacy). When set, it's scoped to that employee.

Trigger conditions use structured field matching (not JSONLogic — simpler, covers our cases):

```jsonc
// condition schema:
{
  "project": "Marketing",       // exact match
  "priority": ["p0", "p1"],     // any of
  "assignee_name": "Arjun",     // exact match
  "status": "in_progress"       // exact match
}
```

If we need complex boolean logic later, we upgrade to JSONLogic without schema changes (condition is jsonb).

### 2.10 New table: `agent_plans`

```sql
agent_plans (
  id                  text PRIMARY KEY
  org_id              text NOT NULL REFERENCES orgs(id)
  user_id             text NOT NULL REFERENCES users(id)       -- who requested the plan
  agent_employee_id   text REFERENCES agent_employees(id)      -- which employee is executing (NULL = Defty)
  conversation_id     text                                     -- agentConversations.id (Defty) or spaces.id (employee DM), nullable, no FK
  title               text NOT NULL
  description         text                                     -- what the plan accomplishes
  steps               jsonb NOT NULL                           -- PlanStep[] (see below)
  status              plan_status DEFAULT 'draft' NOT NULL
  current_step        integer DEFAULT 0 NOT NULL
  context             jsonb                                    -- accumulated results from completed steps
  error               text
  created_at          timestamp DEFAULT now() NOT NULL
  updated_at          timestamp DEFAULT now() NOT NULL

  INDEX: org_id
  INDEX: agent_employee_id
)
```

**PlanStep schema (jsonb array):**

```typescript
interface PlanStep {
  id: string;                    // step UUID
  description: string;           // "Search for overdue tasks in Marketing project"
  tool: string;                  // tool name to call
  params: Record<string, any>;   // tool params (can reference prior step results via $step.N.result)
  is_write: boolean;             // whether this is a write action
  approval_tier?: ApprovalTier;  // override for this specific step
  depends_on?: string[];         // step IDs this step depends on (for conditional execution)
  condition?: {                  // conditional execution
    step_id: string;             // which prior step to check
    field: string;               // field path in that step's result
    operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'empty' | 'not_empty';
    value: any;                  // expected value
    on_false: 'skip' | 'alternative'; // what to do if condition fails
    alternative_tool?: string;   // tool to call instead
    alternative_params?: Record<string, any>;
  };
  status: PlanStepStatus;        // 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting_approval'
  result?: any;                  // execution result
  error?: string;                // error message if failed
  started_at?: string;
  completed_at?: string;
}
```

### 2.11 New table: `api_keys`

For Deft MCP Server — per-agent API keys for external agents.

```sql
api_keys (
  id                      text PRIMARY KEY
  org_id                  text NOT NULL REFERENCES orgs(id)
  agent_employee_id       text REFERENCES agent_employees(id)  -- scoped to this employee (NULL = org-wide)
  name                    text NOT NULL                        -- "NemoClaw Production Key"
  key_hash                text NOT NULL                        -- bcrypt hash of actual key
  key_prefix              text NOT NULL                        -- first 8 chars for display: "deft_abc1..."
  permissions             text[] NOT NULL                      -- tool names this key can access
  rate_limit_per_minute   integer DEFAULT 60 NOT NULL
  rate_limit_per_day      integer DEFAULT 10000 NOT NULL
  last_used_at            timestamp
  request_count           integer DEFAULT 0 NOT NULL
  is_active               boolean DEFAULT true NOT NULL
  expires_at              timestamp
  created_by              text NOT NULL REFERENCES users(id)
  created_at              timestamp DEFAULT now() NOT NULL
  updated_at              timestamp DEFAULT now() NOT NULL

  INDEX: org_id
  INDEX: key_prefix                                            -- fast lookup on auth
)
```

### 2.12 Modify: `agentActions` table

Add columns for agent employee attribution:

```
agent_employee_id   text    REFERENCES agent_employees(id)    -- which employee performed this
source              text    DEFAULT 'native'                  -- 'native' | 'mcp'
mcp_connection_id   text    REFERENCES mcp_connections(id)    -- if source = 'mcp'
plan_id             text    REFERENCES agent_plans(id)        -- if executed as part of a plan
plan_step_id        text                                      -- which step in the plan
```

---

## 3. MCP Client Architecture

### 3.1 New package: `packages/mcp/`

Thin wrapper around `@modelcontextprotocol/sdk/client`.

```
packages/mcp/
  src/
    client.ts           -- MCPClientManager: connect, discover, execute, disconnect
    transports.ts       -- Transport factory (stdio, SSE, streamable-http)
    types.ts            -- MCPTool, MCPConnection, MCPResult interfaces
    cache.ts            -- Tool cache with 5-minute TTL
  package.json          -- depends on @modelcontextprotocol/sdk
```

**MCPClientManager:**

```typescript
class MCPClientManager {
  // Connection lifecycle
  async connect(connection: MCPConnection): Promise<void>
  async disconnect(connectionId: string): Promise<void>
  async testConnection(connection: MCPConnection): Promise<{ success: boolean; error?: string; toolCount?: number }>

  // Tool discovery
  async discoverTools(connectionId: string): Promise<MCPTool[]>
  async getCachedTools(connectionId: string): Promise<MCPTool[]>  // returns cache or re-discovers

  // Tool execution
  async executeTool(connectionId: string, toolName: string, params: Record<string, any>): Promise<MCPResult>
}
```

**Transport factory:**
- `stdio`: Spawn process using `stdio_command` + `stdio_args`. Only available when `process.env.DEFT_SELF_HOSTED === 'true'`.
- `sse`: Connect to `server_url` via SSE transport.
- `streamable-http`: Connect to `server_url` via streamable HTTP transport.

**Connection lifecycle (warm pool):**
- Connect on first tool call, keep alive for 5 minutes of inactivity, then disconnect
- Pool connections by org — two employees using the same MCP server share one connection
- Max 3 concurrent connections per org (configurable via `MCP_MAX_CONNECTIONS_PER_ORG` env var)
- If max exceeded, queue the tool call and wait for a connection slot (30s timeout)
- Stdio: spawn process on first call, keep alive 5 minutes, then kill. Pool by command config
- Health tracking: 3 failures in 5 minutes → mark errored, backoff 10 minutes

**Error handling:**
- Connection timeout: 10 seconds
- Tool execution timeout: 30 seconds
- On failure: retry once silently. If still fails, return `{ error: 'Tool unavailable', retried: true }` — agent continues reasoning without the tool.
- Auth expiry: if 401 returned and auth_type is 'oauth', attempt token refresh from `auth_config_encrypted`. If refresh fails, mark connection as errored, notify admin via dashboard.

### 3.2 Integration into agent tool pipeline

**In `agent.ts` (tool list building, after line 190):**

```typescript
// Existing:
const tools = [...AGENT_TOOLS, ...MANAGER_TOOLS];
if (calendarConnected) tools.push(...CALENDAR_TOOLS, ...CALENDAR_ACTION_TOOLS);
if (githubConnected) tools.push(...GITHUB_TOOLS, ...GITHUB_ACTION_TOOLS);

// New:
const mcpTools = await getMCPToolsForAgent(orgId, agentEmployeeId);
tools.push(...mcpTools);
const allActionTools = new Set([...ACTION_TOOLS, ...mcpTools.filter(t => t.is_write).map(t => t.name)]);
```

**`getMCPToolsForAgent(orgId, agentEmployeeId?)`:**
1. Query active `mcp_connections` for org
2. If `agentEmployeeId`, filter by employee's `mcp_connection_ids`
3. For each connection, get cached tools (re-discover if cache > 5 min)
4. Apply `mcp_tool_overrides` (disabled tools, trust tier overrides)
5. Apply employee's `disabled_tools`
6. Convert to Anthropic tool format with prefixed names: `mcp__{connection_slug}__{tool_name}`
7. Return merged array

**Tool name prefixing:** MCP tools get prefixed to avoid collisions with native tools. E.g., Zapier's `send_email` becomes `mcp__zapier__send_email`. The agent sees descriptive names; routing strips the prefix to find connection + tool.

**In `agent-context.ts` (executeToolCall):**

Add a catch-all at the top of the switch:

```typescript
if (toolName.startsWith('mcp__')) {
  const { connectionId, actualToolName } = parseMCPToolName(toolName);
  const result = await mcpClientManager.executeTool(connectionId, actualToolName, params);
  return {
    result: result.content,
    citations: [{ type: 'mcp', id: connectionId, title: `${connectionName}: ${actualToolName}` }]
  };
}
```

**Approval routing for MCP tools:** MCP tools flow through the same `shouldAutoExecute()` from Phase 1. The trust tier is determined by:
1. `mcp_tool_overrides.trust_tier_override` (if set for this specific tool)
2. `mcp_connections.default_trust_tier` (connection-level default)
3. Falls back to `'full'` (safest default — always needs approval)

### 3.3 Settings UI: Settings > Integrations > MCP Connections

**Route:** `/settings/integrations` (new sub-page or section)

**Components:**
- **Connection list** — name, status indicator (green/red/grey), tool count, last connected, transport type
- **Add MCP Server** button → modal:
  - Name (text input)
  - Transport type (radio: SSE / Streamable HTTP / Stdio — stdio only shown if self-hosted)
  - Server URL (for SSE/streamable-http)
  - Command + Args (for stdio)
  - Auth type (radio: None / API Key / OAuth)
  - Auth config (API key input, or OAuth client ID + secret)
  - **Test Connection** button → attempts connect + tool discovery, shows result
  - Save
- **Guided setup for Zapier MCP** — pre-fills URL pattern, shows step-by-step instructions for getting Zapier MCP URL
- **Guided setup for n8n** — pre-fills URL pattern
- **Per-connection detail view:**
  - Connection health: last connected, error message, reconnect button
  - **Tool list**: each tool with name, description, toggle (enabled/disabled), trust tier dropdown (auto/quick/full)
  - Default trust tier dropdown
  - Delete connection (with confirmation)

---

## 4. Agent Employees Architecture

### 4.1 Agent employee lifecycle

**Creation flow:**

1. Admin opens Settings > Agent Employees > Create
2. Fills minimal required fields: name, role (template or custom), system prompt
3. System creates:
   a. `agent_employees` record
   b. `users` record with `is_agent: true`, `agent_employee_id` set, email nullable
   c. `org_members` record with role `'member'`
   d. `space_members` records for configured spaces (or all public spaces if none specified)
4. Agent employee is now live — appears in member lists, @mention suggestions, assignee dropdowns

**BYOA creation flow (self-hosted or SaaS with external agent):**

1. Admin opens Settings > Agent Employees > Connect External Agent
2. Fills: name, role, description of what the external agent does
3. System creates same records as above but with `is_byoa: true`
4. System generates an API key scoped to this employee (stored in `api_keys`)
5. Admin gets the API key + Deft MCP Server URL to configure in NemoClaw/OpenClaw/etc.
6. External agent connects via MCP, inherits this employee's tool scopes and trust level

### 4.2 Agent employee execution model

**Three interaction surfaces:**

**A. DM conversation (deep work):**
- User clicks agent employee in sidebar DMs → opens a DM space (type='dm')
- DM space is created on first interaction (like human DMs)
- Messages stored in `messages` table with `metadata` jsonb for agent reasoning
- Agent processing: message triggers `agent-employee-message` worker → runs `agent-runner.ts` with employee's system prompt → posts reply as a message in the DM space with metadata
- The **agent page** can also show these conversations — it queries DM spaces where the counterpart is an agent employee and renders with rich UI (expanding citations, tool call details from metadata)
- Full multi-turn context: worker loads last 20 messages from the DM space as conversation history
- Employee can do multi-turn reasoning, call many tools, produce detailed analysis

**B. @mention in channel (conversational):**
- User types `@ProjectManager` in #engineering channel
- Background worker picks up mention, routes to `agent-runner.ts` with:
  - `mode: 'background'` (respect trust level for actions)
  - `systemPromptOverride: employee.system_prompt`
  - Conversation history: last 10 messages in thread for context
- Employee responds in the same thread as a regular message (with metadata for tool calls/citations)
- If the task is complex (needs multiple tool calls or produces long output), employee responds with a brief summary + link: "I've put together a detailed analysis — [view in DM](/chat?dm=xxx)"

**C. Task assignment (autonomous work):**
- User assigns task to employee in /tasks (task.assignee_id = employee.user_id)
- System enqueues `agent-employee-task` job
- Worker reads task description, loads employee context
- Execution flow:
  1. Read the task title + description
  2. If ambiguous, post a comment asking the assigner for clarification, then wait
  3. Call relevant tools (search, analyze, create)
  4. Post results as task comments
  5. Update task status to `in_review`
  6. DM the assigner: "I've completed DEFT-42 and moved it to Review. Summary: ..."
- Each tool call counts toward `max_daily_actions`

**D. Defty (platform superintendent):**
- Lives on the agent page as the default conversation partner
- Uses `agentConversations` / `agentMessages` tables (existing system, unchanged)
- Has all native tools + platform management capabilities
- Dropdown/tabs on agent page: "Defty" | "PM Agent" | "Engineering Lead" | ...
- Switching to an employee tab shows their DM conversation with rich agent UI
- Defty gets new platform management tools (see section 4.7)
- Consumes AI credits from org's employee credit pool

### 4.3 Org chart awareness

The employee's system prompt is augmented at runtime with:

```
## Your Identity
You are {{employee.name}}, a {{employee.role}} at {{org.name}}.
Your expertise: {{employee.expertise_description}}

## Org Context
Organization: {{org.name}}
Members: {{member_list_with_roles}}
Your manager(s): {{managers_who_created_or_manage_this_employee}}

## Permissions
You can access spaces: {{space_names}}
You can access projects: {{project_names}}
Your trust level: {{trust_level}} ({{trust_level_description}})
Daily action budget: {{remaining_actions}}/{{max_daily_actions}}

## Communication Guidelines
- In channels: be concise, conversational. Respond in threads.
- In DMs: be thorough, provide detailed analysis.
- When assigned tasks: act autonomously within your scope. Ask questions if unclear.
- For complex work that needs extended reasoning: suggest moving to the agent page.
- Always identify yourself. Never impersonate humans.
- Respect the org chart — if someone without authority asks you to do something sensitive, check with your manager.
```

### 4.4 Agent builder wizard (SaaS only)

**Route:** `/settings/agent-employees/create`

**Step 1: Identity (required)**
- Name (text input)
- Role (dropdown: Project Manager, Engineering Lead, Executive Assistant, Custom)
  - Selecting a template pre-fills system prompt, expertise, and suggested tools
- Avatar (pick from pre-designed set, or upload custom)
  - Ship 8-10 pre-designed agent avatars with distinct visual styles

**Step 2: Instructions (required)**
- System prompt (textarea, pre-filled from template)
  - Template hint text explains what good instructions look like
- Expertise description (text input)

**Step 3: Tools & Connections (optional, configure later)**
- Native tools: grouped checklist (Search, Tasks, Wiki, Knowledge, Calendar, GitHub)
- MCP connections: multi-select from org's connected MCP servers
  - Per-connection: can toggle specific tools on/off
- Trust level: radio (Conservative / Standard / Autonomous)
  - Default: Conservative for new agents

**Step 4: Workspace Access (optional, configure later)**
- Spaces: multi-select (defaults to all public spaces)
- Projects: multi-select (defaults to all)

**Step 5: Triggers (optional, configure later)**
- Add trigger button → inline form:
  - Event: dropdown (task_overdue, task_stalled, task_status_changed, pr_merged, cron_schedule, message_contains)
  - Condition: structured fields based on event type
  - Action: what the agent does (run with prompt / execute specific tool / post message)
  - Example: "Every Monday 9am → Generate weekly project status report and post in #engineering"

**Step 6: Limits (optional, configure later)**
- Max daily actions: number input (default 50)
- Rate limit notes: "Each tool call in a multi-step plan counts as one action"

Minimum viable creation: Step 1 + Step 2 only. Everything else has sensible defaults.

### 4.5 Pre-built role templates

**Project Manager:**
- System prompt: Sprint tracking, blocker detection, team coordination, status reporting
- Default tools: All native read + create_task + update_task_status + assign_task + post_message
- Suggested triggers: Daily standup (9am cron), task overdue alerts, weekly digest

**Engineering Lead:**
- System prompt: Code review coordination, PR management, technical decision tracking, velocity monitoring
- Default tools: All native read + GitHub tools + update_task_status + post_message
- Suggested triggers: PR merged → update task, PR opened → notify in #engineering

**Executive Assistant:**
- System prompt: Calendar management, meeting prep, email triage, daily briefings
- Default tools: All native read + Calendar tools + post_message
- Suggested triggers: Meeting in 15min → generate prep, 8am daily → morning briefing

### 4.6 Agent employee in the UI

**Sidebar:** Agent employees appear in the DM section with a bot badge icon. Clicking opens a DM-style chat that routes through the agent engine.

**Member lists:** Agent employees show in space member lists with a distinct badge. Hovering shows "AI Agent — Project Manager" and their status (active/paused).

**@mention autocomplete:** When typing `@` in chat, agent employees appear in suggestions with their role as subtitle.

**Assignee dropdown:** In task detail, agent employees appear in the assignee dropdown with a bot badge. Assigning triggers the task execution flow.

**Agent Activity widget (dashboard):** Shows actions from all employees in one feed. Filter dropdown to select specific employee.

**Agent page layout:**
- Default tab: "Defty" — existing agent conversations via agentConversations/agentMessages
- Additional tabs: one per active agent employee — shows their DM conversation rendered with rich agent UI
- Tab shows unread indicator if employee has new messages
- Creating a new conversation: dropdown to pick Defty or a specific employee

### 4.7 Defty superintendent tools

New tools added exclusively to Defty via a `SUPERINTENDENT_TOOLS` array in `agent-tools.ts` (not available to employees, not included when conversation is with an employee):

```
manage_agent_employee    — Create, update, pause, resume, or delete an agent employee     [full tier — always needs approval]
list_agent_employees     — List all employees with status, daily action usage, last active  [auto tier — read-only]
get_agent_activity       — Get recent actions for a specific employee or all employees      [auto tier — read-only]
manage_mcp_connection    — Add, remove, test, or reconfigure MCP connections                [full tier — always needs approval]
get_agent_economics      — Token spend, action counts, credit usage per employee            [auto tier — read-only]
manage_triggers          — Create, update, or disable triggers for an employee              [quick tier — moderate impact]
```

Approval tiers are registered in `TOOL_APPROVAL_TIERS` alongside Phase 1 entries.

These tools allow Defty to be the single conversational interface for platform management. Instead of navigating Settings pages, users can say:

- "Create a PM agent called Alex that tracks sprint progress in #engineering"
- "Show me which agents ran today and how many actions they took"
- "Connect our company's n8n server at https://n8n.internal/mcp"
- "The Engineering Lead agent is posting too often, set its daily limit to 20"

Defty uses these tools to call the same API endpoints as the Settings UI — it's a conversational interface to the same CRUD operations.

---

## 5. Multi-Step Plans Architecture

### 5.1 Plan creation

When the agent determines a request requires multiple steps (or the user explicitly asks for a plan), it creates a plan instead of executing tools directly.

**New tool: `create_plan`**

Added as a **system tool** — always included for both Defty and all employees regardless of `native_tools` scoping. The agent calls this when it identifies a multi-step workflow:

```typescript
{
  name: 'create_plan',
  description: 'Create a multi-step execution plan for complex requests. Use this when the task requires 3+ sequential operations, has write actions that need approval, or involves conditional logic.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            tool: { type: 'string' },
            params: { type: 'object' },
            depends_on: { type: 'array', items: { type: 'string' } },
            condition: { type: 'object' }  // optional conditional execution
          }
        }
      }
    },
    required: ['title', 'steps']
  }
}
```

### 5.2 Plan approval UI

**In agent chat (SSE event: `plan_created`):**

```
Plan — "Prepare Sprint Review" (5 steps)

  1. ○ Search completed tasks this sprint          [read — auto]
  2. ○ Check open PRs on GitHub                    [read — auto]
  3. ○ Summarize blockers from chat                [read — auto]
  4. ○ Draft summary message                       [read — auto]
  5. ○ Post summary in #engineering                [write — needs approval]
       ↳ Condition: only if step 4 produces content

  [Approve & Execute]  [Edit Plan]  [Reject]
```

**Edit plan capabilities:**
- Drag-drop to reorder steps
- Click step to edit description, tool, params
- Delete step (with dependency check — warn if other steps depend on it)
- Add new step
- Modify conditions

### 5.3 Plan execution engine

**New module: `apps/api/src/lib/agent-plans.ts`**

```typescript
async function executePlan(planId: string, orgId: string): Promise<void> {
  // 1. Load plan from DB
  // 2. For each step (respecting order and dependencies):
  //    a. Check condition — if condition fails, skip or execute alternative
  //    b. If step is read-only: execute immediately
  //    c. If step is write AND is a dependency of later steps:
  //       - Check shouldAutoExecute()
  //       - If auto: execute, continue
  //       - If needs approval: pause plan, set status='paused', notify user
  //    d. If step is write AND NOT a dependency:
  //       - Batch into pending approval list (continue with other steps)
  //    e. Store step result in plan.context (accessible by later steps via $step.N.result)
  //    f. Update plan.current_step, step.status
  //    g. Send SSE event: plan_step_completed / plan_step_failed / plan_step_waiting
  // 3. On step failure:
  //    a. Agent reasons about alternatives using accumulated context
  //    b. If alternative found within scope: create modified step, execute
  //    c. If alternative exceeds scope: pause plan, ask human
  //    d. Log reasoning for transparency
  // 4. On completion: set plan status='completed', notify user
  // 5. Each step execution counts as 1 action toward employee's daily limit
}
```

**Step result referencing:**
Steps can reference prior results using `$step.{step_id}.result.{field_path}`:

```jsonc
{
  "description": "Assign the new task to the busiest person's backup",
  "tool": "assign_task",
  "params": {
    "task_id": "$step.create_task_1.result.task_id",
    "assignee": "$step.find_backup.result.name"
  },
  "depends_on": ["create_task_1", "find_backup"]
}
```

**Conditional branching example:**

```jsonc
{
  "description": "If blockers found, post alert in #engineering",
  "tool": "post_message",
  "params": { "space": "engineering", "content": "Blockers detected: $step.search_blockers.result" },
  "condition": {
    "step_id": "search_blockers",
    "field": "result.length",
    "operator": "gt",
    "value": 0,
    "on_false": "skip"
  }
}
```

**Alternative reasoning:**
When a step fails, the plan engine:
1. Loads the plan context + failed step + error
2. Calls agent-runner with a focused prompt: "Step N failed with error X. Given the plan goal and completed steps, what's an alternative approach? If the alternative is within the plan's scope, describe the replacement step. If it requires fundamentally different actions, say ESCALATE."
3. If agent returns a replacement step: insert it, execute
4. If agent says ESCALATE: pause plan, present to user with the agent's reasoning

### 5.4 Plan SSE events

New event types added to the streaming endpoint:

```
{ type: 'plan_created', plan: { id, title, steps } }
{ type: 'plan_step_started', planId, stepId, description }
{ type: 'plan_step_completed', planId, stepId, result }
{ type: 'plan_step_failed', planId, stepId, error }
{ type: 'plan_step_skipped', planId, stepId, reason }
{ type: 'plan_step_waiting', planId, stepId, reason: 'approval_required' }
{ type: 'plan_paused', planId, reason }
{ type: 'plan_completed', planId, summary }
{ type: 'plan_alternative', planId, stepId, original, alternative, reasoning }
{ type: 'plan_resuming', planId, countdown: 10 }
```

### 5.5 Plan resumption flow

When a plan pauses because a write step needs approval:

1. User approves the pending action via approve button
2. UI shows "Resuming plan in 10s..." countdown with a [Pause] button
3. If user doesn't pause within 10 seconds → plan auto-resumes from next step
4. If user clicks Pause → plan stays in `paused` status until manual Resume

For batch approvals (multiple non-blocking writes batched together):
- Approving the batch auto-resumes immediately (no countdown — user already reviewed everything)

SSE flow: `plan_step_waiting` → user approves → `plan_resuming` (countdown: 10) → `plan_step_started` (next step)

---

## 6. Deft MCP Server

### 6.1 Architecture

A standalone MCP server that external agents connect to. Runs as part of the Deft API process (not a separate service).

**Route prefix:** `/mcp` on the existing Hono API.

**Transport:** Streamable HTTP (standard for web-hosted MCP servers). SSE fallback for older clients.

**Authentication:** Bearer token in `Authorization` header. Token is an API key from `api_keys` table.

### 6.2 Exposed tools

Subset of native tools, scoped by the API key's `permissions` and the linked agent employee's tool scopes:

**Read tools (default exposed):**
- `deft_search_tasks` — Search tasks by query, status, priority, assignee
- `deft_get_task` — Get full task detail
- `deft_search_messages` — Search messages by query, space, author
- `deft_search_knowledge` — Search knowledge entries
- `deft_wiki_search` — Search wiki
- `deft_wiki_read` — Read wiki page
- `deft_get_project_progress` — Project completion and status
- `deft_get_team_workload` — Task distribution across team

**Write tools (requires explicit permission):**
- `deft_create_task` — Create task (flows through approval pipeline)
- `deft_update_task_status` — Update task status
- `deft_assign_task` — Assign task
- `deft_post_message` — Post in a space
- `deft_add_knowledge` — Add knowledge entry
- `deft_wiki_write` — Create/update wiki page

**Not exposed (privacy):**
- All manager-only tools (burnout, team health, 1:1 prep)
- Agent memory tools
- People analytics tools

**MCP tool proxying:** If the API key's linked agent employee has `mcp_connection_ids`, the Deft MCP server can also proxy those MCP connections' tools. The external agent sees them as `deft_mcp__{connection}__{tool}`. This means NemoClaw connecting to Deft can also use Deft's Zapier connection — configurable per employee in the wizard.

### 6.3 Request flow

```
External Agent (NemoClaw) → HTTP POST /mcp → Authenticate (API key) →
  Resolve agent_employee from api_key.agent_employee_id →
  Check tool permissions (api_key.permissions ∩ employee.native_tools) →
  Check rate limits (api_key.rate_limit_per_minute, per_day) →
  Execute tool via executeToolCall() or mcpClientManager.executeTool() →
  Log to agentActions with agent_employee_id + source →
  Return MCP response
```

Write actions follow the same approval pipeline:
- Check `shouldAutoExecute(tool, employee.trust_level)`
- If auto: execute, return result
- If needs approval: create pending agentAction, return `{ status: 'pending_approval', action_id }`
- External agent can poll `GET /mcp/actions/:id/status` to check approval state

### 6.4 Settings UI: Settings > API Access

**Route:** `/settings/api-access`

**Components:**
- **API key list** — name, key prefix (`deft_abc1...`), linked employee, last used, request count, status toggle
- **Create API Key** button → modal:
  - Name (text input)
  - Link to Agent Employee (dropdown — required for scoped access)
  - Permissions (tool checklist — pre-filled from employee's tool scopes)
  - Rate limits (requests/minute, requests/day)
  - Expiration (optional)
  - **Generate Key** → shows full key ONCE, user must copy
- **Per-key detail:** usage stats, last 50 requests log, regenerate, revoke

---

## 7. API Endpoints

### 7.1 MCP Connections

```
POST   /api/mcp-connections                    Create connection
GET    /api/mcp-connections                    List org's connections
GET    /api/mcp-connections/:id                Get connection + tools
PUT    /api/mcp-connections/:id                Update connection
DELETE /api/mcp-connections/:id                Delete connection
POST   /api/mcp-connections/:id/test           Test connection (connect + discover)
POST   /api/mcp-connections/:id/refresh-tools  Re-discover tools
PUT    /api/mcp-connections/:id/tools/:name    Override tool trust tier or disable
```

### 7.2 Agent Employees

```
POST   /api/agent-employees                    Create employee
GET    /api/agent-employees                    List org's employees
GET    /api/agent-employees/:id                Get employee detail
PUT    /api/agent-employees/:id                Update employee config
DELETE /api/agent-employees/:id                Delete employee (deactivates user)
POST   /api/agent-employees/:id/pause          Pause employee
POST   /api/agent-employees/:id/resume         Resume employee
GET    /api/agent-employees/:id/activity       Get employee's action log
GET    /api/agent-employees/templates          Get pre-built role templates
```

### 7.3 Agent Plans

```
POST   /api/agent-plans                        Create plan (usually from agent tool call)
GET    /api/agent-plans/:id                    Get plan detail
PUT    /api/agent-plans/:id                    Edit plan (reorder, modify steps)
POST   /api/agent-plans/:id/approve            Approve plan for execution
POST   /api/agent-plans/:id/execute            Start execution
POST   /api/agent-plans/:id/pause              Pause mid-execution
POST   /api/agent-plans/:id/resume             Resume paused plan
POST   /api/agent-plans/:id/abort              Cancel plan
GET    /api/agent-plans                        List plans (filter by status, employee)
```

### 7.4 API Keys (Deft MCP Server)

```
POST   /api/api-keys                           Create API key
GET    /api/api-keys                           List org's keys
GET    /api/api-keys/:id                       Get key detail + usage
PUT    /api/api-keys/:id                       Update key (permissions, limits)
DELETE /api/api-keys/:id                       Revoke key
GET    /api/api-keys/:id/usage                 Usage stats
```

### 7.5 Deft MCP Server

```
POST   /mcp                                    MCP protocol endpoint (streamable-http)
GET    /mcp/sse                                MCP SSE fallback endpoint
GET    /mcp/actions/:id/status                 Poll action approval status (for external agents)
```

---

## 8. Worker Changes

### 8.1 New workers

**`agent-employee-task`** — Handles task assignment to agent employees
- Triggered when: task.assignee_id changes to an agent employee's user_id
- Flow: Read task → reason about what's needed → call tools → post results as comments → update status to in_review → DM assigner

**`agent-employee-message`** — Handles both DMs to and @mentions of agent employees
- Triggered when: new message in a DM space with an agent employee, OR message contains @{employee_slug} or @{employee_name} in a channel
- DM flow: Load last 20 messages from DM space → run agent-runner with employee's system prompt → post reply in DM space with metadata
- @mention flow: Load last 10 messages in thread → run agent-runner with employee's system prompt → post reply in thread with metadata
- If response is long/complex: post summary + link: "View full analysis in DM"

**`agent-employee-trigger`** — Evaluates and fires agent employee triggers
- Triggered when: relevant events occur (task_overdue, task_stalled, pr_merged, cron)
- Flow: Check condition → run agent-runner with trigger's prompt → execute actions

**`plan-executor`** — Runs plan steps in sequence
- Triggered when: plan.status changes to 'executing'
- Flow: Execute steps per plan execution engine logic (section 5.3)

**`agent-daily-reset`** — Resets daily action counters
- Cron: every day at midnight UTC
- Flow: UPDATE agent_employees SET daily_action_count = 0, daily_action_reset_at = now()

### 8.2 Modified workers

**`agent-reply`** — Currently handles @agent/@deft mentions. Stays as-is for Defty routing (@agent/@deft → Defty). The message processing pipeline separately detects employee @mentions (by slug/name) and DM messages to agent users, enqueuing those to `agent-employee-message` instead. No overlap — Defty and employee mention detection are distinct checks.

---

## 9. Self-Hosted vs SaaS Feature Gates

| Feature | SaaS | Self-Hosted |
|---------|------|-------------|
| MCP Client (connect to external servers) | All transports | All transports (stdio native) |
| Agent Builder Wizard | Yes | No |
| Pre-built role templates | Yes | No |
| BYOA (connect external agents) | Yes | Yes |
| Deft MCP Server | Yes | Yes |
| Agent employee user accounts | Yes (wizard-created) | Yes (BYOA-created only) |
| API key management | Yes | Yes |
| Trust level enforcement | Yes | Yes |
| Multi-step plans | Yes | Yes |

Gate mechanism: check `process.env.DEFT_SELF_HOSTED === 'true'`. When true:
- Settings > Agent Employees shows "Connect External Agent" only (no "Create Agent Employee")
- Role template endpoint returns empty
- Agent builder wizard routes redirect to BYOA setup

---

## 10. Cross-Layer Integration Points

### 10.1 Agent employee + MCP tools

When an agent employee executes, its available tools are:
1. Native tools filtered by `native_tools` (NULL = all)
2. MCP tools from connections in `mcp_connection_ids`
3. Minus `disabled_tools`
4. All filtered through the employee's `trust_level`

### 10.2 Plans + Agent employees

Plans can be created by any agent employee. The plan's `agent_employee_id` determines:
- Which tools are available for plan steps
- Which trust level governs auto-execution
- Which daily action budget is decremented (each step = 1 action)

### 10.3 Deft MCP Server + Agent employees

External agents connect as specific employees. Their API key links to an `agent_employee_id`. All actions through the MCP server:
- Are scoped to that employee's tool access
- Flow through that employee's trust level
- Count toward that employee's daily action budget
- Are attributed to that employee in the Action Log and Activity feed

### 10.4 Dashboard integration

The existing Agent Activity widget (Phase 1) is extended:
- Shows actions from all agent employees
- Filter dropdown: "All Agents" / specific employee names
- Each action card shows: employee avatar + name, action type, target, status, timestamp
- Pending approvals section: batched across all employees

### 10.5 Rate limiting enforcement

**Per agent employee:**
- `max_daily_actions` checked before every tool execution (in executeToolCall and executeMCPTool)
- **Counting:** Each tool call = 1 action. Each plan step = 1 action (regardless of internal retries or alternative reasoning within that step). `create_plan` itself does not count — only step executions do.
- When limit reached: agent responds "I've reached my daily action limit (50/50). Please ask an admin to increase my limit or wait until tomorrow."
- Plan execution pauses: "Plan paused — daily action limit reached. Will resume tomorrow."

**Per API key (Deft MCP Server):**
- Per-minute: sliding window counter in memory (Redis if available, in-process Map otherwise)
- Per-day: counter in `api_keys.request_count`, reset daily
- When limited: return MCP error with `retry_after` header

---

## 11. Potential Conflicts & Resolutions

### 11.1 Tool name collisions

**Risk:** Native tool `search_tasks` could collide with an MCP tool named `search_tasks`.
**Resolution:** MCP tools are always prefixed: `mcp__{connection_slug}__{tool_name}`. Native tools are never prefixed. No collision possible.

### 11.2 Approval pipeline contention

**Risk:** Multiple agent employees generating pending actions simultaneously. User overwhelmed with approval requests.
**Resolution:** Dashboard pending approvals widget batches all pending actions with employee attribution. Actions can be bulk-approved/rejected per employee. Agent employees with `trust_level: 'autonomous'` auto-execute most actions (only `full` tier needs approval).

### 11.3 Circular agent mentions

**Risk:** Agent A @mentions Agent B, which triggers Agent B to respond, which triggers Agent A...
**Resolution:** Agent employees cannot @mention other agent employees. Agent-to-agent delegation is Phase 6 (Multi-Agent Orchestration) with explicit loop detection. For now, agent responses are never processed as triggers for other agents.

### 11.4 Plan + live conversation conflict

**Risk:** User edits a plan while execution is in progress.
**Resolution:** Plans must be paused before editing. If a plan is `executing`, the Edit button shows "Pause to Edit". No concurrent modification.

### 11.5 MCP connection goes down mid-conversation

**Risk:** Agent is mid-reasoning, MCP server becomes unreachable.
**Resolution:** MCP tool execution has 30-second timeout + 1 silent retry. On final failure, tool returns `{ error: 'MCP server unavailable' }` — agent sees this as a tool result and adjusts its reasoning (same as any tool returning an error). Plan steps with MCP tools: same failure → alternative reasoning flow.

### 11.6 Self-hosted stdio security

**Risk:** Stdio transport spawns arbitrary processes on the server.
**Resolution:** Only available when `DEFT_SELF_HOSTED=true`. Self-hosted users control their own server. SaaS deployment never allows stdio (transport validation at connection creation time).

### 11.7 Agent employee deletion with pending actions

**Risk:** Admin deletes agent employee that has pending actions or running plans.
**Resolution:** Soft delete: set `is_active: false` on agent_employee AND user account. Pending actions are expired. Running plans are aborted. Agent removed from member lists and @mention suggestions. Action history preserved for audit.

### 11.8 Token budget for agent employees

**Risk:** Agent employee on background task runs up token costs unbounded.
**Resolution:** agent-runner.ts already has 8-iteration limit. Combined with `max_daily_actions` (each tool call = 1 action), an employee with 50 daily actions can use at most 50 * 8 iterations * 200k tokens theoretical max. Practically much lower. Future: add per-employee token budget column.

### 11.9 MCP auth token refresh

**Risk:** OAuth-based MCP connections have tokens that expire.
**Resolution:** On 401 from MCP server, attempt refresh using stored refresh token in `auth_config_encrypted`. If refresh succeeds, update stored tokens, retry original call. If refresh fails, mark connection as errored (`connection_error = 'Auth expired — reconnect required'`), disable connection, notify admin via dashboard.

### 11.10 Race condition on daily action counter

**Risk:** Concurrent tool calls increment `daily_action_count` incorrectly.
**Resolution:** Use atomic SQL: `UPDATE agent_employees SET daily_action_count = daily_action_count + 1 WHERE id = $1 AND daily_action_count < max_daily_actions RETURNING daily_action_count`. If no row returned, limit reached.

---

## 12. Summary of Files to Create/Modify

### New Files

```
packages/mcp/src/client.ts                              MCP client manager
packages/mcp/src/transports.ts                          Transport factory
packages/mcp/src/types.ts                               Type definitions
packages/mcp/src/cache.ts                               Tool cache
packages/mcp/package.json                               Package config

apps/api/src/routes/mcp-connections.ts                  MCP connection CRUD
apps/api/src/routes/mcp-server.ts                       Deft MCP server endpoint
apps/api/src/routes/agent-employees.ts                  Employee CRUD
apps/api/src/routes/agent-plans.ts                      Plan CRUD + execution
apps/api/src/routes/api-keys.ts                         API key management
apps/api/src/lib/agent-plans.ts                         Plan execution engine
apps/api/src/lib/mcp-tools.ts                           getMCPToolsForAgent, parseMCPToolName
apps/api/src/workers/handlers/agent-employee-task.ts    Task assignment handler
apps/api/src/workers/handlers/agent-employee-message.ts DM + @mention handler
apps/api/src/workers/handlers/agent-employee-trigger.ts Trigger evaluation
apps/api/src/workers/handlers/plan-executor.ts          Plan step execution
apps/api/src/workers/handlers/agent-daily-reset.ts      Daily counter reset

apps/web/src/app/(app)/settings/integrations/page.tsx   MCP connections UI
apps/web/src/app/(app)/settings/agent-employees/page.tsx Employee list + wizard
apps/web/src/app/(app)/settings/api-access/page.tsx     API key management
apps/web/src/components/agent-employee-wizard.tsx        Creation wizard
apps/web/src/components/plan-approval.tsx                Plan approval/edit UI
apps/web/src/components/plan-progress.tsx                Plan execution progress
apps/web/src/components/mcp-connection-form.tsx          Add/edit MCP connection

packages/db/src/migrations/XXXX_mcp_and_agents.ts       Schema migration
```

### Modified Files

```
packages/db/src/schema.ts                               New tables + enums + user/agentActions columns
apps/api/src/routes/agent.ts                            MCP tool merging, employee context, plan events
apps/api/src/lib/agent-context.ts                       MCP tool routing in executeToolCall
apps/api/src/lib/agent-tools.ts                         Add create_plan tool + SUPERINTENDENT_TOOLS array
apps/api/src/lib/agent-runner.ts                        Employee context injection, action counting
apps/api/src/lib/agent-actions.ts                       Employee attribution, MCP source tracking
apps/api/src/lib/agent-approval.ts                      MCP tool approval tier resolution
apps/api/src/workers/index.ts                           Register new workers
apps/api/src/index.ts                                   Mount new route files
apps/web/src/components/sidebar.tsx                     Agent employee DM entries
apps/web/src/components/space-chat.tsx                   @mention autocomplete for employees
apps/web/src/components/task-detail.tsx                  Agent employees in assignee dropdown
apps/web/src/app/(app)/dashboard/page.tsx               Employee filter on activity widget
apps/web/src/app/(app)/settings/page.tsx                New settings nav links
```
