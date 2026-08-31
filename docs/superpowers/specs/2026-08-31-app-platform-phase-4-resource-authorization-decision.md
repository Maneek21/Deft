# Phase 4 Resource authorization decision

| Field | Value |
|---|---|
| Status | Accepted for Phase 4 PR A |
| Baseline | `origin/master` at `55cbb078` |
| Plan | `docs/superpowers/plans/2026-08-31-app-platform-phase-4-resource-participation-loops.md` |
| Migration inventory | `.17`–`.21` recorded; `.22` is the next available slot, reserved for Loop 3 only |

## Problem and required outcome

Independently installed Apps need to reference live Deft resources without
copying records or duplicating authorization. The first proof is a Campaign
record referring to a Contact owned by a separate App. The same seam must then
resolve a core Task through current Task/project visibility before Phase 4 is
complete.

The outcome is one small host-owned service that parses bounded references,
binds them to the authenticated organization, selects a closed code-owned
adapter, delegates to the resource owner's current authorization, and returns
only a validated safe projection.

## Invariants

- A serialized ResourceRef never contains an organization or other authority.
- Module and Task services remain the authorization owners; adapters do not
  recreate their policy.
- Unknown provider combinations fail before an adapter, lookup, or disclosure.
- Provider metadata, cached labels, search documents, relation rows, and App
  manifests can deny or nominate; they can never grant access.
- Module manifest schema `1`, canonical bytes, digests, and existing
  `module_record_relations` rows remain unchanged.
- No route, token scope, App grant, connector binding, provider execution,
  network effect, or UI behavior is added in PR A.
- A remote or independently operated effect is a Capability plus App Run, not
  a Resource mutation.

## Current data and trust flow

Module records are stored in `module_records`, scoped by `org_id` and a Module
installation. `module-service.ts` directly owns installation state, human MCP
scopes, guest restrictions, employee/Defty `agent_access`, record state,
manifest verification, concurrency, idempotency, search, and same-installation
relations. Existing relations have database foreign keys to records inside the
same installation.

Task reads remain on Task routes and queries. Restricted visibility is applied
through the current Task/project relationship checks, including creator,
assignee, project lead, explicit visibility, watchers, and secondary
assignees. Phase 4 must call that owner logic rather than translate it into a
generic ACL.

Module search, universal search, agent context, human MCP, employee tools, and
Module-to-Task links currently enter those owners through separate call sites.
PR A changes none of them. Later loops adopt the Resource seam one bounded
caller at a time after parity tests.

## Options considered

### Extend only Module relations across installations

This is the smallest immediate schema change, but it leaves Module identity and
authorization embedded in every caller. It cannot satisfy the Task proof and
would require a second relation migration when other resources arrive.

### Closed ResourceAuthorizationService and additive adapters — selected

This adds one strict ResourceRef plus a service with only two code-owned adapter
slots: Module and core Tasks. Organization context comes from the authenticated
host. Adapters call existing owners and return a minimal safe projection. The
service has no dynamic registration method and Apps cannot name executable
provider code.

This is the smallest option that satisfies both the cross-App and heterogeneous
Task proofs. It is reversible because callers can remain on current paths until
their parity gate passes, and the later relation table is additive.

### Universal resource registry and immediate core conversion

This would create speculative adapters and broad privacy/migration scope before
the first proof needs them. Rollback and authorization review would be much
larger, so it is rejected.

## Frozen ResourceRef v1

```ts
type ResourceRefV1 = {
  schema_version: 'deft.resource_ref.v1';
  provider:
    | { kind: 'module'; provider_instance_id: string }
    | { kind: 'core'; provider_instance_id: 'tasks' };
  resource_type: string;
  resource_id: string;
};
```

For Modules, `provider_instance_id` is the stable Module installation ID and
`resource_type` is the collection key. For Tasks, the provider instance and
resource type are exactly `tasks` and `task`. Identities are strict, bounded,
trimmed opaque values. Adding another provider requires a shared-contract and
source registration change.

The minimal safe projection contains the same validated reference, one bounded
label, and optional host-relative URL, revision, and freshness timestamp. It
contains no arbitrary provider fields, policy claims, tenant value, credential,
or cached authorization decision.

## Error contract

| Code | Meaning | HTTP mapping if a later route adopts it |
|---|---|---|
| `RESOURCE_CONTEXT_INVALID` | Trusted caller supplied incomplete host context | 400 |
| `RESOURCE_REF_INVALID` | Reference shape or identity is malformed | 400 |
| `RESOURCE_PROVIDER_UNSUPPORTED` | Provider tuple is outside the closed contract | 404 |
| `RESOURCE_PROVIDER_UNAVAILABLE` | Supported adapter is not installed or active | 404 |
| `RESOURCE_ACCESS_DENIED` | Current owner authorization denied | 403 |
| `RESOURCE_NOT_FOUND` | Authorized lookup found no live resource | 404 |
| `RESOURCE_UNAVAILABLE` | Resource is disabled, archived, or otherwise unavailable | 409 |
| `RESOURCE_OPERATION_UNSUPPORTED` | Adapter does not support the requested operation | 409 |
| `RESOURCE_PROVIDER_FAILURE` | Adapter failed or returned an unsafe projection | 500 |

Unexpected adapter errors are normalized. Raw database/provider messages and
partial projections never cross the service.

## Lifecycle and rollback

PR A is schema-free and dormant. Removing it restores the exact baseline
because no caller, route, manifest, or persisted row depends on it.

Loop 3 will use the confirmed `.22` slot for additive cross-installation
relations. Image rollback retains that table; there is no down-migration and no
rewrite of Module v1 relations. Disable, archive, delete/dangling, compatible
upgrade, and rejected incompatible upgrade behavior remain as frozen in the
Phase 4 loop plan.

## Proof fixtures

- `examples/resource-participation-contacts-app` owns one Contacts Module.
- `examples/resource-participation-campaigns-app` owns one Campaigns Module.
- Their App IDs, Module IDs, package lineages, slugs, and navigation are
  independent. Campaigns v1 intentionally contains no cross-App field; Loop 3
  adds that field only through Module v2.
- `apps/api/test/fixtures/phase4-sandbox-email-provider.ts` freezes a
  deterministic `send_campaign` network-effect contract. It is not referenced
  by either App and its Phase 4 call count must remain zero.

## Acceptance evidence for PR A

- Shared schemas accept only Module and core Task reference tuples and reject
  tenant fields, unknown providers, unsafe identities, and extra projection
  fields.
- The service uses host organization context and has no dynamic registration
  surface.
- Malformed/unknown refs and invalid context fail before adapter calls.
- Owner denial is preserved while unexpected provider errors are sanitized.
- Safe projection substitution or extra fields fail closed.
- Both independent App fixtures pass public App Kit check/build with
  deterministic output; the sandbox provider remains unused.
- Shared and API focused tests plus package typechecks pass. No database, UI,
  route, environment, token, connector, worker, or deployment diff exists.
