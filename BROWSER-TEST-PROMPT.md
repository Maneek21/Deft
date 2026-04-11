# Deft — Browser QA Test Prompt

Use this prompt with Claude in a browser-enabled environment (Claude with computer use, or any AI agent with browser access). The agent should navigate the app like a human tester — clicking, typing, scrolling, and verifying visual output.

**App URL:** http://localhost:3000
**API URL:** http://localhost:3001
**Login:** maneek@test.com / test1234
**Secondary login (for multi-user tests):** rahul@test.com / test1234

---

## Instructions for the testing agent

You are a QA tester. Navigate Deft at http://localhost:3000 in Chrome. For each test:
1. Perform the exact steps described
2. Report what you SEE on screen (not what you expect)
3. If something doesn't match the expected result, describe the actual behavior precisely
4. Take a screenshot after each test if possible
5. Rate each test: PASS / FAIL / PARTIAL
6. If FAIL: describe the bug, what you expected, what you saw

Do NOT use the browser console or network tab unless a test specifically asks for it. Test as a normal user would.

---

## TEST 1: Login

1. Navigate to http://localhost:3000
2. You should be redirected to /login
3. Verify: there is a "Deft AI" logo or heading, an email field, a password field, and a Login button
4. Enter email: maneek@test.com
5. Enter password: test1234
6. Click Login
7. Verify: you are redirected to the main app (likely /chat or /dashboard)
8. Verify: a sidebar is visible on the left with channel names

**Expected:** Successful login, main app loads with sidebar showing channels like #general, #engineering, #design, #random and DM conversations.

---

## TEST 2: Sidebar Navigation

1. Verify the sidebar shows these sections: a navigation area (Dashboard, Chat, Tasks, Agent icons or labels), a "Spaces" section with channels, a "Direct Messages" section with team members
2. Verify at least one channel shows an unread count badge (a number like "6" or "12", not just a dot)
3. Click on "Dashboard" in the navigation
4. Verify: the main content area changes to show the Dashboard
5. Click on "Tasks" in the navigation
6. Verify: a Kanban board or task list appears
7. Click on "Agent" in the navigation
8. Verify: an agent chat interface appears with "How can I help?" or similar empty state
9. Click on "Chat" to return to the chat view

**Expected:** All four main sections (Dashboard, Chat, Tasks, Agent) load without errors. Navigation switches between them smoothly.

---

## TEST 3: Sidebar Bottom Bar

1. Look at the very bottom of the sidebar
2. Verify you see: a user avatar/name area, a bookmark icon, a bell icon (DND), a sun/moon icon (theme toggle), and a three-dot menu
3. Click the sun/moon icon — the theme should toggle between dark and light mode
4. Click it again to go back
5. Click the bell icon — it should change to a crossed-out bell (BellOff) with an amber/orange color
6. Click it again to disable DND
7. Click the three-dot menu — a dropdown should appear with "Settings" and "Log out"
8. Click away to dismiss

**Expected:** All icons are present and functional. Theme toggles visually. DND toggles the bell icon.

---

## TEST 4: Sidebar Collapse

1. Find the collapse button (likely at the top of the sidebar — a panel/arrow icon)
2. Click it — the sidebar should shrink to a narrow icon-only rail (~48px wide)
3. Verify: navigation icons are still visible and clickable
4. Click the expand button — sidebar returns to full width
5. Verify: channel names and DM names are visible again

**Expected:** Sidebar collapses and expands smoothly with a transition animation.

---

## TEST 5: Chat — Reading Messages

1. Click on #engineering in the sidebar
2. Verify: messages load in the main area
3. Scroll through the messages — there should be 50+ messages between Rahul and Arjun about WebSocket reconnection, Drizzle migrations, file uploads, etc.
4. Verify: messages are grouped (same author within a few minutes shows compact layout without repeated avatar)
5. Verify: day separator headers appear (e.g., "SATURDAY, MAR 28")
6. Look for a red "New messages" divider line somewhere in the message list — this separates read from unread messages
7. Look for emoji reactions on some messages (👍, 🔥, 🚀, etc.)
8. Scroll to the very top — verify a pinned message bar appears at the top of the chat

**Expected:** Rich message history with grouping, day separators, reactions, and pinned message bar. The "New messages" divider should be visible if there are unread messages.

---

## TEST 6: Chat — Sending a Message

1. In #engineering, click the message input at the bottom
2. Type: "Hello from the QA test!"
3. Press Enter
4. Verify: your message appears at the bottom of the chat immediately
5. Verify: your message shows on the right side with your avatar/initial

**Expected:** Message sends instantly and appears in the correct position.

---

## TEST 7: Chat — Hover Toolbar

1. Hover your mouse over any message from Rahul or Arjun (not your own)
2. Verify: a floating toolbar appears above/on the message with small icons
3. Count the icons — there should be approximately 6: emoji react, reply, pin, bookmark, create task, more (...)
4. Click the emoji react icon (smiley face) — an emoji picker should open
5. Click any emoji — verify it appears as a reaction below the message
6. Click the reaction again to remove it
7. Press Escape or click away to close

**Expected:** Hover toolbar appears with all action icons. Emoji reactions add and remove correctly.

---

## TEST 8: Chat — Thread Reply

1. Hover over any message, click the Reply icon (speech bubble)
2. Verify: a thread panel opens on the right side of the screen
3. Verify: the original message is shown at the top of the thread
4. Type a reply: "Testing threads" and press Enter
5. Verify: your reply appears in the thread panel
6. Close the thread panel (X button or click away)
7. Verify: the original message now shows "1 reply" or a reply count indicator

**Expected:** Thread panel opens, replies work, reply count updates.

---

## TEST 9: Chat — Message Actions (More Menu)

1. Hover over YOUR OWN message (the one you sent in Test 6)
2. Click the More icon (... three dots)
3. Verify: a dropdown menu appears with options like: Edit, Copy link, Remind me, Delete
4. Click Edit — the message should enter edit mode
5. Change the text to "Hello from the QA test! (edited)" and press Enter
6. Verify: the message updates and shows "(edited)" indicator
7. Hover again, click More → Delete
8. Verify: a confirmation dialog appears ("Delete this message? This can't be undone.")
9. Confirm deletion
10. Verify: the message disappears or shows as deleted

**Expected:** Edit and delete work correctly with proper confirmation.

---

## TEST 10: Chat — Bookmark a Message

1. Hover over any message from Rahul
2. Click the Bookmark icon (flag/ribbon shape between Pin and Create Task)
3. Verify: the icon fills in or changes color (becomes purple/filled)
4. In the sidebar bottom bar, click the Bookmark icon
5. Verify: a "Saved Items" modal opens showing the message you just bookmarked
6. Verify: the saved item shows the author name, channel name (#engineering), date, and message preview
7. Click the X on the saved item to remove it
8. Close the modal

**Expected:** Bookmarking saves the message. Saved Items modal shows it. Removal works.

---

## TEST 11: Chat — Pinned Messages

1. Look at the top of the #engineering chat — there should be a pinned message bar
2. Click on it — a dropdown should expand showing pinned message(s)
3. Verify: pinned messages show author name, date, and content preview
4. Click "Unpin" on one of them
5. Verify: it disappears from the pinned list
6. Close the dropdown

**Expected:** Pinned messages bar works, unpin removes from the list.

---

## TEST 12: Chat — Catch Up Summary

1. In #engineering, find the "Catch Up" button in the channel header bar (usually top area, near the channel name)
2. Click it
3. Verify: a "Reading..." loading state appears briefly
4. Verify: a summary card/banner appears (should be sticky at the top, visible regardless of scroll position)
5. Verify: the summary mentions key topics from the channel (WebSocket reconnection, Drizzle, typing indicators, etc.)
6. Verify: the text is formatted (bold, bullets) — NOT raw markdown with ** and - characters
7. Click X to dismiss the summary

**Expected:** AI-generated summary loads, is well-formatted, and dismisses cleanly.

---

## TEST 13: Chat — @Deft Agent Mention

1. In #engineering, click the message input
2. Type "@" — an autocomplete dropdown should appear
3. Verify: "Deft" appears in the list with a bot/AI badge icon
4. Select it (click or press Enter)
5. Complete the message: "@Deft what tasks are overdue?" and send it
6. Verify: your message appears immediately
7. Wait 5-15 seconds
8. Verify: a threaded reply appears from "Deft" with an answer about overdue tasks
9. Verify: the original message shows a "1 reply" thread indicator

**Expected:** @Deft autocomplete works. Agent replies in-thread within a few seconds.

---

## TEST 14: Notifications

1. Look at the top-right of the page — find the notification bell icon
2. Verify: a red badge with a number appears on/next to the bell
3. Click the bell
4. Verify: a dropdown panel opens with a list of notifications
5. Verify: notifications include types like: "Rahul in #engineering", "Sara assigned you DEFT-8", "Priya mentioned you"
6. Click one notification — verify it navigates to the relevant page (chat channel or task)
7. Go back, click the bell again, click "Mark all read"
8. Verify: the red badge disappears

**Expected:** Notification panel shows diverse notification types. Navigation works. Mark all read clears the badge.

---

## TEST 15: Unread Badges

1. Navigate to a different channel (e.g., #general or #design)
2. Look at the sidebar — channels with unread messages should show number badges (like "6", "12")
3. Click a channel with an unread badge
4. Verify: the badge disappears after entering the channel (messages are now "read")
5. Verify: the channel name was bold when unread, and returns to normal weight after reading

**Expected:** Unread badges show counts, clear when channel is opened, and names change from bold to normal.

---

## TEST 16: Tasks — Board View

1. Click "Tasks" in the sidebar navigation
2. Verify: a Kanban board loads with 5 columns: Backlog, Todo, In Progress, In Review, Done
3. Verify: task cards show task IDs (like DEFT-7), titles, priority badges (P0/P1/P2), and assignee avatars/initials
4. Verify: column headers show task counts
5. Look for a project selector/switcher — switch between "Deft v1" and "Design System"
6. Verify: the board updates with different tasks for each project

**Expected:** Kanban board renders correctly with task cards and project switching works.

---

## TEST 17: Tasks — Drag and Drop

1. On the Tasks board, grab a task card from the "Todo" column
2. Drag it to the "In Progress" column
3. Verify: the card moves immediately (no delay/loading)
4. Refresh the page
5. Verify: the card is still in "In Progress" (the change persisted)
6. Drag it back to "Todo" if you want to reset

**Expected:** Drag and drop moves cards instantly with optimistic update. Persists after refresh.

---

## TEST 18: Tasks — Create New Task

1. Find the "+ New Task" button or press the C key
2. Verify: a creation modal or panel opens
3. Enter title: "QA test task"
4. Leave assignee and due date empty
5. Click Create
6. Verify: the task appears in the Backlog column
7. Verify: NO error occurred (this was previously a bug with null fields)

**Expected:** Task creates successfully even with empty optional fields.

---

## TEST 19: Tasks — Task Detail

1. Click on any task card to open its detail panel
2. Verify: the panel shows: status dropdown, priority, assignee, labels, description, comments tab, activity tab
3. Try changing the status to "Done" via the dropdown
4. Verify: NO CRASH occurs (this was previously a critical bug)
5. Verify: the task moves to the Done column
6. Click the task title to edit it, type something, press Escape
7. Verify: the edit cancels (original title restored), panel stays open (does not close)
8. Close the panel

**Expected:** Task detail panel works. Status change doesn't crash. Escape cancels edit without closing panel.

---

## TEST 20: Dashboard

1. Click "Dashboard" in the sidebar
2. Verify: metric cards appear (Tasks Today, Overdue, Due This Week, Completion Rate, or similar)
3. Look for a "Daily Standup" section — it should show an AI-generated summary OR a "Generate Now" button
4. If "Generate Now" is visible, click it — verify a summary generates
5. Verify: the summary text is formatted (not raw markdown)
6. If you are logged in as an admin/owner (maneek is owner): verify a "Team Health" section appears with team member cards showing status indicators (green/yellow/red dots)
7. Look for "My Insights" section — should show your activity stats, expertise areas, top collaborators

**Expected:** Dashboard loads with metrics, standup, and (for managers) team health section.

---

## TEST 21: Dashboard — Manager Features

1. On the Dashboard, find the Team Health row (only visible for maneek as org owner)
2. Verify: horizontal row of team member cards with avatar, name, colored status dot, and one-line insight
3. Look for Action Items below the health row — numbered list of recommended actions
4. Look for 1:1 Prep Cards — if you generated a prep in previous tests, it should appear
5. Click "View Prep" on a prep card — verify a modal opens with structured prep content

**Expected:** Manager-specific sections render with team health data and prep cards.

---

## TEST 22: Agent — Basic Conversation

1. Click "Agent" in the sidebar
2. Verify: empty state with "How can I help?" heading and suggestion chips
3. Click any suggestion chip (e.g., "What tasks are in progress?")
4. Verify: your message appears on the right side
5. Verify: thinking dots (three bouncing dots) appear immediately BELOW your message
6. Wait for the response to stream in
7. Verify: "Searching tasks..." or similar tool status appears briefly
8. Verify: the response streams in word by word
9. Verify: citation chips appear below the response (e.g., "DEFT-7: Implement thread side panel")
10. Verify: a confidence indicator shows (green "High confidence" or similar)
11. Verify: follow-up suggestion chips appear below
12. Verify: token count and model name shown at the bottom of the response (e.g., "sonnet · 4934 tokens")

**Expected:** Full agent interaction flow works — thinking dots, tool status, streaming, citations, metadata.

---

## TEST 23: Agent — Manager Questions

1. In the agent, send: "How is Deft v1 progressing?"
2. Verify: agent calls get_project_progress tool (shown as "Searching..." status)
3. Verify: response includes completion %, task breakdown by status
4. Send: "Who has the most work right now?"
5. Verify: agent calls get_workload_balance, shows per-person task distribution
6. Send: "How is the team doing?"
7. Verify: agent calls get_team_health, shows per-person health status with green/yellow/red indicators
8. Send: "Who's the expert on API design?"
9. Verify: agent calls find_expert, returns ranked list

**Expected:** All manager-specific agent tools work and return meaningful data.

---

## TEST 24: Agent — Actions + Approval

1. Send: "Create a task called 'Write unit tests for auth' in Deft v1, priority P1"
2. Verify: an approval card appears with task details (title, project, priority)
3. Verify: the card has "Approve" and "Reject" buttons
4. Click "Approve"
5. Verify: card turns green with "approved and executed" text
6. Verify: an "Undo" link appears
7. Click "Undo"
8. Verify: card shows "undone"
9. Navigate to Tasks — the task should NOT be there

**Expected:** Full approval → execute → undo flow works.

---

## TEST 25: Agent — Stop Button

1. Send a complex question: "Give me a detailed analysis of all tasks, who's working on what, and what's behind schedule"
2. While the response is streaming, click the red Stop button (square icon)
3. Verify: streaming stops, "(stopped)" text appears
4. Verify: the input re-enables so you can send another message

**Expected:** Stop button halts the response and re-enables input.

---

## TEST 26: Agent — Memory

1. Send: "Remember that I prefer seeing tasks sorted by priority"
2. Verify: agent confirms it stored the preference
3. Click "New conversation" in the sidebar (or navigate to /agent)
4. In the new conversation, send: "What do you remember about my preferences?"
5. Verify: agent recalls the preference about priority sorting from the previous conversation

**Expected:** Memory persists across conversations.

---

## TEST 27: Settings

1. Navigate to Settings (gear icon, or sidebar bottom → More → Settings, or press G then S)
2. Verify: Settings page loads with tabs or sections
3. Find "Members" — verify all 5 team members are listed (Maneek, Rahul, Priya, Arjun, Sara) with roles
4. Find "Agent" section — verify:
   - Trust level selector (Conservative / Standard / Autonomous)
   - Action log showing any approved/rejected actions
5. Find "Integrations" — verify Google Calendar, GitHub, Slack, Gmail entries appear

**Expected:** Settings page loads with all sections functional.

---

## TEST 28: Search (Cmd+K)

1. Press Cmd+K (or Ctrl+K on Windows)
2. Verify: a command palette / search modal opens
3. Type "auth" — results should include tasks and/or messages mentioning auth
4. Verify: task results show formatted status ("In Review" not "in_review")
5. Click a task result — verify it navigates to the task and opens its detail panel
6. Press Cmd+K again, type "Rahul" — results should include the user
7. Press Escape to close

**Expected:** Search works across tasks and messages. Status values are formatted. Navigation works.

---

## TEST 29: Keyboard Shortcuts

1. Press "?" key (not in an input field) — a shortcuts reference panel should open
2. Verify: it lists available shortcuts
3. Close it (Escape or X)
4. Press G then D — should navigate to Dashboard
5. Press G then C — should navigate to Chat
6. Press G then T — should navigate to Tasks
7. Press G then A — should navigate to Agent
8. Navigate to Chat. Press Shift+Esc — all unread badges should clear from the sidebar

**Expected:** Keyboard shortcuts reference opens. G→key navigation works. Shift+Esc clears unreads.

---

## TEST 30: Light Mode

1. Click the sun/moon icon in the sidebar bottom bar to switch to light mode
2. Navigate through ALL four main sections: Dashboard, Chat, Tasks, Agent
3. For each, verify:
   - No black-on-black or white-on-white text
   - All dropdowns, modals, and overlays have visible backgrounds
   - Pinned messages bar has a proper light background
   - Task cards are readable
   - Agent messages are readable
4. Switch back to dark mode

**Expected:** Light mode is fully functional across all pages with no visual issues.

---

## TEST 31: Multi-User Test

1. Open an incognito/private window
2. Navigate to http://localhost:3000
3. Login as rahul@test.com / test1234
4. Go to #engineering, send: "Hey team, quick update from Rahul"
5. Switch back to the main browser window (maneek's session)
6. Check: does #engineering show an updated unread badge?
7. Open #engineering — verify Rahul's message appears
8. Check the notification bell — it should show an incremented count
9. Click the bell — verify a notification like "Rahul in #engineering" exists

**Expected:** Real-time cross-user messaging works. Unread counts and notifications update.

---

## TEST 32: Responsive / Edge Cases

1. Send a very long message (paste 500+ characters of text) — verify it renders fully without overflow
2. Send 3 messages rapidly one after another — verify all 3 appear in order
3. Refresh the page — verify: current channel reloads, sidebar state preserved, theme preserved
4. Navigate to a channel with no messages (create a new channel if possible) — verify an empty state shows, not a blank screen

**Expected:** Edge cases handled gracefully.

---

## RESULTS TEMPLATE

After completing all tests, fill in this summary:

```
TEST  1 (Login):              [ PASS / FAIL / PARTIAL ]
TEST  2 (Sidebar Nav):        [ PASS / FAIL / PARTIAL ]
TEST  3 (Bottom Bar):         [ PASS / FAIL / PARTIAL ]
TEST  4 (Sidebar Collapse):   [ PASS / FAIL / PARTIAL ]
TEST  5 (Chat Reading):       [ PASS / FAIL / PARTIAL ]
TEST  6 (Chat Sending):       [ PASS / FAIL / PARTIAL ]
TEST  7 (Hover Toolbar):      [ PASS / FAIL / PARTIAL ]
TEST  8 (Threads):            [ PASS / FAIL / PARTIAL ]
TEST  9 (Message Actions):    [ PASS / FAIL / PARTIAL ]
TEST 10 (Bookmarks):          [ PASS / FAIL / PARTIAL ]
TEST 11 (Pinned Messages):    [ PASS / FAIL / PARTIAL ]
TEST 12 (Catch Up):           [ PASS / FAIL / PARTIAL ]
TEST 13 (@Deft Mention):      [ PASS / FAIL / PARTIAL ]
TEST 14 (Notifications):      [ PASS / FAIL / PARTIAL ]
TEST 15 (Unread Badges):      [ PASS / FAIL / PARTIAL ]
TEST 16 (Tasks Board):        [ PASS / FAIL / PARTIAL ]
TEST 17 (Drag & Drop):        [ PASS / FAIL / PARTIAL ]
TEST 18 (Create Task):        [ PASS / FAIL / PARTIAL ]
TEST 19 (Task Detail):        [ PASS / FAIL / PARTIAL ]
TEST 20 (Dashboard):          [ PASS / FAIL / PARTIAL ]
TEST 21 (Manager Dashboard):  [ PASS / FAIL / PARTIAL ]
TEST 22 (Agent Basic):        [ PASS / FAIL / PARTIAL ]
TEST 23 (Agent Manager):      [ PASS / FAIL / PARTIAL ]
TEST 24 (Agent Approval):     [ PASS / FAIL / PARTIAL ]
TEST 25 (Agent Stop):         [ PASS / FAIL / PARTIAL ]
TEST 26 (Agent Memory):       [ PASS / FAIL / PARTIAL ]
TEST 27 (Settings):           [ PASS / FAIL / PARTIAL ]
TEST 28 (Search):             [ PASS / FAIL / PARTIAL ]
TEST 29 (Shortcuts):          [ PASS / FAIL / PARTIAL ]
TEST 30 (Light Mode):         [ PASS / FAIL / PARTIAL ]
TEST 31 (Multi-User):         [ PASS / FAIL / PARTIAL ]
TEST 32 (Edge Cases):         [ PASS / FAIL / PARTIAL ]

TOTAL PASS:    __/32
TOTAL FAIL:    __/32
TOTAL PARTIAL: __/32

CRITICAL BUGS FOUND:
1. ...
2. ...

HIGH SEVERITY BUGS:
1. ...
2. ...

MEDIUM SEVERITY BUGS:
1. ...
2. ...
```
