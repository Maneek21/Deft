import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Hono, type Context } from 'hono';
import * as limits from '../src/middleware/app-resource-sync-limits.js';

const path = '/api/app-resource-sync-channel/v3/heartbeat';
// The baseline has no trusted success marker; exercise its actual admissions.
const mark = (c: Context) =>
  (limits as typeof limits & { markAuthenticatedResourceSyncHeartbeat?: (c: Context) => void })
    .markAuthenticatedResourceSyncHeartbeat?.(c);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(options: Parameters<typeof limits.createAppResourceSyncLimits>[0] = {}) {
  const app = new Hono();
  app.use('*', limits.createAppResourceSyncLimits({ peerAddress: () => '127.0.0.1', ...options }));
  app.post(path, c => { if (c.req.header('authorization') === 'authenticated') mark(c);
    return c.json({ renewed: true }); });
  app.post('/claim', c => c.json({ ok: true }));
  const request = (url = path, auth = 'authenticated') => app.request(url, {
    method: 'POST', headers: { authorization: auth, 'x-authenticated-heartbeat': 'true' } });
  return { app, request };
}

test('authenticated renewals exceed the generic peer budget but always consume global budget', async () => {
  const f = fixture({ peerPerMinute: 2, globalPerMinute: 6 });
  assert.equal((await f.request('/claim')).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await f.request()).status, 200);
  assert.equal((await f.request('/claim')).status, 200);
  assert.equal((await f.request()).status, 429, 'global budget still includes every renewal');
});

test('headers, body, unmarked success, other paths and methods cannot nominate a refund', async () => {
  const f = fixture({ peerPerMinute: 2 });
  assert.equal((await f.request(path, 'untrusted')).status, 200);
  assert.equal((await f.request(path, 'untrusted')).status, 200);
  assert.equal((await f.request()).status, 429);
  const other = fixture({ peerPerMinute: 1 });
  other.app.post('/other/heartbeat', c => { mark(c); return c.json({ renewed: true }); });
  assert.equal((await other.request('/other/heartbeat')).status, 200);
  assert.equal((await other.request()).status, 429);
  const get = fixture({ peerPerMinute: 1 });
  get.app.get(path, c => { mark(c); return c.json({ renewed: true }); });
  assert.equal((await get.app.request(path)).status, 200);
  assert.equal((await get.request()).status, 429);
});

test('failed and thrown downstream renewals retain their generic charge', async () => {
  for (const mode of ['denied', 'thrown']) {
    const app = new Hono();
    app.use('*', limits.createAppResourceSyncLimits({ peerPerMinute: 1, peerAddress: () => '127.0.0.1' }));
    app.post(path, c => { mark(c); if (mode === 'thrown') throw new Error('test failure');
      return c.json({ error: 'denied' }, 403); });
    assert.equal((await app.request(path, { method: 'POST' })).status, mode === 'thrown' ? 500 : 403);
    assert.equal((await app.request(path, { method: 'POST' })).status, 429);
  }
});

test('late renewal success cannot refund a new minute or backward-clock generation', async () => {
  for (const reset of [60_000, -1]) {
    let now = 0;
    const entered = deferred(), release = deferred();
    const app = new Hono();
    app.use('*', limits.createAppResourceSyncLimits({ peerPerMinute: 2, peerAddress: () => '127.0.0.1', now: () => now }));
    app.post(path, async c => { entered.resolve(); await release.promise; mark(c); return c.json({ renewed: true }); });
    app.post('/claim', c => c.json({ ok: true }));
    const request = (url: string) => app.request(url, { method: 'POST' });
    const pending = request(path); await entered.promise; now = reset;
    assert.equal((await request('/claim')).status, 200);
    release.resolve(); assert.equal((await pending).status, 200);
    assert.equal((await request('/claim')).status, 200);
    assert.equal((await request('/claim')).status, 429);
  }
});

test('renewal refunds do not release occupied concurrency slots', async () => {
  const entered = deferred(), release = deferred();
  const app = new Hono();
  app.use('*', limits.createAppResourceSyncLimits({ peerConcurrent: 1, peerPerMinute: 10, peerAddress: () => '127.0.0.1' }));
  app.post(path, async c => { mark(c); entered.resolve(); await release.promise; return c.json({ renewed: true }); });
  app.post('/claim', c => c.json({ ok: true }));
  const pending = app.request(path, { method: 'POST' }); await entered.promise;
  assert.equal((await app.request('/claim', { method: 'POST' })).status, 503);
  release.resolve(); assert.equal((await pending).status, 200);
  assert.equal((await app.request('/claim', { method: 'POST' })).status, 200);
});

test('the real channel3 route marks only a fresh authenticated successful renewal', async () => {
  let allowed = true, authCalls = 0;
  mock.module(new URL('../src/lib/app-attachment-sync-channel.ts', import.meta.url).href, {
    namedExports: { appAttachmentSyncChannelEnabled: () => true },
  });
  mock.module(new URL('../src/lib/app-attachment-runtime.ts', import.meta.url).href, {
    namedExports: { getAppAttachmentRuntime: async () => ({ channel: { heartbeat: async (input: Record<string, unknown>) => {
      authCalls++;
      return allowed && input.session_token === 'a'.repeat(32) && input.claim_token === 'current-claim'
        ? { lease_expires_at: new Date(Date.now() + 60_000).toISOString(), sequence: 1 } : null;
    } } }) },
  });
  const { appAttachmentSyncChannelRoutes } = await import('../src/routes/app-attachment-sync-channel.js');
  const app = new Hono();
  app.use('*', limits.createAppResourceSyncLimits({ peerPerMinute: 2, globalPerMinute: 20, peerAddress: () => '127.0.0.1' }));
  app.route('/api/app-resource-sync-channel/v3', appAttachmentSyncChannelRoutes);
  const request = (body = { claim_token: 'current-claim' }, token = 'a'.repeat(32)) => app.request(path, {
    method: 'POST', headers: { authorization: `AppRuntime ${token}`, 'content-type': 'application/json',
      'x-authenticated-heartbeat': 'true' }, body: JSON.stringify(body) });
  for (let i = 0; i < 4; i++) assert.equal((await request()).status, 200);
  assert.equal(authCalls, 4, 'every renewal still crosses the current authority service');
  allowed = false;
  assert.equal((await request()).status, 403);
  assert.equal((await request()).status, 403);
  assert.equal((await request()).status, 429);
  assert.equal(authCalls, 6, 'revoked renewal is not refunded or cached');
  for (const denied of [
    { authorization: 'AppRuntime short', body: '{"authenticated_heartbeat":true}', status: 403 },
    { authorization: `AppRuntime ${'a'.repeat(32)}`, body: '{', status: 400 },
    { authorization: `AppRuntime ${'a'.repeat(32)}`, body: '{}', cookie: 'forged=true', status: 403 },
  ]) {
    const guarded = new Hono();
    guarded.use('*', limits.createAppResourceSyncLimits({ peerPerMinute: 1, peerAddress: () => '127.0.0.1' }));
    guarded.route('/api/app-resource-sync-channel/v3', appAttachmentSyncChannelRoutes);
    const headers = { authorization: denied.authorization, 'content-type': 'application/json',
      ...(denied.cookie ? { cookie: denied.cookie } : {}) };
    assert.equal((await guarded.request(path, { method: 'POST', headers, body: denied.body })).status, denied.status);
    assert.equal((await guarded.request(path, { method: 'POST', headers, body: denied.body })).status, 429);
  }
});
