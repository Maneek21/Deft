import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
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
