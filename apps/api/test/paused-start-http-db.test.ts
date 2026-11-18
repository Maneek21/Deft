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
const AGENT_USER_ID = `paused-start-agent-${RUN}`;
const EMPLOYEE_ID = crypto.randomUUID();
const EVENT_ID = crypto.randomUUID();

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
    await c.query(`INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, 'Paused agent', 'agent', true, true)`,
      [AGENT_USER_ID, `${AGENT_USER_ID}@agents.test`]);
    await c.query(`INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
      VALUES ($1, $2, $3, 'Paused agent', $4, 'project_manager', 'Fixture', 'conservative', true, true, $5)`,
      [EMPLOYEE_ID, ORG_ID, AGENT_USER_ID, `paused-agent-${EMPLOYEE_ID.slice(0, 8)}`, USER_ID]);
    await c.query(`INSERT INTO agent_channel_events (id, org_id, agent_employee_id, kind, idempotency_key)
      VALUES ($1, $2, $3, 'message.created', $1)`, [EVENT_ID, ORG_ID, EMPLOYEE_ID]);
  });
  ({ app } = await import('../src/index.js'));
});

afterEach(() => _setPausedStartForTest(false));

after(async () => {
  _setPausedStartForTest(false);
  await withClient(async (c) => {
    await c.query('DELETE FROM agent_channel_events WHERE id = $1', [EVENT_ID]);
    await c.query('DELETE FROM agent_employees WHERE id = $1', [EMPLOYEE_ID]);
    await c.query('DELETE FROM web_sessions WHERE user_id = $1', [USER_ID]);
    await c.query('DELETE FROM onboarding_state WHERE user_id = $1', [USER_ID]);
    await c.query('DELETE FROM org_members WHERE user_id = $1', [USER_ID]);
    await c.query('DELETE FROM users WHERE id IN ($1, $2)', [USER_ID, AGENT_USER_ID]);
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
    ['GET', '/api/agent-channel/v1/events'], ['GET', '/api/agent-channel/v1/connect'], ['HEAD', '/api/agent-channel/v1/events'],
    ['GET', '/api/ics/my-feed-url'], ['GET', '/api/ics/feed/token'], ['HEAD', '/api/ics/feed/token'],
    ['GET', '/api/attention'], ['GET', '/api/members'], ['GET', '/api/agent/conversations'],
    ['GET', '/api/spaces/x/canvas'], ['HEAD', '/api/spaces/x/canvas/'],
  ] as const) assert.equal(isRefusedWhilePaused(method, path), true, `${method} ${path}`);
  for (const [method, path] of [
    ['GET', '/api/tasks'], ['HEAD', '/api/tasks'], ['OPTIONS', '/api/tasks'], ['POST', '/api/auth/login'],
    ['POST', '/api/auth/refresh'], ['POST', '/api/auth/logout'], ['POST', '/api/auth/login/'], ['GET', '/health'],
    ['GET', '/api/agent-channel/v1/contract'], ['OPTIONS', '/api/agent-channel/v1/events'], ['GET', '/api/ics/subscriptions'],
    ['GET', '/api/auth/onboarding'], ['GET', '/api/members/directory'],
  ] as const) assert.equal(isRefusedWhilePaused(method, path), false, `${method} ${path}`);
  _setPausedStartForTest(false);
  assert.equal(isRefusedWhilePaused('POST', '/api/tasks'), false);
});

test('the paused reason reaches only signed-in people, through GET /api/auth/me', async () => {
  const { accessToken } = await login();
  const me = async (token?: string) => app.request('/api/auth/me', token ? { headers: { Authorization: `Bearer ${token}` } } : {});

  // Not paused: the session response is unchanged (no paused field).
  const live = await me(accessToken);
  assert.equal(live.status, 200);
  assert.equal('paused' in (await live.json()), false);

  for (const reason of ['restore_review', 'billing'] as const) {
    _setPausedStartForTest(true, reason);
    const res = await me(accessToken);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).paused, { reason });

    // Signed out or with a bad token: no reason, and no public route names it.
    for (const token of [undefined, 'not-a-token']) {
      const anon = await me(token);
      assert.equal(anon.status, 401);
      assert.doesNotMatch(await anon.text(), /restore_review|billing/);
    }
    for (const path of ['/health', '/health/ready']) {
      assert.doesNotMatch(await (await app.request(path)).text(), /restore_review|billing|reason/, path);
    }
    const refused = await app.request('/api/tasks', json({ title: 'x' }));
    assert.equal(refused.status, 503);
    assert.doesNotMatch(await refused.text(), /restore_review|billing|reason/);
  }
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

test('paused: an owner or admin can still finish a two-step sign-in; two-step security changes are refused', async () => {
  const { ensureTwoStepTables } = await import('./fixtures/two-step-tables.js');
  await ensureTwoStepTables(DATABASE_URL);
  const { encrypt } = await import('../src/lib/encryption.js');
  const { generateTwoStepSecret, twoStepCodeForStep, twoStepStepAt } = await import('../src/lib/two-step.js');
  const hash = await bcrypt.hash(PASSWORD, 4);
  const enrolledId = `paused-two-step-${RUN}`;
  const newAdminId = `paused-two-step-new-${RUN}`;
  const secret = generateTwoStepSecret();
  const hostedBefore = process.env.DEFT_HOSTED;
  await withClient(async (c) => {
    for (const [id, role] of [[enrolledId, 'owner'], [newAdminId, 'admin']] as const) {
      await c.query(`INSERT INTO users (id, email, name, password_hash, email_verified) VALUES ($1, $2, 'Two-step', $3, true)`, [id, `${id}@test.local`, hash]);
      await c.query(`INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)`, [crypto.randomUUID(), ORG_ID, id, role]);
    }
    await c.query(`INSERT INTO user_two_step (user_id, secret_encrypted, confirmed_at) VALUES ($1, $2, now() - interval '1 minute')`, [enrolledId, encrypt(secret)]);
  });
  const signIn = async (id: string) => {
    const res = await app.request('/api/auth/login', json({ email: `${id}@test.local`, password: PASSWORD }));
    assert.equal(res.status, 200);
    return (await res.json()) as { two_step: { status: string; token: string } };
  };
  try {
    _setPausedStartForTest(true);
    process.env.DEFT_HOSTED = 'true';

    // Enrolled: the password gives a challenge, the code gives a session.
    const first = await signIn(enrolledId);
    assert.equal(first.two_step.status, 'code_required');
    const verified = await app.request('/api/auth/two-step/verify',
      json({ challenge_token: first.two_step.token, code: twoStepCodeForStep(secret, twoStepStepAt(Date.now())) }));
    assert.equal(verified.status, 200, 'verify must work while paused');
    const session = await verified.json() as { accessToken: string };
    assert.equal((await app.request('/api/auth/me', { headers: { Authorization: `Bearer ${session.accessToken}` } })).status, 200);

    // A signed-in person cannot change two-step settings while paused.
    for (const path of ['/api/auth/two-step/enrol/start', '/api/auth/two-step/disable', '/api/auth/two-step/recovery-codes']) {
      const res = await app.request(path, json({ code: '000000', current_password: PASSWORD }, session.accessToken));
      assert.equal(res.status, 503, path);
      assert.equal((await res.json()).code, 'PAUSED', path);
    }

    // An admin who has not set it up yet can do so with the enrol-only token.
    const pending = await signIn(newAdminId);
    assert.equal(pending.two_step.status, 'enrolment_required');
    const started = await app.request('/api/auth/two-step/enrol/start', json({}, pending.two_step.token));
    assert.equal(started.status, 200);
    const { secret: newSecret } = await started.json() as { secret: string };
    const confirmed = await app.request('/api/auth/two-step/enrol/confirm',
      json({ code: twoStepCodeForStep(newSecret, twoStepStepAt(Date.now())) }, pending.two_step.token));
    assert.equal(confirmed.status, 200);
    const done = await confirmed.json() as { accessToken: string; recovery_codes: string[] };
    assert.equal(done.recovery_codes.length, 10);
    assert.equal((await app.request('/api/auth/me', { headers: { Authorization: `Bearer ${done.accessToken}` } })).status, 200);
  } finally {
    if (hostedBefore === undefined) delete process.env.DEFT_HOSTED; else process.env.DEFT_HOSTED = hostedBefore;
    await withClient(async (c) => {
      for (const id of [enrolledId, newAdminId]) {
        await c.query('DELETE FROM web_sessions WHERE user_id = $1', [id]);
        await c.query('DELETE FROM onboarding_state WHERE user_id = $1', [id]);
        await c.query('DELETE FROM org_members WHERE user_id = $1', [id]);
        await c.query('DELETE FROM users WHERE id = $1', [id]);
      }
    });
  }
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

async function eventRow() {
  return withClient(async (c) => (await c.query(
    `SELECT status, delivery_count, claim_token, claim_owner, claimed_at, lease_expires_at FROM agent_channel_events WHERE id = $1`,
    [EVENT_ID],
  )).rows[0]);
}

test('paused: an agent-channel poll gets 503 and the pending event is not handed out', async () => {
  _setPausedStartForTest(true);
  const before = await eventRow();
  assert.equal(before.status, 'pending');
  for (const path of ['/api/agent-channel/v1/events?worker_id=w', '/api/agent-channel/v1/connect?worker_id=w']) {
    const res = await app.request(path, { headers: { Authorization: 'Bearer any-restored-token' } });
    assert.equal(res.status, 503, path);
    assert.equal((await res.json()).code, 'PAUSED');
  }
  assert.deepEqual(await eventRow(), before, 'the event row changed while paused');
  const contract = await app.request('/api/agent-channel/v1/contract');
  assert.equal(contract.status, 200, 'the static contract stays readable');
});

test('paused: a GET that writes is refused (feed address, public feed); one left open still answers', async () => {
  _setPausedStartForTest(true);
  const { accessToken } = await login();
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
  const hasFeedTokens = await withClient(async (c) =>
    (await c.query(`SELECT to_regclass('public.ics_publish_tokens') IS NOT NULL AS ok`)).rows[0].ok as boolean);
  const countTokens = () => withClient(async (c) =>
    Number((await c.query('SELECT count(*)::int AS n FROM ics_publish_tokens WHERE user_id = $1', [USER_ID])).rows[0].n));
  const before = hasFeedTokens ? await countTokens() : 0;
  const mint = await app.request('/api/ics/my-feed-url', auth);
  assert.equal(mint.status, 503);
  if (hasFeedTokens) assert.equal(await countTokens(), before, 'a feed token was minted while paused');
  const feed = await app.request('/api/ics/feed/some-restored-token');
  assert.equal(feed.status, 503);
  const members = await app.request('/api/members/directory', auth);
  assert.equal(members.status, 200, 'a GET left open must still answer');
});

test('paused: shared-state GET writes are refused, personal onboarding bookkeeping stays open', async () => {
  _setPausedStartForTest(true);
  for (const path of ['/api/attention', '/api/agent/conversations', '/api/members', `/api/spaces/${crypto.randomUUID()}/canvas`]) {
    for (const method of ['GET', 'HEAD']) {
      const res = await app.request(path, { method });
      assert.equal(res.status, 503, `${method} ${path} must be refused before auth or handler writes`);
    }
  }
  const { accessToken } = await login();
  const onboarding = await app.request('/api/auth/onboarding', { headers: { Authorization: `Bearer ${accessToken}` } });
  assert.equal(onboarding.status, 200);
  assert.equal((await onboarding.json()).user_id, USER_ID);
});

test('paused: live source resolution and adapter initialization are refused before journals or factories', async () => {
  _setPausedStartForTest(true);
  for (const path of ['/api/app-owner-connections/example/connections', '/api/app-integrations/knowledge/source/example',
    '/api/app-integrations/destinations/status/example', '/api/app-integrations/destinations/source/example',
    '/api/app-integrations/destinations/attention/source/example', '/api/app-integrations/destinations/calendar/status/example',
    '/api/email-adoption/source/example']) {
    for (const method of ['GET', 'HEAD']) {
      const res = await app.request(path, { method });
      assert.equal(res.status, 503, `${method} ${path}`);
      if (method === 'GET') assert.equal((await res.json()).code, 'PAUSED');
    }
  }
});
