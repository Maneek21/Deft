# Agent ↔ Chat Unification — Phase 3: MCP Tool Collapse

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two unified MCP tools so BYOA agents speak the same protocol as humans: `send_message(target, content)` (replaces `message_post` / `post_thread_reply` / proposed `open_dm`) and `fetch_unread()` (complements `poll_pending_work` with chat-message inbox). Old tools stay as deprecation-warned aliases for one release.

**Architecture:** `send_message` takes a discriminated `target` ({space_id} | {thread_id} | {user_id}) and routes to the right insert path. The DM target case auto-creates a 1:1 space if one doesn't exist between the caller's shadow user and the target user. `fetch_unread` reads from `messages` filtered by `space_members.last_read_message_id` for spaces the caller is a member of, and additionally returns pending `agent_actions` rows so a single MCP roundtrip surfaces both kinds of pending work.

**Tech Stack:**
- MCP streamable-http via `apps/api/src/routes/mcp-server-v1.ts`
- Tool registry in `apps/api/src/lib/mcp-tools/index.ts`
- Per-tool implementations in `apps/api/src/lib/mcp-tools/*.ts`
- Node native test runner via `tsx --test` (NOT vitest)

**Spec:** `docs/superpowers/specs/2026-05-07-agent-chat-unification.md` §8.4 schema-collapse table + §8.7 step 3.

**Builds on Phases 1 + 2** (already shipped on this branch). Phase 4 follows: UI collapse — delete `/agent` route, merge AgentChat into SpaceChat with tool-call rendering.

---

## Discovery findings (already done)

- The MCP route Phase 3 targets is `apps/api/src/routes/mcp-server-v1.ts` (the streamable-http surface). The old `mcp-server.ts` (`/api/mcp/*` API-key route) is sunsetting — don't add new tools there.
- Tool registry is `apps/api/src/lib/mcp-tools/index.ts` exporting `toolSchemas[]`, `READ_ONLY_TOOLS`, `WRITE_TOOLS`, `ALL_TOOLS`.
- `message_post` lives in `apps/api/src/lib/mcp-tools/writes.ts` (lines ~550–562). Args: `space_id`, `content`, optional `parent_id`. Tier `full`. Inserts to `messages` with `space_members` check, broadcasts `message:new` socket.
- `poll_pending_work` lives in `apps/api/src/lib/mcp-tools/cooperative.ts` (lines ~152–177). Returns pending `agent_actions` for the calling employee, limit 25, DESC by created_at.
- `thread_fetch` lives in `apps/api/src/lib/mcp-tools/messages.ts`. Reads parent + replies. Pattern reference for our new `fetch_unread`.
- `space_members.last_read_message_id` (text) and `last_read_at` (timestamp) track per-member read state. Already populated for human users; agent shadow users inherit the same column when added.
- The bundled `deft-mcp-client` skill is defined in `apps/api/src/lib/bundled-skills.ts:59–88`. The `system_prompt_addition` field is the prompt nudge BYOA runtimes get.
- Test pattern: call tool functions directly (not HTTP routes). Pattern reference: `apps/api/test/mcp-write-tools.test.ts`.
- Trust-tier gate: `shouldAutoExecute(action, trustLevel)` in `apps/api/src/lib/agent-approval.ts`. `TOOL_APPROVAL_TIERS` map needs the new `send_message` entry.
- Phase 2's collapse already had MCP-safe semantics — `message_post` writes to `messages` (no `agent_messages` left). `send_message` inherits the same write path.

---

## File Structure

**Tool implementations**
- Modify: `apps/api/src/lib/mcp-tools/writes.ts` — add `sendMessage()` function
- Modify: `apps/api/src/lib/mcp-tools/messages.ts` — add `fetchUnread()` function

**Tool registry**
- Modify: `apps/api/src/lib/mcp-tools/index.ts` — register both new tools in `toolSchemas[]`, `WRITE_TOOLS`, `READ_ONLY_TOOLS`

**Approval matrix**
- Modify: `apps/api/src/lib/agent-approval.ts` — add `send_message` to `TOOL_APPROVAL_TIERS` (tier `full`)

**Bundled skill**
- Modify: `apps/api/src/lib/bundled-skills.ts:59–88` — update `deft-mcp-client.system_prompt_addition` to nudge use of `send_message` and `fetch_unread`

**Deprecation warnings**
- Modify: `apps/api/src/lib/mcp-tools/writes.ts:messagePost` — log a deprecation warning at the top of the function (no behavior change)
- Modify: `apps/api/src/lib/mcp-tools/cooperative.ts:pollPendingWork` — same pattern

**Tests**
- Create: `apps/api/test/mcp-send-message.test.ts` — covers all three target shapes + approval queueing
- Create: `apps/api/test/mcp-fetch-unread.test.ts` — covers unread filter + pending_actions inclusion

---

## Task 1: Add `send_message` to the approval matrix

**Files:**
- Modify: `apps/api/src/lib/agent-approval.ts`

- [ ] **Step 1: Locate the approval-tier map**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -nE "TOOL_APPROVAL_TIERS|message_post.*'full'" apps/api/src/lib/agent-approval.ts | head -10
```

Find the `TOOL_APPROVAL_TIERS` record. Read 5 lines around `message_post` to see neighboring entries.

- [ ] **Step 2: Add the `send_message` entry**

Insert next to `message_post`:

```typescript
message_post: 'full',
send_message: 'full',
```

(Match the existing formatting — comma-separated lines, alphabetical or grouped by domain depending on the existing pattern.)

- [ ] **Step 3: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsc --noEmit 2>&1 | grep -E "agent-approval" | head
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/api/src/lib/agent-approval.ts && git commit -m "feat(api): register send_message in approval-tier matrix

Phase 3 of agent-chat unification — preparing for the new unified MCP
tool. Tier 'full' (queued for approval unless caller is autonomous +
non-destructive).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Implement `sendMessage()` in writes.ts

**Files:**
- Modify: `apps/api/src/lib/mcp-tools/writes.ts`

- [ ] **Step 1: Read the current file structure**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -nE "^export.*function|messagePost|executeMessagePost|queueAction" apps/api/src/lib/mcp-tools/writes.ts | head -15
```

Find `messagePost`, `executeMessagePost`, and the `queueAction` helper. Read 30 lines around `messagePost` to mirror the pattern.

- [ ] **Step 2: Add the `sendMessage` function**

After `messagePost` (or in a logical alphabetical spot), add:

```typescript
/**
 * Phase 3 of agent-chat unification — unified message-send tool.
 * Target is one of:
 *   - { space_id }           — post in an existing space
 *   - { thread_id }          — reply in a thread (parent message id)
 *   - { user_id }            — DM target user; creates the DM space if missing
 *
 * Tier 'full': queued for approval unless caller's trust is autonomous.
 */
export async function sendMessage(args: {
  caller_employee_slug: string;
  target: { space_id: string } | { thread_id: string } | { user_id: string };
  content: string;
}, ctx: ToolCallContext): Promise<unknown> {
  const { target, content } = args;

  // Resolve target → { space_id, parent_id? } so the rest is uniform.
  let spaceId: string;
  let parentId: string | null = null;

  if ('space_id' in target) {
    spaceId = target.space_id;
  } else if ('thread_id' in target) {
    // Look up the parent message and use its space_id; thread_id is the parent message id.
    const [parent] = await db.select({ id: messages.id, space_id: messages.space_id })
      .from(messages)
      .where(and(eq(messages.id, target.thread_id), eq(messages.org_id, ctx.org_id)))
      .limit(1);
    if (!parent) {
      return { error: 'thread_id not found', code: 'NOT_FOUND' };
    }
    spaceId = parent.space_id;
    parentId = parent.id;
  } else if ('user_id' in target) {
    // Find or create a 1:1 DM space between caller's shadow user and the target user.
    spaceId = await findOrCreateDmSpace(ctx.org_id, ctx.caller_user_id, target.user_id);
  } else {
    return { error: 'target must include space_id, thread_id, or user_id', code: 'VALIDATION_ERROR' };
  }

  // Membership check: caller must be a member of the destination space.
  const [membership] = await db.select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, ctx.caller_user_id)))
    .limit(1);
  if (!membership) {
    return { error: 'Caller is not a member of the destination space', code: 'FORBIDDEN' };
  }

  // Trust-tier gate
  if (!shouldAutoExecute('send_message', ctx.trust_level)) {
    return queueAction({
      action: 'send_message',
      params: { target, content, resolved_space_id: spaceId, parent_id: parentId },
      ctx,
    });
  }

  return executeSendMessage({ orgId: ctx.org_id, spaceId, userId: ctx.caller_user_id, content, parentId });
}

async function executeSendMessage(args: {
  orgId: string;
  spaceId: string;
  userId: string;
  content: string;
  parentId: string | null;
}): Promise<{ message_id: string; space_id: string }> {
  const { orgId, spaceId, userId, content, parentId } = args;
  const [row] = await db.insert(messages).values({
    org_id: orgId,
    space_id: spaceId,
    user_id: userId,
    content,
    parent_id: parentId,
  }).returning();

  // Broadcast via Socket.io (mirror messagePost)
  const io = getIO();
  if (io && row) {
    io.to(`space:${spaceId}`).emit('message:new', { ...row, reactions: [], reply_count: 0, latest_reply_at: null });
  }

  return { message_id: row!.id, space_id: spaceId };
}

/**
 * Find an existing 1:1 DM space between two users in the same org, or create
 * one. Used by sendMessage's user_id target path.
 */
async function findOrCreateDmSpace(orgId: string, userIdA: string, userIdB: string): Promise<string> {
  // Existing DM = a space of type='dm' where both users are members and only those two.
  const existing = await db.execute(sql`
    SELECT s.id FROM spaces s
    WHERE s.org_id = ${orgId}
      AND s.type = 'dm'
      AND EXISTS (SELECT 1 FROM space_members WHERE space_id = s.id AND user_id = ${userIdA})
      AND EXISTS (SELECT 1 FROM space_members WHERE space_id = s.id AND user_id = ${userIdB})
      AND (SELECT COUNT(*) FROM space_members WHERE space_id = s.id) = 2
    LIMIT 1
  `);
  if (existing.rows.length > 0) {
    return (existing.rows[0] as { id: string }).id;
  }

  // Create new DM. Use a deterministic name; the chat UI overrides display anyway.
  const [space] = await db.insert(spaces).values({
    org_id: orgId,
    name: `DM`,
    type: 'dm',
    created_by: userIdA,
  }).returning();
  await db.insert(spaceMembers).values([
    { space_id: space!.id, user_id: userIdA },
    { space_id: space!.id, user_id: userIdB },
  ]).onConflictDoNothing();
  return space!.id;
}
```

Imports at the top of `writes.ts` (check what's already there):

```typescript
import { messages, spaces, spaceMembers } from '@deft/db/schema';
import { sql, and, eq } from 'drizzle-orm';
import { shouldAutoExecute } from '../agent-approval.js';
import { getIO } from '../../socket.js';
```

(Most of these are likely already imported. Confirm and don't duplicate.)

- [ ] **Step 3: Add deprecation warning to messagePost**

At the top of `messagePost` (the existing function), add a one-line warn so old callers get a soft signal:

```typescript
console.warn('[mcp] message_post is deprecated; use send_message');
```

Place it directly inside the function, before any logic. No behavior change.

- [ ] **Step 4: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsc --noEmit 2>&1 | grep -E "writes\.ts" | head -10
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/api/src/lib/mcp-tools/writes.ts && git commit -m "feat(api): sendMessage MCP tool — unified target dispatch

Phase 3 of agent-chat unification. Single tool replaces message_post +
post_thread_reply + open_dm. Target shape is a discriminated union
({space_id} | {thread_id} | {user_id}); the user_id path auto-creates
a DM space between the caller and the target if one doesn't exist.

Trust-tier gate via shouldAutoExecute (tier 'full' from Task 1). Old
message_post logs a deprecation warning.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Implement `fetchUnread()` in messages.ts

**Files:**
- Modify: `apps/api/src/lib/mcp-tools/messages.ts`

- [ ] **Step 1: Read the file**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -nE "^export.*function|threadFetch|^import" apps/api/src/lib/mcp-tools/messages.ts | head -20
```

Note the existing imports — `messages`, `spaces`, `spaceMembers`, `users`, `agent_actions` may be available.

- [ ] **Step 2: Add fetchUnread**

```typescript
/**
 * Phase 3 of agent-chat unification — unified inbox tool.
 *
 * Returns:
 *   unread_messages: messages newer than the caller's last_read in spaces
 *     they're a member of, up to `limit`
 *   pending_actions: same shape as poll_pending_work — agent_actions rows
 *     where approval_status='pending' for the calling employee
 *
 * One MCP roundtrip surfaces both kinds of pending work.
 */
export async function fetchUnread(args: {
  caller_employee_slug: string;
  limit?: number;
  space_id?: string;
}, ctx: ToolCallContext): Promise<{
  unread_messages: Array<{
    id: string;
    space_id: string;
    user_id: string;
    user_name: string | null;
    content: string;
    parent_id: string | null;
    is_dm: boolean;
    created_at: Date;
  }>;
  pending_actions: Array<{
    id: string;
    action: string;
    params: unknown;
    approval_tier: string;
    created_at: Date;
  }>;
}> {
  const limit = Math.min(args.limit ?? 20, 100);

  // Fetch unread messages — join space_members for the caller to get last_read_at,
  // then return messages newer than that in the calling user's spaces.
  const unreadRows = await db.execute(sql`
    SELECT m.id, m.space_id, m.user_id, m.content, m.parent_id, m.created_at,
           u.name AS user_name,
           s.type AS space_type
    FROM messages m
    JOIN space_members sm ON sm.space_id = m.space_id AND sm.user_id = ${ctx.caller_user_id}
    JOIN spaces s ON s.id = m.space_id
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ${ctx.org_id}
      AND m.is_deleted = false
      AND m.user_id != ${ctx.caller_user_id}
      AND (sm.last_read_at IS NULL OR m.created_at > sm.last_read_at)
      ${args.space_id ? sql`AND m.space_id = ${args.space_id}` : sql``}
    ORDER BY m.created_at DESC
    LIMIT ${limit}
  `);

  const unreadMessages = unreadRows.rows.map((r: any) => ({
    id: r.id as string,
    space_id: r.space_id as string,
    user_id: r.user_id as string,
    user_name: r.user_name as string | null,
    content: r.content as string,
    parent_id: r.parent_id as string | null,
    is_dm: r.space_type === 'dm',
    created_at: r.created_at as Date,
  }));

  // Pending agent_actions for the calling employee (matches poll_pending_work shape).
  const actionRows = await db.select({
    id: agentActions.id,
    action: agentActions.action,
    params: agentActions.params,
    approval_tier: agentActions.approval_tier,
    created_at: agentActions.created_at,
  })
    .from(agentActions)
    .where(and(
      eq(agentActions.agent_employee_id, ctx.caller_employee_id),
      eq(agentActions.approval_status, 'pending'),
    ))
    .orderBy(desc(agentActions.created_at))
    .limit(25);

  return {
    unread_messages: unreadMessages,
    pending_actions: actionRows,
  };
}
```

Imports needed (check what's already there):

```typescript
import { messages, spaces, spaceMembers, users, agentActions } from '@deft/db/schema';
import { sql, and, eq, desc } from 'drizzle-orm';
```

- [ ] **Step 3: Add deprecation warning to pollPendingWork**

In `apps/api/src/lib/mcp-tools/cooperative.ts`, at the top of the `pollPendingWork` function, add:

```typescript
console.warn('[mcp] poll_pending_work is deprecated; use fetch_unread (returns both unread messages + pending actions)');
```

No behavior change.

- [ ] **Step 4: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsc --noEmit 2>&1 | grep -E "messages\.ts|cooperative\.ts" | head -10
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/api/src/lib/mcp-tools/messages.ts apps/api/src/lib/mcp-tools/cooperative.ts && git commit -m "feat(api): fetchUnread MCP tool — chat inbox + pending actions

Phase 3 of agent-chat unification. Returns unread messages (newer
than last_read_at for spaces the caller is a member of, excluding
caller's own posts) and pending agent_actions in one roundtrip.
Old poll_pending_work logs a deprecation warning.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Register both tools in `mcp-tools/index.ts`

**Files:**
- Modify: `apps/api/src/lib/mcp-tools/index.ts`

- [ ] **Step 1: Read the registry structure**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -nE "toolSchemas|READ_ONLY_TOOLS|WRITE_TOOLS|message_post|poll_pending_work" apps/api/src/lib/mcp-tools/index.ts | head -20
```

Identify (a) the `toolSchemas` array — JSON Schema definitions, (b) the `READ_ONLY_TOOLS` and `WRITE_TOOLS` records mapping tool name → handler function.

- [ ] **Step 2: Add `send_message` schema entry**

In the `toolSchemas` array, add (next to `message_post`):

```typescript
{
  name: 'send_message',
  description: 'Send a chat message. Target is one of: a space, a thread (reply to a parent message), or a user (DM — auto-creates a 1:1 space if needed). Replaces message_post + post_thread_reply.',
  inputSchema: {
    type: 'object',
    properties: {
      caller_employee_slug: { type: 'string', description: 'Slug of the calling employee.' },
      target: {
        oneOf: [
          { type: 'object', required: ['space_id'], properties: { space_id: { type: 'string' } }, additionalProperties: false },
          { type: 'object', required: ['thread_id'], properties: { thread_id: { type: 'string', description: 'Parent message id — reply lands as a thread reply under it.' } }, additionalProperties: false },
          { type: 'object', required: ['user_id'], properties: { user_id: { type: 'string', description: 'DM target user. Auto-creates a 1:1 DM space if one does not exist.' } }, additionalProperties: false },
        ],
      },
      content: { type: 'string', minLength: 1 },
    },
    required: ['caller_employee_slug', 'target', 'content'],
    additionalProperties: false,
  },
}
```

- [ ] **Step 3: Add `fetch_unread` schema entry**

```typescript
{
  name: 'fetch_unread',
  description: 'Fetch unread messages (in spaces the caller is a member of) plus pending agent_actions. One roundtrip surfaces both kinds of pending work. Replaces poll_pending_work.',
  inputSchema: {
    type: 'object',
    properties: {
      caller_employee_slug: { type: 'string' },
      limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
      space_id: { type: 'string', description: 'Optional — restrict to one space.' },
    },
    required: ['caller_employee_slug'],
    additionalProperties: false,
  },
}
```

- [ ] **Step 4: Wire handlers**

In the `WRITE_TOOLS` record, add:

```typescript
send_message: sendMessage,
```

In the `READ_ONLY_TOOLS` record, add:

```typescript
fetch_unread: fetchUnread,
```

Make sure the imports at top include both new functions:

```typescript
import { messagePost, taskCreate, taskUpdate, sendMessage } from './writes.js';
import { threadFetch, fetchUnread } from './messages.js';
```

- [ ] **Step 5: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsc --noEmit 2>&1 | grep -E "mcp-tools/index" | head -10
```

Expected: clean.

- [ ] **Step 6: Smoke that tools/list returns both new tools**

The dev server hot-reloads on save. Hit `tools/list`:

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" -d '{"email":"maneek@test.com","password":"test1234"}' | grep -oE '"accessToken":"[^"]+"' | cut -d'"' -f4)
# Need an MCP token — query the DB for the live BYOA agent's token
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && cat > tmp-list-tools.ts <<'EOF'
import { ALL_TOOLS, toolSchemas } from './src/lib/mcp-tools/index.js';
const names = Object.keys(ALL_TOOLS).sort();
console.log('Total registered:', names.length);
console.log('Has send_message:', names.includes('send_message'));
console.log('Has fetch_unread:', names.includes('fetch_unread'));
const schemaNames = toolSchemas.map((s: any) => s.name).sort();
console.log('Schema has send_message:', schemaNames.includes('send_message'));
console.log('Schema has fetch_unread:', schemaNames.includes('fetch_unread'));
process.exit(0);
EOF
pnpm exec tsx tmp-list-tools.ts 2>&1 | tail -10
rm tmp-list-tools.ts
```

Expected: all four "Has X" lines print `true`.

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/api/src/lib/mcp-tools/index.ts && git commit -m "feat(api): register send_message + fetch_unread in MCP tool registry

Adds JSON Schema entries to toolSchemas[] and wires handlers into
WRITE_TOOLS / READ_ONLY_TOOLS so MCP clients (BYOA agents) can
discover and call them via tools/list and tools/call.

Phase 3 of agent-chat unification.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Tests for `send_message`

**Files:**
- Create: `apps/api/test/mcp-send-message.test.ts`

- [ ] **Step 1: Read sibling test pattern**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && head -80 apps/api/test/mcp-write-tools.test.ts
```

Note: the test seeds an org + employee + space, then calls the tool function directly (not via HTTP). Tier behavior is checked via the returned shape (`status: 'pending_approval'` vs `message_id`).

- [ ] **Step 2: Write the tests**

Create `apps/api/test/mcp-send-message.test.ts`:

```typescript
/**
 * MCP send_message tool — covers all three target shapes and approval tier.
 * Phase 3 of agent-chat unification.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/mcp-send-message.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers, spaces, spaceMembers, messages, agentEmployees } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { sendMessage } from '../src/lib/mcp-tools/writes.js';

let orgId: string;
let humanUserId: string;
let agentUserId: string;
let agentEmployeeId: string;
let publicSpaceId: string;

before(async () => {
  const [org] = await db.insert(orgs).values({ name: 'sendmsg test', slug: `sm-${Date.now()}` }).returning();
  orgId = org!.id;

  const [human] = await db.insert(users).values({
    email: `sm-h-${Date.now()}@test.local`, name: 'Human', kind: 'human', email_verified: true,
  }).returning();
  humanUserId = human!.id;

  const [agent] = await db.insert(users).values({
    name: 'Test BYOA', kind: 'agent', is_agent: true, email_verified: true,
  }).returning();
  agentUserId = agent!.id;

  await db.insert(orgMembers).values([
    { org_id: orgId, user_id: humanUserId, role: 'owner' },
    { org_id: orgId, user_id: agentUserId, role: 'member' },
  ]);

  const [employee] = await db.insert(agentEmployees).values({
    org_id: orgId, user_id: agentUserId, name: 'Test BYOA', slug: `test-byoa-${Date.now()}`,
    role: 'engineering_lead', system_prompt: 'test', trust_level: 'autonomous', is_byoa: true,
  }).returning();
  agentEmployeeId = employee!.id;

  const [space] = await db.insert(spaces).values({
    org_id: orgId, name: 'general', type: 'public', created_by: humanUserId,
  }).returning();
  publicSpaceId = space!.id;
  await db.insert(spaceMembers).values([
    { space_id: publicSpaceId, user_id: humanUserId },
    { space_id: publicSpaceId, user_id: agentUserId },
  ]);
});

after(async () => {
  // Best-effort cleanup. Skip user delete if cross-org refs exist.
  try {
    await db.delete(messages).where(eq(messages.space_id, publicSpaceId));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, publicSpaceId));
    await db.delete(spaces).where(eq(spaces.id, publicSpaceId));
    // Clean any DM spaces the test created
    const dms = await db.select({ id: spaces.id }).from(spaces).where(and(eq(spaces.org_id, orgId), eq(spaces.type, 'dm')));
    for (const dm of dms) {
      await db.delete(messages).where(eq(messages.space_id, dm.id));
      await db.delete(spaceMembers).where(eq(spaceMembers.space_id, dm.id));
      await db.delete(spaces).where(eq(spaces.id, dm.id));
    }
    await db.delete(agentEmployees).where(eq(agentEmployees.id, agentEmployeeId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(users).where(eq(users.id, humanUserId));
    await db.delete(users).where(eq(users.id, agentUserId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
  } catch (err) { console.error('cleanup', err); }
});

function mkCtx() {
  return {
    org_id: orgId,
    caller_user_id: agentUserId,
    caller_employee_id: agentEmployeeId,
    trust_level: 'autonomous' as const,
  };
}

test('send_message with space_id target inserts a message in the space', async () => {
  const result = await sendMessage(
    { caller_employee_slug: 'test-byoa', target: { space_id: publicSpaceId }, content: 'hello space' },
    mkCtx() as any,
  ) as { message_id: string; space_id: string };
  assert.equal(result.space_id, publicSpaceId);
  const [row] = await db.select().from(messages).where(eq(messages.id, result.message_id)).limit(1);
  assert.equal(row?.content, 'hello space');
  assert.equal(row?.parent_id, null);
});

test('send_message with thread_id target replies under the parent', async () => {
  // First post a parent
  const parent = await sendMessage(
    { caller_employee_slug: 'test-byoa', target: { space_id: publicSpaceId }, content: 'parent' },
    mkCtx() as any,
  ) as { message_id: string };
  // Reply via thread_id
  const reply = await sendMessage(
    { caller_employee_slug: 'test-byoa', target: { thread_id: parent.message_id }, content: 'reply' },
    mkCtx() as any,
  ) as { message_id: string; space_id: string };
  const [row] = await db.select().from(messages).where(eq(messages.id, reply.message_id)).limit(1);
  assert.equal(row?.parent_id, parent.message_id);
  assert.equal(row?.space_id, publicSpaceId);
});

test('send_message with user_id target creates a DM space and posts there', async () => {
  const result = await sendMessage(
    { caller_employee_slug: 'test-byoa', target: { user_id: humanUserId }, content: 'dm test' },
    mkCtx() as any,
  ) as { message_id: string; space_id: string };

  const [space] = await db.select().from(spaces).where(eq(spaces.id, result.space_id)).limit(1);
  assert.equal(space?.type, 'dm');

  const members = await db.select().from(spaceMembers).where(eq(spaceMembers.space_id, result.space_id));
  const ids = members.map((m) => m.user_id).sort();
  assert.deepEqual(ids, [agentUserId, humanUserId].sort());
});

test('send_message with user_id target reuses the same DM on a second call', async () => {
  const r1 = await sendMessage(
    { caller_employee_slug: 'test-byoa', target: { user_id: humanUserId }, content: 'dm 1' },
    mkCtx() as any,
  ) as { space_id: string };
  const r2 = await sendMessage(
    { caller_employee_slug: 'test-byoa', target: { user_id: humanUserId }, content: 'dm 2' },
    mkCtx() as any,
  ) as { space_id: string };
  assert.equal(r1.space_id, r2.space_id);
});

test('send_message rejects unknown target shape', async () => {
  const result = await sendMessage(
    { caller_employee_slug: 'test-byoa', target: {} as any, content: 'oops' },
    mkCtx() as any,
  ) as { error: string; code: string };
  assert.equal(result.code, 'VALIDATION_ERROR');
});

test('send_message queues for approval when trust is conservative', async () => {
  const ctx = { ...mkCtx(), trust_level: 'conservative' as const };
  const result = await sendMessage(
    { caller_employee_slug: 'test-byoa', target: { space_id: publicSpaceId }, content: 'queued' },
    ctx as any,
  ) as { status?: string; action_id?: string };
  assert.equal(result.status, 'pending_approval');
  assert.ok(result.action_id);
});
```

- [ ] **Step 3: Run the test**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsx --test test/mcp-send-message.test.ts 2>&1 | tail -20
```

Expected: 6 tests pass. If any fail, fix the implementation in writes.ts (Task 2) — these tests are the spec.

The `mkCtx()` shape may not exactly match the real `ToolCallContext` type the codebase uses. Check `apps/api/src/lib/mcp-tools/index.ts` for the actual `ToolCallContext` type definition and adjust the test fixture (or the cast `as any`) to match. The real shape may include fields like `request_id`, `client`, etc.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/api/test/mcp-send-message.test.ts && git commit -m "test(api): mcp send_message — 6 cases across target shapes + tier

Phase 3 of agent-chat unification.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Tests for `fetch_unread`

**Files:**
- Create: `apps/api/test/mcp-fetch-unread.test.ts`

- [ ] **Step 1: Write the tests**

Create `apps/api/test/mcp-fetch-unread.test.ts`:

```typescript
/**
 * MCP fetch_unread tool — covers unread filter + pending_actions inclusion.
 * Phase 3 of agent-chat unification.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/mcp-fetch-unread.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers, spaces, spaceMembers, messages, agentEmployees, agentActions } from '@deft/db/schema';
import { eq } from 'drizzle-orm';
import { fetchUnread } from '../src/lib/mcp-tools/messages.js';

let orgId: string;
let humanUserId: string;
let agentUserId: string;
let agentEmployeeId: string;
let spaceId: string;

before(async () => {
  const [org] = await db.insert(orgs).values({ name: 'fetchunread test', slug: `fu-${Date.now()}` }).returning();
  orgId = org!.id;
  const [h] = await db.insert(users).values({
    email: `fu-h-${Date.now()}@test.local`, name: 'H', kind: 'human', email_verified: true,
  }).returning();
  humanUserId = h!.id;
  const [a] = await db.insert(users).values({
    name: 'A', kind: 'agent', is_agent: true, email_verified: true,
  }).returning();
  agentUserId = a!.id;
  await db.insert(orgMembers).values([
    { org_id: orgId, user_id: humanUserId, role: 'owner' },
    { org_id: orgId, user_id: agentUserId, role: 'member' },
  ]);
  const [emp] = await db.insert(agentEmployees).values({
    org_id: orgId, user_id: agentUserId, name: 'A', slug: `a-${Date.now()}`,
    role: 'engineering_lead', system_prompt: '', trust_level: 'autonomous', is_byoa: true,
  }).returning();
  agentEmployeeId = emp!.id;
  const [s] = await db.insert(spaces).values({
    org_id: orgId, name: 'fu', type: 'public', created_by: humanUserId,
  }).returning();
  spaceId = s!.id;
  await db.insert(spaceMembers).values([
    { space_id: spaceId, user_id: humanUserId },
    { space_id: spaceId, user_id: agentUserId },
  ]);
});

after(async () => {
  try {
    await db.delete(agentActions).where(eq(agentActions.agent_employee_id, agentEmployeeId));
    await db.delete(messages).where(eq(messages.space_id, spaceId));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
    await db.delete(spaces).where(eq(spaces.id, spaceId));
    await db.delete(agentEmployees).where(eq(agentEmployees.id, agentEmployeeId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(users).where(eq(users.id, humanUserId));
    await db.delete(users).where(eq(users.id, agentUserId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
  } catch (err) { console.error('cleanup', err); }
});

function mkCtx() {
  return {
    org_id: orgId,
    caller_user_id: agentUserId,
    caller_employee_id: agentEmployeeId,
    trust_level: 'autonomous' as const,
  };
}

test('fetch_unread returns messages from human in spaces the caller is a member of', async () => {
  // Human posts a message
  await db.insert(messages).values({
    org_id: orgId,
    space_id: spaceId,
    user_id: humanUserId,
    content: 'hello agent',
  });
  const result = await fetchUnread({ caller_employee_slug: 'a' }, mkCtx() as any);
  assert.ok(result.unread_messages.some((m) => m.content === 'hello agent'));
});

test('fetch_unread excludes the callers own posts', async () => {
  await db.insert(messages).values({
    org_id: orgId,
    space_id: spaceId,
    user_id: agentUserId,
    content: 'self post should not appear',
  });
  const result = await fetchUnread({ caller_employee_slug: 'a' }, mkCtx() as any);
  assert.ok(!result.unread_messages.some((m) => m.content === 'self post should not appear'));
});

test('fetch_unread returns pending_actions for the caller', async () => {
  const [action] = await db.insert(agentActions).values({
    org_id: orgId,
    user_id: humanUserId,
    agent_employee_id: agentEmployeeId,
    action: 'create_task',
    params: { title: 'pending' },
    approval_tier: 'quick',
    approval_status: 'pending',
  }).returning();
  const result = await fetchUnread({ caller_employee_slug: 'a' }, mkCtx() as any);
  assert.ok(result.pending_actions.some((a) => a.id === action!.id));
});

test('fetch_unread limit caps the unread_messages array', async () => {
  // Bulk insert
  for (let i = 0; i < 5; i++) {
    await db.insert(messages).values({
      org_id: orgId, space_id: spaceId, user_id: humanUserId, content: `bulk ${i}`,
    });
  }
  const result = await fetchUnread({ caller_employee_slug: 'a', limit: 3 }, mkCtx() as any);
  assert.ok(result.unread_messages.length <= 3);
});

test('fetch_unread space_id filter restricts to that space', async () => {
  // Other space the caller is also a member of
  const [other] = await db.insert(spaces).values({
    org_id: orgId, name: 'other', type: 'public', created_by: humanUserId,
  }).returning();
  await db.insert(spaceMembers).values([
    { space_id: other!.id, user_id: humanUserId },
    { space_id: other!.id, user_id: agentUserId },
  ]);
  await db.insert(messages).values({
    org_id: orgId, space_id: other!.id, user_id: humanUserId, content: 'in other',
  });
  const result = await fetchUnread({ caller_employee_slug: 'a', space_id: spaceId }, mkCtx() as any);
  assert.ok(!result.unread_messages.some((m) => m.content === 'in other'));
  // Cleanup
  await db.delete(messages).where(eq(messages.space_id, other!.id));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, other!.id));
  await db.delete(spaces).where(eq(spaces.id, other!.id));
});
```

- [ ] **Step 2: Run the test**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsx --test test/mcp-fetch-unread.test.ts 2>&1 | tail -20
```

Expected: 5 tests pass.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/api/test/mcp-fetch-unread.test.ts && git commit -m "test(api): mcp fetch_unread — unread filter + pending actions

Phase 3 of agent-chat unification.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Update `deft-mcp-client` skill prompt

**Files:**
- Modify: `apps/api/src/lib/bundled-skills.ts`

- [ ] **Step 1: Read the current prompt**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -nA 30 "slug:.*deft-mcp-client" apps/api/src/lib/bundled-skills.ts | head -50
```

- [ ] **Step 2: Update the system_prompt_addition**

Replace the existing `system_prompt_addition` with a version that nudges agents toward the new tools:

```typescript
system_prompt_addition: `You have an MCP connection to your Deft workspace. On every turn, start by:

1. Call \`deft_platform_context\` to refresh your understanding of the org, current date, teammates, and active projects.
2. Call \`deft_fetch_unread\` to see what new messages and pending actions are waiting for you. This single call returns BOTH unread chat messages (people @-mentioning you, DMs, replies in threads you're part of) AND pending agent_actions (tasks queued for you to approve or execute).
3. Triage what you found and decide what to act on.

To send a message, use \`deft_send_message\`. The \`target\` field tells it where to go:
- \`{ space_id }\` — post in a public/private space.
- \`{ thread_id }\` — reply in a thread (\`thread_id\` = parent message id).
- \`{ user_id }\` — DM someone directly. The 1:1 space is auto-created if it doesn't exist yet.

The older tools \`deft_message_post\`, \`deft_post_thread_reply\`, and \`deft_poll_pending_work\` still work for one release but are deprecated — prefer the unified pair.

Be concise. Don't @-mention yourself. Don't reply if the message wasn't addressed to you.`,
```

(Keep the surrounding skill manifest fields — `slug`, `name`, `description`, `mcp_servers`, `requires_env`, etc. — unchanged.)

- [ ] **Step 3: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsc --noEmit 2>&1 | grep -E "bundled-skills" | head
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/api/src/lib/bundled-skills.ts && git commit -m "feat(api): deft-mcp-client prompt nudges send_message + fetch_unread

Phase 3 of agent-chat unification. Updates the bundled MCP-client
skill's system_prompt_addition so any BYOA runtime that installs
this skill knows to use the unified tools. Old tools still work
for backwards compatibility (deprecation warning logged server-side).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: End-to-end MCP smoke + CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run all Phase 1+2+3 tests**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsx --test test/user-kind-migration.test.ts test/members-kind-field.test.ts test/ensure-defty-membership.test.ts test/agent-mention-detection.test.ts test/ensure-agent-conversation-space.test.ts test/mcp-send-message.test.ts test/mcp-fetch-unread.test.ts 2>&1 | tail -15
```

Expected: all pass (Phase 1: 17, Phase 2: 3, Phase 3: 11).

- [ ] **Step 2: Update CLAUDE.md**

Find the existing Phase 2 paragraph in `CLAUDE.md` (Agent Architecture section). Append a Phase 3 paragraph immediately after it:

```markdown


**Phase 3 (2026-05-07).** Two unified MCP tools added: `send_message`
(target = `{space_id}` | `{thread_id}` | `{user_id}` — replaces
`message_post` + `post_thread_reply` + planned `open_dm`) and
`fetch_unread` (unread chat messages + pending `agent_actions` in one
roundtrip — replaces `poll_pending_work`). The old tools still work
this release but log a deprecation warning. The `deft-mcp-client`
bundled skill prompt nudges agents toward the new tools.
```

- [ ] **Step 3: Commit CLAUDE.md**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add CLAUDE.md && git commit -m "docs(claude): note Phase 3 MCP tool collapse

Phase 3 of agent-chat unification has shipped: send_message and
fetch_unread are the unified MCP surface. Old tools deprecated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Final commit chain**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git log --oneline 504bacb..HEAD
```

Expected: ~9 Phase 3 commits.

---

## Self-review checklist

**Spec coverage** — every line from §8.7 step 3:
- [x] `send_message({target, content})` → Tasks 2 + 4 + 5
- [x] `fetch_unread()` → Tasks 3 + 4 + 6
- [x] Old tools aliased + deprecated → Tasks 2 + 3 (deprecation warnings, not aliases — semantically equivalent for our needs)
- [x] `deft-mcp-client` bundled skill prompt updated → Task 7

**Placeholder scan**: searched for "TBD", "TODO", "implement later", "appropriate handling" — none.

**Type consistency**:
- `target` shape `{space_id} | {thread_id} | {user_id}` consistent across schema, function signature, tests
- `caller_employee_slug`, `caller_user_id`, `caller_employee_id` consistent in tests + ctx shapes
- `findOrCreateDmSpace(orgId, userIdA, userIdB)` argument order consistent

---

## Risks and rollback

- **send_message DM creation race**: two concurrent `send_message` calls with the same `user_id` target could create two DM spaces before either commits. Acceptable for now (rare; future invariant: unique partial index on dm-space pairs). Not blocking.
- **fetch_unread with no `last_read_at` on a brand-new BYOA**: the `OR sm.last_read_at IS NULL` clause means a fresh agent's first call returns ALL messages in its spaces. That can be a huge list. Mitigated by `limit` param (default 20). BYOA prompt should call `fetch_unread` with sensible bounds.
- **Deprecation warnings are stdout-only**: log each call. Could be loud. If it becomes noisy, add a per-process dedup. Not blocking.

---

## Phase 4 hand-off

Phase 4 (next) does the UI collapse: delete `/agent` route, merge AgentChat into SpaceChat with tool-call rendering, inline approval cards. Phase 3 ships the protocol; Phase 4 makes the UI match.
