import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

// appRuntimeLimiter reads DEFT_INVITE_TRUSTED_PROXIES at import, so the
// trusted-proxy cases live in their own file (one process per test file).
process.env.NODE_ENV = 'production';
process.env.DEFT_APP_RUNTIME_RATE_LIMIT_PER_MINUTE = '1';
process.env.DEFT_INVITE_TRUSTED_PROXIES = '127.0.0.1,::1';
delete process.env.DEFT_AUDIT_BYPASS_TOKEN;

const { appRuntimeLimiter } = await import('../src/middleware/rate-limit.js');

const app = new Hono();
app.use('*', appRuntimeLimiter);
app.post('*', c => c.text('ok'));
const send = async (peer: string, forwarded?: string) => (await app.fetch(new Request('http://api.test/x', {
  method: 'POST',
  headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
}), { incoming: { socket: { remoteAddress: peer } } })).status;

test('appRuntimeLimiter: two forwarded addresses through a trusted proxy get two buckets', async () => {
  assert.equal(await send('127.0.0.1', '198.51.100.1'), 200);
  assert.equal(await send('127.0.0.1', '198.51.100.2'), 200);
  assert.equal(await send('::1', '198.51.100.1'), 429, 'the same client through either loopback shares its bucket');
  assert.equal(await send('127.0.0.1', '198.51.100.2'), 429);
});

test('appRuntimeLimiter: a forged X-Forwarded-For from an untrusted peer does not change the bucket', async () => {
  assert.equal(await send('203.0.113.9', '198.51.100.50'), 200);
  assert.equal(await send('203.0.113.9', '198.51.100.51'), 429);
  assert.equal(await send('127.0.0.1', '198.51.100.50'), 200, 'the forged address was never charged');
});
