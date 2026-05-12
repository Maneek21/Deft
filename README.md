# Deft — The AI-Native Workspace

> Chat, tasks, and an AI agent that actually understands your work. Open source.

## What is Deft?

Deft combines team chat, task management, and an AI agent into one workspace. The AI has direct SQL access to your conversations and tasks — it doesn't just search, it understands context and takes action.

- **Chat** — Real-time messaging with threads, reactions, @mentions, file sharing, rich text
- **Tasks** — Kanban boards, list views, priorities, assignments, due dates, drag-and-drop
- **AI Agent** — Ask questions, create tasks, summarize conversations, execute multi-step workflows with approval gates
- **Dashboard** — Morning pulse briefing, task overview, activity feed, project progress

## Quick Start

Get to first login in under 5 minutes.

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Docker Compose)
- A free [Anthropic API key](https://console.anthropic.com) — no other accounts required

### Steps

```bash
git clone https://github.com/Maneek21/Deft.git
cd deft

# 1. Create your env file
cp .env.example .env
```

Open `.env` and set three values:

| Variable | How to get it |
|---|---|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com — free tier works |
| `JWT_SECRET` | Run `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | Run `openssl rand -hex 32` again |

```bash
# 2. Start the stack (Postgres + Redis + Deft)
docker compose up -d

# 3. Initialize the database (run once on first boot)
pnpm db:push        # applies schema
pnpm db:seed        # seeds Defty + bundled skills/templates (prod-safe, idempotent)
# pnpm db:seed:demo # ALSO inserts 5 test users for poking around — dev only, NEVER in prod
```

> **Note:** Use `pnpm db:push`, not `pnpm db:migrate`. The migration journal is canonical as of v0.1 but `push` is the supported path for fresh installs — it diffs the live schema against `packages/db/src/schema.ts` and applies what's missing. `db:migrate` is for upgrade paths once we ship versioned releases.

> **`pnpm db:seed` is prod-safe and idempotent** — re-running on a populated workspace is a no-op. It inserts only platform bundles (Defty system user, bundled skills, bundled task templates, first-party employee templates). It never inserts test accounts.

Open **http://localhost:3000** and create your account. The first signup becomes the org owner and administrator.

> **Want to poke around without creating an account?** Run `pnpm db:seed:demo` (dev only — wipes the DB and inserts five test users with passwords listed in [CONTRIBUTING.md](./CONTRIBUTING.md#test-accounts-after-seeding)). Use them for a guided tour, then re-init the DB before inviting real testers.

> **Single-org note:** Deft is designed for one workspace per deployment. Additional users join via invite link from Settings → Members — direct signups after the first account are blocked.

For a deeper setup guide — environment variable reference, backups, upgrades, and MCP agent configuration — see [docs/self-hosting.md](docs/self-hosting.md).

### Local Development

```bash
# Prerequisites: Node.js 18+, pnpm, PostgreSQL 16, Redis
git clone https://github.com/Maneek21/Deft.git
cd deft
pnpm install
cp .env.example .env
# Edit .env with your database URL

# Set up database
pnpm db:push
pnpm db:seed         # Platform bundle only (prod-safe)
# pnpm db:seed:demo  # OR: wipe + populate with 5 test users + demo content (dev only)

# Start dev servers
pnpm dev        # Starts web (3000) + API (3001)
```

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
| AI | Anthropic Claude API (Sonnet for reasoning, Haiku for classification) |
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

**Bring your own API key.** Self-hosted, your data stays with you.

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
- Kanban, List, Calendar, and Pipeline views — view mode driven by the project's attached skill
- Skill-driven project config: statuses, priority vocab, custom fields, task templates
- Drag-and-drop across columns
- Task detail panel with full editing
- Emoji reactions on tasks
- @mentions in task descriptions and comments with notification dispatch
- Activity diff view (old → new) on the activity log
- Comments + full activity log
- Labels, due dates, assignments, recurrence (daily/weekly/biweekly/monthly)
- Quick-create (press C)
- Project archive + soft-delete with 7-day recovery
- GitHub PR → Done on merge (parses `PREFIX-N` in PR title/body)

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

- `JWT_SECRET` — Secret for JWT signing (`openssl rand -hex 32`)
- `JWT_REFRESH_SECRET` — Secret for refresh tokens (`openssl rand -hex 32`)
- `ANTHROPIC_API_KEY` — For AI agent features (app boots without it but AI is disabled)

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
