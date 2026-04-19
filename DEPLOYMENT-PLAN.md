# Deft — SaaS Deployment Plan

Taking Deft from local development to a live multi-tenant SaaS platform.

---

## Current State

- Monorepo: Next.js frontend (port 3000) + Hono API (port 3001)
- Docker: multi-stage Dockerfile + docker-compose with Postgres 16 + Redis 7
- CI: GitHub Actions — typecheck + build on push/PR to main
- License: BSL 1.1 (cannot be offered as hosted service by third parties)
- Auth: Custom JWT (access + refresh tokens)
- File storage: Local filesystem (`./uploads`)
- Email: Resend (optional, falls back to console.log)
- No git repo initialized yet, no remote

---

## Phase 0: Pre-Launch Essentials (Day 1-2)

### 0.1 — Initialize Git & Push to GitHub
```
git init
git add -A
git commit -m "Initial commit"
gh repo create deft --private --source=. --push
```
- Set up branch protection on `main` (require PR, require CI pass)
- CI already configured (`.github/workflows/ci.yml`)

### 0.2 — Domain & DNS
- Register domain: `deft.dev`, `getdeft.com`, `usedeft.com`, or similar
- Set up DNS with Cloudflare (free tier — CDN + DDoS protection + SSL)
- Plan subdomains:
  - `app.deft.dev` — the web app
  - `api.deft.dev` — the API server
  - `deft.dev` — landing page / marketing site

### 0.3 — Environment Secrets Audit
Review `.env.example` and ensure all production values are ready:

| Variable | Status | Action Needed |
|----------|--------|---------------|
| `DATABASE_URL` | Needs prod value | Get from managed Postgres |
| `REDIS_URL` | Needs prod value | Get from managed Redis |
| `JWT_SECRET` | Needs prod value | Generate: `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | Needs prod value | Generate: `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | Needs prod value | Generate: 32-char random string |
| `ANTHROPIC_API_KEY` | Optional | Add if AI features enabled |
| `RESEND_API_KEY` | Required for email | Sign up at resend.com |
| `FROM_EMAIL` | Required | Set to `noreply@deft.dev` (verify domain in Resend) |
| `GOOGLE_CLIENT_ID` | Optional | Google Cloud Console OAuth credentials |
| `GOOGLE_CLIENT_SECRET` | Optional | Same |
| `GITHUB_CLIENT_ID` | Optional | GitHub OAuth App |
| `GITHUB_CLIENT_SECRET` | Optional | Same |
| `NEXT_PUBLIC_APP_URL` | Required | `https://app.deft.dev` |
| `NEXT_PUBLIC_API_URL` | Required | `https://api.deft.dev` |
| `NEXT_PUBLIC_WS_URL` | Required | `wss://api.deft.dev` |

---

## Phase 1: Infrastructure Setup (Day 2-4)

### 1.1 — Hosting Platform

**Recommended: Railway** (best fit for Deft's architecture)

Why Railway:
- Native Docker support (use existing Dockerfile)
- WebSocket support (required for Socket.IO)
- Built-in Postgres + Redis as managed services
- Auto-deploys from GitHub
- $5/month hobby plan, usage-based pro plan ($20/month base)
- No cold starts, persistent processes (needed for background workers)
- Environment variables managed in dashboard

**Alternative: Fly.io**
- Docker-native, globally distributed
- WebSocket support
- Managed Postgres (Supabase partnership) + Upstash Redis
- More manual setup but more control
- $0 free tier for small apps

**NOT recommended:**
- Vercel — no WebSocket support for API, no persistent processes for workers
- Supabase — blocked in India (per CLAUDE.md)
- Heroku — expensive, slow deploys

### 1.2 — Database: Managed PostgreSQL

**Option A: Railway Postgres** (simplest)
- Included in Railway deployment
- Automatic backups
- Adequate for launch

**Option B: Neon** (serverless Postgres)
- Free tier: 0.5 GB storage, 190 compute hours/month
- Auto-scaling, branching for dev/staging
- pgvector support (needed for future embeddings)

**Option C: Supabase Postgres** (if not in India)
- Free tier: 500 MB, 2 projects
- Built-in pgvector

**Required setup regardless of provider:**
- Enable `pgvector` extension: `CREATE EXTENSION IF NOT EXISTS vector;`
- Run migrations: `pnpm db:push`
- Set up automated daily backups
- Connection pooling (PgBouncer) for production load

### 1.3 — Redis: Managed Instance

**Option A: Railway Redis** (simplest — included)
**Option B: Upstash Redis** (serverless, free tier: 10K commands/day)
**Option C: Redis Cloud** (free tier: 30 MB)

Redis is used for Socket.IO adapter and BullMQ. Pick whichever is included with your hosting.

### 1.4 — File Storage: Cloudflare R2

Move from local filesystem to Cloudflare R2:
- Free tier: 10 GB storage, 10M reads/month, 1M writes/month
- S3-compatible API (drop-in replacement)
- No egress fees
- Set env vars: `R2_ENDPOINT`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_BUCKET`

The upload route (`apps/api/src/routes/upload.ts`) already checks for R2 config and falls back to local storage. Just add the env vars.

### 1.5 — Email: Resend

- Sign up at [resend.com](https://resend.com)
- Free tier: 3,000 emails/month, 100/day
- Verify your domain (add DNS records)
- Set `RESEND_API_KEY` and `FROM_EMAIL` in env
- Used for: password reset emails, member invitations, weekly digests

---

## Phase 2: Deployment Configuration (Day 4-5)

### 2.1 — Split Services (Recommended)

Run web and API as separate services for independent scaling:

**Service 1: Web (Next.js)**
```dockerfile
# Dockerfile.web
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/public ./apps/web/public
# ... (same deps as current Dockerfile)
CMD ["npx", "next", "start", "-p", "3000"]
```

**Service 2: API (Hono + Workers)**
```dockerfile
# Dockerfile.api
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/apps/api ./apps/api
COPY --from=builder /app/packages ./packages
# ...
CMD ["node", "--import", "tsx", "apps/api/src/index.ts"]
```

Or keep the single Dockerfile and use Railway's service splitting.

### 2.2 — Environment Configuration

Set all production env vars in Railway/Fly.io dashboard. Never commit `.env` to git.

Key differences from development:
```
NODE_ENV=production
NEXT_PUBLIC_APP_URL=https://app.deft.dev
NEXT_PUBLIC_API_URL=https://api.deft.dev
NEXT_PUBLIC_WS_URL=wss://api.deft.dev
```

### 2.3 — SSL / HTTPS

- Railway/Fly.io provide automatic SSL via Let's Encrypt
- Add custom domain in hosting dashboard
- Update CORS in API to allow only `https://app.deft.dev`
- Update Google OAuth redirect URI to production URL
- Update GitHub OAuth callback URL

### 2.4 — CORS Configuration

Update `apps/api/src/index.ts` CORS for production:
```typescript
app.use('*', cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://app.deft.dev']
    : ['http://localhost:3000'],
  credentials: true,
}));
```

### 2.5 — WebSocket Configuration

Socket.IO needs to work through the reverse proxy:
- Railway: WebSockets work out of the box
- Fly.io: Need `fly.toml` with `auto_stop_machines = false` (WebSockets need persistent connections)
- Cloudflare: If proxying, enable WebSocket support in dashboard

---

## Phase 3: CI/CD Pipeline (Day 5-6)

### 3.1 — Extend GitHub Actions

Add deployment step to existing CI:

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    needs: [typecheck, build]  # from existing ci.yml
    steps:
      - uses: actions/checkout@v4
      # Railway auto-deploys from GitHub — no action needed
      # OR for Fly.io:
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

### 3.2 — Staging Environment

Create a staging environment that mirrors production:
- Separate Railway project or Fly.io app
- Separate database (seeded with test data)
- Deploy `develop` branch to staging, `main` to production
- Same env vars but with staging URLs

### 3.3 — Database Migrations in CI

Add migration step before deployment:
```yaml
- name: Run migrations
  run: pnpm db:push
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

---

## Phase 4: Security Hardening (Day 6-7)

### 4.1 — Rate Limiting

Add rate limiting middleware to the API:
```typescript
// apps/api/src/middleware/rate-limit.ts
// Use hono-rate-limiter or custom implementation with Redis
// Limits:
//   - Auth endpoints: 10 req/min per IP
//   - API endpoints: 100 req/min per user
//   - Upload: 20 req/min per user
//   - Agent: 30 req/min per user
```

### 4.2 — Input Sanitization

- All user text is already stored as-is (per CLAUDE.md)
- Ensure HTML rendering in frontend uses DOMPurify or equivalent
- TipTap editor sanitizes on output
- Verify no raw `dangerouslySetInnerHTML` without sanitization

### 4.3 — Security Headers

Add security headers middleware:
```typescript
// Strict-Transport-Security
// Content-Security-Policy
// X-Content-Type-Options: nosniff
// X-Frame-Options: DENY
// Referrer-Policy: strict-origin-when-cross-origin
```

### 4.4 — Secrets Rotation Plan
- JWT secrets: rotate quarterly
- Encryption key: rotate with data re-encryption
- API keys (Anthropic, Resend): rotate if compromised
- OAuth secrets: rotate annually

### 4.5 — Audit Logging
- Audit log table already exists (`audit_log` in schema)
- Ensure all auth events logged (login, failed login, password change, role change)
- Ensure all destructive actions logged (delete space, remove member, etc.)

### 4.6 — Data Protection
- Passwords hashed with bcrypt (12 rounds) — already done
- Connected account tokens encrypted — already done
- Never log tokens, passwords, or PII to console
- Soft deletes everywhere — already done

---

## Phase 5: Monitoring & Observability (Day 7-8)

### 5.1 — Error Tracking: Sentry

- Free tier: 5K errors/month
- Add `@sentry/node` to API, `@sentry/nextjs` to web
- Capture unhandled exceptions, API 5xx errors, failed background jobs
- Set up alerts for error spikes

### 5.2 — Uptime Monitoring: BetterUptime or UptimeRobot

- Free tier: 50 monitors, 5-minute checks
- Monitor:
  - `https://app.deft.dev` (web app loads)
  - `https://api.deft.dev/health` (API health endpoint)
  - WebSocket connectivity

### 5.3 — API Health Endpoint

Add to `apps/api/src/index.ts`:
```typescript
app.get('/health', async (c) => {
  const dbOk = await db.execute(sql`SELECT 1`).then(() => true).catch(() => false);
  return c.json({
    status: dbOk ? 'healthy' : 'degraded',
    version: process.env.npm_package_version || '0.0.1',
    uptime: process.uptime(),
  }, dbOk ? 200 : 503);
});
```

### 5.4 — Logging

- Use structured JSON logging in production (replace `console.log`)
- Railway/Fly.io capture stdout/stderr automatically
- Consider Axiom (free tier: 500 MB/month) or Logtail for log aggregation
- Log levels: error, warn, info (no debug in production)

### 5.5 — Performance Monitoring

- Track API response times per endpoint
- Track database query durations
- Track background job execution times and failure rates
- Alert if p95 latency exceeds 2 seconds

---

## Phase 6: Pre-Launch Checklist (Day 8-9)

### 6.1 — Legal

- [ ] Privacy Policy page (required for Google OAuth, GDPR)
- [ ] Terms of Service page
- [ ] Cookie consent banner (if using analytics)
- [ ] BSL 1.1 license displayed in footer/about page
- [ ] Data Processing Agreement (DPA) template ready for enterprise customers
- [ ] GDPR compliance: user data export + deletion endpoints

### 6.2 — Transactional Emails

Verify all email templates work:
- [ ] Password reset email
- [ ] Member invitation email
- [ ] Welcome email (optional)
- [ ] Weekly digest email (background worker)

### 6.3 — OAuth Redirect URIs

Update all OAuth providers with production URLs:
- [ ] Google OAuth: `https://api.deft.dev/api/auth/google/callback`
- [ ] GitHub OAuth: `https://api.deft.dev/api/connections/github/callback`
- [ ] Google Calendar: `https://api.deft.dev/api/connections/google_calendar/callback`

### 6.4 — Seed Data

Create a demo org with:
- Sample spaces (#general, #engineering, #design)
- Sample project with tasks in various states
- Sample wiki pages showing the knowledge system
- This helps new users understand the product immediately

### 6.5 — Onboarding Flow

Verify the `/setup` wizard works end-to-end:
- [ ] Step 1-5 complete without errors
- [ ] Skip buttons work
- [ ] Default spaces and project created
- [ ] User lands on a functional workspace after setup

---

## Phase 7: Landing Page (Day 9-11)

### 7.1 — Marketing Site

Build a simple landing page at `deft.dev`:
- Hero: "The AI-native workspace" — tagline + screenshot + CTA
- Features section: Chat, Tasks, Agent, Knowledge Wiki
- How it works: 3-step visual
- Pricing (if applicable)
- CTA: "Start free" → `/signup`

**Options:**
- Add a `/` route in the Next.js app (simplest)
- Separate static site on Cloudflare Pages (better for SEO)
- Use a template: Astro, Next.js static, or plain HTML

### 7.2 — Analytics

- Plausible (privacy-friendly, $9/month) or PostHog (free tier: 1M events/month)
- Track: signups, activation (first message sent), retention (DAU/WAU)
- No Google Analytics (privacy concerns for a workspace tool)

---

## Phase 8: Launch (Day 11-12)

### 8.1 — Soft Launch

1. Deploy to production
2. Run database migrations
3. Run wiki migration script (if existing data)
4. Smoke test every feature (use HUMAN-TEST-GUIDE.md)
5. Invite 5-10 trusted users / team members
6. Monitor error rates, latency, and logs for 48 hours

### 8.2 — Public Launch

1. Open signups
2. Post on:
   - Product Hunt
   - Hacker News (Show HN)
   - Twitter/X
   - Reddit (r/SaaS, r/startups, r/selfhosted)
   - Indie Hackers
3. Monitor server load and scale if needed

### 8.3 — Post-Launch Monitoring (Week 1)

- Check error rates daily
- Monitor database size and query performance
- Watch for abuse (spam signups, API abuse)
- Collect user feedback (in-app feedback form or email)
- Fix critical bugs immediately, batch non-critical for next sprint

---

## Infrastructure Cost Estimate (Monthly)

| Service | Provider | Cost |
|---------|----------|------|
| Hosting (web + API) | Railway Pro | $20 + usage (~$10-30) |
| PostgreSQL | Railway (included) or Neon free | $0-20 |
| Redis | Railway (included) or Upstash free | $0 |
| File Storage | Cloudflare R2 free tier | $0 |
| Email | Resend free tier (3K/month) | $0 |
| Domain | Cloudflare Registrar | $10/year |
| SSL | Auto (Let's Encrypt) | $0 |
| Error Tracking | Sentry free tier | $0 |
| Uptime Monitoring | BetterUptime free | $0 |
| AI (Anthropic) | Pay-per-use | $5-50 (depends on usage) |
| **Total** | | **~$30-80/month** |

---

## Scaling Checklist (When Needed)

When you outgrow the initial setup:

- [ ] **Database:** Add read replicas, connection pooling (PgBouncer), move to dedicated instance
- [ ] **API:** Horizontal scaling (multiple instances behind load balancer), sticky sessions for WebSocket
- [ ] **Workers:** Separate worker process from API (dedicated container for background jobs)
- [ ] **Redis:** Upgrade to dedicated instance with persistence
- [ ] **CDN:** Cloudflare for static assets, Next.js ISR for marketing pages
- [ ] **File Storage:** R2 with CDN (Cloudflare R2 auto-caches)
- [ ] **Search:** Add pgvector for semantic search, consider Elasticsearch for full-text at scale
- [ ] **Auth:** Migrate to WorkOS when enterprise SSO is needed (see analysis)

---

## Architecture Diagram (Production)

```
                    ┌──────────────┐
                    │  Cloudflare  │
                    │   (DNS/CDN)  │
                    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
              │                         │
     ┌────────▼────────┐    ┌──────────▼──────────┐
     │  app.deft.dev   │    │   api.deft.dev      │
     │  (Next.js)      │    │   (Hono + Socket.IO)│
     │  Railway Svc 1  │    │   Railway Svc 2     │
     └─────────────────┘    └──────────┬──────────┘
                                       │
                        ┌──────────────┼──────────────┐
                        │              │              │
                ┌───────▼──────┐ ┌────▼─────┐ ┌─────▼──────┐
                │  PostgreSQL  │ │  Redis   │ │ Cloudflare │
                │  (managed)   │ │(managed) │ │    R2      │
                └──────────────┘ └──────────┘ └────────────┘
```

---

## Timeline Summary

| Phase | What | Days |
|-------|------|------|
| 0 | Git + domain + secrets audit | 1-2 |
| 1 | Infrastructure (hosting, DB, Redis, R2, email) | 2-3 |
| 2 | Deployment config (Docker, env, SSL, CORS) | 1-2 |
| 3 | CI/CD pipeline + staging | 1-2 |
| 4 | Security hardening | 1-2 |
| 5 | Monitoring & observability | 1-2 |
| 6 | Pre-launch checklist (legal, emails, OAuth, seed data) | 1-2 |
| 7 | Landing page + analytics | 2-3 |
| 8 | Soft launch → public launch | 1-2 |
| **Total** | | **~10-18 days** |
