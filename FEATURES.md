# Deft capability reference

> Last verified against the repository on July 16, 2026.
>
> Deft is an alpha. This file describes the current product surface, not a compatibility guarantee. See [current limitations](docs/current-limitations.md) and the [roadmap](ROADMAP.md) before planning a production deployment.

## Product model

Deft is a self-hostable work record shared by human employees and AI agents.

- **Chat is the conversation surface.** Messages, threads, mentions, files, and decisions remain attached to the people and spaces where work happened.
- **Tasks are the action surface.** Projects turn intent into assigned, trackable work.
- **Knowledge is the memory surface.** Durable facts, decisions, procedures, and references can be organized at org, space, or personal scope.
- **Approvals are the governance surface.** Agent writes can be drafted, reviewed, approved, dismissed, and audited.
- **MCP is the headless access surface.** Personal AI apps and agent employees can use permission-aware workspace tools.

## Workspace surfaces

### Chat

- Public and private spaces, direct messages, and group DMs
- Threads with independent read state
- Rich text, links, code, lists, block quotes, files, and inline media
- Structured mentions, message and task references, emoji reactions, pins, and saved messages
- Typing state, online/idle presence, custom status, and do-not-disturb
- Scheduled messages, message history, and quiet chat-to-knowledge capture
- Huddles and asynchronous audio/video clips, subject to browser and deployment support
- Defty and agent employees participate in the same chat surfaces as people

### Tasks

- Projects with human-readable task keys
- Fixed status model: backlog, to do, in progress, in review, done, cancelled
- P0 through P3 priority, assignees, reporters, labels, start dates, due dates, estimates, and recurrence
- Board, Table, Timeline, Calendar, Pipeline, and personal task views
- Inline Table editing, sorting, column controls, and persistent per-user view preferences
- Drag and resize scheduling in Timeline, calendar placement, and board drag-and-drop
- Subtasks, dependencies, task relationships, comments, reactions, watchers, and activity diffs
- Bulk selection and bulk status, priority, assignment, move, and delete operations
- Task creation from chat and agent-drafted task plans with approval
- Project archive and soft delete with recovery support

### Notes

- Personal and workspace note scopes
- Rich text editing, pinning, search, and optimistic concurrency protection
- Agent note search, read, create, and note-to-wiki tools

### Knowledge

- Wiki types: concept, entity, decision, resource, procedure, preference, and fact
- Org, space, and personal scopes
- Full-text and semantic retrieval with source citations
- Links, backlinks, graph views, confidence indicators, and operations history
- Channel memory and org-wide company memory views
- Scheduled knowledge lint and maintenance jobs
- Context packets for agents that combine relevant messages, tasks, wiki pages, decisions, people, and calendar context

### Calendar

- Native workspace events
- Read-only ICS subscriptions and polling sync
- Month, week, and day views
- Workspace calendar context available to Defty and scoped MCP clients
- Calendar connection health, last sync, and error state in settings

### Dashboard and inbox

- Personal work summary, overdue and in-progress work, calendar context, and workspace attention
- Customizable dashboard widgets
- Unified inbox tabs for messages, mentions, task notifications, captures, and approvals
- Inline approval actions in the inbox and on supported chat messages
- Real-time notification delivery plus durable notification state

## People and teams

- Profiles with uploaded or preset avatars, role, title, timezone, status, and notification preferences
- Workspace roles: owner, admin, member, and guest where enabled by the surface
- Member invitation, activation, deactivation, role management, and search
- Teams with leads, members, linked spaces, projects, wiki pages, notes, and calendars
- User groups for reusable group mentions
- Permission-aware private space membership and org-scoped data access
- Team dashboard summaries and agent activity visibility

## Defty

Defty is the built-in workspace agent. It can read native Deft context and propose or execute supported workspace actions.

Current capabilities include:

- Answer questions about visible messages, tasks, notes, wiki pages, decisions, people, teams, and calendars
- Resolve natural-language references against the current conversation and workspace
- Draft and create tasks, including structured descriptions, subtasks, dependencies, and assignments
- Update task fields and transition task status
- Draft and post messages or thread replies
- Create or update wiki pages and notes
- Read and write space canvases
- Link decisions to tasks and mark decisions implemented
- Produce approval cards in chat and mirror pending approvals in the inbox
- Post completion confirmations with result details for supported actions

Defty is not a deterministic rules engine. Output quality depends on the configured provider, model, available context, permissions, and request clarity. Validation, approval policy, and executor contracts remain authoritative even when the model proposes an invalid action.

## Agent employees

Agent employees are separate workspace identities backed by a customer-controlled runtime.

- Onboard from Settings -> Agent employees
- Receive a scoped employee token for `/api/mcp/v1`
- Participate in DMs and group spaces
- Wake from structured mentions and assigned work
- Read unread work, claim tasks, post progress, and complete supported actions
- Operate under trust level, scope, health, action-cap, audit, and approval rules
- Expose supervision state, recent contact, failures, and bridge health to admins

Deft does not require a specific agent framework. A compatible runtime can be built with Hermes, Codex, Claude, or another streamable HTTP MCP client. The external runtime is operated separately from the Deft application stack.

## Personal AI app connections

Human employees can connect their own AI client from Settings -> Connections.

- Streamable HTTP MCP endpoint at `/api/mcp/v1`
- OAuth authorization for compatible remote connector clients
- Personal bearer tokens for clients that accept HTTP headers
- Guided setup for Codex, Claude Code, Claude and Claude Desktop, ChatGPT-compatible web apps, and custom clients
- Read-only and work-capable scope bundles
- Tokens act as the user who created them and inherit that user's workspace access
- Connection history, last use, recent actions, scopes, and revocation
- Idempotency support on write tools to reduce duplicate agent actions

Representative MCP tools cover:

- Workspace, project, space, member, team, task, message, note, wiki, decision, and calendar reads
- Unread triage and owner-operator workspace summaries
- Task create, update, transition, comment, and bulk workflows
- Message and thread posting
- Wiki and note writes
- Context-packet retrieval and memory recall

Client availability and connector UI vary by vendor and account tier. Deft cannot guarantee that every AI product enables custom MCP connections for every user.

## Governance and audit

- Approval tiers: automatic, quick approval, and full review
- Org trust levels: Conservative, Standard, and Autonomous
- User and agent identity preserved on native actions
- Pending approval cards in the source conversation where supported
- Inbox mirror for centralized approval review
- Execution receipts, recent agent actions, and audit history
- Token scopes, revocation, daily action limits, cost accounting, and circuit breakers
- Space membership checks on REST and WebSocket access
- Org ownership checks on task, wiki, workflow, message, and agent operations

## AI providers

Deft supports provider-neutral AI configuration:

- OpenAI
- Anthropic
- OpenRouter
- OpenAI-compatible endpoints
- Local Ollama-style endpoints

Provider keys are optional. Core workspace functionality remains available without AI.

## Self-hosting and operations

- Docker Compose stack for web, API, PostgreSQL, initialization, doctor, and smoke checks
- Environment validation and one-command bootstrap helpers
- Health endpoints for application and dependency checks
- Backup and reset scripts with explicit safety gates
- PostgreSQL 16, pgvector, Drizzle ORM, a PostgreSQL-backed job queue, and Socket.io
- Local file storage with R2-compatible configuration paths
- Production guidance for VPS, domain, HTTPS, and reverse proxy setup
- Synthetic 60-person certification tooling for isolation, bulk operations, job backlog, notification volume, and recovery exercises

Fresh installs currently use `pnpm db:push-full`. A supported versioned upgrade workflow is still deferred; see [current limitations](docs/current-limitations.md).

## Security posture

- Org scoping on workspace data
- Private-space membership enforcement
- XSS sanitization on rich rendered content
- Ownership checks on destructive routes
- Upload path and content-disposition hardening
- HMAC validation for agent webhooks
- Encrypted provider and connection secrets
- Optimistic locking on daily notes
- Private vulnerability reporting through GitHub Security Advisories

Deft has not completed an independent security audit and does not claim SOC 2, HIPAA, ISO 27001, or an uptime SLA.

## Current integration contract

The supported self-hosted v1 integration paths are:

- Native Deft workspace tools
- Native Deft calendar events
- Read-only ICS calendar subscriptions
- Personal MCP connections
- MCP-backed agent employees
- Customer-owned external tools exposed through that customer's agent runtime

Native Slack, Gmail, GitHub, Google Calendar OAuth, Linear, Notion, and similar managed connectors are not current buyer-facing promises. Legacy source or enum values may remain for compatibility.

## Deliberate non-goals for the current alpha

- First-party managed multi-customer hosting as a supported product offering
- Native iOS, Android, Electron, or Tauri apps
- Offline-first operation
- Enterprise compliance certification or uptime SLA
- Full portfolio planning, OKRs, sprint analytics, or custom report builder
- Managed third-party OAuth catalog
- Guaranteed autonomous execution without model, permission, and approval constraints

## Source and license

Deft is open source under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). The license permits commercial and non-commercial use, modification, and distribution under its terms. Operators who modify Deft and let users interact with that version over a network must offer those users the Corresponding Source as required by section 13.
