import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppRuntimeClient, AppRuntimeClientError } from '../src/runtime-client.js';

const credential = { session_id: 'session_test', session_token: 's'.repeat(43) };
const claim = {
  schema_version: 'deft.app_runtime_channel.v1' as const,
  run_id: 'run_test', attempt_id: 'attempt_test', claim_token: 'claim_test',
  sequence: 1, operation_name: 'send_notice', lease_expires_at: new Date().toISOString(),
};

test('Runtime client preserves the configured origin when its path starts with two slashes', async () => {
  let calls = 0;
  const client = createAppRuntimeClient({
    channel_url: 'https://trusted.example//other.example/runtime', credential,
    fetch: async (target, init) => {
      calls += 1;
      const url = new URL(String(target));
      assert.equal(url.origin, 'https://trusted.example');
      assert.equal(url.pathname, '//other.example/runtime/claim');
      assert.equal((init?.headers as Record<string, string>).authorization,
        `AppRuntime ${credential.session_token}`);
      return Response.json({ claim: null });
    },
  });
  assert.equal(await client.claim(), null);
  assert.equal(calls, 1);
});

test('Runtime client scopes the bearer to the channel and never retries an effect', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown>; credentials: RequestCredentials | undefined }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    assert.equal((init?.headers as Record<string, string>).authorization,
      `AppRuntime ${credential.session_token}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.session_id, credential.session_id);
    assert.equal(body.schema_version, 'deft.app_runtime_channel.v1');
    assert.equal(Object.hasOwn(body, 'session_token'), false);
    calls.push({ path, body, credentials: init?.credentials });
    if (path.endsWith('/claim')) return Response.json({ claim });
    if (path.endsWith('/start')) return Response.json({ started: { ...claim, input: { note: 'hello' } } });
    if (path.endsWith('/heartbeat')) return Response.json({ renewed: true });
    return Response.json({ run: { id: claim.run_id, state: 'succeeded' } });
  };
  const client = createAppRuntimeClient({ channel_url: 'http://127.0.0.1:4321/api/app-runtime/channel',
    credential, fetch: fetcher });
  const claimed = await client.claim();
  assert.deepEqual(claimed, claim);
  const started = await client.start(claim);
  assert.deepEqual(started.input, { note: 'hello' });
  assert.equal(await client.heartbeat(claim), true);
  assert.deepEqual(await client.result(claim, { status: 'returned', provider_succeeded: true,
    output: { delivered: true } }), { id: claim.run_id, state: 'succeeded' });
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/app-runtime/channel/claim', '/api/app-runtime/channel/start',
    '/api/app-runtime/channel/heartbeat', '/api/app-runtime/channel/result',
  ]);
  assert(calls.every((call) => call.credentials === 'omit'));
});

test('Runtime client rejects unsafe endpoint credentials and server errors', async () => {
  assert.throws(() => createAppRuntimeClient({
    channel_url: 'https://user:password@example.com/runtime', credential,
  }), /Runtime channel URL/);
  assert.throws(() => createAppRuntimeClient({
    channel_url: 'http://example.com/runtime', credential,
  }), /Runtime channel URL/);
  const client = createAppRuntimeClient({ channel_url: 'https://example.com/runtime', credential,
    fetch: async () => Response.json({ error: 'denied', code: 'APP_RUNTIME_ACCESS_DENIED' }, { status: 403 }) });
  await assert.rejects(() => client.claim(), (error: unknown) =>
    error instanceof AppRuntimeClientError && error.status === 403
      && error.code === 'APP_RUNTIME_ACCESS_DENIED');
});
