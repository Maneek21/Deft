import { test } from 'node:test';
import assert from 'node:assert/strict';

// The invite routes are public and mounted before the default limiter, so
// they carry their own per-IP limiter. Use a small budget for this process.
process.env.DEFT_INVITE_RATE_LIMIT_PER_MINUTE = '3';

test('public invite routes are rate limited per IP', async () => {
  const { app } = await import('../src/index.js');
  const from = (ip: string, path: string, method = 'POST') => app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
  });

  const ip = '198.51.100.7';
  // Preview, legacy preview and accept share the one budget.
  assert.equal((await from(ip, '/api/invites/preview')).status, 400);
  assert.equal((await from(ip, '/api/invites/preview/not-a-token', 'GET')).status, 400);
  assert.equal((await from(ip, '/api/invites/accept')).status, 400);
  for (const [path, method] of [['/api/invites/preview', 'POST'], ['/api/invites/accept', 'POST'], ['/api/invites/preview/x', 'GET']] as const) {
    const limited = await from(ip, path, method);
    assert.equal(limited.status, 429, path);
    assert.equal((await limited.json() as Record<string, unknown>).code, 'RATE_LIMITED');
  }

  // Another address keeps its own budget.
  assert.equal((await from('198.51.100.8', '/api/invites/preview')).status, 400);
});
