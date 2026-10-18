import {appConsentDeadline,appConsentExpiryValid,type AppConsentLifetime} from '../../../../packages/app-kit/src/consent-lifetime';
export type OwnerLimits = { max_records_per_page: number; max_page_bytes: number; max_retained_records: number;
  max_retained_bytes: number; min_interval_seconds: number };
export type OwnerAttachments = { allowed_media_types: string[]; max_attachment_bytes: number; max_attachments_per_record: number;
  max_attachments_per_run: number; max_attachment_bytes_per_run: number; retention_days: number };
type AdmissionRef = { admission_id: string; admission_digest: string };
export type OwnerResourceRequest = AdmissionRef & { target_key: string; consent_expires_at: string|null;consent_lifetime?:AppConsentLifetime; limits: OwnerLimits; attachment_policy: OwnerAttachments };
export type OwnerBinding = { binding_id: string; target_key: string; state: 'active' | 'disabled'; consent_expires_at: string | null;consent_lifetime?:AppConsentLifetime;
  actions: { action_key: string; binding_id: string; state: 'active' | 'disabled' }[] };
export type OwnerPolicy = { policy: { key: string; resource_key: string; action_keys: string[]; max_consent_seconds: number;allow_until_revoked?:true };
  status: 'admitted' | 'deployment_review_required'; admission: null | (AdmissionRef & { operator_user_id: string; operator_label: string;
    resource_request: OwnerResourceRequest }); bindings: OwnerBinding[] };
const fail = (): never => { throw Error('Personal account setup changed. Reload before continuing.'); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const keys = (row: Record<string, unknown>, fields: string,optional='') => { if(fields.split(',').some(key=>!Object.hasOwn(row,key))||Object.keys(row).some(key=>![...fields.split(','),...optional.split(',')].includes(key)))fail(); };
const id = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : fail();
const digest = (value: unknown): string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value : fail();
const key = (value: unknown): string => typeof value === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(value)
  && !['constructor', 'prototype', '__proto__'].includes(value) ? value : fail();
const integer = (value: unknown, min: number, max: number): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail();
const array = (value: unknown, max: number): unknown[] => Array.isArray(value) && value.length <= max ? value : fail();
const date = (value: unknown): string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : fail();
function consent(row:Record<string,unknown>,legacyNull=false):{consent_expires_at:string|null;consent_lifetime?:AppConsentLifetime}{const expires_at=row.consent_expires_at===null?null:date(row.consent_expires_at),mode=row.consent_lifetime;if(mode!==undefined&&mode!=='until_revoked'||!appConsentExpiryValid(expires_at,mode)&&!(legacyNull&&expires_at===null&&mode===undefined))fail();return {consent_expires_at:expires_at,...(mode==='until_revoked'?{consent_lifetime:mode}:{})};}
const reference = (value: unknown): AdmissionRef => { const row = object(value); return { admission_id: id(row.admission_id), admission_digest: digest(row.admission_digest) }; };
const equal = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => equal(value, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = Object.keys(a).sort(), right = Object.keys(b).sort();
    return equal(left, right) && left.every(name => equal((a as Record<string, unknown>)[name], (b as Record<string, unknown>)[name]));
  }
  return a === b;
};
function limits(value: unknown): OwnerLimits {
  const row = object(value); keys(row, 'max_records_per_page,max_page_bytes,max_retained_records,max_retained_bytes,min_interval_seconds');
  return { max_records_per_page: integer(row.max_records_per_page, 1, 100), max_page_bytes: integer(row.max_page_bytes, 1, 524288),
    max_retained_records: integer(row.max_retained_records, 1, 100000), max_retained_bytes: integer(row.max_retained_bytes, 1, 1073741824),
    min_interval_seconds: integer(row.min_interval_seconds, 60, 86400) };
}
function attachments(value: unknown): OwnerAttachments {
  const row = object(value); keys(row, 'allowed_media_types,max_attachment_bytes,max_attachments_per_record,max_attachments_per_run,max_attachment_bytes_per_run,retention_days');
  const allowed = array(row.allowed_media_types, 8).map(type => typeof type === 'string'
    && ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv', 'application/json'].includes(type) ? type : fail());
  if (!allowed.length || new Set(allowed).size !== allowed.length) fail();
  return { allowed_media_types: allowed, max_attachment_bytes: integer(row.max_attachment_bytes, 1, 2097152),
    max_attachments_per_record: integer(row.max_attachments_per_record, 1, 8), max_attachments_per_run: integer(row.max_attachments_per_run, 1, 32),
    max_attachment_bytes_per_run: integer(row.max_attachment_bytes_per_run, 1, 8388608), retention_days: integer(row.retention_days, 1, 30) };
}
export function ownerConnectionContext(value: unknown, installationId: string): OwnerPolicy[] {
  const row = object(value); keys(row, 'schema_version,installation_id,policies');
  if (row.schema_version !== 'deft.owner_connection_context.v1' || row.installation_id !== installationId) fail();
  const policies = array(row.policies, 16).map(value => {
    const entry = object(value); keys(entry, 'policy,status,admission,bindings'); const policy = object(entry.policy);
    keys(policy, 'key,resource_key,action_keys,max_consent_seconds','allow_until_revoked,provider_profile_key,runtime_requirement_key');
    if(policy.allow_until_revoked!==undefined&&policy.allow_until_revoked!==true)fail();
    const profileKey=policy.provider_profile_key,runtimeRequirementKey=policy.runtime_requirement_key;
    if((profileKey===undefined)!==(runtimeRequirementKey===undefined))fail();
    if(profileKey!==undefined){key(profileKey);key(runtimeRequirementKey);}
    const actions = array(policy.action_keys, 16).map(key); if (actions.some((action, i) => i > 0 && action <= actions[i - 1]!)) fail();
    const selected = { key: key(policy.key), resource_key: key(policy.resource_key), action_keys: actions, max_consent_seconds: integer(policy.max_consent_seconds, 1, 90 * 86400),...(policy.allow_until_revoked===true?{allow_until_revoked:true as const}:{}) };
    if (entry.status !== 'admitted' && entry.status !== 'deployment_review_required') fail();
    let admission: OwnerPolicy['admission'] = null;
    if (entry.admission !== null) {
      const admitted = object(entry.admission); keys(admitted, 'admission_id,admission_digest,operator_user_id,operator_label,resource_request');
      const request = object(admitted.resource_request); keys(request, 'admission_id,admission_digest,target_key,consent_expires_at,limits,attachment_policy','consent_lifetime');
      const label = typeof admitted.operator_label === 'string' ? admitted.operator_label : fail();
      const ref = reference(admitted); if (!equal(ref, reference(request))
        || !label.trim() || label.length > 120 || /[\r\n\0]/.test(label)) fail();
      admission = { ...ref, operator_user_id: id(admitted.operator_user_id), operator_label: label,
        resource_request: { ...ref, target_key: key(request.target_key), ...consent(request),
          limits: limits(request.limits), attachment_policy: attachments(request.attachment_policy) } };
    }
    if ((entry.status === 'admitted') !== !!admission) fail();
    const bindings = array(entry.bindings, 16).map(value => {
      const binding = object(value); keys(binding, 'binding_id,target_key,state,consent_expires_at,actions','consent_lifetime');
      if (binding.state !== 'active' && binding.state !== 'disabled') fail();
      const actions = array(binding.actions, 16).map(value => {
        const action = object(value); keys(action, 'action_key,binding_id,state');
        if (action.state !== 'active' && action.state !== 'disabled' || !selected.action_keys.includes(key(action.action_key))) fail();
        return { action_key: key(action.action_key), binding_id: id(action.binding_id), state: action.state as 'active' | 'disabled' };
      });
      if (new Set(actions.map(action => action.action_key)).size !== actions.length) fail();
      return { binding_id: id(binding.binding_id), target_key: key(binding.target_key), state: binding.state as 'active' | 'disabled',
        ...consent(binding,true), actions };
    });
    if (new Set(bindings.map(binding => binding.binding_id)).size !== bindings.length) fail();
    return { policy: selected, status: entry.status, admission, bindings } as OwnerPolicy;
  });
  if (policies.some((policy, i) => i > 0 && policy.policy.key <= policies[i - 1]!.policy.key)) fail();
  return policies;
}
export function ownerResourceRequest(policy: OwnerPolicy, now = Date.now(), targetKey?: string): OwnerResourceRequest {
  const request = policy.admission?.resource_request; if (!request || appConsentDeadline(request.consent_expires_at,request.consent_lifetime) <= now) return fail();
  if (targetKey !== undefined) key(targetKey);
  return { ...structuredClone(request), ...(targetKey === undefined ? {} : { target_key: targetKey }) };
}
export function ownerRetainedTargets(value: unknown): string[] {
  const row = object(value); keys(row, 'targets');
  const targets = array(row.targets, 32).map(value => { const target = object(value); keys(target, 'key'); return key(target.key); });
  if (new Set(targets).size !== targets.length) return fail();
  return targets;
}
export function ownerActionRequest(policy: OwnerPolicy, binding: OwnerBinding, actionKey: string, now = Date.now()) {
  if (!policy.admission || !policy.bindings.some(item => item.binding_id === binding.binding_id) || binding.state !== 'active'
    || !appConsentExpiryValid(binding.consent_expires_at,binding.consent_lifetime) || appConsentDeadline(binding.consent_expires_at,binding.consent_lifetime) <= now || !policy.policy.action_keys.includes(actionKey)) return fail();
  return { admission_id: policy.admission.admission_id, admission_digest: policy.admission.admission_digest,
    owner_resource_binding_id: binding.binding_id, action_key: actionKey };
}
export function ownerConnectionReview(value: unknown, input: { installationId: string; ownerId: string; orgId: string; policy: OwnerPolicy;
  kind: 'resources' | 'actions'; request: OwnerResourceRequest | ReturnType<typeof ownerActionRequest> }) {
  const envelope = object(value); keys(envelope, 'review'); const review = object(envelope.review), request = input.request;
  if (review.installation_id !== input.installationId || review.org_id !== input.orgId || review.operator_user_id !== input.policy.admission?.operator_user_id
    || !equal(review.owner_connection_admission, reference(request)) || review.target_key !== ('target_key' in request ? request.target_key
      : input.policy.bindings.find(binding => binding.binding_id === request.owner_resource_binding_id)?.target_key)) fail();
  const host = object(review.host_policy);
  if (host.retry_class !== 'unsafe_or_unknown' || host.retention_class !== 'standard') fail();
  if (input.kind === 'resources' && 'target_key' in request) {
    if (review.schema_version !== 'deft.app_attachment_consent_review.v1' || review.owner_user_id !== input.ownerId
      || review.resource_key !== input.policy.policy.resource_key || review.consent_expires_at !== request.consent_expires_at||review.consent_lifetime!==request.consent_lifetime
      || !equal(review.limits, request.limits) || !equal(review.attachment_policy, request.attachment_policy)
      || host.risk_class !== 'internal_write' || host.review_requirement !== 'policy' || host.review_scope !== 'reviewed_resource_sync'
      || host.encrypted_custody !== true || host.owner_only_binary !== true || host.provider_url_fetch !== false || host.irrecoverable_host_purge !== true) fail();
  } else if (input.kind === 'actions' && 'action_key' in request) {
    if (review.schema_version !== 'deft.app_runtime_management_review.v1' || review.action_key !== request.action_key
      || review.owner_resource_binding_id !== request.owner_resource_binding_id || host.risk_class !== 'external_write'
      || host.review_requirement !== 'always' || host.review_scope !== 'per_invocation') fail();
    digest(review.contract_digest);
  } else fail();
  for (const field of ['app_version_id', 'grant_snapshot_id']) id(review[field]);
  for (const field of ['package_digest', 'grant_snapshot_digest']) digest(review[field]);
  return { digest: digest(review.review_digest) };
}
