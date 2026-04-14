/**
 * Phase 8 — wizard submission route tests.
 *
 * Covers:
 *   1. GET  /wizard-config      — returns templates + packs + providers
 *   2. POST /start (byo happy)  — inserts employee + enqueues provisioning
 *   3. POST /start (byo missing fields) → 400
 *   4. POST /start (deft_cloud) → 400 COMING_SOON
 *   5. POST /start (trigger conflict) → 409
 *   6. GET  /:id/status         — returns employee + provider_instance
 *   7. POST /:id/handshake happy (mocked fetch) → success + flip to connected
 *   8. POST /:id/handshake HTTP 500 → error
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

process.env.RAILWAY_OAUTH_CLIENT_ID = 'client-test';
process.env.RAILWAY_OAUTH_CLIENT_SECRET = 'secret-test';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = 'test-deploy-wizard-user';
const USER_EMAIL = 'deploy-wizard@test.local';

let testApp: Hono | null = null;
let testEmployeeId: string | null = null;
let conflictEmployeeId: string | null = null;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function seedFixtures() {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Deploy Wizard User', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, USER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'owner', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_ID],
    );

    // Seed a conflict employee that already owns cron:standup so we can
    // verify the uniqueness guard fires.
    conflictEmployeeId = `test-conflict-emp-${Date.now()}`;
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         kind, connection_status, is_active, created_by, trigger_subscriptions)
       VALUES ($1, $2, $3, 'Conflict Existing Emp', 'conflict-pm',
         'project_manager', 'test', 'standard',
         'openclaw', 'connected', true, $3, ARRAY['cron:standup'])`,
      [conflictEmployeeId, ORG_ID, USER_ID],
    );
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    // Order matters: break circular FK between agent_employees and
    // provider_instances before deleting either.
    await c.query(
      `UPDATE agent_employees SET provider_instance_id = NULL
       WHERE org_id = $1 AND slug IN ('byo-wizard-test', 'conflict-pm')`,
      [ORG_ID],
    );
    await c.query(
      `DELETE FROM provider_instances WHERE org_id = $1`,
      [ORG_ID],
    );
    await c.query(
      `DELETE FROM job_queue WHERE name = 'deploy-provision'`,
    );
    // Collect shadow user ids spawned by /start before deleting the employees.
    const shadowRows = await c.query(
      `SELECT user_id FROM agent_employees
       WHERE org_id = $1 AND slug IN ('byo-wizard-test', 'conflict-pm')`,
      [ORG_ID],
    );
    // Filter out the test user itself — we only want to delete the
    // auto-generated shadow users, not our seeded wizard user.
    const shadowIds = shadowRows.rows
      .map((r) => r.user_id)
      .filter((u) => u !== USER_ID);
    await c.query(
      `DELETE FROM agent_employees WHERE org_id = $1 AND slug IN ('byo-wizard-test', 'conflict-pm')`,
      [ORG_ID],
    );
    if (shadowIds.length > 0) {
      await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [shadowIds]);
    }
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
  });
}

before(async () => {
  await seedFixtures();
  const { agentDeployRoutes } = await import('../src/routes/agent-deploy.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', { id: USER_ID, email: USER_EMAIL, org_id: ORG_ID } as any);
    await next();
  });
  testApp.route('/api/agents/deploy', agentDeployRoutes);
});

after(async () => {
  await teardownFixtures();
});

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

test('GET /wizard-config returns templates + packs + providers', async () => {
  const res = await app().request('/api/agents/deploy/wizard-config');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.templates));
  assert.ok(Array.isArray(body.capability_packs));
  assert.ok(Array.isArray(body.providers));
  const alex = body.templates.find((t: any) => t.slug === 'alex-pm');
  assert.ok(alex, 'alex-pm card should be present');
  assert.equal(alex.ready_in_phase_8, true);
  assert.ok(alex.default_capability_packs.includes('deft-workspace'));
  const byo = body.providers.find((p: any) => p.id === 'byo');
  assert.ok(byo && byo.isAvailable);
  const deftCloud = body.providers.find((p: any) => p.id === 'deft_cloud');
  assert.ok(deftCloud && deftCloud.comingSoon);
});

test('POST /start byo happy path inserts employee + enqueues provision job', async () => {
  const res = await app().request('/api/agents/deploy/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template_slug: 'alex-pm',
      name: 'BYO Wizard Test',
      slug: 'byo-wizard-test',
      capability_packs: ['deft-workspace', 'web-browsing'],
      provider: 'byo',
      byo_connection_url: 'http://host.docker.internal:18789',
      byo_gateway_token: 'gw-token-raw',
      trigger_subscriptions: [],
      trust_level: 'standard',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.employee_id);
  testEmployeeId = body.employee_id;

  // Verify employee row exists with pending status
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT kind, deployment_provider, connection_status, connection_url, capability_packs
       FROM agent_employees WHERE id = $1`,
      [body.employee_id],
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].kind, 'openclaw');
    assert.equal(r.rows[0].deployment_provider, 'byo');
    assert.equal(r.rows[0].connection_status, 'pending');
    assert.equal(r.rows[0].connection_url, 'http://host.docker.internal:18789');
    assert.ok((r.rows[0].capability_packs as string[]).includes('web-browsing'));

    // Verify the deploy-provision job was enqueued
    const jobs = await c.query(
      `SELECT name FROM job_queue WHERE name = 'deploy-provision' ORDER BY created_at DESC LIMIT 1`,
    );
    assert.equal(jobs.rows[0].name, 'deploy-provision');
  });
});

test('POST /start byo missing connection_url returns 400', async () => {
  const res = await app().request('/api/agents/deploy/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template_slug: 'alex-pm',
      name: 'Missing',
      slug: 'byo-missing',
      capability_packs: [],
      provider: 'byo',
      trigger_subscriptions: [],
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error ?? body.code ?? '', /BYO|MISSING/);
});

test('POST /start deft_cloud returns 400 COMING_SOON', async () => {
  const res = await app().request('/api/agents/deploy/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template_slug: 'alex-pm',
      name: 'DC',
      slug: 'dc-test',
      capability_packs: [],
      provider: 'deft_cloud',
      trigger_subscriptions: [],
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'COMING_SOON');
});

test('POST /start conflicting trigger returns 409', async () => {
  const res = await app().request('/api/agents/deploy/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template_slug: 'alex-pm',
      name: 'Conflicting',
      slug: 'conflict-new',
      capability_packs: [],
      provider: 'byo',
      byo_connection_url: 'http://localhost:18789',
      byo_gateway_token: 'gw',
      trigger_subscriptions: ['cron:standup'],
    }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'TRIGGER_CONFLICT');
});

test('GET /:id/status returns pending employee row', async () => {
  if (!testEmployeeId) throw new Error('no test employee');
  const res = await app().request(`/api/agents/deploy/${testEmployeeId}/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.employee.connection_status, 'pending');
});

test('POST /:id/handshake happy path flips status to connected', async () => {
  if (!testEmployeeId) throw new Error('no test employee');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ data: [{ id: 'default', object: 'model' }, { id: 'openclaw/byo-wizard-test', object: 'model' }] }),
      { status: 200 },
    )) as any;
  try {
    const res = await app().request(`/api/agents/deploy/${testEmployeeId}/handshake`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    // DB now reflects connected
    await withClient(async (c) => {
      const r = await c.query(
        `SELECT connection_status FROM agent_employees WHERE id = $1`,
        [testEmployeeId],
      );
      assert.equal(r.rows[0].connection_status, 'connected');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /:id/handshake HTTP 500 marks error', async () => {
  if (!testEmployeeId) throw new Error('no test employee');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as any;
  try {
    const res = await app().request(`/api/agents/deploy/${testEmployeeId}/handshake`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, false);
    await withClient(async (c) => {
      const r = await c.query(
        `SELECT connection_status, connection_error FROM agent_employees WHERE id = $1`,
        [testEmployeeId],
      );
      assert.equal(r.rows[0].connection_status, 'error');
      assert.ok(r.rows[0].connection_error);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
