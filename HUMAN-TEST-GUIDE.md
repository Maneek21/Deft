# Deft — Human Test Guide

Step-by-step manual testing for every feature. No SQL needed. Just click through the UI.

**Setup:** Run `npx tsx packages/db/seed.ts` then start both servers.
**Login:** maneek@test.com / test1234

---

## 1. Login & First Impressions

1. Open http://localhost:3000
2. You should be redirected to /login
3. Enter maneek@test.com / test1234, click Login
4. **Check:** You land on the Chat page with the sidebar visible
5. **Check:** Sidebar shows channels (#general, #engineering, #design, #random) and DMs
6. **Check:** Some channels show **unread count badges** (numbers like "6", "12" — not just dots)
7. **Check:** Dark theme by default

---

## 2. Sidebar

1. **Unread badges:** #engineering should show ~12 unread, #general should show ~6
2. **Collapse:** Click the collapse icon (top of sidebar). Sidebar shrinks to icon-only mode
3. **Expand:** Click the expand icon. Sidebar returns to full width
4. **Bottom bar icons (left to right):** User avatar, Saved (bookmark), DND (bell), Theme (sun/moon), More (...)
5. Click the **moon/sun icon** — theme toggles between dark and light
6. Click **More (...)** — dropdown with Settings and Log out appears

---

## 3. Chat — Basic Messaging

1. Click **#engineering** in the sidebar
2. **Check:** 50+ messages between Rahul and Arjun load
3. **Check:** Messages are grouped (same author within 5 min = compact, no avatar repeat)
4. **Check:** Day separator headers appear (e.g., "SATURDAY, MAR 28")
5. Scroll to the bottom. Type "test message from maneek" and press Enter
6. **Check:** Message appears instantly at the bottom
7. **Check:** Your message shows on the right side with your avatar

---

## 4. Unread Divider

1. Open **#engineering** (if not already there)
2. **Check:** A **red "New messages" line** appears somewhere in the message list, separating old messages from unread ones
3. Scroll up to find it — it should be after Arjun's message "Perfect. I'll have the notification flow done by tonight..."
4. **Check:** Everything below the red line was "unread" when you first opened the channel
5. Navigate away to #general, then back to #engineering
6. **Check:** The red line is gone (you've now read everything)

---

## 5. Chat — Hover Toolbar

1. Hover over any message from Rahul or Arjun
2. **Check:** A floating toolbar appears with icons: React (smile), Reply, Pin, **Bookmark**, Create Task, More (...)
3. Click **React (smile)** — emoji picker opens. Pick any emoji
4. **Check:** Reaction appears below the message with count "1"
5. Click the reaction again — it removes
6. Click **Pin** — the message pins
7. **Check:** A **pinned bar** appears at the top of the chat showing the pinned message
8. Click the pinned bar — dropdown expands showing all pins
9. Click **Unpin** on the pinned message in the dropdown

---

## 6. Message Bookmarks

1. Hover over a message, click the **bookmark icon** (flag shape, between Pin and Create Task)
2. **Check:** Icon fills in and turns purple — message is saved
3. Hover over another message in a different channel and bookmark it too
4. In the sidebar bottom bar, click the **bookmark icon**
5. **Check:** "Saved Items" modal opens showing your bookmarked messages
6. **Check:** Each entry shows author name, #channel name, date, and message preview
7. Click a saved message — you navigate to it in chat
8. Click the X on a saved message — it's removed from saved items
9. Go back to the original message, hover — bookmark icon should be unfilled again

---

## 7. Threads

1. Hover over any message, click **Reply**
2. **Check:** Thread panel opens on the right side
3. Type a reply and send it
4. **Check:** Reply appears in the thread panel
5. **Check:** The original message in the main chat now shows "1 reply" indicator
6. Close the thread panel (X or click elsewhere)

---

## 8. Notifications

1. Look at the **top-right bell icon**
2. **Check:** Red badge with a number (should be 5 or more)
3. Click the bell
4. **Check:** Dropdown opens with notifications like:
   - "Rahul in #engineering" (channel messages)
   - "Sara assigned you DEFT-8" (task assignment)
5. Click a notification — you navigate to the relevant page
6. Click **Mark all read** — badge disappears
7. Close the dropdown

---

## 9. Chat — More Actions

1. Hover over **your own message**, click **More (...)**
2. **Check:** Dropdown with: Edit, Copy link, Remind me, Delete
3. Click **Edit** — message enters edit mode with "Editing" label
4. Change the text, press Enter — message updates
5. Try **Remind me > In 20 minutes** on any message
6. Try **Delete** on your own message — confirmation dialog appears, confirm it
7. **Check:** Message shows "[deleted]" or disappears

---

## 10. Create Task from Chat

1. Hover over a message with meaningful content, click **Create Task** (checkbox icon)
2. **Check:** Task creation modal/panel opens with the message text pre-filled as the title
3. **Check:** Title starts from the beginning of the message (not mid-sentence)
4. Select a project, set priority if you want
5. Click Create
6. **Check:** Task is created (navigate to Tasks to verify)

---

## 11. Catch-Up Summary

1. Go to **#engineering**
2. In the channel header bar, click **Catch Up**
3. **Check:** "Reading..." loading state appears
4. **Check:** A summary card appears at the top of the chat (sticky — visible even when scrolled)
5. **Check:** Summary mentions key topics (WebSocket reconnection, Drizzle, notifications, drag-and-drop)
6. **Check:** Markdown is rendered (bold text, bullet points — not raw ** and - characters)
7. Click X to dismiss the summary

---

## 12. DND (Do Not Disturb)

1. In the sidebar bottom bar, click the **bell icon**
2. **Check:** Icon changes to a crossed-out bell (BellOff) with amber/orange color
3. Refresh the page
4. **Check:** DND state persists (bell should still be crossed out)
5. Click the bell icon again to disable DND
6. **Check:** Icon returns to normal bell

---

## 13. Channel Rename

1. In any channel (e.g., #design), **double-click the channel name** in the chat header
2. **Check:** Name becomes editable
3. Change it to "design-reviews", press Enter
4. **Check:** Channel name updates in the header and sidebar
5. Rename it back to "design"

---

## 14. Tasks — Board View

1. Click **Tasks** in the sidebar navigation
2. **Check:** Kanban board with 5 columns: Backlog, Todo, In Progress, In Review, Done
3. **Check:** Task cards show: ID (DEFT-7), title, priority badge (P0/P1/P2/P3), assignee avatar
4. **Check:** Column headers show task counts
5. Switch between projects using the project selector (Deft v1 / Design System)

---

## 15. Tasks — Drag and Drop

1. Grab a task card from "Todo" column
2. Drag it to "In Progress" column
3. **Check:** Card moves instantly (optimistic update)
4. Refresh the page — **Check:** The move persisted

---

## 16. Tasks — Create New Task

1. Click **+ New Task** button (or press C)
2. Enter title: "Test task from manual testing"
3. Leave assignee and due date empty
4. Click Create
5. **Check:** Task appears in the Backlog column
6. **Check:** No error (the null fields bug should be fixed)

---

## 17. Tasks — Task Detail

1. Click any task card to open the detail panel
2. **Check:** Shows status, priority, assignee, labels, description, comments, activity
3. Change the status dropdown to "Done"
4. **Check:** No crash. Task moves to Done column smoothly
5. Click the title to edit it, type something new, press Escape
6. **Check:** Edit cancels (original title restored), panel stays open
7. Press Enter instead — **Check:** Title saves
8. Close the panel

---

## 18. Tasks — Subtasks

1. Open any task detail panel
2. Look for a "Subtasks" section (may need to scroll down)
3. Click **Add subtask** (or the + icon in the subtask section)
4. Enter title: "Sub-item for testing"
5. **Check:** Subtask appears under the parent task
6. Click the checkbox on the subtask to toggle it complete
7. **Check:** Subtask shows as completed (strikethrough or checkmark)
8. Click the subtask title to navigate to the subtask detail
9. **Check:** Subtask detail panel shows the parent task reference
10. Navigate back to the parent task
11. **Check:** Parent task still shows the subtask in its list

---

## 19. Tasks — Dependencies

1. Open any task detail panel (e.g., DEFT-7)
2. Look for a "Dependencies" or "Relationships" section
3. Click **Add dependency** (or similar button)
4. Search for another task (e.g., DEFT-10)
5. Select relationship type: "blocks" or "relates to"
6. **Check:** Dependency appears in the task detail showing the linked task
7. Click the linked task to navigate to it
8. **Check:** The reverse relationship appears (e.g., "blocked by DEFT-7")
9. Go back to the original task, remove the dependency
10. **Check:** Dependency is removed from both sides

---

## 20. Tasks — Bulk Operations

1. Go to the task board view
2. Look for a **Select mode** toggle or multi-select button
3. Enable selection mode
4. Select 3 or more tasks by clicking them
5. **Check:** A bulk action bar appears (or toolbar changes)
6. Try **bulk status change** — change all selected to "In Review"
7. **Check:** All selected tasks move to the In Review column
8. Select tasks again, try **bulk delete**
9. **Check:** Confirmation dialog appears, confirm it
10. **Check:** Tasks are removed from the board

---

## 21. Tasks — Due Date Badges

1. Find or create a task with a due date set to **yesterday** (overdue)
2. **Check:** Task card shows a **red** due date badge or indicator
3. Find or create a task with a due date set to **today**
4. **Check:** Task card shows an **amber/orange** due date badge
5. Find or create a task with a due date in the future
6. **Check:** Task card shows a neutral/gray due date badge (or no special color)

---

## 22. Tasks — Filters

1. Click **My Tasks** filter
2. **Check:** Only tasks assigned to Maneek are shown
3. Clear the filter
4. Try filtering by priority (e.g., P0 only)
5. Try filtering by due date

---

## 23. Tasks — List View

1. Switch from Board view to **List view** (if toggle exists)
2. **Check:** Tasks displayed in a table/list format
3. **Check:** Same filters work in list view
4. Switch back to Board view

---

## 24. Dashboard

1. Click **Dashboard** in the sidebar (or press G then D)
2. **Check:** Metric cards: Tasks Today, Overdue, Due This Week, Completion Rate
3. **Check:** "Daily Standup" section visible
4. If standup already generated: summary is shown with rendered markdown
5. If not: click **Generate Now**
6. **Check:** Loading spinner, then summary appears with activity data
7. **Check:** Summary has formatted text (bold, bullets — not raw markdown)

---

## 25. Dashboard — My Insights

1. On the Dashboard page, look for a **My Insights** section
2. **Check:** Shows personal stats: messages sent this week, tasks completed this week
3. **Check:** Shows spaces you were active in
4. **Check:** Shows your expertise areas (topics you discuss most)
5. **Check:** Shows your top collaborators (who you interact with most)

---

## 26. Timezone

1. Check any message timestamp in chat
2. **Check:** Time is displayed in your local timezone (not UTC)
3. Hover over a message timestamp
4. **Check:** Tooltip shows additional timezone info (sender's timezone if different)
5. Check day separator headers
6. **Check:** "Today" and "Yesterday" labels are correct for your local timezone

---

## 27. Agent — Basic Chat

1. Click **Agent** in the sidebar (or press G then A)
2. **Check:** Empty state with "How can I help?" and suggestion chips
3. Click any suggestion chip (e.g., "What tasks are in progress?")
4. **Check:** Your message appears on the right
5. **Check:** Thinking dots (three bouncing dots) appear immediately below your message
6. **Check:** "Searching tasks..." status shows while the agent queries data
7. **Check:** Response streams in word by word
8. **Check:** Citation chips appear (e.g., "DEFT-7: Implement thread side panel")
9. **Check:** Confidence indicator shows below (green "High confidence" if citations exist)
10. **Check:** Follow-up suggestion chips appear
11. **Check:** Token count and model name shown at bottom of response
12. **Check:** Response has formatted text (headers, bold, bullets rendered as markdown — not raw)

---

## 28. Agent — Analytics

1. Ask: **"How is Deft v1 progressing?"**
2. **Check:** Agent calls `get_project_progress` tool. Shows completion %, task counts by status
3. Ask: **"Who has the most work right now?"**
4. **Check:** Agent calls `get_team_workload`. Shows task distribution per person
5. Ask: **"How many tasks did we close this week?"**
6. **Check:** Agent calls `get_workspace_stats`. Returns aggregate metrics

---

## 29. Agent — Actions + Approval

1. Ask: **"Create a task called 'Write unit tests for auth' in Deft v1, P1 priority"**
2. **Check:** Approval card appears with task details (title, project, priority)
3. Click **Approve**
4. **Check:** Card turns green "approved and executed"
5. **Check:** An **Undo** link appears (valid for 5 minutes)
6. Click **Undo**
7. **Check:** Card shows "undone"
8. Navigate to Tasks — the task should NOT be there (it was undone)

---

## 30. Agent — Reject Action

1. Ask: **"Post a message in #random saying 'hello from the agent'"**
2. **Check:** Approval card appears for "Post message"
3. Click **Reject**
4. **Check:** Card shows strikethrough "rejected"
5. Go to #random — no agent message should be there

---

## 31. Agent — Stop Mid-Stream

1. Ask a complex question: **"Give me a detailed summary of all tasks, their statuses, and who's working on what"**
2. While the response is streaming, click the **red stop button**
3. **Check:** Response stops streaming, "(stopped)" text appears
4. **Check:** On next page load, the response does NOT continue from where it stopped

---

## 32. Agent — Memory

1. Ask: **"Remember that I prefer seeing tasks grouped by priority"**
2. **Check:** Agent confirms it stored the preference
3. Start a **new conversation** (click New conversation in sidebar)
4. Ask: **"What do you remember about my preferences?"**
5. **Check:** Agent recalls "prefers tasks grouped by priority" from the previous conversation

---

## 33. Agent — Conversation Management

1. **Check:** Left sidebar shows your conversation history
2. Click on a previous conversation — it loads with full history
3. Delete a conversation (click the X)
4. **Check:** Conversation removed, redirected to empty state

---

## 34. Agent — Formatted Responses

1. Ask: **"List all P0 tasks with their status"**
2. **Check:** Response renders markdown properly: bold text, bullet points, headers
3. **Check:** No raw markdown syntax visible (no `**`, `##`, `-` as literal characters)
4. Ask: **"Show me a summary of recent activity"**
5. **Check:** Response has proper formatting, not plain text

---

## 35. @Deft in Chat

1. Go to **#engineering**
2. In the composer, type **@**
3. **Check:** Autocomplete dropdown appears showing "Deft" with an AI/bot badge
4. Select it (or type @Deft manually)
5. Complete the message: **"@Deft what tasks are overdue?"**
6. Send it
7. **Check:** Your message appears instantly
8. Wait 5-15 seconds (background job processes)
9. **Check:** A threaded reply appears from "Deft" with the answer
10. **Check:** Thread indicator shows on your original message ("1 reply")
11. Click the thread indicator
12. **Check:** Thread panel auto-opens showing the agent's reply

---

## 36. Task References in Chat

1. In **#engineering**, send: **"Let's discuss DEFT-7 and DEFT-10"**
2. **Check:** Message sends normally
3. Wait a few seconds for the background job
4. Open task DEFT-7 detail panel in Tasks
5. **Check:** A comment appears: "Discussed in #engineering: Let's discuss DEFT-7..."

---

## 37. Keyboard Shortcuts

1. Press **?** — shortcuts help panel opens. Close it.
2. Press **G** then **D** — navigates to Dashboard
3. Press **G** then **C** — navigates to Chat
4. Press **G** then **T** — navigates to Tasks
5. Press **G** then **A** — navigates to Agent
6. Press **G** then **S** — navigates to Settings
7. Go to Chat. Press **Shift+Esc** — all unread badges should clear
8. Go to a channel with unreads. Press **Cmd+Shift+M** — that channel's unread badge clears
9. Press **Cmd+K** — command palette opens. Search for a task. Click it.
10. In the chat composer (empty), press **Up arrow** — enters edit mode on your last message

---

## 38. Search (Cmd+K)

1. Press **Cmd+K** to open the command palette
2. Type "auth" — should find tasks and messages mentioning auth
3. **Check:** Task results show formatted status ("In Review" not "in_review")
4. Click a task result from a different project than currently selected
5. **Check:** You navigate to the correct project and the task detail opens

---

## 39. Settings

1. Go to **Settings** (gear icon or G then S)
2. **Members tab:** All 5 members visible with roles (Maneek=owner, rest=member)
3. **Agent tab:**
   - Action log shows any actions you approved/rejected
   - **Trust level selector:** Three options (Conservative/Standard/Autonomous). Click one to change.
   - No stale "pending" entries older than 1 hour
4. **Integrations tab:** Shows Google Calendar, GitHub, Slack, Gmail (all "Coming soon" unless configured)

---

## 40. Light Mode

1. Click the **sun/moon icon** in sidebar to switch to light mode
2. **Check:** All surfaces switch to light backgrounds
3. **Check:** No black-on-black or white-on-white text anywhere
4. **Check:** Pinned messages bar, dropdowns, modals all have proper light backgrounds
5. Navigate through Dashboard, Chat, Tasks, Agent, Settings
6. **Check:** Everything is readable in light mode
7. Switch back to dark mode

---

## 41. Queue Health

1. Open browser console, run:
   ```javascript
   fetch('http://localhost:3001/health/queue', {
     headers: { Authorization: 'Bearer ' + localStorage.getItem('cairn-access-token') }
   }).then(r => r.json()).then(console.log)
   ```
2. **Check:** Returns `{ pending: N, running: N, failed: N, completed: N }`

---

## 42. Audit Trail

1. After performing agent actions (approve/reject/undo), open browser console:
   ```javascript
   fetch('http://localhost:3001/api/audit?limit=10', {
     headers: { Authorization: 'Bearer ' + localStorage.getItem('cairn-access-token') }
   }).then(r => r.json()).then(console.log)
   ```
2. **Check:** Entries with actor_type, action, entity_type, before_state, after_state

---

## 43. Multi-User Test

1. Open an **incognito/private window**
2. Login as **rahul@test.com / test1234**
3. Go to #engineering, send a message: "Hey team, quick update on the API"
4. Switch to Maneek's window (normal browser)
5. **Check:** #engineering shows an unread badge (incremented by 1)
6. Open #engineering
7. **Check:** Rahul's message appears
8. **Check:** Notification bell badge incremented
9. Click the bell — notification shows "Rahul in #engineering"

---

## 44. Edge Cases

1. **Long message:** Paste a 1000+ character message. Send it. Check it renders fully.
2. **Rapid messages:** Send 5 messages quickly one after another. Check all 5 arrive in order.
3. **Empty states:** Create a new channel, verify it shows an empty state (not a blank page).
4. **Page refresh:** Refresh any page — state should persist (theme, sidebar collapse, current channel).

---

## Test Results Template

Copy this and fill in as you test:

```
Test  1 (Login):              [ PASS / FAIL ] Notes: ___
Test  2 (Sidebar):            [ PASS / FAIL ] Notes: ___
Test  3 (Chat Basic):         [ PASS / FAIL ] Notes: ___
Test  4 (Unread Divider):     [ PASS / FAIL ] Notes: ___
Test  5 (Hover Toolbar):      [ PASS / FAIL ] Notes: ___
Test  6 (Bookmarks):          [ PASS / FAIL ] Notes: ___
Test  7 (Threads):            [ PASS / FAIL ] Notes: ___
Test  8 (Notifications):      [ PASS / FAIL ] Notes: ___
Test  9 (More Actions):       [ PASS / FAIL ] Notes: ___
Test 10 (Task from Chat):     [ PASS / FAIL ] Notes: ___
Test 11 (Catch Up):           [ PASS / FAIL ] Notes: ___
Test 12 (DND):                [ PASS / FAIL ] Notes: ___
Test 13 (Channel Rename):     [ PASS / FAIL ] Notes: ___
Test 14 (Task Board):         [ PASS / FAIL ] Notes: ___
Test 15 (Drag & Drop):        [ PASS / FAIL ] Notes: ___
Test 16 (Create Task):        [ PASS / FAIL ] Notes: ___
Test 17 (Task Detail):        [ PASS / FAIL ] Notes: ___
Test 18 (Subtasks):           [ PASS / FAIL ] Notes: ___
Test 19 (Dependencies):       [ PASS / FAIL ] Notes: ___
Test 20 (Bulk Operations):    [ PASS / FAIL ] Notes: ___
Test 21 (Due Date Badges):    [ PASS / FAIL ] Notes: ___
Test 22 (Task Filters):       [ PASS / FAIL ] Notes: ___
Test 23 (List View):          [ PASS / FAIL ] Notes: ___
Test 24 (Dashboard):          [ PASS / FAIL ] Notes: ___
Test 25 (My Insights):        [ PASS / FAIL ] Notes: ___
Test 26 (Timezone):           [ PASS / FAIL ] Notes: ___
Test 27 (Agent Basic):        [ PASS / FAIL ] Notes: ___
Test 28 (Agent Analytics):    [ PASS / FAIL ] Notes: ___
Test 29 (Agent Approve):      [ PASS / FAIL ] Notes: ___
Test 30 (Agent Reject):       [ PASS / FAIL ] Notes: ___
Test 31 (Agent Stop):         [ PASS / FAIL ] Notes: ___
Test 32 (Agent Memory):       [ PASS / FAIL ] Notes: ___
Test 33 (Agent Convos):       [ PASS / FAIL ] Notes: ___
Test 34 (Formatted Responses):[ PASS / FAIL ] Notes: ___
Test 35 (@Deft Chat):         [ PASS / FAIL ] Notes: ___
Test 36 (Task Refs):          [ PASS / FAIL ] Notes: ___
Test 37 (Shortcuts):          [ PASS / FAIL ] Notes: ___
Test 38 (Search):             [ PASS / FAIL ] Notes: ___
Test 39 (Settings):           [ PASS / FAIL ] Notes: ___
Test 40 (Light Mode):         [ PASS / FAIL ] Notes: ___
Test 41 (Queue Health):       [ PASS / FAIL ] Notes: ___
Test 42 (Audit Trail):        [ PASS / FAIL ] Notes: ___
Test 43 (Multi-User):         [ PASS / FAIL ] Notes: ___
Test 44 (Edge Cases):         [ PASS / FAIL ] Notes: ___
```
