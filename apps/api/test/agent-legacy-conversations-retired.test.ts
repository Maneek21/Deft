/**
 * W1-a — the legacy `/api/agent/conversations*` agent-running and write
 * routes are retired; chat (spaces/messages + agent-reply worker) is the only
 * agent conversation surface. Read-only listing/export routes stay, limited to
 * agent conversations the caller belongs to in their own org. The org trust
 * level is owner/admin-only.
 *
 * Each test is named after the audit ID it closes (see
 * docs/superpowers/audits/2026-11-10-defty-rebaseline.md).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const DATABASE_URL = safeTestDatabaseUrl();
if (!DATABASE_URL) throw new Error('Legacy conversation route tests require a safe test database');

const run = randomUUID().slice(0, 8);
const ORG_A = `w1a-org-a-${run}`;
const ORG_B = `w1a-org-b-${run}`;
const OWNER = `w1a-owner-${run}`;
const MEMBER = `w1a-member-${run}`;
const COLLEAGUE = `w1a-colleague-${run}`;
const OUTSIDER_B = `w1a-b-user-${run}`;
const DM_SPACE = `w1a-dm-${run}`;
const CHANNEL = `w1a-channel-${run}`;
const DEFTY_CONVO = `w1a-defty-convo-${run}`;
const DEFTY_CONVO_B = `w1a-defty-convo-b-${run}`;

let deftyUserId = '';
let orgAEmployeeId = '';
let actor: { id: string; org_id: string; role: string } = { id: MEMBER, org_id: ORG_A, role: 'member' };
let testApp: Hono | null = null;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

function as(user: typeof actor) { actor = user; }
const member = { id: MEMBER, org_id: ORG_A, role: 'member' };
const owner = { id: OWNER, org_id: ORG_A, role: 'owner' };

async function request(path: string, method = 'GET', body?: unknown) {
  return app().request(`/api/agent${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  });
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return withClient(async (c) => Number((await c.query(sql, params)).rows[0].n));
}

before(async () => {
  await withClient(async (c) => {
    await c.query(`INSERT INTO orgs (id, name, slug, trust_level) VALUES ($1, 'W1a A', $2, 'conservative'), ($3, 'W1a B', $4, 'conservative')`,
      [ORG_A, `w1a-a-${run}`, ORG_B, `w1a-b-${run}`]);
    for (const [id, name] of [[OWNER, 'Owner'], [MEMBER, 'Member'], [COLLEAGUE, 'Colleague'], [OUTSIDER_B, 'Org B user']]) {
      await c.query(`INSERT INTO users (id, email, name, kind, is_agent) VALUES ($1, $2, $3, 'human', false)`,
        [id, `${id}@w1a.test`, name]);
    }
    for (const [org, user, role] of [[ORG_A, OWNER, 'owner'], [ORG_A, MEMBER, 'member'], [ORG_A, COLLEAGUE, 'member'], [ORG_B, OUTSIDER_B, 'owner'], [ORG_B, MEMBER, 'member']]) {
      await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, true)`,
        [org, user, role]);
    }
  });

  const { ensureDeftyMembership, ensureDeftyEmployee } = await import('../src/lib/ensure-defty-membership.js');
  deftyUserId = await ensureDeftyMembership(ORG_A);
  await ensureDeftyMembership(ORG_B);
  // Only org A materialises its per-org Defty system employee (A14 setup).
  orgAEmployeeId = (await ensureDeftyEmployee(ORG_A)).employeeId;

  await withClient(async (c) => {
    await c.query(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES
      ($1, $5, 'member-colleague dm', 'dm', $6),
      ($2, $5, 'general', 'public', $7),
      ($3, $5, 'New conversation', 'agent_conversation', $6),
      ($4, $8, 'Org B Defty chat', 'agent_conversation', $6)`,
      [DM_SPACE, CHANNEL, DEFTY_CONVO, DEFTY_CONVO_B, ORG_A, MEMBER, OWNER, ORG_B]);
    const memberships: Array<[string, string]> = [
      [DM_SPACE, MEMBER], [DM_SPACE, COLLEAGUE],
      [CHANNEL, MEMBER], [CHANNEL, COLLEAGUE], [CHANNEL, OWNER],
      [DEFTY_CONVO, MEMBER], [DEFTY_CONVO, deftyUserId],
      [DEFTY_CONVO_B, MEMBER], [DEFTY_CONVO_B, deftyUserId],
    ];
    for (const [space, user] of memberships) {
      await c.query(`INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [space, user]);
    }
    await c.query(`INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES
      (gen_random_uuid()::text, $1, $2, $3, 'channel hello'),
      (gen_random_uuid()::text, $1, $4, $5, 'dm hello')`, [ORG_A, CHANNEL, OWNER, DM_SPACE, COLLEAGUE]);
    await c.query(`INSERT INTO messages (id, org_id, space_id, user_id, content, is_deleted) VALUES
      (gen_random_uuid()::text, $1, $2, $3, 'deleted channel secret', true)`, [ORG_A, CHANNEL, COLLEAGUE]);
    // A long Defty conversation (A13) with a user turn and a Defty reply.
    for (let i = 0; i < 60; i += 1) {
      await c.query(`INSERT INTO messages (id, org_id, space_id, user_id, content, created_at)
        VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW() - ($5 || ' seconds')::interval)`,
        [ORG_A, DEFTY_CONVO, i % 2 === 0 ? MEMBER : deftyUserId, `turn ${i}`, String(600 - i)]);
    }
  });

  const { agentRoutes } = await import('../src/routes/agent.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', { ...actor, email: `${actor.id}@w1a.test` } as never);
    await next();
  });
  testApp.route('/api/agent', agentRoutes);
});

after(async () => {
  await withClient(async (c) => {
    const orgs = [ORG_A, ORG_B];
    await c.query(`DELETE FROM agent_actions WHERE org_id = ANY($1)`, [orgs]);
    await c.query(`DELETE FROM messages WHERE org_id = ANY($1)`, [orgs]);
    await c.query(`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = ANY($1))`, [orgs]);
    await c.query(`DELETE FROM spaces WHERE org_id = ANY($1)`, [orgs]);
  }).catch(() => undefined);
});

async function assertRetired(res: Response) {
  assert.equal(res.status, 410);
  const body = await res.json() as { error: unknown; code: unknown };
  assert.equal(body.code, 'ENDPOINT_RETIRED');
  assert.equal(typeof body.error, 'string');
}

test('A01: legacy streaming message route cannot write into a human-human DM or speak as a colleague', async () => {
  as(member);
  const before = await count(`SELECT count(*) AS n FROM messages WHERE space_id = $1`, [DM_SPACE]);
  const colleagueBefore = await count(`SELECT count(*) AS n FROM messages WHERE space_id = $1 AND user_id = $2`, [DM_SPACE, COLLEAGUE]);
  await assertRetired(await request(`/conversations/${DM_SPACE}/messages`, 'POST', { content: 'pretend to be my colleague' }));
  await assertRetired(await request(`/conversations/${DM_SPACE}/continue`, 'POST'));
  assert.equal(await count(`SELECT count(*) AS n FROM messages WHERE space_id = $1`, [DM_SPACE]), before);
  assert.equal(await count(`SELECT count(*) AS n FROM messages WHERE space_id = $1 AND user_id = $2`, [DM_SPACE, COLLEAGUE]), colleagueBefore);
});

test('A01: read-only conversation routes refuse spaces that are not agent conversations', async () => {
  as(member);
  const messagesRes = await request(`/conversations/${CHANNEL}/messages`);
  assert.equal(messagesRes.status, 404);
  assert.equal(((await messagesRes.json()) as { code: string }).code, 'NOT_FOUND');
  const traceRes = await request(`/conversations/${CHANNEL}/trace.json`);
  assert.equal(traceRes.status, 404);
  assert.equal((await traceRes.text()).includes('deleted channel secret'), false);
  assert.equal((await request(`/conversations/${DM_SPACE}/messages`)).status, 404);
});

test('A02: legacy DELETE cannot archive a channel or soft-delete its messages', async () => {
  as(member);
  await assertRetired(await request(`/conversations/${CHANNEL}`, 'DELETE'));
  await assertRetired(await request(`/conversations/${DEFTY_CONVO}`, 'DELETE'));
  assert.equal(await count(`SELECT count(*) AS n FROM spaces WHERE id = ANY($1) AND is_archived = true`, [[CHANNEL, DEFTY_CONVO]]), 0);
  assert.equal(await count(`SELECT count(*) AS n FROM messages WHERE space_id = $1 AND is_deleted = true`, [CHANNEL]), 1);
});

test('W1a-N1 rename: legacy PATCH cannot rename a channel', async () => {
  as(member);
  await assertRetired(await request(`/conversations/${CHANNEL}`, 'PATCH', { title: 'renamed by a member' }));
  const name = await withClient(async (c) => (await c.query(`SELECT name FROM spaces WHERE id = $1`, [CHANNEL])).rows[0].name);
  assert.equal(name, 'general');
});

test('W1a-N2 unvalidated content: legacy message route stores nothing for a non-string body', async () => {
  as(member);
  const before = await count(`SELECT count(*) AS n FROM messages WHERE space_id = $1`, [DEFTY_CONVO]);
  await assertRetired(await request(`/conversations/${DEFTY_CONVO}/messages`, 'POST', { content: 42 }));
  await assertRetired(await request(`/conversations/${DEFTY_CONVO}/messages`, 'POST', 'not json'));
  assert.equal(await count(`SELECT count(*) AS n FROM messages WHERE space_id = $1`, [DEFTY_CONVO]), before);
});

test('W1a-N2 memory preload: no legacy route builds a streaming context from unscoped memories', async () => {
  as({ ...member, org_id: ORG_B });
  await assertRetired(await request(`/conversations/${DEFTY_CONVO_B}/messages`, 'POST', { content: 'what do you remember?' }));
  await assertRetired(await request(`/conversations/${DEFTY_CONVO_B}/continue`, 'POST'));
});

test('A11: the streaming tool loop is retired, so no streamed turn can end silently', async () => {
  await assert.rejects(import('../src/lib/agent-stream-loop.js' as string));
  as(member);
  await assertRetired(await request(`/conversations/${DEFTY_CONVO}/continue`, 'POST'));
});

test('A13: continuing a long Defty conversation does not load its unbounded history into a stream', async () => {
  as(member);
  const before = await count(`SELECT count(*) AS n FROM messages WHERE space_id = $1`, [DEFTY_CONVO]);
  await assertRetired(await request(`/conversations/${DEFTY_CONVO}/continue`, 'POST'));
  assert.equal(await count(`SELECT count(*) AS n FROM messages WHERE space_id = $1`, [DEFTY_CONVO]), before);
});

test('A14: conversation reads never resolve another org\'s Defty system employee', async () => {
  as({ ...member, org_id: ORG_B });
  const res = await request(`/conversations/${DEFTY_CONVO_B}`);
  assert.equal(res.status, 200);
  const body = await res.json() as { agent_employee_id: string | null };
  assert.notEqual(body.agent_employee_id, orgAEmployeeId);

  const listed = await request(`/conversations?employee=${encodeURIComponent(orgAEmployeeId)}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), []);
});

test('A14: creating a conversation rejects an agent employee from another org', async () => {
  as({ id: OUTSIDER_B, org_id: ORG_B, role: 'owner' });
  const before = await count(`SELECT count(*) AS n FROM spaces WHERE org_id = $1`, [ORG_B]);
  const res = await request('/conversations', 'POST', { agent_employee_id: orgAEmployeeId, title: 'borrow org A agent' });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { code: string }).code, 'NOT_FOUND');
  assert.equal(await count(`SELECT count(*) AS n FROM spaces WHERE org_id = $1`, [ORG_B]), before);
  assert.equal(await count(`SELECT count(*) AS n FROM space_members sm JOIN spaces s ON s.id = sm.space_id WHERE s.org_id = $1 AND sm.user_id = (SELECT user_id FROM agent_employees WHERE id = $2)`, [ORG_B, orgAEmployeeId]), 1,
    'only the global Defty user (org B member) may appear, never via org A\'s employee row');
});

test('W1a create: conversation create validates its body', async () => {
  as(member);
  const bad = await request('/conversations', 'POST', { title: 123 });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { code: string }).code, 'VALIDATION_ERROR');
  const ok = await request('/conversations', 'POST', { title: 'Planning with Defty' });
  assert.equal(ok.status, 201);
  const created = await ok.json() as { id: string };
  const space = await withClient(async (c) => (await c.query(`SELECT type, org_id, created_by FROM spaces WHERE id = $1`, [created.id])).rows[0]);
  assert.deepEqual(space, { type: 'agent_conversation', org_id: ORG_A, created_by: MEMBER });
});

test('W1a kept reads: a real Defty conversation still lists, reads and exports', async () => {
  as(member);
  const list = await (await request('/conversations')).json() as Array<{ id: string }>;
  assert.ok(list.some((row) => row.id === DEFTY_CONVO));
  const msgs = await request(`/conversations/${DEFTY_CONVO}/messages`);
  assert.equal(msgs.status, 200);
  const rows = await msgs.json() as Array<{ role: string; content: string }>;
  assert.equal(rows.find((row) => row.content === 'turn 0')?.role, 'user');
  assert.equal(rows.find((row) => row.content === 'turn 1')?.role, 'assistant');
  const trace = await request(`/conversations/${DEFTY_CONVO}/trace.json`);
  assert.equal(trace.status, 200);
  assert.equal(((await trace.json()) as { format: string }).format, 'deft.agent_trace.v1');
  as({ id: COLLEAGUE, org_id: ORG_A, role: 'member' });
  assert.equal((await request(`/conversations/${DEFTY_CONVO}/trace.json`)).status, 404);
  assert.equal((await request(`/conversations/${DEFTY_CONVO}/messages`)).status, 404);
});

test('E08: Continue with Defty cannot auto-execute writes under an autonomous org trust level', async () => {
  await withClient((c) => c.query(`UPDATE orgs SET trust_level = 'autonomous' WHERE id = $1`, [ORG_A]));
  try {
    as(member);
    const actionsBefore = await count(`SELECT count(*) AS n FROM agent_actions WHERE org_id = $1`, [ORG_A]);
    await assertRetired(await request(`/conversations/${DEFTY_CONVO}/continue`, 'POST'));
    await assertRetired(await request(`/conversations/${DEFTY_CONVO}/messages`, 'POST', { content: 'create a task called ship it' }));
    assert.equal(await count(`SELECT count(*) AS n FROM agent_actions WHERE org_id = $1`, [ORG_A]), actionsBefore);
  } finally {
    await withClient((c) => c.query(`UPDATE orgs SET trust_level = 'conservative' WHERE id = $1`, [ORG_A]));
  }
});

test('E02: member cannot change org trust level', async () => {
  as(member);
  const res = await request('/settings', 'PATCH', { trust_level: 'autonomous' });
  assert.equal(res.status, 403);
  const body = await res.json() as { error: unknown; code: unknown };
  assert.equal(body.code, 'FORBIDDEN');
  assert.equal(typeof body.error, 'string');
  const level = await withClient(async (c) => (await c.query(`SELECT trust_level FROM orgs WHERE id = $1`, [ORG_A])).rows[0].trust_level);
  assert.equal(level, 'conservative');
});

test('E02: a member whose session still claims admin is refused by current membership', async () => {
  as({ ...member, role: 'admin' });
  assert.equal((await request('/settings', 'PATCH', { trust_level: 'standard' })).status, 403);
});

test('E02: owner can change trust level; invalid bodies are rejected', async () => {
  as(owner);
  for (const bad of [{}, { trust_level: 'reckless' }, { trust_level: 'standard', extra: true }, 'not json']) {
    const res = await request('/settings', 'PATCH', bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(((await res.json()) as { code: string }).code, 'VALIDATION_ERROR');
  }
  const ok = await request('/settings', 'PATCH', { trust_level: 'standard' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { success: true, trust_level: 'standard' });
  const level = await withClient(async (c) => (await c.query(`SELECT trust_level FROM orgs WHERE id = $1`, [ORG_A])).rows[0].trust_level);
  assert.equal(level, 'standard');
  await withClient((c) => c.query(`UPDATE orgs SET trust_level = 'conservative' WHERE id = $1`, [ORG_A]));
});
