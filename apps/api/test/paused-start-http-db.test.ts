/**
 * Paused start (DEFT_PAUSED_START=true): every request that could change
 * something is refused with 503 PAUSED before routing, on every route, except
 * login, token refresh and logout. Reads and health keep working. With the
 * setting off, the same requests behave as before.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { _setPausedStartForTest, isRefusedWhilePaused } from '../src/lib/paused-start.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const RUN = crypto.randomUUID();
const ORG_ID = crypto.randomUUID();
const USER_ID = `paused-start-${RUN}`;
const EMAIL = `paused-start-${RUN}@test.local`;
const PASSWORD = 'paused-start-password';

type App = typeof import('../src/index.js')['app'];
let app: App;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

before(async () => {
  const hash = await bcrypt.hash(PASSWORD, 4);
  await withClient(async (c) => {
    await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'paused-start-org', $2) ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, `paused-start-${ORG_ID.slice(0, 8)}`]);
    await c.query(`INSERT INTO users (id, email, name, password_hash, email_verified) VALUES ($1, $2, 'Paused Start', $3, true)
      ON CONFLICT (id) DO NOTHING`, [USER_ID, EMAIL, hash]);
    await c.query(`INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'owner')
      ON CONFLICT (org_id, user_id) DO NOTHING`, [crypto.randomUUID(), ORG_ID, USER_ID]);
  });
  ({ app } = await import('../src/index.js'));
});

afterEach(() => _setPausedStartForTest(false));

after(async () => {
  _setPausedStartForTest(false);
  await withClient(async (c) => {
    await c.query('DELETE FROM web_sessions WHERE user_id = $1', [USER_ID]);
    await c.query('DELETE FROM org_members WHERE user_id = $1', [USER_ID]);
    await c.query('DELETE FROM users WHERE id = $1', [USER_ID]);
    await c.query('DELETE FROM orgs WHERE id = $1', [ORG_ID]);
  });
  const { closeDb } = await import('../src/lib/db.js');
  await closeDb();
});

const json = (body: unknown, token?: string): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

async function login(): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await app.request('/api/auth/login', json({ email: EMAIL, password: PASSWORD }));
  assert.equal(res.status, 200, 'login must work');
  return await res.json() as { accessToken: string; refreshToken: string };
}

test('the refusal rule: writes refused everywhere except login, refresh, logout and health', () => {
  _setPausedStartForTest(true);
  for (const [method, path] of [
    ['POST', '/api/tasks'], ['PATCH', '/api/tasks/x'], ['DELETE', '/api/files/x'], ['PUT', '/api/wiki/x'],
    ['POST', '/api/mcp/v1'], ['POST', '/api/mcp/hermes/v1'], ['POST', '/mcp/tools/call'], ['POST', '/oauth/token'],
    ['POST', '/api/webhooks/github'], ['POST', '/api/agent-webhooks/slug'], ['POST', '/api/agent-channel/v1/events/ack'],
    ['POST', '/api/app-runtime/channel/x'], ['POST', '/api/upload/presign'], ['POST', '/api/auth/signup'],
    ['POST', '/api/auth/reset-password'], ['PATCH', '/api/auth/password'], ['POST', '/api/invites/accept/x'],
  ] as const) assert.equal(isRefusedWhilePaused(method, path), true, `${method} ${path}`);
  for (const [method, path] of [
    ['GET', '/api/tasks'], ['HEAD', '/api/tasks'], ['OPTIONS', '/api/tasks'], ['POST', '/api/auth/login'],
    ['POST', '/api/auth/refresh'], ['POST', '/api/auth/logout'], ['POST', '/api/auth/login/'], ['GET', '/health'],
  ] as const) assert.equal(isRefusedWhilePaused(method, path), false, `${method} ${path}`);
  _setPausedStartForTest(false);
  assert.equal(isRefusedWhilePaused('POST', '/api/tasks'), false);
});

test('paused: ordinary and MCP writes get 503 PAUSED; login, refresh, logout and reads work; health says paused', async () => {
  _setPausedStartForTest(true);
  const { accessToken, refreshToken } = await login();

  for (const [path, init] of [
    ['/api/tasks', json({ title: 'x' }, accessToken)],
    ['/api/mcp/v1', json({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'not-a-token')],
    ['/mcp/tools/call', json({ name: 'x' }, 'not-a-token')],
    ['/oauth/token', json({ grant_type: 'refresh_token' })],
  ] as const) {
    const res = await app.request(path, init);
    assert.equal(res.status, 503, path);
    assert.deepEqual(Object.keys(await res.json()).sort(), ['code', 'error']);
  }
  const patched = await app.request('/api/auth/me', { ...json({ name: 'x' }, accessToken), method: 'PATCH' });
  assert.equal((await patched.json()).code, 'PAUSED');

  const me = await app.request('/api/auth/me', { headers: { Authorization: `Bearer ${accessToken}` } });
  assert.equal(me.status, 200, 'reads keep working');

  const refreshed = await app.request('/api/auth/refresh', json({ refreshToken }));
  assert.equal(refreshed.status, 200, 'refresh must work');
  const rotated = await refreshed.json() as { refreshToken: string };
  const loggedOut = await app.request('/api/auth/logout', json({ refreshToken: rotated.refreshToken }));
  assert.equal(loggedOut.status, 200, 'logout must work');

  const health = await app.request('/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).paused, true);
  const ready = await app.request('/health/ready');
  assert.equal((await ready.json()).paused, true);
});

test('not paused: the same requests reach their routes and health says not paused', async () => {
  _setPausedStartForTest(false);
  const { accessToken } = await login();
  const task = await app.request('/api/tasks', json({}, accessToken));
  assert.notEqual(task.status, 503);
  assert.notEqual((await task.json()).code, 'PAUSED');
  const mcp = await app.request('/api/mcp/v1', json({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'not-a-token'));
  assert.equal(mcp.status, 401);
  assert.equal((await (await app.request('/health')).json()).paused, false);
});
