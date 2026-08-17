# CLAUDE.md — Deft

## What is this?

Deft is an open-source AI-native workspace. Native chat + tasks + an AI agent that plans and executes multi-step workflows across native data and connected calendar feeds and BYOA-provided external tools. The agent has direct SQL access to native data — not API calls — making it fundamentally faster and smarter than bolt-on AI features.

One Next.js app. One Postgres database. Multi-tenant SaaS with org_id on every table.

Licensed under BSL 1.1: use for any purpose except hosting as a service for third parties. Mandatory attribution in forks.

## Architecture

```
deft/
├── apps/
│   ├── web/          # Next.js 14 (App Router, TypeScript, Tailwind CSS)
│   └── api/          # Hono (TypeScript, REST endpoints, WebSocket via Socket.io)
├── packages/
│   ├── db/           # Drizzle ORM schema + client + migrations
│   ├── mcp/          # MCP server SDK + tool definitions for BYOA agents
│   └── shared/       # Shared types, Zod schemas, constants
├── docker-compose.yml  # Self-host: postgres + app
├── .env.example
├── LICENSE             # BSL 1.1
└── pnpm-workspace.yaml
```

**Stack:**
- Frontend: Next.js 14, App Router, TypeScript, Tailwind CSS, TipTap (editor)
- API: Hono on Node.js, TypeScript
- Database: PostgreSQL + pgvector (Drizzle ORM)
- Real-time: Socket.io in-process (single app instance; no cross-instance adapter)
- Auth: Custom JWT + bcrypt (jsonwebtoken + bcryptjs, Google OAuth)
- Background jobs: PostgreSQL `job_queue` with in-process workers
- File storage: Cloudflare R2 or local (presigned uploads)
- AI: Anthropic Claude API (Sonnet for reasoning, Haiku for classification)
- Email: none. Invites and password recovery are admin-generated one-time URLs (`apps/api/src/routes/invites.ts`, `POST /api/members/:id/recovery-url`), shared out-of-band. Self-hosted Deft never sends mail.
- Monorepo: pnpm workspaces

## Database Design Principles

- `org_id` on EVERY table (multi-tenant, row-level isolation)
- Soft deletes everywhere (agent needs historical context)
- `created_at`, `updated_at` on every table
- UUIDs for primary keys (cuid2)
- All user-generated text stored as-is, never truncated
- Events table for connected tool data (unified schema)

## Code Conventions

- TypeScript strict mode everywhere
- Zod for all request/response validation
- Drizzle ORM — no raw SQL except in agent queries (agent needs direct access)
- API routes: `POST /api/spaces`, `GET /api/spaces/:id/messages`, etc.
- WebSocket events: `message:new`, `message:edited`, `typing:start`, `task:updated`
- Error responses: `{ error: string, code: string }` — never raw stack traces
- Components: functional React, no class components, prefer server components where possible
- Styling: Tailwind only, no CSS modules, no styled-components
- State: React hooks + context for client state, SWR or React Query for server state
- File naming: kebab-case for files, PascalCase for components
- **Slash menu for editor surfaces.** All TipTap editor surfaces (chat, task description, task comment, notes, canvas) mount the `BlockSlashMenu` extension via `createBaseExtensions({ surface })` in `apps/web/src/lib/editor/shared-config.ts`. Add new slash commands by registering them on `slashRegistry` in `apps/web/src/lib/editor/commands.ts` — declare which surfaces they appear in via the `surfaces` array. Block commands live in `built-in-commands.ts`; AI actions live in `ai-commands.ts`. AI actions hit `POST /api/ai/transform` (one endpoint, action-typed).

## Agent Architecture

The agent is NOT a chatbot. It's a workflow engine.

**Two agent roles** (collapsed from five in Phase 9, 2026-04-28):
- **Defty** — built-in platform agent. Runs in-process via Anthropic API, has direct SQL access plus 42+ native tools, multi-step planning (`create_plan`), memory (remember/recall), and streaming responses. Lives behind `apps/api/src/workers/handlers/agent-reply.ts` with a well-known `deft-agent@system.local` user. No `agent_employees` row, no `kind` column, no choice. Operates under the org-wide trust level. Reactive only — responds to `@mentions` and triggers.
- **BYOA employees** — every `agent_employees` row. External agents (Claude Code, Claude Desktop, Codex, Cursor, custom MCP runtimes) connecting via MCP. Authenticate with API key, get tools via `/api/mcp/v1`. Per-employee trust levels, daily action caps, cost tracking, circuit breakers. Push is gone — Deft never pushes to BYOA agents. They discover work via `poll_pending_work` MCP tool: `@mentions`, heartbeat ticks, and `trigger_subscriptions`-routed events all queue `agent_actions` rows that BYOA clients pull.

Agent engine lives in `apps/api/src/lib/` (agent-context, agent-plans, agent-tools, agent-actions, agent-runner, agent-stream-loop, agent-approval, agent-approval-resolver). The `packages/ai` stub was removed 2026-04-16.

**Participant model (Phase 1 unification, 2026-05-07).** Agents are first-class
`users` rows distinguished by `users.kind` (`human | agent | system`). The Defty
system user has an `org_members` row in every org (auto-created by
`ensureDeftyMembership` on signup, invite acceptance, or via the backfill
script `apps/api/src/scripts/backfill-defty-membership.ts`); BYOA agent
employees do too. Both appear in `/api/members` (which now returns `kind`),
the @-autocomplete, and the DM picker. The hardcoded `'agent'` mention shim
was removed; agent-reply dispatch detects mentions by joining parsed mention
IDs to `users.kind = 'agent'`, with the legacy `@deft` regex retained as a
backwards-compat fallback. See `docs/superpowers/specs/2026-05-07-agent-chat-unification.md`.

**Phase 2 (2026-05-07).** `agent_conversations` and `agent_messages` tables
are dropped. Each `/agent` conversation is now a `spaces` row of type
`agent_conversation` with the user + agent (Defty or BYOA) as members.
Each agent turn is a `messages` row with structured Anthropic content
blocks in `metadata.agent_blocks`, plus `citations`, `tool_calls`,
`model`, `tokens_in`, `tokens_out`. Tool-result rows carry
`metadata.kind = 'tool_result'` so the chat-view filter excludes them.
The `/agent` UI is unchanged because the API contracts at
`/api/agent/conversations[/:id/messages|trace.json]` preserve their
response shapes; only the underlying data source changed.
`agent_actions.message_id` continues to link to chat messages — same
UUID space.

**Phase 3 (2026-05-07).** Two unified MCP tools added: `send_message`
(target = `{space_id}` | `{thread_id}` | `{user_id}` — replaces
`message_post` + `post_thread_reply` + planned `open_dm`) and
`fetch_unread` (unread chat messages + pending `agent_actions` in one
roundtrip — replaces `poll_pending_work`). The old tools still work
this release but log a deprecation warning. The `deft-mcp-client`
bundled skill prompt nudges agents toward the new tools.

**Phase 4 (2026-05-07).** UI collapse: the dedicated `/agent` route
and `AgentChat` / `ConversationList` components are deleted. Chat is
now the only agent-conversation surface — `SpaceChat` renders agent
messages with inline tool-use chips, citations footer, and model+tokens
detail via the new `<AgentMessageBlocks/>` component. Inline approval
cards (`<AgentActionCard/>`, extracted from the deleted AgentChat)
render on chat messages with pending `agent_actions`. The approval
inbox moved from `/settings/agent` to a top-level `/approvals` page;
the sidebar nav entry swapped "Agent" for "Approvals" with the same
red-badge count. Defty's DM is pinned at the top of the Direct
Messages section, followed by other BYOA agents.

**Phase 5 (2026-05-07).** Universal `/inbox`: one queue at `/inbox`
unifies notifications (mentions, task_assigned, task_updated, blocked,
cross_reference, wiki_update, system), DM unread (per-space rollup
from `space_members.last_read_at` vs `messages.created_at` for `dm` /
`group_dm` spaces), and pending agent approvals (from `agent_actions`).
Backed by `GET /api/inbox` (with `count_only=1` for the badge fetch
and `kind=` for tab filtering) plus `POST /api/inbox/read` for mark-read
(ids[] with `notif:` prefix, or `all: true`). Tab strip:
All / Mentions / DMs / Tasks / Approvals. The Tasks tab fetches all and
filters client-side for both `task_assigned` and `task_updated`.
Approval rows render the existing `<AgentActionCard/>`; everything
else renders `<InboxRow/>`. The sidebar `Approvals` entry was replaced
by `Inbox` with one aggregated red-badge count via `useInboxCount`.
`/approvals` is a server redirect to `/inbox?tab=approvals` so external
links keep working. No schema migrations — pure read-side aggregator.

**Phase 6 (2026-05-07).** Multi-agent affordances. (1) Agents partitioned
in `SpaceMembersPanel` into a separate "Agents" section with an
`<AIBadge/>` per row, mirroring Phase 4's `CreateDmModal` pattern;
backend member-add accepts any user kind unchanged. (2) Reply-storm
detector at `apps/api/src/lib/storm-detector.ts`: counts agent-authored
thread replies (per agent, per thread root) in a rolling 10-minute
window. On `count >= 5`, the BYOA `sendMessage` MCP tool (thread_id
target) and the Defty `post_thread_reply` executor return a
`STORM_DETECTED` error so the agent's runtime can back off. Top-level
posts and DMs are not throttled. (3) `<AIBadge/>` component extracted
into `apps/web/src/components/ai-badge.tsx` and reused by both
`CreateDmModal` and `SpaceMembersPanel`. No DB migration.

**Skills primitive (agent-only).** A single `skills` table with three source tiers — `bundled` (shipped with Deft, `org_id IS NULL`), `marketplace` (installable catalog), `org` (tenant-authored). Carries an `agent_config` JSONB (tools, capability packs, triggers, prompt additions, heartbeat checklists). Agents install skills via the `agent_employee_skills` junction. Bundled skills are generated dynamically — one per available capability pack (Deft Workspace carries the 9 task tools) plus `deft-mcp-client` (Block 3 on-ramp for BYOA agents to talk back into the workspace via MCP). Task templates are a separate first-class primitive (`task_templates` table) — instantiated into any project via `POST /api/projects/:id/apply-template`. Project-level customization via `project_skills` / `skills.project_config` was retired 2026-04-18 in favor of fixed engineering defaults. See `docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md`.

**Observation pipeline:** Every chat message classified (Haiku): actionable? Intent? Entities? Urgency?

**Planner:** Complex requests decomposed into ordered steps. Plan shown to user → user edits/approves → agent executes with live progress (streamed to task-detail panel per Task 3.10) → pauses on failure or rolls back per plan mode.

**Proactive comments:** The nudge-check worker drops agent-authored comments on stalled/overdue tasks and on auto-accepted task extractions (Task 3.11), deduped 7d per task. Inline agent task-suggestion cards appear in chat for classified actionable messages (Task 3.12).

**Tool registry:** All agent actions registered with name, params, approval tier, provider. Agent only sees tools for services the user has connected.

**Three-tier approval:**
- Auto-execute: task status from PR merge, meeting prep, reminders
- Quick-approve: create task, schedule meeting (one-click card)
- Full-review: multi-step plans and external writes (preview + edit)

**Trust levels (per org):** Conservative → Standard → Autonomous

**Native actions (direct SQL):** Create/update/assign tasks, post messages, set reminders
**Connected actions (API):** Create calendar events and read connected work events

**Event-driven triggers (PostgreSQL scheduled jobs):**
- Task overdue → DM assignee + alert lead
- Task stalled 48h → ask for update
- PR merged → parse `PREFIX-N` refs in title/body, move each matched task (in `todo`, `in_progress`, or `in_review`) to `done` and leave an attribution comment linking the PR. Wired into the GitHub sync path (`apps/api/src/workers/github-sync.ts` → `closeTasksForMergedPR`); runs only on the `pr_opened|pr_closed → pr_merged` transition so re-syncs don't re-fire. Tasks already `done` or `cancelled` are never touched.
- Meeting in 15min → generate prep briefing
- 9am daily → auto-generate standup from activity

## Task Architecture (Phases 0-6 shipped)

Tasks are the agent's primary output surface and the product's action surface. Post-Phase-6 they ship with:

- **Fixed project defaults.** Every project uses the 6-status engineering vocabulary (`backlog`, `todo`, `in_progress`, `in_review`, `done`, `cancelled`), p0–p3 priority, and Kanban default view. View switcher (Board / List / Timeline / Calendar / Pipeline) remains a per-user selection. Per-project customization (`project_skills`, `skills.project_config`, first-attached-wins resolution, custom fields, allowed-transitions overrides) was retired 2026-04-18 — see `docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md`.
- **Recurrence UI + clone fix** (Task 4.12) — recurring task pattern stored on `tasks.recurrence` (`daily` | `weekly` | `biweekly` | `monthly`) with `recurrence_source_id` linking generated copies.
- **Workflow executor (basic)** — PostgreSQL-queue-backed runner supporting the `task.status_changed` trigger with four actions: `add_comment`, `assign_to`, `add_label`, `notify` (Task 5.7). Broader trigger coverage + skill-defined triggers land in Phase 8.
- **Task reactions** (Task 6.3) — emoji reactions on task cards/detail (`task_reactions` table, upsert/delete endpoints).
- **@mentions in description + comments** (Task 6.4) — autocomplete + notification dispatch mirrors chat mentions.
- **Activity diff view** (Task 6.2) — inline old→new rendering in the task activity log, replacing flat "changed status" strings.
- **GitHub PR→Done** (Task 5.6) — polling sync worker parses `PREFIX-N` in PR title/body on the `pr_opened|pr_closed → pr_merged` transition and closes each referenced task with an attribution comment. Polling only, no webhook yet.
- **Project archive + soft-delete** (Task 5.8) — settings modal with 7-day recovery window. Soft-deleted projects hide from views but preserve tasks for audit.
- **Task 0.1 security fix (resolved)** — watchers + assignees routes enforce `org_id` + auth.
- **Task 0.4 dashboard fix (resolved)** — "My Work" filter on the bento dashboard now scopes to the current user.
- **Security hardening (Phase 7, resolved)** — 10 vulnerabilities fixed: XSS prevention via DOMPurify on all `dangerouslySetInnerHTML` sites (6 components), IDOR fixes on workflow-run/agent-message/wiki-citation deletes (verify ownership before delete), space membership enforcement on all space/message/pin endpoints + WebSocket `space:join`, upload path traversal fix (`path.basename` + Content-Disposition `attachment`), daily notes optimistic locking (CAS version check, 409 on conflict).

Dead primitives retired: the `native_tools[]` agent column was dropped (migration 0038) and the `TEMPLATE_DEFAULT_PACKS` constant removed (2026-04-16). `project_config` JSONB, `project_skills` table, and the three project-workflow bundled skills (`engineering`, `marketing-campaign`, `sales-pipeline`) were retired 2026-04-18 — projects now use fixed engineering defaults. Capability packs remain expressed as bundled agent skills installed via `agent_employee_skills`.

- **UI fixes (Phase 7)** — sidebar three-dot menu portal click propagation fixed (menu items now respond to clicks). Scroll containers added to 9 settings pages that were clipping content.

## Phase 8 — Heartbeat Autonomy (partially shipped)

The original Phase 8 plan was OpenClaw autonomy inside an in-process gateway. Phase 9 (2026-04-28) deleted the gateway; the autonomous loop is now the BYOA agent's responsibility. What the Deft side actually shipped — the heartbeat lifecycle and its guard rails — survived Phase 9 and now applies before BYOA-bound `agent_actions` rows are queued for MCP pickup.

Tasks 8.1–8.6 shipped on the heartbeat worker:

- **Heartbeat lifecycle** (Task 8.1) — PostgreSQL scheduled jobs dispatch due employees based on `heartbeat_interval_min`. Post-Phase-9, all employees are BYOA; heartbeat ticks queue pending work for MCP polling.
- **Per-tick logging** (Task 8.4) — every tick writes to `agent_heartbeat_turns` (fired_at, prompt_sha, action_count, tokens_in/out, cost_cents, outcome, summary) and broadcasts `agent:heartbeat:turn` via Socket.io.
- **Cost guardrails** (Task 8.5) — `daily_budget_cents` per employee (default $100/day), reset at UTC midnight. Circuit breaker: `unhealthy` flag tripped after 3 consecutive errors, blocks all autonomous dispatch until manually cleared via `PATCH /api/agent-employees/:id { mark_healthy: true }`.
- **Loop detection** (Task 8.6) — prompt_sha idempotency skips re-dispatch when nothing changed since last no_op tick. Consecutive identical action detector trips the circuit breaker.

**Not yet shipped:** skill-defined trigger dispatcher (arbitrary triggers from skill manifests, not just the hardcoded set of `cron:standup`, `member.joined`, `webhook`, `task.status_changed`).

## Key Design Decisions

1. Agent reads native data via direct SQL, not API calls. This is the core advantage.
2. Connected tools write to a unified `events` table. Agent queries native + events together.
3. Chat is the observation surface. Every message feeds the agent's context.
4. Tasks are the action surface. Agent creates and manages tasks as its primary output.
5. Dashboard is the intelligence surface. Agent-generated briefings, not static widgets.
6. Product works fully without AI. If LLM is down, chat + tasks function normally.
7. Multi-tenant from day 1. org_id on every query. No shortcuts.

## OpenClaw Unlock — Block 0 foundation (shipped 2026-04-19; gateway parts ARCHIVED in Phase 9)

> **ARCHIVED 2026-04-28.** OpenClaw was deleted in Phase 9. The in-process gateway, per-org provisioning, gateway-ping, ClawHub HTTP pass-through, and the `kind` column are all gone. Items below stayed because they're useful in the BYOA-only world (trust levels, durable reminders, semantic wiki search, per-org spend caps, SKILL.md sanitizer, ClawHub allowlist as a skill-import source, approval badge nav, post-creation employee edit). Items that depended on a live gateway (any `connection_url`/`gateway_token`/`provider_instance` plumbing) were stripped.

Block 0 of the OpenClaw Unlock plan closed the structural foundation bugs
and added invisible-today primitives. See
`docs/superpowers/plans/2026-04-19-openclaw-unlock.md` for the full plan.

**Shipped:**
- **Trust levels enforce per-tier.** Conservative auto-execs only `auto`; Standard adds `quick`; Autonomous adds `full` EXCEPT destructive admin tools (`manage_agent_employee`, `manage_mcp_connection`, `remove_member`, any `delete_*`, or any call with `params.mode: delete|pause|revoke`). 35-case matrix test in `apps/api/test/agent-approval-matrix.test.ts`.
- **Reminders durable.** Moved from in-process `setTimeout` to the Postgres-backed `scheduled-jobs` queue. Boot rehydrates pending reminders from `reminders.is_sent=false`. New `create_reminder` native agent tool.
- **Wiki search semantic.** `wiki_search` tool routes through `retrieveContext` which blends FTS + pgvector cosine (0.4 / 0.6 weight × confidence). Falls back to FTS-only when embeddings API is unavailable.
- **Wizards unified.** Old 7-step `/settings/agent/deploy` deleted; `NEXT_PUBLIC_FEATURE_OPENCLAW_EMPLOYEES` flag removed; canonical flow is the 3-step `/settings/agent-employees/create`.
- **Standup fallback retired.** If no employee subscribes to `cron:standup`, orgs admins get a single `standup_unconfigured` notification (7-day dedup) pointing at /library. No more native `llm()` path bypassing agent-runner.
- **Per-org LLM spend caps.** New `org_spend_caps` table; `checkOrgSpendCap`/`recordOrgSpendFromUsage` helpers; `llm()` gains optional `orgId` for opt-in enforcement. Default $100/mo new-org cap. Admin UI ships in Block 3.
- **SKILL.md sanitizer.** Pre-import library that neutralizes prompt-injection, credential-exfil, sensitive-file-access patterns. Block 1 consumes at ClawHub skill import time. 20 malicious + 5 benign fixtures.
- **ClawHub allowlist.** Daily cron pulls VoltAgent curated list into `clawhub_allowlist` table; bundled 14-entry static fallback on network failure. Block 1 Library UI filters against this table.
- **Approval badge in main nav.** `usePendingApprovals` SWR hook polls `/api/agent/actions/pending` every 15s; red count badge on the Agent nav entry app-wide.
- **Edit agent post-creation.** `PATCH /api/agent-employees/:id` accepts `name`, `avatar_url`, `starter_prompts`, `expertise_description`, `max_daily_actions`, `heartbeat_enabled` without role gate; trust/cadence/mark_healthy still require owner/admin.

Migrations added: `0047_clawhub_allowlist.sql`, `0048_org_spend_caps.sql`.

## OpenClaw Unlock — Block 1 control plane (shipped 2026-04-19; ARCHIVED 2026-04-28)

> **ARCHIVED 2026-04-28.** Phase 9 deleted the gateway control plane: `openclaw-{gateway,dispatch,client,chat-envelope}.ts` are in `docs/deprecated/openclaw/`, `pushSkillSecretsToGateway` is removed, the per-org provider-instance reuse logic is gone (the `provider_instances` table was dropped), the reasoning-trace component + hook were deleted (no live session events to subscribe to), and the gateway approval-forwarder is gone. Surfaces that survived because they're still useful in BYOA-only: the markdown personality editor (`/settings/agent-employees/[id]/personality` reading/writing the 7 canonical files locally, no longer pushed to a gateway), the `skill_secrets` table for storing BYOA per-skill credentials, ClawHub allowlist for skill import (allowlist row → marketplace skill row, no gateway install). The `request_skill_install` runtime tool stayed but no longer pushes to a gateway.

Block 1 delivers the OpenClaw Gateway control plane: a WebSocket
JSON-RPC client that every route/worker shares, plus the surrounding
surfaces that exercise it (skill install/remove, markdown file editing,
approval forwarding, reasoning trace, per-org gateway reuse).

**Shipped:**
- **Gateway RPC client.** `apps/api/src/lib/openclaw-gateway.ts`. WebSocket JSON-RPC 2.0 with multiplex-by-id, lazy connect, exponential-backoff reconnect (1s→2s→4s→8s→30s), 30s per-call timeout, per-deployment-id cache. Typed namespaces: `skills`, `agents.files`, `exec.approval`, `config`, `sessions`, `cron`. Transport is injectable (test seam).
- **agents.files.\* UI + API.** `GET/PUT /api/agent-employees/:id/files[/:filename]` routes + `/settings/agent-employees/[id]/personality` page with a markdown editor for the 7 canonical files (SOUL, AGENTS, USER, TOOLS, IDENTITY, HEARTBEAT, BOOT). 128KB cap, filename whitelist.
- **Live skill install/remove on attach.** `ensureSkillInstalled` fires `gateway.skills.install(slug, version)` live for connected openclaw employees alongside the junction insert. New `removeSkillFromEmployee` helper + `DELETE /api/skills/:id/install` route mirrors the semantics. Fire-and-forget — gateway errors don't roll back the DB write; reconciliation loop retries.
- **`skill_secrets` table.** Migration 0049. Encrypted per-org, per-skill credential store with helpers in `apps/api/src/lib/skill-secrets.ts`. Least-privilege: `getSecretsForSkill` only returns the keys declared by a skill's manifest.
- **ClawHub browse + import.** `GET /api/clawhub/browse` reads the VoltAgent-seeded allowlist; `POST /api/clawhub/import { slug }` materializes as a marketplace skill. New "ClawHub" tab on the Library page with per-entry Import button.
- **Pre-deploy install flow.** `resolveSecretsForInstall(orgId, skillId, requiredKeys)` — OAuth-first (connected_accounts) with skill_secrets fallback, env-var → provider prefix map (GITHUB_/GOOGLE_/LINEAR_). `pushSkillSecretsToGateway` calls `config.set('skills/<slug>/<KEY>', value)`. Orchestrator `installMarketplaceSkillWithSecrets(employeeId, skillId)` wires it end-to-end. New routes: `POST /api/skills/:id/install/marketplace`, `POST /api/skills/:id/secrets`.
- **Runtime install tool.** `request_skill_install(slug, agent_employee_id?, rationale?)` — new native tool, always queues for approval (tier='full' + DESTRUCTIVE_ADMIN_TOOLS). Executor looks up the slug on the allowlist (imports as marketplace skill on first use) and runs the pre-deploy flow. Slugs off the allowlist are rejected; full-ClawHub install stays admin-only.
- **Skill reconciliation loop.** `reconcileSkillsForEmployee` fires best-effort from the openclaw heartbeat branch. Diffs `agent_employee_skills` against `gateway.skills.list()`, auto-reinstalls missing via `gateway.skills.install`, emits `skill_drift` system notification to org admins after > 2 consecutive drifting ticks (24h dedupe).
- **Exec/plugin approval forwarding.** `startApprovalSubscriberFor(employeeId)` subscribes to `exec.approval.request` + `plugin.approval.request` events on the gateway and mirrors them as `agent_actions` rows (action=`openclaw_exec_approval`/`openclaw_plugin_approval`, tier=full). Existing approval-inbox UI renders them with no change. Approve/reject forwards back via `gateway.exec.approval.resolve(approvalId, approved, reason)`. Bootstrap from `workers/index.ts`.
- **Reasoning trace.** `startTraceForwarderForSession(employee, sessionId)` subscribes to `session.tool` + `session.message`, fans out `agent:trace` via Socket.io to `org:<orgId>` filtered by sessionId. Frontend `useReasoningTrace(sessionId)` hook + `<ReasoningTrace/>` expander component.
- **Per-org gateway for new deploys.** `deploy-provision` worker checks for an existing openclaw provider_instance in the org on the same provider; if found, the new employee inherits its `connection_url` + `gateway_token_encrypted` + `provider_instance_id`, skipping `provider.provision()`. Pre-existing per-agent deploys are NOT migrated (Open Question #4).

Migration added: `0049_skill_secrets.sql`.

**Known-deferred (Block 2):** full-ClawHub HTTP pass-through (currently stubbed); allowlist-auto under Standard/Autonomous trust; drawer-tab integration of the Personality editor; chat-surface integration of `<ReasoningTrace/>`; migration path for existing per-agent deploys.

## OpenClaw Unlock — Block 2 agent reach + visibility (shipped 2026-04-19; mostly intact)

> **Phase 9 note 2026-04-28.** Block 2 was already runtime-agnostic — the new tools (notes/canvas/decision/post_thread_reply) are exposed via MCP and work for BYOA agents unchanged. The `member.joined` onboarding trigger keeps working because `trigger_subscriptions` was preserved (it's the routing key for the trigger system, not OpenClaw plumbing). Dashboard inline approve/reject and the heartbeat checklist builder still apply. Nothing in this block needed to be removed.

Block 2 closed the dead zones where agents couldn't act and surfaced agent activity on the primary product surfaces. All 9 tasks shipped.

- **Note agent tools.** `search_notes` (ILIKE + scope filter), `read_note`, `create_note` (tier quick), `note_to_wiki` (auto-slug disambiguation, tier quick). Uses existing `notes` table.
- **post_thread_reply(parent_message_id, content).** Full-tier; inherits parent's `space_id`, broadcasts `message:new` socket event.
- **Canvas read/write.** `read_canvas(space_name)` returns exists=false when no row; `write_canvas(space_name, content, title?)` upserts (one canvas per space). String content is auto-wrapped into a minimal TipTap doc.
- **Blocked-message → task-create proposal.** `blocked-alert` worker now ALSO queues `agent_actions { action:'create_task', approval_status:'pending', source:'blocked_classifier' }` on the blocked user so they get a one-click "track this as a task" card.
- **unblock_dependents workflow action.** New action kind for workflow rules. When the triggering task enters `done`, DMs each open+assigned dependent task's assignee with a `subtype:'unblocked'` notification.
- **Decision ↔ task tools.** `link_decision_to_tasks(decision_id, task_ids, context?)` → cross_reference edges (idempotent). `mark_decision_implemented(decision_id)` → stamps `decisions.implemented_at` (migration 0050).
- **member.joined onboarding trigger.** `POST /api/members` fans out `employee-trigger` jobs to every agent whose `trigger_subscriptions` contains `member.joined`. Opt-in via HR skill install.
- **Dashboard inline approve/reject.** `/api/agent/actions/recent` returns recent actions; the existing "Agent Activity" bento card on `/dashboard` renders inline Approve/Reject buttons on pending items.
- **Structured heartbeat checklist builder.** New `<HeartbeatChecklistBuilder/>` component replaces the textarea for `HEARTBEAT.md` on the Personality editor. Rows → `- [ ] every Nmin: …` markdown the existing heartbeat parser already understands.

Migration added: `0050_decision_implemented.sql`.

## OpenClaw Unlock — Block 3 power users + ecosystem polish (shipped 2026-04-19; partially ARCHIVED 2026-04-28)

> **Phase 9 note 2026-04-28.** Clone agent + save-as-template stayed (still useful for BYOA scaffolding). Webhook-callable agents stayed — the dispatch path enqueues `employee-trigger` jobs which now queue `agent_actions` rows for BYOA pickup. `deft-mcp-client` bundled skill stayed (more relevant than ever). Agent trace export stayed. **Removed:** the "developer credentials" page no longer carries `wscat` examples or a JSON-RPC frame catalog (the gateway is gone) — it now shows the MCP endpoint URL + a regenerable bearer token, plus a Claude Desktop config snippet. The reasoning-trace component (Block 1) is also gone, so any chat-surface integration of `<ReasoningTrace/>` planned in Block 3 is moot.

Block 3 exit-gate met at 5/10 tasks with `deft-mcp-client` live. Remaining 5 deferred (see `docs/superpowers/block-3-complete-2026-04-19.md`).

- **Clone agent + save as template.** `POST /:id/clone` duplicates an employee with a fresh slug + all installed skills; `POST /:id/save-as-template` writes an org-scoped template row. Migration 0051 makes `agent_employee_templates.org_id` nullable (NULL = first-party/community; non-NULL = org-scoped) with COALESCE-keyed unique on (org_id, slug).
- **Developer credentials page.** `GET /api/agent-employees/:id/developer[?reveal=1]` + `/settings/agent-employees/[id]/developer` — masked token by default, reveal gated to admin/owner. Carries wscat one-liner + example JSON-RPC frames for SDK scaffolding.
- **Webhook-callable agents.** Migration 0052 + `agent_webhooks` table; migration 0060 added `hmac_key_encrypted`. Authenticated mgmt surface under `/api/agent-webhooks`, public dispatch at `/api/agent-webhooks/:slug` that enqueues an `employee-trigger` job with `trigger_kind='webhook'` + full payload in context. **Auth: HMAC-SHA256 signature in `x-deft-webhook-signature: sha256=<hex>` header (recompute over raw body using the per-webhook `hmac_key`); legacy raw-secret in `x-deft-webhook-secret` accepted with deprecation warning during transition window.** scrypt-hashed legacy secret + AES-encrypted HMAC key both stored at rest; constant-time signature comparison.
- **`deft-mcp-client` bundled skill.** On-ramp for any OpenClaw deployment (incl. BYOA) to talk back into its Deft workspace over MCP — seeded into the bundled catalog. `SkillAgentConfig` extended with `requires_env?: string[]` + `mcp_servers?: Array<{ name, transport, url|command, headers }>`.
- **Agent trace export.** `GET /api/agent/conversations/:id/trace.json` — format `deft.agent_trace.v1`, messages + actions + conversation metadata as one JSON download.

Migrations added: `0051_org_scoped_templates.sql`, `0052_agent_webhooks.sql`.

## Phase 9 — Agent Architecture Simplification (shipped 2026-04-28)

Collapsed five agent kinds (`native`, `openclaw`, `claude_sdk`, `custom_mcp`, plus the unkinded built-in Defty) down to two clear roles:

1. **Defty** — built-in platform agent. In-process via Anthropic API. No `agent_employees` row; routes through `agent-reply.ts` with a well-known system user. Serves `@deft` mentions and platform workflows.
2. **BYOA employees** — every `agent_employees` row. External agents (Claude Code, Claude Desktop, Codex, Cursor, custom MCP) connect via MCP with an API key, get tools through `/api/mcp/v1`, and pull pending work through `poll_pending_work`. Deft never pushes.

**Removed:**
- `kind` column on `agent_employees` (and the `'native' | 'openclaw' | 'claude_sdk' | 'custom_mcp'` enum)
- 10 OpenClaw sidecar columns: `connection_url`, `gateway_token_encrypted`, `connection_status`, `template_slug`, `template_version`, `provider_hint`, `provider_instance_id`, `connection_error`, `last_gateway_ping_at`, `gateway_ping_fail_count`
- `provider_instances` table
- Worker handler `gateway-ping.ts` and the cron registration
- Gateway WebSocket JSON-RPC client (`openclaw-gateway.ts`), dispatch (`openclaw-dispatch.ts`), HTTP client (`openclaw-client.ts`), chat envelope (`openclaw-chat-envelope.ts`) — all archived to `docs/deprecated/openclaw/`
- `pushSkillSecretsToGateway` helper
- Frontend: `gateway-health-card.tsx`, `reasoning-trace.tsx`, `use-reasoning-trace.ts`
- `web-browsing` and `shell-exec` references from seed templates (these were never in the `CAPABILITY_PACKS` catalog; they pointed to OpenClaw Layer-2 plugins that no longer exist)
- `/provider-readiness` and `/retry-provision` API endpoints
- 6 test files (openclaw-envelope, openclaw-heartbeat, gateway-ping, agent-deploy-routes, byo-provider, railway-provider, skill-install)

**Kept (deliberately):**
- `is_byoa` (now always true), `byoa_model_info`, `mcp_token_hash`
- `trigger_subscriptions` and `default_trigger_subscriptions` — routing key for the trigger system, not OpenClaw plumbing. Webhooks, member.joined, cron triggers all still route through it
- `agent_webhooks` table (Block 3)
- `agent_employee_templates` table (templates still useful for scaffolding BYOA personalities)
- `skill_secrets` table (still useful for storing BYOA per-skill credentials)
- ClawHub allowlist (now imports as marketplace skills directly, no gateway install)
- The 7-file markdown personality editor (BYOA runtimes can read these locally)
- All trust-tier/budget/circuit-breaker/idempotency/loop-detector heartbeat guards

**New worker behavior:** instead of branching by `kind` to push to native (`runAgentQuery`) or OpenClaw (`dispatchViaOpenClaw`), every BYOA-bound action queues an `agent_actions` row that `poll_pending_work` discovers:

| Source | `action` | `source` |
|--------|----------|----------|
| `@mention` in chat | `chat_mention` | `mention` |
| Heartbeat tick (after guards pass) | `heartbeat_tick` | `heartbeat` |
| Trigger fired (`member.joined`, webhook, skill cron, …) | `trigger_dispatch` | `trigger` |
| Task assigned to agent | `task_assigned` | `task_assignment` |

Migration: `0059_remove_openclaw_columns.sql`.

See plan: `docs/superpowers/plans/2026-04-28-phase9-simplify-agents.md` (this prompt).

## Known Limitations (deployment blockers)

- **Use `pnpm db:push-full` for fresh installs and `pnpm db:upgrade` for supported release upgrades.** `push-full` applies the Drizzle schema plus supplemental search/index SQL. The tracked upgrade baseline starts at `v0.2.0-preview.1` and uses a checksumed `deft_schema_migrations` ledger. Raw `pnpm db:push` and `pnpm db:migrate` are not supported operator upgrade paths; historical pre-preview databases require manual review.

## What NOT To Do

- Don't build features we don't need yet (sprints, burndown, Gantt, huddles, CRM)
- Don't over-abstract. Build for the current scope, refactor when needed
- Don't cache prematurely. Postgres is fast enough for our scale
- Don't replace the existing auth system without a migration plan. It's custom JWT + bcrypt, not a library — changes affect every authenticated route.
- Don't use Supabase (blocked in India)
- Don't deploy to Vercel for the API (need WebSocket support). Use Railway or Fly.io
- Don't import full TipTap — use only the extensions we need
- Agent conversations live in messages with metadata.agent_blocks (since Phase 2, 2026-05-07). Don't reintroduce parallel agent-only chat tables; use the unified messages schema.
- Don't reintroduce agent kind/type enums or in-process agent runtimes. Every `agent_employees` row is BYOA — the user's runtime owns execution. If managed deployments come back as a need, build it as a separate service, not as a column on `agent_employees`.
