import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerConnectionContext, ownerResourceRequest, ownerActionRequest, ownerConnectionReview } from './app-owner-connection.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const installationId = id(1), ownerId = id(2), orgId = id(3), now = Date.now();
const ref = { admission_id: id(4), admission_digest: 'sha256:' + 'a'.repeat(64) };
const limits = { max_records_per_page: 10, max_page_bytes: 65536, max_retained_records: 1000, max_retained_bytes: 1048576, min_interval_seconds: 300 };
const attachment_policy = { allowed_media_types: ['application/pdf'], max_attachment_bytes: 2097152, max_attachments_per_record: 1,
  max_attachments_per_run: 1, max_attachment_bytes_per_run: 2097152, retention_days: 7 };
const resource_request = { ...ref, target_key: 'personal', consent_expires_at: new Date(now + 3600000).toISOString(), limits, attachment_policy };
const policy = { key: 'personal_mail', resource_key: 'inbox', action_keys: ['send_message'], max_consent_seconds: 86400 };
const admission = { ...ref, operator_user_id: id(5), operator_label: 'Workspace mail operator', resource_request };
const binding = { binding_id: id(6), target_key: 'personal', state: 'active', consent_expires_at: resource_request.consent_expires_at, actions: [] };
const context = { schema_version: 'deft.owner_connection_context.v1', installation_id: installationId,
  policies: [{ policy, status: 'admitted', admission, bindings: [binding] }] };
const baseReview = { org_id: orgId, installation_id: installationId, app_version_id: id(7), grant_snapshot_id: id(8),
  package_digest: 'sha256:' + 'b'.repeat(64), grant_snapshot_digest: 'sha256:' + 'c'.repeat(64), operator_user_id: id(5),
  target_key: 'personal', owner_connection_admission: ref, review_digest: 'sha256:' + 'd'.repeat(64) };

test('owner setup context is bounded and refuses owner/operator nomination or ambiguous admission', () => {
  const parsed = ownerConnectionContext(context, installationId);
  assert.equal(parsed[0]!.admission!.operator_label, admission.operator_label);
  for (const changed of [ { ...context, installation_id: id(99) }, { ...context, owner_user_id: ownerId },
    { ...context, policies: [{ ...context.policies[0], admission: null }] },
    { ...context, policies: [{ ...context.policies[0], admission: { ...admission, resource_request: { ...resource_request, operator_user_id: id(99) } } }] },
    { ...context, policies: [{ ...context.policies[0], admission: { ...admission, resource_request: { ...resource_request, admission_digest: 'sha256:' + 'f'.repeat(64) } } }] },
    { ...context, policies: [{ ...context.policies[0], admission: { ...admission, resource_request: { ...resource_request,
      attachment_policy: { ...attachment_policy, allowed_media_types: ['text/html'] } } } }] } ]) assert.throws(() => ownerConnectionContext(changed, installationId));
});

test('owner setup context accepts legacy and profile-backed policies but rejects incomplete or malformed profile bindings', () => {
  const parsePolicy = (candidate: Record<string, unknown>) => ownerConnectionContext({ ...context,
    policies: [{ ...context.policies[0], policy: candidate }] }, installationId)[0]!.policy;
  assert.deepEqual(parsePolicy(policy), policy);
  assert.deepEqual(parsePolicy({ ...policy, provider_profile_key: 'google_mail', runtime_requirement_key: 'sync_provider' }), policy);
  for (const candidate of [
    { ...policy, provider_profile_key: 'google_mail' },
    { ...policy, runtime_requirement_key: 'sync_provider' },
    { ...policy, provider_profile_key: 'Google Mail', runtime_requirement_key: 'sync_provider' },
    { ...policy, provider_profile_key: 'google_mail', runtime_requirement_key: '__proto__' },
    { ...policy, provider_profile_key: 'google_mail', runtime_requirement_key: 'sync_provider', operator_user_id: id(99) },
  ]) assert.throws(() => parsePolicy(candidate));
});

test('member requests use only admitted resource/action references and refuse expired or unrelated bindings', () => {
  const selected = ownerConnectionContext(context, installationId)[0]!;
  const request = ownerResourceRequest(selected, now); assert.deepEqual(request, resource_request);
  request.limits.max_page_bytes = 1; assert.equal(selected.admission!.resource_request.limits.max_page_bytes, limits.max_page_bytes);
  const action = ownerActionRequest(selected, selected.bindings[0]!, 'send_message', now);
  assert.deepEqual(action, { ...ref, owner_resource_binding_id: id(6), action_key: 'send_message' });
  assert.equal('owner_user_id' in action, false); assert.equal('operator_user_id' in action, false);
  assert.throws(() => ownerResourceRequest(selected, now + 3600001));
  assert.throws(() => ownerActionRequest(selected, { ...selected.bindings[0]!, binding_id: id(99) }, 'send_message', now));
  assert.throws(() => ownerActionRequest(selected, selected.bindings[0]!, 'undeclared_action', now));
  assert.throws(() => ownerActionRequest(selected, selected.bindings[0]!, 'send_message', now + 3600001));
});

test('resource review must match exact member, admitted request and host private custody policy', () => {
  const selected = ownerConnectionContext(context, installationId)[0]!, request = ownerResourceRequest(selected, now);
  const review = { ...baseReview, schema_version: 'deft.app_attachment_consent_review.v1', owner_user_id: ownerId,
    resource_key: 'inbox', consent_expires_at: request.consent_expires_at, limits, attachment_policy,
    host_policy: { retry_class: 'unsafe_or_unknown', retention_class: 'standard', risk_class: 'internal_write', review_requirement: 'policy',
      review_scope: 'reviewed_resource_sync', encrypted_custody: true, owner_only_binary: true, provider_url_fetch: false, irrecoverable_host_purge: true } };
  const input = { installationId, ownerId, orgId, policy: selected, kind: 'resources' as const, request };
  assert.deepEqual(ownerConnectionReview({ review }, input), { digest: review.review_digest });
  for (const changed of [{ ...review, owner_user_id: id(99) }, { ...review, operator_user_id: id(99) }, { ...review, target_key: 'another' },
    { ...review, limits: { ...limits, max_retained_records: 2000 } }, { ...review, host_policy: { ...review.host_policy, provider_url_fetch: true } }])
    assert.throws(() => ownerConnectionReview({ review: changed }, input));
});

test('action review remains bound to the admitted own account and per invocation confirmation', () => {
  const selected = ownerConnectionContext(context, installationId)[0]!, request = ownerActionRequest(selected, selected.bindings[0]!, 'send_message', now);
  const review = { ...baseReview, schema_version: 'deft.app_runtime_management_review.v1', action_key: 'send_message', owner_resource_binding_id: id(6),
    contract_digest: 'sha256:' + 'e'.repeat(64), host_policy: { retry_class: 'unsafe_or_unknown', retention_class: 'standard', risk_class: 'external_write',
      review_requirement: 'always', review_scope: 'per_invocation' } };
  const input = { installationId, ownerId, orgId, policy: selected, kind: 'actions' as const, request };
  assert.deepEqual(ownerConnectionReview({ review }, input), { digest: review.review_digest });
  for (const changed of [{ ...review, owner_resource_binding_id: id(99) }, { ...review, action_key: 'other' },
    { ...review, host_policy: { ...review.host_policy, review_requirement: 'never' } }]) assert.throws(() => ownerConnectionReview({ review: changed }, input));
});
