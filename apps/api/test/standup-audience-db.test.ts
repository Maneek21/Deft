/**
 * W2-a5a-2: the shared standup is readable by workspace members only when it
 * was built from content every member may read. A stored standup without that
 * record is returned only to owners/admins and to the user who requested it.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/standup-audience-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock, test } from 'node:test';
import pg from 'pg';

const emitted: Array<{ room: string; event: string; payload: any }> = [];
const actualSocket = await import('../src/socket.js');
mock.module(new URL('../src/socket.ts', import.meta.url).href, { namedExports: {
  ...actualSocket,
  getIO: () => ({
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); return true; },
    }),
  }),
} });
const actualRunner = await import('../src/lib/agent-runner.js');
mock.module(new URL('../src/lib/agent-runner.ts', import.meta.url).href, { namedExports: {
  ...actualRunner,
  runAgentQuery: async () => { throw new Error('standup tests must not call a model'); },
} });
const actualAiConfig = await import('../src/lib/org-ai-config.js');
mock.module(new URL('../src/lib/org-ai-config.ts', import.meta.url).href, { namedExports: {
  ...actualAiConfig,
  resolveReasonProvider: async () => ({ provider: 'anthropic', apiKey: null }),
} });

const { Hono } = await import('hono');
const { dashboardRoutes } = await import('../src/routes/dashboard.js');
const { generateDailyStandup } = await import('../src/lib/standup-automation.js');
const { standupRunKey, localClockAt } = await import('../src/lib/automation-schedule.js');

type Role = 'owner' | 'admin' | 'member';
type Fixture = { org: string; admin: string; member: string; requester: string; space: string; secret: string };

async function seed(c: pg.Client): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const org = randomUUID(), admin = randomUUID(), member = randomUUID(), requester = randomUUID(), space = randomUUID();
  await c.query(`INSERT INTO orgs(id,name,slug,timezone) VALUES($1,$1,$1,'UTC')`, [org]);
  for (const [id, role] of [[admin, 'admin'], [member, 'member'], [requester, 'member']] as const) {
    await c.query(`INSERT INTO users(id,email,name) VALUES($1,$1||'@test.local',$2)`, [id, `User ${tag}`]);
    await c.query(`INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)`, [randomUUID(), org, id, role]);
  }
  await c.query(`INSERT INTO spaces(id,org_id,name,type,is_default,created_by) VALUES($1,$2,'general','public',true,$3)`, [space, org, admin]);
  return { org, admin, member, requester, space, secret: `RESTRICTED-STANDUP-${tag}` };
}

async function cleanup(c: pg.Client, f: Fixture) {
  for (const sql of [
    'DELETE FROM messages WHERE org_id=$1',
    'DELETE FROM standups WHERE org_id=$1',
    'DELETE FROM automation_runs WHERE org_id=$1',
    'DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)',
    'DELETE FROM spaces WHERE org_id=$1',
    'DELETE FROM org_members WHERE org_id=$1',
    'DELETE FROM orgs WHERE id=$1',
  ]) {
    await c.query(sql, [f.org]).catch(() => undefined);
  }
  await c.query('DELETE FROM users WHERE id = ANY($1)', [[f.admin, f.member, f.requester]]).catch(() => undefined);
}

/** A standup stored without a record of being built for all workspace members. */
async function insertUnmarkedStandup(c: pg.Client, f: Fixture, generatedBy: string) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO standups(id,org_id,date,generated_by,summary,raw_data) VALUES($1,$2,NOW(),$3,$4,$5::jsonb)`,
    [id, f.org, generatedBy, `Done: ${f.secret}`, JSON.stringify({ status_changes: [{ title: f.secret }] })],
  );
  return id;
}

function app(f: Fixture, userId: string, role: Role) {
  const a = new Hono();
  a.use('*', async (ctx, next) => {
    ctx.set('user', { id: userId, email: `${userId}@test.local`, org_id: f.org, sid: 'sid', role });
    await next();
  });
  a.route('/api/dashboard', dashboardRoutes);
  return a;
}

async function dashboardStandup(f: Fixture, userId: string, role: Role) {
  const res = await app(f, userId, role).request('/api/dashboard?tz=UTC');
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { standup: { summary: string } | null }).standup;
}

test('W2-a5a-2: a stored standup without a members audience is not shown to members on the dashboard', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const f = await seed(c);
  try {
    await insertUnmarkedStandup(c, f, f.requester);
    const asMember = await dashboardStandup(f, f.member, 'member');
    assert.ok(!JSON.stringify(asMember ?? null).includes(f.secret), 'a member does not receive the stored standup');
    const asAdmin = await dashboardStandup(f, f.admin, 'admin');
    assert.ok(asAdmin?.summary.includes(f.secret), 'an admin still sees the stored standup');
    const asRequester = await dashboardStandup(f, f.requester, 'member');
    assert.ok(asRequester?.summary.includes(f.secret), 'the recorded requester still sees the stored standup');
  } finally {
    await cleanup(c, f); await c.end();
  }
});

test('W2-a5a-2: POST /standup does not hand a member a stored standup without a members audience', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const f = await seed(c);
  try {
    const standupId = await insertUnmarkedStandup(c, f, f.requester);
    const local = localClockAt(new Date(), 'UTC')!;
    await c.query(
      `INSERT INTO automation_runs(id,org_id,kind,idempotency_key,scheduled_for,status,context,result_entity_id)
       VALUES($1,$2,'standup',$3,NOW(),'delivered','{}'::jsonb,$4)`,
      [randomUUID(), f.org, standupRunKey(f.org, local.dateKey), standupId],
    );
    const res = await app(f, f.member, 'member').request('/api/dashboard/standup', { method: 'POST' });
    const text = await res.text();
    assert.ok(!text.includes(f.secret), `a member does not receive the stored standup: ${res.status}`);
    const asAdmin = await app(f, f.admin, 'admin').request('/api/dashboard/standup', { method: 'POST' });
    assert.equal(asAdmin.status, 200);
    assert.ok((await asAdmin.text()).includes(f.secret), 'an admin still receives it');
  } finally {
    await cleanup(c, f); await c.end();
  }
});

test('W2-a5a-2: a generated standup is shown to every workspace member and posted only to its space room', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const f = await seed(c);
  emitted.length = 0;
  try {
    const result = await generateDailyStandup({ orgId: f.org, requestedByUserId: f.requester });
    assert.ok(result.standup);
    const asMember = await dashboardStandup(f, f.member, 'member');
    assert.equal(asMember?.summary, result.standup!.summary);
    const messageEmits = emitted.filter((entry) => entry.event === 'message:new');
    assert.deepEqual(messageEmits.map((entry) => entry.room), [`space:${f.space}`]);
  } finally {
    await cleanup(c, f); await c.end();
  }
});
