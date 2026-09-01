# Governed App Run operations

Governed App Runs are a disabled-by-default self-host opt-in with three controls.
Exact `DEFT_APP_RUNS_ENABLED=true` enables key access, runtime composition, and
draining of accepted work. Exact
`DEFT_APP_RUN_APP_ORIGIN_ENABLED=true` separately admits reviewed connected-App
actions, and exact
`DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=true` separately admits supported
legacy MCP capability calls to that engine. Every other intake value preserves
the legacy or disabled entrance. Either intake on with the engine off is invalid
and API startup rejects it. App-origin intake additionally requires
`DEFT_APPS_ENABLED=true`; the flag never creates grants or bindings.

| Run engine | App intake | Legacy MCP intake | Operational state |
|---|---|---|---|
| Off | Off | Off | Default legacy execution; no Run keys required; durable Run jobs defer |
| On | Off | Off | Decrypt, resume, and drain accepted Runs; no new governed intake |
| On | On | Off | Exact reviewed App bindings may submit governed Runs |
| On | Off | On | Default-off governed legacy MCP canary |
| On | On | On | Both intake planes use the same governed engine |
| Off | On | Any | Invalid startup configuration |
| Off | Any | On | Invalid startup configuration |

This feature has two independent operational assets: the additive PostgreSQL
Run ledger and `DEFT_APP_RUN_KEYRINGS`. Back them up, restore them, and rotate
them together. Losing a referenced key is data loss even when the database is
intact.

## Generate the first keyring

Generate three independent random 32-byte keys on a trusted operator machine:

```bash
node -e "const c=require('node:crypto');const k=()=>c.randomBytes(32).toString('base64');console.log(JSON.stringify({schema_version:'deft.app_run_keyring.v1',run_encryption:{current:'enc-v1',keys:{'enc-v1':k()}},receipt_signing:{current:'sig-v1',keys:{'sig-v1':k()}},fingerprint:{current:'fp-v1',keys:{'fp-v1':k()}}}))"
```

Store the single-line result as the secret `DEFT_APP_RUN_KEYRINGS`; do not put
it in source control, logs, tickets, or a database row. Set
`DEFT_APP_RUNS_ENABLED=true` only after the supported upgrades through
`0.3.0-preview.25` are applied. Leave both intake flags false while validating
startup and draining behavior. Enable App-origin intake only with Apps enabled
and exact reviewed bindings; enable legacy MCP intake only for a certified
canary. A process restart is required after any Run environment value changes.

Startup rejects malformed documents, reused key material, missing current key
IDs, non-32-byte keys, and a keyring that omits any version still referenced by
an active fingerprint, retained encrypted payload, or App Run receipt. This
check completes before a governed provider effect can start.

## Rotate without losing reads

Rotate one purpose at a time:

1. Back up PostgreSQL and the current keyring secret as one recovery point.
2. Generate a new independent 32-byte key and a new portable ID such as
   `enc-v2`, `sig-v2`, or `fp-v2`.
3. Add the new entry to that purpose's `keys` object and make only its ID
   `current`. Keep every old entry unchanged.
4. Restart one candidate process. It must pass the referenced-key startup
   inventory before receiving traffic.
5. Complete the normal health and governed-call smoke checks, then roll the
   same document to the remaining processes.

New writes use the current key. Old entries are read/verify-only, so rotation
does not rewrite old ciphertext or signatures. Mixed processes are safe only
while the document contains both old and new keys.

Do not retire an encryption key until its encrypted payloads have expired and
the retention purge has completed. Do not retire a fingerprint key until every
Run in its fixed idempotency horizon has expired. Receipt signing references
are retained for as long as their receipts; Phase 3 has no destructive receipt
retirement workflow, so a referenced signing key must remain configured.

To test a proposed retirement, remove only the candidate entry in a non-serving
process with a restored production backup. Startup must succeed. A missing
reference fails with `APP_RUN_KEY_VERSION_UNAVAILABLE`; restore the entry and do
not enable traffic. Never discover retirement safety by deleting the only copy.

## Backup, restore, and disaster recovery

Use the normal database backup flow in [Self-hosting](./self-hosting.md#backups),
and export the exact keyring secret into the same encrypted backup set. Record
which key IDs were current. Keep at least one offline recovery copy under the
same access controls as the deployment secrets.

For a restore:

1. Restore PostgreSQL and uploads using the normal self-host procedure.
2. Restore the keyring document from the matching recovery point before
   enabling App Runs.
3. Boot with `DEFT_APP_RUNS_ENABLED=false` first and complete database and
   application health checks.
4. Set the restored keyring and engine flag with both intake flags still off,
   restart, and require the referenced-key inventory to pass.
5. Inspect pending, running, and `unknown_outcome` Runs before accepting new
   provider work. Never blindly retry an unknown outcome. Enable each intake
   only after that inspection and its release canary gate passes.

If the database survives but a referenced key does not, keep App Runs disabled.
Encryption-key loss prevents retained input/result recovery; signing-key loss
prevents receipt verification; fingerprint-key loss prevents safe replay
matching. None can be reconstructed from database contents.

## Inspect bounded App operations

An authenticated workspace owner or admin can read `GET /api/apps/operations`.
The endpoint rechecks current organization membership and returns the
`deft.app_operations.v1` projection: bounded Run and attempt counts, queue
health, approval and cleanup pressure, connected-App health, retention and
payload ceilings, and whether every referenced key version is configured.

This is a read-only health surface, not a repair API. It omits provider and
actor identities, grant snapshots, raw input and result payloads, ciphertext,
receipt signatures, key IDs, and key material. A member, a demoted manager, an
agent, or a request while the Run engine is disabled cannot use it. Resolve the
reported degraded reason through the existing App lifecycle or recovery
runbook; do not infer permission to replay an unknown provider outcome.

## Disable and rollback

The normal entrance rollback is to set the affected intake flag false while
keeping `DEFT_APP_RUNS_ENABLED=true`. For connected Apps, set
`DEFT_APP_RUN_APP_ORIGIN_ENABLED=false`; for legacy MCP, set
`DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=false`. Already accepted Runs,
attempts, and approvals retain their governed identity and may drain. There is
no shadow call or legacy fallback for accepted governed work.

Set the engine false only after both intake flags are false. Engine-off defers durable
`app-run-attempt` jobs without calling a provider or spending queue retry
allowance; pending App Run approvals remain governed. Re-enable the same
keyring and engine to resume them. Engine-off/intake-on is rejected rather than
silently falling through.

Local C5 and closeout commit hashes are review checkpoints, not an operational
rollback floor. The floor is the first immutable released image whose release
record explicitly contains this split-control and job-pause contract. Until
that artifact and its supported predecessor are recorded, do not treat the
legacy MCP canary as production-supported. To move below the recorded floor:

1. On the current floor, set both `DEFT_APP_RUN_APP_ORIGIN_ENABLED=false` and
   `DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=false`, but leave the engine and
   keyring available; quiesce traffic that could create more governed work.
2. Resolve or cancel pending approvals and let known work settle. Reconcile
   `unknown_outcome` without another provider call.
3. Confirm there are no nonterminal Runs, pending App Run approvals, or active
   App Run jobs:

   ```sql
   SELECT state, count(*) FROM app_runs
    WHERE state NOT IN ('succeeded','failed','cancelled','expired','unknown_outcome')
    GROUP BY state;
   SELECT count(*) FROM agent_actions
    WHERE action = 'app_run_invoke' AND approval_status = 'pending';
   SELECT status, count(*) FROM job_queue
    WHERE name = 'app-run-attempt' AND status IN ('pending','running')
    GROUP BY status;
   ```

4. Set the engine false, restart on the current floor, verify that both intake
   paths remain closed and App Run jobs defer safely, and only then deploy the
   supported older image. Preserve the additive tables and keyring backup; do
   not down-migrate or delete them.

If any query is nonzero, remain on the Phase 3 floor. An in-flight process loss
after a provider call may correctly produce `unknown_outcome`; that is an
operator reconciliation case, not permission to retry.

## Hosted-service boundary

A future SaaS deployment may replace the environment provider with a KMS-backed
implementation of the same purpose-separated key-provider interface. It must
retain opaque versions, tenant/Run/purpose binding, current-plus-read-only
rotation, pre-effect reference inventory, auditable access, backup/restore, and
regional disaster-recovery behavior. No KMS or hosted dependency is required
for self-hosted Phase 3.
