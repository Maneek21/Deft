# Self-Hosting Deft

This guide covers first boot, production hardening, upgrades, and the main
operator tasks for a self-hosted Deft workspace.

## Overview

Self-hosted Deft is a single-workspace deployment. You run the PostgreSQL
database and application stack yourself. Your data stays on your infrastructure.

Each deployment supports one organisation. The first user to sign up becomes
the workspace owner; everyone else joins through invite links generated from
Settings -> Members. This one-workspace boundary is the supported v1 product
contract, not a license restriction. AGPL-3.0-only permits network use under
its terms, including the Corresponding Source obligation for modified versions.

AI is bring-your-own-provider. Deft can use Anthropic, OpenAI, OpenRouter, or a
local Ollama server, but the core workspace works without any AI provider.

Background and scheduled work runs through Deft's PostgreSQL-backed job queue;
Redis and BullMQ are not runtime dependencies. See the
[job queue architecture decision](./decisions/2026-08-17-postgres-job-queue.md).

## Prerequisites

| Requirement | Notes |
|---|---|
| Docker Desktop 4.x+ | Includes Docker Compose v2 |
| openssl | Used to generate secrets; ships with macOS, Linux, Git for Windows |
| AI provider | Optional; configure later from Settings -> AI |

The stack runs comfortably on 2 vCPU / 4 GB RAM for small pilots.

## First Boot

### Choose source build or named release

The source-build path below is the most flexible option for contributors.
Tagged preview releases also publish an amd64 image to
`ghcr.io/maneek21/deft`. The release image injects `NEXT_PUBLIC_APP_URL`,
`NEXT_PUBLIC_API_URL`, and `NEXT_PUBLIC_WS_URL` when the container starts, so
the same image works on localhost or a custom domain.

For a named release, download `docker-compose.yml`, `compose.prod.yml`,
`compose.release.yml`, and `.env.example` from the GitHub release into one
directory. Then set:

```bash
DEFT_IMAGE=ghcr.io/maneek21/deft:<release-version>
```

Use the release overlay in every application/tool command:

```bash
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml pull
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml up -d postgres
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm init
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml up -d deft
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm doctor
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm smoke
```

Release assets include `SHA256SUMS`, an SPDX SBOM, and a manifest containing
the exact commit, image digest, keyless-signing identity, provenance type, and
upgrade baseline. Release-tagged images are signed by the release workflow and
carry GitHub build provenance. Verify the digest before deploying it:

```bash
export TAG=v0.3.0-preview.3
export VERSION="${TAG#v}"
export IMAGE=ghcr.io/maneek21/deft
export DIGEST="$(docker buildx imagetools inspect "$IMAGE:$VERSION" --format '{{json .Manifest.Digest}}' | tr -d '"')"
cosign verify "$IMAGE@$DIGEST" \
  --certificate-identity "https://github.com/Maneek21/Deft/.github/workflows/release.yml@refs/tags/$TAG" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
gh attestation verify "oci://$IMAGE@$DIGEST" --repo Maneek21/Deft
```

Compare `DIGEST` with `release-manifest.json`, then set `DEFT_IMAGE` to the
immutable `ghcr.io/maneek21/deft@<digest>` reference. A release workflow fails
before creating the GitHub release if signing, signature verification,
provenance publication, or provenance verification fails. Use `init` only for
a fresh database. Versioned release upgrades begin at `v0.2.0-preview.1` and
use the dedicated `upgrade` service described below.

### Fast path: one-command bootstrap

If you are working from a cloned repo with Node.js and pnpm available on the
host, use the bootstrap wrapper:

```bash
pnpm selfhost:bootstrap
```

That validates `.env`, builds and starts Compose, runs the database init, runs
the doctor, and runs the OAuth/MCP smoke test. For a demo/pilot environment
with seeded Testers Tomatoes data:

```bash
pnpm selfhost:bootstrap --seed-pilot
```

For a hardened production overlay:

```bash
pnpm selfhost:bootstrap --prod
```

To validate `.env` before starting or rebuilding containers:

```bash
pnpm selfhost:bootstrap --prod --check-only
```

The Docker-only path below remains supported and does not require host-side
Node.js or pnpm.

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
DEFT_SOURCE_CODE_URL=https://example.com/your-fork/tree/EXACT_COMMIT
```

Official images default this source offer to the exact upstream release. If
you expose a modified Deft server to users over a network, set
`DEFT_SOURCE_CODE_URL` to a no-charge, publicly reachable copy of the exact
Corresponding Source you run, including the scripts needed to build and install
it. The in-product `/license` page presents this link to users.

If signup or login shows "Failed to fetch", the browser is probably trying to
call the wrong API URL. Fix the `NEXT_PUBLIC_*` values and rebuild.

### 2. Start the stack

```bash
docker compose build deft init doctor smoke
docker compose up -d
```

This builds the app and one-shot tool images, then starts Postgres with pgvector.
The first build can take a few minutes. Building `init`, `doctor`,
and `smoke` alongside `deft` matters on updates because those services run
schema and verification code from the image.

### 3. Initialise the database

Run the one-shot init service once:

```bash
docker compose run --rm init
```

The init service first refuses any database that already contains application
tables, then runs `pnpm db:push-full && pnpm db:seed` inside the Deft image.
No host Node.js or pnpm install is required for the Docker self-host path.

`db:push-full` enables the `vector` extension, syncs the schema, and applies the
supplemental SQL files for search indexes and safe metadata backfills that
Drizzle cannot fully express. `db:seed` seeds Defty, internal agent/tool bundles,
task templates, and first-party employee templates. It is idempotent and does not
insert demo users.

### 4. Verify

```bash
docker compose run --rm doctor
```

The doctor checks API health, web reachability, browser/API origin agreement,
the Postgres schema, and the platform seed.

Then run the public connector smoke test:

```bash
docker compose run --rm smoke
```

The smoke test verifies API health, OAuth discovery metadata, dynamic client
registration, MCP initialize, and the protected MCP auth challenge. To also
exercise an authenticated MCP `tools/list` call, set `DEFT_MCP_BEARER_TOKEN` in
`.env` to a personal MCP token from Settings -> MCP Access and rerun smoke.

### 5. Open the app

Open `http://localhost:3000`, create the first account, and keep that account as
the owner/admin seat.

## Fresh Reset For A Pilot Or Internal Workspace

Use `selfhost:reset` when the stack already exists and you want to return it to
a clean first-user experience. The command takes a Postgres backup by default,
stops only the app container, drops and recreates the application schema, clears
the local uploads volume, runs the supported `init` path, restarts
the app, and then runs doctor + smoke. It rebuilds the app and tool images before
the destructive reset so the validation containers match the checked-out code.

Empty internal workspace, ready for the first owner signup:

```bash
pnpm selfhost:reset --platform-only --force
```

Fresh Testers Tomatoes/demo workspace:

```bash
pnpm selfhost:reset --seed-pilot --force
```

For a public or production-overlay deployment, the command intentionally needs a
second confirmation flag:

```bash
pnpm selfhost:reset --prod --platform-only --force --force-production-reset
```

If your server uses a site-specific Compose overlay, append it after the base
and production files:

```bash
pnpm selfhost:reset --prod --compose-file compose.demo.yml --platform-only --force --force-production-reset
```

Preview the exact plan without touching data:

```bash
pnpm selfhost:reset --prod --platform-only --dry-run
```

Take only a backup:

```bash
pnpm selfhost:backup --prod
```

Reset safety notes:

- `--force` is required for any real reset.
- `--force-production-reset` is also required when URLs or overlays look public.
- Backups are written to `./backups` unless `--backup-dir` is supplied.
- Use `--skip-build` only when you intentionally want to reuse the existing
  Docker images.
- The command never deletes Docker volumes or reverse-proxy state.
- Use `--keep-uploads` only when you intentionally want files to survive.

## Production Overlay

For production, use the overlay that does not publish Postgres to host ports:

```bash
docker compose -f docker-compose.yml -f compose.prod.yml build deft init doctor smoke
docker compose -f docker-compose.yml -f compose.prod.yml up -d
docker compose -f docker-compose.yml -f compose.prod.yml run --rm init
docker compose -f docker-compose.yml -f compose.prod.yml run --rm doctor
docker compose -f docker-compose.yml -f compose.prod.yml run --rm smoke
```

If default local ports are already occupied, change these values in `.env`
before building:

```bash
DEFT_WEB_PORT=3000
DEFT_API_PORT=3001
DEFT_BIND_HOST=127.0.0.1
DEFT_POSTGRES_PORT=5432
```

The app still listens on ports 3000 and 3001 inside the container. These values
only control host-side published ports.

For a full VPS, DNS, reverse proxy, and HTTPS runbook, see
[`docs/self-hosting-vps-domain-https.md`](./self-hosting-vps-domain-https.md).

## Invites And Password Recovery

After the first account is created, direct signup is blocked. Add teammates from
Settings -> Members. Deft generates one-time invite URLs; share them out of band.

Self-hosted Deft does not send email. Password recovery is admin-generated:
owners/admins create recovery URLs from Settings -> Members and share them
manually.

## MCP Access And Agents

Defty is seeded by `docker compose run --rm init`. It becomes active once a
usable AI provider is configured. Without a provider, Defty and AI features stay
off while chat, tasks, notes, calendar, wiki, and the dashboard continue to work.

Human employees can connect personal AI clients through Settings -> MCP Access.
Create a personal token, choose read-only or write-enabled scopes, and paste the
generated streamable HTTP MCP config into Claude Desktop, Claude Code, ChatGPT
MCP clients, or any compatible MCP runtime. Personal tokens act as the user who
created them. Writes create tasks, messages, and wiki pages under that user's
identity. With the corresponding scopes, personal clients can also manage the
user's notes, native calendar events, inbox state, assigned approvals, projects,
saved task views, and bounded agent-employee state. Initial authentication,
connector authorization, member administration, credentials, billing, and
irreversible deletion remain UI-only. In that sense Deft is operationally
headless after setup, not a UI-free product.

### AI client compatibility

Deft exposes a streamable HTTP MCP endpoint at:

```text
https://your-domain.com/api/mcp/v1
```

For remote AI apps that support OAuth MCP, use the public endpoint and Deft's
OAuth discovery metadata:

```text
https://your-domain.com/.well-known/oauth-protected-resource
https://your-domain.com/.well-known/oauth-authorization-server
```

For clients that support HTTP MCP but do not complete OAuth, create a personal
token in Settings -> MCP Access and use it as a bearer token.

| Client | Status | Recommended setup |
|---|---|---|
| Claude Code | Verified with Deft remote HTTP MCP. Runtime tool use still depends on the user's Claude Code subscription/API access. | `claude mcp add --transport http deft https://your-domain.com/api/mcp/v1`, then authenticate if the client asks. |
| Codex CLI / IDE | Codex documents streamable HTTP MCP with bearer-token and OAuth support. | Add Deft as a streamable HTTP MCP server in Codex config. Use OAuth when available, or a personal bearer token from Settings -> MCP Access. |
| ChatGPT main app | Account gated. Developer Mode/custom MCP apps are not visible in every plan or workspace. | In an eligible ChatGPT workspace, create a custom app/connector that points at the Deft MCP endpoint and follows the OAuth flow. |
| Claude Desktop / Claude web | Support varies by surface and release channel. | Prefer OAuth when the client offers it; otherwise use a personal bearer token if HTTP MCP headers are supported. |
| Generic MCP runtime | Compatible when it supports streamable HTTP plus OAuth or bearer headers. | Point the runtime at `/api/mcp/v1` and grant only the scopes needed for that workflow. |

Start pilots with read-only scopes (`read:workspace`, `read:wiki`,
`read:tasks`, `read:messages`, `read:calendar`). Add write scopes only when the
user expects that AI client to create or update Deft records under their own
identity. The write scopes are `write:tasks`, `write:messages`, `write:wiki`,
`write:calendar`, and `write:workspace`. The broad workspace scope covers notes,
inbox state, approvals, projects, saved views, and owner/admin-only agent state;
it does not expose secrets or member administration.

Bring-your-own-agent employees connect through MCP:

```text
POST https://your-domain.com/api/mcp/v1
```

Create an agent employee from Settings -> Agent Employees, copy the bearer token,
and paste the generated MCP config into your runtime. Agent employee tokens act
as that employee and are governed by the employee's trust level, approval rules,
health status, and MCP audit log.

Personal tokens and agent employee tokens use the same endpoint, but they are not
the same authority model. Use personal tokens when a human wants their own AI
assistant to help with work. Use agent employee tokens when an autonomous or
semi-autonomous runtime should show up as a shared coworker in Deft.

## Environment Variables

| Variable | Required | Purpose | Default |
|---|---|---|---|
| `POSTGRES_PASSWORD` | Yes | Database password for Compose Postgres | none |
| `JWT_SECRET` | Yes | Signs access tokens | none |
| `JWT_REFRESH_SECRET` | Yes | Signs refresh tokens | none |
| `ENCRYPTION_KEY` | Production | Encrypts provider keys at rest; exactly 32 chars | dev value |
| `DATABASE_URL` | No for Compose | External Postgres URL for non-Compose installs | derived |
| `NEXT_PUBLIC_APP_URL` | Recommended | Public web URL and invite-link base | `http://localhost:3000` |
| `NEXT_PUBLIC_API_URL` | Recommended | Public API URL seen by browser | `http://localhost:3001` |
| `NEXT_PUBLIC_WS_URL` | Recommended | Public WebSocket/API URL seen by browser | `http://localhost:3001` |
| `DEFT_SOURCE_CODE_URL` | Required for modified public deployments | Public Corresponding Source URL shown on `/license` | Image-embedded upstream source URL |
| `API_PORT` | No | API port inside the app container | `3001` |
| `DEFT_WEB_PORT` | No | Host port for web | `3000` |
| `DEFT_API_PORT` | No | Host port for API | `3001` |
| `DEFT_BIND_HOST` | No | Host address for local database publishing | `127.0.0.1` |
| `DEFT_POSTGRES_PORT` | No | Host Postgres port in local compose | `5432` |
| `ANTHROPIC_API_KEY` | No | Optional AI provider fallback | none |
| `OPENAI_API_KEY` | No | Optional AI provider/embedding/transcription fallback | none |
| `OPENROUTER_API_KEY` | No | Optional AI provider fallback | none |
| `OLLAMA_URL` | No | Optional local Ollama endpoint; set only when running | none |
| `R2_ENDPOINT` / `R2_ACCESS_KEY` / `R2_SECRET_KEY` / `R2_BUCKET` | No | Cloudflare R2 uploads | local uploads volume |
| `METRICS_SCRAPE_TOKEN` | No | Bearer token for `/api/metrics` and `/health/queue`; unset disables detailed telemetry | none |

## Backups

Persistent data lives in Docker volumes:

| Volume | Contents |
|---|---|
| `pgdata` | PostgreSQL data |
| `uploads` | User-uploaded files |

Upgrades from a release that bundled Redis may leave an orphaned Redis
container and `redisdata` volume. Deft does not remove either automatically.
After confirming no other workload uses them, an operator may identify the
exact Compose project resources with `docker ps -a` and `docker volume ls`, then
remove those exact resources manually. Back up anything uncertain first.

Postgres backup:

```bash
pnpm selfhost:backup
```

The backup command writes a gzip-compressed SQL dump to `./backups`. For the
production overlay:

```bash
pnpm selfhost:backup --prod
```

Raw Docker equivalent:

```bash
docker compose exec postgres pg_dump -U postgres deft > deft-backup-$(date +%Y%m%d).sql
```

Restore from an uncompressed SQL dump:

```bash
docker compose exec -T postgres psql -U postgres deft < deft-backup-20260101.sql
```

Restore from a `.sql.gz` backup:

```bash
gunzip -c backups/deft-backup-20260101T120000Z.sql.gz | docker compose exec -T postgres psql -U postgres deft
```

## Upgrading

The first supported versioned schema baseline is `v0.2.0-preview.1`. The
upgrader fingerprints an untracked database before adopting that baseline,
records checksums in `deft_schema_migrations`, applies each later migration in
a transaction, and refuses unknown, newer, or modified migration histories.

For a source checkout:

```bash
git pull --ff-only
pnpm selfhost:upgrade --prod
```

For a named GHCR release, set the target image and use the release overlay:

```bash
export DEFT_IMAGE=ghcr.io/maneek21/deft:<target-version>
pnpm selfhost:upgrade --prod --release
```

The wrapper builds or pulls the target image before downtime, stops app writes,
writes a compressed Postgres backup, runs the `upgrade` service, recreates the
app, and requires doctor plus MCP smoke to pass. Site-specific overlays can be
appended with `--compose-file <file>`.

Schema upgrades are forward-only. The migration ledger is checksummed and a
failed migration transaction rolls back, but there is no automatic downgrade
path after a successful upgrade. Recovery means stopping Deft, restoring the
pre-upgrade Postgres backup and uploads backup, and running the exact previous
image digest. Rehearse that restore on a disposable host before upgrading data
that cannot be recreated.

Preview the exact sequence without changing data:

```bash
pnpm selfhost:upgrade --prod --release --dry-run
```

Database-only checks are also available inside the target image:

```bash
pnpm db:upgrade --status
pnpm db:upgrade --dry-run
pnpm db:upgrade
```

Do not run `init`, `db:push-full`, or raw `db:migrate` as an upgrade mechanism.
If the upgrader rejects a pre-preview or incomplete schema, restore the backup
and use a reviewed migration or a fresh deployment. Uploads remain in the
Docker volume and are not deleted by the upgrade command; back them up according
to your storage policy before high-risk changes.

See [current limitations](current-limitations.md) before upgrading production.

## What's Not In Self-Hosted v1

- Managed hosting or one-click cloud deployments
- Multi-org / multi-tenant mode
- Email delivery for invites or password resets
- Native Slack/Gmail/GitHub OAuth promises
- Managed agent runtime provisioning
