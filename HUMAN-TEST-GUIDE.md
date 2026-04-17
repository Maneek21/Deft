# Deft — Human Testing Guide

Comprehensive manual testing checklist for the entire platform. Work through each section top to bottom. Mark items with [x] as you complete them.

---

## Prerequisites

Before testing, ensure:
- [ ] PostgreSQL running on port 5432 with database created
- [ ] Redis running on port 6379
- [ ] `.env` file configured (copy from `.env.example`)
- [ ] `pnpm install` completed
- [ ] `pnpm db:push` run to apply schema
- [ ] `pnpm dev` running (web on 3000, API on 3001)

---

## 1. Authentication

### 1.1 Signup
- [ ] Navigate to `/signup`
- [ ] Try submitting with empty fields — validation errors should appear
- [ ] Try a password shorter than 8 characters — should be rejected
- [ ] Create a new account with valid name, email, password, org name
- [ ] Verify redirect to `/chat` or `/setup` after successful signup
- [ ] Verify `#general` space was auto-created
- [ ] Verify user is set as `owner` role

### 1.2 Login
- [ ] Navigate to `/login`
- [ ] Try wrong password — should show "Invalid credentials"
- [ ] Try non-existent email — should show "Invalid credentials" (no email enumeration)
- [ ] Login with correct credentials
- [ ] Verify redirect to `/chat`
- [ ] Refresh the page — should stay logged in (token persisted)

### 1.3 Google OAuth
- [ ] Google login button is clickable (not disabled/grayed out)
- [ ] Clicking it redirects to Google consent screen (requires GOOGLE_CLIENT_ID configured)
- [ ] After Google auth, redirects back to `/login` with tokens in URL
- [ ] Tokens are stored and user is redirected to `/chat`
- [ ] If Google OAuth is not configured, endpoint returns 503

### 1.4 Password Reset
- [ ] Click "Forgot?" link on login page — navigates to `/forgot-password`
- [ ] Submit with valid email — shows "Check your email" success message
- [ ] Submit with non-existent email — should STILL show success (no email enumeration)
- [ ] Check console/email for reset link
- [ ] Click reset link — navigates to `/reset-password?token=...`
- [ ] Try mismatched passwords — shows error
- [ ] Try password < 8 chars — shows error
- [ ] Submit valid new password — shows success
- [ ] Login with new password — works
- [ ] Try the same reset link again — should fail (token expired or already used)

### 1.5 Session Management
- [ ] After 15+ minutes of inactivity, token refresh should happen silently
- [ ] If refresh token is expired, user sees "Session expired" and is redirected to `/login`
- [ ] After re-login, user returns to the page they were on (path preserved in sessionStorage)

### 1.6 Onboarding / Setup
- [ ] New user sees `/setup` onboarding wizard
- [ ] Step 1: Welcome message displayed
- [ ] Step 2: Can invite team members by email (or skip)
- [ ] Step 3: Can create spaces (or skip with defaults)
- [ ] Step 4: Can create first project (or skip)
- [ ] Step 5: Meet Deft intro
- [ ] Can skip any step
- [ ] Completing setup marks onboarding as done

---

## 2. Chat / Messaging

### 2.1 Spaces
- [ ] Sidebar shows list of spaces with unread counts
- [ ] Click a space — messages load in main panel
- [ ] Create a new public space via "+" button
- [ ] Create a new private space
- [ ] Create a DM with another user
- [ ] Space name, description, and topic display correctly
- [ ] Mute a space — mute icon appears, no more notification badges
- [ ] Archive/delete a space (admin only) — space disappears from sidebar
- [ ] Default `#general` space cannot be deleted

### 2.2 Messages
- [ ] Send a text message — appears in real-time
- [ ] Send a message with **bold**, *italic*, `code`, and links
- [ ] Links auto-unfurl with preview (title, description, image)
- [ ] Edit a message — "(edited)" indicator appears
- [ ] Delete a message — message removed from view
- [ ] Long messages display correctly (no overflow)
- [ ] Empty message cannot be sent

### 2.3 Threads
- [ ] Click "Reply in thread" on a message — thread panel opens on the right
- [ ] Post a reply in the thread
- [ ] Thread reply count shows on the parent message ("X replies")
- [ ] Thread unread state works (bold indicator on unread threads)
- [ ] Close thread panel — returns to main view

### 2.4 Reactions
- [ ] Add an emoji reaction to a message
- [ ] Same user reacting again with same emoji removes it
- [ ] Multiple users reacting shows count
- [ ] Clicking reaction count shows who reacted
- [ ] Add multiple different reactions to one message

### 2.5 Mentions
- [ ] Type `@` — autocomplete dropdown appears with user list
- [ ] Select a user — mention is inserted as formatted text
- [ ] Mentioned user receives a notification
- [ ] `@here` and `@all` mentions work
- [ ] Mention a group handle (e.g., `@engineering`) — all group members notified

### 2.6 File Attachments
- [ ] Upload a file in chat (image, PDF, etc.)
- [ ] Image files display as inline thumbnails
- [ ] Non-image files display as download links
- [ ] Click image — opens in lightbox
- [ ] Large files (>50MB) are rejected with error

### 2.7 Pinned Messages
- [ ] Pin a message — appears in pinned messages panel
- [ ] Unpin a message — removed from panel
- [ ] Pinned messages panel accessible via header icon

### 2.8 Bookmarked Messages
- [ ] Bookmark a message — appears in saved messages
- [ ] Remove bookmark
- [ ] Bookmarks are personal (other users don't see them)

### 2.9 Search
- [ ] Use global search (Cmd+K) to search messages
- [ ] Filter by author, space, date range
- [ ] Results show message preview with highlighted match

### 2.10 Typing Indicators
- [ ] When another user types, "X is typing..." appears
- [ ] Multiple users typing shows "X, Y are typing..."
- [ ] Typing indicator disappears after 2-3 seconds of inactivity

### 2.11 Real-time Updates
- [ ] Open same space in two browser tabs
- [ ] Send message in one tab — appears instantly in the other
- [ ] Edit a message — update reflected in both tabs
- [ ] Reactions update in real-time across tabs

### 2.12 Presence
- [ ] Online users show green dot in sidebar
- [ ] Idle users (5 min inactive) show yellow dot
- [ ] Offline users show gray dot
- [ ] Closing browser tab updates presence for other users

### 2.13 Scheduled Messages
- [ ] Schedule a message for a future time
- [ ] Verify it appears in scheduled messages panel
- [ ] Cancel a scheduled message
- [ ] At the scheduled time, message is auto-sent

---

## 3. Tasks

### 3.1 Project Management
- [ ] Create a new project with name, prefix, and color
- [ ] Project appears in the task page sidebar/dropdown
- [ ] Project shows task count and progress

### 3.2 Task Creation
- [ ] Quick create a task (keyboard shortcut `c` or "+" button)
- [ ] Set title, description, status, priority, assignee, due date
- [ ] Task appears in the correct board column
- [ ] Task ID auto-increments (e.g., PROJ-1, PROJ-2)

### 3.3 Task Board (Kanban)
- [ ] Board shows columns: Backlog, To Do, In Progress, In Review, Done
- [ ] Drag a task from one column to another — status updates
- [ ] Task count per column updates
- [ ] Cards show: title, priority badge, assignee avatar, due date, subtask count, label pills

### 3.4 Task List View
- [ ] Toggle to list view
- [ ] Sort by clicking column headers (title, status, priority, assignee, due date)
- [ ] Inline status dropdown works per row
- [ ] Click a task row — opens detail panel

### 3.5 Task Detail
- [ ] Title editable (click to edit)
- [ ] Description editor (TipTap) renders and saves
- [ ] Status dropdown works
- [ ] Priority selector works (P0-P3 with colors)
- [ ] Assignee picker works
- [ ] Due date picker works
- [ ] Overdue indicator shows red for past-due tasks
- [ ] Labels can be added/removed (tag picker)
- [ ] New labels can be created inline
- [ ] Parent task / subtasks display correctly
- [ ] Add a subtask — appears nested under parent
- [ ] Toggle subtask completion

### 3.6 Task Comments & Activity
- [ ] Post a comment on a task
- [ ] Activity tab shows status changes, assignment changes, priority changes
- [ ] Comments show author and timestamp

### 3.7 Task Dependencies
- [ ] Add a "blocks" dependency between tasks
- [ ] Add a "relates to" dependency
- [ ] Search for tasks to link (autocomplete)
- [ ] Remove a dependency
- [ ] Dependencies display in the detail panel

### 3.8 Task Attachments
- [ ] Upload a file to a task
- [ ] Attachment appears in the attachments section
- [ ] Click to download

### 3.9 Task References / Backlinks
- [ ] If a task is mentioned in chat (e.g., PROJ-5), it shows in the "References" section
- [ ] Clicking a reference navigates to the source message

### 3.10 Filters
- [ ] Filter by assignee (multi-select dropdown)
- [ ] Filter by priority (multi-select)
- [ ] Filter by project
- [ ] Filter by due date (presets: overdue, today, this week)
- [ ] Filter by custom date range (from/to inputs)
- [ ] Active filter pills appear with X to remove
- [ ] "Clear all" removes all filters

### 3.11 Saved Views
- [ ] Apply some filters
- [ ] Click "Save view" in the Views dropdown
- [ ] Enter a name and save
- [ ] Clear filters, then load the saved view — filters restored
- [ ] Delete a saved view

### 3.12 Bulk Operations
- [ ] Enable selection mode (checkbox icon)
- [ ] Select multiple tasks
- [ ] Bulk change status — all selected tasks update
- [ ] Bulk assign — all selected tasks get new assignee
- [ ] Bulk delete — confirmation shown, tasks removed

### 3.13 My Tasks View
- [ ] Switch to "My Tasks" view
- [ ] Shows only tasks assigned to current user across all projects
- [ ] Tasks grouped by project

### 3.14 Task Duplication
- [ ] Duplicate a task from the card menu
- [ ] New task created with "(copy)" suffix
- [ ] Labels carried over

### 3.15 Task Notifications
- [ ] Assign a task to another user — they get a notification
- [ ] Change task status — assignee notified
- [ ] Comment on a task — assignee notified

---

## 4. Calendar

### 4.1 Views
- [ ] Month view shows events on correct dates
- [ ] Week view shows events in time slots
- [ ] Day view shows detailed time blocks
- [ ] Navigate forward/backward with arrows
- [ ] "Today" button returns to current date

### 4.2 Event Creation
- [ ] Click a time slot — create event modal opens with pre-filled date/time
- [ ] Enter title, date, start/end time, location, description
- [ ] Add attendees via member search picker
- [ ] Create event — appears on calendar
- [ ] Create all-day event

### 4.3 Event Detail
- [ ] Click an event — detail modal opens
- [ ] Shows title, time, location, description, attendees
- [ ] Delete event — removed from calendar

### 4.4 Google Calendar Sync
- [ ] Connect Google Calendar from Settings > Integrations
- [ ] Click "Sync" on calendar page — events pulled from Google
- [ ] Synced events appear with Google Calendar badge
- [ ] Events show attendees, hangout links from Google
- [ ] Disconnect Google Calendar — synced events remain (read-only)

### 4.5 Meeting Briefs
- [ ] For upcoming meetings (next 15 min), an AI-generated brief appears
- [ ] Brief includes context from recent messages, relevant tasks, attendee workload
- [ ] Brief appears via real-time socket event

### 4.6 Dashboard Calendar Widget
- [ ] Dashboard shows today's upcoming events
- [ ] Events display correctly in the mini widget

---

## 5. Knowledge Wiki

### 5.1 Wiki List View
- [ ] Navigate to Knowledge page — shows "Knowledge Wiki" header
- [ ] Search box filters pages by title/content
- [ ] Type filter tabs: All, Concepts, Entities, Decisions, Resources, Procedures, Preferences, Facts
- [ ] Each card shows: icon, title, type badge, summary, confidence bar, link count, last updated
- [ ] Pagination works (prev/next buttons, page indicator)

### 5.2 Wiki Page Detail
- [ ] Click a page card — detail view opens
- [ ] Shows: type badge, version number, confidence bar with percentage
- [ ] Full markdown content displayed
- [ ] "Linked Pages" section shows outbound links (clickable)
- [ ] "Referenced By" section shows backlinks (clickable)
- [ ] "Sources" section shows citations with excerpts and timestamps
- [ ] "Back to Knowledge" button returns to list

### 5.3 Wiki Page Navigation
- [ ] Click a linked page — navigates to that page's detail view
- [ ] Click a backlink — navigates to that page
- [ ] Can navigate deep (page A -> page B -> page C)
- [ ] Back button works at every level

### 5.4 Confidence Indicators
- [ ] Green bar for confidence > 70%
- [ ] Yellow bar for 50-70%
- [ ] Red bar for < 50%
- [ ] Percentage number matches bar fill

### 5.5 Auto-Ingest from Chat
- [ ] Send a message with a clear fact (e.g., "We decided to use Postgres for the new service")
- [ ] Wait a few seconds for the classifier + memory-extract pipeline
- [ ] Check Knowledge Wiki — new page should appear with the fact
- [ ] Page should have a citation linking back to the source message
- [ ] Send another related fact — existing page should be updated (not a duplicate)

### 5.6 Wiki Search
- [ ] Search for a keyword — matching pages appear
- [ ] Search with no results — empty state shown
- [ ] Search combined with type filter works

### 5.7 Empty State
- [ ] New org with no wiki pages — empty state message shown
- [ ] Message explains knowledge is auto-captured from conversations

---

## 6. AI Agent

### 6.1 Agent Chat
- [ ] Navigate to Agent page
- [ ] See greeting and suggested prompts
- [ ] Click a suggested prompt — sends it as a message
- [ ] Type a custom question and send
- [ ] Agent responds with streaming text
- [ ] Response includes markdown formatting (headers, lists, bold)

### 6.2 Agent Tool Use
- [ ] Ask "What tasks are in progress?" — agent uses search_tasks tool
- [ ] Ask "What did we decide about X?" — agent uses wiki_search tool
- [ ] Ask about a specific wiki page — agent uses wiki_read tool
- [ ] Agent responses include citations (source badges)

### 6.3 Agent Actions (Approval Flow)
- [ ] Ask agent to create a task — approval card appears
- [ ] Approve the action — task is created
- [ ] Ask agent to create another task — reject it — task is NOT created
- [ ] Undo a recently approved action (within 5 min window)

### 6.4 Agent Wiki Integration
- [ ] Ask "What do we know about [topic]?" — agent auto-loads relevant wiki context
- [ ] Agent's system prompt includes "Relevant knowledge:" section
- [ ] Agent references wiki pages in its response

### 6.5 @agent in Chat
- [ ] In a chat space, type `@agent` or `@deft` followed by a question
- [ ] Agent reply appears as a message in the thread
- [ ] Agent reply includes citations if tools were used

### 6.6 Conversation Management
- [ ] Multiple conversations listed in sidebar
- [ ] Switch between conversations — history preserved
- [ ] Delete a conversation — removed from list
- [ ] Start a new conversation

### 6.7 Agent Settings
- [ ] Navigate to Settings > Agent
- [ ] Change trust level to Conservative — all actions require approval
- [ ] Change to Standard — routine actions auto-execute
- [ ] Change to Autonomous — most actions auto-execute
- [ ] Action log shows history of all agent actions with status

---

## 7. Notes

### 7.1 Note Creation
- [ ] Click "New note" — blank note appears
- [ ] Title auto-focuses
- [ ] Type a title — auto-saves after 500ms

### 7.2 Rich Text Editor
- [ ] Bold text (Ctrl+B)
- [ ] Italic text (Ctrl+I)
- [ ] Strikethrough
- [ ] Code inline
- [ ] Headings (H1, H2)
- [ ] Bullet list
- [ ] Numbered list
- [ ] Blockquote
- [ ] Divider
- [ ] Links (clickable)

### 7.3 Note Management
- [ ] Auto-save indicator shows "Saving..." then "Saved"
- [ ] Pin a note — moves to top of list
- [ ] Unpin a note — returns to normal position
- [ ] Change note icon via emoji picker
- [ ] Delete a note — removed from list
- [ ] Search notes by title/content

### 7.4 Note Display
- [ ] Grid layout (3 columns on desktop)
- [ ] Pinned section at top, recent below
- [ ] Cards show: icon, title, preview (first 120 chars), last updated

---

## 8. Dashboard

### 8.1 Overview Cards
- [ ] "Due today" shows correct task count
- [ ] "Due this week" shows correct count
- [ ] "Overdue" shows correct count with red indicator
- [ ] "In progress" shows correct count
- [ ] Clicking a card navigates to filtered task view

### 8.2 Unread Spaces
- [ ] Shows spaces with unread messages
- [ ] Shows last message preview with author
- [ ] Clicking navigates to that space

### 8.3 Recent Activity
- [ ] Shows task status changes, assignments, comments
- [ ] Formatted as "[User] moved [Task] to [Status]"
- [ ] Timestamps are relative ("2 hours ago")

### 8.4 Project Overview
- [ ] Shows all projects with progress bar (done/total ratio)
- [ ] Assigned task count per project

### 8.5 Calendar Widget
- [ ] Shows today's upcoming events
- [ ] Events display with time and title

### 8.6 My Insights (Personal Analytics)
- [ ] Activity summary (messages sent, tasks completed)
- [ ] Expertise topics
- [ ] Top collaborators
- [ ] Work patterns

### 8.7 Manager Features (if user is manager)
- [ ] Team health cards show per-member status
- [ ] One-on-one prep data available
- [ ] Standup summary generated

---

## 9. Settings

### 9.1 Profile
- [ ] User name displayed
- [ ] User email displayed
- [ ] Avatar (initials or image) displayed

### 9.2 Appearance
- [ ] Toggle between Light and Dark themes
- [ ] Theme persists across page refreshes
- [ ] All pages render correctly in both themes

### 9.3 Members
- [ ] Member list shows all org members with roles
- [ ] "Invite" button visible for admin/owner only
- [ ] Invite a new member by email — invite sent (check console if no email configured)
- [ ] Change a member's role via dropdown
- [ ] Remove a member — confirmation shown, member deactivated
- [ ] Cannot remove yourself
- [ ] Cannot change owner role
- [ ] Guest/member users cannot see invite/remove buttons

### 9.4 Integrations
- [ ] Google Calendar shows "Connect" or "Connected" status
- [ ] GitHub shows "Connect" or "Connected" status
- [ ] Slack shows "Coming soon" (disabled)
- [ ] Gmail shows "Coming soon" (disabled)
- [ ] Connect flow redirects to OAuth provider
- [ ] Disconnect removes the connection

### 9.5 Tags
- [ ] Create a tag with name and color
- [ ] Tag appears in list with entity count
- [ ] Delete a tag — removed from list
- [ ] Apply a tag to a task/message — count increments
- [ ] View tagged entities — shows linked items

### 9.6 Groups
- [ ] Create a group with name and handle
- [ ] Group appears in list
- [ ] Handle auto-generated from name (lowercase, kebab-case)
- [ ] Delete a group — removed from list
- [ ] Group handle usable as @mention in chat

---

## 10. Notifications

- [ ] Notification bell shows unread count badge
- [ ] Click bell — notification panel opens
- [ ] Notifications include: mentions, task assignments, task updates, thread replies
- [ ] Click a notification — navigates to the source (message, task, etc.)
- [ ] Mark single notification as read
- [ ] "Mark all as read" clears all
- [ ] Real-time: new notification appears without page refresh

---

## 11. Reminders

- [ ] Navigate to Reminders page
- [ ] "Upcoming" section shows future reminders sorted by time
- [ ] "Past" section shows delivered reminders (grayed out)
- [ ] Delete a reminder
- [ ] Set a reminder from a chat message context menu
- [ ] At the reminder time, notification is delivered
- [ ] Empty state when no reminders exist

---

## 12. Command Palette & Keyboard Shortcuts

- [ ] Press Cmd+K (Mac) / Ctrl+K (Windows) — command palette opens
- [ ] Search for spaces, tasks, members
- [ ] Quick actions: create task, create space, toggle theme
- [ ] Press Escape to close
- [ ] `c` — opens quick task create (when not in text input)
- [ ] Keyboard navigation (arrow keys + Enter) works in dropdowns

---

## 13. Real-time & Network Resilience

### 13.1 Socket Reconnection
- [ ] Disconnect network briefly — "Reconnecting..." behavior expected
- [ ] Reconnect network — data syncs automatically
- [ ] Messages sent during disconnect are received after reconnect

### 13.2 API Retry
- [ ] If API call fails due to network error, it retries (up to 2 times)
- [ ] 4xx errors do NOT retry (immediate failure)

### 13.3 Concurrent Usage
- [ ] Open app in two browser tabs as same user
- [ ] Actions in one tab reflect in the other (messages, task updates, presence)
- [ ] Open app as two different users — multi-tenant isolation verified

---

## 14. Background Workers

### 14.1 Message Classification Pipeline
- [ ] Send a message with a clear actionable item — task-extract job fires
- [ ] Send a message mentioning being "blocked" — blocked-alert fires
- [ ] Send a message with a memorable fact — memory-extract fires, wiki page created/updated

### 14.2 Cron Jobs (verify via console logs or database)
- [ ] Standup generation runs hourly
- [ ] Nudge check runs hourly (overdue/stalled task reminders)
- [ ] Meeting prep check runs every 15 minutes
- [ ] Wiki lint runs daily (check wiki_ops_log table for lint entries)
- [ ] Stale jobs (stuck in "running" > 5 min) are automatically recovered

### 14.3 Wiki Lint Health Check
- [ ] After wiki-lint runs, check `wiki_ops_log` for lint entries
- [ ] Orphaned pages (no links) flagged
- [ ] Stale pages (90+ days, low confidence) have confidence reduced
- [ ] Pages with confidence < 0.3 are soft-deleted

---

## 15. Integrations

### 15.1 Google Calendar
- [ ] Connect via OAuth in Settings > Integrations
- [ ] Trigger sync — events pulled (14 days past, 30 days future)
- [ ] Events appear in Calendar page
- [ ] Meeting briefs generated for upcoming meetings
- [ ] Token refresh works silently when access token expires
- [ ] Disconnect — connection removed

### 15.2 GitHub
- [ ] Connect via OAuth in Settings > Integrations
- [ ] GitHub activity appears in Dashboard
- [ ] PRs and issues queryable by agent
- [ ] Disconnect — connection removed

---

## 16. Multi-Tenant Isolation

- [ ] Create two separate accounts/orgs
- [ ] Data from Org A is never visible in Org B
- [ ] Spaces, tasks, messages, wiki pages all scoped by org_id
- [ ] API calls with Org A token cannot access Org B data

---

## 17. Theme & Responsive Design

### 17.1 Dark Mode
- [ ] All pages render correctly in dark mode
- [ ] No white flashes on navigation
- [ ] All text is readable (proper contrast)
- [ ] Modals, dropdowns, tooltips all themed

### 17.2 Light Mode
- [ ] All pages render correctly in light mode
- [ ] Same checks as dark mode

### 17.3 Mobile / Responsive
- [ ] Sidebar collapses on small screens
- [ ] Task board scrolls horizontally on mobile
- [ ] Chat input stays at bottom of screen
- [ ] Modals fit within viewport

---

## 18. Edge Cases & Error Handling

- [ ] Submit forms with empty required fields — validation errors shown
- [ ] API returns 500 — user sees error message (not blank screen)
- [ ] Navigate to non-existent page — 404 page shown
- [ ] Very long text inputs — handled gracefully (truncation or scroll)
- [ ] Rapid clicking "Create" button — no duplicate entities created
- [ ] Delete an entity that's referenced elsewhere — no crash (soft delete)
- [ ] Browser back/forward navigation works correctly
- [ ] Page refresh preserves current state (URL-driven routing)

---

## 19. Performance Checks

- [ ] Dashboard loads in < 3 seconds
- [ ] Chat messages load in < 2 seconds per space
- [ ] Task board renders 100+ tasks without lag
- [ ] Knowledge page with 50+ wiki pages renders smoothly
- [ ] Search results return in < 1 second
- [ ] No memory leaks after extended use (30+ minutes)

---

## 20. Trusted Tester Flow — Phases 0-6 Smoke

Fast end-to-end walk for verifying Phases 0-6 of the task-management overhaul. Takes ~15 minutes once you have a seeded org. Do this on a fresh login as an admin/owner.

### 20.1 Create a project with a skill
- [ ] Navigate to `/tasks` → "New project" → wizard opens
- [ ] Step 1: name + prefix (e.g. "Smoke Test", prefix `SMOK`)
- [ ] Step 2: skill picker — verify all 9 bundled skills render. Three should carry the "Project" badge (engineering, marketing-campaign, sales-pipeline). Six should carry the "Agent" badge (capability-pack skills)
- [ ] Pick `engineering` → Create
- [ ] Board renders with columns `backlog / todo / in_progress / in_review / done / cancelled` and priority labels `p0/p1/p2/p3`
- [ ] Go back to project settings → Skills tab → verify `engineering` is attached

### 20.2 Attach a second skill (multi-skill, first-attached-wins)
- [ ] Add the `github` capability-pack skill on top — no column re-order, since project_config only lives on `engineering`
- [ ] Swap order: drag `github` above `engineering` → page still renders (github has empty project_config so resolver falls through)
- [ ] Swap back

### 20.3 Assign an agent employee
- [ ] Create or reuse `Alex PM`. Attach him to the project (Project settings → Team → Add Alex PM)
- [ ] Verify his drawer now shows the project in context

### 20.4 Add a task + basic fields
- [ ] Press `C` → quick-create "Ship SMOK smoke" with priority `p1`, assignee self, due date tomorrow
- [ ] Drag from Backlog → In Progress — activity log records the transition

### 20.5 React to the task (Task 6.3)
- [ ] Open the task detail → click the emoji button at the top of the task card → add `🚀`
- [ ] Reaction pill shows `🚀 1` with your name on hover
- [ ] React again with `🚀` — pill removed (toggle semantics)
- [ ] React with `🔥` and `👀` — both appear

### 20.6 @mention in comments + description (Task 6.4)
- [ ] Open task description → type `@` → autocomplete dropdown renders org members
- [ ] Pick a teammate → mention chip inserted
- [ ] Save → teammate receives a notification (check their bell or psql `SELECT * FROM notifications ORDER BY created_at DESC LIMIT 3`)
- [ ] Same flow in Comments tab

### 20.7 Activity diff view (Task 6.2)
- [ ] Change task title from "Ship SMOK smoke" to "Ship SMOK smoke v2"
- [ ] Change priority from `p1` → `p0`
- [ ] Open Activity tab — rows render as `title: "Ship SMOK smoke" → "Ship SMOK smoke v2"` and `priority: p1 → p0`, not flat "changed title"
- [ ] Bulk-move several tasks in one action (from list view select + bulk edit) — activity groups the bulk change

### 20.8 Recurrence (Task 4.12)
- [ ] Quick-create a task "Weekly report"
- [ ] Open detail → enable `weekly` recurrence
- [ ] Complete the task → new copy auto-generated with `recurrence_source_id` pointing to the original (check psql)
- [ ] Clone a recurring task manually → the clone should NOT inherit the recurrence pattern (the clone-gap fix)

### 20.9 Workflow executor (Task 5.7)
- [ ] Settings → Workflows → New rule: trigger `task.status_changed → in_review`, action `add_comment` body `"auto-review triggered"`
- [ ] Save → enable
- [ ] Move any task into `in_review` → a new comment appears authored by the system user with the configured body
- [ ] Check the rule's run history — one successful row

### 20.10 Live agent progress (Task 3.10)
- [ ] Ask Defty to "Update task SMOK-1 status to done and assign to @teammate"
- [ ] Open the task detail in a second tab while the plan executes
- [ ] Tool-call receipts stream into the activity area: `update_task_status` → `assign_task` each with a tick once complete

### 20.11 Proactive agent comment (Task 3.11)
- [ ] Set a task's due date to yesterday, leave it in `in_progress`
- [ ] Manually trigger nudge-check (`pnpm tsx apps/api/src/scripts/check-queue.ts run nudge-check`) or wait for the hourly cron
- [ ] Within a minute, a proactive comment authored by the org's default agent shadow user appears on the task
- [ ] Trigger again immediately — no duplicate comment (7d dedup)

### 20.12 Inline suggestion card (Task 3.12)
- [ ] In `#general` send a message like "we should follow up with Acme on the contract tomorrow"
- [ ] Within a few seconds an inline suggestion card appears under the message offering to create a task
- [ ] Click Create — task lands in the default project, detail panel opens with the extracted fields pre-filled
- [ ] Dismiss card on a different actionable message — no task created

### 20.13 PR → Done (Task 5.6) — only if GitHub is connected
- [ ] Create a test PR with `SMOK-1` in the title
- [ ] Merge it
- [ ] Within one GitHub sync poll interval, `SMOK-1` moves to `done` with an attribution comment linking the PR
- [ ] Tasks already in `done` or `cancelled` are never bumped

### 20.14 Project archive + soft-delete (Task 5.8)
- [ ] Project settings → Archive → project vanishes from active lists but tasks remain queryable
- [ ] Unarchive → reappears
- [ ] Project settings → Delete → ConfirmDangerous modal → soft-delete
- [ ] Navigate to Settings → Recently deleted → within 7 days, "Restore" is available
- [ ] Restore → project reappears with all tasks intact

### 20.15 Security sanity (Task 0.1)
- [ ] Log out. Call `curl -i http://localhost:3001/api/tasks/<id>/watchers` with no auth → 401
- [ ] Same for `/assignees`, `/assignees/:userId` (POST + DELETE) → all 401
- [ ] With a different org's token, try to watch a task in Org A → 404 (not found in caller's org)

### 20.16 Dashboard "My Work" (Task 0.4)
- [ ] Go to `/dashboard`
- [ ] "My Work" card lists only tasks where you are assignee, split into To Do / In Progress / In Review
- [ ] Assign a teammate a task in a status you watch — it does NOT appear in your "My Work" card

---

## 21. Persona Flow — Marketing (marketing-campaign skill)

Validates that non-technical skill project_config actually drives the UI.

### 21.1 Create a marketing project
- [ ] New project "Q2 Campaigns" with the `marketing-campaign` skill attached
- [ ] Board renders with named priority pills `High / Medium / Low` (NOT `p0/p1/p2/p3`)
- [ ] Default view is Calendar (not Kanban)
- [ ] Custom fields include campaign-specific entries (channel, launch_date, budget, etc.)

### 21.2 Create a campaign task
- [ ] New task "Launch spring newsletter" → calendar view places it on its launch_date
- [ ] Priority picker shows `High / Medium / Low`
- [ ] Custom fields panel lets you set channel=email, budget=5000
- [ ] Switch to list view → custom fields render as sortable columns

### 21.3 Task template
- [ ] Verify the skill's bundled task template is available in the quick-create dropdown (e.g. "New campaign brief") and prefills the custom fields

### 21.4 Agent familiarity
- [ ] Ask Defty "what campaigns are High priority due this month?" — should use `search_tasks` scoped to the marketing project and return a list with the correct named priorities

---

## 22. Persona Flow — Sales (sales-pipeline skill)

### 22.1 Create a sales project
- [ ] New project "Pipeline FY26" with the `sales-pipeline` skill attached
- [ ] Board renders with temperature priorities `Hot / Warm / Cold`
- [ ] Default view is Pipeline (pipeline-style board, not Kanban)
- [ ] Custom fields include deal-specific entries (stage, ACV, probability, close_date, account)

### 22.2 Create a deal
- [ ] New task "Acme — Enterprise renewal" → stage=Proposal, ACV=50000, probability=60
- [ ] Drag across pipeline columns — stage updates inline and activity log records the transition with diff
- [ ] Priority Hot → Warm works

### 22.3 Reporting
- [ ] Ask Defty "what's in Proposal stage with ACV over $25k?" — should return matching deals using `search_tasks` + custom field filter

### 22.4 Multi-skill for a hybrid team
- [ ] Attach both `sales-pipeline` and `marketing-campaign` to a single project — verify the first-attached-wins resolver: the project takes its UI from whichever skill sits at position 0, and reordering in project settings immediately flips the board rendering

---

## Playwright E2E Test Results (2026-04-16)

Baseline Playwright walkthrough covering core surfaces. Use as a regression baseline for future test runs.

### Test Environment
- Branch: `feat/phase2-4-mcp-agents-plans`
- Migrations applied: 0001-0044
- Seeds: 9 bundled skills, 1 agent employee (Alex PM)
- Test user: maneek@test.com (owner role)

### Surface Coverage

| Surface | Status | Notes |
|---------|--------|-------|
| Dashboard (10+ widgets) | PASS | All bento-grid cards render |
| Task Board (6 columns) | PASS | Cancelled column renders collapsed |
| Task List view | PASS | Sortable columns, inline status edit |
| Calendar view | PASS | Tasks on correct due dates |
| Pipeline view | PASS | Fixed: was showing "No deals" instead of "No tasks" |
| Task Detail — Description tab | PASS | TipTap editor renders and saves |
| Task Detail — Subtasks tab | PASS | |
| Task Detail — Dependencies tab | PASS | |
| Task Detail — Comments tab | PASS | |
| Task Detail — Activity tab | PASS | Diff view renders old->new |
| Task Reactions bar | PASS | Emoji toggle works |
| Recurrence dropdown | PASS | None/Daily/Weekly/Biweekly/Monthly |
| Priority labels | PASS | P1 -> "High" mapping correct |
| Status labels | PASS | "To Do" (not "Todo") |
| Filter bar | PASS | Assignee, Priority, Status, Labels, Project, Due date, Views |
| Skills library (3 tabs) | PASS | Bundled 9 / Marketplace 0 / Your org 0 |
| Skills cards (actions) | PASS | View/Install/Attach/Fork + context-bloat indicator |
| Agent Employees list | PASS | Alex PM visible after migration fix |
| Create Agent wizard (5 steps) | PASS | Skills picker shows all 9 bundled skills |
| Project selector | PASS | Dropdown works across views |
| Skills page breadcrumb | PASS | Fixed: was "Dashboard", now "Skills" |

### Bugs Found (6 total — 6 fixed, 0 blocking)

| # | Bug | Severity | Fix |
|---|-----|----------|-----|
| 1 | `/api/agent-employees` 500 — 20 unapplied migrations (0025-0044) | Critical | Applied all migrations + seeded 9 bundled skills |
| 2 | Skills wizard "No skills available" — frontend expected `{skills:[...]}` wrapper, API returns raw array | High | `fd2cb3f` |
| 3 | Pipeline view "No deals" copy in Engineering projects | Medium | `73946cf` |
| 4 | Skills page breadcrumb said "Dashboard" | Low | `73946cf` |
| 5 | Skills wizard fetch error not caught | Low | `73946cf` |
| 6 | Agent wizard Step 3 (Skills) overflows viewport — Back/Next buttons pushed off-screen with 9 skills | High | `1639dd7` — added `max-h-[45vh] overflow-y-auto` scroll container |

### Known Remaining Issues (not fixed — document for future sprints)

1. **Postgres status enum** — column uses enum with 6 Engineering values; Marketing/Sales statuses will fail at DB layer until changed to text.
2. **`tasks.completed_at` column missing** — people-graph uses `updated_at` fallback.
3. **Chat task-reference pills** don't respect `hide_prefix_ids` (would need per-message task lookup).
4. **Notification panel rows** can't render `variant="notification"` TaskCard (no embedded Task payload).
5. **Board-card reactions** only show when task data is pre-hydrated (list endpoints don't hydrate reactions).
6. **Drizzle `_journal.json`** stale since migration 0017 — prod deploy must apply 0025-0044 manually.
7. **Sidebar wiring** for archived projects not implemented (backend ready, no UI entry point).

---

## Sign-off

| Area | Tester | Date | Pass/Fail | Notes |
|------|--------|------|-----------|-------|
| Auth | | | | |
| Chat | | | | |
| Tasks | | | | |
| Calendar | | | | |
| Knowledge Wiki | | | | |
| Agent | | | | |
| Notes | | | | |
| Dashboard | | | | |
| Settings | | | | |
| Notifications | | | | |
| Reminders | | | | |
| Real-time | | | | |
| Workers | | | | |
| Integrations | | | | |
| Multi-tenant | | | | |
| Theme/Responsive | | | | |
| Edge Cases | | | | |
| Performance | | | | |
| Trusted Tester (Phases 0-6) | | | | |
| Marketing persona | | | | |
| Sales persona | | | | |
