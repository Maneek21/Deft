# Task Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the key gaps in Deft's task management to match Linear's feature depth while leveraging Deft's unique chat+wiki+agent integration.

**Architecture:** Schema additions to the `tasks` table (start_date, estimation), new `task_watchers` table, upgrade comments to rich text, and add recurring task support via a cron job. All changes are additive — no breaking changes to existing task flows.

**Tech Stack:** PostgreSQL (Drizzle ORM), Hono API, React + TipTap, Socket.io

---

## File Structure

### Modified Files
| File | Changes |
|------|---------|
| `packages/db/src/schema.ts` | Add `start_date`, `estimation`, `is_template` to tasks; add `taskWatchers` table |
| `apps/api/src/routes/tasks.ts` | Watcher endpoints, template endpoints, estimation field handling, rich comments |
| `apps/web/src/components/task-detail.tsx` | Rich text comments, watchers UI, estimation picker, start date picker, template toggle |
| `apps/web/src/app/(app)/tasks/page.tsx` | Template selector in quick-create, estimation column in list view |

### New Files
| File | Purpose |
|------|---------|
| `apps/api/src/workers/handlers/task-recurring.ts` | Cron handler to create next instance of recurring tasks |

---

### Task 1: Schema Changes (start_date, estimation, watchers, templates)

**Files:**
- Modify: `packages/db/src/schema.ts`

- [ ] **Step 1: Add columns to tasks table**

Add after the `due_date` field (~line 202):
```typescript
start_date: timestamp('start_date'),
estimation: text('estimation'), // 'xs' | 's' | 'm' | 'l' | 'xl' or story points as string
is_template: boolean('is_template').default(false).notNull(),
```

- [ ] **Step 2: Add taskWatchers table**

Add after the taskRelationships table:
```typescript
export const taskWatchers = pgTable('task_watchers', {
  ...id(),
  task_id: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  user_id: text('user_id').notNull().references(() => users.id),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('task_watcher_unique').on(t.task_id, t.user_id),
  index('task_watcher_task_idx').on(t.task_id),
]);
```

- [ ] **Step 3: Run database migration**

```sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date TIMESTAMP;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimation TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS task_watchers (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS task_watcher_unique ON task_watchers(task_id, user_id);
CREATE INDEX IF NOT EXISTS task_watcher_task_idx ON task_watchers(task_id);
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: PASS

---

### Task 2: Task Watchers API

**Files:**
- Modify: `apps/api/src/routes/tasks.ts`

- [ ] **Step 1: Import taskWatchers**

Add `taskWatchers` to the import from `@deft/db/schema`.

- [ ] **Step 2: Add watcher endpoints**

Add before the `/:id` GET route (to avoid route conflicts):

```typescript
// GET /api/tasks/:id/watchers — list watchers
taskRoutes.get('/:id/watchers', async (c) => {
  const user = c.get('user');
  const taskId = c.req.param('id');
  const watchers = await db.select({
    id: taskWatchers.id,
    user_id: taskWatchers.user_id,
    user_name: users.name,
    user_avatar: users.avatar_url,
    created_at: taskWatchers.created_at,
  }).from(taskWatchers)
    .innerJoin(users, eq(taskWatchers.user_id, users.id))
    .where(eq(taskWatchers.task_id, taskId));
  return c.json({ watchers });
});

// POST /api/tasks/:id/watch — watch a task
taskRoutes.post('/:id/watch', async (c) => {
  const user = c.get('user');
  const taskId = c.req.param('id');
  await db.insert(taskWatchers).values({
    task_id: taskId,
    user_id: user.id,
  }).onConflictDoNothing();
  return c.json({ success: true });
});

// DELETE /api/tasks/:id/watch — unwatch a task
taskRoutes.delete('/:id/watch', async (c) => {
  const user = c.get('user');
  const taskId = c.req.param('id');
  await db.delete(taskWatchers)
    .where(and(eq(taskWatchers.task_id, taskId), eq(taskWatchers.user_id, user.id)));
  return c.json({ success: true });
});
```

- [ ] **Step 3: Update notification logic**

In the task update notification section, also notify watchers (not just assignee). Query taskWatchers for the task, create notifications for each watcher who isn't the actor.

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && pnpm typecheck`

---

### Task 3: Rich Text Comments

**Files:**
- Modify: `apps/web/src/components/task-detail.tsx`

- [ ] **Step 1: Replace textarea with TipTap editor in comments**

Replace the plain `<textarea>` for comment input with a mini TipTap editor (reuse StarterKit + Placeholder + Link, same config as chat composer but simpler — no mentions needed).

- [ ] **Step 2: Render comment content as HTML**

Change comment rendering from `{comment.content}` to `<div dangerouslySetInnerHTML={{ __html: comment.content }} className="deft-editor" />` so rich text renders properly.

- [ ] **Step 3: Typecheck + test**

Run: `cd apps/web && pnpm typecheck`
Test: Open a task, add a comment with bold/italic/code, verify it renders with formatting.

---

### Task 4: Start Date + Estimation in Task Detail

**Files:**
- Modify: `apps/web/src/components/task-detail.tsx`
- Modify: `apps/api/src/routes/tasks.ts`

- [ ] **Step 1: Add start_date and estimation to task PATCH handler**

In the update task endpoint, add `start_date` and `estimation` to the accepted update fields.

- [ ] **Step 2: Add start date picker in detail panel**

Add a date picker next to the existing due date picker. Label: "Start". When both start and due dates are set, show the range.

- [ ] **Step 3: Add estimation picker**

Add estimation selector below priority: T-shirt sizes (XS, S, M, L, XL) rendered as clickable pills. Save to task.estimation on click.

- [ ] **Step 4: Show estimation in board cards**

Add a small estimation badge on task cards in the Kanban board (e.g., "M" in a rounded pill).

- [ ] **Step 5: Typecheck + test**

---

### Task 5: Task Templates

**Files:**
- Modify: `apps/api/src/routes/tasks.ts`
- Modify: `apps/web/src/app/(app)/tasks/page.tsx`

- [ ] **Step 1: Add template endpoints**

```typescript
// GET /api/tasks/templates — list task templates
taskRoutes.get('/templates', async (c) => {
  const user = c.get('user');
  const templates = await db.select({
    id: tasks.id,
    title: tasks.title,
    description: tasks.description,
    priority: tasks.priority,
    estimation: tasks.estimation,
  }).from(tasks)
    .where(and(eq(tasks.org_id, user.org_id), eq(tasks.is_template, true), eq(tasks.is_deleted, false)))
    .orderBy(tasks.title);
  return c.json({ templates });
});

// POST /api/tasks/templates — create a task template
taskRoutes.post('/templates', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const [template] = await db.insert(tasks).values({
    org_id: user.org_id,
    project_id: body.project_id,
    number: 0, // templates don't consume task numbers
    title: body.title,
    description: body.description || null,
    priority: body.priority || 'p2',
    estimation: body.estimation || null,
    is_template: true,
    created_by: user.id,
  }).returning();
  return c.json(template, 201);
});
```

Note: Template endpoints MUST be registered before `/:id` routes to avoid Hono treating "templates" as an ID.

- [ ] **Step 2: Add template selector to quick-create modal**

In the new task modal, add a "From template" dropdown at the top. When selected, pre-fill title, description, priority, estimation from the template. User can then modify before creating.

- [ ] **Step 3: Seed default templates**

Create 3 default templates:
- "Bug Report" (P1, description template with Steps to Reproduce / Expected / Actual)
- "Feature Request" (P2, description template with User Story / Acceptance Criteria)
- "Technical Debt" (P3, description template with Current State / Desired State / Approach)

- [ ] **Step 4: Typecheck + test**

---

### Task 6: Multiple Assignees

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `apps/api/src/routes/tasks.ts`
- Modify: `apps/web/src/components/task-detail.tsx`
- Modify: `apps/web/src/app/(app)/tasks/page.tsx`

- [ ] **Step 1: Add task_assignees junction table**

```typescript
export const taskAssignees = pgTable('task_assignees', {
  ...id(),
  task_id: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  user_id: text('user_id').notNull().references(() => users.id),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('task_assignee_unique').on(t.task_id, t.user_id),
]);
```

Keep the existing `assignee_id` column as the "primary assignee" for backward compatibility. The junction table adds additional assignees.

- [ ] **Step 2: Create migration**

```sql
CREATE TABLE IF NOT EXISTS task_assignees (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS task_assignee_unique ON task_assignees(task_id, user_id);
```

- [ ] **Step 3: Add API endpoints**

```typescript
POST /api/tasks/:id/assignees — add assignee { user_id }
DELETE /api/tasks/:id/assignees/:userId — remove assignee
```

Return assignee list in task detail response (join taskAssignees + users).

- [ ] **Step 4: Update task detail UI**

Change the single assignee picker to a multi-select. Show avatar stack (max 3 + "+N"). Clicking opens member picker. Primary assignee shown first with a small star indicator.

- [ ] **Step 5: Update board cards**

Show avatar stack on Kanban cards instead of single avatar.

- [ ] **Step 6: Typecheck + build**

---

### Task 7: Recurring Tasks

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `apps/api/src/workers/handlers/task-recurring.ts`
- Modify: `apps/api/src/workers/index.ts`
- Modify: `apps/web/src/components/task-detail.tsx`

- [ ] **Step 1: Add recurrence fields to tasks**

```typescript
recurrence: text('recurrence'), // 'daily' | 'weekly' | 'biweekly' | 'monthly' | null
recurrence_source_id: text('recurrence_source_id'), // points to the original task
```

```sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_source_id TEXT;
```

- [ ] **Step 2: Create recurring task worker**

`apps/api/src/workers/handlers/task-recurring.ts`:

When a task with `recurrence` is moved to `done` or `cancelled`:
- Calculate next due date based on recurrence type
- Create a new task with same title, description, priority, assignee, labels
- Set new task's `due_date` to calculated date
- Set `recurrence` to same value (chain continues)
- Set `recurrence_source_id` to original task ID
- Log in task activity

- [ ] **Step 3: Hook into task status change**

In the task PATCH handler, after status update to `done`/`cancelled`, check if task has `recurrence`. If yes, enqueue `task-recurring` job.

- [ ] **Step 4: Add recurrence picker in task detail**

Dropdown in task detail: "Repeat: None | Daily | Weekly | Biweekly | Monthly". Saves to task.recurrence.

- [ ] **Step 5: Typecheck + test**

---

### Task 8: Task-Wiki Linking (Deft Differentiator)

**Files:**
- Modify: `apps/web/src/components/task-detail.tsx`
- Modify: `apps/api/src/routes/tasks.ts`

- [ ] **Step 1: Add wiki link section to task detail**

In the task detail panel, add a "Related Knowledge" section (after Dependencies). Shows wiki pages linked to this task.

- [ ] **Step 2: Add link/unlink endpoints**

```typescript
POST /api/tasks/:id/wiki-links — { slug } — links task to wiki page
DELETE /api/tasks/:id/wiki-links/:slug — unlinks
GET /api/tasks/:id/wiki-links — returns linked wiki pages
```

Use `wikiCitations` table with `source_type: 'task'` and `source_id: taskId` to store the link. This reuses existing infrastructure.

- [ ] **Step 3: Add wiki page picker**

Searchable dropdown that queries `/api/wiki?q=...` and lets user pick a wiki page to link. Shows page title, type badge, and confidence.

- [ ] **Step 4: Show task references on wiki pages**

In wiki detail view, add a "Referenced by Tasks" section that queries tasks linked via wikiCitations. Clickable to navigate to task.

- [ ] **Step 5: Typecheck + test**

---

### Task 9: Smart Task Creation from Chat (Deft Differentiator)

**Files:**
- Modify: `apps/api/src/lib/agent-context.ts`
- Modify: `apps/web/src/components/space-chat.tsx`

- [ ] **Step 1: Enhance "Create task" from chat**

When the "Create task" button is clicked on a message hover, pre-fill:
- Title: first sentence of the message (truncated to 100 chars)
- Description: full message content as blockquote + "Created from chat in #channel"
- If message mentions a user, suggest them as assignee

Currently the create-task button opens a blank modal. Change it to pass `defaultTitle`, `defaultDescription`, `defaultAssignee` props based on the message content.

- [ ] **Step 2: Agent smart task creation**

In the agent's `create_task` tool handler, use Haiku to analyze the conversation context and suggest:
- Priority (based on urgency words: "urgent", "blocker", "ASAP" → P0/P1)
- Assignee (based on who's being asked or who volunteered)

This enriches the agent's task creation without requiring the user to specify everything.

- [ ] **Step 3: Typecheck + test**

---

## Verification Checklist

After all tasks are complete:

- [ ] `cd apps/api && pnpm typecheck` — PASS
- [ ] `cd apps/web && pnpm typecheck` — PASS
- [ ] `pnpm --filter @deft/web build` — PASS
- [ ] Playwright: Navigate to /tasks, verify board renders
- [ ] API: `GET /api/tasks/:id/watchers` — returns watchers list
- [ ] API: `POST /api/tasks/:id/watch` — adds watcher
- [ ] API: `GET /api/tasks/templates` — returns templates
- [ ] UI: Open task detail → add rich text comment → verify renders with formatting
- [ ] UI: Set start date + due date → verify range display
- [ ] UI: Set estimation (M) → verify badge on board card
- [ ] UI: Create task from template → verify pre-filled fields
- [ ] UI: Link wiki page to task → verify in "Related Knowledge" section

## Build Order

1. Task 1 (schema) — foundation for everything
2. Task 2 (watchers) — independent, small
3. Task 3 (rich comments) — independent, small
4. Task 4 (start date + estimation) — independent, small
5. Task 5 (templates) — depends on schema Task 1
6. Task 6 (multiple assignees) — independent, medium
7. Task 7 (recurring tasks) — depends on schema Task 1
8. Task 8 (task-wiki linking) — independent, Deft differentiator
9. Task 9 (smart task creation) — independent, Deft differentiator
