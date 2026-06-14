# VPS + Domain + HTTPS Runbook

This runbook is for a single self-hosted Deft workspace on a VPS. It assumes a
domain such as `demo.example.com`, one Linux server, Docker Compose, and a
reverse proxy that terminates HTTPS.

## Target Shape

```text
https://demo.example.com          -> Deft web container :3000
https://demo.example.com/api/...  -> Deft API container :3001
https://demo.example.com/oauth/... and /.well-known/... -> Deft API container :3001
```

Use one public origin for the web app and API. This is the smoothest shape for
browser login, OAuth MCP discovery, ChatGPT/Claude/Codex connector setup, and
cookie/CORS behavior.

## 1. DNS

Create an `A` record:

```text
demo.example.com -> <your-vps-ip>
```

Wait until:

```bash
dig +short demo.example.com
```

returns the VPS IP.

## 2. Server Prerequisites

Install Docker and the Compose plugin. Then clone Deft:

```bash
git clone https://github.com/Maneek21/Deft.git
cd Deft
cp .env.example .env
```

Generate required secrets:

```bash
openssl rand -hex 32   # POSTGRES_PASSWORD
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # JWT_REFRESH_SECRET
openssl rand -base64 24 | cut -c1-32   # ENCRYPTION_KEY, exactly 32 chars
```

Set the public URLs in `.env`:

```bash
NEXT_PUBLIC_APP_URL=https://demo.example.com
NEXT_PUBLIC_API_URL=https://demo.example.com
NEXT_PUBLIC_WS_URL=https://demo.example.com
API_PORT=3001

DEFT_WEB_PORT=3000
DEFT_API_PORT=3001
DEFT_BIND_HOST=127.0.0.1
```

The `DEFT_BIND_HOST=127.0.0.1` default keeps Deft's app ports local to the VPS.
Only the reverse proxy should be public.

## 3. Reverse Proxy

Example Caddyfile:

```caddyfile
demo.example.com {
  encode zstd gzip

  handle /api/* {
    reverse_proxy 127.0.0.1:3001
  }

  handle /oauth/* {
    reverse_proxy 127.0.0.1:3001
  }

  handle /.well-known/* {
    reverse_proxy 127.0.0.1:3001
  }

  handle {
    reverse_proxy 127.0.0.1:3000
  }
}
```

If you use Nginx, keep the same routing split: `/api`, `/oauth`, and
`/.well-known` go to the API port; everything else goes to the web port.

## 4. Bootstrap

From the repo:

```bash
pnpm selfhost:bootstrap --prod --check-only
pnpm selfhost:bootstrap --prod
```

If you do not have host-side Node.js/pnpm, run the Docker-only sequence:

```bash
docker compose -f docker-compose.yml -f compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f compose.prod.yml run --rm init
docker compose -f docker-compose.yml -f compose.prod.yml run --rm doctor
docker compose -f docker-compose.yml -f compose.prod.yml run --rm smoke
```

For a demo/pilot instance with seeded data:

```bash
pnpm selfhost:bootstrap --prod --seed-pilot
```

Do not use `--seed-pilot` for a real customer workspace.

## 5. Verify Browser And OAuth MCP

Open:

```text
https://demo.example.com
```

Create the owner account. Then verify public OAuth/MCP metadata:

```bash
curl https://demo.example.com/.well-known/oauth-protected-resource
curl https://demo.example.com/.well-known/oauth-authorization-server
```

The protected resource metadata should name:

```text
https://demo.example.com/api/mcp/v1
```

In Deft, go to Settings -> MCP Access, create a personal token, add it to
`.env` as `DEFT_MCP_BEARER_TOKEN`, and run:

```bash
docker compose -f docker-compose.yml -f compose.prod.yml run --rm smoke
```

That confirms an authenticated MCP `tools/list` call works from the running
deployment.

## 6. Common Failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Login shows "Failed to fetch" | `NEXT_PUBLIC_API_URL` was built with the wrong URL | Fix `.env`, rebuild with `docker compose up -d --build` |
| OAuth connector says metadata missing | Proxy does not route `/.well-known/*` to API | Add the `/.well-known` API route to the proxy |
| OAuth token exchange fails by resource mismatch | Client uses a different MCP URL than metadata | Use exactly `https://domain/api/mcp/v1` |
| `doctor` fails CORS | App/API origins do not match expected public URL | Set all `NEXT_PUBLIC_*` URLs to the same HTTPS origin |
| Smoke fails DCR | API is unreachable through proxy or `/oauth/register` not routed | Route `/oauth/*` to API |

## 7. Upgrade Loop

Before upgrades, take a Postgres backup. Then:

```bash
git pull
docker compose -f docker-compose.yml -f compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f compose.prod.yml run --rm init
docker compose -f docker-compose.yml -f compose.prod.yml run --rm doctor
docker compose -f docker-compose.yml -f compose.prod.yml run --rm smoke
```
