import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

for (const [name, configured, peer] of [
  ['direct', '', '10.0.0.7'],
] as const) {
  test(`general limiter: ${name} peer`, async () => {
    process.env.DEFT_AUTH_RATE_LIMIT_PER_MINUTE = '1';
    process.env.DEFT_INVITE_TRUSTED_PROXIES = configured;
    const { authLimiter } = await import('../src/middleware/rate-limit.js');
    const app = new Hono();
    app.use('*', authLimiter);
    app.get('/', c => c.text('ok'));
    const send = (client: string) => app.fetch(new Request('http://api.test/', {
      headers: { 'x-forwarded-for': client, 'x-real-ip': client },
    }), { incoming: { socket: { remoteAddress: peer } } });
    assert.equal((await send('198.51.100.1')).status, 200);
    assert.equal((await send('198.51.100.2')).status, 429);
    assert.equal((await send('198.51.100.1')).status, 429);
    delete process.env.DEFT_AUTH_RATE_LIMIT_PER_MINUTE;
    delete process.env.DEFT_INVITE_TRUSTED_PROXIES;
  });
}
