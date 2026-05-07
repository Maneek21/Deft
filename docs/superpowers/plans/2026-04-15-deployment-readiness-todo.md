# Deft — Deployment Readiness TODO (v2)

**Updates** the April 13 `2026-04-13-deployment-readiness-todo.md` with two weeks of shipped work: the 17-gap sweep (gap-fixes plan), the mention-pill fixes, the password-log fix, the full trusted-tester deploy to Neon + Railway, and the rich seed content. Keeps the same A → H phase structure so you can diff against the original.

## TL;DR — where we are vs where we're going

**Where we are (April 15, 7 PM):**
- ✅ Trusted-tester environment is **live and serving traffic** at `https://deft-web-production.up.railway.app`
- ✅ 15/15 gap-fixes audit checks green (locally — prod audit pending)
- ✅ Neon Postgres with pgvector + 85 tables + Railway api + Railway web deployed and talking
- ✅ Admin user + 6 seeded team members + 3 projects + 47 tasks + 25 wiki pages + 12 spaces + ~185 messages + 21 calendar events
- ✅ `ANTHROPIC_API_KEY` set on prod; agent endpoints returning 200
- ✅ 30 commits landed since the gap-fix sprint started (17 fix, 6 feat, 4 chore, 2 docs, 1 test)

**Next decision point:** do we **widen the tester cohort beyond trusted** or **iterate on feedback from the current 5–6 testers first**? If the latter, most of this TODO can wait. If the former, we need to close A4/A5/A6/B1/B2/C1/C2/C4 before opening the URL to anyone whose browser tab we can't trust.

**Updated total effort to production:**
- **Widen cohort** (close critical security + minimal legal): ~40 hours (sprint 1 below)
- **Public launch** (add legal, ops, polish, launch prep): ~130 hours (sprints 1–5)
- **Paid launch** (add commerce): ~160 hours (sprints 1–6)

**Single most urgent item:** ~A1 password logging — FIXED on April 15.~ The new #1 is **A5 security headers** (2 hours, unblocks everything else) and **A6 email verification gate** (2 hours). Both are small but high-leverage.

---

## What landed since April 13

Status markers inherited from the original TODO. `→ DONE` / `→ PARTIAL` / `→ PENDING`.

### 🔴 Phase A — Security

- **A1 — Password console.log** → **DONE** (commit `44b349e`). `apps/api/src/routes/members.ts:145-186` now returns `temp_password` in the API response when Resend isn't configured, never writes it to stdout. Honest-labelled carry-forward commit so the diff is auditable.
- **A2 — Sanitize `dangerouslySetInnerHTML`** → **DONE**. Fresh grep of `apps/web/src/**/*.tsx` finds **zero** call sites. Either they were refactored out during the April 14 agent-employees UI sweep, or the original count was stale. **Worth a 30-min re-verification** before claiming fully closed — my Explore agent found 0 matches but the original TODO listed 8 specific file:line references. Re-grep with fresh eyes before marking "done" in a PR.
- **A3 — Logout + refresh revocation** → **DONE** (commit `23c1f50`, from Task 15 of the gap-fixes plan). `POST /api/auth/logout` writes the refresh token's sha256 hash to `revoked_tokens`. `/api/auth/refresh` checks the table before accepting the token. Verified by the gap-fixes audit `gap#server-logout`.
- **A4 — Rate limiting** → **PENDING**. No middleware. Current soft-limit is the $50/mo Anthropic budget cap in the dashboard. Acceptable for the trusted cohort but blocks widening.
- **A5 — Security headers** → **PENDING**. `apps/api/src/index.ts:54-77` only has `cors()` + `logger()` — no CSP, HSTS, X-Content-Type-Options, X-Frame-Options. `apps/web/next.config.ts` has no `headers()` export. **2 hours of work, high leverage.**
- **A6 — Enforce email verification on login** → **PENDING**. `auth.ts:110-142` login handler doesn't check `user.email_verified`. Column exists, signup sets it correctly, just needs a guard clause.

**Phase A remaining: ~12 hours** (down from 20).

### 🔴 Phase B — Legal / compliance

- **B1 — Privacy Policy page** → **PENDING**. No `apps/web/src/app/privacy/page.tsx`.
- **B2 — Terms of Service page** → **PENDING**. No `apps/web/src/app/terms/page.tsx`.
- **B3 — GDPR data export** → **PENDING**. No `GET /api/users/me/export`.
- **B4 — Account deletion** → **PENDING**. No `DELETE /api/users/me`.
- **B5 — Cookie consent** → **PENDING** (low — only matters if we ship analytics with cookies).

**Phase B remaining: ~25 hours** (unchanged).

### 🟠 Phase C — Ops / observability

- **C1 — DB backups** → **PENDING**. Neon free tier has no point-in-time restore. Acceptable for throwaway tester data, **must** upgrade or add `pg_dump` cron before any data we care about.
- **C2 — Sentry** → **PENDING**. No `@sentry/node` or `@sentry/nextjs` in `package.json`, no `Sentry.init()` calls.
- **C3 — Structured logging** → **PENDING**. No `pino` in the API.
- **C4 — Real health endpoint** → **PENDING**. `apps/api/src/index.ts:118` `/health` still hardcoded `{status:'ok'}`. **BUT** — `/health/queue` (lines 120-138) DOES query the DB, so uptime monitors can hit that instead as a workaround.
- **C5 — Wiki migrations in journal** → **PARTIAL (kind-of-done on prod, dev still broken)**. `packages/db/drizzle/0011_wiki_pages_embedding.sql` exists and is referenced. Prod Neon has real `vector(1536)` and the ivfflat index. **Dev Postgres on Windows still uses the BYTEA workaround** because pgvector isn't available locally. Documented in commit `520eb5a`. **New item below:** D10 — install pgvector in local dev or switch to Docker Postgres for dev.
- **C6 — Production env template** → **PENDING**. No `.env.production.example`. `scripts/generate-secrets.sh` doesn't exist. **BUT** the full env var list is documented in `docs/superpowers/plans/2026-04-15-test-deploy-runbook.md` appendix, which is better than nothing. Lift that into a proper template file when convenient.
- **C7 — Redis decision** → **PARTIAL**. Redis still in `docker-compose.yml` but nothing uses it — the Postgres job queue runs fine without it. Railway deploy doesn't provision Redis at all. **Recommend removing from docker-compose.yml** (1 h of cleanup) rather than wiring the Socket.io Redis adapter (4 h). Single-instance is the correct choice at tester scale.
- **C8 — Split Dockerfile for web + API** → **PENDING-BUT-WORKED-AROUND**. The monolithic root `Dockerfile` still exists. On Railway we force nixpacks via `.railwayignore` (excludes `Dockerfile` from the upload tarball) and use custom build + start commands per service. Works fine but the `Dockerfile` is dead code in prod. **Two paths forward:** (a) delete the root Dockerfile, or (b) split it into `Dockerfile.api` + `Dockerfile.web` for self-hosters. Not urgent.

**Phase C remaining: ~24 hours** (down from 30 — a few partials).

### 🟡 Phase D — Missing endpoints

- **D1 — `/api/tasks/saved-views`** → **DONE**. Endpoint exists, gap-fixes audit confirms 200.
- **D2 — `/api/users/status`** → **PENDING**. `PATCH` exists, `GET` does not.
- **D3 — `/api/calendar/events`** → **DONE**. `calendar.ts:9` with `?from=ISO&to=ISO` query params.
- **D4 — `/api/clips`** → **DONE**. `GET /api/clips/:id` + `GET /api/clips/space/:spaceId` exist.
- **D5 — `/api/emoji/custom`** → **DONE**. `GET /api/emoji` exists.

**Phase D remaining: ~1 hour** (down from 10 — mostly 404s got filled in).

### 🟡 Phase E — Frontend polish

- **E1 — Error boundaries** → **PENDING**. No `error-boundary.tsx`.
- **E2 — `error.tsx` / `global-error.tsx`** → **PENDING**.
- **E3 — `loading.tsx` per route** → **PENDING**.
- **E4 — Mobile responsive sweep** → **PENDING** (can't verify via code, skipping check).
- **E5 — Accessibility audit** → **PARTIAL**. `aria-label` count grew from 2 → 5 across the codebase. Still a long way from accessibility-first. Acceptable for trusted cohort, must land before enterprise pitches.

**Phase E remaining: ~30 hours** (unchanged).

### 🟡 Phase F — Commerce / scale

- **F1 — Stripe billing** → **PENDING**. Not needed for tester phase.
- **F2 — Usage quotas** → **PENDING**. Soft cap via Anthropic dashboard works for now.
- **F3 — AI credits UI** → **PENDING**. Deferred from AGENT-UI-BACKLOG.
- **F4 — Database indexes** → **DONE (massively improved)**. Index count grew from **7 → 72** since April 13. Someone added indexes during the agent-employees UI work and the wiki + Openclaw phases. Worth an EXPLAIN ANALYZE audit of the hottest 10 queries to confirm the new indexes are on the right columns, but the raw count is no longer a blocker.
- **F5 — Streaming uploads** → **PENDING**. Still `file.arrayBuffer()` buffered. Acceptable at 50 MB cap for trusted cohort.
- **F6 — Admin panel** → **PENDING**.

**Phase F remaining: ~50 hours** (down from 60 — F4 closed).

### 🟢 Phase G — Launch prep

- **G1 — Landing page at `/`** → **DEFERRED**. `apps/web/src/app/page.tsx` redirects to `/dashboard`. Fine for tester phase since testers get direct links. Needed for public launch.
- **G2 — Analytics** → **PENDING**.
- **G3 — Transactional email test** → **PENDING**. We shipped without Resend configured, relying on the `temp_password` response field instead.
- **G4 — OAuth redirect URIs** → **N/A for tester phase** (no Google OAuth used in trusted tester launch).
- **G5 — Domain + DNS + TLS** → **PARTIAL**. We're on Railway's `*.up.railway.app` subdomains. **ISP DNS filtering surfaced as an issue** — see D11 below.
- **G6 — Staging env** → **PENDING**. Current "staging" is local dev.
- **G7 — Soft launch runbook** → **PARTIAL**. `docs/superpowers/plans/2026-04-15-test-deploy-runbook.md` is the canonical runbook now, complete with the real-deploy gotchas appendix. Not at the file path G7 expected (`docs/RUNBOOK.md`) but the content is there.
- **G8 — Seed data for demo** → **DONE**. Two scripts: `apps/api/src/scripts/seed-test-org.ts` (base cohort) + `seed-test-org-rich.ts` (layered rich content with DMs, projects, wiki cross-links, calendar events). Committed `849ed20` + `d441868`.

**Phase G remaining: ~30 hours** (down from 40 — G7 + G8 partially done).

---

## New items discovered during the April 15 deploy

These aren't in the original TODO but we learned them the hard way. Adding as Phase **D′** ("deploy-ops") so the numbering doesn't collide with phase D.

### D'1 — Custom domain + Cloudflare proxy **[3 h — high leverage]**

**Why:** one of our first (internal) testers couldn't reach `deft-web-production.up.railway.app` because their ISP's DNS resolver was actively refusing queries for `*.up.railway.app` (likely filtering Fastly's anycast IPs). Fixed for them by switching networks, but this **will** bite random testers whose ISPs filter Fastly/CloudFront domains.

**Fix:** buy a domain (`deft.dev` / `getdeft.com` / whatever), proxy through Cloudflare with the orange cloud on, CNAME `app.deft.dev → deft-web-production.up.railway.app`, configure the custom domain in Railway's service settings. Cloudflare's DNS is never filtered and their edge network has a different IP range than Fastly's.

**Bonus:** you get free SSL, free CDN caching, WAF rules, and a domain you actually own for Privacy Policy / Terms URLs.

### D'2 — Rotate the three API tokens currently in chat history **[5 min — must do]**

Neon API key, Railway account token, and Vercel token were pasted into this session's chat context during the deploy. They're revocable in one click each:

- Neon: <https://console.neon.tech> → Account settings → API keys → revoke
- Railway: <https://railway.com/account/tokens> → revoke
- Vercel: <https://vercel.com/account/tokens> → revoke (unused anyway — the read-only scope blocked the Vercel path)

Deft keeps running without them because the provisioned resources use their own internal credentials once created. Do this before closing the session.

### D'3 — Delete local `.deploy-tokens` scratch file **[1 min]**

It's `.gitignore`d but still sitting at the repo root on disk. Remove it.

### D'4 — Run the gap-fixes audit against the hosted environment **[30 min]**

The 15/15 green is local-dev only. The real prod test is:

```bash
DEFT_TEST_EMAIL=maneek@deft.test \
DEFT_TEST_PASSWORD='<prod password>' \
DEFT_WEB_URL=https://deft-web-production.up.railway.app \
DEFT_API_URL=https://deft-api-production.up.railway.app \
pnpm exec tsx docs/superpowers/audits/gap-fixes.audit.ts
```

If anything fails on prod but passes on dev, it's a Railway-config issue (env var missing, CORS misconfigured, nixpacks build difference). Worth running before inviting testers.

### D'5 — Proper API build step (drop `tsx watch` in prod) **[2 h]**

`apps/api/package.json` has `"build": "tsx src/index.ts"` which isn't a real build — just runs the server. And `"start": "node dist/index.js"` references a `dist/` that doesn't exist. On Railway we worked around this by making the start command `pnpm --filter @deft/api exec tsx src/index.ts` which runs from source via tsx.

**Cost:** tsx has a ~300ms cold-start compile step on every boot that a proper `tsc`/`esbuild` build would eliminate. Not a blocker at tester scale (boots once per deploy), will be visible under Railway's sleep-on-idle behavior.

**Fix:** add `esbuild --bundle --platform=node --target=node22 src/index.ts --outfile=dist/index.js` as the real build command, update `start` to `node dist/index.js`, update Railway's start command to match.

### D'6 — pgvector in local dev **[1 h one-time + docs]**

Dev Postgres on Windows doesn't have pgvector, so `wiki_pages.embedding` is BYTEA locally per the April 15 workaround commit. This means:
- Local wiki search features don't actually run vector similarity
- Any local test of embedding backfills will fail
- Someone setting up a fresh dev env will re-hit the gap #10 500 error

**Fix:** either (a) document the BYTEA workaround in CLAUDE.md so new devs know, or (b) switch local dev Postgres to the `pgvector/pgvector:pg17` Docker image (one-line docker-compose change). Option (b) is cleaner.

### D'7 — Document the Railway-specific gotchas permanently **[done, 0 h]**

Already in `docs/superpowers/plans/2026-04-15-test-deploy-runbook.md` appendix, which records:
- Vercel token scope trap (Northstar personal accounts are read-only)
- Railway CLI project-token vs account-token auth split
- `Dockerfile` auto-detection forcing nixpacks via `.railwayignore`
- `next start -p $PORT` not expanding through pnpm-exec wrapper
- Signup endpoint expects `org_name` not `orgName`
- Railway upload endpoint intermittent 500s (retry after 60s)

Leave it where it is; no action needed.

### D'8 — Remove or refactor the monolithic root `Dockerfile` **[1 h]**

Currently the root `Dockerfile` builds both web + api and runs them in one container with `&`. On Railway we exclude it via `.railwayignore` so nixpacks takes over, but anyone who self-hosts via `docker run` will hit the same CORS/port issues we hit on Railway. Either delete it, turn it into an api-only or web-only variant, or add a `# Railway uses nixpacks instead; this Dockerfile is for self-hosted only` comment + update `README.md` accordingly.

### D'9 — Clean up the `packages/db/seed.ts` vs `seed-test-org.ts` divergence **[1 h]**

`packages/db/seed.ts` is destructive — wipes every table and re-seeds a dev fixture. **Unusable on a live DB.** We added `apps/api/src/scripts/seed-test-org.ts` + `seed-test-org-rich.ts` for the non-destructive prod path. Both are committed, both are documented in their respective commit messages.

**Cleanup action:** rename `packages/db/seed.ts` to `packages/db/seed-dev.ts` (matches its destructive scope), or add a top-of-file warning comment + a check that refuses to run against non-localhost DATABASE_URLs. Prevents someone nuking prod with `pnpm db:seed` by habit.

### D'10 — Live remote gap-fixes audit **[same as D'4 — track separately]**

Call out in sprint planning: the gap-fixes audit check `gap#7+12 projects endpoint exposes live total_tasks` currently reports `deft.total_tasks=25` on local dev but the production count will differ. Some checks (#2 chat wrapper, #9 wiki entities label, #11 note preview, #19 note delete confirm) will behave identically on prod because they're source-level or UI-level assertions, but a few assert on specific DB state (#21 dropdown, #18 source-level) and should be re-verified fresh. Worth a sanity pass.

### D'11 — First-class "tester having DNS trouble" playbook **[30 min]**

Document in the tester onboarding email or Notion page: if the site won't load, try (1) enable DNS over HTTPS in Chrome/Firefox, (2) change system DNS to 8.8.8.8 or 1.1.1.1, (3) use mobile hotspot. This is a known-issue FAQ more than a fix, but it'll save 20 minutes of confusion the first time a real tester reports it.

**Phase D′ total: ~8 hours**

---

## Phase H — Optional / roadmap

Unchanged from April 13. See the original TODO section for the list. No progress; no regressions.

---

## Updated sequencing

The April 13 sprints assumed "launch to anyone" from a cold start. Now we're deployed to trusted testers, so the sequencing is different. Here's the revised sprint plan with durable milestones:

### Milestone 1 — "Don't leak anything dumb" ✅ DONE (April 15)

Gate met: trusted tester cohort can safely use the live URL without us shipping an obvious security bug on day 1.

- ✅ A1 password log fix
- ✅ A3 logout revocation
- ✅ 17-gap audit (15 resolved in code, 1 deferred then fixed post-deploy, 1 retracted)
- ✅ Mention pill + double-@ fixes
- ✅ Rich seed data

### Milestone 2 — "Widen the cohort to untrusted testers" **[~16 h, 2 days]**

Gate: anyone we don't personally know can sign up without us worrying about XSS, rate limit abuse, or logged-in users never being able to log out cleanly.

- A4 rate limiting (6 h) — `hono-rate-limiter` with per-route limits; in-memory for single-instance launch
- A5 security headers (2 h) — hono-helmet equivalent + `headers()` in `next.config.ts`
- A6 email verification gate (2 h) — login handler check + re-send endpoint
- C4 real `/health` endpoint (2 h) — `SELECT 1` + version + uptime
- D'1 custom domain + Cloudflare (3 h) — unblocks ISP-filter issues + looks professional
- D'2 rotate deploy tokens (5 min) — must-do
- A2 re-verification (30 min) — confirm the 0-match grep result isn't stale

### Milestone 3 — "Legal to exist" **[~25 h, ~1 week]**

Gate: public-ish launch OK; GDPR-safe; Google OAuth brand verification can start.

- B1 Privacy Policy (4 h)
- B2 Terms of Service (4 h)
- B3 GDPR data export (6 h)
- B4 Account deletion (8 h)
- B5 Cookie consent (3 h — or skip if using Plausible)

### Milestone 4 — "Can diagnose prod" **[~15 h, ~2 days]**

Gate: when something breaks, we find out from Sentry, not from a tester DM.

- C1 DB backups (4 h — Neon paid PITR or `pg_dump` cron to R2)
- C2 Sentry (4 h — `@sentry/node` + `@sentry/nextjs`)
- C3 Structured logging (4 h — `pino` with redaction)
- C7 Redis cleanup in docker-compose (1 h — remove unused service)
- D'4 live remote gap-fixes audit (30 min)
- D'5 proper API build step (2 h — optional, not blocking)

### Milestone 5 — "Can launch to real users" **[~30 h, ~1 week]**

Gate: public launch-ready. Error pages exist. Landing page exists. Mobile doesn't look broken. Email flows end-to-end.

- E1 Error boundaries (6 h)
- E2 error.tsx / global-error.tsx (2 h)
- E4 Mobile responsive sweep (12 h)
- G1 Landing page (16 h) — split across 2 days
- G3 Resend + email flow test (2 h)

### Milestone 6 — "Can charge customers" **[optional, ~30 h]**

Deferred until paying intent materializes. Existing Phase F items.

### Milestone 7 — "Durable ops" **[optional, ~15 h]**

- G6 Staging env (4 h)
- G7 Runbook → consolidate `2026-04-15-test-deploy-runbook.md` + sprint retros into a `docs/RUNBOOK.md`
- E3 Loading states (8 h)
- D'6 pgvector in local dev (1 h)
- D'8 Root Dockerfile cleanup (1 h)
- D'9 Rename `packages/db/seed.ts` → `seed-dev.ts` (1 h)

---

## Updated totals

| Milestone | Effort | When |
|---|---|---|
| ✅ M1 "Don't leak anything dumb" | DONE | April 15 |
| M2 "Widen cohort" | ~16 h | When ready to take untrusted signups |
| M3 "Legal to exist" | ~25 h | Before public launch |
| M4 "Can diagnose prod" | ~15 h | Before real traffic |
| M5 "Can launch to real users" | ~30 h | Public launch |
| M6 "Can charge" (optional) | ~30 h | When paying intent is real |
| M7 "Durable ops" (optional) | ~15 h | Ongoing |

**Realistic total to public free launch (M1-M5):** ~86 hours = ~2 focused weeks (down from 130 hours in the original).
**Add paid tier (M1-M6):** ~116 hours = ~3 weeks (down from 160).
**Add the nice-to-haves (M1-M7):** ~131 hours = ~3.5 weeks (down from 220).

The reduction came from: ~50 hours of gap-fixes + missing endpoints + F4 indexes + seed scripts + runbook + G8 already landed during the April 13-15 sprint.

---

## What's actively misleading in existing docs

- **`DEPLOYMENT-READINESS-REPORT.md` (April 10)** — still says wiki tables are missing from migrations. Mostly stale but the underlying point is correct: local dev doesn't have pgvector, prod Neon does.
- **`DEPLOYMENT-PLAN.md` (April 10)** — estimates 10–18 days to launch. Revised estimate is ~2 weeks to public free launch given everything that shipped since.
- **`2026-04-13-deployment-readiness-todo.md`** (original) — superseded by this file for status. The **External Dependencies** section at the bottom of that file is still accurate and worth keeping as a reference (cost estimates, package names, OAuth flow order, sequencing gotchas). I'm not duplicating it here; consult that section for the "what do we need to buy/install" view.
- **`2026-04-15-test-deploy-runbook.md`** — this is the authoritative deploy procedure, including the appendix on real-run gotchas. Cross-reference from this TODO for anything operational.

---

## What's working well that we don't need to worry about

Unchanged from April 13, with additions:
- Core chat, tasks, wiki, dashboard, manager intelligence, agent loop, real-time, background jobs, multi-tenancy, prompt caching, onboarding, Google Calendar + GitHub
- **New since April 13:** the entire gap-fixes landing (p→div chat, agent employees dropdown, project counts, mention pills, all 15 audit checks), the deployed trusted-tester environment itself, the rich seed data, and 30 commits of shipped work

---

## Related docs

- [2026-04-13-deployment-readiness-todo.md](2026-04-13-deployment-readiness-todo.md) — the original (still canonical for the External Dependencies section)
- [2026-04-15-human-test-gap-fixes.md](2026-04-15-human-test-gap-fixes.md) — the gap-fixes plan we executed April 15
- [2026-04-15-test-deploy-runbook.md](2026-04-15-test-deploy-runbook.md) — authoritative deploy procedure + real-run gotchas
- [docs/superpowers/audits/gap-fixes.audit.ts](../audits/gap-fixes.audit.ts) — 15-check Playwright audit suite (15/15 green on dev, prod-run pending)
- [apps/api/src/scripts/seed-test-org.ts](../../../apps/api/src/scripts/seed-test-org.ts) + [seed-test-org-rich.ts](../../../apps/api/src/scripts/seed-test-org-rich.ts) — non-destructive prod seed
- [ROADMAP.md](../../../ROADMAP.md) — phases 1-6 product features (unchanged)
- [AGENT-UI-BACKLOG.md](AGENT-UI-BACKLOG.md) — 12 deferred items from the April 13 sweep
