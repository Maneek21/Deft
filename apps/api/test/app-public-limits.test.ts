import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { createAppPublicLimits } from '../src/middleware/app-public-limits.js';

function appWithLimits(options: Parameters<typeof createAppPublicLimits>[0], handler?: () => Promise<void>) {
  const app = new Hono();
  let bodyReads = 0;
  app.use('*', createAppPublicLimits(options));
  app.post('/:slug/claims', async (c) => {
    bodyReads += 1;
    if (handler) await handler();
    return c.json({ ok: true });
  });
  app.onError(() => new Response('internal error', { status: 500 }));
  return { app, bodyReads: () => bodyReads };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test('forged forwarding headers cannot multiply socket-peer budget; rejection precedes route', async () => {
  const { app, bodyReads } = appWithLimits({
    peerAddress: () => '203.0.113.7',
    globalPerMinute: 10,
    peerPerMinute: 2,
  });
  for (const forged of ['198.51.100.1', '198.51.100.2']) {
    const response = await app.request('/phantom/claims', {
      method: 'POST',
      headers: { 'x-forwarded-for': forged, 'x-real-ip': forged },
      body: '{}',
    });
    assert.equal(response.status, 200);
  }
  const rejected = await app.request('/different-unknown-slug/claims', {
    method: 'POST',
    headers: { 'x-forwarded-for': '198.51.100.3', 'x-real-ip': '198.51.100.3' },
    body: '{}',
  });
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json() as { code: string }).code, 'PUBLIC_RATE_LIMITED');
  assert.equal(bodyReads(), 2);
});

test('unknown socket peer shares a fail-closed bucket regardless of forwarding headers', async () => {
  const { app } = appWithLimits({ globalPerMinute: 10, peerPerMinute: 1 });
  assert.equal((await app.request('/a/claims', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 200);
  assert.equal((await app.request('/b/claims', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.2' } })).status, 429);
});

test('peer identity table is capped and overflow identities share one bucket', async () => {
  let peer = '203.0.113.1';
  const { app } = appWithLimits({
    peerAddress: () => peer,
    maxPeerBuckets: 1,
    globalPerMinute: 10,
    peerPerMinute: 1,
  });
  assert.equal((await app.request('/a/claims', { method: 'POST' })).status, 200);
  peer = '203.0.113.2';
  assert.equal((await app.request('/b/claims', { method: 'POST' })).status, 200);
  peer = '203.0.113.3';
  assert.equal((await app.request('/c/claims', { method: 'POST' })).status, 429);
  peer = '203.0.113.1';
  assert.equal((await app.request('/d/claims', { method: 'POST' })).status, 429);
});

test('global budget holds across peer and slug rotation', async () => {
  let peerNumber = 1;
  const { app } = appWithLimits({
    peerAddress: () => `203.0.113.${peerNumber++}`,
    globalPerMinute: 2,
    peerPerMinute: 10,
  });
  assert.equal((await app.request('/a/claims', { method: 'POST' })).status, 200);
  assert.equal((await app.request('/b/claims', { method: 'POST' })).status, 200);
  assert.equal((await app.request('/c/claims', { method: 'POST' })).status, 429);
});

test('in-flight slots reject before route and release after success or error', async () => {
  const gate = deferred();
  let entered = 0;
  const { app } = appWithLimits({
    peerAddress: () => '203.0.113.5',
    globalPerMinute: 10,
    peerPerMinute: 10,
    globalConcurrent: 1,
    peerConcurrent: 1,
  }, async () => {
    entered += 1;
    if (entered === 1) await gate.promise;
    if (entered === 2) throw new Error('test failure');
  });
  const first = app.request('/a/claims', { method: 'POST' });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(entered, 1);
  const busy = await app.request('/b/claims', { method: 'POST' });
  assert.equal(busy.status, 503);
  assert.equal(entered, 1);
  gate.release();
  assert.equal((await first).status, 200);
  assert.equal((await app.request('/c/claims', { method: 'POST' })).status, 500);
  assert.equal((await app.request('/d/claims', { method: 'POST' })).status, 200);
});

test('abort does not release capacity until downstream work settles', async () => {
  const gate = deferred();
  let entered = 0;
  const { app } = appWithLimits({
    peerAddress: () => '203.0.113.8',
    globalPerMinute: 10,
    peerPerMinute: 10,
    globalConcurrent: 1,
    peerConcurrent: 1,
  }, async () => {
    entered += 1;
    if (entered === 1) await gate.promise;
  });
  const controller = new AbortController();
  const first = app.request(new Request('http://localhost/a/claims', {
    method: 'POST', signal: controller.signal,
  }));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(entered, 1);
  controller.abort();
  assert.equal((await app.request('/b/claims', { method: 'POST' })).status, 503);
  assert.equal(entered, 1, 'aborted client did not release unfinished work');
  gate.release();
  await Promise.allSettled([first]);
  assert.equal((await app.request('/c/claims', { method: 'POST' })).status, 200);
});



test('global concurrency cap spans different verified peers', async () => {
  const gate = deferred();
  let peer = '203.0.113.11';
  let entered = 0;
  const { app } = appWithLimits({
    peerAddress: () => peer,
    globalPerMinute: 10,
    peerPerMinute: 10,
    globalConcurrent: 1,
    peerConcurrent: 2,
  }, async () => {
    entered += 1;
    if (entered === 1) await gate.promise;
  });
  const first = app.request('/first/claims', { method: 'POST' });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  peer = '203.0.113.12';
  assert.equal((await app.request('/second/claims', { method: 'POST' })).status, 503);
  assert.equal(entered, 1);
  gate.release();
  assert.equal((await first).status, 200);
  assert.equal((await app.request('/third/claims', { method: 'POST' })).status, 200);
});
