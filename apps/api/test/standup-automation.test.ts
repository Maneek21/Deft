import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock, test } from 'node:test';
import pg from 'pg';

// Standup synthesis must never reach a real model provider in tests. The
// provider resolver reports no key, and the runner fails closed if reached.
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

const { generateDailyStandup } = await import('../src/lib/standup-automation.js');
const { dashboardRoutes } = await import('../src/routes/dashboard.js');

type Fixture = {
  org: string; owner: string; hidden: string; space: string; project: string;
  secretTitles: string[]; publicTitle: string; hiddenName: string;
};

async function seed(c: pg.Client): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const org = randomUUID(), owner = randomUUID(), hidden = randomUUID();
  const space = randomUUID(), project = randomUUID();
  const hiddenName = `Hidden Owner ${tag}`;
  await c.query('INSERT INTO orgs(id,name,slug) VALUES($1,$1,$1)', [org]);
  await c.query(`INSERT INTO users(id,email,name) VALUES($1,$1||'@test.local',$2)`, [owner, `Owner ${tag}`]);
  await c.query(`INSERT INTO users(id,email,name) VALUES($1,$1||'@test.local',$2)`, [hidden, hiddenName]);
  await c.query(`INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'admin')`, [randomUUID(), org, owner]);
  await c.query(`INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'member')`, [randomUUID(), org, hidden]);
  await c.query(`INSERT INTO spaces(id,org_id,name,type,is_default,created_by) VALUES($1,$2,'general','public',true,$3)`, [space, org, owner]);
  await c.query(`INSERT INTO projects(id,org_id,name,prefix) VALUES($1,$2,'Standup fixture',$3)`, [project, org, `S${tag.toUpperCase()}`]);

  const secretTitles = [`SECRET-DONE-${tag}`, `SECRET-ACTIVE-${tag}`, `SECRET-OVERDUE-${tag}`];
  const publicTitle = `PUBLIC-ACTIVE-${tag}`;
  const restricted = JSON.stringify({ visibility: 'restricted' });
  const insertTask = async (number: number, title: string, status: string, metadata: string, assignee: string, due: Date | null) => {
    const id = randomUUID();
    await c.query(
      `INSERT INTO tasks(id,org_id,project_id,number,title,status,assignee_id,created_by,due_date,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [id, org, project, number, title, status, assignee, assignee, due, metadata],
    );
    return id;
  };
  const doneTask = await insertTask(1, secretTitles[0]!, 'done', restricted, hidden, null);
  await c.query(
    `INSERT INTO task_activity(id,org_id,task_id,user_id,action,field,old_value,new_value)
     VALUES($1,$2,$3,$4,'status_changed','status','in_progress','done')`,
    [randomUUID(), org, doneTask, hidden],
  );
  await insertTask(2, secretTitles[1]!, 'in_progress', restricted, hidden, null);
  await insertTask(3, secretTitles[2]!, 'todo', restricted, hidden, new Date(Date.now() - 2 * 86_400_000));
  await insertTask(4, publicTitle, 'in_progress', '{}', owner, null);
  return { org, owner, hidden, space, project, secretTitles, publicTitle, hiddenName };
}

async function cleanup(c: pg.Client, f: Fixture) {
  for (const sql of [
    'DELETE FROM messages WHERE org_id=$1',
    'DELETE FROM standups WHERE org_id=$1',
    'DELETE FROM automation_runs WHERE org_id=$1',
    'DELETE FROM task_activity WHERE org_id=$1',
    'DELETE FROM tasks WHERE org_id=$1',
    'DELETE FROM projects WHERE org_id=$1',
    'DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)',
    'DELETE FROM spaces WHERE org_id=$1',
    'DELETE FROM org_members WHERE org_id=$1',
    'DELETE FROM orgs WHERE id=$1',
  ]) {
    await c.query(sql, [f.org]).catch(() => undefined);
  }
  await c.query('DELETE FROM users WHERE id IN ($1,$2)', [f.owner, f.hidden]).catch(() => undefined);
}

test('D01: standup omits a restricted task the audience cannot see', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const f = await seed(c);
  try {
    const result = await generateDailyStandup({ orgId: f.org });
    assert.ok(result.standup, 'standup was generated');
    const [message] = (await c.query('SELECT content FROM messages WHERE org_id=$1 AND space_id=$2', [f.org, f.space])).rows;
    const published = [
      result.standup!.summary,
      JSON.stringify(result.standup!.raw_data),
      String(message?.content ?? ''),
    ].join('\n');
    assert.ok(published.includes(f.publicTitle), 'org-visible work still appears in the standup');
    for (const title of f.secretTitles) {
      assert.ok(!published.includes(title), `restricted task "${title}" must not appear in the standup`);
    }
    assert.ok(!published.includes(f.hiddenName), 'owner of restricted-only work must not be named');
  } finally {
    await cleanup(c, f); await c.end();
  }
});

test('D04: standup is not emitted to the org-wide room', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const f = await seed(c);
  emitted.length = 0;
  try {
    const result = await generateDailyStandup({ orgId: f.org });
    assert.ok(result.standup);
    const messageEmits = emitted.filter((entry) => entry.event === 'message:new');
    assert.equal(messageEmits.length, 1, 'the standup message is emitted once');
    assert.ok(!messageEmits.some((entry) => entry.room === `org:${f.org}`), 'must not reach the whole-org room');
    assert.deepEqual(messageEmits.map((entry) => entry.room), [`space:${f.space}`]);
  } finally {
    await cleanup(c, f); await c.end();
  }
});

test('D09: a retry after a failed delivery does not post a second standup', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const f = await seed(c);
  const fn = `w1c_fault_${f.org.replaceAll('-', '')}`;
  try {
    // Fault-inject the final "delivered" run update for this org only, after
    // the standup row and the channel message have been written.
    await c.query(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.org_id = '${f.org}' AND NEW.status = 'delivered' THEN
          RAISE EXCEPTION 'injected delivery fault';
        END IF;
        RETURN NEW;
      END $$`);
    await c.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON automation_runs FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    const now = new Date();
    await assert.rejects(generateDailyStandup({ orgId: f.org, now }), (error: any) =>
      /injected delivery fault/.test(`${error?.message} ${error?.cause?.message}`));
    await c.query(`DROP TRIGGER ${fn} ON automation_runs`);

    const retry = await generateDailyStandup({ orgId: f.org, now });
    assert.ok(retry.standup);
    const standups = (await c.query('SELECT id FROM standups WHERE org_id=$1', [f.org])).rows;
    const posts = (await c.query('SELECT id FROM messages WHERE org_id=$1 AND space_id=$2', [f.org, f.space])).rows;
    assert.equal(standups.length, 1, 'exactly one standup row after recovery');
    assert.equal(posts.length, 1, 'exactly one standup message after recovery');
  } finally {
    await c.query(`DROP TRIGGER IF EXISTS ${fn} ON automation_runs`).catch(() => undefined);
    await c.query(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => undefined);
    await cleanup(c, f); await c.end();
  }
});

test('standup route: a guest cannot generate the org standup', async () => {
  const { Hono } = await import('hono');
  const org = randomUUID();
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('user', { id: randomUUID(), email: 'guest@test.local', org_id: org, sid: 'sid', role: 'guest' });
    await next();
  });
  app.route('/api/dashboard', dashboardRoutes);
  const response = await app.request('/api/dashboard/standup', { method: 'POST' });
  assert.equal(response.status, 403);
  const body = await response.json() as { error?: string; code?: string };
  assert.equal(body.code, 'FORBIDDEN');
  assert.equal(typeof body.error, 'string');
});
