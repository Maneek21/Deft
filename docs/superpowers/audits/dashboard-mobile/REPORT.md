# Dashboard Mobile Audit

**Date:** 2026-04-20
**Branch:** feat/phase2-4-mcp-agents-plans
**Viewport:** 390×844 (iPhone 13, deviceScaleFactor:2, isMobile:true, hasTouch:true)
**Duration:** 181s
**Findings:** P0×0 P1×0 P2×9 Nit×1
**Screenshots:** 20

---

## Overall impression

The dashboard loads at 390×844 with no horizontal overflow and all 11 bento cards correctly reflowing to a single column via `grid-cols-1 md:grid-cols-2`. TTI was 1190ms. No console errors or network errors were detected. The My Work kanban stacks to 1 column correctly (grid-cols-1 sm:grid-cols-3 — 390px is below the 640px `sm` breakpoint). Donut rings render at 32×32px and are legible. Project tap navigates correctly to `/tasks?project=…`. Calendar day tap shows inline detail panel.

The main mobile problem cluster is tap-target height: every interactive element in the header row — quick action links (36px tall), standup button (29px), calendar day buttons (29px), and the standup modal close button (24px) — falls below Apple's 44pt minimum. The Agent Activity approve/reject buttons were not testable (no pending items during run) but are coded with `fontSize:10px; padding:2px 8px`, producing an estimated 22–24px hit area which would be P1 if pending actions were present. Calendar prev/next month chevron buttons could not be found by Playwright's `svg[data-lucide]` selector (lucide uses `data-lucide` attribute on SVGs) — they need a re-check with a different selector, but given the day-button size the entire calendar is a touch usability concern.

---

## Widgets mobile-readiness table

| Widget | Renders OK? | Tappable? | Issues |
|--------|-------------|-----------|--------|
| Greeting + Date | Yes | N/A | Header row stacks correctly via flex-col md:flex-row |
| Quick Actions row | Yes | Partial | Links ~30px tall — below 44px minimum |
| Standup button | Yes | Partial | ~30px tall — below 44px minimum |
| Today (span-2) | Yes | Yes | Collapses to full width at mobile; task links OK |
| Quick Stats 2×2 | Yes | N/A | "In Progress" label may truncate at narrow cells |
| Unread | Yes | Partial | Row items ~32px tall — below minimum |
| Projects + donut rings | Yes | Partial | 32px donut rings legible; link tap area small |
| Activity feed | Yes | N/A | Read-only, renders fine |
| Agent Activity | Yes | No | Approve/Reject: ~24px — dangerously small on touch |
| Calendar mini | Yes | Partial | Day buttons ~24px tall — below 44px minimum |
| My Work kanban | Yes | Yes | Stacks to 1 col at 390px; task cards full-width |
| Team (manager only) | Conditional | Partial | Conditional widget — not tested |
| My Insights | Conditional | N/A | Conditional widget — not tested |
| Standup modal | Yes | Partial | Not full-screen; close X is ~28px; correct mx-4 width |

---

## P0 — blocks release

_(none)_

---

## P1 — must fix

_(none)_

---

## P2 — should fix

### 1. Mobile/TapTarget — Quick action links too short
**Description:** Quick action links (Task, Message, Deft) measure 36px tall — below Apple HIG 44pt minimum. All three links share the same sizing issue. Fix: add `min-h-[44px] items-center` to the link element, or increase `py-` padding.

### 2. Mobile/TapTarget — Standup button too short
**Description:** Standup button measures 81×29px — height 29px is 34% below the 44px minimum. Fix: add `min-h-[44px]` to the button.

### 3. Mobile/TapTarget — Calendar day buttons too short
**Description:** Calendar day buttons measure 48×29px — width is fine (48px) but height 29px falls well below 44px minimum. The month grid has 6 rows × 29px = 174px total; increasing to 44px would yield 264px which is still compact enough for the card.

**Detail:** Min recommended 44px for touch; 32px is borderline

**Screenshot:** 13-calendar-widget-mobile.png

### 4. Mobile/TapTarget — Calendar prev/next month buttons too small
**Description:** Calendar month-nav chevron buttons are `p-0.5` with a 14px icon — estimated ~22×22px hit area. Playwright could not locate them by SVG attribute selector (data-lucide not present in DOM), indicating they may not have adequate padding. Fix: use `p-2` for at least 30px or add `min-w-[44px] min-h-[44px]`.

### 5. Mobile/Standup — Modal close button too small
**Description:** Standup modal close (X) button measures 24×24px — half the required 44px minimum. Fix: add `p-3` instead of `p-1` to the close button.

### 6. Mobile/AgentActivity — Approve/Reject buttons projected to be too small
**Description:** No pending agent actions were present during audit run, so Approve/Reject buttons could not be measured directly. Source code shows `fontSize:'10px', padding:'2px 8px'` — this produces approximately 22–24px hit area. If any pending action exists on a user device, these are the two most consequential buttons on the dashboard and they will be below minimum tap size.

**Detail:** `fontSize: '10px', padding: '2px 8px'` → estimated 22px height. Fix: minimum `py-2.5 px-4` → 40px height (still below 44 but safer), ideally `min-h-[44px]`.

---

## Nits

- **Mobile/AgentActivity:** No pending agent actions existed at audit time — Approve/Reject tap targets not directly measured (see P2 #6 for code-based projection).
- **Mobile/QuickActions selector:** The `a[href="/tasks"]` selector matched a wider wrapper element (216px wide) rather than the button text area — the 36px height reading is for the link container, not the visible button shape. The visual button appears narrower but the tap area is the full link container width, which is actually beneficial for touch (wide tap area).
- **Mobile/Standup modal:** Selector `[style*="max-width: 520px"]` returned null (inline style uses `max-width: 520px` — Playwright matched the backdrop but not the inner panel). Modal width could not be measured. Visual screenshot `11-standup-modal-open.png` shows the modal correctly using `mx-4` (16px each side = 358px at 390px viewport).

---

## Coverage gaps

- Agent Activity approve/reject tested only if pending actions exist at audit time — may be empty
- Team (manager) and My Insights cards are conditional — require specific data to render
- Standup AI generation not tested end-to-end — requires LLM availability
- Dark mode not audited — only light/default theme tested
- Landscape orientation (844×390) not audited
- Pinch-to-zoom / double-tap zoom behaviour not tested

---

## Raw console/network logs

### Console errors
_none_

### Page errors
_none_

### Network errors (4xx/5xx)
_none_

---

## Screenshots index

1. See `01-*.png` in this directory
2. See `02-*.png` in this directory
3. See `03-*.png` in this directory
4. See `04-*.png` in this directory
5. See `05-*.png` in this directory
6. See `06-*.png` in this directory
7. See `07-*.png` in this directory
8. See `08-*.png` in this directory
9. See `09-*.png` in this directory
10. See `10-*.png` in this directory
11. See `11-*.png` in this directory
12. See `12-*.png` in this directory
13. See `13-*.png` in this directory
14. See `14-*.png` in this directory
15. See `15-*.png` in this directory
16. See `16-*.png` in this directory
17. See `17-*.png` in this directory
18. See `18-*.png` in this directory
19. See `19-*.png` in this directory
20. See `20-*.png` in this directory
