# Deft Agent — Test Plan

Use this prompt with Claude to systematically test every agent capability. Login as **maneek@test.com / test1234** unless stated otherwise.

---

## Prerequisites

1. API server running on `localhost:3001`
2. Web app running on `localhost:3000`
3. Database seeded (`npx tsx packages/db/seed.ts`)
4. `ANTHROPIC_API_KEY` set in `.env`
5. `job_queue` table exists in Postgres

---

## Test 1: Agent Chat — Basic Conversation

**Navigate to:** `/agent`

**Send these messages one at a time and verify:**

| Message | Expected Behavior |
|---------|-------------------|
| "What tasks are in progress?" | Agent calls `search_tasks` tool, returns DEFT-7, DEFT-8, DEFT-9. Shows "Searching tasks..." status during tool call. Shows citations with task IDs. |
| "Who is working on what?" | Agent calls `get_team_workload` tool. Returns breakdown by assignee. |
| "What's the status of DEFT-10?" | Agent calls `get_task_detail`. Returns full task detail including comments and activity log. |
| "How many tasks did we close?" | Agent calls `get_workspace_stats`. Returns completion metrics. |
| "How is Deft v1 progressing?" | Agent calls `get_project_progress`. Returns completion %, task breakdown, blockers. |

**Verify for each:**
- [ ] Thinking dots appear immediately after sending
- [ ] Thinking dots are BELOW the user message (not above)
- [ ] "Searching..." status shows during tool calls
- [ ] Response streams in word-by-word
- [ ] Citations appear as clickable chips
- [ ] Confidence indicator shows below response
- [ ] Follow-up suggestion chips appear
- [ ] Auto-scroll follows the response

---

## Test 2: Agent Memory

**In the same conversation:**

| Message | Expected |
|---------|----------|
| "Remember that I prefer tasks sorted by priority" | Agent calls `remember` tool with scope='user'. Confirms it stored the preference. |
| "What do you remember about me?" | Agent calls `recall` tool. Returns the stored preference. |

**Start a NEW conversation:**

| Message | Expected |
|---------|----------|
| "What do you know about my preferences?" | Agent should recall the user-scope memory from the previous conversation. Check that the system prompt includes "Known context about this user/conversation". |

---

## Test 3: Agent Actions + Approval Flow

| Message | Expected |
|---------|----------|
| "Create a task called 'Fix WebSocket reconnection' in Deft v1, assign to Rahul, priority P1" | Agent proposes a `create_task` action. An approval card appears with task details. |
| Click **Approve** | Task is created. Card shows green checkmark "approved and executed". An "Undo" link appears (valid for 5 min). |
| Click **Undo** | Task is soft-deleted. Card shows "undone". |

**Also test rejection:**

| Message | Expected |
|---------|----------|
| "Post a message in #engineering saying 'standup at 10am tomorrow'" | Agent proposes a `post_message` action. |
| Click **Reject** | Card shows strikethrough "rejected". No message posted. |

---

## Test 4: Agent Undo + Audit Trail

After approving an action above:

1. **Check audit log:** `GET /api/audit?limit=10` — should contain entries for the create_task and undo actions with before/after state.
2. **Test status undo:**
   - Ask: "Move DEFT-7 to in review"
   - Approve the action
   - Click Undo within 5 minutes
   - Verify task reverted to `in_progress`

---

## Test 5: @agent Mentions in Chat

**Navigate to:** `/chat` → `#engineering`

1. **Autocomplete:** Type `@` in the composer. Verify "Deft" appears in the mention dropdown with a bot icon and "AI" badge.
2. **Send:** `@Deft what tasks are overdue?`
3. **Verify:**
   - [ ] Message sends immediately (no delay)
   - [ ] A job appears in `job_queue` table with name='agent-reply'
   - [ ] After the worker processes it (3-5 seconds), a threaded reply appears from "Deft" with the agent's response
   - [ ] The thread indicator shows "1 reply" on the original message

**Thread context test:**
4. Open the thread on the agent's reply
5. Type: `@Deft tell me more about the first one`
6. Verify the agent's response references the previous thread context

---

## Test 6: Cross-Reference Intelligence

**In `#engineering`, send:** `Has anyone looked at DEFT-7 lately? The thread panel is still buggy.`

**Verify:**
- [ ] A `cross-reference` job appears in `job_queue`
- [ ] After processing: `GET /api/tasks/{DEFT-7-id}/references` returns a cross-reference linking the message to the task
- [ ] A comment appears on DEFT-7: "Discussed in #engineering: Has anyone looked at..."

**Send another:** `We need to close DEFT-10 and DEFT-14 before the demo`

**Verify:** Two cross-references created (one for each task ID).

---

## Test 7: Natural Language Task Creation

**In `#engineering`, send:** `We really need to add rate limiting to the API before launch`

**Verify:**
- [ ] The message classifier detects `task_create` or `actionable` intent
- [ ] A `task-extract` job appears in `job_queue`
- [ ] After processing: an inline suggestion card appears below the message: "Deft suggests: Create task 'Add rate limiting to the API'"
- [ ] Click **Accept** → task is created
- [ ] Click **Dismiss** → card disappears

**Negative test:** Send a casual message like `"lol that's hilarious"` — no task suggestion should appear.

---

## Test 8: Daily Standup

**On the dashboard (`/dashboard`):**

1. Verify the "Daily Standup" section is visible
2. If no standup exists: click **Generate Now**
3. Verify:
   - [ ] Loading spinner shows while generating
   - [ ] Summary appears with activity data (tasks completed, created, updates)
   - [ ] The standup is cached — refreshing the page shows the same standup without regenerating

**API test:**
```
POST /api/dashboard/standup
```
Should return the cached standup with `already_existed: true`.

---

## Test 9: Proactive Nudges

**Setup:** Manually update a task to simulate staleness:
```sql
UPDATE tasks SET updated_at = now() - interval '72 hours'
WHERE status = 'in_progress' LIMIT 1;
```

**Trigger the nudge check:** Insert a nudge job:
```sql
INSERT INTO job_queue (id, queue, name, data, status, run_at)
VALUES (gen_random_uuid(), 'scheduled-jobs', 'nudge-check', '{}', 'pending', now());
```

**Verify:**
- [ ] After worker picks it up: a notification is created for the task's assignee
- [ ] `agent_nudges` table has a new entry
- [ ] Running the nudge check again within 24h does NOT create a duplicate nudge

---

## Test 10: Meeting Prep Briefs

**Setup:** Insert a fake calendar event starting in 15 minutes:
```sql
INSERT INTO events (id, org_id, source, event_type, title, event_timestamp, metadata, user_id)
VALUES (
  gen_random_uuid(),
  (SELECT id FROM orgs LIMIT 1),
  'google_calendar',
  'calendar_event',
  'Sprint Planning',
  now() + interval '15 minutes',
  '{"attendees": [{"displayName": "Maneek", "email": "maneek@test.com"}, {"displayName": "Rahul", "email": "rahul@test.com"}]}',
  (SELECT id FROM users WHERE email = 'maneek@test.com')
);
```

**Trigger meeting prep:**
```sql
INSERT INTO job_queue (id, queue, name, data, status, run_at)
VALUES (gen_random_uuid(), 'scheduled-jobs', 'meeting-prep-check', '{}', 'pending', now());
```

**Verify:**
- [ ] After processing: `meeting_briefs` table has a new entry
- [ ] Notification created for maneek
- [ ] Brief contains relevant context about attendees' tasks

---

## Test 11: Notification System

**Navigate to the top-right notification bell.**

**Verify:**
- [ ] Red badge shows unread count
- [ ] Clicking opens the dropdown with notifications
- [ ] Channel message notifications show: "Rahul in #engineering" with message preview
- [ ] Task notifications show: "Sara assigned you DEFT-8"
- [ ] Clicking a notification navigates to the correct page
- [ ] "Mark all read" clears the badge
- [ ] New notifications increment the badge in real-time (test by sending a message from another account)

---

## Test 12: Unread Messages

**Login as rahul@test.com in an incognito window.**

1. Send a message in `#engineering`
2. Switch back to maneek's session
3. **Verify sidebar:**
   - [ ] `#engineering` shows a count badge (not just a dot) with the number of unread messages
   - [ ] Channel name is bold
4. **Click `#engineering`:**
   - [ ] Red "New messages" divider line appears between the last-read message and the new ones
   - [ ] Unread count clears from sidebar
   - [ ] Divider disappears on next visit

---

## Test 13: Message Bookmarks

**In any chat channel:**

1. Hover over a message → click the **bookmark icon** (between Pin and Create Task)
2. Verify icon fills in and turns purple
3. Click again → verify it unfills (unsaved)
4. Save 2-3 messages across different channels
5. Click the **bookmark icon** in the sidebar bottom bar
6. **Verify Saved Items modal:**
   - [ ] Shows all saved messages with author, channel name, date
   - [ ] Click a saved message → navigates to that message in chat
   - [ ] X button removes from saved

---

## Test 14: Catch Up Summary

**In `#engineering`:**

1. Click the **Catch Up** button in the channel header
2. **Verify:**
   - [ ] "Reading..." loading state shows
   - [ ] Summary appears with key decisions, action items, updates
   - [ ] X button dismisses the summary
   - [ ] Works even if you've already read all messages (falls back to summarizing recent messages)

---

## Test 15: DND Toggle

1. In the sidebar bottom bar, click the **bell icon** (between bookmark and theme toggle)
2. **Verify:**
   - [ ] Icon changes to BellOff with amber color
   - [ ] User status updates to "Do Not Disturb" with moon emoji
3. Click again to disable
4. **Verify:** Icon reverts to normal bell

---

## Test 16: LLM Router

**Verify the model routing works by checking API logs for model names used:**

| Feature | Expected Task Type | Default Model |
|---------|-------------------|---------------|
| Agent chat | `reason` | claude-sonnet-4-20250514 |
| Classifier | `classify` | claude-haiku-4-5-20251001 |
| Catch Up summary | `summarize` | claude-haiku-4-5-20251001 |
| Standup generation | `summarize` | claude-haiku-4-5-20251001 |
| Meeting prep | `summarize` | claude-haiku-4-5-20251001 |
| Task extraction | `extract` | claude-haiku-4-5-20251001 |

**To test with a different provider** (if you have the key):
Set `OPENAI_API_KEY` or `OPENROUTER_API_KEY` in `.env` and modify `DEFAULT_ROUTES` in `apps/api/src/lib/llm.ts` to route `classify` to the alternate provider. Restart and verify the classifier still works.

---

## Test 17: Postgres Job Queue Health

**Monitor the queue:**
```sql
-- Pending jobs
SELECT name, status, attempts, created_at, run_at
FROM job_queue WHERE status = 'pending' ORDER BY created_at DESC;

-- Failed jobs
SELECT name, error, attempts, max_attempts
FROM job_queue WHERE status = 'failed' ORDER BY created_at DESC;

-- Completed jobs
SELECT name, completed_at, attempts
FROM job_queue WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 20;

-- Cron jobs
SELECT name, cron_key, status, run_at
FROM job_queue WHERE cron_key IS NOT NULL;
```

**Verify:**
- [ ] No stuck jobs (status='running' for more than 5 minutes)
- [ ] Failed jobs have error messages
- [ ] Cron jobs re-enqueue after completion
- [ ] Job count doesn't grow unbounded (completed jobs should exist)

---

## Edge Cases to Test

- [ ] Send a message with both `@Deft` and a task ref (`DEFT-7`) — both jobs should enqueue
- [ ] Send a very long message (1000+ chars) — classifier should still work
- [ ] Rapidly send 5 messages — no race conditions, all process correctly
- [ ] Open agent chat, send a message, immediately click Stop — response stops cleanly
- [ ] Approve an agent action, wait 6 minutes, try Undo — should be disabled (5 min window)
- [ ] Navigate away from agent chat mid-stream, come back — conversation loads from DB
- [ ] Test with `ANTHROPIC_API_KEY` removed — all AI features should fall back gracefully (no crashes, static summaries shown instead)
