import type { RuntimeSetupContext, RuntimeSetupTarget } from './app-runtime-setup';
export type SyncClosureCandidate = { run_id: string; operation_name: string; created_at: string; unknown_outcome_at: string | null };
export type HistoricalSyncClosureReview = {
  schema_version: 'deft.app_private_sync_closure_review.v1'; run_id: string; reviewer_user_id: string; owner_user_id: string; operator_user_id: string;
  installation_id: string; resource_binding_id: string; runtime_registration_id: string; app_version_id: string; grant_snapshot_id: string;
  package_digest: string; grant_snapshot_digest: string; lifecycle_epoch: number; grant_epoch: number; runtime_epoch: number; target_key: string;
  consent_expires_at: string | null; consent_lifetime?: string; unknown_outcome_at: string; state: 'unknown_outcome';
  basis: 'operator_closes_unknown_sync'; provider_outcome: 'unknown'; no_retry: true; review_digest: string;
  historical_closure: { operation_name: string; run_created_at: string; current_resource_binding_id: string; current_runtime_registration_id: string;
    current_app_version_id: string; current_grant_snapshot_id: string; current_package_digest: string; current_grant_snapshot_digest: string;
    current_lifecycle_epoch: number; current_grant_epoch: number; current_runtime_epoch: number; current_consent_expires_at: string | null;
    current_consent_lifetime?: string; profile_digest: string; transport_digest: string };
};
export type HistoricalSyncClosureResult = { run_id: string; state: 'failed'; basis: 'operator_closes_unknown_sync';
  provider_outcome: 'unknown'; no_retry: true; review_digest: string; receipt: {
    receipt_id: string; envelope_digest: string; signing_key_version: string; signed_at: string; verified: true } };
export type PendingSyncClosureReceipt = { run_id: string; review_digest: string };
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const uuid = (x: unknown) => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const digest = (x: unknown) => typeof x === 'string' && /^sha256:[a-f0-9]{64}$/.test(x);
const instant = (x: unknown) => typeof x === 'string' && /Z$/.test(x) && Number.isFinite(Date.parse(x));
const integer = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const text = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 128;
const fields = (x: Record<string, unknown>, keys: string[], predicate: (v: unknown) => boolean) => keys.every(k => predicate(x[k]));
const validExpiry = (expiry: unknown, lifetime: unknown) => lifetime === 'until_revoked' ? expiry === null : lifetime === undefined && instant(expiry);
const invalid = () => new Error('Private sync recovery response changed. Reload setup.');
export function readPendingSyncClosureReceipt(storage: Pick<Storage, 'getItem'>, key: string): PendingSyncClosureReceipt | null {
  try { const text = storage.getItem(key); if (!text || text.length > 512) return null;
    const value: unknown = JSON.parse(text);
    return object(value) && Object.keys(value).length === 2 && uuid(value.run_id) && digest(value.review_digest)
      ? value as PendingSyncClosureReceipt : null;
  } catch { return null; }
}
export function parseSyncClosureCandidates(raw: unknown): { current_resource_binding_id: string; target_key: string; resource_key: string; runs: SyncClosureCandidate[] } {
  if (!object(raw) || !uuid(raw.current_resource_binding_id) || !text(raw.target_key) || !text(raw.resource_key)
    || !Array.isArray(raw.runs) || raw.runs.length > 8 || !raw.runs.every(row => object(row) && uuid(row.run_id)
      && text(row.operation_name) && instant(row.created_at) && (row.unknown_outcome_at === null || instant(row.unknown_outcome_at)))) throw invalid();
  return raw as ReturnType<typeof parseSyncClosureCandidates>;
}
export function parseHistoricalSyncClosureReview(raw: unknown, expected: {
  candidate: SyncClosureCandidate; target: RuntimeSetupTarget; context: RuntimeSetupContext; actorId: string;
}): HistoricalSyncClosureReview {
  if (!object(raw) || !object(raw.historical_closure)) throw invalid();
  const c = raw.historical_closure;
  if (raw.schema_version !== 'deft.app_private_sync_closure_review.v1' || raw.state !== 'unknown_outcome'
    || raw.basis !== 'operator_closes_unknown_sync' || raw.provider_outcome !== 'unknown' || raw.no_retry !== true
    || !fields(raw, ['run_id','reviewer_user_id','owner_user_id','operator_user_id','installation_id','resource_binding_id','runtime_registration_id','app_version_id','grant_snapshot_id'], uuid)
    || !fields(raw, ['package_digest','grant_snapshot_digest','review_digest'], digest)
    || !fields(raw, ['lifecycle_epoch','grant_epoch','runtime_epoch'], integer) || !text(raw.target_key) || !instant(raw.unknown_outcome_at)
    || !validExpiry(raw.consent_expires_at,raw.consent_lifetime)
    || !fields(c,['current_resource_binding_id','current_runtime_registration_id','current_app_version_id','current_grant_snapshot_id'],uuid)
    || !fields(c,['current_package_digest','current_grant_snapshot_digest','profile_digest','transport_digest'],digest)
    || !fields(c,['current_lifecycle_epoch','current_grant_epoch','current_runtime_epoch'],integer)
    || !text(c.operation_name) || !instant(c.run_created_at) || !validExpiry(c.current_consent_expires_at,c.current_consent_lifetime)) throw invalid();
  const value = raw as HistoricalSyncClosureReview, current = value.historical_closure, e = expected;
  if (value.run_id !== e.candidate.run_id || value.installation_id !== e.context.installation_id
    || value.reviewer_user_id !== e.actorId || value.operator_user_id !== e.context.operator_user_id
    || ![value.owner_user_id,value.operator_user_id].includes(e.actorId) || value.target_key !== e.target.target_key
    || current.operation_name !== e.candidate.operation_name || current.operation_name !== `sync_${e.target.resource_key}`
    || current.run_created_at !== e.candidate.created_at || value.unknown_outcome_at !== e.candidate.unknown_outcome_at
    || current.current_resource_binding_id !== e.target.resource_binding_id
    || current.current_app_version_id !== e.context.app_version_id || current.current_grant_snapshot_id !== e.context.grant_snapshot_id
    || current.current_package_digest !== e.context.package_digest || current.current_grant_snapshot_digest !== e.context.grant_snapshot_digest
    || current.current_lifecycle_epoch !== e.context.lifecycle_epoch || current.current_grant_epoch !== e.context.grant_epoch) throw invalid();
  return value;
}
export const HistoricalSyncClosureResultSchema = { parse(raw: unknown): HistoricalSyncClosureResult {
  if (!object(raw) || !object(raw.receipt) || !uuid(raw.run_id) || raw.state !== 'failed'
    || raw.basis !== 'operator_closes_unknown_sync' || raw.provider_outcome !== 'unknown' || raw.no_retry !== true || !digest(raw.review_digest)
    || typeof raw.receipt.receipt_id !== 'string' || !/^app-run-receipt:[a-f0-9]{64}$/.test(raw.receipt.receipt_id)
    || !digest(raw.receipt.envelope_digest) || !text(raw.receipt.signing_key_version)
    || !instant(raw.receipt.signed_at) || raw.receipt.verified !== true) throw invalid();
  return raw as HistoricalSyncClosureResult;
} };

/** A receipt check has a fixed read-only route and never falls back to activate. */
export async function lookupHistoricalSyncClosureReceipt(reference: PendingSyncClosureReceipt, currentBindingId: string,
  request: (path: string, init: RequestInit) => Promise<unknown>): Promise<HistoricalSyncClosureResult | null> {
  const raw = await request('/api/apps/blob/sync/unknown-runs/receipt', { method: 'POST', body: JSON.stringify({
    run_id: reference.run_id, current_resource_binding_id: currentBindingId, expected_review_digest: reference.review_digest }) });
  if (!object(raw)) throw invalid();
  if (raw.status === 'unconfirmed') return null;
  if (raw.status !== 'closed') throw invalid();
  const value = HistoricalSyncClosureResultSchema.parse(raw.closure);
  if (value.run_id !== reference.run_id || value.review_digest !== reference.review_digest) throw invalid();
  return value;
}
