# Task Remaining Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three remaining task management gaps: sprint-free velocity (Deft's alternative to sprints), multi-level subtasks, and timeline view.

**Architecture:** Velocity is a computed metric from task activity data (no new tables). Multi-level subtasks removes the parent_task_id restriction and adds recursive queries. Timeline view is a new frontend component using start_date → due_date ranges.

**Tech Stack:** PostgreSQL (recursive CTEs), Hono API, React (canvas or CSS grid for timeline), Drizzle ORM

---

## File Structure

### Modified Files
| File | Changes |
|------|---------|
| `apps/api/src/routes/projects.ts` | Velocity endpoint, recursive subtask queries |
| `apps/api/src/routes/tasks.ts` | Allow nested subtasks, subtask tree endpoint |
| `apps/web/src/components/task-detail.tsx` | Nested subtask rendering, indented tree |
| `apps/web/src/app/(app)/tasks/page.tsx` | Timeline view toggle, velocity widget |

### New Files
| File | Purpose |
|------|---------|
| `apps/web/src/app/(app)/tasks/timeline.tsx` | Timeline/Gantt component |

---

### Task 1: Sprint-Free Velocity

**Why not sprints:** Sprints add ceremony (planning meetings, sprint boundaries, velocity calculations per sprint). For small teams, rolling velocity is more useful — "how many tasks did we complete per week over the last 8 weeks?" No configuration, no sprint creation, no sprint management UI.

**Files:**
- Modify: `apps/api/src/routes/projects.ts`
- Modify: `apps/web/src/app/(app)/tasks/page.tsx`

- [ ] **Step 1: Add velocity endpoint**

Add to `apps/api/src/routes/projects.ts`:

```typescript
// GET /api/projects/:id/velocity — rolling weekly completion velocity
projectRoutes.get('/:id/velocity', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const weeks = parseInt(c.req.query('weeks') || '8');

    // Count tasks completed per week for the last N weeks
    const result = await db.execute(sql`
      SELECT
        date_trunc('week', ta.created_at) as week_start,
        count(DISTINCT ta.task_id) as completed
      FROM task_activity ta
      JOIN tasks t ON ta.task_id = t.id
      WHERE t.project_id = ${projectId}
        AND t.org_id = ${user.org_id}
        AND ta.action = 'status_changed'
        AND ta.new_value = 'done'
        AND ta.created_at > NOW() - INTERVAL '1 week' * ${weeks}
      GROUP BY date_trunc('week', ta.created_at)
      ORDER BY week_start
    `);

    const rows = (result as any).rows ?? result;
    const velocity = Array.isArray(rows) ? rows.map((r: any) => ({
      week: r.week_start,
      completed: Number(r.completed),
    })) : [];

    const avg = velocity.length > 0
      ? Math.round(velocity.reduce((s, v) => s + v.completed, 0) / velocity.length * 10) / 10
      : 0;

    return c.json({ velocity, average: avg, weeks });
  } catch (err) {
    console.error('Failed to fetch velocity:', err);
    return c.json({ error: 'Failed to fetch velocity', code: 'INTERNAL_ERROR' }, 500);
  }
});
```

- [ ] **Step 2: Add velocity widget to tasks page**

In `apps/web/src/app/(app)/tasks/page.tsx`, add a small velocity indicator near the project header. Fetch on project load:

```tsx
// Velocity bar — show after project selector
const [velocity, setVelocity] = useState<{ average: number; velocity: { week: string; completed: number }[] } | null>(null);

useEffect(() => {
  if (!selectedProject) return;
  api.get(`/api/projects/${selectedProject.id}/velocity`).then(async res => {
    if (res.ok) setVelocity(await res.json());
  });
}, [selectedProject]);
```

Render as a small inline widget:
```tsx
{velocity && velocity.average > 0 && (
  <span className="text-[11px] px-2 py-0.5 rounded-full"
    style={{ background: 'var(--surface-container-low)', color: 'var(--muted)' }}>
    ~{velocity.average} tasks/week
  </span>
)}
```

- [ ] **Step 3: Typecheck + test**

Run: `cd apps/api && pnpm typecheck && cd ../web && pnpm typecheck`
Test: `curl /api/projects/:id/velocity` returns weekly data.

---

### Task 2: Multi-Level Subtasks

**Current state:** `parent_task_id` allows one level of nesting. The board excludes subtasks (`isNull(tasks.parent_task_id)`). The detail panel shows subtasks as a flat list.

**Change:** Allow any depth of nesting. Add a recursive subtask tree endpoint. Update the detail panel to render indented subtask trees.

**Files:**
- Modify: `apps/api/src/routes/tasks.ts`
- Modify: `apps/web/src/components/task-detail.tsx`

- [ ] **Step 1: Add recursive subtask tree endpoint**

Add to `apps/api/src/routes/tasks.ts` (before `/:id`):

```typescript
// GET /api/tasks/:id/subtree — recursive subtask tree
taskRoutes.get('/:id/subtree', async (c) => {
  try {
    const taskId = c.req.param('id');
    const result = await db.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id, title, status, priority, parent_task_id, 0 as depth
        FROM tasks WHERE parent_task_id = ${taskId} AND is_deleted = false
        UNION ALL
        SELECT t.id, t.title, t.status, t.priority, t.parent_task_id, s.depth + 1
        FROM tasks t
        JOIN subtree s ON t.parent_task_id = s.id
        WHERE t.is_deleted = false AND s.depth < 5
      )
      SELECT * FROM subtree ORDER BY depth, title
    `);
    const rows = (result as any).rows ?? result;
    return c.json({ subtasks: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    console.error('Failed to fetch subtree:', err);
    return c.json({ error: 'Failed to fetch subtree', code: 'INTERNAL_ERROR' }, 500);
  }
});
```

Max depth is capped at 5 to prevent runaway recursion.

- [ ] **Step 2: Allow creating nested subtasks**

In the POST create-task handler, remove any validation that prevents setting `parent_task_id` to a task that already has a parent. Currently there shouldn't be such validation (the schema just allows any `parent_task_id`), but verify.

- [ ] **Step 3: Update subtask rendering in detail panel**

In `apps/web/src/components/task-detail.tsx`, find the subtasks section. Instead of a flat list, fetch the subtree and render with indentation:

```tsx
// Render subtask with indent based on depth
function SubtaskRow({ task, depth }: { task: any; depth: number }) {
  return (
    <div className="flex items-center gap-2 py-1" style={{ paddingLeft: `${depth * 16}px` }}>
      <button onClick={() => toggleSubtaskStatus(task.id, task.status)}
        className="flex-shrink-0">
        {task.status === 'done' ? <CheckSquare size={14} /> : <Square size={14} />}
      </button>
      <span className={`text-[12px] ${task.status === 'done' ? 'line-through opacity-50' : ''}`}
        style={{ color: 'var(--foreground)' }}>
        {task.title}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + test**

---

### Task 3: Timeline View

**Requires:** Tasks with `start_date` and `due_date` (added in this session). Shows tasks as horizontal bars on a time axis.

**Files:**
- Create: `apps/web/src/app/(app)/tasks/timeline.tsx`
- Modify: `apps/web/src/app/(app)/tasks/page.tsx`

- [ ] **Step 1: Add Timeline view toggle**

In `apps/web/src/app/(app)/tasks/page.tsx`, add a third view option alongside Board and List:

```tsx
<button onClick={() => setView('timeline')} ...>
  <CalendarRange size={14} /> Timeline
</button>
```

- [ ] **Step 2: Create Timeline component**

`apps/web/src/app/(app)/tasks/timeline.tsx`:

A CSS-grid based timeline (no external library needed):
- X-axis: weeks (scrollable, showing 8 weeks by default)
- Y-axis: tasks (one row per task)
- Each task renders as a colored bar from start_date to due_date
- Tasks without start_date show a point at due_date
- Tasks without either date are listed in a "No dates" section below
- Bar color based on status (backlog=gray, todo=blue, in_progress=yellow, done=green)
- Hover shows task title + dates
- Click opens task detail panel

```tsx
'use client';

import { useMemo } from 'react';

type TimelineTask = {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  start_date: string | null;
  due_date: string | null;
  assignee_name: string | null;
};

const STATUS_COLORS: Record<string, string> = {
  backlog: '#6B7280',
  todo: '#3B82F6',
  in_progress: '#EAB308',
  in_review: '#A855F7',
  done: '#22C55E',
  cancelled: '#EF4444',
};

export default function TaskTimeline({
  tasks,
  onTaskClick,
}: {
  tasks: TimelineTask[];
  onTaskClick: (taskId: string) => void;
}) {
  // Filter to tasks with at least a due_date
  const datedTasks = tasks.filter(t => t.due_date || t.start_date);
  const undatedTasks = tasks.filter(t => !t.due_date && !t.start_date);

  // Calculate date range (8 weeks around today)
  const today = new Date();
  const rangeStart = new Date(today);
  rangeStart.setDate(rangeStart.getDate() - 7); // 1 week back
  const rangeEnd = new Date(today);
  rangeEnd.setDate(rangeEnd.getDate() + 49); // 7 weeks forward
  const totalDays = Math.ceil((rangeEnd.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24));

  const getPosition = (date: string) => {
    const d = new Date(date);
    const dayOffset = Math.ceil((d.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24));
    return Math.max(0, Math.min(100, (dayOffset / totalDays) * 100));
  };

  // Generate week markers
  const weeks = useMemo(() => {
    const result = [];
    const d = new Date(rangeStart);
    d.setDate(d.getDate() - d.getDay()); // align to Sunday
    while (d <= rangeEnd) {
      result.push(new Date(d));
      d.setDate(d.getDate() + 7);
    }
    return result;
  }, []);

  return (
    <div className="flex-1 overflow-x-auto overflow-y-auto">
      {/* Week headers */}
      <div className="relative h-8 mb-1" style={{ minWidth: '800px' }}>
        {weeks.map((w, i) => {
          const left = getPosition(w.toISOString());
          return (
            <div key={i} className="absolute text-[10px] top-0"
              style={{ left: `${left}%`, color: 'var(--muted)', borderLeft: '1px solid var(--border)', paddingLeft: 4, height: '100%' }}>
              {w.toLocaleDateString('en', { month: 'short', day: 'numeric' })}
            </div>
          );
        })}
        {/* Today marker */}
        <div className="absolute top-0 bottom-0 w-px" style={{ left: `${getPosition(today.toISOString())}%`, background: 'var(--accent)', zIndex: 10 }} />
      </div>

      {/* Task rows */}
      <div style={{ minWidth: '800px' }}>
        {datedTasks.map(task => {
          const start = task.start_date ? getPosition(task.start_date) : (task.due_date ? getPosition(task.due_date) - 1 : 0);
          const end = task.due_date ? getPosition(task.due_date) : start + 1;
          const width = Math.max(1, end - start);
          const color = STATUS_COLORS[task.status] || '#6B7280';

          return (
            <div key={task.id} className="relative h-8 mb-0.5 flex items-center cursor-pointer group"
              onClick={() => onTaskClick(task.id)}
              style={{ borderBottom: '1px solid var(--border)' }}>
              {/* Bar */}
              <div className="absolute h-5 rounded-sm transition-opacity group-hover:opacity-100"
                style={{ left: `${start}%`, width: `${width}%`, background: color, opacity: 0.7, minWidth: 4 }}>
                <span className="text-[9px] text-white px-1 truncate block leading-5 font-medium">
                  {task.title}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Undated tasks */}
      {undatedTasks.length > 0 && (
        <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="text-[11px] font-medium mb-2" style={{ color: 'var(--muted)' }}>
            No dates ({undatedTasks.length})
          </div>
          {undatedTasks.map(task => (
            <div key={task.id} className="text-[12px] py-1 cursor-pointer hover:underline"
              onClick={() => onTaskClick(task.id)}
              style={{ color: 'var(--foreground)' }}>
              {task.title}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire timeline into tasks page**

In the tasks page, when `view === 'timeline'`, render the Timeline component with the same task data that feeds the board/list:

```tsx
{view === 'timeline' && (
  <TaskTimeline
    tasks={allTasks.map(t => ({
      id: t.id,
      number: t.number,
      title: t.title,
      status: t.status,
      priority: t.priority,
      start_date: t.start_date,
      due_date: t.due_date,
      assignee_name: t.assignee_name,
    }))}
    onTaskClick={(id) => router.push(`/tasks?task=${id}`)}
  />
)}
```

- [ ] **Step 4: Add start_date + estimation to project tasks response**

In `apps/api/src/routes/projects.ts` GET `/:id/tasks`, add `start_date: tasks.start_date` and `estimation: tasks.estimation` to the select fields so the frontend has the data for timeline rendering.

- [ ] **Step 5: Typecheck + build + test**

Run: `cd apps/api && pnpm typecheck && cd ../web && pnpm typecheck && pnpm build`

---

## Build Order

1. Task 1 (velocity) — independent, API + small UI widget
2. Task 2 (multi-level subtasks) — independent, API + detail panel
3. Task 3 (timeline) — depends on start_date being in the API response (Step 4)

## Verification

- [ ] `GET /api/projects/:id/velocity` returns weekly completion data with average
- [ ] Velocity widget shows "~X tasks/week" next to project name
- [ ] `GET /api/tasks/:id/subtree` returns recursive tree with depth field
- [ ] Creating a subtask of a subtask works (depth > 1)
- [ ] Subtask tree renders indented in detail panel
- [ ] Timeline view toggle appears next to Board/List
- [ ] Tasks with start_date + due_date show as horizontal bars
- [ ] Tasks without dates appear in "No dates" section
- [ ] Today marker (purple line) visible on timeline
- [ ] Clicking a timeline bar opens task detail
- [ ] Both typechecks pass, production build passes
