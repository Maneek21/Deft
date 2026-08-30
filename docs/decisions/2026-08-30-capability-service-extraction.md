# ADR: Capability Service extraction and discovery snapshot lifetime

- Status: Accepted
- Date: 2026-08-30
- Implementation baseline: `origin/master` at `bdb137ee33a047a39b73d5f08ea958efb1fcbf35`
- Supersedes: provisional durable-snapshot timing in the earlier App Protocol v2 sequence where it conflicts

## Context

Outbound MCP execution currently crosses two direct production seams: the
immediate/read-classified branch in `agent-context.ts` and the action branch in
`agent-actions.ts`. The latter serves both auto-direct and human-approved
actions. Later App Runs and provider types need one authoritative provider-call
boundary, but Phase 2 promises no visible behavior change.

The full-surface roadmap also requires immutable provider discovery snapshots.
The current runtime uses a five-minute process-local MCP tool cache. The
`mcp_connections.tools_cache` JSON is a separate mutable Integrations/admin
cache and is not read to authorize or execute tools.

No Phase 2 object needs to retain or reference discovery history. Phase 3 App
Runs are the first concrete durable consumer that must pin executable provider
schema evidence and own its retention, connector-deletion, and schema-drift
semantics.

## Decision

### Deep internal seam

Create a logical in-process `CapabilityService` with a closed code-owned
provider dispatch and an MCP provider adapter.

The service accepts a strict provider-neutral invocation descriptor and returns
a provider-neutral safe outcome. The MCP adapter alone owns:

- live organization-scoped connection resolution;
- employee assignment, connection allowlist, and disabled-tool enforcement;
- target validation and runtime credential materialization;
- low-level MCP discovery and execution calls; and
- conversion from MCP results into the service outcome.

Legacy callers retain their current policy/budget/approval ordering and project
the service outcome back into the exact current citation and `agent_actions`
shapes. Phase 2 does not move those governance decisions into the service.

### Snapshot as an immutable value

Phase 2 defines `ProviderDiscoverySnapshot` as a strict immutable tenant-bound
value returned by discovery. It is not stored in a new table.

The value contains:

- provider kind and instance identity;
- adapter contract and snapshot schema versions;
- an ordered safe operation projection with unique operation keys;
- per-operation executable-schema digests;
- a complete safe-projection digest; and
- capture time.

Canonical JSON sorts object keys, normalizes strings to NFC, and preserves array
order. Digests use ordinary SHA-256 with explicit domain/version separation.
Credentials, transport targets, auth configuration, invocation arguments and
results, raw MCP tool objects, and effective Deft policy are excluded.

The snapshot is observational evidence only. It never authorizes, filters,
validates an invocation, or becomes required for a legacy call. Live connector,
assignment, override, and approval policy remain authoritative.

Phase 3 may persist the minimum immutable provider snapshot referenced by a Run
after it defines retention, encryption/privacy classification, schema-drift,
connector deletion, garbage collection, and backup/restore behavior. It must
not backfill from `mcp_connections.tools_cache`, which may be stale and contains
legacy policy-enriched tool projections.

## Options considered

### Thin `executeTool` wrapper

Rejected. It would leak MCP configuration/results through the new interface and
leave connection resolution, discovery, policy checks, and result mapping
duplicated in callers. Removing it would make complexity disappear instead of
moving behind the seam.

### New networked Capability Service

Rejected. There is no process-isolation or scale requirement in Phase 2. It
would add a mandatory self-hosted dependency and new partial-failure modes.

### Append-only durable discovery snapshots in Phase 2

Rejected for now. Without a reader or reference, the table would be shadow data
whose write failure, retention, deletion, and garbage-collection behavior must
be invented. MCP schemas can contain dynamic `enum`, `default`, and `const`
values, so retaining them before the Run privacy/retention model also creates a
data-lifetime boundary. Removing such a table would remove complexity without
making any caller harder, so it fails the deletion test.

When persistence has a consumer, immutable versioning requires provider
identity to remain distinct from append-only content-digest snapshots; a single
row unique only on the provider operation tuple cannot represent schema drift
without mutation.

## Compatibility boundary

Phase 2 preserves names, order, descriptions, schemas, raw structured results,
errors, citations, approval tiers, destructive classification, assignments,
budgets, timeouts, backoff, connector cache invalidation, receipt behavior, and
all current token/scope behavior. It adds no App manifest fields, routes, UI,
grants, App Runs, database migration, feature flag, provider interface mapping,
or new execution authority.

No old/new external execution shadowing is permitted because it could duplicate
a non-idempotent effect.

## Acceptance evidence

- Exactly two baseline production execution seams are recorded and cut over one
  at a time.
- Strict contract tests prove deterministic digests, tenant binding, operation
  uniqueness, schema-drift sensitivity, and exclusion of unsafe fields.
- Golden discovery tests preserve legacy tools and admin cache behavior.
- Immediate, auto-direct action, and human-reviewed tests preserve result,
  citation, action-row, budget, approval, and receipt behavior.
- Denial and revocation produce zero provider calls; every attempted provider
  execution produces at most one low-level call.
- An architecture test permits low-level MCP execution only in the MCP provider
  adapter.
- Existing connector/trust tests plus repository CI, security, production-image,
  browser/MCP smoke, and versioned-upgrade checks remain green.
