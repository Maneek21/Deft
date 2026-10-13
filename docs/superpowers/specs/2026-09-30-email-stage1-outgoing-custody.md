# Production outgoing custody and dispatch

The immediate outcome is one real Gmail Send from a saved draft with a PDF,
followed by exact recipient verification. The full replacement scope remains on
the execution plan. The host must retain precisely what the human authorized;
neither a Worker proposal nor a guessed file identifier may create that authority.

## Decision

Use generic PostgreSQL custody tables for private draft files and immutable
action payloads, plus a payload-file association table. Ciphertext is bounded bytea; small metadata is encrypted under
the existing Run keyring with separate authenticated domains. Keep scalar private
state and scalar Runtime input unchanged.

The existing incoming attachment stage cannot be reused: its authority requires
a Sync checkpoint, attempt and parent projection. Workspace uploads have a
different sharing/ownership boundary. The existing ciphertext object store is a
viable later backend, but its current write acknowledgement lacks an fsync
contract and its2MiB cap is too small for full MIME. It would add object/database
commit coordination, orphan cleanup and backup obligations. PostgreSQL gives the
initial bounded flow one atomic metadata/bytes/draft-CAS commit using existing
operations. Its cost is bounded WAL/TOAST growth and memory; quotas are mandatory.

This is generic App custody, with Email account/MIME/provider behavior retained
in the private deployment module. No Email table or unchecked JSON/base64 scalar
is introduced.

## Reviewed declarations and limits

Optional private-state `files` policy contains `max_file_bytes`,
`max_files_per_record`, `max_total_bytes_per_record` and `allowed_media_types`.
Optional `action_payloads` contains sorted unique `{action_key,max_payload_bytes}`
entries referencing declared Runtime actions. Absent fields remain absent.
Canonical review, effective grants and the strict database trigger must retain
these policies exactly; retained consent cannot silently widen.

Initial Email policy is one PDF up to2097152bytes and one payload up to4194304bytes.
Host ceilings are2097152bytes/file,8files and8388608bytes/draft or payload. File
expiry cannot exceed its draft expiry. Total retained owner/install/state byte
and identifier quotas also apply. Broader recipient/file/rich-text behavior stays
on the full launch plan.

## File interface and transaction

The native authenticated path is
`/api/app-experiences/sessions/:sessionId/state/:stateKey/:draftId/files`.
GET lists committed ready files. POST accepts a bounded raw body, declared media
type and validated `expected_revision`, `upload_operation_id` UUID and `filename`
query values. DELETE `.../:fileId` accepts `{expected_revision}`.

Responses use `{schema_version:'deft.private_files.v1',draft:{record_id,revision},
files:[{file_id,upload_operation_id,filename,media_type,byte_length,digest,expires_at}]}`; file digests
are bare lowercase SHA256. No provider URL, storage path or credential is exposed.
Queries and bodies must not be logged as diagnostic content.

There is no durable upload stage in this first implementation. The browser shows
pending/failed selection locally; only a verified, encrypted, committed file is
listed by the server. Bound raw reads by time, byte count and concurrency before
entering the authority transaction. Aborted/invalid uploads publish nothing.

Use the existing owner/state advisory lock before phased authority locks, then
the exact draft and sorted file rows. Atomically validate the reviewed policy,
exact scope/artifact/declaration/CAS, store ciphertext and reseal the unchanged
scalar draft at revision+1. Removal has the same CAS boundary. Scope every row to
org, owner, installation, target, state and draft. Upload operation identity gives
exact same-content response-loss recovery; changed content/scope, retired files
or conflicting later revisions cannot overwrite or resurrect state.

The native composer serializes scalar saving and file mutations through one
revision lane. It flushes edits before upload/removal, adopts the acknowledged
revision, preserves conflicts and blocks Send until all selected files are ready.
Reload shows committed files; an uncommitted local selection is not advertised
as recovered.

## Immutable payload and Run release

The payload reference is `{snapshot_id:UUID,digest:lowercase64hex}`. Only a trusted
host module builder can create a payload from the current verified account,
exact saved draft, scalar action input and finalized file bytes. Browser/Worker
bytes or module paths cannot nominate an authoritative payload. A bounded module
display projection supplies trusted From/context; browser draft fields cannot
assert verified identity.

Preparation retains immutable metadata/bytes under the current owner/target,
action binding/contract, draft revision, file identities and all deadlines.
Equivalent preparation reuses retained content rather than multiplying storage.
Once the saved draft advances, older-revision unconfirmed payload bodies in that
exact owner/install/target/state/draft may be retired before quota admission.
Confirmation uses the same owner/state lock and always validates current draft
CAS; the retirement query excludes every payload referenced by human Run
authorization. Keep identity/digest, file links and original expiry as tombstones.
Never retire a confirmed payload early because its source draft changed.
The sealed ticket binds the retained reference and full draft digest. Confirmation
requires its expected snapshot digest, rechecks current draft/files/authority and
persists the paired pointer in the same Run authorization/release transaction.
Idempotent replay must compare the existing pointer; it cannot replace it.

Legacy scalar actions stay compatible. Payload-backed Runtime Start requires an
explicit `action_payload_version:'deft.app_action_payload.v1'` handshake before
provider_call_started, so an old worker cannot silently omit a PDF. Claim remains
metadata-only. Payload metadata/bytes/file reads use the existing authenticated
Runtime channel and exact started attempt/session/claim/sequence/lease. Derive
scope/reference from retained Run authorization; reject caller substitutions.
Check current owner/target/consent and conservative deadlines before/after I/O and
after commit, before releasing any plaintext. MIME is never rebuilt at dispatch.

Email keeps distinct durable snapshot reservation and provider outcome states
under one `mail-${run_id}` identity. Lost acceptance acknowledgement is unknown
until reconciled and never permits blind resend. Recipient receipt and provider
acceptance/Sent evidence remain distinct.

## Migration, cleanup and verification

Preview59 is additive: generic file/payload custody and paired nullable scoped
payload pointers on human Run authorization, plus strict reviewed-policy guards.
Fresh schema and supported upgrade paths must agree. Disabling admission preserves
legacy scalar behavior and retained payload/outcome evidence; do not drop rows to
roll back. Ciphertext participates in retained-key references. Expired payloads
become body-free identity tombstones while referenced by a Run. Coordinate file
cleanup with private-state purge; no live referenced payload may be deleted.

Acceptance uses real HTTP/PostgreSQL upload→CAS→prepare→confirm→authenticated
Start/payload→executor→receipt, plus owner/target/content substitution, conflict,
response-loss, expiry/revocation/abort and cleanup/key-retention checks. Verify
fresh/upgrade parity and inspect the actual composer on desktop/mobile. Fixtures
alone do not prove deployment or live Gmail delivery.

## Reviewed closure of an unknown private Sync obligation

The existing Email upgrade is blocked by an older private inbox Sync Run whose
provider outcome remains unknown. Keeping the drain block cannot finish the
upgrade; general external-write reconciliation would widen authority beyond this
task. The chosen interface closes only this host-local private Sync obligation.
It requires a real web SID and the exact current private owner or reviewed
operator. Legacy registrations additionally require an owner/admin caller;
member-owned registrations retain their explicit current admission checks.

Review and activation at `/api/apps/blob/sync/unknown-runs/{review,activate}`
pin the actor, org, Run, unknown attempt, immutable intent, current checkpoint,
current installation/version/grant, consent and epochs. Activation requires the
exact review digest and explicit acceptance. Lock order remains Run, sorted
members, App, registration/binding, attempt, checkpoint, then SID. Current
checkpoint advancement does not establish any prior provider effect.

The local Run becomes failed with `APP_RUN_UNKNOWN_OUTCOME`, while its original
unknown timestamp, unknown attempt and receipts remain intact. A signed
reconciliation receipt states `operator_closes_unknown_sync`, provider outcome
unknown and no retry. No provider call, result payload, retry, forged system
actor, SQL repair, schema change or drain exception is introduced. A lost
activation response may recover the signed closure under current authority even
after a later checkpoint observation; it cannot create a second receipt.

Acceptance requires real authenticated HTTP/DB review and activation, preserved
verified original evidence, one signed closure receipt, denied wrong owner/org,
changed review/authority and non-Sync actions, and upgrade drain success after
closure. Rollback removes the new entry points without rewriting the ledger.

Restoring the actual pre58 registration reproduced a discovery mismatch: adding
PDF changed the generated request media enum from seven to eight values and its
maximum count from seven to eight, changing derived schema/snapshot digests. The
closure-only authority entrance may reconstruct exactly that pre58 canonical
variant for legacy null-admission registrations. It compares all regenerated
digests and the complete retained discovery snapshot; self-consistency alone is
insufficient. Current execution, attachment custody and Send retain their strict
authority entrance. After this compatibility check, the restored historical Run
authorization snapshot matched all eight current authority references unchanged.
