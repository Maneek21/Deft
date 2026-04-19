# Block 3 complete — power users + ecosystem polish

**Branch:** `feat/openclaw-unlock-block1`
**Date:** 2026-04-19
**Shipped:** 5 of 10 tasks + `deft-mcp-client` live (exit gate met).

## What shipped

- **3.1 Clone + save-as-template.** `POST /:id/clone` duplicates an agent with a fresh slug + all skills; `POST /:id/save-as-template` writes an org-scoped `agent_employee_templates` row. Migration 0051 makes templates org-scoped (nullable `org_id`). Tests 7/7.
- **3.2 Developer credentials page.** `GET /:id/developer[?reveal=1]` returns connection URL + masked/revealed gateway token + wscat one-liner + example JSON-RPC frames. Reveal gated to admin/owner. Dedicated page at `/settings/agent-employees/[id]/developer` with copy-to-clipboard.
- **3.3 Webhook-callable agents.** Migration 0052 + `agent_webhooks` table. Authenticated management surface + public HMAC-gated dispatcher on `/api/agent-webhooks/:slug`. Incoming POST enqueues an `employee-trigger` with `trigger_kind='webhook'` + full payload. Tests 9/9.
- **3.4 `deft-mcp-client` bundled skill.** On-ramp for any OpenClaw deployment (BYOA too) to talk back into its Deft workspace over MCP. Seeded into `skills` as `source='bundled'`. Tests 2/2.
- **3.8 Agent trace export.** `GET /api/agent/conversations/:id/trace.json` — format `deft.agent_trace.v1` with messages + actions + metadata as a single JSON download (Content-Disposition attachment). Tests 3/3.

## Deferred (see plan §3)

- 3.5 Skill version update UX — useful polish; defer until one skill actually ships a v1.1.0.
- 3.6 Deft Verified review workflow — needs the marketplace UI from Block 2+ to be active first.
- 3.7 Pre-bake Railway template image — infra, requires Railway access.
- 3.9 xterm.js terminal — feature-flagged experimental surface.
- 3.10 WhatsApp send-channel — needs live WhatsApp Business API access.

## Exit gate — green

- [x] At least 5 of 10 tasks shipped.
- [x] `deft-mcp-client` live in BUNDLED_SKILLS catalog, seeded into DB.
- [x] `pnpm --filter @deft/api typecheck` clean; `pnpm --filter @deft/web typecheck` clean.
- [x] Block 3 tests (21/21 net new) green; no existing tests broken.

## Migrations added

- `0051_org_scoped_templates.sql` — nullable `org_id` + COALESCE-keyed unique.
- `0052_agent_webhooks.sql` — webhook table with secret-hash + fire stats.

Migrations applied manually against dev DB; `_journal.json` remains stale (documented known limitation).

## Next

Block 4 is explicitly out of scope for this plan — closing the OpenClaw Unlock initiative.
