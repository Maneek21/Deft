# Hermes Employee Onboarding Reliability

**Date:** 2026-08-23
**Status:** Accepted; implementation in verification
**Decision owner:** Deft
**Scope:** Hermes/OpenClaw-style BYOA employees connected through Deft MCP and Agent Channel

## Outcome

A newly onboarded Hermes employee must not be shown as ready until it has received a real Deft event, run a real Hermes model turn, used its employee-scoped Deft MCP identity, and reported the result back through Agent Channel. Incompatible Deft and Hermes integration versions must fail before polling work, with one actionable error instead of an endless retry loop.

Deft should provide the workspace, identity, event delivery, approvals, audit, and memory synchronization. Hermes should continue to provide reasoning, research, browser/computer use, external tools, MCP clients, skills, and its open-source ecosystem. This design does not rebuild those runtime capabilities inside Deft.

## Incident observed on demo.deft.ing

Rita appeared connected in Deft, but did not reply to direct messages. The Developer surface showed one pending event, five failed events, and an older event with more than 526 deliveries. The local bridge and Windows scheduled task were both alive.

The bridge repeatedly reported:

```text
Channel event <event-id> has no claim token
```

The live demo API identified itself as `deft.agent_channel.v1`, but its event representation did not contain `claim_token`, `claim_owner`, or `lease_expires_at`. The current bridge requires those fields before acknowledging or executing an event.

The repository contains the lease/fencing schema upgrade as `0.3.0-preview.4-agent-channel-leases.sql` and the memory-sync upgrade as `0.3.0-preview.5-wiki-memory-sync.sql`, while the repository package version remains `0.3.0-preview.3`. Rita's locally copied bridge was therefore newer than the deployed Deft Agent Channel server.

This was not a model-quality or contacts-module failure. Work never reached Hermes inference.

## Root causes

### 1. A breaking protocol change retained the same protocol version

Agent Channel added mandatory claim tokens, renewable leases, and fencing semantics without changing `deft.agent_channel.v1` or advertising required capabilities. A bridge cannot determine safely whether a server supports its execution contract.

### 2. Runtime artifacts are not coupled to the Deft release

The onboarding page currently tells operators to run `pnpm agent:hermes-channel` and provides configuration snippets. That can execute a bridge from an arbitrary repository checkout against a differently versioned Deft server. The Hermes plugins also do not declare a compatible Deft release, Agent Channel version, or required capabilities.

### 3. “Connected” proves transport liveness, not employee readiness

Calling `/connect` or polling `/events` updates the connection record. The UI can therefore show connected even when every event is unusable. The Windows service health check verifies that a process exists and that its log is fresh; repeating errors satisfy both conditions.

### 4. Certification proves MCP discovery, not the employee loop

The current certification challenge checks a set of MCP tools and a nonce. It does not prove Agent Channel delivery, event claiming, a Hermes inference turn, an employee-scoped tool call, a reply, or a terminal event outcome.

### 5. Release smoke tests omit the Agent Channel contract

The self-host smoke test checks API health, auth, and MCP basics. It does not exercise the Deft event -> bridge -> Hermes -> Deft path. The application can pass deployment checks while agent employees are unable to work.

## Architecture decision

Adopt a release-pinned Hermes integration bundle, an explicit Agent Channel compatibility handshake, and deep employee certification. Treat transport connection, runtime health, and employee readiness as separate states.

### Responsibility boundary

| Deft owns | Hermes owns |
| --- | --- |
| Employee identity and org-scoped credentials | Planning and reasoning |
| Native workspace MCP tools | Web research and computer use |
| Agent Channel queue, leases, fencing, and idempotency | External MCP servers and plugins |
| Trust, approvals, audit, and activity receipts | General-purpose skill ecosystem |
| Wiki/memory synchronization contract | Runtime memory and skill execution |
| Onboarding certification and visible readiness | Model/provider configuration |

## Contract changes

### Protocol version and capabilities

The lease/fencing contract is a breaking change and must use `deft.agent_channel.v2`. `/connect` must return a capability document even after future additive changes:

```json
{
  "protocol_version": "deft.agent_channel.v2",
  "server_release": "0.3.0-preview.5",
  "server_commit": "<sha>",
  "schema_head": "0.3.0-preview.5",
  "capabilities": [
    "single_flight_claims",
    "renewable_leases",
    "fencing_tokens",
    "terminal_outcomes",
    "identity_bound_mcp",
    "wiki_memory_sync_v1"
  ]
}
```

The bridge sends its adapter version, Hermes version, supported protocol majors, and required capabilities. If the intersection is empty or a required capability is absent, `/connect` returns an explicit incompatibility response, preferably HTTP 426 with a stable error code and the compatible integration version.

The bridge must validate the handshake before its first event poll. It must not silently downgrade to legacy unclaimed processing.

### Fail-fast runtime behavior

A missing claim token under v2 is an invalid server response, not a retryable event failure. The bridge must:

1. stop polling;
2. publish a bounded `incompatible_channel` runtime status when possible;
3. write a structured local health record;
4. exit non-zero so its supervisor can apply bounded backoff; and
5. never increment the same event's delivery count indefinitely.

The local service health check must use structured state such as `last_success_at`, `last_error_code`, `protocol_version`, and `adapter_version`. Process existence and log freshness are diagnostics, not health.

### Release-pinned integration bundle

Each Deft release must publish or serve one immutable Hermes integration bundle containing:

- the Agent Channel bridge;
- the Deft employee and memory adapters;
- a manifest with adapter version, compatible Deft release range, protocol majors, required capabilities, supported Hermes versions, and file checksums; and
- an install/upgrade command pinned to the running Deft release.

The onboarding UI must generate this pinned installation path. It must not depend on the operator having a matching Deft source checkout. Existing Hermes MCP servers and skills remain in Hermes; the bundle only implements the Deft boundary.

## Employee readiness certification

Readiness is earned through an end-to-end challenge:

1. **Identity:** validate the employee bearer and discover the required Deft MCP tools.
2. **Transport:** complete the v2 compatibility handshake.
3. **Delivery:** Deft publishes a certification event carrying a one-time nonce; the bridge claims it once and renews the lease if required.
4. **Inference:** Hermes runs a real model turn using the configured model and reasoning level.
5. **Workspace use:** the model calls `platform_context` through the employee-scoped MCP identity and returns the nonce.
6. **Report back:** Hermes posts a channel reply and terminal outcome. Deft verifies employee identity, nonce, claim token, single delivery, and terminal state.
7. **Memory:** run a small wiki recall and memory-writeback probe without exposing secrets.

Only a successful challenge sets `ready_at`. A simple poll updates transport state but cannot mark an employee ready.

Suggested visible states:

- `setup_required`
- `transport_connected`
- `certifying`
- `ready`
- `degraded`
- `incompatible`
- `offline`

The UI must show the exact remediation for `incompatible`, including installed adapter version, server release, and the pinned upgrade command.

## Release and deployment gates

Before publishing a release:

- bump the package/release version whenever the protocol or required schema advances;
- require the release image, migration manifest, and Hermes bundle manifest to agree on protocol and minimum schema;
- expose release, commit, and schema head in a safe version/readiness endpoint;
- fail API readiness when required Agent Channel columns or migrations are absent; and
- add an Agent Channel compatibility and certification smoke test to CI and `selfhost:smoke`.

The normal combined Deft image already avoids independent web/API drift. Upgrades must continue to apply versioned database migrations before recreating the app, then run the deeper smoke test before declaring success.

## Immediate recovery for demo

Do not add a legacy claim-token bypass to the current bridge.

1. Cut a named Deft release that includes the Agent Channel lease migration and wiki memory-sync migration, with a correctly bumped package version.
2. Build and deploy the combined immutable image to the real demo host.
3. Apply the supported database upgrade and verify the schema head.
4. Install the Hermes integration bundle produced by that release for Rita.
5. Run the deep certification challenge using `gpt-5.6-sol` at medium reasoning.
6. Cancel obsolete malformed deliveries, retry only valid pending work, and rerun the employee gauntlet.

If an emergency rollback is necessary, the only safe temporary pairing is the old server with its exact bundled old adapter. That pairing should not be certified as fully autonomous because it lacks the newer lease/fencing guarantees.

## Work order

### Minimum work for maximum experience

1. Bump Agent Channel to v2 and add the bidirectional capability handshake.
2. Make the bridge fail closed on incompatible or malformed channel responses.
3. Separate transport, health, and readiness states in API and UI.
4. Implement the real end-to-end onboarding certification challenge.
5. Package and publish a release-pinned Hermes integration bundle.
6. Add version/schema metadata and Agent Channel checks to release and self-host smoke gates.
7. Deploy the matched release and bundle to demo, certify Rita, and rerun the gauntlet.

### Should follow immediately

1. Automatic adapter update availability and `needs_recertification` state for existing employees.
2. Semantic local-service health and bounded backoff/circuit breaking.
3. A one-click diagnostic export containing versions, capabilities, recent status codes, and redacted queue state.
4. Scheduled synthetic certification for demo and production canaries.
5. Memory-sync certification expanded to conflict, provenance, and permission cases.

### Park for later

- Reimplementing Hermes skills, universal MCP support, browsing, or computer use in Deft.
- A broad plugin marketplace beyond the existing curated/runtime-owned model.
- Hot-swapping protocol majors without restarting the bridge.
- Cross-runtime orchestration that is unrelated to onboarding reliability.

## Acceptance tests

The change is complete only when all of these pass:

- A fresh Deft install can onboard a clean Hermes runtime using only the pinned release instructions.
- A v2 bridge against a v1 server is rejected before the first event poll and produces one actionable UI error.
- A compatible employee completes the real inference certification with exactly one delivery and one terminal outcome.
- Bridge restart, Hermes restart, expired lease, stale claimant, duplicate delivery, child-process failure, revoked MCP credential, and memory-sync outage each produce truthful state without duplicate external writes.
- The UI never labels transport-only connectivity as employee readiness.
- No credential or claim token appears in logs, diagnostics, or certification replies.
- Rita completes three consecutive multi-step research/workspace scenarios, including a long-running task, and reports progress, blockers, and final artifacts correctly.

## Rejected alternatives

### Accept missing claim tokens in the new bridge

Rejected. It would mask the deployment mismatch and remove the concurrency guarantees that prevent overlapping or stale execution.

### Fix only the demo deployment

Rejected as the full solution. A matched deploy restores Rita, but the current onboarding and health model allows the same mismatch to recur for the next customer.

### Move general Hermes capabilities into Deft

Rejected. It duplicates Hermes's ecosystem, expands Deft's security surface, and weakens the value of onboarding a capable external agent runtime.
