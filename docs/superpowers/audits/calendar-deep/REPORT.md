# Calendar Deep Audit

**Date:** 2026-04-20
**Branch:** feat/phase2-4-mcp-agents-plans
**Duration:** 50s
**Findings:** P0=0 P1=0 P2=1 Nit=1 Gap=5
**Console errors:** 1
**Network 4xx/5xx:** 1
**Screenshots:** 15

---

## Surfaces observed

- `/calendar` — Month/Week/Day calendar with task/event overlay and DnD reschedule
- `CalendarHeader` — View toggle (Month/Week/Day), Today button, New Event, Google Calendar connect/sync
- `MonthView` — 6-week grid with event chips, task chips (TaskCardUnified), drag-to-reschedule (@dnd-kit)
- `WeekView` — Hourly time-slot grid with click-to-create
- `DayView` — Single-day hourly time-slot grid with click-to-create
- `DayDetailPanel` — Slide-in side panel on day cell click
- `CreateEventModal` — Title, date, start/end time, location, description, attendees
- `EventDetailModal` — Event detail with brief, attendees (RSVP status), Google Meet link, edit/delete
- `/api/calendar` — Unified endpoint (tasks + events + notes + reminders)
- `/api/calendar/briefs` — Meeting prep briefs endpoint
- `/api/events` — Create/delete native calendar events
- `/api/connections` — OAuth connection status
- `/settings/integrations` — Google Calendar connect/sync UI

---

## P0 — Blocks release

_None_


## P1 — Must fix

_None_


## P2 — Should fix

1. **[OAuth Initiate]** `GET /api/connections/google_calendar/oauth/initiate` returns 404 — the OAuth kickoff endpoint is either not registered or behind a different path. The "Connect" button in `/settings/integrations` would silently fail if wired to this URL.
  - Screenshot: `12-settings-integrations.png`
  - Detail: Response body: "404 Not Found". Verified the `/api/connections` list endpoint works (200) and returns `google_calendar` as a known provider, so the route registration is incomplete.

2. **[Task API]** `GET /api/tasks` returns 404 for the test user during the audit, preventing direct verification of task-with-due-date overlay. Calendar data endpoint (`/api/calendar`) did return 1 task this month, so tasks ARE reaching the calendar — but the tasks list endpoint itself is 404 (may require project-scoped query params not sent by the test).
  - Detail: `/api/tasks` without a `project_id` param returned 404. Task overlay in calendar is partially confirmed via `/api/calendar` data.


## Nits

1. **[Nav Deep-Link]** Calendar navigation is React-state only — URL never updates. Bookmarked URLs always land on today's month.
  - Detail: Not a bug per current design, but limits shareability / browser back/forward.


## Coverage gaps

1. **[Agenda View]** No Agenda view toggle — only Month/Week/Day supported
  - Detail: Source code confirms only 3 views. Noted as coverage gap.

2. **[Task Overlay]** No tasks with due dates found for test user — cannot verify task rendering on calendar
  - Detail: Seed a task with a due date to test this flow.

3. **[Task Drag-Drop]** 1 calendar tasks found — drag-to-reschedule UI flow not tested (requires visible drag handles in month cells)
  - Screenshot: `11-task-overlay-visible.png`
  - Detail: Source code implements DnD via @dnd-kit/core. Functional test would need a seeded visible task.

4. **[Meeting Briefs]** No calendar events found — meeting brief flow cannot be tested (requires synced or native events)
  - Detail: Google Calendar OAuth or native events needed to seed events.

5. **[Google Calendar OAuth]** Google Calendar not connected for test user — OAuth flow not completeable in automated test (requires browser-level OAuth redirect)
  - Detail: This is a coverage gap, not a bug. Noted for manual testing.


---

## Raw logs

### Console errors/warnings

```
[console.error] Failed to load resource: the server responded with a status of 400 (Bad Request)
```

### Network 4xx/5xx

```
[400] http://localhost:3001/api/events   ← intentional: end-before-start validation test (expected 400)
[404] http://localhost:3001/api/connections/google_calendar/oauth/initiate  ← P2 finding above
```

### Uncaught page errors

```
_None_
```

---

## Screenshots index

- `01-*.png`
- `02-*.png`
- `03-*.png`
- `04-*.png`
- `05-*.png`
- `06-*.png`
- `07-*.png`
- `08-*.png`
- `09-*.png`
- `10-*.png`
- `11-*.png`
- `12-*.png`
- `13-*.png`
- `14-*.png`
- `15-*.png`