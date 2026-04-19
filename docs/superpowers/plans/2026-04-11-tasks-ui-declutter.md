# Tasks UI Declutter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce visual clutter in the tasks UI — especially on mobile — by collapsing secondary metadata, consolidating filters, improving timeline usability, and adding a mobile FAB for task creation.

**Architecture:** All changes are frontend-only (no API changes). The work focuses on responsive layout improvements in 4 files: tasks page, task detail panel, timeline component, and task list. Each task produces a self-contained visual improvement that can be verified independently with Playwright.

**Tech Stack:** React, Tailwind CSS, Lucide icons, Next.js App Router

---

## File Structure

### Modified Files
| File | Changes |
|------|---------|
| `apps/web/src/components/task-detail.tsx` | Collapse secondary metadata on mobile into expandable section; fix due date display format |
| `apps/web/src/app/(app)/tasks/page.tsx` | Hide velocity badge on mobile; add floating action button for mobile; hide Select button on mobile; hide Views button when no saved views |
| `apps/web/src/app/(app)/tasks/timeline.tsx` | Collapsible "No dates" section; compact undated task list; hide task ID column on mobile |
| `apps/web/src/components/task-filters.tsx` | Collapse filter bar into single "Filter" button on mobile with dropdown |
| `apps/web/src/components/task-list.tsx` | Hide Est. column when no tasks have estimations; show blank instead of "—" |

---

### Task 1: Collapse Detail Panel Metadata on Mobile

**Why:** On mobile, 9 metadata rows (Status, Priority, Size, Assignee, Start date, Due date, Created, Labels, Tags) push Description below the fold. Users need to see Description immediately — the secondary fields (Start date, Created, Labels, Tags, Size) are rarely used inline.

**Files:**
- Modify: `apps/web/src/components/task-detail.tsx:668-960`

- [ ] **Step 1: Add state for metadata expansion**

In `TaskDetail` component (around line 260, after the `isMobile` state), add:

```tsx
const [metadataExpanded, setMetadataExpanded] = useState(false);
```

- [ ] **Step 2: Wrap secondary fields in collapsible section**

Replace the fields grid section (line 668) with a version that splits fields into primary (always visible) and secondary (collapsible on mobile).

The grid currently starts at line 668:
```tsx
<div className="px-5 pb-4 grid grid-cols-[100px_1fr] gap-y-2.5 items-center">
```

Replace the entire grid (lines 668–960 approximately) with this structure:

```tsx
{/* Fields grid */}
<div className="px-5 pb-4 grid grid-cols-[100px_1fr] gap-y-2.5 items-center">
  {/* === PRIMARY FIELDS (always visible) === */}
  {/* Status */}
  {/* ... existing Status field code (lines 669-711) — no changes ... */}

  {/* Priority */}
  {/* ... existing Priority field code (lines 714-757) — no changes ... */}

  {/* Assignee */}
  {/* ... existing Assignee field code (lines 784-853) — no changes ... */}

  {/* Due Date */}
  {/* ... existing Due Date field code (lines 885-913) — no changes ... */}

  {/* === SECONDARY FIELDS (collapsible on mobile) === */}
  {(!isMobile || metadataExpanded) && (
    <>
      {/* Size / Estimation */}
      {/* ... existing Size field code (lines 759-782) — no changes ... */}

      {/* Start Date */}
      {/* ... existing Start Date field code (lines 855-883) — no changes ... */}

      {/* Created date */}
      {/* ... existing Created field code (lines 915-922) — no changes ... */}

      {/* Labels */}
      {/* ... existing Labels field code (lines 924-957) — no changes ... */}

      {/* Tags */}
      {/* ... existing Tags field code (lines 959 onward) — no changes ... */}
    </>
  )}
</div>

{/* Mobile expand/collapse toggle */}
{isMobile && (
  <button
    onClick={() => setMetadataExpanded(!metadataExpanded)}
    className="w-full text-center py-1.5 text-[11px] font-medium"
    style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
  >
    {metadataExpanded ? '▲ Less details' : '▼ More details'}
  </button>
)}
```

The key change: move Assignee above Due Date in the field order (currently it's Status → Priority → Size → Assignee → Start date → Due date → Created → Labels → Tags). The new primary order becomes: **Status → Priority → Assignee → Due date**. Everything else becomes secondary.

- [ ] **Step 3: Fix due date display format**

The due date field uses a native `<input type="date">` which renders the raw ISO format (e.g., "09-04-2026"). The Created field uses `toLocaleDateString`. To make them consistent, the due date value should render in the same human-readable format when not being edited.

In the Due Date field section (around line 885-913), change the `<input type="date">` styling so the displayed value is formatted. Replace the due date block with:

```tsx
{/* Due Date */}
<span className="text-[12px] font-medium" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>
  <Calendar size={12} className="inline mr-1" />
  Due date
</span>
<div className="relative">
  {!task.due_date ? (
    <div className="relative">
      <span
        className="absolute left-2 top-1/2 -translate-y-1/2 text-[13px] pointer-events-none"
        style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}
      >
        Set due date
      </span>
      <input
        type="date"
        value=""
        onChange={(e) => handleFieldUpdate('due_date', e.target.value || null)}
        className="px-2 py-1 rounded-md text-[13px] bg-transparent outline-none"
        style={{ color: 'transparent', fontFamily: 'var(--font-body)', border: 'none' }}
      />
    </div>
  ) : (
    <div className="flex items-center gap-1">
      <span
        className="text-[13px] px-2 py-1 cursor-pointer rounded-md"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
        onClick={() => {
          // Focus the hidden date input
          const input = document.getElementById('due-date-input') as HTMLInputElement;
          input?.showPicker?.();
        }}
      >
        {new Date(task.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
      </span>
      <input
        id="due-date-input"
        type="date"
        value={new Date(task.due_date).toISOString().split('T')[0]}
        onChange={(e) => handleFieldUpdate('due_date', e.target.value || null)}
        className="w-5 h-5 opacity-0 absolute right-0"
        style={{ cursor: 'pointer' }}
      />
    </div>
  )}
</div>
```

Apply the same pattern to the Start Date field.

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && pnpm typecheck`

- [ ] **Step 5: Verify with Playwright**

Open http://localhost:3000/tasks, click a task, take screenshot at 390x844. Verify:
- Only Status, Priority, Assignee, Due date visible initially
- "More details" button visible
- Click "More details" → Size, Start date, Created, Labels, Tags appear
- Due date shows "Apr 9, 2026" format (not "09-04-2026")

---

### Task 2: Collapse Filter Bar on Mobile

**Why:** The filter bar shows 5 buttons (Assignee, Priority, Project, Due date, Views) that wrap to 2 lines on mobile, consuming ~80px of vertical space. On mobile, a single "Filter" button with a dropdown saves space.

**Files:**
- Modify: `apps/web/src/components/task-filters.tsx`

- [ ] **Step 1: Add mobile detection**

At the top of the `TaskFilters` component (around line 42), add:

```tsx
const [isMobile, setIsMobile] = useState(false);
useEffect(() => {
  const check = () => setIsMobile(window.innerWidth < 768);
  check();
  window.addEventListener('resize', check);
  return () => window.removeEventListener('resize', check);
}, []);
```

- [ ] **Step 2: Count active filters**

After the state declarations, add a computed count:

```tsx
const activeFilterCount = filters.assigneeIds.length + filters.priorities.length +
  (filters.dueDate ? 1 : 0) + (filters.projectId ? 1 : 0);
```

- [ ] **Step 3: Wrap filter buttons in mobile container**

Find the outer container of the filter buttons (look for the div that contains all the Assignee/Priority/Project/Due date/Views buttons). On mobile, wrap them in a collapsible dropdown triggered by a single "Filter" button.

Replace the filter bar's outer wrapper with:

```tsx
<div className="flex items-center gap-2 px-3 md:px-6 py-2 flex-wrap"
  style={{ borderBottom: '1px solid var(--border)' }}>

  {/* Mobile: single filter toggle */}
  {isMobile ? (
    <div className="relative w-full flex items-center gap-2">
      <button
        onClick={() => setOpenDropdown(openDropdown === 'mobile-filters' ? null : 'mobile-filters')}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium"
        style={{
          background: activeFilterCount > 0 ? 'var(--accent-subtle)' : 'transparent',
          color: activeFilterCount > 0 ? 'var(--accent)' : 'var(--muted)',
          border: `1px solid ${activeFilterCount > 0 ? 'var(--accent)' : 'var(--border)'}`,
          fontFamily: 'var(--font-heading)',
        }}
      >
        <SlidersHorizontal size={13} />
        Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
      </button>

      {activeFilterCount > 0 && (
        <button
          onClick={() => onChange({ assigneeIds: [], priorities: [], labels: [], dueDate: null, dateFrom: null, dateTo: null, projectId: null })}
          className="text-[11px] font-medium"
          style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
        >
          Clear
        </button>
      )}

      {/* Saved views on mobile — just the button, moved inline */}
      <div className="ml-auto">
        {/* ... existing Views button code ... */}
      </div>

      {openDropdown === 'mobile-filters' && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpenDropdown(null)} />
          <div className="absolute top-full left-0 mt-1 w-64 rounded-lg py-2 z-20"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>
            {/* Render each filter section vertically */}
            <div className="px-3 py-1.5 text-[11px] font-semibold" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>Assignee</div>
            {/* ... My tasks button + member list ... */}

            <div className="my-1" style={{ borderTop: '1px solid var(--border)' }} />
            <div className="px-3 py-1.5 text-[11px] font-semibold" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>Priority</div>
            {/* ... Priority options ... */}

            <div className="my-1" style={{ borderTop: '1px solid var(--border)' }} />
            <div className="px-3 py-1.5 text-[11px] font-semibold" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>Due date</div>
            {/* ... Due date options ... */}
          </div>
        </>
      )}
    </div>
  ) : (
    /* Desktop: existing filter buttons — keep all current code unchanged */
    <>
      {/* ... all existing filter button code ... */}
    </>
  )}
</div>
```

Add `SlidersHorizontal` to the lucide-react import.

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && pnpm typecheck`

- [ ] **Step 5: Verify with Playwright**

At 390x844:
- Single "Filters" button visible instead of 5 separate buttons
- Clicking opens dropdown with Assignee/Priority/Due date sections
- Selecting a filter shows badge count "Filters (1)"
- "Clear" button appears when filters active

At 1440x900:
- All 5 filter buttons still visible (unchanged desktop behavior)

---

### Task 3: Mobile FAB + Hide Velocity/Select on Mobile

**Why:** On mobile, the "New task" button is pushed off-screen by the toolbar. A floating action button (FAB) at bottom-right gives constant access. The velocity badge and Select button waste space on mobile for metrics/workflows that are desktop-oriented.

**Files:**
- Modify: `apps/web/src/app/(app)/tasks/page.tsx`

- [ ] **Step 1: Add mobile detection**

In the `TasksPage` component (around line 121, after `velocity` state), add:

```tsx
const [isMobile, setIsMobile] = useState(false);
useEffect(() => {
  const check = () => setIsMobile(window.innerWidth < 768);
  check();
  window.addEventListener('resize', check);
  return () => window.removeEventListener('resize', check);
}, []);
```

- [ ] **Step 2: Hide velocity badge on mobile**

Find the velocity badge (around line 540-544):
```tsx
{velocity && velocity.average > 0 && (
  <span className="text-[11px] px-2 py-0.5 rounded-full ml-2"
```

Wrap it with a mobile check:
```tsx
{!isMobile && velocity && velocity.average > 0 && (
  <span className="text-[11px] px-2 py-0.5 rounded-full ml-2"
    style={{ background: 'var(--surface-container-low)', color: 'var(--muted)' }}>
    ~{velocity.average} {velocity.average === 1 ? 'task' : 'tasks'}/week
  </span>
)}
```

- [ ] **Step 3: Hide Select button on mobile**

Find the Select toggle button (around line 637-650):
```tsx
<button
  onClick={() => setSelectionMode(!selectionMode)}
  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium"
```

Wrap the button in:
```tsx
{!isMobile && (
  <button ... >
    ...
  </button>
)}
```

- [ ] **Step 4: Hide "New task" button on mobile (keep desktop)**

Find the "New task" button (around line 654-671). Add a mobile hide class:

```tsx
{!isMyTasksView && (
  <button
    onClick={() => { setQuickCreateStatus(undefined); setQuickCreateOpen(true); }}
    className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium text-white"
    style={{ background: 'var(--accent)', fontFamily: 'var(--font-heading)', transition: 'opacity 150ms' }}
    onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.9')}
    onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
  >
    <Plus size={14} />
    New task
  </button>
)}
```

- [ ] **Step 5: Add floating action button for mobile**

After the quick create modal section (around line 843), before the bulk action bar, add:

```tsx
{/* Mobile FAB */}
{isMobile && !isMyTasksView && !selectedTask && (
  <button
    onClick={() => { setQuickCreateStatus(undefined); setQuickCreateOpen(true); }}
    className="fixed z-30 w-12 h-12 rounded-full flex items-center justify-center text-white shadow-lg"
    style={{
      background: 'var(--accent)',
      bottom: '80px',
      right: '16px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    }}
  >
    <Plus size={22} />
  </button>
)}
```

The FAB is hidden when a task detail is open (`!selectedTask`) to avoid overlapping.

- [ ] **Step 6: Hide Views button when no saved views exist**

Find the Views button in the filter bar. It currently always shows and displays "No saved views yet" when empty. Instead of modifying the filter bar (which is a separate component), we can address this by passing a prop to hide it when empty — but since the saved views are loaded inside `TaskFilters`, the simpler approach is to handle it inside `task-filters.tsx`: only render the Views button when `savedViews.length > 0`.

In `apps/web/src/components/task-filters.tsx`, find the Views button section and wrap it:

```tsx
{savedViews.length > 0 && (
  /* ... existing Views button and dropdown code ... */
)}
```

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && pnpm typecheck`

- [ ] **Step 8: Verify with Playwright**

At 390x844:
- Velocity badge hidden
- Select button hidden
- "New task" button in header hidden
- Purple FAB with "+" visible at bottom-right
- Tapping FAB opens the new task modal
- FAB hidden when task detail is open

At 1440x900:
- Velocity badge visible
- Select button visible
- "New task" button visible in header
- No FAB visible

---

### Task 4: Improve Timeline "No Dates" Section

**Why:** When most tasks lack dates, the "No dates" section dominates the timeline. Wide colored blocks look like timeline bars but aren't — confusing visual language. The section should be compact, collapsible, and visually distinct from the timeline.

**Files:**
- Modify: `apps/web/src/app/(app)/tasks/timeline.tsx`

- [ ] **Step 1: Add collapsible state + mobile detection**

At the top of the `TaskTimeline` component (after the function signature, line 23), add:

```tsx
import { useState, useEffect } from 'react';
// ... inside the component:
const [undatedExpanded, setUndatedExpanded] = useState(false);
const [isMobile, setIsMobile] = useState(false);
useEffect(() => {
  const check = () => setIsMobile(window.innerWidth < 768);
  check();
  window.addEventListener('resize', check);
  return () => window.removeEventListener('resize', check);
}, []);
```

Also update the import at line 1 — `useState` and `useEffect` need to be imported from React:
```tsx
'use client';

import { useState, useEffect } from 'react';
```

- [ ] **Step 2: Hide task ID column on mobile**

In the task row rendering (around line 80-94), conditionally hide the task ID label on mobile:

```tsx
{datedTasks.map(task => {
  const start = task.start_date ? getPos(task.start_date) : task.due_date ? getPos(task.due_date) - 0.5 : 0;
  const end = task.due_date ? getPos(task.due_date) : start + 0.5;
  const width = Math.max(3 / totalDays * 100, end - start);
  const color = STATUS_COLORS[task.status] || '#6B7280';

  return (
    <div key={task.id} className="relative h-7 flex items-center cursor-pointer group"
      onClick={() => onTaskClick(task.number)}>
      {!isMobile && (
        <div className="w-28 flex-shrink-0 text-[10px] truncate pr-2" style={{ color: 'var(--muted)' }}>
          {projectPrefix}-{task.number}
        </div>
      )}
      <div className="flex-1 relative h-5">
        <div className="absolute h-full rounded-sm transition-all group-hover:opacity-100"
          style={{ left: `${start}%`, width: `${width}%`, background: color, opacity: 0.7, minWidth: 4, overflow: 'visible' }}>
          <span className="text-[9px] text-white px-1.5 block leading-5 font-medium whitespace-nowrap" style={{ overflow: 'visible' }}>
            {task.title}
          </span>
        </div>
      </div>
    </div>
  );
})}
```

- [ ] **Step 3: Replace "No dates" section with collapsible compact list**

Replace the undated section (lines 98-113) with:

```tsx
{undatedTasks.length > 0 && (
  <div className="mt-6 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
    <button
      onClick={() => setUndatedExpanded(!undatedExpanded)}
      className="flex items-center gap-2 text-[11px] font-medium mb-2 w-full text-left"
      style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
    >
      <span style={{ fontSize: '8px' }}>{undatedExpanded ? '▼' : '▶'}</span>
      No dates ({undatedTasks.length})
    </button>
    {undatedExpanded && (
      <div className={isMobile ? "flex flex-col gap-1" : "grid grid-cols-3 gap-1.5"}>
        {undatedTasks.map(task => (
          <div key={task.id}
            className="text-[11px] py-1 px-2 rounded cursor-pointer flex items-center gap-1.5"
            onClick={() => onTaskClick(task.number)}
            style={{ color: 'var(--foreground)' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: STATUS_COLORS[task.status] || '#6B7280' }} />
            <span style={{ color: 'var(--muted)' }}>{projectPrefix}-{task.number}</span>
            <span className="truncate">{task.title}</span>
          </div>
        ))}
      </div>
    )}
  </div>
)}
```

This changes the "No dates" section from wide colored blocks (which look like timeline bars) to a simple text list with tiny status-colored dots — visually distinct from the timeline above.

- [ ] **Step 4: Reduce minimum width on mobile**

Change `minWidth: 900` (line 59) to be responsive:

```tsx
<div style={{ minWidth: isMobile ? 500 : 900 }}>
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && pnpm typecheck`

- [ ] **Step 6: Verify with Playwright**

At 1440x900 on Timeline view:
- "No dates (9)" header with collapsed arrow
- Clicking expands to show 3-column compact text list (no colored blocks)
- Task IDs visible on left of timeline bars

At 390x844:
- Task IDs hidden on timeline bars (more room for bar labels)
- "No dates" section: single column list when expanded
- Timeline scrollable at 500px min-width (not 900px)

---

### Task 5: Clean Up List View Estimation Column

**Why:** The Est. column shows "—" for every task without an estimation, which is visual noise. If no tasks have estimations, the column wastes horizontal space entirely.

**Files:**
- Modify: `apps/web/src/components/task-list.tsx`

- [ ] **Step 1: Compute whether any task has estimation**

At the top of the `TaskList` component render function, add:

```tsx
const hasAnyEstimation = tasks.some(t => t.estimation);
```

- [ ] **Step 2: Conditionally hide the Est. column header**

Find the table header that renders "EST." and wrap it:

```tsx
{hasAnyEstimation && (
  <th ... >EST.</th>
)}
```

- [ ] **Step 3: Conditionally hide the Est. column cells**

Find the table cell that renders the estimation badge (and the "—" fallback). Wrap the entire `<td>` in the same condition:

```tsx
{hasAnyEstimation && (
  <td ...>
    {task.estimation ? (
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ ... }}>
        {task.estimation.toUpperCase()}
      </span>
    ) : null}
  </td>
)}
```

Note: when `hasAnyEstimation` is true but a specific task has no estimation, render nothing (blank cell) instead of "—".

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && pnpm typecheck`

- [ ] **Step 5: Verify with Playwright**

At 1440x900 on List view:
- If any task has estimation (e.g., DEFT-1 has "S"), the Est. column appears
- Tasks without estimation show blank cell (not "—")
- If NO tasks have estimations, the Est. column is entirely hidden

---

## Build Order

1. **Task 1** (Detail panel metadata collapse) — independent, highest mobile impact
2. **Task 2** (Filter bar collapse) — independent, significant mobile space savings
3. **Task 3** (FAB + velocity/select hide) — independent, mobile polish
4. **Task 4** (Timeline cleanup) — independent, timeline improvement
5. **Task 5** (List view est. column) — independent, quick polish

Tasks 1-5 are all independent and can be done in any order. If parallelizing, avoid Task 2 and Task 3 running simultaneously since both modify closely related mobile layout areas.

## Verification

After all tasks:
- [ ] `cd apps/web && pnpm typecheck` passes
- [ ] `pnpm --filter @deft/web build` passes
- [ ] Mobile (390x844): Detail panel shows 4 primary fields with "More details" toggle
- [ ] Mobile: Filter bar is single "Filters" button
- [ ] Mobile: FAB visible at bottom-right for task creation
- [ ] Mobile: No velocity badge, no Select button
- [ ] Desktop (1440x900): All fields visible in detail panel (no collapse)
- [ ] Desktop: All 5 filter buttons visible (no change)
- [ ] Desktop: "New task" button in header, no FAB
- [ ] Timeline: "No dates" collapsed by default, compact text list when expanded
- [ ] List view: Est. column hidden when no tasks have estimations
- [ ] Due date in detail panel shows "Apr 9, 2026" format
