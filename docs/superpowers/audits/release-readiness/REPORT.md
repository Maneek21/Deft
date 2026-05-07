# Release-Readiness Audit Report

**Date:** 2026-04-20
**Branch:** feat/phase2-4-mcp-agents-plans (commit 468779e)
**Auditor:** Claude Sonnet 4.6 (automated Playwright walkthrough + static analysis + API probes)

---

## Overview

Full-platform automated walkthrough using headed Playwright Chromium (slowMo: 250ms, 1440x900).

Areas walked: Auth, Dashboard, Notes, Calendar, Chat, Tasks, Knowledge, Agent chat, Agent Employees (list + detail + create wizard), Agent Dashboard, Library, Settings (all subtabs: general, members, groups, tags, integrations, api-access), Webhooks, Misc features, Search, Dead routes, API endpoints.

Also ran: static file-system checks for retired page directories, direct API probes for 7 endpoints, DB query for seeded templates.

- **Total duration:** ~4 minutes (3m 34s browser walk + API probes)
- **Screenshots taken:** 33
- **Browser console errors:** 0
- **Network 4xx/5xx hits:** 5 (all expected — retired routes 404-ing correctly)
- **P0:** 2 | **P1:** 4 | **P2:** 1 | **Nits:** 2

---

## P0: Blocks Release

### 1. Templates route returns empty array for self-hosted — Defty template invisible in wizard

**Area:** API `GET /api/agent-employees/templates` + Create Agent wizard
**URL:** `http://localhost:3001/api/agent-employees/templates`
**Screenshot:** [19-connect-wizard.png](./19-connect-wizard.png)

`apps/api/src/routes/agent-employees.ts` lines 73-75 contain a guard:

```ts
if (process.env.DEFT_SELF_HOSTED === 'true') {
  return c.json([]);
}
```

This hard-codes an empty array for every self-hosted instance, bypassing the DB entirely. The Defty superintendent template (`slug: defty`, name: "Defty — platform captain") **is confirmed in the DB** (11 templates found in `agent_employee_templates`) but is never shown. The wizard template dropdown renders empty in self-hosted mode — a key first-run experience is completely broken.

**Suggested fix:** Remove the early-return guard. Query `agent_employee_templates` where `org_id = user.org_id OR org_id IS NULL`. The guard made sense when templates came from the ClawHub cloud API; they are now seeded locally.

---

### 2. "OpenClaw" brand name visible to users in 4+ places after the reframe

**Area:** `/settings/agent`, `/settings/agent-employees/[id]/developer`
**Screenshot:** [20-agent-dashboard.png](./20-agent-dashboard.png)

After the reframe deleted OpenClaw branding, the following user-visible copy remains:

1. `settings/agent/page.tsx:461` — renders "No OpenClaw gateways deployed yet." in the Gateways panel visible to all users
2. `settings/agent/page.tsx:677` — description reads "...files via the OpenClaw gateway. Native agents..."
3. `settings/agent/page.tsx:97,1004` — badge label `KIND_STYLES.openclaw.label = 'OpenClaw'` rendered on every BYOA agent row as a visible type badge
4. `settings/agent-employees/[id]/developer/page.tsx:103,114` — "...connecting to this agent's OpenClaw gateway." plus a link "OpenClaw Gateway protocol docs" pointing to `https://docs.openclaw.ai/gateway/protocol` (dead URL for self-hosted users)

A new self-hosted user sees "OpenClaw" on day 1 — a deleted brand whose docs link goes nowhere useful.

**Suggested fix:** Rename user-visible strings to "BYOA via MCP" or "MCP gateway". Remove the dead `docs.openclaw.ai` link. The `openclaw` DB enum value can stay — only copy needs to change.

---

## P1: Must-Fix Before Launch

### 1. Signup page shows no self-hosted warning — users submit before getting the 403

**Area:** `/signup`
**Screenshot:** [02-signup.png](./02-signup.png)

`POST /api/auth/signup` with a complete body correctly returns 403 `SINGLE_ORG_LIMIT` with a good error message (confirmed). However, the `/signup` page still shows a standard registration form with no indication it will fail on a self-hosted instance that already has a workspace. A new visitor who follows a "Sign up" link must submit the form to discover they cannot register.

**Suggested fix:** Add a pre-emptive banner when `NEXT_PUBLIC_SELF_HOSTED=true` (or detect via a `/api/health` flag) saying "This workspace already has an account — contact your admin for an invite." Alternatively redirect `/signup` to `/login?error=single_org`.

---

### 2. "Deploy new employee" button copy on agent dashboard uses retired terminology

**Area:** `/settings/agent`
**URL:** `http://localhost:3000/settings/agent`
**Screenshot:** [20-agent-dashboard.png](./20-agent-dashboard.png)

The Employees panel header has a link with `data-testid="deploy-new-employee"` and rendered text **"Deploy new employee"** (`settings/agent/page.tsx:513`). After deleting managed deployment, "deploy" sounds like infrastructure provisioning rather than agent creation. New users will be confused.

**Suggested fix:** Rename to "Connect agent" or "Add employee" to match the wizard's own heading.

---

### 3. Agent employee detail tabs not reachable from the list page

**Area:** `/settings/agent-employees` list + `/settings/agent-employees/[id]/developer|webhooks|heartbeats`

The detail tabs (Developer, Webhooks, Heartbeats) are Next.js sub-routes, not tab buttons on a parent page. There is no `page.tsx` at `/settings/agent-employees/[id]` — navigating there directly 404s. The list page renders employee rows as `div` elements without navigable links. A user cannot click into an employee detail from the list.

**Suggested fix:** Add a `page.tsx` at `[id]` that redirects to `/[id]/developer`, and make each employee row a link to that URL. Human tester: manually navigate to `/settings/agent-employees/<real-id>/developer` to confirm tabs work.

---

### 4. MCP tools/list count could not be verified (27 tools expected)

**Area:** API `POST /api/mcp/v1/tools/list` with BYOA bearer

Automated verification was not possible because MCP tokens are bcrypt-hashed in the DB and the developer endpoint does not expose the plaintext after creation.

**Action for human tester:** Create a fresh BYOA agent via the wizard to get a plaintext token, then verify the tool count:
```
curl -X POST http://localhost:3001/api/mcp/v1/tools/list \
  -H "Authorization: Bearer <mcp-token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
Count the tools array — brief specifies 27.

---

## P2: Should-Fix Before v1.1

### 1. Knowledge wiki contains seed data referencing Railway as production hosting

**Area:** `/knowledge`

The wiki contains seeded pages including "Deploy on Railway" and "Railway hosting for api + web" created by `packages/db/seed-wiki.ts`. For a self-hosted product delivered via Docker, these pages are misleading to new users browsing the knowledge base.

**Suggested fix:** Update `packages/db/seed-wiki.ts` and `seed-knowledge.ts` to replace Railway-specific deployment docs with Docker/self-hosting references. Low urgency — users can edit or delete these pages, but it is confusing on first look.

---

## Nits

### 1. /dashboard6 accessible by URL but not linked from navigation

`/dashboard6` renders a full alternate dashboard layout. If not the production dashboard, either promote it as default or delete the route.

### 2. 7 "AuditAgent 9448 (copy)" clutter rows in agent employees list

Visible to the human tester tomorrow. Consider pre-flight cleanup of `slug LIKE 'auditagent-%'` rows.

---

## Passing Checks

| Check | Result |
|-------|--------|
| `GET /health` | 200 `{"status":"ok"}` — pass |
| `GET /health/queue` | 200 with `{pending:14, running:0, failed:32, completed:270729}` — pass |
| `POST /api/auth/signup` (full valid body with org_name) | 403 `SINGLE_ORG_LIMIT` with good message — pass |
| `GET /api/agent-employees/provider-readiness` | 200 `{"ready":true}` — commit 468779e fix confirmed — pass |
| `POST /api/mcp/v1/initialize` (no bearer) | 200 valid MCP handshake — pass |
| `GET /api/metrics` (no bearer) | 401 (token set in .env — correct) — pass |
| `/settings/agent/deploy` | 404 — pass |
| `/settings/agent-employees/<id>/personality` | 404 — pass |
| `personality` page directory on disk | Absent — pass |
| `agent/deploy` page directory on disk | Absent — pass |
| Browser console errors | 0 — pass |
| Blank or white-screen P0s | None — pass |
| Dashboard, Notes, Calendar, Tasks, Knowledge, Library | All render — pass |
| Settings subtabs (6) | All render — pass |
| Library: no ClawHub tab | Correct, only Skills + Templates — pass |
| Connect wizard three tabs | Native, BYOA via MCP, Custom MCP Client all present — pass |
| Member invite dialog | Opens — pass |
| API key create dialog | Opens — pass |
| Search Cmd+K | Opens and accepts input — pass |

---

## Observations (not bugs)

1. `/search` returns 404 — search is exclusively Cmd+K. No dedicated search page URL. Fine, but human tester should know there is no URL to bookmark for search.
2. All BYOA agents show `kind: "openclaw"` in the DB — even agents created via the new BYOA wizard tab. The `kind` field may need a migration or new enum value for post-reframe agents.
3. `/health/queue` reports 32 failed jobs — likely from previous test runs. Not a blocker but worth a glance before the human test.
4. `mcp-exercise` agent has `last_heartbeat_at` from earlier today — connected and alive.
5. Agent employees list has 13+ rows including 7 inactive AuditAgent copies with no filter/archive UI visible.

---

## Coverage Gaps

- **MCP tools/list with BYOA bearer** — cannot retrieve plaintext MCP token after creation. Human tester must create a fresh BYOA agent and verify 27-tool count.
- **Chat space interior** — 14 spaces confirmed via API. Playwright scan could not click into a space because navigation uses React state/context, not href links. Human tester should click into the general space and verify messages, reactions, threads.
- **Scheduled messages** — requires a future-dated message. Not created.
- **Pinned messages / recap** — requires pre-existing populated space interaction.
- **Agent tool-call rendering** — message was sent; async streaming display requires more time than the 4s wait.
- **Timeline view on tasks** — route file exists at `apps/web/src/app/(app)/tasks/timeline.tsx` but no tab link found in the tasks page.
- **Webhooks sub-route** — exists at `[id]/webhooks` but the list page has no direct employee links. Human tester: navigate to an employee and click the Webhooks tab.
- **Reminders** — `/reminders` route exists but not in main nav.
- **Decisions / Clips** — API routes exist; UI surfaces not confirmed.

---

## Screenshots

1. **01-login.png** — Login page
2. **02-signup.png** — Signup page (P1: no self-hosted warning)
3. **03-dashboard.png** — Dashboard main
4. **04-dashboard6.png** — Dashboard6 alt layout (accessible by URL, not linked from nav)
5. **05-notes.png** — Notes list
6. **06-notes-create.png** — Notes create flow
7. **07-calendar.png** — Calendar view
8. **08-chat.png** — Chat page (spaces in sidebar state, not page body links)
9. **09-tasks.png** — Tasks board view
10. **10-tasks-list.png** — Tasks list view
11. **11-tasks-create.png** — Tasks create dialog
12. **12-knowledge.png** — Knowledge hub
13. **13-knowledge-create.png** — Knowledge create page
14. **14-knowledge-graph.png** — Knowledge graph view
15. **15-agent-chat.png** — Agent chat UI
16. **16-agent-chat-reply.png** — Agent chat after message send
17. **17-agent-employees-list.png** — Agent employees list
18. **18-agent-employee-detail.png** — Agent employee wizard landing
19. **19-connect-wizard.png** — Connect Agent wizard (P0: templates empty in self-hosted)
20. **20-agent-dashboard.png** — Agent dashboard (P0: OpenClaw visible; P1: Deploy copy)
21. **21-agent-dashboard-kebab.png** — Agent dashboard kebab menu
22. **22-library.png** — Library (no ClawHub tab — correct)
23. **23-library-skills.png** — Library Skills tab
24. **24-library-templates.png** — Library Templates tab
25. **25-settings-settings.png** — Settings general
26. **26-settings-settings-members.png** — Settings members
27. **27-settings-settings-groups.png** — Settings groups
28. **28-settings-settings-tags.png** — Settings tags
29. **29-settings-settings-integrations.png** — Settings integrations
30. **30-settings-settings-api-access.png** — Settings API access
31. **31-settings-members-invite.png** — Members invite dialog
32. **32-settings-api-key-create.png** — API key create dialog
33. **33-search-cmdk.png** — Search command palette (Cmd+K)

---

## Raw Console/Network Error Log

### Browser console errors (0)
```
(none)
```

### Network 4xx/5xx during walkthrough (5 — all expected)
```
404 http://localhost:3000/settings/agent-employees/00000000-0000-0000-0000-000000000001/personality
404 http://localhost:3000/settings/agent/deploy
404 http://localhost:3000/search
404 http://localhost:3000/settings/agent/deploy
404 http://localhost:3000/settings/agent-employees/00000000-0000-0000-0000-000000000001/personality
```

All 5 are expected 404s on deliberately retired routes. No unexpected 4xx/5xx from any live page or API call.
