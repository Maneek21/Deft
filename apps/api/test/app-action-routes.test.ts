import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import { appActionService } from '../src/lib/app-action-service.js';
import { closeDb } from '../src/lib/db.js';
import { AppRunError } from '../src/lib/app-run-errors.js';
import { appActionRoutes } from '../src/routes/app-actions.js';
import { appRunRoutes } from '../src/routes/app-runs.js';

after(async () => closeDb());

const ORG_ID = 'app-action-route-org';
const USER_ID = 'app-action-route-user';
const RESOURCE_REF = {
  schema_version: 'deft.resource_ref.v1',
  provider: { kind: 'module', provider_instance_id: 'campaign-module' },
  resource_type: 'campaigns',
  resource_id: 'campaign-1',
} as const;
const INPUT_CANDIDATE = {
  schema_version: 'deft.app_run_prepared_input.v1',
  candidate_id: 'candidate-1',
  expires_at: '2099-01-01T00:00:00.000Z',
  sealed_payload: {
    schema_version: 'deft.secret.v1',
    algorithm: 'aes-256-gcm',
    key_version: 'test-v1',
    nonce_b64: Buffer.alloc(12).toString('base64'),
    ciphertext_b64: '',
    auth_tag_b64: Buffer.alloc(16).toString('base64'),
  },
  safe_envelope: {
    schema_version: 'deft.secret.v1',
    algorithm: 'aes-256-gcm',
    key_version: 'test-v1',
    ciphertext_bytes: 0,
  },
} as const;

function testApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', {
      id: USER_ID,
      email: 'app-action-route@test.local',
      org_id: ORG_ID,
      role: 'member',
    });
    await next();
  });
  app.route('/api/app-actions', appActionRoutes);
  app.route('/api/app-runs', appRunRoutes);
  return app;
}

test('JWT App action routes are strict human:ui adapters over AppActionService', async (t) => {
  const service = appActionService as any;
  const original = {
    list: service.list,
    resolve: service.resolve,
    prepare: service.prepare,
    invoke: service.invoke,
  };
  t.after(() => Object.assign(service, original));

  const calls: Array<{ operation: string; caller: any; input: any }> = [];
  for (const operation of ['list', 'resolve', 'prepare', 'invoke'] as const) {
    service[operation] = async (caller: any, input: any) => {
      calls.push({ operation, caller, input });
      if (operation === 'invoke') return { id: 'run-1', state: 'pending_approval' };
      if (operation === 'prepare') return {
        action: { binding_id: 'binding-1' },
        safe_preview: { title: 'Safe preview' },
        input_candidate: INPUT_CANDIDATE,
        replay_identity: 'sha256:test',
        authority_vector: { must_not_leave_service: true },
        authority_digest: 'sha256:internal',
      };
      return { operation };
    };
  }

  const app = testApp();
  const base = {
    binding_id: 'binding-1',
    resource_ref: RESOURCE_REF,
    idempotency_key: 'route-key-1',
  };
  const requests = [
    ['/api/app-actions/list', { resource_ref: RESOURCE_REF }],
    ['/api/app-actions/resolve', { binding_id: base.binding_id, resource_ref: RESOURCE_REF }],
    ['/api/app-actions/prepare', base],
    ['/api/app-actions/invoke', { ...base, input_candidate: INPUT_CANDIDATE }],
  ] as const;
  let preparedBody: any;
  for (const [path, body] of requests) {
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `${path} should succeed`);
    if (path.endsWith('/prepare')) preparedBody = await response.json();
  }

  assert.equal('authority_vector' in preparedBody.result, false);
  assert.equal('authority_digest' in preparedBody.result, false);

  assert.deepEqual(calls.map((call) => call.operation), ['list', 'resolve', 'prepare', 'invoke']);
  for (const call of calls) {
    assert.deepEqual(call.caller, {
      actor: {
        kind: 'human',
        org_id: ORG_ID,
        actor_id: USER_ID,
        role: 'member',
        source: 'ui',
        scopes: [],
      },
    });
  }
  assert.deepEqual(calls[2]?.input.selections, []);
  assert.deepEqual(calls[2]?.input.user_inputs, {});

  const callsBeforeInvalid = calls.length;
  const invalid = await app.request('/api/app-actions/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resource_ref: RESOURCE_REF, org_id: 'forged-org' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as any).code, 'VALIDATION_ERROR');
  assert.equal(calls.length, callsBeforeInvalid, 'invalid bodies must fail before the service');

  service.prepare = async () => { throw new AppRunError('APP_RUNS_DISABLED'); };
  const disabled = await app.request('/api/app-actions/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(base),
  });
  assert.equal(disabled.status, 503);
  assert.deepEqual(await disabled.json(), {
    error: 'App Run execution is disabled',
    code: 'APP_RUNS_DISABLED',
  });
});

test('JWT App Run routes delegate actor-scoped reads and map safe Run errors', async (t) => {
  const service = appActionService as any;
  const original = { inspectRun: service.inspectRun, result: service.result };
  t.after(() => Object.assign(service, original));

  const calls: Array<{ operation: string; caller: any; runId: string }> = [];
  service.inspectRun = async (caller: any, runId: string) => {
    calls.push({ operation: 'inspect', caller, runId });
    return { id: runId, state: 'succeeded' };
  };
  service.result = async (caller: any, runId: string) => {
    calls.push({ operation: 'result', caller, runId });
    return { run: { id: runId, state: 'succeeded' }, value: { status: 'accepted' } };
  };

  const app = testApp();
  const inspected = await app.request('/api/app-runs/run-1');
  assert.equal(inspected.status, 200);
  assert.equal(((await inspected.json()) as any).run.id, 'run-1');
  const result = await app.request('/api/app-runs/run-1/result');
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json() as any).value, { status: 'accepted' });
  assert.deepEqual(calls.map((call) => [call.operation, call.runId]), [
    ['inspect', 'run-1'],
    ['result', 'run-1'],
  ]);
  assert.ok(calls.every((call) => call.caller.actor.source === 'ui'));

  service.result = async () => { throw new AppRunError('APP_RUN_RESULT_EXPIRED'); };
  const expired = await app.request('/api/app-runs/run-1/result');
  assert.equal(expired.status, 410);
  assert.deepEqual(await expired.json(), {
    error: 'The exact App Run result is no longer retained',
    code: 'APP_RUN_RESULT_EXPIRED',
  });

  const invalid = await app.request(`/api/app-runs/${'x'.repeat(513)}`);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as any).code, 'VALIDATION_ERROR');
});
