# Self-Hosting Deft

This guide covers first boot, production hardening, upgrades, and the main
operator tasks for a self-hosted Deft workspace.

## Overview

Self-hosted Deft is a single-workspace deployment. You run the database, Redis,
and application stack yourself. Your data stays on your infrastructure.

Each deployment supports one organisation. The first user to sign up becomes
the workspace owner; everyone else joins through invite links generated from
Settings -> Members. Hosting Deft as a managed service for other organisations
is outside the Business Source License 1.1 terms.

AI is bring-your-own-provider. Deft can use Anthropic, OpenAI, OpenRouter, or a
local Ollama server, but the core workspace works without any AI provider.

## Prerequisites

| Requirement | Notes |
|---|---|
| Docker Desktop 4.x+ | Includes Docker Compose v2 |
| openssl | Used to generate secrets; ships with macOS, Linux, Git for Windows |
| AI provider | Optional; configure later from Settings -> AI |

The stack runs comfortably on 2 vCPU / 4 GB RAM for small pilots.

## First Boot

### 1. Clone and configure

```bash
git clone https://github.com/Maneek21/Deft.git
cd Deft
cp .env.example .env
```

Open `.env` and set these required values:

```bash
openssl rand -hex 32   # paste into POSTGRES_PASSWORD
openssl rand -hex 32   # paste into JWT_SECRET
openssl rand -hex 32   # paste into JWT_REFRESH_SECRET
```

Replace `ENCRYPTION_KEY` before production. It must be exactly 32 characters.

Leave `OLLAMA_URL` commented unless an Ollama server is actually running.
Otherwise Deft will correctly show AI features as off until a provider is
configured.

If you are deploying to a remote server, set the public URLs before the first
build because Next.js bakes them into the browser bundle:

```bash
NEXT_PUBLIC_APP_URL=http://your-domain-or-ip:3000
NEXT_PUBLIC_API_URL=http://your-domain-or-ip:3001
NEXT_PUBLIC_WS_URL=http://your-domain-or-ip:3001
```

If signup or login shows "Failed to fetch", the browser is probably trying to
call the wrong API URL. Fix the `NEXT_PUBLIC_*` values and rebuild.

### 2. Start the stack

```bash
docker compose up -d --build
```

This builds Deft and starts Postgres with pgvector plus Redis. The first build
can take a few minutes.

### 3. Initialise the database

Run the one-shot init service once:

```bash
docker compose run --rm init
```

The init service runs `pnpm db:push-full && pnpm db:seed` inside the Deft image.
No host Node.js or pnpm install is required for the Docker self-host path.

`db:push-full` enables the `vector` extension, syncs the schema, and applies the
full-text-search extras Drizzle cannot express. `db:seed` seeds Defty, bundled
skills, task templates, and first-party employee templates. It is idempotent and
does not insert demo users.

### 4. Verify

```bash
docker compose run --rm doctor
```

The doctor checks API health, web reachability, browser/API origin agreement,
Postgres schema, Redis, and the platform seed.

### 5. Open the app

Open `http://localhost:3000`, create the first account, and keep that account as
the owner/admin seat.

## Production Overlay

For production, use the overlay that does not publish Postgres or Redis to host
ports:

```bash
docker compose -f docker-compose.yml -f compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f compose.prod.yml run --rm init
docker compose -f docker-compose.yml -f compose.prod.yml run --rm doctor
```

If default local ports are already occupied, change these values in `.env`
before building:

```bash
DEFT_WEB_PORT=3000
DEFT_API_PORT=3001
DEFT_BIND_HOST=127.0.0.1
DEFT_POSTGRES_PORT=5432
DEFT_REDIS_PORT=6379
```

The app still listens on ports 3000 and 3001 inside the container. These values
only control host-side published ports.

## Invites And Password Recovery

After the first account is created, direct signup is blocked. Add teammates from
Settings -> Members. Deft generates one-time invite URLs; share them out of band.

Self-hosted Deft does not send email. Password recovery is admin-generated:
owners/admins create recovery URLs from Settings -> Members and share them
manually.

## Agents

Defty is seeded by `docker compose run --rm init`. It becomes active once a
usable AI provider is configured. Without a provider, Defty and AI features stay
off while chat, tasks, notes, calendar, wiki, and the dashboard continue to work.

Bring-your-own-agent employees connect through MCP:

```text
POST https://your-domain.com/api/mcp/v1
```

Create an agent employee from Settings -> Agent Employees, copy the bearer token,
and paste the generated MCP config into your runtime.

## Environment Variables

| Variable | Required | Purpose | Default |
|---|---|---|---|
| `POSTGRES_PASSWORD` | Yes | Database password for Compose Postgres | none |
| `JWT_SECRET` | Yes | Signs access tokens | none |
| `JWT_REFRESH_SECRET` | Yes | Signs refresh tokens | none |
| `ENCRYPTION_KEY` | Production | Encrypts provider keys at rest; exactly 32 chars | dev value |
| `DATABASE_URL` | No for Compose | External Postgres URL for non-Compose installs | derived |
| `REDIS_URL` | No for Compose | External Redis URL for non-Compose installs | derived |
| `NEXT_PUBLIC_APP_URL` | Recommended | Public web URL and invite-link base | `http://localhost:3000` |
| `NEXT_PUBLIC_API_URL` | Recommended | Public API URL seen by browser | `http://localhost:3001` |
| `NEXT_PUBLIC_WS_URL` | Recommended | Public WebSocket/API URL seen by browser | `http://localhost:3001` |
| `API_PORT` | No | API port inside the app container | `3001` |
| `DEFT_WEB_PORT` | No | Host port for web | `3000` |
| `DEFT_API_PORT` | No | Host port for API | `3001` |
| `DEFT_BIND_HOST` | No | Host address for local DB/Redis publishing | `127.0.0.1` |
| `DEFT_POSTGRES_PORT` | No | Host Postgres port in local compose | `5432` |
| `DEFT_REDIS_PORT` | No | Host Redis port in local compose | `6379` |
| `ANTHROPIC_API_KEY` | No | Optional AI provider fallback | none |
| `OPENAI_API_KEY` | No | Optional AI provider/embedding/transcription fallback | none |
| `OPENROUTER_API_KEY` | No | Optional AI provider fallback | none |
| `OLLAMA_URL` | No | Optional local Ollama endpoint; set only when running | none |
| `R2_ENDPOINT` / `R2_ACCESS_KEY` / `R2_SECRET_KEY` / `R2_BUCKET` | No | Cloudflare R2 uploads | local uploads volume |
| `METRICS_SCRAPE_TOKEN` | No | Bearer token for `/api/metrics`; unset disables metrics | none |

## Backups

Persistent data lives in Docker volumes:

| Volume | Contents |
|---|---|
| `pgdata` | PostgreSQL data |
| `redisdata` | Redis data |
| `uploads` | User-uploaded files |

Postgres backup:

```bash
docker compose exec postgres pg_dump -U postgres deft > deft-backup-$(date +%Y%m%d).sql
```

Restore:

```bash
docker compose exec -T postgres psql -U postgres deft < deft-backup-20260101.sql
```

## Upgrading

Deft is alpha and does not yet publish stable tagged releases. To roll forward:

```bash
git pull
docker compose up -d --build
docker compose run --rm init
docker compose run --rm doctor
```

`docker compose run --rm init` is the supported schema/update path during the
alpha. Versioned `pnpm db:migrate` is not supported yet.

Before upgrading production, snapshot the Postgres volume or take a SQL backup.

## What's Not In Self-Hosted v1

- Managed hosting or one-click cloud deployments
- Multi-org / multi-tenant mode
- Email delivery for invites or password resets
- Native Slack/Gmail/GitHub OAuth promises
- Managed agent runtime provisioning
