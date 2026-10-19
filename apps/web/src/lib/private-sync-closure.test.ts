import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseHistoricalSyncClosureReview, HistoricalSyncClosureResultSchema, readPendingSyncClosureReceipt, lookupHistoricalSyncClosureReceipt } from './private-sync-closure';
import type { RuntimeSetupContext } from './app-runtime-setup';

test('ordinary historical sync review keeps original and current pins distinct', () => {
  const digest = 'sha256:' + 'a'.repeat(64), actorId = randomUUID(), oldBinding = randomUUID(), oldVersion = randomUUID();
  const target = { resource_binding_id: randomUUID(), target_key: 'fresh_mailbox', resource_key: 'inbox' };
  const candidate = { run_id: randomUUID(), operation_name: 'sync_inbox', created_at: '2026-10-18T08:14:35.884Z', unknown_outcome_at: '2026-10-18T08:16:27.243Z' };
  const context: RuntimeSetupContext = { schema_version: 'deft.app_runtime_setup_context.v1', installation_id: randomUUID(),
    app_version_id: randomUUID(), grant_snapshot_id: randomUUID(), package_digest: digest, grant_snapshot_digest: digest,
    lifecycle_epoch: 10, grant_epoch: 10, operator_user_id: actorId, target,
    policy: { review_requirement: 'always', review_scope: 'per_invocation', retry_class: 'unsafe_or_unknown' }, actions: [] };
  const raw = { schema_version: 'deft.app_private_sync_closure_review.v1', run_id: candidate.run_id, reviewer_user_id: actorId,
    owner_user_id: actorId, operator_user_id: actorId, installation_id: context.installation_id, resource_binding_id: oldBinding,
    runtime_registration_id: randomUUID(), app_version_id: oldVersion, grant_snapshot_id: randomUUID(), package_digest: digest,
    grant_snapshot_digest: digest, lifecycle_epoch: 9, grant_epoch: 9, runtime_epoch: 1, target_key: target.target_key,
    consent_expires_at: null, consent_lifetime: 'until_revoked', unknown_outcome_at: candidate.unknown_outcome_at,
    state: 'unknown_outcome', basis: 'operator_closes_unknown_sync', provider_outcome: 'unknown', no_retry: true, review_digest: digest,
    historical_closure: { operation_name: candidate.operation_name, run_created_at: candidate.created_at,
      current_resource_binding_id: target.resource_binding_id, current_runtime_registration_id: randomUUID(),
      current_app_version_id: context.app_version_id, current_grant_snapshot_id: context.grant_snapshot_id,
      current_package_digest: digest, current_grant_snapshot_digest: digest, current_lifecycle_epoch: 10, current_grant_epoch: 10,
      current_runtime_epoch: 1, current_consent_expires_at: '2026-11-18T03:40:14.593Z', profile_digest: digest, transport_digest: digest } };
  const parsed = parseHistoricalSyncClosureReview(raw, { candidate, context, target, actorId });
  assert.equal(parsed.app_version_id, oldVersion); assert.equal(parsed.lifecycle_epoch, 9);
  assert.equal(parsed.historical_closure.current_app_version_id, context.app_version_id);
  assert.equal(parsed.historical_closure.current_lifecycle_epoch, 10);
  assert.equal(parsed.provider_outcome, 'unknown'); assert.equal(parsed.no_retry, true);
});

test('ordinary signed closure receipt displays unknown outcome and an actual verified receipt', () => {
  const digest = 'sha256:' + 'b'.repeat(64);
  const receipt = HistoricalSyncClosureResultSchema.parse({ run_id: randomUUID(), state: 'failed',
    basis: 'operator_closes_unknown_sync', provider_outcome: 'unknown', no_retry: true, review_digest: digest,
    receipt: { receipt_id: 'app-run-receipt:' + 'c'.repeat(64), envelope_digest: digest, signing_key_version: 'retained-signing-key',
      signed_at: '2026-10-19T07:00:00.000Z', verified: true } });
  assert.equal(receipt.receipt.verified, true); assert.equal(receipt.provider_outcome, 'unknown');
});

test('ordinary pending receipt reference survives remount and Check sends only a read-only lookup', async () => {
  const value = { run_id: randomUUID(), review_digest: 'sha256:' + 'd'.repeat(64) };
  const storage = new Map<string,string>([['same-session-and-target', JSON.stringify(value)]]);
  assert.deepEqual(readPendingSyncClosureReceipt({ getItem: key => storage.get(key) ?? null }, 'same-session-and-target'), value);
  assert.equal(readPendingSyncClosureReceipt({ getItem: key => storage.get(key) ?? null }, 'new-session-or-target'), null);
  const calls: { path: string; body: unknown }[] = [], binding = randomUUID();
  const result = await lookupHistoricalSyncClosureReceipt(value, binding, async (path, init) => {
    calls.push({ path, body: JSON.parse(init.body as string) }); return { status: 'unconfirmed' };
  });
  assert.equal(result, null);
  assert.deepEqual(calls, [{ path: '/api/apps/blob/sync/unknown-runs/receipt', body: {
    run_id: value.run_id, current_resource_binding_id: binding, expected_review_digest: value.review_digest } }]);
});
