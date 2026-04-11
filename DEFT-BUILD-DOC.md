# Deft — Comprehensive Build Document

**Version:** Pre-Alpha (April 2026)
**License:** BSL 1.1 — Use for any purpose except hosting as a service for third parties. Mandatory attribution in forks.

---

## 1. Platform Overview

Deft is an open-source AI-native workspace that unifies team chat, task management, and an AI agent into a single product. The agent has direct SQL access to all native data — not API calls — making it fundamentally faster and more context-aware than bolt-on AI features.

**Target users:** Engineering teams (5-50 people) who currently juggle Slack + Linear/Jira + scattered AI tools. Deft replaces all three with one integrated surface.

**Deployment modes:**
- **Self-hosted (open source):** Docker Compose with Postgres + the app. No Redis needed.
- **Managed SaaS:** Hosted multi-tenant service with usage-based AI billing.

---

## 2. Architecture

```
cairn/
├── apps/
│   ├── web/          # Next.js 16 (App Router, React 19, Tailwind CSS 4)
│   └── api/          # Hono (TypeScript, REST + WebSocket via Socket.io)
├── packages/
│   ├── db/           # Drizzle ORM schema + migrations (PostgreSQL)
│   ├── shared/       # Shared types, Zod schemas, constants
│   └── ai/           # Agent engine (placeholder for future extraction)
├── docker-compose.yml
├── Dockerfile
└── pnpm-workspace.yaml
```

**Stack:**

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, Tailwind CSS 4, TipTap |
| API | Hono on Node.js, TypeScript |
| Database | PostgreSQL 16 + Drizzle ORM |
| Real-time | Socket.io |
| Auth | Custom JWT (access 15min + refresh 30d) |
| Background jobs | Postgres job queue (SKIP LOCKED) |
| AI | Multi-model LLM router (Anthropic, OpenAI, OpenRouter, Ollama) |
| File storage | Local filesystem (R2/S3 ready) |
| Email | Resend |
| Icons | Lucide React |
| Drag & Drop | dnd-kit |
| Monorepo | pnpm workspaces |

**Key design decisions:**
1. Agent reads native data via direct SQL, not API calls — the core technical advantage.
2. Product works fully without AI — if the LLM is down, chat + tasks function normally.
3. Multi-tenant from day 1 — `org_id` on every table.
4. No Redis required — background jobs use Postgres SKIP LOCKED.
5. Multi-model routing — different LLM providers for different task types.

---

## 3. Database

56 tables across 7 domains.

### Auth (4 tables)

| Table | Purpose |
|-------|---------|
| `orgs` | Organizations with name, slug, timezone, trust level, agent settings |
| `users` | User accounts with email, name, avatar, timezone, status fields |
| `org_members` | User-to-org membership with role (owner/admin/member/guest) |
| `invites` | Email and link invites with token, expiration |

### Chat (10 tables)

| Table | Purpose |
|-------|---------|
| `spaces` | Channels and DMs (public/private/dm/group_dm) |
| `space_members` | User-to-space membership with mute, last-read tracking |
| `messages` | Chat messages with threading (parent_id), soft delete, metadata |
| `reactions` | Emoji reactions on messages (unique per user+message+emoji) |
| `pinned_messages` | Pinned messages per space |
| `scheduled_messages` | Messages scheduled for future delivery |
| `message_bookmarks` | Per-user saved/bookmarked messages |
| `canvases` | Per-space shared canvas (TipTap JSON) |
| `reminders` | Per-user message reminders with delivery time |
| `files` | File uploads with storage key, mime type, optional message/task link |

### Tasks (7 tables)

| Table | Purpose |
|-------|---------|
| `projects` | Projects with prefix (e.g., DEFT), icon, color, lead, task counter |
| `project_spaces` | Links projects to chat spaces |
| `tasks` | Tasks with status, priority, assignee, due date, parent_task_id for subtasks, sort order |
| `labels` | Colored labels per org |
| `task_labels` | Many-to-many task-to-label mapping |
| `task_comments` | Comment threads on tasks |
| `task_activity` | Activity log: status changes, assignments, priority changes |
| `task_relationships` | Blocks, relates_to, duplicates between tasks |

### Agent (8 tables)

| Table | Purpose |
|-------|---------|
| `agent_conversations` | Agent chat conversations per user |
| `agent_messages` | Messages in agent conversations (user + assistant roles, citations, tool calls, token counts) |
| `agent_actions` | Action log with approval status, before/after state, undo tracking |
| `agent_memory` | Per-conversation, per-user, and per-org memory storage |
| `agent_nudges` | Proactive nudges for stalled/overdue tasks |
| `skills` | Custom agent skills with system prompts |
| `tools` | Tool registry with approval tiers |
| `triggers` | Event-driven agent triggers (task_overdue, pr_merged, cron) |

### People Intelligence (8 tables)

| Table | Purpose |
|-------|---------|
| `people_interactions` | Interaction matrix: message counts, DM counts, mentions, thread co-participation |
| `people_expertise` | Per-user topic expertise scores from messages, tasks, and help requests |
| `people_influence` | Influence roles: decision_maker, blocker_resolver, reviewer, connector, mentor |
| `people_patterns` | Behavioral patterns: active hours, response time, communication style, activity trends |
| `people_relationships` | Detected relationships: close collaborator, mentor/mentee, tension, delegation chain |
| `team_health_snapshots` | Point-in-time team health data |
| `oneone_preps` | Generated 1:1 meeting preparation content |
| `burnout_alerts` | Burnout risk alerts (privacy-protected, manager-only) |
| `manager_settings` | Per-manager config: pulse frequency, thresholds, digest preferences |

### Infrastructure (7 tables)

| Table | Purpose |
|-------|---------|
| `job_queue` | Postgres-based background job queue with SKIP LOCKED |
| `standups` | Generated daily standup summaries |
| `meeting_briefs` | Generated meeting prep briefs |
| `audit_log` | Full audit trail: actor, action, entity, before/after state |
| `onboarding_state` | Per-user onboarding progress tracking |
| `notifications` | All notification types (mention, task, agent, system) |
| `decisions` | Team decisions extracted from chat with tags, context, reversal tracking |

### Integrations & Collaboration (7 tables)

| Table | Purpose |
|-------|---------|
| `connected_accounts` | OAuth connections (Google Calendar, GitHub, Slack, Gmail) with encrypted tokens |
| `events` | Unified events table for all external tool data |
| `cross_references` | Links between messages, tasks, and events |
| `user_groups` | Named user groups with handles |
| `user_group_members` | Group membership |
| `custom_emoji` | Per-org custom emoji uploads |
| `workflow_rules` | Automation rules (trigger + action) |
| `workflow_runs` | Execution history for workflow rules |
| `saved_views` | Saved task filter/sort configurations |
| `favorites` | User favorites (projects, spaces, tasks) |

---

## 4. API Endpoints

229 endpoints across 26 route files.

### auth.ts (6 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/signup` | Register new user + org |
| POST | `/login` | Email/password login, returns JWT tokens |
| POST | `/refresh` | Refresh access token |
| POST | `/logout` | Invalidate session |
| GET | `/me` | Get current user + org info |
| PATCH | `/me` | Update user profile |

### spaces.ts (10 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Create a new space (channel or DM) |
| GET | `/` | List all spaces for user's org |
| GET | `/unread` | Get unread counts for all spaces |
| GET | `/:id` | Get single space details |
| PATCH | `/:id` | Update space name/description/topic |
| GET | `/:id/members` | List space members |
| POST | `/:id/members` | Add member to space |
| POST | `/:id/read` | Mark space as read (update last_read position) |
| DELETE | `/:id/members/:userId` | Remove member from space |
| DELETE | `/:id/members/me` | Leave space |

### messages.ts (7 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/:spaceId` | List messages in a space (paginated) |
| POST | `/:spaceId` | Send a message (with @mention, @Deft, and cross-ref detection) |
| PATCH | `/:id` | Edit a message |
| DELETE | `/:id` | Soft-delete a message |
| POST | `/:id/reactions` | Add emoji reaction |
| DELETE | `/:id/reactions/:emoji` | Remove emoji reaction |
| GET | `/:id/thread` | Get thread replies for a message |

### tasks.ts (22 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/my` | Get current user's assigned tasks |
| GET | `/search` | Search tasks by keyword/filters |
| GET | `/labels` | List all labels |
| POST | `/labels` | Create a label |
| PATCH | `/bulk` | Bulk update task status/priority/assignee |
| POST | `/bulk-delete` | Bulk soft-delete tasks |
| GET | `/:id` | Get task detail with subtasks, comments, activity, dependencies |
| GET | `/:id/comments` | List task comments |
| POST | `/:id/comments` | Add a comment |
| GET | `/:id/activity` | Get task activity log |
| POST | `/:id/labels` | Add label to task |
| DELETE | `/:id/labels/:labelId` | Remove label from task |
| GET | `/project/:projectId` | List tasks for a project (with filters) |
| POST | `/project/:projectId` | Create a new task |
| PATCH | `/:id` | Update task fields (status, priority, assignee, title, description, due date, parent_task_id) |
| DELETE | `/:id` | Soft-delete a task |
| POST | `/:id/duplicate` | Duplicate a task |
| GET | `/:id/dependencies` | Get task dependencies (blocks, blocked by, relates to, duplicates) |
| POST | `/:id/dependencies` | Add a dependency relationship |
| DELETE | `/:id/dependencies/:relationId` | Remove a dependency |

### projects.ts (5 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List all projects |
| POST | `/` | Create a project |
| GET | `/:id` | Get project details |
| GET | `/:id/tasks` | List tasks in project |
| POST | `/:id/tasks` | Create task in project |

### agent.ts (12 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/conversations` | List user's agent conversations |
| POST | `/conversations` | Create new conversation |
| PATCH | `/conversations/:id` | Rename conversation |
| DELETE | `/conversations/:id` | Delete conversation |
| GET | `/conversations/:id/messages` | Get conversation messages |
| POST | `/conversations/:id/messages` | Send message to agent (SSE streaming response) |
| POST | `/actions/:id/approve` | Approve a pending agent action |
| POST | `/actions/:id/reject` | Reject a pending action |
| POST | `/actions/:id/undo` | Undo an executed action |
| GET | `/actions` | List agent action history |
| GET | `/settings` | Get agent/trust level settings |
| PATCH | `/settings` | Update trust level |

### dashboard.ts (3 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Dashboard data: metrics, activity, unread channels |
| POST | `/standup` | Generate daily standup summary |
| GET | `/my-insights` | Personal insights: messages sent, tasks completed, expertise, top collaborators |

### manager.ts (6 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/oneone-prep` | Generate 1:1 prep for a report |
| GET | `/oneone-preps` | List past 1:1 preps |
| PATCH | `/oneone-preps/:id` | Update a 1:1 prep |
| GET | `/settings` | Get manager settings |
| PATCH | `/settings` | Update manager settings |
| GET | `/team-health` | Get team health cards and action items |

### decisions.ts (3 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List decisions (filterable by space, search) |
| GET | `/:id` | Get single decision |
| PATCH | `/:id` | Update/reverse a decision |

### notifications.ts (3 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List notifications for user |
| PATCH | `/:id/read` | Mark notification as read |
| POST | `/read-all` | Mark all notifications as read |

### bookmarks.ts (4 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List user's bookmarked messages |
| POST | `/` | Bookmark a message |
| DELETE | `/:messageId` | Remove bookmark |
| GET | `/check/:messageId` | Check if message is bookmarked |

### connections.ts (5 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List connected accounts |
| POST | `/:provider/connect` | Start OAuth flow for provider |
| GET | `/:provider/callback` | OAuth callback handler |
| POST | `/:provider/sync` | Trigger manual sync |
| DELETE | `/:provider` | Disconnect provider |

### pins.ts (3 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/:spaceId/pins` | Pin a message |
| DELETE | `/:spaceId/pins/:messageId` | Unpin a message |
| GET | `/:spaceId/pins` | List pinned messages |

### scheduled.ts (3 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Schedule a message |
| GET | `/` | List scheduled messages |
| DELETE | `/:id` | Cancel a scheduled message |

### reminders.ts (3 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Create a reminder |
| GET | `/` | List reminders |
| DELETE | `/:id` | Delete a reminder |

### search.ts (1 endpoint)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Global search across messages, tasks, members |

### recap.ts (1 endpoint)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/:spaceId/recap` | AI-generated catch-up summary for a channel |

### cross-references.ts (2 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tasks/:taskId/references` | Get cross-references for a task |
| GET | `/messages/:messageId/references` | Get cross-references for a message |

### audit.ts (1 endpoint)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Query audit log |

### members.ts (1 endpoint)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List org members |

### upload.ts (2 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Upload a file |
| GET | `/:id` | Serve/download a file |

### user-status.ts (3 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| PATCH | `/status` | Set custom status (emoji + text) |
| PATCH | `/dnd` | Toggle Do Not Disturb |
| DELETE | `/status` | Clear custom status |

### canvas.ts (2 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/:spaceId/canvas` | Get canvas content for a space |
| PATCH | `/:spaceId/canvas` | Update canvas content |

### groups.ts (6 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List user groups |
| POST | `/` | Create a group |
| PATCH | `/:id` | Update group |
| DELETE | `/:id` | Delete group |
| POST | `/:id/members` | Add member to group |
| DELETE | `/:id/members/:userId` | Remove member from group |

### emoji.ts (3 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List custom emoji |
| POST | `/` | Upload custom emoji |
| DELETE | `/:id` | Delete custom emoji |

### workflows.ts (5 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List workflow rules |
| POST | `/` | Create workflow rule |
| PATCH | `/:id` | Update workflow rule |
| DELETE | `/:id` | Delete workflow rule |
| GET | `/:id/runs` | Get run history for a rule |

---

## 5. Real-Time Events (Socket.io)

**Connection events:**

| Event | Direction | Description |
|-------|-----------|-------------|
| `presence:init` | Server -> Client | List of online users on connection |
| `presence:update` | Server -> All | User went online/offline/idle |
| `presence:idle` | Client -> Server | User went idle (5min inactivity) |
| `presence:active` | Client -> Server | User became active again |

**Space events:**

| Event | Direction | Description |
|-------|-----------|-------------|
| `space:join` | Client -> Server | Join a space room for real-time updates |
| `space:leave` | Client -> Server | Leave a space room |
| `space:created` | Server -> Org | New space created |

**Message events:**

| Event | Direction | Description |
|-------|-----------|-------------|
| `message:new` | Server -> Space | New message posted |
| `message:edited` | Server -> Space | Message was edited |
| `message:deleted` | Server -> Space | Message was deleted |
| `message:link_previews` | Server -> Space | Open Graph previews fetched for a message |

**Thread events:**

| Event | Direction | Description |
|-------|-----------|-------------|
| `thread:updated` | Server -> Space | Thread got a new reply |

**Typing events:**

| Event | Direction | Description |
|-------|-----------|-------------|
| `typing:start` | Bidirectional | User started typing in a space |
| `typing:stop` | Bidirectional | User stopped typing |

**Reaction events:**

| Event | Direction | Description |
|-------|-----------|-------------|
| `reaction:added` | Server -> Space | Emoji reaction added |
| `reaction:removed` | Server -> Space | Emoji reaction removed |

**Task events:**

| Event | Direction | Description |
|-------|-----------|-------------|
| `task:created` | Server -> Org | New task created |
| `task:updated` | Server -> Org | Task field changed |
| `task:deleted` | Server -> Org | Task deleted |

**Other events:**

| Event | Direction | Description |
|-------|-----------|-------------|
| `canvas:updated` | Server -> Space | Canvas content changed |
| `notification:new` | Server -> User | New notification for specific user |
| `user_status:changed` | Server -> Org | User status/DND changed |

---

## 6. Frontend Pages & Components

### Pages (13 pages)

| Path | Description |
|------|-------------|
| `/` | Landing/redirect page |
| `/login` | Email/password login |
| `/signup` | Registration form |
| `/setup` | Initial org setup |
| `/(app)/chat` | Team chat (channels + DMs) |
| `/(app)/tasks` | Task management (board + list views) |
| `/(app)/agent` | AI agent conversations |
| `/(app)/dashboard` | Dashboard with metrics, standup, insights |
| `/(app)/settings` | General settings |
| `/(app)/settings/members` | Org member management |
| `/(app)/settings/groups` | User group management |
| `/(app)/settings/integrations` | Connected integrations |
| `/(app)/settings/agent` | Agent settings, action log, trust level |

### Components (31 components)

| Component | Description |
|-----------|-------------|
| `agent-chat.tsx` | Agent conversation UI: message list, streaming, tool calls, citations, approval cards, memory |
| `app-header.tsx` | Top header bar with page title, notifications bell, actions |
| `board-column.tsx` | Single kanban board column with drag-and-drop |
| `canvas-panel.tsx` | Per-space shared canvas editor (TipTap) |
| `command-palette.tsx` | Cmd+K global search across spaces, tasks, members |
| `create-dm-modal.tsx` | Modal for creating direct message conversations |
| `create-project-modal.tsx` | Modal for creating new projects |
| `create-space-modal.tsx` | Modal for creating channels |
| `emoji-picker.tsx` | Emoji reaction picker |
| `empty-state.tsx` | Empty state illustrations for empty channels/lists |
| `file-upload.tsx` | Drag-and-drop file upload with preview |
| `keyboard-shortcuts.tsx` | Keyboard shortcuts help modal |
| `lightbox.tsx` | Image lightbox for viewing image attachments |
| `mention-autocomplete.tsx` | @mention autocomplete dropdown (users + @Deft bot) |
| `notification-panel.tsx` | Notification dropdown panel |
| `pinned-messages.tsx` | Pinned messages bar and dropdown |
| `rich-composer.tsx` | TipTap rich text message editor |
| `saved-messages.tsx` | Bookmarked/saved messages modal |
| `scheduled-panel.tsx` | Scheduled messages panel |
| `sidebar.tsx` | Navigation sidebar: spaces, DMs, nav links, user controls |
| `space-chat.tsx` | Main chat view: messages, threads, unread divider, hover toolbar |
| `space-members-panel.tsx` | Space member list panel |
| `task-autocomplete.tsx` | Task ID autocomplete for references |
| `task-board.tsx` | Full kanban board with columns, drag-and-drop, filters |
| `task-card.tsx` | Individual task card: title, priority badge, assignee, labels, due date badge |
| `task-detail.tsx` | Task detail panel: metadata, subtasks, dependencies, comments, activity |
| `task-filters.tsx` | Task filter controls: status, priority, assignee, label, due date |
| `task-list.tsx` | List view of tasks (alternative to board) |
| `task-quick-create.tsx` | Inline quick task creation form |
| `theme-provider.tsx` | Dark/light mode provider with localStorage persistence |
| `thread-panel.tsx` | Threaded reply side panel |

### Frontend Libraries (5 files)

| File | Description |
|------|-------------|
| `api.ts` | API client with JWT refresh interceptor |
| `auth-context.tsx` | Auth context provider with auto timezone detection |
| `chat-context.tsx` | Chat/spaces context with unread tracking, Socket.io integration |
| `socket.ts` | Socket.io client singleton |
| `time.ts` | Timezone-aware time formatting utilities |

---

## 7. Agent System

### Tools (27 tools)

**Read-only tools (auto-execute):**

| Tool | Description |
|------|-------------|
| `search_messages` | Search chat messages by keyword, space, author |
| `search_tasks` | Search tasks by title, status, assignee, project, priority, overdue |
| `get_task_detail` | Get full task info including comments and activity |
| `get_workspace_stats` | Aggregate metrics: tasks completed/created, messages sent, active users (7/14/30d) |
| `get_team_workload` | Task distribution per team member by status |
| `get_project_progress` | Project completion %, tasks by status, recent activity, blockers |
| `remember` | Store facts/preferences (conversation, user, or org scope) |
| `recall` | Retrieve stored memories by key or scope |
| `search_decisions` | Search past team decisions ("what did we decide about X") |
| `get_user_activity` | Person's recent activity: tasks changed, messages sent, assignments |
| `get_task_dependencies` | Tasks that block or are blocked by a given task |
| `search_blockers` | Search messages for blockers, stuck points, waiting-on items |

**Write tools (require approval):**

| Tool | Description |
|------|-------------|
| `create_task` | Create a new task in a project |
| `update_task_status` | Change task status |
| `assign_task` | Reassign a task |
| `post_message` | Post a message in a channel |

**Calendar tools (when connected):**

| Tool | Description |
|------|-------------|
| `check_calendar` | Query Google Calendar events |
| `create_calendar_event` | Create Google Calendar event (requires approval) |

**GitHub tools (when connected):**

| Tool | Description |
|------|-------------|
| `check_github_prs` | Query GitHub PRs (open, merged, closed) |

**Manager/Team tools:**

| Tool | Description |
|------|-------------|
| `get_team_health` | Health status per team member: activity, overdue tasks, engagement |
| `get_team_performance` | Team velocity: tasks completed per week, trends, per-person breakdown |
| `get_workload_balance` | Work distribution across team, overloaded/underloaded identification |
| `prep_oneone` | Generate 1:1 prep for a report (manager only) |
| `find_expert` | Find who has expertise on a topic |
| `get_team_dynamics` | Collaboration patterns, mentoring pairs, tensions |
| `analyze_skills_gap` | Missing skills and single points of failure |
| `get_burnout_risks` | Team members showing strain signals (manager only) |

### Background Job Handlers (18 handlers)

| Handler | Description |
|---------|-------------|
| `agent-reply` | Generates threaded agent reply when @Deft is mentioned in chat |
| `task-extract` | Extracts task fields from natural language messages |
| `cross-reference` | Links messages mentioning task IDs to the tasks |
| `standup-generate` | Generates daily standup summary at 9am |
| `standup-check` | Checks if standup should be generated (cron trigger) |
| `nudge-check` | Scans for stalled/overdue tasks, sends nudge notifications |
| `meeting-prep-check` | Checks for upcoming meetings, generates prep briefs |
| `embed-content` | Generates vector embeddings for content (future) |
| `index-message` | Indexes a message for search |
| `index-task` | Indexes a task for search |
| `extract-tasks` | Batch task extraction |
| `people-graph` | Builds interaction matrix, expertise, patterns, relationships |
| `manager-pulse` | Generates team health cards and action items |
| `burnout-detect` | Detects burnout signals across org members |
| `blocked-alert` | Alerts on blocked tasks |
| `duplicate-detect` | Detects duplicate tasks |
| `memory-extract` | Extracts memories from conversations |
| `weekly-digest` | Generates weekly summary digest for managers |

### Services (6 service files)

| Service | Description |
|---------|-------------|
| `people-graph.ts` | Builds interaction matrices, extracts expertise from messages/tasks, analyzes communication patterns, detects relationships |
| `manager-pulse.ts` | Generates team health cards (green/yellow/red per person), action items, summary for managers |
| `oneone-prep.ts` | Generates 1:1 meeting preparation: recent tasks, patterns, interaction data, conversation starters |
| `burnout-detector.ts` | Detects 5 burnout signals without exposing message content. Privacy-protected, manager-only alerts |
| `team-analytics.ts` | Velocity calculator (tasks/week trend), workload analyzer (overloaded/underloaded), bottleneck finder, skills gap analysis |
| `weekly-digest.ts` | Comprehensive weekly summary: velocity, completions, decisions, nudges, burnout status |

### LLM Routing

| Task Type | Default Model | Used For |
|-----------|--------------|----------|
| `classify` | Claude Haiku 4.5 | Message intent classification, urgency detection |
| `summarize` | Claude Haiku 4.5 | Catch-up summaries, standups, meeting prep briefs |
| `reason` | Claude Sonnet 4 | Agent chat, @agent replies, complex queries with tool use |
| `extract` | Claude Haiku 4.5 | Task field extraction from natural language |

**Supported providers:** Anthropic, OpenAI, OpenRouter, Ollama.
Org-level overrides allow custom model selection per task type.

### Memory System

- **Conversation scope:** Facts about the current discussion
- **User scope:** Preferences that persist across all conversations for that user
- **Org scope:** Team-wide knowledge visible to everyone
- Memories injected into system prompt automatically
- Agent decides when to store/recall via `remember` and `recall` tools

### Decision Log

- Decisions extracted from chat messages and stored in `decisions` table
- Searchable via `search_decisions` agent tool
- Tags for categorization (e.g., "payments", "infrastructure")
- Reversible with `is_reversed` flag
- API endpoints for listing, viewing, and updating decisions

---

## 8. Manager Intelligence

### People Graph

Built nightly by the `people-graph` background job:

- **Interaction matrix:** Tracks message counts, DM counts, @mentions, thread co-participation between every pair of users. Recency-weighted scoring.
- **Expertise extraction:** Identifies per-user expertise topics from messages, questions answered, tasks completed. Scored and ranked.
- **Influence detection:** Classifies influence types: decision_maker, blocker_resolver, reviewer, connector, mentor. Evidence-based scoring.
- **Pattern analysis:** Tracks active hours, response time, communication style, activity trends, collaboration preferences. Baseline comparison.
- **Relationship detection:** Identifies close collaborators, mentor/mentee pairs, tensions, delegation chains, cross-team bridges. Strength and direction tracked.

### Manager Pulse

Generated by the `manager-pulse` handler:

- **Health cards:** Per-member status card (green/yellow/red) with insight text, active task count, overdue tasks, message count, blockers.
- **Action items:** Prioritized list of actions the manager should take (e.g., "check in with Rahul who has 3 overdue tasks").
- **Team health snapshots:** Point-in-time snapshots stored for trend analysis.

### 1:1 Prep Generation

Generated by `oneone-prep` service:

- Looks back since last 1:1 or 14 days
- Gathers report's tasks, status changes, messages, patterns, interactions
- AI generates structured prep: accomplishments, concerns, talking points, questions to ask
- Stored in `oneone_preps` table, accessible via manager API

### Burnout Detection

5 signals analyzed (without reading message content):

1. **After-hours messaging patterns** — working outside normal hours
2. **Response time degradation** — slower replies than baseline
3. **Activity volume changes** — sudden increase or decrease
4. **Communication style shifts** — shorter messages, less engagement
5. **Task overload indicators** — too many in-progress tasks, overdue items

Privacy enforcement: alerts sent only to the manager in `alerted_to`. No message content included, only patterns.

### Team Analytics

- **Velocity calculator:** Tasks completed per week over 4-week window, per-person breakdown, trend detection (increasing/stable/declining)
- **Workload analyzer:** Distribution of active tasks across team, overloaded and underloaded identification
- **Bottleneck finder:** Tasks stuck in review, blocked items, single-assignee bottlenecks
- **Skills gap analysis:** Missing expertise areas, single points of failure, hiring recommendations

### Weekly Digest

Generated by `weekly-digest` handler:

- Velocity this week vs. 4-week average
- Tasks completed, created, overdue
- Key decisions made this week
- Burnout alerts status
- Nudges sent and outcomes
- AI-generated summary narrative

### Privacy Enforcement

- Burnout alerts never contain message content
- DM content never included in interaction matrix (only counts)
- Burnout data accessible only to the specific manager in `alerted_to`
- Manager settings control which features are enabled
- All people data scoped to `org_id`

---

## 9. Chat Features

**Channels & DMs:**
- Public and private channels with descriptions and topics
- Direct messages (1:1) and group DMs
- Create, archive, leave channels
- Channel member management (add/remove)
- Double-click channel name to rename

**Messaging:**
- Rich text editing via TipTap (bold, italic, strikethrough, code, code blocks, blockquotes, lists, links)
- Threaded replies (side panel)
- Message editing and deletion (soft delete)
- Emoji reactions (click to add/remove, hover to see who reacted)
- File attachments (images, documents) with drag-and-drop upload
- Link previews (Open Graph metadata fetched automatically)
- @mentions with autocomplete (users + @Deft for agent)
- Message search across all spaces
- Edit last message with Up arrow in empty composer

**Unread tracking (Slack-style):**
- Per-space last-read position tracking
- Unread count badges in sidebar (actual numbers)
- "New messages" red divider line between read and unread
- Real-time unread increment via Socket.io
- Shift+Esc to mark all read, Cmd+Shift+M for current space

**Pinned messages:**
- Pin/unpin from hover toolbar
- Persistent pinned bar at top of chat
- Expandable dropdown showing all pins
- Click to jump to original message

**Message bookmarks (saved messages):**
- Bookmark icon in message hover toolbar
- "Saved Items" modal from sidebar
- Shows all bookmarked messages across channels
- Click to navigate to the message

**Scheduled messages:**
- Schedule from composer
- View/cancel scheduled messages panel
- Auto-delivers at scheduled time

**Reminders:**
- "Remind me" option in message menu (20 min, 1 hour, 3 hours, tomorrow 9am)
- Notification at reminder time

**Catch-up summary:**
- "Catch Up" button in channel header
- AI-generated summary of unread messages
- Highlights decisions, action items, questions

**@Deft in chat:**
- Autocomplete suggests "Deft" with bot badge
- Agent receives message + thread context (last 10 messages)
- Responds as threaded reply (background job, 5-15 seconds)
- Works in any channel or DM

**Task references:**
- Task IDs in chat auto-detected (DEFT-7)
- Cross-reference created linking message to task
- Comment added to the task with discussion excerpt

**Real-time features:**
- Typing indicators ("Rahul is typing...")
- Online/idle/offline presence dots
- Idle detection (5 min inactivity)
- Live message updates (edits, deletions, reactions)
- "Jump to latest" floating button

**Message UI:**
- Message grouping (same author within 5 min)
- Day separators (Today, Yesterday, date headers)
- System messages (task status changes)
- Hover toolbar: React, Reply, Pin, Bookmark, Create Task, More (Edit, Copy Link, Remind Me, Delete)
- Delete confirmation dialog
- Edit mode with Escape/Enter hints

---

## 10. Task Features

**Projects:**
- Create with name, description, prefix (DEFT), icon color
- Project lead assignment
- Link projects to chat spaces
- Archive projects

**Tasks:**
- Task identifiers: PREFIX-NUMBER (DEFT-7)
- Status workflow: Backlog > Todo > In Progress > In Review > Done / Cancelled
- Priority levels: P0 (Critical), P1 (High), P2 (Medium), P3 (Low)
- Assignee (single user)
- Due dates with overdue/due-today badges (red for overdue, amber for due today)
- Rich text descriptions
- Labels (colored tags, many-to-many)
- Soft delete with historical context preservation

**Subtasks:**
- One level deep (parent_task_id on tasks table)
- Create subtasks from task detail panel
- Toggle subtask completion
- Navigate between parent and child tasks

**Dependencies:**
- Relationship types: blocks, relates_to, duplicates
- Add/view/remove dependencies from task detail
- Agent can query dependencies via `get_task_dependencies` tool

**Bulk operations:**
- Select mode for multiple task selection
- Bulk status change
- Bulk delete
- Bulk priority and assignee update

**Kanban board:**
- Drag-and-drop between status columns (dnd-kit)
- Optimistic updates
- Task cards: title, priority badge, assignee avatar, label dots, due date badge
- Column task counts

**Task detail panel:**
- Full metadata editing
- Subtask list
- Dependency list
- Comment thread with rich text
- Activity log (status changes, assignments, priority changes)
- Linked discussions (cross-references from chat)

**Task views:**
- Board view (Kanban)
- List view
- Filters: status, priority, assignee, label, due date
- My Tasks filter
- Saved views (shareable filter configurations)

**Task duplicate:**
- Duplicate task endpoint copies all fields

**Integrations:**
- Create task from chat message (hover toolbar)
- Task IDs in chat auto-link
- Task status changes post to linked spaces
- Agent can create/update/assign tasks with approval

---

## 11. Design System ("Obsidian")

**Philosophy:** "The Quiet Workspace" — tonal layering with no borders, calm density, reduced visual noise.

**Color system:**
- Dark mode (default): #0E0E10 > #39393B surface hierarchy
- Light mode: full override via CSS custom properties
- Muted violet accent (#9080FA)
- Status colors: red, amber, green, blue, gray
- All colors via CSS variables — zero hardcoded values

**Typography:** Inter (UI) + JetBrains Mono (code/data)

**Components:**
- Ghost borders (5-10% opacity, accessibility only)
- Glassmorphism for floating elements (blur + shadow)
- 4px spacing grid
- Architectural radius (0.125-0.75rem, not bubbly)
- 150ms cubic-bezier transitions
- Custom thin scrollbars

**Theming:**
- Dark/light toggle in sidebar (sun/moon icon)
- Persisted to localStorage
- All components respect CSS variables

---

## 12. Timezone System

**Shared utility:** `apps/web/src/lib/time.ts`

- Module-level timezone set once on login
- Auto-detect from browser: `Intl.DateTimeFormat().resolvedOptions().timeZone`
- Falls back to stored user timezone from DB
- Auto-patches DB if user has default "UTC" but browser reports different timezone

**Formatting functions:**
- `formatTime(iso)` — "2:30 PM"
- `formatDate(iso)` — "Mar 28, 2026"
- `formatDateTime(iso)` — "Mar 28, 2:30 PM"
- `formatDayHeader(iso)` — "Today", "Yesterday", or "SATURDAY, MAR 28"
- `formatTimeWithZone(iso)` — "2:30 PM EDT"
- `formatTimeWithSenderZone(iso, senderTimezone)` — hover tooltip showing sender's timezone

**Usage:**
- All timestamps in chat formatted via shared utility
- Hover over message time shows sender's timezone
- Day separators computed in user's timezone
- Per-user timezone stored in `users.timezone` column

---

## 13. Background Job Queue

**Implementation:** Postgres-based, no Redis required.

Uses `SELECT ... FOR UPDATE SKIP LOCKED` pattern on the `job_queue` table.

**Worker:** Polls every 3 seconds for pending jobs.

**Job table fields:**
- `queue` — job queue name (agent-jobs, scheduled-jobs)
- `name` — job type (agent-reply, standup-generate, etc.)
- `data` — JSONB payload
- `status` — pending / running / completed / failed
- `attempts` / `max_attempts` — retry tracking
- `run_at` — for delayed/scheduled jobs
- `cron_key` — for repeatable jobs (prevents duplicates)

**Reliability:**
- Exponential backoff on failure (1s, 2s, 4s... up to 60s)
- Configurable max attempts (default 3)
- Failed jobs retained with error messages
- Cron jobs self-re-enqueue after completion
- Jobs survive server restarts (persisted in Postgres)

**Cron jobs:**
- Standup generation — hourly check, runs at 9am org timezone
- Nudge check — hourly scan for stalled/overdue tasks
- Meeting prep check — every 15 minutes
- People graph build — nightly
- Burnout detection — periodic
- Weekly digest — weekly

---

## 14. Integrations

### Google Calendar
- OAuth 2.0 connection flow
- Read calendar events
- Agent can check upcoming meetings (`check_calendar` tool)
- Agent can create events (`create_calendar_event` tool, requires approval)
- Events stored in unified `events` table
- Meeting prep briefs generated for upcoming meetings

### GitHub
- OAuth connection flow
- Check open/merged/closed PRs (`check_github_prs` tool)
- Events stored in unified `events` table

### Architecture
All external data stored in the `events` table with `source` (google_calendar, github, slack, gmail, linear) and `event_type` columns. Agent queries native data + events together in one SQL query.

### Future: MCP (Model Context Protocol)
Planned support for MCP to allow third-party tool integrations without custom code.

---

## 15. Security & Privacy

**Authentication:**
- Custom JWT: 15-minute access tokens, 30-day refresh tokens
- Password hashing (bcrypt)
- Email verification support
- Per-user session management

**Multi-tenant isolation:**
- `org_id` on every table
- Every query filters by org_id
- No cross-org data leakage

**Privacy guard:**
- Burnout alerts never contain message content — only patterns
- DM content excluded from interaction matrix (only counts)
- Burnout data accessible only to the specific manager in `alerted_to`
- Agent memory scoped to user/conversation/org
- Soft deletes preserve context without exposing deleted content

**OAuth token security:**
- Connected account tokens encrypted at rest (`access_token_encrypted`)
- Separate encryption for refresh tokens

**Audit log:**
- Every agent action logged with actor, entity, before/after state
- Undo actions also logged
- Queryable via API

**Decision log:**
- Team decisions tracked with context and reversibility

---

## 16. Deployment

### Self-Hosted (Docker Compose)

```bash
git clone https://github.com/deft-labs/deft.git
cd deft
cp .env.example .env
# Edit .env: set JWT secrets, add AI API key
docker-compose up -d
docker-compose exec deft npx tsx packages/db/seed.ts
# Access at http://localhost:3000
```

**Requirements:**
- Docker + Docker Compose
- 2GB RAM minimum
- PostgreSQL 16 (included in docker-compose)
- AI API key (Anthropic, OpenAI, OpenRouter, or local Ollama)

### Managed SaaS (additional infrastructure)

- Load balancer (nginx/Cloudflare)
- Managed PostgreSQL (Neon, RDS)
- Cloudflare R2 for file storage
- Redis (optional, for Socket.io adapter at scale)
- Stripe for billing
- Sentry for error tracking
- Vercel for frontend, Railway/Fly.io for API (WebSocket support needed)

### Seed Data

The seed script creates a realistic test environment:
- **Users:** Maneek (owner), Rahul, Priya, Arjun, Sara — all with password `test1234`
- **Org:** Deft Labs
- **Spaces:** #general, #engineering, #design, #random, 3 DMs
- **Messages:** 100+ messages including a 50-message engineering conversation
- **Projects:** Deft v1 (15 tasks), Design System (8 tasks)
- **Notifications:** 6 pre-seeded for Maneek

---

*Last updated: April 2026*
