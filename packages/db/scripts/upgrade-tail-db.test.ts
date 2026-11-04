import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { main as runUpgrade, tailMigrations, CONVERGE_HEAD_VERSION } from './upgrade.ts';

const upgradeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'upgrades');

const target = process.env.DATABASE_URL;
const safe = (() => {
  if (!target) return false;
  const url = new URL(target);
  return ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port === '55440' && /^\/fix_a_/u.test(url.pathname);
})();

/** Resets a `.131`-head clone to exactly the pre-tail state, reverting the
 * `.133` function change in place so the clone again matches the reviewed head
 * variant. Only the tail surfaces are touched; no other tenant data is changed. */
async function resetToHead(client: pg.Client) {
  const persistent = readFileSync(resolve(upgradeDir, '0.3.0-preview.120-app-persistent-consent.sql'), 'utf8');
  const start = persistent.indexOf('CREATE OR REPLACE FUNCTION public.enforce_app_runtime_session()');
  const end = persistent.indexOf('CREATE OR REPLACE FUNCTION public.enforce_app_v7_effective_grant_shape()', start);
  assert.ok(start >= 0 && end > start, 'preview120 runtime session guard body is located');
  await client.query(persistent.slice(start, end));
  await client.query('DROP FUNCTION IF EXISTS public.app_runtime_session_resume_allowed(app_runtime_sessions, app_runtime_sessions)');
  await client.query(`ALTER TABLE app_integration_capture_policies
    DROP COLUMN IF EXISTS retired_at, DROP COLUMN IF EXISTS retired_reason, DROP COLUMN IF EXISTS last_error`);
  await client.query('DROP TABLE IF EXISTS app_restore_access_reviews CASCADE');
  await client.query(`DELETE FROM deft_schema_migrations WHERE version = ANY($1::text[])`,
    [tailMigrations().map((migration) => migration.version)]);
  const head = await client.query('SELECT 1 FROM deft_schema_migrations WHERE version = $1', [CONVERGE_HEAD_VERSION]);
  assert.equal(head.rowCount, 1, 'fixture must be a reviewed head clone');
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
