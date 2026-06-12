# Deft — The AI-Native Workspace

> Chat, tasks, and an AI agent that actually understands your work. Source-available.

## What is Deft?

Deft combines team chat, task management, and an AI agent into one workspace. The AI has direct SQL access to your conversations and tasks — it doesn't just search, it understands context and takes action.

- **Chat** — Real-time messaging with threads, reactions, @mentions, file sharing, rich text
- **Tasks** — Kanban boards, list views, priorities, assignments, due dates, drag-and-drop
- **AI Agent** — Ask questions, create tasks, summarize conversations, execute multi-step workflows with approval gates
- **Dashboard** — Morning pulse briefing, task overview, activity feed, project progress

> **License:** Source-available under the [Business Source License 1.1](./LICENSE). Use it for any purpose — including self-hosting — **except** offering Deft as a hosted or managed service to third parties. Forks must retain attribution. Converts to Apache License 2.0 four years from each release date.

## Project status

Deft is in **alpha** — usable and self-hostable today, but expect breaking changes and rough edges until a tagged `v0.1.0`. Designed for **one workspace per deployment**. Source-available under BSL 1.1.

## Quick Start

Get to first login in under 5 minutes.

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Docker Compose)
- (Optional) Any supported AI provider key, or a local Ollama server, for AI features. Chat and tasks work without one

### Steps

```bash
git clone https://github.com/Maneek21/Deft.git
cd deft

# 1. Create your env file
cp .env.example .env
```

Open `.env` and set the three required values. AI keys are optional and can be added later in Settings -> AI.

| Variable | Required? | How to get it |
|---|---|---|
| `POSTGRES_PASSWORD` | **Required** | Any strong string — `openssl rand -hex 32` |
| `JWT_SECRET` | **Required** | `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | **Required** | `openssl rand -hex 32` (run it again) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `OLLAMA_URL` | Optional | Configure one provider for AI features; can also be set per-org in Settings -> AI |

```bash
# 2. Build and start the stack (Postgres + Redis + Deft)
docker compose up -d --build

# 3. Initialize the database from inside Docker (run once on first boot)
docker compose run --rm init

# Optional: verify the self-host stack
docker compose run --rm doctor
```

> **Note:** Use `pnpm db:push-full`, not `pnpm db:migrate`. `push-full` is the supported path for fresh installs — it diffs the live schema against `packages/db/src/schema.ts`, then applies two orphan SQL files (`0020_wiki_search_vector.sql` and `0033_tasks_embedding.sql`) that create generated tsvector columns and GIN indexes Drizzle's pushed schema can't express. Plain `pnpm db:push` skips the orphans and leaves wiki/task FTS broken. Versioned `db:migrate` upgrade paths are not yet supported and will arrive post-alpha.

> **`pnpm db:seed` is prod-safe and idempotent** — re-running on a populated workspace is a no-op. It inserts only platform bundles (Defty system user, internal agent/tool bundles, bundled task templates, first-party employee templates). It never inserts test accounts.

Open **http://localhost:3000** and create your account. The first signup becomes the org owner and administrator.

> **Want to poke around with demo data?** Use the local development or pilot path below and run `pnpm db:seed:demo` or `pnpm db:seed:pilot` (dev only — wipes the DB and inserts six Testers Tomatoes users with password `tomato123`). Never run demo/pilot seeds in production.

> **Single-org note:** Deft is designed for one workspace per deployment. Additional users join via invite link from Settings → Members — direct signups after the first account are blocked.

For a deeper setup guide — environment variable reference, backups, upgrades, and MCP agent configuration — see [docs/self-hosting.md](docs/self-hosting.md).

### Local Development

```bash
# Prerequisites: Node.js 20+, pnpm, PostgreSQL 16, Redis
git clone https://github.com/Maneek21/Deft.git
cd deft
pnpm install
cp .env.example .env
# Edit .env with your database URL

# Set up database
pnpm db:push-full
pnpm db:seed         # Platform bundle only (prod-safe)
# pnpm db:seed:demo  # OR: wipe + populate with 6 Testers Tomatoes users (dev only)
# pnpm db:seed:pilot # OR: demo seed + pilot polish fixtures (dev/pilot only)

# Start dev servers
pnpm dev        # Starts web (3000) + API (3001)
```

### Fresh Pilot/Demo Install

For a local pilot workspace with the full Testers Tomatoes demo and pilot polish fixtures:

```bash
pnpm install
cp .env.example .env
# Set POSTGRES_PASSWORD, JWT_SECRET, JWT_REFRESH_SECRET, DATABASE_URL, REDIS_URL
pnpm pilot:reset
pnpm pilot:preflight:strict
pnpm pilot:cracks:battery
```

The pilot seed creates six users. Password is `tomato123`; start with `diego@testers-tomatoes.com`.

## Architecture

```
deft/
├── apps/
│   ├── web/          # Next.js 16 (App Router, TypeScript)
│   └── api/          # Hono on Node.js (REST + WebSocket + agent engine)
├── packages/
│   ├── db/           # Drizzle ORM schema + migrations
│   └── shared/       # Shared types and constants
├── docker-compose.yml
└── pnpm-workspace.yaml
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, Tailwind CSS v4, TipTap |
| API | Hono on Node.js |
| Database | PostgreSQL 16 + Drizzle ORM |
| Real-time | Socket.io + Redis adapter |
| Background Jobs | BullMQ + Redis |
| AI | Provider-neutral BYOK: Anthropic, OpenAI, OpenRouter, or Ollama |
| Auth | JWT + refresh tokens |
| File Storage | Local disk (R2-ready) |
| Monorepo | pnpm workspaces |

## AI Agent

The agent has **direct SQL access** to your data — no API middleman. It can:

- Answer questions about tasks, conversations, and team activity
- Create and assign tasks from natural language
- Summarize conversation threads and spaces
- Execute multi-step plans with approval gates and live progress streaming
- Post messages and updates across spaces
- Leave proactive comments on stalled or overdue tasks
- Offer inline task suggestions from actionable chat messages

Every write action goes through an approval flow. The user sees what the agent wants to do, approves or rejects, and can undo after execution.

**Bring your own provider.** Self-hosted Deft can run with Anthropic, OpenAI, OpenRouter, or local Ollama. Without a provider, AI features are disabled but the core workspace still works.

## Features

### Chat
- Real-time messaging with Socket.io
- Threaded conversations
- Emoji reactions (24+ common emojis)
- @mentions with autocomplete
- File upload with inline image preview
- Rich text (bold, italic, code blocks, lists, links)
- Typing indicators and online presence
- Unread badges and mark-as-read

### Tasks
- Kanban, List, Calendar, and Pipeline views
- Fixed engineering workflow defaults: backlog, todo, in progress, in review, done, cancelled
- Drag-and-drop across columns
- Task detail panel with full editing
- Emoji reactions on tasks
- @mentions in task descriptions and comments with notification dispatch
- Activity diff view (old → new) on the activity log
- Comments + full activity log
- Labels, due dates, assignments, recurrence (daily/weekly/biweekly/monthly)
- Quick-create (press C)
- Project archive + soft-delete with 7-day recovery

### Dashboard
- Personalized greeting with morning pulse
- Due today / this week / overdue task sections
- In-progress task tracker
- Unread messages widget
- Recent activity feed
- Project progress cards

### Global
- Cmd+K command palette (search + commands)
- Dark mode (default, with light mode support)
- Real-time presence (online/idle/offline)
- Notification system with mentions, tasks, agent alerts

## Environment Variables

See `.env.example` for all configuration options with inline documentation. Three variables are required for first boot:

- `POSTGRES_PASSWORD` — Database password (`openssl rand -hex 32`)
- `JWT_SECRET` — Secret for JWT signing (`openssl rand -hex 32`)
- `JWT_REFRESH_SECRET` — Secret for refresh tokens (`openssl rand -hex 32`)

AI provider keys are optional. The app boots without Anthropic, OpenAI, OpenRouter, or Ollama; AI features stay disabled until a provider is configured via env or per-org in Settings -> AI.

Full reference: [docs/self-hosting.md#environment-variables-reference](docs/self-hosting.md#environment-variables-reference)

## License

Business Source License 1.1 (BSL-1.1)

- Use, copy, modify, and distribute for any purpose
- **Cannot** offer as a hosted/managed service to third parties
- Attribution required in forks and derivative works
- Converts to Apache License 2.0 after 4 years from each release

See [LICENSE](./LICENSE) for full terms.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.
