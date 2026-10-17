import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
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

const payloadRef = { snapshot_id: randomUUID(), digest: 'a'.repeat(64) };

test('current authority binds the started human claim and exact input without a heartbeat or retry', async () => {
  const session = randomUUID(), owner = randomUUID();
  const input = { snapshot_id: randomUUID(), draft_revision: 4 };
  const authorized = { schema_version: 'deft.app_runtime_authority.v1', run_id: claim.run_id, attempt_id: claim.attempt_id,
    org_id: randomUUID(), owner_id: owner, app_installation_id: randomUUID(), app_version_id: randomUUID(),
    grant_snapshot_id: randomUUID(), lifecycle_epoch: 0, grant_epoch: 1, runtime_registration_id: randomUUID(),
    runtime_binding_id: randomUUID(), runtime_epoch: 1, session_id: session, session_epoch: 0, audience: 'app_runtime',
    operation_name: claim.operation_name, input, input_digest: `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`,
    lease_expires_at: new Date(Date.now() + 30000).toISOString() };
  // Host canonical input order is alphabetical, independent of insertion order.
  authorized.input_digest = `sha256:${createHash('sha256').update(JSON.stringify({ draft_revision: 4, snapshot_id: input.snapshot_id })).digest('hex')}`;
  const currentClaim = { ...claim, session_id: session, org_id: authorized.org_id, initiating_actor_type: 'human', initiating_actor_id: owner };
  let calls = 0;
  const client = createAppRuntimeClient({ channel_url: 'https://trusted.example/runtime', credential: { ...credential, session_id: session },
    fetch: async (url, init) => { calls++; assert.equal(String(url), 'https://trusted.example/runtime/authorize');
      assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
      assert.equal(JSON.parse(String(init?.body)).claim_token, claim.claim_token); return Response.json({ authorized }); } });
  assert.deepEqual(await client.authorize(currentClaim), authorized);
  assert.equal(calls, 1);
});

test('current authority rejects substituted owner, input, scopes and expired lease without retry', async () => {
  const session = randomUUID(), owner = randomUUID(), input = { draft_revision: 1 };
  const good = { schema_version: 'deft.app_runtime_authority.v1', run_id: claim.run_id, attempt_id: claim.attempt_id,
    org_id: randomUUID(), owner_id: owner, app_installation_id: randomUUID(), app_version_id: randomUUID(),
    grant_snapshot_id: randomUUID(), lifecycle_epoch: 1, grant_epoch: 1, runtime_registration_id: randomUUID(),
    runtime_binding_id: randomUUID(), runtime_epoch: 1, session_id: session, session_epoch: 1, audience: 'app_runtime',
    operation_name: claim.operation_name, input, input_digest: `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`,
    lease_expires_at: new Date(Date.now() + 30000).toISOString() };
  for (const bad of [{ ...good, owner_id: randomUUID() }, { ...good, input: { draft_revision: 2 } },
    { ...good, org_id: randomUUID() }, { ...good, lease_expires_at: new Date(Date.now() - 1).toISOString() },
    { ...good, host_token: 'not-allowed' }]) {
    let calls = 0;
    const client = createAppRuntimeClient({ channel_url: 'https://trusted.example/runtime', credential: { ...credential, session_id: session },
      fetch: async () => { calls++; return Response.json({ authorized: bad }); } });
    await assert.rejects(client.authorize({ ...claim, org_id: good.org_id, initiating_actor_type: 'human', initiating_actor_id: owner }),
      (error: unknown) => error instanceof AppRuntimeClientError && error.code === 'APP_RUNTIME_INVALID_AUTHORITY');
    assert.equal(calls, 1);
  }
});

test('reviewed action resources require opt-in and send only the retained input-field nomination', async () => {
  let calls = 0;
  const resources = { schema_version: 'deft.app_action_resources.v1', input_key: 'record_ids', resource_key: 'mail',
    resource_binding_id: randomUUID(), scope: { org_id: randomUUID(), owner_id: randomUUID(), installation_id: randomUUID() },
    records: [{ record_id: randomUUID(), label: 'Message', revision: 'rev1', data: { account_id: 'acct1', provider_message_id: 'private-1' } }] };
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://trusted.example/runtime/resources');
    assert.equal((init?.headers as Record<string, string>).authorization, `AppRuntime ${credential.session_token}`);
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init?.body)), { schema_version: 'deft.app_runtime_channel.v1', session_id: credential.session_id,
      run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence,
      action_resources_version: 'deft.app_action_resources.v1', input_key: 'record_ids' });
    return Response.json({ resources });
  };
  const legacy = createAppRuntimeClient({ channel_url: 'https://trusted.example/runtime', credential, fetch: fetcher });
  await assert.rejects(legacy.readActionResources(claim, { input_key: 'record_ids' }), TypeError);
  const client = createAppRuntimeClient({ channel_url: 'https://trusted.example/runtime', credential, fetch: fetcher,
    action_resources_version: 'deft.app_action_resources.v1' });
  await assert.rejects(client.readActionResources(claim, { input_key: 'record_ids', record_ids: [randomUUID()] } as never), TypeError);
  assert.equal(calls, 0);
  assert.deepEqual(await client.readActionResources(claim, { input_key: 'record_ids' }), resources);
  assert.equal(calls, 1);
});

test('reviewed action resources reject malformed, substituted and case-duplicate record output without retry', async () => {
  const record_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const resources = { schema_version: 'deft.app_action_resources.v1', input_key: 'record_ids', resource_key: 'mail',
    resource_binding_id: randomUUID(), scope: { org_id: randomUUID(), owner_id: randomUUID(), installation_id: randomUUID() },
    records: [{ record_id, label: 'Message', revision: 'rev1', data: { account_id: 'acct1' } }] };
  for (const bad of [{ ...resources, input_key: 'other' }, { ...resources, scope: {} },
    { ...resources, records: [null] }, { ...resources, records: [{ ...resources.records[0], data: 'private' }] },
    { ...resources, records: [resources.records[0], { ...resources.records[0], record_id: record_id.toUpperCase() }] },
    { ...resources, provider_locator: 'outside-retained-input' }]) {
    let calls = 0;
    const client = createAppRuntimeClient({ channel_url: 'https://trusted.example/runtime', credential,
      action_resources_version: 'deft.app_action_resources.v1', fetch: async () => { calls++; return Response.json({ resources: bad }); } });
    await assert.rejects(client.readActionResources(claim, { input_key: 'record_ids' }), (error: unknown) =>
      error instanceof AppRuntimeClientError && error.code === 'APP_RUNTIME_INVALID_RESOURCES');
    assert.equal(calls, 1);
  }
});

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function binaryResponse(bytes: Uint8Array, headers: Record<string, string> = {}) {
  return new Response(bytes, { headers: { 'content-type': 'application/octet-stream',
    'content-length': String(bytes.byteLength), 'x-deft-payload-digest': sha(bytes),
    'x-deft-snapshot-id': payloadRef.snapshot_id, 'x-deft-snapshot-digest': payloadRef.digest, ...headers } });
}

test('payload transport explicitly opts in and releases exact binary bytes beyond the scalar JSON budget', async () => {
  const bytes = new Uint8Array(1_200_000).fill(37), calls: Record<string, unknown>[] = [];
  const fileId = randomUUID();
  const client = createAppRuntimeClient({ channel_url: 'https://trusted.example/runtime', credential,
    action_payload_version: 'deft.app_action_payload.v1', fetch: async (target, init) => {
      const body = JSON.parse(String(init?.body)); calls.push(body);
      assert.equal((init?.headers as Record<string, string>).authorization, `AppRuntime ${credential.session_token}`);
      assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
      if (String(target).endsWith('/start')) return Response.json({ started: { ...claim, input: {}, snapshot_ref: payloadRef } });
      assert.equal(String(target), 'https://trusted.example/runtime/payload'); assert.deepEqual(body.snapshot_ref, payloadRef);
      if (body.part.kind === 'metadata') return Response.json({ payload: { ref: payloadRef, binding: {}, metadata: {}, file_refs: [],
        expires_at: new Date(Date.now() + 60000).toISOString(), byte_count: bytes.length, bytes_digest: sha(bytes) } });
      return binaryResponse(bytes);
    } });
  assert.deepEqual((await client.start(claim)).snapshot_ref, payloadRef);
  assert.equal(calls[0]!.action_payload_version, 'deft.app_action_payload.v1');
  assert.equal((await client.payloadMetadata(claim, payloadRef)).bytes_digest, sha(bytes));
  assert.deepEqual(await client.payloadBytes(claim, payloadRef), bytes);
  assert.deepEqual(await client.fileBytes(claim, payloadRef, fileId), bytes);
  assert.deepEqual(calls.slice(1).map(call => call.part), [{ kind: 'metadata' }, { kind: 'bytes' }, { kind: 'file', file_id: fileId }]);
  assert.equal(calls.length, 4);
});

test('payload transport rejects substituted headers, byte hashes and truncated responses without retry', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  for (const headers of [{ 'x-deft-snapshot-id': randomUUID() }, { 'x-deft-snapshot-digest': 'b'.repeat(64) },
    { 'x-deft-payload-digest': 'c'.repeat(64) }, { 'content-length': '4' }]) {
    let calls = 0;
    const client = createAppRuntimeClient({ channel_url: 'https://trusted.example/runtime', credential,
      action_payload_version: 'deft.app_action_payload.v1', fetch: async () => { calls++; return binaryResponse(bytes, headers); } });
    await assert.rejects(client.payloadBytes(claim, payloadRef), (error: unknown) => error instanceof AppRuntimeClientError);
    assert.equal(calls, 1);
  }
});

test('file transport bounds both declared and streamed bytes and cannot activate from a legacy client', async () => {
  let calls = 0;
  const legacy = createAppRuntimeClient({ channel_url: 'https://trusted.example/runtime', credential,
    fetch: async () => { calls++; throw Error('unexpected request'); } });
  assert.throws(() => legacy.payloadBytes(claim, payloadRef)); assert.equal(calls, 0);
  const fileId = randomUUID(), tooLarge = new Uint8Array(2097153);
  for (const declared of [String(tooLarge.length), '0']) {
    const client = createAppRuntimeClient({ channel_url: 'https://trusted.example/runtime', credential,
      action_payload_version: 'deft.app_action_payload.v1', fetch: async () => { calls++; return binaryResponse(tooLarge, { 'content-length': declared }); } });
    await assert.rejects(client.fileBytes(claim, payloadRef, fileId), (error: unknown) => error instanceof AppRuntimeClientError && error.code === 'APP_RUNTIME_RESPONSE_TOO_LARGE');
  }
  assert.equal(calls, 2);
});
