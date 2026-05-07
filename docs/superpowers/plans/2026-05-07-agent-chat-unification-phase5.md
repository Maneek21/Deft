# Agent ↔ Chat Unification — Phase 5: Universal `/inbox`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build one queue at `/inbox` that aggregates everything demanding the user's attention — mentions, DM unread, watcher / task-assigned / task-updated / blocked / cross-reference / wiki-update notifications, and pending agent approvals — into a filterable, single-cursor list. Replace the standalone `/approvals` page with the **Approvals** tab inside `/inbox`. The sidebar nav entry becomes "Inbox" with one aggregated red-badge count.

**Architecture:** A single backend endpoint `GET /api/inbox` returns a unified feed of `InboxItem`s sourced from three tables — `notifications`, `space_members.last_read_at` (DM unread), and `agent_actions` (pending approvals). Each item is normalized into a common shape `{ id, kind, title, body?, link, created_at, read }` with `kind` being a discriminator (`'mention' | 'dm_unread' | 'task_assigned' | 'task_updated' | 'blocked' | 'cross_reference' | 'wiki_update' | 'system' | 'pending_approval'`). The UI is a top-level page `/inbox/page.tsx` with a tab strip (All / Mentions / DMs / Tasks / Approvals) and a virtualized list. Approvals render the existing `<AgentActionCard/>` inline; everything else renders a generic `<InboxRow/>` that links to the originating surface (chat space, task detail, wiki page, etc.).

The redirect rule: `/approvals` → `/inbox?tab=approvals` so existing bookmarks keep working. The dedicated `/approvals` page is deleted.

**Tech Stack:**
- Hono on the API side (`apps/api/src/routes/inbox.ts`)
- Drizzle ORM with three SELECTs unioned in TypeScript (Postgres `UNION ALL` with normalized projections is also acceptable; we choose TS-side merge for clarity since the three sources have very different join shapes)
- Next.js 14 App Router page (`apps/web/src/app/(app)/inbox/page.tsx`) using SWR for the feed
- Tailwind CSS, Lucide icons
- Tests: `tsx --test` (Node native) — same harness as Phases 1–4; do NOT use vitest

**Spec:** `docs/superpowers/specs/2026-05-07-agent-chat-unification.md` §8.5 + §8.7 step 5.

**Builds on Phases 1–4** (all shipped). Phase 6 follows: multi-agent affordances (Add Member modal includes agents, thread-level reply-storm detector).

---

## Discovery findings (already done)

- `notifications` table (`packages/db/src/schema.ts:392`) carries `id`, `org_id`, `user_id`, `type`, `title`, `body`, `link`, `is_read`, `metadata`, `created_at`. The `notification_type` enum (line 45) already covers: `task`, `task_assigned`, `task_updated`, `agent_suggestion`, `mention`, `message`, `reminder`, `huddle_started`, `system`, `blocked`, `cross_reference`, `workload_imbalance`, `wiki_update`, `skill_update_available`. No schema changes required — the inbox is a view over existing data.
- Mentions are written as `notifications { type: 'mention', link: '/chat?space=<id>&msg=<id>' }` from `apps/api/src/routes/messages.ts:386–425`.
- Task assignments / updates are written as `notifications { type: 'task_assigned' | 'task_updated', link: '/tasks/<key>' }` from `apps/api/src/routes/tasks.ts:487, 1008, 1390, 1762, 1793` and `apps/api/src/routes/projects.ts:606`.
- DM unread isn't a notification — it's `space_members.last_read_at < latest message.created_at` for `spaces.type IN ('dm','group_dm')`. The existing endpoint `GET /api/spaces/unread` (`apps/api/src/routes/spaces.ts:149`) returns counts per space; we reuse that logic but lift it inline so the inbox call is one roundtrip.
- Pending approvals come from `GET /api/agent/actions/pending` (`apps/api/src/routes/agent.ts:717`). The existing route returns `{ actions: PendingAction[] }`; the inbox endpoint reads from the same query.
- The `<AgentActionCard/>` component (`apps/web/src/components/agent-action-card.tsx`, extracted in Phase 4) already renders one approval card with approve/reject. Inbox reuses it for the Approvals tab and inline in the All tab.
- The sidebar nav entry currently reads `{ name: 'Approvals', href: '/approvals', icon: ShieldCheck }` (`apps/web/src/components/sidebar.tsx:81`) and uses `usePendingApprovals` for the badge. We replace it with `{ name: 'Inbox', href: '/inbox', icon: Inbox }` and a new `useInboxCount` hook.
- The existing `/approvals` page is at `apps/web/src/app/(app)/approvals/page.tsx`. We replace it with a server-side redirect (Next.js `redirect()`) to `/inbox?tab=approvals` so external links don't break.

---

## File Structure

**New backend**
- Create: `apps/api/src/routes/inbox.ts` — `GET /api/inbox?cursor=&limit=&kind=` and `POST /api/inbox/read` (mark items read).

**Modified backend**
- Modify: `apps/api/src/index.ts` — register `inboxRoutes` under `/api/inbox`.

**New frontend**
- Create: `apps/web/src/app/(app)/inbox/page.tsx` — the unified inbox page with tabs, virtualized list, mark-all-read.
- Create: `apps/web/src/components/inbox-row.tsx` — generic row renderer for non-approval inbox items.
- Create: `apps/web/src/hooks/use-inbox.ts` — SWR hook that fetches `/api/inbox` and exposes `{ items, unreadCount, mutate }`.
- Create: `apps/web/src/hooks/use-inbox-count.ts` — lightweight count-only SWR hook used by the sidebar badge (calls `/api/inbox?count_only=1`).

**Modified frontend**
- Modify: `apps/web/src/components/sidebar.tsx` — swap the `Approvals` nav entry for `Inbox`. Remove the `usePendingApprovals` import in this file (replaced by `useInboxCount`). Rename the badge title text accordingly.
- Modify: `apps/web/src/app/(app)/approvals/page.tsx` — replace with a server-side redirect to `/inbox?tab=approvals`.

**Tests**
- Create: `apps/api/test/inbox-route.test.ts` — exercises `GET /api/inbox` with multi-source aggregation, kind filter, cursor pagination, and mark-read.
- Create: `apps/api/test/inbox-count-only.test.ts` — verifies `count_only=1` returns just the aggregate count without items.
- Create: `apps/api/test/inbox-redirect.test.ts` — UI smoke is harder to assert in `tsx --test`; this file asserts that the deleted `/approvals` page is gone from the source tree (file-existence check) and that `/inbox` page exists. (Cheap, mechanical, and catches accidental reverts.)

---

## File: `inbox.ts` route — wire shape

Define this once so every task references the same types.

```typescript
// apps/api/src/routes/inbox.ts
import { Hono } from 'hono';
import { eq, and, desc, inArray, sql, lt, isNull, or } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  notifications,
  spaces,
  spaceMembers,
  messages,
  agentActions,
  agentEmployees,
} from '@deft/db/schema';

export const inboxRoutes = new Hono();

export type InboxItemKind =
  | 'mention'
  | 'dm_unread'
  | 'task_assigned'
  | 'task_updated'
  | 'blocked'
  | 'cross_reference'
  | 'wiki_update'
  | 'system'
  | 'pending_approval';

export type InboxItem = {
  id: string;                 // unique within a response: prefixed by source — e.g. 'notif:<uuid>', 'dm:<spaceId>', 'approval:<actionId>'
  kind: InboxItemKind;
  title: string;
  body: string | null;
  link: string | null;        // where the row jumps to on click
  created_at: string;         // ISO
  read: boolean;
  source: 'notification' | 'dm' | 'approval';
  // Approval-specific extras (only present when kind === 'pending_approval')
  approval?: {
    action_id: string;
    action: string;
    params: Record<string, unknown>;
    approval_tier: 'auto' | 'quick' | 'full';
    agent_employee_id: string | null;
    employee_name: string | null;
    employee_slug: string | null;
    employee_avatar: string | null;
    proposer: 'employee' | 'defty';
  };
  // DM-specific extras
  dm?: { space_id: string; unread_count: number; last_message_preview: string | null };
};

export type InboxResponse = {
  items: InboxItem[];
  unread_count: number;       // total across all kinds
  has_more: boolean;
  next_cursor: string | null; // ISO timestamp of the oldest item in this page
};
```

---

## Task 1: Backend — `GET /api/inbox` aggregator

Goal: return a unified, sorted-desc-by-created_at list of inbox items pulling from three sources. Mark which sources contribute and verify the wire shape.

**Files:**
- Create: `apps/api/src/routes/inbox.ts`
- Create: `apps/api/test/inbox-route.test.ts`

- [ ] **Step 1: Write the failing test (multi-source aggregation)**

```typescript
// apps/api/test/inbox-route.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { db } from '../src/lib/db.js';
import {
  users, orgs, orgMembers, spaces, spaceMembers, messages,
  notifications, agentActions, agentEmployees,
} from '@deft/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { inboxRoutes } from '../src/routes/inbox.js';

let testOrgId: string;
let userId: string;
let dmSpaceId: string;
let dmPartnerId: string;
let publicSpaceId: string;
const createdNotifIds: string[] = [];
const createdActionIds: string[] = [];
const createdMessageIds: string[] = [];
let app: Hono;

before(async () => {
  const ts = Date.now();
  const [org] = await db.insert(orgs).values({
    name: `inbox-test-${ts}`,
    slug: `inbox-${ts}`,
  }).returning();
  testOrgId = org.id;

  const [user] = await db.insert(users).values({
    email: `inbox-user-${ts}@test.com`,
    name: 'Inbox User',
    org_id: testOrgId,
    kind: 'human',
  }).returning();
  userId = user.id;

  const [partner] = await db.insert(users).values({
    email: `inbox-partner-${ts}@test.com`,
    name: 'DM Partner',
    org_id: testOrgId,
    kind: 'human',
  }).returning();
  dmPartnerId = partner.id;

  await db.insert(orgMembers).values([
    { org_id: testOrgId, user_id: userId, role: 'owner' },
    { org_id: testOrgId, user_id: dmPartnerId, role: 'member' },
  ]);

  const [dmSpace] = await db.insert(spaces).values({
    name: 'dm-test',
    type: 'dm',
    org_id: testOrgId,
    created_by: userId,
  }).returning();
  dmSpaceId = dmSpace.id;
  await db.insert(spaceMembers).values([
    { space_id: dmSpaceId, user_id: userId, last_read_at: new Date(Date.now() - 60_000) },
    { space_id: dmSpaceId, user_id: dmPartnerId },
  ]);

  const [publicSpace] = await db.insert(spaces).values({
    name: 'general',
    type: 'public',
    org_id: testOrgId,
    created_by: userId,
  }).returning();
  publicSpaceId = publicSpace.id;
  await db.insert(spaceMembers).values({ space_id: publicSpaceId, user_id: userId });

  // Build the test app — same auth shim style as agent-mention-detection.test.ts
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: testOrgId } as never);
    await next();
  });
  app.route('/api/inbox', inboxRoutes);
});

after(async () => {
  if (createdActionIds.length) {
    await db.delete(agentActions).where(inArray(agentActions.id, createdActionIds));
  }
  if (createdNotifIds.length) {
    await db.delete(notifications).where(inArray(notifications.id, createdNotifIds));
  }
  if (createdMessageIds.length) {
    await db.delete(messages).where(inArray(messages.id, createdMessageIds));
  }
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, dmSpaceId));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, publicSpaceId));
  await db.delete(spaces).where(eq(spaces.id, dmSpaceId));
  await db.delete(spaces).where(eq(spaces.id, publicSpaceId));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, testOrgId));
  await db.delete(users).where(inArray(users.id, [userId, dmPartnerId]));
  await db.delete(orgs).where(eq(orgs.id, testOrgId));
});

test('GET /api/inbox returns mention notifications', async () => {
  const [n] = await db.insert(notifications).values({
    org_id: testOrgId,
    user_id: userId,
    type: 'mention',
    title: 'Alice mentioned you',
    body: '@you check this out',
    link: `/chat?space=${publicSpaceId}`,
    is_read: false,
  }).returning();
  createdNotifIds.push(n.id);

  const res = await app.request('/api/inbox');
  assert.equal(res.status, 200);
  const body = await res.json() as { items: { kind: string; id: string }[] };
  const mention = body.items.find((it) => it.id === `notif:${n.id}`);
  assert.ok(mention, 'mention should appear in inbox');
  assert.equal(mention.kind, 'mention');
});

test('GET /api/inbox surfaces DM unread', async () => {
  // Partner posts a message in the DM space AFTER our last_read_at
  const [m] = await db.insert(messages).values({
    org_id: testOrgId,
    space_id: dmSpaceId,
    user_id: dmPartnerId,
    content: 'hello there',
  }).returning();
  createdMessageIds.push(m.id);

  const res = await app.request('/api/inbox');
  const body = await res.json() as { items: { kind: string; id: string; dm?: { space_id: string } }[] };
  const dm = body.items.find((it) => it.kind === 'dm_unread' && it.dm?.space_id === dmSpaceId);
  assert.ok(dm, 'DM unread should appear');
  assert.equal(dm.id, `dm:${dmSpaceId}`);
});

test('GET /api/inbox surfaces pending approvals', async () => {
  const [a] = await db.insert(agentActions).values({
    org_id: testOrgId,
    user_id: userId,
    action: 'create_task',
    params: { title: 'foo' },
    approval_status: 'pending',
    approval_tier: 'quick',
    source: 'mention',
  }).returning();
  createdActionIds.push(a.id);

  const res = await app.request('/api/inbox');
  const body = await res.json() as { items: { kind: string; id: string; approval?: { action_id: string } }[] };
  const ap = body.items.find((it) => it.kind === 'pending_approval' && it.approval?.action_id === a.id);
  assert.ok(ap, 'pending approval should appear');
  assert.equal(ap.id, `approval:${a.id}`);
});

test('GET /api/inbox sorts items desc by created_at', async () => {
  const res = await app.request('/api/inbox');
  const body = await res.json() as { items: { created_at: string }[] };
  for (let i = 1; i < body.items.length; i++) {
    const prev = new Date(body.items[i - 1].created_at).getTime();
    const cur = new Date(body.items[i].created_at).getTime();
    assert.ok(prev >= cur, `expected desc; got ${body.items[i - 1].created_at} before ${body.items[i].created_at}`);
  }
});
```

- [ ] **Step 2: Run the test, confirm it fails (route file does not exist yet)**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/inbox-route.test.ts
```

Expected: FAIL — `Cannot find module '../src/routes/inbox.js'` (because the file doesn't exist).

- [ ] **Step 3: Implement `inboxRoutes`**

```typescript
// apps/api/src/routes/inbox.ts
import { Hono } from 'hono';
import { eq, and, desc, sql, lt, gt, inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  notifications,
  spaces,
  spaceMembers,
  messages,
  agentActions,
  agentEmployees,
  users,
} from '@deft/db/schema';

export const inboxRoutes = new Hono();

export type InboxItemKind =
  | 'mention'
  | 'dm_unread'
  | 'task_assigned'
  | 'task_updated'
  | 'blocked'
  | 'cross_reference'
  | 'wiki_update'
  | 'system'
  | 'pending_approval';

export type InboxItem = {
  id: string;
  kind: InboxItemKind;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read: boolean;
  source: 'notification' | 'dm' | 'approval';
  approval?: {
    action_id: string;
    action: string;
    params: Record<string, unknown>;
    approval_tier: 'auto' | 'quick' | 'full';
    agent_employee_id: string | null;
    employee_name: string | null;
    employee_slug: string | null;
    employee_avatar: string | null;
    proposer: 'employee' | 'defty';
  };
  dm?: { space_id: string; unread_count: number; last_message_preview: string | null };
};

const NOTIF_KIND_MAP: Record<string, InboxItemKind> = {
  mention: 'mention',
  task_assigned: 'task_assigned',
  task_updated: 'task_updated',
  blocked: 'blocked',
  cross_reference: 'cross_reference',
  wiki_update: 'wiki_update',
  system: 'system',
  task: 'task_updated', // legacy alias
  message: 'mention',   // treat generic message-bell as a mention-like surface
  reminder: 'system',
  huddle_started: 'system',
  workload_imbalance: 'system',
  agent_suggestion: 'system',
  skill_update_available: 'system',
};

inboxRoutes.get('/', async (c) => {
  try {
    const user = c.get('user') as { id: string; org_id: string };
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
    const cursor = c.req.query('cursor'); // ISO; we return rows older than this
    const kindFilter = c.req.query('kind') as InboxItemKind | undefined;
    const countOnly = c.req.query('count_only') === '1';

    // Auto-expire stale pending agent actions (24h) before reading them — same
    // policy as /api/agent/actions/pending.
    await db.update(agentActions)
      .set({ approval_status: 'expired' })
      .where(and(
        eq(agentActions.org_id, user.org_id),
        eq(agentActions.approval_status, 'pending'),
        lt(agentActions.created_at, new Date(Date.now() - 24 * 60 * 60 * 1000)),
      ));

    // ── Source 1: notifications ──────────────────────────────────────────
    const notifRows = countOnly
      ? []
      : await db.select()
          .from(notifications)
          .where(and(
            eq(notifications.user_id, user.id),
            eq(notifications.org_id, user.org_id),
            cursor ? lt(notifications.created_at, new Date(cursor)) : sql`TRUE`,
          ))
          .orderBy(desc(notifications.created_at))
          .limit(limit);

    const notifItems: InboxItem[] = notifRows.map((n) => ({
      id: `notif:${n.id}`,
      kind: NOTIF_KIND_MAP[n.type as string] ?? 'system',
      title: n.title,
      body: n.body ?? null,
      link: n.link ?? null,
      created_at: (n.created_at instanceof Date ? n.created_at : new Date(n.created_at as unknown as string)).toISOString(),
      read: n.is_read,
      source: 'notification',
    }));

    // ── Source 2: DM unread (per-space rollup) ───────────────────────────
    const dmSpaces = await db.select({
      space_id: spaceMembers.space_id,
      last_read_at: spaceMembers.last_read_at,
      space_name: spaces.name,
      space_type: spaces.type,
    })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaceMembers.space_id, spaces.id))
      .where(and(
        eq(spaceMembers.user_id, user.id),
        eq(spaces.org_id, user.org_id),
        eq(spaces.is_archived, false),
        sql`${spaces.type} IN ('dm','group_dm')`,
      ));

    const dmItems: InboxItem[] = [];
    for (const s of dmSpaces) {
      const lastRead = s.last_read_at ?? new Date(0);
      const [agg] = await db.select({
        count: sql<number>`count(*)::int`,
        latest: sql<Date | null>`MAX(${messages.created_at})`,
        preview: sql<string | null>`(SELECT content FROM ${messages} WHERE space_id = ${s.space_id} AND user_id <> ${user.id} AND is_deleted = false ORDER BY created_at DESC LIMIT 1)`,
      })
        .from(messages)
        .where(and(
          eq(messages.space_id, s.space_id),
          gt(messages.created_at, lastRead),
          eq(messages.is_deleted, false),
          sql`${messages.user_id} != ${user.id}`,
          sql`${messages.parent_id} IS NULL`,
        ));
      const count = agg?.count ?? 0;
      if (count <= 0) continue;
      dmItems.push({
        id: `dm:${s.space_id}`,
        kind: 'dm_unread',
        title: `${count} unread message${count === 1 ? '' : 's'} in ${s.space_name ?? 'DM'}`,
        body: agg.preview,
        link: `/chat?space=${s.space_id}`,
        created_at: (agg.latest instanceof Date ? agg.latest : new Date()).toISOString(),
        read: false,
        source: 'dm',
        dm: { space_id: s.space_id, unread_count: count, last_message_preview: agg.preview },
      });
    }

    // ── Source 3: pending approvals ──────────────────────────────────────
    const approvalRows = await db.select({
      id: agentActions.id,
      action: agentActions.action,
      params: agentActions.params,
      approval_tier: agentActions.approval_tier,
      created_at: agentActions.created_at,
      agent_employee_id: agentActions.agent_employee_id,
      employee_name: agentEmployees.name,
      employee_slug: agentEmployees.slug,
      employee_avatar: agentEmployees.avatar_url,
    })
      .from(agentActions)
      .leftJoin(agentEmployees, eq(agentActions.agent_employee_id, agentEmployees.id))
      .where(and(
        eq(agentActions.org_id, user.org_id),
        eq(agentActions.approval_status, 'pending'),
      ))
      .orderBy(desc(agentActions.created_at))
      .limit(limit);

    const approvalItems: InboxItem[] = approvalRows.map((r) => ({
      id: `approval:${r.id}`,
      kind: 'pending_approval',
      title: r.employee_name ? `${r.employee_name} proposes: ${r.action}` : `Defty proposes: ${r.action}`,
      body: null,
      link: `/inbox?tab=approvals&action=${r.id}`,
      created_at: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at as unknown as string)).toISOString(),
      read: false,
      source: 'approval',
      approval: {
        action_id: r.id,
        action: r.action,
        params: (r.params ?? {}) as Record<string, unknown>,
        approval_tier: r.approval_tier as 'auto' | 'quick' | 'full',
        agent_employee_id: r.agent_employee_id,
        employee_name: r.employee_name,
        employee_slug: r.employee_slug,
        employee_avatar: r.employee_avatar,
        proposer: r.agent_employee_id ? 'employee' : 'defty',
      },
    }));

    // Merge + sort
    const all = [...notifItems, ...dmItems, ...approvalItems]
      .filter((it) => !kindFilter || it.kind === kindFilter)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const unreadCount = all.filter((it) => !it.read).length;

    if (countOnly) {
      return c.json({ unread_count: unreadCount });
    }

    const items = all.slice(0, limit);
    const nextCursor = items.length === limit ? items[items.length - 1].created_at : null;

    return c.json({
      items,
      unread_count: unreadCount,
      has_more: nextCursor !== null,
      next_cursor: nextCursor,
    });
  } catch (err) {
    console.error('Failed to fetch inbox:', err);
    return c.json({ error: 'Failed to fetch inbox', code: 'INTERNAL_ERROR' }, 500);
  }
});
```

- [ ] **Step 4: Register the route**

In `apps/api/src/index.ts`, import `inboxRoutes` and mount it. Find the section where other routes (notifications, messages, agent) are mounted and add:

```typescript
import { inboxRoutes } from './routes/inbox.js';
// ...
app.route('/api/inbox', inboxRoutes);
```

- [ ] **Step 5: Run the test, confirm it passes**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/inbox-route.test.ts
```

Expected: PASS — all four cases (mention, dm, approval, sort) green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/inbox.ts apps/api/src/index.ts apps/api/test/inbox-route.test.ts
git commit -m "feat(api): GET /api/inbox unified queue (mentions + DMs + approvals)"
```

---

## Task 2: Backend — `count_only=1` and `kind=` filter

Goal: sidebar badge fetch should be cheap; an explicit `count_only=1` skips the row payload. The existing route already implements both branches in Task 1; this task adds dedicated test coverage so the hooks in Tasks 6–7 have a contract to depend on.

**Files:**
- Create: `apps/api/test/inbox-count-only.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/inbox-count-only.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers, notifications, agentActions } from '@deft/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { inboxRoutes } from '../src/routes/inbox.js';

let testOrgId: string;
let userId: string;
let app: Hono;
const createdNotifIds: string[] = [];
const createdActionIds: string[] = [];

before(async () => {
  const ts = Date.now();
  const [org] = await db.insert(orgs).values({ name: `count-${ts}`, slug: `count-${ts}` }).returning();
  testOrgId = org.id;
  const [u] = await db.insert(users).values({
    email: `count-${ts}@test.com`, name: 'C', org_id: testOrgId, kind: 'human',
  }).returning();
  userId = u.id;
  await db.insert(orgMembers).values({ org_id: testOrgId, user_id: userId, role: 'owner' });

  const [n] = await db.insert(notifications).values({
    org_id: testOrgId, user_id: userId, type: 'mention', title: 'x', is_read: false,
  }).returning();
  createdNotifIds.push(n.id);

  const [a] = await db.insert(agentActions).values({
    org_id: testOrgId, user_id: userId, action: 'create_task', params: {},
    approval_status: 'pending', approval_tier: 'quick', source: 'mention',
  }).returning();
  createdActionIds.push(a.id);

  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: testOrgId } as never);
    await next();
  });
  app.route('/api/inbox', inboxRoutes);
});

after(async () => {
  if (createdActionIds.length) await db.delete(agentActions).where(inArray(agentActions.id, createdActionIds));
  if (createdNotifIds.length) await db.delete(notifications).where(inArray(notifications.id, createdNotifIds));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, testOrgId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(orgs).where(eq(orgs.id, testOrgId));
});

test('count_only=1 returns just unread_count, no items', async () => {
  const res = await app.request('/api/inbox?count_only=1');
  assert.equal(res.status, 200);
  const body = await res.json() as { unread_count: number; items?: unknown };
  assert.equal(typeof body.unread_count, 'number');
  assert.ok(body.unread_count >= 2, `expected ≥2 (mention + approval), got ${body.unread_count}`);
  assert.equal(body.items, undefined);
});

test('kind=mention filters out approvals and DM unread', async () => {
  const res = await app.request('/api/inbox?kind=mention');
  assert.equal(res.status, 200);
  const body = await res.json() as { items: { kind: string }[] };
  for (const it of body.items) {
    assert.equal(it.kind, 'mention');
  }
});

test('kind=pending_approval filters out notifications', async () => {
  const res = await app.request('/api/inbox?kind=pending_approval');
  assert.equal(res.status, 200);
  const body = await res.json() as { items: { kind: string }[] };
  for (const it of body.items) {
    assert.equal(it.kind, 'pending_approval');
  }
});
```

- [ ] **Step 2: Run, confirm pass**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/inbox-count-only.test.ts
```

Expected: PASS — Task 1's implementation already covers both branches. If a test fails, re-read Task 1 step 3 and fix the route.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/inbox-count-only.test.ts
git commit -m "test(api): inbox count_only + kind filter coverage"
```

---

## Task 3: Backend — `POST /api/inbox/read` (mark items read)

Goal: a single endpoint that flips `notifications.is_read = true` for an array of notification IDs (or all). DM unread is implicitly cleared by visiting `/chat?space=<id>` (no separate write here). Approvals don't carry a read flag — they vanish when approved/rejected/expired.

**Files:**
- Modify: `apps/api/src/routes/inbox.ts`
- Modify: `apps/api/test/inbox-route.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/inbox-route.test.ts`:

```typescript
test('POST /api/inbox/read marks specific notifications read', async () => {
  const [n1] = await db.insert(notifications).values({
    org_id: testOrgId, user_id: userId, type: 'task_assigned',
    title: 'Task X', is_read: false,
  }).returning();
  const [n2] = await db.insert(notifications).values({
    org_id: testOrgId, user_id: userId, type: 'task_assigned',
    title: 'Task Y', is_read: false,
  }).returning();
  createdNotifIds.push(n1.id, n2.id);

  const res = await app.request('/api/inbox/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [`notif:${n1.id}`] }),
  });
  assert.equal(res.status, 200);

  const [after1] = await db.select().from(notifications).where(eq(notifications.id, n1.id));
  const [after2] = await db.select().from(notifications).where(eq(notifications.id, n2.id));
  assert.equal(after1.is_read, true);
  assert.equal(after2.is_read, false);
});

test('POST /api/inbox/read with all=true marks everything read', async () => {
  const [n] = await db.insert(notifications).values({
    org_id: testOrgId, user_id: userId, type: 'task_assigned',
    title: 'Z', is_read: false,
  }).returning();
  createdNotifIds.push(n.id);

  const res = await app.request('/api/inbox/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ all: true }),
  });
  assert.equal(res.status, 200);

  const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
  assert.equal(after.is_read, true);
});

test('POST /api/inbox/read scoped to current user only', async () => {
  // Insert a notification for a DIFFERENT user — it must NOT be marked read.
  const [otherUser] = await db.insert(users).values({
    email: `other-${Date.now()}@test.com`, name: 'O', org_id: testOrgId, kind: 'human',
  }).returning();
  const [n] = await db.insert(notifications).values({
    org_id: testOrgId, user_id: otherUser.id, type: 'mention',
    title: 'cross-user', is_read: false,
  }).returning();

  const res = await app.request('/api/inbox/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [`notif:${n.id}`] }),
  });
  assert.equal(res.status, 200);

  const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
  assert.equal(after.is_read, false, 'other-user notif must not be flipped');

  await db.delete(notifications).where(eq(notifications.id, n.id));
  await db.delete(users).where(eq(users.id, otherUser.id));
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/inbox-route.test.ts
```

Expected: FAIL on the new tests — endpoint not implemented (404).

- [ ] **Step 3: Implement `POST /api/inbox/read`**

Append to `apps/api/src/routes/inbox.ts`:

```typescript
inboxRoutes.post('/read', async (c) => {
  try {
    const user = c.get('user') as { id: string; org_id: string };
    const body = await c.req.json().catch(() => ({})) as { ids?: string[]; all?: boolean };

    if (body.all) {
      await db.update(notifications)
        .set({ is_read: true })
        .where(and(
          eq(notifications.user_id, user.id),
          eq(notifications.org_id, user.org_id),
          eq(notifications.is_read, false),
        ));
      return c.json({ success: true });
    }

    const notifIds = (body.ids ?? [])
      .filter((id) => id.startsWith('notif:'))
      .map((id) => id.slice('notif:'.length));

    if (notifIds.length === 0) {
      return c.json({ success: true, updated: 0 });
    }

    const updated = await db.update(notifications)
      .set({ is_read: true })
      .where(and(
        inArray(notifications.id, notifIds),
        eq(notifications.user_id, user.id),
        eq(notifications.org_id, user.org_id),
      ))
      .returning({ id: notifications.id });

    return c.json({ success: true, updated: updated.length });
  } catch (err) {
    console.error('Failed to mark inbox read:', err);
    return c.json({ error: 'Failed to mark read', code: 'INTERNAL_ERROR' }, 500);
  }
});
```

- [ ] **Step 4: Run, confirm pass**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/inbox-route.test.ts
```

Expected: PASS — all original + 3 new tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/inbox.ts apps/api/test/inbox-route.test.ts
git commit -m "feat(api): POST /api/inbox/read mark notifications read"
```

---

## Task 4: Frontend — `useInbox` SWR hook

Goal: client hook that owns the inbox feed + mark-read mutations. Used by the page; no UI yet.

**Files:**
- Create: `apps/web/src/hooks/use-inbox.ts`

- [ ] **Step 1: Write the hook**

```typescript
// apps/web/src/hooks/use-inbox.ts
'use client';

import useSWR from 'swr';
import { useCallback } from 'react';
import { api } from '@/lib/api';

export type InboxItemKind =
  | 'mention' | 'dm_unread' | 'task_assigned' | 'task_updated'
  | 'blocked' | 'cross_reference' | 'wiki_update' | 'system' | 'pending_approval';

export type InboxItem = {
  id: string;
  kind: InboxItemKind;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read: boolean;
  source: 'notification' | 'dm' | 'approval';
  approval?: {
    action_id: string;
    action: string;
    params: Record<string, unknown>;
    approval_tier: 'auto' | 'quick' | 'full';
    agent_employee_id: string | null;
    employee_name: string | null;
    employee_slug: string | null;
    employee_avatar: string | null;
    proposer: 'employee' | 'defty';
  };
  dm?: { space_id: string; unread_count: number; last_message_preview: string | null };
};

type InboxResponse = {
  items: InboxItem[];
  unread_count: number;
  has_more: boolean;
  next_cursor: string | null;
};

async function fetchInbox(url: string): Promise<InboxResponse> {
  const res = await api.get(url);
  if (!res.ok) {
    return { items: [], unread_count: 0, has_more: false, next_cursor: null };
  }
  return (await res.json()) as InboxResponse;
}

export function useInbox(kind?: InboxItemKind) {
  const url = kind ? `/api/inbox?kind=${kind}` : '/api/inbox';
  const { data, mutate, isLoading } = useSWR<InboxResponse>(url, fetchInbox, {
    refreshInterval: 15_000,
    revalidateOnFocus: true,
    fallbackData: { items: [], unread_count: 0, has_more: false, next_cursor: null },
  });

  const markRead = useCallback(async (ids: string[]) => {
    await api.post('/api/inbox/read', { ids });
    void mutate();
  }, [mutate]);

  const markAllRead = useCallback(async () => {
    await api.post('/api/inbox/read', { all: true });
    void mutate();
  }, [mutate]);

  return {
    items: data?.items ?? [],
    unreadCount: data?.unread_count ?? 0,
    hasMore: data?.has_more ?? false,
    isLoading,
    markRead,
    markAllRead,
    refresh: mutate,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/hooks/use-inbox.ts
git commit -m "feat(web): useInbox SWR hook"
```

---

## Task 5: Frontend — `useInboxCount` lightweight badge hook

Goal: a count-only hook used by the sidebar so the badge update path doesn't pull the whole feed every 15s.

**Files:**
- Create: `apps/web/src/hooks/use-inbox-count.ts`

- [ ] **Step 1: Write the hook**

```typescript
// apps/web/src/hooks/use-inbox-count.ts
'use client';

import useSWR from 'swr';
import { api } from '@/lib/api';

async function fetchCount(): Promise<number> {
  const res = await api.get('/api/inbox?count_only=1');
  if (!res.ok) return 0;
  const body = (await res.json()) as { unread_count?: number };
  return body.unread_count ?? 0;
}

export function useInboxCount() {
  const { data } = useSWR<number>(
    '/api/inbox?count_only=1',
    fetchCount,
    { refreshInterval: 15_000, revalidateOnFocus: true, fallbackData: 0 },
  );
  const count = data ?? 0;
  return { count, hasUnread: count > 0 };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/hooks/use-inbox-count.ts
git commit -m "feat(web): useInboxCount lightweight badge hook"
```

---

## Task 6: Frontend — `<InboxRow/>` generic renderer

Goal: a per-row component for non-approval inbox items. Approvals reuse the existing `<AgentActionCard/>`.

**Files:**
- Create: `apps/web/src/components/inbox-row.tsx`

- [ ] **Step 1: Write the component**

```typescript
// apps/web/src/components/inbox-row.tsx
'use client';

import Link from 'next/link';
import { formatRelative } from '@/lib/time';
import {
  AtSign, MessageSquare, CheckSquare, AlertTriangle, Link as LinkIcon,
  BookOpen, Bell,
} from 'lucide-react';
import type { InboxItem, InboxItemKind } from '@/hooks/use-inbox';

const KIND_ICON: Record<InboxItemKind, typeof AtSign> = {
  mention: AtSign,
  dm_unread: MessageSquare,
  task_assigned: CheckSquare,
  task_updated: CheckSquare,
  blocked: AlertTriangle,
  cross_reference: LinkIcon,
  wiki_update: BookOpen,
  system: Bell,
  pending_approval: Bell, // not used here — approvals use AgentActionCard
};

type Props = {
  item: InboxItem;
  onClick?: () => void; // mark-read on visit
};

export function InboxRow({ item, onClick }: Props) {
  const Icon = KIND_ICON[item.kind] ?? Bell;
  const content = (
    <div
      className="flex items-start gap-3 px-4 py-3 rounded-lg cursor-pointer"
      style={{
        background: item.read ? 'transparent' : 'var(--bg-active)',
        borderLeft: item.read ? '2px solid transparent' : '2px solid var(--primary)',
      }}
    >
      <Icon size={16} strokeWidth={1.5} style={{ color: 'var(--primary)', marginTop: 2 }} />
      <div className="flex-1 min-w-0">
        <div
          className="text-[13px] font-medium truncate"
          style={{ color: 'var(--on-surface)', fontWeight: item.read ? 400 : 600 }}
        >
          {item.title}
        </div>
        {item.body && (
          <div className="text-[12px] mt-0.5 line-clamp-2" style={{ color: 'var(--muted)' }}>
            {item.body}
          </div>
        )}
        <div className="text-[11px] mt-1" style={{ color: 'var(--outline)' }}>
          {formatRelative(item.created_at)}
        </div>
      </div>
    </div>
  );

  if (item.link) {
    return (
      <Link href={item.link} onClick={onClick}>
        {content}
      </Link>
    );
  }
  return <div onClick={onClick}>{content}</div>;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/inbox-row.tsx
git commit -m "feat(web): InboxRow generic renderer"
```

---

## Task 7: Frontend — `/inbox/page.tsx` page

Goal: the main page. Tab strip (All / Mentions / DMs / Tasks / Approvals), virtualized list (we keep it simple for now — `items.map`; add virtualization later if needed), mark-all-read button.

**Files:**
- Create: `apps/web/src/app/(app)/inbox/page.tsx`

- [ ] **Step 1: Write the page**

```typescript
// apps/web/src/app/(app)/inbox/page.tsx
'use client';

import { useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useInbox, type InboxItemKind } from '@/hooks/use-inbox';
import { InboxRow } from '@/components/inbox-row';
import { AgentActionCard, type AgentAction } from '@/components/agent-action-card';
import { api } from '@/lib/api';

type Tab = 'all' | 'mentions' | 'dms' | 'tasks' | 'approvals';

const TAB_TO_KIND: Record<Tab, InboxItemKind | undefined> = {
  all: undefined,
  mentions: 'mention',
  dms: 'dm_unread',
  tasks: 'task_assigned',     // Tasks tab shows assigned + updated (handled below)
  approvals: 'pending_approval',
};

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mentions', label: 'Mentions' },
  { id: 'dms', label: 'DMs' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'approvals', label: 'Approvals' },
];

export default function InboxPage() {
  const params = useSearchParams();
  const initialTab = (params.get('tab') as Tab) ?? 'all';
  const [tab, setTab] = useState<Tab>(initialTab);

  // For 'tasks' we want both task_assigned and task_updated. We fetch all and filter
  // client-side for that tab; for the others we pass kind to the API.
  const apiKind = tab === 'tasks' ? undefined : TAB_TO_KIND[tab];
  const { items, unreadCount, isLoading, markRead, markAllRead, refresh } = useInbox(apiKind);

  const filtered = useMemo(() => {
    if (tab === 'tasks') {
      return items.filter((it) => it.kind === 'task_assigned' || it.kind === 'task_updated');
    }
    return items;
  }, [items, tab]);

  const handleApprove = useCallback(
    async (id: string) => {
      const res = await api.post(`/api/agent/actions/${id}/approve`, {});
      if (res.ok) void refresh();
    },
    [refresh],
  );

  const handleReject = useCallback(
    async (id: string) => {
      const res = await api.post(`/api/agent/actions/${id}/reject`, {});
      if (res.ok) void refresh();
    },
    [refresh],
  );

  const handleRowClick = useCallback(
    (id: string) => () => {
      void markRead([id]);
    },
    [markRead],
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[760px] mx-auto px-6 py-8">
        <header className="mb-6 flex items-end justify-between">
          <div>
            <h1
              className="text-[20px] font-semibold"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
            >
              Inbox
            </h1>
            <p className="text-[13px] mt-1" style={{ color: 'var(--muted)' }}>
              {unreadCount > 0
                ? `${unreadCount} unread item${unreadCount === 1 ? '' : 's'}`
                : 'You\'re caught up.'}
            </p>
          </div>
          {unreadCount > 0 && (
            <button
              onClick={() => void markAllRead()}
              className="text-[12px] px-3 py-1.5 rounded-md"
              style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}
            >
              Mark all read
            </button>
          )}
        </header>

        {/* Tab strip */}
        <nav className="flex gap-1 mb-5 border-b" style={{ borderColor: 'var(--border)' }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="text-[13px] px-3 py-2 -mb-px"
              style={{
                color: tab === t.id ? 'var(--primary)' : 'var(--muted)',
                borderBottom: tab === t.id ? '2px solid var(--primary)' : '2px solid transparent',
                fontWeight: tab === t.id ? 600 : 400,
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Body */}
        {isLoading ? (
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>Loading...</p>
        ) : filtered.length === 0 ? (
          <div
            className="text-[13px] py-12 text-center rounded-lg"
            style={{ color: 'var(--muted)', border: '1px dashed var(--border)' }}
          >
            Nothing here.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((item) => {
              if (item.kind === 'pending_approval' && item.approval) {
                const action: AgentAction = {
                  id: item.approval.action_id,
                  action: item.approval.action,
                  params: item.approval.params,
                };
                return (
                  <AgentActionCard
                    key={item.id}
                    action={action}
                    onApprove={() => handleApprove(item.approval!.action_id)}
                    onReject={() => handleReject(item.approval!.action_id)}
                  />
                );
              }
              return (
                <InboxRow
                  key={item.id}
                  item={item}
                  onClick={handleRowClick(item.id)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/(app)/inbox/page.tsx
git commit -m "feat(web): /inbox page — tabs + unified feed"
```

---

## Task 8: Frontend — sidebar nav swap (Approvals → Inbox)

Goal: replace the `Approvals` entry with `Inbox` and switch the badge hook.

**Files:**
- Modify: `apps/web/src/components/sidebar.tsx`

- [ ] **Step 1: Replace import + nav entry + badge hook**

In `apps/web/src/components/sidebar.tsx`:

1. Replace `import { usePendingApprovals } from '@/hooks/use-pending-approvals';` with `import { useInboxCount } from '@/hooks/use-inbox-count';`. (Leave `usePendingApprovals` itself in place — Phase 4 still uses it from `space-chat.tsx`. We're only swapping THIS file's usage.)

2. In the lucide-react import block, add `Inbox`. Remove `ShieldCheck` from the import only if it's no longer referenced anywhere else in the file (search for it).

3. In the `navItems` array, change the `Approvals` entry:

```typescript
// before
{ name: 'Approvals', href: '/approvals', icon: ShieldCheck },
// after
{ name: 'Inbox', href: '/inbox', icon: Inbox },
```

4. Inside the `Sidebar` component body, find where `usePendingApprovals` is called (search for `pendingApprovalCount`):

```typescript
// before
const { count: pendingApprovalCount } = usePendingApprovals();
// after
const { count: inboxCount } = useInboxCount();
```

5. In the JSX render where the Approvals badge was rendered (`{item.name === 'Approvals' && pendingApprovalCount > 0 && ...}`), update both the name match and the variable:

```typescript
{item.name === 'Inbox' && inboxCount > 0 && (
  <div
    className="ml-auto min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white px-1"
    style={{ background: 'var(--danger, #ef4444)' }}
    title={`${inboxCount} unread item${inboxCount === 1 ? '' : 's'}`}
  >
    {inboxCount > 99 ? '99+' : inboxCount}
  </div>
)}
```

- [ ] **Step 2: Verify with grep**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -n "pendingApprovalCount\|usePendingApprovals\|name: 'Approvals'\|href: '/approvals'" apps/web/src/components/sidebar.tsx
```

Expected: zero matches in `sidebar.tsx`. (`usePendingApprovals` may still appear in `space-chat.tsx` or the hook's own file — that's fine.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/sidebar.tsx
git commit -m "feat(web): sidebar — Inbox replaces Approvals nav entry"
```

---

## Task 9: Frontend — redirect `/approvals` → `/inbox?tab=approvals`

Goal: keep external bookmarks and any in-app links from breaking.

**Files:**
- Modify: `apps/web/src/app/(app)/approvals/page.tsx`

- [ ] **Step 1: Replace the page with a server-side redirect**

Overwrite `apps/web/src/app/(app)/approvals/page.tsx` entirely with:

```typescript
import { redirect } from 'next/navigation';

export default function ApprovalsRedirect() {
  redirect('/inbox?tab=approvals');
}
```

This is a server component (no `'use client'`). Next.js sees the synchronous `redirect()` call and emits a 307 to `/inbox?tab=approvals`.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/(app)/approvals/page.tsx
git commit -m "feat(web): /approvals → /inbox?tab=approvals redirect"
```

---

## Task 10: Test — file structure assertions

Goal: lock in that the new files exist and old paths are either deleted or redirecting. Cheap regression-catcher.

**Files:**
- Create: `apps/api/test/inbox-redirect.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// apps/api/test/inbox-redirect.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.', '..', '..', '..');

test('inbox page exists', () => {
  const p = resolve(ROOT, 'apps/web/src/app/(app)/inbox/page.tsx');
  assert.ok(existsSync(p), `expected ${p} to exist`);
  const src = readFileSync(p, 'utf8');
  assert.ok(src.includes('useInbox'), 'page should consume useInbox hook');
});

test('approvals page is a redirect, not a full inbox', () => {
  const p = resolve(ROOT, 'apps/web/src/app/(app)/approvals/page.tsx');
  assert.ok(existsSync(p), 'approvals page must still exist as a redirect shim');
  const src = readFileSync(p, 'utf8');
  assert.ok(src.includes('/inbox?tab=approvals'), 'should redirect to inbox tab');
  assert.ok(src.includes('redirect('), 'should call next/navigation redirect()');
  assert.ok(!src.includes('AgentActionCard'), 'should NOT render approval cards anymore');
});

test('inbox row component exists', () => {
  const p = resolve(ROOT, 'apps/web/src/components/inbox-row.tsx');
  assert.ok(existsSync(p));
});

test('inbox hook exists', () => {
  const p = resolve(ROOT, 'apps/web/src/hooks/use-inbox.ts');
  assert.ok(existsSync(p));
});

test('inbox count hook exists', () => {
  const p = resolve(ROOT, 'apps/web/src/hooks/use-inbox-count.ts');
  assert.ok(existsSync(p));
});

test('sidebar uses Inbox not Approvals', () => {
  const p = resolve(ROOT, 'apps/web/src/components/sidebar.tsx');
  const src = readFileSync(p, 'utf8');
  assert.ok(src.includes("name: 'Inbox'"), "sidebar should declare Inbox nav entry");
  assert.ok(src.includes("href: '/inbox'"), "sidebar should point to /inbox");
  assert.ok(!src.match(/name:\s*'Approvals'/), 'sidebar should NOT have Approvals nav entry');
  assert.ok(src.includes('useInboxCount'), 'sidebar should use useInboxCount badge hook');
});
```

- [ ] **Step 2: Run, confirm pass**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/inbox-redirect.test.ts
```

Expected: PASS — all 6 assertions green.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/inbox-redirect.test.ts
git commit -m "test: inbox file-structure regression locks"
```

---

## Task 11: Smoke — full test suite + dev-server visit

Goal: prove the whole inbox flow works end-to-end before moving to Phase 6.

- [ ] **Step 1: Run all inbox-touching tests**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/inbox-route.test.ts test/inbox-count-only.test.ts test/inbox-redirect.test.ts
```

Expected: ALL PASS. If any fail, fix before continuing.

- [ ] **Step 2: Start dev servers**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm dev
```

Wait for "ready" on both web (`http://localhost:3000`) and api (`http://localhost:3001`).

- [ ] **Step 3: Manual UI smoke (or Playwright)**

Visit `http://localhost:3000/inbox` after logging in as the dev test user (`maneek@test.com`). Verify:
- Page renders with the `Inbox` heading
- Tab strip shows All / Mentions / DMs / Tasks / Approvals
- Sidebar shows `Inbox` (not `Approvals`) as a nav entry
- Sidebar badge shows a number if there are pending approvals or unread notifications
- Visiting `http://localhost:3000/approvals` redirects (307) to `/inbox?tab=approvals`
- Clicking an approval card's Approve button removes it from the list
- Clicking a non-approval row navigates to its `link` and the row disappears from the unread set on next refresh

- [ ] **Step 4: Update CLAUDE.md**

Append a Phase 5 paragraph in the `Agent Architecture` section after the Phase 4 paragraph:

```markdown
**Phase 5 (2026-05-07).** Universal `/inbox`: one queue at `/inbox`
unifies notifications (mentions, task_assigned, task_updated, blocked,
cross_reference, wiki_update, system), DM unread (per-space rollup
from `space_members.last_read_at`), and pending agent approvals (from
`agent_actions`). Backed by `GET /api/inbox` (with `count_only=1` for
the badge fetch and `kind=` filter for tabs) and `POST /api/inbox/read`
for mark-read. Tab strip: All / Mentions / DMs / Tasks / Approvals.
Approval rows render the existing `<AgentActionCard/>`; everything else
renders `<InboxRow/>`. The sidebar `Approvals` entry is replaced by
`Inbox` with one aggregated red-badge count via `useInboxCount`.
`/approvals` is a server redirect to `/inbox?tab=approvals` so existing
links keep working.
```

- [ ] **Step 5: Commit + plan-doc commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): note Phase 5 universal inbox"

git add docs/superpowers/plans/2026-05-07-agent-chat-unification-phase5.md
git commit -m "docs(plans): Phase 5 plan"
```

---

## Hand-off

Phase 5 ships the unified attention queue. Phase 6 (next) builds the multi-agent affordances:
- Add Member modal includes agents (so users can add Defty/BYOA agents to channels and group DMs)
- Thread-level reply-storm detector (suppress runaway agent loops in long threads)
- Agent participant indicator on the channel header (so humans see when an agent is active in a channel)

Phase 5's plumbing — single feed, single badge, single read endpoint — gives Phase 6 a clean place to also surface agent-driven activity (e.g., new agent participant in a channel notifications) without inventing another stream.

---

## Self-review checklist

- [x] Spec coverage: §8.7 step 5 (Universal /inbox) is fully covered by Tasks 1–10. The hand-off section and CLAUDE.md update document Phase 6 dependencies.
- [x] Placeholder scan: no TBDs or "implement appropriately"; every code block is concrete.
- [x] Type consistency: `InboxItem` shape is identical between `inbox.ts` (server) and `use-inbox.ts` (client). `InboxItemKind` enum matches across files. `notif:`/`dm:`/`approval:` ID prefix is used consistently in `POST /api/inbox/read` parsing.
- [x] No new schema migrations — the inbox is a pure read-side aggregator over existing tables (`notifications`, `space_members`, `messages`, `agent_actions`, `agent_employees`).
- [x] Tests use `node:test` (NOT vitest), matching the harness used in Phases 1–4.
- [x] Worktree path `C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification` is used in every Bash step.
