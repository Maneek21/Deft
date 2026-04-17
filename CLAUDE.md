# CLAUDE.md — Deft

## What is this?

Deft is an open-source AI-native workspace. Native chat + tasks + an AI agent that plans and executes multi-step workflows across native data and connected external tools (Google Calendar, GitHub, Slack, Gmail). The agent has direct SQL access to native data — not API calls — making it fundamentally faster and smarter than bolt-on AI features.

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
│   └── shared/       # Shared types, Zod schemas, constants
├── docker-compose.yml  # Self-host: postgres + redis + app
├── .env.example
├── LICENSE             # BSL 1.1
└── pnpm-workspace.yaml
```

**Stack:**
- Frontend: Next.js 14, App Router, TypeScript, Tailwind CSS, TipTap (editor)
- API: Hono on Node.js, TypeScript
- Database: PostgreSQL + pgvector (Drizzle ORM)
- Real-time: Socket.io with Redis adapter
- Auth: better-auth (JWT + refresh tokens + Google OAuth)
- Background jobs: BullMQ with Redis
- File storage: Cloudflare R2 or local (presigned uploads)
- AI: Anthropic Claude API (Sonnet for reasoning, Haiku for classification)
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

**Skills primitive (unified agent + project capabilities).** A single `skills` table with three source tiers — `bundled` (shipped with Deft, `org_id IS NULL`), `marketplace` (installable catalog), `org` (tenant-authored) — each carrying an `agent_config` JSONB (capability packs, triggers, tools, prompt additions) and a `project_config` JSONB (statuses, priority vocab, default view, custom fields, task templates, allowed transitions). Nine day-one bundled skills are seeded: six capability-pack skills (one per available pack) plus three project-workflow skills — `engineering`, `marketing-campaign`, `sales-pipeline`. Agents install skills via the `agent_employee_skills` junction (replacing the dropped `capability_packs[]` array); projects attach skills via `project_skills` with ordering. Projects support multi-skill attachments resolved first-attached-wins in the UI. The dead `native_tools[]` column and `TEMPLATE_DEFAULT_PACKS` constant were removed — everything now flows through skills.

**Observation pipeline:** Every chat message classified (Haiku): actionable? Intent? Entities? Urgency?

**Planner:** Complex requests decomposed into ordered steps. Plan shown to user → user edits/approves → agent executes with live progress (streamed to task-detail panel per Task 3.10) → pauses on failure or rolls back per plan mode.

**Proactive comments:** The nudge-check worker drops agent-authored comments on stalled/overdue tasks and on auto-accepted task extractions (Task 3.11), deduped 7d per task. Inline agent task-suggestion cards appear in chat for classified actionable messages (Task 3.12).

**Tool registry:** All agent actions registered with name, params, approval tier, provider. Agent only sees tools for services the user has connected.

**Three-tier approval:**
- Auto-execute: task status from PR merge, meeting prep, reminders
- Quick-approve: create task, schedule meeting (one-click card)
- Full-review: multi-step plans, email drafts, external writes (preview + edit)

**Trust levels (per org):** Conservative → Standard → Autonomous

**Native actions (direct SQL):** Create/update/assign tasks, post messages, set reminders
**Connected actions (API):** Create calendar events, GitHub issues, Slack messages, Gmail drafts

**Event-driven triggers (BullMQ crons):**
- Task overdue → DM assignee + alert lead
- Task stalled 48h → ask for update
- PR merged → parse `PREFIX-N` refs in title/body, move each matched task (in `todo`, `in_progress`, or `in_review`) to `done` and leave an attribution comment linking the PR. Wired into the GitHub sync path (`apps/api/src/workers/github-sync.ts` → `closeTasksForMergedPR`); runs only on the `pr_opened|pr_closed → pr_merged` transition so re-syncs don't re-fire. Tasks already `done` or `cancelled` are never touched.
- Meeting in 15min → generate prep briefing
- 9am daily → auto-generate standup from activity

## Task Architecture (Phases 0-6 shipped)

Tasks are the agent's primary output surface and the product's action surface. Post-Phase-6 they ship with:

- **Skills primitive** drives per-project vocabulary: statuses, priority vocab, board columns, pipeline/calendar view modes, custom fields, and task templates all come from the project's resolved skill config (first-attached-wins across multi-skill).
- **Recurrence UI + clone fix** (Task 4.12) — recurring task pattern stored on `tasks.recurrence` (`daily` | `weekly` | `biweekly` | `monthly`) with `recurrence_source_id` linking generated copies.
- **Workflow executor (basic)** — BullMQ-backed runner supporting the `task.status_changed` trigger with four actions: `add_comment`, `assign_to`, `add_label`, `notify` (Task 5.7). Broader trigger coverage + skill-defined triggers land in Phase 8.
- **Task reactions** (Task 6.3) — emoji reactions on task cards/detail (`task_reactions` table, upsert/delete endpoints).
- **@mentions in description + comments** (Task 6.4) — autocomplete + notification dispatch mirrors chat mentions.
- **Activity diff view** (Task 6.2) — inline old→new rendering in the task activity log, replacing flat "changed status" strings.
- **GitHub PR→Done** (Task 5.6) — polling sync worker parses `PREFIX-N` in PR title/body on the `pr_opened|pr_closed → pr_merged` transition and closes each referenced task with an attribution comment. Polling only, no webhook yet.
- **Project archive + soft-delete** (Task 5.8) — settings modal with 7-day recovery window. Soft-deleted projects hide from views but preserve tasks for audit.
- **Task 0.1 security fix (resolved)** — watchers + assignees routes enforce `org_id` + auth.
- **Task 0.4 dashboard fix (resolved)** — "My Work" filter on the bento dashboard now scopes to the current user.

Dead primitives retired: the `native_tools[]` agent column was dropped (migration 0038) and the `TEMPLATE_DEFAULT_PACKS` constant removed. Capability packs are now expressed as bundled skills and installed via `agent_employee_skills`.

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

## What NOT To Do

- Don't build features we don't need yet (sprints, burndown, Gantt, huddles, CRM)
- Don't over-abstract. Build for the current scope, refactor when needed
- Don't cache prematurely. Postgres is fast enough for our scale
- Don't build a custom auth system. Use better-auth
- Don't use Supabase (blocked in India)
- Don't deploy to Vercel for the API (need WebSocket support). Use Railway or Fly.io
- Don't import full TipTap — use only the extensions we need
- Don't store agent conversations in the same messages table — separate agent_conversations table
