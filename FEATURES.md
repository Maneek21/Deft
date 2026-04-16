# Deft — Complete Feature Inventory

> Last updated: April 8, 2026
> Verified against codebase: 66 database tables, 32 route files, 32+ agent tools, 17 background workers, 23 pages, 47+ components

---

## Architecture Overview

```
Frontend:  Next.js 14 (App Router) + React + Tailwind CSS
API:       Hono on Node.js (TypeScript)
Database:  PostgreSQL + pgvector (66 tables, Drizzle ORM)
Real-time: Socket.io with room-based presence
AI:        Multi-LLM (Anthropic Claude, OpenAI, OpenRouter, Ollama)
Auth:      better-auth (JWT + refresh tokens + Google OAuth)
Jobs:      Postgres-based job queue (17 background workers)
Storage:   Local filesystem (./uploads), Cloudflare R2-ready
Monorepo:  pnpm workspaces
```

---

## 1. Communication

### Real-time Chat
Full-featured messaging system with spaces (public, private, DM, group DM). Cursor-based pagination (50/page), room-per-space architecture via Socket.io. Message grouping for consecutive messages from same user within 5 minutes. Day separators between message groups.

### Threads
Reply to any message opens a side panel with parent message + replies. Thread replies don't appear in main feed. "X replies" indicator on parent with latest reply time. Per-user thread read tracking (`threadReads` table).

### Emoji Reactions
124 standard emojis across categories. Click to toggle reaction on any message. Reaction pills below message showing emoji + count + users who reacted.

### Custom Emoji
Org-specific custom emoji uploads (256KB max, alphanumeric names). Served with correct MIME type. Appear alongside standard emojis.

### Pinned Messages
Pin important messages per space. Pinned messages bar/sidebar panel with preview. Unique constraint: one pin per message per space.

### Saved / Bookmarked Messages
Personal saved messages collection. Save any message by ID + space. List all saved with author, space, timestamp. Remove saves. Sorted by most recent.

### Scheduled Messages
Schedule messages for future delivery. Status tracking: pending → sent → cancelled. Background job polls and sends when time arrives. Scheduled panel in chat UI.

### File Uploads & Attachments
50MB per file max. Drag-and-drop zone overlay, clipboard paste (Ctrl+V) for images, paperclip button. Images render inline (max 400x300) with lightbox modal on click. Other files as download cards with icon + name + size. Multiple files per message. Storage in ./uploads with UUID-prefixed filenames (R2-ready).

### Audio/Video Clips
Async voice/video clip recording and upload (50MB WebM). Two modes: async (standalone recording) and live (huddle recording). Auto-transcription via configurable provider (local Whisper, OpenAI Whisper API, or Deepgram Nova-2 with speaker diarization). Timestamped transcript segments with speaker info. AI-powered summarization: TLDR, decisions, action items, blockers extracted. Status pipeline: uploading → transcribing → summarizing → ready. Inline clip card in messages with playback.

### Huddles — Live Audio/Video Calls
WebRTC audio/video rooms within spaces. Socket.io-based signaling (offer/answer/ICE candidates). Create/join huddles per space. Participant list with mute status. Ring notifications sent to non-muted space members. 30-second grace period before room destruction when empty. Compact + expanded overlay UI with duration timer, mute toggle, participant avatars. Speaking detection visualization. In-memory room state management.

### Rich Text Editor
TipTap-based editor with bold, italic, strikethrough, inline code, code blocks, bullet lists, numbered lists, blockquotes, links, headings. Formatting toolbar in composer.

### @Mentions
Type `@` → autocomplete dropdown with org members. `@here` and `@all` support. User group mentions (@engineering, @design). Task mentions (#DEFT-1 → styled chip with autocomplete). Creates notifications on mention.

### Slash Commands
Slash command autocomplete (e.g., `/remind`, `/task`, `/gif`). Integrated in rich composer.

### Link Preview Unfurling
URLs auto-unfurl with Open Graph metadata (title, description, image, favicon). Async fetch with 5-second timeout, follows redirects. Socket broadcast of preview data.

### Typing Indicators
"X is typing..." with 2-second debounce. Socket.io `typing:start` / `typing:stop` events per space.

### User Presence
Green dot = online, yellow = idle (5min+ inactivity), no dot = offline. Server tracks per-socket with multi-tab support (only offline when ALL sockets disconnect). Idle detection triggers `presence:idle`, activity resumption triggers `presence:active`.

### Custom User Status
Set status emoji + text with optional expiry time. Visible on user profile cards and member lists. Clear status manually or auto-expire.

### Do Not Disturb
DND mode toggle. Suppresses notifications when active.

### Canvas — Collaborative Whiteboard
Per-space collaborative canvas using TipTap JSON document storage. Real-time updates via Socket.io (`canvas:updated` event). Track last editor + edit timestamp. Auto-create canvas when first opened in a space.

### Space Recaps
AI-summarized recap of unread or recent messages in a space. Uses Claude API for intelligent summarization. Summarizes last 50 messages or unread messages on demand.

### Space Management
Create spaces: public, private, DM, group DM. Space member panel (list, add, remove). Mute spaces. Archive/unarchive. Default space (#general) created on org signup. Private spaces with invite-only access.

### DMs & Group DMs
All org members listed under "Direct Messages" in sidebar. Click → creates DM or opens existing (deduplication). DM header shows other person's name. Group DM support for multi-party direct conversations.

---

## 2. Task Management

### Projects & Task IDs
Project collections with customizable prefix (e.g., DEFT). Auto-incrementing task numbers per project (DEFT-1, DEFT-2). Project lead, color, archive status.

### Kanban Board
6 columns: Backlog, To Do, In Progress, In Review, Done, Cancelled. Drag-and-drop between and within columns (@dnd-kit). Column headers with count badge. "+" add task at bottom of each column.

### List / Table View
Tabular view with columns: ID, Title, Status, Priority, Assignee, Due Date, Updated. Sortable column headers. Inline status edit (click to change). Click row → detail panel.

### Task Detail Panel
450px side panel sliding from right. Editable title (debounced auto-save). Field grid: Status, Priority, Assignee, Reporter, Due Date, Labels — all dropdown pickers. TipTap rich text description editor (auto-save). Tabs: Comments (with add form) | Activity (formatted log). Source message link if created from chat. Subtask display (parent/child).

### Task Comments & Activity Log
Threaded comments on tasks. Full activity log of every field change (status, assignment, priority, etc.). Formatted display: "In Progress" not "in_progress", "P1 (High)" not "p1". Assignee name resolution in activity.

### Task Relationships
Three relationship types: blocks, relates_to, duplicates. Bidirectional tracking. Displayed on task detail panel.

### Labels
Org-wide reusable labels with colors. Apply/remove labels on tasks. Filter tasks by label. Manage labels in settings.

### Saved Views
Saved filter/sort configurations per user per project. Reusable view presets.

### Quick Create & Bulk Operations
Press `C` key → quick-create modal with title + fields (defaults to Backlog). Bulk delete and reassign operations.

### Task Filters
Filter by: status (multi-select), assignee, priority (multi-select), project, labels, due date (overdue/today/this week). My Tasks toggle. URL-driven filtering.

### Cross-References
Link messages to tasks and tasks to other tasks with context notes. Display on task detail panel. Searchable index. Background worker auto-detects references.

### Duplicate Task Detection
Background worker identifies similar/duplicate tasks. Prevents redundant work.

### Blocked Task Detection & Alerts
Keyword detection in messages ("blocked", "stuck", "waiting on"). Background worker generates alerts. Notifies relevant team members.

### Chat ↔ Tasks Bridge
Create task from message (hover menu → "Create task" → pre-filled modal). Task mentions in chat (#DEFT-1 autocomplete → styled chip). Status changes auto-post system messages in linked spaces.

---

## 3. Knowledge & Documentation

### Wiki Pages
Structured knowledge base with 7 page types: concept, entity, decision, resource, procedure, preference, fact. 3 scopes: org-wide, space-scoped, user-private. Auto-generated slugs with collision avoidance. Full-text search and type/scope filtering. Pagination (50 items/page).

### Semantic Page Linking & Backlinks
Directed link graph between wiki pages. Each link carries optional context (reason/label). Backlinks view showing all pages that reference a given page. Link count aggregation on list view.

### Confidence Scoring & Automated Decay
Each page has a confidence score (0–1). Visual confidence bars: green (>70%), yellow (50–70%), red (<50%). Daily wiki lint worker decays pages with confidence below 0.3 (soft delete). Automated stale content detection.

### Citations & Source Tracking
Link wiki pages to their source messages, tasks, or events. Citation excerpts showing what was referenced. Displayed on page detail view.

### Wiki Ops Log
Full audit trail of wiki operations: create, update, delete, merge, lint. Tracks actor (performed_by) and details (JSONB).

### Wiki Lint — Daily Health Check
Automated daily worker per org. Detects orphaned pages (no links in or out), stale content, low confidence. Logs all issues to ops log. Auto-decays very low confidence pages.

### Space Knowledge — Quick Capture
Lightweight knowledge capture sidebar in chat. 4 types: decision, resource, action_item, note. Link to source message. Real-time Socket.io events (`knowledge:created/updated/deleted`). Searchable across org via `/api/knowledge`.

### Decisions Tracking
Record decisions with text, context, and tags. Link to source message. Track who decided (decided_by). Reversibility flag (is_reversed). Search/filter by query or space.

### Daily Notes
Personal rich text notes with emoji icons. TipTap HTML content. Pin/unpin notes (pinned show first). Search by title. Sorted by pinned status + update time.

### Tags System
Org-wide colored tags. Apply tags to multiple entity types: messages, tasks, clips, daily notes. Tag search/filter. Browse tagged entities. Tag management in settings.

---

## 4. AI Agent

### Conversational Interface
Dedicated AI chat page with streaming SSE responses. Multi-turn conversations with history. Auto-titled from first message. Thinking indicator (bouncing dots). Auto-scroll with manual scroll-up respect. Empty state with 5 suggestion cards. Markdown rendering for responses.

### 32+ Agent Tools
Organized in 5 categories:

**Read-only tools (auto-execute):**
- `search_messages` — full-text search across chat with space/author filters
- `search_tasks` — query by title, status, priority, assignee, project, overdue flag
- `get_task_detail` — full task with comments and activity
- `get_workspace_stats` — aggregate metrics (tasks, messages, active users)
- `get_team_workload` — task distribution by assignee and status
- `get_project_progress` — completion %, overdue counts, recent activity
- `get_user_activity` — person's recent task changes, messages, assignments
- `get_task_dependencies` — blocking/blocked-by relationships
- `search_blockers` — find mentions of blocked/stuck work
- `search_decisions` — retrieve past team decisions
- `search_knowledge` — find documented knowledge entries
- `wiki_search` — search wiki pages
- `wiki_read` — read full wiki page with backlinks
- `remember` — store facts (conversation/user/org scopes)
- `recall` — retrieve stored memories

**Calendar tools (auto-execute):**
- `check_calendar` — view Google Calendar events

**GitHub tools (auto-execute):**
- `check_github_prs` — view pull requests by state

**Write tools (require approval):**
- `create_task` — new tasks in projects
- `update_task_status` — move tasks between statuses
- `assign_task` — assign to team members
- `post_message` — post in spaces
- `add_knowledge` — add knowledge entries
- `create_calendar_event` — create Google Calendar events
- `wiki_write` — create/update wiki pages

**Manager tools (require manager role):**
- `get_team_health` — health status per member (green/yellow/red)
- `get_team_performance` — velocity metrics per week
- `get_workload_balance` — identify over/underloaded members
- `prep_oneone` — generate 1:1 meeting prep for a person
- `find_expert` — find who has expertise on a topic
- `get_team_dynamics` — collaboration clusters, mentoring pairs, tensions
- `analyze_skills_gap` — missing skills in team
- `get_burnout_risks` — members showing strain signals (manager-only, privacy-conscious)

### Three-Tier Approval System
- **Auto-execute**: read-only tools, memory operations, calendar/GitHub reads
- **Quick-approve**: task creation, status updates, assignments (one-click approval card)
- **Full-review**: multi-step plans, message posting, external writes (preview + edit)

### Trust Levels
Per-org setting: Conservative (all writes need approval) → Standard (some auto-execute) → Autonomous (most auto-execute). Configurable in settings.

### Agent Memory System
Store and retrieve facts at three scopes: conversation, user, org. Upsert semantics (update if exists). Used by `remember` and `recall` tools. Persistent across conversations.

### Agent Actions with Undo
Write actions create pending records. User sees approval card with Approve/Reject buttons. Approved actions can be undone within 5 minutes. Full action log in settings.

### Citations with Confidence
Task and message sources shown below response (max 5, expandable). Confidence indicator: green (3+ sources), amber (1-2), red (0 sources).

### @agent / @deft Mentions in Chat
Mention `@agent` or `@deft` in any space message. Background worker picks up mention, runs agent reasoning with thread context, posts reply in thread. Auto-creates agent system user. Up to 8 reasoning iterations.

### Follow-up Suggestions
Agent provides follow-up question suggestions after responses.

### Message Classification Pipeline
Every chat message classified by Haiku for: intent (task_create, question, discussion, actionable, none), entity extraction (assignee, project, due_date), agent mention detection, task reference detection, blocked indicators, memorable facts, team decisions.

---

## 5. Dashboard & Analytics

### Bento Grid Home View
Responsive card-based dashboard (1 col mobile, 2 col tablet, 3 col desktop). Cards: Today (tasks due, span 2), Quick Stats (4-stat grid: overdue/due today/in progress/completed), Unread (space notifications), Projects (progress rings), Activity (recent feed), Calendar (mini widget with day bucketing), My Work (kanban-lite: todo/in_progress/in_review columns), Team (manager-only health cards), My Insights (personal metrics).

### AI Standup Generation
Daily AI-generated standup using Claude. Gathers: status changes, new tasks, messages by space, active users, completed count, overdue count. Falls back to template-based summary if no API key. Auto-posts to default space as system message.

### Personal Insights
Activity metrics: messages sent, tasks completed, active spaces. Expertise areas with scores. Top collaborators with interaction counts. Work patterns (behavioral analysis). Weekly pace/velocity (4-week trend).

### Team Health Monitoring
Per-member health cards with green/yellow/red status dots. Action items extraction. Wins identification. Uses patterns, messages, and task data for insights. Manager-only view.

### Burnout Detection
Detects: working hours shift, sentiment decline, velocity drop, isolation patterns. Privacy-conscious (analyzes public message patterns only, never content). Configurable thresholds. Generates alerts with confidence scores. Manager + affected user visibility only.

### 1:1 Meeting Prep
Auto-generated preparation documents for manager-report 1:1 meetings. Includes: summary, wins, focus areas, concerns, talking points. Uses team member activity data. Status tracking: generated → discussed → archived.

### Expertise Tracking
Per-user expertise scored by topic. Factors: message count on topic, questions answered, help mentions received, tasks completed in area. Expertise score aggregation. Used by `find_expert` agent tool.

### Collaboration Graph
Tracks interactions between all org members. Metrics: interaction count, recency-weighted score, DM count, shared space count, mention count, thread co-participation. Powers "top collaborators" in personal insights.

### People Influence Mapping
Maps influence types per person: decision_maker, blocker_resolver, reviewer, connector, mentor. Evidence-based scoring. Used by `get_team_dynamics` agent tool.

### People Relationships
Maps relationship types with direction: close_collaborator, mentor_mentee, tension, delegation_chain, cross_team_bridge. Powers team dynamics analysis.

### Velocity Calculator
4-week velocity trend (tasks completed per week). Trend detection: increasing, stable, declining. Per-person and team-wide breakdowns.

### Workload Analyzer
Identifies over/underloaded team members. Priority-weighted task distribution. Used by `get_workload_balance` agent tool.

### Bottleneck Detector
Identifies stuck reviews, stalled tasks, review bottlenecks. Surfaces blockers in team analytics.

### Skills Gap Analyzer
Maps expertise coverage across team. Identifies single points of failure (only one person knows X). Highlights well-covered vs. gap areas.

### Space Recap
AI-summarized recap of unread or recent messages per space. On-demand generation via API. Uses Claude for intelligent summarization.

### Weekly Digest
Weekly org-wide summary for managers. Aggregates: velocity, task completion, decisions made, risks, wins. Delivered via background worker.

---

## 6. Calendar & Scheduling

### Multi-View Calendar
Three views: month (day buckets with event dots), week (7-day horizontal), day (hourly timeline). Event creation/edit modals. Day detail panel showing all events. Navigation between dates.

### Native Calendar Events
Create, update, delete events within Deft. Stored in unified events table.

### Google Calendar Sync
OAuth 2.0 integration with token refresh. Polling-based sync worker. Bidirectional: read events + create events via agent. Connection status + error display in settings. Last sync timestamp.

### Meeting Briefs
AI-generated pre-meeting summaries. Links to calendar event. Prep content stored as JSON. Background worker checks every 15 minutes for upcoming meetings.

---

## 7. Automation & Background Intelligence

### Workflow Rules
User-created automation rules. Trigger types: keyword_in_message, new_member_joins, reaction_added. Action types: create_task, send_message, notify_user. Flexible JSON config for triggers and actions. Enable/disable rules. Run history with results log.

### 17 Background Workers
All powered by Postgres-based job queue (no external Redis required). Atomic job claiming with `SELECT FOR UPDATE SKIP LOCKED`. Exponential backoff on retry.

| Worker | Schedule | Purpose |
|--------|----------|---------|
| standup-generate | Daily at 9am local time per org (standup-generate cron) | Generate daily team standup summaries |
| standup-check | Hourly | Validate/process standup entries |
| nudge-check | Hourly | Smart reminders for stalled/overdue/unassigned tasks |
| meeting-prep-check | Every 15 min | Generate meeting briefs for upcoming meetings |
| people-graph | Daily | Update interaction, expertise, and pattern data |
| manager-pulse | Daily | Generate team health snapshots |
| burnout-detect | Daily | Detect burnout risk signals |
| weekly-digest | Weekly | Generate org-wide weekly summary |
| wiki-lint | Daily | Validate wiki health, detect orphans, decay stale pages |
| agent-reply | On demand | Process @agent/@deft mentions in chat |
| task-extract | On demand | Extract tasks from natural language in messages |
| memory-extract | On demand | Extract memorable facts from conversations |
| cross-reference | On demand | Auto-detect and link task/message references |
| clip-process | On demand | Transcribe and summarize audio/video clips |
| duplicate-detect | On demand | Identify duplicate/similar tasks |
| blocked-alert | On demand | Alert on blocked task mentions |
| embed-content | On demand | Semantic search via pgvector + OpenAI text-embedding-3-small (1536 dims). Populated on wiki ingest by the embed-content worker. Requires `OPENAI_API_KEY` env var. Implemented 2026-04-16. |

### Cron Scheduling
Postgres-based cron with idempotent job creation. Re-enqueue pattern (complete job → re-enqueue with delay). Stale job cleanup for crashed workers (5 min timeout).

### Agent Nudges
Smart reminders for: stalled tasks (no update in X days), overdue tasks, unassigned tasks. Dismissable by user. Background worker generates nudges hourly.

---

## 8. Search & Navigation

### Global Search (Cmd+K)
Unified search across spaces, tasks, people, messages, notes, tags. Glassmorphism overlay with backdrop blur. Results grouped by type. Task search supports title or PREFIX-NUMBER (e.g., "DEFT-1"). 200ms debounced.

### Command Mode
Type `>` in search bar for actions: Create task, New space, Toggle dark mode, Open settings, Ask Deft.

### Keyboard Shortcuts
| Shortcut | Action |
|----------|--------|
| Cmd+K / Ctrl+K | Command palette |
| ? | Keyboard shortcuts help |
| G → D | Dashboard |
| G → C | Chat |
| G → T | Tasks |
| G → A | Agent |
| G → S | Settings |
| G → N | Notes |
| G → L | Calendar |
| G → K | Knowledge |
| G → R | Reminders |
| C (on tasks page) | Quick-create task |
| Shift+Esc | Mark all notifications read |
| Ctrl+Shift+M | Mark current space read |
| Enter | Send message |
| Shift+Enter | New line in composer |
| Esc | Close panels/modals |

---

## 9. Integrations

### Google Calendar — Working
OAuth 2.0 flow with token refresh. Polling sync worker syncs events to local events table. Agent can read events (`check_calendar`) and create events (`create_calendar_event`). Connection status, errors, and last sync time shown in settings.

### GitHub — Working
OAuth integration with PR/issue event syncing. Sync worker polls for activity. Agent can read PRs (`check_github_prs`). PR merge can auto-complete linked tasks. GitHub activity shown on dashboard.

### Slack — Scaffolded
Event schema defined in unified events table (source: slack, type: slack_message). OAuth config scaffolded. Agent outbound messaging via `post_message` tool. No inbound sync worker yet.

### Gmail — Scaffolded
Event schema defined (source: gmail, type: email_received). OAuth config scaffolded. No sync worker yet.

### Unified Events Table
All external data normalized into single `events` table. Sources: native, google_calendar, github, slack, gmail, linear. Event types: calendar_event, pr_opened, pr_merged, slack_message, email_received. External ID deduplication. User mapping. Agent queries across native + events data together.

---

## 10. Platform & Infrastructure

### Multi-Tenant Architecture
`org_id` on every table (66 tables). All queries filter by org_id. Row-level isolation. No cross-org data leakage.

### Self-Hosting
Docker Compose deployment with health checks. Multi-stage Dockerfile (deps → build → production). Persistent volumes for data and uploads. `.env.example` with documented variables.

### Open Source (BSL 1.1)
Business Source License 1.1 — use for any purpose except hosting as a service for third parties. Converts to Apache 2.0 after 4 years. Mandatory attribution in forks.

### Authentication
better-auth with JWT access tokens (15min) + refresh tokens (30d, HttpOnly). Google OAuth support. Automatic token refresh on 401. bcrypt password hashing (12 rounds).

### Roles & Permissions
4 roles: owner, admin, member, guest. Role-based UI (admin-only member management, manager-only analytics). Org membership tracking.

### Invite System
Email invites with unique tokens. Link-based invites. Invite expiry tracking. Accept tracking (who accepted, when). Role assignment on invite.

### Onboarding
5-step setup wizard: workspace name → invite team → create spaces (general, engineering, design, random templates) → create project → meet Deft AI. Completion flags tracked per user.

### Theming
Light/dark/system preference. Obsidian dark theme: 8-level tonal surface scale, muted violet accent, glassmorphism floating elements. CSS custom properties. 150ms transitions.

### Audit Log
Complete audit trail of all user and agent actions. Tracks: actor (user or agent), action, entity type/ID, before/after state snapshots (JSON), metadata. Queryable by actor, entity, or action type.

### Encryption
AES-256-GCM for sensitive OAuth tokens. Key derived via scrypt from env variable. IV + tag + ciphertext format.

### Multi-LLM Support
Unified LLM router supporting 4 providers: Anthropic (Haiku for classify/summarize/extract, Sonnet for reasoning), OpenAI (GPT models with function calling), OpenRouter (compatible with OpenAI format), Ollama (local models for self-hosted). Per-org API key overrides. Token usage tracking.

### Real-Time (Socket.io)
Room-based broadcasting: org rooms, space rooms, user rooms, huddle rooms. JWT-authenticated WebSocket connections. 15+ event types for messages, typing, presence, notifications, reactions, threads, tasks, spaces, huddles, knowledge, canvas.

### Notifications System
In-app notifications for: mentions, task assignments, task updates, agent suggestions, huddle started, system events. Real-time delivery via Socket.io. Mark single or all as read. Unread count badge in header.

### Reminders
Schedule reminders for messages or custom alerts. Remind_at time with in-process scheduling. Fires as notification + socket event. Upcoming/past views. Source message linking.

### User Groups
Named groups (e.g., @engineering, @design) with handle/slug. Add/remove members. Bulk mentioning in chat. Handle uniqueness per org.

### Message Edit History
`messageVersions` table tracks all message edits. Previous content preserved for audit.

---

## What Does NOT Exist

- Mobile app (iOS / Android) — web-only
- Desktop app (Electron / Tauri)
- Offline support
- Screen sharing in huddles
- SFU / media server for huddles (peer-to-peer only, limits group call size)
- SOC 2, HIPAA, or other compliance certifications
- Uptime SLA
- Public REST/GraphQL API for third-party developers
- Zapier / Make integration
- Data export (CSV, JSON)
- Burndown / sprint velocity charts (traditional PM analytics)
- Goal / OKR tracking
- Portfolio management
- Custom report builder
- Timeline / Gantt view
- Calendar view for tasks
- Sprints / cycles
- Roadmap view
- Guest access (external collaborators outside org)
- Page-level or channel-level permissions (org-level roles only)
- IP allowlisting
- DLP / eDiscovery
- Domain verification
- Billing / subscription management (schema exists, no routes)
- Rich blocks in wiki (wiki content is text-based, not block-based like Notion)
- Embeds (Figma, Loom, YouTube) in wiki/docs
- Drag-and-drop page hierarchy in wiki (link-based, not tree-based)

---

## Stats Summary

| Metric | Count |
|--------|-------|
| Database tables | 66 |
| API route files | 32 |
| API endpoints | 100+ |
| React components | 47+ |
| Pages | 23 |
| Socket.io event types | 15+ |
| Agent tools | 32+ |
| Background workers | 17 |
| Cron jobs | 7 (hourly to weekly) |
| LLM providers supported | 4 |
| Keyboard shortcuts | 18 |
