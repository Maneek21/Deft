# Getting started

Choose the journey that matches what you want to evaluate. The latest downloadable image is `v0.3.0-preview.15`.

## Start a team workspace

You need Docker Compose and `openssl`. Download the [preview.15 release assets](https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.15) into an empty directory, copy `default.env.example` to `.env`, and use a separate `openssl rand -hex 32` value for each required secret: `POSTGRES_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, and `ENCRYPTION_KEY`.

```bash
export DEFT_IMAGE=ghcr.io/maneek21/deft:0.3.0-preview.15
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml pull
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml up -d postgres
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm init
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml up -d deft
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm doctor
docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml run --rm smoke
```

Open `http://localhost:3000`. The first account becomes the workspace owner. Create a space and a task to confirm the workspace path. Use the [self-hosting guide](self-hosting.md) for HTTPS, backups, immutable image digests, and upgrades.

## Connect an AI client

Start a workspace first. Sign in as the person whose permissions the client should use, open **Settings → MCP Access**, and create a personal connection with the smallest suitable scope. Copy the generated endpoint and token into a client that supports streamable HTTP MCP and bearer headers; the endpoint is `https://<your-api-host>/api/mcp/v1`.

Ask the client to list your tasks or search visible workspace knowledge. A successful connection returns only data that the signed-in person may access. A write-enabled connection can change workspace data as you, within its scopes and your permissions. Employee approval policies apply to the governed agent paths, not every personal-client write. Vendor UI and custom-connector availability vary by client and account tier; follow the client-specific instructions shown in Settings.

## Build an internal App

This source/tarball path avoids assuming that `@deft/app-kit` is available from a public registry. Use a checkout matching the host release and Node.js 22.13+ with pnpm 11.10.0.

```bash
git clone --branch v0.3.0-preview.15 --depth 1 https://github.com/Maneek21/Deft.git deft-app-source
cd deft-app-source
pnpm install
mkdir -p "$HOME/deft-artifacts"
pnpm --dir packages/app-kit pack --pack-destination "$HOME/deft-artifacts"
mkdir -p "$HOME/deft-apps/hello-workspace"
cd "$HOME/deft-apps/hello-workspace"
pnpm init
pnpm add --save-dev "$HOME/deft-artifacts/deft-app-kit-0.1.0-alpha.2.tgz"
pnpm exec deft app init
pnpm exec deft app check
pnpm exec deft app build
pnpm exec deft app doctor --url http://localhost:3001
pnpm exec deft app install-local --url http://localhost:3001
```

These commands use the published preview.15 and its App Kit `0.1.0-alpha.2`. Use the guide from the same release as your host.

The host API must have `DEFT_APPS_ENABLED=true` and `DEFT_APP_DEVELOPER_PAIRING_ENABLED=true`; the web build needs `NEXT_PUBLIC_FEATURE_APPS=true`. In **Settings → Apps**, an owner or admin creates the one-time developer pairing code; enter it when `install-local` prompts. For Protocol v0, a successful install stages and activates a Deft-rendered internal App. Open **Apps** and confirm its native navigation and Module view.

Connected Apps and bounded daily actions are an experimental path in preview.15. They require separate review, grants, bindings, activation, and additional operator flags. Follow the [connected App author guide](connected-app-author-guide.md) and [App Run operator guide](app-run-operations.md). Current protocols do not provide arbitrary custom UI or public portals.
