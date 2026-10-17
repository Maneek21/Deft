import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';

test('normal Runtime Send guard reads fit a separate bounded budget without changing login limits', async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.DEFT_AUTH_RATE_LIMIT_PER_MINUTE;
  delete process.env.DEFT_APP_RUNTIME_RATE_LIMIT_PER_MINUTE;
  const limits = await import('../src/middleware/rate-limit.js');
  // Baseline falls back to the limiter installed by host06; this fails after
  // claim + start + eight reads, matching the captured production workflow.
  const runtimeLimiter = (limits as typeof limits & { appRuntimeLimiter?: typeof limits.authLimiter }).appRuntimeLimiter ?? limits.authLimiter;
  const app = new Hono(); let delivered = 0;
  app.use('/runtime/*', runtimeLimiter);
  app.use('/login', limits.authLimiter);
  app.post('/runtime/:operation', c => {
    if (c.req.header('authorization') !== 'AppRuntime synthetic-valid-credential') return c.json({ code: 'APP_RUNTIME_ACCESS_DENIED' }, 403);
    delivered += 1; return c.json({ authenticated: true });
  });
  app.post('/login', c => c.json({ ok: true }));
  const headers = { authorization: 'AppRuntime synthetic-valid-credential' };
  // Maximum measured current one-PDF path includes OAuth token refresh:
  // claim + start + 27 metadata reads + MIME + PDF + result = 32 requests.
  const oneSend = ['claim', 'start', ...Array(29).fill('payload'), 'result'];
  const sequence = [...oneSend, ...oneSend];
  for (const operation of sequence) {
    const response = await app.request('/runtime/' + operation, { method: 'POST', headers });
    assert.equal(response.status, 200, 'normal Send workflow must not be rate limited at ' + operation);
  }
  assert.equal(delivered, 64);
  assert.equal((await app.request('/runtime/payload', { method: 'POST' })).status, 403, 'limiter cannot replace Runtime authentication');
  for (let i = 0; i < 10; i++) assert.equal((await app.request('/login', { method: 'POST' })).status, 200);
  assert.equal((await app.request('/login', { method: 'POST' })).status, 429, 'login retains ten requests/minute');
  // Changing nominated credentials or forwarded headers must not bypass the
  // peer budget. Sixty five requests have been charged to the unknown peer.
  for (let i = 65; i < 90; i++) assert.equal((await app.request('/runtime/payload', { method: 'POST', headers })).status, 200);
  const denied = await app.request('/runtime/payload', { method: 'POST', headers: { authorization: 'AppRuntime rotated-synthetic', 'x-forwarded-for': '192.0.2.99' } });
  assert.equal(denied.status, 429); assert.equal((await denied.json()).code, 'RATE_LIMITED');
});
