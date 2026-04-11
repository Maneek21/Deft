# Deft — Product Documentation

**Version:** Pre-Alpha (April 2026)
**License:** BSL 1.1 — Use for any purpose except hosting as a service for third parties. Mandatory attribution in forks.

---

## 1. What is Deft?

Deft is an open-source AI-native workspace that combines team chat, task management, and an AI agent into a single product. The AI agent has direct SQL access to all native data — not API calls — making it fundamentally faster and more context-aware than bolt-on AI features in existing tools.

**Target users:** Engineering teams (5-50 people) who currently juggle Slack + Linear/Jira + scattered AI tools. Deft replaces all three with one integrated surface.

**Two deployment modes:**
- **Self-hosted (open source):** Docker Compose with Postgres and the app. No Redis, no external dependencies beyond a database.
- **Managed SaaS:** Hosted multi-tenant service with usage-based AI billing.

---

## 2. Architecture Overview

```
deft/
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

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Next.js 16, React 19, Tailwind CSS 4, TipTap | App Router for server components, TipTap for rich editing |
| API | Hono on Node.js | Lightweight, fast, native TypeScript, WebSocket support |
| Database | PostgreSQL 16 + Drizzle ORM | 47 tables, multi-tenant, SKIP LOCKED for job queue |
| Real-time | Socket.io | Presence, typing indicators, live message updates |
| Auth | Custom JWT (access 15min + refresh 30d) | Simple, stateless, no third-party dependency |
| Background jobs | Postgres job queue (SKIP LOCKED) | Zero external dependencies — no Redis needed |
| AI | Multi-model LLM router | Anthropic, OpenAI, OpenRouter, Ollama supported |
| File storage | Local filesystem (R2/S3 ready) | Presigned upload architecture built in |
| Email | Resend | Transactional email (invites, notifications) |
| Icons | Lucide React | Consistent stroke weight, tree-shakeable |
| Drag & Drop | dnd-kit | Kanban board, task reordering |
| Monorepo | pnpm workspaces | Fast installs, strict dependency isolation |

**Key design decisions:**
1. **Agent reads native data via direct SQL** — not API calls. This is the core technical advantage.
2. **Product works fully without AI** — if the LLM is down or no API key is configured, chat + tasks function normally. Every AI feature has a non-AI fallback.
3. **Multi-tenant from day 1** — `org_id` on every table, every query. Row-level isolation.
4. **No Redis required** — background jobs use Postgres SKIP LOCKED. Self-hosters need only Postgres + the app.
5. **Multi-model routing** — different LLM providers for different task types. Self-hosters bring their own keys.

---

## 3. Feature Inventory

### 3.1 Team Chat

A full Slack-equivalent real-time messaging system.

**Channels & DMs:**
- Public and private channels with descriptions and topics
- Direct messages (1:1) and group DMs
- Create/archive/leave channels
- Channel member management (add/remove)

**Messaging:**
- Rich text editing via TipTap (bold, italic, strikethrough, code, code blocks, blockquotes, lists, links)
- Threaded replies (side panel)
- Message editing and deletion (soft delete)
- Emoji reactions (click to add/remove, hover to see who reacted)
- File attachments (images, documents) with drag-and-drop upload
- Link previews (Open Graph metadata fetched automatically)
- @mentions with autocomplete (users + @deft for agent)
- Message search across all spaces

**Unread tracking (Slack-style):**
- Per-space last-read position tracking (`last_read_message_id`, `last_read_at`)
- Unread count badges in sidebar (actual numbers, not just dots)
- "New messages" red divider line in chat between read and unread messages
- Initial unread counts fetched from DB on page load (survives refresh)
- Real-time unread increment via Socket.io when messages arrive in other channels

**Pinned messages:**
- Pin/unpin messages from the hover toolbar
- Persistent pinned bar at top of chat showing the latest pin
- Expandable dropdown showing all pinned messages
- Click to jump to the original message

**Message bookmarks (saved messages):**
- Bookmark icon in message hover toolbar (filled when saved)
- "Saved Items" modal accessible from sidebar
- Shows all bookmarked messages across all channels with author, channel, date
- Click to navigate to the message

**Scheduled messages:**
- Schedule a message for later from the composer
- View/cancel scheduled messages panel
- Auto-delivers at scheduled time

**Reminders:**
- "Remind me" option in message menu (20 min, 1 hour, 3 hours, tomorrow 9am)
- Notification delivered at reminder time

**Catch-up summary:**
- "Catch Up" button in channel header
- AI-generated summary of recent/unread messages
- Highlights key decisions, action items, questions
- Falls back to summarizing latest 50 messages if all are already read

**Real-time features:**
- Typing indicators ("Rahul is typing...")
- Online/idle/offline presence dots on avatars
- Idle detection (5 min inactivity → idle status)
- Live message updates (edits, deletions, reactions)
- "Jump to latest" floating button when scrolled up

**User experience:**
- Message grouping (same author within 5 min → compact layout)
- Day separators (Today, Yesterday, date headers)
- System messages (task status changes posted to linked channels)
- Hover toolbar: React, Reply, Pin, Bookmark, Create Task, More (Edit, Copy Link, Remind Me, Delete)
- Message delete confirmation dialog
- Edit mode with "Editing" label and Escape/Enter hints

### 3.2 Task Management

A Linear-equivalent project and task management system.

**Projects:**
- Create projects with name, description, prefix (e.g., "DEFT"), icon color
- Project lead assignment
- Link projects to chat spaces
- Archive projects

**Tasks:**
- Task identifiers: PREFIX-NUMBER (e.g., DEFT-7)
- Status workflow: Backlog → Todo → In Progress → In Review → Done / Cancelled
- Priority levels: P0 (Critical), P1 (High), P2 (Medium), P3 (Low)
- Assignee (single user)
- Due dates
- Rich text descriptions
- Labels (colored tags, many-to-many)
- Task relationships (blocks, relates to, duplicates)
- Sort ordering within columns
- Soft delete with historical context preservation

**Kanban board:**
- Drag-and-drop between status columns (dnd-kit)
- Optimistic updates (UI updates instantly, API call in background)
- Task cards showing: title, priority badge, assignee avatar, label dots
- Column task counts

**Task detail panel:**
- Full task metadata editing
- Comment thread with rich text
- Activity log (status changes, assignments, priority changes)
- Linked discussions (cross-references from chat messages)

**Task views:**
- Board view (Kanban)
- List view
- Filters: status, priority, assignee, label, due date
- Saved views (shareable filter configurations)

**Integrations:**
- Create task from chat message (hover toolbar → Create Task)
- Task identifiers in chat auto-link (DEFT-7 becomes clickable)
- Task status changes post to linked chat spaces
- Agent can create/update/assign tasks with approval

### 3.3 AI Agent

The core differentiator. A workflow engine — not a chatbot.

**Agent chat interface:**
- Dedicated `/agent` page with conversation history
- SSE streaming with word-by-word typing effect
- Tool call status indicators ("Searching tasks...")
- Citation badges linking to source tasks/messages
- Confidence indicators (high/limited/low based on citations)
- Follow-up suggestion chips
- Conversation persistence (load from DB on revisit)
- Stop button to abort mid-stream
- Conversation list in sidebar

**Read-only tools (auto-execute):**
| Tool | What it does |
|------|-------------|
| `search_messages` | Search chat messages by keyword, space, author |
| `search_tasks` | Search tasks by title, status, assignee, project, priority, overdue |
| `get_task_detail` | Get full task info including comments and activity |
| `get_workspace_stats` | Aggregate metrics: tasks completed/created, messages sent, active users over 7/14/30 days |
| `get_team_workload` | Task distribution per team member by status |
| `get_project_progress` | Project completion %, tasks by status, overdue count, recent activity |
| `check_calendar` | Query Google Calendar events (if connected) |
| `check_github_prs` | Query GitHub PRs (if connected) |
| `remember` | Store facts/preferences (per conversation or per user) |
| `recall` | Retrieve stored memories |

**Write tools (require approval):**
| Tool | What it does |
|------|-------------|
| `create_task` | Create a new task in a project |
| `update_task_status` | Change task status |
| `assign_task` | Reassign a task |
| `post_message` | Post a message in a channel |
| `create_calendar_event` | Create Google Calendar event (if connected) |

**Approval flow:**
1. Agent proposes an action → approval card shown to user
2. User clicks Approve → action executed, result shown
3. User clicks Reject → action cancelled
4. After approval: Undo available for 5 minutes
5. All actions logged in audit trail with before/after state

**Agent undo system:**
- `update_task_status` → reverts to previous status
- `assign_task` → reverts to previous assignee
- `create_task` → soft-deletes the task
- `post_message` → soft-deletes the message
- All undos logged in audit trail

**Agent memory:**
- Per-conversation memory (facts about this discussion)
- Per-user memory (preferences that persist across conversations)
- Injected into system prompt automatically
- Agent decides when to store/recall via tools

### 3.4 @Agent Mentions in Chat

Type `@Deft` in any channel to invoke the agent inline.

- Autocomplete suggests "Deft" with a bot badge when typing @
- Agent receives the message + thread context (last 10 messages)
- Responds as a threaded reply within 5-15 seconds (background job)
- Uses the full tool suite (search, task detail, analytics)
- Works in any channel or DM

### 3.5 Proactive Agent Features

Background jobs that run automatically.

**Daily standup generation:**
- Runs at 9am per org timezone (cron)
- Gathers last 24h: task status changes, new tasks, message volume, active users
- AI-generated summary posted to #general
- Also available on dashboard with "Generate Now" button
- Falls back to structured text summary if no AI key

**Proactive nudges:**
- Hourly scan for stalled tasks (in_progress > 48h with no update)
- Hourly scan for overdue tasks (past due date, not done)
- Sends notification to assignee: "DEFT-5 has been in progress for 3 days with no updates"
- Deduplicates within 24h (won't re-nudge for same task)

**Meeting prep briefs:**
- Checks every 15 minutes for calendar events starting in 10-20 minutes
- Gathers context: attendee tasks, recent messages, related topics
- AI-generated 3-bullet prep brief
- Delivered as notification

**Natural language task creation:**
- Every message classified by AI (intent, confidence, entities)
- High-confidence task intents trigger extraction
- User gets an inline suggestion card: "Deft suggests: Create task 'Fix reconnection bug'"
- Accept creates the task, Dismiss hides the card

**Cross-reference intelligence:**
- Messages mentioning task IDs (e.g., DEFT-7) auto-detected
- Cross-reference created linking message ↔ task
- Comment added to the task: "Discussed in #engineering: [excerpt]"
- Queryable via API for task detail views

### 3.6 Notifications

**Notification types:**
- Channel messages ("Rahul in #engineering")
- Direct messages ("Priya sent you a message")
- @mentions ("Arjun mentioned you")
- Thread replies ("Rahul replied to your message")
- Task assignments ("Sara assigned you DEFT-8")
- Task status changes ("Rahul moved DEFT-10 to In Review")
- Reminders ("Reminder: [message]")
- Agent suggestions ("Create task: Fix reconnection bug?")
- Agent nudges ("DEFT-5 has been in progress for 3 days")

**Notification UI:**
- Bell icon in header with real-time unread count badge
- Dropdown panel with full notification list
- Click to navigate to source
- Mark individual or all as read
- Real-time updates via Socket.io

### 3.7 Dashboard

- Morning pulse: active tasks, recent activity, upcoming events
- Daily standup section (AI-generated or "Generate Now")
- Quick actions
- Unread channels with message preview
- Team activity feed

### 3.8 Connected Integrations

**Google Calendar:**
- OAuth 2.0 connection flow
- Read calendar events
- Agent can check upcoming meetings
- Agent can create calendar events (with approval)
- Events stored in unified `events` table

**GitHub:**
- OAuth connection flow
- Check open/merged/closed PRs
- Agent can query PR status
- Events stored in unified `events` table

**Architecture:** All external data stored in a single `events` table with `source` and `event_type` columns. Agent queries native data + events together in one SQL query.

### 3.9 Design System ("Obsidian")

**Philosophy:** "The Quiet Workspace" — tonal layering with no borders, calm density, reduced visual noise.

**Color system:**
- Dark mode (default): #0E0E10 → #39393B surface hierarchy
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
- Dark/light toggle in sidebar
- Persisted to localStorage
- All components respect CSS variables

### 3.10 Additional Features

**Sidebar:**
- Collapsible (240px → 48px), persisted to localStorage
- Navigation: Dashboard, Chat, Tasks, Agent, Settings
- Space list with unread badges
- DM list with presence indicators
- Bottom bar: user status, saved messages, DND toggle, theme toggle, more menu (settings, logout)

**Do Not Disturb:**
- One-click DND toggle in sidebar (bell icon)
- Sets status emoji to moon + "Do Not Disturb" text
- Broadcasts to all org members via Socket

**User status:**
- Custom emoji + text status
- Preset statuses (Working remotely, On lunch, On vacation, Heads down, Out sick)
- Expiration timer support
- Real-time broadcast to org

**Canvas:**
- Per-space shared canvas (TipTap editor)
- Auto-saves with 1s debounce
- Editable title
- Toggle panel from channel header

**Command palette (Cmd+K):**
- Global search across spaces, tasks, members
- Quick navigation

**Keyboard shortcuts:**
- `?` — show shortcuts help
- `G then D/C/T/A/S` — navigate to Dashboard/Chat/Tasks/Agent/Settings
- `Shift+Esc` — mark all read
- `Cmd+Shift+M` — mark current space read

**Custom emoji:**
- Upload custom emoji per org
- API for CRUD

**User groups:**
- Create named groups with handles
- Add/remove members
- Foundation for @group mentions

**Workflow rules:**
- Trigger types: keyword in message, new member joins, reaction added
- Action types: create task, send message, notify user
- Enable/disable per rule
- Run history tracking

---

## 4. Database Schema

47 tables across 11 domains:

| Domain | Tables | Key Table |
|--------|--------|-----------|
| Auth & Orgs | 4 | `users`, `orgs`, `org_members`, `invites` |
| Chat & Spaces | 7 | `spaces`, `messages`, `reactions`, `pinnedMessages`, `messageBookmarks`, `scheduledMessages` |
| Files | 1 | `files` |
| Projects & Tasks | 7 | `projects`, `tasks`, `taskComments`, `taskActivity`, `labels`, `taskLabels`, `taskRelationships` |
| Agent | 7 | `agentConversations`, `agentMessages`, `agentActions`, `agentMemory`, `agentNudges`, `skills`, `tools` |
| Notifications | 1 | `notifications` |
| Views & Favorites | 2 | `savedViews`, `favorites` |
| Connections & Events | 2 | `connectedAccounts`, `events` |
| Collaboration | 5 | `canvases`, `userGroups`, `userGroupMembers`, `customEmoji`, `crossReferences` |
| Automation | 2 | `workflowRules`, `workflowRuns` |
| Infrastructure | 4 | `jobQueue`, `standups`, `meetingBriefs`, `auditLog`, `onboardingState`, `reminders` |

**Design principles:**
- `org_id` on every table (multi-tenant isolation)
- Soft deletes everywhere (agent needs historical context)
- `created_at`, `updated_at` on every table
- UUIDs for primary keys (crypto.randomUUID)
- JSONB for flexible metadata
- Indexed for common query patterns

---

## 5. API Surface

90+ REST endpoints organized across 18 route modules:

| Module | Endpoints | Auth |
|--------|-----------|------|
| Auth | 5 | Public |
| Spaces | 10 | Protected |
| Messages | 8 | Protected |
| Tasks | 12+ | Protected |
| Projects | 5 | Protected |
| Agent | 10 | Protected |
| Notifications | 3 | Protected |
| Bookmarks | 4 | Protected |
| Dashboard | 2 | Protected |
| Connections | 5 | Protected |
| Members | 1 | Protected |
| Upload | 2 | Protected |
| Pins | 3 | Protected |
| Scheduled | 3 | Protected |
| Reminders | 3 | Protected |
| Recap | 1 | Protected |
| Cross-References | 2 | Protected |
| Audit | 1 | Protected |
| Search | 1 | Protected |
| User Status | 3 | Protected |
| Canvas | 2 | Protected |
| Groups | 5 | Protected |
| Emoji | 3 | Protected |
| Workflows | 5 | Protected |

---

## 6. Real-Time Events (Socket.io)

25+ event types across 8 categories:

- **Presence:** init, update, idle, active
- **Messages:** new, edited, deleted, pinned, unpinned, link_previews
- **Typing:** start, stop
- **Threads:** updated
- **Reactions:** added, removed
- **Tasks:** created, updated, deleted
- **Canvas:** updated
- **Notifications:** new
- **User status:** changed
- **Spaces:** created

---

## 7. Multi-Model LLM System

**Task-based routing:**

| Task | Default Model | Used For |
|------|--------------|----------|
| `classify` | Claude Haiku | Message intent classification, urgency detection |
| `summarize` | Claude Haiku | Catch-up summaries, standups, meeting prep briefs |
| `reason` | Claude Sonnet | Agent chat, @agent replies, complex queries with tool use |
| `extract` | Claude Haiku | Task field extraction from natural language |

**Supported providers:**
- **Anthropic** — Claude models (default)
- **OpenAI** — GPT-4o, GPT-4o-mini
- **OpenRouter** — Access to 100+ models (Qwen, Kimi, Llama, Mistral, etc.)
- **Ollama** — Local models (Qwen 2.5, Llama 3, Mistral, etc.)

**Self-hosted model selection:**
Self-hosters configure their preferred provider per task type via environment variables. The `DEFAULT_ROUTES` in `apps/api/src/lib/llm.ts` can be modified, or org-level config can override at runtime.

---

## 8. Background Job System

**Postgres-based job queue** — no Redis required.

Uses `SELECT ... FOR UPDATE SKIP LOCKED` pattern on the `job_queue` table. Worker polls every 3 seconds.

**Job types:**

| Job | Queue | Trigger | Description |
|-----|-------|---------|-------------|
| `agent-reply` | agent-jobs | @deft mention in chat | Generate agent reply in thread |
| `task-extract` | agent-jobs | Message classified as actionable | Extract task fields, show suggestion |
| `cross-reference` | agent-jobs | Message contains task ID | Link message to task |
| `embed-content` | agent-jobs | Message/task created | Generate vector embedding (future) |
| `standup-generate` | scheduled-jobs | Cron (hourly) | Generate daily standup at 9am |
| `nudge-check` | scheduled-jobs | Cron (hourly) | Find stalled/overdue tasks |
| `meeting-prep-check` | scheduled-jobs | Cron (every 15min) | Generate meeting prep briefs |

**Reliability:**
- Exponential backoff on failure (1s, 2s, 4s... up to 60s)
- Configurable max attempts (default 3)
- Failed jobs retained with error messages for debugging
- Cron jobs self-re-enqueue after completion
- Jobs survive server restarts (persisted in Postgres)

---

## 9. What's Needed for Pilot Readiness

### 9.1 Critical (Must Have Before Pilot)

**1. End-to-end auth hardening**
- [ ] Replace dev JWT secrets with proper random keys
- [ ] Add CSRF protection
- [ ] Rate limit login attempts (5/min per IP)
- [ ] Password reset flow (currently no "Forgot password" functionality)
- [ ] Email verification enforcement (currently optional)
- [ ] Session invalidation on password change

**2. Rate limiting**
- [ ] Per-user rate limiting on API endpoints (token bucket)
- [ ] Per-org rate limiting for AI features (prevent one org from exhausting API credits)
- [ ] Message send rate limit (e.g., 60/min per user)
- [ ] File upload size/count limits enforced server-side

**3. Input validation & security**
- [ ] Audit all endpoints for SQL injection (Drizzle ORM handles most, but raw `sql` template usages need review)
- [ ] XSS prevention on message content rendering (currently uses `dangerouslySetInnerHTML` in places)
- [ ] Content Security Policy headers
- [ ] CORS configuration for production domains
- [ ] File upload type validation (prevent executable uploads)

**4. Error handling**
- [ ] Replace all empty `catch {}` blocks with proper error logging
- [ ] Add Sentry or equivalent error tracking
- [ ] API error responses are consistent (`{ error, code }` everywhere)
- [ ] Client-side error boundaries for React components

**5. Data integrity**
- [ ] Foreign key cascade rules review (what happens when a user is deleted?)
- [ ] Orphan record cleanup (messages in deleted spaces, etc.)
- [ ] Database backup strategy documentation
- [ ] Migration safety (currently mixing Drizzle push + manual SQL)

**6. File storage**
- [ ] Configure Cloudflare R2 or AWS S3 for production file storage
- [ ] Presigned upload URLs (architecture exists, needs production config)
- [ ] File size limits enforced
- [ ] Image thumbnail generation
- [ ] CDN for serving files

### 9.2 Important (Should Have for Pilot)

**7. Notification delivery**
- [ ] Email notifications for offline users (Resend integration exists but not wired to notifications)
- [ ] Push notifications (Web Push API)
- [ ] Per-user notification preferences (mute channels, mention-only mode)
- [ ] Notification batching (don't send 50 emails for 50 messages in a channel)

**8. Search**
- [ ] Global search UI improvements (current command palette is basic)
- [ ] Full-text search with PostgreSQL `tsvector` or pgvector semantic search
- [ ] Search within specific channels/projects
- [ ] Search result highlighting

**9. Onboarding**
- [ ] Complete onboarding flow (currently has schema but UI is minimal)
- [ ] Invite by email (Resend integration)
- [ ] Invite by link (token-based)
- [ ] First-run tutorial/tooltips
- [ ] Sample data option for new orgs

**10. Mobile responsiveness**
- [ ] Sidebar has mobile hamburger menu (exists) but content views need responsive layouts
- [ ] Touch-friendly tap targets
- [ ] Mobile-optimized composer

**11. Performance**
- [ ] Message pagination (cursor-based, partially implemented)
- [ ] Virtual scrolling for long message lists
- [ ] Image lazy loading
- [ ] Response caching for dashboard, space list (5-30s TTL)
- [ ] Database connection pooling (PgBouncer for production)
- [ ] Batch notification inserts (currently one INSERT per notification per member)

**12. Admin tools**
- [ ] Org admin panel (manage members, billing, AI usage)
- [ ] User management (deactivate, role changes)
- [ ] Audit log viewer UI
- [ ] Usage analytics dashboard

### 9.3 Nice to Have (Post-Pilot)

**13. Semantic search (pgvector)**
- [ ] Enable pgvector extension
- [ ] Generate embeddings on message/task creation
- [ ] Vector similarity search for "find conversations about X"
- [ ] Integrate with agent search tools

**14. Thread improvements**
- [ ] Thread panel UX polish
- [ ] "Following" threads
- [ ] Thread notifications separate from channel notifications

**15. Advanced task features**
- [ ] Sprints/milestones
- [ ] Time tracking
- [ ] Dependencies visualization
- [ ] Bulk task operations
- [ ] Import from Linear/Jira

**16. Integrations**
- [ ] Slack import (migrate channels + history)
- [ ] Gmail integration (read/draft emails via agent)
- [ ] Linear integration (bi-directional task sync)
- [ ] Webhook system (outgoing webhooks for custom integrations)

**17. AI billing**
- [ ] Token usage tracking per org
- [ ] Usage caps (free tier: X tokens/month)
- [ ] Billing integration (Stripe)
- [ ] Usage dashboard for org admins

**18. Multi-model settings UI**
- [ ] Settings page for org admins to configure LLM provider per task type
- [ ] API key input for self-hosted (currently env vars only)
- [ ] Model selection dropdown (list available models from provider)
- [ ] Test connection button

---

## 10. Deployment

### Self-Hosted (Docker Compose)

```bash
# Clone the repo
git clone https://github.com/deft-labs/deft.git
cd deft

# Copy environment config
cp .env.example .env
# Edit .env: set JWT secrets, add AI API key

# Start everything
docker-compose up -d

# Run migrations
docker-compose exec deft npx tsx packages/db/seed.ts

# Access at http://localhost:3000
```

**Requirements:**
- Docker + Docker Compose
- 2GB RAM minimum
- PostgreSQL 16 (included in docker-compose)
- AI API key (Anthropic, OpenAI, OpenRouter, or local Ollama)

### Managed SaaS

Additional infrastructure needed:
- Load balancer (nginx/Cloudflare)
- Managed PostgreSQL (Neon, Supabase, RDS)
- Cloudflare R2 for file storage
- Redis (optional, for Socket.io adapter at scale)
- Stripe for billing
- Sentry for error tracking
- Vercel for frontend (or static deploy)
- Railway/Fly.io for API (needs WebSocket support)

---

## 11. Seed Data

The seed script (`packages/db/seed.ts`) creates a realistic test environment:

**Users:** Maneek (owner), Rahul, Priya, Arjun, Sara — all with password `test1234`

**Org:** Deft Labs

**Spaces:** #general, #engineering, #design, #random, 3 DMs

**Messages:** 100+ messages across spaces including a dense 50-message engineering conversation between Rahul and Arjun about WebSocket reconnection, Drizzle migrations, file uploads, typing indicators, notifications, and task board drag-and-drop.

**Projects:** Deft v1 (15 tasks), Design System (8 tasks) — tasks across all statuses with comments, activity logs, and labels.

**Notifications:** 6 pre-seeded for Maneek (channel messages + task assignments).

**Read positions:** Maneek has unread messages in #engineering (last 12) and #general (last 6) for testing unread indicators.

---

## 12. File Structure Summary

```
apps/api/src/
├── index.ts                    # Server entry, route mounting, worker startup
├── socket.ts                   # Socket.io setup, presence, emitToUser
├── middleware/auth.ts           # JWT verification middleware
├── routes/                     # 18 route modules (90+ endpoints)
│   ├── agent.ts               # Agent conversations, SSE streaming, actions
│   ├── auth.ts                # Login, signup, refresh, me
│   ├── messages.ts            # CRUD + mentions + @agent + cross-ref + classify
│   ├── spaces.ts              # CRUD + members + read tracking + unread counts
│   ├── tasks.ts               # CRUD + comments + activity + labels
│   ├── projects.ts            # CRUD + task creation
│   ├── notifications.ts       # List + mark read
│   ├── bookmarks.ts           # Save/unsave messages
│   ├── dashboard.ts           # Dashboard data + standup generation
│   ├── recap.ts               # AI channel summary
│   ├── connections.ts         # OAuth flows
│   ├── audit.ts               # Audit log API
│   ├── cross-references.ts    # Entity cross-references
│   └── ... (pins, scheduled, reminders, upload, search, status, canvas, groups, emoji, workflows)
├── lib/                        # Shared libraries
│   ├── llm.ts                 # Multi-model LLM router
│   ├── queues.ts              # Postgres job queue (SKIP LOCKED)
│   ├── agent-runner.ts        # Reusable agent reasoning engine
│   ├── agent-tools.ts         # Tool definitions
│   ├── agent-context.ts       # Tool execution
│   ├── agent-actions.ts       # Write action execution
│   ├── classifier.ts          # Message intent classification
│   ├── audit.ts               # Audit event logger
│   ├── db.ts                  # Drizzle ORM client
│   ├── env.ts                 # Environment variables
│   ├── encryption.ts          # OAuth token encryption
│   ├── link-preview.ts        # Open Graph fetcher
│   ├── mentions.ts            # @mention parser
│   └── job-scheduler.ts       # Cron job registration
└── workers/                    # Background job handlers
    ├── index.ts               # Poll-based worker (3s interval)
    ├── types.ts               # JobData, JobHandler types
    └── handlers/              # 11 job handlers
        ├── agent-reply.ts     # @agent in-chat replies
        ├── task-extract.ts    # NL task extraction
        ├── cross-reference.ts # Task ID linking
        ├── standup-generate.ts # Daily standup
        ├── nudge-check.ts     # Stalled/overdue nudges
        ├── meeting-prep-check.ts # Meeting prep briefs
        └── ... (embed-content, index-message, index-task, standup-check, extract-tasks)

apps/web/src/
├── app/
│   ├── (app)/                  # Authenticated layout
│   │   ├── layout.tsx         # Chat context, presence, keyboard shortcuts
│   │   ├── chat/page.tsx      # Chat view
│   │   ├── tasks/page.tsx     # Task board
│   │   ├── agent/page.tsx     # Agent conversations
│   │   ├── dashboard/page.tsx # Dashboard
│   │   └── settings/          # Settings pages (agent, members, groups, integrations)
│   ├── login/page.tsx         # Login page
│   ├── signup/page.tsx        # Signup page
│   └── globals.css            # Obsidian design system (CSS variables)
├── components/                 # 30+ React components
│   ├── space-chat.tsx         # Main chat component (~1200 lines)
│   ├── sidebar.tsx            # Navigation sidebar (~900 lines)
│   ├── agent-chat.tsx         # Agent conversation (~715 lines)
│   ├── task-board.tsx         # Kanban board
│   ├── rich-composer.tsx      # TipTap message editor
│   ├── notification-panel.tsx # Notification dropdown
│   ├── saved-messages.tsx     # Bookmarked messages modal
│   ├── pinned-messages.tsx    # Pinned messages bar
│   ├── theme-provider.tsx     # Dark/light mode
│   └── ... (20+ more components)
└── lib/
    ├── api.ts                 # API client with JWT refresh interceptor
    ├── auth-context.tsx       # Auth context provider
    ├── chat-context.tsx       # Chat/spaces context
    └── socket.ts              # Socket.io client singleton

packages/db/
├── src/schema.ts              # 47 Drizzle ORM table definitions
├── seed.ts                    # Test data seeder
├── drizzle.config.ts          # Drizzle Kit configuration
└── drizzle/                   # SQL migrations
```

---

*Last updated: April 2026*
