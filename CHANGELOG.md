# Changelog

All notable changes to Deft are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and during the pre-1.0 alpha phase the project uses a loose interpretation of
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — minor versions
(`0.X.0`) may include breaking changes to schema, API contracts, or required
env vars. Patch versions (`0.X.Y`) are non-breaking fixes only.

## [Unreleased]

### Added

- Guided personal MCP connections for Codex, Claude, ChatGPT-compatible clients, and custom streamable HTTP MCP clients.
- Operational headless MCP tools for unread triage, context packets, people, teams, tasks, messages, notes, wiki, decisions, and calendar workflows.
- Task Table view, richer Timeline and Calendar interactions, persistent view preferences, and improved bulk operations.
- Profile, member, team, and linked-resource management with team dashboard summaries.
- Agent employee bridge supervision, structured-mention wakeup, assignment flows, and completion receipts.
- Synthetic 60-person workspace certification for isolation, job backlog, notification volume, bulk operations, and recovery exercises.

### Changed

- Reworked Defty planning so natural-language requests resolve through model-generated structured drafts, deterministic validation, approval, execution, and confirmation.
- Moved supported approval cards into the source conversation with an inbox mirror.
- Reworked chat knowledge capture into settled-window episode processing with quiet receipts.
- Simplified Connections, Agent employees, Inbox, Settings, Chat, Tasks, Knowledge, and Calendar interfaces across desktop and mobile.
- Standardized public positioning on source-available BSL 1.1, the self-hosted v1 integration contract, and current alpha boundaries.

### Fixed

- Scheduled chat-to-knowledge jobs now reach their registered handler.
- Agent task creation supports structured descriptions, subtasks, dependencies, and richer completion receipts.
- Personal MCP unread and owner-operator workflows avoid hidden-tool and keyword-search fallbacks.
- Mobile scrolling, navigation overlays, chat composers, avatar propagation, mentions, approval placement, and task-view interaction defects found during dogfooding.
- Self-host bootstrap, environment validation, health checks, and production preflight coverage.

## [0.1.0-alpha] — 2026-05-26

> Historical release snapshot. Some integrations and architecture described below were later retired or narrowed. Use [FEATURES.md](FEATURES.md), [current limitations](docs/current-limitations.md), and the self-hosted v1 contract for the current product boundary.

First public alpha. Deft is a source-available AI-native workspace: native chat
+ tasks + an AI agent (Defty) with direct SQL access to your data, plus a
Bring-Your-Own-Agent (BYOA) MCP surface for connecting external runtimes
(Claude Code, Claude Desktop, Codex, Cursor, custom MCP).

### Added — platform

- Multi-tenant Postgres + Drizzle ORM workspace with `org_id` row-level
  isolation on every table; soft-deletes throughout for agent history.
- Native chat surface: TipTap composer, threads, group DMs, pins, mentions,
  reactions, file uploads, presence + typing indicators over Socket.io
  (Redis adapter).
- Native tasks: 6-status engineering flow (`backlog → todo → in_progress →
  in_review → done → cancelled`), p0–p3 priority, Board / List / Timeline /
  Calendar / Pipeline views, labels, reactions, mentions in description +
  comments, recurrence (daily / weekly / biweekly / monthly), inline
  activity diff log, archive + soft-delete with 7-day recovery window.
- Unified `events` table for connected tool data so the agent queries native
  + Google Calendar / GitHub in one breath.
- Real-time over Socket.io with Redis adapter; background jobs via BullMQ.
- Custom JWT + bcrypt auth (jsonwebtoken + bcryptjs); Google OAuth optional.
- File storage via Cloudflare R2 or local disk with presigned uploads.

### Added — agent

- **Defty** — built-in platform agent. Runs in-process via Anthropic API
  with direct SQL access, 42+ native tools, multi-step planning, persistent
  memory (remember / recall), and streaming responses.
- **Multi-provider Defty** — pluggable reasoning backend:
  `anthropic` / `openai` (gpt-5.x and o-series via Responses API) /
  `openrouter` / `ollama`. Falls back gracefully if a provider key is unset.
- **BYOA employees** — every `agent_employees` row is an external runtime
  connecting via MCP at `/api/mcp/v1`. Per-employee trust levels, daily
  action caps, cost tracking ($100/day default), circuit breakers (3
  consecutive errors → `unhealthy` flag blocks dispatch).
- Three-tier approval flow: auto-execute / quick-approve / full-review.
- Three trust levels per org: Conservative / Standard / Autonomous.
- Workflow executor for the `task.status_changed` trigger with 4 actions
  (`add_comment` / `assign_to` / `add_label` / `notify`).
- GitHub `PR → task close`: parses `PREFIX-N` refs in PR title/body on the
  `pr_merged` transition and closes each referenced task with an
  attribution comment.
- Heartbeat lifecycle with per-tick logging (`agent_heartbeat_turns`),
  cost guardrails, idempotency via `prompt_sha`, and loop detection.
- Unified `/inbox` queue: mentions + DM unread + task notifications +
  agent approvals in one tab strip, with a single aggregated badge count.
- Skills primitive with three tiers (bundled / marketplace / org); 14-entry
  ClawHub allowlist bundled as a static fallback when the daily catalog
  fetch fails.
- Webhook-callable agents with HMAC-SHA256 signing (per-webhook key,
  constant-time comparison; legacy raw-secret accepted with deprecation
  warning).

### Security

- **Phase 7 hardening** — 10 vulnerabilities fixed:
  - XSS prevention via DOMPurify on all `dangerouslySetInnerHTML` sites (6
    components).
  - IDOR fixes on workflow-run / agent-message / wiki-citation delete
    endpoints (verify ownership before delete).
  - Space-membership enforcement on every space / message / pin endpoint
    and on the WebSocket `space:join` event.
  - Upload path traversal fix (`path.basename` + `Content-Disposition:
    attachment`).
  - Daily-notes optimistic locking via CAS version check (409 on
    conflict).
- Webhook signing migrated from raw-secret comparison to HMAC-SHA256.

### Changed — architecture

- **Phase 9 simplification** (2026-04-28): collapsed 5 agent kinds
  (`native`, `openclaw`, `claude_sdk`, `custom_mcp`, plus the unkinded
  built-in) down to 2 roles — Defty (in-process, well-known
  `deft-agent@system.local` system user) and BYOA (every
  `agent_employees` row, MCP-only).
- Removed the in-process gateway: `openclaw-gateway.ts`,
  `openclaw-dispatch.ts`, `openclaw-client.ts`, `openclaw-chat-envelope.ts`,
  the `gateway-ping.ts` worker, the `provider_instances` table, and 10
  OpenClaw sidecar columns on `agent_employees`. All archived under
  `docs/deprecated/openclaw/`.
- Trigger system retained — `trigger_subscriptions` still routes webhooks,
  `member.joined`, cron, and `task.status_changed` events into
  `agent_actions` rows that BYOA clients pull via `poll_pending_work`.
- **Phase 1–4 agent-chat unification** (2026-05-07): collapsed
  `agent_conversations` + `agent_messages` tables into the unified
  `spaces` + `messages` schema (each `/agent` conversation is a
  `spaces` row of type `agent_conversation`; each agent turn carries
  structured Anthropic content in `metadata.agent_blocks`). Deleted the
  dedicated `/agent` route — chat is now the only agent-conversation
  surface. Approval inbox promoted to a top-level `/approvals` page
  (now `/inbox?tab=approvals` after Phase 5).

### Known limitations

- **`pnpm db:push-full`** is required for fresh installs — not
  `db:push` or `db:migrate`. The `apply-extras.ts` script applies
  schema features `drizzle-kit push` can't express (`tsvector` generated
  columns + GIN indexes for wiki/task FTS; pgvector ivfflat indexes;
  expression-based unique indexes).
- **No transactional email** — invites and password recovery are
  admin-generated one-time URLs (shared out-of-band by an admin).
- **API can't deploy to Vercel** — WebSocket support required.
  Use Railway, Fly.io, or any container host. The Next.js web app
  deploys to Vercel fine.
- **No Supabase support** — blocked in India.
- Repo history still contains ~44 MB of audit screenshots (cleaned in
  #26, not history-rewritten — history rewrite would break in-flight
  forks/clones during alpha).

### License

[BSL 1.1](LICENSE) — free for any purpose except hosting as a service
for third parties. Mandatory attribution in forks. Each release
auto-converts to Apache 2.0 four years after its release date.

[Unreleased]: https://github.com/Maneek21/Deft/compare/v0.1.0-alpha...HEAD
[0.1.0-alpha]: https://github.com/Maneek21/Deft/releases/tag/v0.1.0-alpha
