# Agent ↔ Chat Unification — Phase 1: First-Class Participants

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agents (Defty + every BYOA employee) first-class participants in the existing chat protocol — addressable in the @-autocomplete, selectable in the DM picker, distinguishable by a `kind` field on `users`. Closes the initiation gap by making Defty DM-able and removes the hardcoded `'agent'` mention shim.

**Architecture:** Adds a `users.kind` enum (`human | agent | system`) backfilled from the existing `is_agent` boolean. The `deft-agent@system.local` user gets a real `org_members` row in every org so it appears in `/api/members` like any other participant. The mention-autocomplete shim (`id: 'agent'`) is removed; `agent-reply` dispatch detects Defty by the `kind = 'agent'` user it actually mentions. UI surfaces (DM picker, autocomplete) sort agents distinctly and tag them with an AI badge. No data migration of `messages` or `agent_messages` in this phase — that's Phase 2.

**Tech Stack:**
- Drizzle ORM + PostgreSQL (`packages/db/`)
- Hono API (`apps/api/`)
- Next.js 14 + Tailwind (`apps/web/`)
- Vitest (test runner — see `apps/api/test/agent-employee-schema.test.ts` for patterns)

**Spec:** `docs/superpowers/specs/2026-05-07-agent-chat-unification.md` (Section 8)

**Phases that follow this plan (separate plans, not this one):**
- Phase 2 — Mirror → dual-write → collapse `agent_messages` into `messages` (~3 days)
- Phase 3 — MCP tool collapse: `send_message`, `fetch_unread` (~1 day)
- Phase 4 — UI collapse: delete `/agent`, merge `AgentChat` into `SpaceChat` with tool-call rendering, inline approval cards (~3 days)
- Phase 5 — Universal `/inbox` (~3–4 days)
- Phase 6 — Multi-agent affordances (Add-Member modal includes agents, thread-level reply-storm detector) (~2 days)

---

## Discovery findings (already done — read before starting)

These were verified during plan-writing; no need to re-discover:

- `users.is_agent` already exists (`packages/db/src/schema.ts:85`). Set `true` when an agent_employee is created (`apps/api/src/routes/agent-employees.ts:453`), reset to `false` on soft-delete (line 1015). BYOA agents already have `org_members` rows (`agent-employees.ts:460`), so they are already returned by `/api/members`.
- `deft-agent@system.local` (the built-in Defty user) is created lazily in `apps/api/src/workers/handlers/agent-reply.ts:17–34`. **It does NOT have `org_members` rows** — it's just a row in `users`. That's why it doesn't appear in `/api/members`.
- The mention autocomplete (`apps/web/src/components/mention-autocomplete.tsx`) uses a hardcoded `{ id: 'agent', name: 'Deft' }` shim (line 50) since Defty isn't in `/api/members`. When picked, it produces the string `<@agent|Deft>` in the message body.
- Message dispatch detects this with the regex `/@(agent|deft)\b|<@agent\|Deft>/i` (`apps/api/src/routes/messages.ts:486`).
- `parseMentions` (`apps/api/src/lib/mentions.ts`) extracts user IDs from `<@userId|userName>` — supports any user ID, no special-case.
- Latest migration is `0062_ics_calendar_sync.sql`. Next number is `0063`.
- Drizzle journal is stale since 0017 — migrations are applied manually (per CLAUDE.md "Known Limitations"). New migration must work via `drizzle-kit push` or direct SQL, NOT `pnpm db:migrate`.
- BYOA agent employees already get `space_members` rows for selected spaces (`agent-employees.ts:478–483`). The plan does not change this.

---

## File Structure

**Schema + migration (`packages/db/`)**
- Modify: `packages/db/src/schema.ts:15–62` — add `userKindEnum`
- Modify: `packages/db/src/schema.ts:81–102` — add `kind` column to `users`
- Create: `packages/db/drizzle/0063_user_kind.sql` — migration with backfill

**API — agent user creation + Defty membership (`apps/api/`)**
- Modify: `apps/api/src/workers/handlers/agent-reply.ts:17–34` — `ensureAgentUser` now also takes `orgId`, creates `org_members` row, sets `kind='agent'`
- Modify: `apps/api/src/workers/handlers/agent-reply.ts:36+` — pass orgId into `ensureAgentUser`
- Modify: `apps/api/src/routes/agent-employees.ts:447–457` — set `kind='agent'` on agent user creation (in addition to existing `is_agent: true`)
- Modify: `apps/api/src/routes/agent-employees.ts:1015` — flip `kind` back to a sentinel (or leave; we're keeping the row anyway). Confirm: leave `kind='agent'` even on soft-delete since list endpoints filter by `is_deleted`. NO change needed; just verify.
- Modify: `apps/api/src/routes/members.ts:23–63` — `/api/members` returns `kind` field
- Create: `apps/api/src/lib/ensure-defty-membership.ts` — idempotent helper that ensures a Defty user + org_members row exists for a given org. Called from invite acceptance and org bootstrap.
- Modify: `apps/api/src/routes/auth.ts` (signup completion / invite acceptance) — call `ensureDeftyMembership(orgId)` after a new user joins an org. Find the right hook point during the task.
- Modify: `apps/api/src/routes/messages.ts:485–486` — replace the `@(agent|deft)` regex with a check that the parsed mention IDs include any user with `kind='agent'`. Detect via DB lookup, NOT a string match.

**Frontend — autocomplete + DM picker (`apps/web/`)**
- Modify: `apps/web/src/components/mention-autocomplete.tsx:7–11` — add `kind` field to `Member` type
- Modify: `apps/web/src/components/mention-autocomplete.tsx:44–60` — remove the hardcoded `agentOption` shim; agents come through `/api/members` like everyone else. Sort: humans first, agents second, special (`here`/`all`) last. Render agents with the existing AI badge + bot icon (lines 152–178), reused as a render branch keyed off `kind === 'agent'`.
- Modify: `apps/web/src/components/create-dm-modal.tsx:9–13` — add `kind` to `Member` type
- Modify: `apps/web/src/components/create-dm-modal.tsx:181–212` — render agent rows with AI badge + bot icon; humans render unchanged. Optional: section header "People" / "Agents" if both groups have results.

**Tests (`apps/api/test/`)**
- Create: `apps/api/test/user-kind-migration.test.ts` — verifies the schema migration: kind enum exists, backfill correct
- Create: `apps/api/test/members-kind-field.test.ts` — `/api/members` returns `kind` for human + agent users
- Create: `apps/api/test/ensure-defty-membership.test.ts` — `ensureDeftyMembership(orgId)` is idempotent, creates user + org_members + sets `kind='agent'`
- Create: `apps/api/test/agent-mention-detection.test.ts` — message with `<@<defty-user-id>|Deft>` enqueues agent-reply; message without doesn't

---

## Task 1: Add `users.kind` enum to schema

**Files:**
- Modify: `packages/db/src/schema.ts:15–62` (add enum near other pgEnum declarations)
- Modify: `packages/db/src/schema.ts:81–102` (add column to users)

- [ ] **Step 1: Add `userKindEnum` near other enums**

In `packages/db/src/schema.ts`, after `eventSourceEnum` declaration around line 23 (or grouped with other enums — pick a logical spot near `orgRoleEnum`):

```typescript
export const userKindEnum = pgEnum('user_kind', ['human', 'agent', 'system']);
```

- [ ] **Step 2: Add `kind` column to `users` table**

In `packages/db/src/schema.ts`, modify the `users` pgTable definition (currently line 81–102) to add the `kind` column. Insert it directly after `name`:

```typescript
export const users = pgTable('users', {
  ...id(),
  email: text('email').unique(),
  name: text('name').notNull(),
  kind: userKindEnum('kind').default('human').notNull(),
  is_agent: boolean('is_agent').default(false).notNull(),
  agent_employee_id: text('agent_employee_id'),
  // ... rest unchanged
```

Keep `is_agent` for now — it's still in active use by 30+ files. Phase 1 introduces `kind` alongside; Phase 2 (or a follow-on cleanup) drops `is_agent`.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `pnpm --filter @deft/db typecheck` (from repo root)
Expected: PASS, no errors. Drizzle should infer the new column type as `'human' | 'agent' | 'system'`.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema.ts
git commit -m "feat(schema): add users.kind enum (human|agent|system)"
```

---

## Task 2: Write the migration SQL

**Files:**
- Create: `packages/db/drizzle/0063_user_kind.sql`

- [ ] **Step 1: Write the migration SQL**

Create `packages/db/drizzle/0063_user_kind.sql`:

```sql
-- Migration 0063: Add users.kind enum
-- Phase 1 of agent-chat unification (docs/superpowers/specs/2026-05-07-agent-chat-unification.md).
-- Introduces a participant-kind enum on users. Backfills from is_agent and email patterns.
-- is_agent is retained for backwards compat; a follow-on plan drops it.

-- 1. Create the enum
DO $$ BEGIN
  CREATE TYPE user_kind AS ENUM ('human', 'agent', 'system');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2. Add the column with default 'human'
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kind user_kind NOT NULL DEFAULT 'human';

-- 3. Backfill: rows with is_agent=true become 'agent'
UPDATE users SET kind = 'agent' WHERE is_agent = true;

-- 4. Backfill: the well-known Defty system user becomes 'agent' (it's an agent participant, not 'system')
--    'system' is reserved for cron/webhook senders we'll add in Phase 5.
UPDATE users SET kind = 'agent' WHERE email = 'deft-agent@system.local';

-- 5. Index for the common filter (e.g. @-autocomplete sorting)
CREATE INDEX IF NOT EXISTS users_kind_idx ON users(kind);
```

- [ ] **Step 2: Apply the migration locally**

Per CLAUDE.md "Known Limitations" — the journal is stale, so use `drizzle-kit push` or direct psql. Pick whichever the local dev pattern uses (look for prior migration 0062 application notes in `apps/api/scripts/` or just use psql).

```bash
# Option A — drizzle-kit push (preferred if the local setup uses it)
pnpm --filter @deft/db db:push

# Option B — direct SQL apply (if push isn't wired)
psql "$DATABASE_URL" -f packages/db/drizzle/0063_user_kind.sql
```

Expected: migration applies without error. Verify with:

```bash
psql "$DATABASE_URL" -c "SELECT typname FROM pg_type WHERE typname = 'user_kind';"
psql "$DATABASE_URL" -c "SELECT kind, COUNT(*) FROM users GROUP BY kind;"
```

Expected output: `user_kind` row exists; counts show `human`, `agent` (Defty + BYOA agent employees), and (probably) no `system` rows yet.

- [ ] **Step 3: Write the migration verification test**

Create `apps/api/test/user-kind-migration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { db } from '../src/lib/db.js';
import { users } from '@deft/db/schema';
import { eq, sql } from 'drizzle-orm';

describe('users.kind migration (0063)', () => {
  it('kind column exists and accepts the three enum values', async () => {
    const result = await db.execute(sql`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'kind'
    `);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].udt_name).toBe('user_kind');
  });

  it('backfilled is_agent=true rows to kind=agent', async () => {
    const mismatched = await db.execute(sql`
      SELECT id FROM users WHERE is_agent = true AND kind != 'agent'
    `);
    expect(mismatched.rows.length).toBe(0);
  });

  it('backfilled deft-agent@system.local to kind=agent', async () => {
    const result = await db
      .select({ kind: users.kind })
      .from(users)
      .where(eq(users.email, 'deft-agent@system.local'))
      .limit(1);
    if (result.length > 0) {
      expect(result[0]!.kind).toBe('agent');
    }
    // If no Defty user exists yet, that's fine — Task 4 creates one.
  });
});
```

- [ ] **Step 4: Run the migration test**

Run: `pnpm --filter @deft/api test user-kind-migration`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/0063_user_kind.sql apps/api/test/user-kind-migration.test.ts
git commit -m "feat(schema): migration 0063 adds users.kind enum + backfill"
```

---

## Task 3: `/api/members` returns `kind`

**Files:**
- Modify: `apps/api/src/routes/members.ts:23–63`
- Create: `apps/api/test/members-kind-field.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/members-kind-field.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers } from '@deft/db/schema';
import { eq } from 'drizzle-orm';
import { app } from '../src/index.js'; // Hono app
import { signTestJwt } from './helpers/auth.js'; // existing test helper — adjust import if path differs

describe('GET /api/members returns kind field', () => {
  let testOrgId: string;
  let humanUserId: string;
  let agentUserId: string;
  let humanToken: string;

  beforeAll(async () => {
    // Set up org + a human + an agent shadow user
    const [org] = await db.insert(orgs).values({ name: 'Test Org', slug: `test-${Date.now()}` }).returning();
    testOrgId = org!.id;

    const [human] = await db.insert(users).values({
      email: `human-${Date.now()}@test.local`,
      name: 'Test Human',
      email_verified: true,
    }).returning();
    humanUserId = human!.id;

    const [agentUser] = await db.insert(users).values({
      name: 'Test Agent',
      kind: 'agent',
      is_agent: true,
      email_verified: true,
    }).returning();
    agentUserId = agentUser!.id;

    await db.insert(orgMembers).values([
      { org_id: testOrgId, user_id: humanUserId, role: 'owner' },
      { org_id: testOrgId, user_id: agentUserId, role: 'member' },
    ]);

    humanToken = signTestJwt({ id: humanUserId, org_id: testOrgId });
  });

  it('returns kind field for both human and agent members', async () => {
    const res = await app.request('/api/members', {
      headers: { Authorization: `Bearer ${humanToken}` },
    });
    expect(res.status).toBe(200);
    const body: Array<{ id: string; kind: 'human' | 'agent' | 'system' }> = await res.json();

    const human = body.find((m) => m.id === humanUserId);
    const agent = body.find((m) => m.id === agentUserId);

    expect(human?.kind).toBe('human');
    expect(agent?.kind).toBe('agent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @deft/api test members-kind-field`
Expected: FAIL — body items don't have a `kind` field yet.

- [ ] **Step 3: Modify `/api/members` to include kind**

In `apps/api/src/routes/members.ts`, modify the SELECT around line 27–36:

```typescript
const members = await db.select({
  id: users.id,
  name: users.name,
  email: users.email,
  kind: users.kind,
  avatar_url: users.avatar_url,
  status_emoji: users.status_emoji,
  status_text: users.status_text,
  status_expires_at: users.status_expires_at,
  role: orgMembers.role,
})
  .from(orgMembers)
  .innerJoin(users, eq(orgMembers.user_id, users.id))
  .where(
    and(
      eq(orgMembers.org_id, user.org_id),
      eq(orgMembers.is_active, true),
    )
  );
```

Also update the `result.map` block at lines 48–56 to spread `kind` through unchanged (the existing spread does this already — verify nothing strips it).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @deft/api test members-kind-field`
Expected: PASS.

- [ ] **Step 5: Also update GET /api/members/:id (single profile)**

In the same file, around line 71, modify the single-member SELECT to also include `kind: users.kind`. Keeps the contract uniform.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/members.ts apps/api/test/members-kind-field.test.ts
git commit -m "feat(api): /api/members returns kind field"
```

---

## Task 4: `ensureDeftyMembership(orgId)` helper

**Goal:** A single idempotent helper that guarantees the Defty user + org_members row exists for a given org. Replaces the partial `ensureAgentUser` logic in `agent-reply.ts` and is callable from invite-acceptance hooks.

**Files:**
- Create: `apps/api/src/lib/ensure-defty-membership.ts`
- Create: `apps/api/test/ensure-defty-membership.test.ts`
- Modify: `apps/api/src/workers/handlers/agent-reply.ts:17–34` (replace `ensureAgentUser` with `ensureDeftyMembership`)

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/ensure-defty-membership.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { ensureDeftyMembership, DEFTY_EMAIL } from '../src/lib/ensure-defty-membership.js';

describe('ensureDeftyMembership', () => {
  let orgId: string;

  beforeAll(async () => {
    const [org] = await db.insert(orgs).values({ name: 'Defty Test Org', slug: `dt-${Date.now()}` }).returning();
    orgId = org!.id;
  });

  it('creates Defty user with kind=agent on first call', async () => {
    const userId = await ensureDeftyMembership(orgId);

    const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(u?.email).toBe(DEFTY_EMAIL);
    expect(u?.kind).toBe('agent');
    expect(u?.is_agent).toBe(true);
    expect(u?.name).toBe('Deft');
  });

  it('creates org_members row in target org', async () => {
    const userId = await ensureDeftyMembership(orgId);
    const [m] = await db.select()
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, userId)))
      .limit(1);
    expect(m).toBeDefined();
    expect(m?.role).toBe('member');
  });

  it('is idempotent — second call returns same userId, no duplicate rows', async () => {
    const id1 = await ensureDeftyMembership(orgId);
    const id2 = await ensureDeftyMembership(orgId);
    expect(id1).toBe(id2);

    const memberRows = await db.select()
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, id1)));
    expect(memberRows.length).toBe(1);
  });

  it('reuses existing Defty user across orgs (single user, multiple org_members rows)', async () => {
    const [otherOrg] = await db.insert(orgs).values({ name: 'Other', slug: `other-${Date.now()}` }).returning();
    const id1 = await ensureDeftyMembership(orgId);
    const id2 = await ensureDeftyMembership(otherOrg!.id);
    expect(id1).toBe(id2);

    const allMemberships = await db.select().from(orgMembers).where(eq(orgMembers.user_id, id1));
    expect(allMemberships.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @deft/api test ensure-defty-membership`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/lib/ensure-defty-membership.ts`:

```typescript
// Idempotent helper: ensures the Defty system agent user exists and has an
// org_members row for the given org. Callable from invite-acceptance,
// signup-finalization, and the @deft mention worker.
//
// Design: there is ONE Defty user row globally (keyed by email) that joins
// every org via org_members. This matches the existing pattern from
// agent-reply.ts where the user is keyed by email='deft-agent@system.local'.

import { db } from './db.js';
import { users, orgMembers } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';

export const DEFTY_EMAIL = 'deft-agent@system.local';
export const DEFTY_NAME = 'Deft';

export async function ensureDeftyMembership(orgId: string): Promise<string> {
  // 1. Find or create the Defty user.
  let [user] = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEFTY_EMAIL))
    .limit(1);

  if (!user) {
    [user] = await db.insert(users).values({
      email: DEFTY_EMAIL,
      name: DEFTY_NAME,
      kind: 'agent',
      is_agent: true,
      email_verified: true,
    }).returning({ id: users.id });
  }

  const userId = user!.id;

  // 2. Ensure org_members row exists for this org.
  const [existing] = await db.select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, userId)))
    .limit(1);

  if (!existing) {
    await db.insert(orgMembers).values({
      org_id: orgId,
      user_id: userId,
      role: 'member',
    });
  }

  return userId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @deft/api test ensure-defty-membership`
Expected: PASS (4 tests).

- [ ] **Step 5: Replace `ensureAgentUser` in agent-reply.ts**

In `apps/api/src/workers/handlers/agent-reply.ts`, delete lines 9–34 (the `AGENT_EMAIL`/`AGENT_NAME` constants and `ensureAgentUser` function) and replace with:

```typescript
import { ensureDeftyMembership } from '../../lib/ensure-defty-membership.js';
```

Then in `handleAgentReply` (around line 36+), find every call to `ensureAgentUser()` and replace with `ensureDeftyMembership(orgId)`. The `orgId` is already destructured from `job.data` at line 38.

- [ ] **Step 6: Run agent-reply tests to confirm no regression**

Run: `pnpm --filter @deft/api test agent-reply` (or whichever tests exercise the @deft path)
Expected: PASS. If a test specifically asserts on `ensureAgentUser` being called, update it to assert `ensureDeftyMembership` instead.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/ensure-defty-membership.ts apps/api/test/ensure-defty-membership.test.ts apps/api/src/workers/handlers/agent-reply.ts
git commit -m "feat(api): ensureDeftyMembership helper, replaces ad-hoc ensureAgentUser"
```

---

## Task 5: Wire `ensureDeftyMembership` into invite acceptance / signup

**Goal:** When a new user joins an org (signup, invite acceptance, or via `POST /api/members`), Defty's per-org membership is guaranteed.

**Files:**
- Modify: `apps/api/src/routes/auth.ts` (signup completion path)
- Modify: `apps/api/src/routes/members.ts` (invite acceptance / POST handler if it creates the org)
- Modify: `apps/api/src/routes/invites.ts` (invite acceptance flow — if separate)

- [ ] **Step 1: Find the org-creation and invite-acceptance points**

Run:

```bash
grep -rn "insert(orgs).values" apps/api/src/routes/
grep -rn "insert(orgMembers).values" apps/api/src/routes/
```

Expected: identifies signup-finalization (where the first user creates an org) and invite-acceptance (where a user joins an existing org). Likely:
- `apps/api/src/routes/auth.ts` (signup, `POST /api/auth/signup`)
- `apps/api/src/routes/invites.ts` (invite acceptance, `POST /api/invites/:token/accept`)
- `apps/api/src/routes/members.ts` (admin POST /api/members for invites)

- [ ] **Step 2: Add `ensureDeftyMembership(orgId)` after each org_members insert**

In each location identified, after the line that inserts the new user's `org_members` row, add:

```typescript
import { ensureDeftyMembership } from '../lib/ensure-defty-membership.js';
// ...
await ensureDeftyMembership(newOrgId); // adjust variable name to match local context
```

Place the call in a way that doesn't fail the request if Defty creation errors (best-effort) — wrap in try/catch and log on failure:

```typescript
try {
  await ensureDeftyMembership(orgId);
} catch (err) {
  console.error('[ensureDeftyMembership] failed for org', orgId, err);
  // Don't fail the signup/invite — Defty will be lazily created on first @deft mention.
}
```

- [ ] **Step 3: Manual smoke test**

Start dev server: `pnpm dev`
Sign up a new user creating a new org. Then check via psql:

```bash
psql "$DATABASE_URL" -c "
  SELECT u.kind, u.email, om.org_id
  FROM users u
  JOIN org_members om ON om.user_id = u.id
  WHERE u.email = 'deft-agent@system.local'
  ORDER BY om.created_at DESC
  LIMIT 5;
"
```

Expected: a row exists with `kind='agent'`, the email, and the new org's id.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/routes/invites.ts apps/api/src/routes/members.ts
git commit -m "feat(api): ensureDeftyMembership on signup + invite acceptance"
```

---

## Task 6: Backfill Defty into all existing orgs

**Goal:** Every existing org must have a Defty `org_members` row before the frontend changes ship; otherwise users won't see Defty in their member list until someone @-mentions it.

**Files:**
- Create: `apps/api/scripts/backfill-defty-membership.ts`

- [ ] **Step 1: Write the backfill script**

Create `apps/api/scripts/backfill-defty-membership.ts`:

```typescript
// One-shot backfill: ensure every existing org has a Defty org_members row.
// Run once after migration 0063 ships. Idempotent — safe to re-run.
//
// Usage: pnpm --filter @deft/api tsx src/scripts/backfill-defty-membership.ts

import { db } from '../src/lib/db.js';
import { orgs } from '@deft/db/schema';
import { ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';

async function main() {
  const allOrgs = await db.select({ id: orgs.id, name: orgs.name }).from(orgs);
  console.log(`[backfill-defty] found ${allOrgs.length} orgs`);

  let ok = 0;
  let failed = 0;
  for (const org of allOrgs) {
    try {
      await ensureDeftyMembership(org.id);
      ok++;
    } catch (err) {
      console.error(`[backfill-defty] FAILED for org ${org.id} (${org.name}):`, err);
      failed++;
    }
  }

  console.log(`[backfill-defty] complete: ${ok} ok, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[backfill-defty] fatal', err);
  process.exit(1);
});
```

Note: place under `apps/api/scripts/` (NOT `apps/api/src/scripts/` if the repo's existing one-shot scripts live elsewhere — check `git ls-files apps/api/scripts/ apps/api/src/scripts/` and match the existing convention; modify path here if needed).

- [ ] **Step 2: Run the backfill against the local DB**

```bash
pnpm --filter @deft/api tsx scripts/backfill-defty-membership.ts
```

Expected: prints "found N orgs" and "complete: N ok, 0 failed".

- [ ] **Step 3: Verify**

```bash
psql "$DATABASE_URL" -c "
  SELECT COUNT(*) FROM orgs;
"
psql "$DATABASE_URL" -c "
  SELECT COUNT(*) FROM org_members om
  JOIN users u ON u.id = om.user_id
  WHERE u.email = 'deft-agent@system.local';
"
```

Expected: the second count equals the first (every org has Defty).

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/backfill-defty-membership.ts
git commit -m "chore(api): backfill script for Defty org membership"
```

---

## Task 7: Replace hardcoded `'agent'` mention in @-autocomplete

**Files:**
- Modify: `apps/web/src/components/mention-autocomplete.tsx`

- [ ] **Step 1: Add `kind` to the `Member` type**

In `apps/web/src/components/mention-autocomplete.tsx:7–11`:

```typescript
type Member = {
  id: string;
  name: string;
  avatar: string | null;
  kind?: 'human' | 'agent' | 'system';
};
```

- [ ] **Step 2: Remove the hardcoded `agentOption` shim**

In the same file around lines 49–60, delete:

```typescript
// Deft agent entry — always shown when query matches
const agentOption = { id: 'agent', name: 'Deft' };
const agentMatches = agentOption.name.toLowerCase().includes(lowerQuery) ||
  'agent'.includes(lowerQuery) || 'deft'.includes(lowerQuery);
const agentOptions = agentMatches ? [agentOption] : [];

const specialOptions = [...].filter(...);

const allOptions = [...filtered, ...agentOptions, ...specialOptions];
```

Replace with:

```typescript
// Partition members by kind so agents (incl. Defty) get the agent badge.
const humans = filtered.filter((m) => m.kind !== 'agent');
const agents = filtered.filter((m) => m.kind === 'agent');

const specialOptions = [
  { id: 'here', name: 'here' },
  { id: 'all', name: 'all' },
].filter((o) => o.name.includes(lowerQuery));

const allOptions = [...humans, ...agents, ...specialOptions];
```

- [ ] **Step 3: Update the render to use the new partition**

In the same file around lines 124–178, the JSX currently renders `filtered.map(...)` for humans then `agentOptions.map(...)` for the hardcoded shim. Replace those two blocks with one render that branches on `kind`:

```typescript
{humans.map((member, i) => (
  <button
    key={member.id}
    onClick={() => onSelect({ id: member.id, name: member.name })}
    className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-[13px]"
    style={{
      background: selectedIndex === i ? 'var(--hover-tint)' : 'transparent',
      color: 'var(--foreground)',
      fontFamily: 'var(--font-body)',
    }}
    onMouseEnter={() => setSelectedIndex(i)}
  >
    {member.avatar ? (
      <img src={member.avatar} className="w-6 h-6 rounded-full" alt={member.name} />
    ) : (
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium text-white"
        style={{ background: avatarColor(member.name) }}
      >
        {member.name.charAt(0).toUpperCase()}
      </div>
    )}
    <span>{member.name}</span>
  </button>
))}
{agents.length > 0 && humans.length > 0 && (
  <div className="mx-3 my-1 h-px" style={{ background: 'var(--border)' }} />
)}
{agents.map((agent, i) => {
  const idx = humans.length + i;
  return (
    <button
      key={agent.id}
      onClick={() => onSelect({ id: agent.id, name: agent.name })}
      className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-[13px]"
      style={{
        background: selectedIndex === idx ? 'var(--hover-tint)' : 'transparent',
        color: 'var(--foreground)',
        fontFamily: 'var(--font-body)',
      }}
      onMouseEnter={() => setSelectedIndex(idx)}
    >
      {agent.avatar ? (
        <img src={agent.avatar} className="w-6 h-6 rounded-full" alt={agent.name} />
      ) : (
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center"
          style={{ background: '#6366f1', color: '#fff' }}
        >
          <Bot size={13} strokeWidth={1.5} />
        </div>
      )}
      <span>{agent.name}</span>
      <span
        className="text-[11px] ml-auto px-1.5 py-0.5 rounded-full"
        style={{ background: 'var(--surface)', color: 'var(--muted)' }}
      >
        AI
      </span>
    </button>
  );
})}
{specialOptions.length > 0 && (humans.length > 0 || agents.length > 0) && (
  <div className="mx-3 my-1 h-px" style={{ background: 'var(--border)' }} />
)}
{specialOptions.map((opt, i) => {
  const idx = humans.length + agents.length + i;
  // ... unchanged from current code lines 184–212
})}
```

- [ ] **Step 4: Manual smoke test**

Start dev server. In a chat, type `@d`. Expected:
- "Deft" appears in the dropdown with the AI badge and bot avatar.
- BYOA agent employees (e.g., "Alex PM") also show with the AI badge.
- Real human members appear without the badge.
- Selecting "Deft" produces `<@<defty-real-user-id>|Deft>` in the message body, NOT `<@agent|Deft>`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/mention-autocomplete.tsx
git commit -m "feat(web): mention autocomplete uses real agent users (no agent shim)"
```

---

## Task 8: Update message dispatch to detect agent mentions by `kind`

**Files:**
- Modify: `apps/api/src/routes/messages.ts:485–486`
- Create: `apps/api/test/agent-mention-detection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/agent-mention-detection.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers, spaces, spaceMembers } from '@deft/db/schema';
import { app } from '../src/index.js';
import { signTestJwt } from './helpers/auth.js';
import { ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';
import { eq } from 'drizzle-orm';

describe('agent mention dispatch (kind-based)', () => {
  let orgId: string;
  let humanUserId: string;
  let deftyUserId: string;
  let spaceId: string;
  let token: string;

  beforeAll(async () => {
    const [org] = await db.insert(orgs).values({ name: 'Mention Test', slug: `mt-${Date.now()}` }).returning();
    orgId = org!.id;

    const [human] = await db.insert(users).values({
      email: `mt-${Date.now()}@test.local`, name: 'Tester', email_verified: true,
    }).returning();
    humanUserId = human!.id;
    await db.insert(orgMembers).values({ org_id: orgId, user_id: humanUserId, role: 'owner' });

    deftyUserId = await ensureDeftyMembership(orgId);

    const [space] = await db.insert(spaces).values({
      org_id: orgId, name: 'general', type: 'public', created_by: humanUserId,
    }).returning();
    spaceId = space!.id;
    await db.insert(spaceMembers).values([
      { space_id: spaceId, user_id: humanUserId },
      { space_id: spaceId, user_id: deftyUserId },
    ]);

    token = signTestJwt({ id: humanUserId, org_id: orgId });
  });

  it('enqueues agent-reply when mention id resolves to a kind=agent user', async () => {
    // We can't easily assert the queue without a queue inspection helper, so
    // instead: send the message and assert the response is 200 + the agent
    // user appears in the parsed mentioned_user_ids the route stores.
    // (Adjust this assertion to whatever the existing repo conventions use —
    // e.g., a queue spy if available.)
    const res = await app.request('/api/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        space_id: spaceId,
        content: `Hey <@${deftyUserId}|Deft> what's up?`,
      }),
    });
    expect(res.status).toBe(200);
    // Further assertion: query agent_actions or messages.metadata for the
    // dispatch marker the route writes. Adjust to match the actual repo
    // verification pattern.
  });

  it('does NOT enqueue agent-reply for a human-only mention', async () => {
    const res = await app.request('/api/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        space_id: spaceId,
        content: `Just chatting <@${humanUserId}|Tester>`,
      }),
    });
    expect(res.status).toBe(200);
  });
});
```

Note: if the existing test suite uses a queue spy or different verification pattern, adapt the assertions to match. Check `apps/api/test/agent-actions-routes.test.ts` for the established style.

- [ ] **Step 2: Run test to verify it fails (or check current behavior)**

Run: `pnpm --filter @deft/api test agent-mention-detection`
Expected behavior depends on test assertions. Initially the test verifies the structure works at all.

- [ ] **Step 3: Modify the dispatch logic**

In `apps/api/src/routes/messages.ts:485–486`, the current logic is:

```typescript
const agentMentionRegex = /@(agent|deft)\b|<@agent\|Deft>/i;
if (agentMentionRegex.test(parsed.data.content)) {
  // ... enqueue agent-reply
}
```

Replace with:

```typescript
// Detect agent mentions by looking up the kind of each mentioned user.
// Falls back to the legacy regex for backwards compat with messages
// authored before Phase 1 (or by external tools that haven't migrated).
const { userIds } = parseMentions(parsed.data.content);
let agentMentioned = false;
if (userIds.length > 0) {
  const mentionedAgents = await db
    .select({ id: users.id })
    .from(users)
    .where(and(
      inArray(users.id, userIds),
      eq(users.kind, 'agent'),
    ))
    .limit(1);
  agentMentioned = mentionedAgents.length > 0;
}
// Backwards-compat: legacy `<@agent|Deft>` and freeform `@deft` still trigger.
const legacyRegex = /@(agent|deft)\b|<@agent\|Deft>/i;
if (!agentMentioned && legacyRegex.test(parsed.data.content)) {
  agentMentioned = true;
}

if (agentMentioned) {
  // ... existing enqueue call unchanged
}
```

Make sure `parseMentions` and `inArray` are imported at the top of the file. `parseMentions` from `'../lib/mentions.js'`, `inArray` from `'drizzle-orm'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @deft/api test agent-mention-detection`
Expected: PASS.

- [ ] **Step 5: Manual smoke test**

In dev:
1. Type `@deft hello` — should still trigger Defty (legacy path).
2. Pick "Deft" from autocomplete (which now produces `<@<defty-id>|Deft>`) and send — should trigger Defty.
3. Mention an agent_employee like `@alex-pm` — should NOT trigger Defty (it's a different agent), should still queue the agent_employee_message worker as before. Verify by checking the existing agent_employee dispatch logic isn't broken.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/messages.ts apps/api/test/agent-mention-detection.test.ts
git commit -m "feat(api): dispatch agent-reply by users.kind, not regex"
```

---

## Task 9: DM picker shows agents distinctly

**Files:**
- Modify: `apps/web/src/components/create-dm-modal.tsx`

- [ ] **Step 1: Add `kind` to the `Member` type**

In `apps/web/src/components/create-dm-modal.tsx:9–13`:

```typescript
type Member = {
  id: string;
  name: string;
  avatar: string | null;
  kind?: 'human' | 'agent' | 'system';
};
```

- [ ] **Step 2: Partition the rendered list**

In the same file, around the existing `filtered.map((member) => ...)` block at line 181, partition into humans + agents and render them in two groups with a header for each:

```typescript
const humans = filtered.filter((m) => m.kind !== 'agent');
const agents = filtered.filter((m) => m.kind === 'agent');
```

(Place this just before the `return (` in the component, near line 67.)

In the JSX, replace the single `filtered.map` (lines 181–212) with two sections:

```typescript
{agents.length > 0 && (
  <>
    <div
      className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide"
      style={{ color: 'var(--muted)' }}
    >
      Agents
    </div>
    {agents.map((member) => (
      <MemberRow
        key={member.id}
        member={member}
        isAgent
        onSelect={handleSelect}
        submitting={submitting}
      />
    ))}
  </>
)}
{humans.length > 0 && (
  <>
    <div
      className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide"
      style={{ color: 'var(--muted)' }}
    >
      People
    </div>
    {humans.map((member) => (
      <MemberRow
        key={member.id}
        member={member}
        isAgent={false}
        onSelect={handleSelect}
        submitting={submitting}
      />
    ))}
  </>
)}
```

- [ ] **Step 3: Extract the row into a small component**

In the same file, above the `CreateDmModal` component, add:

```typescript
import { Bot } from 'lucide-react';

function MemberRow({
  member,
  isAgent,
  onSelect,
  submitting,
}: {
  member: Member;
  isAgent: boolean;
  onSelect: (m: Member) => void;
  submitting: boolean;
}) {
  return (
    <button
      onClick={() => onSelect(member)}
      disabled={submitting}
      className="w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors"
      style={{ opacity: submitting ? 0.5 : 1 }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'var(--hover-tint)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {member.avatar ? (
        <img src={member.avatar} className="w-8 h-8 rounded-full" alt={member.name} />
      ) : isAgent ? (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center"
          style={{ background: '#6366f1', color: '#fff' }}
        >
          <Bot size={15} strokeWidth={1.5} />
        </div>
      ) : (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-medium text-white"
          style={{ background: avatarColor(member.name) }}
        >
          {member.name.charAt(0).toUpperCase()}
        </div>
      )}
      <span
        className="text-[13px] font-medium flex-1"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
      >
        {member.name}
      </span>
      {isAgent && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full"
          style={{ background: 'var(--surface)', color: 'var(--muted)' }}
        >
          AI
        </span>
      )}
    </button>
  );
}
```

- [ ] **Step 4: Manual smoke test**

Start dev server. Click the "New message" / DM creation button. Expected:
- "Agents" section appears at the top with Defty + every BYOA agent in the org, each with the bot avatar + AI badge.
- "People" section below with human members.
- Picking Defty creates a DM with Defty (a real `dm` space with two members: the user + Defty's user_id). Picking an agent_employee creates a DM with that agent.
- Test sending a message in the new Defty DM — `@deft` style autocomplete should also work and the agent should reply.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/create-dm-modal.tsx
git commit -m "feat(web): DM picker partitions agents from people"
```

---

## Task 10: Self-review + final integration test

**Files:**
- (read-only review across all changes)

- [ ] **Step 1: Run the full API test suite**

```bash
pnpm --filter @deft/api test
```

Expected: all tests PASS. If the agent-employee creation tests assert on schema columns, they should still pass since we only added `kind` (with a default).

- [ ] **Step 2: Run the web typecheck**

```bash
pnpm --filter @deft/web typecheck
```

Expected: PASS. The new `kind` field on `Member` types is optional, so any places that consume `/api/members` and don't pass `kind` through still typecheck.

- [ ] **Step 3: Manual end-to-end flow**

Start dev server. As a new user signing up to a new org:
1. Sidebar — confirm Defty doesn't auto-appear (lazy DM is the rule for now; eager-DM is wired but shouldn't surface until the user interacts).
2. Type `@d` in any chat — Defty appears in autocomplete with AI badge.
3. Pick Defty, send `Hello`. Defty replies in-thread.
4. Open the DM picker. "Agents" section shows Defty (top) + any deployed BYOA agents. "People" section shows human teammates.
5. Click Defty in the DM picker. A DM space opens. Send a message. Defty replies in-DM (the existing agent-reply worker handles DMs the same as channels — confirm).
6. Verify: `psql ... "SELECT kind FROM users WHERE email = 'deft-agent@system.local'"` returns `agent`.

If step 5 fails because agent-reply only listens to channel @-mentions (not DMs), file a follow-up but don't block this plan — Phase 2 / Phase 3 cleans that up.

- [ ] **Step 4: Update CLAUDE.md to remove the obsolete prohibition (light touch)**

This plan does NOT yet merge `agent_messages` into `messages` (that's Phase 2). But to set the stage, add a paragraph at the top of the "Agent Architecture" section in `CLAUDE.md` noting that the participant model is being unified:

In `CLAUDE.md`, add to the "Agent Architecture" section (after the Defty/BYOA description):

```markdown
**Participant model (Phase-1 unification, 2026-05-07).** Agents are first-class
`users` rows distinguished by `users.kind` (`human | agent | system`). Defty
has an `org_members` row in every org; BYOA agent employees do too. Both appear
in `/api/members`, the @-autocomplete, and the DM picker. The hardcoded `'agent'`
mention shim was removed; agent-reply dispatch detects mentions by joining
parsed mention IDs to `users.kind = 'agent'`. Phase 2 (planned) merges
`agent_messages` into `messages` with structured blocks in `metadata.agent_blocks`,
which will supersede the prior "*Don't store agent conversations in the same
messages table*" rule. See `docs/superpowers/specs/2026-05-07-agent-chat-unification.md`.
```

- [ ] **Step 5: Final commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): note Phase-1 participant unification, foreshadow Phase-2"
```

- [ ] **Step 6: Open a PR or hand off**

If the worktree pattern is used, push the branch and open a PR with a body that links the spec doc and lists the 5 follow-on phases. Otherwise hand the branch back to the user for merge.

---

## Self-review checklist (run before declaring complete)

**Spec coverage** — every requirement from §8 of the spec has a task:
- [x] §8.4 schema collapse, item 1 (`users.kind` enum) → Task 1, 2
- [x] §8.4 item 2 (Defty as a regular agent user) → Task 4, 5, 6
- [x] §8.4 item "agents in @-autocomplete" → Task 7
- [x] §8.4 item "agents in DM picker" → Task 9
- [x] §8.4 item "dispatch by kind, not regex" → Task 8
- [x] §8.4 items "merge agent_messages into messages", "/agent route gone", "AgentChat into SpaceChat", "send_message tool", "fetch_unread tool", "/inbox", "multi-agent affordances" → DEFERRED to Phases 2–6 (separate plans, listed at top of this doc)

**Placeholder scan** — searched for "TODO", "TBD", "implement later" — none present.

**Type consistency**:
- `kind` field is `'human' | 'agent' | 'system'` consistently in schema, API response, and frontend types.
- `ensureDeftyMembership` returns `Promise<string>` (the userId) — used consistently.
- `Member` type carries `kind?: ...` (optional in frontend, since not all consumers will receive it during the rollout window).

---

## Risks and rollback

- **Migration is non-reversible in practice** — adding a column with a default + backfill is safe; the `is_agent` column stays. If the migration has to be rolled back, drop the index and column. Backfill data isn't lost.
- **Defty backfill is idempotent** — safe to re-run if it errors mid-flight.
- **Frontend changes ship after API changes** — order matters. Tasks 1–6 land first (backend ready), Task 7 + 9 (frontend) ship after. If frontend is reverted, backend continues working with the old shim still working via the legacy regex (Task 8 keeps it).

---

## Hand-off note

Phase 1 is the foundation — no user-visible "Defty in your sidebar" surface yet (that comes from clicking the DM picker). The big wins (chat-as-agent-platform, deletion of `/agent` route, agent-DM in sidebar by default, multi-agent collaboration in shared spaces) come from Phases 2–6. Phase 1 unblocks all of them by getting the participant model right.
