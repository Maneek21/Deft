# App Platform Phase 4 — Resource participation loops

| Field | Value |
|---|---|
| Status | Read-only implementation handoff; no Phase 4 code started |
| Released baseline | `v0.3.0-preview.14` at `6d39e0e0413c82d36c9481849ae582fdf805d1a6` |
| Baseline image | `sha256:e565cc64ee22b5b9f6f99973e3762b639c27e026dc8824852145035acdacf788` |
| Architecture source | `2026-08-29-full-surface-app-platform.md` |
| Delivery source | `2026-08-30-full-surface-app-platform-delivery-plan.md` |
| Phase 3 evidence | `../audits/2026-08-31-app-platform-phase-3-release-certification.md` |
| Outcome | Two independently installed declarative Apps can relate live-authorized resources without copying them; the same seam works for one core resource without weakening its current authorization. |

## Why this is the next slice

Phase 3 supplied durable governed effects. It deliberately did not give Apps
authority. Phase 4 supplies the other half of native participation: a stable way
to address, resolve, relate, and search resources while the host remains the
only authorization authority.

This phase is not a universal rewrite of Deft data. It extracts the smallest
resource seam needed by two independent Apps, then proves that seam against a
heterogeneous core resource. Existing Module APIs, data, same-installation
relations, search results, and agent behavior remain valid throughout.

## Architecture gate decision

The user problem is cross-App composition without copied records or duplicated
authorization. The required outcome is one small host-owned seam that can serve
Module records and a real core resource while preserving tenant isolation,
current owner authorization, Module v1 bytes, and additive rollback.

Three implementation shapes are credible:

| Option | Strength | Why it loses or wins |
|---|---|---|
| Extend only `module_record_relations` across installations | Smallest immediate schema change | Loses: it embeds Module identity/authorization in every caller, cannot prove Task reuse, and makes the later Resource Service a second migration. |
| Closed ResourceAuthorizationService plus host-bound ResourceRef and adapters | Small public contract; current owners retain authorization; additive relation store supports heterogeneous endpoints | Wins: it is the smallest seam that satisfies both cross-App and Task proofs, is reversible behind existing callers, and keeps provider registration code-owned. |
| Universal registry and immediate conversion of all core resources | Maximum apparent generality | Loses: speculative adapters, broad migrations, large privacy blast radius, difficult rollback, and no evidence that the first proof needs most of it. |

Choose the closed service and adapter option. Removing it would force relation,
picker, search, context, agent, and later App-grant callers to repeat provider
routing and live authorization, so it passes the deletion test: the complexity
is real and belongs behind one interface. Keep the interface deep by exposing
resolve/mutate/search semantics rather than adapter storage details.

The main risks are a prematurely broad ResourceRef, generic edges without
cross-table foreign keys, temporary dual relation stores, and authorization
drift. Mitigate them with a closed provider union, no generalized public route
or token scope, host-derived organization, endpoint locks and live owner
authorization, a v1 compatibility adapter, deterministic parity shadows, and
release rollback that retains additive tables. The acceptance matrix at the end
of this plan is the evidence required before the decision is considered proven.

## Frozen proof and scope

### Independent artifacts

Build two independent App v0 fixtures using only the public App Kit:

- **Contacts** owns a Contacts Module with organization-visible contact
  records.
- **Campaigns** owns a Campaigns Module whose records can reference Contacts
  from the separately installed Contacts App.

The Apps have distinct canonical lineages, packages, installations, Module
installations, and lifecycle epochs. Neither may assume the other's database
IDs or copy the other's records. Phase 4 does not add an App dependency grant;
Phase 5 binds exact App dependencies and capabilities.

Freeze a deterministic sandbox-email MCP provider alongside the fixtures, but
do not invoke it in Phase 4. It constrains the future Campaign action and proves
that `update campaign` cannot hide a network effect. Sending email begins in
Phase 5 through CapabilityService and an App Run.

### Exact operations

The first proof needs only:

- resolve one Contact or Campaign by ResourceRef;
- list safe references for an authorized picker;
- create, update, and archive through the owning Module service;
- link and unlink a Campaign-to-Contact relation with an idempotency key and
  optimistic-concurrency precondition;
- render the resolved Contact label in the existing generic Module UI;
- include authorized Contact/Campaign results in the existing Module search and
  agent context paths; and
- stop resolution immediately when the actor loses access or either owning
  installation is disabled.

It does not need arbitrary graph traversal, bulk mutation, files/blobs,
specialized provider resources, App tokens, capability grants, or email send.

### Caller surfaces

The Phase 4 seam serves these existing authenticated callers:

1. human Module REST/UI reads and mutations;
2. current Module agent tools under their existing employee trust and
   installation policy;
3. existing Module search/context/citation assembly; and
4. internal conformance tests using explicit human and employee actors.

Do not add a generalized public `/api/resources` surface or new OAuth/MCP scope
in this phase. Phase 5 exposes App-scoped discovery and invocation after grants
exist. Personal MCP clients continue through their current Module tools.

## Frozen ResourceRef contract

The shared contract is a strict, bounded discriminated object:

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

For a Module record, `provider_instance_id` is the stable Module installation
ID, `resource_type` is the collection key, and `resource_id` is the opaque
record ID. For a Task, `provider_instance_id` is exactly `tasks`,
`resource_type` is exactly `task`, and `resource_id` is the current task ID.

The serialized client contract contains no organization ID. The host binds the
reference to the authenticated organization before lookup. Persisted relation
rows carry a host-derived `org_id`; callers cannot use a reference to select or
override it. Unknown provider combinations fail with a stable structured error
before any adapter call.

Adding a future provider kind is a versioned shared-contract change plus a
reviewed adapter registration. It is not a database row or App-manifest string
that dynamically loads code.

## Authorization and data-flow boundary

`ResourceAuthorizationService` is the only cross-provider resolve/mutation
entry point. It performs this order:

```text
authenticated actor + host org
        -> parse bounded ResourceRef
        -> select closed code-owned adapter
        -> resolve current owning resource
        -> delegate to the owner's current authorization
        -> return a safe projection or perform the authorized mutation
```

The service does not duplicate Module or Task access rules. The Module adapter
uses Module installation/record authorization. The Task adapter uses the
current Task/project authorization. Cached labels, search documents, relation
rows, provider claims, and App metadata may deny or assist lookup; none may
allow access.

Pure canonical state changes may use Resource Service only when the host owns
the state, schema validation, authorization, audit, idempotency, and concurrency
rule. Any remote, network, connector, or independently operated effect must use
CapabilityService and an App Run. An adapter must reject an `update` request
that would conceal such an effect.

## Relation and lifecycle contract

Reserve the next migration identifier only at Loop 0 after re-reading the
current upgrade manifest. At the released baseline, the next apparent slot is
`0.3.0-preview.22`; it is not assigned until that check passes.

The additive relation table stores:

- organization;
- a source ResourceRef tuple;
- relation type and stable relation ID;
- a target ResourceRef tuple;
- position where ordered cardinality needs it;
- idempotency key and actor/audit metadata; and
- creation/update timestamps plus a soft-deleted marker.

Both endpoints are resolved and authorized in one transaction before insert or
replacement. Database uniqueness prevents duplicate active edges and
cross-organization queries always include `org_id`. Because heterogeneous
targets cannot share a useful foreign key, service authorization and
tenant-scoped lookup are mandatory; relation rows never prove endpoint
existence or access.

Lifecycle behavior is fixed:

- **Module/App disabled:** retain edges, hide ordinary resolution/picker/search,
  and restore visibility only after re-enable plus live authorization.
- **Record archived:** retain edges; ordinary resolve returns unavailable while
  an authorized management projection may report `archived` without leaking
  fields.
- **Record soft-deleted:** retain a dangling safe reference with no cached label
  disclosure. Do not silently retarget or cascade-delete the opposite record.
- **Compatible Module upgrade:** stable installation and record IDs preserve
  edges.
- **Incompatible staged upgrade:** active pointers and edges remain unchanged
  when compatibility validation rejects activation.
- **Source unavailable:** ordinary relation reads return no target data. An
  authorized management path may count dangling edges without disclosing the
  inaccessible endpoint.

Existing `module_record_relations` remain the optimized same-installation v1
implementation. Phase 4 must not reinterpret them. A compatibility adapter may
project them as ResourceRefs; only new cross-installation fields use the new
relation store.

## Manifest compatibility decision

Module manifest schema `1`, its parser, canonical bytes, and digests are frozen.
Cross-installation reference fields require an additive Module manifest schema
version, provisionally `2`, with an explicit parser and upgrade compatibility
rule. Do not add optional keys to the v1 parser that change its canonical
output.

The v2 reference field declares a bounded target interface, cardinality, and
display behavior. It does not contain tenant IDs, grants, connector IDs,
provider URLs, executable hooks, or authorization rules. The installed host
resolves compatible target installations and the actor's access live.

## Task decision

Task is the immediately following heterogeneous fixture, not a blocker for the
first Campaign-to-Contact proof. It must land before Phase 4 is declared
complete. This ordering allows the first relation to validate the Module/App
composition need, then forces the seam to generalize beyond Module internals.

The Task adapter initially supports resolve and safe projection only. Task
mutation remains on the current Task service unless a later, separately tested
change proves exact parity. Task links are shadow-projected as ResourceRefs;
existing task relation tables and APIs remain source of truth.

## Delivery loops

### Loop 0 — Reconcile and freeze

- Re-read current schema, upgrade manifest, Module v1 contracts, Module
  relation service, Task authorization, search/context callers, and all dirty
  worktree state.
- Confirm the released Phase 3 baseline and next available migration ID.
- Materialize the two independent App/Module fixtures and deterministic sandbox
  provider without adding product behavior.
- Write the ResourceRef/authorization ADR with error shapes, data flow,
  lifecycle table, rollback, and rejected alternatives.
- Freeze the focused acceptance matrix and PR boundaries below.

**Stop condition:** if current Task/Module authorization cannot be delegated
without widening or if a caller needs a new token scope, stop and move that
caller to Phase 5 rather than weakening the boundary.

### Loop 1 — Shared contract and closed service seam

- Add strict shared ResourceRef schemas, limits, structured errors, safe
  projection types, and adapter interfaces.
- Add `ResourceAuthorizationService` with an empty/closed registry and explicit
  host context.
- Test malformed refs, unknown provider combinations, tenant spoof attempts,
  adapter error normalization, and denial-before-disclosure.
- Add architecture tests preventing routes, App artifacts, and providers from
  bypassing the service once they adopt it.

This loop changes no schema, UI, App manifest, token, connector, or provider
execution path.

### Loop 2 — Module adapter and parity shadow

- Implement resolve/list-safe-projection and owner-service mutation delegation
  for Module records.
- Project existing same-installation v1 relations as ResourceRefs without moving
  or rewriting rows.
- Run byte/state parity against the existing Module API for human and employee
  actors, disabled installations, deleted records, manifest mismatch,
  optimistic concurrency, and idempotency.
- Keep production reads on the old path while collecting deterministic shadow
  comparisons in tests and the certification fixture.

**Stop condition:** any authorized-result difference is resolved before a new
relation schema or UI caller is added.

### Loop 3 — Additive cross-installation relations and Module v2

- Add the confirmed versioned migration and Drizzle schema for generic relation
  edges.
- Add the independent Module v2 parser/JSON schema and prove Module v1 parsing,
  canonicalization, and digest fixtures are byte-identical.
- Implement link, unlink/replace, list, and safe dangling-state behavior with
  endpoint locks, optimistic concurrency, idempotency, and audit.
- Test cross-org IDs, valid IDs from another installation, disabled endpoints,
  archive/delete races, duplicate/reordered writes, rollback, and failed
  activation.

Migration rollback is image rollback with additive tables retained; no
down-migration or v1 row rewrite is permitted.

### Loop 4 — Contacts/Campaigns compound proof

- Independently build/check/package/install Contacts and Campaigns.
- Create Contacts and Campaigns through the existing generic Module UI/API.
- Link Campaigns to Contacts through Resource Service and the new relation
  contract.
- Add the bounded reference picker/rendering behavior needed by the generic
  Module form and detail view. UI completion requires desktop and mobile visual
  inspection.
- Prove disable/re-enable, archive, delete/dangling, compatible upgrade, and
  failed incompatible upgrade behavior without copied records or domain code in
  core.
- Prove current employee Module tools see only the same authorized projections.

The sandbox-email provider remains unused and its call count must remain zero.

### Loop 5 — Task heterogeneous proof

- Register the closed `core/tasks` adapter.
- Resolve safe Task projections through current Task/project authorization.
- Shadow-project existing task links as ResourceRefs without changing their
  source tables or public behavior.
- Add a bounded Campaign-to-Task or Contact-to-Task conformance fixture only if
  it improves the heterogeneous proof; do not add CRM-specific UI.
- Test project membership loss, assignment changes, private/restricted Task
  visibility, deleted Tasks, stale refs, and cross-org IDs.

Task mutation and universal core-resource conversion remain out of scope.

### Loop 6 — Search, context, and citation cutover

- Adapt only Module results used by the two proof Apps and Task results used by
  the heterogeneous fixture.
- Compare old and Resource Service results for authorized IDs, safe fields,
  ranking inputs, snippets, and citations. A projection mismatch cannot be
  waived by a higher result count.
- Resolve and authorize live immediately before returning content; stale search
  documents can only nominate candidates.
- Add revocation tests where membership, installation state, record state, or
  Task visibility changes after indexing.
- Use one bounded default-off rollout control if runtime shadowing is required;
  document it and its removal criterion. Do not add parallel permanent search
  architectures.

### Loop 7 — Consolidate, release, and hand Phase 5 exact inputs

- Run shared ResourceRef and authorization contracts.
- Run Module v1 byte/digest compatibility and Module v2 tests.
- Run relation database, tenant, lifecycle, idempotency, concurrency, and
  malicious-provider tests.
- Run Module human/employee parity, Task authorization parity, search/context
  shadow/cutover, and architecture tests.
- Run API/shared/web/App Kit typecheck, one production build, and focused UI
  visual checks for the generic picker/detail behavior.
- Prove fresh pgvector schema, supported upgrade from `preview.14`, matched
  backup/restore, image rollback reads, and independent Contacts/Campaigns App
  installation on the release candidate.
- Record exact released commit/image, evidence, remaining adapters, and the
  Phase 5 sandbox-email interface inputs. Do not begin Phase 5 code in this
  loop.

## PR and review shape

Use additive merge trains rather than one large PR:

1. **PR A — contracts and authorization seam:** Loop 0 ADR plus Loop 1.
2. **PR B — Module adapter and relation substrate:** Loops 2–3, including the
   migration and Module v2 compatibility proof.
3. **PR C — proof callers and heterogeneous adapter:** Loops 4–6.
4. **PR D only if needed — release-only repair:** bounded fixes revealed by the
   release gate; do not mix Phase 5 grants or capability work into closeout.

Each PR gets focused checks while developing and one consolidated relevant
validation pass. Release infrastructure, fresh schema, restore, and rollback
run once against the merged candidate unless an earlier diff directly changes
them.

## Acceptance matrix

Phase 4 passes only when all are true:

- Contacts and Campaigns are independently built and installed; a Campaign
  references a Contact without copying it.
- No ResourceRef value can select an organization or dynamically load an
  adapter.
- Cross-org and unauthorized endpoint resolution fails before labels, snippets,
  or fields are disclosed.
- Module/App disable, archive, delete, membership loss, and Task visibility
  changes take effect on the next live resolve/search/context request.
- Existing Module v1 bytes/digests and same-installation relations are unchanged.
- Relation writes are tenant-bound, idempotent, concurrency-checked, audited,
  and deterministic through disable/upgrade/archive/delete.
- Task authorization parity proves the seam is not Module-specific.
- Stale search projections and malicious provider access claims never
  authorize.
- The sandbox-email provider receives zero calls.
- App origin, grants, connector bindings, and new token scopes remain absent.
- Fresh install, supported upgrade, backup/restore, and image rollback evidence
  pass on a release-capable host.

## Explicit exclusions

- App manifest capability/resource requirements, dependency grants, connector
  bindings, AppActionService, App-origin Runs, App Run UI, and App token scopes
  belong to Phase 5.
- Email send and the connected CRM/Marketing beta belong to Phases 5–6.
- Messages, wiki, notes, files, calendar, people, teams, specialized provider
  resources, sync, automation, custom UI, runtimes, and public ingress remain
  evidence-led later adapters/tracks.
- No domain-specific Contact/Campaign table, route, service, agent tool, or core
  branch is allowed.
- No marketplace, billing, hosted KMS, SaaS control plane, or mandatory hosted
  dependency enters Phase 4.

## Completion and pause rule

Phase 4 is complete only after the released evidence record proves the compound
App relation and heterogeneous Task seam on an ordinary self-host stack. A
contract merge without live authorization, lifecycle, search/context, and
rollback evidence is infrastructure, not completion.

Pause and reopen the architecture gate if implementation would require a new
tenant selector, token scope, App grant, dynamic provider registration,
in-process third-party code, remote effect hidden as resource mutation, v1
canonicalization change, down-migration, or authorization rule duplicated
outside its owning service.
