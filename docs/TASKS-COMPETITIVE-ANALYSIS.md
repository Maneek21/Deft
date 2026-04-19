# Tasks — Competitive Analysis

## Current State

Deft's task management is feature-rich — Kanban board with drag-and-drop, list view, subtasks, dependencies (blocks/blocked_by/relates_to), labels, comments, activity log, bulk operations, saved views, keyboard shortcuts, agent integration, and project organization. This is comparable to Linear's core feature set.

---

## Feature Comparison Matrix

| Feature | Deft | Linear | Asana | Jira | Notion | Todoist |
|---------|------|--------|-------|------|--------|---------|
| **Kanban board** | Full (dnd-kit) | Full | Full | Full | Full | Partial |
| **List view** | Sortable table | Full | Full | Full | Table view | Full |
| **Subtasks** | 1 level | Multi-level | Multi-level | 1 level | Multi-level | Multi-level |
| **Dependencies** | blocks/blocked_by/relates_to | Full | Full (paid) | Full | None | None |
| **Priority levels** | P0-P3 (4 levels) | Urgent/High/Med/Low/None | High/Med/Low | P1-P5 | None | P1-P4 |
| **Labels/Tags** | Colored labels | Labels | Tags (multi-color) | Labels + Components | Tags | Labels |
| **Comments** | Plain text | Rich text + reactions | Rich text + reactions | Rich text | Comments | Comments |
| **Activity log** | Full (11 event types) | Full | Full | Full | History | None |
| **Assignees** | Single | Single | Multiple | Single + Watchers | Multiple | Single |
| **Due dates** | Single date | Single + cycles | Date ranges | Date ranges | Date | Date + recurring |
| **Projects** | Full (prefix, color, icon) | Projects + Teams | Projects + Sections | Projects + Sprints | Databases | Projects |
| **Search** | By ID + title | Full-text + filters | Full-text | JQL | Full-text | Natural language |
| **Saved views** | Full (filters saved) | Views + custom views | My tasks + saved | Filters + boards | Database views | Filters |
| **Bulk ops** | Update/delete (50 max) | Full | Full | Full | None | None |
| **Drag-and-drop** | Board columns | Full | Full | Limited | Full | Full |
| **Keyboard shortcuts** | c (create), Esc | Extensive (30+) | Some | Some | Some | Extensive |
| **Templates** | None | Issue templates | Task templates | Templates + Workflows | Templates | None |
| **Time tracking** | None | None | Time tracking (paid) | Built-in | None | None (Toggl plugin) |
| **Sprints/Cycles** | None | Cycles | Sprints | Sprints | None | None |
| **Automations** | Agent-based | Automations | Rules | Automation rules | None | None |
| **Calendar view** | Via Calendar page | None | Calendar view | None | Calendar | None |
| **Timeline/Gantt** | None | None | Timeline (paid) | Roadmap | Timeline | None |
| **API/Webhooks** | Internal (agent) | Full public API | Full API | Full API | Full API | REST API |
| **AI features** | Native agent (create, update, assign, search) | None | AI project status | None | Notion AI | AI scheduling |
| **Chat integration** | Native (same app) | Slack integration | Slack integration | Slack/Teams | None | None |
| **Mobile app** | Responsive web | iOS + Android | iOS + Android | iOS + Android | iOS + Android | iOS + Android |

---

## Where Deft Stands

### Already Strong (Matching or Beating Linear)
1. **Kanban + List views** — both work well with drag-and-drop
2. **Dependencies** — blocks/blocked_by/relates_to (Linear has this, Todoist/Notion don't)
3. **Activity log** — 11 event types tracked (comprehensive)
4. **Saved views** — custom filter configurations saved per user
5. **Bulk operations** — update status/priority/assignee or delete up to 50 tasks
6. **Agent integration** — native AI that creates, updates, assigns tasks from chat. Linear has no AI. Asana/Jira need third-party integrations.
7. **Chat → Task pipeline** — create task from any chat message with one click. Source message linked back.
8. **Real-time updates** — Socket.io broadcasts task changes instantly

### Deft's Unique Advantage

**No competitor has tasks + chat + wiki + AI agent in one app.**

Linear is tasks-only — you need Slack for chat, Notion for docs. Asana is tasks-only — you need Slack + Confluence. Jira is tasks-only — you need Slack + Confluence.

Deft's tasks are the **action surface** for the AI agent:
1. **Agent creates tasks from conversations** — "Can someone fix the auth bug?" → agent creates DEFT-20 and assigns it
2. **Agent updates tasks from events** — PR merged → agent moves task to Done
3. **Agent searches tasks in context** — "What's blocking the launch?" → agent queries dependencies and blockers
4. **Tasks reference messages** — every task knows which conversation spawned it
5. **Wiki knowledge references tasks** — decisions page links to tasks that implemented them

### Gaps (What's Missing)

| Gap | Impact | Competitor Reference | Effort |
|-----|--------|---------------------|--------|
| **No sprints/cycles** | Can't plan time-boxed iterations | Linear cycles, Jira sprints | Large |
| **No recurring tasks** | Manual recreation of repeated work | Todoist, Asana | Medium |
| **No multiple assignees** | One person per task limit | Asana, Notion | Small |
| **No task templates** | Can't standardize task creation | Linear, Asana, Jira | Small |
| **No time estimation** | Can't estimate or track effort | Jira story points, Asana | Medium |
| **Single-level subtasks** | Can't nest deeper than one level | Asana, Notion, Todoist | Medium |
| **No watchers/followers** | Can't follow tasks you don't own | Jira watchers, Asana followers | Small |
| **Comments are plain text** | No rich text, reactions, or @mentions in comments | Linear, Asana | Small |
| **No task description templates** | Blank descriptions every time | Linear templates, Jira | Small |
| **No due date ranges** | Only single date, no start→end | Asana, Jira | Small |
| **Saved views 404** | `/api/tasks/saved-views` returns 404 — route not registered | N/A (bug) | Tiny |

---

## What to Build (Priority Order)

### Tier 1: Quick Wins (High Impact, Low Effort)

| Feature | What | Effort |
|---------|------|--------|
| **Fix saved-views 404** | Register the endpoint that already exists in code | Tiny |
| **Rich text comments** | Use TipTap in task comments (reuse existing editor) | Small |
| **Task watchers** | "Watch" button — get notified on changes without being assignee | Small |
| **Multiple assignees** | Array of user_ids instead of single assignee_id | Small |
| **Start + due date range** | Add `start_date` column, show as range | Small |
| **Task templates** | Pre-fill title + description + labels from template | Small |

### Tier 2: Important for Competitiveness

| Feature | What | Effort |
|---------|------|--------|
| **Recurring tasks** | "Repeat: daily/weekly/monthly" — auto-create next instance on completion | Medium |
| **Estimation** | T-shirt sizes (S/M/L/XL) or story points on tasks, show in board | Medium |
| **Multi-level subtasks** | Remove 1-level restriction, allow nesting | Medium |
| **Timeline/Gantt view** | Visual timeline using start_date → due_date | Large |

### Tier 3: Differentiators (Deft-Only)

| Feature | What | Effort |
|---------|------|--------|
| **Agent task intelligence** | Agent proactively suggests task priority changes, reassignments, and deadline adjustments based on conversation analysis | Medium |
| **Smart task creation** | When creating from chat, agent pre-fills description, priority, assignee based on message context | Small |
| **Task-wiki linking** | Link tasks to wiki decisions/concepts. "This task implements the Auth Architecture decision" | Small |
| **Sprint-free velocity** | Instead of sprints, show rolling velocity: tasks completed per week trend. No ceremony required. | Medium |

---

## What NOT to Build

- **Jira-level configurability** — no custom workflows, no issue types, no field customization. Simplicity is Deft's strength.
- **Gantt charts** — timeline view yes, but not full project management Gantt. Deft is for small teams.
- **Resource planning** — capacity planning, resource allocation. Wrong abstraction for 5-50 person teams.
- **Portfolio management** — multi-project dashboards. Overkill for current scale.
- **Approval workflows** — staged approval chains. Tasks have statuses, that's enough.

---

## The Pitch

> "Linear is where you track work. Deft is where work happens. Your team discusses a bug in chat — the agent creates the task, assigns it, and links it to the architecture decision in the wiki. When the PR merges, the agent moves it to Done and posts in the channel. No copy-pasting between apps. No context switching. One workspace."
