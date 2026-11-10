import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { main as runUpgrade, tailMigrations, CONVERGE_HEAD_VERSION } from './upgrade.ts';
import { assertReviewedCurrent } from './lineage-convergence.mjs';

const upgradeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'upgrades');

const target = process.env.DATABASE_URL;
const safe = (() => {
  if (!target) return false;
  const url = new URL(target);
  return ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port === '55440' && /^\/(fix_a_|deft_test_424fix_)/u.test(url.pathname);
})();

async function isReviewedHead(client: pg.Client) {
  try {
    return (await assertReviewedCurrent(client)).stage === 'current';
  } catch {
    return false;
  }
}

/** Resets a `.131`-head database to exactly the pre-tail state, reverting the
 * `.133` and `.135` function/constraint changes in place so it again matches a
 * reviewed head variant. A fresh (push-full) database already carries the
 * `.132` columns and `.134` table in its reviewed bootstrap; an upgraded clone
 * does not, so those are dropped only when the clone needs it. Runs in one
 * transaction and rolls back unless the result is a reviewed head, so a fixture
 * mismatch never leaves the database half reset. Only tail surfaces change. */
async function resetToHead(client: pg.Client) {
  const persistent = readFileSync(resolve(upgradeDir, '0.3.0-preview.120-app-persistent-consent.sql'), 'utf8');
  const start = persistent.indexOf('CREATE OR REPLACE FUNCTION public.enforce_app_runtime_session()');
  const end = persistent.indexOf('CREATE OR REPLACE FUNCTION public.enforce_app_v7_effective_grant_shape()', start);
  assert.ok(start >= 0 && end > start, 'preview120 runtime session guard body is located');
  const constraintStart = persistent.indexOf('ALTER TABLE app_connection_sessions DROP CONSTRAINT app_connection_sessions_record_identity;');
  assert.ok(constraintStart >= 0, 'preview120 connection session constraint is located');
  const repairFnStart = persistent.indexOf('CREATE OR REPLACE FUNCTION public.deft_app_connection_credential_repair_record_valid(r jsonb)');
  const repairFnEnd = persistent.indexOf('CREATE OR REPLACE FUNCTION public.deft_app_consent_continuation_guard()', repairFnStart);
  assert.ok(repairFnStart >= 0 && repairFnEnd > repairFnStart, 'preview120 credential-repair function is located');
  await client.query('BEGIN');
  try {
    await client.query(persistent.slice(start, end));
    await client.query('DROP FUNCTION IF EXISTS public.app_runtime_session_resume_allowed(app_runtime_sessions, app_runtime_sessions)');
    // Revert the .135 restore-marker constraint and credential-repair function change.
    await client.query(persistent.slice(constraintStart));
    await client.query(persistent.slice(repairFnStart, repairFnEnd));
    await client.query(`DELETE FROM deft_schema_migrations WHERE version = ANY($1::text[])`,
      [tailMigrations().map((migration) => migration.version)]);
    const head = await client.query('SELECT 1 FROM deft_schema_migrations WHERE version = $1', [CONVERGE_HEAD_VERSION]);
    assert.equal(head.rowCount, 1, 'fixture must be a reviewed head clone');
    if (!(await isReviewedHead(client))) {
      await client.query(`ALTER TABLE app_integration_capture_policies
        DROP COLUMN IF EXISTS retired_at, DROP COLUMN IF EXISTS retired_reason, DROP COLUMN IF EXISTS last_error`);
      await client.query('DROP TABLE IF EXISTS app_restore_access_reviews CASCADE');
      assert.ok(await isReviewedHead(client), 'reset reproduces a reviewed .131 head variant');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

test('a .131 head applies the tail once and the second run is a no-op',
  { skip: !safe, timeout: 120000 }, async () => {
    const client = new pg.Client({ connectionString: target });
    await client.connect();
    try {
      await resetToHead(client);
      const head = tailMigrations().map((migration) => migration.version);
      await runUpgrade([]);
      for (const version of head) {
        const row = await client.query('SELECT 1 FROM deft_schema_migrations WHERE version = $1', [version]);
        assert.equal(row.rowCount, 1, `${version} applied`);
      }
      const columns = await client.query(
        `SELECT count(*)::int AS count FROM information_schema.columns
          WHERE table_name='app_integration_capture_policies'
            AND column_name IN ('retired_at','retired_reason','last_error')`);
      assert.equal(columns.rows[0].count, 3, 'retirement columns exist after upgrade');
      const review = await client.query("SELECT to_regclass('app_restore_access_reviews') AS present");
      assert.ok(review.rows[0].present, 'restore review table exists after upgrade');

      const before = (await client.query('SELECT version FROM deft_schema_migrations ORDER BY version')).rows
        .map((row: { version: string }) => row.version);
      await runUpgrade([]);
      const after = (await client.query('SELECT version FROM deft_schema_migrations ORDER BY version')).rows
        .map((row: { version: string }) => row.version);
      assert.deepEqual(after, before, 'second upgrade run changes nothing');
    } finally {
      await client.end();
    }
  });

/** Ledger plus every schema surface the tail changes, for read-only proofs. */
async function tailState(client: pg.Client) {
  const ledger = (await client.query('SELECT version, checksum FROM deft_schema_migrations ORDER BY version')).rows;
  const shape = (await client.query(`SELECT
    (SELECT count(*)::int FROM information_schema.columns
      WHERE table_name='app_integration_capture_policies'
        AND column_name IN ('retired_at','retired_reason','last_error')) AS retirement_columns,
    to_regclass('app_restore_access_reviews') IS NOT NULL AS restore_reviews,
    (SELECT count(*)::int FROM pg_proc WHERE proname='app_runtime_session_resume_allowed') AS resume_fn,
    (SELECT md5(pg_get_functiondef('public.enforce_app_runtime_session()'::regprocedure))) AS session_fn,
    (SELECT md5(pg_get_constraintdef(oid)) FROM pg_constraint
      WHERE conname='app_connection_sessions_record_identity') AS session_constraint`)).rows[0];
  return { ledger, shape };
}

test('PR424-F11: --status and --dry-run on a .131 head change nothing',
  { skip: !safe, timeout: 120000 }, async () => {
    const client = new pg.Client({ connectionString: target });
    await client.connect();
    try {
      await resetToHead(client);
      const before = await tailState(client);
      const tailVersions = new Set(tailMigrations().map((migration) => migration.version));
      assert.ok(!before.ledger.some((row: { version: string }) => tailVersions.has(row.version)),
        'fixture is at the .131 head');
      assert.equal(before.shape.resume_fn, 0, '.133 resume function is absent at the head');
      await runUpgrade(['--status']);
      assert.deepEqual(await tailState(client), before, '--status is read-only');
      await runUpgrade(['--dry-run']);
      assert.deepEqual(await tailState(client), before, '--dry-run is read-only');
    } finally {
      await client.end();
    }
  });

test('PR424-F13: concurrent upgrades of a .131 head both succeed and apply the tail once',
  { skip: !safe, timeout: 180000 }, async () => {
    const client = new pg.Client({ connectionString: target });
    await client.connect();
    try {
      await resetToHead(client);
      const results = await Promise.allSettled([runUpgrade([]), runUpgrade([])]);
      assert.deepEqual(results.map((result) => result.status === 'rejected' ? String(result.reason) : 'ok'),
        ['ok', 'ok'], 'neither concurrent upgrader fails');
      for (const migration of tailMigrations()) {
        const row = await client.query('SELECT 1 FROM deft_schema_migrations WHERE version = $1', [migration.version]);
        assert.equal(row.rowCount, 1, `${migration.version} recorded once`);
      }
      const state = await tailState(client);
      assert.equal(state.shape.retirement_columns, 3);
      assert.equal(state.shape.restore_reviews, true);
    } finally {
      await client.end();
    }
  });
