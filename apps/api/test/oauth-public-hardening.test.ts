import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';

process.env.DEFT_OAUTH_PUBLIC_RATE_LIMIT_PER_MINUTE = '5';

const { oauthPublicRoutes } = await import('../src/routes/oauth-mcp.js');
const { connectionRoutes } = await import('../src/routes/connections.js');

function appFor(routes: Hono, prefix: string) {
  const app = new Hono();
  app.route(prefix, routes);
  return app;
}

const oauth = appFor(oauthPublicRoutes, '/oauth');

async function json(path: string, body: unknown, forwardedFor = '198.51.100.1') {
  return oauth.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
    body: JSON.stringify(body),
  });
}

test('public OAuth rejects oversized and non-scalar input with structured errors', async () => {
  const oversized = await oauth.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '70000' },
    body: JSON.stringify({ client_name: 'x'.repeat(70_000), redirect_uris: ['http://localhost/callback'] }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json() as any).error, 'invalid_request');

  const cases: Array<[string, unknown]> = [
    ['/oauth/register', null],
    ['/oauth/register', { redirect_uris: { callback: 'http://localhost/callback' }, software_id: 'extension-is-ignored' }],
    ['/oauth/token', { grant_type: ['authorization_code'], client_id: 'client' }],
    ['/oauth/token', { grant_type: 'refresh_token', client_id: {}, refresh_token: ['token'] }],
    ['/oauth/revoke', { token: { nested: 'token' } }],
  ];
  for (const [path, body] of cases) {
    const response = await json(path, body);
    assert.equal(response.status, 400, `${path} accepted ${JSON.stringify(body)}`);
    const payload = await response.json() as { error?: string; error_description?: string };
    assert.match(payload.error ?? '', /invalid_(request|client_metadata)/);
    assert.equal(typeof payload.error_description, 'string');
  }
});

test('public OAuth global budget cannot be bypassed with forged forwarded IPs', async () => {
  const response = await json('/oauth/revoke', { client_id: 'legitimate-public-client', extension: true }, '203.0.113.250');
  assert.equal(response.status, 429);
  assert.equal((await response.json() as any).error, 'temporarily_unavailable');
});

test('native provider connect and callback are unavailable before any exchange', async () => {
  const connections = appFor(connectionRoutes, '/api/connections');
  const originalFetch = globalThis.fetch;
  let exchanges = 0;
  globalThis.fetch = (async () => {
    exchanges += 1;
    throw new Error('provider exchange must not run');
  }) as typeof fetch;
  try {
    for (const [path, method] of [
      ['/api/connections/github/connect', 'POST'],
      ['/api/connections/github/callback?code=attacker&state=unsigned', 'GET'],
    ] as const) {
      const response = await connections.request(path, { method });
      assert.equal(response.status, 404);
      assert.equal((await response.json() as any).code, 'NOT_FOUND');
    }
    assert.equal(exchanges, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
