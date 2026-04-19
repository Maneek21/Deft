# Deft — Product Roadmap

> Last updated: April 8, 2026
> Based on: [COMPETITIVE-ANALYSIS.md](COMPETITIVE-ANALYSIS.md) and [FEATURES.md](FEATURES.md)

This roadmap is organized into phases. Each phase targets a strategic goal and lists features by implementation effort. Features are sourced from competitive gaps, partially-built code in the codebase, and opportunities to deepen Deft's unique advantages.

---

## Phase 1: Close Trust & Adoption Gaps (Weeks 1–3)

**Goal:** Remove the reasons teams say "we can't use this yet." These are table-stakes features that competitors all have and that block adoption decisions.

### 1.1 Outgoing Webhooks
- **What:** Fire webhooks on key events (task.created, task.updated, message.sent, member.joined, etc.)
- **Why:** Unlocks Zapier/Make without building 50 native integrations. Integration breadth is the #1 adoption blocker identified in competitive analysis.
- **Effort:** 1 week
- **Approach:** New `webhooks` table (org_id, url, events[], secret). Emit webhook calls from existing Socket.io broadcast points. HMAC signature for verification. Settings page to manage webhook URLs.
- **Impact:** Opens Deft to thousands of external tools overnight.

### 1.2 Data Export (CSV/JSON)
- **What:** Export tasks, messages, knowledge, and activity as CSV or JSON.
- **Why:** "Can I get my data out?" is the first question security-conscious teams ask. Every competitor has export. Removes vendor lock-in fear.
- **Effort:** 3–4 days
- **Approach:** `/api/export/tasks`, `/api/export/messages`, `/api/export/knowledge` endpoints with format query param. Paginated streaming for large orgs. Button in Settings.
- **Impact:** Unblocks security reviews and team evaluations.

### 1.3 Two-Factor Authentication (TOTP)
- **What:** App-based 2FA (Google Authenticator, Authy) for login.
- **Why:** Table-stakes for any team with security requirements. Every competitor has it.
- **Effort:** 3–4 days
- **Approach:** better-auth has a TOTP plugin. Add `totp_secret` and `totp_enabled` to users table. QR code setup flow in Settings. Verify on login.
- **Impact:** Unblocks security-conscious teams.

### 1.4 Calendar View for Tasks
- **What:** Render tasks with due dates on the existing calendar page.
- **Why:** Calendar page already exists with month/week/day views. Tasks already have due dates. This is a frontend wiring change, not a new feature.
- **Effort:** 2–3 days
- **Approach:** Query tasks with due dates in the calendar date range. Render as calendar items alongside events. Click to open task detail.
- **Impact:** Closes a gap against Linear, Notion, Asana, ClickUp.

### 1.5 Recurring Tasks
- **What:** Tasks that auto-create on a schedule (daily, weekly, monthly, custom).
- **Why:** Common for standups, reviews, maintenance checklists. Job queue and cron scheduling already exist.
- **Effort:** 3–4 days
- **Approach:** Add `recurrence_rule` (RFC 5545 RRULE) and `recurrence_source_id` to tasks table. Worker clones task on schedule with new due date. UI: recurrence picker in task detail.
- **Impact:** Closes gap against Linear, Asana, ClickUp.

### 1.6 Task Templates
- **What:** Save task configurations (title pattern, default fields, labels, description) as reusable templates per project.
- **Why:** Expected feature for any PM tool. Reduces repetitive task creation.
- **Effort:** 2–3 days
- **Approach:** New `task_templates` table (project_id, name, default_status, default_priority, default_labels, description_template). "Create from template" option in quick-create modal.
- **Impact:** Closes gap against Notion, Asana, ClickUp.

### 1.7 Guest Access
- **What:** Invite external collaborators with limited access to specific spaces.
- **Why:** Freelancers, clients, contractors need workspace access without seeing everything. The `guest` role already exists in the schema but isn't enforced.
- **Effort:** 4–5 days
- **Approach:** Enforce `guest` role in middleware — limit to explicitly added spaces. Guest invite flow (email with role=guest). Guest badge in member list. Guests cannot see org-wide knowledge, dashboard analytics, or other spaces.
- **Impact:** Closes gap against Notion, Slack, Asana.

---

## Phase 2: Deepen Unique Advantages (Weeks 3–6)

**Goal:** Make Deft's AI and people intelligence features even more differentiated. These are features no competitor has — doubling down on strengths.

### 2.1 Manager Dashboard Page
- **What:** Dedicated page for managers showing team health, 1:1 preps, burnout alerts, workload balance, and velocity trends.
- **Why:** Backend is fully built (routes, services, workers, 7 database tables). There's no UI page for it. This is Deft's most unique feature set and it's invisible to users.
- **Effort:** 5–7 days
- **Approach:** New `/manager` page. Cards: Team Health (green/yellow/red per person), Workload Balance (bar chart), Velocity Trend (4-week sparkline), Burnout Alerts (flagged members), 1:1 Prep (generate/view/archive). Pull from existing `/api/manager/*` and `/api/dashboard/my-insights` endpoints.
- **Impact:** Makes the people intelligence suite visible and usable. This is the "manager superpower" pitch made real.

### 2.2 People Directory & Team Graph
- **What:** Org-wide people directory showing each member's expertise, collaborators, influence type, activity patterns, and relationship map.
- **Why:** 7 people graph tables are populated by daily workers but have no dedicated UI. This data is unique to Deft.
- **Effort:** 5–7 days
- **Approach:** New `/people` page. Member cards with expertise tags, influence badges, collaboration heatmap. Click member for profile: activity trend, top collaborators, expertise breakdown, recent tasks/messages. Optional: simple force-directed graph visualization of team relationships.
- **Impact:** No competitor has anything like this. Strong differentiator for team leads and HR.

### 2.3 AI Writing Assist in Wiki & Notes
- **What:** "AI Assist" button in the wiki and notes editors that can expand, rewrite, summarize, or continue selected text using Claude.
- **Why:** Closes the AI content creation gap vs Notion AI and ClickUp Brain. LLM router already exists. Wiki and notes editors already use TipTap.
- **Effort:** 4–5 days
- **Approach:** New `/api/ai/assist` endpoint accepting text + action (expand/rewrite/summarize/continue). TipTap toolbar button that sends selected text, streams response back into editor. Use Sonnet for quality.
- **Impact:** Moves "AI writing" from "None/Basic" to "Good" in competitive analysis.

### 2.4 Thread & Channel AI Summaries
- **What:** "Summarize this thread" button on any thread. "Catch me up" button on any space.
- **Why:** Space recaps already exist. Extending to individual threads is a small scope increase. Closes gap vs Slack AI.
- **Effort:** 2–3 days
- **Approach:** Reuse existing recap logic. New endpoint `/api/threads/:parentId/summary`. Frontend button in thread panel header. Cache summaries for 1 hour.
- **Impact:** Matches Slack AI's most-used feature.

### 2.5 Workflow Rules UI
- **What:** Settings page to create, edit, enable/disable automation rules with trigger→action pairs. View run history.
- **Why:** Backend fully built (`/api/workflows` CRUD + run history). No UI exists. User-configurable automation is a competitive gap.
- **Effort:** 4–5 days
- **Approach:** New `/settings/workflows` page. Rule builder: select trigger type (keyword, new member, reaction) → configure → select action (create task, send message, notify) → configure. Enable/disable toggle. Run history table with status.
- **Impact:** Makes automation visible and configurable by users.

### 2.6 Custom Emoji Management
- **What:** Settings page to upload, view, and delete org-custom emoji.
- **Why:** Backend fully built (`/api/emoji` CRUD). Emoji picker already supports custom emoji. No management UI exists.
- **Effort:** 1–2 days
- **Approach:** New section in `/settings` or dedicated `/settings/emoji` page. Upload form (256KB max, alphanumeric name). Grid view of existing custom emoji. Delete button.
- **Impact:** Small but expected feature for team culture.

### 2.7 Semantic Search (pgvector)
- **What:** Search that understands meaning, not just keywords. "Find discussions about deployment strategy" returns relevant results even if those exact words weren't used.
- **Why:** pgvector is in the stack. `embed-content` worker exists (with TODO for implementation). Schema supports vector columns.
- **Effort:** 1 week
- **Approach:** Implement `embed-content` worker to generate embeddings via OpenAI/local model. Store in pgvector column on messages, tasks, wiki pages. New `/api/search/semantic?q=` endpoint with cosine similarity. Enhance Cmd+K to offer "Semantic search" toggle.
- **Impact:** Leap-frogs keyword search. Matches Notion AI's search quality.

---

## Phase 3: Expand Reach (Weeks 6–10)

**Goal:** Remove platform limitations that shrink the addressable market.

### 3.1 Public REST API (Read-Only)
- **What:** Documented API with API key authentication for reading tasks, messages, spaces, and members.
- **Why:** Developers want to build on top of Deft. No public API is a gap against every competitor.
- **Effort:** 1–2 weeks
- **Approach:** New `/api/v1/*` routes mirroring internal endpoints. API key table (org_id, key_hash, name, scopes, created_by). Rate limiting (100 req/min). OpenAPI spec generation. Read-only first, write endpoints in a later phase.
- **Impact:** Enables custom integrations, dashboards, and bots built by users.

### 3.2 Incoming Webhooks
- **What:** Accept webhook payloads from external services and route them to spaces or the agent.
- **Why:** Combined with outgoing webhooks (Phase 1), this creates a full integration layer. Services like GitHub, Sentry, PagerDuty can post directly into Deft.
- **Effort:** 4–5 days
- **Approach:** New `incoming_webhooks` table (org_id, space_id, url_token, name). POST to `/api/webhooks/:token` creates a message in the linked space with formatted payload. Template system for known services.
- **Impact:** Replaces many native integrations with a generic mechanism.

### 3.3 Screen Sharing in Huddles
- **What:** Share your screen during a huddle.
- **Why:** Huddles without screen sharing are limited. This is the biggest gap vs Slack huddles.
- **Effort:** 1 week
- **Approach:** `getDisplayMedia()` API on frontend. Send screen as additional WebRTC track. Toggle button in huddle overlay. Receiver renders in expanded view. Peer-to-peer only (no SFU), so works best 1:1 or small groups.
- **Impact:** Moves huddles from "Good" to near-"Full" vs Slack.

### 3.4 Simple Timeline View
- **What:** Horizontal timeline rendering tasks as bars from start date to due date.
- **Why:** Timeline/Gantt is a gap against Linear, Notion, Asana, ClickUp. Doesn't need to be full Gantt — even an Airtable-style timeline closes the gap.
- **Effort:** 1 week
- **Approach:** Add optional `start_date` to tasks table. New "Timeline" tab on tasks page. Render tasks as horizontal bars on a date axis. Color by status or priority. Drag to adjust dates. No dependency arrows needed initially.
- **Impact:** Moves from "None" to "Basic" on timeline/Gantt.

### 3.5 Slack Integration (Full)
- **What:** Bidirectional Slack integration — sync Slack messages to Deft events, post from Deft to Slack channels.
- **Why:** Event schema is already scaffolded. Many teams adopting Deft will still have Slack users. Coexistence is the adoption path.
- **Effort:** 1–2 weeks
- **Approach:** Complete OAuth flow in connections.ts. Slack Events API subscription for message events. Sync worker (like calendar-sync and github-sync). Agent tool to post to Slack channels. Settings page status display.
- **Impact:** Moves Slack from "Scaffolded" to "Good". Enables gradual migration.

### 3.6 Gmail Integration (Full)
- **What:** Sync emails to events, draft emails from the agent.
- **Why:** Event schema scaffolded. Agent already has cross-tool actions. Email is a critical workflow surface.
- **Effort:** 1–2 weeks
- **Approach:** Complete Gmail OAuth flow. Gmail API watch + history sync. Agent tool to draft/send emails. Email activity on dashboard.
- **Impact:** Moves Gmail from "Scaffolded" to "Good". Strengthens cross-tool agent story.

### 3.7 Mobile-Responsive PWA
- **What:** Progressive Web App with service worker, push notifications, and install prompt.
- **Why:** Native mobile apps take months. A PWA gives mobile access immediately with push notifications on Android and partial support on iOS.
- **Effort:** 1 week
- **Approach:** Service worker for offline shell + cache. Web push notifications via Push API. `manifest.json` for installability. Responsive layout already exists (1-col mobile breakpoint). Add bottom tab nav for mobile viewport.
- **Impact:** Doesn't replace native apps but gives mobile users something now.

---

## Phase 4: Enterprise Readiness (Weeks 10–16)

**Goal:** Enable upmarket motion to larger teams and regulated industries.

### 4.1 SSO (SAML 2.0)
- **What:** SAML-based Single Sign-On for enterprise identity providers (Okta, Azure AD, Google Workspace).
- **Why:** Required for any org >50 people with IT policies. Every competitor gates this at Enterprise tier.
- **Effort:** 2 weeks
- **Approach:** better-auth supports SAML plugins. New `sso_configs` table (org_id, provider, metadata_url, certificate). SSO login flow. Enforce SSO-only for configured orgs.
- **Impact:** Unlocks enterprise sales motion.

### 4.2 SCIM Provisioning
- **What:** Automatic user provisioning/deprovisioning from identity providers.
- **Why:** Required alongside SSO for enterprise orgs. IT admins need to manage access centrally.
- **Effort:** 1–2 weeks
- **Approach:** SCIM 2.0 endpoints (`/scim/v2/Users`, `/scim/v2/Groups`). Map to existing members and user_groups tables. Bearer token auth for SCIM client.
- **Impact:** Completes the enterprise identity story with SSO.

### 4.3 Advanced Permissions
- **What:** Space-level permissions (who can post, who can view) and project-level roles.
- **Why:** Org-level roles are too coarse for teams with sensitive spaces or cross-functional projects.
- **Effort:** 2 weeks
- **Approach:** Add `role` to `space_members` (owner, admin, member, viewer). Permission checks in message and task routes. UI for space-level role management. Project-level access control.
- **Impact:** Moves permissions from "Good (org-level)" to "Full (space-level)".

### 4.4 Data Retention Policies
- **What:** Auto-delete messages and files older than a configured threshold per org.
- **Why:** Required for compliance (GDPR, internal policies). Competitors all have this at business/enterprise tier.
- **Effort:** 1 week
- **Approach:** Add `retention_days` to orgs table. Daily worker hard-deletes soft-deleted records older than threshold. Separate retention for messages, files, and audit logs. Settings UI.
- **Impact:** Compliance requirement for regulated industries.

### 4.5 IP Allowlisting
- **What:** Restrict API and app access to specific IP ranges per org.
- **Why:** Enterprise security requirement. Slack and Asana offer this at Enterprise tier.
- **Effort:** 3–4 days
- **Approach:** New `allowed_ips` table (org_id, cidr_range). Middleware check on all authenticated routes. Settings page for admins.
- **Impact:** Enterprise security checkbox.

### 4.6 Audit Log Enhancements
- **What:** Filterable audit log page in settings, exportable, with retention.
- **Why:** Audit log data exists but has no dedicated management UI. Enterprise admins need to search and export audit trails.
- **Effort:** 3–4 days
- **Approach:** New `/settings/audit` page. Filter by actor, action, entity type, date range. Export as CSV. Pagination.
- **Impact:** Makes existing audit data accessible to admins.

---

## Phase 5: Product Depth (Weeks 16–24)

**Goal:** Deepen core product capabilities to compete with mature PM tools on their turf.

### 5.1 Custom Fields on Tasks
- **What:** User-defined fields (text, number, date, select, multi-select) per project.
- **Why:** Every mature PM tool has this. Teams need project-specific fields (sprint points, team, component, etc.).
- **Effort:** 2 weeks
- **Approach:** New `custom_field_definitions` table (project_id, name, type, options) and `custom_field_values` table (task_id, field_id, value). Render in task detail panel. Filter/sort by custom fields.
- **Impact:** Moves from "None" to "Good" on custom fields.

### 5.2 Subtask Depth (Multi-Level)
- **What:** Allow subtasks to have their own subtasks (2–3 levels deep).
- **Why:** Current subtasks are one level only. Complex projects need deeper decomposition.
- **Effort:** 1 week
- **Approach:** Schema already supports parent_task_id. Frontend needs recursive rendering in task detail. Limit to 3 levels to avoid complexity.
- **Impact:** Matches Linear and Asana subtask depth.

### 5.3 Roadmap View
- **What:** High-level view of projects and their milestones over time.
- **Why:** Gap against Linear (roadmaps), Asana (portfolios), ClickUp (roadmaps).
- **Effort:** 2 weeks
- **Approach:** New `milestones` table (project_id, name, target_date, status). Roadmap page rendering projects as swimlanes with milestones and task progress. Zoom levels (quarter, month, week).
- **Impact:** Moves from "None" to "Good" on roadmaps.

### 5.4 Goals / OKR Tracking
- **What:** Set org/team/project goals with key results linked to tasks.
- **Why:** Gap against Asana (Goals), ClickUp (Goals). Important for larger teams aligning work to outcomes.
- **Effort:** 2 weeks
- **Approach:** New `goals` table (org_id, title, type, target_date, owner_id) and `key_results` table (goal_id, title, target_value, current_value, linked_project_id). Progress auto-calculated from linked task completion. Dashboard widget.
- **Impact:** Enables strategic alignment features.

### 5.5 Sprints / Cycles
- **What:** Time-boxed iterations with task scoping, velocity tracking, and retrospective summaries.
- **Why:** Gap against Linear (cycles). Engineering teams expect sprint support.
- **Effort:** 2 weeks
- **Approach:** New `sprints` table (project_id, name, start_date, end_date, status). Sprint backlog view (assign tasks to sprint). Sprint velocity chart. AI-generated sprint retrospective summary.
- **Impact:** Moves from "None" to "Good" on sprints.

### 5.6 Rich Wiki Editor (Block-Based)
- **What:** Upgrade wiki editor from text-based to block-based (headings, images, code blocks, callouts, tables, embeds).
- **Why:** Biggest gap vs Notion. TipTap already supports extensions for these block types.
- **Effort:** 2–3 weeks
- **Approach:** Extend TipTap config in wiki editor with block extensions: Image, Table, CodeBlock (with syntax highlighting), Callout, Divider, Toggle (collapsible). Store as TipTap JSON instead of plain text. Migration for existing content.
- **Impact:** Moves wiki from "Basic" to "Good" on rich editing.

### 5.7 Native Desktop App (Electron/Tauri)
- **What:** Desktop app with native notifications, dock badge, and global shortcut.
- **Why:** Teams that live in Deft all day want a dedicated window, not a browser tab.
- **Effort:** 2–3 weeks
- **Approach:** Tauri wrapper around existing web app. Native notification bridge. Menu bar icon with unread count. Global Cmd+Shift+D shortcut to focus. Auto-update.
- **Impact:** Moves from "None" to "Good" on desktop app.

---

## Phase 6: Scale & Polish (Weeks 24+)

**Goal:** Long-term investments that require significant engineering effort.

### 6.1 Native Mobile App (React Native)
- **What:** iOS and Android apps with push notifications, offline message queue, and responsive task management.
- **Why:** Web-only is a hard limitation for teams with mobile workers. Every major competitor has polished mobile apps.
- **Effort:** 8–12 weeks
- **Approach:** React Native with shared TypeScript types from `packages/shared`. Push via APNs/FCM. Offline message queue with sync. Start with chat + tasks + notifications, add other features incrementally.

### 6.2 SFU for Huddles (Group Calls)
- **What:** Selective Forwarding Unit to support group calls with 5+ participants.
- **Why:** Peer-to-peer WebRTC degrades above 4-5 participants. SFU enables reliable group calls.
- **Effort:** 4–6 weeks
- **Approach:** Deploy mediasoup or LiveKit as SFU. Modify signaling to route through SFU when participant count exceeds threshold. Add basic call quality indicators.

### 6.3 SOC 2 Type II Certification
- **What:** Security audit and certification for enterprise trust.
- **Why:** Required for enterprise procurement. Most competitors have this.
- **Effort:** 3–6 months (process, not just code)
- **Approach:** Engage SOC 2 auditor. Implement required controls: access reviews, incident response, change management, monitoring. Document policies. The codebase already has audit logs, encryption, and role-based access.

### 6.4 Public Write API + Developer Platform
- **What:** Full public API (read + write) with OAuth apps, rate limiting, and developer documentation.
- **Why:** Enables a developer ecosystem. Slack's app platform is a major moat.
- **Effort:** 4–6 weeks
- **Approach:** Extend read-only API (Phase 3.1) with write endpoints. OAuth 2.0 app registration. Scoped permissions. API documentation site. Webhook subscriptions per app.

### 6.5 White-Label / Reseller Support
- **What:** Allow partners to reskin Deft with their own branding.
- **Why:** Revenue channel for agencies and consultancies. Unique to BSL-licensed products.
- **Effort:** 2–3 weeks
- **Approach:** Org-level branding table (logo, colors, app name). CSS variable overrides. Custom domain support. Remove Deft branding when white-label is active.

---

## Summary Timeline

| Phase | Timeline | Features | Strategic Goal |
|---|---|---|---|
| **Phase 1** | Weeks 1–3 | Webhooks, export, 2FA, calendar tasks, recurring tasks, templates, guest access | Remove adoption blockers |
| **Phase 2** | Weeks 3–6 | Manager dashboard, people directory, AI writing, thread summaries, workflow UI, custom emoji, semantic search | Deepen unique advantages |
| **Phase 3** | Weeks 6–10 | Public API, incoming webhooks, screen share, timeline view, Slack/Gmail integration, PWA | Expand platform reach |
| **Phase 4** | Weeks 10–16 | SSO, SCIM, advanced permissions, data retention, IP allowlisting, audit log UI | Enterprise readiness |
| **Phase 5** | Weeks 16–24 | Custom fields, subtask depth, roadmaps, goals/OKRs, sprints, rich wiki, desktop app | Product depth |
| **Phase 6** | Weeks 24+ | Mobile app, SFU, SOC 2, developer platform, white-label | Scale & polish |

---

## Competitive Gap Closure Tracker

Track how each phase moves the competitive needle:

| Gap (from analysis) | Current | After Phase 1 | After Phase 3 | After Phase 5 |
|---|---|---|---|---|
| Integration breadth | 2 working | 2 + webhooks (Zapier/Make) | 4 working + API + incoming webhooks | Full ecosystem |
| Timeline / Gantt | None | None | Basic | Good |
| Calendar view (tasks) | None | Good | Good | Good |
| Custom fields | None | None | None | Good |
| Sprints / cycles | None | None | None | Good |
| Recurring tasks | None | Full | Full | Full |
| Task templates | None | Full | Full | Full |
| Guest access | None | Good | Good | Good |
| Data export | None | Full | Full | Full |
| 2FA | None | Full | Full | Full |
| SSO / SCIM | None | None | None | Full |
| Screen sharing | None | None | Good | Good |
| AI writing | Basic | Basic | Good | Good |
| Rich wiki editor | Basic | Basic | Basic | Good |
| Mobile app | None | None | PWA | Native |
| Desktop app | None | None | None | Good |
| Public API | None | None | Read-only | Full |
| Goals / OKRs | None | None | None | Good |
| Manager dashboard (UI) | None | None (data exists) | Full | Full |
| People directory | None | None (data exists) | Full | Full |
