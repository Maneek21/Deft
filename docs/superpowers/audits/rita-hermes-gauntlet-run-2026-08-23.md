# Rita / Hermes Gauntlet Run — 2026-08-23

**Environment:** `https://demo.deft.ing`

**Employee:** Rita (`rita`), Hermes, `gpt-5.6-sol`, medium reasoning

**Repository revision:** `e1d0a58c`

**Result:** BLOCKED AT PREFLIGHT — Agent Channel API/runtime version mismatch

## Executive finding

The gauntlet could not safely begin because demo's Agent Channel API is still returning the pre-lease event shape while Rita's installed bridge is the new lease-aware implementation.

The bridge requires every delivered event to contain `claim_token`. Demo returned events without `claim_token`, `claim_owner`, or `lease_expires_at`. The bridge therefore rejected the event before acknowledgement or Hermes execution, retried it hundreds of times, and prevented later messages from reaching Rita.

This is a deployment mismatch, not a Hermes inference or Deft MCP failure.

## Observed user-visible symptoms

- A Rita DM posted at 14:15 IST received Deft's “Sent to Rita” acknowledgement but no Rita response.
- A second Rita DM posted at 14:30 IST also received the acknowledgement but no Rita response.
- Rita's Developer page showed the channel as connected, one pending event, five historical failed events, and one delivered event with a rapidly increasing delivery count.
- The delivered event reached 547 delivery attempts before it was cancelled as obsolete to expose the next queued event.
- The next pending event immediately reproduced the same missing-claim-token failure.

## Focused reproduction

An authenticated read of one event from:

`GET /api/agent-channel/v1/events?caller_employee_slug=rita&worker_id=diagnostic-read&limit=1&lease_ms=30000`

returned:

- protocol: `deft.agent_channel.v1`
- event status: `delivered`
- event id: `c986e581-77e0-44dc-9b7c-af5167550ebb`
- delivery count at diagnostic read: 17
- `claim_token`: missing
- `claim_owner`: missing
- `lease_expires_at`: missing

The response keys ended at the legacy fields (`delivery_count`, timestamps, and error) and contained none of the lease/fencing fields required by the current bridge.

The installed bridge log repeatedly reported:

> Channel event c986e581-77e0-44dc-9b7c-af5167550ebb has no claim token

The preceding event `8009091b-2ba3-4ec3-a422-8fb0157bbcec` failed identically.

## Components that were healthy

- Rita Hermes gateway process was running.
- The latest repository bridge matched the installed bridge.
- Deft MCP was reachable and had previously exposed 73 tools.
- Demo's frontend exposed the new Agent Channel status and lifecycle UI.
- Rita was active, verified, not marked unhealthy, and on Standard trust.

## Root cause

The demo frontend and local Rita runtime/bridge contain the new single-flight protocol work, but the demo API service does not. The API advertises the unchanged `deft.agent_channel.v1` string while returning the legacy event contract, so the bridge cannot negotiate or clearly classify the incompatibility.

## Gauntlet status

| Stage | Status | Evidence |
| --- | --- | --- |
| Workspace inventory | Pass | People, spaces, projects, Knowledge, tasks, and Rita state read from demo |
| Hermes gateway | Pass | Rita gateway process running |
| Deft MCP | Pass | Authenticated workspace reads succeeded |
| Agent Channel delivery | Fail | Delivered event omitted required claim fields |
| Chat pickup and response | Fail | Two acknowledged DMs produced no Rita response |
| Core scenarios 1–12 | Not started | Stopped to avoid accumulating undeliverable work |
| Security scenarios 13–16 | Not started | Requires a functioning employee loop |
| Reliability matrix | Not started | Current mismatch would invalidate results |

## Required recovery

1. Deploy revision `e1d0a58c` to the demo API service, not only the web service.
2. Apply the Agent Channel lease/fencing database migration on demo.
3. Confirm `/events` returns non-empty `claim_token`, `claim_owner`, and `lease_expires_at`.
4. Cancel or retry the remaining stale queued DM after the API deployment.
5. Verify one natural DM completes with a single delivery and a Rita reply.
6. Start scenarios 1–4, then proceed through the rest of the gauntlet sequentially.

## Deployment access finding

`demo.deft.ing` resolves to `143.244.140.118` and is served through Caddy. The Railway account available in the browser contains only an expired, offline four-month-old `deft-test` project; it is not the live demo host. Direct SSH to the current demo IP did not accept the available local key. DigitalOcean account access is therefore required to locate and update the live droplet. The browser is paused at GitHub's DigitalOcean OAuth authorization screen so the account owner can explicitly authorize that access.

## Follow-up product hardening

Change protocol negotiation so a lease-aware bridge cannot connect to a legacy event contract under the same protocol version. Either bump the protocol version or advertise explicit capabilities such as `leases`, `fencing`, and `terminal_outcomes`, and fail readiness immediately when required capabilities are absent.
