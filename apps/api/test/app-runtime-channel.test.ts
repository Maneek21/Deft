import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { appRuntimeChannelRoutes } from '../src/routes/app-runtime-channel.js';
import { parseAppRuntimeResult } from '../src/lib/app-runtime-contract.js';

test('disabled Runtime transport rejects before parsing a request body', async () => {
  assert.notEqual(process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED, 'true');
  const app = new Hono().route('/runtime', appRuntimeChannelRoutes);
  const response = await app.request('/runtime/claim', {
    method: 'POST', body: '{malformed',
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'APP_RUNTIME_DISABLED');
});

test('Runtime result refuses an oversized retained output before any DB write', () => {
  assert.throws(() => parseAppRuntimeResult({
    schema_version: 'deft.app_runtime_channel.v1',
    session_id: 'session', session_token: 'a'.repeat(32),
    run_id: 'run', attempt_id: 'attempt', claim_token: 'claim', sequence: 1,
    status: 'returned', provider_succeeded: true,
    output: { payload: 'x'.repeat(1_048_576) },
  }));
});
