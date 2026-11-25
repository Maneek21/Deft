/**
 * The heartbeat's seats_used against a real database: the workspace's active
 * people who count for seats, by the seat limit's own rule (guests, agents,
 * the system user and removed members never count), and 0 before setup.
 *
 * Like install-ping-db.test.ts, this process gets empty copies of the tables
 * it reads, in a throwaway schema first on its search path, so the "first
 * workspace" is the one this test makes.
 *
 * Run: pnpm --filter @deft/api test test/telemetry-heartbeat-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.search && !url.hash;
  } catch { return false; }
})();

const TABLES = ['users', 'orgs', 'org_members'];

test('seats_used counts the workspace\'s seat-holding people, and 0 before setup', { skip: !safe, timeout: 120_000 }, async (t) => {
  const schema = `heartbeat_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: target, max: 2 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  for (const table of TABLES) {
    await admin.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  const savedOptions = process.env.PGOPTIONS;
  process.env.PGOPTIONS = `-c search_path=${schema},public`;
  const { heartbeatDeps, stopCellHeartbeat } = await import('../src/lib/telemetry/heartbeat.js');
  const { closeDb, db } = await import('../src/lib/db.js');
  t.after(async () => {
    await closeDb();
    if (savedOptions === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = savedOptions;
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  assert.equal(await heartbeatDeps.seatsUsed(), 0, 'no workspace yet');

  const org = randomUUID();
  await admin.query(`INSERT INTO "${schema}".orgs (id, name, slug) VALUES ($1, 'Heartbeat Org', $2)`, [org, `hb-${org.slice(0, 8)}`]);
  const people: Array<[string, 'human' | 'agent' | 'system', 'owner' | 'admin' | 'member' | 'guest', boolean]> = [
    ['owner', 'human', 'owner', true],
    ['admin', 'human', 'admin', true],
    ['member', 'human', 'member', true],
    ['guest', 'human', 'guest', true],
    ['agent', 'agent', 'member', true],
    ['system', 'system', 'member', true],
    ['removed', 'human', 'member', false],
  ];
  for (const [name, kind, role, active] of people) {
    const id = randomUUID();
    await admin.query(`INSERT INTO "${schema}".users (id, name, email, kind, is_agent) VALUES ($1, $2, $3, $4, $5)`,
      [id, name, `${name}-${id.slice(0, 8)}@heartbeat.test`, kind, kind === 'agent']);
    await admin.query(`INSERT INTO "${schema}".org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), org, id, role, active]);
  }
  // Owner, admin and member: guests, agents, the system user and removed members never count.
  assert.equal(await heartbeatDeps.seatsUsed(), 3);

  // A table held by someone else: the count gives up within its 3-second bound
  // instead of holding a connection through a shutdown (15-second deadline).
  const holder = await admin.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`LOCK TABLE "${schema}".orgs IN ACCESS EXCLUSIVE MODE`);
    const started = Date.now();
    await assert.rejects(heartbeatDeps.seatsUsed());
    assert.ok(Date.now() - started < 8_000, `gave up after ${Date.now() - started} ms`);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }

  // A shutdown while a count is out: stopping gives the connection up at once,
  // out of the pool (so closing the pool cannot wait for it), and the count fails.
  const blocker = await admin.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(`LOCK TABLE "${schema}".orgs IN ACCESS EXCLUSIVE MODE`);
    const pending = heartbeatDeps.seatsUsed();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const before = db.$client.totalCount;
    const stopped = Date.now();
    stopCellHeartbeat();
    assert.equal(db.$client.totalCount, before - 1, 'the connection left the pool at once');
    await assert.rejects(pending);
    assert.ok(Date.now() - stopped < 1_000, `the count failed after ${Date.now() - stopped} ms`);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  assert.equal(await heartbeatDeps.seatsUsed(), 3, 'and the next count works');

  // A stop while the count is still waiting for a connection (a busy pool):
  // the connection it then gets is given up, out of the pool, never handed back.
  const max = (db.$client as unknown as { options: { max: number } }).options.max;
  const held = [];
  for (let i = 0; i < max; i += 1) held.push(await db.$client.connect());
  try {
    const queued = heartbeatDeps.seatsUsed();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(db.$client.waitingCount, 1, 'the count is waiting for a connection');
    stopCellHeartbeat();
    held.pop()!.release();
    await assert.rejects(queued);
    assert.equal(db.$client.totalCount, max - 1, 'the connection it got left the pool');
  } finally {
    for (const client of held) client.release();
  }
  assert.equal(await heartbeatDeps.seatsUsed(), 3, 'and counting works afterwards');

  // Two workspaces (a database restored over another): ambiguous, so no count at all.
  await admin.query(`INSERT INTO "${schema}".orgs (id, name, slug) VALUES ($1, 'Second Org', $2)`, [randomUUID(), `hb2-${org.slice(0, 8)}`]);
  assert.equal(await heartbeatDeps.seatsUsed(), null);
});

test('a stop just after a count begins (before it has a connection) is seen', { skip: !safe, timeout: 60_000 }, async () => {
  const { heartbeatDeps, stopCellHeartbeat } = await import('../src/lib/telemetry/heartbeat.js');
  const counting = heartbeatDeps.seatsUsed();
  stopCellHeartbeat();
  await assert.rejects(counting, /heartbeat stopped/);
});
