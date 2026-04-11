# Week 1 Session 1 — Scaffold + Auth + Real-time Chat

Read CLAUDE.md. We are building Deft from scratch.

## TASK 1: Scaffold the monorepo

Create a pnpm workspace monorepo:

```
deft/
├── apps/
│   ├── web/          # Next.js 14 (App Router)
│   └── api/          # Hono on Node.js
├── packages/
│   ├── db/           # Drizzle ORM + PostgreSQL
│   ├── shared/       # Types, Zod schemas
│   └── ai/           # Agent (empty for now)
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.json (base)
├── .env.example
├── .gitignore
├── LICENSE           # BSL 1.1 (I'll provide text)
└── CLAUDE.md
```

Install dependencies:
- apps/web: next, react, tailwindcss, @tailwindcss/typography, lucide-react, socket.io-client, swr
- apps/api: hono, @hono/node-server, socket.io, ioredis, bullmq, bcryptjs, jsonwebtoken, zod, resend
- packages/db: drizzle-orm, drizzle-kit, @neondatabase/serverless, pg, dotenv

Set up TypeScript strict mode in base tsconfig. Set up Tailwind in web app. Set up path aliases (@/components, @/lib, etc.).

## TASK 2: Database schema

Copy the schema from packages/db/schema.ts (I'll paste it). Run drizzle-kit generate and push to a local PostgreSQL. Make sure all tables create successfully.

Database connection: read DATABASE_URL from .env. For local dev use postgres://postgres:postgres@localhost:5432/deft.

## TASK 3: Auth

Using better-auth or manual JWT:
- POST /api/auth/signup — email, password, name → create user, create org, create org_member (role: owner), send verification email (Resend), return tokens
- POST /api/auth/login — email, password → verify, return JWT access token (15min) + refresh token (30d, HttpOnly cookie)
- POST /api/auth/refresh — refresh token → new access token
- POST /api/auth/logout — clear refresh token
- POST /api/auth/forgot-password — email → send reset link
- POST /api/auth/reset-password — token, new password → update
- GET /api/auth/me — return current user + org

Auth middleware on Hono: extract JWT from Authorization header, attach user to context. Every subsequent route uses this.

## TASK 4: Basic UI shell

In apps/web, build:
- Login page (/login) — email + password form, Google OAuth button (stub for now), link to signup
- Signup page (/signup) — name, email, password, org name. On success → redirect to app
- App layout (/(app)/layout.tsx) — sidebar + main content area
  - Sidebar: Deft logo, Dashboard (stub), Chat (active), Tasks (stub), Agent (stub), Settings (stub)
  - Dark mode toggle (CSS variables, prefers-color-scheme, persisted in localStorage)
  - User avatar + name at bottom of sidebar
  - Sidebar collapses on mobile (hamburger menu)
- Redirect to /login if not authenticated

## TASK 5: Real-time chat (basic)

API endpoints:
- POST /api/spaces — create space (name, type, description)
- GET /api/spaces — list spaces for current user's org
- GET /api/spaces/:id/messages — paginated messages (cursor-based, 50 per page)
- POST /api/spaces/:id/messages — send message (content)
- PATCH /api/messages/:id — edit message
- DELETE /api/messages/:id — soft delete

Socket.io setup:
- Server: apps/api/src/socket.ts — authenticate on connection (JWT), join room per space
- Events: message:new, message:edited, message:deleted, typing:start, typing:stop, presence:update
- Redis adapter for horizontal scaling readiness

UI:
- Space list in sidebar (below nav items)
- Message list with virtual scrolling (or simple infinite scroll for now)
- Message composer at bottom — text input with Shift+Enter for newline, Enter to send
- Messages show: avatar, name, timestamp, content (render markdown)
- Typing indicator: "X is typing..."
- Online/offline dots on avatars
- Unread count badge on spaces with unread messages

## TESTING

When done, I should be able to:
1. Open localhost:3000 → see login page
2. Sign up → creates org → lands in app with sidebar
3. See #general space auto-created for the org
4. Open second browser (incognito) → sign up another user → invite to same org
5. Both users see #general in sidebar
6. User A sends a message → User B sees it instantly (no refresh)
7. Typing indicator shows when typing
8. Online status shows green dot
9. Edit a message → (edited) indicator appears
10. Delete a message → "message deleted" placeholder appears
11. Toggle dark mode → entire UI switches
12. Refresh page → still logged in (JWT refresh works)
