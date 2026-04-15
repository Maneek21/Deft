# Deft — Trusted-Tester Deploy Runbook

**Target audience:** ~5 trusted humans with access to a hosted test build.
**Scope:** minimum-viable deployment on managed services. Skips public-launch hardening (GDPR, XSS sanitization, rate limiting beyond Anthropic dashboard caps, formal backups).
**Estimated time:** ~3 hours of active work, mostly waiting on builds.
**Status of security gaps:** A1 (password logging) FIXED this session · A3 (no server logout) FIXED via Task 15 · A2/A4/A5 DEFERRED (acceptable for trusted cohort).

---

## Stack overview

| Component | Service | Why |
|---|---|---|
| Postgres + pgvector | **Neon** (free tier) | pgvector is pre-installed, free tier fits a tester cohort, easy connection string |
| API | **Railway** ($5/mo hobby) | WebSockets supported, easy Node runtime, Postgres job queue is already built in so we don't need Redis |
| Web | **Vercel** (free hobby) | Next.js 16 is native; NEXT_PUBLIC_* vars baked at build time |
| File uploads | **Local filesystem (ephemeral)** — warn testers | R2 support isn't wired yet; files will disappear on Railway redeploy |
| Email | **Resend** (free tier) | Optional; without it the admin UI surfaces temp passwords in the response |
| Redis | **Not used** | Job queue is Postgres-backed; Socket.io runs fine single-instance |
| Error tracking | **Skip** | Railway + Vercel logs are enough for a trusted cohort |

**Guardrail:** the API reads ~30 env vars and the web build reads 6 `NEXT_PUBLIC_*` ones. Miss any required one and the app will either crash on boot or silently serve stale/empty state. The checklist below is the exact subset we need.

---

## 1 — Provision Neon Postgres (10 min)

- [ ] Create a Neon account at <https://neon.tech>
- [ ] Create a project named `deft-test`
- [ ] In the branch settings, confirm the Postgres version is 16.x
- [ ] In the SQL editor, run:
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  ```
- [ ] Copy the **pooled** connection string (ends with `?sslmode=require`). Call this `$NEON_URL`.

> **Why pgvector first:** wiki_pages has an `embedding vector(1536)` column. The dev DB on Windows doesn't have pgvector and we BYTEA'd the column as a workaround (see commit `520eb5a`). On Neon, the column must be a real `vector(1536)` so the wiki routes work end-to-end.

- [ ] From your laptop, push the schema:
  ```bash
  cd "C:/Users/Osheen Pradhan/cairn"
  DATABASE_URL="$NEON_URL" pnpm --filter @deft/db push
  ```
  Expected: `drizzle-kit push` prints "No changes" or applies migrations. If it asks about destructive changes, answer no and inspect.

- [ ] Apply the wiki embedding migration manually (drizzle-kit push may skip it on a fresh DB):
  ```bash
  cd apps/api
  DATABASE_URL="$NEON_URL" node -e "
  const { Pool } = require('pg');
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  (async () => {
    await p.query('CREATE EXTENSION IF NOT EXISTS vector');
    await p.query('ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS embedding vector(1536)');
    await p.query(\"CREATE INDEX IF NOT EXISTS wiki_pages_embedding_ivfflat_idx ON wiki_pages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)\");
    console.log('wiki embedding migration applied');
    await p.end();
  })();"
  ```

- [ ] Verify the schema landed:
  ```bash
  DATABASE_URL="$NEON_URL" node -e "
  const { Pool } = require('pg');
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  p.query(\"select table_name from information_schema.tables where table_schema='public' order by table_name\").then(r => { console.log(r.rows.length, 'tables:', r.rows.map(x=>x.table_name).join(',')); p.end(); });"
  ```
  Expected: 60-ish tables including `users`, `orgs`, `spaces`, `messages`, `tasks`, `wiki_pages`, `revoked_tokens` (added in Task 15).

---

## 2 — Generate secrets (2 min)

Run these locally and save them — you'll paste them into Railway and Vercel.

- [ ] `JWT_SECRET`:
  ```bash
  openssl rand -hex 32
  ```
- [ ] `JWT_REFRESH_SECRET`:
  ```bash
  openssl rand -hex 32
  ```
- [ ] `ENCRYPTION_KEY` (used for integrations token encryption — exactly 32 bytes):
  ```bash
  openssl rand -hex 32
  ```
- [ ] `METRICS_SCRAPE_TOKEN` (protects `/metrics` endpoint — any random string):
  ```bash
  openssl rand -hex 16
  ```

Keep a scratch file locally called `deploy-secrets.txt` (add to `.gitignore` immediately — do NOT commit). You will delete this file once Railway and Vercel both have them.

---

## 3 — Collect third-party API keys (5 min)

- [ ] **Anthropic API key** — <https://console.anthropic.com> → API Keys → Create. Call this `$ANTHROPIC_API_KEY`. **Set a monthly spend cap in the dashboard** (e.g. $50/mo) so a runaway tester can't burn your budget. This is your rate-limit substitute.
- [ ] **Resend API key** (optional but recommended) — <https://resend.com> → API Keys → Create. Without this, the admin UI shows temp passwords in the invite response and you relay them manually.
- [ ] If using Resend, also verify a sending domain and set `FROM_EMAIL` (e.g. `noreply@your-domain.com`). The default `noreply@deft.dev` won't deliver unless you own that domain.

---

## 4 — Deploy API to Railway (30 min)

- [ ] Create a Railway account at <https://railway.com>
- [ ] `New Project` → `Deploy from GitHub repo` → pick this repo's branch `feat/phase2-4-mcp-agents-plans` (or whatever PR branch you're shipping)
- [ ] Railway will auto-detect `pnpm` but may guess wrong. Open service settings and set:
  - **Root directory:** `/` (monorepo root — keep default)
  - **Build command:** `pnpm install --frozen-lockfile`
  - **Start command:** `pnpm --filter @deft/api exec tsx src/index.ts`
    - Note: `apps/api/package.json` has `"build": "tsx src/index.ts"` and `"start": "node dist/index.js"` — both are broken for hosting (no real build, start references a nonexistent dist). The override above runs directly from source. Long-term, wire a real `esbuild` or `tsc` build — out of scope for this runbook.
  - **Watch paths:** `apps/api/**`, `packages/**` (optional — prevents unnecessary redeploys on web-only edits)

- [ ] Add environment variables in Railway service → Variables:

  | Key | Value |
  |---|---|
  | `DATABASE_URL` | `$NEON_URL` (from step 1) |
  | `JWT_SECRET` | from step 2 |
  | `JWT_REFRESH_SECRET` | from step 2 |
  | `ENCRYPTION_KEY` | from step 2 |
  | `METRICS_SCRAPE_TOKEN` | from step 2 |
  | `ANTHROPIC_API_KEY` | from step 3 |
  | `RESEND_API_KEY` | from step 3 (or leave empty) |
  | `FROM_EMAIL` | from step 3 (or leave empty) |
  | `NEXT_PUBLIC_APP_URL` | your Vercel URL (step 5 — set AFTER Vercel is deployed, come back to this) |
  | `API_PORT` | `3001` (Railway sets `PORT` automatically — see note below) |
  | `NODE_ENV` | `production` |

  **Railway PORT gotcha:** Railway sets `$PORT` but our API reads `API_PORT`. Either:
  - Set `API_PORT=$PORT` as a variable reference (preferred — Railway supports `${{ PORT }}` templating)
  - Or edit `apps/api/src/index.ts:140` to read `process.env.PORT ?? process.env.API_PORT ?? 3001` before deploying

  Recommended: add the `PORT` fallback to the code (one-line change). See step 4b below.

- [ ] **Step 4b — API PORT fallback** (one-line code change so Railway's `$PORT` works out of the box):

  Edit `apps/api/src/index.ts` around line 140:
  ```typescript
  const port = parseInt(process.env.PORT || process.env.API_PORT || '3001');
  ```

  Commit + push:
  ```bash
  git add apps/api/src/index.ts
  git commit -m "chore(api): read Railway's PORT env before API_PORT"
  git push
  ```

- [ ] Railway will trigger a build automatically. Watch the deploy logs tab. Expected final lines:
  ```
  Deft API running on http://localhost:PORT
  [workers] Postgres job poller started (3s interval)
  [scheduler] Cron jobs registered
  ```
  If you see `ECONNREFUSED` or `password authentication failed`, the `DATABASE_URL` is wrong. If you see a TypeScript error, the tsx runtime couldn't load the file — check the tsx version and the commit you deployed.

- [ ] Once green, open the Railway service → Settings → Networking → Generate Domain. Railway gives you `your-service.up.railway.app`. Call this `$API_URL`.

- [ ] Health check:
  ```bash
  curl "$API_URL/health"
  ```
  Expected: `200 OK` with a small JSON body.

---

## 5 — Deploy web to Vercel (20 min)

- [ ] Create a Vercel account at <https://vercel.com>
- [ ] `Add New...` → `Project` → import the same GitHub repo and branch
- [ ] Vercel auto-detects Next.js. In project settings:
  - **Root directory:** `apps/web`
  - **Framework preset:** Next.js
  - **Build command:** `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @deft/web build`
  - **Output directory:** `.next` (default)
  - **Install command:** leave blank (the build command above handles it)

  Vercel's Next.js monorepo auto-detect sometimes works — if the custom build command above fails, try letting Vercel default to `next build` and configure `apps/web` as the root.

- [ ] Environment variables (Vercel → Project → Settings → Environment Variables):

  | Key | Value | Notes |
  |---|---|---|
  | `NEXT_PUBLIC_API_URL` | `$API_URL` (from step 4) | Baked at build time — MUST be set before first build |
  | `NEXT_PUBLIC_WS_URL` | `$API_URL` | Same URL as API; Socket.io uses this for the websocket connection |
  | `NEXT_PUBLIC_APP_URL` | Your Vercel URL (circular — leave blank, Vercel will set it at deploy time, or use `https://deft-test-<hash>.vercel.app`) | |
  | `NEXT_PUBLIC_FEATURE_OPENCLAW_EMPLOYEES` | `true` | Enables the agent employees flag from Phase 12 |
  | `NEXT_PUBLIC_DEFT_SELF_HOSTED` | `false` | Enables SaaS-only UI affordances |

  **Critical:** `NEXT_PUBLIC_*` vars are compile-time. Changing any of them requires a full rebuild via `Deployments → Redeploy`.

- [ ] Deploy. Watch the build logs. Expected: `Route (app)` table, `Compiled successfully`, deploy URL at the bottom. First build takes 4-6 minutes.

- [ ] Once deployed, Vercel gives you `https://deft-test-<hash>.vercel.app`. Call this `$WEB_URL`.

- [ ] Go back to Railway → `NEXT_PUBLIC_APP_URL` and set it to `$WEB_URL`. This fixes the CORS origin for the API. Railway will redeploy (~2 min).

- [ ] Confirm the wire-up:
  ```bash
  curl -I "$WEB_URL/login"                          # expect 200
  curl -X POST "$API_URL/api/auth/login" \          # expect 400 (empty body) or 401
    -H "Content-Type: application/json" \
    -d '{"email":"nope@test","password":"wrong"}'
  ```

---

## 6 — Bootstrap the first admin (10 min)

The dev `packages/db/seed.ts` is destructive — it wipes the DB and repopulates seed fixtures. Don't run it against Neon. Instead, use the normal signup flow:

- [ ] Open `$WEB_URL/signup` in your browser
- [ ] Create the first account: name, email, password, workspace name (this user becomes the org owner)
- [ ] Verify you land on `/chat` or `/dashboard` and the sidebar shows an empty workspace with a default `#general` space
- [ ] Test a few paths:
  - Send a message in `#general`
  - Create a project + task from the Tasks page
  - Open the Knowledge page (wiki should load; detail view should not 500 — this is the pgvector fix from step 1)
  - Open Agent → ask "What tasks do I have?" (confirms Anthropic is wired)
  - Settings → Integrations → confirm MCP Connections list loads (no integrations seeded remotely, will be empty — that's fine)

- [ ] If anything fails, check both Railway and Vercel deploy logs. Most first-deploy issues are: wrong env var name, stale build, or CORS (Railway `NEXT_PUBLIC_APP_URL` doesn't match `$WEB_URL` exactly).

---

## 7 — Invite testers (5 min each)

For each tester:

- [ ] Sign in as the admin
- [ ] Settings → Members → Invite → enter their email, role `member`
- [ ] Click Send. The response now includes `temp_password` in the JSON body (per the Task 1 fix). Either:
  - **Resend configured:** they receive the email automatically
  - **No Resend:** the admin UI displays the temp password once — copy it and relay through Slack, Signal, or whatever out-of-band channel you're using
- [ ] Tester opens `$WEB_URL/login`, signs in with email + temp password, changes password on first login
- [ ] Confirm they land in the same org (should see existing spaces, tasks)

---

## 8 — Write the tester invite email

Send one message per tester. Template:

```
Subject: You're in — Deft test build

Hey,

You have access to a private test build of Deft, a chat + tasks workspace
with an AI agent that has direct SQL access to your data.

URL: https://deft-test-<hash>.vercel.app
Email: <their email>
Temporary password: <the temp password from the invite response>

Known limitations for this build:
- Uploaded files (images, PDFs) disappear when we redeploy — don't upload
  anything you'd cry about losing
- No data backups yet — everything you create is on a free-tier Neon instance
- No rate limiting — agent queries hit Anthropic directly; don't run it in
  a loop
- A few pasteable HTML surfaces haven't been sanitized yet (XSS) — since
  this is a trusted cohort, just don't paste weird HTML you don't trust
- Agent can and will create test data as part of how it works — if you
  see tasks/notes you didn't make, that's probably the agent

If you find something broken: DM <your contact>.

- <your name>
```

> **Why spell out the limitations:** testers file high-signal bugs when they know the edges ahead of time. They file noise when they don't.

---

## 9 — Post-launch watch (rest of day 1)

- [ ] Keep Railway deploy logs tab open for the first hour. Watch for crashes, auth failures, or Anthropic rate-limit errors.
- [ ] Check Neon → Monitoring → query count trend. If it spikes 10x after an invite, you probably have a polling loop or a runaway worker — investigate.
- [ ] Check Anthropic Usage dashboard daily for the first week. Set a budget alert at 50% of your monthly cap.
- [ ] Delete `deploy-secrets.txt` from your laptop once you've confirmed everything is working.

---

## What's deferred (and when to revisit)

| Item | Defer until | Effort |
|---|---|---|
| DOMPurify for `dangerouslySetInnerHTML` (gap A2) | Before any **untrusted** tester | 2-3 hours |
| Rate limiting middleware (gap A4) | Before 20+ testers OR public link | 4 hours |
| Security headers CSP/HSTS (gap A5) | Before public link | 1 hour |
| GDPR export + deletion (gap B1) | Before first EU tester OR launch | 1 day |
| Privacy Policy / ToS (gap B2) | Before public link | Legal review |
| Sentry error tracking | When tester reports get hard to debug | 30 min |
| R2 file uploads | When testers complain about file loss | 2-3 hours |
| Redis for Socket.io multi-instance | When Railway instance count > 1 | 1 hour |
| Database backups | When test data stops being throwaway | 30 min (Neon has point-in-time restore on paid tier) |
| Real API `tsc` build | When cold starts feel slow | 2 hours |

---

## Appendix — Env var reference

**Railway API required:**
```
DATABASE_URL
JWT_SECRET
JWT_REFRESH_SECRET
ENCRYPTION_KEY
ANTHROPIC_API_KEY
NEXT_PUBLIC_APP_URL  ← for CORS; must match Vercel URL
API_PORT  ← $PORT reference
NODE_ENV=production
```

**Railway API recommended:**
```
RESEND_API_KEY
FROM_EMAIL
METRICS_SCRAPE_TOKEN
```

**Vercel web required (all compile-time):**
```
NEXT_PUBLIC_API_URL          ← Railway API URL
NEXT_PUBLIC_WS_URL           ← Same as API URL
NEXT_PUBLIC_APP_URL          ← The Vercel URL itself
NEXT_PUBLIC_FEATURE_OPENCLAW_EMPLOYEES=true
NEXT_PUBLIC_DEFT_SELF_HOSTED=false
```

**Not needed for test deploy (leave unset):**
```
REDIS_URL              — Postgres job queue is used instead
GITHUB_CLIENT_ID       — integrations optional
GITHUB_CLIENT_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
RAILWAY_OAUTH_*        — only needed if you're using the Railway managed-employee wizard
OPENAI_API_KEY
OPENROUTER_API_KEY
OLLAMA_URL
DEEPGRAM_API_KEY
TAVILY_MCP_URL
WHISPER_URL
TRANSCRIPTION_PROVIDER
R2_*                   — uploads default to local fs (ephemeral)
```

---

## Appendix — What fixed means for each critical gap

- **A1 — Password logging (fixed in commit `44b349e` this session):** The invite endpoint no longer calls `console.log` with the temp password. Instead, the response body carries a `temp_password` field when Resend isn't configured (or the send fails). The client UI is expected to display it once.
- **A3 — No logout revocation (fixed in Task 15 commit `23c1f50`):** `POST /api/auth/logout` writes a sha256 hash of the refresh token to `revoked_tokens`. The `/api/auth/refresh` handler checks this table before issuing a new access token. Stolen tokens die on logout.
- **Wiki embedding (fixed in Task 1 commit `520eb5a`):** The column exists in the Drizzle schema (`vector(1536)`), but was missing from the dev Postgres. On a dev machine without pgvector, we BYTEA'd it as a workaround. **On Neon, step 1 of this runbook re-installs pgvector and restores the real `vector(1536)` type so wiki search and embeddings will work properly.**

---

**When everything is green and testers are in, you're done.** Come back to this doc before touching the deferred items.
