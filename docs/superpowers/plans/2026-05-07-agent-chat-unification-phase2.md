# Agent ↔ Chat Unification — Phase 2: Collapse `agent_messages` into `messages`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the parallel `agent_conversations` + `agent_messages` tables with native `spaces` + `messages` rows. Each /agent conversation becomes a `spaces` row of type `agent_conversation` with the user + Defty (or BYOA) as members. Each agent turn becomes a `messages` row with structured content in `metadata.agent_blocks`.

**Architecture:** Add a new `agent_conversation` space type. Redirect `agent-stream-loop.ts` writes from `agentMessages`/`agentConversations` to `messages`/`spaces`. Repoint `agent_actions.message_id` to `messages.id`. Backfill historical rows preserving original UUIDs (so existing links don't break). Drop the old tables. The `/agent` UI continues to function because the API contracts at `GET /api/agent/conversations` and `GET /api/agent/conversations/:id/messages` keep their response shape — only the underlying data source changes.

**Tech Stack:**
- Drizzle ORM + PostgreSQL (`packages/db/`)
- Hono API (`apps/api/`)
- Anthropic streaming via `@anthropic-ai/sdk`
- Vitest equivalent: Node native test runner via `tsx --test` (NOT vitest)

**Spec:** `docs/superpowers/specs/2026-05-07-agent-chat-unification.md` §8.4 (schema collapse table) and §8.7 (migration shape).

**Builds on Phase 1** (already shipped on this branch). Phase 3 follows: MCP tool collapse (`send_message`, `fetch_unread`).

---

## Discovery findings (already done — read before starting)

These were verified during plan-writing:

- `agent-stream-loop.ts` (~282 lines) is the streaming heart. It calls `db.insert(agentMessages)` and `db.insert(agentActions)` directly. Persistence pattern: an assistant `agentMessages` row per Anthropic API call (one or more per turn), a user `agentMessages` row per tool_result block, `agentActions` rows for proposed-but-unexecuted actions linking via `message_id`.
- `apps/api/src/routes/agent.ts` exposes `POST /api/agent/conversations`, `GET /api/agent/conversations`, `GET /api/agent/conversations/:id/messages`, `POST /api/agent/conversations/:id/messages` (the SSE chat), `GET /api/agent/conversations/:id/trace.json`. The whole route file is ~700 lines and reads/writes `agentConversations` + `agentMessages` directly.
- `apps/web/src/components/agent-chat.tsx` consumes the API contract above: streams via SSE, renders tool-call cards, citations, pending-action approval cards. After Phase 2 the SSE event shape and the GET messages response shape stay unchanged — frontend doesn't need to change.
- `agent_actions.message_id` is `text` (not a typed FK). It can hold either an `agentMessages.id` or a `messages.id` — same UUID space.
- `messages.metadata` is `jsonb` (no migration needed for `agent_blocks`).
- `agent-reply.ts` already writes to `messages` (with `metadata.is_agent_reply`, `metadata.citations`, `metadata.pending_actions`) — that's the established pattern. Phase 2 generalizes it to `metadata.agent_blocks` (the full Anthropic block array).
- The `spaces.type` enum currently has `public | private | dm | group_dm`. Adding `agent_conversation` requires a migration.
- Drizzle journal is stale per CLAUDE.md "Known Limitations" — apply migrations manually via tsx scripts that call `db.execute(sql.raw(...))`.

---

## File Structure

**Schema + migration**
- Modify: `packages/db/src/schema.ts:17` — add `'agent_conversation'` to `spaceTypeEnum`
- Create: `packages/db/drizzle/0064_agent_conversation_space_type.sql`

**Backend — write path**
- Modify: `apps/api/src/lib/agent-stream-loop.ts` — redirect inserts from `agentMessages` to `messages`, use `metadata.agent_blocks` for the rich payload
- Modify: `apps/api/src/routes/agent.ts` — POST conversations creates a `spaces` row (type `agent_conversation`); POST messages writes the user turn to `messages`; GET conversations queries spaces; GET conversations/:id/messages queries messages; GET trace.json rebuilds from messages
- Modify: `apps/api/src/routes/agent-followups.ts` — if it reads `agentMessages`, repoint to `messages`

**Migration script**
- Create: `apps/api/src/scripts/backfill-agent-conversations-to-spaces.ts` — one-shot: for each `agent_conversations` row, insert a parallel `spaces` row (same id, type=`agent_conversation`); for each `agent_messages` row, insert a parallel `messages` row (same id, with content+metadata.agent_blocks)

**Schema cleanup migration**
- Create: `packages/db/drizzle/0065_drop_agent_conversations_and_messages.sql`
- Modify: `packages/db/src/schema.ts` — remove `agentConversations`, `agentMessages` table definitions, keep `agentActions` unchanged

**Tests**
- Create: `apps/api/test/agent-streaming-writes-to-messages.test.ts` — POST a /agent message, assert messages row + agent_blocks
- Create: `apps/api/test/agent-conversations-as-spaces.test.ts` — POST conversation creates spaces row; GET conversations returns it
- Create: `apps/api/test/agent-trace-export-from-messages.test.ts` — trace.json compiles from messages
- Create: `apps/api/test/backfill-agent-conversations.test.ts` — backfill is idempotent + correctly migrates rows

---

## Task 1: Add `agent_conversation` to `spaceTypeEnum`

**Files:**
- Modify: `packages/db/src/schema.ts:17`
- Create: `packages/db/drizzle/0064_agent_conversation_space_type.sql`

- [ ] **Step 1: Modify schema.ts**

In `packages/db/src/schema.ts`, find the `spaceTypeEnum` declaration:

```typescript
export const spaceTypeEnum = pgEnum('space_type', ['public', 'private', 'dm', 'group_dm']);
```

Replace with:

```typescript
export const spaceTypeEnum = pgEnum('space_type', ['public', 'private', 'dm', 'group_dm', 'agent_conversation']);
```

- [ ] **Step 2: Create migration 0064**

Create `packages/db/drizzle/0064_agent_conversation_space_type.sql`:

```sql
-- Migration 0064: Add 'agent_conversation' to space_type enum.
-- Phase 2 of agent-chat unification — agent conversations become first-class spaces.
ALTER TYPE space_type ADD VALUE IF NOT EXISTS 'agent_conversation';
```

- [ ] **Step 3: Apply the migration**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm exec tsx -e "
import { db } from './apps/api/src/lib/db.js';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
const content = readFileSync('packages/db/drizzle/0064_agent_conversation_space_type.sql', 'utf-8');
await db.execute(sql.raw(content));
console.log('migration 0064 applied');
process.exit(0);
"
```

Expected: prints "migration 0064 applied".

- [ ] **Step 4: Verify**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm exec tsx -e "
import { db } from './apps/api/src/lib/db.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql\`SELECT enumlabel FROM pg_enum WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'space_type') ORDER BY enumsortorder\`);
console.log(r.rows.map(x => x.enumlabel));
process.exit(0);
"
```

Expected: `[ 'public', 'private', 'dm', 'group_dm', 'agent_conversation' ]`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0064_agent_conversation_space_type.sql && git commit -m "feat(schema): add 'agent_conversation' space type

Phase 2 of agent-chat unification. Agent conversations become spaces
of type 'agent_conversation' with the user + agent (Defty or BYOA)
as members. Subsequent tasks redirect writes/reads from agent_messages
to messages within these spaces.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Helper — `ensureAgentConversationSpace(orgId, userId, agentUserId, conversationId, title)`

**Goal:** A single idempotent helper that ensures a `spaces` row + space_members rows exist for an agent conversation. Used by Task 3 (rewriting POST conversations) and Task 8 (backfill).

**Files:**
- Create: `apps/api/src/lib/ensure-agent-conversation-space.ts`
- Create: `apps/api/test/ensure-agent-conversation-space.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/ensure-agent-conversation-space.test.ts`:

```typescript
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers, spaces, spaceMembers } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { ensureAgentConversationSpace } from '../src/lib/ensure-agent-conversation-space.js';
import { ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';

let orgId: string;
let userId: string;
let deftyUserId: string;
const convoId = `conv-${Date.now()}`;

before(async () => {
  const [org] = await db.insert(orgs).values({ name: 'EACS Test', slug: `eacs-${Date.now()}` }).returning();
  orgId = org!.id;
  const [u] = await db.insert(users).values({
    email: `eacs-u-${Date.now()}@test.local`, name: 'Test User', kind: 'human', email_verified: true,
  }).returning();
  userId = u!.id;
  await db.insert(orgMembers).values({ org_id: orgId, user_id: userId, role: 'owner' });
  deftyUserId = await ensureDeftyMembership(orgId);
});

after(async () => {
  try {
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, convoId));
    await db.delete(spaces).where(eq(spaces.id, convoId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
  } catch {}
});

test('creates spaces row with given id, type=agent_conversation', async () => {
  await ensureAgentConversationSpace({ orgId, userId, agentUserId: deftyUserId, conversationId: convoId, title: 'Test convo' });
  const [s] = await db.select().from(spaces).where(eq(spaces.id, convoId)).limit(1);
  assert.ok(s, 'space row exists');
  assert.equal(s!.type, 'agent_conversation');
  assert.equal(s!.org_id, orgId);
  assert.equal(s!.name, 'Test convo');
});

test('adds both user and agent as space_members', async () => {
  await ensureAgentConversationSpace({ orgId, userId, agentUserId: deftyUserId, conversationId: convoId, title: 'Test convo' });
  const members = await db.select().from(spaceMembers).where(eq(spaceMembers.space_id, convoId));
  const ids = members.map((m) => m.user_id).sort();
  assert.deepEqual(ids.sort(), [userId, deftyUserId].sort());
});

test('is idempotent — second call with same conversationId is a no-op', async () => {
  await ensureAgentConversationSpace({ orgId, userId, agentUserId: deftyUserId, conversationId: convoId, title: 'Test convo' });
  await ensureAgentConversationSpace({ orgId, userId, agentUserId: deftyUserId, conversationId: convoId, title: 'Test convo' });
  const spacesRows = await db.select().from(spaces).where(eq(spaces.id, convoId));
  assert.equal(spacesRows.length, 1);
  const memberRows = await db.select().from(spaceMembers).where(eq(spaceMembers.space_id, convoId));
  assert.equal(memberRows.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsx --test test/ensure-agent-conversation-space.test.ts 2>&1 | tail -10
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the helper**

Create `apps/api/src/lib/ensure-agent-conversation-space.ts`:

```typescript
// Idempotent helper: ensures a spaces row of type 'agent_conversation' exists
// for an agent conversation, with both the user and the agent as members.
// Phase 2 of agent-chat unification.

import { db } from './db.js';
import { spaces, spaceMembers } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';

export type EnsureAgentConversationSpaceArgs = {
  orgId: string;
  userId: string;
  agentUserId: string;
  conversationId: string;
  title: string;
};

export async function ensureAgentConversationSpace(args: EnsureAgentConversationSpaceArgs): Promise<void> {
  const { orgId, userId, agentUserId, conversationId, title } = args;

  // 1. Ensure spaces row exists with this exact id.
  const [existing] = await db.select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.id, conversationId))
    .limit(1);

  if (!existing) {
    await db.insert(spaces).values({
      id: conversationId,
      org_id: orgId,
      name: title,
      type: 'agent_conversation',
      created_by: userId,
    }).onConflictDoNothing();
  }

  // 2. Ensure both members are present.
  await db.insert(spaceMembers).values([
    { space_id: conversationId, user_id: userId },
    { space_id: conversationId, user_id: agentUserId },
  ]).onConflictDoNothing();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsx --test test/ensure-agent-conversation-space.test.ts 2>&1 | tail -10
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/ensure-agent-conversation-space.ts apps/api/test/ensure-agent-conversation-space.test.ts && git commit -m "feat(api): ensureAgentConversationSpace helper

Idempotent helper that materializes an agent_conversation space with
both participants as members. Used by /api/agent/conversations and
the backfill script in Phase 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `POST /api/agent/conversations` creates a space, not an `agent_conversations` row

**Files:**
- Modify: `apps/api/src/routes/agent.ts` (POST /conversations handler — find via grep)

- [ ] **Step 1: Locate the handler**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -n "agentConversations\|conversationsRoutes\.post\|/conversations.*async" apps/api/src/routes/agent.ts | head -10
```

The handler that responds to `POST /api/agent/conversations` lives somewhere in this file. Read 30 lines around the match.

- [ ] **Step 2: Modify the handler to use `ensureAgentConversationSpace`**

The handler currently inserts a row into `agentConversations` and returns it. Instead:
1. Generate a UUID for the conversation (preserve the same id semantics).
2. Call `ensureAgentConversationSpace({ orgId: user.org_id, userId: user.id, agentUserId, conversationId: <uuid>, title: title || 'New conversation' })` where `agentUserId` is Defty's user_id (resolved via `ensureDeftyMembership(user.org_id)` if no `agent_employee_id`) or the agent_employee's user_id (looked up from agent_employees).
3. Return `{ id: conversationId, title, created_at: <now>, ... }` shaped like the old response.

Preserve the response shape so the frontend doesn't need changes. The `agentConversations` table should NO LONGER receive new inserts after this task — but reads continue to work for the brief window before backfill (Task 8).

Add imports:

```typescript
import { ensureAgentConversationSpace } from '../lib/ensure-agent-conversation-space.js';
import { ensureDeftyMembership } from '../lib/ensure-defty-membership.js';
import { agentEmployees } from '@deft/db/schema';
import { randomUUID } from 'node:crypto';
```

Logic:

```typescript
const conversationId = randomUUID();
let agentUserId: string;
if (data.agent_employee_id) {
  const [emp] = await db.select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(eq(agentEmployees.id, data.agent_employee_id))
    .limit(1);
  if (!emp) return c.json({ error: 'Unknown agent employee', code: 'NOT_FOUND' }, 404);
  agentUserId = emp.user_id;
} else {
  agentUserId = await ensureDeftyMembership(user.org_id);
}

await ensureAgentConversationSpace({
  orgId: user.org_id,
  userId: user.id,
  agentUserId,
  conversationId,
  title: data.title || 'New conversation',
});

return c.json({
  id: conversationId,
  user_id: user.id,
  org_id: user.org_id,
  agent_employee_id: data.agent_employee_id ?? null,
  title: data.title || 'New conversation',
  created_at: new Date(),
  updated_at: new Date(),
}, 201);
```

- [ ] **Step 3: Smoke test**

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" -d '{"email":"maneek@test.com","password":"test1234"}' | grep -oE '"accessToken":"[^"]+"' | cut -d'"' -f4)
RESP=$(curl -s -X POST http://localhost:3001/api/agent/conversations -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"title":"Phase2 test convo"}')
echo "Create response: $RESP"
CONVO_ID=$(echo "$RESP" | python -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Convo ID: $CONVO_ID"
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsx -e "
import { db } from './src/lib/db.js';
import { spaces, spaceMembers } from '@deft/db/schema';
import { eq } from 'drizzle-orm';
const id = '$CONVO_ID';
const [s] = await db.select().from(spaces).where(eq(spaces.id, id)).limit(1);
console.log('space type:', s?.type, 'name:', s?.name);
const m = await db.select().from(spaceMembers).where(eq(spaceMembers.space_id, id));
console.log('members:', m.length);
process.exit(0);
"
```

Expected: `space type: agent_conversation`, members: 2.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/agent.ts && git commit -m "feat(api): POST /api/agent/conversations creates space, not agent_conversations row

New conversations now materialize as spaces of type 'agent_conversation'
with the user + agent (Defty or BYOA) as members. The response shape
is preserved so the /agent UI doesn't need changes. Old agent_conversations
rows are still readable until Task 8 backfills them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `GET /api/agent/conversations` queries spaces

**Files:**
- Modify: `apps/api/src/routes/agent.ts` (GET /conversations handler)

- [ ] **Step 1: Read the current handler**

Find the `GET /conversations` handler in `apps/api/src/routes/agent.ts` (around line 312–332). It currently queries `agentConversations` filtered by `user_id`, `org_id`, and optional `agent_employee_id`.

- [ ] **Step 2: Replace with a spaces query**

Query: spaces of type `agent_conversation` in the user's org, filtered to spaces where the user is a member. If `agent_employee_id` is provided, filter to spaces where that agent's user_id is also a member. If `agent_employee_id` is omitted, filter to Defty's spaces (where Defty's user_id is a member, but no agent_employee_id is associated).

```typescript
import { ensureDeftyMembership } from '../lib/ensure-defty-membership.js';
import { agentEmployees } from '@deft/db/schema';
// ... existing imports

const employeeIdFilter = c.req.query('employee'); // matches existing query param

let agentFilterUserId: string | null = null;
if (employeeIdFilter) {
  const [emp] = await db.select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(eq(agentEmployees.id, employeeIdFilter))
    .limit(1);
  agentFilterUserId = emp?.user_id ?? null;
} else {
  // Defty (no employee filter)
  agentFilterUserId = await ensureDeftyMembership(user.org_id);
}

if (!agentFilterUserId) return c.json([], 200);

// Find spaces where BOTH the current user AND the target agent are members.
const result = await db.execute(sql`
  SELECT s.id, s.name AS title, s.created_at, s.updated_at
  FROM spaces s
  WHERE s.org_id = ${user.org_id}
    AND s.type = 'agent_conversation'
    AND s.is_deleted = false
    AND EXISTS (SELECT 1 FROM space_members WHERE space_id = s.id AND user_id = ${user.id})
    AND EXISTS (SELECT 1 FROM space_members WHERE space_id = s.id AND user_id = ${agentFilterUserId})
  ORDER BY s.updated_at DESC NULLS LAST
  LIMIT 100
`);

return c.json(result.rows.map((r: any) => ({
  id: r.id,
  user_id: user.id,
  org_id: user.org_id,
  agent_employee_id: employeeIdFilter ?? null,
  title: r.title,
  created_at: r.created_at,
  updated_at: r.updated_at,
})));
```

Confirm `spaces.is_deleted` exists — check the schema. If it doesn't exist on `spaces`, drop that filter.

- [ ] **Step 3: Smoke test**

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" -d '{"email":"maneek@test.com","password":"test1234"}' | grep -oE '"accessToken":"[^"]+"' | cut -d'"' -f4)
echo "List response (Defty conversations):"
curl -s "http://localhost:3001/api/agent/conversations" -H "Authorization: Bearer $TOKEN" | python -c "
import json,sys
d=json.load(sys.stdin)
print(f'Got {len(d)} conversations. Sample: {json.dumps(d[0], default=str) if d else None}'[:200])
"
```

Expected: Returns at least the conversation created in Task 3. Sample row has fields `id`, `title`, `created_at`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/agent.ts && git commit -m "feat(api): GET /api/agent/conversations queries spaces of type agent_conversation

Filters by current user + agent as space_members. Defty conversations
when employee param omitted; BYOA conversations when present. Response
shape unchanged for the /agent UI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Redirect `agent-stream-loop.ts` writes from `agentMessages` to `messages`

**This is the core write-path change.**

**Files:**
- Modify: `apps/api/src/lib/agent-stream-loop.ts` (lines ~47–282)

- [ ] **Step 1: Read the current loop persistence**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -n "agentMessages\|insert(agentMessages)\|insert(agentActions)" apps/api/src/lib/agent-stream-loop.ts | head -20
```

Identify every `db.insert(agentMessages).values({...})` call. There are typically 2–3 sites:
- An assistant message at the end of each Anthropic API call (line ~140s)
- A user message containing tool_result blocks (line ~250s, when continuing the loop after tool execution)

- [ ] **Step 2: Replace assistant message inserts**

For the assistant message insert site, replace:

```typescript
const [assistantRow] = await db.insert(agentMessages).values({
  conversation_id: conversationId,
  role: 'assistant',
  content: textContent,
  content_blocks: contentBlocks,
  citations,
  tool_calls: toolCalls,
  hidden: allReadOnly,
  model,
  tokens_in: tokensIn,
  tokens_out: tokensOut,
}).returning();
```

With (assuming `agentUserId` is the Defty/BYOA user_id passed into the loop, and `conversationId` is the spaces.id):

```typescript
const [assistantRow] = await db.insert(messages).values({
  org_id: orgId,
  space_id: conversationId,
  user_id: agentUserId,
  content: textContent,
  metadata: {
    is_agent_reply: true,
    agent_blocks: contentBlocks,
    citations,
    tool_calls: toolCalls,
    hidden: allReadOnly,
    model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
  },
}).returning();
```

For the user-tool-result insert, replace similarly with `messages` insert where `user_id` is the human user (the one who initiated the conversation), and `metadata.agent_blocks` carries the tool_result blocks. Use a sentinel `metadata.kind = 'tool_result'` so the read path can filter these from user-visible rendering.

The function signature for `runAgentStreamingLoop` likely already takes `userId`. Confirm; if not, add. Also accept `agentUserId` as a parameter — pass from the caller (Task 6).

- [ ] **Step 3: Replace `agentActions.message_id` linkage**

Current code (around line 192–206) inserts `agentActions` with `message_id: assistantRow.id` referring to the agentMessages row. After this task, it'll reference the new messages row's id. No code change needed since `assistantRow.id` is now the messages.id — but verify the value flowing into agent_actions is correct.

- [ ] **Step 4: Add the `messages` import**

At the top of `agent-stream-loop.ts`, ensure:

```typescript
import { messages, agentActions } from '@deft/db/schema';
```

If you remove `agentMessages` from the import, double-check no other reference remains in the file.

- [ ] **Step 5: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsc --noEmit 2>&1 | grep -E "agent-stream-loop|messages\.ts" | head -10
```

Should be clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/agent-stream-loop.ts && git commit -m "feat(api): agent-stream-loop writes to messages with metadata.agent_blocks

Phase 2 core write-path change. Each Anthropic API turn now inserts
a messages row (instead of agentMessages) with the structured Anthropic
content blocks in metadata.agent_blocks, plus citations/tool_calls/model/
tokens. Tool-result user-side rows go to messages too with
metadata.kind='tool_result' so they can be filtered from rendering.
agent_actions.message_id continues to link to the new messages.id —
same UUID space, no schema change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `POST /api/agent/conversations/:id/messages` (the SSE chat) writes to messages

**Files:**
- Modify: `apps/api/src/routes/agent.ts` (POST /conversations/:id/messages — around lines 442–525)

- [ ] **Step 1: Locate the handler**

Find the SSE chat handler (search for `runAgentStreamingLoop`). Around line 442–525.

- [ ] **Step 2: Update user-message insert**

Where the user's input is currently inserted to `agentMessages`:

```typescript
const [userRow] = await db.insert(agentMessages).values({
  conversation_id,
  role: 'user',
  content: parsed.data.content,
}).returning();
```

Replace with:

```typescript
const [userRow] = await db.insert(messages).values({
  org_id: user.org_id,
  space_id: conversation_id,
  user_id: user.id,
  content: parsed.data.content,
}).returning();
```

- [ ] **Step 3: Resolve agent user id and pass to the streaming loop**

Before calling `runAgentStreamingLoop`, resolve `agentUserId`:

```typescript
import { ensureDeftyMembership } from '../lib/ensure-defty-membership.js';
import { agentEmployees } from '@deft/db/schema';

// Resolve the agent's user_id for the conversation. Look up via space_members
// to find the non-current-user member of this space.
const otherMembers = await db.select({ user_id: spaceMembers.user_id })
  .from(spaceMembers)
  .where(and(
    eq(spaceMembers.space_id, conversation_id),
    sql`${spaceMembers.user_id} != ${user.id}`,
  ));
const agentUserId = otherMembers[0]?.user_id;
if (!agentUserId) {
  return c.json({ error: 'Conversation has no agent member', code: 'INVALID_STATE' }, 400);
}
```

Then pass into the loop:

```typescript
await runAgentStreamingLoop({
  // ... existing params
  conversationId: conversation_id,
  orgId: user.org_id,
  userId: user.id,
  agentUserId,
  // ...
});
```

Update `runAgentStreamingLoop`'s parameter type if needed.

- [ ] **Step 4: Smoke test**

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" -d '{"email":"maneek@test.com","password":"test1234"}' | grep -oE '"accessToken":"[^"]+"' | cut -d'"' -f4)
# Create a fresh conversation
CONVO=$(curl -s -X POST http://localhost:3001/api/agent/conversations -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"title":"P2 task6"}' | python -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Convo: $CONVO"
# Stream a message (will SSE — capture briefly)
curl -s -N -X POST "http://localhost:3001/api/agent/conversations/$CONVO/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"content":"What time is it?"}' | head -c 500 &
CURL_PID=$!
sleep 8
kill $CURL_PID 2>/dev/null
echo ""
# Verify rows in messages table
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsx -e "
import { db } from './src/lib/db.js';
import { messages } from '@deft/db/schema';
import { eq, desc } from 'drizzle-orm';
const r = await db.select().from(messages).where(eq(messages.space_id, '$CONVO')).orderBy(desc(messages.created_at)).limit(5);
console.log(JSON.stringify(r.map(m => ({ id: m.id.slice(0,8), user_id: m.user_id.slice(0,8), content: m.content.slice(0,40), has_agent_blocks: !!(m.metadata && m.metadata.agent_blocks) })), null, 2));
process.exit(0);
"
```

Expected: at least one user row + one assistant row with `has_agent_blocks: true`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agent.ts apps/api/src/lib/agent-stream-loop.ts && git commit -m "feat(api): POST /api/agent/conversations/:id/messages writes to messages

User input inserts into messages (space_id = conversation id). Agent
turn streaming loop receives the resolved agent user_id and writes
its turn to messages too. agent_messages no longer receives writes
from this path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `GET /api/agent/conversations/:id/messages` reads from messages

**Files:**
- Modify: `apps/api/src/routes/agent.ts` (GET /conversations/:id/messages — around lines 393–438)
- Modify: `apps/api/src/routes/agent.ts` (GET /conversations/:id/trace.json — around lines 639–705)

- [ ] **Step 1: Update messages list endpoint**

Replace the `agentMessages` query with a `messages` query filtered by `space_id`. Project `metadata.agent_blocks` back into the response shape that AgentChat expects (`content_blocks`, `citations`, `tool_calls`, `model`, `tokens_in`, `tokens_out`, `hidden`).

```typescript
const rows = await db.select().from(messages)
  .where(and(
    eq(messages.space_id, conversationId),
    eq(messages.org_id, user.org_id),
    eq(messages.is_deleted, false),
  ))
  .orderBy(asc(messages.created_at));

// Map to the shape AgentChat expects
const mapped = rows
  .filter((r) => {
    const m = (r.metadata as any) || {};
    return m.kind !== 'tool_result' && !m.hidden;
  })
  .map((r) => {
    const m = (r.metadata as any) || {};
    const isAgent = m.is_agent_reply === true;
    return {
      id: r.id,
      conversation_id: conversationId,
      role: isAgent ? 'assistant' : 'user',
      content: r.content,
      content_blocks: m.agent_blocks ?? [{ type: 'text', text: r.content }],
      citations: m.citations ?? null,
      tool_calls: m.tool_calls ?? null,
      hidden: m.hidden ?? false,
      model: m.model ?? null,
      tokens_in: m.tokens_in ?? null,
      tokens_out: m.tokens_out ?? null,
      created_at: r.created_at,
      pending_actions: [], // populated below
    };
  });

// Attach pending agent_actions per message via existing query
const allActions = await db.select().from(agentActions)
  .where(eq(agentActions.conversation_id, conversationId));
// ... existing pending_actions attach logic, keying on message_id
```

Note: `agentActions.conversation_id` should now match the spaces.id (which is the same UUID as before). If the existing logic indexes by `conversation_id` it still works.

- [ ] **Step 2: Update trace.json**

Replace the trace handler's `agentMessages` query with a `messages` query (same filters as above, but include hidden + tool_result rows for full audit fidelity), then map back to the trace shape:

```typescript
const rows = await db.select().from(messages)
  .where(and(
    eq(messages.space_id, conversationId),
    eq(messages.org_id, user.org_id),
  ))
  .orderBy(asc(messages.created_at));

const traceMessages = rows.map((r) => {
  const m = (r.metadata as any) || {};
  const role = m.kind === 'tool_result' ? 'user' : (m.is_agent_reply ? 'assistant' : 'user');
  return {
    id: r.id,
    role,
    content: r.content,
    content_blocks: m.agent_blocks ?? null,
    citations: m.citations ?? null,
    tool_calls: m.tool_calls ?? null,
    model: m.model ?? null,
    tokens_in: m.tokens_in ?? null,
    tokens_out: m.tokens_out ?? null,
    created_at: r.created_at,
  };
});
```

Existing actions block stays unchanged.

- [ ] **Step 3: Smoke test**

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" -d '{"email":"maneek@test.com","password":"test1234"}' | grep -oE '"accessToken":"[^"]+"' | cut -d'"' -f4)
# Use convo from Task 6 smoke (or create fresh + send message). Then list:
curl -s "http://localhost:3001/api/agent/conversations" -H "Authorization: Bearer $TOKEN" | python -c "
import json,sys
d=json.load(sys.stdin)
print('first id:', d[0]['id'] if d else None)
" > /tmp/p2-convo-id.txt
CONVO=$(cat /tmp/p2-convo-id.txt | grep -oE '[a-f0-9-]{36}')
echo "Listing messages for $CONVO"
curl -s "http://localhost:3001/api/agent/conversations/$CONVO/messages" -H "Authorization: Bearer $TOKEN" | python -c "
import json,sys
d=json.load(sys.stdin)
print('messages:', len(d))
for m in d[:3]:
    print(f'  - role={m[\"role\"]} content={m[\"content\"][:40]} has_blocks={m.get(\"content_blocks\") is not None}')
"
```

Expected: returns the user + assistant rows from Task 6's smoke, with content_blocks populated for the assistant.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/agent.ts && git commit -m "feat(api): GET conversations/:id/messages + trace.json read from messages

Messages list filters tool-result rows + hidden rows from the response,
unwraps metadata.agent_blocks back into the shape AgentChat expects.
Trace export keeps full fidelity (includes hidden + tool_result rows).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Backfill historical agent conversations + messages

**Files:**
- Create: `apps/api/src/scripts/backfill-agent-conversations-to-spaces.ts`

- [ ] **Step 1: Write the backfill**

Create `apps/api/src/scripts/backfill-agent-conversations-to-spaces.ts`:

```typescript
// One-shot backfill: migrate agent_conversations + agent_messages into
// spaces (type='agent_conversation') + messages (with metadata.agent_blocks).
// Phase 2 of agent-chat unification. Idempotent — safe to re-run.

import { db } from '../lib/db.js';
import { agentConversations, agentMessages, spaces, messages, spaceMembers } from '@deft/db/schema';
import { eq, sql } from 'drizzle-orm';
import { ensureDeftyMembership } from '../lib/ensure-defty-membership.js';
import { agentEmployees } from '@deft/db/schema';

async function main() {
  const allConvos = await db.select().from(agentConversations);
  console.log(`[backfill] found ${allConvos.length} agent_conversations`);
  let convosOk = 0;
  let msgsOk = 0;
  let convosFailed = 0;

  for (const c of allConvos) {
    try {
      // Resolve agent user id
      let agentUserId: string;
      if (c.agent_employee_id) {
        const [emp] = await db.select({ user_id: agentEmployees.user_id })
          .from(agentEmployees).where(eq(agentEmployees.id, c.agent_employee_id)).limit(1);
        if (!emp) {
          console.warn(`[backfill] convo ${c.id} references missing employee ${c.agent_employee_id} — skipping`);
          convosFailed++;
          continue;
        }
        agentUserId = emp.user_id;
      } else {
        agentUserId = await ensureDeftyMembership(c.org_id);
      }

      // Ensure spaces row with same id (idempotent via onConflictDoNothing)
      await db.insert(spaces).values({
        id: c.id,
        org_id: c.org_id,
        name: c.title || 'Conversation',
        type: 'agent_conversation',
        created_by: c.user_id,
        created_at: c.created_at,
        updated_at: c.updated_at,
      }).onConflictDoNothing();

      // Ensure both members
      await db.insert(spaceMembers).values([
        { space_id: c.id, user_id: c.user_id },
        { space_id: c.id, user_id: agentUserId },
      ]).onConflictDoNothing();

      convosOk++;

      // Migrate messages
      const msgs = await db.select().from(agentMessages).where(eq(agentMessages.conversation_id, c.id));
      for (const m of msgs) {
        const isAgent = m.role === 'assistant';
        const metadata: Record<string, unknown> = {
          is_agent_reply: isAgent,
        };
        if (m.content_blocks) metadata.agent_blocks = m.content_blocks;
        if (m.citations) metadata.citations = m.citations;
        if (m.tool_calls) metadata.tool_calls = m.tool_calls;
        if (m.hidden) metadata.hidden = m.hidden;
        if (m.model) metadata.model = m.model;
        if (m.tokens_in != null) metadata.tokens_in = m.tokens_in;
        if (m.tokens_out != null) metadata.tokens_out = m.tokens_out;
        // Detect tool_result rows by inspecting content_blocks
        if (Array.isArray(m.content_blocks) && m.content_blocks.some((b: any) => b.type === 'tool_result')) {
          metadata.kind = 'tool_result';
        }
        await db.insert(messages).values({
          id: m.id,
          org_id: c.org_id,
          space_id: c.id,
          user_id: isAgent ? agentUserId : c.user_id,
          content: m.content,
          metadata,
          created_at: m.created_at,
          updated_at: m.updated_at,
        }).onConflictDoNothing();
        msgsOk++;
      }
    } catch (err) {
      console.error(`[backfill] convo ${c.id} failed:`, err);
      convosFailed++;
    }
  }

  console.log(`[backfill] complete: ${convosOk} ok, ${convosFailed} failed; ${msgsOk} messages migrated`);
  process.exit(convosFailed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('[backfill] fatal', e); process.exit(1); });
```

- [ ] **Step 2: Run the backfill against local DB**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsx src/scripts/backfill-agent-conversations-to-spaces.ts 2>&1 | tail -10
```

Expected: prints counts ("X ok, 0 failed").

- [ ] **Step 3: Verify**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsx -e "
import { db } from './src/lib/db.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql\`
  SELECT
    (SELECT COUNT(*) FROM agent_conversations) AS old_convos,
    (SELECT COUNT(*) FROM spaces WHERE type='agent_conversation') AS new_spaces,
    (SELECT COUNT(*) FROM agent_messages) AS old_msgs,
    (SELECT COUNT(*) FROM messages WHERE metadata->>'is_agent_reply' = 'true' OR metadata->>'kind' = 'tool_result') AS new_msgs
\`);
console.log(r.rows[0]);
process.exit(0);
"
```

Expected: `new_spaces >= old_convos`, `new_msgs >= old_msgs` (greater because new turns from Tasks 5–7 may have added rows).

- [ ] **Step 4: Re-run idempotency check**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsx src/scripts/backfill-agent-conversations-to-spaces.ts 2>&1 | tail -5
```

Expected: same "X ok, 0 failed" — no duplicate rows created.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scripts/backfill-agent-conversations-to-spaces.ts && git commit -m "chore(api): backfill agent_conversations + agent_messages to spaces+messages

One-shot script that copies historical /agent conversation data into
the new schema with original UUIDs preserved. Idempotent. Run once
after Tasks 1-7 ship; safe to re-run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Drop `agent_messages` and `agent_conversations` tables

**Files:**
- Modify: `packages/db/src/schema.ts` — remove `agentConversations`, `agentMessages` table definitions
- Create: `packages/db/drizzle/0065_drop_agent_conversations_and_messages.sql`

- [ ] **Step 1: Confirm no remaining references**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -rn "agentConversations\|agentMessages\|agent_conversations\|agent_messages" apps/api/src apps/web/src packages 2>&1 | grep -v "node_modules\|\.test\.ts\|migration\|backfill" | head -20
```

If references remain in non-test, non-migration code, fix them before proceeding (typically these are stale imports in agent.ts or agent-followups.ts that should now reference messages).

- [ ] **Step 2: Write the migration**

Create `packages/db/drizzle/0065_drop_agent_conversations_and_messages.sql`:

```sql
-- Migration 0065: Drop agent_messages + agent_conversations.
-- Phase 2 of agent-chat unification. Data has been migrated to spaces +
-- messages by backfill-agent-conversations-to-spaces.ts. agent_actions
-- stays — it's the approval ledger, not chat data.

DROP TABLE IF EXISTS agent_messages;
DROP TABLE IF EXISTS agent_conversations;
```

- [ ] **Step 3: Apply the migration**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm exec tsx -e "
import { db } from './apps/api/src/lib/db.js';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
const content = readFileSync('packages/db/drizzle/0065_drop_agent_conversations_and_messages.sql', 'utf-8');
await db.execute(sql.raw(content));
console.log('migration 0065 applied');
process.exit(0);
"
```

Expected: prints "migration 0065 applied".

- [ ] **Step 4: Remove the table definitions from schema.ts**

In `packages/db/src/schema.ts`, find and DELETE the `agentConversations` and `agentMessages` table declarations (around lines 432–455 — the Read tool will show the exact lines). Keep `agentActions` (line ~458–481) unchanged.

- [ ] **Step 5: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm exec tsc --noEmit 2>&1 | tail -10
```

Should be clean OR only show errors in stale tests that import the deleted types. If tests import `agentConversations` / `agentMessages`, delete those test files (they tested the old shape and Phase 2 supersedes them).

- [ ] **Step 6: Run the full Phase 2 test suite**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsx --test test/ensure-agent-conversation-space.test.ts 2>&1 | tail -10
```

Plus the Phase 1 tests (regression check):

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsx --test test/user-kind-migration.test.ts test/members-kind-field.test.ts test/ensure-defty-membership.test.ts test/agent-mention-detection.test.ts 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0065_drop_agent_conversations_and_messages.sql && git commit -m "feat(schema): drop agent_messages + agent_conversations tables

Data migrated to spaces + messages by backfill in Task 8. agent_actions
preserved (approval ledger, not chat data). The /agent UI continues
to work via the unchanged API contracts at /api/agent/conversations.

Phase 2 of agent-chat unification.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Self-review + smoke

- [ ] **Step 1: Run all tests**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/api test 2>&1 | tail -30
```

Expected: Phase 1 + Phase 2 tests all pass. Pre-existing failures (`agent-actions-routes`, `bundled-skills-seed`) remain out of scope.

- [ ] **Step 2: End-to-end UI smoke**

Refresh the browser session. Visit `/agent`. Expected:
- Defty conversations sidebar lists previous conversations (backfilled)
- Click a conversation: messages render, including agent tool-call cards, citations, etc.
- Type a new message + send: streams a response, the response renders with the same fidelity as before

If the rendering is broken, the most likely cause is the `metadata.agent_blocks` shape not matching what AgentChat expects. Check the Network tab on `/api/agent/conversations/:id/messages` and compare to the old shape.

- [ ] **Step 3: Update CLAUDE.md**

In `CLAUDE.md`, find the "Phase 1 unification" paragraph added in Phase 1 (Agent Architecture section). Append to it:

```markdown

**Phase 2 (2026-05-07).** `agent_conversations` and `agent_messages` tables
are dropped. Each /agent conversation is now a `spaces` row of type
`agent_conversation` with the user + agent (Defty or BYOA) as members.
Each agent turn is a `messages` row with structured Anthropic content
blocks in `metadata.agent_blocks`, plus `citations`, `tool_calls`,
`model`, `tokens_in`, `tokens_out`. The `/agent` UI is unchanged because
the API contracts at `/api/agent/conversations[/:id/messages|trace.json]`
preserve their response shapes; only the underlying data source changed.
`agent_actions.message_id` continues to link to chat messages — same
UUID space.
```

Find the corresponding "What NOT To Do" line that Phase 1 annotated and update it again — Phase 2 has now actually superseded the prohibition:

Replace `Don't store agent conversations in the same messages table — separate agent_conversations table — NOTE: Phase 2 will supersede this; see Agent Architecture § Participant model above.` with `Agent conversations live in messages with metadata.agent_blocks (since Phase 2, 2026-05-07). Don't reintroduce parallel agent-only tables; use the unified messages schema.`

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md && git commit -m "docs(claude): note Phase 2 schema collapse, update prohibition

Phase 2 of agent-chat unification has shipped. Update the Agent
Architecture section to note the schema collapse and rewrite the
former prohibition into a current rule.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Show final commit chain**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git log --oneline 3096285..HEAD
```

Should show ~10 Phase 2 commits.

---

## Self-review checklist

**Spec coverage** — every requirement from §8.7 of the spec has a task:
- [x] §8.7 step 1 (mirror writes / new write path) → Tasks 5, 6
- [x] §8.7 step 2 (confidence period) — compressed; Phase 2 ships dual-write + flip in one go (the user explicitly asked for the complete build)
- [x] §8.7 step 3 (flip reads) → Tasks 4, 7
- [x] §8.7 step 4 (backfill historical) → Task 8
- [x] §8.7 step 5 (drop tables) → Task 9
- [x] AgentChat rendering preserved via unchanged API contract — no frontend task needed for Phase 2 (this is intentional; SpaceChat-renders-tool-blocks lands in Phase 4)

**Placeholder scan**: searched for "TBD", "TODO", "implement later", "fill in details", "appropriate error handling" — none present.

**Type consistency**:
- `agentUserId: string` consistent across `ensureAgentConversationSpace`, `runAgentStreamingLoop`, route handlers
- `conversationId: string` (UUID) consistent — also serves as `spaces.id` and `agentActions.conversation_id`
- `metadata.agent_blocks` field naming consistent (Anthropic-shaped content blocks, not "content_blocks" — kept the namespace clean from existing `messages.content`)

---

## Risks and rollback

- **Migration 0065 is destructive.** If reads break after the drop, restoration requires the backfill data (which now lives in spaces + messages). Roll forward, not back. Pre-flight: ensure Task 8 has been run AND the verification queries show row counts match.
- **AgentChat depends on `metadata.agent_blocks` shape exactly matching the old `content_blocks`.** Any subtle field rename will break tool-call rendering. Smoke test in browser before declaring complete.
- **`agent_followups.ts` may read agentMessages.** If grep in Task 9 step 1 finds it, fix that file as part of Task 9 — don't defer.

---

## Hand-off

Phase 2 ships the schema collapse. Phase 3 (next) collapses the MCP tool surface (`send_message`, `fetch_unread`) — uses the unified messages model that Phase 2 establishes.
