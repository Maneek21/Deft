import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { once } from 'node:events';
import { sql } from 'drizzle-orm';
import { withDbAdvisoryLock } from '../src/lib/db.js';
import pg from 'pg';
import { db, closeDb } from '../src/lib/db.js';

test('an idle database connection can disappear and the ordinary pool reconnects', async t => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  t.after(async () => { await admin.end(); });
  const pool = (db as typeof db & { $client: pg.Pool }).$client;
  const client = await pool.connect();
  const { rows } = await client.query('select pg_backend_pid() as pid');
  const disconnected = once(pool, 'error');
  client.release();
  await admin.query('select pg_terminate_backend($1)', [rows[0].pid]);
  await disconnected;
  assert.equal((await pool.query('select 1 as recovered')).rows[0].recovered, 1);
});

test('unexpected request errors use the public error envelope', async () => {
  const { app } = await import('../src/index.js');
  app.get('/__test_database_failure', () => { throw new Error('private database detail'); });
  const response = await app.request('/__test_database_failure');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Request failed', code: 'INTERNAL_ERROR' });
});

after(closeDb);

test('a transaction disconnect rejects its owner and the pool recovers', async t => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  t.after(() => admin.end());
  await assert.rejects(db.transaction(async tx => {
    const result = await tx.execute(sql`select pg_backend_pid() as pid`);
    await admin.query('select pg_terminate_backend($1)', [result.rows[0].pid]);
    await tx.execute(sql`select 1`);
  }));
  assert.equal((await db.execute(sql`select 1 as recovered`)).rows[0].recovered, 1);
});

test('a lost advisory connection cannot report successful work', async t => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  t.after(() => admin.end());
  await assert.rejects(withDbAdvisoryLock('outage-test', async () => {
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and application_name = 'deft-advisory' and pid <> pg_backend_pid() and query like 'SELECT pg_advisory_lock%'");
    // Wait for the server to observe connection loss before the callback settles.
    await new Promise(resolve => setTimeout(resolve, 100));
  }));
  await withDbAdvisoryLock('outage-test', async () => {});
});

test('feature pools survive idle disconnects and reconnect', async t => {
  const { createAppAutomationScanDatabase } = await import('../src/lib/app-automation-scan-db.js');
  const { createExperienceExposureDatabase } = await import('../src/lib/app-experience-exposure-db.js');
  const scanner = createAppAutomationScanDatabase(process.env.DATABASE_URL!);
  const experience = createExperienceExposureDatabase(process.env.DATABASE_URL!);
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  t.after(async () => { await scanner.close(); await experience.close(); await admin.end(); });
  const variants = [
    (run: any) => scanner.transaction(run),
    (run: any) => experience.transaction(run),
    (run: any) => experience.transaction(run, undefined, undefined, undefined, 'human_action_preparation'),
  ];
  for (const transaction of variants) {
    const result = await transaction((tx: any) => tx.execute(sql`select pg_backend_pid() as pid`));
    await admin.query('select pg_terminate_backend($1)', [result.rows[0].pid]);
    // A first checkout can race delivery of the disconnect; it may reject normally.
    const query = () => transaction((tx: any) => tx.execute(sql`select 1 as recovered`));
    const recovered = await query().catch(query);
    assert.equal(recovered.rows[0].recovered, 1);
  }
});

test('disconnecting a query in flight rejects it without crashing the process', async t => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  t.after(() => admin.end());
  const pool = (db as typeof db & { $client: pg.Pool }).$client;
  const client = await pool.connect();
  try {
    const { rows } = await client.query('select pg_backend_pid() as pid');
    const interrupted = assert.rejects(client.query('select pg_sleep(10)'));
    await admin.query('select pg_terminate_backend($1)', [rows[0].pid]);
    await interrupted;
  } finally { client.release(true); }
  assert.equal((await pool.query('select 1 as recovered')).rows[0].recovered, 1);
});

test('server statement cancellation rolls back before the next checkout', async () => {
  await assert.rejects(db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '50ms'`);
    await tx.execute(sql`select pg_sleep(1)`);
  }), (error: any) => error.cause?.code === '57014');
  const result = await db.execute(sql`select current_setting('statement_timeout') as timeout, 1 as recovered`);
  assert.equal(result.rows[0].timeout, '30s');
  assert.equal(result.rows[0].recovered, 1);
});

test('advisory callers wait behind two long holders instead of exhausting retries', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let entered = 0;
  let ready!: () => void;
  const both = new Promise<void>(resolve => { ready = resolve; });
  const work = async () => { if (++entered === 2) ready(); await hold; };
  const first = withDbAdvisoryLock('outage-test-holder-a', work);
  const second = withDbAdvisoryLock('outage-test-holder-b', work);
  await both;
  let ran = false;
  const third = withDbAdvisoryLock('outage-test-waiter', async () => { ran = true; });
  const observed = third.then(() => null, error => error);
  try {
    await new Promise(resolve => setTimeout(resolve, 5_200));
    assert.equal(ran, false);
  } finally { release(); await Promise.all([first, second]); }
  assert.equal(await observed, null);
  assert.equal(ran, true);
});
