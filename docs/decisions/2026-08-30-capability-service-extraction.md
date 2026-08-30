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

During the parity cutover, `invoke` returns a transient compatibility envelope:
the exact untouched legacy payload and execution/citation facts sit beside a
strict safe-outcome projection. If an SDK edge payload cannot be represented as
finite JSON, the projection is explicitly `unrepresentable` while the legacy
payload, provider-attempt state, duration, and actual success remain intact.
Projection work is byte/depth/node preflighted before strict validation so a
large provider result cannot make the observational path unbounded.
Safe-projection failure after a possible external effect never throws, retries,
or reclassifies the provider call. Phase 3 Runs will decide how an
unrepresentable safe projection becomes a durable `unknown_outcome`; Phase 2
does not persist either projection.

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

Canonical JSON sorts object keys while preserving exact string values, property
keys, and array order. This keeps behaviorally distinct JSON Schema `const`,
`enum`, and property values distinct. Digests use ordinary SHA-256 with explicit
domain/version separation. Executable-schema digests exclude provider identity;
the enclosing snapshot digest binds schemas to the provider and operation tuple.
Credentials, transport targets, auth configuration, invocation arguments and
results, raw MCP tool objects, and effective Deft policy are excluded.

The snapshot is observational evidence only. It never authorizes, filters,
validates an invocation, or becomes required for a legacy call. Live connector,
assignment, override, and approval policy remain authoritative.

Discovery callers pass only authenticated organization and provider-instance
identity. The MCP adapter re-resolves that tuple before target validation and
credential materialization. One low-level `listTools` response yields both the
unchanged policy-enriched legacy tool array and a separate pre-override,
pre-filter provider projection. Snapshot prose/schema annotations are hardened
without changing executable schema values. Provider JSON is depth/count/byte
preflighted before cloning or hashing, and unchanged process-cache projections
reuse their immutable snapshot so observational work stays bounded on small
self-hosted deployments.

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

“Preserves receipt and retry behavior” includes two legacy asymmetries rather
than claiming they are the target design. The generic web approval path may
reopen a failed non-Module MCP action for an explicit later retry and does not
always emit the same receipt/approver projection as the signed resolver path;
auto-direct outbound MCP also has no generic signed receipt. Phase 2 keeps those
paths byte- and state-compatible. Phase 3 App Runs must replace them with a
uniform `unknown_outcome`, idempotency, receipt, and crash-repair contract.
Exactly once in this ADR means one low-level provider call per service
invocation or approval attempt, not one provider call for a legacy row that a
human explicitly re-approves after failure.

No old/new external execution shadowing is permitted because it could duplicate
a non-idempotent effect.

## Acceptance evidence

- Exactly two baseline production execution seams are recorded and cut over one
  at a time.
- Strict contract tests prove deterministic digests, tenant binding, operation
  uniqueness, schema-drift sensitivity, and exclusion of authority-bearing or
  transport fields from the snapshot envelope. Provider descriptions and JSON
  Schemas remain untrusted and may contain sensitive provider-supplied values.
- Golden discovery tests preserve legacy tools and admin cache behavior.
- Immediate, auto-direct action, and pending quick/full resolver tests preserve
  result, citation, action-row, budget, approval, replay, revocation, and the
  path-specific receipt behavior.
- Non-JSON SDK edge payload tests prove that strict safe projection failure
  cannot alter, retry, or hide an already-attempted legacy provider result.
- Denial and revocation produce zero provider calls; every attempted provider
  execution produces at most one low-level call.
- An architecture test permits low-level MCP execution only in the MCP provider
  adapter.
- Shared contracts, Capability Service, immediate/action parity, relevant
  connector/trust/approval/architecture tests, repository typecheck, and one
  production build remain green. UI, schema, environment, token, deployment,
  browser, image, and upgrade certification are not repeated unless the final
  diff touches those surfaces.
