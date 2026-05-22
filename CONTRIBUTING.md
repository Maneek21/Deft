# Contributing to Deft

## Development Setup

### Prerequisites
- Node.js 18+ (22 recommended)
- pnpm 9+
- PostgreSQL 16
- Redis 7 (optional — needed for real-time features)

### Setup

```bash
git clone https://github.com/Maneek21/Deft.git
cd deft
pnpm install
cp .env.example .env
# Edit .env with your database credentials

# Create database and push schema (+ full-text-search extras)
createdb deft
pnpm db:push-full

# Seed demo data (5 test users + demo org + sample messages/tasks).
# This wipes the DB — dev only, NEVER run in production.
pnpm db:seed:demo

# Or, for a prod-safe seed (Defty + bundled skills/templates only):
#   pnpm db:seed

# Start development servers
pnpm dev
```

The web app runs at `http://localhost:3000`, API at `http://localhost:3001`.

### Test accounts (after seeding)
| Email | Password | Role |
|-------|----------|------|
| maneek@test.com | test1234 | Owner |
| rahul@test.com | test1234 | Member |
| priya@test.com | test1234 | Member |
| arjun@test.com | test1234 | Member |
| sara@test.com | test1234 | Member |

## Project Structure

```
deft/
├── apps/web/src/
│   ├── app/(app)/         # Authenticated pages (dashboard, chat, tasks, agent, settings)
│   ├── app/login/         # Auth pages
│   ├── components/        # Shared React components
│   └── lib/               # Client utilities (api, auth, socket, context)
├── apps/api/src/
│   ├── routes/            # Hono API route handlers
│   ├── lib/               # Server utilities (db, env, agent tools)
│   ├── middleware/         # Auth middleware
│   └── socket.ts          # Socket.io setup
├── packages/db/
│   ├── src/schema.ts      # Drizzle ORM schema (all 30 tables)
│   ├── seed.ts            # Database seed script
│   └── drizzle.config.ts  # Migration config
└── packages/shared/       # Shared types and constants
```

## Code Standards

- **TypeScript strict mode** everywhere — no `any` unless absolutely necessary
- **Zod** for all request validation on API routes
- **Drizzle ORM** — no raw SQL except in agent queries
- **Functional React** — no class components, prefer server components where possible
- **Tailwind CSS** — no CSS modules, no styled-components
- **File naming**: kebab-case for files, PascalCase for components

## Adding a New API Endpoint

1. Create or edit a route file in `apps/api/src/routes/`
2. Use Hono: `export const myRoutes = new Hono();`
3. Add Zod validation for request body
4. Use `c.get('user')` for authenticated user context
5. Always filter by `org_id` for multi-tenant isolation
6. Return errors as `{ error: string, code: string }`
7. Register in `apps/api/src/index.ts`

## Adding a New Agent Tool

1. Define the tool schema in `apps/api/src/lib/agent-tools.ts`
2. Implement the handler in `apps/api/src/lib/agent-context.ts` (read-only) or `agent-actions.ts` (write)
3. Write actions must go through approval flow

## Branch & PR Convention

- Branch names: `feat/short-description`, `fix/short-description`, `chore/short-description`
- Commit messages: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- PRs: describe changes, link related issue, include screenshots for UI changes
- All PRs must pass TypeScript type-check

## Design System

Key rules:
- No borders for layout — use tonal layering
- Inter for text, JetBrains Mono for technical data
- All colors via CSS variables in `apps/web/src/app/globals.css`
- Brand assets live in `apps/web/public/brand/`; use the `<Logo />` component (`apps/web/src/components/brand/logo.tsx`) rather than inlining SVGs.
