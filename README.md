# Deft

### Where humans and agents work together.

[![CI](https://github.com/Maneek21/Deft/actions/workflows/ci.yml/badge.svg)](https://github.com/Maneek21/Deft/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0--only-7c5cff.svg)](./LICENSE)
[![Status: Alpha](https://img.shields.io/badge/status-alpha-f59e0b.svg)](#project-status-and-limitations)

[Website](https://deft.ing) | [Self-hosting guide](docs/self-hosting.md) | [Contributing](CONTRIBUTING.md)

Deft is a self-hostable, open-source workspace where people and AI agents share chat, tasks, knowledge, calendar context, approvals, and action history.

Capture a team discussion into knowledge, ask Defty to propose a task using that context, review and approve the proposal, and keep the agreed details in the resulting task.

**Alpha:** for technical evaluation and controlled pilots. The walkthrough uses **seeded demo data**; it is not evidence of a live customer workspace or an active external agent runtime.

[![Watch the full walkthrough — 5:09](https://i.ytimg.com/vi/7z9EH4c9k2o/hqdefault.jpg)](https://youtu.be/7z9EH4c9k2o)

[**Watch the full walkthrough — 5:09.**](https://youtu.be/7z9EH4c9k2o)

## Quick start with Docker

Use the prebuilt [v0.3.0-preview.15 release](https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.15) for evaluation. It targets **Linux amd64** and needs Docker Desktop or Docker Engine with Compose v2. An AI provider is optional. No source build, Node.js, or pnpm is needed for this path.

Download `docker-compose.yml`, `compose.prod.yml`, `compose.release.yml`, and `default.env.example` from that release into a **new directory**. In Bash (macOS, Linux, or Git Bash on Windows):

```bash
cp default.env.example .env
openssl rand -hex 32  # POSTGRES_PASSWORD
openssl rand -hex 32  # JWT_SECRET
openssl rand -hex 32  # JWT_REFRESH_SECRET
openssl rand -hex 32  # ENCRYPTION_KEY
```

Paste each independently generated secret into its corresponding `.env` variable. All four are required for Docker, including local evaluation. Keep the encryption key with your backups. Leave AI keys empty and `OLLAMA_URL` commented unless you intend to configure a provider.

Add this pinned release image to `.env`:

```dotenv
DEFT_IMAGE=ghcr.io/maneek21/deft@sha256:665a66083adaaf9db876fa815203c854509c5fdde72b89a0db212fe2e07d398b
```

Then run, from that directory:

```bash
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml config --quiet
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml pull
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml up -d postgres
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm init
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml up -d deft
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm doctor
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm smoke
```

Open [http://localhost:3000](http://localhost:3000) and create the first account, which owns the workspace. Subsequent users join by invitation. This creates an empty workspace with the platform bundle, not the video's demo records. Create a chat message and a task to try the core workspace without AI.

Use `init` only with a fresh database. For custom ports, public URLs, image verification, source builds, backups, and upgrades, follow the [self-hosting guide](docs/self-hosting.md). Versioned upgrades start at `v0.2.0-preview.1`; use the backup-first upgrade flow for existing workspaces. Historical releases through `v0.2.0-preview.4` retain their shipped BSL 1.1 license; the selected release is AGPL-3.0-only.

**Try Deft:** [install a workspace, connect your AI client, or build an internal App](docs/getting-started.md). See the [current availability map](docs/product-status.md) before enabling an experimental feature.

[Architecture](#architecture) · [Current limitations](docs/current-limitations.md) · [Licensing](#license)

## The core loop

1. **Capture the discussion.** Save useful decisions and references in Knowledge with links back to their source conversation.
2. **Ask Defty for a task.** With an AI provider configured, Defty can use workspace context to propose the title, owner, dates, and description.
3. **Review and approve.** Under a policy requiring review, inspect the proposed details before approving. Trust settings can permit some actions to execute automatically.
4. **Keep the agreed details.** The task stores the approved content, and governed agent actions have approval history and receipts to inspect.

Optional video chapters: [Knowledge capture — 1:09](https://youtu.be/7z9EH4c9k2o?t=69) · [Defty task request and approval — 2:06](https://youtu.be/7z9EH4c9k2o?t=126) · [ChatGPT connection and workspace read/write — 3:25](https://youtu.be/7z9EH4c9k2o?t=205).

**Personal MCP connections use a different authority model.** ChatGPT and other personal clients act as the authorizing user within their granted scopes and normal permissions. Their writes do not automatically enter Deft's agent approval queue. Defty and Agent Employees use agent identities and policy-based approval flows. See [MCP access and agents](docs/self-hosting.md#mcp-access-and-agents).

![A live Deft workspace](docs/assets/repository/dashboard.png)

## What ships today

### A workspace people can use normally

- Real-time chat with spaces, DMs, threads, mentions, reactions, files, presence, and rich text
- Task management with Board, Table, Timeline, Calendar, Pipeline, and personal views
- Notes, company knowledge, channel memory, decisions, references, and knowledge graph views
- Native calendar events plus read-only ICS subscriptions
- Dashboard, inbox, notifications, people, teams, roles, and profile management
- Dark and light themes, desktop and mobile layouts

### A work record agents can use safely

- Built-in Defty workflows for workspace questions and governed native actions
- Personal MCP access for Codex, Claude, ChatGPT, and streamable HTTP MCP clients
- Agent employees that can participate in channels, receive assignments, and use Deft tools
- Native task, message, wiki, note, calendar, member, team, and context-packet tools
- Approval tiers, trust levels, token scopes, revocation, activity history, and action receipts
- Provider-neutral AI configuration: OpenAI, Anthropic, OpenRouter, OpenAI-compatible endpoints, or local Ollama-style providers

Deft still works as a normal workspace without an AI provider key. Chat, tasks, notes, knowledge, calendar, people, and teams remain available; AI features stay disabled until a provider is configured.

### An extensible workspace through Modules and Apps

Modules add domain records, relationships, and native views. Apps package supported workspace extensions for operator review and installation. Declarative internal Apps, connected Apps, and bounded scheduled actions are opt-in alpha capabilities and remain disabled by default. Arbitrary custom UI and public portals are planned rather than part of the current contract.

The bundled **Contacts** module is the first example of this model. The goal is not to turn Deft's core into every application a company might need, but to let new capabilities live on the same shared substrate instead of becoming another disconnected system.

## Product surfaces

### Chat keeps the source conversation attached

Chat is both a human communication surface and part of the workspace record. Threads, structured mentions, quiet knowledge capture, and agent replies keep decisions close to their source.

![Deft chat](docs/assets/repository/chat.png)

### Tasks turn context into accountable work

Projects support Board, Table, Timeline, Calendar, and Pipeline views, plus dependencies, subtasks, recurrence, comments, activity diffs, bulk actions, and agent-created drafts.

![Deft task table](docs/assets/repository/tasks-table.png)

### Knowledge becomes durable team memory

Deft separates transient conversation from durable concepts, entities, decisions, resources, procedures, preferences, and facts. Agents can ask for org-wide or channel-specific context instead of reading an undifferentiated transcript.

![Deft knowledge](docs/assets/repository/knowledge.png)

### Connect the AI app you already use

The Connections page guides each user through the setup required by their client. Personal connections act as that user, inherit their access boundaries, expose explicit scopes, and can be revoked.

![Deft connections](docs/assets/repository/connections.png)

## Why Deft is different

| Traditional stack | Deft |
|---|---|
| Chat, tasks, docs, calendar, and AI live in separate products | One work record connects the discussion, assigned work, durable memory, and agent action |
| Context is copied into an AI conversation by hand | Agents retrieve permission-aware workspace context through MCP or native tools |
| Agent writes are invisible or happen outside the workspace | Proposed writes can require approval and completed work leaves a receipt |
| AI is tied to one vendor or sidebar | Teams can use Defty, Codex, Claude, ChatGPT, or their own agent runtime |
| SaaS data and behavior are controlled by a vendor | The product is self-hostable and open source under AGPL-3.0-only |

## Local development

Requirements: Node.js 22.13+, the pnpm version pinned in `package.json`, and a running PostgreSQL 16 database with pgvector. Set the four secrets in `.env` and `DATABASE_URL` for your disposable development database before initialization; see [Contributing](CONTRIBUTING.md).

```bash
git clone https://github.com/Maneek21/Deft.git
cd Deft
pnpm install
cp .env.example .env
# Set the four secrets and DATABASE_URL before continuing.
pnpm db:push-full
pnpm db:seed
pnpm dev
```

Useful development seeds:

```bash
pnpm db:seed:demo   # Testers Tomatoes demo data
pnpm db:seed:pilot  # Demo data plus pilot fixtures
```

Both development seeds reset the database. Never run them against a production workspace.

## Architecture

```text
deft/
|-- apps/
|   |-- web/       Next.js 16, React 19, Tailwind CSS, TipTap
|   `-- api/       Hono, Socket.io, PostgreSQL job workers, agent and MCP runtime
|-- packages/
|   |-- db/        PostgreSQL, pgvector, Drizzle schema and migrations
|   |-- mcp/       Shared MCP protocol support
|   `-- shared/    Shared types, schemas, and constants
|-- docker-compose.yml
`-- pnpm-workspace.yaml
```

| Layer | Technology |
|---|---|
| Web | Next.js 16, React 19, TypeScript, Tailwind CSS v4, TipTap |
| API | Hono on Node.js |
| Data | PostgreSQL 16, pgvector, Drizzle ORM |
| Realtime | Socket.io in-process (single app instance) |
| Jobs | PostgreSQL `job_queue` and in-process workers |
| Auth | Email/password with bcrypt, JWT access tokens, and refresh tokens |
| AI | Provider-neutral routing plus MCP |
| Storage | Local disk with R2-compatible paths |
| Monorepo | pnpm workspaces |

## Project status and limitations

Deft is an **alpha**. It is suitable for technical evaluation, internal dogfooding, and controlled pilots. Expect breaking changes before a stable release.

Important current boundaries:

- One workspace per self-hosted deployment is the supported product contract.
- Versioned upgrades are supported from the `v0.2.0-preview.1` baseline forward; older untracked alpha databases require a reviewed migration or fresh install.
- Native Google, Slack, Gmail, and GitHub OAuth integrations are not part of the current self-hosted v1 promise. Use ICS for calendar subscriptions and bring external tools through your own agent or MCP runtime.
- Agent quality depends on the configured model, scopes, workspace data, and approval policy.
- This repository is open source under GNU AGPL v3.0 only.

Security reports should follow [SECURITY.md](SECURITY.md). Operational support boundaries are documented in [docs/self-hosted-v1-contract.md](docs/self-hosted-v1-contract.md).

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), run the relevant tests, and open a focused pull request.

If Deft is useful to you, starring the repository helps more teams find the project.

## License

Deft is free software licensed under the [GNU Affero General Public License
v3.0 only](LICENSE) (`AGPL-3.0-only`). You may use, study, modify, and
redistribute it subject to the license terms. If you modify Deft and let users
interact with that version over a network, section 13 requires you to offer
those users its Corresponding Source.

Public modified deployments should set `DEFT_SOURCE_CODE_URL` to the
public URL for the exact source they run. See [NOTICE](NOTICE) for the project
copyright notice and [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) for
third-party attribution.
