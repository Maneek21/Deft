# ADR: Additive Governed App Runs and staged secret rollout

- Status: Accepted; dormant foundation implementation begun after Phase 2 merge
- Date: 2026-08-30
- Depends on: Capability Service squash merge `9ba7b7c8` from PR #270
- Supersedes: the big-bang sequencing implied by the earlier App Protocol v2
  specification where it conflicts

## Context

Phase 2 creates one internal Capability Service seam but deliberately preserves
the two legacy execution lifecycles. The current approval ledger stores raw
parameters in `agent_actions`; action receipts are signed with the same
deployment secret used for encryption; provider credentials use one unversioned
AES-GCM format; and a crash after an external effect begins cannot be represented
uniformly as an unknown outcome.

Phase 3 must add an actor-neutral, durable execution envelope without making
existing Deft, Module, employee, or MCP behavior depend on an unfinished App
grant model. It must remain straightforward to operate in an open-source
self-host and leave a clean key-provider seam for a future hosted service.

## Options considered

### Extend `agent_actions` into the Run ledger

This is the smallest schema change, but it retains an agent-specific source of
truth, raw approval parameters, path-dependent retry semantics, and no adequate
attempt or unknown-outcome model. App callers would inherit legacy constraints
instead of receiving an actor-neutral contract. Rejected.

### Replace legacy execution in one migration

This produces the desired end state sooner on paper, but combines cryptography,
schema, migration, approval, provider-call, receipt, worker, and rollback risk.
An external-effect shadow comparison is unsafe, and a rollback could strand
ciphertext an older image cannot read. Rejected.

### Add a dormant Run subsystem and cut over behind a fail-closed flag

Add new tables and a deep App Run service, preserve `agent_actions` as a linked
approval adapter, and keep current execution active until parity and release
gates pass. Versioned key readers land before existing ciphertext writers
change. This is the selected option.

An external workflow engine or mandatory KMS is not introduced. PostgreSQL and
the existing queue remain the self-host baseline. A future hosted key provider
may implement the same internal key-provider interface.

## Decision

### One source of truth

`AppRunService` owns Run creation, idempotency, state transitions, attempts,
retention, and sanitized projections. A reviewed Run may have exactly one linked
`agent_actions` row of kind `app_run_invoke`; that row is an inbox/UI adapter,
not the execution ledger. Its parameters contain identifiers and a bounded safe
preview only.

The caller-facing Capability Service remains the execution entrance. Governed
requests submit to App Run service. A separate internal attempt executor is the
only Run component allowed to dispatch to a capability provider adapter, which
remains the only place allowed to call the low-level MCP client. Routes,
resolvers, workers, and tests use the same caller-facing Run interface.

No old/new provider shadow call is permitted.

### Additive data boundary

The exact columns are frozen in Loop 0, but the model has these responsibilities:

- append-only, tenant-bound capability provider snapshots;
- `app_runs` for actor, origin, policy, state, ancestry, pinned authorization
  facts, safe preview, retention, and keyed fingerprints;
- a one-to-one immutable secret-input row plus retention-bound encrypted attempt
  output where exact replay requires it, separated from safe Run metadata so
  ordinary Run selections cannot return ciphertext or full provider output;
- attempts with claim/lease and provider-call boundary timestamps;
- append-only sanitized events;
- App-native sanitized receipts with signing-key version; and
- one nullable, indexed `agent_actions.app_run_id` compatibility link.

The Run row carries only a bounded sanitized outcome projection. Exact output may
be returned to the authorized invocation caller and replayed while its encrypted
payload is retained; generic inspection never returns it. After purge, replay
returns the original terminal identity plus an explicit result-expired status and
never calls the provider again.

Existing generic Attention tables are reused with `source_type = app_run`; no
parallel App-only inbox is created. New tables and old-table columns are
additive so the rollback-floor image can ignore them.

Database constraints and triggers enforce tenant-consistent references,
immutable secret/snapshot identity fields, one approval adapter per Run, and
legal state transitions. Only the App Run secret repository may reference the
ciphertext table; an architecture test enforces this boundary.

### State and effect semantics

The Run lifecycle distinguishes pending, pending approval, running, waiting on
an external system, succeeded, failed, cancelled/expired, and unknown outcome.
Illegal transitions fail with a stable structured error. An unknown outcome is
never automatically retried. Explicit operator reconciliation may resolve it to
success or failure without another provider call and must append an event and
receipt.

Every provider call belongs to exactly one claimed attempt. Unsafe or unknown
effects get at most one attempt. Safe or provider-idempotent effects may receive
another attempt only under their host-owned retry classification and, for the
idempotent class, the same provider idempotency key. Phase 3 does not claim
exactly-once delivery to an external system.

A process records and commits the attempt boundary before the provider call. If
the provider result is known in-process, terminal persistence is retried without
calling the provider again. Recovery of an expired lease with a started but
unrecorded unsafe call becomes `unknown_outcome`.

### Idempotency and ancestry

Caller retry keys never appear in rows, logs, events, receipts, or responses.
Versioned HMAC fingerprints are computed under a purpose-specific fingerprint
keyring. A transaction-scoped PostgreSQL advisory lock uses a transient hash of
the replay scope and raw key, then the service queries candidate fingerprints
for every configured read key. Same replay key and same canonical input returns
the original Run; different input fails with
`APP_RUN_IDEMPOTENCY_CONFLICT`.

Fingerprint-key removal is blocked while retained Runs reference that version.
The raw key and transient lock digest are never persisted.

Child Runs store root, parent, and bounded depth. Synchronous capability cycles
are rejected before another effect. Children inherit the effective
authorization ceiling and continue to consume the same actor/employee budgets;
creating a child cannot reset limits.

### Secret and key boundary

Phase 3 adds three purpose-separated, versioned keyrings:

1. authenticated encryption for Run secret payloads;
2. App Run receipt signing; and
3. input/idempotency fingerprints, with domain-separated purposes.

Each envelope records an opaque key version and uses a random nonce plus AAD
binding tenant, Run, payload kind, and envelope schema version. One key is
current for writes; older configured keys are read/verify-only. Missing keys,
wrong AAD, malformed envelopes, or fingerprint mismatch fail closed.

The initial self-host format uses random 32-byte base64 key material,
AES-256-GCM with a 96-bit nonce for envelope v1, and HMAC-SHA-256 for signing and
fingerprints. Algorithm identifiers are versioned so a future format can be
introduced without guessing from ciphertext shape. App-native receipts may bind
to a digest of the randomized ciphertext envelope; they never publish a digest
of low-entropy plaintext input or output.

The initial self-host provider reads bounded keyring configuration from the
environment and has no network dependency. Run execution remains disabled when
its required keyrings are absent. A future SaaS KMS provider can replace this
provider behind the same narrow interface.

Existing `ENCRYPTION_KEY` ciphertext and action-receipt signatures keep their
legacy write format during the first rollout. Readers may gain versioned-envelope
support, but connectors are not re-encrypted in place. Existing writes can move
to the new format only after a released rollback-floor image can read it and
backup/restore plus key-rotation drills pass. Legacy retirement is a release
milestone, not a same-PR cleanup.

### Authority boundary

Execution origin is a closed `core | legacy_connector | app` union. Phase 3 can
exercise `core` and `legacy_connector`. `app` origin fails closed until Phase 5
adds effective App grants and exact provider bindings; an App installation by
itself is not authority.

The effective policy is host-owned. Actor trust cannot bypass
`review_requirement: always`. Membership, employee health and budget, token
scope, connector, assignment, provider snapshot/schema, and every available
authorization version are checked before approval and again immediately before
the attempt.

### Rollout

Phase 3 is delivered as additive merge trains rather than one stacked PR:

1. contracts, key readers, and dormant schema;
2. Run lifecycle, attempts, and recovery using fake providers;
3. approval and legacy compatibility behind `DEFT_APP_RUNS_ENABLED=false`;
4. operations, retention, rotation, and release certification; and
5. an explicit decision to widen opt-in after parity, never an implicit default.

The Phase 2 PR remained unchanged while this plan was prepared. The Phase 3
planning branch is now rebased onto the exact squash merge. The upgrade manifest
ends at `0.3.0-preview.16` on that baseline, so `.17` is the current candidate;
Loop 0 must re-confirm it immediately before the first schema implementation.

## Consequences

- Phase 3 is larger than a local refactor and may span more than one release.
- Old and new execution can coexist in code, but exactly one is selected for an
  invocation; they are never both called.
- The linked legacy approval row remains temporarily necessary for native UI
  compatibility.
- New App Run tables can be rolled back by using an older image because that
  image ignores them, but any change to existing ciphertext writers has a
  separate rollback-floor gate.
- Self-hosts gain explicit key configuration only when enabling App Runs;
  existing deployments continue to boot with the legacy contract while the
  feature is off.

## Acceptance evidence

- Migration tests prove fresh and supported-upgrade schemas, constraints,
  checksums, old-image tolerance, and no ciphertext rewrite.
- Crypto tests prove nonce uniqueness, AAD binding, purpose separation,
  rotation, missing-key denial, low-entropy guessing resistance, and explicit
  safe projections.
- Concurrency and crash-point tests prove replay/conflict behavior, one provider
  call per attempt, unsafe unknown-outcome handling, and no budget reset through
  child Runs.
- Approval tests prove sanitized parameters, source-of-truth ownership, live
  authorization rechecks, and an unbypassable `always` floor.
- Leakage tests cover generic/list API JSON, approval payloads, logs, errors,
  events, receipts, metrics, Attention, and trace output. Separate tests prove
  exact output is available only through the authorized invocation/result path
  during its retention window.
- Flag-off tests preserve every Phase 2 compatibility path; flag-on golden tests
  certify legacy outcomes without external shadow execution.
- Self-host, backup/restore, rotation, rollback-floor, image, browser approval,
  security, and operator-recovery checks pass before opt-in is widened.
