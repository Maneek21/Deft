# Deft — Complete Feature Inventory

> Last updated: March 30, 2026
> Codebase: 69 source files, ~15,700 lines of TypeScript
> 60 API endpoints across 11 route files
> 27 React components, 11 pages

---

## Architecture Overview

```
Frontend:  Next.js 16 (App Router) + React 19 + Tailwind CSS v4
API:       Hono on Node.js (TypeScript, ESM)
Database:  PostgreSQL 16 (30 tables, Drizzle ORM)
Real-time: Socket.io with presence tracking
AI:        Anthropic Claude API (Sonnet for reasoning, tool use)
Auth:      JWT access tokens (15min) + refresh tokens (30d)
Storage:   Local filesystem (./uploads), R2-ready
Monorepo:  pnpm workspaces
```

---

## 1. Authentication & User Management

### Endpoints
| Method | Route | Description |
|--------|-------|-------------|
| POST | /api/auth/signup | Create user + org + #general space + onboarding state |
| POST | /api/auth/login | Email/password → JWT access + refresh tokens |
| POST | /api/auth/refresh | Exchange refresh token for new access token |
| POST | /api/auth/logout | Client-side token clear |
| GET | /api/auth/me | Return current user + org |

### Features
- Email/password authentication with bcrypt hashing (12 rounds)
- JWT access tokens (15min expiry) + refresh tokens (30d, HttpOnly)
- Automatic token refresh on 401 in the API client (transparent to user)
- Org creation on signup with auto-generated slug
- Auto-creates #general space and adds user as member on signup
- Onboarding state tracking per user
- Multi-tenant isolation: `org_id` on every table and query

### UI
- Login page: centered card, email/password fields, Google OAuth stub, "OR CONTINUE WITH" separator
- Signup page: name, email, password, org name fields
- Design: Obsidian dark theme with --surface-container card, gradient primary CTA button

---

## 2. Chat — Real-Time Messaging

### Endpoints
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/spaces | List spaces for current user's org |
| POST | /api/spaces | Create space (public/private/DM) |
| GET | /api/spaces/:id | Get single space |
| PATCH | /api/spaces/:id | Update space name/description |
| GET | /api/spaces/:id/members | List space members |
| POST | /api/spaces/:id/members | Add member to space |
| DELETE | /api/spaces/:id/members/:userId | Remove member |
| POST | /api/spaces/:id/read | Mark space as read |
| DELETE | /api/spaces/:id/members/me | Leave space |
| GET | /api/messages/:spaceId | Paginated messages (cursor-based, 50/page) |
| POST | /api/messages/:spaceId | Send message |
| PATCH | /api/messages/:id | Edit message |
| DELETE | /api/messages/:id | Soft delete message |

### Socket.io Events
| Event | Direction | Description |
|-------|-----------|-------------|
| message:new | Server → Client | New message broadcast |
| message:edited | Server → Client | Message edit broadcast |
| message:deleted | Server → Client | Message soft-delete broadcast |
| typing:start | Client → Server → Client | Typing indicator |
| typing:stop | Client → Server → Client | Stop typing |
| presence:init | Server → Client | Initial online users list |
| presence:update | Server → Client | User online/idle/offline change |
| space:join / space:leave | Client → Server | Room management |
| thread:updated | Server → Client | Thread reply count change |

### Chat Features
- **Real-time messaging** with Socket.io (room per space)
- **Threading**: click reply → side panel with parent message + replies. Thread replies don't appear in main feed. "X replies" indicator on parent.
- **Emoji reactions**: 124 emojis across 4 categories. Click to toggle. Pills below message.
- **@Mentions**: type `@` → autocomplete dropdown. `@here` and `@all` support. Creates notifications.
- **Rich text**: TipTap editor with Bold, Italic, Strikethrough, Inline code, Code blocks, Bullet lists, Numbered lists, Blockquotes, Links (Cmd+K)
- **File upload**: paperclip button or drag-and-drop or Ctrl+V paste. Images render inline (click for lightbox). Other files as download cards.
- **Link previews**: URLs auto-unfurl with Open Graph metadata (title, description, image, favicon). Async fetch, Socket broadcast.
- **Message grouping**: consecutive messages from same user within 5 minutes collapse avatar/name
- **Day separators**: "TUESDAY, OCT 24" in JetBrains Mono
- **Hover toolbar**: React, Reply, Pin, More menu (Edit, Copy link, Forward, Delete, Create task)
- **Typing indicators**: "X is typing..." with 2-second debounce
- **Online presence**: green dot (online), yellow (idle after 5min), no dot (offline). Server tracks per-socket with multi-tab support.
- **Unread tracking**: bold space name + accent dot. Auto-mark-read on view. `last_read_message_id` per space per user.

### DM Features
- All org members listed under "Direct Messages" in sidebar
- Click member → creates DM or opens existing (deduplication)
- DM header shows other person's name (not both)
- DM composer placeholder: "Message {name}"

### Space Management
- Create space modal (name, public/private, description)
- Create DM modal (search members)
- Space member panel (list, add, remove members)
- Private spaces with invite-only access

---

## 3. Tasks — Project Management

### Endpoints
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/projects | List projects for org |
| GET | /api/projects/:id | Project detail with task counts per status |
| POST | /api/projects | Create project (name, prefix, color, lead) |
| GET | /api/projects/:id/tasks | All tasks for project (with assignee, labels) |
| POST | /api/projects/:id/tasks | Create task (auto-increment number) |
| GET | /api/tasks/:id | Task detail with assignee, creator, labels |
| PATCH | /api/tasks/:id | Update any field (logs activity per field) |
| DELETE | /api/tasks/:id | Soft delete |
| POST | /api/tasks/:id/duplicate | Duplicate task with "(copy)" suffix |
| GET | /api/tasks/:id/comments | List task comments |
| POST | /api/tasks/:id/comments | Add comment |
| GET | /api/tasks/:id/activity | Activity log |
| POST | /api/tasks/:id/labels | Add label |
| DELETE | /api/tasks/:id/labels/:labelId | Remove label |
| GET | /api/tasks/labels | List org labels |
| POST | /api/tasks/labels | Create label |
| GET | /api/tasks/my | My tasks across all projects |
| GET | /api/tasks/search?q= | Search by title or PREFIX-N |

### Task Board (Kanban)
- 5 columns: Backlog, Todo, In Progress, In Review, Done
- Drag-and-drop between columns and within columns (@dnd-kit)
- Column headers: uppercase status + count badge + "..." menu
- "+" Add task at bottom of each column

### Task Cards
- Task ID in JetBrains Mono (DEFT-1)
- Title (Inter 500, max 2 lines)
- Priority badge: P0 red, P1 amber, P2 blue, P3 gray
- Assignee avatar (20px)
- Due date with Calendar icon (red if overdue, amber if today)
- Labels as color pills
- Hover: "..." menu with Duplicate, Copy link, Delete

### Task Detail Panel
- 450px side panel, slides from right
- Editable title (debounced 500ms auto-save)
- Field grid: Status, Priority, Assignee, Due Date, Labels — all dropdown pickers
- TipTap rich text description editor (auto-save 800ms debounce)
- Tabs: Comments (with add form) | Activity (formatted log)
- Source message link (if created from chat)
- "..." header menu: Duplicate, Copy link, Delete

### Task List View
- Table: ID, Title, Status, Priority, Assignee, Due Date, Updated
- Sortable column headers
- Inline status edit (click to change)
- Click row → detail panel

### Task Features
- Quick-create: press `C` → modal with title + fields (defaults to Backlog)
- Task filters: My tasks toggle, Priority multi-select, Due date (overdue/today/this week)
- My Tasks view: tasks across all projects, grouped by project
- URL-driven: /tasks?project=ID&task=DEFT-5
- Project switching via sidebar
- Activity formatting: "In Progress" not "in_progress", "P1 (High)" not "p1"
- Assignee name resolution in activity log

### Chat ↔ Tasks Bridge
- Create task from message (hover menu → "Create task" → pre-filled modal)
- Task mentions in chat (#DEFT-1 autocomplete → styled chip)
- Status changes auto-post system messages in linked spaces

---

## 4. AI Agent

### Endpoints
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/agent/conversations | List user's conversations |
| POST | /api/agent/conversations | Create conversation |
| DELETE | /api/agent/conversations/:id | Delete conversation + messages |
| GET | /api/agent/conversations/:id/messages | Conversation history |
| POST | /api/agent/conversations/:id/messages | Send message → streamed response (SSE) |
| POST | /api/agent/actions/:id/approve | Approve pending action |
| POST | /api/agent/actions/:id/reject | Reject pending action |
| POST | /api/agent/actions/:id/undo | Undo executed action |
| GET | /api/agent/actions | List org action log |

### Agent Tools (Anthropic tool_use)

**Read-only tools** (execute immediately):
| Tool | Description |
|------|-------------|
| search_messages | Full-text search across chat messages with space/author filters |
| search_tasks | Search tasks by title, status, priority, assignee, project, overdue flag |
| get_task_detail | Get task with comments and activity history |

**Write tools** (require approval):
| Tool | Description |
|------|-------------|
| create_task | Create task in a project (resolves project/user names) |
| update_task_status | Change task status |
| assign_task | Assign task to team member |
| post_message | Post message in a space |

### Agent Features
- **SSE streaming**: responses stream token-by-token with tool use indicators
- **Tool loop**: up to 5 iterations of tool calling → Claude reasoning
- **Approval flow**: write actions create pending records → user sees approval card → Approve/Reject
- **Undo**: approved actions can be undone within 5 minutes
- **Thinking indicator**: bouncing dots while agent processes
- **Auto-scroll**: follows streaming output, respects manual scroll-up
- **Lazy conversation creation**: no DB record until first message
- **Auto-title**: conversation titled from first message content
- **Citation chips**: task and message sources shown below response (max 5, expandable)
- **Confidence indicator**: green (3+ sources), amber (1-2), red (0)
- **Markdown rendering**: agent responses render as formatted HTML
- **Empty state**: "How can I help?" with suggestion cards
- **No API key graceful**: shows "Add your Anthropic API key in Settings"
- **Context retrieval**: direct SQL queries filtered by org_id

---

## 5. Dashboard — "My Day"

### Endpoint
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/dashboard | All dashboard data in one call |

### Dashboard Sections
- **Greeting**: "Good morning, Maneek" with formatted date
- **Morning Pulse**: Deft-generated summary card — tasks in progress, overdue count, due today, unread messages
- **Quick Actions**: New Task, New Message, Ask Deft, Invite Member (horizontal row)
- **Due Today**: task rows with status icon, ID, title, priority pill
- **Due This Week**: grouped by day
- **Overdue**: highlighted in red (separate section)
- **In Progress**: tasks with time-in-status indicator ("3d")
- **Unread Messages**: spaces with count, last message preview
- **Recent Activity**: timeline with formatted entries ("Rahul moved DEFT-7 to Done")
- **My Projects**: cards with progress bar (done/total), task count assigned to you
- **Empty state**: "Your workspace is ready" with action button

---

## 6. Global Search (Cmd+K)

### Endpoint
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/search?q= | Search spaces, tasks, people, messages |

### Features
- Cmd+K (Ctrl+K on Windows) toggles the palette
- Glassmorphism overlay with backdrop blur
- Deft icon in search bar
- Results grouped: Tasks (ID pill + title), Spaces (# chips), People (avatar + ACTIVE badge), Messages
- Command mode: type `>` for commands (Create task, New space, Toggle dark mode, Open settings, Ask Deft)
- Keyboard navigation: arrows, Enter to select, Esc to close
- Footer: navigation hints + version in JetBrains Mono
- 200ms debounced search

---

## 7. Notifications

### Endpoints
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/notifications | List user's notifications (top 50) + unread count |
| PATCH | /api/notifications/:id/read | Mark single as read |
| POST | /api/notifications/read-all | Mark all as read |

### Features
- Bell icon in global header with unread count dot
- Notification panel: solid --surface-container-highest background, z-[9999]
- Notification types: mention, DM, thread reply, task assignment
- Mark as read on click, mark all as read button
- Real-time: `notification:new` socket event to user-specific rooms
- Created automatically on @mentions, thread replies to your messages

---

## 8. File Upload

### Endpoints
| Method | Route | Description |
|--------|-------|-------------|
| POST | /api/upload | Multipart file upload (50MB max) |
| GET | /api/files/:id | Serve file with correct Content-Type |

### Features
- Paperclip button in composer opens file picker
- Drag-and-drop zone overlay
- Ctrl+V clipboard paste for images
- Upload progress bar (simulated)
- Images: inline thumbnail (max 400x300), click for lightbox
- Other files: card with icon + filename + size + download
- Multiple files per message (embedded as content markers)
- Files stored in ./uploads with UUID-prefixed filenames

---

## 9. Settings

### Pages
| Route | Content |
|-------|---------|
| /settings | General settings, theme toggle (light/dark/system) |
| /settings/members | Org member list (name, email, role, avatar) |
| /settings/integrations | Placeholder for Google Calendar, GitHub, Slack, Gmail |
| /settings/agent | Agent action log (action, details, status, timestamp) |

---

## 10. Presence System

- Server tracks connected users in `Map<userId, Set<socketId>>` (multi-tab support)
- Only broadcasts offline when ALL sockets for a user disconnect
- Sends `presence:init` on connect with full online user list
- Idle detection: 5min no mouse/keyboard → `presence:idle` → yellow dot
- Activity resumes → `presence:active` → green dot
- Presence tracked globally in app context, shared across all components

---

## 11. Design System — "Obsidian"

### Color System
- **Surface hierarchy**: 8-level tonal scale from #0E0E10 to #39393B
- **"No-Line Rule"**: layout boundaries through background shifts, not borders
- **Primary accent**: muted violet (#9080FA / #C8BFFF)
- **Glassmorphism**: floating elements use --surface-variant at 70% + blur(12px) + tinted shadow

### Typography
- **Inter**: variable weights (400-700) for all text
- **JetBrains Mono**: task IDs, timestamps, code, technical data
- Hierarchy through weight (400 body, 500 labels, 600 headings), not size

### Design Tokens
- All colors as CSS custom properties in globals.css
- Legacy aliases for backward compatibility
- Light mode support (`.light` class)
- 150ms transitions with cubic-bezier(0.16, 1, 0.3, 1)
- Radius: --radius-sm (0.125rem) to --radius-xl (0.75rem)

---

## 12. Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+K | Command palette |
| ? | Keyboard shortcuts reference |
| G → D | Go to Dashboard |
| G → C | Go to Chat |
| G → T | Go to Tasks |
| G → A | Go to Agent |
| G → S | Go to Settings |
| C (on tasks) | Create new task |
| Enter (in composer) | Send message |
| Shift+Enter | New line |
| Esc | Close panels/modals |

---

## 13. Real-Time Features

All real-time powered by Socket.io with user/space/org room architecture:

| Feature | Mechanism |
|---------|-----------|
| Chat messages | `message:new/edited/deleted` in space rooms |
| Typing indicators | `typing:start/stop` in space rooms |
| Online presence | `presence:init/update` in org rooms |
| Notifications | `notification:new` in user rooms |
| Thread updates | `thread:updated` in space rooms |
| Reactions | `reaction:added/removed` in space rooms |
| Task changes | `task:created/updated/deleted` in org rooms |
| Space creation | `space:created` in org rooms |
| Link previews | `message:link_previews` in space rooms |

---

## 14. Infrastructure

### Database
- 30 PostgreSQL tables with Drizzle ORM
- Multi-tenant: `org_id` on every table
- Soft deletes everywhere
- UUIDs for primary keys (cuid2)
- Timestamps (created_at, updated_at) on every table
- Indexes on foreign keys and common query patterns

### Docker
- Multi-stage Dockerfile (deps → build → production)
- docker-compose.yml with health checks (postgres, redis)
- Persistent volumes for data and uploads

### CI/CD
- GitHub Actions: TypeScript type-check → build
- Triggered on push/PR to main

### Open Source
- BSL 1.1 license (Apache 2.0 after 4 years)
- README with quick start (Docker + local dev)
- CONTRIBUTING.md with dev setup and code standards
- .env.example with documented variables
- 404 page, error states, empty states

---

## 15. Seed Data

### Users (5)
| Name | Email | Role |
|------|-------|------|
| Maneek | maneek@test.com | Owner |
| Rahul | rahul@test.com | Member |
| Priya | priya@test.com | Member |
| Arjun | arjun@test.com | Member |
| Sara | sara@test.com | Member |

### Projects (2)
| Name | Prefix | Tasks | Lead |
|------|--------|-------|------|
| Deft v1 | DEFT | 15 | Maneek |
| Design System | DS | 8 | Arjun |

### Spaces (7+)
- #general, #engineering, #design, #random (public)
- Maneek↔Rahul, Maneek↔Priya, Maneek↔Sara (DMs)
- 50+ realistic messages about product development

### Labels (3)
- bug (red), feature (blue), design (purple)

---

## Stats Summary

| Metric | Count |
|--------|-------|
| Source files | 69 |
| Lines of code | ~15,700 |
| API endpoints | 60 |
| React components | 27 |
| Pages | 11 |
| Database tables | 30 |
| Socket.io events | 15+ |
| Agent tools | 7 |
| Design tokens | 40+ |
| Dependencies (web) | 22 |
| Dependencies (api) | 20 |
