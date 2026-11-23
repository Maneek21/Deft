# Self-Hosting Deft

This guide covers first boot, production hardening, upgrades, and the main
operator tasks for a self-hosted Deft workspace.

## Overview

Self-hosted Deft is a single-workspace deployment. You run the PostgreSQL
database and application stack yourself. Workspace storage is on your infrastructure;
configured AI providers and external clients can receive workspace content as
described under [AI data flow](#ai-data-flow).

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
| Docker Desktop or Docker Engine | A running Linux container engine and Compose v2 |
| openssl | Used to generate secrets; ships with macOS, Linux, Git for Windows |
| AI provider | Optional; configure later from Settings -> AI |

Start with 2 vCPU / 4 GB RAM for a small evaluation and measure resource use on
your workload. This is a starting configuration, not a capacity guarantee.
Commands below use Bash; Windows users can use Git Bash with Docker Desktop.

## First Boot

### Recommended: prebuilt release

For the independently sideloaded Email developer preview, use a Host
built with the **apps-developer-preview** browser profile, such as
`v0.3.0-preview.144`; its `browser-feature-evidence.json` lists the profile. Follow the independent
[Email setup guide](https://github.com/Maneek21/deft-email/blob/main/docs/setup.md)
and the `compatibility.json` attached to the Email release being installed
for the exact Host version and image digest, schema version, sealed Kit downloads, HTTPS/OAuth and
Runtime configuration.
This path requires an operator; it is not the stable
core quick start below. Feature flags beginning `NEXT_PUBLIC_` are compiled
into the browser bundle. Setting them only when a container starts does not
enable Apps, resource sync or attachments missing from that build. Server gates,
purpose-separated keys, reviewed grants and the independent Runtime are also
required. Keep only one active Host when operating the small demo database;
overlapping Host processes consume separate connection pools.

For a fresh evaluation, follow the [README quick start](../README.md#quick-start-with-docker),
which pins `v0.3.0-preview.144` and its image digest. Use that release's own Compose
files and environment template together; this source checkout can differ from
the published image. The source-build instructions below are for contributors.
Tagged preview releases publish an amd64 image to
`ghcr.io/maneek21/deft`. The release image injects `NEXT_PUBLIC_APP_URL`,
`NEXT_PUBLIC_API_URL`, and `NEXT_PUBLIC_WS_URL` when the container starts, so
the same image works on localhost or a custom domain.

For a named release, download `docker-compose.yml`, `compose.prod.yml`,
`compose.release.yml`, `default.env.example`, `self-hosting.md`,
`release-manifest.json`, and `SHA256SUMS` from the selected GitHub release into
a new directory. Copy
`default.env.example` to `.env`. Generate separate values with `openssl rand -hex 32`
for **all four** required secrets: `POSTGRES_PASSWORD`, `JWT_SECRET`,
`JWT_REFRESH_SECRET`, and `ENCRYPTION_KEY`. Production startup requires distinct
JWT signing keys of at least 32 characters, rejects known template/default values
and surrounding whitespace, and preserves accepted key bytes exactly. Docker
runs in production mode even on localhost. Set the image in `.env` (the tag has no leading `v`):

```bash
DEFT_IMAGE=ghcr.io/maneek21/deft:0.3.0-preview.144
```

For another host or port, set `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`,
and `NEXT_PUBLIC_WS_URL` to the browser-reachable URLs first. Keep their defaults
for localhost ports 3000/3001. Leave provider keys empty for a basic evaluation.

Host `v0.3.0-preview.123` pins the reviewed PostgreSQL 16.15 / pgvector 0.8.6 image in `docker-compose.yml`. Keep that immutable database image with this preview's deployment assets: fresh initialization and upgrade lineage checks include PostgreSQL and extension versions, so a floating `pg16` tag can produce an unrecognized catalog.

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
upgrade baseline. New `deft.release.v2` manifests explicitly identify
`release_scope` as `core` or `hermes-certified`. Core releases contain no Hermes
bundle or certification claims. Historical `deft.release.v1` manifests retain
their original release-specific Hermes evidence. Hermes-certified releases include
`hermes-employee-release-gate.json` and
`deft-hermes-integration-<version>.tar.gz`. The release manifest binds their
SHA-256 digests, the bundle manifest and content digests, compatibility range,
and exact tested Hermes runtime. Release-tagged images are signed by the release
workflow and carry GitHub build provenance. Verify checksums and the image
digest before deploying or installing the Hermes bundle:

```bash
export TAG="$(jq -r .tag release-manifest.json)"
export VERSION="${TAG#v}"
export IMAGE=ghcr.io/maneek21/deft
export DIGEST="$(docker buildx imagetools inspect "$IMAGE:$VERSION" --format '{{json .Manifest.Digest}}' | tr -d '"')"
export SIGNATURE_IDENTITY="$(jq -r .signature_identity release-manifest.json)"
cosign verify "$IMAGE@$DIGEST" \
  --certificate-identity "$SIGNATURE_IDENTITY" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
gh attestation verify "oci://$IMAGE@$DIGEST" --repo Maneek21/Deft
```

Verify downloaded assets against `SHA256SUMS`; older checksum files may name
`default.env.example` as `.env.example`, so verify the unedited template under
that name before copying it to `.env`. Do not compare your secret-filled `.env`
against the template checksum. Image verification above additionally requires
`jq`, Cosign, Docker Buildx, and GitHub CLI.

Compare `DIGEST` with `release-manifest.json` and verify every downloaded asset
against `SHA256SUMS`. For a Hermes-certified release, also confirm the manifest's
Hermes archive and certificate digests before extracting the integration. That
scope requires two consecutive clean-state gates against the manifest-pinned
runtime and an archive that exactly matches the certified bundle. Core releases
omit those integration artifacts; they still require image signing, provenance,
SBOM and corresponding source. Then set `DEFT_IMAGE` to the immutable
`ghcr.io/maneek21/deft@<digest>` reference. Use `init` only for a fresh database.
Versioned release upgrades begin at `v0.2.0-preview.1` and use the dedicated
`upgrade` service described below.

Preview.15 is a core release and carries no new Hermes certification or
integration bundle; a configured employee identity is not proof of a running
external runtime.

### Source checkout: bootstrap wrapper

If you are working from a cloned repo with Node.js and pnpm available on the
host, first complete the clone and configuration step below, then use the
bootstrap wrapper:

```bash
pnpm install --frozen-lockfile
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
openssl rand -hex 32   # paste into ENCRYPTION_KEY
```

All four are required for Docker, including local evaluation. `ENCRYPTION_KEY`
must be a unique, non-placeholder secret of at least 32 characters.

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
call the wrong API URL. Fix the `NEXT_PUBLIC_*` values. Rebuild source images;
for prebuilt releases, recreate the app container with `up -d --force-recreate deft`
and the same three Compose files so startup injects the new URLs.

### 2. Start the stack

```bash
docker compose build deft init doctor smoke
docker compose up -d postgres
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
After successful initialization, start the app:

```bash
docker compose up -d deft
```

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
the Postgres schema, database/host clock agreement, and the platform seed.

Run the doctor on the API host so its clock check compares the systems that
produce record timestamps. If database time differs by more than five seconds
(allowing for request latency), synchronize the host and database/VM clocks
before continuing. Creation and audit entries can use database time while
updates and action runs use API time; clock drift can make an update appear
earlier than creation. The doctor only checks time and never rewrites historical
timestamps. Recheck after suspending or resuming a local VM.

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
the owner/admin seat. Post a message in a space, then create and update a task.
Doctor and smoke check infrastructure and connector protocol behavior; they do
not prove first login, chat, task creation, or a model-driven approval flow.

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
docker compose -f docker-compose.yml -f compose.prod.yml up -d postgres
docker compose -f docker-compose.yml -f compose.prod.yml run --rm init
docker compose -f docker-compose.yml -f compose.prod.yml up -d deft
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

Core self-hosted account recovery does not send email. This is separate from the independently installed Email App. Password recovery is admin-generated:
owners/admins create recovery URLs from Settings -> Members and share them
manually. Admins can make new admins (invite or promote someone who has never been
an owner or admin), but only the owner can change, remove, re-invite or recover a
person who is or was an owner or admin, a pending admin invite included. The same
applies to an agent that is or was an owner or admin: only the owner resets its
keys, manages its API keys and webhooks, pauses or resumes it, or edits, clones or
deletes it. Admins manage member-level agents as before.

If the owner has forgotten their password, an operator with shell access to the
server prints a one-time recovery URL (valid 24 hours):

```bash
docker compose exec deft sh -c "cd /app/apps/api && node --import tsx src/scripts/make-recovery-url.ts owner@example.com"
```

A recovery URL sets a new password only. It never removes two-step
verification: the person still needs a code from their authenticator app or one
of their recovery codes. Signing in with a recovery code signs out every session that
person has and gives no session of its own: they must first set up a new authenticator
(30 minutes from the sign-in, in the same browser tab), which replaces the old one and
their recovery codes. Until then the old authenticator and the unused recovery codes
still work.

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

For a copyable CRM workflow, see the [CRM AI assistant guide](crm-ai-assistants.md).

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
`read:tasks`, `read:messages`, `read:calendar`, `read:modules`). Add write scopes only when the
user expects that AI client to create or update Deft records under their own
identity. The write scopes are `write:tasks`, `write:messages`, `write:wiki`,
`write:calendar`, `write:workspace`, and `write:modules`. App workflows additionally
use `read:apps`, `invoke:apps`, and `read:app-runs`. The broad workspace scope covers notes,
inbox state, approvals, projects, saved views, and owner/admin-only agent state;
it does not expose secrets or member administration.

Bring-your-own-agent employees connect through MCP:

```text
POST https://your-domain.com/api/mcp/v1
```

Create an agent employee from Settings -> Agent Employees, copy the bearer token,
and paste the generated MCP config into your runtime. Agent employee tokens act
as that employee and are governed by the employee's trust level, approval rules,
health status, and MCP audit log. Deft does not record what an employee's own runtime spends, so the per-employee daily cost budget never triggers. The daily action cap (`max_daily_actions`) is enforced; use it and your runtime's own limits to bound cost. The unhealthy (circuit breaker) state also applies.

Personal tokens and agent employee tokens use the same endpoint, but they are not
the same authority model. Use personal tokens when a human wants their own AI
assistant to help with work. Use agent employee tokens when an autonomous or
semi-autonomous runtime should show up as a shared coworker in Deft.

### Identity, approvals, and action history

Personal ChatGPT and other MCP connections act as the authorizing user. Scopes
limit available tools; handlers also enforce the user's organization, role,
membership, and resource access. Personal native writes execute under that user
and do **not** automatically enter the Agent Employee approval queue. A personal
client with `write:workspace` can also exercise the user's permitted approval
actions, so grant that scope deliberately.

Defty and Agent Employees use agent identities. The API routes governed writes
through tool tiers and trust policy, then resolves required approvals on the
server. In the shared tier policy, Conservative auto-executes `auto` actions,
Standard also permits `quick`, and Autonomous also permits `full`. No trust level
auto-runs a call classed as destructive (admin tools, `delete_*` tools, module
archive and unlink, bulk record creation, or a delete, pause or revoke mode); those
always wait for approval. Individual workflows can require stricter review.
Task creation is normally `quick`; posting a message is `full`. A task proposal
in the walkthrough is not a promise that every configured task write pauses.

Two rules sit on top of the tier policy. Defty's chat writes always wait for
approval, at every trust level; the workspace trust level governs only Defty's
approved plans and background work. An agent employee's own chat messages (post,
reply, direct message) run without approval at every trust level, within guard
rails: space membership and visibility, the reply-storm detector, the daily action
cap, and the unhealthy (circuit breaker) state, in which the message waits for
approval over MCP or is refused on the Agent Channel. Everything else an employee writes follows that employee's own
trust level. Passive task-candidate extraction from chat is disabled by default; operators can enable it with `DEFT_ENABLE_BACKGROUND_TASK_CAPTURE=1`. Defty does not manage agent employees, connections or triggers. A connected tool that declares itself
destructive always needs approval. Only an action's requester, or an owner or
admin who still has access to the target, can undo it.

An agent action is reviewed by the member who requested it. Owners and admins review when there is no active human requester; they read another active member's request in activity and history. An approver assignment makes a member a reviewer only when this rule does. The Inbox approval list and its counts, Attention and the personal MCP approval tools use this rule for the approvals they list and count.

An agent employee can cite the chat message it answers in a proposal
(`source_message_id`, or `params.source_message_id` for `request_human_approval`);
when the server recorded that the message's author, then a non-guest member,
addressed the employee with it, the proposal is not tied to another delivery or
room and is made within 24 hours, and the author is now an active human member,
not a guest, who can read the room, the author reviews it. Personal MCP approval tools follow the same rule as the web.
A wiki proposal that cites a message from a room the page does not take its
sources from is refused when proposed (`WIKI_SOURCE_MESSAGE_ROOM`). Agent
webhooks are managed by owners and admins.

Requests under `/api` need a web session (CORS preflight is answered by the CORS
policy) unless the path is one of the
routes that use their own authentication or are intentionally public (auth, MCP,
Agent Channel, webhooks, invites, metrics, App developer pairing, App runtime and
public App routes, `POST /api/agent-webhooks/:slug` and ICS feed URLs). Link previews are fetched only from public internet
addresses. Calendar feeds are too, except the exact URLs an operator lists in
`DEFT_CALENDAR_PRIVATE_URL_ALLOWLIST`.

### Internal calendar feeds

On a self-hosted install (`DEFT_SELF_HOSTED=true`, exactly), set
`DEFT_CALENDAR_PRIVATE_URL_ALLOWLIST` to a JSON array of exact feed URLs, for
example `["http://radicale.lan:5232/team/work.ics"]`. A listed URL may use its
own port and may resolve to loopback, RFC 1918 or IPv6 unique-local addresses;
cloud metadata addresses are always refused. Matching is by the whole URL
(scheme, host, port, path and query; `webcal://` counts as `https://`), with no
wildcards or prefixes, and an entry may not contain credentials. Redirects from a
listed URL are followed only to another listed URL. A malformed value disables
the list and logs a warning. The variable is ignored on hosted installs and
cannot be set by workspace owners or admins.

Every account that knows a listed URL, members and guests alike, can have the
server fetch that exact URL repeatedly and import its events. List only
read-only feed URLs, and update the entry when a feed's token rotates.

The resolver checks review authority and action state and claims pending work
before execution. Repeated approval of a completed action returns its existing
state. Idempotency and stale-target checks vary by tool; do not assume global
exactly-once execution or that every intervening edit invalidates a proposal.
Inspect the proposed details and current target before approving.

Personal token/grant revocation blocks subsequent authenticated calls. It does
not undo completed writes or withdraw content already read by an external client.
Governed agent actions use signed receipts; personal MCP calls have OAuth/MCP
audit history. Receipts use a deployment-held HMAC secret, not independent
third-party proof. Receipt recording can fail after a write succeeds, so inspect
the resulting record and operational logs when reconciling an uncertain result.

### Knowledge and AI data flow

Knowledge capture stores durable wiki records and source citations. Visibility
is scoped to the organization and, for restricted pages, the owner or space
membership. A source link is evidence to inspect, not a guarantee that an AI
summary is correct. Correct the durable knowledge record as well as the source
when needed; do not assume editing a chat message rewrites every derived page or
already-created task. Wiki editing and version history support human correction.

#### AI data flow

With a provider enabled, classification/extraction can send chat content to the
configured model, and Defty can send prompts, retrieved messages, tasks, knowledge,
and tool results needed for a request. Embedding and transcription features can
send text or audio to their separately configured providers. Personal MCP clients
and external employee runtimes receive the records returned by their permitted
tools and have their own provider, retention, and cost policies. Self-hosting the
workspace does not by itself keep model traffic local.

Without a Deft AI provider, normal chat, tasks, notes, manual knowledge editing,
calendar, and auth remain usable. Model-driven extraction and Defty reasoning
need a provider; deterministic capture paths may still run. A personal MCP client
can supply its own AI independently of Deft's provider configuration.

## Environment Variables

| Variable | Required | Purpose | Default |
|---|---|---|---|
| `POSTGRES_PASSWORD` | Yes | Database password for Compose Postgres | none |
| `JWT_SECRET` | Yes | Signs access tokens | none |
| `JWT_REFRESH_SECRET` | Yes | Signs refresh tokens | none |
| `ENCRYPTION_KEY` | Yes for Docker/production | Encrypts stored credentials and signs receipts; at least 32 characters, unique and non-placeholder | none suitable for Docker |
| Apps flags | No | See "Apps feature flags" below; all are off by default | off |
| `DATABASE_URL` | No for Compose | External Postgres URL for non-Compose installs | derived |
| `NEXT_PUBLIC_APP_URL` | Recommended | Public web URL and invite-link base | `http://localhost:3000` |
| `NEXT_PUBLIC_API_URL` | Recommended | Public API URL seen by browser | `http://localhost:3001` |
| `NEXT_PUBLIC_WS_URL` | Recommended | Public WebSocket/API URL seen by browser | `http://localhost:3001` |
| `DEFT_SOURCE_CODE_URL` | Required for modified public deployments | Public Corresponding Source URL shown on `/license` | Image-embedded upstream source URL |
| `API_PORT` | No | API port inside the app container | `3001` |
| `DEFT_WEB_PORT` | No | Host port for web | `3000` |
| `DEFT_API_PORT` | No | Host port for API | `3001` |
| `DEFT_BIND_HOST` | No | Host address for local database publishing | `127.0.0.1` |
| `DEFT_INVITE_TRUSTED_PROXIES` | Behind a reverse proxy | Comma-separated exact IPs or DNS names of the proxies in front of the API. When the API's socket peer is one of them, every IP rate limit keys on the last `X-Forwarded-For` entry instead of the peer: auth, login, invites, MCP, webhooks, OAuth, uploads and the default limiter, and the Apps limiters (App Runtime channel, public App routes, resource sync and the App connection, data and job routes). Despite the name it is not specific to invites. The proxy must append the real client address as the final `X-Forwarded-For` entry. Unset: the socket peer is used and forwarding headers are ignored. See [`docs/self-hosting-vps-domain-https.md`](./self-hosting-vps-domain-https.md) | none |
| `DEFT_POSTGRES_PORT` | No | Host Postgres port in local compose | `5432` |
| `ANTHROPIC_API_KEY` | No | Optional AI provider fallback | none |
| `OPENAI_API_KEY` | No | Optional AI provider/embedding/transcription fallback | none |
| `OPENROUTER_API_KEY` | No | Optional AI provider fallback | none |
| `OLLAMA_URL` | No | Optional local Ollama endpoint; set only when running | none |
| `R2_ENDPOINT` / `R2_ACCESS_KEY` / `R2_SECRET_KEY` / `R2_BUCKET` | No | Cloudflare R2 uploads | local uploads volume |
| `GITHUB_WEBHOOK_SECRET` | No | Secret for `POST /api/webhooks/github`; unset disables that endpoint (503). GitHub PR-to-Done runs through the scheduled per-workspace GitHub sync and does not use it | none |
| `DEFT_GITHUB_SYNC_INTERVAL_MIN` | No | Minutes between scheduled syncs of each connected GitHub account (at most 10 connections queued per minute; failures back off, rate limits wait for GitHub's reset). `0` or `off` disables the schedule; manual sync still works | `10` |
| `METRICS_SCRAPE_TOKEN` | No | Bearer token for `/api/metrics` and `/health/queue`; unset disables detailed telemetry | none |
| `DEFT_PAUSED_START` | No | Exactly `true` starts Deft read-only, for example to look at a restored copy before releasing it; see "Health checks and a paused start" below. Any value other than exactly `true` or `false` stops startup | unset (normal start) |
| `DEFT_PAUSED_REASON` | No | Why a paused install is paused, shown to signed-in people: `restore_review` or `billing`. Any other value stops startup. It changes nothing that is refused | `restore_review` |
| `DEFT_HOSTED` and the hosted-only settings | Leave unset | For the hosted Deft service only. Unset `DEFT_HOSTED` means self-hosted; when set it must be exactly `true` or `false`, or startup stops. `DEFT_SETUP_TOKEN_SHA256`, `DEFT_SETUP_TOKEN_EXPIRES_AT`, `DEFT_CELL_ID`, `DEFT_SEAT_PUBLIC_KEYS`, `DEFT_SEAT_STATEMENT_URL`, `DEFT_SEAT_FETCH_TOKEN`, `DEFT_HOSTED_SEATS_URL` and the per-workspace limits (`DEFT_HOSTED_LIMIT_OUTGOING_PER_MINUTE`, `DEFT_HOSTED_LIMIT_OUTGOING_PER_HOUR`, `DEFT_HOSTED_LIMIT_SCHEDULED_MESSAGES`, `DEFT_HOSTED_LIMIT_REMINDERS`, `DEFT_HOSTED_LIMIT_STORAGE_PERCENT`) stop startup when they are defined, even empty, without `DEFT_HOSTED=true`: remove them from a self-hosted environment | unset |
| `DEFT_TEST_FAILURE_SWITCHES` | Leave unset | For test installs only: it lets a tester make an approved assistant action fail, or an assistant reply hang, so failure handling can be checked. Never set it on an install people use. Only the process environment can set it (no screen or API can). Self-hosted, the value must be exactly `on`; any other value stops startup. With it on, startup logs a warning and only actions or messages that carry a test marker are affected: for a posted-message action (`post_message`), `deft-test-fail-final` or `deft-test-fail-retryable` in its proposed parameters makes its approval fail without running (the retryable one stays pending and runs normally on the next approval); other action kinds can behave differently, for example a wiki page proposal may still run, and `deft-test-hang-reply` in a message makes the assistant's reply wait until the worker job timeout (120 seconds by default). Remove the variable from any environment file you copy to another install | unset |

### Health checks and a paused start

- `/health` is a liveness check. It answers 200 with `status: "ok"` while the API
  process is up, and reports `release`, `schema_head`, `schema_applied` and `paused`.
- `/health/ready` is the readiness check. It answers 200 with `status: "ready"` when
  the database query succeeds, the agent-channel claim and lease columns and the
  `wiki_memory_syncs` table exist, and job-worker startup has completed. Otherwise it
  answers 503 with `status: "not_ready"` (`code: "DATABASE_NOT_READY"` when the
  database cannot be read). It does not compare the upgrade ledger with `schema_head`;
  read `schema_applied` on `/health` for that. It also reports `paused`.
- Route traffic only when `/health/ready` returns 200 and `paused` is `false`. A paused
  install reports `"paused": true` on both endpoints: `/health` returns 200, and
  `/health/ready` returns 200 once its normal readiness checks pass, so that an
  operator can reach it. A load balancer must read that field and must not treat a
  paused install as serving.

`DEFT_PAUSED_START=true` starts Deft so an operator can look at it, without letting it
work. The setting is read once, when the API process starts. While paused:

- the scheduler and the background jobs do not run, and startup work that writes or
  re-queues is skipped;
- every request other than `GET`, `HEAD` and `OPTIONS` is refused with 503 and
  `code: "PAUSED"`, except sign-in (including two-step verification and, where it is
  required, enrolment), token refresh and logout;
- the agent channel (except its static contract), the calendar feeds and the few reads
  that change shared state are refused, and realtime connections are refused;
- the API process makes no outbound call: AI and embedding providers, transcription,
  outside tool servers, the App Runtime, URL fetches and web push are all refused;
- signed-in people see a notice with the reason from `DEFT_PAUSED_REASON`.

To resume, remove `DEFT_PAUSED_START` (or set it to exactly `false`) and restart the
API. Leave it unset in normal operation. The pause covers the API process only: if you
run the separate Email helper, stop it yourself before you restore.

### Apps feature flags

**Core: set nothing.** Every Apps flag is off by default. A flag is on only when
its value is exactly `true`. A normal install needs none of them.

#### Apps developer preview

The preview is two separate things. Do not treat one as the other.

**1. The browser build profile.** Three web flags are compiled into the browser
bundle at build time:

| Build flag | Needs |
|---|---|
| `NEXT_PUBLIC_FEATURE_APPS` | nothing |
| `NEXT_PUBLIC_FEATURE_APP_RESOURCE_SYNC` | `NEXT_PUBLIC_FEATURE_APPS` |
| `NEXT_PUBLIC_FEATURE_APP_ATTACHMENT_BROKER` | `NEXT_PUBLIC_FEATURE_APP_RESOURCE_SYNC` |

`release/browser-profile.json` names the profile (`apps-developer-preview` or
`core`). The release workflow builds the published image with the flags that
profile selects and writes the result to `browser-feature-evidence.json`.
Check that file for the image you plan to use. The profile is allowed only on
prerelease versions (see [RELEASING.md](../RELEASING.md)).

Setting these variables when a container starts does not change a built image.
To change them, use a published image built with the profile you want, or
rebuild. With Compose, set the three variables in `.env` and run
`docker compose build`. Compose passes only these three to the build
(`Dockerfile` has no build argument for the other `NEXT_PUBLIC_FEATURE_APP_*`
flags). `NEXT_PUBLIC_FEATURE_APP_PRIVATE_SHARING` and
`NEXT_PUBLIC_FEATURE_APP_PRIVATE_MCP` are read by the web app, but the
`Dockerfile` does not declare them: a Docker build needs them added there first. `NEXT_PUBLIC_FEATURE_APP_PRIVATE_DEFTY` has no effect in this
release.

**2. The server flags.** The repository does not define one complete server
set for the preview. The Email developer preview documents its own server
settings with the Email app. The checklist below lists what each flag needs, so
you can build your own set. Do the steps in order and enable only what you need.

Compose gives `.env` to the `deft`, `init`, `upgrade`, `doctor` and `smoke`
services (`env_file: .env`). Every variable below can therefore be set in `.env`
and reaches the API container. `docker-compose.yml` also lists a few of them under
`environment:` for the `deft` service (`DEFT_APPS_ENABLED` and
`DEFT_APP_DEVELOPER_PAIRING_ENABLED`). Those two entries use Compose
interpolation, so a value exported in your shell overrides the one in `.env`.
Make sure both agree. After a change, recreate the container.

| Step | Server flag | Must already be on | Notes |
|---|---|---|---|
| 1 | `DEFT_APPS_ENABLED` | none | Turns on the Apps API |
| 2 | `DEFT_APP_DEVELOPER_PAIRING_ENABLED` | step 1 | Developer pairing codes |
| 3 | `DEFT_APP_RUNS_ENABLED` | a valid `DEFT_APP_RUN_KEYRINGS` | Missing or invalid keyrings stop startup. Generate keyrings as described in the keyring section below |
| 4 | `DEFT_APP_RUN_APP_ORIGIN_ENABLED` | steps 1 and 3 | Startup fails if Apps or Runs is off |
| 5 | `DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED` | step 3 | Startup fails if Runs is off |
| 6 | `DEFT_APP_AUTOMATIONS_ENABLED` | steps 1, 3 and 4 | Startup fails if any is off |
| 7 | `DEFT_APP_RUNTIME_CHANNEL_ENABLED` | steps 3 and 4 | |
| 8 | `DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED` | step 7 | |
| 9 | `DEFT_APP_NATIVE_CALENDAR_ENABLED` | steps 1, 3 and 4 | |
| 10 | `DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED` | steps 1, 3 and 4 | Private resource sync |
| 11 | `DEFT_APP_RESOURCE_SYNC_SCHEDULER_ENABLED` | step 10 | |
| 12 | `DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED` | step 10 | |
| 13 | `DEFT_APP_PRIVATE_STATE_ENABLED` | step 12 | |
| 14 | `DEFT_APP_ATTACHMENT_BROKER_ENABLED` | step 10 | |
| 15 | `DEFT_APP_OWNER_CONNECTIONS_ENABLED` | step 14 | |
| 16 | `DEFT_APP_PRIVATE_SHARING_ENABLED` | step 10 | |
| 17 | `DEFT_APP_PRIVATE_MCP_ENABLED` | step 16 | |
| 18 | `DEFT_APP_PRIVATE_DEFTY_ENABLED` | step 10 | |
| 19 | `DEFT_APP_PUBLIC_INGRESS_ENABLED` | step 1 | Mounts `/api/public/apps` |

Only the combinations marked "startup fails" stop the API. For every other
flag, a missing requirement leaves the feature off without stopping startup.
Requests to a route whose feature is off can answer `503`.

Several owner-connection routes answer `503` until steps 1, 3, 4, 10, 14 and 15
are on, with valid Run keyrings: `/api/app-connection-sessions`, `/api/app-connection-forms`,
`/api/app-data`, the App data actions, App integration tools, App local jobs and
App resource observations. Resource observations also need step 14.

Enabling a flag grants no data access. Grants, consent and reviews are still
required for each App.

### Opt-in Governed App Run keyrings

Governed App Runs stay off by default. Existing self-hosts do not need any Run
variable and retain the legacy connector execution path. The engine, connected
App intake, and legacy MCP intake are intentionally separate:

| Run engine | Connected App intake | Legacy MCP intake | Meaning |
|---|---|---|---|
| Off | Off | Off | Default legacy behavior; no Run keyrings required |
| On | Off | Off | Run service can decrypt, resume, and drain accepted work; no new governed intake |
| On | On | Off | Reviewed connected-App actions enter App Runs; legacy MCP remains legacy |
| On | Off | On | Exact default-off legacy MCP canary enters App Runs |
| On | On | On | Both independently reviewed intake planes enter the same governed engine |
| Off | On | Any | Invalid; API startup rejects the configuration |
| Off | Any | On | Invalid; API startup rejects the configuration |

Operators preparing the engine must generate three independent 32-byte keys
with this Node.js command:

```bash
node -e "const c=require('node:crypto');const k=()=>c.randomBytes(32).toString('base64');console.log(JSON.stringify({schema_version:'deft.app_run_keyring.v1',run_encryption:{current:'enc-v1',keys:{'enc-v1':k()}},receipt_signing:{current:'sign-v1',keys:{'sign-v1':k()}},fingerprint:{current:'fp-v1',keys:{'fp-v1':k()}}}))"
```

Store the single-line output verbatim as `DEFT_APP_RUN_KEYRINGS`, then set
`DEFT_APP_RUNS_ENABLED=true` while leaving
`DEFT_APP_RUN_APP_ORIGIN_ENABLED=false` and
`DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=false`. Add a new key ID and make it
`current` to rotate; keep older entries configured for reads and verification.
Back up this setting with the database. Removing a key that is still referenced
by retained Run payloads, receipts, or fingerprints is unrecoverable data loss.
Startup checks that inventory before any governed effect can execute.

Enable the separate legacy intake flag only for a certified canary. To stop new
governed MCP admission without stranding accepted work, turn the intake flag
off and leave the engine on until the Run ledger and queue are quiescent.

Enable `DEFT_APP_RUN_APP_ORIGIN_ENABLED=true` only after Apps are enabled and
the connected App has passed explicit grant review and activation. The flag
admits only exact persisted App bindings; it does not create a grant, connector,
or provider authority. To stop new App-origin admission without stranding
accepted work, turn this intake flag off and leave the Run engine and matching
keyring available until the governed ledger is quiescent.

Read [Governed App Run operations](./app-run-operations.md) before enabling the
feature. It contains rotation, retirement, backup/restore, disaster recovery,
split-control drain/pause behavior, and the exact rollback-floor rules.

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

For a source checkout, the complete recovery-set helper is:

```bash
pnpm selfhost:backup
```

The backup command briefly stops the app and writes a timestamped recovery
directory under `./backups`. It contains the database, persistent uploads,
any legacy uploads found in the running container writable layer, `.env`
(including keyrings), Compose configuration, and the running image identity.
For the production overlay:

```bash
pnpm selfhost:backup --prod
```

For a recoverable release deployment, capture one stopped recovery point. This
keeps the database and local uploads at the same point in time and preserves the
configuration, App Run keyrings, and immutable image selection needed to decrypt
and verify retained data. Run these commands from the downloaded release-asset
directory. Choose and keep a stable Compose project name for the deployment:

```bash
export COMPOSE_PROJECT_NAME=deft
export RECOVERY="recovery-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RECOVERY"
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml stop deft
container_id="$(docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml ps -aq deft)"
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml \
  exec -T postgres pg_dump -U postgres --clean --if-exists --no-owner --no-privileges deft \
  | gzip -9 > "$RECOVERY/database.sql.gz"
docker run --rm \
  -v "${COMPOSE_PROJECT_NAME}_uploads:/source:ro" \
  -v "$PWD/$RECOVERY:/backup" alpine:3.22 \
  tar -C /source -czf /backup/uploads.tar.gz .
mkdir -p "$RECOVERY/legacy-container-uploads"
if [ -n "$container_id" ]; then
  docker cp "$container_id:/app/apps/api/uploads/." "$RECOVERY/legacy-container-uploads/"
  docker inspect "$container_id" --format '{{.Image}}' > "$RECOVERY/running-image-id.txt"
  docker image inspect "$(cat "$RECOVERY/running-image-id.txt")" --format '{{json .RepoDigests}}' \
    > "$RECOVERY/running-image-repo-digests.json"
fi
cp .env docker-compose.yml compose.prod.yml compose.release.yml release-manifest.json "$RECOVERY/"
cp SHA256SUMS "$RECOVERY/release-SHA256SUMS"
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml config --images \
  > "$RECOVERY/configured-images.txt"
while IFS= read -r image; do
  docker image inspect "$image" --format '{{json .RepoDigests}}'
done < "$RECOVERY/configured-images.txt" > "$RECOVERY/image-repo-digests.jsonl"
(cd "$RECOVERY" && find . -type f ! -name SHA256SUMS -print0 \
  | sort -z | xargs -0 sha256sum > SHA256SUMS)
chmod 600 "$RECOVERY/.env" "$RECOVERY/database.sql.gz" "$RECOVERY/uploads.tar.gz"
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml start deft
```

Store that directory together as a protected recovery artifact. `.env` contains
authentication secrets, provider credentials, and `DEFT_APP_RUN_KEYRINGS` when
configured. Losing a retained App Run key makes its encrypted payload or receipt
unrecoverable. If uploads use R2 or another external canonical store, back up and
restore that store with its provider tools instead of the local `uploads` volume;
the command above covers local uploads only. Keep the release manifest and
`SHA256SUMS` beside the recovery artifact when available.

Restore into a new empty directory and a new, empty Compose project first. Do not
run `init` and do not restore over an initialized application database:

```bash
mkdir deft-restore && cd deft-restore
cp /secure/recovery/.env /secure/recovery/docker-compose.yml \
  /secure/recovery/compose.prod.yml /secure/recovery/compose.release.yml .
export COMPOSE_PROJECT_NAME=deft-restore
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml pull
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml up -d postgres
gunzip -c /secure/recovery/database.sql.gz \
  | docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml \
      exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres deft
docker run --rm \
  -v "${COMPOSE_PROJECT_NAME}_uploads:/target" \
  -v /secure/recovery:/backup:ro alpine:3.22 \
  tar -C /target -xzf /backup/uploads.tar.gz
docker run --rm \
  -v "${COMPOSE_PROJECT_NAME}_uploads:/target" \
  -v /secure/recovery/legacy-container-uploads:/legacy:ro alpine:3.22 \
  cp -a /legacy/. /target/
# Set DEFT_IMAGE in .env to the exact prior repo digest recorded in
# running-image-repo-digests.json before pulling or starting the restored app.
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml up -d deft
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm doctor
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm smoke
```

Before switching traffic, compare the restored image list and recovery checksums,
sign in, open representative uploaded files, and exercise any configured provider
key. If App Runs are enabled, follow `docs/app-run-operations.md` from the matching
source archive to verify key inventory and receipts and to inspect pending or
unknown outcomes. Keep the original deployment stopped until these checks pass.
The recovery point loses writes accepted after the app was stopped; measure the
dump/archive/restore time during a rehearsal to set the installation's RPO/RTO.

To return to the original deployment after a rehearsal:

```bash
cd /path/to/original-release-directory
export COMPOSE_PROJECT_NAME=deft
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml start deft
```

### Supported database restore routes

Two ways of restoring the database are supported. Both restore into a new, empty
database, as a PostgreSQL role that may create the `vector` extension (the
Compose `postgres` user may). Dump and restore with PostgreSQL client tools of
the same major version as the server: the Compose commands above run them inside
the `postgres` container, which does this. A newer `pg_dump` on the host (version
17 or later) writes `SET transaction_timeout`, which a version 16 server rejects
when the dump is restored.

| Dump | Restore | Status |
|---|---|---|
| Plain SQL: `pg_dump --clean --if-exists --no-owner --no-privileges`, the `database.sql.gz` that `pnpm selfhost:backup` and the commands above write | `psql -v ON_ERROR_STOP=1` | Supported. This is the documented route. |
| Custom format: `pg_dump --format=custom --no-owner --no-privileges` | `pg_restore --no-owner --no-privileges --exit-on-error --dbname deft` | Supported. |

Both need a dump taken at schema `0.3.0-preview.148` or later; see below for
older dumps. Nothing else is supported: not a restore over an initialized
database, not a partial restore (`--data-only`, `--schema-only`, single tables),
and not a copy of the PostgreSQL data directory of a running server. The
directory and tar dump formats have not been tested.

`pnpm --filter @deft/db test:restore` checks both routes against a disposable
test database: it stores an App connection record, dumps the database both ways,
restores each dump into an empty database and compares the row count of every
table. This covers the database only: restoring uploads and secrets, and keeping
people removed since the backup removed after a restore, are not covered.

CI also runs `pnpm --filter @deft/db check:add-only-upgrades`. It checks SQL files
added since the release tag named by `origin/master` and refuses changes to
released SQL. New files may add tables, optional columns and non-unique indexes;
drops, renames, type changes, narrowing constraints and data rewrites fail.
Procedural or otherwise unclassified SQL fails closed. This structural check
does not replace testing the previous application release on the new schema.

#### Dumps taken before schema `0.3.0-preview.148`

`pnpm db:upgrade --status` shows the schema a database is at. A dump taken at
`0.3.0-preview.137` or earlier, in either format, can fail to restore when the
workspace holds App connection or consent records: rows in
`app_connection_sessions`, `app_connection_forms`, `app_data_consents`,
`app_data_invocations`, `app_resource_observation_consents`,
`app_local_job_schedules`, `app_native_bindings` or
`app_public_cancellation_selections`. Whether a row stops the restore depends on what it
records; a connection session that carries an action consent does. The restore
then stops while loading the table:

```text
ERROR:  function deft_app_consent_valid(jsonb, text) does not exist
CONTEXT:  PL/pgSQL function public.deft_app_consent_deadline(jsonb,text) line 3 at IF
COPY app_connection_sessions, line 1
```

The data in the dump is intact; PostgreSQL restores a dump with an empty
`search_path`, and before `0.3.0-preview.148` the functions that check those rows
could not find each other without it. A workspace with no rows in those tables is
not affected.

The backup that `pnpm selfhost:upgrade` takes before it upgrades is such an older
dump, and it is the one to restore if an upgrade fails. After upgrading to
`0.3.0-preview.148`, take a fresh backup and rehearse restoring that one.

To restore an older dump, give those functions their search path in the new
database before the rows load. `fix.sql` below holds the 11 `ALTER FUNCTION` lines
of `packages/db/upgrades/0.3.0-preview.148-restore-safe-check-helpers.sql` from the
release source (`grep '^ALTER FUNCTION' <that file> > fix.sql`). A dump older than
`0.3.0-preview.120` does not define every one of those functions: remove the lines
of any function the dump lacks (`pg_restore --list database.dump | grep ' FUNCTION '`,
or `gunzip -c database.sql.gz | grep 'CREATE FUNCTION'`), or the fix stops with
"function does not exist". Restore into a new, empty database as above.

Custom format: restore in three steps, with the fix between the first two:

```bash
pg_restore --no-owner --no-privileges --exit-on-error --section=pre-data --dbname deft database.dump
psql -v ON_ERROR_STOP=1 -d deft -f fix.sql
pg_restore --no-owner --no-privileges --exit-on-error --section=data --dbname deft database.dump
pg_restore --no-owner --no-privileges --exit-on-error --section=post-data --dbname deft database.dump
```

Plain SQL: put the same lines before the first `COPY` of the dump:

```bash
gunzip -c database.sql.gz \
  | awk 'FNR==NR{fix=fix $0 "\n"; next} /^COPY /&&!done{printf "%s", fix; done=1} 1' fix.sql - \
  | psql -v ON_ERROR_STOP=1 -d deft
```

Both were checked on PostgreSQL 16 with a connection session that carries an action
consent: each restored it with the row intact.

### Content exports

To export a whole workspace's content (spaces, messages, attachments, tasks,
notes, wiki, events, Contacts and members) as a portable archive, run the
workspace export command; it works while the app is stopped. See
[workspace export](workspace-export.md).

Smaller exports also exist: wiki JSON/Markdown/CSV (`GET /api/wiki/export`,
with `format=md` or `format=csv`), note Markdown download, and calendar ICS
feeds. None of these is a restorable backup. Use Postgres, uploads, and
configuration backups for recovery.

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

For a named GHCR release, first create the recovery artifact above using the
current `.env` and previous image digest, but leave `deft` stopped instead of
running the final `start deft` command. Then pin `DEFT_IMAGE` in the working
`.env` to the target digest. Keep Deft stopped and set `RECOVERY` to the absolute
recovery-folder path. Before replacing its container, copy any captured legacy
uploads into the persistent volume; older releases may have written files into
the container's writable layer.

```bash
set -euo pipefail
test -d "$RECOVERY" || { echo 'Set RECOVERY to the absolute recovery folder path.'; exit 1; }
(cd "$RECOVERY" && sha256sum -c SHA256SUMS)
if [ -d "$RECOVERY/legacy-container-uploads" ]; then
  container_id="$(docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml ps -aq deft)"
  uploads_volume="$(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Destination "/app/uploads"}}{{.Name}}{{end}}{{end}}')"
  test -n "$uploads_volume" || { echo 'Uploads volume not found. Keep Deft stopped and check its storage mounts.'; exit 1; }
  docker run --rm -v "$uploads_volume:/target" -v "$RECOVERY/legacy-container-uploads:/legacy:ro" alpine:3.22 cp -a /legacy/. /target/
fi
```

Then run using the target release's downloaded Compose assets:

```bash
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml pull deft upgrade doctor smoke
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm upgrade
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml up -d --force-recreate deft
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm doctor
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm smoke
```

The source-checkout wrapper stops app writes, records the complete recovery set
and previous image identity before a mutable target tag can be pulled, overlays
any captured legacy container uploads into the corrected persistent volume,
then builds or pulls the target, runs the `upgrade` service, recreates the app,
and requires doctor plus MCP smoke to pass. Site-specific overlays can be
appended with `--compose-file <file>`.

Schema upgrades are forward-only. The migration ledger is checksummed and a
failed migration transaction rolls back, but there is no automatic downgrade
path after a successful upgrade. Recovery means stopping Deft, restoring the
pre-upgrade Postgres backup and uploads backup, and running the exact previous
image digest. Rehearse that restore on a disposable host before upgrading data
that cannot be recreated.

For a source checkout, preview the exact sequence without changing data:

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

## Checking For Rows Stamped With The Wrong Org

Every table carries an `org_id`. The audit script lists rows whose `org_id`
differs from the org of the space, task, note or other row they belong to, and users who hold a
grant or authorship column (space member, task assignee or watcher, note share,
token, OAuth grant, agent employee and workflow rule owners and similar) without
a membership in the row's org. It only reports; it never changes data and has no repair mode.

```bash
pnpm --filter @deft/api exec tsx src/scripts/audit-mixed-org-rows.ts \
  --database-url postgresql://user@host:5432/deft \
  --json mixed-org-report.json --limit 50
```

- The target (host and database name, no credentials) is printed before any
  query runs. `DATABASE_URL` is used when `--database-url` is omitted.
- All queries run in one `READ ONLY` transaction with a 30 second statement
  timeout (`--timeout-ms` changes it), so the database rejects any write.
- Stdout has one line per check with its tables and mismatch count, followed by
  the list of things deliberately not checked. Rows whose only fault is an
  inactive membership are counted separately as informational, as is each org
  where the built-in Defty user has no membership row (older versions wrote
  Defty messages without one; `apps/api/src/scripts/backfill-defty-membership.ts`
  repairs it). Defty is not counted as a mismatch elsewhere.
- `--json` writes up to `--limit` samples per check. Samples contain row ids,
  both org ids and `created_at`, never message text, note bodies, names or
  emails.
- Error output is deliberately terse: an unrecognised argument is reported by
  position only, and a failure prints a fixed description with the SQLSTATE or
  network code, never the connection string, user name or driver message. A
  check that hits its statement timeout is listed as an error and the exit code
  is `1`.
- Exit code `0` means no mismatches, `2` means mismatches were found, `1` means
  an error or an unfinished check. Running through `pnpm exec` can report `1`
  for any non-zero exit; call `tsx` directly if a script needs to tell them apart.

Review the list before deciding anything. Take a backup first and ask for
review before correcting rows by hand.

## Optional web app installation and message previews

Both features default off; the disabled manifest endpoint serves an empty
manifest with no installation metadata. For a source build, set
`NEXT_PUBLIC_FEATURE_WEB_APP_INSTALL=true` before building (Compose forwards it
as a build argument). This adds the standalone manifest, square app icons and
an iPhone Safari hint: tap Share, then Add to Home Screen. Prebuilt images must
have this build-time flag enabled by their publisher. Installation is optional;
the app still requires a network connection. Phones need HTTPS; localhost is
sufficient for desktop development. The icons reuse the existing Deft logo;
the maskable variant keeps it within the central safe circle.

Set `PUSH_MESSAGE_PREVIEWS_ENABLED=true` at API startup to include a sender and
up to 100 characters of plain chat text in browser notifications. This changes
lock-screen text for existing subscribed devices too. Without the setting,
existing subscribers continue to see "Open Deft to review." Browser notification
configuration, user preferences and quiet hours still apply. Message previews
are checked against the recipient's current workspace and space access at send
time. Deleted messages, unavailable sources, private Defty messages and non-chat
items retain generic text. A legacy thread notification that points at the
recipient's own parent message stays generic rather than quoting the wrong turn.

On iPhone, browser notifications require launching the installed Home Screen
app (iOS 16.4 or later) and enabling notifications there.

Push endpoints require HTTPS on port 443 and every resolved address must be public,
including on self-hosted installs. Private-network push servers cannot subscribe.

## What's Not In Self-Hosted v1

- Managed hosting or one-click cloud deployments
- Multi-org / multi-tenant mode
- Email delivery for invites or password resets
- Native Slack/Gmail/GitHub OAuth promises
- Managed agent runtime provisioning
