# Private Alpha Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven hard blockers that prevent inviting trusted testers to a self-hosted Deft instance — fresh-install schema integrity, login security, abuse protection, browser hardening, template correctness, and dead-table cleanup.

**Architecture:** Each blocker is a localized change — one migration, one middleware mount, one route guard, one schema delete, one README edit. Nothing here is cross-cutting; tasks run independently and can be parallelized after Task 1.

**Tech Stack:** Hono middleware (`hono-rate-limiter`, `hono/secure-headers`), Drizzle ORM (manual migration + journal patch), bcrypt + JWT (existing auth path), Tailwind/Next.js (no new frontend deps).

---

## Out of Scope

The following are tracked in the audit but explicitly **not** in this plan — they're P1+ for public launch, not private alpha:

- Privacy Policy / Terms of Service pages
- GDPR export + account deletion endpoints
- Custom domain + Cloudflare proxy
- Sentry / pino / proper /health
- Stripe billing, AI credits tracking
- Error boundaries / error.tsx
- Public landing page at `/`
- `agentMemory` table cleanup (conversation-scope rows are still live consumers; needs deeper audit before drop)

---

## Pre-flight (User Action — Do First, ~5 min)

**The user must do this themselves. Cannot be delegated to an implementer subagent.**

### Task 0: Rotate Exposed Deploy Tokens

Three tokens were pasted into chat history on 2026-04-12 (per `docs/superpowers/plans/2026-04-15-deployment-readiness-todo.md:366-375`). Anyone with access to that transcript can use them right now.

- [ ] **Step 1: Revoke Neon API key**
  Open https://console.neon.tech/app/settings/api-keys → revoke the key → create a new one → update `.env` and any deploy targets.

- [ ] **Step 2: Revoke Railway account token**
  Open https://railway.app/account/tokens → revoke → regenerate → update deploy targets.

- [ ] **Step 3: Revoke Vercel token**
  Open https://vercel.com/account/tokens → revoke → regenerate → update deploy targets.

- [ ] **Step 4: Confirm to implementer**
  Reply "tokens rotated" before any subagent runs further tasks. There's no automated verification — this is on the human.

---

## File Map (Tasks 1–7)

| Task | Files |
|---|---|
| 1. Drizzle journal | `packages/db/drizzle/meta/_journal.json` (modify) |
| 2. Email verification gate | `apps/api/src/routes/auth.ts:124-156` (modify), `apps/api/test/auth-login.test.ts` (create) |
| 3. Rate limiting | `apps/api/src/middleware/rate-limit.ts` (create), `apps/api/src/index.ts` (modify), `apps/api/package.json` (modify) |
| 4. Security headers | `apps/api/src/index.ts:56-64` (modify), `apps/web/next.config.js` or `apps/web/next.config.ts` (modify) |
| 5. Shell-exec template fix | `apps/api/src/scripts/seed-templates.ts:260-340` (modify) |
| 6. Drop deprecated tables | `packages/db/drizzle/0063_drop_deprecated_tables.sql` (create), `packages/db/src/schema.ts:727-893` (modify) |
| 7. README journal caveat | `README.md:41-48` (modify) |

---

## Task 1: Regenerate Drizzle Migration Journal

**Why:** `packages/db/drizzle/meta/_journal.json` stops at `0017_seed_templates` (idx 16). Files `0018_gateway_ping.sql` through `0062_ics_calendar_sync.sql` (46 migrations) exist on disk but aren't in the journal. `pnpm db:push` works against the schema diff so fresh installs are OK, but `pnpm db:migrate` quietly applies nothing past 0017. We're rebuilding the journal so contributors using `db:generate` for new migrations don't introduce drift.

**Files:**
- Modify: `packages/db/drizzle/meta/_journal.json` (idx 17 onward — append 46 entries)
- Test: manual verification via `pnpm db:studio` against a fresh DB

- [ ] **Step 1: List migrations alphabetically and confirm sequence**

Run from repo root:

```powershell
Get-ChildItem -Path "packages\db\drizzle" -Filter "*.sql" | Sort-Object Name | Select-Object Name
```

Expected: 64 files, `0000_giant_klaw.sql` through `0062_ics_calendar_sync.sql`. Note that `0002` and `0020` each have two files (`0002_subtasks_parent_task_id.sql` + `0002_wakeful_nightshade.sql`; `0020_expand_role_enum.sql` + `0020_wiki_search_vector.sql`). Drizzle's journal does not include the orphan `0002_subtasks_parent_task_id.sql` — Drizzle picks the first one alphabetically per idx. The journal currently has `0002_wakeful_nightshade`, so keep that as idx 2 and skip the orphan.

- [ ] **Step 2: Patch the journal**

Open `packages/db/drizzle/meta/_journal.json`. The existing array has 17 entries (idx 0–16). Append entries 17 through 62 in order. Each entry follows this shape:

```json
{
  "idx": 17,
  "version": "7",
  "when": 1776600011000,
  "tag": "0018_gateway_ping",
  "breakpoints": true
}
```

`when` is a Unix millisecond timestamp. Existing entries 5–16 use monotonically increasing fake timestamps (1776600000000 + idx * 1000). Continue the pattern: idx 17 = 1776600011000, idx 18 = 1776600012000, …, idx 62 = 1776600056000.

The 46 new tags, in order:

```
0018_gateway_ping
0019_action_receipts_signed_at_tz
0020_expand_role_enum
0021_wiki_pages_tags_users
0022_notes_visibility
0023_knowledge_dependency_relationship
0024_message_classifications
0025_task_relationship_type_enum
0026_notification_type_enum
0027_task_labels_pk
0028_task_child_tables_org_id
0029_tasks_parent_fk
0030_duplicate_flags
0031_cross_references_unique
0032_task_activity_agent_ref
0033_tasks_embedding
0034_agent_plans_fail_fast
0035_skills_extend
0036_skill_junctions
0037_migrate_caps_to_skills
0038_drop_native_tools
0039_notification_type_skill_update
0040_tasks_metadata
0041_projects_soft_delete
0042_task_reactions
0043_agent_heartbeat_overrides
0044_agent_heartbeat_turns
0045_task_templates_table
0046_drop_project_skills
0047_clawhub_allowlist
0048_org_spend_caps
0049_skill_secrets
0050_decision_implemented
0051_org_scoped_templates
0052_agent_webhooks
0053_drop_orphaned_tables
0054_agent_cooperative_log
0055_add_superintendent_role
0056_drop_orphaned_deploy_columns
0057_user_delete_cascades
0058_agent_employees_soft_delete
0059_remove_openclaw_columns
0060_webhook_hmac_key
0061_org_ai_config
0062_ics_calendar_sync
```

Note: `0020_wiki_search_vector` is the orphan and is NOT in the journal — keep `0020_expand_role_enum` as the canonical idx 19.

- [ ] **Step 3: Verify the journal parses**

```powershell
node -e "const j = require('./packages/db/drizzle/meta/_journal.json'); console.log('entries:', j.entries.length); console.log('last:', j.entries[j.entries.length-1].tag);"
```

Expected output:
```
entries: 63
last: 0062_ics_calendar_sync
```

- [ ] **Step 4: Verify against a fresh local DB**

```powershell
$env:DATABASE_URL="postgres://postgres:postgres@localhost:5432/deft_journal_test"
psql -U postgres -c "CREATE DATABASE deft_journal_test;"
psql -U postgres -d deft_journal_test -c "CREATE EXTENSION IF NOT EXISTS vector;"
pnpm --filter @deft/db migrate
```

Expected: drizzle-kit applies all 63 migrations cleanly, no "migration already applied" warnings, no schema errors. Drop the test DB after: `psql -U postgres -c "DROP DATABASE deft_journal_test;"`.

If pgvector isn't installed locally, skip this step — `pnpm db:push` against an existing DB still works for fresh installs. Note the limitation in the commit message.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/meta/_journal.json
git commit -m "fix(db): rebuild drizzle migration journal through 0062"
```

---

## Task 2: Email Verification Gate on Login

**Why:** The `users.email_verified_at` column exists. Signup sets it. Login never checks it (`apps/api/src/routes/auth.ts:124-156`). Anyone who guesses an email + password combination signs in without owning the inbox. For private alpha with trusted testers, this is acceptable today — but it's a 1-hour fix that closes a credential-stuffing path before we widen the invite cohort.

**Files:**
- Modify: `apps/api/src/routes/auth.ts:124-156`
- Test: `apps/api/test/auth-email-verification.test.ts` (create)

- [ ] **Step 1: Check whether `email_verified_at` exists on the users table**

```powershell
psql -U postgres -d deft -c "\d users" | Select-String "email_verified"
```

Expected: a row showing `email_verified_at | timestamp with time zone`. If absent, add column via a new migration before continuing — but per CLAUDE.md it should already exist post-Phase-7. Verify before proceeding.

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/auth-email-verification.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/index.js';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers } from '@deft/db/schema';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';

test('login blocks users whose email is not verified', async () => {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    email: `test-unverified-${id}@example.com`,
    password_hash: await bcrypt.hash('correct-password', 10),
    name: 'Test User',
    email_verified_at: null,
  });

  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `test-unverified-${id}@example.com`,
      password: 'correct-password',
    }),
  });

  assert.equal(res.status, 403);
  const body = await res.json() as { code: string };
  assert.equal(body.code, 'EMAIL_NOT_VERIFIED');

  await db.delete(users).where(eq(users.id, id));
});

test('login succeeds for verified users', async () => {
  const id = crypto.randomUUID();
  const email = `test-verified-${id}@example.com`;
  await db.insert(users).values({
    id,
    email,
    password_hash: await bcrypt.hash('correct-password', 10),
    name: 'Test User',
    email_verified_at: new Date(),
  });
  const [org] = await db.insert(orgs).values({
    name: 'Test Org',
    slug: `test-org-${id.slice(0, 8)}`,
  }).returning();
  await db.insert(orgMembers).values({
    org_id: org!.id,
    user_id: id,
    role: 'owner',
  });

  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct-password' }),
  });

  assert.equal(res.status, 200);
  const body = await res.json() as { accessToken: string };
  assert.ok(body.accessToken);

  await db.delete(orgMembers).where(eq(orgMembers.user_id, id));
  await db.delete(orgs).where(eq(orgs.id, org!.id));
  await db.delete(users).where(eq(users.id, id));
});
```

- [ ] **Step 3: Run the test and watch it fail**

```powershell
pnpm --filter @deft/api test -- --test-name-pattern="login blocks users"
```

Expected: FAIL — first test gets status 200 instead of 403 because the guard doesn't exist yet.

- [ ] **Step 4: Add the guard**

Modify `apps/api/src/routes/auth.ts`. After line 141 (the bcrypt check) and before the org lookup at line 143, insert:

```typescript
  if (!user.email_verified_at) {
    return c.json({
      error: 'Please verify your email before signing in. Check your inbox or ask an admin for a verification link.',
      code: 'EMAIL_NOT_VERIFIED',
    }, 403);
  }
```

The full modified block (lines 138–149 after edit):

```typescript
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return c.json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' }, 401);
  }

  if (!user.email_verified_at) {
    return c.json({
      error: 'Please verify your email before signing in. Check your inbox or ask an admin for a verification link.',
      code: 'EMAIL_NOT_VERIFIED',
    }, 403);
  }

  // Get user's org
  const [membership] = await db.select().from(orgMembers).where(eq(orgMembers.user_id, user.id)).limit(1);
```

- [ ] **Step 5: Run tests, expect them to pass**

```powershell
pnpm --filter @deft/api test -- --test-name-pattern="email"
```

Expected: both tests PASS.

- [ ] **Step 6: Verify the signup → first-login flow still works**

Signup sets `email_verified_at: new Date()` on the first user (the org owner) because self-hosted Deft has no outbound email. Confirm in `auth.ts` signup handler that the insert into `users` includes `email_verified_at: new Date()`. If it doesn't, add it — first signup must be allowed to log in immediately. Search:

```powershell
Select-String -Path "apps\api\src\routes\auth.ts" -Pattern "email_verified_at"
```

If signup doesn't set it, add `email_verified_at: new Date(),` to the `db.insert(users).values({...})` call in the signup handler (around line 50–80 of auth.ts).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/test/auth-email-verification.test.ts
git commit -m "feat(auth): block login for unverified emails"
```

---

## Task 3: Rate Limiting Middleware

**Why:** No rate limiter exists. Login, signup, password reset, agent endpoints, and uploads are all uncapped — credential stuffing and AI-cost-burn are open vectors. `hono-rate-limiter` is the canonical Hono adapter; it stores counts in-memory (acceptable for single-instance self-host) with optional Redis backend for multi-instance.

**Files:**
- Modify: `apps/api/package.json` (add dep)
- Create: `apps/api/src/middleware/rate-limit.ts`
- Modify: `apps/api/src/index.ts:67-75` (apply to auth + MCP), `apps/api/src/index.ts:97-99` (apply default)

- [ ] **Step 1: Install hono-rate-limiter**

```powershell
pnpm --filter @deft/api add hono-rate-limiter
```

Expected: `hono-rate-limiter` appears under `dependencies` in `apps/api/package.json`.

- [ ] **Step 2: Create the middleware module**

Create `apps/api/src/middleware/rate-limit.ts`:

```typescript
import { rateLimiter } from 'hono-rate-limiter';
import type { Context } from 'hono';

// Per-IP for unauthenticated routes (login, signup, forgot-password).
// 10 requests / minute is enough for a human and brutal on a brute-forcer.
export const authLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => {
    return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
           c.req.header('x-real-ip') ||
           'unknown';
  },
  handler: (c) => c.json({
    error: 'Too many requests. Try again in a minute.',
    code: 'RATE_LIMITED',
  }, 429),
});

// Per-user for the agent surface. Agent calls hit Anthropic/OpenAI on every
// request and burn dollars — 30/min/user prevents a runaway client from
// draining a BYOK budget in seconds.
export const agentLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => {
    const user = c.get('user') as { id?: string } | undefined;
    return user?.id || c.req.header('x-forwarded-for') || 'unknown';
  },
  handler: (c) => c.json({
    error: 'Agent rate limit hit. Pause for a minute or talk to your admin about quota.',
    code: 'AGENT_RATE_LIMITED',
  }, 429),
});

// Per-user for uploads. 20/min lets a normal user paste a doc with images;
// stops scripted abuse.
export const uploadLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => {
    const user = c.get('user') as { id?: string } | undefined;
    return user?.id || c.req.header('x-forwarded-for') || 'unknown';
  },
  handler: (c) => c.json({
    error: 'Upload rate limit hit.',
    code: 'UPLOAD_RATE_LIMITED',
  }, 429),
});

// Default — covers everything else. Per-user for authed, per-IP for public.
export const defaultLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => {
    const user = c.get('user') as { id?: string } | undefined;
    return user?.id || c.req.header('x-forwarded-for') || 'unknown';
  },
  handler: (c) => c.json({
    error: 'Too many requests.',
    code: 'RATE_LIMITED',
  }, 429),
});
```

- [ ] **Step 3: Mount the limiters in `apps/api/src/index.ts`**

Find the import block at top of `apps/api/src/index.ts` (around line 53) and add after the `authMiddleware` import:

```typescript
import { authLimiter, agentLimiter, uploadLimiter, defaultLimiter } from './middleware/rate-limit.js';
```

Then modify the route mounts. Replace `app.route('/api/auth', authRoutes);` (line 67) with:

```typescript
app.use('/api/auth/*', authLimiter);
app.route('/api/auth', authRoutes);
```

Replace `app.route('/api/agent', agentRoutes);` (line 109) with:

```typescript
app.use('/api/agent/*', agentLimiter);
app.route('/api/agent', agentRoutes);
```

Replace `app.route('/api/upload', uploadRoutes);` (line 103) with:

```typescript
app.use('/api/upload/*', uploadLimiter);
app.route('/api/upload', uploadRoutes);
```

After `app.use('/api/*', authMiddleware);` (line 98), add:

```typescript
app.use('/api/*', defaultLimiter);
```

- [ ] **Step 4: Smoke-test by hammering login**

Start the API: `pnpm --filter @deft/api dev`. In another terminal:

```powershell
1..15 | ForEach-Object {
  $r = curl.exe -s -o /dev/null -w "%{http_code}`n" -X POST http://localhost:3001/api/auth/login `
    -H "Content-Type: application/json" `
    -d '{\"email\":\"none@example.com\",\"password\":\"x\"}'
  Write-Output "Request $_ -> $r"
}
```

Expected: requests 1–10 return `401` (invalid credentials), requests 11–15 return `429`. Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add apps/api/package.json apps/api/src/middleware/rate-limit.ts apps/api/src/index.ts
git commit -m "feat(api): per-route rate limiting (auth/agent/upload/default)"
```

---

## Task 4: Security Headers

**Why:** No CSP, HSTS, X-Frame-Options, or Referrer-Policy. Hono ships `secureHeaders` middleware; Next.js exposes a `headers()` config hook. Both take ~30 minutes to wire up.

**Files:**
- Modify: `apps/api/src/index.ts:56-64`
- Modify: `apps/web/next.config.js` or `apps/web/next.config.ts` (whichever exists)

- [ ] **Step 1: Add Hono security headers**

In `apps/api/src/index.ts`, find the import block and add:

```typescript
import { secureHeaders } from 'hono/secure-headers';
```

After the existing `app.use('*', cors({...}));` block (line 59–64), add:

```typescript
app.use('*', secureHeaders({
  // Browsers loading API responses cross-origin only see JSON — we don't
  // need a script-src here. xFrameOptions blocks the API itself from being
  // iframed even though there's no HTML; defense in depth.
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin',
  strictTransportSecurity: 'max-age=31536000; includeSubDomains',
  // Hono's default permissions-policy is fine; leave unset.
}));
```

- [ ] **Step 2: Locate the Next.js config**

```powershell
Get-ChildItem -Path "apps\web" -Filter "next.config.*"
```

Use whichever file exists (`.js`, `.ts`, or `.mjs`).

- [ ] **Step 3: Add headers() to the Next.js config**

Open the config file. If it already exports an object, add a `headers()` method. If it exports a function, add headers inside. Example for `next.config.js`:

```javascript
const nextConfig = {
  // ... existing config
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' ws: wss: http://localhost:3001 https:",
              "media-src 'self' blob:",
              "frame-ancestors 'none'",
            ].join('; '),
          },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
```

`unsafe-inline` and `unsafe-eval` on script-src are temporary — Next.js + Tailwind v4 + TipTap currently require them. Tightening to nonce-based CSP is a P1 post-launch task, not an alpha blocker.

The `microphone=(self)` allowance keeps the voice-clip recorder working.

- [ ] **Step 4: Smoke-test the headers**

Start both apps: `pnpm dev`. In another terminal:

```powershell
curl.exe -I http://localhost:3000/
```

Expected: response includes `X-Frame-Options: DENY`, `Content-Security-Policy: ...`, `Referrer-Policy: strict-origin-when-cross-origin`.

```powershell
curl.exe -I http://localhost:3001/health
```

Expected: same headers from Hono.

- [ ] **Step 5: Visit the running app in a browser and confirm no CSP console errors**

Open http://localhost:3000, sign in, navigate to chat / tasks / dashboard / wiki. Check DevTools console — no `Refused to ... because it violates the following Content Security Policy directive` errors. If any appear, widen the offending directive minimally (e.g., add `data:` to img-src if needed). Do not weaken `frame-ancestors 'none'`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/index.ts apps/web/next.config.js
git commit -m "feat(security): CSP, HSTS, X-Frame-Options on api + web"
```

---

## Task 5: Remove Shell-Exec from Bundled Templates

**Why:** `apps/api/src/scripts/seed-templates.ts:266,327` list `shell_exec` in `required_tools` for the on-call and DevOps templates. The `shell_exec` capability pack is `coming_soon: true` (no implementation). Templates deploy with the tool missing, agents look broken, support tickets follow.

**Files:**
- Modify: `apps/api/src/scripts/seed-templates.ts:260-340`

- [ ] **Step 1: Read the template block**

```powershell
Get-Content "apps\api\src\scripts\seed-templates.ts" | Select-Object -Skip 255 -First 90
```

Find both arrays containing `'shell_exec'` (lines 266 and 327 per audit). Note the surrounding template names.

- [ ] **Step 2: Remove `shell_exec` from both required_tools arrays**

Edit the file. In each template's `required_tools: [...]` array, delete the `'shell_exec',` entry. Leave the other tools intact. Example diff for the on-call template:

```typescript
// BEFORE
required_tools: ['create_task', 'post_message', 'shell_exec', 'github_create_issue'],

// AFTER
required_tools: ['create_task', 'post_message', 'github_create_issue'],
```

Apply the same removal at line 327 (DevOps template).

- [ ] **Step 3: Replace OpenClaw attribution in CFO template**

Audit also flagged stale attribution at `seed-templates.ts:274`. Find any string containing `mergisi/awesome-openclaw-agents` and replace with `bundled` or remove the attribution string entirely. OpenClaw was EOL'd in Phase 9 — the reference is misleading.

```powershell
Select-String -Path "apps\api\src\scripts\seed-templates.ts" -Pattern "openclaw" -CaseSensitive:$false
```

Each match: either remove the comment line or replace the attribution with `attribution: 'bundled'`.

- [ ] **Step 4: Re-run the seed script and confirm clean output**

```powershell
pnpm --filter @deft/db seed
```

Expected: completes without warning lines mentioning `shell_exec` or `coming_soon` packs being skipped. If a warning fires, the template still references the gated pack — fix and retry.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scripts/seed-templates.ts
git commit -m "fix(templates): drop shell_exec from on-call/devops, scrub openclaw attribution"
```

---

## Task 6: Drop Deprecated Tables

**Why:** `space_knowledge` and `decisions` were marked deprecated on 2026-04-16 with a 30-day cleanup deadline of 2026-05-16 (`packages/db/src/schema.ts:727-733`, `:868-873`). Today is 2026-05-12. Reads were migrated to `wikiPages` in Phase 2. The deprecation cron has been clean. Drop them now.

**Out of scope:** `agent_memory` (`schema.ts:847-866`). The deprecation note explicitly says "Conversation-scoped agentMemory rows from the native `remember` tool still use this table legitimately." Dropping it would break the remember/recall path. Leave for a P1 deeper audit.

**Files:**
- Create: `packages/db/drizzle/0063_drop_deprecated_tables.sql`
- Modify: `packages/db/src/schema.ts:727-750` (remove `spaceKnowledge`), `:868-893` (remove `decisions`)
- Modify: `packages/db/drizzle/meta/_journal.json` (add idx 63)
- Grep + fix consumers in `apps/api/src/`

- [ ] **Step 1: Find live consumers before dropping**

```powershell
Select-String -Path "apps\api\src","packages\db\src" -Pattern "spaceKnowledge|space_knowledge" -CaseSensitive:$false -SimpleMatch
```

```powershell
Select-String -Path "apps\api\src","packages\db\src" -Pattern "from\s+decisions|decisions\)" -CaseSensitive:$false
```

Expected: hits in `packages/db/src/schema.ts` (definitions — that's what we're about to remove), and possibly stale references in worker files or routes. List each hit; non-schema references must be deleted in this task.

- [ ] **Step 2: Delete the schema entries**

In `packages/db/src/schema.ts`, delete:
- Lines 727–750 (the `spaceKnowledge` block including the comment header `// ═══ SPACE KNOWLEDGE ═══` and its `@deprecated` JSDoc).
- Lines 868–893 (the `decisions` block including the `// ═══ DECISIONS ═══` header and the `@deprecated` JSDoc).

Leave `agentMemory` (lines 847–866) intact — it has live conversation-scope consumers.

- [ ] **Step 3: Delete any non-schema references**

For each hit from Step 1 that is not in `packages/db/src/schema.ts`:
- If it's an import statement, remove the import.
- If it's a usage (e.g., `db.select().from(spaceKnowledge)`), delete the surrounding function or route handler if it has no other purpose. Most should already be dead code per Phase 2 cleanup — confirm by reading the surrounding 20 lines.

Common locations to inspect:
- `apps/api/src/routes/knowledge.ts` — `spaceKnowledge` was the old backing table; confirm it now only reads from `wikiPages`.
- `apps/api/src/routes/decisions.ts` — confirm it reads from `wikiPages` (decision type), not the legacy `decisions` table.
- `apps/api/src/workers/handlers/` — search for `space_knowledge` cron warnings; remove the worker file if it exists.

- [ ] **Step 4: Create the migration**

Create `packages/db/drizzle/0063_drop_deprecated_tables.sql`:

```sql
-- Deprecated 2026-04-16, cleanup deadline 2026-05-16.
-- Reads migrated to wiki_pages in Phase 2 (Tasks 2.2 + 2.3).
-- Deprecation-warning cron reported zero new rows for 30 days.

DROP TABLE IF EXISTS space_knowledge CASCADE;
DROP TABLE IF EXISTS decisions CASCADE;
```

- [ ] **Step 5: Add the migration to the journal**

Append to `packages/db/drizzle/meta/_journal.json` entries array:

```json
{
  "idx": 63,
  "version": "7",
  "when": 1776600057000,
  "tag": "0063_drop_deprecated_tables",
  "breakpoints": true
}
```

- [ ] **Step 6: Run typecheck — catch missed references**

```powershell
pnpm typecheck
```

Expected: zero new errors. If anything references the dropped tables, the typecheck will name the file. Fix and re-run.

- [ ] **Step 7: Apply against a fresh test DB**

```powershell
$env:DATABASE_URL="postgres://postgres:postgres@localhost:5432/deft_drop_test"
psql -U postgres -c "CREATE DATABASE deft_drop_test;"
psql -U postgres -d deft_drop_test -c "CREATE EXTENSION IF NOT EXISTS vector;"
pnpm --filter @deft/db migrate
psql -U postgres -d deft_drop_test -c "\dt" | Select-String "space_knowledge|^decisions"
```

Expected: no rows match — both tables gone. Drop the test DB.

- [ ] **Step 8: Commit**

```bash
git add packages/db/drizzle/0063_drop_deprecated_tables.sql packages/db/drizzle/meta/_journal.json packages/db/src/schema.ts apps/api/src
git commit -m "feat(db): drop deprecated space_knowledge and decisions tables"
```

---

## Task 7: README Journal Caveat + Test-Account Hint

**Why:** Two small README fixes for first-time self-hosters. Five minutes.

**Files:**
- Modify: `README.md:41-54`

- [ ] **Step 1: Add a note about pnpm db:push vs db:migrate**

In `README.md`, find the Quick Start section around lines 41–48. After the existing `pnpm db:push` line, add a callout. The current text reads:

```markdown
# 3. Initialize the database (run once on first boot)
pnpm db:push   # applies schema
pnpm db:seed   # seeds Defty and starter data
```

Replace with:

```markdown
# 3. Initialize the database (run once on first boot)
pnpm db:push   # applies schema (preferred — diffs against your DB)
pnpm db:seed   # seeds Defty and starter data
```

> **Note:** Use `pnpm db:push`, not `pnpm db:migrate`. The migration journal is canonical as of v0.1 but `push` is the supported path for fresh installs — it diffs the live schema against `packages/db/src/schema.ts` and applies what's missing. `db:migrate` is for upgrade paths once we ship versioned releases.

- [ ] **Step 2: Mention test accounts available via seed**

Find the line `> **Single-org note:**` (around line 52). Just above it, add:

```markdown
> **Want to poke around without creating an account?** `pnpm db:seed` populates five test users with passwords listed in [CONTRIBUTING.md](./CONTRIBUTING.md#test-accounts). Use those for a guided tour, then delete them via Settings → Members before inviting real testers.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): db:push guidance + test-account hint"
```

---

## Done — Open the Cohort

After all 7 tasks land:

1. Run the audit suites against the dev server to confirm no regression:

```powershell
pnpm audit:setup
pnpm audit:session1
```

Expected: both pass (15/15 green per prior runs).

2. Tag a release in the repo:

```bash
git tag -a v0.1.0-alpha -m "Private alpha — 7 P0 blockers cleared"
```

3. Send invite links from Settings → Members. Watch the queue health endpoint (`/health/queue`) for any new failure modes the wider audience exposes.

---

## Self-Review

**Spec coverage:** 7 P0 items from the audit → 7 tasks. Token rotation (Task 0) is a user action. Journal regen (Task 1), email gate (Task 2), rate limit (Task 3), security headers (Task 4), shell-exec fix + OpenClaw scrub (Task 5), table drops (Task 6), README polish (Task 7). All accounted for.

**Placeholder scan:** No `TBD`, no `TODO`, no `add appropriate error handling`. Every code step shows the code. Every command shows expected output.

**Type consistency:** `email_verified_at` is used identically across Tasks 2 (test + guard); `authLimiter`/`agentLimiter`/`uploadLimiter`/`defaultLimiter` named the same in the middleware module and the mount point.

**One known soft-spot:** Task 2 Step 6 assumes the signup handler already sets `email_verified_at: new Date()`. If it doesn't, the same task patches it inline — no separate task needed because the change is one line in the same file.
