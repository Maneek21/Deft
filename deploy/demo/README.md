# Demo deployment overlay

This directory records the deployment-only files used by a public Deft demo.
The examples contain no credentials and are not loaded automatically.

## Install

From the repository root on the server:

```bash
cp deploy/demo/Caddyfile.example Caddyfile
cp deploy/demo/compose.demo.yml.example compose.demo.yml
```

Set the normal production secrets plus these public values in `.env`:

```dotenv
DEFT_PUBLIC_HOST=demo.example.com
NEXT_PUBLIC_APP_URL=https://demo.example.com
NEXT_PUBLIC_API_URL=https://demo.example.com
NEXT_PUBLIC_WS_URL=https://demo.example.com
```

Keep provider keys in `.env`; do not add them to the Compose overlay.

The overlay sets `DEFT_INVITE_TRUSTED_PROXIES=caddy` for general API and invite
limits. The API resolves that service name and trusts forwarded
addresses only when the socket peer matches its current IP; container IP
changes require no manual setting.

For a different proxy, set this variable to a comma-separated list of its
exact IPs or DNS names that you control (no CIDRs or implicit private ranges).
An absent setting uses the socket peer. Missing/invalid forwarding headers or
failed DNS resolution also use that peer, sharing its budget. A configured
proxy must overwrite untrusted `X-Forwarded-For` or append its actual client as
the rightmost entry; the API ignores earlier entries and `X-Real-IP`.
[Caddy does this by default](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults).
With additional proxies in front of Caddy, this policy counts Caddy's immediate
client, not an unverified address farther back in the chain.

## Preflight and deploy

```bash
test -f Caddyfile && test -f compose.demo.yml
docker compose -f docker-compose.yml -f compose.demo.yml config --quiet
pnpm selfhost:bootstrap --prod --check-only
docker compose -f docker-compose.yml -f compose.demo.yml up -d --build
docker compose -f docker-compose.yml -f compose.demo.yml run --rm doctor
docker compose -f docker-compose.yml -f compose.demo.yml run --rm smoke
```

Back up `.env`, `Caddyfile`, and `compose.demo.yml` outside the checkout before
rebuilding or moving the VPS. The checked-in examples are the recovery source;
the root copies remain server-local because they select the live hostname and
deployment environment.
