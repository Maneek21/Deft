type RecordMetadata = { record_id: string; revision: number; byte_length: number; created_at: string; expires_at: string };
export type GroupValue = { source_artifact_digest: string; source_app_version_id: string; source_version: string; count: number; records: RecordMetadata[] };
const fail = (): never => { throw new Error('Invalid private state recovery metadata'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) fail(); }
function integer(value: unknown, min: number, max: number) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return fail(); return value; }
function string(value: unknown, pattern: RegExp, max = 128) { if (typeof value !== 'string' || value.length > max || !pattern.test(value)) return fail(); return value; }
const uuid = (value: unknown) => string(value, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, 36);
const digest = (value: unknown) => string(value, /^sha256:[a-f0-9]{64}$/, 71);
const date = (value: unknown) => { const result = string(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 24); if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) fail(); return result; };
const groupKeys = ['source_artifact_digest', 'source_app_version_id', 'source_version', 'count', 'records'];
function group(value: unknown): GroupValue {
  const item = object(value); exact(item, groupKeys);
  if (!Array.isArray(item.records) || item.records.length > 32) return fail();
  const records = item.records.map(raw => { const record = object(raw); exact(record, ['record_id','revision','byte_length','created_at','expires_at']);
    const created_at = date(record.created_at), expires_at = date(record.expires_at);
    if (Date.parse(expires_at) <= Date.parse(created_at)) fail();
    return { record_id: uuid(record.record_id), revision: integer(record.revision,1,2147483647), byte_length: integer(record.byte_length,0,16384), created_at, expires_at }; });
  const count = integer(item.count,1,32); if (count !== records.length || new Set(records.map(record => record.record_id)).size !== count) fail();
  return { source_artifact_digest: digest(item.source_artifact_digest), source_app_version_id: uuid(item.source_app_version_id),
    source_version: string(item.source_version,/^.{1,128}$/),count,records };
}
export const PrivateStateAdoptionContext = { parse(value: unknown) { const context = object(value); exact(context,['schema_version','groups']);
  if (context.schema_version !== 'deft.private_state.adoption_context.v1' || !Array.isArray(context.groups) || context.groups.length > 32) return fail();
  return { schema_version: 'deft.private_state.adoption_context.v1' as const, groups: context.groups.map(group) }; } };
export function reviewOutput(value: unknown) {
  const output = object(object(value).output);
  const ids = ['organization_id','owner_user_id','web_session_id','experience_session_id','installation_id','app_version_id','grant_snapshot_id','exposure_id'];
  const digests = ['exposure_review_digest','target_artifact_digest','declaration_digest'];
  const epochs = ['exposure_epoch','lifecycle_epoch','grant_epoch'];
  exact(output,[...groupKeys,...ids,...digests,...epochs,'schema_version','state_key','expires_at','review_token']);
  if (output.schema_version !== 'deft.private_state.adoption_review.v1') fail();
  ids.forEach(key => uuid(output[key])); digests.forEach(key => digest(output[key])); epochs.forEach(key => integer(output[key],0,2147483647));
  string(output.state_key,/^[a-z][a-z0-9_]{0,47}$/,48); date(output.expires_at);
  if (Date.parse(output.expires_at as string) <= Date.now()) fail();
  const selected: Record<string,unknown> = {}; groupKeys.forEach(key => { selected[key] = output[key]; });
  return { ...group(selected), review_token: string(output.review_token,/^[A-Za-z0-9_-]+$/,24000) };
}
export function parseAdoptionActivation(value: unknown) {
  const output = object(object(value).output); exact(output,['schema_version','adopted_count']);
  if (output.schema_version !== 'deft.private_state.adoption_activated.v1') fail();
  return { adopted_count: integer(output.adopted_count,1,32) };
}
