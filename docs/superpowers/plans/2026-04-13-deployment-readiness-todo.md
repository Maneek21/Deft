# Deft — Deployment Readiness TODO

Full system audit for production shipping, April 13, 2026. Supersedes the April 10 `DEPLOYMENT-READINESS-REPORT.md` with findings from a code sweep after the Playwright approval fix + tier-1 MCP bundle + agent UI sessions 1/2/3 + session 2.5 prompt caching hotfix. Also incorporates the `AGENT-UI-BACKLOG.md` I wrote yesterday.

## TL;DR verdict

**Deft is functionally complete but NOT production-ready.** The platform has ~66 DB tables, 30+ working API endpoints, 9 working UI pages, a fully operational agent loop with 17 tier-1 MCP tools, and 20 passing audit assertions. But there are **6 critical security/legal gaps that block any deploy**, **4 high-severity operational gaps** that block any real traffic, and ~30 smaller items that should land before public launch.

**Realistic path to production:** ~4–6 weeks of focused work (180–260 hours) across security hardening, legal/compliance, ops observability, missing endpoints, frontend polish, commerce/scale, and launch prep. That assumes you ship without a test suite (builds on the typecheck + audit scripts we already have) and without billing (run in "free/self-hosted" mode until you have paying customers).

**Single most urgent item:** `apps/api/src/routes/members.ts:168` is logging temporary passwords to the server console on member invite. **Fix in under 5 minutes, deploy the fix, then move to the rest.**

---

## 🔴 Phase A — Security hardening (20 h, must fix before any deploy)

### A1 — 🔥 Remove password console.log
- **Where:** `apps/api/src/routes/members.ts:168`
- **What:** `console.log("[members] Invite for ${email} — temp password: ${tempPassword}")` — logs the temporary password plaintext to stdout. Anyone with log access can see it.
- **Fix:** delete the line, or redact to `temp password: ***` for debug only.
- **Effort:** **5 min**
- **Severity:** CRITICAL

### A2 — Sanitize `dangerouslySetInnerHTML` sites
- **Where:** 8 instances across the web app (Session 1 killed the agent-chat one; the others remain):
  - `apps/web/src/components/thread-panel.tsx:123, 133` (message content)
  - `apps/web/src/components/space-chat.tsx:379, 405, 1109` (messages + recaps)
  - `apps/web/src/components/task-detail.tsx:1729` (task comments)
  - `apps/web/src/app/(app)/notes/page.tsx:632` (note versions)
  - `apps/web/src/app/(app)/dashboard/page.tsx:936` (standup summary)
- **What:** each one pipes user-generated (or agent-generated) HTML into `innerHTML` without sanitization. TipTap sanitizes on output, but when an agent returns or a recap worker produces text with embedded tags, there's no second line of defense.
- **Fix:** wrap the HTML strings in DOMPurify (same library pattern as agent-chat's rehype-sanitize — but DOMPurify is the go-to for plain innerHTML). Install `dompurify` + `@types/dompurify`, create a shared `sanitize(html)` helper in `apps/web/src/lib/sanitize.ts`, and use it at all 8 sites.
- **Effort:** 4 h (1 install + 1 helper + 8 call-site updates + 1 quick review)
- **Severity:** CRITICAL

### A3 — Session revocation / logout endpoint
- **Where:** `apps/api/src/routes/auth.ts` — has signup, login, password reset, but no `/logout` or refresh token revocation.
- **What:** current JWTs have a 15-min access + 30-day refresh. No way to kick a user out if a laptop is stolen.
- **Fix:** add a `/api/auth/logout` endpoint that writes the refresh token to a revocation set (Redis TTL or a `revoked_tokens` table with the token jti + expiry). Auth middleware checks the set before accepting a refresh. Add a "Sign out all devices" button in settings that revokes every refresh for the user.
- **Effort:** 4 h
- **Severity:** HIGH

### A4 — Rate limiting middleware
- **Where:** `apps/api/src/index.ts` and per-route.
- **What:** zero rate limiting anywhere. Anyone can brute-force `/api/auth/login`, spam `/api/agent/conversations/:id/messages`, exhaust Anthropic credits, spam signups.
- **Fix:** add `hono-rate-limiter` with per-route limits:
  - `/api/auth/login`, `/api/auth/signup`, `/api/auth/forgot-password` → 10/min per IP
  - `/api/agent/conversations/:id/messages` → 30/min per user
  - `/api/upload/*` → 20/min per user
  - everything else → 100/min per user
- Back it with Redis for multi-instance consistency, or use in-memory for single-instance launch.
- **Effort:** 6 h
- **Severity:** HIGH

### A5 — Security headers middleware
- **Where:** `apps/api/src/index.ts` and `apps/web/next.config.*`
- **What:** no `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, or `Referrer-Policy` set anywhere. Browsers can't enforce the basic protections.
- **Fix:** add middleware on the API (`hono-helmet` or manual header setter). For Next.js, add a `headers()` export in `next.config.js`. Start with a permissive CSP and tighten over time; `frame-ancestors 'none'`, `object-src 'none'`, and `base-uri 'self'` are the high-value minimums.
- **Effort:** 2 h
- **Severity:** HIGH

### A6 — Enforce email verification on login
- **Where:** `apps/api/src/routes/auth.ts:109` (login handler)
- **What:** the `users.email_verified` column exists but isn't checked on login. Attackers can create accounts with any email and start using the workspace.
- **Fix:** in the login handler, reject with `403 { code: 'EMAIL_NOT_VERIFIED' }` if `!user.email_verified`. Signup handler already triggers the verification email on Resend-enabled orgs — just need to gate login.
- **Effort:** 2 h (including a "resend verification" endpoint)
- **Severity:** MEDIUM (only high if email harvesting is a real risk in your threat model)

**Phase A total: ~20 hours**

---

## 🔴 Phase B — Legal / compliance (25 h, must fix before public launch)

### B1 — Privacy Policy page
- **Where:** new file `apps/web/src/app/privacy/page.tsx`
- **What:** required by Google OAuth consent screen, GDPR, most jurisdictions. No page exists.
- **Fix:** static page with GDPR-compliant privacy policy. Start from a generator (iubenda, termly, or hand-written). Must cover: what data is collected, why, how long, who it's shared with, user rights, cookies, contact email.
- **Effort:** 4 h (writing + review + simple page layout)
- **Severity:** CRITICAL (blocks Google OAuth approval)

### B2 — Terms of Service page
- **Where:** new file `apps/web/src/app/terms/page.tsx`
- **What:** required by Google OAuth, most payment processors, enterprise customers.
- **Fix:** static page. Cover: usage restrictions, liability, termination, governing law, BSL 1.1 license reference.
- **Effort:** 4 h
- **Severity:** CRITICAL

### B3 — GDPR data export endpoint
- **Where:** new route `apps/api/src/routes/user-data.ts` → `GET /api/users/me/export`
- **What:** GDPR "right to data portability" — users must be able to download everything you have on them.
- **Fix:** endpoint that queries every table where `user_id = current_user.id` (messages, tasks, wiki pages, agent conversations, notifications, etc.) and returns a JSON or zip. Background worker for large exports.
- **Effort:** 6 h
- **Severity:** CRITICAL

### B4 — Account deletion endpoint
- **Where:** new route `DELETE /api/users/me` with a confirmation flow
- **What:** GDPR "right to erasure." Soft deletes exist on 8 tables but there's no cascade or orchestration.
- **Fix:** endpoint that flips `users.is_deleted = true`, anonymizes identifying fields (name → "Deleted User", email → `deleted-<id>@deleted.local`), cascades `is_deleted = true` to owned resources (spaces, tasks, messages), and schedules a hard delete job for N days later. Add a confirmation UI in settings.
- **Effort:** 8 h
- **Severity:** CRITICAL

### B5 — Cookie consent banner
- **Where:** new component `apps/web/src/components/cookie-consent.tsx`, mounted in root layout
- **What:** only required if you ship analytics (PostHog, Plausible, GA) or non-essential cookies. Plausible is cookie-free and skips this entirely.
- **Fix:** if using PostHog or similar, ship a banner. If using Plausible or Umami, skip.
- **Effort:** 3 h if needed, 0 if not
- **Severity:** CRITICAL (if analytics is in), LOW (if not)

**Phase B total: ~25 hours**

---

## 🟠 Phase C — Ops / observability (30 h, must fix before real traffic)

### C1 — Database backups
- **Where:** `docker-compose.yml` has `pgdata:` volume, no backup automation.
- **What:** if the DB dies, everything is gone. Zero backup strategy documented or scripted.
- **Fix:** one of:
  - (a) Managed Postgres (Railway, Neon, Supabase) — backups included.
  - (b) Self-hosted: add a nightly `pg_dump` cron running in a separate container, pushing to R2 / S3 with retention. Script + retention policy + restore runbook.
- **Effort:** 4 h (managed) or 8 h (self-hosted)
- **Severity:** CRITICAL

### C2 — Sentry error tracking
- **Where:** `apps/api/src/index.ts` + `apps/web/src/instrumentation.ts`
- **What:** no error tracking. When things break in prod, you find out from user complaints.
- **Fix:** install `@sentry/node` on the API and `@sentry/nextjs` on the web. Free tier (5k errors/month) is enough to start. Capture unhandled exceptions, API 5xx, failed background jobs.
- **Effort:** 4 h
- **Severity:** HIGH

### C3 — Structured logging
- **Where:** `apps/api/src/index.ts` — currently Hono's logger middleware writes plain text to stdout.
- **What:** production needs JSON logs for aggregation (Axiom, Logtail, Datadog). Current logs are unparseable and include PII carelessly.
- **Fix:** install `pino` + `pino-http` (or `hono-pino`). Configure to redact `password`, `token`, `authorization` fields. Replace `console.log` in hot paths (agent-stream-loop, agent-runner, routes) with `logger.info/warn/error`.
- **Effort:** 4 h
- **Severity:** MEDIUM

### C4 — Proper health endpoint
- **Where:** `apps/api/src/index.ts:105`
- **What:** `/health` returns hardcoded `{status: 'ok'}` — doesn't test the DB, doesn't report version. Uptime monitors will think everything is fine even when Postgres is down.
- **Fix:** check `SELECT 1` against the DB, verify Redis if used, return `{status, db, queue, version, uptime}` with 503 on any failure.
- **Effort:** 2 h
- **Severity:** MEDIUM

### C5 — Generate Drizzle migrations for current schema state
- **Where:** `packages/db/drizzle/`
- **What:** the session work backfilled `_journal.json` with idx 4 and added 0005, but **wiki tables (5 tables: wiki_pages, wiki_links, wiki_citations, wiki_ops_log, wiki_page_versions) are still not in any migration file** per the April 10 report. They exist in the DB because someone ran raw SQL. A fresh deploy would miss them.
- **Fix:** stop the dev DB, run `pnpm --filter @deft/db generate` — if drizzle-kit produces a migration capturing the wiki tables, great. If not, write a `0006_wiki_tables.sql` manually with the CREATE TABLE statements. Verify `pnpm push` on a fresh DB produces a working schema.
- **Effort:** 3 h
- **Severity:** HIGH (fresh deploys are broken without this)

### C6 — Production env config template
- **Where:** `.env.example` → `.env.production.example` and hosting dashboard vars
- **What:** `.env.example` documents dev values. No prod template, no secret generation script, no staging config.
- **Fix:** copy `.env.example` to `.env.production.example` with prod-appropriate defaults and comments. Add a script `scripts/generate-secrets.sh` that outputs fresh JWT/encryption keys via `openssl rand`.
- **Effort:** 2 h
- **Severity:** MEDIUM

### C7 — Resolve Redis dependency
- **Where:** `docker-compose.yml` still defines Redis, code uses Postgres for queues.
- **What:** per the April 10 report, code migrated off Redis for queues but Redis stayed in compose. Either remove it or use it for the Socket.IO adapter (needed for multi-instance scaling).
- **Fix:** decision call:
  - Single-instance launch → remove Redis from compose, drop any lingering imports.
  - Multi-instance from day 1 → wire Socket.IO's Redis adapter (`@socket.io/redis-adapter`) in `socket.ts`, add to Dockerfile deps, test cross-instance message delivery.
- **Effort:** 1 h (remove) or 4 h (wire adapter)
- **Severity:** MEDIUM

### C8 — Split Dockerfile for web + API services
- **Where:** `Dockerfile` at repo root currently starts both web and API in one container with `&`.
- **What:** production needs independent scaling. Running both in one container means scaling web also scales API.
- **Fix:** create `Dockerfile.api` and `Dockerfile.web`, or use Railway's service-splitting. Keep the current combined Dockerfile for dev/self-hosted simplicity.
- **Effort:** 4 h
- **Severity:** MEDIUM (nice to split; not a blocker for launch)

**Phase C total: ~30 hours**

---

## 🟡 Phase D — Missing API endpoints (10 h, known gaps from April 10)

### D1–D5 — Stub or implement missing endpoints
These are known to 404 from the April 10 report:
- **D1** `GET /api/tasks/saved-views` — frontend tasks page calls it, gets 404, throws 2 console errors. Quick stub: return `[]`. 30 min.
- **D2** `GET /api/users/status` — 404. Probably part of an older status feature. 1 h.
- **D3** `GET /api/calendar/events` — 404. Calendar page works via Google Calendar integration but this endpoint is missing. 2 h to stub, 4 h to wire to native events table.
- **D4** `GET /api/clips`, `GET /api/clips/my` — audio clips feature. Routes may need registration in `apps/api/src/index.ts`. 1 h.
- **D5** `GET /api/emoji/custom` — custom emoji endpoint. 1 h.

**Phase D total: ~10 hours** (mostly quick stubs)

---

## 🟡 Phase E — Frontend polish (30 h, ship before public launch)

### E1 — Error boundaries
- **Where:** new `apps/web/src/components/error-boundary.tsx`; wrap every app-level route in `apps/web/src/app/(app)/layout.tsx`
- **What:** zero error boundaries anywhere. An unhandled React error white-screens the entire app.
- **Fix:** write an `ErrorBoundary` class component with a fallback UI. Wrap the dashboard, agent, tasks, chat, knowledge, notes routes. Report errors to Sentry (from Phase C).
- **Effort:** 6 h
- **Severity:** MEDIUM

### E2 — error.tsx and global-error.tsx
- **Where:** `apps/web/src/app/error.tsx`, `apps/web/src/app/global-error.tsx`
- **What:** Next.js app-router needs these for route-segment errors + app-level errors. Neither exists; `not-found.tsx` does exist but it's only for 404s.
- **Fix:** write both. Style to match the rest of the app. Report errors to Sentry.
- **Effort:** 2 h
- **Severity:** MEDIUM

### E3 — Loading states
- **Where:** `apps/web/src/app/(app)/*/loading.tsx` for each major route
- **What:** no Next.js `loading.tsx` files. Initial route load shows blank while data fetches.
- **Fix:** add a `loading.tsx` per major route (dashboard, tasks, chat, notes, knowledge, agent, settings) with a skeleton screen.
- **Effort:** 8 h
- **Severity:** LOW (polish)

### E4 — Mobile responsiveness sweep
- **Where:** pages the audit flagged as having thin breakpoint coverage: chat, notes, knowledge.
- **What:** the sidebar has a hamburger toggle but content views are inconsistently mobile-friendly. Session 3 fixed the agent chat mobile gutter and code-block scrolling but didn't touch other pages.
- **Fix:** manual pass on a 390×844 viewport for each major page. Fix the top 5 broken layouts.
- **Effort:** 12 h
- **Severity:** MEDIUM (matters for any tablet/phone users)

### E5 — Accessibility audit
- **Where:** app-wide
- **What:** only 2 `aria-label` instances found across the entire codebase. Lots of icon-only buttons without labels, no keyboard nav audit, no screen-reader testing.
- **Fix:** run axe-core on the dev build, fix the top 20 violations. Focus on buttons, form inputs, and navigation.
- **Effort:** 16 h (can be deferred — not a launch blocker unless you have enterprise/gov customers)
- **Severity:** LOW (unless a11y is in your launch criteria)

**Phase E total: ~30 hours** (or ~14 hours if you skip E5 + E3)

---

## 🟡 Phase F — Commerce / scale (60 h, needed before you charge for anything)

### F1 — Billing schema + Stripe integration
- **Where:** new schema (`plans`, `subscriptions`, `invoices`, `payment_methods`), new routes (`apps/api/src/routes/billing.ts`), Stripe webhook handler.
- **What:** no billing anywhere. You can't charge customers.
- **Fix:** design plan tiers (Free, Team, Business, Enterprise), add the schema, wire Stripe Checkout + Customer Portal, Stripe webhook handler for lifecycle events (subscription.created, subscription.updated, invoice.paid, etc.), basic admin UI for billing state.
- **Effort:** 16+ h (plus Stripe learning curve if new)
- **Severity:** CRITICAL if charging, OPTIONAL if free/self-hosted launch
- **Recommendation:** launch free first, add billing once you have paying intent from real users.

### F2 — Usage limits + quotas
- **Where:** middleware in `apps/api/src/middleware/quota.ts`, usage counters in DB.
- **What:** no per-user or per-org quota enforcement. Free-tier abuse is unchecked.
- **Fix:** add counters for messages/day, agent calls/day, storage bytes, and enforce on request. Return `429` with a clear error when exceeded.
- **Effort:** 8 h
- **Severity:** HIGH if launching free tier publicly

### F3 — AI credits tracking (deferred from AGENT-UI-BACKLOG)
- **Where:** new table (e.g. `agent_usage`), UI meter in agent header, per-org budget enforcement
- **What:** this is the deferred item #11 from `AGENT-UI-BACKLOG.md`. Two credit-exhaustion incidents during the audit sweep prove the lack of visibility is operational risk.
- **Fix:** per-user + per-org token counters in DB. UI meter showing daily running total. Hard caps per trust tier. Overage alerts via email. Per-model cost table.
- **Effort:** 16 h (1-2 day session)
- **Severity:** HIGH (but scoped to when you open the agent to multiple users)

### F4 — Database indexes on heavy-query tables
- **Where:** `packages/db/src/schema.ts`
- **What:** only 7 indexes defined across 66 tables. Heavy-query foreign keys missing indexes: `agent_messages.conversation_id`, `messages.space_id`, `tasks.org_id`, `tasks.project_id`, `agent_actions.conversation_id`, etc.
- **Fix:** add indexes via drizzle's `index()` on the hot foreign keys. Generate a migration. Measure query times before/after with EXPLAIN ANALYZE.
- **Effort:** 2 h
- **Severity:** MEDIUM (works at small scale, will hurt at 10k+ rows per table)

### F5 — Streaming file uploads
- **Where:** `apps/api/src/routes/upload.ts:31` — currently buffers the entire file into memory via `file.arrayBuffer() + Buffer.from()`.
- **What:** 50MB limit is in place, but buffering means a handful of concurrent uploads can OOM the server.
- **Fix:** stream multipart form data directly to R2 / S3 using a streaming client. Keep the size limit.
- **Effort:** 6 h
- **Severity:** MEDIUM (MVP-acceptable at 50MB cap, fix before raising the limit)

### F6 — Admin panel
- **Where:** new routes under `apps/web/src/app/(app)/admin/*`
- **What:** no admin UI for ops. Member management exists in settings but there's no org-level admin view for "who's on the platform, what are they spending, block this user."
- **Fix:** build a minimal `/admin` page gated on `is_superadmin` flag. Show: org list, user list, usage metrics, ability to impersonate / suspend / refund.
- **Effort:** 20 h
- **Severity:** MEDIUM (can ship without; needed once you have real users)

**Phase F total: ~60 hours** (if you do all of it; ~30 hours if you launch free-only and skip billing for now)

---

## 🟢 Phase G — Launch prep (40 h, must do before public launch)

### G1 — Landing page at `/`
- **Where:** `apps/web/src/app/page.tsx` currently redirects to `/dashboard`.
- **What:** no marketing landing page. When people hit `deft.dev` unauthenticated, they bounce to `/login` with no context.
- **Fix:** build a `(marketing)` route group with a proper landing page at `/`: hero + tagline + screenshot + features section + CTA to sign up. Keep `/app` as the authenticated area OR use middleware to redirect logged-in users to `/dashboard`.
- **Effort:** 16 h
- **Severity:** HIGH for public launch, LOW for pilot

### G2 — Analytics
- **Where:** new wire-up via Plausible or PostHog.
- **What:** no analytics. You won't know who's signing up, activating, or retaining.
- **Fix:** pick one. Plausible ($9/mo, privacy-friendly, no cookie consent needed) or PostHog (free tier). Track signup, activation (first message), retention (DAU/WAU), feature usage.
- **Effort:** 4 h
- **Severity:** MEDIUM

### G3 — Transactional emails end-to-end test
- **Where:** Resend integration
- **What:** emails are wired but none have been tested end-to-end against real Resend. Templates may be missing or broken.
- **Fix:** manual test: signup → verify email arrives, password reset → verify email arrives, member invite → verify email arrives. Fix any template issues.
- **Effort:** 2 h
- **Severity:** HIGH (password reset is a critical path — must work)

### G4 — OAuth redirect URIs for production
- **Where:** Google Cloud Console, GitHub OAuth App settings, Google Calendar OAuth
- **What:** OAuth apps are configured with `localhost` redirect URIs. Production URLs need to be added.
- **Fix:** add `https://api.deft.dev/api/auth/google/callback`, `https://api.deft.dev/api/connections/github/callback`, `https://api.deft.dev/api/connections/google_calendar/callback` to each provider.
- **Effort:** 1 h
- **Severity:** HIGH (OAuth breaks without this)

### G5 — Domain + DNS + TLS
- **Where:** Cloudflare or equivalent DNS provider
- **What:** no domain configured. Current URLs are all `localhost:3000`.
- **Fix:** register a domain (you noted `deft.dev` / `getdeft.com` in DEPLOYMENT-PLAN.md), point DNS at Railway/Fly, verify TLS cert issues automatically via Let's Encrypt.
- **Effort:** 4 h
- **Severity:** HIGH (obviously)

### G6 — Staging environment
- **Where:** separate Railway project or Fly.io app
- **What:** no staging. Changes go straight from dev to prod.
- **Fix:** spin up a second hosted instance mirroring prod config, point at a separate staging DB. Deploy `develop` branch to staging, `main` to prod.
- **Effort:** 4 h
- **Severity:** MEDIUM (can launch without, but you'll regret it on the first production hotfix)

### G7 — Soft launch runbook
- **Where:** new `docs/RUNBOOK.md` or similar
- **What:** no documented on-call playbook. If something breaks, how do you diagnose? How do you roll back?
- **Fix:** write a 1-page runbook: "DB is down → check Railway", "API is 500ing → check Sentry", "users can't log in → check JWT secret + Redis (if session-revocation)", "how to roll back a deploy", "how to restore from backup."
- **Effort:** 3 h
- **Severity:** MEDIUM

### G8 — Seed data for demo
- **Where:** `apps/api/src/scripts/seed-demo.ts`
- **What:** new users currently see empty spaces, empty task board, empty wiki. Hard to understand the product value.
- **Fix:** seed the default new-org setup with 3 sample spaces, a sample project with ~10 tasks in various states, 3 wiki pages showing the knowledge system, 1 agent employee (Alex PM). Optional: only seed if user opts in during onboarding.
- **Effort:** 6 h
- **Severity:** MEDIUM

**Phase G total: ~40 hours**

---

## 🟢 Phase H — Optional / roadmap items

These are all in `ROADMAP.md` already and are not deploy blockers. Listed here for completeness.

### From Roadmap Phase 1 (close trust & adoption gaps)
- **2FA (TOTP)** — 3-4 days. Blocks enterprise / security-conscious teams.
- **Outgoing webhooks** — 1 week. Unlocks Zapier/Make/n8n integrations without building 50 native.
- **Data export CSV/JSON** (bulk, not GDPR) — 3-4 days. Unblocks security reviews.
- **Recurring tasks** — 3-4 days. Common feature gap vs Linear/Asana.
- **Task templates** — 2-3 days.
- **Guest access** — 4-5 days. Schema exists, needs middleware enforcement.
- **Calendar view for tasks** — 2-3 days. Calendar page exists, wire up task rendering.

### From Roadmap Phase 2 (deepen unique advantages)
- **Manager dashboard UI** — 5-7 days. Backend built, no UI. This is Deft's differentiator.
- **People directory + team graph** — 5-7 days. 7 tables populated, no UI.
- **AI writing assist in wiki/notes** — 4-5 days.
- **Thread / channel AI summaries** — 2-3 days.
- **Workflow rules UI** — 4-5 days.

### From AGENT-UI-BACKLOG.md (12 items)
- Desktop sidebar → ConversationList unification (2 h)
- Starter prompts editor UI (3-4 h)
- Auto-execute action audit logging (30 min)
- Python Sandbox + AWS Document Loader MCPs (30 min once `uv`/`deno` installed)
- Starter prompts a11y (1 h)
- Contextual follow-ups cache (1 h)
- Real-phone mobile verification (15 min)
- 401 `/api/auth/me` console noise (30 min)
- Legacy conversation cleanup (2 min)
- Prompt caching live verification (2 min)
- Audit script auth refresh automation (30 min)

### Test suite (40+ hours)
- Real unit + integration tests for the API (auth, tasks, messages, wiki CRUD, agent routes). The audit scripts at `docs/superpowers/audits/` cover UI flows but not server logic directly. Vitest or jest for the runner. ~40 hours to get meaningful coverage.

---

## Recommended sequencing

### Sprint 1 — "Don't get hacked on day 1" (1 week, ~20 h)
1. A1 password log fix (5 min) — **do first, before anything else**
2. A2 DOMPurify sites (4 h)
3. A4 rate limiting (6 h)
4. A5 security headers (2 h)
5. A3 session revocation (4 h)
6. C1 database backups (4 h)

### Sprint 2 — "Legal to exist" (1 week, ~25 h)
7. B1 Privacy Policy (4 h)
8. B2 TOS (4 h)
9. B3 GDPR export (6 h)
10. B4 Account deletion (8 h)
11. B5 Cookie consent (if needed, 3 h)

### Sprint 3 — "Can actually diagnose prod" (1 week, ~25 h)
12. C2 Sentry (4 h)
13. C3 Structured logging (4 h)
14. C4 Health endpoint (2 h)
15. C5 Wiki migrations (3 h)
16. C6 Prod env template (2 h)
17. C7 Redis decision (1-4 h)
18. D1-D5 Missing endpoint stubs (10 h)

### Sprint 4 — "Can launch to real users" (1 week, ~30 h)
19. E1 Error boundaries (6 h)
20. E2 error.tsx / global-error.tsx (2 h)
21. E4 Mobile responsiveness sweep (12 h)
22. G3 Transactional emails test (2 h)
23. G4 OAuth redirect URIs (1 h)
24. G5 Domain + DNS + TLS (4 h)
25. C8 Split Dockerfile (4 h)
26. G7 Soft launch runbook (3 h)

### Sprint 5 — "Can do a public launch" (1 week, ~30 h)
27. G1 Landing page (16 h)
28. G2 Analytics (4 h)
29. G6 Staging env (4 h)
30. G8 Seed demo data (6 h)
31. A6 Enforce email verification (2 h)

### Sprint 6 — "Can charge customers" (1 week, ~30 h, optional)
32. F1 Billing + Stripe (16 h)
33. F2 Usage quotas (8 h)
34. F4 Indexes (2 h)
35. F5 Streaming uploads (6 h)

### Later / as-needed
- F3 AI credits tracking — when you open agent to multiple users
- F6 Admin panel — when you have real users to manage
- E3 Loading states — polish
- E5 A11y — polish / enterprise requirement
- H phase roadmap items — product depth
- Test suite — ongoing

**Total effort to production-ready (sprints 1-5): ~130 hours = ~4 weeks of focused solo work.**
**Add sprint 6 for paid launch: ~160 hours = ~5 weeks.**
**Add test suite + H-phase basics: ~220+ hours = ~6-7 weeks.**

---

## What NOT to worry about

The following are already working well and don't need attention before launch:
- Core chat (messages, threads, reactions, mentions, rich text, presence, files)
- Tasks (kanban, list, priorities, labels, projects, assignees, due dates)
- Knowledge wiki (CRUD, graph, FTS, versions, cascade ingest, export)
- Dashboard (greeting, tasks, stats, projects, activity, calendar)
- Manager intelligence (health, burnout, 1:1 prep, team dynamics) — backend built
- Agent loop (tools, approval, streaming, memory, undo, citations)
- Real-time (Socket.IO working)
- Background jobs (Postgres queue, 17 workers, 73k+ completed jobs)
- Multi-tenancy (org_id on 66 tables)
- Prompt caching (Session 2.5)
- Onboarding flow (`/setup` 5-step wizard works)
- Google Calendar + GitHub integrations

## What's actively misleading in existing docs

- `DEPLOYMENT-READINESS-REPORT.md` (April 10) still says wiki tables are missing from migrations. That's still true as of April 13 (Session 3 added agent_messages/actions migrations but not wiki).
- `DEPLOYMENT-PLAN.md` (April 10) says the journal needs idx 4 backfill. That's done as of Session 3's schema task.
- `DEPLOYMENT-PLAN.md` estimates 10-18 days to launch; **that was before the security + legal gaps surfaced in this audit**. Realistic estimate is 4-6 weeks.

---

## Related docs

- [Deployment Readiness Report (April 10)](../../DEPLOYMENT-READINESS-REPORT.md) — stale in places, still useful
- [Deployment Plan (April 10)](../../DEPLOYMENT-PLAN.md) — still useful for infra sequencing
- [Roadmap (April 8)](../../ROADMAP.md) — phases 1-6 product features
- [Agent UI Backlog (April 13)](AGENT-UI-BACKLOG.md) — 12 deferred items from the 3-session sweep
- [Agent UI Sessions Rollup (April 13)](2026-04-13-agent-ui-sessions-rollup.md) — what shipped in the April 12-13 sweep

---

# External Dependencies

Everything Deft will need from the outside world to ship. Grouped by category, with free-tier notes and rough monthly cost at launch scale (small team, low traffic). Price estimates are USD, accurate as of April 2026 — verify before committing.

## 🏠 Hosting + infrastructure (required)

| Service | What for | Free tier | Launch cost | Notes |
|---|---|---|---|---|
| **Railway** *(recommended)* | Hosts both the Next.js web and the Hono API as separate services. Native Docker, WebSocket support, auto-deploy from GitHub. | $5/mo hobby, $0 usage credit | **$20/mo base + ~$10–30 usage** | Best fit — supports persistent processes for background workers. Includes managed Postgres + Redis as add-ons. |
| **Fly.io** *(alt)* | Docker-native, globally distributed, good for WebSockets | Free tier: 3 shared VMs, 3GB storage | ~$15/mo | Requires more manual config than Railway, but cheaper at small scale. |
| **Postgres (managed)** | Primary database. Options: Railway Postgres (included), Neon (serverless, pgvector support, free tier 0.5GB), Supabase (blocked in India per CLAUDE.md — skip). | Railway: included. Neon: free 0.5GB / 190 compute hours | **$0–20/mo** | Must enable pgvector extension for future embeddings. PgBouncer connection pooling at scale. |
| **Redis (managed)** | Socket.IO adapter (multi-instance), session revocation cache (Phase A3), rate-limit counters (Phase A4) | Railway: included. Upstash: free 10k commands/day. Redis Cloud: free 30MB | **$0** at launch | Optional if you launch single-instance. Required for multi-instance scaling. |
| **Cloudflare R2** | File storage for user uploads (replaces current local `./uploads` filesystem) | 10GB storage, 10M reads/mo, 1M writes/mo free | **$0** at launch, ~$0.015/GB/mo beyond free tier | S3-compatible API, zero egress fees. Upload route at `apps/api/src/routes/upload.ts` already checks for R2 config and falls back to local. |
| **Cloudflare** (DNS + CDN + SSL) | DNS, DDoS protection, CDN, free TLS, domain registrar | Fully free | **$0** | Industry standard. Enables WebSocket tunneling for Socket.IO. |
| **Domain registrar** | e.g. `deft.dev`, `getdeft.com`, `usedeft.com` | N/A | **~$10–50/yr** | Cloudflare Registrar sells at cost (no markup). |

## 📧 Communication

| Service | What for | Free tier | Launch cost | Notes |
|---|---|---|---|---|
| **Resend** | Transactional email: password reset, email verification (Phase A6), member invites, weekly digests | 3,000 emails/mo, 100/day free | **$0** at launch, $20/mo for 50k | Required for Phase G3 email verification flow. Needs domain verification via DNS records. Set `RESEND_API_KEY` + `FROM_EMAIL`. |

## 🔐 Auth / OAuth providers

| Service | What for | Cost | Setup effort |
|---|---|---|---|
| **Google Cloud Console** | OAuth credentials for "Sign in with Google" + Google Calendar integration | Free | **Medium** — requires OAuth consent screen verification (brand verification can take 2–6 weeks for apps requesting sensitive scopes like Calendar). Google reviews: domain ownership, Privacy Policy URL, Terms of Service URL, demo video. **This is why Phases B1+B2 are blocking.** |
| **GitHub OAuth App** | OAuth credentials for GitHub integration (PR/issue polling, agent read) | Free | Low — create OAuth app, add client id/secret, done. Production redirect URI: `https://api.deft.dev/api/connections/github/callback` |

## 🤖 AI / MCP services (required for agent features)

| Service | What for | Free tier | Launch cost | Notes |
|---|---|---|---|---|
| **Anthropic API** (Claude Sonnet + Haiku) | Core agent loop + contextual follow-ups + all LLM features | Pay-per-token, no free tier | **$5–50/mo at small usage, $200+ at growing team scale** | **Primary cost driver.** Session 2.5 prompt caching cuts cost ~55%. Budget $0.07–0.21 per agent query depending on complexity. See `docs/superpowers/plans/AGENT-UI-BACKLOG.md` item #11 for proper credit tracking (deferred). |
| **Tavily** | Web search MCP — used by all agent employees via `tavily_search` / `tavily_extract` / `tavily_crawl` | 1,000 credits/mo free | **$0** at small scale, ~$30/mo for 4k credits | Credit rotation: the dev key pasted into this session's chat history on April 12 should be rotated post-deploy. |
| **Upstash Context7** | Real-time library documentation MCP — used by `resolve-library-id` / `get-library-docs` | Generous free tier with API key (`CONTEXT7_API_KEY`) | **$0** | Paid only at serious scale. |
| **Playwright MCP** | Browser automation (`mcp__playwright-browser__*` tools) | Free — runs as a stdio subprocess via `npx @playwright/mcp` | **$0** | Self-hosted, uses local chromium. Chromium binary (~150MB) must be pre-installed in the production container. |
| **Time MCP** (`time-mcp`) | Current time + timezone conversion | Free | **$0** | Local stdio subprocess via npx. |
| **Fetch MCP** (`fetch-mcp`) | HTTP GET with markdown extraction | Free | **$0** | Local stdio. |
| **Sequential Thinking MCP** | Structured reasoning scratchpad | Free | **$0** | Local stdio. |

## 📊 Monitoring + observability

| Service | What for | Free tier | Launch cost | Notes |
|---|---|---|---|---|
| **Sentry** (Phase C2) | Error tracking for API (`@sentry/node`) + web (`@sentry/nextjs`) | 5,000 errors/mo, 1 user | **$0** at launch, $26/mo team plan | Required per DEPLOYMENT-PLAN. Captures unhandled exceptions, API 5xx, failed jobs. |
| **BetterUptime** or **UptimeRobot** | Uptime monitoring: `/health`, `/health/queue`, WebSocket connectivity | Free: 50 monitors, 5-min checks | **$0** | Required for Phase G. Alerts via email/SMS/Slack. |
| **Axiom** or **Logtail** (optional) | Log aggregation + query — needed after Phase C3 structured logging is in | Axiom free: 500MB/mo. Logtail free: 1GB/mo | **$0** at launch | Not strictly required — Railway/Fly.io capture stdout/stderr by default. Aggregation helps after you have real traffic. |

## 📈 Analytics

| Service | What for | Cost | Notes |
|---|---|---|---|
| **Plausible** *(recommended)* | Privacy-friendly product analytics — no cookies, no consent banner needed, no GDPR headaches | **$9/mo** for 10k pageviews | Ships in a single script tag. Great for privacy-conscious product. Reduces legal surface (no cookie consent). |
| **PostHog** *(alt)* | Full-featured analytics + session recordings + feature flags + A/B testing | Free tier: 1M events/mo | Much more powerful but requires cookie consent (Phase B5). Useful if you want behavioral analytics and experimentation. |

## 💳 Payments (Sprint 6 — optional at launch)

| Service | What for | Cost | Notes |
|---|---|---|---|
| **Stripe** | Billing, checkout, customer portal, invoices, dunning | **2.9% + $0.30 per charge**, no monthly fee | Phase F1 if/when you charge customers. Launch free first, add when paying intent materializes. |
| **Stripe Tax** (optional) | Automatic VAT / sales tax calculation | 0.5% per transaction | Only matters for international + US state-level sales tax. |

## ⚖️ Legal / compliance

| Service | What for | Cost | Notes |
|---|---|---|---|
| **iubenda** or **Termly** | Privacy Policy + Terms of Service generator (Phase B1+B2) | iubenda: $9/mo for full suite. Termly: free with branding, $10/mo without | Alternative: hand-written by you or a lawyer ($500–2000 one-time). Required for Google OAuth approval. |
| **Data Processing Agreement template** | GDPR compliance for enterprise customers asking for a DPA | Free templates (gdpr.eu, iubenda) or lawyer ($500+) | Not needed for launch; needed when first enterprise prospect asks. |
| **Google Workspace** or **Zoho Mail** (optional) | Custom-domain email for `support@deft.dev`, `noreply@deft.dev`, etc. | Google Workspace: $6/user/mo. Zoho Mail: free for 5 users | Can delay — start with `noreply@deft.dev` via Resend domain verification + forward to a personal inbox. |

## 🛠️ Dev tooling / CI

| Service | What for | Cost | Notes |
|---|---|---|---|
| **GitHub** | Source hosting + Actions CI/CD | Free for private repos + 2,000 Actions minutes/mo | Already using. Existing `.github/workflows/ci.yml` runs typecheck + build. |
| **GitHub Actions** | CI: typecheck, build, deploy, eventually test | Free tier: 2,000 min/mo on private. $0.008/min beyond. | Plenty for a small team. |
| **Claude Code** / **Anthropic API** (dev tooling) | You already have this | Per-session cost | Not counted as "Deft dependency" but worth noting — agentic dev loops are part of the budget. |

## 📦 npm packages to add (not yet installed)

These are packages the audit flags as needed but which aren't in the tree yet. Install with `pnpm --filter @deft/web add <pkg>` or `pnpm --filter @deft/api add <pkg>`:

| Package | Where | Purpose | Phase |
|---|---|---|---|
| **`dompurify`** + `@types/dompurify` | `@deft/web` | Sanitize the 8 `dangerouslySetInnerHTML` sites | A2 |
| **`hono-rate-limiter`** (or similar: `@hono/rate-limiter`) | `@deft/api` | Rate limiting middleware | A4 |
| **`hono-helmet`** (or manual header middleware) | `@deft/api` | Security headers (CSP, HSTS, X-Frame-Options, etc.) | A5 |
| **`pino`** + **`pino-http`** (or `hono-pino`) | `@deft/api` | Structured JSON logging with redaction | C3 |
| **`@sentry/node`** | `@deft/api` | Error tracking (API) | C2 |
| **`@sentry/nextjs`** | `@deft/web` | Error tracking (web) | C2 |
| **`@socket.io/redis-adapter`** (conditional) | `@deft/api` | Only if you go multi-instance and keep Redis | C7 |
| **`stripe`** (conditional) | `@deft/api` | Only if Phase F1 ships | F1 |
| **`posthog-node`** + **`posthog-js`** (if PostHog) | both | Analytics | G2 |

## 💰 Total launch-month cost estimate

Minimum viable (free tiers only):
- Railway hobby: $5/mo
- Domain: ~$1/mo amortized
- Everything else: $0 (free tiers)
- Anthropic API: $10–30/mo (depends on usage)

**Total: ~$16–36/mo to run Deft in production on day 1.**

Realistic first 6 months (light traffic, some paid tier upgrades):
- Railway Pro: $20–50/mo
- Postgres overage: $0–20/mo
- Plausible (if chosen): $9/mo
- Email overage: $0–20/mo (Resend paid tier)
- Anthropic API: $50–200/mo
- Sentry Team: $0–26/mo (when free tier runs out)

**Total: ~$80–325/mo for the first 6 months of real operation.**

At 100+ active users or heavy agent usage, expect the Anthropic API line to dominate — budget $500–2000/mo. That's why Session 2.5 prompt caching was worth shipping pre-launch (cuts cost ~55%).

## 🚦 Sequencing note on external dependencies

Many of these dependencies gate each other. Rough order to set up:

1. **Domain + Cloudflare DNS** (before Google OAuth approval can start)
2. **Resend + domain verification** (before email verification flow works)
3. **Privacy Policy + TOS pages** (Phase B1+B2 — blocks Google OAuth consent screen approval, which takes 2–6 weeks)
4. **Google OAuth consent screen + verification** — start the approval flow early, it's async
5. **Railway + Postgres + managed Redis** (infra)
6. **R2 + env vars** (file storage)
7. **Sentry + uptime monitor** (observability)
8. **Analytics** (after legal pages land)
9. **Stripe** (only if charging)

Google OAuth verification in particular is **not a code change** — it's a manual process with Google that requires domain ownership, public Privacy Policy URL, public TOS URL, and sometimes a demo video. Start it as soon as the domain and legal pages are live, and don't count on the approval being instant.
