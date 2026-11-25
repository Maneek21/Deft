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
  const admin = new pg.Pool({ connectionString: target, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  for (const table of TABLES) {
    await admin.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  const savedOptions = process.env.PGOPTIONS;
  process.env.PGOPTIONS = `-c search_path=${schema},public`;
  const { heartbeatDeps } = await import('../src/lib/telemetry/heartbeat.js');
  const { closeDb } = await import('../src/lib/db.js');
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
});
