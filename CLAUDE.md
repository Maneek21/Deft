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
│   ├── shared/       # Shared types, Zod schemas, constants
│   └── ai/           # Agent engine (planner, tool registry, observation pipeline)
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

**Observation pipeline:** Every chat message classified (Haiku): actionable? Intent? Entities? Urgency?

**Planner:** Complex requests decomposed into ordered steps. Plan shown to user → user edits/approves → agent executes with live progress → pauses on failure.

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
- PR merged → move task to Done + post in space
- Meeting in 15min → generate prep briefing
- 9am daily → auto-generate standup from activity

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
