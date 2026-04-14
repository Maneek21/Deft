# Deft Agentic Vision — Spec & Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Phases 0 and 1 are manual-only — subagents cannot run Docker, observe empirical outcomes, or make architectural decisions. Subagent dispatch begins at Phase 2, only after Phase 1 outcomes are recorded in §18.**

**Revision:** 2026-04-14 rev 2 — incorporates critical fixes C1-C7, important fixes I1-I8, and research-derived critical patches NC1-NC4 from the second research pass. See §19 for change log.

**Goal:** Keep Defty as the native, direct-SQL generalist agent. Move all role-specific agent employees (PM, Designer, CFO, QA, etc.) onto user-deployed OpenClaw runtimes. Make Deft the shared memory, governance, and workspace layer that every agent — native or external — plugs into via MCP.

**Architecture:** Two-surface agent model: (a) Defty runs in-process with direct SQL access, unchanged, the demo centerpiece; (b) Employees run as OpenClaw agents on user-controlled VPSes, connecting back to Deft through a new MCP server that exposes the wiki as typed memory, tasks as action tools, and approval-gated write operations. **Dynamic per-turn context flows through a `platform_context` MCP tool called by the agent at turn start, not through request-body system prompts — OpenClaw owns the system prompt assembly and does not merge client-supplied system messages.** All triggers (cron, chat @mention, webhook, DB event) stay in Deft's job queue and dispatch to employees via `/v1/chat/completions` with `model: openclaw/<slug>` routing (confirmed supported). Audit receipts, template marketplace, and session inspector are adapted from Mission Control's MIT-licensed codebase.

**Tech Stack:** TypeScript (Hono API, Next.js 16 App Router), PostgreSQL + Drizzle + tsvector FTS + pgvector (new), BullMQ-on-Postgres job queue, Socket.io, MCP streamable-http, OpenClaw Docker (external, ghcr.io/openclaw/openclaw:latest pinned), Anthropic SDK, Claude Opus 4.6 (Defty native) / Claude Sonnet 4.6 (OpenClaw employee default, BYOK) / Opus opt-in for high-stakes employee roles.

**Target demo date:** 2026-04-28 (two weeks). **Realistic effort:** 50-85 working hours or 8-14 working days. The "4 days MVP" estimate from yesterday's rev 1 was optimistic and has been removed. MVP must demo: Defty unchanged, one deployed OpenClaw Alex PM employee replying in chat, wiki memory being read/written across both agents, audit receipts visible on Settings → Agent, DigitalOcean one-click deploy path working end-to-end.

---

## 0. Vision & Positioning

### What Deft is

Deft is **the workspace where agent teams live**. It ships one native agent (Defty) with direct SQL access to the team's data, and orchestrates N role-specific "employee" agents as OpenClaw deployments on user infrastructure. All agents — native and external — share one memory: Deft's typed knowledge wiki. Humans and agents collaborate in the same chat, tasks, calendar, and wiki surface. The workspace is the moat.

### What Deft is not

- **Not a chatbot sidebar** (we have a full workspace)
- **Not a pure agent framework** (OpenClaw does that job better)
- **Not a governance-only operations console** (Mission Control is in that lane)
- **Not a vector-memory-as-a-service** (MemOS/memU/Mem0 are in that lane)
- **Not trying to own the full agent runtime** (OpenClaw v4.0 will out-ship us on runtime features, and that's fine)

### The three-surface pitch

| Surface | What it is | Who owns it |
|---|---|---|
| **Defty** | Native agent, direct SQL, workspace-aware, the demo generalist | **Deft** (runs in `apps/api` process) |
| **Employees** | Role-specific personas (PM, Designer, CFO, QA, Customer Success, etc.) | **User** (deployed on their VPS via OpenClaw) |
| **Shared brain** | Typed knowledge wiki + task state + space memory + member roster | **Deft** (exposed via MCP server) |

Defty and employees share the brain. Employees are portable and BYOK. The workspace is where the team and the agents actually work.

### Default deployment model

**One Gateway per org** with N employees in the Gateway's `agents.list[]`. All agents share one top-level `mcp.servers.deft` bearer token (per-agent MCP override is **not supported** by OpenClaw per `docs.openclaw.ai/cli/mcp`). Employee-level scoping is enforced at Deft's MCP server by requiring a `caller_employee_slug` parameter on every tool call, validated against the Gateway's registered employee set.

**Strict-isolation mode (advanced):** one Gateway per employee, each with its own Deft MCP bearer token. Costs $12 × N per month on DigitalOcean, offered as an opt-in for customers who need hard cross-employee isolation.

### Pricing implication

- **Deft Workspace:** $3/month/user — chat, tasks, wiki, calendar, Defty. Deft pays Anthropic for Defty.
- **Agent Employees:** free from Deft (BYOK on the user side). User deploys OpenClaw on their VPS, pays their own Anthropic/OpenAI bill, plugs into Deft via MCP.
- **Deft Cloud (v1.1):** optional managed OpenClaw hosting tier for users who don't want to run a VPS. Add-on at cost-plus-margin. Deferred to v1.1.

---

## 1. Architecture diagram (end-to-end)

*Final state after multiple deploys — the wizard ships one employee at a time, subsequent deploys extend the same `agents.list[]`.*

```
┌────────────────────────────── Deft API (Hono) ──────────────────────────────┐
│                                                                             │
│  ┌────────────────────┐   ┌─────────────────────────┐                       │
│  │ Defty (native)     │   │ /api/mcp/v1 (NEW)       │                       │
│  │ agent-runner.ts    │   │                         │                       │
│  │ direct SQL tools   │   │ Tools (bearer + slug    │                       │
│  │ unchanged          │   │ self-identification):   │                       │
│  └────────────────────┘   │  - platform_context     │                       │
│          ▲                │  - memory_recall        │                       │
│          │                │  - memory_write         │                       │
│          │ shares         │  - memory_update        │                       │
│          │ wiki           │  - memory_list          │                       │
│          ▼                │  - task_query           │                       │
│  ┌────────────────────┐   │  - task_create  (gated) │                       │
│  │ wiki_pages +       │◄──│  - task_update  (gated) │                       │
│  │ agent_memory +     │   │  - message_post (gated) │                       │
│  │ tasks + messages   │   │  - thread_fetch         │                       │
│  │ space_memory +     │   │  - member_list          │                       │
│  │ action_receipts    │   │  - space_memory_get     │                       │
│  │ (Postgres + FTS    │   │  - space_memory_set     │                       │
│  │  + pgvector)       │   │  - delegation_self_report│                      │
│  └────────────────────┘   └──────────┬──────────────┘                       │
│          ▲                           │                                     │
│          │                           │ HTTP (streamable-http MCP)          │
│          │                           ▼                                     │
│  ┌────────────────────┐  ┌────────────────────┐                            │
│  │agent-employee-     │  │employee-trigger.ts │                            │
│  │message.ts          │  │(new worker)        │                            │
│  │(@mentions in chat) │  │(cron/event/webhook)│                            │
│  └────────┬───────────┘  └─────────┬──────────┘                            │
│           │                        │                                       │
│           └──────────┬─────────────┘                                       │
│                      │                                                      │
│                      │ POST /v1/chat/completions (SSE, model: openclaw/<slug>)
│                      │                                                      │
└──────────────────────┼──────────────────────────────────────────────────────┘
                       │
                       │  over public HTTPS, Bearer = Gateway token
                       │
                       ▼
┌──────────── User's VPS (DigitalOcean / Hostinger / Railway / self-host) ───┐
│                                                                             │
│  OpenClaw Gateway :18789                                                    │
│  ├─ mcp.servers.deft → single bearer, shared by all agents                  │
│  ├─ agents.list[]                                                           │
│  │   ├─ alex-pm    (Claude Sonnet 4.6, SOUL.md, AGENTS.md, USER.md, TOOLS.md)│
│  │   ├─ designer   (Claude Sonnet 4.6, SOUL.md, AGENTS.md, USER.md, TOOLS.md)│
│  │   ├─ cfo        (Claude Opus 4.6,   SOUL.md, AGENTS.md, USER.md, TOOLS.md)│  // Opus opt-in for finance
│  │   └─ qa         (Claude Sonnet 4.6, SOUL.md, AGENTS.md, USER.md, TOOLS.md)│
│  ├─ plugins.slots.memory = "none"  (Deft wiki is sole memory source)        │
│  ├─ tools.agentToAgent.enabled = true  (sessions_send cross-employee)       │
│  └─ channels = {}  (Deft is the only inbound surface)                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Message flow: user types `@Alex PM draft this week's roadmap` in `#general`

1. Web client → socket.io → `apps/api/src/routes/messages.ts` POST
2. Insert message, `parseMentions` extracts Alex PM's user_id, enqueue `agent-employee-message` job
3. Worker looks up employee. If `kind = 'native'` → existing `runAgentQuery` path (unchanged). If `kind = 'openclaw'` → new `openclaw-chat-envelope.ts`:
   a. Builds thread context (parent + last 10 replies + trigger message)
   b. POSTs to `<connection_url>/v1/chat/completions` with `model: openclaw/alex-pm`, `stream: true`, bearer = Gateway token. **No dynamic system message** — OpenClaw owns the prompt assembly; dynamic context is retrieved by the agent via tool call (step 5).
4. OpenClaw Gateway routes to the `alex-pm` agent, calls Claude Sonnet 4.6 with the employee's configured tools (Sonnet is the default for cost; Opus is opt-in per role)
5. Agent's **first tool call (always)**: `deft_platform_context({caller_employee_slug: "alex-pm", trigger: {kind: "chat_mention", space_id: "general"}})`. Deft's MCP server returns a JSON blob: current date, org name, employee role + trust level, teammate roster, top 3-5 wiki snippets via FTS+pgvector hybrid search, trigger context. The agent's `AGENTS.md` file instructs it to call this first on every turn.
6. Agent proceeds with additional tool calls as needed: `deft_memory_recall`, `deft_task_query`, etc. Each carries `caller_employee_slug` for Deft-side scoping enforcement.
7. Agent finalizes reply → SSE stream back to Deft worker
8. Worker parses stream, backfills `@Name` → `<@uuid|Name>` pill syntax, inserts new `messages` row with `user_id = employee.user_id, parent_id = trigger.id`
9. Socket emit `message:new` → web clients render in-thread
10. Worker writes an `agent_session_turns` row capturing input/output/latency for the session inspector

### Message flow: 9am daily standup trigger

1. Deft's `scheduled-jobs` queue fires `standup-generate` cron job
2. Handler checks: does any employee in this org subscribe to `cron:standup`? If yes:
3. Enqueue `employee-trigger` job with `{employee_id, trigger_kind: 'cron:standup', goal: 'Generate today's team standup and post it in #general', context: {yesterday_activity}}`
4. `employee-trigger.ts` worker packages as synthetic chat-completion call — the trigger description is the user-role message, there's no real chat trigger
5. Agent runs loop: calls `deft_platform_context` first, then `deft_task_query` for yesterday's activity, then `deft_message_post({space_id: 'general', content: standup_text})` as its final action
6. `message_post` routes through approval gating (auto-execute if trust_level ≥ standard), generates an `action_receipt`, inserts message, broadcasts

---

## 2. Data model changes

All changes in `packages/db/src/schema.ts` + seven new migration files.

### 2.1 `agent_employees` — new columns

```ts
kind: text('kind').$type<'native' | 'openclaw' | 'claude_sdk' | 'custom_mcp'>()
  .default('openclaw').notNull(),
connection_url: text('connection_url'),                   // e.g. https://vps:18789
gateway_token_encrypted: text('gateway_token_encrypted'),  // AES-GCM via env.ENCRYPTION_KEY — Deft REPLAYS this calling Gateway
mcp_token_hash: text('mcp_token_hash'),                   // bcrypt — Gateway presents this TO Deft, compared not replayed
connection_status: text('connection_status').$type<'pending' | 'connected' | 'error' | 'revoked'>()
  .default('pending').notNull(),
template_slug: text('template_slug'),                     // which template was used
template_version: text('template_version'),               // for upgrade prompts
trigger_subscriptions: text('trigger_subscriptions').array(),
  // one employee per (org_id, trigger_kind) — enforced by unique partial index
provider_hint: text('provider_hint'),                     // 'digitalocean' | 'hostinger' | 'railway' | 'byo'
```

**C1 fix:** `gateway_token_encrypted` is AES-GCM encrypted at rest (using `env.ENCRYPTION_KEY` per the existing `mcp_connections.encrypted_credentials` pattern) and decrypted at send time. It **cannot** be bcrypt-hashed because Deft needs to replay the raw token in the `Authorization: Bearer` header when calling out to OpenClaw. `mcp_token_hash` is correctly bcrypt because the flow is inverted — OpenClaw presents it and Deft compares.

**I8 fix:** add a partial unique index to enforce one employee per `(org_id, trigger_kind)`:
```sql
CREATE UNIQUE INDEX agent_employees_trigger_subscription_unique
  ON agent_employees ((unnest(trigger_subscriptions)), org_id)
  WHERE is_active = true;
```
(If partial GIN index is awkward, enforce at application level with a uniqueness check inside `enqueueEmployeeTrigger`.)

Existing columns that stop being load-bearing when `kind !== 'native'` (keep in schema for native Alex PM seed):
`system_prompt`, `native_tools`, `mcp_connection_ids`, `disabled_tools` — these become UI templates, the external agent owns its real config.

### 2.2 New tables

**`agent_employee_templates`** — the template marketplace:
```ts
export const agentEmployeeTemplates = pgTable('agent_employee_templates', {
  ...id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  version: text('version').notNull(),                      // semver validated at insert via Zod /^\d+\.\d+\.\d+$/
  role: agentEmployeeRoleEnum('role').notNull(),
  description: text('description').notNull(),
  soul_md: text('soul_md').notNull(),                      // SOUL.md — role + personality
  agents_md: text('agents_md').notNull(),                  // AGENTS.md — tool conventions + approval rules + call platform_context first
  user_md_template: text('user_md_template').notNull(),    // USER.md template (handlebars), rendered per-org
  tools_md: text('tools_md').notNull(),                    // TOOLS.md — full Deft MCP tool descriptions with examples
  default_tools: text('default_tools').array().notNull(),
  default_trust_level: trustLevelEnum('default_trust_level').default('standard').notNull(),
  default_trigger_subscriptions: text('default_trigger_subscriptions').array(),
  model_recommendation: text('model_recommendation').notNull(),
  fallback_models: text('fallback_models').array(),
  source: text('source').$type<'first-party' | 'community' | 'user'>().default('first-party').notNull(),
  source_attribution: text('source_attribution'),
  download_count: integer('download_count').default(0).notNull(),
  is_public: boolean('is_public').default(true).notNull(),
  created_by: text('created_by').references(() => users.id),
  ...timestamps(),
});
```

**NC3 fix:** Templates hold **four** bootstrap files (SOUL.md, AGENTS.md, USER.md, TOOLS.md), not three, because OpenClaw assembles its system prompt from 8 workspace files and the four Deft-generated ones cover role, conventions, roster, and tool docs. The other four (`IDENTITY.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `MEMORY.md`) are OpenClaw-managed and we don't write them.

**`agent_session_turns`** — session inspector data:
```ts
export const agentSessionTurns = pgTable('agent_session_turns', {
  ...id(),
  ...orgId(),
  employee_id: text('employee_id').notNull().references(() => agentEmployees.id),
  trigger_kind: text('trigger_kind').notNull(),
  triggering_message_id: text('triggering_message_id'),
  space_id: text('space_id'),
  input_messages_json: jsonb('input_messages_json').notNull(),
  raw_reply_text: text('raw_reply_text'),
  tool_calls_json: jsonb('tool_calls_json'),
  latency_ms: integer('latency_ms').notNull(),
  model_name: text('model_name'),                   // e.g. 'anthropic/claude-opus-4-6' — for cost lookup at display time
  tokens_in: integer('tokens_in'),
  tokens_out: integer('tokens_out'),
  // M9 fix: cost is computed on-read via model_pricing table, not stored per-row
  result: text('result').$type<'success' | 'timeout' | 'error' | 'rejected_approval'>().notNull(),
  error: text('error'),
  ...timestamps(),
}, (t) => [
  index('ast_employee_idx').on(t.employee_id, t.created_at),
  index('ast_org_idx').on(t.org_id, t.created_at),
]);
```

**M9 fix:** dropped `cost_usd_microcents` — cost is computed at display time using `{model_name, tokens_in, tokens_out}` against a `model_pricing` lookup table. Upgradeable to immutable `cost_snapshot_microcents` later if billing-grade audit is needed.

**`action_receipts`** — elevated action log with HMAC-signed receipts (ported from Mission Control, MIT):
```ts
export const actionReceipts = pgTable('action_receipts', {
  ...id(),
  ...orgId(),
  action_id: text('action_id').notNull(),            // FK verified in Phase 0 (could be agent_actions or agent_action_log)
  employee_id: text('employee_id').references(() => agentEmployees.id),
  proposer: text('proposer').$type<'defty' | 'employee' | 'user' | 'cron'>().notNull(),
  proposer_id: text('proposer_id'),
  approver_id: text('approver_id').references(() => users.id),
  decision: text('decision').$type<'auto_executed' | 'approved' | 'rejected' | 'expired'>().notNull(),
  decision_reason: text('decision_reason'),
  action_name: text('action_name').notNull(),
  action_params_json: jsonb('action_params_json').notNull(),
  result_json: jsonb('result_json'),
  signature_hmac: text('signature_hmac').notNull(),
  signed_at: timestamp('signed_at').defaultNow().notNull(),
  ...timestamps(),
}, (t) => [
  index('receipt_org_idx').on(t.org_id, t.created_at),
  index('receipt_action_idx').on(t.action_id),
]);
```

**C6 fix:** `action_id` is a plain `text` column, **not** a foreign key reference to `agentActions`, because we haven't yet verified the existing action-log table's name. Phase 0 step 0.5 runs a grep to confirm the table name before deciding whether to add the FK constraint. If the column is named `agent_action_log.id` or similar, we add the FK in a follow-up migration.

**`space_memory`** — per-channel KV (adapted from Mission Control's board memory concept, MIT):
```ts
export const spaceMemory = pgTable('space_memory', {
  ...id(),
  ...orgId(),
  space_id: text('space_id').notNull().references(() => spaces.id),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
  updated_by_employee_id: text('updated_by_employee_id').references(() => agentEmployees.id),
  ...timestamps(),
}, (t) => [
  uniqueIndex('space_memory_key_unique').on(t.space_id, t.key),
]);
```

### 2.3 Existing tables — extend

**`wiki_pages`** — add pgvector column for hybrid search:
```ts
+ embedding: vector('embedding', { dimensions: 1536 }),
```

### 2.4 Migrations

- `packages/db/drizzle/0006_agent_employee_openclaw.sql` — employee column additions (including `gateway_token_encrypted`) + UPDATE existing Alex PM row to `kind='native'`
- `packages/db/drizzle/0007_agent_session_turns.sql`
- `packages/db/drizzle/0008_action_receipts.sql` — backfill existing action-log rows
- `packages/db/drizzle/0009_agent_employee_templates.sql` — empty schema only; seed rows in migration 0012
- `packages/db/drizzle/0010_space_memory.sql`
- `packages/db/drizzle/0011_wiki_pages_embedding.sql` — `CREATE EXTENSION IF NOT EXISTS vector;` + column + ivfflat index
- `packages/db/drizzle/0012_seed_templates.sql` — Phase 9 adds 8 first-party template rows

---

## 3. MCP server spec — `apps/api/src/routes/mcp-server.ts`

New Hono sub-router mounted at `/api/mcp/v1` implementing MCP streamable-http transport.

### 3.1 Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/mcp/v1/initialize` | MCP handshake, returns `serverInfo + capabilities` |
| `POST` | `/api/mcp/v1/tools/list` | Returns available tools for the authenticated employee |
| `POST` | `/api/mcp/v1/tools/call` | Executes a tool, returns tool_result |
| `GET` | `/api/mcp/v1/sse` | SSE stream for async tool results (approval queue events) |
| `POST` | `/api/mcp/v1/ping` | Health check for Gateway to verify bearer |

### 3.2 Auth + `caller_employee_slug` self-identification (NC2)

Every request carries `Authorization: Bearer <token>`. The resolver in `apps/api/src/lib/mcp-token.ts`:

1. bcrypt-compares the bearer against all `agent_employees.mcp_token_hash` values where `is_active = true`. (Indexed lookup if we rework to a lookup table; for MVP, linear scan is fine — <100 employees per instance.)
2. Returns `{ org_id, gateway_connection_url, registered_employee_slugs: [...] }` — NOT a single employee. One bearer = one Gateway = multiple employees.
3. On every `tools/call` request, the body's `arguments.caller_employee_slug` is validated: must be a member of `registered_employee_slugs`. Reject 403 otherwise.
4. Tool handlers receive `ctx = { org_id, employee_id, trust_level }` where `employee_id` and `trust_level` come from looking up the declared slug.

**This is an honesty-based boundary**, not a cryptographic one. Two employees on the same Gateway could theoretically lie about their slug, but doing so requires them to know each other's slugs and be coded to cheat — which is only an issue if the Gateway host is compromised. For stricter isolation, use the advanced "one Gateway per employee" deployment mode.

### 3.3 Tool catalog (v1 MVP)

| Tool | R/W | Approval-gated | Description |
|---|---|---|---|
| `platform_context` | R | no | **NC1** — `{caller_employee_slug, trigger?: {kind, space_id?, triggering_message_id?}}` → returns JSON blob with date, org, employee role+trust, teammates, top 3-5 wiki snippets via FTS×confidence×embedding hybrid, trigger context. **Agent is instructed by AGENTS.md to call this first on every turn.** |
| `memory_recall` | R | no | `{caller_employee_slug, query, limit, scope}` → wiki pages via hybrid search. **Scoping rule: returns pages where `agent_employee_id = $employee_id OR agent_employee_id IS NULL` — employee-tagged + org-wide. Cross-employee isolation is default.** |
| `memory_write` | W | no (own scope) | `{caller_employee_slug, title, body, type, confidence, scope}` → insert `wiki_pages` with `agent_employee_id = $employee_id` |
| `memory_update` | W | yes on scope promotion | `{caller_employee_slug, slug, patch}` → update own page; promoting to org-wide requires approval |
| `memory_list` | R | no | enumerate employee + org-wide pages |
| `task_query` | R | no | `{caller_employee_slug, filter}` |
| `task_create` | W | yes (trust-gated) | `shouldAutoExecute` or `asPseudoResult` |
| `task_update` | W | yes (trust-gated) | same |
| `message_post` | W | yes (trust-gated) | posts as employee shadow user |
| `thread_fetch` | R | no | conversation history |
| `member_list` | R | no | org roster + roles |
| `space_memory_get` | R | no | per-space KV read |
| `space_memory_set` | W | no (space-scoped) | per-space KV write |
| `delegation_self_report` | W | no | **I7** — agent reports its own `sessions_send` delegations for audit log visibility; named honestly because Deft cannot observe OpenClaw-internal delegations |

### 3.4 Approval-gate response shape

When a write tool is called below the employee's trust threshold:

```json
{
  "isError": false,
  "content": [{
    "type": "text",
    "text": "{\"status\":\"queued_for_approval\",\"approval_id\":\"act_abc123\",\"message\":\"This action requires human approval. Continue your reasoning — the action will execute if approved within 24h. Tell the user the action is pending.\"}"
  }]
}
```

**Research confirmation:** OpenClaw treats MCP `tool_result.content[0].text` as opaque — it does not interpret structured JSON in the text. The agent reads the JSON as string content and acts on it according to `AGENTS.md` instructions:

> *"If a write tool returns `queued_for_approval`, tell the user the action is pending human review. Do not retry. Continue the conversation naturally. The action will execute asynchronously once approved."*

### 3.5 Token issuance

- **One bearer per Gateway**, issued at wizard time when the user adds their first employee to a Gateway. Subsequent employees on the same Gateway share the token. Each employee's `mcp_token_hash` column stores the same bcrypt hash of that shared token.
- Shown once via the `CopyOnce` component
- Revoke = NULL all `mcp_token_hash` values for employees sharing the Gateway + set `connection_status = 'revoked'`
- Rotate = new token, update all affected rows, replay wizard

---

## 4. Chat envelope + trigger dispatcher

### 4.1 `apps/api/src/lib/openclaw-chat-envelope.ts`

```ts
export async function buildChatCompletionRequest(params: {
  employee: AgentEmployee;
  threadContext: { parentMessage?: Message; replies: Message[] };
  triggerMessage: Message | TriggerDescriptor;
}): Promise<OpenAIChatCompletionRequest> {
  // NO dynamic system message. OpenClaw owns the system prompt.
  // Dynamic context flows via the agent calling platform_context as its first tool call.
  // We only pass the thread history + trigger message.
  const messages: Array<{role: string; content: string}> = [];

  if (params.threadContext.parentMessage) {
    messages.push({
      role: 'user',
      content: `[${params.threadContext.parentMessage.user_name}]: ${params.threadContext.parentMessage.content}`,
    });
  }
  for (const reply of params.threadContext.replies) {
    messages.push({
      role: reply.user_id === params.employee.user_id ? 'assistant' : 'user',
      content: reply.user_id === params.employee.user_id ? reply.content : `[${reply.user_name}]: ${reply.content}`,
    });
  }
  // Trigger message
  const trigger = params.triggerMessage;
  if ('role' in trigger && trigger.role === 'system') {
    // Real message trigger
    messages.push({ role: 'user', content: `[${trigger.user_name}]: ${trigger.content}` });
  } else {
    // TriggerDescriptor (cron/webhook/event) — package as synthetic user message
    messages.push({ role: 'user', content: formatTriggerAsMessage(trigger as TriggerDescriptor) });
  }

  return {
    model: `openclaw/${params.employee.slug}`,
    messages,
    stream: true,
  };
}

export async function parseReplyIntoMessage(...) { /* as before */ }
export function backfillMentions(content: string, orgMembers: Member[]): string { /* as before */ }
```

**NC1 fix:** removed `dynamic-system-prompt.ts` entirely. Per-turn context flows exclusively through the `platform_context` MCP tool, which the agent calls first per AGENTS.md instructions.

### 4.2 `apps/api/src/lib/openclaw-client.ts`

Thin wrapper around `fetch` with SSE parsing + 60s timeout. Standard OpenAI SSE format (`data: <json>` lines, `data: [DONE]`). OpenClaw v2026.3.12+ cancels in-flight requests on client disconnect, so aborting the fetch stops the agent cleanly.

**I3 fix:** add a 60s LRU cache (`Map<cacheKey, expiresAt>`) keyed by `employeeId + queryHash` for `platform_context` results on the MCP server side. First hit computes the full response; subsequent hits within 60s return cached. Invalidate on any `memory_write` in that scope.

### 4.3 `apps/api/src/workers/handlers/employee-trigger.ts` (new)

```ts
type TriggerInvocation = {
  employee_id: string;
  trigger_kind:
    | 'cron:standup' | 'cron:weekly-digest' | 'cron:meeting-prep'
    | 'event:task-stalled' | 'event:task-overdue'
    | 'webhook:pr-merged' | 'webhook:calendar-event-upcoming';
  context: Record<string, unknown>;
  goal: string;
  target_space_id?: string;
};
// Handler dispatches via chat envelope. 60s timeout.
```

### 4.4 Modifications to `agent-employee-message.ts`

Branch on `employee.kind === 'openclaw'` → use chat envelope. Keep native path unchanged.

### 4.5 Modifications to existing trigger handlers

`standup-generate.ts`, `meeting-prep-check.ts`, `nudge-check.ts`, `task-extract.ts` all call `findEmployeeWithSubscription(orgId, triggerKind)` first. If found, route through `employee-trigger`. Otherwise fall back to existing native path.

---

## 5. Setup wizard UX

New route: `apps/web/src/app/(app)/settings/agent/deploy/page.tsx`

### 5.1 Six-step flow

| Step | Screen | What the user does |
|---|---|---|
| 1 | Pick a role template | Browse 8 first-party templates seeded from mergisi + Deft-originals. Preview SOUL.md, AGENTS.md, TOOLS.md, default tools, recommended model. |
| 2 | Pick deployment target | 4 cards: **DigitalOcean 1-click** ($12/mo, recommended), **Hostinger Docker Manager** (~$5-8/mo, manual install with screenshot walkthrough), **Railway 1-click template** (~$5/mo + usage), **Advanced: BYO URL**. |
| 3 | Configure triggers | Checklist of trigger subscriptions. Validates against the (org_id, trigger_kind) uniqueness rule; blocks deploy if another employee already owns that trigger. |
| 4 | Generate config + tokens | Deft issues: **one-time install token (15-min TTL)** + Gateway token + MCP bearer. Single "Copy" button for the install command. |
| 5 | Handshake test | User deploys externally, pastes back the public URL, clicks "Test connection". **C4/NC4 fix:** Deft POSTs to `/v1/models` (cheap, no LLM tokens), verifies the expected `openclaw/<slug>` appears in the returned list. On success flip `connection_status='connected'`. |
| 6 | Approval mapping | Pick which write tools auto-execute vs queue. Trust level is capped at `standard` in this wizard (**I6 fix**). Upgrading to `autonomous` is a separate post-deploy action gated by `ConfirmDangerous`. |

### 5.2 Generated OpenClaw config (JSON5)

```json5
// ~/.openclaw/openclaw.json — generated by Deft wizard
{
  $schema: "https://docs.openclaw.ai/schemas/openclaw.schema.json",
  env: { vars: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" } },

  gateway: {
    bind: "0.0.0.0",
    port: 18789,
    auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
    http: { endpoints: { chatCompletions: { enabled: true }, models: { enabled: true } } },
  },

  mcp: {
    servers: {
      deft: {
        url: "https://api.deft.io/mcp/v1",
        transport: "streamable-http",
        connectionTimeoutMs: 10000,
        headers: { Authorization: "Bearer ${DEFT_MCP_TOKEN}" },
      },
    },
  },

  plugins: {
    slots: { memory: "none" },             // Deft wiki is sole memory (Phase 1 empirical test verifies this fully silences workspace writes)
    entries: { "memory-wiki": { enabled: false } },
  },

  agents: {
    defaults: {
      workspace: "~/.openclaw/workspace",
      model: {
        // Sonnet 4.6 is the default for cost — comparable quality to Opus 4.6
        // on most employee tasks at a fraction of the price, and measurably
        // faster (Phase 5 audit: Sonnet 16s vs Opus 23-27s per turn). Opus is
        // opt-in for high-stakes roles like CFO or On-call Responder via the
        // template marketplace. Fallback to Haiku for trivial acknowledgements.
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["anthropic/claude-haiku-4-5-20251001"],
      },
      skills: [],
      timeoutSeconds: 600,
      maxConcurrent: 4,
      bootstrapMaxChars: 20000,
      bootstrapTotalMaxChars: 150000,
    },
    list: [
      {
        id: "alex-pm",
        default: true,
        agentDir: "~/.openclaw/agents/alex-pm/agent",
        workspace: "~/.openclaw/agents/alex-pm/workspace",
        tools: {
          allow: [
            "deft_platform_context",
            "deft_memory_recall", "deft_memory_write", "deft_memory_update", "deft_memory_list",
            "deft_task_query", "deft_task_create", "deft_task_update",
            "deft_message_post", "deft_thread_fetch", "deft_member_list",
            "deft_space_memory_get", "deft_space_memory_set",
            "deft_delegation_self_report",
          ],
          agentToAgent: { enabled: true, allow: [/* other employee slugs, filled by wizard */] },
        },
      },
      // Additional employees appended here on subsequent deploys — wizard merges into agents.list
    ],
  },

  channels: {},  // Deft is the only inbound surface
}
```

**I5 fix:** `tools.agentToAgent.enabled = true` is included so employees on the same Gateway can delegate via `sessions_send`. The `allow` list is populated by the wizard based on other employees already on that Gateway — when a new employee is added, the wizard updates every existing employee's `allow` list to include the newcomer.

Bootstrap files served at `GET /api/agents/:slug/files/{soul,agents,user,tools}.md`. All four are generated by Deft from the template's `soul_md`, `agents_md`, `user_md_template` (rendered with org data), and `tools_md`.

### 5.3 Install command (NC2 + C2)

**One-time install token flow** — wizard generates a 15-min TTL install token, embeds it in the bootstrap URL. No exported shell env var needed.

```bash
# Runs inside the deployed OpenClaw droplet/container
curl https://api.deft.io/api/agents/alex-pm/bootstrap/${INSTALL_TOKEN} | bash
```

The `bootstrap/:token` endpoint:
1. Validates the install token (single-use, 15-min TTL, bound to a specific employee row)
2. Generates a shell script that:
   - Creates `~/.openclaw/agents/alex-pm/workspace/`
   - Writes SOUL.md, AGENTS.md, USER.md, TOOLS.md
   - Writes the openclaw.json config with both `OPENCLAW_GATEWAY_TOKEN` and `DEFT_MCP_TOKEN` pre-baked
   - Optionally mounts `~/.openclaw/agents/alex-pm/workspace/MEMORY.md` as `tmpfs` if Phase 1 empirical test shows memory leakage
   - Restarts OpenClaw
3. Burns the install token — single use, never served again

**M7 fix:** Hostinger path does not use a "deep link" — instead shows a 3-step walkthrough in the wizard card with a checkbox "I've installed OpenClaw in Hostinger Docker Manager" that gates the handshake step. After they install, they paste the public URL and run the single curl command.

**M8 fix:** Railway pre-fill URL pattern (`?variables=X=y`) needs empirical verification in Phase 0. If it doesn't actually pre-fill secrets in the Railway deploy UI, fall back to the same "deploy + paste URL + curl install" flow as Hostinger.

---

## 6. Template marketplace

### 6.1 Seeding

Clone `https://github.com/mergisi/awesome-openclaw-agents` to `/tmp/openclaw-refs/awesome-agents/`. Check license (expected MIT). **M3 fix:** 6 templates adapted from mergisi + 2 Deft-originals = 8 first-party templates.

For each mergisi port:
- Read the source SOUL.md
- Translate into Deft's convention with `{{DATE}}`, `{{ORG}}`, `{{ROLE}}` placeholders
- Author matching AGENTS.md with Deft tool conventions, approval rules, and **the explicit instruction to call `deft_platform_context` first on every turn**
- Author matching TOOLS.md describing every MCP tool the employee is allowed to call
- Author USER.md template rendered per-org at deploy time
- Set `source='community'`, `source_attribution="Adapted from mergisi/awesome-openclaw-agents (MIT)"`

First-party templates (MVP):
1. **alex-pm** — Project Manager (mergisi, adapted)
2. **designer** — Product Designer (mergisi, adapted)
3. **cfo** — Financial + burn tracking (Deft-original)
4. **qa** — Test planning + bug triage (mergisi, adapted)
5. **cs** — Customer Success (mergisi, adapted)
6. **on-call** — Incident triage + runbooks (mergisi, adapted)
7. **community** — Community Manager (mergisi, adapted)
8. **devops** — Deploy + infra health (Deft-original)

### 6.2 Template synchronization

When `template_version` on an employee row is older than the current template version, show an upgrade badge. Click to preview diff + apply. Never force-upgrade.

---

## 7. Audit receipts & governance

Port from Mission Control (MIT attribution via `THIRD-PARTY-LICENSES.md` + inline file header).

### 7.1 Receipt generation

Every write tool call on the MCP server produces a receipt:

```ts
export async function generateReceipt(params: {
  actionId: string;
  orgId: string;
  employeeId: string;
  proposer: 'employee' | 'defty' | 'user' | 'cron';
  actionName: string;
  actionParams: Record<string, unknown>;
  decision: 'auto_executed' | 'approved' | 'rejected' | 'expired';
  decisionReason?: string;
  approverId?: string;
  resultJson?: unknown;
}): Promise<Receipt> {
  const signedPayload = JSON.stringify({
    action_id: params.actionId, action_name: params.actionName,
    params: params.actionParams, decision: params.decision,
    timestamp: new Date().toISOString(),
  });
  const signature = createHmac('sha256', env.ENCRYPTION_KEY).update(signedPayload).digest('hex');
  return db.insert(actionReceipts).values({...params, signature_hmac: signature}).returning();
}
```

### 7.2 Receipt viewer UI

Settings → Agent → Action log row → "View receipt" button → modal with action name, params, proposer, decision, approver, signature hash, "Copy as JSON". PDF export deferred to v1.1.

### 7.3 Typed confirmation gates (`ConfirmDangerous` component)

Apply to: trust upgrade to `autonomous`, employee deletion, org deletion, member role downgrade, wiki bulk delete (>5 pages). Component is built in Phase 10.

---

## 8. Observability

### 8.1 OTel metrics export

`GET /api/metrics` — Prometheus format. Metrics:

- `deft_mcp_tool_calls_total{tool, employee_slug, org_id, result}`
- `deft_mcp_tool_latency_ms{tool, quantile}`
- `deft_employee_chat_turn_total{employee_slug, trigger_kind, result}`
- `deft_employee_chat_latency_ms{employee_slug, quantile}`
- `deft_employee_tokens_in_total{employee_slug}`
- `deft_employee_tokens_out_total{employee_slug}`
- `deft_approval_queue_size{org_id}`

Users point ClawMetry or Grafana at `api.deft.io/metrics`. **Do not build an observability dashboard inside Deft.**

### 8.2 Session inspector UI

Settings → Agent → Employees → click employee → "Recent turns" tab. Last 50 `agent_session_turns` rows with expandable details.

---

## 9. ClawHub skill browser (deferred)

Stretch goal. Not in MVP. v1.1 adds a "Browse skills from ClawHub" step in the wizard.

---

## 10. v4.0 compatibility plan

OpenClaw v4.0 ships mid-2026 with native multi-agent orchestration, Plugin SDK v2, native ChromaDB.

Migration when v4.0 lands:
1. Update Docker tag in wizard
2. Diff v3.x vs v4.0 JSON5, regenerate templates
3. If Plugin SDK v2 changes MCP tool_result shape, update `mcp-server.ts`
4. Offer ChromaDB as an alternative memory backend
5. Test one employee on v4.0 before broad rollout

Budget: 3-5 days compat work. Watch `openclaw/openclaw` `main` weekly.

---

## 11. Phased implementation plan

### Phase 0 — Environment prep (Day 0 ~ 3 hours) — MANUAL

**C7 + I1 note:** Phases 0 and 1 run in the main session with direct Docker and empirical observation. Subagent dispatch begins at Phase 2, only after Phase 1 outcomes are recorded in §18.

**Files:**
- Create: `/tmp/openclaw-refs/` directory
- Create: `THIRD-PARTY-LICENSES.md` at Deft repo root
- Create: `scripts/scratch/dummy-mcp-server.ts` (Phase 1 test harness)

**Steps:**

- [ ] **Step 0.1: Clone reference repos outside Deft's tree**
  ```bash
  mkdir -p /tmp/openclaw-refs
  cd /tmp/openclaw-refs
  git clone https://github.com/abhi1693/openclaw-mission-control mission-control
  git clone https://github.com/clawdeckio/clawdeck clawdeck
  git clone https://github.com/grp06/openclaw-studio openclaw-studio
  git clone https://github.com/mergisi/awesome-openclaw-agents awesome-agents
  ```

- [ ] **Step 0.2: Verify licenses on all four**
  ```bash
  for d in mission-control clawdeck openclaw-studio awesome-agents; do
    echo "=== $d ==="; head -5 /tmp/openclaw-refs/$d/LICENSE 2>/dev/null || echo "NO LICENSE FILE"
  done
  ```
  Expected: all MIT. Flag if any are missing.

- [ ] **Step 0.3: Create THIRD-PARTY-LICENSES.md**
  See §0.3 in the rev 1 plan for the exact content.

- [ ] **Step 0.4: Pull OpenClaw Docker image + verify tag**
  ```bash
  docker pull ghcr.io/openclaw/openclaw:latest
  docker images ghcr.io/openclaw/openclaw
  ```
  Record the concrete tag (`:2026.x.y`) to pin in the wizard.

- [ ] **Step 0.5 (C6): Verify `agent_actions` table name in current schema**
  ```bash
  grep -n "agentActions\|agent_actions\|actionLog\|agent_action_log\|agentAction" packages/db/src/schema.ts
  ```
  Record the exact table name. Update `action_receipts.action_id` FK decision accordingly.

- [ ] **Step 0.6 (M6): Create dummy MCP server script**
  Create `scripts/scratch/dummy-mcp-server.ts`:
  ```ts
  // Minimal HTTP server that logs every request with a port-identifying prefix
  import { createServer } from 'http';
  const port = parseInt(process.argv[process.argv.indexOf('--port') + 1]);
  const label = process.argv[process.argv.indexOf('--label') + 1];
  createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      console.log(`[${label}:${port}] ${req.method} ${req.url} — ${body.slice(0, 200)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tools: [], source: label }));
    });
  }).listen(port, () => console.log(`dummy MCP ${label} on :${port}`));
  ```

- [ ] **Step 0.7 (M8): Manually test Railway deploy URL env var pre-fill**
  Visit `https://railway.com/deploy/openclaw-railway-template?variables=FOO=bar&BAZ=qux` in a browser. Check if the deploy UI pre-fills `FOO` and `BAZ`. If not, document as "Railway flow requires manual env var paste" and plan fallback for Phase 8.

- [ ] **Step 0.8: Spin up local OpenClaw Docker container**
  ```bash
  mkdir -p ~/.openclaw-dev
  cat > ~/.openclaw-dev/openclaw.json << 'EOF'
  {
    gateway: { bind: "127.0.0.1", port: 18789, auth: { mode: "none" } },
    agents: { list: [{ id: "default", default: true }] }
  }
  EOF
  docker run -d --name openclaw-dev -p 18789:18789 -v ~/.openclaw-dev:/root/.openclaw ghcr.io/openclaw/openclaw:latest
  docker logs openclaw-dev | tail -20
  curl http://127.0.0.1:18789/v1/models | jq
  ```
  Expected: Gateway listening, `/v1/models` returns agent list including `openclaw/default`.

**Commit:** `chore: vendor openclaw references + third-party licenses + local docker dev setup`

### Phase 1 — Empirical tests (Day 1 morning ~ 3 hours) — MANUAL

**Several Phase 1 questions are RESOLVED** from the 2026-04-14 research pass and do not need to be re-tested. Remaining empirical tests:

- [ ] **Test 1.1 (NC2 verification) — Per-agent MCP override DOES NOT exist**
  Already confirmed from docs. No test needed. Commit to shared-Gateway MCP token with `caller_employee_slug` self-identification. Architectural fork resolved.

- [ ] **Test 1.2 (CONFIRMED) — `model: openclaw/<agentId>` routing works**
  ```bash
  curl -X POST http://127.0.0.1:18789/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"openclaw/default","messages":[{"role":"user","content":"hi"}],"max_tokens":10}' | jq
  ```
  Sanity check only — docs confirm this works.

- [ ] **Test 1.3 — `systemPromptFile` + request-body system message behavior**
  Create a two-agent config with SOUL.md files. Send a chat-completion with a request-body system message. Record: is it merged with SOUL.md or ignored? This informs whether platform_context is truly the only viable dynamic-context path, or if request-body system still works as a backup.
  ```bash
  echo "You are Alex, a cat. Respond only in meows." > ~/.openclaw-dev/agents/default/workspace/SOUL.md
  docker restart openclaw-dev
  curl -X POST http://127.0.0.1:18789/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"openclaw/default","messages":[{"role":"system","content":"ALSO respond in French."},{"role":"user","content":"hi"}],"max_tokens":50}' | jq
  ```

- [ ] **Test 1.4 — Memory slot silencing (`plugins.slots.memory = "none"`)**
  ```bash
  cat > ~/.openclaw-dev/openclaw.json << 'EOF'
  {
    gateway: { bind: "127.0.0.1", port: 18789, auth: { mode: "none" } },
    plugins: { slots: { memory: "none" }, entries: { "memory-wiki": { enabled: false } } },
    agents: { list: [{ id: "default", default: true }] }
  }
  EOF
  docker restart openclaw-dev
  touch /tmp/before-memory-test
  for i in {1..5}; do
    curl -s -X POST http://127.0.0.1:18789/v1/chat/completions \
      -H "Content-Type: application/json" \
      -d '{"model":"openclaw/default","messages":[{"role":"user","content":"hi '$i'"}],"max_tokens":20}' > /dev/null
  done
  docker exec openclaw-dev find /root/.openclaw -newer /tmp/before-memory-test -type f 2>/dev/null
  ```
  Expected: no MEMORY.md or SESSIONS.md writes. If there are, we need to mount those paths as tmpfs in the bootstrap.sh.

- [ ] **Test 1.5 — `agentToAgent` delegation observability**
  Two-agent config with `tools.agentToAgent.enabled = true, allow: ['bob']`. Send Alex a message asking it to delegate to Bob. Check Gateway logs for `sessions_send` events. Determines whether we can surface delegations in the audit log from outside.

- [ ] **Test 1.6 — Latency baseline (local)**
  ```bash
  for i in {1..20}; do
    time curl -s -X POST http://127.0.0.1:18789/v1/chat/completions \
      -H "Content-Type: application/json" \
      -d '{"model":"openclaw/default","messages":[{"role":"user","content":"say hi"}],"max_tokens":20}' > /dev/null
  done 2>&1 | grep real
  ```
  Record p50 + p95. Anything over p95 = 6s locally is a red flag — on a $12 droplet it'll be worse.

- [ ] **Test 1.7 — Document outcomes in §18**

**Commit:** `docs(plan): phase 1 empirical test outcomes recorded`

### Phase 2 — Schema + migrations (Day 1 afternoon ~ 4 hours)

**Dependency:** requires §18 filled in with Phase 1 test outcomes. Do not dispatch as subagent until done.

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: migrations 0006-0011 (see §2.4)
- Create: `apps/api/src/scripts/backfill-wiki-embeddings.ts` (I2 fix)

**Steps:**

- [ ] **Step 2.1: Add all 9 columns to `agent_employees`** per §2.1 (including `gateway_token_encrypted`, not `gateway_token_hash`)
- [ ] **Step 2.2: Create `agent_session_turns` table** per §2.2 (with `model_name`/`tokens_in`/`tokens_out`, not `cost_usd_microcents`)
- [ ] **Step 2.3: Create `action_receipts`** — `action_id` as plain text, FK added in later migration if Phase 0.5 confirms a table to reference
- [ ] **Step 2.4: Create `agent_employee_templates`** — empty, no seed yet
- [ ] **Step 2.5: Create `space_memory`**
- [ ] **Step 2.6: Add `embedding` column to `wiki_pages` + pgvector extension**
- [ ] **Step 2.7 (I2): Create backfill script**
  ```bash
  # apps/api/src/scripts/backfill-wiki-embeddings.ts
  # Iterates wiki_pages where embedding IS NULL
  # For each: call the existing embed-content worker logic synchronously
  # Update the row with embedding vector
  # Log progress every 50 pages
  ```
- [ ] **Step 2.8: Run migrations + backfill**
  ```bash
  pnpm --filter @deft/db drizzle-kit migrate
  pnpm tsx apps/api/src/scripts/backfill-wiki-embeddings.ts
  pnpm --filter @deft/api test -- schema
  ```
- [ ] **Step 2.9: Verify existing Alex PM is `kind='native'`**
  The migration 0006 explicit UPDATE ensures this. Phase 12 backfill step is redundant (I4).

**Commit:** `feat(db): openclaw employee schema + turns + receipts + templates + space memory + pgvector`

### Phase 3 — MCP server MVP (Day 2 ~ 7 hours)

**Goal:** Deft exposes a working MCP server. Local OpenClaw Docker can call `platform_context` + `memory_recall` + `memory_write` against a local Deft instance via ngrok.

**Files:**
- Create: `apps/api/src/routes/mcp-server.ts`
- Create: `apps/api/src/lib/mcp-token.ts`
- Create: `apps/api/src/lib/mcp-tools/types.ts`
- Create: `apps/api/src/lib/mcp-tools/index.ts`
- Create: `apps/api/src/lib/mcp-tools/context.ts` (platform_context — new)
- Create: `apps/api/src/lib/mcp-tools/memory.ts`
- Create: `apps/api/src/lib/mcp-tools/tasks.ts`
- Create: `apps/api/src/lib/mcp-tools/members.ts`
- Create: `apps/api/src/scripts/issue-token.ts` (M4)
- Modify: `apps/api/src/index.ts` (mount route)
- Create: `apps/api/test/mcp-server.test.ts`

**Steps:**

- [ ] **Step 3.1: Define types** (`mcp-tools/types.ts`)
  ```ts
  export type ToolContext = { org_id: string; employee_id: string; employee_slug: string; trust_level: 'conservative' | 'standard' | 'autonomous'; };
  export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
  export type ToolError = { code: number; message: string };
  ```

- [ ] **Step 3.2: Implement token resolver** (`mcp-token.ts`)
  Functions: `issueGatewayToken(connectionUrl)`, `resolveGatewayToken(bearer, callerSlug)`.
  Takes bearer + caller_employee_slug, validates both, returns full `ToolContext`.

- [ ] **Step 3.3: Implement `platform_context`** (`mcp-tools/context.ts`)
  First thing built. Returns the dynamic JSON blob. FTS + pgvector hybrid search on wiki for relevant snippets. 60s LRU cache.

- [ ] **Step 3.4: Write failing test for `platform_context`**
- [ ] **Step 3.5: Implement `memory_recall` + `memory_write`** (`mcp-tools/memory.ts`)
- [ ] **Step 3.6: Implement `memory_list`, `task_query`, `thread_fetch`, `member_list`**
- [ ] **Step 3.7: Wire MCP server route** (`routes/mcp-server.ts`) with `initialize`, `tools/list`, `tools/call`, `ping` endpoints
- [ ] **Step 3.8: Mount route** in `apps/api/src/index.ts`
- [ ] **Step 3.9: Create `issue-token.ts` script**
  ```bash
  # Usage: pnpm tsx apps/api/src/scripts/issue-token.ts <employee_slug>
  # Issues a raw token, prints it once, writes the bcrypt hash to agent_employees.mcp_token_hash
  ```
- [ ] **Step 3.10: Run tests, expect PASS**
- [ ] **Step 3.11: Manual curl verification via ngrok**
  ```bash
  ngrok http 3001 &
  NGROK_URL=$(curl -s localhost:4040/api/tunnels | jq -r .tunnels[0].public_url)
  TOKEN=$(pnpm tsx apps/api/src/scripts/issue-token.ts alex-pm)
  curl -X POST $NGROK_URL/api/mcp/v1/tools/call \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"name":"platform_context","arguments":{"caller_employee_slug":"alex-pm"}}' | jq
  ```

**Commit:** `feat(api): mcp server v1 with platform_context + memory + read-only tools`

### Phase 4 — Write tools + approval gating (Day 3 morning ~ 5 hours)

**Files:**
- Create: `apps/api/src/lib/mcp-tools/writes.ts`
- Create: `apps/api/src/lib/mcp-tools/space-memory.ts`
- Create: `apps/api/src/lib/mcp-tools/delegation.ts`
- Modify: `apps/api/src/lib/agent-approval.ts` — add `asPseudoResult(actionId, message)`
- Modify: `apps/api/src/routes/mcp-server.ts` — wire new tools

**Steps:**

- [ ] **Step 4.1: Implement `asPseudoResult` in `agent-approval.ts`**
- [ ] **Step 4.2: Implement `task_create`, `task_update`, `message_post`** (writes.ts) with trust-level gating
- [ ] **Step 4.3: Implement `memory_update`** (memory.ts extension) — approval required for cross-scope promotion (C3)
- [ ] **Step 4.4: Implement `space_memory_get` + `space_memory_set`** (space-memory.ts) (C3)
- [ ] **Step 4.5: Implement `delegation_self_report`** (delegation.ts) (C3, I7)
- [ ] **Step 4.6: TDD coverage for each gate path** (auto-execute, queue-for-approval, reject)
- [ ] **Step 4.7: Manual verification — conservative employee calling `task_create` gets queued_for_approval**

**Commit:** `feat(api): mcp server write tools with approval gating + memory_update + space_memory + delegation_self_report`

### Phase 5 — Chat envelope adapter (Day 3 afternoon ~ 4 hours)

**Dependency (M1):** Phase 3 steps 3.5 and 3.6 must be complete — the employee needs at least `task_query` and `thread_fetch` for a useful chat response.

**Files:**
- Create: `apps/api/src/lib/openclaw-chat-envelope.ts` (no dynamic-system-prompt.ts — NC1)
- Create: `apps/api/src/lib/openclaw-client.ts`
- Modify: `apps/api/src/workers/handlers/agent-employee-message.ts`
- Create: `apps/api/test/openclaw-envelope.test.ts`

**Steps:**

- [ ] **Step 5.1: Implement `buildChatCompletionRequest()`** per §4.1 — no dynamic system message
- [ ] **Step 5.2: Implement `openclawClient.chatCompletion()`** — SSE parser with 60s timeout
- [ ] **Step 5.3: Implement `parseReplyIntoMessage()`**
- [ ] **Step 5.4: Implement `backfillMentions()`**
- [ ] **Step 5.5: Branch `agent-employee-message.ts` on `kind`**
- [ ] **Step 5.6: End-to-end local test** — `@Alex PM hi` in chat with `openclaw` employee pointed at ngrok → OpenClaw Docker → MCP roundtrip → threaded reply
- [ ] **Step 5.7: Verify the agent called `platform_context` first** via `agent_session_turns` inspection

**Commit:** `feat(api): openclaw chat envelope + agent-employee-message dispatch branch`

### Phase 6 — Trigger dispatcher (Day 4 morning ~ 3 hours)

**Files:**
- Create: `apps/api/src/workers/handlers/employee-trigger.ts`
- Modify: `apps/api/src/workers/handlers/standup-generate.ts`
- Modify: `apps/api/src/workers/handlers/meeting-prep-check.ts`
- Modify: `apps/api/src/workers/handlers/nudge-check.ts`
- Modify: `apps/api/src/workers/handlers/task-extract.ts`
- Modify: `apps/api/src/workers/index.ts` — register

**Steps:**

- [ ] **Step 6.1: Implement `employee-trigger.ts`** per §4.3
- [ ] **Step 6.2: Register in `workers/index.ts`**
- [ ] **Step 6.3: Modify each existing trigger handler** to check for subscription first
- [ ] **Step 6.4: Verify standup trigger fires via OpenClaw** — set `alex-pm.trigger_subscriptions = ['cron:standup']`, wait for cron fire, confirm a new message appears in #general authored by Alex PM

**Commit:** `feat(api): employee trigger dispatcher routes cron/event/webhook through openclaw`

### Phase 7 — Audit receipts (Day 4 afternoon ~ 3 hours)

**Files:**
- Create: `apps/api/src/lib/receipts.ts`
- Modify: `apps/api/src/routes/mcp-server.ts` — generate receipt on every write
- Create: `apps/web/src/components/receipt-viewer.tsx`
- Modify: `apps/web/src/app/(app)/settings/agent/page.tsx` — add "View receipt" button

**Steps:**

- [ ] **Step 7.1: Implement `generateReceipt()`** per §7.1
- [ ] **Step 7.2: Wire into every write path**
- [ ] **Step 7.3: Build viewer modal**
- [ ] **Step 7.4: Add MC attribution file header** to the receipt files

**Commit:** `feat(api+web): hmac-signed action receipts ported from mission control (mit)`

### Phase 8 — Setup wizard (Day 5-6 ~ 8 hours)

**Files:**
- Create: `apps/web/src/app/(app)/settings/agent/deploy/page.tsx` + step components
- Create: `apps/web/src/components/copy-once.tsx`
- Create: `apps/api/src/routes/agents-deploy.ts` — `GET /api/agents/:slug/config`, `GET /api/agents/:slug/bootstrap/:install_token`
- Create: `apps/api/src/lib/install-tokens.ts` — 15-min TTL single-use tokens
- Modify: `apps/web/src/app/(app)/settings/agent/page.tsx` — "Deploy new employee" CTA

**Steps:**

- [ ] **Step 8.1: Build `CopyOnce` component**
- [ ] **Step 8.2: Build install token issuer** (C2)
- [ ] **Step 8.3: Build `bootstrap/:token` endpoint** that serves the shell script with pre-baked secrets + all 4 workspace files (SOUL.md, AGENTS.md, USER.md, TOOLS.md)
- [ ] **Step 8.4: Build the 6-step wizard**
- [ ] **Step 8.5: Implement handshake via `/v1/models`** (C4/NC4) — verify expected `openclaw/<slug>` appears in returned list
- [ ] **Step 8.6: Cap trust level at `standard` in wizard** (I6)
- [ ] **Step 8.7: Multi-agent `agentToAgent` emission** when deploying into an existing Gateway (I5) — update all existing employees' `allow` lists to include the newcomer
- [ ] **Step 8.8: Trigger uniqueness check** (I8) — block deploy if another employee already owns the subscribed trigger
- [ ] **Step 8.9: Manual walkthrough on real $12 DigitalOcean droplet** — zero to live Alex PM in <15 minutes (realistic)

**Commit:** `feat(web+api): setup wizard with digitalocean/hostinger/railway/byo paths`

### Phase 9 — Template seeding (Day 7 ~ 4 hours)

**Files:**
- Create: `apps/api/src/scripts/seed-templates.ts`
- Create: `packages/db/drizzle/0012_seed_templates.sql`

**Steps:**

- [ ] **Step 9.1: For each of 8 templates, read source SOUL.md from `/tmp/openclaw-refs/awesome-agents/`**
- [ ] **Step 9.2: Translate SOUL.md with placeholders**
- [ ] **Step 9.3: Author matching AGENTS.md** — include explicit "call `deft_platform_context` first on every turn" instruction
- [ ] **Step 9.4: Author matching TOOLS.md** describing allowed Deft MCP tools
- [ ] **Step 9.5: Author USER.md templates**
- [ ] **Step 9.6: Insert rows with `source_attribution` where applicable**
- [ ] **Step 9.7: Verify all 8 appear in wizard**

**Commit:** `feat(db): seed 8 first-party employee templates (6 from mergisi mit, 2 deft-original)`

### Phase 10 — Session inspector + confirmations + OTel (Day 8 ~ 4 hours)

**Files:**
- Create: `apps/web/src/app/(app)/settings/agent/employees/[id]/turns.tsx`
- Create: `apps/web/src/components/confirm-dangerous.tsx`
- Modify: trust upgrade + employee delete + org delete + member role downgrade sites
- Create: `apps/api/src/lib/otel-metrics.ts`
- Create: `apps/api/src/routes/metrics.ts`

**Steps per §8 and §7.3.**

**Commit:** `feat(web+api): session inspector + confirm-dangerous + otel metrics export`

### Phase 11 — Heartbeat + multi-gateway UI (Day 9 ~ 3 hours)

**Files:**
- Create: `apps/api/src/workers/handlers/employee-heartbeat.ts`
- Modify: `apps/api/src/lib/scheduled-jobs.ts` — 60s cron
- Modify: `apps/web/src/app/(app)/settings/agent/page.tsx` — health status + gateway grouping

**Steps:**

- [ ] **Step 11.1: Heartbeat worker — pings `/api/mcp/v1/ping` on each connected employee** (actually: pings the Gateway's `/v1/models` since that's cheaper than our MCP /ping and proves connectivity in both directions)
- [ ] **Step 11.2: Flip to `error` on 3 consecutive fails**
- [ ] **Step 11.3: Surface health per employee + group by Gateway in UI**

**Commit:** `feat(api+web): employee heartbeat + gateway health ui`

### Phase 12 — Feature flag + final review (Day 10 ~ 2 hours)

**I4 fix:** Alex PM native migration is already done in Phase 2 step 2.9 (explicit UPDATE in migration 0006). No redundant backfill here.

**Steps:**

- [ ] **Step 12.1: Add `FEATURE_OPENCLAW_EMPLOYEES` flag** — Deploy button hidden unless flag on
- [ ] **Step 12.2: Dispatch `superpowers:code-reviewer` subagent** for full arc review
- [ ] **Step 12.3: Merge behind flag**

**Commit:** `feat: enable openclaw employee runtime behind feature flag (mvp)`

---

## 12. Day 1 tomorrow — concrete first actions

**All Phase 0 and Phase 1 steps run manually in the main session. No subagent dispatch until Phase 2.**

| Order | Action | Time | Blocker? |
|---|---|---|---|
| 1 | Clone reference repos (Step 0.1) | 10 min | No |
| 2 | Verify licenses + `THIRD-PARTY-LICENSES.md` (0.2, 0.3) | 15 min | No |
| 3 | Pull OpenClaw Docker image (0.4) | 5 min | No |
| 4 | **Grep `agent_actions` table name** (0.5) | 5 min | **Yes — C6** |
| 5 | Create dummy MCP server script (0.6) | 15 min | No |
| 6 | Test Railway deploy URL pre-fill (0.7) | 10 min | No |
| 7 | Spin up local OpenClaw Docker (0.8) | 15 min | **Yes — Phase 1 prereq** |
| 8 | Phase 1 empirical tests 1.3-1.6 (memory silencing, latency, system prompt merge, delegation) | 90 min | **Yes — Phase 2 prereq** |
| 9 | Record outcomes in §18 | 15 min | **Yes — Phase 2 prereq** |
| 10 | Dispatch Phase 2 schema migrations as subagent | delegate | No |
| 11 | Review Phase 2 output, merge | 30 min | No |
| 12 | Dispatch Phase 3 MCP server MVP (including `platform_context`) as subagent | delegate | No |

**Stop point:** once Phase 3 lands and you can `curl` a `platform_context` + `memory_recall` call from the local OpenClaw Docker container through ngrok, Day 1 is a success. Total elapsed: ~8 hours.

---

## 13. Risks + showstoppers (revised)

| # | Risk | Severity | Status | Mitigation |
|---|---|---|---|---|
| 1 | Per-agent MCP override unsupported, forcing shared token | Was High | **Confirmed** | Accept. Use `caller_employee_slug` self-identification. Strict-isolation mode via one-Gateway-per-employee as advanced opt-in. |
| 2 | `model:` routing unsupported in multi-agent mode | Was High | **Resolved ✅** | Docs confirm `model: openclaw/<id>` works. |
| 3 | `systemPromptFile` conflicts with request-body system | Was Med | **Confirmed** | OpenClaw owns prompt assembly. Dynamic context flows through `platform_context` MCP tool, not request body. |
| 4 | MCP client treats `queued_for_approval` as hard failure | Was Med | **Resolved ✅** | OpenClaw treats tool_result opaquely. AGENTS.md instructs agent to handle the JSON as natural content. |
| 5 | Latency >10s on $12 droplet | Med | Open | Phase 1 test 1.6 measures. Mitigations: LRU cache for `platform_context`, keep Gateway warm, use Haiku for trivial ack turns. |
| 6 | OpenClaw v4.0 ships before Deft demos and breaks config | Med | Open | Pin Docker tag. 3-5 day compat sprint budget. |
| 7 | Steinberger OpenClaw governance uncertainty | Low | Open | Foundation-backed. Bus factor OK. |
| 8 | MIT attribution insufficient for enterprise diligence | Low | Open | Preserve notices. Counsel review for $10M+ contracts. |
| 9 | Users abandon wizard at handshake step | Med | Open | `/v1/models` handshake + clear error messages + fallback BYO URL. |
| 10 | Memory slot = "none" still writes MEMORY.md | Med | Open | Phase 1 test 1.4 verifies. Fall back: bootstrap.sh mounts MEMORY.md as tmpfs. |
| 11 | Client disconnect leaks Anthropic tokens | Low | **Resolved ✅** | Recent OpenClaw releases abort in-flight requests on disconnect. |
| 12 | Self-identification via `caller_employee_slug` weak vs malicious agent | Low | Open | MVP accepts this. Strict-isolation advanced mode for enterprise. |

---

## 14. Open questions

### Resolved (from 2026-04-14 research pass)

- ✅ `model:` routing works (`openclaw/<slug>` supported, plus aliases and headers)
- ✅ `/v1/models` exists for cheap handshake
- ✅ Client disconnect cancellation confirmed (recent release)
- ✅ SSE format is standard OpenAI
- ✅ Per-agent MCP override: **unsupported**, workaround documented
- ✅ System prompt is OpenClaw-owned, not client-overridable: **workaround via `platform_context` tool**
- ✅ Approval pseudo-result pattern: **OpenClaw treats content opaquely, AGENTS.md rule handles it**

### Must empirically verify in Phase 1

1. Does `plugins.slots.memory = "none"` fully silence workspace file writes? (Test 1.4)
2. What's the p50/p95 latency baseline? (Test 1.6)
3. How does `systemPromptFile` interact with a request-body system message when present? (Test 1.3 — informational, we're not relying on it)
4. Is `sessions_send` delegation observable via HTTP or Gateway logs? (Test 1.5)

### Strategic (defer)

5. Should Deft offer "Deft Cloud managed OpenClaw" tier? (v1.1 decision)
6. Open-source the MCP server as a standalone package? (Strategic, not blocking)
7. Should Defty also use the MCP server for dogfooding? (Probably no — direct SQL wins)
8. At what user count does BYOK pricing become uncompetitive? (User research)

---

## 15. Non-goals (explicit)

- Building a "better Mission Control" (governance-only, not our lane)
- Building our own agent framework
- Building a vector-memory-as-a-service
- Supporting arbitrary MCP clients in v1 (focus on OpenClaw)
- Multi-Gateway multi-tenancy on one VPS for different orgs
- Replacing Defty with an OpenClaw deployment
- OpenClaw Launch integration (dashboard-only, no deploy API)
- Staged playbooks (ClawControl pattern)
- `.deftpack.zip` portable bundle format
- IoT / Home Assistant / Oura integrations
- Asian messaging platform plugins (Feishu, DingTalk, WeCom, QQ)

---

## 16. Execution handoff

- **Phase 0, 1** — manual, main session only (Docker, empirical testing, architectural decisions)
- **Phase 2** — single subagent after §18 filled in
- **Phases 3-12** — one subagent per phase, two-stage review (spec compliance → code quality) between each
- Use **superpowers:subagent-driven-development** for dispatches

---

## 17. Appendix A — First-party template catalog (stub)

Populated in Phase 9. 6 adapted from `mergisi/awesome-openclaw-agents` (MIT) + 2 Deft-originals.

**Default model per template** (Sonnet is default, Opus is opt-in for high-stakes roles):

| Template | Source | Default model | Opus upgrade? |
|---|---|---|---|
| alex-pm | mergisi | `anthropic/claude-sonnet-4-6` | optional, default off |
| designer | mergisi | `anthropic/claude-sonnet-4-6` | optional, default off |
| qa | mergisi | `anthropic/claude-sonnet-4-6` | optional, default off |
| cs | mergisi | `anthropic/claude-sonnet-4-6` | optional, default off |
| community | mergisi | `anthropic/claude-haiku-4-5` | n/a — Haiku is plenty for community engagement |
| **on-call** | mergisi | `anthropic/claude-opus-4-6` | ✅ **default Opus** — incident response needs strongest reasoning |
| **cfo** | Deft-original | `anthropic/claude-opus-4-6` | ✅ **default Opus** — finance/burn analysis needs strongest reasoning |
| devops | Deft-original | `anthropic/claude-sonnet-4-6` | optional, default off |

**Rationale:** Sonnet 4.6 empirically delivered comparable response quality to Opus 4.6 in Phase 5 audit testing at ~60% faster turn time (16s vs 23-27s) and ~5x lower token cost. For most employee roles (task management, QA triage, design review, customer support, devops) Sonnet is strictly better UX. Only high-stakes reasoning roles where wrong answers have real cost (finance, incident response) default to Opus. Users can upgrade any template to Opus via the wizard's approval mapping step.

Each template ships SOUL.md + AGENTS.md + USER.md template + TOOLS.md.

---

## 18. Day 1 empirical results

Run Phase 1 tests tomorrow and record here.

### Resolved from 2026-04-14 research pass (no test needed)

- **`model:` routing (former Test 1.2):** ✅ CONFIRMED — `openclaw/<agentId>` works, plus `openclaw:<id>` and `agent:<id>` aliases, plus `x-openclaw-model` header
- **Per-agent MCP override (former Test 1.1):** ❌ UNSUPPORTED — docs confirm only top-level `mcp.servers`. Workaround: `caller_employee_slug` self-ID on all tool calls.
- **`/v1/models` endpoint:** ✅ EXISTS — returns agent-target list, no LLM tokens consumed. Use for handshake.
- **Client-disconnect cancellation:** ✅ RESOLVED — OpenClaw v2026.3.12+ aborts in-flight requests when client disconnects.
- **SSE format:** ✅ STANDARD OpenAI-compat (`data: <json>`, `data: [DONE]`)
- **Approval pseudo-result handling:** ✅ OpenClaw treats MCP tool content opaquely; agents read the JSON as text. AGENTS.md instructs natural-language handling.

### Pending empirical tests

- **Test 1.3 — `systemPromptFile` + request-body system message:** _pending_
- **Test 1.4 — Memory slot "none" silencing workspace writes:** _pending_
- **Test 1.5 — `sessions_send` delegation observability:** _pending_
- **Test 1.6 — p50/p95 latency baseline (local):** _pending_
- **Architectural decision (already made):** shared Gateway MCP token + `caller_employee_slug` self-identification, advanced one-Gateway-per-employee mode offered later

---

## 19. Revision history

- **rev 1 (2026-04-14):** Initial plan. 18 sections.
- **rev 2 (2026-04-14 later):** Applied patches from cold-read review pass + 2nd research pass.
  - **Critical (C1-C7):** `gateway_token_encrypted` not hash; install-token bootstrap flow; 4 unassigned MCP tools slotted to Phase 4; `/v1/models` cheap handshake (C4 also addresses NC4); timeline math corrected; `agent_actions` table name verification added; Phase 0-1 explicitly manual-only.
  - **Important (I1-I8):** Phase 2 depends on Phase 1 outcomes; pgvector backfill step added; 60s LRU cache for `platform_context`; dedup Alex PM migration; multi-agent `agentToAgent` config emission in wizard; wizard trust cap at `standard`; `delegation_log` → `delegation_self_report`; trigger subscription uniqueness.
  - **New critical from research (NC1-NC4):** `dynamic-system-prompt.ts` removed, replaced with `platform_context` MCP tool + AGENTS.md instruction; shared-Gateway MCP token + `caller_employee_slug` self-identification (per-agent override unsupported); 4 bootstrap files (SOUL, AGENTS, USER, TOOLS); `/v1/models` for handshake.
  - **Minor fixes inline:** M3 template counts, M4 issue-token script, M5 types.ts, M6 dummy MCP server script, M7 Hostinger no-deep-link, M8 Railway pre-fill verification, M9 cost tracking via model_name, M10 both workers in diagram, M11 memory scoping rule documented, M12 semver validation.
