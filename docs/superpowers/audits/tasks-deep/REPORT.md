# Tasks Deep Audit

**Date:** 2026-04-21
**Branch:** feat/phase2-4-mcp-agents-plans
**Duration:** ~30s Playwright (audit hit timeout on group 6 assignee-filter click; report compiled from run.log + 15 screenshots)
**Findings:** P0×0 P1×2 P2×4 Nit×1
**Console errors:** 0
**Network 4xx/5xx:** 0

> Note: the audit script was dispatched with an 8-minute budget but the controlling LLM hit its usage limit before writing REPORT.md directly. Findings below are reconstructed from the run.log + screenshots captured by the audit run.

---

## Surfaces observed

- `/tasks` — single page hosting all views
- **5 view toggles** rendered in the top bar: **Board, List, Timeline, Calendar, Pipeline** (all five affordances present)
- List view with 7 sortable column headers
- Task create modal + keyboard shortcut **`c`** to open it (confirmed working)
- Task detail drawer (opens on row click)
- Status dropdown inside the detail drawer (confirmed working — changed a task to `in_progress` and it persisted)
- Filter controls for Priority, Assignee, Status

---

## P0 — blocks release

_(none)_

---

## P1 — must fix

### 1. View toggle does not update URL — view state lost on refresh

**File:** `apps/web/src/app/(app)/tasks/page.tsx` (view-toggle click handler)
**Screenshot:** `02-list-no-url-update.png`

Clicking the Board/List/Timeline/Calendar/Pipeline toggles does NOT update the URL. Refreshing always returns to the default view. Same pattern as the chat sidebar fix we landed earlier (`405554e`) — use `router.replace` with `?view=<name>` on click, and read it back on mount with `useSearchParams`.

### 2. Board view shows zero task cards despite 162 tasks in DB

**Screenshot:** `03-board-view.png`
**DB evidence:** `SELECT status, COUNT(*) FROM tasks WHERE is_deleted=false GROUP BY status` → `{backlog:138, todo:7, in_progress:7, in_review:3, done:7}`

Board view rendered 0 columns + 0 cards. Either:
- The default filter is "my open tasks" and maneek has few assignments, but then there should be an empty-state message — none visible.
- The board requires a project selection first, but there's no "pick a project" call-to-action.
- Columns are rendered hidden (CSS issue).

Either way, a new user lands on `/tasks`, sees a blank Board, and has nothing guiding them. Fix: either show a "pick a project" empty state, or default to showing all tasks across projects with a project-filter chip at the top, or default to list view.

---

## P2 — should fix

### 1. List view: no pagination with 162 tasks in DB

**Screenshot:** `04-list-view.png` / `05-list-sorted.png`

The list view shows no "load more", no pagination, no infinite scroll markers. 162 tasks total is already past a reasonable first-page limit. Will grow worse over time. Add server-side pagination or virtualized rendering.

### 2. Task detail drawer: no comment textarea surfaced

**Screenshot:** `10-task-detail-drawer.png`

The detail drawer renders the task, shows the comments + activity **sections**, but no comment composer was found. Either the textarea only renders on focus/click, or it's been regressed. Worth checking: does a user clicking "Add comment" anywhere actually produce a working composer?

### 3. Priority filter does not update URL (not deep-linkable)

**Screenshot:** `14-priority-filter-dropdown.png`

Applying the Priority filter leaves URL at `/tasks`. Can't share a filtered view. Same fix pattern as finding P1-1.

### 4. Stale modal backdrop blocks subsequent clicks

**Evidence:** audit crashed here — `<div class="fixed inset-0 z-10"></div> intercepts pointer events` after the Priority filter dropdown was dismissed. The backdrop element stayed in the DOM with pointer-events active, blocking all subsequent filter clicks (the audit retried 56× on Assignee filter before giving up).

Real UX bug: a user would see the Assignee filter button "look clickable" but no amount of clicking would open it. Fix: ensure modal backdrops are unmounted or get `pointer-events: none` when the dropdown closes.

---

## Nits

### 1. "My tasks" view identifier ambiguous

The Board shows no tasks. If the default scoping is "tasks assigned to me" it isn't explicit. Add a small header tag like "Showing: my open tasks across all projects" so users know what they're looking at.

---

## What passed cleanly

- Task create modal opens + submits (verified: row `c3b451d3-...` inserted with `status='backlog'`, `priority='p2'`)
- Keyboard shortcut `c` opens the create modal
- List view has 7 sortable columns; click-to-sort works + inverts on second click
- Task detail drawer opens on row click
- Status dropdown in the detail drawer works — changed task to In Progress, verified persisted
- Zero console errors, zero network failures before the timeout

---

## Coverage gaps

- **Board kanban drag-drop** — could not test because 0 cards rendered
- **Timeline view** — toggle exists but not clicked
- **Calendar view** — toggle exists but not clicked
- **Pipeline view** — toggle exists but not clicked (what is Pipeline? — worth documenting)
- **Assignee filter** — click blocked by stale backdrop (see P2-4)
- **Status filter** — not reached
- **Bulk selection / bulk actions** — not tested
- **Task relationships (parent/child/blocker)** — not tested
- **Cross-references from messages/notes** — not tested
- **Apply task template** — not tested
- **Task comments + activity feed** — not tested beyond section presence

---

## Raw console / network logs

### Console errors
_None_

### Network 4xx/5xx
_None_

### Uncaught page errors
_None_

---

## Screenshots index

| # | Filename | Description |
|---|----------|-------------|
| 01 | `01-tasks-landing.png` | Tasks landing page (TTI 2.7s) |
| 02 | `02-list-no-url-update.png` | URL unchanged after List click (P1) |
| 03 | `03-board-view.png` | Board — 0 columns, 0 cards visible (P1) |
| 04 | `04-list-view.png` | List view |
| 05 | `05-list-sorted.png` | First sortable column clicked |
| 06 | `06-list-sort-reversed.png` | Second click inverts sort |
| 07 | `07-create-task-modal-open.png` | Task create modal |
| 08 | `08-create-task-filled.png` | Create modal filled |
| 09 | `09-after-task-created.png` | New task visible in list |
| 10 | `10-task-detail-drawer.png` | Task detail drawer (P2 — no comment composer) |
| 11 | `11-status-dropdown-open.png` | Status dropdown open |
| 12 | `12-status-changed-in-progress.png` | Status changed to In Progress |
| 13 | `13-filter-bar.png` | Filter bar |
| 14 | `14-priority-filter-dropdown.png` | Priority filter dropdown (P2 — backdrop stays mounted) |
| 15 | `15-filtered-priority-p1.png` | Filtered by Priority p1 |
