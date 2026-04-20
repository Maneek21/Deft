# Self-Hosting Deft

This guide covers everything you need to run Deft on your own infrastructure — from first boot through production hardening.

## Overview

Self-hosted Deft is a single-workspace deployment of the Deft platform. You run the database, Redis, and application stack yourself. Your data never leaves your server, and you bring your own AI API key.

Each deployment supports **one organisation**. This is by design: self-hosted Deft is meant for a single team, not a multi-tenant SaaS offering. The first user to sign up becomes the org owner and admin; subsequent users join via invite link only. Attempting to host Deft as a managed service for other organisations is outside what the Business Source License 1.1 permits — see [Licence & what's not in v1](#licence--whats-not-in-v1) for details.

Defty, the built-in native agent, is seeded automatically on first run. Think of Defty as your workspace's default AI crew member — already hired, already configured, ready to take on tasks. You can also connect your own agents via the MCP protocol (see [Hiring your first crew member](#hiring-your-first-crew-member)).

## Prerequisites

| Requirement | Notes |
|---|---|
| Docker Desktop 4.x+ | Includes Docker Compose v2. [Download](https://www.docker.com/products/docker-desktop/) |
| Anthropic API key | Free tier at [console.anthropic.com](https://console.anthropic.com). Required for AI features. |
| `openssl` (any version) | For generating secrets. Ships with macOS, Linux, Git for Windows. |

**Alternative AI provider:** If you prefer not to use Anthropic, [Ollama](https://ollama.com) can serve a local model. You will need to update `ANTHROPIC_API_KEY` and the model references in Settings → Agent after first boot. Ollama support is community-maintained.

**Hardware:** The stack runs comfortably on 2 vCPU / 4 GB RAM. Postgres and Redis together use under 100 MB at idle.

## First Boot

### 1. Clone and configure

```bash
git clone https://github.com/deft-dev/deft.git
cd deft
cp .env.example .env
```

Open `.env` in your editor. You must set these three variables before starting:

```bash
# Generate secrets — run each command separately
openssl rand -hex 32   # paste result into JWT_SECRET
openssl rand -hex 32   # paste result into JWT_REFRESH_SECRET
```

| Variable | Where to get it | Required |
|---|---|---|
| `JWT_SECRET` | `openssl rand -hex 32` | Yes |
| `JWT_REFRESH_SECRET` | `openssl rand -hex 32` | Yes |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com | Yes for AI features |

Everything else in `.env` is optional for a first boot. Leave the database and Redis URLs as-is — Docker Compose overrides them automatically.

### 2. Start the stack

```bash
docker compose up -d
```

Docker pulls `postgres:16-alpine` and `redis:7-alpine`, builds the Deft image, and starts all three services. The first build takes 2–4 minutes depending on your connection. Subsequent starts are instant.

Wait for Postgres to be healthy before continuing (the compose file already enforces this via `depends_on`). You can check with:

```bash
docker compose ps
```

All three services should show `healthy` or `running`.

### 3. Initialise the database

The container does not auto-migrate on startup. Run these from the repo root **once**, after the stack is up:

```bash
# Apply the schema
pnpm db:push

# Seed Defty and starter data
pnpm db:seed
```

`pnpm db:push` talks to Postgres at `localhost:5432` (exposed by Docker Compose). `pnpm db:seed` seeds the Defty agent template, default skills, and starter prompts. Both commands are idempotent — safe to run again if something goes wrong.

> **No pnpm locally?** Install it with `npm install -g pnpm`, then run the commands above. Node.js 18+ is required.

### 4. Open the app

Navigate to **http://localhost:3000**. You should see the Deft sign-up screen.

## Creating Your First Account

The very first user to complete sign-up becomes the **organisation owner** — the account with full admin rights over the workspace. Choose this account carefully; it will be the admin seat going forward.

After the first account is created, direct sign-up is blocked for all subsequent users. The org owner invites additional users from **Settings → Members → Invite**. Invited users receive an email link (requires `RESEND_API_KEY` in `.env`) or you can copy the invite link from the UI and share it manually.

Password reset also requires email configured. Without `RESEND_API_KEY`, you can reset passwords directly in the database:

```sql
-- Connect to the container
docker compose exec postgres psql -U postgres deft

-- Update password hash (use bcrypt — generate at bcrypt-generator.com)
UPDATE users SET password_hash = '<new-bcrypt-hash>' WHERE email = 'user@example.com';
```

## Hiring Your First Crew Member

Deft agents are configured from **Settings → Agent**. The Connect Agent wizard has three tabs:

### Native (Defty)

Defty is the built-in native agent seeded by `pnpm db:seed`. It runs inside the Deft process using the Anthropic API key you configured. No additional setup required — Defty is already active after seeding.

Defty's behaviour is defined by the `defty` template. You can inspect and customise it from Settings → Agent → Defty.

### BYOA via MCP

Bring Your Own Agent lets you connect any MCP-compatible agent runtime to your workspace. The MCP endpoint is:

```
POST https://your-domain.com/api/mcp/v1
```

Authentication uses a bearer token issued from **Settings → Agent → Connect → BYOA**. Copy the token and configure it in your agent client.

**Supported clients:**
- [Claude Desktop](https://claude.ai/download) — add the MCP server in `claude_desktop_config.json`
- [Claude Code](https://claude.ai/claude-code) — configure via `/mcp` command
- Any client that speaks the MCP over HTTP+SSE transport

**Claude Desktop example config** (`~/.config/claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "deft": {
      "url": "http://localhost:3001/api/mcp/v1",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

### Custom MCP

For custom OpenClaw runtimes or self-built MCP servers, the Custom tab lets you register a named endpoint with a pre-shared bearer token. The agent connects outbound to Deft over the same `/api/mcp/v1` interface.

## Meeting Defty

Defty is the default agent seeded into every fresh Deft deployment. Defty can read and write tasks and messages, run multi-step plans, summarise threads, and proactively nudge overdue work — all subject to the approval flow you configure in Settings → Agent → Trust.

Defty is powered by the `defty` agent template. The template slug is `defty`. You can view the full system prompt from Settings → Agent → Defty → Edit template.

## Environment Variables Reference

| Variable | Required | Purpose | Default |
|---|---|---|---|
| `DATABASE_URL` | Yes (auto-set by Docker) | Postgres connection string | `postgres://postgres:postgres@localhost:5432/deft` |
| `REDIS_URL` | Yes (auto-set by Docker) | Redis connection string | `redis://localhost:6379` |
| `JWT_SECRET` | **Yes** | Signs access tokens | none |
| `JWT_REFRESH_SECRET` | **Yes** | Signs refresh tokens | none |
| `ANTHROPIC_API_KEY` | Yes for AI | Anthropic Claude API key | none |
| `NEXT_PUBLIC_API_URL` | No | API base URL seen by browser | `http://localhost:3001` |
| `NEXT_PUBLIC_WS_URL` | No | WebSocket URL seen by browser | `http://localhost:3001` |
| `NEXT_PUBLIC_APP_URL` | No | App base URL (used in invite links) | `http://localhost:3000` |
| `API_PORT` | No | Port the API listens on | `3001` |
| `RESEND_API_KEY` | No | Sends invite and password-reset emails | none |
| `FROM_EMAIL` | No | From address for outbound email | `noreply@deft.dev` |
| `GOOGLE_CLIENT_ID` | No | Enables Google OAuth login | none |
| `GOOGLE_CLIENT_SECRET` | No | Enables Google OAuth login | none |
| `R2_ENDPOINT` | No | Cloudflare R2 endpoint for file storage | none (uses local disk) |
| `R2_ACCESS_KEY` | No | R2 access key | none |
| `R2_SECRET_KEY` | No | R2 secret key | none |
| `R2_BUCKET` | No | R2 bucket name | none |
| `METRICS_SCRAPE_TOKEN` | No | Bearer token for `GET /api/metrics`. Unset = endpoint disabled (503) | none |

When `DATABASE_URL` or `REDIS_URL` are set in `.env`, the `docker-compose.yml` `environment:` block takes precedence for those two — the container always connects to the Compose-managed Postgres and Redis regardless of what is in `.env`.

## Backups

All persistent data lives in two Docker named volumes:

| Volume | Contents |
|---|---|
| `pgdata` | PostgreSQL data directory |
| `redisdata` | Redis RDB snapshot |
| `uploads` | User-uploaded files |

**Postgres backup (recommended):**

```bash
docker compose exec postgres pg_dump -U postgres deft > deft-backup-$(date +%Y%m%d).sql
```

**Restore:**

```bash
docker compose exec -T postgres psql -U postgres deft < deft-backup-20260101.sql
```

Schedule this with cron or any job scheduler. For production, consider streaming WAL replication to a replica or using a managed Postgres service that handles backups for you.

## Upgrading

Deft follows semantic versioning. Minor and patch releases are safe to roll forward; major releases may include breaking schema changes — check the release notes before upgrading.

```bash
# Pull the latest image and restart
docker compose pull
docker compose up -d

# Apply any new schema changes
pnpm db:migrate   # uses Drizzle migrations (safer than db:push in production)
```

`db:migrate` applies only pending migrations. `db:push` force-syncs the schema and is fine for development but should be avoided in production where you want a migration history.

**Rollback:** Docker Compose does not keep the old image by default. Before upgrading, tag the current image or snapshot the `pgdata` volume so you have a restore point.

## Licence & What's Not in v1

Deft is licensed under the **Business Source License 1.1**. You may use, modify, and distribute Deft freely for any internal purpose. You may **not** offer Deft as a hosted or managed service to third parties. The licence converts to Apache 2.0 four years after each release. See [LICENSE](../LICENSE) for the full text.

**Not included in self-hosted v1:**

- Managed hosting or one-click cloud deployments
- A skills/agent marketplace or plugin registry
- Gateway push (outbound webhooks from Deft to external services)
- Per-org spend caps or usage billing
- Multi-org / multi-tenant mode
