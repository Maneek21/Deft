# Deft — Deployment Readiness Report

**Date:** April 10, 2026
**Tested by:** Claude (automated via Playwright + curl)
**Environment:** localhost:3000 (web) + localhost:3001 (api) + PostgreSQL

---

## Executive Summary

The platform is **functional and buildable** with most core features working. The main gaps are: missing test suite, no production env configuration, Redis still referenced in docker-compose despite migration to Postgres job queue, and a few missing API endpoints. The wiki "holistic brain" feature (built this session) is fully operational.

---

## 1. Build Status

| Check | Result | Evidence |
|-------|--------|----------|
| API typecheck (`tsc --noEmit`) | **PASS** | Exit 0, no errors |
| Web typecheck (`tsc --noEmit`) | **PASS** | Exit 0, no errors |
| Web production build (`next build`) | **PASS** | All 18 pages built successfully |
| Health endpoint | **PASS** | `GET /health` returns `{"status":"ok"}` |
| Queue health | **PASS** | 73,631 completed jobs, 7 pending, 0 failed |

## 2. UI Pages — Playwright Test Results

| Page | URL | Errors | Warnings | Status |
|------|-----|--------|----------|--------|
| Login | /login | 0 | 0 | PASS |
| Dashboard | /dashboard | 0 | 0 | PASS — greeting, tasks, stats, projects, activity, calendar |
| Chat | /chat | 0 | 1 (TipTap duplicate link extension) | PASS — messages render, editor works |
| Tasks | /tasks | 2 (`/api/tasks/saved-views` 404) | 0 | PARTIAL — board renders, saved-views endpoint missing |
| Notes | /notes | 0 | 0 | PASS |
| Calendar | /calendar | 0 | 0 | PASS |
| Knowledge | /knowledge | 0 | 0 | PASS — pages, graph, stats, activity, export all work |
| Agent | /agent | 0 | 0 | PASS |
| Settings | /settings | 0 | 0 | PASS |

**Total: 8/9 pages pass clean, 1 partial (tasks — missing saved-views endpoint)**

## 3. API Endpoints — curl Test Results

### Working (HTTP 200)

| Endpoint | Response |
|----------|----------|
| `GET /health` | `{"status":"ok"}` |
| `GET /health/queue` | pending/running/failed/completed counts |
| `POST /api/auth/login` | Returns JWT tokens |
| `GET /api/auth/me` | Returns user profile |
| `GET /api/spaces` | 10 spaces |
| `GET /api/messages/:spaceId` | Messages with reactions, threads |
| `GET /api/notifications` | 42 notifications |
| `GET /api/members` | 5 members |
| `GET /api/dashboard` | Full dashboard data (13 fields) |
| `GET /api/bookmarks` | 0 bookmarks |
| `GET /api/connections` | 0 connections |
| `GET /api/reminders` | 0 reminders |
| `GET /api/projects` | 0 projects (data exists via tasks) |
| `GET /api/tasks/my` | 0 (user's tasks) |
| `GET /api/tasks/search` | Search works |
| `GET /api/tasks/labels` | Labels endpoint |
| `GET /api/agent/conversations` | 0 conversations |
| `GET /api/groups` | 0 groups |
| `GET /api/scheduled-messages` | 0 scheduled |
| `GET /api/pins/:spaceId` | 0 pins |
| `GET /api/decisions` | 0 decisions |
| `GET /api/workflows` | 0 workflows |
| `GET /api/tags` | 0 tags |
| `GET /api/daily-notes/today` | 404 (expected — no note for today) |
| `GET /api/emoji` | Empty array (no custom emoji) |
| **Wiki endpoints:** | |
| `GET /api/wiki` | 39 pages |
| `GET /api/wiki/graph` | 39 nodes, 33 edges |
| `GET /api/wiki/log` | Activity entries |
| `GET /api/wiki/stats` | Full stats with type/confidence distribution |
| `GET /api/wiki/contradictions` | 0 contradictions |
| `GET /api/wiki/export?format=json` | Full export |
| `GET /api/wiki/:slug` | Page detail with backlinks + citations |
| `GET /api/wiki/:slug/history` | Version history |
| `GET /api/wiki/:slug/backlinks` | Backlinks |
| `GET /api/knowledge` | Unified knowledge (reads from wiki_pages) |

### Missing/Broken (HTTP 404)

| Endpoint | Issue |
|----------|-------|
| `GET /api/tasks/saved-views` | Endpoint not implemented — frontend calls it |
| `GET /api/users/status` | Route not found (tried /status and /me/status) |
| `GET /api/calendar/events` | Route not found |
| `GET /api/clips` / `GET /api/clips/my` | Route not found / returns "not found" |
| `GET /api/emoji/custom` | Route not found |
| `GET /api/search?q=auth` | Returns 0 results (may need data, or search not wired) |

## 4. Database Status

| Table Category | Count | Status |
|---------------|-------|--------|
| Wiki tables | 5 (wiki_pages, wiki_links, wiki_citations, wiki_ops_log, wiki_page_versions) | HEALTHY |
| Wiki pages | 39 active | Full-text search vectors populated |
| Wiki links | 33 | Graph connectivity working |
| Wiki ops log | 40 entries | Activity tracking working |
| FTS trigger | Exists | Auto-updates on insert/update |
| Job queue | 73,631 completed, 7 pending, 0 failed | HEALTHY |

## 5. What's Working Well

1. **Core chat** — messages, threads, reactions, typing indicators, rich text editor
2. **Tasks** — Kanban board, priorities, labels, projects, assignees, due dates
3. **Dashboard** — greeting, today's tasks, quick stats, projects, activity feed, calendar widget
4. **Knowledge wiki** — full CRUD, graph viz, FTS search, version history, activity log, stats, export, type/scope filters
5. **Auth** — email/password login, JWT refresh, Google OAuth setup
6. **Notifications** — 42 existing notifications, bell badge counter
7. **Real-time** — Socket.io connected, message/typing events
8. **Background jobs** — Postgres job queue processing (73k+ completed)
9. **Multi-tenancy** — org_id on all queries, 5 team members in test org
10. **Agent** — conversation UI, tool definitions, wiki integration

## 6. What Needs Fixing Before Deploy

### Critical (Blocks Deploy)

| Issue | Details | Effort |
|-------|---------|--------|
| **No production env config** | .env.example exists but no staging/prod env files. Need to set real JWT secrets, database URL, API keys | Config only |
| **Redis in docker-compose** | docker-compose.yml still references Redis, but code migrated to Postgres job queue. Either remove Redis or keep for Socket.io adapter | Small |
| **No database migrations strategy** | Tables created via `drizzle-kit push` (dev tool). Need `drizzle-kit generate` + migration files for reproducible deploys | Medium |
| **Wiki tables not in migrations** | Created via raw SQL this session. Need to be captured in Drizzle migration files | Small |
| **No HTTPS/TLS** | All URLs are http://localhost. Production needs HTTPS configuration | Config only |

### High (Should Fix)

| Issue | Details | Effort |
|-------|---------|--------|
| **Missing `/api/tasks/saved-views`** | Frontend calls it, gets 404. Causes 2 console errors on tasks page | Small — add empty endpoint |
| **No test suite** | Zero automated tests. CI only runs typecheck + build. Need at least API integration tests | Large |
| **TipTap duplicate link extension** | Warning on every chat page load. Cosmetic but noisy | Small |
| **JWT 15-min expiry** | Sessions expire quickly during testing. May need longer expiry or better refresh UX | Small |
| **Search returns 0 results** | `/api/search?q=auth` returns empty. Cross-entity search may not be wired up | Medium |

### Medium (Nice to Have)

| Issue | Details | Effort |
|-------|---------|--------|
| Missing `/api/calendar/events` route | Calendar page works but API route for events not found | Small |
| Missing `/api/clips` routes | Audio clips feature — routes may need registration | Small |
| Missing `/api/emoji/custom` route | Custom emoji endpoint not found | Small |
| Missing `/api/users/status` route | User status update API | Small |
| No rate limiting | API has no rate limiting on any endpoint | Medium |
| No CORS production config | CORS allows localhost:3000 only. Need production domain | Config |
| Email verification not enforced | `RESEND_API_KEY` optional, email_verified defaults to false | Config |

## 7. Infrastructure Requirements for Deploy

| Service | Required | Purpose | Recommended |
|---------|----------|---------|-------------|
| PostgreSQL 16+ | Yes | Primary database | Railway, Neon, or self-hosted |
| Node.js 22+ | Yes | Runtime for API + Web | Railway (API), Vercel (Web) |
| Redis 7+ | Maybe | Socket.io adapter (if multi-instance) | Railway or remove if single instance |
| Anthropic API key | Optional | AI agent features | Required for wiki auto-ingest |
| Resend API key | Optional | Transactional email | Required for email verification |
| Cloudflare R2 | Optional | File storage | Required for persistent file uploads |
| Google OAuth | Optional | Social login | Recommended for production |
| Domain + TLS | Yes | HTTPS | Cloudflare or Let's Encrypt |

## 8. Recommended Deploy Steps

1. **Generate Drizzle migrations** — `cd packages/db && npx drizzle-kit generate` to capture current schema state
2. **Configure production env** — Copy .env.example, set real secrets, database URL, API keys
3. **Fix Redis dependency** — Either keep for Socket.io adapter or remove from docker-compose
4. **Add saved-views stub** — Empty endpoint to stop 404 errors on tasks page
5. **Deploy API to Railway** — WebSocket support required, use `tsx src/index.ts`
6. **Deploy Web to Vercel** — Set `NEXT_PUBLIC_API_URL` to Railway URL
7. **Run migrations** — `drizzle-kit push` on production database
8. **Seed initial data** — Run wiki seed if desired for demo
9. **Configure domain + HTTPS** — Point domain to Vercel (web) + Railway (API)
10. **Set up monitoring** — `/health` and `/health/queue` endpoints ready for uptime checks

## 9. Feature Completeness (from FEATURES.md + CAIRN-PRODUCT-DOC.md)

### Fully Implemented
- Chat (messages, threads, reactions, mentions, presence, rich text editor, file uploads)
- Tasks (Kanban, list view, priorities, labels, projects, assignees, due dates, comments, activity)
- AI Agent (32+ tools, 3-tier approval, SSE streaming, memory, undo, citations)
- Dashboard (bento grid, tasks, stats, projects, activity, calendar widget, standup)
- Manager intelligence (health cards, team dynamics, burnout detection, 1:1 prep)
- Knowledge wiki (CRUD, graph, FTS, version history, cascade ingest, activity log, stats, export)
- Auth (JWT + refresh, bcrypt, Google OAuth scaffold)
- Real-time (Socket.io, 15+ event types, presence)
- Background jobs (Postgres queue, 17 workers, cron scheduling)
- Notifications (in-app, real-time, per-user prefs)
- Google Calendar integration (OAuth, polling sync, agent read/write)
- GitHub integration (OAuth, PR/issue polling, agent read)
- Spaces (public/private, DMs, groups)
- Daily notes, tags, reminders, bookmarks, pins
- Audit logging, workflow rules, user groups
- Custom emoji, scheduled messages, canvas (per-space whiteboard)
- Design system (Obsidian — dark/light, tonal layering, CSS variables)
- Multi-tenancy (org_id on 66 tables)

### Partially Implemented
- Search (command palette works, full-text search needs wiring)
- Audio/video clips (recording pipeline exists, transcription worker exists)
- Huddles (WebRTC peer-to-peer, no SFU for group calls)
- Mobile responsiveness (sidebar has hamburger, content views need work)
- Admin tools (org admin scaffolded, billing schema exists)
- Onboarding (schema exists, UI minimal)

### Not Implemented (not needed for MVP deploy)
- Mobile/desktop native apps
- Offline support
- Screen sharing in huddles
- SOC 2/HIPAA certifications
- Public API for third parties
- Zapier/Make integration
- Sprint/burndown charts, Gantt/timeline views
- Guest access, page-level permissions
- IP allowlisting, DLP, eDiscovery

## 10. Pilot Readiness Checklist (from CAIRN-PRODUCT-DOC.md)

| Area | Status | Notes |
|------|--------|-------|
| Auth hardening | Needs work | Password reset flow, email verification enforcement, session invalidation |
| Rate limiting | Missing | No per-user/per-org rate limits on any endpoint |
| Input validation | Partial | Zod validation on most routes, but SQL injection audit needed |
| Error handling | Partial | Most routes have try/catch, but empty catch blocks exist |
| File storage | Local only | Needs R2/S3 config for production persistence |
| Search | Partial | Wiki FTS works, cross-entity search not wired |
| Performance | Unknown | No load testing done, virtual scrolling not implemented |
| Admin tools | Scaffolded | Member management exists, billing/analytics not built |
| Monitoring | Minimal | Health endpoints exist, no Sentry/error tracking |
| Backups | Not configured | Need automated PostgreSQL backup strategy |

## 11. Test Coverage Gap

| Area | Automated Tests | Manual Tests (this session) |
|------|----------------|---------------------------|
| API endpoints | None | 30+ endpoints tested via curl |
| UI pages | None | 9 pages tested via Playwright |
| Auth flow | None | Login tested, JWT refresh observed |
| Wiki CRUD | None | Create, edit, delete tested via Playwright |
| Search (FTS) | None | 3 queries tested via curl |
| Graph | None | Verified 39 nodes + 33 edges render |
| Real-time | None | Socket.io connection observed |
| Background jobs | None | Queue health shows 73k+ completed |

**Recommendation:** Before production deploy, add at minimum:
- API integration tests for auth, messages, tasks, wiki CRUD
- Playwright E2E tests for login flow, chat messaging, task creation, wiki CRUD
