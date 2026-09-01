# App Platform Track A — bounded automation foundation

| Field | Decision |
| --- | --- |
| Status | Frozen for Track A PR A (Loops A.0–A.2) |
| Starting point | Phase 6 certificate on `master` at `7a71fbfb6037e9516847df333fa70f45fda5da95` |
| Public wire addition | App Protocol v2, additive over frozen v0/v1 |
| Production behavior in PR A | Disabled by default; no scanner, queue dispatch, or unattended Run |
| First proof | One daily action over one exact Campaign and one exact Contact |

This document resolves the decisions that the
[Track A plan](../plans/2026-09-01-app-platform-phase-6-and-track-a-loops.md)
requires before implementation. Current code, migrations, and tests remain the
source of truth where this document is silent.

## Boundary

PR A adds a dormant declaration, review, persistence, and host-only execution
seam. It does not add a scheduler, event outbox, arbitrary cron, expressions,
scripts, conditions, branching, waits, compensation, dynamic provider choice,
fan-out, unresolved user input, or a public automation execution endpoint.

The first definition pins exactly one placement resource and one selected
relation resource. The proof fixture uses a Module v2 Campaign and Contact, but
all core contracts use generic ResourceRefs and action bindings.

## Protocol v2 request

Protocol v2 is Protocol v1 plus one strict `automation_requests` collection.
Each request contains only:

- a bounded unique request key and display label;
- `trigger.kind: daily_local_time`;
- one exact existing `action_key`.

The referenced action must have no `user_input` source. Its resource,
capability, connector, and input-binding declarations remain the Protocol v1
contracts. A request cannot name a provider, connector instance, resource
record, schedule time, timezone, budget, policy, approver, or validity window.
Those are host-owned definition choices.

Protocol v2 uses explicit manifest/package/version dispatch. v0 and v1
canonical JSON, digests, rejection issue shapes, package locks, requested
authority reports, and frozen private-interface bytes do not change. A v2
requested-authority report may describe the automation request, but still says
`requested_only`, `executable: false`, and `provider_access: false`.

Staging a v2 package is `stage_only` and grants no authority. The host may list
and inspect the request before any definition exists.

## Code-owned policy

The Phase 5 sandbox email interface and action binding remain byte-for-byte
unchanged, including `review_scope: per_invocation` and
`automation_eligibility: forbidden`.

Automation uses a separate code-owned policy contract with version `1`. It:

- references the exact existing App action binding and provider interface;
- permits only `review_scope: approved_automation_definition`;
- applies only to a fully pinned, owner/admin-approved definition;
- allows one external action per fire;
- cannot be selected, authored, weakened, or replaced by an App or schedule.

The old binding is necessary action lineage but is never sufficient automation
authority. Effective unattended authority requires both the unchanged binding
and this exact code-owned policy.

## Host-created definition

Review creates an immutable definition instance. It pins:

- organization, App installation, exact App version and Protocol v2 request;
- effective grant snapshot and exact action binding;
- provider snapshot, connector identity, and connector authorization version;
- one Campaign ResourceRef plus exact revision and content digest;
- one Contact ResourceRef plus exact revision and content digest;
- canonical schedule, timezone, misfire policy, budgets, and validity window;
- policy version/digest and the complete authorization vector;
- approving user, approval time, and definition epoch.

The approving user must be an active owner or admin at approval and at every
future claim and dispatch. Any schedule, input, resource revision/content,
provider, connector, grant, binding, budget, validity, or policy change creates
a new definition and requires fresh approval.

The only mutable definition operations are pause, resume, revoke, expire, and
their timestamps. Every such transition increments the epoch. A stale epoch can
never claim or dispatch a fire.

Definitions require a finite validity window no longer than 30 days from
approval. Renewal creates a new approved definition.

## Schedule semantics

The only schedule is daily wall-clock time:

- `local_time` is zero-padded `HH:mm`, minute precision, `00:00` through `23:59`;
- `timezone` is a host-canonicalized IANA zone accepted by the installed ICU
  database; aliases that do not resolve to the stored canonical zone are
  rejected;
- the logical occurrence is the tuple of local date, local time, and timezone;
- a DST gap produces one terminal skipped occurrence with reason `dst_gap` and
  no provider call;
- a DST fold fires once at the earlier matching UTC instant; the later matching
  instant is never a second occurrence;
- a missed occurrence may catch up once only when claimed within 15 minutes of
  its resolved UTC instant; otherwise it becomes terminal `misfire_skipped`;
- resume schedules the first occurrence strictly after the resume instant and
  never catches up work missed while paused.

The unique fire identity is the SHA-256 of canonical organization ID,
definition ID, epoch, logical local date/time, and canonical timezone. The
database also enforces the equivalent unique tuple. Retries retain the same fire
identity and App Run idempotency scope.

## Retry, outcome, and dead letter

A fire may make at most three safe orchestration/claim attempts. Creating the
App Run is idempotent. Once a Run exists, AppRunService exclusively owns
provider retry, result, receipt, and unknown-outcome behavior.

The scheduler may rediscover the same Run; it may not create a second Run or
retry an external effect whose dispatch outcome is ambiguous. Exhausted safe
orchestration attempts become `dead_letter`. A later operator retry may reuse
the same fire only when the existing App Run policy proves another dispatch is
safe.

## Budgets and recursion

The first slice enforces all of these ceilings:

- one selected Contact and one externally meaningful action per fire;
- one active fire per definition;
- one logical fire per definition per local calendar day;
- at most 100 automation Run creations per organization per UTC day;
- at most 25 pending or claimed fires per organization.

App-authored values cannot raise those ceilings. Lower host-approved limits may
be stored on a definition.

Automation is a closed non-admin principal. An automation-origin Run cannot
create, approve, mutate, or trigger an automation definition or fire, and it
cannot enter the automation execution seam recursively. This first slice has no
event producer, so there is no event loop or outbox.

## Live authorization and kill order

Eligibility is recomputed immediately before claim and immediately before
provider dispatch. Checks fail closed in this order:

1. global `DEFT_APP_AUTOMATIONS_ENABLED` is exact lowercase `true`;
2. definition state, epoch, validity, and budget remain eligible;
3. approving owner/admin membership remains active;
4. App installation/version remains active and exact;
5. effective grant and action binding remain exact and active;
6. connector authorization and provider snapshot remain healthy and exact;
7. both ResourceRefs remain readable at the pinned revisions and digests;
8. the exact code-owned policy and authorization vector still match.

Any failure prevents a new Run. App disable/upgrade, grant revocation, connector
disable, resource change, membership change, pause/revoke, or the global flag
therefore acts as a live kill switch.

## Persistence and rollback

PR A adds organization-scoped `app_automation_definitions` and
`app_automation_fires`, plus only the additive existing-table columns and
constraints required for Protocol v2 acceptance and strong Run/fire lineage.
Composite tenant foreign keys, bounded JSON/text, immutable history triggers,
unique fire constraints, and fresh/upgrade parity are mandatory.

The production flag defaults false and requires Apps, App Runs, and App-origin
Runs. Focused tests may inject the enabled gate to prove the internal execution
seam; production receives no scanner or unattended dispatch in PR A.

Rollback is flag-off. v0/v1 behavior and bytes remain unchanged, and dormant v2
definitions/fires cannot execute without the later PR B scheduler cutover.
