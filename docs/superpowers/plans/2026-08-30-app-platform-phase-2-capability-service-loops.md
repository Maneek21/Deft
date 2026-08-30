# App Platform Phase 2: Capability Service loops

**Status:** in progress; Loops 0–3 completed on 2026-08-30, Loop 4 next

**Implementation baseline:** `origin/master` at `bdb137ee33a047a39b73d5f08ea958efb1fcbf35`

**Outcome:** every production outbound MCP provider call crosses one deep internal Capability Service seam with no visible behavior change

## Problem and boundary

Deft currently has two production outbound MCP execution paths:

1. the immediate/read-classified tool path in `agent-context.ts`; and
2. the action path in `agent-actions.ts`, which serves both auto-direct and
   human-approved actions.

Both independently resolve the live connection, materialize runtime credentials,
call `mcpClientManager.executeTool`, and project its result. That duplication is a
real execution boundary: later App Runs, provider mappings, runtime providers,
and schema-drift checks need one authoritative call seam.

Phase 2 is a structural extraction only. It does not add App capabilities,
App Runs, grants, connector mappings, new approval policy, new tokens, UI,
automation, or execution authority.

## Invariants

- Preserve current tool names, discovery order, descriptions, input schemas,
  output payloads, errors, approval tiers, assignments, allowlists, employee
  budgets, connector health/backoff, timeouts, and citations.
- Resolve organization and live connector/employee policy from authenticated
  server context. No provider-supplied field becomes policy or authorization.
- Invoke the provider at most once for one Capability Service invocation.
- Do not shadow-execute external effects to compare old and new paths.
- Keep the existing `mcp_connections.tools_cache` compatibility behavior. It is
  a mutable admin cache and is not an authorization or runtime snapshot.
- Add no database migration in Phase 2. Durable snapshot pinning begins only
  when Phase 3 App Runs provide a concrete owner, retention policy, and reference.
- Keep the service as a logical deep module inside the existing API process.
  Self-hosting gains no mandatory process, queue, or network dependency.

## Architecture decision

Use a closed provider adapter behind `CapabilityService`.

```text
immediate path ─┐
                ├─ CapabilityService ─ MCP provider adapter ─ MCPClientManager
action path ────┘
```

The service owns strict request validation, provider dispatch, and a stable safe
result. The MCP adapter owns MCP connection resolution, target/auth
materialization, discovery, execution, and legacy payload projection. Only the
adapter may call the low-level MCP client manager's execution method.

An immutable `ProviderDiscoverySnapshot` is a strict tenant-bound value, not a
Phase 2 table. It contains a safe projection, deterministic digests, and no
credentials, targets, invocation data, raw provider object, or effective Deft
policy. Persisting unused discovery history now would introduce retention,
connector-deletion, garbage-collection, and failure semantics while providing
no Phase 2 reader. Phase 3 may persist the minimum snapshot needed by a Run.

Rejected alternatives:

- A pass-through wrapper around `executeTool` leaves connection policy and
  result mapping duplicated in callers and fails the deep-module test.
- A new network service adds self-hosting and failure complexity without a
  process-isolation requirement.
- A durable Phase 2 snapshot table has no concrete consumer and fails the
  deletion test.
- Shadow execution can duplicate non-idempotent external effects and is never
  used for parity testing.

## Loop 0: Rebaseline and freeze parity

### Work

- Reconcile the canonical roadmap with the merged Phase 1 revision and green
  post-merge database/bootstrap evidence.
- Record the two production execution paths and every direct low-level call.
- Freeze the compatibility matrix below before changing either path.
- Run the existing focused MCP safety, trust, and approval tests at the baseline.
- Search open work to avoid overlapping Capability Service implementation.

### Exit evidence

- Clean Phase 2 worktree is based on the exact merged Phase 1 revision.
- Existing focused MCP and approval tests pass unchanged.
- The outcome, exclusions, cutover order, and stop conditions are reviewable.

## Loop 1: Strict shared contracts and snapshot values

### Work

- Add strict Zod and TypeScript contracts for provider identity, operation
  identity, discovery snapshots, invocation requests, safe results, and stable
  internal error codes.
- Start with the closed provider kind `mcp`; adding a provider kind requires an
  explicit adapter and tests.
- Canonicalize safe JSON deterministically: object keys sorted while exact
  strings, property keys, and provider array order remain unchanged.
- Digest executable input/output schemas and the complete safe discovery
  projection with ordinary SHA-256 and explicit domain/version prefixes.
- Reject duplicate provider-operation tuples and tenant mismatches.
- Treat provider descriptions, titles, schemas, and annotations as untrusted
  data; keep effective approval and assignment policy outside the snapshot.

### Exit evidence

- Equivalent discovery values produce identical digests independent of object
  key order.
- Executable schema changes change the operation and snapshot digests.
- Credentials, transport targets, auth configuration, params/results, and raw
  provider objects cannot appear in the safe snapshot contract.
- Shared contract tests pass without API or database access.

## Loop 2: MCP provider adapter and discovery parity

### Work

- Add one MCP provider adapter over the existing client manager.
- Route runtime discovery and production/admin discovery calls through
  Capability Service while retaining the current cache and refresh semantics.
- Produce immutable safe snapshots alongside the exact legacy MCP tool
  projection; do not expose snapshots to Apps or persist them.
- Resolve tenant/provider identity and materialize targets/credentials inside
  the adapter. Capture the policy-free provider projection from the same
  `listTools` call, preflight provider JSON, and reuse snapshots for unchanged
  in-process cache entries.
- Preserve override merging, disabled-tool filtering, description hardening,
  input-schema hardening, connection order, tool order, and failure isolation.
- Move scripts that exercise production discovery onto the same adapter seam.

### Exit evidence

- Golden before/after discovery projections are byte/deep equal.
- Refresh, cached, test-connection, partial-provider-failure, duplicate-tool,
  disabled-tool, and tenant-negative tests pass.
- Snapshot construction failure cannot weaken policy, cause another provider
  request, or change the exact legacy discovery result; observational snapshot
  evidence is simply unavailable for that provider.

## Loop 3: Immediate execution cutover

### Work

- Route the `agent-context.ts` MCP branch through `CapabilityService.invoke`.
- Keep live connection, target, enabled-tool, employee assignment, disabled-tool,
  and budget checks in their existing order and with their existing messages.
- Preserve structured MCP output, explicit outer error signal, duration,
  citation identity/title, timeout, auth-expiry handling, and backoff behavior.
- Preserve the untouched legacy payload beside a strict safe projection. Mark
  non-JSON SDK edge outputs unrepresentable without throwing, retrying, or
  changing an already-attempted result.

### Exit evidence

- Success, tool-declared error, transport failure, revoked connection, stale
  assignment, disabled tool, malformed prefixed name, and cross-org cases match
  the baseline result and citation behavior.
- A counting fake provider proves one low-level execution per invocation.
- Golden before/after immediate-path DB tests preserve structured success,
  tool/transport errors, citations, denial ordering, and zero-call boundaries.

## Loop 4: Action execution cutover

### Work

- Route the `agent-actions.ts` MCP branch through the same service.
- Preserve proposal validation, effective approval tier, destructive detection,
  employee policy, daily budget consumption, result/error persistence,
  `executed_at`, receipts, and existing resolver behavior.
- Recheck live connector and employee assignment immediately before execution.

### Exit evidence

- Auto-direct, quick, and full approval paths retain their current outcomes.
- Revocation between proposal and execution fails before the provider call.
- Success and error rows remain projection-compatible.
- Approval replay, duplicate execution, and provider-error tests prove at most
  one external call.

## Loop 5: Seal and certify the seam

### Work

- Add an architecture test that permits `executeTool` only inside the MCP
  provider adapter in production source.
- Remove obsolete direct execution imports and duplicated mapping code only
  after both callers are certified.
- Run focused tests, repository typecheck, API suite, production build/image,
  browser/MCP smoke, security workflows, and versioned-upgrade preservation.
- Inspect the final diff and package output for unintended authority, schema,
  migration, UI, env, or self-hosting changes.

### Exit evidence

- Grep/architecture test proves one low-level production execution seam.
- Current connector/trust tests and new automatic/reviewed parity tests pass.
- There is one provider call per invocation and no visible behavior change.
- No database migration, new feature flag, token scope, App field, route, or UI
  is introduced.

## Compatibility matrix

| Surface | Must remain identical |
|---|---|
| Discovery | names, order, descriptions, schemas, annotations, disabled filtering, override precedence |
| Authorization | org scope, active connection, enabled tools, employee assignment, employee disabled tools |
| Approval | dynamic tier mapping, trust behavior, destructive handling, proposal/resolver outcomes |
| Execution | target validation, runtime credential materialization, timeout, auth expiry, backoff, no retry |
| Result | raw structured result, content, structured content, metadata, explicit error, stored result |
| Accounting | employee daily budget, one provider call, `executed_at`, receipt and audit behavior |
| Operations | connection refresh/test semantics, self-hosted stdio/network policy, no new service |

## Stop conditions

Stop and reopen the architecture gate if Phase 2 would require any of:

- persisting invocation inputs, results, or discovery history;
- changing approval, retry, receipt, token, grant, or connector policy;
- exposing capabilities to Apps, MCP clients, or UI;
- introducing a provider-specific branch outside the provider adapter;
- executing old and new external paths for comparison;
- adding a mandatory process or hosted dependency; or
- changing an existing MCP error/result shape to make the abstraction cleaner.

Those belong to later phases or require an explicit compatibility decision.
