# OpenClaw Employee Runtime — Design & Implementation Plan

**Status:** Draft, pre-implementation
**Author:** design session 2026-04-14
**Related:** `2026-04-11-phase2-4-implementation.md` (agent employees phase), `AGENT-UI-BACKLOG.md`
**Companion code pointers:** `apps/api/src/lib/agent-runner.ts`, `apps/api/src/workers/handlers/agent-employee-message.ts`, `apps/api/src/lib/mcp-tools.ts`, `packages/db/src/schema.ts:1149` (`agent_employees`), `packages/db/src/schema.ts` (`wiki_pages`, `agent_memory`)

---

## Executive summary

During demo feedback sessions, multiple builders suggested that instead of shipping native agent employees (custom prompts + trust levels baked into Deft), we should let users deploy their own agent containers and have Deft act as the data/memory layer. The specific framework being pointed at is **OpenClaw** — the MIT-licensed, multi-model, multi-channel AI assistant runtime that grew to ~247k GitHub stars in four months and has explosive mindshare in April 2026.

The recommendation in this doc is: **keep Defty native, convert agent employees into OpenClaw deployments, and build an MCP server in Deft that exposes the wiki as shared memory across all employees**. This inverts Deft's positioning from "AI workspace with an agent" to "AI workspace with a native agent AND the memory layer for your whole agent fleet." It gives up nothing (Defty stays as the demo centerpiece) and gains BYOK pricing, framework agnosticism, cross-agent knowledge sharing, and a stronger moat.

The integration is concrete: OpenClaw's official Docker image is published at `ghcr.io/openclaw/openclaw:latest`, one-click deploy paths exist on DigitalOcean ($12/mo official hardened droplet), Hostinger (hPanel Docker Manager catalog), Railway (community 1-click template), Coolify, and Dokploy. OpenClaw's built-in OpenAI-compatible `/v1/chat/completions` HTTP surface + MCP client registry (streamable-http with bearer headers) provides everything Deft needs without touching OpenClaw's source. Estimated effort for a shippable MVP: **~4 days**.

---

## 1. The split: what stays native, what becomes OpenClaw

| | **Defty (native, unchanged)** | **Agent employees (OpenClaw-hosted)** |
|---|---|---|
| Runtime | `apps/api/src/lib/agent-runner.ts` inside API process | External OpenClaw Gateway, user's VPS or managed host |
| Data access | Direct SQL via `agent-tools.ts` (~30ms) | MCP HTTP to Deft MCP server (~100ms/call) |
| Model | Deft's Anthropic key | User's key (BYOK by default) |
| Memory | Reads wiki via native tools | Reads/writes wiki via `memory_recall` / `memory_write` MCP tools |
| Scope | Org-wide, workspace-aware | Role-scoped, per-employee |
| Marginal cost to Deft | Pays per LLM call | Zero |
| Failure isolation | Shared API process | Isolated container — dead employee doesn't wedge Defty |
| Demo story | "Defty has direct SQL — impossible to replicate" | "Employees are OpenClaw, deploy any of them in 2 min" |

**Why this split and not "all OpenClaw":** Defty's direct-SQL access is the core thesis of the product and the reason builders find the demo interesting. Routing Defty through MCP adds 100-300ms per data call and dilutes the "native data access" pitch. Keep it native.

**Why this split and not "all native":** Native employees force Deft to maintain every role-specific system prompt, pay for every LLM call, eat every compute hang, and own the agent-framework arms race forever. OpenClaw is already winning the OSS agent-framework category; we should ride it, not compete with it.

---

## 2. Architecture diagram

```
  User's VPS                              Deft API (Hono)
┌────────────────────────┐              ┌────────────────────────┐
│ OpenClaw Gateway       │              │ /api/mcp/v1  (NEW)     │
│ :18789                 │              │                        │
│                        │              │ Tools exposed:         │
│ /v1/chat/completions ◄─┼── Deft POSTs─┤ - memory_recall        │
│ (OpenAI-compat, SSE)   │              │ - memory_write         │
│                        │              │ - memory_update        │
│ MCP client registry    ├── MCP HTTP ──┤ - task_query/create    │
│ (streamable-http)      │   streamable │ - message_post         │
│                        │              │ - thread_fetch         │
│ Agent model:           │              │                        │
│ Claude Opus 4.6 (BYOK) │              │ Auth: per-employee     │
│ memory slot: none      │              │ bearer, scoped to      │
│ (Deft is sole brain)   │              │ employee_id + org_id   │
└────────────────────────┘              └────────────────────────┘
         ▲                                       │
         │                                       ▼
         │                              ┌────────────────────────┐
  Deft wizard SSH/curl                  │ wiki_pages +           │
  bootstraps config                     │ agent_memory           │
                                        │ (Postgres + tsvector + │
                                        │  pgvector later)       │
                                        └────────────────────────┘
```

### End-to-end flow for `@Alex PM draft this week's roadmap` in `#general`

1. Deft web → socket.io → Deft API (Hono)
2. `messages.ts` POST handler inserts the message; `parseMentions` extracts the Alex PM user id; the existing `agent-employee-message` job is enqueued (this was just wired up on 2026-04-13)
3. Worker checks `agent_employees.kind`:
   - `native` → existing `runAgentQuery` path (current Alex PM behavior; kept for the demo seed)
   - `openclaw` → POST `https://<vps>:18789/v1/chat/completions` with `model: openclaw/alex-pm`, `stream: true`, body = trigger + thread context + bearer = Gateway token
4. OpenClaw Gateway routes to the agent; agent calls Claude Opus 4.6 with tools
5. Agent issues `tool_use: deft_memory_recall({query: "roadmap"})`
6. OpenClaw's MCP client POSTs to `api.deft.io/mcp/v1/tools/call` with the employee's Deft-issued bearer
7. Deft MCP server runs `ts_rank(search_vector, plainto_tsquery($q)) * confidence DESC` over `wiki_pages` filtered by `agent_employee_id = $employee_id OR agent_employee_id IS NULL` (employee-scoped + org-shared)
8. Returns JSON snippets; agent may call `deft_task_query` next to scan active tasks
9. Agent finalizes a reply; SSE streams tokens back to Deft's worker
10. Worker writes the reply as a new message with `user_id = employee.user_id, parent_id = triggerMessage.id`
11. Socket broadcasts; clients render the reply in the thread

The 60s hard timeout wrapper added to `agent-employee-message.ts` on 2026-04-13 stays — it's even more critical now that the runtime is external.

---

## 3. Schema changes

Add to `agent_employees` in `packages/db/src/schema.ts`:

```ts
kind: text('kind').$type<'native' | 'openclaw' | 'claude_sdk' | 'custom_mcp'>().default('openclaw').notNull(),
connection_url: text('connection_url'),              // e.g. https://vps.example.com:18789
mcp_token_hash: text('mcp_token_hash'),               // bcrypt hash of the bearer Deft issued
connection_status: text('connection_status').$type<'pending' | 'connected' | 'error'>().default('pending').notNull(),
// Reuse existing columns: last_heartbeat_at (already present), system_prompt (becomes template), trust_level
```

Columns that stop being load-bearing for `kind !== 'native'`:

- `system_prompt` — becomes a **template** shown in the wizard; the actual prompt lives in the OpenClaw config on the user's VPS
- `native_tools`, `mcp_connection_ids`, `disabled_tools` — the external agent owns its own tool config
- `trust_level` — enforced at the Deft MCP server's token scope, not inside an agent loop
- `max_daily_actions` / `daily_action_count` — enforced by Deft at the MCP layer on write calls

Existing `is_byoa` becomes redundant; `kind !== 'native'` is the new discriminator. Keep `is_byoa` for a migration window, drop in v1.1.

**Migration for the existing seed Alex PM** (`7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633`): flag it `kind='native'` at migration time so the current demo surface does not break. Set new employees to default `kind='openclaw'`. The native code path stays as a "first-party reference implementation" of what Deft-native looks like.

---

## 4. The MCP server (new, `apps/api/src/routes/mcp-server.ts`)

A Hono sub-router exposed at `/api/mcp/v1` that implements the MCP streamable-http transport spec. Initial tool set:

| Tool | Purpose | Writes? | Approval-gated? |
|---|---|---|---|
| `memory_recall({query, limit, scope})` | `ts_rank * confidence` search over `wiki_pages` scoped to employee + org-wide pages | no | no |
| `memory_write({title, body, type, confidence, scope})` | insert into `wiki_pages` with `agent_employee_id` set to token's employee | yes | no (writes to own scope only) |
| `memory_update(slug, patch)` | last-write-wins update; requires `agent_employee_id` match or org-promoted page | yes | yes if promoting to org scope |
| `memory_list({type, limit})` | enumerate memory for the employee | no | no |
| `task_query(filter)` | read `tasks` table filtered by org scope | no | no |
| `task_create(payload)` | insert task; trust-level gated | yes | yes (auto/quick/full per trust) |
| `message_post(space_id, content)` | post message with `user_id = employee.user_id` | yes | yes |
| `thread_fetch(message_id)` | read conversation history under a parent | no | no |

**Auth:** every request carries `Authorization: Bearer <token>`. The token resolver:

1. Looks up `agent_employees` by matching bcrypt hash of the incoming token against `mcp_token_hash`
2. Returns `{ employee_id, org_id, trust_level }`
3. If no match, returns 401

Every write-path tool runs through `agent-approval.ts:shouldAutoExecute(toolName, trustLevel)`. Failed approval returns a pseudo-success tool_result with `{ status: "queued_for_approval", approval_id }` so the agent can continue its reasoning chain without treating it as a hard error. The approval UI on Deft's web side drains the queue.

**Per-employee token generation:**

- Generated at "Deploy agent" time via `crypto.randomBytes(32).toString('base64url')`
- Shown **once** in the wizard UI with a "copy to clipboard" affordance
- Only the bcrypt hash is stored in `agent_employees.mcp_token_hash`
- Revoke = set `mcp_token_hash = NULL` + `connection_status = 'revoked'`
- Rotate = new token, new hash, replay the wizard

---

## 5. The OpenClaw config Deft's wizard generates

```json5
// ~/.openclaw/openclaw.json — auto-generated by Deft Settings → Agent → Deploy
{
  $schema: "https://docs.openclaw.ai/schemas/openclaw.schema.json",
  env: { vars: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" } },

  gateway: {
    bind: "0.0.0.0",
    port: 18789,
    auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
    http: { endpoints: { chatCompletions: { enabled: true } } },
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
    slots: { memory: "none" },           // Deft is the sole memory source
    entries: { "memory-wiki": { enabled: false } },
  },

  agents: {
    defaults: {
      workspace: "~/.openclaw/workspace",
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["anthropic/claude-sonnet-4-6"],
      },
      skills: [],
      timeoutSeconds: 600,
      maxConcurrent: 4,
    },
    list: [{
      id: "alex-pm",
      default: true,
      systemPromptFile: "~/.openclaw/prompts/alex-pm.md",
      tools: { allow: [
        "deft_memory_recall", "deft_memory_write",
        "deft_task_query", "deft_task_create",
        "deft_message_post", "deft_thread_fetch",
      ]},
    }],
  },

  channels: {},  // No native channels — Deft is the only inbound surface
}
```

Deft exposes `GET /api/agents/:slug/config` that interpolates the tokens server-side and returns the JSON5 with `Content-Disposition: attachment`. The wizard also ships a sidecar `alex-pm.md` file containing the role-specific system prompt.

---

## 6. One-click deploy landscape

| Provider | 1-click OpenClaw? | Min $/mo | Deploy URL / path | Gotcha |
|---|---|---|---|---|
| **DigitalOcean** | ✅ **Official 1-click droplet**, security-hardened, Docker-isolated | **$12** | `marketplace.digitalocean.com/apps/openclaw` | Public droplet — must `ufw` port 18789 to Deft origin only |
| **Hostinger** | ✅ **Official hPanel Docker template** (Docker Manager → Catalog → OpenClaw) | **~$5-8** (KVM1/KVM2) | Wizard deep link into hPanel Docker Manager | Needs ≥2 GB RAM plan |
| **Railway** | ✅ **Community template** with web setup wizard + persistent volume | ~$5 starter + usage | `railway.com/deploy/openclaw-railway-template` | Deploy button is Railway-native, embeds cleanly in Deft's wizard |
| **Coolify** (self-hosted PaaS) | ✅ First-class catalog entry | host cost only | `coolify.io/docs/services/openclaw` | Requires user already runs Coolify |
| **Dokploy** (self-hosted PaaS) | ✅ First-class template | host cost only | `docs.dokploy.com/docs/templates/openclaw` | Dokploy prerequisite |
| **Hetzner CX22 + Coolify** | Community-recommended budget combo | **€3.99** | n/a (via Coolify) | Needs Coolify install first |
| **Fly.io** | No official template | ~$2-3 | n/a | Needs custom `fly.toml` — deferrable |
| **Render** | No official template | $7 starter web service | n/a | Long-running gateway fits web-service model |
| **Vercel** | ❌ Doesn't fit — long-running port 18789 can't live on serverless | — | — | Skip |
| **OpenClaw Launch** (project's own managed tier) | Dashboard-only, no deploy API | n/a | — | **Do NOT list in the wizard** |

**Canonical artifact:** `ghcr.io/openclaw/openclaw:latest` — the official Docker image. Every provider above either pulls it directly or wraps it. The wizard's source of truth is one image tag; all deploy paths converge on it.

---

## 7. Recommended happy path for the setup wizard

**Top pick — DigitalOcean 1-click droplet.** Official, security-hardened, Docker-isolated, has a built-in `/opt/update-openclaw.sh` update script, and lands at $12/mo — the lowest "no prerequisites, no account juggling, fully managed VPS" entry point. The wizard:

1. Generates the OpenClaw JSON5 config + role-specific system prompt file
2. Pre-signs the Deft MCP bearer token (shown once)
3. Opens a "Create droplet" button pointing at `marketplace.digitalocean.com/apps/openclaw` in a new tab
4. Gives the user one shell command to bootstrap the config once the droplet is live:
   ```bash
   curl -H "Authorization: Bearer $DEFT_USER_TOKEN" \
     -o /root/.openclaw/openclaw.json \
     https://api.deft.io/api/agents/alex-pm/config && \
   systemctl restart openclaw
   ```
5. A "Test connection" button POSTs a ping to `https://<user-entered-url>:18789/v1/chat/completions`
6. On successful SSE close, the employee flips to `connection_status='connected'` and becomes `@mention`-able

**Runner-up — Hostinger hPanel template.** For users already on Hostinger (large India/SEA overlap with Deft's likely early user base), the Docker Manager → Catalog → OpenClaw flow is the lowest-friction path because there's no new billing account.

**Devs — Railway 1-click template.** For users who want CI-tracked deploys + GitHub sync. The `railway.com/deploy/openclaw-railway-template` URL is embed-ready.

**Power users — "Bring your own URL".** Plain form for users who already have Hetzner + Coolify, Dokploy, or a raw Docker host. No bootstrapping, just URL + Gateway token validation + handshake test.

### Wizard UX (Settings → Agent → Deploy)

1. **Role picker** — PM / Designer / CFO / QA / Customer Success / Custom. Hydrates the system prompt template.
2. **Hosting picker** — DigitalOcean (recommended) / Hostinger / Railway / Advanced (BYO URL). Each card shows min cost, official-vs-community badge, and a 1-sentence gotcha.
3. **Config generate** — Deft issues `DEFT_MCP_TOKEN` (per-employee, stored as bcrypt hash) and `OPENCLAW_GATEWAY_TOKEN` (shown once). Generates the JSON5 config. Shows the copy-paste install script.
4. **External deploy** — user clicks through to the provider's 1-click page. Comes back with a public URL.
5. **Handshake** — Deft POSTs a ping to `/v1/chat/completions`; on successful SSE close, flips `connection_status='connected'`, schedules a 60s heartbeat ping.
6. **Approval mapping** — Deft asks which write tools (`task_create`, `message_post`, `gmail_draft`) should auto-execute vs queue for approval. Stored on the `agent_employees` row, enforced at the MCP server boundary.

---

## 8. Phased implementation

### Phase 0 — Prep (day 0, ~2 hours)
- Drop this doc into `docs/superpowers/plans/`
- Review `packages/db/src/schema.ts:1149` current `agent_employees` shape
- Write the schema migration locally, don't commit yet

### Phase 1 — MCP server MVP (day 1, ~6 hours)
**Goal:** Deft exposes a functioning MCP server with two tools, so an OpenClaw container on a laptop can do full round trips against a local Deft instance via ngrok.

Files:
- **Create** `apps/api/src/routes/mcp-server.ts` — Hono sub-router mounted at `/api/mcp/v1`, implements MCP streamable-http transport
- **Create** `apps/api/src/lib/mcp-token.ts` — `issueEmployeeToken()`, `resolveEmployeeToken()` using `crypto.randomBytes` + `bcrypt`
- **Modify** `packages/db/src/schema.ts:1149` — add `kind`, `connection_url`, `mcp_token_hash`, `connection_status` columns
- **Migration** `packages/db/drizzle/0006_agent_employee_openclaw.sql`
- **Modify** `apps/api/src/index.ts` — mount `/api/mcp/v1` routes

Tools shipped in phase 1: **`memory_recall` and `memory_write` only**. Everything else is phase 3.

Acceptance:
- Manual `curl` with a test bearer can call `memory_recall` and get wiki snippets
- `memory_write` inserts a row in `wiki_pages` with the correct `agent_employee_id`
- 401 on missing / wrong bearer
- Unit test of `resolveEmployeeToken()` in isolation

### Phase 2 — OpenClaw bridge in the worker (day 2, ~4 hours)
**Goal:** `agent-employee-message` worker can dispatch to an OpenClaw runtime over HTTP instead of calling `runAgentQuery` locally, when the employee's `kind === 'openclaw'`.

Files:
- **Modify** `apps/api/src/workers/handlers/agent-employee-message.ts` — branch on `employee.kind`:
  - `native` → existing `runAgentQuery` path (unchanged)
  - `openclaw` → POST to `employee.connection_url + '/v1/chat/completions'` with bearer from the org's stored Gateway token, `model: openclaw/<employee.slug>`, `stream: true`, body = thread context + trigger message. Read SSE stream. Post reply in thread same as today.
- **Create** `apps/api/src/lib/openclaw-client.ts` — thin SSE client wrapping `fetch` with proper stream parsing and the existing 60s timeout wrapper
- **Verify** the timeout wrapper from 2026-04-13 still fires on remote hangs

Acceptance:
- Local OpenClaw Docker container on laptop receives a chat request from Deft worker
- Streams back a reply; Deft posts it in the correct thread
- 60s timeout fires if the container is paused

### Phase 3 — Wider tool surface (day 2.5, ~3 hours)
Add `memory_update`, `memory_list`, `task_query`, `task_create`, `message_post`, `thread_fetch` to the MCP server. `task_create` and `message_post` go through `agent-approval.ts:shouldAutoExecute`; queued-for-approval returns a structured `{ status: "queued_for_approval", approval_id }` pseudo-result.

Files:
- **Modify** `apps/api/src/routes/mcp-server.ts` — add the six additional tools
- **Modify** `apps/api/src/lib/agent-approval.ts` — add a helper `asPseudoResult(actionId)` used by MCP write tools
- **Modify** the action log UI (`apps/web/src/app/(app)/settings/agent/page.tsx`) — show MCP-origin actions with an "OpenClaw" badge

### Phase 4 — Setup wizard (day 3, ~6 hours)
**Goal:** user can go from empty state to a live Alex PM in <10 minutes with a DigitalOcean droplet.

Files:
- **Create** `apps/web/src/app/(app)/settings/agent/deploy/page.tsx` — 6-step wizard with role picker, hosting picker, config preview, token display, handshake test, approval mapping
- **Create** `apps/api/src/routes/agents-deploy.ts` — `GET /api/agents/:slug/config` returns the generated JSON5
- **Create** `apps/web/src/components/copy-once.tsx` — reusable "shown once" secret display component
- **Modify** `apps/web/src/app/(app)/settings/agent/page.tsx` — add "Deploy new employee" CTA, list existing employees with their `connection_status`

Acceptance:
- DigitalOcean path generates a working config + copy-paste install command
- Hostinger path generates the same config with a deep link to hPanel's Docker Manager
- Railway path generates a pre-filled deploy button URL
- "Advanced" path accepts a BYO URL + Gateway token and validates both via handshake

### Phase 5 — Heartbeat + connection health (day 3.5, ~2 hours)
- Cron job every 60s pings all `kind='openclaw', connection_status='connected'` employees at their `/health` endpoint
- Flips to `connection_status='error'` on 3 consecutive fails
- Agent page shows a warning pill next to unhealthy employees

### Phase 6 — Embeddings for `memory_recall` (day 4, ~4 hours)
**Deferrable to v1.1.** The existing `embed-content` worker already populates embeddings; finish wiring it to `wiki_pages` and add a pgvector column. MCP server's `memory_recall` becomes hybrid: FTS + cosine, reranked by `confidence`.

### Phase 7 — Migration safety (day 4.5, ~2 hours)
- Backfill migration sets existing Alex PM seed row to `kind='native'`
- Smoke test: existing `@Alex PM hi` demo still works identically
- Add a feature flag (`FEATURE_OPENCLAW_EMPLOYEES`) so the Deploy button is only visible to accounts we opt in

**Total MVP effort:** ~4 working days (Phases 1-5), ~6 days with embeddings + feature flag.

---

## 9. Pitch shift

| Audience hears | Old pitch | New pitch |
|---|---|---|
| Workspace | "AI-native workspace with a built-in agent" | "AI-native workspace with a native agent" (Defty) |
| Employees | "We ship Alex PM" | "**Deploy any agent you want — they share one brain**" |
| Answer to "why not OpenClaw" | hand-wave | "our **employees are OpenClaw**, deployed from our setup wizard" |
| Moat | "direct SQL access" | "direct SQL access **AND** the memory layer your fleet of agents plugs into" |
| Pricing | implicit Deft pays for AI | $3/mo Deft + BYOK employees = user pays for their own model |

OpenClaw stops being a rival and becomes a body you rent. The brain is still Deft.

---

## 10. Risks + showstoppers

1. **Full-operator auth on `/v1/chat/completions`** (high). OpenClaw's docs explicitly warn that the shared-secret auth on this endpoint grants full operator access. Deft cannot multi-tenant a single Gateway across orgs. Mitigation: one Gateway instance per org, documented in the wizard. Power users with multi-org deployments get their own Gateway per workspace.
2. **Schema drift velocity** (medium). OpenClaw's config schema churned daily through Q1 2026. Mitigation: pin the version in the wizard to a specific Docker tag, regenerate user configs on upgrade.
3. **Foundation governance uncertainty** (medium). Peter Steinberger joined OpenAI in Feb 2026; the project moved to a foundation "supported by OpenAI." Bus factor is unclear. Mitigation: our bridge is framework-agnostic — if OpenClaw dies we swap to Claude Agent SDK without touching the MCP server, schema, or wizard.
4. **Latency** (medium). External agents add 5-15s to a chat reply (previously 3-5s native). Mitigation: keep Defty native for snappy demos; employees are fine with this latency since they're expected to do more reasoning.
5. **MCP client approval compliance** (medium). We don't know yet if OpenClaw's MCP client treats Deft's "queued for approval" pseudo-result as a tool failure or a continue-signal. Needs empirical test on day 1.
6. **OpenClaw Launch has no deploy API** (low once we acknowledge it). Skip Launch entirely in the wizard; self-host only.
7. **Memory-plugin silencing** (low). Setting `plugins.slots.memory = "none"` should disable OpenClaw's internal memory, but docs hint the agent system prompt still references a workspace `MEMORY.md`. Needs a canary test.
8. **Seed Alex PM breaking** (low). Mitigation: keep seed row as `kind='native'` through the transition. No change to the 2026-04-13 demo surface.

---

## 11. Non-goals (for this plan)

- Re-platforming Defty onto OpenClaw (no)
- Building our own agent runtime as an alternative to both (no)
- Shipping OpenClaw Launch integration (no — dashboard-only, no API)
- Multi-Gateway multi-tenancy on a single VPS (no — one Gateway per org)
- A "Deft-hosted employee runtime" tier (deferrable to v2; adds compute cost and ops burden)
- Real-time streaming of agent tokens into the chat UI (chat already handles atomic replies fine; SSE-to-socket fan-out is a v2 UX upgrade)

---

## 12. Open questions (empirical tests needed)

### Must resolve before shipping

1. **MCP approval flow behavior.** Does OpenClaw's MCP client treat `{ status: "queued_for_approval", approval_id }` as a successful tool_result the agent can reason over, or as an error it retries / aborts on? If it's the latter, we need a different approval UX (e.g., return a natural-language "this action needs approval" string and let the agent respond with that).
2. **`plugins.slots.memory = "none"` completeness.** Does this fully silence every internal memory write path, or does the agent still try to persist to the workspace `MEMORY.md` that the system prompt references? If incomplete, we may need to patch the system prompt template or mount the workspace to `tmpfs`.
3. **Concurrency per Gateway.** How many simultaneous `/v1/chat/completions` requests can one OpenClaw Gateway handle on a $12 DigitalOcean droplet? If the answer is <5, we need to advertise resource limits to users or size up the default recommendation.
4. **MCP tool namespacing.** When a Deft MCP server exposes `memory_recall`, does OpenClaw's agent see it as `memory_recall` or `deft_memory_recall`? Both are valid per the MCP spec; we need to know which to document in the allow-list.
5. **p50/p95 latency.** Baseline a `@Alex PM hi → reply` round-trip on a fresh $12 droplet with an empty wiki. Any number above ~8s breaks the "agent is a teammate" vibe we want on the demo.

### Nice to know but not blocking

6. **System-prompt override.** Is `systemPromptFile` in the config a full replacement or merged with OpenClaw's built-in system prompt assembly? If merged, we may need to override the plugin-author hook to suppress OpenClaw's own prose.
7. **Does the Gateway expose Prometheus metrics?** If yes, Deft can scrape `/metrics` from each connected employee and show real stats (messages/min, tool calls, latency) on the Agent page without re-implementing telemetry.
8. **Fallback model behavior.** If `fallbacks: ["anthropic/claude-sonnet-4-6"]` triggers, does the agent's MCP tool call history carry over, or does it start fresh? Affects UX of mid-conversation degradation.
9. **Webhook-driven replies.** OpenClaw's webhooks plugin is ingress-only per current docs. Is there a plan for outbound webhooks so Deft can register a callback URL instead of holding the SSE connection open for long-running turns? If yes, we get async-friendly handling for 60s+ tool chains.
10. **Auth isolation for `/v1/chat/completions`.** Is there any roadmap item for per-agent scoped tokens (vs. one operator-level token)? Would change our "one Gateway per org" recommendation if so.
11. **Self-hosted embedding provider support.** If a user wants to BYOK OpenAI for the LLM but run embeddings locally (llama.cpp), does OpenClaw let them split? Relevant for the BYOK pricing pitch.
12. **Multi-channel + Deft simultaneously.** If a user also wants their OpenClaw instance to run a Slack or Telegram channel alongside Deft, does the `channels: {}` empty-object block conflict with that? Or is it purely additive? Affects whether the wizard can co-exist with other OpenClaw uses.
13. **Docker image update cadence.** How often does `ghcr.io/openclaw/openclaw:latest` bump, and does the DigitalOcean 1-click droplet pin to a specific tag or float? If it floats, we have a silent-breakage risk we need to monitor.

### Strategic / non-technical

14. **Do we want a "Deft-hosted employee" tier eventually?** If so, at what price point does it make sense vs BYO VPS? Needs user research.
15. **Do we open source the MCP server?** Making it public + documented would let third-party agent frameworks (CrewAI, LangGraph, custom) integrate with Deft too, strengthening the "Deft is the memory layer" pitch but also inviting copycats.
16. **Should Defty also use the MCP server, for dogfooding?** Would unify memory access patterns but costs ~50-100ms per Defty data call (vs direct SQL). Probably no for demo paths, maybe yes for background workers.

---

## 13. Next step

Ship **Phase 1 (MCP server MVP with `memory_recall` + `memory_write`)** before anything else. It's self-contained, testable against a local OpenClaw Docker container on a laptop via ngrok, and the outcome of that 6-hour spike answers open questions 1, 2, and 4 simultaneously. Everything else is contingent on those answers.

If Phase 1 goes clean, proceed to Phase 2-5 over the rest of the week and aim to have a working Deploy button in Settings by the next demo round.
