# Cowork Runbook: Agent ↔ Chat Unification (Phases 1–6) End-to-End

**For:** Claude Cowork agent (or any browser-puppeteering agent) testing the Phases 1–6 work shipped on branch `phase1-agent-chat-unification`.

**Goal:** drive a real browser through every user-visible surface introduced or changed by Phases 1–6, plus exercise the backend invariants those surfaces depend on. Find regressions the headless tests can't catch — visual bugs, hydration mismatches, broken navigation, race conditions in mutations, role-gated UI, and storm-detector behavior under live agent traffic.

**You are not** writing or merging code. You are exercising the running app and reporting findings.

---

## Prerequisites you must verify before testing

1. **Dev servers running.** Confirm via HTTP:
   - `GET http://localhost:3001/api/health` returns 200 (api). If port differs, find it via `netstat`/`Get-NetTCPConnection -LocalPort 3001,3011`.
   - `GET http://localhost:3000` returns 200 (web). If port differs, the web app reads `NEXT_PUBLIC_API_URL` to find the api.
   - If neither is up, ask the user to start them (`pnpm dev:api` and `pnpm dev:web` in separate terminals — `pnpm dev` parallel mode silently buffers api stdout on Windows).

2. **Branch is checked out.** `git -C "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" rev-parse --abbrev-ref HEAD` should return `phase1-agent-chat-unification`. If not, the work-under-test is somewhere else.

3. **Seed data exists.** Login as `maneek@test.com` / `test1234` should succeed; this user is `owner` in the seed org `760b7a2b-a4ce-4b75-897c-c86d8e5d8047`. If login fails, the dev DB is wrong.

4. **Phase 6 storm threshold.** Constants are exported from `apps/api/src/lib/storm-detector.ts`: `STORM_THRESHOLD = 5`, `STORM_WINDOW_MS = 600_000` (10 min). Tests below assume these values; if they've drifted, calibrate.

---

## Test user fixtures

| Name | Email | Password | Role | Notes |
|---|---|---|---|---|
| Maneek | `maneek@test.com` | `test1234` | owner | primary tester |
| Priya Shah | `priya@deft.test` | `DeftTest2026!` | member | second user for cross-user tests |
| Rahul Mehta | `rahul@deft.test` | `DeftTest2026!` | member | mention target |
| Arjun Rao | `arjun@deft.test` | `DeftTest2026!` | member | DM target |
| Sara Kim | `sara@deft.test` | `DeftTest2026!` | member | space invitee |

**Verify these still exist** before running anything: `POST /api/auth/login` for each. The DB is reseeded periodically; ids in memory may be stale.

**Defty (the platform agent):** `deft-agent@system.local`, `users.kind = 'agent'`. No password — system-only. Should appear as a member in every space-member list and in the @-autocomplete.

---

## Reporting format (use this for every finding)

```
### [PHASE-N.K] <short title> — <SEVERITY>

Surface: <URL or component name>
Severity: P0 (broken/data loss) | P1 (UX defect, workaround exists) | P2 (polish)
Repro:
  1. ...
  2. ...
Expected: ...
Actual: ...
Console errors: <paste relevant browser console / network 5xx>
Screenshots: <attach if visual>
Suggested cause: <optional hypothesis>
```

P0 findings stop the run for triage. P1/P2 keep going and accumulate.

**At the end of the run** post a summary:
- Total findings by severity
- Phases with regressions vs phases that ship clean
- Whether the run hit the full checklist or stopped early (and why)

---

## Phase 1 — Participant model (`users.kind` first-class)

**What this delivered:** agents are real users in the `users` table with `kind = 'agent' | 'system' | 'human'`. Defty has an `org_members` row in every org. Agent users appear in `/api/members`, the @-autocomplete, and the DM picker. The hardcoded `@deft` shim is gone (the legacy regex stays as a fallback only).

### 1.1 Defty membership smoke

- [ ] **Login** as Maneek. Open `/chat`.
- [ ] **Click "New DM"** (the `+` button in the Direct Messages section of the sidebar). Confirm the picker has a section labeled "Agents" (Phase 4 work, but it's the same picker).
- [ ] **Find Defty** in the Agents section. Confirm:
  - The avatar shows the Bot icon, not a colored letter.
  - There is no "AI" pill on Defty itself in CreateDmModal — Defty has the Bot avatar instead. (BYOA agents use a colored letter avatar plus the AI pill.)
- [ ] **Verify via API:** `GET /api/members` (with bearer token) returns at least one row with `kind: 'agent'` and `email: 'deft-agent@system.local'`. Note the `id` for later.

### 1.2 @-autocomplete shows Defty

- [ ] In the general (or any public) space, focus the message input and type `@de`.
- [ ] **Expected:** the autocomplete dropdown shows `Defty` (or whatever the seed org's `agent_name` is) under an Agents subsection, separated from human matches.
- [ ] **Send** a message containing `@<Defty mention>`. Press enter.
- [ ] **Expected within ~5 seconds:** Defty replies in-thread with a normal-looking agent message. The reply has tool chips, citations, or model+tokens footer (Phase 4 rendering). If the reply never arrives, capture the api log and any `agent-reply` job_queue rows.

### 1.3 Plain `@deft` text still works (legacy regex fallback)

- [ ] In the same space, send `@deft what's on my plate today?` as **plain text** (no autocomplete). Phase 1 says the server should normalize this on insert into a structured mention pointing at Defty's user_id.
- [ ] **Expected:** the rendered message shows `@Defty` styled like other mentions (highlighted, clickable), and Defty replies. If the message renders as plain text without highlight, that's a P1.

### 1.4 BYOA agent visible in /api/members

- [ ] If `Maneek's Claude Code` (or any other BYOA agent) is seeded, hit `GET /api/members` and confirm there's a row with `kind: 'agent'` and `email` containing the agent's slug. Confirm it shows in the DM picker's Agents section as well (with a colored-letter avatar and an AI pill — different from Defty's Bot avatar).

---

## Phase 2 — Agent conversations as spaces

**What this delivered:** the `agent_conversations` and `agent_messages` tables are gone. Each historical agent conversation is a `spaces` row of type `agent_conversation` with the user + the agent as members. Each agent turn lives in `messages` with structured Anthropic blocks in `metadata.agent_blocks`. Tool-result rows carry `metadata.kind = 'tool_result'` so the chat-view filter excludes them.

### 2.1 Direct DM with Defty stores in spaces

- [ ] Open Defty's DM (sidebar > DMs > Defty).
- [ ] Send: `Plan: write a haiku about debugging`. Wait for the response.
- [ ] **Open DevTools > Network**. The chat fetch should hit `/api/messages/<spaceId>` (NOT `/api/agent/conversations/...`). Confirm.
- [ ] **Verify in DB** (or via the api directly): the new messages live in the `messages` table with `metadata.agent_blocks` populated. The space row has `type = 'agent_conversation'`.

### 2.2 Tool-result rows excluded from chat view

- [ ] Trigger an agent reply that uses a tool (e.g., `@Defty list my open tasks`). Defty should call something like `list_my_tasks` internally.
- [ ] **Expected:** the chat view shows ONLY the agent's text reply with a tool-call chip ("Used `list_my_tasks`"). It does NOT show the raw `tool_result` content as a separate message.
- [ ] **Verify in api:** if you query `/api/messages/<spaceId>` you might see the tool_result row in the array (or you might not, depending on whether the filter is server-side or client-side). Either way the rendered UI must not show a raw JSON dump as a chat bubble. Capture a screenshot if it does — that's a P0 information leak.

### 2.3 `/api/agent/conversations/...` legacy contract still works

- [ ] Hit `GET /api/agent/conversations` directly. Phase 2 preserved this contract — it now reads from spaces under the hood. Expect a 200 with an array of conversations and `last_message_at` etc. If you get a 500 or 404, that's a regression.

---

## Phase 3 — Unified MCP tools

**What this delivered:** `send_message` (target = `{space_id}` | `{thread_id}` | `{user_id}`) and `fetch_unread` (chat unread + pending agent_actions in one call). Both replace older tools. The deprecated tools still respond but log a warning.

You are not writing MCP code. You're checking that the BYOA agent path through these tools surfaces correctly in the UI.

### 3.1 Live BYOA agent posts via send_message → appears in chat

- [ ] **Pick a BYOA agent** (`Maneek's Claude Code` if seeded, else any active `agent_employees` row). If the agent has a Claude Desktop / Codex client connected, ask the user to nudge it: "post a quick message in the #general space".
- [ ] **Watch the general space** in the browser. The agent's message should arrive within 1–2 seconds via Socket.io (`message:new` event). Confirm the avatar is a colored-letter circle (Phase 4 BYOA stub authorship), the author name matches the agent name, and the AI badge (Phase 4) is visible next to the name.
- [ ] **If no BYOA agent is connected**, skip 3.1. Document as "skipped — no live BYOA agent".

### 3.2 fetch_unread surfaces pending approvals

- [ ] **Manufacture a pending approval.** From Maneek's session, send `@Defty schedule a Friday 3pm meeting with Priya about Q2 planning` (or any prompt that should produce a quick/full-tier action). Wait for Defty to respond with a "I'd like to..." card.
- [ ] **Find the approval card** in the chat (Phase 4 inline rendering) AND in `/inbox?tab=approvals`.
- [ ] **Verify the card has Approve / Reject buttons.** Don't approve yet — that's tested in Phase 5.4 below.

---

## Phase 4 — UI collapse: chat is the agent surface

**What this delivered:** `/agent` and `/agent/...` are deleted. `SpaceChat` renders agent messages with tool chips, citations, and model+tokens detail. Inline approval cards on agent-authored messages with pending actions. Approval inbox moved to top-level `/approvals` (Phase 5 then moves it to `/inbox`).

### 4.1 `/agent` is gone

- [ ] **Hit** `http://localhost:3000/agent` in the browser.
- [ ] **Expected:** 404 or redirect. NOT a working /agent page. If a page renders, that's a P0 regression — Phase 4 is supposed to have deleted that route.
- [ ] **Hit** `http://localhost:3000/agent/conversations/abc`. Same — should not render.

### 4.2 SpaceChat renders agent message structure

- [ ] In Defty's DM, ask `@Defty list my projects and tag the most blocked one`. Wait for response.
- [ ] **Expected agent message UI:**
  - Tool chip(s) showing what tools Defty called (e.g., "list_projects", "search_tasks").
  - Citations footer if any wiki/note was retrieved (small numbered links).
  - Model + tokens footer at the bottom of the message ("claude-sonnet-... · 127→482 tokens" or similar).
  - The agent's avatar uses the Bot icon (Defty) or colored-letter+AI pill (BYOA), matching the sidebar/picker.
- [ ] **Click a tool chip** if it's expandable. Expected: tool input/output expands inline. Capture any console errors.

### 4.3 Inline approval card

- [ ] Use the pending-approval generated in 3.2. In the chat view (NOT `/inbox`), find Defty's message that proposed the action.
- [ ] **Expected:** an inline `<AgentActionCard/>` is rendered immediately under that message with Approve / Reject buttons. The card mirrors the one shown in `/inbox`.
- [ ] **Verify** that approving from chat (next phase) updates both the chat-inline card AND the `/inbox` list (since both poll `agent_actions`).

### 4.4 Sidebar pinning

- [ ] In the sidebar's Direct Messages section, confirm:
  - Defty is pinned at the top.
  - Other BYOA agents (if any) come next, all grouped before human DMs.
  - Each agent row has the AI pill OR Bot icon distinguishing it from human DMs.

---

## Phase 5 — Universal `/inbox`

**What this delivered:** `GET /api/inbox` aggregates notifications + DM unread + pending approvals. Page at `/inbox` with tabs (All / Mentions / DMs / Tasks / Approvals). Sidebar nav swaps "Approvals" for "Inbox". `/approvals` becomes a redirect to `/inbox?tab=approvals`. New `<InboxRow/>` for non-approval items, `<AgentActionCard/>` reused for approvals.

### 5.1 Inbox page renders

- [ ] Click the **Inbox** entry in the sidebar (it should NOT say "Approvals").
- [ ] **Expected URL:** `/inbox`.
- [ ] **Expected:** Inbox heading, "N unread items" subtitle (or "You're caught up."), tab strip showing All / Mentions / DMs / Tasks / Approvals, list of items below.
- [ ] **Sidebar badge:** if `unread_count > 0` from the api, the Inbox nav entry has a red badge with the same count. Verify by comparing to `GET /api/inbox?count_only=1`.

### 5.2 Tab filtering

- [ ] Click each tab in turn: All, Mentions, DMs, Tasks, Approvals.
- [ ] **Expected per tab:**
  - **All** — every kind interleaved.
  - **Mentions** — only items with `kind: mention`.
  - **DMs** — only `kind: dm_unread` (per-space rollup, not per-message).
  - **Tasks** — both `task_assigned` and `task_updated` (the page filters client-side for this tab).
  - **Approvals** — only `pending_approval` items, rendered as `<AgentActionCard/>` not `<InboxRow/>`.
- [ ] **Edge case:** when a tab is empty, the "Nothing here." placeholder is visible (NOT the Loading spinner).

### 5.3 Mark all read

- [ ] On the All tab with at least 1 unread item, click **Mark all read**.
- [ ] **Expected:** within ~1s the unread count drops to 0, the row backgrounds switch from highlighted to neutral, the sidebar badge disappears.
- [ ] **Network check:** observe `POST /api/inbox/read` with body `{ "all": true }` in DevTools Network. Response should be `{ success: true, updated: <N> }`.

### 5.4 Inline approve / reject

- [ ] Use the pending approval from 3.2. On the Approvals tab, click **Approve**.
- [ ] **Expected:** the card disappears from `/inbox?tab=approvals` within ~1s. The api call is `POST /api/agent/actions/<id>/approve`. Response 200.
- [ ] **Cross-check:** the same card in the chat surface (4.3) should also disappear after ~15s (its SWR poll interval), proving they're reading from the same `agent_actions` row.

### 5.5 `/approvals` redirect

- [ ] Manually navigate to `http://localhost:3000/approvals`.
- [ ] **Expected:** the URL bar lands on `http://localhost:3000/inbox?tab=approvals` and the Approvals tab is selected. The transition may go through a server-component redirect — that's fine — what matters is the final URL.
- [ ] **NOT expected:** the old standalone `/approvals` page rendering with a fresh implementation. If it does, the redirect didn't ship.

### 5.6 Per-row click marks read

- [ ] On the All tab, click any unread non-approval row.
- [ ] **Expected:** the page navigates to the row's `link` (e.g., `/chat?space=...` for a mention or DM). When you come back to `/inbox`, that row should now be in "read" styling.
- [ ] **Network check:** `POST /api/inbox/read` with body `{ "ids": ["notif:<uuid>"] }` should fire on click.

### 5.7 Real-time-ish refresh

- [ ] In a second tab/window, log in as Priya (`priya@deft.test`). Send a DM to Maneek: `hey, quick q`.
- [ ] In Maneek's `/inbox` tab, **wait up to 15 seconds** (the SWR refresh interval). The DM unread should appear in the list. Sidebar badge should bump up.

---

## Phase 6 — Multi-agent affordances

**What this delivered:** the channel "Add members" modal partitions into People / Agents sections with `<AIBadge/>` per agent row. Existing-member rows in the same modal also show the badge for agents. The reply-storm detector returns `STORM_DETECTED` from `sendMessage`/`post_thread_reply` when an agent posts ≥5 thread replies in 10 minutes.

### 6.1 SpaceMembersPanel partition

- [ ] In `/chat`, open any public/private space (not a DM). Click the channel header / kebab menu and choose **Members** (or whatever opens `SpaceMembersPanel`).
- [ ] **Click "Add members"**. Type a query that matches both a human and an agent (e.g., empty query, or `m`).
- [ ] **Expected:**
  - Two sections in the picker, each with an uppercase tracking-wide header: **PEOPLE** and **AGENTS**.
  - People section first, Agents section below.
  - Each agent row has an "AI" pill next to the name.
  - When the picker has zero matches, "No matches found" placeholder.
  - When the org has only humans (no agents available to add), the Agents section is hidden entirely.
- [ ] **Add Defty** (if not already a member). Confirm:
  - The add succeeds (no error toast).
  - Defty appears in the existing-members list above with an AI badge next to the name.
  - Network: `POST /api/spaces/<spaceId>/members` with body `{ user_id: "<defty user id>" }` returned 201.

### 6.2 Existing-members list shows AI badge

- [ ] In the same panel, scroll the existing-members list. For every member with `kind === 'agent'` or `kind === 'system'`, the row shows the "AI" pill next to the name.
- [ ] Human rows do NOT show the pill.
- [ ] The remove button (`UserMinus`) is available on hover for both kinds — humans can remove agents the same way they remove humans.

### 6.3 Reply-storm detector — BYOA path

This requires a live BYOA agent that you can drive. If none is connected, skip and document.

- [ ] **Ask the user** to point a Claude Code / Claude Desktop client at the BYOA agent's MCP endpoint, with a prompt like: "Reply to message X in the thread 6 times in a row, one second apart." (X is a real message id from the seed org.)
- [ ] **Expected behavior:** the first 5 `send_message` calls (or `post_thread_reply` if the agent uses that legacy tool) succeed. The 6th call returns `isError: true` with content text matching `/STORM_DETECTED.*backing off/`.
- [ ] **In the chat UI:** confirm that 5 replies posted to the thread (visible in the chat panel), and the 6th never appeared.
- [ ] **In api logs:** the line `STORM_DETECTED: agent exceeded 5 replies in this thread within the rate-limit window; backing off` should appear once. Capture it.
- [ ] **Recovery:** wait 10 minutes (or manually delete the seed replies via admin SQL). Retry — the agent should now succeed again.

### 6.4 Reply-storm detector — Defty path (alternative)

If you can't get a BYOA agent looping, force Defty into a thread storm:
- [ ] Pick a thread (`parent_message_id = X`).
- [ ] Manually insert 5 messages into `messages` with `user_id = <defty_user_id>`, `parent_id = X`, `is_deleted = false`, `created_at = NOW()` via the dev DB.
- [ ] In the UI, ask `@Defty reply to thread X with another comment`.
- [ ] **Expected:** Defty either declines visibly or the action returns an error in `agent_actions.error` matching `STORM_DETECTED`. Verify by querying `agent_actions WHERE action='post_thread_reply' AND user_id=<defty_user_id> AND error LIKE '%STORM_DETECTED%'` after the attempt.

### 6.5 Storm doesn't affect non-thread paths

Important false-positive check: the storm guard is scoped to thread replies. Top-level posts and DMs MUST stay unthrottled.
- [ ] After tripping the storm in 6.3 or 6.4, immediately:
  - Have the agent post a top-level message in the SAME space (not a thread reply). Should succeed.
  - Have the agent send a DM to a human user. Should succeed.
  - Have the agent reply in a DIFFERENT thread (different `parent_message_id`). Should succeed.
- [ ] All three must work. If any of them returns `STORM_DETECTED`, the guard is over-broad — that's a P0.

### 6.6 Storm doesn't affect humans

- [ ] As Maneek, post 6+ thread replies in the same thread (within 10 minutes). Each should succeed.
- [ ] **Expected:** no `STORM_DETECTED` error visible in chat or api logs. The guard is agent-only — humans hitting the same threshold pass through.

---

## Cross-phase regressions to watch for

These aren't tied to a single phase but easy to break:

- [ ] **Sidebar can render** `Inbox` with badge AND the spaces list AND the DMs list (with Defty pinned, BYOA agents grouped, then humans). All three must coexist without overflow / clipping.
- [ ] **`@-mention autocomplete** still works for HUMAN users (not just agents). Type `@pri`, expect Priya Shah.
- [ ] **CreateDmModal opens from the `+` button** in the DMs section of the sidebar. Search box autofocuses. Closing with Esc works.
- [ ] **Kbd shortcuts** still navigate (`g i` → inbox, etc., if those bindings exist). Don't fail this checklist if shortcuts simply weren't defined; only fail if they USED to work and now don't.
- [ ] **Console is clean.** No React hydration warnings on `/inbox`, `/chat`, `/chat?space=<dmId>`, or `/settings/agent-employees/<id>`. One yellow Next.js workspace-root warning is fine; the rest should be quiet.
- [ ] **Network has no 5xx responses** during normal navigation. 401s on `/api/health` while logged out are fine.
- [ ] **Dark/light theme toggle.** Switch the theme. AI badges should remain legible (the pill uses `var(--surface)` background and `var(--muted)` text — both respond to the theme).

---

## Out-of-scope (don't test these)

- BYOA wizard / deploy flows — covered by separate audits.
- Trust-level promotion / demotion UI — Phase 0 territory.
- Mobile responsive layout (the `phase1-agent-chat-unification` worktree didn't touch responsiveness).
- Storm-detector tunability via UI — there's no UI for it; the constants live in code.
- Per-thread mute toggles — explicitly out-of-scope per the Phase 6 spec.

---

## Final report template

Post this exact structure when done:

```markdown
# Cowork Run — Agent ↔ Chat Unification (Phases 1–6)

**Date:** YYYY-MM-DD
**Branch HEAD:** <git rev-parse HEAD>
**Browser:** Chrome <version>
**Total findings:** X (P0: A, P1: B, P2: C)

## Summary

- Phase 1: <PASS / N findings>
- Phase 2: <PASS / N findings>
- Phase 3: <PASS / N findings (or SKIPPED — no live BYOA)>
- Phase 4: <PASS / N findings>
- Phase 5: <PASS / N findings>
- Phase 6: <PASS / N findings (or partial — section X skipped)>
- Cross-phase: <PASS / N findings>

## Findings

[paste each finding using the template above]

## Run notes

- Sections skipped and why
- Anything surprising in the flow that didn't fit a single finding
- Suggestions for improving this runbook
```

---

## Tips for the puppeteering agent

- **Wait for hydration**, not just DOM ready. Next.js client components mount after the initial HTML; `wait_for_selector('[data-hydrated]')` or polling for a known interactive element is more reliable than `wait_for_load_state('networkidle')` (Socket.io keeps the network busy).
- **Capture screenshots on every P0/P1**, not just at the end. By the time you summarize, the page state has moved on.
- **Open DevTools** before navigating so console errors and network failures are captured from the first paint.
- **Use real users from the fixtures table** — don't sign up new users, the seed-only fixtures are already wired into the spaces and agent_actions you'll be exercising.
- **Read api logs after every storm/approval test** — the most informative signal often lands there, not in the UI.
- **Don't approve real pending actions** unless you generated them. Other test users may be relying on them.
- **If a test requires a live BYOA agent and none is connected**, skip the test and document — don't try to fake the BYOA path.
