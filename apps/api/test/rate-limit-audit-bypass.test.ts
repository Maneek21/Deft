import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

test('audit bypass token skips default limiter outside production', async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldBypassToken = process.env.DEFT_AUDIT_BYPASS_TOKEN;
  const oldDefaultLimit = process.env.DEFT_DEFAULT_RATE_LIMIT_PER_MINUTE;

  process.env.NODE_ENV = 'test';
  process.env.DEFT_AUDIT_BYPASS_TOKEN = 'audit-secret';
  process.env.DEFT_DEFAULT_RATE_LIMIT_PER_MINUTE = '1';

  const { defaultLimiter } = await import(`../src/middleware/rate-limit.js?audit-bypass=${Date.now()}`);
  const app = new Hono();
  app.use('*', defaultLimiter);
  app.get('/ok', (c) => c.json({ ok: true }));

  const first = await app.request('/ok', { headers: { 'x-deft-audit-token': 'audit-secret' } });
  const second = await app.request('/ok', { headers: { 'x-deft-audit-token': 'audit-secret' } });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  process.env.NODE_ENV = oldNodeEnv;
  if (oldBypassToken === undefined) delete process.env.DEFT_AUDIT_BYPASS_TOKEN;
  else process.env.DEFT_AUDIT_BYPASS_TOKEN = oldBypassToken;
  if (oldDefaultLimit === undefined) delete process.env.DEFT_DEFAULT_RATE_LIMIT_PER_MINUTE;
  else process.env.DEFT_DEFAULT_RATE_LIMIT_PER_MINUTE = oldDefaultLimit;
});

test('audit bypass token is ignored in production', async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldBypassToken = process.env.DEFT_AUDIT_BYPASS_TOKEN;
  const oldDefaultLimit = process.env.DEFT_DEFAULT_RATE_LIMIT_PER_MINUTE;

  process.env.NODE_ENV = 'production';
  process.env.DEFT_AUDIT_BYPASS_TOKEN = 'audit-secret-prod';
  process.env.DEFT_DEFAULT_RATE_LIMIT_PER_MINUTE = '1';

  const { defaultLimiter } = await import(`../src/middleware/rate-limit.js?audit-prod=${Date.now()}`);
  const app = new Hono();
  app.use('*', defaultLimiter);
  app.get('/ok', (c) => c.json({ ok: true }));

  const first = await app.request('/ok', { headers: { 'x-deft-audit-token': 'audit-secret-prod' } });
  const second = await app.request('/ok', { headers: { 'x-deft-audit-token': 'audit-secret-prod' } });

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);

  process.env.NODE_ENV = oldNodeEnv;
  if (oldBypassToken === undefined) delete process.env.DEFT_AUDIT_BYPASS_TOKEN;
  else process.env.DEFT_AUDIT_BYPASS_TOKEN = oldBypassToken;
  if (oldDefaultLimit === undefined) delete process.env.DEFT_DEFAULT_RATE_LIMIT_PER_MINUTE;
  else process.env.DEFT_DEFAULT_RATE_LIMIT_PER_MINUTE = oldDefaultLimit;
});
