# Deft — Feature Roadmap (Craft-Inspired Additions)

**Status:** Planning
**Priority:** Ordered by impact
**Context:** Features adapted from Craft.do's model, filtered for what makes sense in an AI-native team workspace.

---

## 1. Daily Notes (Very High Impact | 3-5 days)

### What it is
A personal daily page per user — part journal, part task list, part scratchpad. The place you open every morning. The agent uses it as context for standups, summaries, and personal productivity insights.

### How it works
- Each user gets a daily note for today, auto-created on first visit
- **Auto-populated sections:**
  - Today's tasks (pulled from tasks assigned to user with due_date = today)
  - Unfinished from yesterday (carried forward automatically)
  - Calendar events (from connected Google Calendar, if any)
  - Mentions/threads you were tagged in since yesterday
- **User-editable sections:**
  - Free-form notes (TipTap editor, same as chat composer)
  - Quick task capture (type a line, press checkbox to convert to task)
  - Mood/energy check-in (optional, feeds burnout detection)
- **Calendar navigation:** Browse past days, see patterns
- **Agent integration:**
  - EOD: agent summarizes daily note into standup (replaces current standup-generate job)
  - Agent can reference "what you wrote yesterday" in conversations
  - Weekly: agent synthesizes the week's notes into a personal digest

### Data model
```
daily_notes
  id              uuid pk
  org_id          text (multi-tenant)
  user_id         text fk → users
  note_date       date (one per user per day)
  content         text (TipTap HTML — user's free-form notes)
  auto_items      jsonb {
                    tasks: [{ id, title, status, due_date }],
                    carried_over: [{ id, title }],
                    events: [{ title, start, end }],
                    mentions: [{ message_id, space_name, snippet }]
                  }
  summary         text (agent-generated EOD summary)
  mood            text (nullable — 'great' | 'good' | 'okay' | 'rough')
  created_at      timestamp
  updated_at      timestamp
  UNIQUE(user_id, note_date)
```

### Entry points
- Sidebar: "Today" link at the top of nav items
- Dashboard: "Daily Note" card/widget
- Keyboard shortcut: G then N (go to notes)
- Agent: "What did I write yesterday?" queries daily_notes

### API routes
```
GET    /api/daily-notes/today          → get or create today's note
GET    /api/daily-notes/:date          → get note for specific date
PATCH  /api/daily-notes/:date          → update content, mood
GET    /api/daily-notes/range?from=&to= → list notes in date range (calendar view)
```

### Agent tools
- `get_daily_note(user_id, date)` — read a user's daily note
- `get_daily_notes_range(user_id, from, to)` — read a range for summaries

---

## 2. Tags Across Everything (High Impact | Hours)

### What it is
Cross-entity tags (`#launch`, `#q3`, `#blocked`, `#design`) that work on messages, tasks, clips, and daily notes. Agent auto-tags based on content. Users can browse by tag to see all related items.

### How it works
- **Manual tagging:** Type `#` in any composer → autocomplete from existing tags
- **Auto-tagging:** Classifier (Haiku) extracts tags from messages/tasks on creation
- **Tag browser:** `/tags` page showing all tags with counts, click to filter
- **Sidebar:** Pin frequently used tags for quick access
- **Agent:** Can search by tag — "show me everything tagged #launch"

### Data model
```
tags
  id              uuid pk
  org_id          text
  name            text (lowercase, no spaces — "launch", "q3-planning")
  color           text (nullable — hex color for visual distinction)
  created_at      timestamp
  UNIQUE(org_id, name)

entity_tags (junction table)
  id              uuid pk
  org_id          text
  tag_id          text fk → tags
  entity_type     text ('message' | 'task' | 'clip' | 'daily_note')
  entity_id       text
  created_at      timestamp
  UNIQUE(tag_id, entity_type, entity_id)
  INDEX(org_id, tag_id)
  INDEX(entity_type, entity_id)
```

### API routes
```
GET    /api/tags                       → list all tags for org (with counts)
POST   /api/tags                       → create tag
DELETE /api/tags/:id                   → delete tag
POST   /api/tags/:id/apply             → apply tag to entity { entity_type, entity_id }
DELETE /api/tags/:id/apply             → remove tag from entity
GET    /api/tags/:id/entities          → list all entities with this tag
GET    /api/tags/search?q=             → autocomplete search
```

### Agent tools
- `search_by_tag(tag_name)` — find all items with a tag
- Auto-tag extraction in the existing classifier pipeline

### UI
- Tag chips rendered inline (colored pills) in messages, tasks, task list
- `#` autocomplete in rich-composer (same pattern as @mentions)
- Tag filter bar on /tasks page
- `/tags` browse page

---

## 3. Calendar View (High Impact | 1-2 days)

### What it is
A unified calendar showing tasks (by due date), meetings (connected calendar), clips, and daily notes in one temporal view. The time-based lens on your workspace.

### How it works
- **Month view:** Grid with dots/indicators for items per day
- **Week view:** Time blocks for events, task cards for due items
- **Day view:** Detailed list — events, tasks due, daily note, clips recorded
- **Drag to reschedule:** Drag a task to a different day to change its due_date
- **Click to create:** Click a day to create a task with that due date or open daily note
- **Sources:**
  - Tasks with `due_date` (from tasks table)
  - Events from `events` table (Google Calendar, etc.)
  - Daily notes (from daily_notes table)
  - Clips with `created_at` (optional, can toggle)

### Data model
No new tables — queries existing tables:
- `SELECT * FROM tasks WHERE assignee_id = ? AND due_date BETWEEN ? AND ?`
- `SELECT * FROM events WHERE user_id = ? AND timestamp BETWEEN ? AND ?`
- `SELECT * FROM daily_notes WHERE user_id = ? AND note_date BETWEEN ? AND ?`

### Entry point
- Sidebar: Calendar icon in nav items (between Tasks and Agent)
- Keyboard shortcut: G then L (go to calendar)
- Task detail: "View in calendar" link next to due date

### API routes
```
GET /api/calendar?from=&to=&user_id=   → unified calendar items for date range
```
Returns `{ tasks: [...], events: [...], daily_notes: [...] }` in one call.

---

## 4. Web Clipper → Context Clipper (High Impact | 1-2 days)

### What it is
A browser extension that captures web content (articles, docs, Stack Overflow answers, GitHub issues) into Deft. Saved content is searchable by the agent — extending its knowledge beyond the workspace.

### How it works
1. User clicks extension icon (or Cmd+Shift+D) on any page
2. Extension extracts: title, URL, main content (via Readability), selected text (if any)
3. Popup lets user choose destination: space, task, or just "save to workspace"
4. Content saved as a message with `metadata.web_clip` or as a standalone clip entry
5. Agent can search clips: "What did we save about OAuth best practices?"

### Browser extension (Chrome Manifest V3)
- `content.js` — extracts page content using Mozilla Readability
- `popup.html` — destination picker (space, task, or inbox)
- `background.js` — sends to Deft API with auth token
- ~150 lines total

### Data model
```
web_clips
  id              uuid pk
  org_id          text
  user_id         text fk → users
  url             text
  title           text
  content         text (cleaned markdown)
  excerpt         text (first 300 chars)
  favicon         text (nullable)
  image           text (nullable — og:image)
  space_id        text (nullable — if attached to a space)
  task_id         text (nullable — if attached to a task)
  tags            jsonb (auto-extracted by classifier)
  created_at      timestamp
  INDEX(org_id)
  INDEX(org_id, user_id)
```

### API routes
```
POST   /api/web-clips                  → save a web clip
GET    /api/web-clips                  → list user's clips (paginated)
GET    /api/web-clips/:id              → get clip detail
DELETE /api/web-clips/:id              → delete
GET    /api/web-clips/search?q=        → search clip content
```

### Agent tools
- `search_web_clips(query)` — search saved web clips by content/title
- Agent can reference clips in responses: "According to the article you saved about OAuth..."

---

## 5. Collapsible Blocks in Agent Responses (Medium Impact | 30 min)

### What it is
Long agent responses use expandable/collapsible sections so the chat stays scannable. Instead of a wall of text, key sections are toggled open.

### How it works
- Agent uses a simple syntax in its responses: `<details>` / `<summary>` or a custom marker
- `renderAgentMarkdown()` detects these and renders them as toggle blocks
- Default: collapsed. User clicks to expand.
- Examples:
  - "Here's the analysis (click to expand)" → collapsed detail
  - Task redistribution plans with expandable per-person breakdowns
  - Long code blocks collapsed by default

### Implementation
- Add to `renderAgentMarkdown()` in `agent-chat.tsx`:
  ```
  // Convert :::details Title\n...\n::: to <details><summary>
  // Or detect <details> blocks directly
  ```
- Add to agent system prompt: instruction to use collapsible sections for long responses
- No backend changes needed

---

## 6. Backlinks UI (Medium Impact | Hours)

### What it is
Surface the cross-references you already compute. When viewing a task, show "Referenced in 3 messages." When viewing a message, show linked tasks. Bi-directional visibility.

### How it works
- You already have `cross_references` table populated by the cross-reference worker
- Add a "References" section to:
  - **Task detail panel:** "Mentioned in #engineering (2 messages), #design (1 message)"
  - **Message hover/context:** "Links to DEFT-42, DEFT-18"
- Clicking a reference navigates to the source

### Data model
Already exists: `cross_references` table with `source_type`, `source_id`, `target_type`, `target_id`.

### API routes
```
GET /api/references/:entityType/:entityId  → get all references to/from an entity
```

### UI
- Small "References" chip/section below task description in task-detail.tsx
- Subtle link indicators on messages that reference tasks (already partially done with #DEFT-42 chips)

---

## 7. Publish-to-Web (Medium Impact | 1-2 days)

### What it is
Turn any project into a read-only public page. Useful for changelogs, status pages, and stakeholder visibility.

### How it works
- Project settings: "Publish to web" toggle
- Generates a public URL: `app.deft.ai/public/:slug` or `localhost:3000/public/:slug`
- Shows: project name, description, task board (read-only), recent activity
- Optional: password protection, custom slug
- Auto-updates as tasks change (no manual publishing step)

### Data model
```
published_pages
  id              uuid pk
  org_id          text
  project_id      text fk → projects
  slug            text UNIQUE
  is_active       boolean default true
  password_hash   text (nullable)
  settings        jsonb { show_assignees, show_activity, custom_css }
  created_at      timestamp
  updated_at      timestamp
```

### API routes
```
POST   /api/projects/:id/publish       → create/update published page
DELETE /api/projects/:id/publish       → unpublish
GET    /public/:slug                   → public page (no auth, SSR)
```

---

## 8. Inline Collections (Uncertain Impact | 3-5 days — evaluate before building)

### What it is
Lightweight embedded databases inside spaces — think Notion databases but contextual to a conversation. A space can have a "Decisions" table, a "Links" collection, or a "Sprint Tracker."

### Risk assessment
This is the closest to "building Notion inside Deft." Before investing:
- Does the agent benefit? (Can it query collections? Create rows?)
- Do users actually need this, or do tasks + tags cover it?
- Is the complexity worth it for a v1?

**Recommendation:** Skip for now. Revisit after Daily Notes, Tags, and Calendar are validated. If users ask for structured data beyond tasks, build it then.

### Data model (if built)
```
collections
  id, org_id, space_id, name, created_by, created_at, updated_at

collection_fields
  id, collection_id, name, field_type (text|number|date|select|user|relation), options jsonb, sort_order

collection_rows
  id, collection_id, data jsonb, created_by, created_at, updated_at
```

---

---

## Integration Map — How New Features Wire Into Existing Systems

Every new feature must feed data into and consume data from existing Deft systems. This section ensures nothing is built in isolation.

### Daily Notes → Existing Systems

| Existing System | Integration | What Changes |
|---|---|---|
| **Standup generation** (`standup-generate.ts`) | Daily note content becomes the PRIMARY input for standup, replacing raw message/task scanning. If a user wrote a daily note, summarize THAT. Fall back to auto-scan only if no note exists. | Modify `handleStandupGenerate` to query `daily_notes` first |
| **Burnout detector** (`burnout-detector.ts`) | `mood` field is a 6th signal. A string of 3+ "rough" days = 0.3 score. 5+ days = 0.5 (triggers alert). Weight: 0.20 (redistribute from others). Also: declining note frequency = social withdrawal signal. | Add mood signal to `detectBurnout`, read `daily_notes` table |
| **People graph** (`people-graph.ts`) | Daily note writes count as activity in `analyzePatterns`. Users who stop writing notes show declining `activity_trend`. Note content feeds into `extractExpertise` (topics user writes about). | Add daily_notes to activity count + expertise extraction |
| **Dashboard** (`dashboard.ts` + `page.tsx`) | Today's daily note replaces the standup card as the hero widget. Dashboard shows: note preview, mood indicator, task completion progress from the note. Standup becomes a "generated from your note" sub-section. | Modify `/api/dashboard` to include `daily_note`, update Dashboard3Page |
| **Agent memory** (`memory-extract.ts`) | Facts written in daily notes run through the same classifier → memory pipeline. Agent can recall "you mentioned X in your Tuesday note." | Enqueue `memory-extract` job when daily note is saved |
| **Agent tools** (`agent-tools.ts`) | Add `get_daily_note` and `get_daily_notes_range` tools. Agent can answer "what did I work on last week?" by reading notes. | Add 2 tool definitions + handlers in `agent-context.ts` |
| **Keyboard shortcuts** (`layout.tsx`) | G then N = go to daily notes | Add to chord handler |
| **Weekly digest** (`weekly-digest.ts`) | Aggregate week's daily notes into the digest. "You wrote 4 notes this week. Key themes: auth migration, Q3 planning." Fall back to message/task scan if no notes. | Modify `handleWeeklyDigest` to query `daily_notes` for the week |
| **Manager 1:1 prep** (`prep_oneone` tool) | Include report's daily notes from past week in 1:1 prep. Mood trends visible to manager: "3 rough days this week." NEVER include note content — only mood + metadata (wrote/didn't write). | Modify `prep_oneone` handler to query `daily_notes` mood + frequency |
| **Meeting prep** (`meeting-prep-check.ts`) | If user has a meeting today, include meeting prep brief in daily note `auto_items`. | Modify auto_items generation to check `meetingBriefs` table |
| **Nudge check** (`nudge-check.ts`) | If a task is overdue and user hasn't mentioned it in their daily note, escalate nudge priority. | Modify `handleNudgeCheck` to cross-reference daily note content |
| **Command palette** (`command-palette.tsx`) | "Go to today's note" action in command palette results. | Add to command palette items |
| **Cross-references** (`cross-reference.ts`) | If a daily note mentions DEFT-42, create a cross-reference with `source_type: 'daily_note'`. | Enqueue cross-reference job on daily note save |
| **Privacy** | Daily note free-form content is NEVER read by burnout detector or people graph. Only `mood` field and metadata (wrote/didn't write). Same privacy model as DMs. | Enforce in code with explicit field selection |

### Tags → Existing Systems

| Existing System | Integration | What Changes |
|---|---|---|
| **Classifier** (`classifier.ts`) | Extend `ClassificationResult` to include `suggested_tags: string[]`. Haiku already analyzes content — add "suggest 1-3 tags" to the prompt. | Modify classifier prompt, add field to output type |
| **Search** (`search.ts`) | Tags become a 5th searchable entity type. Also: existing task/message search accepts optional `tag` filter. | Add tag search to `/api/search`, add tag filter param to task/message queries |
| **Agent tools** (`agent-tools.ts`) | New `search_by_tag` tool. Existing `search_tasks` and `search_messages` tools get optional `tag` parameter. | Add 1 tool, modify 2 tool schemas + handlers |
| **Task page** (`tasks/page.tsx`) | Tag filter bar in the toolbar. Tags rendered as colored pills on task cards. | Add filter state, render tag chips |
| **Standup generation** (`standup-generate.ts`) | Group activity by tags: "3 items tagged #launch progressed." | Optionally join entity_tags when building standup data |
| **Dashboard** (`dashboard.ts`) | Tag distribution widget: "12 items tagged #blocked across projects." | Add tag stats query to `/api/dashboard` |
| **Rich composer** (`rich-composer.tsx`) | `#` autocomplete already exists for tasks. Need a second `#tag:` autocomplete that creates/applies tags. Differentiate: `#DEFT-42` = task ref, `#launch` = tag. | Extend `#` autocomplete to detect tag vs task context |
| **Clip cards** (`clip-card.tsx`) | Clips can be tagged. Auto-tag on transcription completion. | Apply tags in `clip-process.ts` worker after summary |
| **Weekly digest** (`weekly-digest.ts`) | Tag-based summaries: "This week in #launch: 5 tasks completed, 2 blocked." | Join entity_tags when building digest data |
| **Manager intelligence** (`get_workload_balance` tool) | Tag distribution across team — "90% of #launch work is on Rahul" = workload imbalance. | Query entity_tags + tasks by assignee in workload tool |
| **Command palette** (`command-palette.tsx`) | Search by tag in command palette results. "Type # to filter by tag." | Add tag search to command palette |
| **Notifications** | Optional "watch a tag" — get notified when new items tagged with a pinned tag. Low priority for v1. | Deferred — add if users request |

### Calendar View → Existing Systems

| Existing System | Integration | What Changes |
|---|---|---|
| **Dashboard** (`dashboard.ts`) | Calendar API reuses the same queries as dashboard (tasks by due date, events). Extract shared query functions to avoid duplication. | Refactor shared queries into a `calendar-queries.ts` utility |
| **Tasks** (`tasks/page.tsx`) | "View in calendar" link on task cards with due dates. Clicking a task in calendar opens task detail. | Add link in task-detail, calendar click handler opens task |
| **Daily notes** | Clicking a day in calendar opens that day's daily note. Days with notes show a dot indicator. | Calendar queries `daily_notes` table |
| **Nudge check** (`nudge-check.ts`) | Overdue tasks show red indicators in calendar view. | Calendar UI reads due_date vs today |
| **Keyboard shortcuts** | G then L = go to calendar | Add to chord handler |
| **Sidebar** (`sidebar.tsx`) | Calendar icon added to nav items between Tasks and Agent | Add navItem |
| **Audio/video clips** (`clips` table) | Clips recorded on a day appear in calendar view as entries. | Calendar query includes `clips` table by `created_at` |
| **Meeting prep** (`meetingBriefs` table) | Calendar events show generated meeting prep brief inline (expandable). | Join meetingBriefs to calendar events in API response |
| **Mobile** | Calendar on mobile = scrollable day-list (not grid). Touch-friendly day switching. | Responsive layout in calendar component |
| **Command palette** | "Go to calendar" action. | Add to command palette |
| **Tags** (cross-feature) | Filter calendar by tag — "show only #launch items this month." | Add optional tag filter param to `/api/calendar` |

### Web Clipper → Existing Systems

| Existing System | Integration | What Changes |
|---|---|---|
| **Search** (`search.ts`) | Web clips become a 6th searchable type (or 5th if tags aren't counted separately). Content is full-text searchable via ILIKE. | Add web_clips to `/api/search` |
| **Classifier** (`classifier.ts`) | On clip save, enqueue a classify job that auto-extracts tags and memorable facts from the clipped content. | Enqueue `memory-extract` + tag extraction on clip save |
| **Agent tools** (`agent-tools.ts`) | New `search_web_clips(query)` tool. Also consider including clip results in `search_messages` for unified search. | Add tool definition + handler |
| **Agent memory** (`memory-extract.ts`) | Facts from clipped articles enter agent memory. "According to the article you saved about OAuth..." | Enqueue memory-extract with clip content |
| **Tags** | Auto-tag clips on save using classifier output. Manual tag editing on clip detail. | Apply entity_tags on clip creation |
| **Daily notes** | "Saved 3 clips today" in daily note auto_items. Clips browseable from the note. | Include web_clips count in auto_items generation |
| **Notifications** (`notifications` table) | Notify space members when a clip is saved to a shared space. | Insert notification on shared clip save |
| **Mobile** | Mobile share sheet integration — share URL from mobile browser → save to Deft via PWA share target or deep link. | Add share target to PWA manifest (Phase 2) |
| **Audit log** (`audit.ts`) | Web clips saved to spaces are audit-logged. Who saved what external content. | Call `logAuditEvent` on clip save |
| **Thread panel** | Web clips shared in threads render as rich link cards (title, excerpt, favicon). | Add web_clip rendering to thread message display |

### Collapsible Blocks → Existing Systems

| Existing System | Integration | What Changes |
|---|---|---|
| **Agent system prompt** (`agent.ts`) | Add instruction: "For responses longer than 3 paragraphs, use collapsible sections for detailed breakdowns." | Modify SYSTEM_PROMPT constant |
| **Agent chat rendering** (`agent-chat.tsx`) | `renderAgentMarkdown()` parses `:::details Title` blocks or `<details>` HTML. | Add regex/parser to markdown renderer |
| **Space chat rendering** (`space-chat.tsx`) | Agent replies in threads also use markdown — `renderSimpleMarkdown()` should handle details blocks too. | Add to `renderSimpleMarkdown` |
| **Thread panel** (`thread-panel.tsx`) | Agent replies in threads use `renderContent`. Both renderers need collapsible block support. | Ensure thread rendering uses the same markdown pipeline |
| **Clip cards** (`clip-card.tsx`) | Long transcripts could use collapsible blocks instead of max-height scroll. | Render transcript with collapsible markdown |

### Backlinks → Existing Systems

| Existing System | Integration | What Changes |
|---|---|---|
| **Cross-reference worker** (`cross-reference.ts`) | Already populates `cross_references` table. No changes needed to the worker. | None |
| **Task detail** (`task-detail.tsx`) | Add "Referenced in" section showing linked messages with space name and timestamp. | New API call + UI section |
| **Search** | Backlinks could surface in search results: "DEFT-42 — referenced 5 times in #engineering" | Enhance search result metadata |
| **Agent** | Agent already uses `get_task_dependencies`. Could also surface "this task was discussed in these messages" from cross_references. | Optionally include in `get_task_detail` response |
| **Daily notes** | If a daily note mentions DEFT-42, index it as a cross-reference. `source_type: 'daily_note'`. | Add daily_note as source type in cross-reference worker |
| **Audio clips** | Clips attached to a task context show as backlinks on that task. | Include clips in backlink query |
| **Web clips** | Web clips saved to a task appear as references on that task. | Include web_clips in backlink query |

---

## Cross-Feature Interactions (New → New)

These are interactions between the NEW features themselves:

| Feature A | Feature B | Integration |
|---|---|---|
| **Daily Notes** | **Tags** | Notes can be tagged. Auto-tag notes based on content. Filter notes by tag in browse view. |
| **Daily Notes** | **Calendar** | Clicking a day in calendar opens that day's note. Days with notes show a dot indicator. Note page has mini-calendar nav. |
| **Daily Notes** | **Web Clipper** | Clips saved today appear in daily note auto_items. Browseable from the note. |
| **Daily Notes** | **Backlinks** | Notes mentioning tasks create cross-references (new source_type). |
| **Tags** | **Calendar** | Filter calendar by tag — "show only #launch items this month." |
| **Tags** | **Web Clipper** | Auto-tag clips on save. Filter clips by tag in browse view. |
| **Tags** | **Backlinks** | Items sharing the same tag are implicitly connected. Agent can surface: "These 3 tasks and 2 messages all tagged #launch." |
| **Calendar** | **Web Clipper** | Clips show as entries on the day they were saved (optional, toggle). |
| **Collapsible** | **Clip Cards** | Long transcripts rendered with collapsible blocks. |

---

## Privacy & Permissions

| Feature | Visibility | Rule |
|---|---|---|
| **Daily Notes** | Personal only | Only the user can read their note content. Manager 1:1 prep sees ONLY mood field + wrote/didn't-write metadata. NEVER content. Same as DM privacy model. |
| **Tags** | Org-wide | All org members see all tags. Tags on private messages only visible to space members. |
| **Calendar** | Personal | Each user sees their own tasks, events, notes. Managers don't see reports' calendars. |
| **Web Clips** | Mixed | Clips saved to a space = visible to space members. Personal clips = user only. |
| **Backlinks** | Follows source entity | If you can see the message, you can see the backlink. No escalation. |

---

## Data Flow Diagram (After All Features)

```
User Activity
  │
  ├─ Chat message ──→ classifier ──→ memory-extract (facts, decisions)
  │                       │              └──→ entity_tags (auto-tag)
  │                       └──→ cross-reference (task refs)
  │
  ├─ Daily note ───→ classifier ──→ memory-extract (facts)
  │                  │    └──→ entity_tags (auto-tag)
  │                  └──→ cross-reference (if mentions DEFT-42)
  │       │
  │       ├──→ standup-generate (PRIMARY input, replaces message scan)
  │       ├──→ burnout-detector (mood signal only, NEVER content)
  │       ├──→ people-graph (activity frequency, expertise topics)
  │       ├──→ weekly-digest (aggregated into weekly summary)
  │       ├──→ manager 1:1 prep (mood trends only, NEVER content)
  │       └──→ nudge-check (overdue tasks not mentioned = escalate)
  │
  ├─ Task change ──→ task-activity ──→ standup, dashboard, calendar
  │                       └──→ nudge-check (overdue alerts)
  │
  ├─ Web clip ────→ classifier ──→ memory-extract (facts from articles)
  │                  │    └──→ entity_tags (auto-tag)
  │                  ├──→ search index
  │                  ├──→ audit log (if saved to shared space)
  │                  └──→ notifications (notify space members)
  │
  ├─ Audio clip ──→ transcribe ──→ summarize ──→ message card
  │                       ├──→ entity_tags (auto-tag from transcript)
  │                       └──→ search index
  │
  └─ Tag applied ──→ entity_tags ──→ search, agent tools, dashboard stats
                          └──→ weekly-digest (tag-based summaries)
                          └──→ manager workload (tag distribution per person)

Background Jobs
  │
  ├─ standup-generate ←── daily_notes (primary) + tasks + messages (fallback)
  ├─ people-graph ←────── messages + tasks + daily_notes (frequency)
  ├─ burnout-detect ←──── messages + daily_notes.mood + patterns
  ├─ nudge-check ←─────── tasks.due_date + daily_notes (cross-check)
  ├─ meeting-prep ←────── events + tasks + messages → daily_note auto_items
  ├─ manager-pulse ←───── all computed tables + entity_tags (tag distribution)
  ├─ weekly-digest ←───── daily_notes + tasks + messages + entity_tags (7d)
  └─ 1:1 prep ←────────── daily_notes.mood (trends) + tasks + patterns

Agent Tools (after additions)
  │
  ├─ search_messages ──── messages (+ optional tag filter)
  ├─ search_tasks ─────── tasks (+ optional tag filter)
  ├─ search_by_tag ────── entity_tags → any entity type (NEW)
  ├─ search_web_clips ─── web_clips (NEW)
  ├─ get_daily_note ───── daily_notes (NEW)
  ├─ get_daily_notes_range ─ daily_notes date range (NEW)
  ├─ get_task_detail ──── tasks + cross_references (now includes daily_note + clip backlinks)
  ├─ recall ───────────── agentMemory (facts from messages, notes, web clips, audio clips)
  └─ ... (19 existing tools unchanged)

Surfaces (where data appears to users)
  │
  ├─ Dashboard ←────── daily_note (hero) + tasks + standup + tag stats
  ├─ Calendar ←─────── tasks (due_date) + events + daily_notes + clips + meeting_preps
  │                     └── filter by tag
  ├─ Task detail ←──── task + cross_references (backlinks from messages, notes, clips)
  ├─ Tag browser ←──── entity_tags + counts by type
  ├─ Search ←────────── spaces + tasks + messages + people + tags + web_clips
  ├─ Command palette ← "today's note" + tag search + "go to calendar"
  └─ Sidebar ←──────── nav: Dashboard, Chat, Tasks, Calendar (NEW), Agent, Settings
```

---

## Build Sequence

```
Phase 1: Daily Notes + Tags (anchor features)
  - daily_notes table + API + sidebar + page
  - tags + entity_tags tables + API + composer autocomplete
  - Wire into: standup-generate, classifier, search, dashboard, agent tools

Phase 2: Calendar View (ties daily notes + tasks + events together)
  - Calendar page + API (reuse dashboard queries)
  - Wire into: sidebar nav, task detail links, daily note navigation

Phase 3: Web Clipper (expands agent knowledge)
  - web_clips table + API + browser extension
  - Wire into: search, classifier, memory-extract, agent tools, tags

Phase 4: Collapsible blocks + Backlinks UI (quick polish)
  - Markdown renderer updates (frontend only for collapsible)
  - Backlinks API + task-detail UI (reads existing cross_references)

Phase 5: Publish-to-Web (stakeholder visibility)
  - published_pages table + public route + project settings UI

Phase 6: Inline Collections (only if validated by user demand)
```
