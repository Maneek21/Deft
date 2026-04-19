# Live-gateway validation plan

**Goal:** close the last validation gap left open by the OpenClaw Unlock — prove the seven end-to-end behaviors from the Block 1 exit gate against a real running gateway, not a mock.

**Prereq:** everything up to merge commit `084709d` on `feat/phase2-4-mcp-agents-plans`. Deploy code + 138 unit tests + 54 Playwright smoke + dogfood walkthrough all green.

**Why this isn't closed yet:** everything we tested in-process used `MockTransport` + `_setGatewayResolver` seams. The wire-protocol assumption (JSON-RPC frame shapes, authentication header scheme, event names, close-reason semantics) is only as correct as the OpenClaw docs we read while building. A real instance is the only way to find protocol drift.

This plan has three layers. They're sequential: infra first, then smoke, then resilience.

---

## Layer A — Stand up one gateway

Three candidate provisioning paths. Pick the cheapest one that your infra supports; the validation script doesn't care which.

### A1. Railway (recommended, matches production shape)

- **Prereq:** Railway account with a paid plan (container runtime requires Pro or Hobby+).
- **Cost:** ~$5/mo minimum for one always-on container.
- **Setup:**
  1. Generate a Railway API token: dashboard → Account Settings → Tokens.
  2. Export: `RAILWAY_API_TOKEN=...`
  3. Seed an `integrations` row for the org with `provider='railway'` and the encrypted token:
     ```
     POST /api/integrations
     { "provider": "railway", "config": { "token": "<raw>" } }
     ```
  4. Deploy via the existing flow: Settings → Agent → Deploy new employee → wizard → choose `openclaw` kind. `deploy-provision` will call Railway's GraphQL API and return `connection_url`.
- **Done-when:** `agent_employees.connection_status = 'connected'` and `gateway_ping` worker logs success.
- **Estimated time:** 30 minutes if Railway onboarding is new; 5 minutes if existing.

### A2. Local Docker (fastest iteration, no external dependency)

- **Prereq:** Docker Desktop / Docker Engine on the dev machine.
- **Setup:**
  1. Pull the OpenClaw reference image:
     ```
     docker pull ghcr.io/openclaw/gateway:latest
     ```
     (or build from the OpenClaw repo if the image isn't published yet — falls back to BYOA mode)
  2. Run with a fixed token and port:
     ```
     docker run -d --name claw-dev \
       -p 18789:18789 \
       -e OPENCLAW_GATEWAY_TOKEN=dev-token-xyz \
       -v claw-data:/data \
       ghcr.io/openclaw/gateway:latest
     ```
  3. Patch an agent_employees row directly (no provisioning needed):
     ```sql
     UPDATE agent_employees
     SET kind = 'openclaw',
         connection_url = 'ws://localhost:18789',
         gateway_token_encrypted = pgp_sym_encrypt('dev-token-xyz', 'ENCRYPTION_KEY'),
         connection_status = 'connected'
     WHERE id = 'uuid-of-your-test-agent';
     ```
     (Encryption is `encrypt()` from `apps/api/src/lib/encryption.ts` — one-liner script faster than SQL.)
- **Done-when:** `apps/api/src/lib/openclaw-gateway.ts` can `skills.status()` against `ws://localhost:18789` and returns `{ ready: true }`.
- **Estimated time:** 10 minutes.

### A3. BYOA (self-hosted, if you already have OpenClaw running elsewhere)

- Drop-in substitution: use an existing `connection_url` + raw token from wherever it's running.
- No provisioning needed, just seed the `agent_employees` row and flip `kind='openclaw'`.
- **Estimated time:** 5 minutes.

---

## Layer B — The seven acceptance smokes

Each check maps to exactly one Block 1 feature + the UI entrypoint sweep added later. All seven are wired to run in sequence from `docs/superpowers/audits/live-gateway-smoke.ts` (stub ships with this plan; runnable as soon as Layer A is done).

| # | Smoke | What it proves | Fails if |
|---|---|---|---|
| B1 | Attach `slack` ClawHub skill → wait for `skills.install` RPC → verify agent has `slack_*` tools in first turn | Block 1.3 live install + Block 3.4 `deft-mcp-client` config.set substitution | Gateway times out on install; skill not listed in `gateway.skills.list()` 10s later |
| B2 | Send chat: "install the github skill" → approval card appears → approve → observe skill in next turn | Block 1.7 runtime install flow | Approval doesn't land in `agent_actions`; resolve doesn't call gateway; skill absent post-approve |
| B3 | Via `docker exec` or Railway console, force-remove a skill file → trigger heartbeat → verify reconcile re-installs | Block 1.8 reconciliation loop | Drift not detected; `gateway.skills.list()` still missing after 2 heartbeat ticks |
| B4 | Agent runs `exec_command` mid-turn → approval card appears in Deft inbox → approve → observe command ran | Block 1.9 exec approval forwarding | `exec.approval.request` event never lands as `agent_actions` row; `exec.approval.resolve` doesn't unblock the turn |
| B5 | Chat with the agent → assistant replies with tool calls → click "Show trace" → tree renders | Block 1.10 reasoning trace | Socket room receives no `agent:trace` frames; expander shows empty state |
| B6 | In an org with zero openclaw employees, provision three via wizard → count Railway containers | Block 1.11 per-org gateway reuse | Three containers created; `deploy-provision` didn't short-circuit |
| B7 | Edit SOUL.md via Personality page → Save → start new conversation → verify personality change surfaces | Block 1.2 `agents.files.set` + next-session semantics | Gateway returns 200 but file content unchanged; OR agent behaves same as before |

Each smoke writes a pass/fail entry + relevant artifact (frame dumps, screenshots, timing) to `docs/superpowers/audits/live-gateway-smoke.last-run.txt` — mirrors the shape of Block 0/1/2/3 smoke outputs.

**Pass criteria:** 7/7 green. One failure blocks the release; investigate whether the issue is ours (wire assumption wrong) or the gateway's (protocol drift upstream).

---

## Layer C — Resilience checks (do after Layer B passes)

These live in `docs/superpowers/audits/live-gateway-resilience.ts`. They're slower, more destructive, and only worth running once the happy path works.

| # | Scenario | What it tests |
|---|---|---|
| C1 | Kill the container mid-turn with `docker kill`; wait 60s; observe | Gateway client reconnect backoff + pending-call rejection |
| C2 | Network partition: `iptables` drop WebSocket outbound for 30s | Per-call 30s timeout path + reconnect after recovery |
| C3 | Flood 100 parallel RPCs | Multiplex correctness, no cross-talk in response IDs |
| C4 | Call `skills.install('nonexistent-slug')` | JSON-RPC error response mapping + user-facing error copy |
| C5 | Send a frame that's 10MB | Client-side size limit; no memory spike |
| C6 | Run for 2 hours with heartbeat + idle traffic; check memory + reconnect count | Long-run stability; counter creep |

Resilience failures are rarely blockers for a release — they're prioritizable bugs. Treat them like any other quality work.

---

## Time + cost estimate

| Layer | Time | One-time cost | Recurring |
|---|---|---|---|
| A — infrastructure | 10–30 min | $0–$5 | $5/mo if Railway |
| B — smoke suite | 30–45 min run + 15 min triage | $0 | $0 |
| C — resilience | 2–4 hours if run fully | $0 | $0 |

**Minimum path to "validated":** Layer A (local Docker) + Layer B = ~50 minutes.

---

## Execution handoff

1. Apply Layer A setup (one of A1/A2/A3).
2. Run `docs/superpowers/audits/live-gateway-smoke.ts` (stub script ships with this plan — add env vars and run).
3. Triage results.
4. If green: strike the last "live-gateway validation" line from the Known Limitations section in CLAUDE.md and the release note.
5. If red: file per-smoke bug reports; prioritize based on whether the failure is ours or upstream.

## What doesn't belong in this plan

- Running OpenClaw in production for real users — that's a separate release cycle.
- ClawHub publishing (Block 3.4) — external marketing task, doesn't depend on a running gateway.
- Scale/load testing — only after correctness is proven.
