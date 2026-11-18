import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono, type MiddlewareHandler } from 'hono';

// The Apps limiters key on the same client address as the invite and auth
// limiters (lib/invite-client-ip.ts). This file covers the no-proxy case for
// appRuntimeLimiter and all three cases for the per-route Apps factories.
// apps-rate-limit-trusted-proxy.test.ts covers appRuntimeLimiter behind a proxy.
process.env.NODE_ENV = 'production';
process.env.DEFT_APP_RUNTIME_RATE_LIMIT_PER_MINUTE = '1';
delete process.env.DEFT_INVITE_TRUSTED_PROXIES;
delete process.env.DEFT_AUDIT_BYPASS_TOKEN;

const { appRuntimeLimiter } = await import('../src/middleware/rate-limit.js');
const { createAppPublicLimits } = await import('../src/middleware/app-public-limits.js');
const { createAppResourceSyncLimits } = await import('../src/middleware/app-resource-sync-limits.js');

function sender(limiter: MiddlewareHandler) {
  const app = new Hono();
  app.use('*', limiter);
  app.post('*', c => c.text('ok'));
  return async (peer: string, forwarded?: string) => (await app.fetch(new Request('http://api.test/x', {
    method: 'POST',
    headers: forwarded ? { 'x-forwarded-for': forwarded, 'x-real-ip': forwarded } : {},
  }), { incoming: { socket: { remoteAddress: peer } } })).status;
}

const factories = [
  ['app public limits', (o: { peerPerMinute: number }) => createAppPublicLimits({ ...o, globalPerMinute: 100 })],
  ['app resource sync limits', (o: { peerPerMinute: number }) => createAppResourceSyncLimits({ ...o, globalPerMinute: 100 })],
] as const;

function withTrustedProxies<T>(value: string | undefined, build: () => T): T {
  if (value === undefined) delete process.env.DEFT_INVITE_TRUSTED_PROXIES;
  else process.env.DEFT_INVITE_TRUSTED_PROXIES = value;
  try { return build(); } finally { delete process.env.DEFT_INVITE_TRUSTED_PROXIES; }
}

test('appRuntimeLimiter with no trusted proxy keys on the socket peer and ignores forwarded headers', async () => {
  const send = sender(appRuntimeLimiter);
  assert.equal(await send('127.0.0.1', '198.51.100.1'), 200);
  assert.equal(await send('127.0.0.1', '198.51.100.2'), 429, 'a different forwarded address must not open a new bucket');
  assert.equal(await send('10.0.0.7', '198.51.100.1'), 200, 'a different socket peer has its own bucket');
});

for (const [name, build] of factories) {
  test(`${name}: two forwarded addresses through a trusted proxy get two buckets`, async () => {
    const send = sender(withTrustedProxies('127.0.0.1,::1', () => build({ peerPerMinute: 1 })));
    assert.equal(await send('127.0.0.1', '198.51.100.1'), 200);
    assert.equal(await send('127.0.0.1', '198.51.100.2'), 200);
    assert.equal(await send('::ffff:127.0.0.1', '198.51.100.3'), 200, 'mapped loopback is the same trusted proxy');
    assert.equal(await send('127.0.0.1', '198.51.100.1'), 429);
    assert.equal(await send('::1', 'spoofed, 198.51.100.2'), 429, 'only the final entry, appended by the proxy, counts');
  });

  test(`${name}: a forged X-Forwarded-For from an untrusted peer does not change the bucket`, async () => {
    const send = sender(withTrustedProxies('127.0.0.1,::1', () => build({ peerPerMinute: 1 })));
    assert.equal(await send('203.0.113.9', '198.51.100.1'), 200);
    assert.equal(await send('203.0.113.9', '198.51.100.2'), 429);
    assert.equal(await send('203.0.113.9'), 429);
    assert.equal(await send('127.0.0.1', '198.51.100.1'), 200, 'the forged address was never charged');
  });

  test(`${name}: with no trusted proxy configured, keys on the socket peer as before`, async () => {
    const send = sender(withTrustedProxies(undefined, () => build({ peerPerMinute: 1 })));
    assert.equal(await send('127.0.0.1', '198.51.100.1'), 200);
    assert.equal(await send('127.0.0.1', '198.51.100.2'), 429);
    assert.equal(await send('127.0.0.1'), 429);
    assert.equal(await send('10.0.0.7', '198.51.100.2'), 200);
  });
}

for (const [name, create] of [
  ['app public limits', createAppPublicLimits],
  ['app resource sync limits', createAppResourceSyncLimits],
] as const) {
  test(`${name}: a slow address lookup cannot rewind a bucket another request advanced`, async () => {
    let clock = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const app = new Hono();
    app.use('*', create({
      peerPerMinute: 1, globalPerMinute: 100, now: () => clock,
      peerAddress: async () => { if (calls++ === 0) await held; return '198.51.100.1'; },
    }));
    app.post('*', c => c.text('ok'));
    const slow = app.request('http://api.test/x', { method: 'POST' });
    clock = 1_000;
    assert.equal((await app.request('http://api.test/x', { method: 'POST' })).status, 200);
    release();
    assert.equal((await slow).status, 429, 'the same client gets one request a minute, whatever the lookup order');
  });
}

for (const [name, create] of [
  ['app public limits', createAppPublicLimits],
  ['app resource sync limits', createAppResourceSyncLimits],
] as const) {
  test(`${name}: an exhausted global budget rejects without starting an address lookup`, async () => {
    let lookups = 0;
    const app = new Hono();
    app.use('*', create({
      globalPerMinute: 1, peerPerMinute: 100,
      peerAddress: async () => { lookups += 1; return '198.51.100.1'; },
    }));
    app.post('*', c => c.text('ok'));
    assert.equal((await app.request('http://api.test/x', { method: 'POST' })).status, 200);
    for (let i = 0; i < 20; i++) {
      assert.equal((await app.request('http://api.test/x', { method: 'POST' })).status, 429);
    }
    assert.equal(lookups, 1);
  });
}
