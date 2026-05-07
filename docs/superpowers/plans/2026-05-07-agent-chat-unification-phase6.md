# Agent ↔ Chat Unification — Phase 6: Multi-Agent Affordances

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make multi-agent participation in chat surfaces safe and legible. Agents appear as a separate badged section in the channel "Add members" picker; agent thread replies are throttled to 5 per thread per 10 minutes via a `STORM_DETECTED` tool error so agents can back off.

**Architecture:** One new pure helper (`storm-detector.ts`), guards added at two existing agent post-message sites (BYOA `sendMessage` in `mcp-tools/writes.ts` and Defty `post_thread_reply` case in `agent-actions.ts`), one members-panel UI partition that consumes the existing `kind` field on `/api/members`, and a small `<AIBadge/>` component extracted from inline JSX in the Phase 4 `CreateDmModal`.

**Tech Stack:**
- Hono + Drizzle ORM (`apps/api/src/lib/storm-detector.ts`, `mcp-tools/writes.ts`, `agent-actions.ts`)
- Next.js 14 client component + Tailwind + Lucide icons (`apps/web/src/components/space-members-panel.tsx`, `create-dm-modal.tsx`, new `ai-badge.tsx`)
- Tests: `tsx --test` (Node native) — same harness as Phases 1–5; do NOT use vitest

**Spec:** `docs/superpowers/specs/2026-05-07-agent-chat-unification-phase6-design.md`

**Builds on Phases 1–5** (all shipped). Phase 7+ scope (manual mute toggles, admin storm dashboard, cross-channel rate limits) is explicitly out of scope.

---

## Discovery findings (already done)

- `users.kind` enum is `'human' | 'agent' | 'system'` (Phase 1). `users.kind` has default `'human'`. `/api/members` returns `kind` for every row (`apps/api/src/routes/members.ts:27`).
- `messages.parent_id` is the thread root for replies; existing index on `parent_id` (`packages/db/src/schema.ts:174`).
- BYOA agent thread-replies route through `sendMessage` in `apps/api/src/lib/mcp-tools/writes.ts:588`. The thread branch resolves `parentId` at line 612. `executeSendMessage` does the actual insert; `shouldAutoExecute` may queue for approval first. The storm check must fire BEFORE `shouldAutoExecute` so storm-tripped calls don't pollute the approval queue.
- Defty's thread-reply path lives in `apps/api/src/lib/agent-actions.ts:1441` (case `post_thread_reply` in the executor). After parent lookup at line 1448 and before the message insert at line 1457 is the right place.
- The `ToolContext` (`apps/api/src/lib/mcp-tools/types.ts:18`) carries `employee_id` — that's the BYOA agent's id. `getShadowUserId(ctx.employee_id)` at `apps/api/src/lib/mcp-tools/writes.ts:131` resolves to the agent's `users.id`. We need that value for the storm count.
- `errorResult(msg)` in `mcp-tools/types.ts:39` is the MCP-conformant error wrapper. Storm errors return `errorResult('STORM_DETECTED: ...')`.
- `apps/web/src/components/create-dm-modal.tsx` (Phase 4) already partitions humans/agents in the DM picker. Lines 5, 13, 58, 131–132 reveal: `kind?: 'human' | 'agent' | 'system'` on Member, `import { Bot } from 'lucide-react'`, inline `<Bot size={15} strokeWidth={1.5} />` as the AI badge. We extract this into a standalone `<AIBadge/>` component for reuse.
- `apps/web/src/components/space-members-panel.tsx` (current) does NOT carry `kind` on its `Member` type and renders a flat picker. This is the Phase 6 surface. 265 lines, single responsibility — no need to split.

---

## File Structure

**New backend (1):**
- Create: `apps/api/src/lib/storm-detector.ts` — pure read-side helper. One exported function `checkReplyStorm(agentUserId, threadParentId, now?)`. Two exported constants `STORM_THRESHOLD = 5`, `STORM_WINDOW_MS = 10 * 60 * 1000`.

**Modified backend (2):**
- Modify: `apps/api/src/lib/mcp-tools/writes.ts` — `sendMessage` checks `checkReplyStorm` when `target.thread_id` resolves; throws via `errorResult` before `shouldAutoExecute`.
- Modify: `apps/api/src/lib/agent-actions.ts` — case `'post_thread_reply'` checks `checkReplyStorm` after parent lookup, before insert; returns `{ success: false, result: null, error: 'STORM_DETECTED: ...' }` on trip.

**New frontend (1):**
- Create: `apps/web/src/components/ai-badge.tsx` — small reusable badge: `<Bot size>` + "AI" label, accepts `size?: number` and optional `className`.

**Modified frontend (2):**
- Modify: `apps/web/src/components/space-members-panel.tsx` — add `kind` to Member type, partition picker into Humans / Agents sections, render `<AIBadge/>` next to agent rows in BOTH the existing-members list AND the add-member picker.
- Modify: `apps/web/src/components/create-dm-modal.tsx` — replace inline `<Bot>` badge with `<AIBadge/>` import. Keep all other behavior unchanged.

**Tests (3 new):**
- Create: `apps/api/test/storm-detector.test.ts` — unit tests `checkReplyStorm` directly against the DB.
- Create: `apps/api/test/mcp-storm-enforcement.test.ts` — integration tests `sendMessage` thread branch trips storm.
- Create: `apps/api/test/defty-storm-enforcement.test.ts` — integration tests Defty's `post_thread_reply` case trips storm.

**Modified tests (1):**
- Modify: `apps/api/test/inbox-redirect.test.ts` — append assertions that `space-members-panel.tsx` references `kind === 'agent'` and `'Agents'` section header. Keeps the file-structure regression-lock theme of that file.

---

## Task 1: Storm detector helper + unit tests

**Files:**
- Create: `apps/api/src/lib/storm-detector.ts`
- Create: `apps/api/test/storm-detector.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/storm-detector.test.ts`:

```typescript
// apps/api/test/storm-detector.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers, spaces, spaceMembers, messages } from '@deft/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { checkReplyStorm, STORM_THRESHOLD, STORM_WINDOW_MS } from '../src/lib/storm-detector.js';

let testOrgId: string;
let agentUserId: string;
let humanUserId: string;
let spaceId: string;
let threadParentId: string;
let otherThreadParentId: string;
const createdMessageIds: string[] = [];

before(async () => {
  const ts = Date.now();
  const [org] = await db.insert(orgs).values({ name: `storm-${ts}`, slug: `storm-${ts}` }).returning();
  testOrgId = org.id;

  const [agent] = await db.insert(users).values({
    email: `storm-agent-${ts}@test.com`, name: 'Storm Agent', org_id: testOrgId, kind: 'agent',
  }).returning();
  agentUserId = agent.id;

  const [human] = await db.insert(users).values({
    email: `storm-human-${ts}@test.com`, name: 'Storm Human', org_id: testOrgId, kind: 'human',
  }).returning();
  humanUserId = human.id;

  await db.insert(orgMembers).values([
    { org_id: testOrgId, user_id: agentUserId, role: 'member' },
    { org_id: testOrgId, user_id: humanUserId, role: 'owner' },
  ]);

  const [space] = await db.insert(spaces).values({
    name: 'storm-space', type: 'public', org_id: testOrgId, created_by: humanUserId,
  }).returning();
  spaceId = space.id;
  await db.insert(spaceMembers).values([
    { space_id: spaceId, user_id: humanUserId },
    { space_id: spaceId, user_id: agentUserId },
  ]);

  // Two thread roots to test cross-thread isolation.
  const [t1] = await db.insert(messages).values({
    org_id: testOrgId, space_id: spaceId, user_id: humanUserId, content: 'thread root 1',
  }).returning();
  threadParentId = t1.id;
  createdMessageIds.push(t1.id);

  const [t2] = await db.insert(messages).values({
    org_id: testOrgId, space_id: spaceId, user_id: humanUserId, content: 'thread root 2',
  }).returning();
  otherThreadParentId = t2.id;
  createdMessageIds.push(t2.id);
});

after(async () => {
  if (createdMessageIds.length) {
    await db.delete(messages).where(inArray(messages.id, createdMessageIds));
  }
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
  await db.delete(spaces).where(eq(spaces.id, spaceId));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, testOrgId));
  await db.delete(users).where(inArray(users.id, [agentUserId, humanUserId]));
  await db.delete(orgs).where(eq(orgs.id, testOrgId));
});

async function insertReply(authorId: string, parentId: string, ageMs = 0): Promise<string> {
  const createdAt = new Date(Date.now() - ageMs);
  const [m] = await db.insert(messages).values({
    org_id: testOrgId, space_id: spaceId, user_id: authorId,
    content: `reply ${ageMs}`, parent_id: parentId, created_at: createdAt,
  }).returning();
  createdMessageIds.push(m.id);
  return m.id;
}

test('0 replies in window → not tripped, count=0', async () => {
  const r = await checkReplyStorm(agentUserId, threadParentId);
  assert.equal(r.tripped, false);
  assert.equal(r.count, 0);
  assert.equal(r.windowMs, STORM_WINDOW_MS);
});

test('4 replies in window → not tripped, count=4', async () => {
  for (let i = 0; i < 4; i++) await insertReply(agentUserId, threadParentId);
  const r = await checkReplyStorm(agentUserId, threadParentId);
  assert.equal(r.tripped, false);
  assert.equal(r.count, 4);
});

test('5 replies in window → tripped, count=5', async () => {
  await insertReply(agentUserId, threadParentId);
  const r = await checkReplyStorm(agentUserId, threadParentId);
  assert.equal(r.tripped, true);
  assert.equal(r.count, STORM_THRESHOLD);
});

test('replies older than 10min are not counted', async () => {
  await insertReply(agentUserId, otherThreadParentId, 11 * 60 * 1000);
  await insertReply(agentUserId, otherThreadParentId, 11 * 60 * 1000);
  await insertReply(agentUserId, otherThreadParentId, 11 * 60 * 1000);
  await insertReply(agentUserId, otherThreadParentId, 11 * 60 * 1000);
  await insertReply(agentUserId, otherThreadParentId, 11 * 60 * 1000);
  const r = await checkReplyStorm(agentUserId, otherThreadParentId);
  assert.equal(r.tripped, false);
  assert.equal(r.count, 0);
});

test('different thread is not affected', async () => {
  // threadParentId already has 5 agent replies from the earlier test.
  // otherThreadParentId only has stale ones (counted as 0 above).
  const r = await checkReplyStorm(agentUserId, otherThreadParentId);
  assert.equal(r.tripped, false);
});

test('same thread, different agent → not tripped (per-agent scope)', async () => {
  // Insert 5 replies as the human user in the same thread.
  for (let i = 0; i < 5; i++) await insertReply(humanUserId, threadParentId);
  // Storm check for a NEW agent (we only have one agent in this fixture, so use a synthetic uuid).
  const fakeAgentId = '00000000-0000-0000-0000-000000000000';
  const r = await checkReplyStorm(fakeAgentId, threadParentId);
  assert.equal(r.tripped, false);
  assert.equal(r.count, 0);
});
```

- [ ] **Step 2: Run, confirm fail (module not found)**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/storm-detector.test.ts
```

Expected: FAIL — `Cannot find module '../src/lib/storm-detector.js'`.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/lib/storm-detector.ts`:

```typescript
// apps/api/src/lib/storm-detector.ts
import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from './db.js';
import { messages } from '@deft/db/schema';

export const STORM_THRESHOLD = 5;
export const STORM_WINDOW_MS = 10 * 60 * 1000;

export type StormCheck = {
  tripped: boolean;
  count: number;
  windowMs: number;
};

/**
 * Count an agent's thread replies within the storm window.
 * - Per-agent: scoped to one users.id
 * - Per-thread: scoped to one parent_message_id (the thread root)
 * - Excludes deleted rows
 *
 * Tripped means count >= STORM_THRESHOLD. Callers should NOT post when
 * tripped; they should surface a STORM_DETECTED error to the agent runtime.
 */
export async function checkReplyStorm(
  agentUserId: string,
  threadParentId: string,
  now?: Date,
): Promise<StormCheck> {
  const cutoff = new Date((now ?? new Date()).getTime() - STORM_WINDOW_MS);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.user_id, agentUserId),
        eq(messages.parent_id, threadParentId),
        eq(messages.is_deleted, false),
        gt(messages.created_at, cutoff),
      ),
    );

  const count = row?.count ?? 0;
  return {
    tripped: count >= STORM_THRESHOLD,
    count,
    windowMs: STORM_WINDOW_MS,
  };
}
```

- [ ] **Step 4: Run, confirm pass**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/storm-detector.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/api/src/lib/storm-detector.ts apps/api/test/storm-detector.test.ts && git commit -m "feat(api): storm-detector helper for per-agent per-thread reply rate"
```

---

## Task 2: BYOA `sendMessage` storm guard

**Files:**
- Modify: `apps/api/src/lib/mcp-tools/writes.ts`
- Create: `apps/api/test/mcp-storm-enforcement.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/mcp-storm-enforcement.test.ts`:

```typescript
// apps/api/test/mcp-storm-enforcement.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import {
  users, orgs, orgMembers, spaces, spaceMembers, messages, agentEmployees,
} from '@deft/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { sendMessage } from '../src/lib/mcp-tools/writes.js';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';

let testOrgId: string;
let agentUserId: string;
let humanUserId: string;
let employeeId: string;
let spaceId: string;
let threadRootId: string;
const createdMessageIds: string[] = [];

before(async () => {
  const ts = Date.now();
  const [org] = await db.insert(orgs).values({ name: `mcpstorm-${ts}`, slug: `mcpstorm-${ts}` }).returning();
  testOrgId = org.id;

  const [agentUser] = await db.insert(users).values({
    email: `mcpstorm-${ts}@test.com`, name: 'MCP Storm Agent', org_id: testOrgId, kind: 'agent',
  }).returning();
  agentUserId = agentUser.id;

  const [human] = await db.insert(users).values({
    email: `mcpstorm-h-${ts}@test.com`, name: 'Human', org_id: testOrgId, kind: 'human',
  }).returning();
  humanUserId = human.id;

  await db.insert(orgMembers).values([
    { org_id: testOrgId, user_id: agentUserId, role: 'member' },
    { org_id: testOrgId, user_id: humanUserId, role: 'owner' },
  ]);

  const [emp] = await db.insert(agentEmployees).values({
    org_id: testOrgId, user_id: agentUserId, name: 'MCP Storm Agent', slug: `mcp-storm-${ts}`,
    role: 'engineer', is_active: true, trust_level: 'autonomous', is_byoa: true,
  }).returning();
  employeeId = emp.id;

  const [space] = await db.insert(spaces).values({
    name: 'mcp-storm-space', type: 'public', org_id: testOrgId, created_by: humanUserId,
  }).returning();
  spaceId = space.id;
  await db.insert(spaceMembers).values([
    { space_id: spaceId, user_id: humanUserId },
    { space_id: spaceId, user_id: agentUserId },
  ]);

  const [root] = await db.insert(messages).values({
    org_id: testOrgId, space_id: spaceId, user_id: humanUserId, content: 'thread root',
  }).returning();
  threadRootId = root.id;
  createdMessageIds.push(root.id);
});

after(async () => {
  if (createdMessageIds.length) {
    await db.delete(messages).where(inArray(messages.id, createdMessageIds));
  }
  await db.delete(messages).where(eq(messages.space_id, spaceId)); // catch any spillover
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
  await db.delete(spaces).where(eq(spaces.id, spaceId));
  await db.delete(agentEmployees).where(eq(agentEmployees.id, employeeId));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, testOrgId));
  await db.delete(users).where(inArray(users.id, [agentUserId, humanUserId]));
  await db.delete(orgs).where(eq(orgs.id, testOrgId));
});

const ctx = (): ToolContext => ({
  org_id: testOrgId,
  employee_id: employeeId,
  employee_slug: `mcp-storm-test`,
  trust_level: 'autonomous',
});

test('sendMessage thread branch with 5 prior agent replies → STORM_DETECTED', async () => {
  // Seed 5 agent replies in this thread.
  for (let i = 0; i < 5; i++) {
    const [m] = await db.insert(messages).values({
      org_id: testOrgId, space_id: spaceId, user_id: agentUserId,
      content: `seed reply ${i}`, parent_id: threadRootId,
    }).returning();
    createdMessageIds.push(m.id);
  }

  const r = await sendMessage(
    { caller_employee_slug: 'mcp-storm-test', target: { thread_id: threadRootId }, content: 'one more' },
    ctx(),
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /STORM_DETECTED/);
});

test('sendMessage space_id branch is NOT throttled even after 5 replies', async () => {
  // Top-level posts (parent_id null) shouldn't trip storm.
  const r = await sendMessage(
    { caller_employee_slug: 'mcp-storm-test', target: { space_id: spaceId }, content: 'top-level' },
    ctx(),
  );
  // Either succeeded or queued for approval — both are non-storm outcomes.
  if (r.isError) {
    assert.doesNotMatch(r.content[0]!.text, /STORM_DETECTED/);
  }
});

test('sendMessage thread branch with 4 prior agent replies → succeeds (or queued)', async () => {
  // Fresh thread root.
  const [root] = await db.insert(messages).values({
    org_id: testOrgId, space_id: spaceId, user_id: humanUserId, content: 'fresh thread',
  }).returning();
  createdMessageIds.push(root.id);

  for (let i = 0; i < 4; i++) {
    const [m] = await db.insert(messages).values({
      org_id: testOrgId, space_id: spaceId, user_id: agentUserId,
      content: `seed ${i}`, parent_id: root.id,
    }).returning();
    createdMessageIds.push(m.id);
  }

  const r = await sendMessage(
    { caller_employee_slug: 'mcp-storm-test', target: { thread_id: root.id }, content: 'fifth' },
    ctx(),
  );
  if (r.isError) {
    assert.doesNotMatch(r.content[0]!.text, /STORM_DETECTED/);
  }
});
```

- [ ] **Step 2: Run, confirm new tests fail**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/mcp-storm-enforcement.test.ts
```

Expected: the "5 prior agent replies → STORM_DETECTED" test fails because the guard isn't wired yet.

- [ ] **Step 3: Wire the guard into `sendMessage`**

Open `apps/api/src/lib/mcp-tools/writes.ts`. Find this block (around line 600–612):

```typescript
  if ('space_id' in target) {
    spaceId = target.space_id;
  } else if ('thread_id' in target) {
    const [parent] = await db
      .select({ id: messages.id, space_id: messages.space_id })
      .from(messages)
      .where(and(eq(messages.id, target.thread_id), eq(messages.org_id, ctx.org_id)))
      .limit(1);
    if (!parent) {
      return errorResult('send_message: thread_id not found');
    }
    spaceId = parent.space_id;
    parentId = parent.id;
  } else if ('user_id' in target) {
```

Change the `thread_id` branch to also run the storm check after resolving parentId. Add the import at the top of `writes.ts` near the other lib imports:

```typescript
import { checkReplyStorm, STORM_THRESHOLD } from '../storm-detector.js';
```

Then inside the `thread_id` branch, AFTER `parentId = parent.id;` and BEFORE the closing brace of that branch, add the storm guard. Also resolve the agent's shadow user before the check (we need its id):

```typescript
  } else if ('thread_id' in target) {
    const [parent] = await db
      .select({ id: messages.id, space_id: messages.space_id })
      .from(messages)
      .where(and(eq(messages.id, target.thread_id), eq(messages.org_id, ctx.org_id)))
      .limit(1);
    if (!parent) {
      return errorResult('send_message: thread_id not found');
    }
    spaceId = parent.space_id;
    parentId = parent.id;

    // Phase 6 — reply-storm guard.
    const callerShadowId = await getShadowUserId(ctx.employee_id);
    if (callerShadowId) {
      const storm = await checkReplyStorm(callerShadowId, parent.id);
      if (storm.tripped) {
        return errorResult(
          `STORM_DETECTED: agent exceeded ${STORM_THRESHOLD} replies in this thread within the rate-limit window; backing off`,
        );
      }
    }
  } else if ('user_id' in target) {
```

(`getShadowUserId` is defined at `apps/api/src/lib/mcp-tools/writes.ts:131` — already in scope.)

- [ ] **Step 4: Run, confirm pass**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/mcp-storm-enforcement.test.ts
```

Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/api/src/lib/mcp-tools/writes.ts apps/api/test/mcp-storm-enforcement.test.ts && git commit -m "feat(api): sendMessage thread branch enforces reply-storm rate limit"
```

---

## Task 3: Defty `post_thread_reply` storm guard

**Files:**
- Modify: `apps/api/src/lib/agent-actions.ts`
- Create: `apps/api/test/defty-storm-enforcement.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/defty-storm-enforcement.test.ts`. The Defty path is `executeAgentAction` (or whatever the executor function is named in `agent-actions.ts`) routed through `case 'post_thread_reply'`. Most tests in the project test the executor through a wrapper that constructs a pending `agent_actions` row and runs the executor.

First, find the executor function name and signature:

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -nE "^export.*function.*[Ee]xecut|^export const.*=.*async" apps/api/src/lib/agent-actions.ts | head -10
```

Use the same pattern as `apps/api/test/post-thread-reply.test.ts` (a pre-existing file that tests the same case). Read its setup:

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && head -80 apps/api/test/post-thread-reply.test.ts
```

Mirror that structure exactly, but seed 5 agent-authored thread replies before invoking the executor. The test:

```typescript
// apps/api/test/defty-storm-enforcement.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import {
  users, orgs, orgMembers, spaces, spaceMembers, messages, agentActions,
} from '@deft/db/schema';
import { eq, inArray } from 'drizzle-orm';
// IMPORTANT: import the same executor that post-thread-reply.test.ts imports.
// Read post-thread-reply.test.ts to confirm the function name + signature.
import { executeAgentAction } from '../src/lib/agent-actions.js';

let testOrgId: string;
let deftyUserId: string;
let humanUserId: string;
let spaceId: string;
let threadRootId: string;
const createdMessageIds: string[] = [];
const createdActionIds: string[] = [];

before(async () => {
  const ts = Date.now();
  const [org] = await db.insert(orgs).values({ name: `defty-storm-${ts}`, slug: `defty-storm-${ts}` }).returning();
  testOrgId = org.id;

  const [defty] = await db.insert(users).values({
    email: `defty-storm-${ts}@test.com`, name: 'Defty', org_id: testOrgId, kind: 'agent',
  }).returning();
  deftyUserId = defty.id;

  const [human] = await db.insert(users).values({
    email: `defty-storm-h-${ts}@test.com`, name: 'Human', org_id: testOrgId, kind: 'human',
  }).returning();
  humanUserId = human.id;

  await db.insert(orgMembers).values([
    { org_id: testOrgId, user_id: deftyUserId, role: 'member' },
    { org_id: testOrgId, user_id: humanUserId, role: 'owner' },
  ]);

  const [space] = await db.insert(spaces).values({
    name: 'defty-storm-space', type: 'public', org_id: testOrgId, created_by: humanUserId,
  }).returning();
  spaceId = space.id;
  await db.insert(spaceMembers).values([
    { space_id: spaceId, user_id: humanUserId },
    { space_id: spaceId, user_id: deftyUserId },
  ]);

  const [root] = await db.insert(messages).values({
    org_id: testOrgId, space_id: spaceId, user_id: humanUserId, content: 'thread root',
  }).returning();
  threadRootId = root.id;
  createdMessageIds.push(root.id);
});

after(async () => {
  if (createdActionIds.length) {
    await db.delete(agentActions).where(inArray(agentActions.id, createdActionIds));
  }
  await db.delete(messages).where(eq(messages.space_id, spaceId));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
  await db.delete(spaces).where(eq(spaces.id, spaceId));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, testOrgId));
  await db.delete(users).where(inArray(users.id, [deftyUserId, humanUserId]));
  await db.delete(orgs).where(eq(orgs.id, testOrgId));
});

test('Defty post_thread_reply with 5 prior agent replies → STORM_DETECTED', async () => {
  // Seed 5 agent replies in this thread.
  for (let i = 0; i < 5; i++) {
    const [m] = await db.insert(messages).values({
      org_id: testOrgId, space_id: spaceId, user_id: deftyUserId,
      content: `seed ${i}`, parent_id: threadRootId,
    }).returning();
    createdMessageIds.push(m.id);
  }

  // Queue an action and execute it. Adapt this block to match the actual
  // executor signature found via the grep in step 1. Most likely:
  const [action] = await db.insert(agentActions).values({
    org_id: testOrgId, user_id: deftyUserId,
    action: 'post_thread_reply',
    params: { parent_message_id: threadRootId, content: 'one more reply' } as never,
    approval_status: 'approved', approval_tier: 'full', source: 'mention',
  }).returning();
  createdActionIds.push(action.id);

  // Use the same invocation pattern that post-thread-reply.test.ts uses.
  // Likely shape: executeAgentAction(action.id, { orgId: testOrgId, userId: deftyUserId })
  const result = await executeAgentAction(action.id, {
    orgId: testOrgId, userId: deftyUserId,
  } as never);

  assert.equal(result.success, false);
  assert.match(String(result.error), /STORM_DETECTED/);
});
```

**Important:** Before writing this test, READ `apps/api/test/post-thread-reply.test.ts` first and copy its exact import statement and invocation pattern. The signature of `executeAgentAction` (or whatever the public executor entrypoint is) must match what that file uses. If it uses a different function name or argument shape, mirror that here.

- [ ] **Step 2: Run, confirm new test fails**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/defty-storm-enforcement.test.ts
```

Expected: FAIL with the storm-not-detected outcome (the executor inserts the 6th reply because the guard isn't there yet).

- [ ] **Step 3: Wire the guard into `agent-actions.ts`**

Open `apps/api/src/lib/agent-actions.ts`. At the top, add the import alongside other lib imports:

```typescript
import { checkReplyStorm, STORM_THRESHOLD } from './storm-detector.js';
```

Find the `case 'post_thread_reply':` block at line 1441. After the parent lookup (line 1448–1455) and BEFORE the message insert (line 1457), insert the storm guard. The full case block should become:

```typescript
      case 'post_thread_reply': {
        // Block 2.2 — reply to an existing message in its thread.
        const parentId = typeof params.parent_message_id === 'string' ? params.parent_message_id : '';
        const content = typeof params.content === 'string' ? params.content.trim() : '';
        if (!parentId) return { success: false, result: null, error: 'parent_message_id is required' };
        if (!content) return { success: false, result: null, error: 'content is required' };

        const [parent] = await db
          .select({ id: messages.id, space_id: messages.space_id, org_id: messages.org_id })
          .from(messages)
          .where(and(eq(messages.id, parentId), eq(messages.org_id, orgId), eq(messages.is_deleted, false)))
          .limit(1);
        if (!parent) {
          return { success: false, result: null, error: 'Parent message not found in this org' };
        }

        // Phase 6 — reply-storm guard.
        const storm = await checkReplyStorm(userId, parent.id);
        if (storm.tripped) {
          return {
            success: false,
            result: null,
            error: `STORM_DETECTED: agent exceeded ${STORM_THRESHOLD} replies in this thread within the rate-limit window; backing off`,
          };
        }

        const [msg] = await db
          .insert(messages)
          .values({
            org_id: orgId,
            space_id: parent.space_id,
            user_id: userId,
            content,
            parent_id: parent.id,
          })
          .returning();

        // ... rest of the case (audit log, socket emit, return success) — unchanged.
```

(The lines after the insert — audit log, socket emit, success return — are unchanged from the existing code.)

- [ ] **Step 4: Run, confirm pass**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/defty-storm-enforcement.test.ts test/post-thread-reply.test.ts
```

Expected: defty-storm-enforcement passes; the existing post-thread-reply tests should still pass since the storm threshold is 5 and they don't seed that many.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/api/src/lib/agent-actions.ts apps/api/test/defty-storm-enforcement.test.ts && git commit -m "feat(api): post_thread_reply enforces reply-storm rate limit"
```

---

## Task 4: Extract `<AIBadge/>` from CreateDmModal

**Files:**
- Create: `apps/web/src/components/ai-badge.tsx`
- Modify: `apps/web/src/components/create-dm-modal.tsx`

- [ ] **Step 1: Read the existing inline badge in create-dm-modal.tsx**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && sed -n '50,70p' apps/web/src/components/create-dm-modal.tsx
```

Note the exact icon size, strokeWidth, classes, and inline style used for the badge.

- [ ] **Step 2: Create the standalone component**

Create `apps/web/src/components/ai-badge.tsx`:

```typescript
// apps/web/src/components/ai-badge.tsx
'use client';

import { Bot } from 'lucide-react';

type Props = {
  size?: number;
  className?: string;
};

/**
 * Compact "AI" badge: a Bot icon used to mark agent users in lists and pickers.
 * Used by CreateDmModal (Phase 4) and SpaceMembersPanel (Phase 6).
 */
export function AIBadge({ size = 15, className }: Props) {
  return (
    <Bot
      size={size}
      strokeWidth={1.5}
      className={className}
      aria-label="AI agent"
    />
  );
}
```

If reading step 1 reveals additional styling on the inline `<Bot/>` (e.g., specific color CSS var, container span with background, "AI" text label), match that styling here exactly. The point of extraction is visual parity, not redesign.

- [ ] **Step 3: Replace the inline badge in CreateDmModal**

Open `apps/web/src/components/create-dm-modal.tsx`. At line 5, the import is:

```typescript
import { X, Search, Bot } from 'lucide-react';
```

Remove `Bot` from that import (only if no other line in the file references `Bot` outside the badge — verify with grep):

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -nE "<Bot|Bot[ ,}]" apps/web/src/components/create-dm-modal.tsx
```

If the only `Bot` references are in the import line and the badge JSX (line 58), remove `Bot` from the import. Otherwise keep it.

Add a new import line:

```typescript
import { AIBadge } from './ai-badge';
```

At line 58 (the inline badge), replace:

```typescript
<Bot size={15} strokeWidth={1.5} />
```

with:

```typescript
<AIBadge size={15} />
```

- [ ] **Step 4: Type-check**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/web exec tsc --noEmit --project tsconfig.json 2>&1 | grep -E "ai-badge\.tsx|create-dm-modal\.tsx" | head -10
```

Expected: no errors for either file.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/web/src/components/ai-badge.tsx apps/web/src/components/create-dm-modal.tsx && git commit -m "refactor(web): extract <AIBadge/> from CreateDmModal for reuse"
```

---

## Task 5: SpaceMembersPanel — kind field + partitioned picker + badges

**Files:**
- Modify: `apps/web/src/components/space-members-panel.tsx`

- [ ] **Step 1: Read the current panel structure**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && wc -l apps/web/src/components/space-members-panel.tsx && sed -n '1,30p' apps/web/src/components/space-members-panel.tsx
```

- [ ] **Step 2: Edit the file**

Make four edits in `apps/web/src/components/space-members-panel.tsx`:

**Edit A — extend the `Member` type and add the AIBadge import.**

Change:
```typescript
import { X, Plus, UserMinus, Search } from 'lucide-react';

type Member = { id: string; name: string; email: string; avatar_url: string | null; status_emoji?: string | null; status_text?: string | null };
```

to:
```typescript
import { X, Plus, UserMinus, Search } from 'lucide-react';
import { AIBadge } from './ai-badge';

type Member = {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  kind?: 'human' | 'agent' | 'system';
  status_emoji?: string | null;
  status_text?: string | null;
};
```

**Edit B — partition `filtered` into humans + agents.**

Find:
```typescript
const nonMembers = allMembers.filter(m => !members.some(mem => mem.id === m.id));
const filtered = nonMembers.filter(m =>
  m.name.toLowerCase().includes(search.toLowerCase()) ||
  m.email.toLowerCase().includes(search.toLowerCase())
);
```

Replace with:
```typescript
const nonMembers = allMembers.filter(m => !members.some(mem => mem.id === m.id));
const filtered = nonMembers.filter(m =>
  m.name.toLowerCase().includes(search.toLowerCase()) ||
  m.email.toLowerCase().includes(search.toLowerCase())
);
const filteredHumans = filtered.filter(m => m.kind !== 'agent' && m.kind !== 'system');
const filteredAgents = filtered.filter(m => m.kind === 'agent' || m.kind === 'system');
```

**Edit C — render two sections in the add-member picker.**

Find the block that renders the picker rows. Per the read of step 1 in this task, this is around lines 212–250 — the `filtered.map((member) => (...))` JSX. Replace the single `filtered.map` with two sections, each with its own header. The exact replacement depends on the current JSX structure but should look like:

```typescript
{filtered.length === 0 ? (
  <p className="text-[12px] py-2 text-center" style={{ color: 'var(--muted)' }}>
    {nonMembers.length === 0 ? 'All org members are in this space' : 'No matches found'}
  </p>
) : (
  <>
    {filteredHumans.length > 0 && (
      <div className="mb-2">
        <div
          className="text-[10px] font-semibold uppercase tracking-wider mb-1 px-2"
          style={{ color: 'var(--muted)' }}
        >
          People
        </div>
        {filteredHumans.map((member) => (
          // existing per-member button JSX, unchanged
          // (paste the exact JSX from the current file's filtered.map body here)
          /* ... */
        ))}
      </div>
    )}
    {filteredAgents.length > 0 && (
      <div>
        <div
          className="text-[10px] font-semibold uppercase tracking-wider mb-1 px-2"
          style={{ color: 'var(--muted)' }}
        >
          Agents
        </div>
        {filteredAgents.map((member) => (
          // SAME per-member JSX as above, but ALSO render <AIBadge size={13} className="ml-auto mr-2" />
          // immediately before the existing inline indicator (or wherever the row's right edge is).
          /* ... */
        ))}
      </div>
    )}
  </>
)}
```

To keep the diff focused: extract the existing per-member button JSX into a small inline render function inside the component (`renderMemberRow(member, isAgent)`) and call it from both arrays. This avoids duplicating the row markup.

**Concrete approach:**

```typescript
function renderMemberRow(member: Member, isAgent: boolean) {
  const color = avatarColor(member.name || '');
  return (
    <button
      key={member.id}
      onClick={() => addMember(member.id)}
      className="flex items-center gap-3 w-full px-2 py-2 rounded-md transition-colors"
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'var(--hover-tint)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {member.avatar_url ? (
        <img src={member.avatar_url} className="w-7 h-7 rounded-full" alt={member.name} />
      ) : (
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold text-white"
          style={{ background: color }}
        >
          {member.name?.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-medium truncate" style={{ color: 'var(--foreground)' }}>
            {member.name}
          </span>
          {isAgent && <AIBadge size={13} />}
        </div>
        <div className="text-[11px] truncate" style={{ color: 'var(--muted)' }}>
          {member.email}
        </div>
      </div>
      <Plus size={14} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
    </button>
  );
}
```

(If the existing row markup differs from this skeleton, preserve the existing markup exactly and just add the `{isAgent && <AIBadge size={13} />}` next to the name.)

Then the picker body becomes:

```typescript
{filtered.length === 0 ? (
  <p className="text-[12px] py-2 text-center" style={{ color: 'var(--muted)' }}>
    {nonMembers.length === 0 ? 'All org members are in this space' : 'No matches found'}
  </p>
) : (
  <>
    {filteredHumans.length > 0 && (
      <div className="mb-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider mb-1 px-2" style={{ color: 'var(--muted)' }}>
          People
        </div>
        {filteredHumans.map((m) => renderMemberRow(m, false))}
      </div>
    )}
    {filteredAgents.length > 0 && (
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider mb-1 px-2" style={{ color: 'var(--muted)' }}>
          Agents
        </div>
        {filteredAgents.map((m) => renderMemberRow(m, true))}
      </div>
    )}
  </>
)}
```

**Edit D — add badge to the existing-members list (the rows above the picker).**

Find the existing-members render loop (above the "Add members" button — around line 140–175 in the current file). For each member row, render `<AIBadge size={13} />` next to the name when `member.kind === 'agent' || member.kind === 'system'`. The existing remove (`UserMinus`) button stays as-is.

- [ ] **Step 3: Type-check**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/web exec tsc --noEmit --project tsconfig.json 2>&1 | grep -E "space-members-panel\.tsx" | head -10
```

Expected: no errors for `space-members-panel.tsx`.

- [ ] **Step 4: Verify the file structurally**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -nE "AIBadge|filteredAgents|filteredHumans|kind === 'agent'|People|Agents</" apps/web/src/components/space-members-panel.tsx
```

Expected: matches for `AIBadge`, `filteredHumans`, `filteredAgents`, the literal `'People'`, the literal `'Agents'`, and at least one `kind === 'agent'`.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/web/src/components/space-members-panel.tsx && git commit -m "feat(web): SpaceMembersPanel — partition picker + AI badges"
```

---

## Task 6: File-structure regression test for Phase 6

**Files:**
- Modify: `apps/api/test/inbox-redirect.test.ts` (this is the existing Phase 5 file-structure test; we extend it with Phase 6 checks rather than create a separate file)

- [ ] **Step 1: Append the regression assertions**

Append to the END of `apps/api/test/inbox-redirect.test.ts`:

```typescript
test('SpaceMembersPanel partitions humans/agents and renders AIBadge', () => {
  const p = resolve(ROOT, 'apps/web/src/components/space-members-panel.tsx');
  const src = readFileSync(p, 'utf8');
  assert.ok(src.includes('AIBadge'), 'should import the AIBadge component');
  assert.ok(src.includes("kind === 'agent'"), 'should partition by kind');
  assert.ok(src.includes("'People'"), "should render the People section header");
  assert.ok(src.includes("'Agents'"), "should render the Agents section header");
});

test('AIBadge component exists', () => {
  const p = resolve(ROOT, 'apps/web/src/components/ai-badge.tsx');
  assert.ok(existsSync(p), `expected ${p} to exist`);
  const src = readFileSync(p, 'utf8');
  assert.ok(src.includes('export function AIBadge'), 'should export AIBadge function');
});

test('storm-detector module exists with documented constants', () => {
  const p = resolve(ROOT, 'apps/api/src/lib/storm-detector.ts');
  assert.ok(existsSync(p));
  const src = readFileSync(p, 'utf8');
  assert.ok(src.includes('STORM_THRESHOLD'), 'should export threshold constant');
  assert.ok(src.includes('STORM_WINDOW_MS'), 'should export window constant');
  assert.ok(src.includes('checkReplyStorm'), 'should export checkReplyStorm function');
});
```

- [ ] **Step 2: Run, confirm pass**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/inbox-redirect.test.ts
```

Expected: 9 tests total (6 from Phase 5 + 3 new), all pass.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/api/test/inbox-redirect.test.ts && git commit -m "test: file-structure regression locks for Phase 6"
```

---

## Task 7: Smoke + CLAUDE.md + plan commit

- [ ] **Step 1: Run all Phase 6 tests + Phase 5 regression test**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsx --test test/storm-detector.test.ts test/mcp-storm-enforcement.test.ts test/defty-storm-enforcement.test.ts test/inbox-redirect.test.ts
```

Expected: all green. If any fail, fix before continuing.

- [ ] **Step 2: Type-check both apps**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api exec tsc --noEmit && echo "api ok" && pnpm --filter @deft/web exec tsc --noEmit 2>&1 | grep -E "ai-badge|space-members-panel|create-dm-modal|writes\.ts|agent-actions\.ts|storm-detector" | head -10
```

Expected: api ok; the web grep returns no errors in any of the listed files. Pre-existing errors in `clip-recorder.tsx` and `dashboard-grid.tsx` (Phase 5 baseline) are NOT Phase 6 regressions and can stay.

- [ ] **Step 3: Update CLAUDE.md**

Open `CLAUDE.md` and find the Phase 5 paragraph in the Agent Architecture section. Append the Phase 6 paragraph immediately after Phase 5:

```markdown
**Phase 6 (2026-05-07).** Multi-agent affordances. (1) Agents partitioned
in `SpaceMembersPanel` into a separate "Agents" section with an
`<AIBadge/>` per row, mirroring Phase 4's `CreateDmModal` pattern;
backend member-add accepts any user kind unchanged. (2) Reply-storm
detector at `apps/api/src/lib/storm-detector.ts`: counts agent-authored
thread replies (per agent, per thread root) in a rolling 10-minute
window. On `count >= 5`, the BYOA `sendMessage` MCP tool (thread_id
target) and the Defty `post_thread_reply` executor return a
`STORM_DETECTED` error so the agent's runtime can back off. Top-level
posts and DMs are not throttled. (3) `<AIBadge/>` component extracted
into `apps/web/src/components/ai-badge.tsx` and reused by both
`CreateDmModal` and `SpaceMembersPanel`. No DB migration.
```

- [ ] **Step 4: Commit CLAUDE.md + plan doc**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add CLAUDE.md && git commit -m "docs(claude): note Phase 6 multi-agent affordances" && git add docs/superpowers/plans/2026-05-07-agent-chat-unification-phase6.md && git commit -m "docs(plans): Phase 6 plan"
```

---

## Hand-off

Phase 6 ships the multi-agent affordances: visible agents in the channel members panel, throttled thread replies via a simple per-agent per-thread rolling counter, and reusable AI badge component. No DB migration, two new files (`storm-detector.ts`, `ai-badge.tsx`), guards added at the two existing agent post-message sites, and one members-panel partition.

Phases 1–6 close out the agent-chat unification arc. The agent-chat unification spec at `docs/superpowers/specs/2026-05-07-agent-chat-unification.md` should now be marked complete in any roadmap doc.

---

## Self-review checklist

- [x] **Spec coverage:** §Components and data flow item 1 (storm detector) → Task 1. Item 2 (tool-side enforcement) → Tasks 2 + 3 (BYOA + Defty). Item 3 (members panel UI) → Tasks 4 + 5 (extract badge, then panel). §Testing → Tasks 1, 2, 3, 6 (regression). §CLAUDE.md update → Task 7.
- [x] **Placeholder scan:** No TBDs. Every code block is concrete; the one ambiguity in Task 5 (the existing row JSX may differ from skeleton) is explicitly resolved with a fallback instruction ("If the existing row markup differs from this skeleton, preserve the existing markup exactly and just add the AIBadge…"). Task 3 has a similar fallback for the executor signature: "READ post-thread-reply.test.ts first and copy its exact import statement".
- [x] **Type consistency:** `checkReplyStorm` signature matches across Tasks 1, 2, 3 (`agentUserId, threadParentId, now?`). `STORM_THRESHOLD` constant is consistent. `Member.kind` union matches Phase 1's `userKindEnum`. `<AIBadge/>` props match between Tasks 4 and 5 (`size?: number, className?: string`). The Task 5 row-rendering helper uses `isAgent: boolean` as derived from `kind === 'agent' || kind === 'system'` — same predicate as the partition.
- [x] **Worktree path:** Every Bash step starts with `cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && ...`.
- [x] **Test harness:** `node:test` + `node:assert/strict` (NOT vitest), matching Phases 1–5.
- [x] **No schema migrations:** Phase 6 reads existing columns; no new tables, no new indexes (the optional composite index is explicitly deferred).
