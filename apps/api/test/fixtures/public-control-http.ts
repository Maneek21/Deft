import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { publicNativeHttpFixture } from './public-native-http.js';
export async function publicControlHttpFixture(ttl = 604800) {
  const f = await publicNativeHttpFixture();
  const cancelBinding = await f.call('/api/apps/native/bindings/stage', {
    schema_version: 'deft.app_native_binding_stage.v1', installation_id: f.staged.id, action_key: 'cancel_booking',
    target: { schema_version: 'deft.app_native_target.v1', provider_kind: 'native', adapter_contract_version: 'deft.native.calendar.v1',
      operation_name: 'calendar.events.cancel.v1', calendar_owner_user_id: f.ownerId },
    expected_app_version_id: f.staged.version_id, expected_package_digest: f.staged.package_digest,
    expected_grant_snapshot_digest: f.grant.snapshot_digest, expected_lifecycle_epoch: f.active.installation.lifecycle_epoch,
    expected_grant_epoch: f.active.installation.grant_epoch,
  });
  const context = await f.call(`/api/apps/native/bindings/${cancelBinding.binding_id}/context`, undefined, 'owner');
  const review = await f.call(`/api/apps/native/bindings/${cancelBinding.binding_id}/review`, context.review_request, 'owner');
  const consent = await f.call(`/api/apps/native/bindings/${cancelBinding.binding_id}/accept`, { ...context.review_request,
    expected_review_digest: review.review_digest, accept_host_policy: true }, 'owner');
  const policy = { schema_version: 'deft.app_public_cancellation_policy.v1', control_ttl_seconds: ttl,
    cancel_native_binding_id: cancelBinding.binding_id, expected_cancel_consent_digest: consent.consent_digest };
  const endpoint = await f.call('/api/apps/public/endpoints/stage', { ...f.stageInput, cancellation_policy: policy,
    budget_policy: { schema_version: 'deft.app_public_budget.v1', max_pending: 1, max_confirmed_per_utc_day: 2 } });
  assert.equal(endpoint.cancellation_scope, 'pre_effect_withdrawal_only'); assert.equal(endpoint.post_effect_cancellation, 'unavailable');
  const activation = await f.call(`/api/apps/public/endpoints/${endpoint.endpoint_id}/activate`, {
    expected_review_digest: endpoint.review_digest, expected_endpoint_epoch: endpoint.endpoint_epoch, accept_host_policy: true });
  const path = `/api/public/apps/${endpoint.slug}/claims`;
  const claim = async (title: string, secret = randomBytes(32).toString('hex')) => {
    const record = await f.createRecord(title);
    const listed = await f.call(`/api/public/apps/${endpoint.slug}/availability`, undefined, 'anonymous');
    const item = listed.result.items.find((row: { resource_ref: { resource_id: string } }) => row.resource_ref.resource_id === record.id);
    assert.ok(item);
    const body = { schema_version: 'deft.app_public_claim.v2', resource_ref: item.resource_ref,
      expected_revision: item.revision, idempotency_key: randomUUID(), control_secret: secret };
    const claimed = await f.call(path, body, 'anonymous');
    return { record, secret, body, result: claimed.result, statusPath: `${path}/${claimed.result.claim_id}/status`,
      cancelPath: `${path}/${claimed.result.claim_id}/cancel` };
  };
  const status = (c: Awaited<ReturnType<typeof claim>>) => f.request(c.statusPath,
    { schema_version: 'deft.app_public_control.v1', control_secret: c.secret }, 'anonymous');
  const cancel = (c: Awaited<ReturnType<typeof claim>>, key = randomUUID()) => f.request(c.cancelPath,
    { schema_version: 'deft.app_public_cancel.v1', control_secret: c.secret, idempotency_key: key }, 'anonymous');
  const { and, eq } = f.orm;
  const retained = async (id: string) => (await f.db.select().from(f.schema.appCanonicalClaims).where(and(
    eq(f.schema.appCanonicalClaims.org_id, f.orgId), eq(f.schema.appCanonicalClaims.id, id))))[0]!;
  const admit = async (id: string) => {
    const c = await retained(id), job = await f.queues.dequeueJob(f.queues.QUEUE_NAMES.AGENT_JOBS, {
      orgId: f.orgId, jobName: 'app-public-ingress', dataMatch: { key: 'ingress_id', value: c.ingress_id } });
    assert.ok(job); await f.workers._processDequeuedJobForTest(f.queues.QUEUE_NAMES.AGENT_JOBS, job);
    return (await f.db.select().from(f.schema.appRuns).where(and(eq(f.schema.appRuns.org_id, f.orgId),
      eq(f.schema.appRuns.origin_public_ingress_id, c.ingress_id))))[0];
  };
  return { ...f, endpoint, activation, policy, claim, status, cancel, retained, admit, path };
}
