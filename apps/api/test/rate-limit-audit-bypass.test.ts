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

test('production default app limiter allows normal chatty UI bursts', async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldDefaultLimit = process.env.DEFT_DEFAULT_RATE_LIMIT_PER_MINUTE;

  process.env.NODE_ENV = 'production';
  delete process.env.DEFT_DEFAULT_RATE_LIMIT_PER_MINUTE;

  const { defaultLimiter } = await import(`../src/middleware/rate-limit.js?default-budget=${Date.now()}`);
  const app = new Hono();
  app.use('*', defaultLimiter);
  app.get('/ok', (c) => c.json({ ok: true }));

  for (let i = 0; i < 120; i += 1) {
    const res = await app.request('/ok', { headers: { 'x-forwarded-for': '203.0.113.42' } });
    assert.equal(res.status, 200, `request ${i + 1} should not be rate-limited`);
  }

  process.env.NODE_ENV = oldNodeEnv;
  if (oldDefaultLimit === undefined) delete process.env.DEFT_DEFAULT_RATE_LIMIT_PER_MINUTE;
  else process.env.DEFT_DEFAULT_RATE_LIMIT_PER_MINUTE = oldDefaultLimit;
});

test('agent channel limiter isolates credentials that share one public IP', async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldChannelLimit = process.env.DEFT_AGENT_CHANNEL_RATE_LIMIT_PER_MINUTE;

  process.env.NODE_ENV = 'production';
  process.env.DEFT_AGENT_CHANNEL_RATE_LIMIT_PER_MINUTE = '2';

  const { agentChannelLimiter } = await import(`../src/middleware/rate-limit.js?channel-isolation=${Date.now()}`);
  const app = new Hono();
  app.use('*', agentChannelLimiter);
  app.get('/ok', (c) => c.json({ ok: true }));

  const sharedIp = '203.0.113.55';
  for (let i = 0; i < 2; i += 1) {
    const res = await app.request('/ok', {
      headers: { authorization: 'Bearer employee-one', 'x-forwarded-for': sharedIp },
    });
    assert.equal(res.status, 200);
  }
  const limited = await app.request('/ok', {
    headers: { authorization: 'Bearer employee-one', 'x-forwarded-for': sharedIp },
  });
  assert.equal(limited.status, 429);

  const otherEmployee = await app.request('/ok', {
    headers: { authorization: 'Bearer employee-two', 'x-forwarded-for': sharedIp },
  });
  assert.equal(otherEmployee.status, 200, 'another channel credential must keep its own budget');

  process.env.NODE_ENV = oldNodeEnv;
  if (oldChannelLimit === undefined) delete process.env.DEFT_AGENT_CHANNEL_RATE_LIMIT_PER_MINUTE;
  else process.env.DEFT_AGENT_CHANNEL_RATE_LIMIT_PER_MINUTE = oldChannelLimit;
});

test('production agent channel budget covers polling plus normal event bursts', async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldChannelLimit = process.env.DEFT_AGENT_CHANNEL_RATE_LIMIT_PER_MINUTE;

  process.env.NODE_ENV = 'production';
  delete process.env.DEFT_AGENT_CHANNEL_RATE_LIMIT_PER_MINUTE;

  const { agentChannelLimiter } = await import(`../src/middleware/rate-limit.js?channel-budget=${Date.now()}`);
  const app = new Hono();
  app.use('*', agentChannelLimiter);
  app.get('/ok', (c) => c.json({ ok: true }));

  for (let i = 0; i < 90; i += 1) {
    const res = await app.request('/ok', {
      headers: { authorization: 'Bearer normal-channel-runtime' },
    });
    assert.equal(res.status, 200, `request ${i + 1} should fit the normal channel budget`);
  }

  process.env.NODE_ENV = oldNodeEnv;
  if (oldChannelLimit === undefined) delete process.env.DEFT_AGENT_CHANNEL_RATE_LIMIT_PER_MINUTE;
  else process.env.DEFT_AGENT_CHANNEL_RATE_LIMIT_PER_MINUTE = oldChannelLimit;
});
