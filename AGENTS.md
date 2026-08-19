# AGENTS.md — Deft

## What is this?

Deft is an open-source AI-native workspace. Native chat + tasks + an AI agent that plans and executes multi-step workflows across native data and connected calendar feeds and BYOA-provided external tools. The agent has direct SQL access to native data — not API calls — making it fundamentally faster and smarter than bolt-on AI features.

One Next.js app. One Postgres database. Multi-tenant SaaS with org_id on every table.

Licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). Network deployments of modified versions must offer their users the corresponding source under AGPL section 13.

## Architecture

```
deft/
├── apps/
│   ├── web/          # Next.js 14 (App Router, TypeScript, Tailwind CSS)
│   └── api/          # Hono (TypeScript, REST endpoints, WebSocket via Socket.io)
├── packages/
│   ├── db/           # Drizzle ORM schema + client + migrations
│   └── shared/       # Shared types, Zod schemas, constants
├── docker-compose.yml  # Self-host: postgres + app
├── .env.example
├── LICENSE             # GNU AGPL v3.0 only
└── pnpm-workspace.yaml
```

**Stack:**
- Frontend: Next.js 14, App Router, TypeScript, Tailwind CSS, TipTap (editor)
- API: Hono on Node.js, TypeScript
- Database: PostgreSQL + pgvector (Drizzle ORM)
- Real-time: Socket.io in-process (single app instance; no cross-instance adapter)
- Auth: better-auth (JWT + refresh tokens). Google OAuth is retired from the self-hosted v1 product contract.
- Background jobs: PostgreSQL `job_queue` with in-process workers
- File storage: Cloudflare R2 or local (presigned uploads)
- AI: provider-neutral LLM routing. Anthropic, OpenAI/OpenAI-compatible, OpenRouter, and local Ollama-style providers are optional; core workspace flows must run without any provider key.
- Email: Resend (transactional)
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

## Agent Architecture

The agent is NOT a chatbot. It's a workflow engine.

Agent engine lives in `apps/api/src/lib/` (agent-context, agent-plans, agent-tools, agent-actions, agent-runner, agent-stream-loop, agent-approval, agent-approval-resolver). The `packages/ai` stub was removed 2026-04-16.

**MCP Access is the pilot-facing integration surface.** Human employees create personal MCP tokens in Settings -> MCP Access and can connect Claude Desktop, Claude Code, ChatGPT MCP clients, or any streamable HTTP MCP client to `/api/mcp/v1`. Personal tokens act as the user who created them. Agent employees use the same MCP endpoint with employee tokens from Settings -> Agent Employees; those calls act as the employee and remain governed by trust, approval, health, and audit rules.

**Skills primitive (internal agent registry).** The `skills` table remains for first-party/internal agent-tool bundles and future ecosystem work, but it is not the pilot-facing onboarding primitive. Task templates are a separate first-class primitive (`task_templates` table) instantiated into any project via `POST /api/projects/:id/apply-template`. Project-level customization via `project_skills` / `skills.project_config` was retired 2026-04-18 in favor of fixed engineering defaults. See `docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md`.

**Observation pipeline:** Every chat message classified (Haiku): actionable? Intent? Entities? Urgency?

**Planner:** Complex requests decomposed into ordered steps. Plan shown to user → user edits/approves → agent executes with live progress (streamed to task-detail panel per Task 3.10) → pauses on failure or rolls back per plan mode.

**Proactive comments:** The nudge-check worker drops agent-authored comments on stalled/overdue tasks and on auto-accepted task extractions (Task 3.11), deduped 7d per task. Inline agent task-suggestion cards appear in chat for classified actionable messages (Task 3.12).

**Tool registry:** All agent actions registered with name, params, approval tier, provider. Current self-hosted v1 pilots emphasize native Deft tools, ICS calendars, and BYOA/MCP tools supplied by the customer's already-running agents. Native Slack/Gmail/GitHub/Google OAuth are not buyer-facing promises for this cut.

**Three-tier approval:**
- Auto-execute: low-risk native updates, meeting prep from connected calendar context, reminders
- Quick-approve: create task, schedule meeting (one-click card)
- Full-review: multi-step plans and external writes (preview + edit)

**Trust levels (per org):** Conservative → Standard → Autonomous

**Native actions (direct SQL):** Create/update/assign tasks, post messages, set reminders
**Connected actions:** Read/write native calendar events, ingest ICS calendar subscriptions, and call BYOA/MCP tools that the agent runtime brings with it.

**Event-driven triggers (PostgreSQL scheduled jobs):**
- Task overdue → DM assignee + alert lead
- Task stalled 48h → ask for update
- BYOA/runtime trigger → a connected employee can react to external tool events it owns and use Deft-native task/message/wiki tools under org trust and approval rules.
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
- **Legacy GitHub PR→Done code path** (Task 5.6) — retained as implementation history, but not part of the current self-hosted v1 pilot promise. Customers that need GitHub should connect it inside their BYOA employee or MCP runtime.
- **Project archive + soft-delete** (Task 5.8) — settings modal with 7-day recovery window. Soft-deleted projects hide from views but preserve tasks for audit.
- **Task 0.1 security fix (resolved)** — watchers + assignees routes enforce `org_id` + auth.
- **Task 0.4 dashboard fix (resolved)** — "My Work" filter on the bento dashboard now scopes to the current user.
- **Security hardening (Phase 7, resolved)** — 10 vulnerabilities fixed: XSS prevention via DOMPurify on all `dangerouslySetInnerHTML` sites (6 components), IDOR fixes on workflow-run/agent-message/wiki-citation deletes (verify ownership before delete), space membership enforcement on all space/message/pin endpoints + WebSocket `space:join`, upload path traversal fix (`path.basename` + Content-Disposition `attachment`), daily notes optimistic locking (CAS version check, 409 on conflict).

Dead primitives retired: the `native_tools[]` agent column was dropped (migration 0038) and the `TEMPLATE_DEFAULT_PACKS` constant removed (2026-04-16). `project_config` JSONB, `project_skills` table, and the three project-workflow bundled skills (`engineering`, `marketing-campaign`, `sales-pipeline`) were retired 2026-04-18 — projects now use fixed engineering defaults. Capability packs remain expressed as bundled agent skills installed via `agent_employee_skills`.

- **UI fixes (Phase 7)** — sidebar three-dot menu portal click propagation fixed (menu items now respond to clicks). Scroll containers added to 9 settings pages that were clipping content.

## Next Milestone — Phase 8 (OpenClaw autonomy)

Phase 8 has NOT shipped yet. Flagged here so future edits don't claim it:

- OpenClaw autonomous heartbeat lifecycle (long-running employees with scheduled self-wake).
- Skill-defined trigger dispatcher (arbitrary triggers from skill manifests, not just `cron:standup`).
- Heartbeat cost guardrails (per-turn + per-day caps, circuit-breakers).

The current `agent-employee-heartbeat` worker is a scaffold; the autonomous loop ships in Phase 8.

## Key Design Decisions

1. Agent reads native data via direct SQL, not API calls. This is the core advantage.
2. Connected tools write to a unified `events` table. Agent queries native + events together.
3. Chat is the observation surface. Every message feeds the agent's context.
4. Tasks are the action surface. Agent creates and manages tasks as its primary output.
5. Dashboard is the intelligence surface. Agent-generated briefings, not static widgets.
6. Product works fully without AI. If LLM is down, chat + tasks function normally.
7. Multi-tenant from day 1. org_id on every query. No shortcuts.

## OpenClaw Unlock — Block 0 foundation (shipped 2026-04-19)

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

## OpenClaw Unlock — Block 1 control plane (shipped 2026-04-19)

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

## OpenClaw Unlock — Block 2 agent reach + visibility (shipped 2026-04-19)

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

## OpenClaw Unlock — Block 3 power users + ecosystem polish (shipped 2026-04-19)

Block 3 exit-gate met at 5/10 tasks with `deft-mcp-client` live. Remaining 5 deferred (see `docs/superpowers/block-3-complete-2026-04-19.md`).

- **Clone agent + save as template.** `POST /:id/clone` duplicates an employee with a fresh slug + all installed skills; `POST /:id/save-as-template` writes an org-scoped template row. Migration 0051 makes `agent_employee_templates.org_id` nullable (NULL = first-party/community; non-NULL = org-scoped) with COALESCE-keyed unique on (org_id, slug).
- **Developer credentials page.** `GET /api/agent-employees/:id/developer[?reveal=1]` + `/settings/agent-employees/[id]/developer` — masked token by default, reveal gated to admin/owner. Carries wscat one-liner + example JSON-RPC frames for SDK scaffolding.
- **Webhook-callable agents.** Migration 0052 + `agent_webhooks` table. Authenticated mgmt surface under `/api/agent-webhooks`, public HMAC-gated dispatch at `/api/agent-webhooks/:slug` that enqueues an `employee-trigger` with `trigger_kind='webhook'` + full payload in context. scrypt-hashed secrets, constant-time verification.
- **`deft-mcp-client` bundled skill.** On-ramp for any OpenClaw deployment (incl. BYOA) to talk back into its Deft workspace over MCP — seeded into the bundled catalog. `SkillAgentConfig` extended with `requires_env?: string[]` + `mcp_servers?: Array<{ name, transport, url|command, headers }>`.
- **Agent trace export.** `GET /api/agent/conversations/:id/trace.json` — format `deft.agent_trace.v1`, messages + actions + conversation metadata as one JSON download.

Migrations added: `0051_org_scoped_templates.sql`, `0052_agent_webhooks.sql`.

## Known Limitations (deployment blockers)

- **Use `pnpm db:push-full` for fresh installs and `pnpm db:upgrade` for supported upgrades.** The first tracked upgrade baseline is `v0.2.0-preview.1`; the upgrader fingerprints untracked baseline databases and records checksums in `deft_schema_migrations`. Plain `drizzle-kit push` cannot express every generated search/index object, and raw `pnpm db:migrate` remains unsupported. Historical pre-preview databases are rejected for manual review instead of being mutated.
- **No live OpenClaw gateway in dev.** All `openclaw`-kind agent_employees rows currently have `connection_url IS NULL`. Block 1's live-gateway smoke tests run only once a gateway is provisioned; unit tests use MockTransport + `_setGatewayResolver` seams to exercise the forwarding code paths end-to-end.

## What NOT To Do

- Don't put domain-specific CRM logic in core. CRM capabilities belong in declarative modules; core stays generic.
- Don't over-abstract. Build for the current scope, refactor when needed
- Don't cache prematurely. Postgres is fast enough for our scale
- Don't build a custom auth system. Use better-auth
- Don't use Supabase (blocked in India)
- Don't deploy to Vercel for the API (need WebSocket support). Use Railway or Fly.io
- Don't import full TipTap — use only the extensions we need
- Don't store agent conversations in the same messages table — separate agent_conversations table
