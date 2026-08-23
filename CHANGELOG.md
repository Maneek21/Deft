# Changelog

All notable changes to Deft are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and during the pre-1.0 alpha phase the project uses a loose interpretation of
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — minor versions
(`0.X.0`) may include breaking changes to schema, API contracts, or required
env vars. Patch versions (`0.X.Y`) are non-breaking fixes only.

## [Unreleased]

## [0.3.0-preview.7] — 2026-08-23

### Changed

- The release-pinned Hermes integration bundle is now version `0.2.1` and
  includes the fresh-install reliability fixes and their regression coverage.

### Fixed

- Hermes service reinstall, repair, stop, and uninstall now terminate both the
  bridge child and its verified PowerShell supervisor so refreshed credentials
  cannot be shadowed by a stale environment.
- Deft employee policy recognizes Hermes's real `mcp_deft_*` tool namespace as
  governed Deft work while continuing to block unapproved external writes.
- Idle channel status no longer sends a null event ID, and ambiguous transport
  failures no longer replay a non-idempotent Hermes inference request and
  duplicate long-running work.

## [0.3.0-preview.6] — 2026-08-23

### Added

- Agent Channel v2 compatibility negotiation, lease/fencing capability checks,
  release and schema readiness metadata, and a release-pinned Hermes integration
  bundle with complete checksums.
- End-to-end employee certification now proves real channel delivery, Hermes
  runtime inference, employee-scoped MCP calls, a nonce-bearing reply, terminal
  outcome reporting, and wiki memory recall/writeback before showing Ready.

### Changed

- Runtime transport contact, health, and employee readiness are now distinct UI
  states. A polling process can no longer make an uncertified employee appear
  ready to work.
- The Windows Hermes service uses structured semantic health and fails closed on
  incompatible protocol versions instead of retrying malformed work forever.

### Fixed

- Prevented newer Hermes bridges from consuming older unclaimed Agent Channel
  events, which previously caused silent non-response and unbounded redelivery.
- Fresh-install and supported-upgrade gates now require Agent Channel leases and
  wiki memory-sync schema before the API reports ready.

## [0.3.0-preview.3] — 2026-08-22

Delta from `v0.3.0-preview.2`. Deft remains alpha.

### Added

- Structured text attachments are now bound to their exact org and message,
  authorized through the same space-membership rules as chat, and presented to
  the agent as untrusted user data with filename/type/size provenance.
- Defty can deterministically compile an attached CSV into one governed,
  full-review module bulk-import proposal. The generic importer resolves the
  target from installed manifests, validates every header/value, limits batches
  to 100 rows, and uses per-row receipts/idempotency so replay cannot duplicate
  records.
- The certified App Protocol v2 implementation contract now defines closed
  Modules, provider-neutral Capabilities, staged App Packs, encrypted Governed
  App Runs, cross-app references, explicit grants, and the Native Equivalence
  branch gate.

### Security

- Retrieved wiki and agent-memory context remain outside system instructions
  and are explicitly framed as untrusted data on the current user turn.
- Agent-authored approval proposals use the canonical actor boundary, cannot
  impersonate a human requester, and recheck live membership, module access,
  employee health, trust, and action budgets before execution.
- Signed action receipts redact secret-like input fields while preserving stable
  verification semantics.
- Attachment lookup is exact-message and exact-org scoped with path containment,
  media/size limits, and no generic filesystem access.
- Bulk-import approval/history/receipts retain row counts, field names, digests,
  and resource IDs but scrub CSV row values and raw retry keys.

### Changed

- Release-tagged GHCR images are keylessly signed with Cosign. The release job
  verifies the workflow identity and GitHub build provenance for the exact image
  digest before it can create a GitHub Release.
- Versioned-upgrade CI now snapshots representative chat, task, wiki, team, and
  agent-action data from a populated `v0.2.0-preview.1` database, runs the entire
  checksummed upgrade chain twice, and requires byte-for-byte preservation.
- Self-hosting docs now provide digest-first signature/provenance verification
  commands and explicitly document forward-only migration recovery.

## [0.3.0-preview.2] — 2026-08-20

Delta from `v0.3.0-preview.1`. Deft remains alpha.

### Changed

- Multi-collection modules, including bundled Contacts, use header
  collection tabs on every viewport. Desktop no longer renders a second
  left rail next to the workspace sidebar.
- Product browser smoke now asserts Contacts collection tabs and the
  absence of a second collections aside.

## [0.3.0-preview.1] — 2026-08-19

First AGPL-3.0-only preview. This is the delta from `v0.2.0-preview.4`.
Earlier `[Unreleased]` notes that already shipped on the `0.2.0-preview`
line are not repeated here.

### Added

- Declarative Modules v1: first-class Deft applications defined through
  strict `deft.module.json` manifests, reusing storage, permissions,
  search, approvals, receipts, tasks, audit, and agent access.
- Bundled Contacts module as a manifest-defined CRM surface for contacts,
  companies, deals, and activities — not CRM code in core.
- Module distribution, provenance locking, sideloading, immutable module
  versions, compatible upgrades, and runtime verification for bundled
  module artifacts.

### Changed

- Relicensed the current release line from BSL 1.1 to GNU AGPL v3.0 only.
  Historical tags through `v0.2.0-preview.4` retain the licenses shipped
  in those revisions. Relicensing does not rewrite old tags or images.
- Removed Redis/BullMQ from the supported runtime. Scheduled work uses
  PostgreSQL `job_queue` with in-process workers.
- Hardened live chat reconnect behavior so subscriptions survive socket
  reconnects.
- Updated dependency and security-tooling pins used by the release line
  (pnpm action, CodeQL, patch/minor group).

### Fixed

- Destructive pilot knowledge-receipt seeding now uses real
  message-backed sources, explicit simulated-history metadata,
  tenant-scoped replacement, and deterministic planning.
- Chat browser smoke assertions are scoped to actual message rows.
- Cross-org receipt semantics are preserved in the module runtime.
- Preview GitHub Releases now attach `.env.example` and include it in
  `SHA256SUMS`. Shell `dist/*` previously omitted that dotfile.

## [0.2.0-preview.1 — 0.2.0-preview.4]

Historical BSL 1.1 preview releases. These tags introduced the portable
preview-image and self-host upgrade line and remain licensed under the
terms included in those revisions.

See the GitHub Releases page and tag comparisons for exact historical
contents.

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

### License at release

The `0.1.0-alpha` tag was originally published under BSL 1.1. The current
codebase has since been relicensed under [GNU AGPL v3.0 only](LICENSE); consult
the license file present in the exact revision you use.

[Unreleased]: https://github.com/Maneek21/Deft/compare/v0.3.0-preview.7...HEAD
[0.3.0-preview.7]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.7
[0.3.0-preview.6]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.6
[0.3.0-preview.3]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.3
[0.3.0-preview.2]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.2
[0.3.0-preview.1]: https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.1
[0.2.0-preview.1 — 0.2.0-preview.4]: https://github.com/Maneek21/Deft/releases/tag/v0.2.0-preview.4
[0.1.0-alpha]: https://github.com/Maneek21/Deft/releases/tag/v0.1.0-alpha
