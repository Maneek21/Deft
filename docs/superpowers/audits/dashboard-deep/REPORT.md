# Dashboard Deep Audit

**Date:** 2026-04-20
**Branch:** feat/phase2-4-mcp-agents-plans
**Duration:** 66s
**Findings:** P0×0 P1×2 P2×1 Nit×1
**Screenshots:** 19

---

## Widgets observed

- Greeting header + date line (h1 with time-of-day, user first name)
- Quick actions row: Task link, Message link, Deft link, Standup button
- Today card (span-2): overdue + due-today tasks merged, sorted by priority
- Quick Stats card: 2×2 grid — Overdue/DueToday/InProgress/Completed counts
- Unread card: unread message spaces with badge counts
- Projects card: progress rings with done/total tasks and % label
- Activity card: recent task_activity feed (5 items max)
- Agent Activity card: recent agent_actions with approve/reject inline for pending
- Calendar mini-widget: month grid with day-dots for tasks/events/notes
- My Work card (span-2): kanban-lite columns todo/in_progress/in_review
- Team card (manager-only): health cards, 1:1 prep links (conditional)
- My Insights card: activity stats + pace bar + expertise tags (conditional)
- Standup modal: Daily Standup overlay with AI-generated content

---

## P0 — blocks release

_(none)_

## P1 — must fix


### 1. Dashboard/Greeting — Greeting h1 does not contain time-of-day text: "Deft AI"

**Description:** Greeting h1 does not contain time-of-day text: "Deft AI"



### 2. Dashboard/Realtime — Task creation via API failed with 404

**Description:** Task creation via API failed with 404




## P2 — should fix


### 1. Dashboard/Activity — Activity bento card not visible

**Description:** Activity bento card not visible




## Nits


- **Dashboard/Realtime:** Dashboard does not auto-refresh when new tasks are created — relies on manual refresh. Expected for SWR-based approach.

---

## Coverage gaps

- Standup generation (AI) not tested end-to-end — requires LLM availability
- Team Health and 1:1 Prep cards not tested — user is owner but team health data may be empty
- My Insights card conditional — only shown when insights data available
- GitHub activity widget — no GitHub integration connected
- Calendar widget events — no Google Calendar integration connected
- True real-time (WebSocket) dashboard refresh not verified — dashboard appears SWR-based

---

## Raw console/network logs

### Console errors
- Failed to load resource: the server responded with a status of 500 (Internal Server Error)

### Page errors
_none_

### Network errors (4xx/5xx)
- 500 /api/dashboard/standup

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