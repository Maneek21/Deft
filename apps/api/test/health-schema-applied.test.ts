/**
 * /health reports schema_applied: the newest row of the upgrade ledger
 * (deft_schema_migrations), cached, and null when the ledger is missing or
 * the database cannot be read. schema_head stays the release's constant.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  compareSchemaVersions,
  createSchemaAppliedCache,
  newestLedgerVersion,
  readLedgerFromDatabase,
  type LedgerRow,
} from '../src/lib/schema-applied.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

after(async () => {
  const { closeDb } = await import('../src/lib/db.js');
  await closeDb();
});

test('versions compare in release order, not text order', () => {
  assert.ok(compareSchemaVersions('0.3.0-preview.137', '0.3.0-preview.37') > 0);
  assert.ok(compareSchemaVersions('0.3.0-preview.7', '0.2.0-preview.40') > 0);
  assert.ok(compareSchemaVersions('0.3.0', '0.3.0-preview.140') > 0);
  assert.equal(compareSchemaVersions('0.2.0-preview.1', '0.2.0-preview.1'), 0);
});

test('ledger present: the newest row wins, ties on applied_at broken by release order', async () => {
  const same = new Date('2026-11-01T00:00:00Z');
  const rows: LedgerRow[] = [
    { version: '0.2.0-preview.1', applied_at: same },
    { version: '0.3.0-preview.137', applied_at: same },
    { version: '0.3.0-preview.37', applied_at: same },
  ];
  assert.equal(newestLedgerVersion(rows), '0.3.0-preview.137');
  assert.equal(newestLedgerVersion([...rows, { version: '0.3.0-preview.138', applied_at: '2026-11-02T00:00:00Z' }]),
    '0.3.0-preview.138');

  let reads = 0;
  let clock = 0;
  const get = createSchemaAppliedCache(async () => { reads++; return rows; }, () => clock);
  assert.equal(await get(), '0.3.0-preview.137');
  assert.equal(await get(), '0.3.0-preview.137');
  assert.equal(reads, 1, 'health checks must not read the ledger on every call');
  clock += 31_000;
  await get();
  assert.equal(reads, 2, 'the cache expires');
});

test('ledger absent: null', async () => {
  const get = createSchemaAppliedCache(async () => null);
  assert.equal(await get(), null);
  assert.equal(newestLedgerVersion([]), null);
});

test('database error or a hung read: null, quickly, without throwing', async () => {
  const failing = createSchemaAppliedCache(async () => { throw new Error('connection refused'); });
  assert.equal(await failing(), null);
  const hung = createSchemaAppliedCache(() => new Promise<never>(() => {}));
  const started = performance.now();
  assert.equal(await hung(), null);
  assert.ok(performance.now() - started < 3_000, 'a hung database must not hold /health');
});

test('the real reader matches the ledger in this database (or null without one), and /health carries both fields', async () => {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  let expected: string | null;
  try {
    const { rows: [{ exists }] } = await c.query(`SELECT to_regclass('public.deft_schema_migrations') IS NOT NULL AS exists`);
    expected = exists
      ? newestLedgerVersion((await c.query('SELECT version, applied_at FROM deft_schema_migrations')).rows)
      : null;
  } finally {
    await c.end();
  }
  const rows = await readLedgerFromDatabase();
  assert.equal(rows ? newestLedgerVersion(rows) : null, expected);

  const [{ app }, { DEFT_SCHEMA_HEAD }] = await Promise.all([
    import('../src/index.js'), import('../src/lib/agent-channel.js'),
  ]);
  const res = await app.request('/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.schema_head, DEFT_SCHEMA_HEAD);
  assert.ok('schema_applied' in body);
  assert.equal(body.schema_applied, expected);
});
