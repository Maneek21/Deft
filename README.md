# Deft — The AI-Native Workspace

> Chat, tasks, and an AI agent that actually understands your work. Open source.

## What is Deft?

Deft combines team chat, task management, and an AI agent into one workspace. The AI has direct SQL access to your conversations and tasks — it doesn't just search, it understands context and takes action.

- **Chat** — Real-time messaging with threads, reactions, @mentions, file sharing, rich text
- **Tasks** — Kanban boards, list views, priorities, assignments, due dates, drag-and-drop
- **AI Agent** — Ask questions, create tasks, summarize conversations, execute multi-step workflows with approval gates
- **Dashboard** — Morning pulse briefing, task overview, activity feed, project progress

## Quick Start

### Self-Host with Docker

```bash
git clone https://github.com/deft-dev/deft.git
cd deft
cp .env.example .env
# Edit .env — add your Anthropic API key (optional, app works without it)
docker compose up -d
```

Open http://localhost:3000. Sign up, create your workspace, start chatting.

### Local Development

```bash
# Prerequisites: Node.js 18+, pnpm, PostgreSQL 16, Redis
git clone https://github.com/deft-dev/deft.git
cd deft
pnpm install
cp .env.example .env
# Edit .env with your database URL

# Set up database
pnpm db:push
pnpm db:seed    # Optional: populate with sample data

# Start dev servers
pnpm dev        # Starts web (3000) + API (3001)
```

## Architecture

```
deft/
├── apps/
│   ├── web/          # Next.js 14 (App Router, TypeScript)
│   └── api/          # Hono on Node.js (REST + WebSocket)
├── packages/
│   ├── db/           # Drizzle ORM schema + migrations
│   ├── shared/       # Shared types and constants
│   └── ai/           # Agent engine (planner, tools, context)
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
- Execute multi-step plans with approval gates
- Post messages and updates across spaces

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
- Kanban board with drag-and-drop
- List view with sortable columns
- Task detail panel with full editing
- Priority levels (P0-P3) with color coding
- Labels, due dates, assignments
- Comments and activity log
- Quick-create (press C)
- Task search and filters

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

See `.env.example` for all configuration options. The only required variables are:

- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — Secret for JWT signing
- `ANTHROPIC_API_KEY` — For AI agent features (optional)

## License

Business Source License 1.1 (BSL-1.1)

- Use, copy, modify, and distribute for any purpose
- **Cannot** offer as a hosted/managed service to third parties
- Attribution required in forks and derivative works
- Converts to Apache License 2.0 after 4 years from each release

See [LICENSE](./LICENSE) for full terms.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.
