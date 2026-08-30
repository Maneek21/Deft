# App Platform Phase 3: Governed App Runs and Secret Service loops

**Status:** accepted and in progress; PR A (#271) and PR B (#272) merged the
dormant Loops 0–4 foundation and fake-provider engine. C0 is complete at local
checkpoint `4c4f48c1`; C1 live authorization/budget and C2 approval
compatibility are stacked on it pending review and publication.

**Rebaseline record:** Phase 2 PR #270 merged with every required check green;
the foundation selected `.17`, PR B selected `.18`, and the post-engine audit
re-confirmed `.19` as the additive C0 cutover-gate slot.

**Outcome:** Deft has an opt-in, actor-neutral, durable execution envelope with
encrypted retained inputs, governed approvals, explicit attempts and unknown
outcomes, sanitized signed receipts, and no implicit App authority

## Scope correction

The roadmap outcome is sound, but completing it as one PR is not. Phase 3
crosses cryptography, migrations, execution, approvals, workers, privacy,
receipts, self-host configuration, and rollback compatibility. It therefore
uses ten loops in four additive merge trains. Every train is reviewable and
rollback-safe on its own. No implementation started before Phase 2 merged.

Phase 3 does not add App manifest fields, App grants, capability bindings, App
catalog UI, automation ingress, arbitrary code, a new queue, or a mandatory
hosted dependency. Those remain later phases.

## Completion model

### Milestone A: dormant foundation

Loops 0–2 land contracts, keyring readers, and additive schema with the feature
off. Existing execution and existing ciphertext writes do not change.

### Milestone B: governed engine

Loops 3–4 implement lifecycle, idempotency, attempts, recovery, and retention
against fake providers. There is still no production cutover.

### C0 hardening gate before compatibility integration

The merged engine remains dormant, but its audit found boundaries that must be
fixed before any production ingress exists. C0 is a separate additive merge:

- persist a write-once execution release and refuse attempt creation, claim, or
  `running` transition while it is absent;
- keep a default-deny live execution-authorizer seam even after release;
- persist write-once budget-reservation evidence for the C1 budget adapter;
- pin every worker job to one exact attempt and heartbeat that attempt's lease;
- distinguish `not_attempted`, determinate provider return, and indeterminate
  dispatch, retaining bounded encrypted success or provider-error responses;
- make the idempotency index non-unique so the advisory-lock writer can create
  exactly one new Run after the fixed horizon; and
- constrain the future `agent_actions` compatibility row to
  `action = app_run_invoke`, the same safe Run ID, and a bounded allowlist.

C0 does not register a worker, call MCP, add an ingress route or flag, alter UI,
or reserve a live employee budget. Its evidence uses fake providers and the
disposable database only.

### C1 live authorization and budget gate

C1 adds upgrade `.20` and a host-owned authorization snapshot builder/verifier:

- security-relevant membership, employee, connector, override, MCP-token, and
  OAuth-token changes advance monotonic authority versions, including a
  revoke-then-restore cycle; ordinary counters, heartbeats, caches, and
  last-used timestamps do not;
- live authorization rederives membership, initiating/execution actor health,
  employee budget policy, token binding, connector activity, employee
  assignment, provider schema, and the bound host-policy version before an
  approval or attempt;
- agent action budget is reserved once in the same Run-locked transaction that
  creates the first attempt, and later claim/provider-call checks require that
  durable evidence; and
- system/automation actors remain fail-closed until a later host-owned
  authority source is explicitly designed.

C1 remains production-unwired. It adds no route, worker registration, provider
call, flag, UI, environment variable, or deployment dependency.

### C2 safe approval compatibility adapter

C2 creates exactly one `app_run_invoke` compatibility action in the same
transaction as every `pending_approval` Run. The row contains only Run ID,
bounded capability/provider labels, resource identities, and the validated safe
preview; it never contains invocation input, retry identity, provider output,
credentials, or ciphertext.

The existing approve/reject entrance delegates only this action kind to a
Run-native resolver. Human requester/owner/admin review is required and the
legacy internal bypass is explicitly refused. Resolution locks both rows,
rechecks C1 live authority, and atomically either records the write-once
approval release or cancels/expires the Run. The Run repairs the compatibility
row if they ever disagree, approval/rejection races append one resolution
event, and user-supplied rejection prose is not copied into the safe ledger.

C2 still does not enqueue an attempt or call a provider. C4 owns worker
scheduling after the remaining receipt and runtime boundaries exist.

### Milestone C: compatibility integration

Loops 5–7 integrate approvals, Capability Service, existing actors, receipts,
Attention, ancestry, and operator inspection behind a fail-closed flag.

### Milestone D: release certification

Loops 8–9 prove key rotation, supported upgrades, rollback, self-host operation,
parity, and leakage safety. Widening the flag remains a separate explicit
decision.

## Invariants

- Every persisted row and reference is tenant-bound; actor and organization
  identity come from authenticated context, never invocation input.
- After request ingress, raw invocation inputs and retry keys never reappear in
  approval rows, safe Run selections, events, receipts, logs, errors, metrics,
  Attention, traces, or API responses. Full sensitive provider output appears
  only in the authorized invocation/result response while its encrypted payload
  is retained, never in generic Run APIs or observability surfaces.
- App Run secret payloads are accessible only through the secret repository and
  are always encrypted with versioned AEAD plus tenant/Run/purpose AAD.
- One provider call belongs to one durable attempt. No route, approval resolver,
  worker, or Run service calls the MCP client directly.
- Unsafe/unknown attempts are never automatically retried after the call may
  have started. Exactly-once external delivery is not claimed.
- The App Run is the execution source of truth; `agent_actions` is only the
  linked compatibility approval surface.
- `review_requirement: always` cannot be bypassed by Autonomous trust.
- App installations have no execution authority until later App grants and
  bindings exist. `origin = app` therefore fails closed in Phase 3.
- Current legacy behavior remains selected while the flag is off. The old and
  new providers are never invoked for the same request.
- Current connector ciphertext and legacy action-receipt writes are not changed
  before their rollback-floor release gate.

## Proposed internal flow

```text
caller
  -> Capability Service governed entry
    -> App Run submit/replay
      -> immediate durable attempt OR linked approval adapter
        -> shared attempt runner
          -> internal capability provider executor
            -> MCP provider adapter
              -> low-level MCP client
```

The approval resolver and queue worker resume a Run through the same App Run
service interface. They do not receive decrypted input or a provider callback.

## Loop 0: Rebaseline and freeze the contract

### Work

- Rebase this plan onto the exact Phase 2 merge commit and rerun the architecture
  inventory against current code, schema, upgrade manifest, CI, and release
  docs.
- Record the exact state machine, stable error codes, actor/origin unions,
  retention classes, byte limits, retry classes, safe projections, AAD fields,
  keyring configuration, and rollback-floor rules in shared contracts and an
  accepted ADR.
- Freeze the difference between Run state and attempt state. Define the exact
  crash points that produce `failed`, `unknown_outcome`, or a retryable attempt.
- Define the opt-in flag semantics. Absence, malformed keyrings, and every value
  other than exact enablement fail closed without preventing a normal legacy
  self-host boot.
- Choose migration identifiers only after confirming the latest merged upgrade
  manifest.

### Exit evidence

- Two independent reviewers can trace data, trust, retry, migration, and rollback
  flows without an unresolved high-impact choice.
- No code, schema, environment, or execution behavior changes in this loop.
- The deletion test still justifies App Run service, the secret repository, and
  the internal attempt executor as deep boundaries rather than pass-throughs.

## Loop 1: Versioned Secret Service and key providers

### Work

- Add a narrow key-provider interface and a bounded environment-backed self-host
  provider. Do not add KMS/network dependencies.
- Add three purpose-separated versioned keyrings: Run AEAD, App Run receipt
  signing, and domain-separated input/idempotency fingerprints.
- Define a versioned envelope with random nonce, authenticated ciphertext,
  opaque key version, algorithm/envelope version, and AAD covering tenant, Run,
  payload kind, and schema version.
- Make safe projections explicit and impossible to construct from a raw envelope
  by object spreading.
- Add read/verify-only keys, one current write key, key-reference inventory, and
  refusal to remove a key still referenced inside the retention window.
- Preserve legacy `ENCRYPTION_KEY` reads and writes. Versioned legacy readers may
  be added, but no connector or existing receipt is rewritten.

### Exit evidence

- Random-nonce, wrong-AAD, wrong-tenant, wrong-purpose, tamper, malformed-envelope,
  unknown-key, rotation, and constant-time verification tests pass.
- Low-entropy retry/input values cannot be verified by an offline database-only
  guessing attack.
- Production startup fails only when App Runs are enabled without valid Run
  keyrings; flag-off deployments retain the existing environment contract.
- Architecture tests prove only the secret repository handles Run ciphertext and
  only the signer handles signing key material.

## Loop 2: Additive Run schema and supported upgrade

### Work

- Add tenant-bound immutable capability provider snapshots with deterministic
  digests and no credentials, targets, effective policy, or raw provider object.
- Add Run metadata, a separate immutable input payload and retention-bound
  encrypted attempt-output storage, attempts, append-only events, and App-native
  receipt tables.
- Add a nullable `agent_actions.app_run_id` foreign key plus a uniqueness rule
  that permits at most one reviewed compatibility action per Run.
- Reuse generic Attention with `source_type = app_run`; do not create an App-only
  attention/inbox table.
- Add database constraints/triggers for tenant-consistent references, immutable
  identity/ciphertext fields, bounded ancestry, legal state transitions, and
  append-only event/receipt behavior.
- Add the exact forward-only upgrade migration and fresh-schema representation.
  Do not backfill legacy actions or rewrite existing ciphertext.

### Exit evidence

- `db:push-full` and `db:upgrade` converge on the same schema, indexes,
  constraints, and triggers on pgvector-backed CI infrastructure.
- Supported existing data upgrades without table rewrites or default-value locks
  on hot legacy tables; the prior image can boot and ignore the additive schema.
- Cross-org references, mutated immutable fields, duplicate approval links,
  illegal transitions, and updates/deletes of append-only records fail.
- Generic Run queries and serializers cannot select or expose ciphertext.

## Loop 3: Run lifecycle, replay, and retention without effects

### Work

- Implement `AppRunService.submit`, safe lookup/inspection, transition, cancel,
  expire, and explicit operator-reconciliation interfaces.
- Canonicalize and validate input before encryption. Enforce minimum required
  fields, strict byte/depth/count limits, retention class, terminal purge time,
  and a bounded safe approval preview.
- Claim idempotency under a transaction-scoped advisory lock. Query HMAC
  fingerprints for all configured read key versions. Never persist the raw key
  or transient lock digest.
- Return the existing Run for same-key/same-input replay with no new event;
  return `APP_RUN_IDEMPOTENCY_CONFLICT` for different input.
- Pin a host-owned idempotency horizon at submission: 7 days for ephemeral,
  30 days for standard, and 90 days for extended Runs. Active rows block
  fingerprint-key retirement; after the horizon callers must use a new key.
  Apps and later permission changes cannot widen this window.
- Add terminal secret purge and sanitized residue. Permission widening cannot
  extend a previously chosen retention class.

### Exit evidence

- Concurrent same-key submissions create one Run; conflict, rotation overlap,
  missing old key, and tenant/actor/provider scope cases fail deterministically.
- State transitions and events commit atomically and illegal transitions have a
  stable structured error.
- Expired secrets are purged while the declared safe residue remains useful and
  contains no raw input or retry key.
- Logs/errors/API serialization/leak snapshots remain clean under injected
  failures.

## Loop 4: Attempt engine and crash recovery

### Work

- Implement a shared claimed-attempt runner usable synchronously and by the
  PostgreSQL worker. Commit the attempt boundary before a provider call and do
  not hold a transaction open across network I/O.
- Start against a counting fake provider and freeze a narrow injected executor
  port after state/recovery tests pass. The real internal provider executor and
  production worker registration remain Loop 6 cutover work.
- Persist a known provider result as bounded encrypted output plus a sanitized
  terminal projection without another call even if event, receipt, metrics, or
  Attention work needs repair.
- Classify expired leases after call start: unsafe/unknown becomes
  `unknown_outcome`; safe may retry; idempotent may retry only with the same
  provider idempotency key. Each retry is a new attempt.
- Make cancellation effective before call start and advisory after an external
  call begins. Never report an external effect as cancelled when its outcome is
  unknown.
- Add bounded stale-attempt reconciliation and idempotent repair for
  engine-owned terminal state/events. Concrete receipt and Attention repair
  remains Loop 7 work, after those projections exist.

### Exit evidence

- Crash injection before claim, after claim, before call, during call, after
  provider return, and during each terminal side effect produces the specified
  state with no ungoverned retry.
- Multi-worker and lease-expiry tests prove one call per attempt and no concurrent
  claim reuse.
- Unsafe attempts never call twice. Safe/idempotent retry tests show explicit
  attempt ancestry and unchanged provider idempotency identity.
- A provider success plus local post-call repair failure stays known success and
  never re-enters the provider.
- Exact result replay is available only to the live-authorized caller during the
  result-retention window. After purge, replay returns terminal identity plus
  `result_expired` and never calls the provider again during the pinned
  idempotency horizon.

## Loop 5: Approval adapter and live authorization

### Work

- Add the `app_run_invoke` approval kind and one linked `agent_actions` adapter
  containing only Run ID, capability/provider labels, resource identifiers, and
  bounded safe preview.
- Make approval creation and Run `pending_approval` transition atomic. Make
  approval resolution claim and resume the Run through App Run service.
- Recheck authenticated membership, initiating/execution actors, employee
  health/budget, token scope, connector activity, assignment, provider snapshot
  and schema, retry class, policy source, and bound authorization versions before
  approval and immediately before attempt.
- Implement the host-owned risk/review vocabulary from the accepted review-policy
  ADR. App/provider metadata can never lower it; Autonomous cannot satisfy
  `always`.
- Keep existing approval API/UI response shapes where possible. The Run remains
  source of truth if the compatibility action and Run disagree.

### Exit evidence

- Approval params, events, receipts, Attention, logs, and API responses contain no
  raw input.
- Approval/rejection/replay races resolve once and cannot create another Run or
  provider attempt.
- Revocation between proposal, approval, and attempt fails before the call.
- `always` review is unbypassable under every current trust level.

## Loop 6: Capability Service integration and legacy compatibility

### Work

- Split the caller-facing governed Capability Service entrance from the narrow
  internal provider attempt executor so App Run execution cannot recurse.
- Route selected `core` and `legacy_connector` invocations through App Runs only
  when the exact fail-closed flag is enabled. Keep current direct behavior when
  disabled.
- Preserve Phase 2 discovery, target/credential materialization, policy/budget
  ordering, exact provider result/error mapping, citations, timeouts, backoff,
  and path-specific legacy receipts during compatibility certification.
- Reserve `origin = app` but reject it until Phase 5 supplies an effective grant
  and exact binding. An installation or manifest cannot fabricate authority.
- Add architecture tests proving callers cannot bypass Capability Service, Run
  attempts cannot bypass the internal executor, and only the MCP adapter calls
  the low-level client.

### Exit evidence

- Flag-off tests are byte/state compatible with Phase 2.
- Flag-on immediate, auto-direct, quick, full, replay, revocation, provider-error,
  timeout, and unknown-outcome fixtures pass with one selected path and no shadow
  call.
- Existing explicit reapproval behavior is either preserved by the compatibility
  adapter or changed only under a separately approved migration decision.
- No App-origin invocation succeeds.

## Loop 7: Ancestry, receipts, Attention, and operator inspection

### Work

- Add root/parent/depth handling, a small fixed maximum depth, synchronous
  capability-cycle rejection, authorization-ceiling inheritance, and budget
  continuity across child Runs.
- Add App-native receipt envelopes over sanitized immutable facts, attempt and
  outcome identity, actor attribution, reconciliation, and signing-key version.
  Do not migrate legacy receipt rows in place.
- Publish idempotent Run Attention events for approval, failure,
  `unknown_outcome`, and repair gaps using the existing Attention service.
- Add safe operator inspection and reconciliation surfaces plus bounded metrics.
  Raw ciphertext and retry keys are never operator-list fields or metric labels.
- Add reconciliation reports for missing terminal events/receipts/Attention.

### Exit evidence

- Cycles stop before a child call, depth is bounded, and child Runs cannot widen
  authorization or reset budgets.
- Receipt verification works across signing-key rotation and detects tampering;
  key retirement is refused while retained receipts depend on it.
- Operator resolution of unknown outcome performs no provider call and appends a
  signed receipt/event.
- Metrics and inspection stay tenant-scoped, bounded, and secret-free.

## Loop 8: Release, rotation, rollback, and self-host gates

### Work

- Document and test key generation, addition, current-key rotation,
  read/verify-only overlap, reference inventory, retirement refusal,
  backup/restore, and disaster recovery for self-hosts.
- Ship readers before changing any existing ciphertext writer. Record the exact
  rollback-floor image that can read new envelopes.
- Keep connector and legacy receipt writes legacy until that floor is proven.
  Do not perform bulk in-place re-encryption during the compatibility window.
- Test old-image tolerance of additive Run tables and new-image operation with
  the flag off, misconfigured, and on.
- Define the future hosted key-provider/KMS operational contract without adding
  it as a Phase 3 runtime dependency.

### Exit evidence

- Fresh install, supported upgrade, backup/restore, rolling deployment, key
  rotation, rollback-floor, and mixed-reader tests pass.
- A missing decrypt/verify key is detected before effect execution and produces
  actionable operator state without leaking material.
- Legacy connector and receipt compatibility remains intact throughout the
  window.
- Self-host docs describe recoverable steps and explicitly warn that deleting a
  referenced key is data loss.

## Loop 9: Seal and certify Phase 3

### Work

- Run the consolidated contract, crypto, schema/upgrade, Run lifecycle,
  concurrency, crash/recovery, provider, approval, trust, budget, connector,
  receipt, Attention, leakage, architecture, API, worker, and repository checks.
- Run one production image, self-host smoke, browser approval/inspection pass,
  security workflows, and supported upgrade/rollback drill because Phase 3
  touches those surfaces.
- Inspect the final diff, generated artifacts, environment documentation,
  migrations, safe projections, and every ciphertext/key reference.
- Decide explicitly whether the feature remains developer-only, becomes self-host
  opt-in, or can widen further. Never switch the default as a cleanup.
- Update the roadmap and compatibility records with verified evidence and every
  deferred release gate.

### Exit evidence

- The acceptance matrix passes on the immutable candidate revision.
- No raw input, retry key, ciphertext, provider secret, full output, or
  signing/fingerprint material appears in any generic/list or observability
  surface; the exact result is confined to its explicitly authorized response.
- Every flag-on governed provider effect has a Run and attempt; every reviewed
  Run has one linked approval adapter; every terminal governed effect has a
  receipt or a visible repair gap. Flag-off legacy execution remains explicitly
  outside that claim.
- Unknown outcomes are inspectable and never auto-retried.
- The flag/default, rollback floor, key versions, unverified requirements, and
  remaining legacy-encryption work are reported explicitly.

## Pull request sequence

1. **PR A — foundation:** Loops 0–2; contracts, key readers, dormant additive
   schema, no execution cutover.
2. **PR B — engine:** Loops 3–4; lifecycle, idempotency, retention, attempts, fake
   providers, and recovery.
3. **PR C0 — engine cutover gate:** additive `.19`, execution-release and budget
   evidence, exact-attempt jobs, lease heartbeat, provider-result taxonomy, and
   horizon-safe replay; the engine remains unwired.
4. **C1–C5 — integration train:** live authorization/budget, safe approval
   adapter, receipts/Attention/operator/ancestry, pinned provider runtime and
   worker, then an explicit guarded cutover. Each slice must be independently
   green and may be its own PR.
5. **D1–D2 — certification:** release/rotation/rollback evidence and the
   explicit opt-in decision.

Do not hold all merge trains for one final merge. Merge each independently green,
then rebase the next train onto its merge commit. This preserves reviewability,
forward-only migration order, and rollback diagnosis.

## Stop conditions

Stop and reopen the architecture gate if implementation would require:

- raw input, retry keys, provider secrets, or ciphertext in an approval row,
  event, receipt, log, metric, Attention item, trace, or API response;
- treating `agent_actions` as the Run source of truth;
- calling old and new external execution paths for comparison;
- automatically retrying an unsafe or unknown effect;
- promising exactly-once behavior from a provider that lacks idempotency;
- changing existing ciphertext writes before the rollback-floor image is proven;
- allowing an App installation or author metadata to create authority;
- adding a mandatory KMS, Redis, workflow engine, or hosted dependency;
- enabling App Runs by default before the immutable certification gate; or
- selecting a migration identifier without re-confirming the current merged
  upgrade manifest at the implementation boundary.
