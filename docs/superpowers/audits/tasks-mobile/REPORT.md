# Tasks Mobile Audit

**Date:** 2026-04-20
**Branch:** feat/phase2-4-mcp-agents-plans (47e3402)
**Viewport:** 390×844 (iPhone 13) · deviceScaleFactor 2 · isMobile+hasTouch · iOS 17 UA
**Duration:** 87.5s Playwright (12 checks, 0 crashes)
**Findings:** P0×0 P1×1 P2×1 Nit×1
**Console errors:** 0
**Network 4xx/5xx:** 0

---

## Overall impression

The page has solid mobile groundwork: the kanban board already stacks into pill-tab columns, the detail panel correctly renders full-screen, the filter bar collapses to a single "Filters" button, the scope label is hidden on mobile, and the FAB (floating action button) is present and 48×48px. No crash across all five views at 390px.

Two regressions found: the view-toggle row clips 2-3 of 5 buttons out of the viewport (P1), and the stale click-away backdrop bug persists on mobile after the filter panel is dismissed (P2, pre-existing from the desktop audit).

---

## View-by-view mobile table

| View | Renders OK | Usable | Notes |
|------|------------|--------|-------|
| Board | Yes | Yes | Mobile pill-tab stacking — one column visible at a time, swipe between via tabs. No horizontal scroll. |
| List | Yes | Yes | Mobile card layout (not table). "Load more" not triggered (< 50 tasks in project). |
| Timeline | Yes | Partial | Renders without crash. No touch-drag affordance tested — timeline may be hard to use on touch. |
| Calendar | Yes | Partial | Renders without crash. Month grid at 390px may be tight but does not overflow. |
| Pipeline | Yes | Partial | Renders without crash. Pipeline lane width behaviour unconfirmed — insufficient tasks to populate lanes. |

---

## P0 — blocks release

_(none)_

---

## P1 — must fix

### 1. View-toggle row clips 3 buttons at 390px

**Screenshot:** `02-view-toggle-row.png`
**File:** `apps/web/src/app/(app)/tasks/page.tsx` lines 740-804

The five-button view-toggle strip (Board | List | Timeline | Calendar | Pipeline) has a measured container width of **401px** at 390px viewport — overflowing by 11px. Only 3/6 measured button elements fit entirely within the viewport. The last 2-3 buttons (Timeline, Calendar, Pipeline) are either clipped or hidden behind the viewport edge.

The container is a plain flex row with rounded-md, no overflow-x-auto and no flex-wrap. At 390px the strip must either:
1. Scroll horizontally (overflow-x-auto on the container), or
2. Collapse to a compact icon-only strip at < md breakpoint (show icons without text labels), or
3. Move the toggle below the project selector in a second row.

**Impact:** Users cannot easily switch to Timeline / Calendar / Pipeline views on mobile.

---

## P2 — should fix

### 1. Stale click-away backdrop blocks touches after filter dismiss

**Screenshot:** `11-ghost-backdrop-check.png`
**File:** `apps/web/src/components/task-filters.tsx`

After opening the "Filters" panel on mobile and pressing Escape to close it, one fixed inset-0 backdrop element remains in the DOM with pointer-events active (confirmed via window.getComputedStyle). This is the same bug logged in the desktop deep audit (tasks-deep P2-4) — it exists on mobile too and is worse there because users cannot use keyboard shortcuts to work around it.

**Fix:** Ensure the backdrop div is unmounted (not just hidden) when the dropdown state clears, or set pointerEvents: 'none' on it when openDropdown is null.

---

## Nits

### 1. View-toggle and Filters buttons below 44px tap-target height

**Screenshot:** `12-tap-targets-mobile.png`

- Board button: 26px height
- List button: 26px height
- Filters button: 28px height

Apple HIG and WCAG 2.5.5 both recommend a minimum 44px touch target. The FAB is correctly 48x48px, but the header bar buttons are 26-28px. Adding py-2 or min-h-[44px] to these buttons would bring them into compliance.

---

## What passed cleanly

- Page mounts at 390px (no crash, body text loaded)
- Board view uses mobile stacked pill-tab approach (no horizontal scroll) — body.scrollWidth === innerWidth === 390
- Board pill-tab navigation works — tapping tabs switches the visible column
- Filter bar collapses to a single "Filters" button on mobile
- Filter dropdown renders within viewport bounds (right edge 304px < 390px)
- Task detail opens as fixed inset-0 z-50 full-screen sheet (width 390px = viewport) — NOT the 450px side panel
- Tiptap comment composer renders at 293px width (fits within 390px)
- Comment composer accepts touch-typed input
- All 5 views render without crash (board/list/timeline/calendar/pipeline)
- Scope label ("Showing N tasks") correctly hidden on mobile via !isMobile guard
- Mobile FAB present and 48x48px (correct for thumb)
- Zero browser console errors throughout run

---

## Coverage gaps

- "Load more" pagination — not tested live because project had < 50 tasks. Code path confirmed to exist in task-list.tsx lines 214-227 for mobile.
- Timeline touch-drag — timeline renders but touch-scroll/drag on the Gantt bar was not exercised.
- Calendar day-tap to create task — not tested.
- Pipeline lanes at 390px with populated tasks — pipeline rendered but no tasks populated the lanes.
- Bulk select on mobile — Select button hidden on mobile (!isMobile guard in page.tsx line 807); bulk flow not tested.
- Orientation change — landscape mode not tested.

---

## Screenshots index

| # | Filename | Description |
|---|----------|-------------|
| 01 | 01-tasks-landing-mobile.png | /tasks at iPhone 13 viewport — page mounted OK |
| 02 | 02-view-toggle-row.png | View toggle strip at 390px — 401px container overflows (P1) |
| 03 | 03-board-view-mobile.png | Board view — mobile pill-tab stacking visible |
| 03b | 03b-board-second-tab.png | Board — second status tab selected |
| 04 | 04-list-view-mobile.png | List view — mobile card layout (not table) |
| 05 | 05-scope-label-check.png | Scope label hidden on mobile (correct) |
| 06 | 06-filter-bar-mobile.png | Filter bar — collapsed "Filters" button |
| 06b | 06b-filter-dropdown-open.png | Filter dropdown open — within viewport |
| 07 | 07-task-detail-mobile.png | Task detail — full-screen sheet (390px wide) |
| 08 | 08-comment-composer-mobile.png | Comment tab — Tiptap editor visible at 293px |
| 08b | 08b-comment-typing.png | Comment composer — touch typing confirmed |
| 09-board | 09-view-board-mobile.png | Board view switch via URL — no crash |
| 09-list | 09-view-list-mobile.png | List view switch — no crash |
| 09-timeline | 09-view-timeline-mobile.png | Timeline view — no crash |
| 09-calendar | 09-view-calendar-mobile.png | Calendar view — no crash |
| 09-pipeline | 09-view-pipeline-mobile.png | Pipeline view — no crash |
| 10 | 10-kanban-scroll-mobile.png | Kanban scroll — body.scrollWidth=390, no overflow |
| 11 | 11-ghost-backdrop-check.png | Stale backdrop after filter close (P2) |
| 12 | 12-tap-targets-mobile.png | Tap target sizes — Board/List/Filters buttons 26-28px (Nit) |
