import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  APP_RESOURCE_SYNC_AUDIENCE, APP_RESOURCE_SYNC_CHANNEL_VERSION,
  ResourceSyncClaimSchema, ResourceSyncClientError,
  createResourceSyncClient, digestResourceSyncDescriptor,
} from '../src/resource-sync-client.js';

const ids = {
  org: '00000000-0000-4000-8000-000000000001',
  install: '00000000-0000-4000-8000-000000000002',
  version: '00000000-0000-4000-8000-000000000003',
  grant: '00000000-0000-4000-8000-000000000004',
  registration: '00000000-0000-4000-8000-000000000005',
  binding: '00000000-0000-4000-8000-000000000006',
  session: '00000000-0000-4000-8000-000000000007',
  run: '00000000-0000-4000-8000-000000000008',
  attempt: '00000000-0000-4000-8000-000000000009',
  claim: '00000000-0000-4000-8000-00000000000a',
};
const credential = { session_id: ids.session, session_token: 's'.repeat(43) };
const descriptor = {
  schema_version: 'deft.app_sync_descriptor.v1' as const,
  key: 'inbox', runtime_requirement_key: 'mail', resource_type: 'email_message',
  requested_visibility: 'user_private' as const,
  record_schema: { type: 'object' as const, properties: {
    subject: { type: 'string' as const, maxLength: 200 },
  }, required: ['subject'], additionalProperties: false as const },
  label_field: 'subject',
};
const input = { schema_version: 'deft.app_sync_request.v1' as const,
  cursor: 'start', max_items: 100 };
const page = { schema_version: 'deft.app_sync_page.v1' as const,
  upserts: [{ id: 'item-1', revision: 'r1', data: { subject: 'Hello' } }],
  tombstones: [], next_cursor: 'next', has_more: true };
const outer = { schema_version: APP_RESOURCE_SYNC_CHANNEL_VERSION,
  audience: APP_RESOURCE_SYNC_AUDIENCE };
const expires = '2037-01-01T00:00:00.000Z';

async function fixture() {
  const descriptor_digest = await digestResourceSyncDescriptor(descriptor);
  const claim = { ...outer, work_kind: 'sync_page' as const,
    org_id: ids.org, app_installation_id: ids.install, app_version_id: ids.version,
    grant_snapshot_id: ids.grant, lifecycle_epoch: 2, grant_epoch: 3,
    runtime_registration_id: ids.registration, resource_binding_id: ids.binding,
    runtime_epoch: 4, session_id: ids.session, session_epoch: 5,
    run_id: ids.run, attempt_id: ids.attempt, attempt_number: 1,
    claim_token: ids.claim, sequence: 6, lease_expires_at: expires,
    descriptor_digest };
  const started = { ...outer, work_kind: 'sync_page' as const,
    resource_binding_id: ids.binding, run_id: ids.run, attempt_id: ids.attempt,
    sequence: 6, lease_expires_at: expires, descriptor_digest, descriptor, input };
  return { claim, started };
}

test('v2 SDK validates every reply and sends a sync-only bearer transcript', async () => {
  const { claim, started } = await fixture();
  const calls: Array<{ path: string; body: Record<string, unknown>; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body, init: init! });
    if (path.endsWith('/claim')) return Response.json({ ...outer, claim });
    if (path.endsWith('/start')) return Response.json({ ...outer, started });
    if (path.endsWith('/heartbeat')) return Response.json({ ...outer,
      work_kind: 'sync_page', run_id: ids.run, attempt_id: ids.attempt,
      sequence: 6, renewed: true, lease_expires_at: expires });
    return Response.json({ ...outer, work_kind: 'sync_page', run_id: ids.run,
      attempt_id: ids.attempt, sequence: 6, accepted: true });
  };
  const client = createResourceSyncClient({
    channel_url: 'http://127.0.0.1:4321/api/app-runtime/channel', credential, fetch: fetcher,
  });
  const claimed = await client.claim();
  assert.deepEqual(claimed, ResourceSyncClaimSchema.parse(claim));
  const opened = await client.start(claimed!);
  assert.deepEqual(opened.input, input);
  assert.equal(await client.heartbeat(claimed!), expires);
  await client.result(claimed!, opened, { status: 'returned', provider_succeeded: true, page });
  assert.deepEqual(calls.map((item) => item.path), ['/api/app-runtime/channel/claim',
    '/api/app-runtime/channel/start', '/api/app-runtime/channel/heartbeat',
    '/api/app-runtime/channel/result']);
  for (const { body, init } of calls) {
    assert.equal(body.schema_version, APP_RESOURCE_SYNC_CHANNEL_VERSION);
    assert.equal(body.audience, APP_RESOURCE_SYNC_AUDIENCE);
    assert.equal(body.session_id, credential.session_id);
    assert.equal(Object.hasOwn(body, 'session_token'), false);
    assert.equal((init.headers as Record<string, string>).authorization,
      `AppRuntime ${credential.session_token}`);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
  }
  assert.equal((calls[3]!.body.page as typeof page).upserts[0]!.data.subject, 'Hello');
  assert.equal(Object.hasOwn(calls[3]!.body, 'descriptor'), false);
  assert.equal(Object.hasOwn(calls[3]!.body, 'resource_binding_id'), false);
});

test('descriptor digest is canonical and start must match all claim correlation pins', async () => {
  const { claim, started } = await fixture();
  const canonical = '{"key":"inbox","label_field":"subject","record_schema":'
    + '{"additionalProperties":false,"properties":{"subject":{"maxLength":200,"type":"string"}},'
    + '"required":["subject"],"type":"object"},"requested_visibility":"user_private",'
    + '"resource_type":"email_message","runtime_requirement_key":"mail",'
    + '"schema_version":"deft.app_sync_descriptor.v1"}';
  assert.equal(claim.descriptor_digest,
    `sha256:${createHash('sha256').update(canonical).digest('hex')}`);
  for (const changed of [
    { ...started, run_id: ids.attempt },
    { ...started, attempt_id: ids.run },
    { ...started, resource_binding_id: ids.run },
    { ...started, sequence: 7 },
    { ...started, descriptor_digest: `sha256:${'f'.repeat(64)}` },
    { ...started, descriptor: { ...descriptor, resource_type: 'email_thread' } },
  ]) {
    const client = createResourceSyncClient({ channel_url: 'https://example.test/channel',
      credential, fetch: async () => Response.json({ ...outer, started: changed }) });
    await assert.rejects(() => client.start(claim), (error: unknown) =>
      error instanceof ResourceSyncClientError && error.code === 'APP_RESOURCE_SYNC_INVALID_RESPONSE');
  }
});

test('SDK rejects wrong audience, malformed replies, replay substitution and invalid pages', async () => {
  const { claim, started } = await fixture();
  for (const payload of [
    { ...outer, claim: { ...claim, audience: 'app_runtime' } },
    { ...outer, claim: { ...claim, resource_binding_id: 'not-a-uuid' } },
    { ...outer, claim: { ...claim, extra: true } },
    { ...outer, extra: true, claim },
  ]) {
    const client = createResourceSyncClient({ channel_url: 'https://example.test/channel',
      credential, fetch: async () => Response.json(payload) });
    await assert.rejects(() => client.claim(), ResourceSyncClientError);
  }
  const fake = (operation: string): typeof fetch => async () => Response.json(operation === 'heartbeat'
    ? { ...outer, work_kind: 'sync_page', run_id: ids.run, attempt_id: ids.attempt,
      sequence: 7, renewed: true, lease_expires_at: expires }
    : { ...outer, work_kind: 'sync_page', run_id: ids.run, attempt_id: ids.attempt,
      sequence: 7, accepted: true });
  await assert.rejects(() => createResourceSyncClient({ channel_url: 'https://example.test/channel',
    credential, fetch: fake('heartbeat') }).heartbeat(claim), ResourceSyncClientError);
  await assert.rejects(() => createResourceSyncClient({ channel_url: 'https://example.test/channel',
    credential, fetch: fake('result') }).result(claim, started,
      { status: 'returned', provider_succeeded: true, page }), ResourceSyncClientError);
  const noSend: typeof fetch = async () => { throw new Error('must not send'); };
  const client = createResourceSyncClient({ channel_url: 'https://example.test/channel',
    credential, fetch: noSend });
  await assert.rejects(() => client.result(claim, started, { status: 'returned',
    provider_succeeded: true, page: { ...page, next_cursor: 'start' } }), /advance/);
  await assert.rejects(() => client.result(claim, started,
    { status: 'returned', provider_succeeded: false,
      error_code: 'APP_RUN_PROVIDER_ERROR', page } as never));
});

test('transport guards URL, AbortSignal, deadline, response size and generic errors', async () => {
  for (const channel_url of ['http://example.test/channel',
    'https://user:password@example.test/channel', 'https://example.test/channel?token=x']) {
    assert.throws(() => createResourceSyncClient({ channel_url, credential }));
  }
  let destination = '';
  const sameOrigin = createResourceSyncClient({
    channel_url: 'https://trusted.example//other.example/path', credential,
    fetch: async (url) => {
      destination = String(url);
      return Response.json({ ...outer, claim: null });
    },
  });
  assert.equal(await sameOrigin.claim(), null);
  assert.equal(new URL(destination).origin, 'https://trusted.example');
  assert.equal(new URL(destination).pathname, '//other.example/path/claim');
  const aborted = new AbortController(); aborted.abort();
  let calls = 0;
  const abortClient = createResourceSyncClient({ channel_url: 'https://example.test/channel',
    credential, fetch: async () => { calls++; return Response.json({ ...outer, claim: null }); } });
  await assert.rejects(() => abortClient.claim({ signal: aborted.signal }), (error: unknown) =>
    error instanceof ResourceSyncClientError && error.code === 'APP_RESOURCE_SYNC_ABORTED');
  assert.equal(calls, 0);
  const slow = createResourceSyncClient({ channel_url: 'https://example.test/channel',
    credential, timeout_ms: 10, fetch: async () => new Promise<Response>(() => {}) });
  await assert.rejects(() => slow.claim(), (error: unknown) =>
    error instanceof ResourceSyncClientError && error.code === 'APP_RESOURCE_SYNC_TIMEOUT');
  const oversized = createResourceSyncClient({ channel_url: 'https://example.test/channel',
    credential, fetch: async () => Response.json({ ...outer, claim: null },
      { headers: { 'content-length': '1100001' } }) });
  await assert.rejects(() => oversized.claim(), (error: unknown) =>
    error instanceof ResourceSyncClientError && error.code === 'APP_RESOURCE_SYNC_RESPONSE_TOO_LARGE');
  const denied = createResourceSyncClient({ channel_url: 'https://example.test/channel',
    credential, fetch: async () => Response.json({ code: 'APP_RESOURCE_SYNC_ACCESS_DENIED',
      error: 'Resource sync credential required' }, { status: 403 }) });
  await assert.rejects(() => denied.claim(), (error: unknown) =>
    error instanceof ResourceSyncClientError && error.status === 403
      && error.code === 'APP_RESOURCE_SYNC_ACCESS_DENIED');
  const rawProvider = createResourceSyncClient({ channel_url: 'https://example.test/channel',
    credential, fetch: async () => Response.json({ code: 'PROVIDER_SECRET',
      error: 'raw provider internal message' }, { status: 500 }) });
  await assert.rejects(() => rawProvider.claim(), (error: unknown) =>
    error instanceof ResourceSyncClientError && error.code === 'APP_RESOURCE_SYNC_FAILURE'
      && !error.message.includes('raw provider'));
});
