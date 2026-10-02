export type NativeReviewOperation = 'calendar.events.create.v1' | 'calendar.events.cancel.v1';
export type NativeAppReview = Readonly<{
  schema_version: 'deft.app_native_run_review.v1'; run_id: string; operation_name: NativeReviewOperation;
  owner_user_id: string; action_label: string; native_binding_id: string; consent_digest: string;
  host_policy: Readonly<Record<string, string | boolean>>;
  input: Readonly<Record<string, unknown>>;
}>;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => [...required, ...optional].includes(k));
const text = (v: unknown, max: number, nonempty = false): v is string => typeof v === 'string' && v.length <= max && (!nonempty || v.length > 0);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const instant = (v: unknown): v is string => typeof v === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));

/** Only the closed owner-only native review may unlock the approval button. */
export function parseNativeAppReview(value: unknown, runId: string, bindingId: string,
  operation: NativeReviewOperation, ownerId: string): NativeAppReview | null {
  if (!record(value) || !exact(value, ['schema_version', 'run_id', 'operation_name', 'owner_user_id',
    'action_label', 'native_binding_id', 'consent_digest', 'host_policy', 'input'])
    || value.schema_version !== 'deft.app_native_run_review.v1' || value.run_id !== runId
    || value.native_binding_id !== bindingId || value.owner_user_id !== ownerId || value.operation_name !== operation
    || !uuid(value.run_id) || !uuid(value.native_binding_id) || !uuid(value.owner_user_id)
    || !text(value.action_label, 200, true) || !/^[^\u0000-\u001f\u007f<>]+$/.test(value.action_label)
    || typeof value.consent_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.consent_digest)
    || !record(value.host_policy) || !exact(value.host_policy, ['risk_class', 'review_requirement', 'review_scope',
      'retry_class', 'retention_class', 'automation_allowed'])
    || value.host_policy.risk_class !== 'internal_write' || value.host_policy.review_requirement !== 'always'
    || value.host_policy.review_scope !== 'per_invocation' || value.host_policy.retry_class !== 'idempotent_with_key'
    || value.host_policy.retention_class !== 'standard' || value.host_policy.automation_allowed !== false
    || !record(value.input)) return null;
  const input = value.input;
  if (operation === 'calendar.events.create.v1') {
    if (!exact(input, ['title', 'start', 'end'], ['description', 'location', 'attendees'])
      || !text(input.title, 200, true) || !instant(input.start) || !instant(input.end)
      || Date.parse(input.end) <= Date.parse(input.start)
      || (Object.hasOwn(input, 'description') && !text(input.description, 4096))
      || (Object.hasOwn(input, 'location') && !text(input.location, 512))) return null;
    if (Object.hasOwn(input, 'attendees') && (!Array.isArray(input.attendees) || input.attendees.length > 20
      || input.attendees.some(item => !record(item) || !exact(item, ['email'], ['displayName'])
        || !text(item.email, 320, true) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email)
        || (Object.hasOwn(item, 'displayName') && !text(item.displayName, 120))))) return null;
  } else {
    if (!exact(input, ['create_run_id', 'event_ref']) || !uuid(input.create_run_id) || !record(input.event_ref)) return null;
    const ref = input.event_ref;
    if (!exact(ref, ['schema_version', 'provider', 'resource_type', 'resource_id'])
      || ref.schema_version !== 'deft.resource_ref.v2' || ref.resource_type !== 'calendar_event'
      || !record(ref.provider) || !exact(ref.provider, ['kind', 'provider_instance_id'])
      || ref.provider.kind !== 'core' || ref.provider.provider_instance_id !== 'calendar_events'
      || !text(ref.resource_id, 256, true) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(ref.resource_id)) return null;
  }
  try { if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 8192) return null; } catch { return null; }
  return value as NativeAppReview;
}
