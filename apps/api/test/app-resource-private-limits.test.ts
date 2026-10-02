import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest, type Server } from 'node:http';
import test from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createAppResourcePrivateReadLimits, createAppResourceSyncManagementLimits } from '../src/middleware/app-resource-private-limits.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function listen(app: Hono) {
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

test('private host HTTP budgets use actual socket peers and reject spoofed forwarding headers before auth', async () => {
  for (const factory of [createAppResourcePrivateReadLimits, createAppResourceSyncManagementLimits]) {
    let now = 0;
    let authReads = 0;
    const app = new Hono();
    app.use('*', factory({ peerPerMinute: 2, globalPerMinute: 20, now: () => now }));
    app.use('*', async (c, next) => {
      authReads += 1;
      if (c.req.header('authorization') !== 'test-current-human') return c.json({ error: 'unauthorized' }, 401);
      await next();
    });
    app.get('/records', (c) => c.json({ ok: true }));
    const host = await listen(app);
    try {
      assert.equal((await fetch(`${host.url}/records`)).status, 401);
      assert.equal((await fetch(`${host.url}/records`, { headers: { authorization: 'test-current-human',
        'x-forwarded-for': '192.0.2.1', 'x-real-ip': '192.0.2.1' } })).status, 200);
      const denied = await fetch(`${host.url}/records`, { headers: { authorization: 'test-current-human',
        'x-forwarded-for': '198.51.100.7', 'x-real-ip': '203.0.113.8', forwarded: 'for=203.0.113.9' } });
      assert.equal(denied.status, 429);
      assert.equal(denied.headers.get('retry-after'), '60');
      assert.deepEqual(await denied.json(), { error: 'Resource sync request failed', code: 'APP_RESOURCE_SYNC_FAILURE' });
      assert.equal(authReads, 2);
      now = 60_000;
      assert.equal((await fetch(`${host.url}/records`, { headers: { authorization: 'test-current-human' } })).status, 200);
      assert.equal(authReads, 3);
    } finally { await host.close(); }
  }
});

test('private read and management HTTP budgets remain independent', async () => {
  const app = new Hono();
  app.use('/read/*', createAppResourcePrivateReadLimits({ peerPerMinute: 1 }));
  app.use('/manage/*', createAppResourceSyncManagementLimits({ peerPerMinute: 1 }));
  app.get('*', (c) => c.json({ ok: true }));
  const host = await listen(app);
  try {
    assert.equal((await fetch(`${host.url}/read/records`)).status, 200);
    assert.equal((await fetch(`${host.url}/read/records`)).status, 429);
    assert.equal((await fetch(`${host.url}/manage/status`)).status, 200);
    assert.equal((await fetch(`${host.url}/manage/status`)).status, 429);
  } finally { await host.close(); }
});

test('private HTTP budgets distinguish actual loopback socket addresses', async () => {
  const app = new Hono();
  app.use('*', createAppResourcePrivateReadLimits({ peerPerMinute: 1, globalPerMinute: 10 }));
  app.get('*', (c) => c.json({ ok: true }));
  const host = await listen(app);
  const from = (localAddress: string) => new Promise<number>((resolve, reject) => {
    const request = httpRequest(host.url, { localAddress,
      headers: { 'x-forwarded-for': '203.0.113.99' } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode!));
    });
    request.once('error', reject);
    request.end();
  });
  try {
    assert.equal(await from('127.0.0.1'), 200);
    assert.equal(await from('127.0.0.1'), 429);
    assert.equal(await from('127.0.0.2'), 200, 'actual second socket peer receives its own budget');
    assert.equal(await from('127.0.0.2'), 429);
  } finally { await host.close(); }
});

test('private HTTP global budgets cannot be reset by trusted peer rotation', async () => {
  const app = new Hono();
  // This mutable callback models a trusted transport adapter, not a request header.
  let transportPeer = '192.0.2.1';
  app.use('*', createAppResourcePrivateReadLimits({ globalPerMinute: 2, peerPerMinute: 10,
    peerAddress: () => transportPeer }));
  app.get('*', (c) => c.json({ ok: true }));
  const host = await listen(app);
  try {
    for (let index = 1; index <= 3; index += 1) {
      transportPeer = `192.0.2.${index}`;
      assert.equal((await fetch(host.url)).status, index <= 2 ? 200 : 429);
    }
  } finally { await host.close(); }
});

test('private HTTP missing and overflow peers share bounded budgets', async () => {
  for (const peers of [[null, undefined, 'not-an-ip'], ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4']]) {
    let transportPeer: string | null | undefined;
    const app = new Hono();
    app.use('*', createAppResourceSyncManagementLimits({ globalPerMinute: 20, peerPerMinute: 2,
      maxPeerBuckets: 1, peerAddress: () => transportPeer }));
    app.get('*', (c) => c.json({ ok: true }));
    const host = await listen(app);
    try {
      for (const [index, peer] of peers.entries()) {
        transportPeer = peer;
        assert.equal((await fetch(host.url)).status, index === peers.length - 1 ? 429 : 200);
      }
    } finally { await host.close(); }
  }
});

test('private HTTP concurrency is global and remains charged until aborted work unwinds', { timeout: 10_000 }, async () => {
  let transportPeer = '192.0.2.1';
  const entered = deferred();
  const aborted = deferred();
  const release = deferred();
  const completed = deferred();
  const app = new Hono();
  app.use('*', createAppResourcePrivateReadLimits({ globalConcurrent: 1, peerConcurrent: 1,
    globalPerMinute: 50, peerPerMinute: 50, peerAddress: () => transportPeer }));
  app.get('/blocked', async (c) => {
    c.req.raw.signal.addEventListener('abort', aborted.resolve, { once: true });
    entered.resolve();
    await release.promise;
    completed.resolve();
    return c.json({ ok: true });
  });
  app.get('/ready', (c) => c.json({ ok: true }));
  const host = await listen(app);
  const controller = new AbortController();
  const first = fetch(`${host.url}/blocked`, { signal: controller.signal }).catch((error: unknown) => error);
  try {
    await entered.promise;
    transportPeer = '198.51.100.2';
    const blocked = await fetch(`${host.url}/ready`);
    assert.equal(blocked.status, 503);
    assert.equal(blocked.headers.get('retry-after'), '1');
    controller.abort();
    await first;
    await aborted.promise;
    assert.equal((await fetch(`${host.url}/ready`)).status, 503, 'aborted work still occupies the global slot');
    release.resolve();
    await completed.promise;
    assert.equal((await fetch(`${host.url}/ready`)).status, 200);
  } finally { release.resolve(); controller.abort(); await host.close(); }
});

test('private middleware rejects pre-aborted requests and releases thrown downstream work', async () => {
  const app = new Hono();
  let entered = 0;
  app.use('*', createAppResourceSyncManagementLimits({ globalConcurrent: 1, peerConcurrent: 1 }));
  app.onError((_error, c) => c.json({ error: 'test failure' }, 500));
  app.get('/throw', () => { entered += 1; throw new Error('test-only downstream failure'); });
  app.get('/ready', (c) => { entered += 1; return c.json({ ok: true }); });
  const controller = new AbortController();
  controller.abort();
  assert.equal((await app.request('/ready', { signal: controller.signal })).status, 503);
  assert.equal(entered, 0);
  const host = await listen(app);
  try {
    assert.equal((await fetch(`${host.url}/throw`)).status, 500);
    assert.equal((await fetch(`${host.url}/ready`)).status, 200);
    assert.equal(entered, 2);
  } finally { await host.close(); }
});
