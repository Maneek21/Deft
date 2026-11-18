import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { db, closeDb } from '../src/lib/db.js';

test('an idle database connection can disappear and the ordinary pool reconnects', async t => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  t.after(async () => { await closeDb(); await admin.end(); });
  const pool = (db as typeof db & { $client: pg.Pool }).$client;
  const client = await pool.connect();
  const { rows } = await client.query('select pg_backend_pid() as pid');
  client.release();
  await admin.query('select pg_terminate_backend($1)', [rows[0].pid]);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await pool.query('select 1 as recovered')).rows[0].recovered, 1);
});

test('unexpected request errors use the public error envelope', async () => {
  const { app } = await import('../src/index.js');
  app.get('/__test_database_failure', () => { throw new Error('private database detail'); });
  const response = await app.request('/__test_database_failure');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Request failed', code: 'INTERNAL_ERROR' });
});
