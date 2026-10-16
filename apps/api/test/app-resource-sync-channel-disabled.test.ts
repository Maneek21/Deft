import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createAppResourceSyncLimits } from '../src/middleware/app-resource-sync-limits.js';

test('v2 resource channel fails closed before parsing a request', async () => {
  const prior = process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED;
  process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'false';
  try {
    const { appResourceSyncChannelRoutes } = await import('../src/routes/app-resource-sync-channel.js');
    const response = await appResourceSyncChannelRoutes.request('/result', {
      method: 'POST', headers: { 'content-type': 'text/plain', cookie: 'sid=human' },
      body: 'this is not JSON',
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Resource sync channel unavailable',
      code: 'APP_RESOURCE_SYNC_DISABLED' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    if (prior === undefined) delete process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED;
    else process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = prior;
  }
});

test('v2 pre-auth limits ignore spoofed forwarding headers and cap concurrency', async () => {
  const capped = new Hono();
  capped.use('*', createAppResourceSyncLimits({ globalPerMinute: 10,
    peerPerMinute: 2, globalConcurrent: 1, peerConcurrent: 1 }));
  let release!: () => void;
  let entered!: () => void;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  capped.post('/work', async (c) => { entered(); await waiting; return c.json({ ok: true }); });
  const first = capped.request('/work', { method: 'POST',
    headers: { 'x-forwarded-for': '192.0.2.1', 'x-real-ip': '192.0.2.1' } });
  await began;
  const concurrent = await capped.request('/work', { method: 'POST',
    headers: { 'x-forwarded-for': '198.51.100.2', 'x-real-ip': '198.51.100.2' } });
  assert.equal(concurrent.status, 503);
  release();
  assert.equal((await first).status, 200);
  const rotated = await capped.request('/work', { method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.3', 'x-real-ip': '203.0.113.3' } });
  assert.equal(rotated.status, 429, 'all in-memory peers share the unknown bucket');
});
