import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import type { AppRunKeyProvider } from '../src/lib/app-run-keyrings.js';
import type { HumanActionAuthorityPort } from '../src/lib/app-experience-human-action-service.js';
import type { AppRunTransaction } from '../src/lib/app-run-repository.js';
Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
  DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true',
  DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true',
  DEFT_APP_OWNER_CONNECTIONS_ENABLED: 'true' });
const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update('synthetic-record-action-'+id).digest('base64') } });
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
  run_encryption: ring('enc'), receipt_signing: ring('sign'), fingerprint: ring('fingerprint') });
test('Trusted record action routes disable before parsing and authenticate before private review', async () => {
  const { appDataActionRoutes: routes } = await import('../src/routes/app-data-actions.js');
  const paths = ['/experiences/11111111-1111-4111-8111-111111111111/targets/sender/actions/send_message/prepare',
    '/experiences/11111111-1111-4111-8111-111111111111/targets/sender/actions/confirm',
    '/experiences/11111111-1111-4111-8111-111111111111/targets/sender/resource-actions/organize_messages/prepare',
    '/experiences/11111111-1111-4111-8111-111111111111/targets/sender/resource-actions/confirm'];
  for (const flag of ['DEFT_APPS_ENABLED', 'DEFT_APP_OWNER_CONNECTIONS_ENABLED']) {
    process.env[flag] = 'false';
    try { for (const path of paths) {
      const response = await routes.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
      assert.equal(response.status, 503); assert.equal((await response.json()).code, 'APP_FEATURE_DISABLED');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    } } finally { process.env[flag] = 'true'; }
  }
  for (const path of paths) {
    const response = await routes.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(response.status, 401); assert.equal((await response.json()).code, 'APP_ACCESS_DENIED');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
});

const keys: AppRunKeyProvider = {
  current: () => ({ key_id: 'test', key: Buffer.alloc(32, 7) }),
  read: () => ({ key_id: 'test', key: Buffer.alloc(32, 7) }),
  keyIds: () => ['test'],
};

test('generic human status uses ordinary capacity and only explicit review purposes reserve slots', async () => {
  const { AppExperienceExposureService } = await import('../src/lib/app-experience-exposure.js');
  const previous = process.env.DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED;
  process.env.DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED = 'true';
  const stopped = new Error('synthetic repository boundary');
  const purposes: unknown[] = [];
  const service = new AppExperienceExposureService(keys, {
    transaction: async (_run, _signal, _deadline, _observe, purpose) => { purposes.push(purpose); throw stopped; },
  });
  const caller = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID(), access_expires_at: Date.now() + 60_000 };
  try {
    for (const purpose of [undefined, 'human_action_preparation', 'human_action_confirmation'] as const) {
      await assert.rejects(service.withHumanAction(caller, randomUUID(), 'write', async () => {
        assert.fail('authority callback must not run before acquisition');
      }, undefined, undefined, undefined, purpose), error => error === stopped);
    }
    assert.deepEqual(purposes, [undefined, 'human_action_preparation', 'human_action_confirmation']);
  } finally {
    if (previous === undefined) delete process.env.DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED;
    else process.env.DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED = previous;
  }
});

test('batch status reuses its human transaction for the nested fresh target guard', async () => {
  const { AppDataResourceBatchService } = await import('../src/lib/app-data-resource-batch-service.js');
  const caller = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID() };
  const batch = {
    id: randomUUID(), owner_user_id: caller.user_id, release_mode: 'prepared_resource_sequential',
    experience_session_id: randomUUID(), connection_session_id: randomUUID(), resource_store_key: 'records',
    account_ref: 'synthetic-account', action_key: 'write', runtime_binding_id: randomUUID(),
    consent_grant_id: randomUUID(), consent_epoch: 1,
  };
  const current = { connection: { account_ref: batch.account_ref } };
  const transaction = { execute: async () => ({ rows: [batch] }) } as unknown as AppRunTransaction;
  const stop = new Error('synthetic nested authority boundary');
  let calls = 0;
  const authority: HumanActionAuthorityPort = {
    async withHumanAction(_caller, _session, _action, use, _signal, _draft, supplied) {
      calls++;
      if (calls === 2) {
        assert.equal(supplied, transaction, 'nested target guard must not acquire its own bounded pool slot');
        throw stop;
      }
      assert.equal(supplied, undefined);
      return use(transaction, {
        runtime_binding_id: batch.runtime_binding_id,
        session: { resource_target_key: 'primary' },
        authorization_identity: { consent_grant_id: batch.consent_grant_id, consent_epoch: batch.consent_epoch },
      } as any, async () => {});
    },
  };
  const service = new AppDataResourceBatchService({ caller, current: async () => current } as any,
    {} as any, authority, keys, { repository: { transaction: async (use: (tx: AppRunTransaction) => unknown) => use(transaction) } } as any);
  await assert.rejects(service.statusOwnedBatch(batch.id), error => error === stop);
  assert.equal(calls, 2);
});
