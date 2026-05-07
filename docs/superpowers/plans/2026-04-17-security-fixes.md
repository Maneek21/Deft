# Security Vulnerability Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

> **Status: COMPLETE** — All 7 tasks shipped 2026-04-17. Commits: `c817a56`, `1e83ab8`, `6c2c110`, `a612de7`, `2293bf3`, `4504e47`, `7b4987c`, `e423ce0`.

**Goal:** Fix 10 confirmed security vulnerabilities (XSS, IDOR, access control, path traversal, race condition) to bring the platform to trusted-tester launch readiness.

**Architecture:** Minimal, surgical fixes — no refactors, no architectural changes. Each fix adds the missing guard (sanitization, auth check, or ordering fix) at the exact vulnerable call site.

**Tech Stack:** DOMPurify (frontend HTML sanitization), Drizzle ORM `and(eq())` guards (backend auth), `path.basename()` (upload fix).

---

## File Map

### Frontend (XSS fixes)
- **Modify:** `apps/web/src/components/space-chat.tsx` — sanitize all `dangerouslySetInnerHTML` outputs
- **Modify:** `apps/web/src/components/thread-panel.tsx` — sanitize all `dangerouslySetInnerHTML` outputs  
- **Modify:** `apps/web/src/components/task-detail.tsx` — sanitize comment HTML
- **Modify:** `apps/web/src/app/(app)/notes/page.tsx` — sanitize version content
- **Modify:** `apps/web/src/app/(app)/dashboard/page.tsx` — sanitize standup summary
- **Create:** `apps/web/src/lib/sanitize.ts` — single DOMPurify wrapper

### Backend (IDOR + access control fixes)
- **Modify:** `apps/api/src/routes/workflows.ts` — reorder delete, add org_id guard
- **Modify:** `apps/api/src/routes/agent.ts` — verify ownership before deleting messages
- **Modify:** `apps/api/src/routes/tasks.ts` — add org_id check to wiki-links delete
- **Modify:** `apps/api/src/routes/spaces.ts` — add spaceMembers checks to GET members, POST members
- **Modify:** `apps/api/src/routes/messages.ts` — add membership checks to GET messages, POST forward
- **Modify:** `apps/api/src/routes/pins.ts` — add membership check
- **Modify:** `apps/api/src/socket.ts` — validate membership on space:join
- **Modify:** `apps/api/src/routes/upload.ts` — sanitize filename, fix Content-Disposition
- **Modify:** `apps/api/src/routes/daily-notes.ts` — add CAS version check

---

### Task 1: Install DOMPurify + create sanitize utility

**Files:**
- Modify: `apps/web/package.json` (install dompurify)
- Create: `apps/web/src/lib/sanitize.ts`

- [x] **Step 1: Install DOMPurify**

```bash
cd apps/web && pnpm add dompurify && pnpm add -D @types/dompurify
```

- [x] **Step 2: Create sanitize utility**

Create `apps/web/src/lib/sanitize.ts`:

```typescript
import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'span', 'div', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'hr', 'sub', 'sup', 'mark',
];

const ALLOWED_ATTR = [
  'href', 'target', 'rel', 'class', 'style', 'src', 'alt', 'title',
  'data-mention-id', 'data-mention-name', 'data-type',
  'colspan', 'rowspan',
];

export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}
```

- [x] **Step 3: Commit**

```bash
git add apps/web/src/lib/sanitize.ts apps/web/package.json apps/web/pnpm-lock.yaml
git commit -m "feat(security): add DOMPurify sanitize utility for XSS prevention"
```

---

### Task 2: Sanitize all dangerouslySetInnerHTML in space-chat.tsx and thread-panel.tsx

**Files:**
- Modify: `apps/web/src/components/space-chat.tsx` (lines ~167, ~380, ~406, ~1222)
- Modify: `apps/web/src/components/thread-panel.tsx` (lines ~55, ~123, ~133)

- [x] **Step 1: Fix space-chat.tsx**

Add import at top:
```typescript
import { sanitizeHtml } from '@/lib/sanitize';
```

Fix `inlineFormat()` (line ~167) — escape HTML entities BEFORE regex processing:
```typescript
function inlineFormat(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .replace(/`([^`]+)`/g, '<code style="...">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}
```

Wrap all `dangerouslySetInnerHTML` outputs with `sanitizeHtml()`:
- Line ~380: `dangerouslySetInnerHTML={{ __html: sanitizeHtml(processed) }}`
- Line ~406: `dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}`
- Line ~1222: `dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderSimpleMarkdown(recapSummary)) }}`

- [x] **Step 2: Fix thread-panel.tsx**

Same pattern — add import, fix `inlineFormat()`, wrap all `dangerouslySetInnerHTML`:
- Line ~123: `dangerouslySetInnerHTML={{ __html: sanitizeHtml(processed) }}`
- Line ~133: `dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}`

- [x] **Step 3: Commit**

```bash
git add apps/web/src/components/space-chat.tsx apps/web/src/components/thread-panel.tsx
git commit -m "fix(security): sanitize all dangerouslySetInnerHTML in chat components"
```

---

### Task 3: Sanitize dangerouslySetInnerHTML in task-detail, notes, dashboard

**Files:**
- Modify: `apps/web/src/components/task-detail.tsx` (line ~2397)
- Modify: `apps/web/src/app/(app)/notes/page.tsx` (line ~810)
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx` (line ~907)

- [x] **Step 1: Fix task-detail.tsx**

Add import and wrap comment content:
```typescript
import { sanitizeHtml } from '@/lib/sanitize';
// ...
dangerouslySetInnerHTML={{ __html: sanitizeHtml(c.content) }}
```

- [x] **Step 2: Fix notes/page.tsx**

```typescript
import { sanitizeHtml } from '@/lib/sanitize';
// ...
dangerouslySetInnerHTML={{ __html: sanitizeHtml(selectedVersion.content || '<em>Empty</em>') }}
```

- [x] **Step 3: Fix dashboard/page.tsx**

```typescript
import { sanitizeHtml } from '@/lib/sanitize';
// ...
dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderSimpleMarkdown(d.standup.summary)) }}
```

- [x] **Step 4: Commit**

```bash
git add apps/web/src/components/task-detail.tsx apps/web/src/app/\(app\)/notes/page.tsx apps/web/src/app/\(app\)/dashboard/page.tsx
git commit -m "fix(security): sanitize HTML in task comments, notes versions, dashboard standup"
```

---

### Task 4: Fix IDOR — workflow runs, agent messages, wiki citations

**Files:**
- Modify: `apps/api/src/routes/workflows.ts` (lines ~115-131)
- Modify: `apps/api/src/routes/agent.ts` (lines ~376-386)
- Modify: `apps/api/src/routes/tasks.ts` (lines ~2211-2220)

- [x] **Step 1: Fix workflows.ts — verify ownership BEFORE deleting runs**

```typescript
workflowRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  // Verify ownership FIRST
  const [rule] = await db.select({ id: workflowRules.id })
    .from(workflowRules)
    .where(and(eq(workflowRules.id, id), eq(workflowRules.org_id, user.org_id)))
    .limit(1);

  if (!rule) {
    return c.json({ error: 'Workflow rule not found', code: 'NOT_FOUND' }, 404);
  }

  // Safe to delete runs now
  await db.delete(workflowRuns).where(eq(workflowRuns.rule_id, id));
  await db.delete(workflowRules).where(eq(workflowRules.id, id));

  return c.json({ success: true });
});
```

- [x] **Step 2: Fix agent.ts — verify conversation ownership BEFORE deleting messages**

```typescript
agentRoutes.delete('/conversations/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  // Verify ownership FIRST
  const [conv] = await db.select({ id: agentConversations.id })
    .from(agentConversations)
    .where(and(eq(agentConversations.id, id), eq(agentConversations.user_id, user.id)))
    .limit(1);

  if (!conv) {
    return c.json({ success: true }); // Don't leak existence
  }

  // Safe to delete now
  await db.delete(agentMessages).where(eq(agentMessages.conversation_id, id));
  await db.delete(agentConversations).where(eq(agentConversations.id, id));
  return c.json({ success: true });
});
```

- [x] **Step 3: Fix tasks.ts — add org_id check to wiki citation delete**

```typescript
taskRoutes.delete('/:id/wiki-links/:citationId', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const citationId = c.req.param('citationId');

    // Verify task belongs to user's org
    const [task] = await db.select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.org_id, user.org_id)))
      .limit(1);

    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    // Delete citation only if it belongs to this task
    await db.delete(wikiCitations).where(
      and(eq(wikiCitations.id, citationId), eq(wikiCitations.task_id, taskId))
    );
    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to unlink task from wiki:', err);
    return c.json({ error: 'Failed to unlink', code: 'INTERNAL_ERROR' }, 500);
  }
});
```

- [x] **Step 4: Commit**

```bash
git add apps/api/src/routes/workflows.ts apps/api/src/routes/agent.ts apps/api/src/routes/tasks.ts
git commit -m "fix(security): prevent IDOR on workflow runs, agent messages, wiki citations"
```

---

### Task 5: Add space membership enforcement to all space endpoints

**Files:**
- Modify: `apps/api/src/routes/spaces.ts` (GET /:id/members ~264, POST /:id/members ~302)
- Modify: `apps/api/src/routes/messages.ts` (GET /:spaceId ~150, POST /forward ~88)
- Modify: `apps/api/src/routes/pins.ts` (POST + DELETE)
- Modify: `apps/api/src/socket.ts` (space:join ~106)

The membership check pattern to add everywhere:

```typescript
// Helper: check if user is member of space (add near top of each file or as shared util)
async function isSpaceMember(spaceId: string, userId: string): Promise<boolean> {
  const [m] = await db.select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, userId)))
    .limit(1);
  return !!m;
}
```

Since multiple route files need this, create a shared helper.

- [x] **Step 1: Create shared membership check utility**

Create `apps/api/src/lib/space-membership.ts`:

```typescript
import { db } from '@deft/db';
import { spaceMembers } from '@deft/db/schema';
import { and, eq } from 'drizzle-orm';

export async function requireSpaceMembership(spaceId: string, userId: string): Promise<boolean> {
  const [member] = await db.select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, userId)))
    .limit(1);
  return !!member;
}
```

- [x] **Step 2: Fix spaces.ts — add membership check to GET /:id/members**

After the space existence check (~line 274), add:
```typescript
const isMember = await requireSpaceMembership(spaceId, user.id);
if (!isMember) return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
```

- [x] **Step 3: Fix spaces.ts — add permission check to POST /:id/members**

After the space existence check, verify the requesting user is already a member:
```typescript
const isMember = await requireSpaceMembership(spaceId, user.id);
if (!isMember) return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
```

- [x] **Step 4: Fix messages.ts — add membership check to GET /:spaceId messages**

After extracting spaceId, before the query:
```typescript
const isMember = await requireSpaceMembership(spaceId, user.id);
if (!isMember) return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
```

- [x] **Step 5: Fix messages.ts — add membership checks to POST /forward**

Check both source and target space membership:
```typescript
const isSourceMember = await requireSpaceMembership(original.space_id, user.id);
if (!isSourceMember) return c.json({ error: 'No access to source message', code: 'FORBIDDEN' }, 403);

const isTargetMember = await requireSpaceMembership(target_space_id, user.id);
if (!isTargetMember) return c.json({ error: 'No access to target space', code: 'FORBIDDEN' }, 403);
```

- [x] **Step 6: Fix pins.ts — add membership check to both PIN and UNPIN**

```typescript
const isMember = await requireSpaceMembership(spaceId, user.id);
if (!isMember) return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
```

- [x] **Step 7: Fix socket.ts — validate membership on space:join**

```typescript
socket.on('space:join', async (spaceId: string) => {
  if (!userId) return;
  const [member] = await db.select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, userId)))
    .limit(1);
  if (member) {
    socket.join(`space:${spaceId}`);
  }
});
```

Note: socket.ts may need the db import and schema imports. Check existing imports in the file. The `userId` should already be available from the socket auth middleware.

- [x] **Step 8: Commit**

```bash
git add apps/api/src/lib/space-membership.ts apps/api/src/routes/spaces.ts apps/api/src/routes/messages.ts apps/api/src/routes/pins.ts apps/api/src/socket.ts
git commit -m "fix(security): enforce space membership on all space/message/pin/socket endpoints"
```

---

### Task 6: Fix upload path traversal + Content-Disposition injection

**Files:**
- Modify: `apps/api/src/routes/upload.ts` (lines ~29-36, ~87)

- [x] **Step 1: Sanitize filename on upload**

```typescript
import { basename } from 'node:path';

// Replace line ~29:
const originalName = file.name;
// With:
const originalName = basename(file.name).replace(/[^\w.\-]/g, '_');
```

This strips directory components AND removes special characters.

- [x] **Step 2: Fix Content-Disposition header**

```typescript
// Replace line ~87:
'Content-Disposition': `inline; filename="${fileRecord.filename}"`,
// With:
'Content-Disposition': `attachment; filename="${encodeURIComponent(fileRecord.filename)}"`,
```

Changed `inline` to `attachment` (prevents HTML/JS execution in browser) and URI-encoded the filename.

- [x] **Step 3: Commit**

```bash
git add apps/api/src/routes/upload.ts
git commit -m "fix(security): sanitize upload filenames and fix Content-Disposition header"
```

---

### Task 7: Fix daily notes version race condition

**Files:**
- Modify: `apps/api/src/routes/daily-notes.ts` (lines ~273-287)

- [x] **Step 1: Add CAS (compare-and-swap) version check**

Replace the blind update with a conditional update that checks version hasn't changed:

```typescript
// Instead of:
// updates.version = full.version + 1;
// await db.update(notes).set(updates).where(eq(notes.id, noteId));

// Use:
if (parsed.data.content !== undefined && parsed.data.content !== full.content) {
  await db.insert(noteVersions).values({
    note_id: noteId,
    version: full.version,
    title: full.title,
    content: full.content,
    edited_by: user.id,
  }).onConflictDoNothing();
  updates.version = full.version + 1;
}

const [updated] = await db.update(notes)
  .set(updates)
  .where(and(eq(notes.id, noteId), eq(notes.version, full.version)))
  .returning();

if (!updated) {
  return c.json({ error: 'Note was modified by another session. Please refresh and try again.', code: 'CONFLICT' }, 409);
}
```

The key change: adding `eq(notes.version, full.version)` to the WHERE clause. If another request incremented the version between our read and write, this update returns 0 rows → 409 Conflict.

- [x] **Step 2: Commit**

```bash
git add apps/api/src/routes/daily-notes.ts
git commit -m "fix(security): add optimistic locking to daily notes PATCH to prevent race condition"
```

---

## Execution Handoff

**Parallelization strategy:**

- **Batch 1 (parallel):** Tasks 1 + 4 + 6 + 7 — all touch disjoint files
- **Batch 2 (parallel, after Task 1):** Tasks 2 + 3 — both depend on sanitize.ts from Task 1, but touch disjoint frontend files
- **Batch 3 (serial):** Task 5 — touches multiple backend route files; run alone to avoid conflicts

Total: 7 tasks, 3 batches, ~30 minutes estimated.
