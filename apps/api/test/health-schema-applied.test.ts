/**
 * /health reports schema_applied: the newest row of the upgrade ledger
 * (deft_schema_migrations), cached, with explicit missing/unavailable states.
 * schema_head stays the release's constant.
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
  assert.deepEqual(await get(), { value: '0.3.0-preview.137', state: 'ok' });
  assert.deepEqual(await get(), { value: '0.3.0-preview.137', state: 'ok' });
  assert.equal(reads, 1, 'health checks must not read the ledger on every call');
  clock += 31_000;
  await get();
  assert.equal(reads, 2, 'the cache expires');
});

test('ledger absent: explicit no_ledger state', async () => {
  const get = createSchemaAppliedCache(async () => null);
  assert.deepEqual(await get(), { value: null, state: 'no_ledger' });
  assert.equal(newestLedgerVersion([]), null);
});

test('database error or a hung read: unavailable, quickly, without throwing', async () => {
  const failing = createSchemaAppliedCache(async () => { throw new Error('connection refused'); });
  assert.deepEqual(await failing(), { value: null, state: 'unavailable' });
  const hung = createSchemaAppliedCache(() => new Promise<never>(() => {}));
  const started = performance.now();
  assert.deepEqual(await hung(), { value: null, state: 'unavailable' });
  assert.ok(performance.now() - started < 3_000, 'a hung database must not hold /health');
});

test('release order wins even when the restore clock moves backwards', () => {
  assert.equal(newestLedgerVersion([
    { version: '0.3.0-preview.137', applied_at: '2026-11-02T00:00:00Z' },
    { version: '0.3.0-preview.138', applied_at: '2026-11-01T00:00:00Z' },
  ]), '0.3.0-preview.138');
});

test('failed refresh preserves the last known version with unavailable state', async () => {
  let clock = 0;
  let fail = false;
  const get = createSchemaAppliedCache(async () => {
    if (fail) throw new Error('offline');
    return [{ version: '0.3.0-preview.137', applied_at: null }];
  }, () => clock);
  assert.deepEqual(await get(), { value: '0.3.0-preview.137', state: 'ok' });
  clock = 31_000;
  fail = true;
  assert.deepEqual(await get(), { value: '0.3.0-preview.137', state: 'unavailable' });
});

test('a timed-out read cannot overwrite a newer successful read', async () => {
  let clock = 0;
  let finish!: (rows: LedgerRow[]) => void;
  let calls = 0;
  const get = createSchemaAppliedCache(() => ++calls === 1
    ? new Promise<LedgerRow[]>((resolve) => { finish = resolve; })
    : Promise.resolve([{ version: '0.3.0-preview.138', applied_at: null }]), () => clock);
  assert.deepEqual(await get(), { value: null, state: 'unavailable' });
  clock = 6_000;
  assert.deepEqual(await get(), { value: '0.3.0-preview.138', state: 'ok' });
  finish([{ version: '0.3.0-preview.137', applied_at: null }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await get(), { value: '0.3.0-preview.138', state: 'ok' });
});

test('the real reader and /health report the applied ledger version, including a partial upgrade', async () => {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  let createdLedger = false;
  try {
    const { rows: [{ exists }] } = await c.query(`SELECT to_regclass('public.deft_schema_migrations') IS NOT NULL AS exists`);
    if (!exists) {
      assert.equal(await readLedgerFromDatabase(), null);
      // Local fresh-init fingerprinting can leave no ledger. A disposable test
      // fixture proves the actual SQL reader with an applied version below head.
      await c.query('CREATE TABLE deft_schema_migrations (version text PRIMARY KEY, applied_at timestamptz)');
      createdLedger = true;
      await c.query(`INSERT INTO deft_schema_migrations VALUES
        ('0.3.0-preview.7', '2026-11-02'), ('0.3.0-preview.37', '2026-11-01')`);
    }
    const expected = newestLedgerVersion((await c.query('SELECT version, applied_at FROM deft_schema_migrations')).rows);
    const rows = await readLedgerFromDatabase();
    assert.equal(rows ? newestLedgerVersion(rows) : null, expected);

    const [{ app }, { DEFT_SCHEMA_HEAD }] = await Promise.all([
      import('../src/index.js'), import('../src/lib/agent-channel.js'),
    ]);
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.schema_head, DEFT_SCHEMA_HEAD);
    assert.equal(body.schema_applied, expected);
    assert.equal(body.schema_applied_state, expected === null ? 'no_ledger' : 'ok');
    if (createdLedger) assert.notEqual(body.schema_applied, body.schema_head);
  } finally {
    if (createdLedger) await c.query('DROP TABLE deft_schema_migrations');
    await c.end();
  }
});
