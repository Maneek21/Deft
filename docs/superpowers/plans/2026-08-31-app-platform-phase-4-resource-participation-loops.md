# App Platform Phase 4 — Resource participation loops

| Field | Value |
|---|---|
| Status | In execution; Loops 0–2 are locally checkpointed and Loop 3 is next |
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

Task is the heterogeneous owner fixture paired with the Module adapter in Loop
2. Proving both adapters behind the same parity kernel removes a separate
milestone and forces the seam beyond Module internals before the relation
migration lands. It does not add Task mutation or make Task a dependency of the
Contacts/Campaigns product flow.

The Task adapter initially supports resolve and safe projection only. Task
mutation remains on the current Task service unless a later, separately tested
change proves exact parity. Existing Task relation tables and APIs remain
source of truth and are not converted in Phase 4.

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

**Completed evidence (2026-08-31):** the released baseline and `.22` migration
slot were confirmed; current Module relation/search and Task visibility owners
remain delegable without a new scope. The architecture decision, independent
Contacts/Campaigns App v0 fixtures, and deterministic zero-call sandbox email
provider are materialized. Both Apps pass two identical public App Kit checks
with no connected permissions.

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

**Completed evidence (2026-08-31):** the shared closed ResourceRef and safe
projection contracts pass with all existing shared contracts (58 tests). Eight
focused service/fixture/architecture tests prove host-bound context, closed
adapter slots, pre-adapter rejection, denial/error sanitization, projection
validation, zero provider calls, and the absence of routes or effect/data
dependencies. Shared, App Kit, API, web, and repository typechecks pass.

### Tightened execution rules for Loops 2–5

- Preserve the acceptance matrix; remove repeated ceremony, not safety evidence.
- Reuse one parity-fixture library for Module, Task, relation, search, and
  revocation assertions. Do not grow separate end-to-end harnesses per caller.
- Keep one disposable PostgreSQL environment through focused development and
  reset only owned fixtures. Recreate it only when Loop 3 needs to prove the
  migration from a clean baseline.
- Run changed-package tests and typechecks during a loop. Run the broad matrix,
  production build, self-host proofs, packaging determinism, and rollback once
  in Loop 5.
- Do not add a generic mutation/search port before a concrete Loop 3 or Loop 4
  caller needs it. Existing owner services remain the mutation entry points.
- Do not wait for a separate Task milestone: prove the second owner adapter in
  the same parity loop as Modules.

### Loop 2 — Owner adapters and one parity kernel

- Implement the Module resolve/list-safe-projection adapter by delegating to the
  existing Module owner service; do not duplicate its authorization or mutation
  policy.
- Register the closed `core/tasks` resolve adapter in the same loop and delegate
  to current Task/project visibility.
- Add only the thin compatibility projection needed to express existing
  same-installation Module v1 relations as ResourceRefs. Do not move or rewrite
  their rows and do not generalize existing Task link tables.
- Use one shared parity fixture to compare existing-owner and Resource Service
  results for human and employee actors, tenant spoof attempts, disabled or
  deleted Modules, manifest mismatch, project membership loss,
  private/restricted Tasks, deleted Tasks, and stale references.
- Keep production callers on their current paths. This loop proves both owner
  adapters but changes no route, UI, schema, or mutation behavior.

**Stop condition:** any authorized-result or disclosure difference is resolved
before a relation migration or production caller is added.

**Completed evidence (2026-08-31):** the configured service has only the
code-owned Module and `core/tasks` adapters. Fourteen focused contract,
adapter, error-normalization, v1-projection, and architecture tests pass, plus
one live-database parity journey covering Module human/employee resolution,
Task human/employee visibility, project-scope and restricted/deleted/cross-org
denial, live employee pause, Module disable/re-enable, and record archive. API
typecheck passes and no route, UI, schema, mutation, token, connector, or App
grant adopts the seam. The dedicated local database uses a test-only storage
stand-in because this machine lacks pgvector; that is not counted as the Loop 5
fresh-pgvector proof.

### Loop 3 — Relation substrate and Module v2

- Add the confirmed `.22` migration and Drizzle schema for generic resource
  relation edges.
- Add the independent Module v2 parser/JSON schema and prove Module v1 parsing,
  canonicalization, digests, installs, and same-installation relation behavior
  remain byte/state identical.
- Implement only the operations required by the proof: link, replace/unlink,
  list, and safe dangling-state resolution. Both endpoints pass through the
  closed authorization service; writes remain tenant-bound, locked,
  concurrency-checked, idempotent, and audited.
- Run one database matrix covering cross-org and cross-installation IDs,
  disabled endpoints, archive/delete races, duplicate/reordered writes,
  compatible and rejected upgrades, and additive-row retention semantics.

No UI or search caller lands in this loop. There is no down-migration, v1 row
rewrite, App grant, or generalized resource mutation API.

### Loop 4 — Single compound App and caller cutover proof

- Build/check the independent Contacts and Campaigns fixtures once, install
  them together, and create records through the existing generic Module API/UI.
- Link a Campaign to a Contact through the new relation substrate without
  copying either record. Add only the generic reference picker and resolved
  label rendering required by Module v2.
- Adopt the Resource seam for the proof Apps' human/employee relation reads and
  their bounded search, agent-context, and citation return paths. Stale indexes
  may nominate candidates but live owner authorization runs immediately before
  content is returned.
- Exercise the Task adapter in the same caller matrix to prove the seam is not
  Module-specific; do not create a Campaign-to-Task domain fixture or convert
  Task mutation/link storage.
- Use one end-to-end lifecycle matrix for disable/re-enable, archive,
  delete/dangling state, membership loss, Task visibility change, compatible
  upgrade, rejected upgrade, and post-index revocation.
- Inspect the generic picker/detail behavior once at representative desktop and
  mobile sizes. Assert the sandbox-email provider still has zero calls.

Cut over only the bounded proof callers. Do not rewrite universal search or add
a rollout flag unless deterministic shadow comparison shows it is necessary.

### Loop 5 — Consolidated certification and release

- Run the shared ResourceRef/authorization contracts, owner-adapter parity,
  Module v1/v2 compatibility, relation database/lifecycle/concurrency tests,
  caller revocation tests, malicious-provider tests, and architecture guards as
  one focused matrix using the shared fixtures.
- Run API/shared/web/App Kit typecheck and one production build. Repeat visual
  inspection only if Loop 5 repairs changed the UI.
- Check/package Contacts and Campaigns twice for deterministic public App Kit
  output, then install the release-candidate packages once.
- Prove fresh pgvector schema, supported upgrade from `preview.14`, matched
  backup/restore, and image rollback reads once on a release-capable host.
- Record the exact released commit/image, evidence, remaining adapters, and the
  Phase 5 sandbox-email interface inputs. Do not begin Phase 5 code here.

Any failure gets the smallest repair and reruns only its affected focused gate
plus the final matrix. Unrelated self-host, Docker, visual, or migration work is
not repeated when the diff did not touch that surface.

## PR and review shape

Use a three-PR additive merge train:

1. **PR A — contracts and authorization seam:** Loop 0 ADR plus Loop 1.
2. **PR B — owner adapters and relation substrate:** Loops 2–3, including both
   owner parity proofs, the migration, and Module v2 compatibility.
3. **PR C — compound cutover and certification:** Loops 4–5 and the Phase 4
   evidence record.

Open a separate repair PR only if the release gate reveals a change that cannot
be reviewed safely inside PR C. Do not mix Phase 5 grants or capability work
into closeout.

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
