type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Row => record(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f<>]/.test(value);
const instant = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const states = ['released_before_effect', 'withdrawal_requested', 'cancellation_unavailable', 'cancel_run_pending', 'cancelled', 'cancel_failed', 'unknown_outcome'] as const;
const runStates = ['pending', 'pending_approval', 'running', 'waiting_external', 'succeeded', 'failed', 'cancelled', 'expired', 'unknown_outcome'];
const invalid = (): never => { throw new Error('Cancellation response is unavailable or changed.'); };
export type CancellationState = typeof states[number];
export type CancellationItem = { id: string; state: CancellationState; accepted_at: string; original_version: string;
  cancel_run_id: string | null; cancel_run_state: string | null };
export type CancellationChoice = { native_binding_id: string; action_label: string; consent_digest: string;
  current_app_version_id: string; historical_create_authorized: boolean };
export type CancellationContext = { schema_version: 'deft.app_public_cancellation_owner_context.v1'; cancellation_id: string;
  installation_id: string; state: CancellationState; original_version: string; choices: CancellationChoice[]; cancel_run_id: string | null };
export type CancellationRequest = { schema_version: 'deft.app_public_cancellation_owner_review_request.v1'; native_binding_id: string; expected_consent_digest: string };
export type CancellationReview = { cancellation_id: string; request: CancellationRequest; native_binding_id: string;
  current_app_version_id: string; input: { create_run_id: string; event_ref: { resource_id: string } };
  review_digest: string; review_token: string; expires_at: string; historical_create_policy: unknown; original_create_pin: unknown };

export function parseCancellationList(value: unknown, installationId: string): { items: CancellationItem[]; next: string | null } {
  if (!exact(value, ['schema_version', 'installation_id', 'items', 'next_after_cancellation_id'])
    || value.schema_version !== 'deft.app_public_cancellation_owner_list.v1' || value.installation_id !== installationId
    || !Array.isArray(value.items) || value.items.length > 20
    || !(value.next_after_cancellation_id === null || uuid(value.next_after_cancellation_id))) return invalid();
  for (const item of value.items) if (!exact(item, ['id', 'state', 'accepted_at', 'original_version', 'cancel_run_id', 'cancel_run_state'])
    || !uuid(item.id) || !states.includes(item.state as CancellationState) || !instant(item.accepted_at) || !label(item.original_version)
    || !(item.cancel_run_id === null || uuid(item.cancel_run_id)) || !(item.cancel_run_state === null || runStates.includes(String(item.cancel_run_state)))
    || (item.cancel_run_id === null) !== (item.cancel_run_state === null)) return invalid();
  if (new Set(value.items.map(item => (item as Row).id)).size !== value.items.length
    || (value.next_after_cancellation_id !== null && value.next_after_cancellation_id !== (value.items.at(-1) as Row | undefined)?.id)) return invalid();
  return { items: value.items as CancellationItem[], next: value.next_after_cancellation_id as string | null };
}
export function parseCancellationContext(value: unknown, installationId: string, cancellationId: string): CancellationContext {
  if (!exact(value, ['schema_version', 'cancellation_id', 'installation_id', 'state', 'original_version', 'choices', 'cancel_run_id'])
    || value.schema_version !== 'deft.app_public_cancellation_owner_context.v1' || value.installation_id !== installationId
    || value.cancellation_id !== cancellationId || !states.includes(value.state as CancellationState) || !label(value.original_version)
    || !(value.cancel_run_id === null || uuid(value.cancel_run_id)) || !Array.isArray(value.choices) || value.choices.length > 8) return invalid();
  for (const choice of value.choices) if (!exact(choice, ['native_binding_id', 'action_label', 'consent_digest', 'current_app_version_id', 'historical_create_authorized'])
    || !uuid(choice.native_binding_id) || !uuid(choice.current_app_version_id) || !digest(choice.consent_digest)
    || !label(choice.action_label) || typeof choice.historical_create_authorized !== 'boolean') return invalid();
  if (new Set(value.choices.map(item => (item as Row).native_binding_id)).size !== value.choices.length) return invalid();
  return value as CancellationContext;
}
function pin(value: unknown) {
  return exact(value, ['app_version_id', 'package_digest', 'grant_snapshot_id', 'grant_snapshot_digest'])
    && uuid(value.app_version_id) && digest(value.package_digest) && uuid(value.grant_snapshot_id) && digest(value.grant_snapshot_digest);
}
export function parseCancellationReview(value: unknown, cancellationId: string, choice: CancellationChoice): CancellationReview {
  const receivedAt = Date.now();
  if (!exact(value, ['schema_version', 'cancellation_id', 'request', 'original_create_pin', 'current_app_version_id', 'native_binding_id',
    'historical_create_policy', 'input', 'review_digest', 'review_token', 'expires_at', 'host_policy'])
    || value.schema_version !== 'deft.app_public_cancellation_owner_review.v1' || value.cancellation_id !== cancellationId
    || value.native_binding_id !== choice.native_binding_id || value.current_app_version_id !== choice.current_app_version_id
    || !pin(value.original_create_pin) || !digest(value.review_digest) || typeof value.review_token !== 'string'
    || value.review_token.length < 1 || value.review_token.length > 8192 || !instant(value.expires_at)
    || Date.parse(value.expires_at) <= receivedAt
    || !exact(value.request, ['schema_version', 'native_binding_id', 'expected_consent_digest'])
    || value.request.schema_version !== 'deft.app_public_cancellation_owner_review_request.v1'
    || value.request.native_binding_id !== choice.native_binding_id || value.request.expected_consent_digest !== choice.consent_digest
    || !exact(value.host_policy, ['normal_owner_approval_required', 'old_grant_execution', 'automatic_rebinding'])
    || value.host_policy.normal_owner_approval_required !== true || value.host_policy.old_grant_execution !== false || value.host_policy.automatic_rebinding !== false
    || !exact(value.input, ['create_run_id', 'event_ref']) || !uuid(value.input.create_run_id)
    || !exact(value.input.event_ref, ['schema_version', 'provider', 'resource_type', 'resource_id'])
    || value.input.event_ref.schema_version !== 'deft.resource_ref.v2' || value.input.event_ref.resource_type !== 'calendar_event'
    || !exact(value.input.event_ref.provider, ['kind', 'provider_instance_id']) || value.input.event_ref.provider.kind !== 'core'
    || value.input.event_ref.provider.provider_instance_id !== 'calendar_events' || !uuid(value.input.event_ref.resource_id)) return invalid();
  if (value.historical_create_policy !== null && (!exact(value.historical_create_policy, ['schema_version', 'creates'])
    || value.historical_create_policy.schema_version !== 'deft.app_native_historical_create_policy.v1' || !Array.isArray(value.historical_create_policy.creates)
    || value.historical_create_policy.creates.length < 1 || value.historical_create_policy.creates.length > 16
    || value.historical_create_policy.creates.some(item => !pin(item)))) return invalid();
  // Server UTC expiry and the client's clock need not be identical. Limit
  // transient display to both the server expiry and five local minutes; the
  // unchanged signed token is still enforced by the host at submission.
  return { ...(value as unknown as CancellationReview),
    expires_at: new Date(Math.min(Date.parse(value.expires_at), receivedAt + 300000)).toISOString() };
}
