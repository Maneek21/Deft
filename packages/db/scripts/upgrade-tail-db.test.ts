import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pg from 'pg';
import { main as runUpgrade, tailMigrations, CONVERGE_HEAD_VERSION } from './upgrade.ts';
import { assertReviewedCurrent } from './lineage-convergence.mjs';
import { ScratchDatabases, scratchDatabaseName } from './upgrade-tail-scratch.ts';

/** DATABASE_URL names the fixture: a database at the reviewed `.131` head with
 * no tail migration applied (for example restored from a supported release
 * backup). The tests never write to it. Each test upgrades its own scratch
 * copy, made from it with CREATE DATABASE … TEMPLATE … under a new short name
 * (`<prefix>tail_<random>`): the tail adds enum labels (`.155`), which
 * PostgreSQL cannot remove, so an upgraded database can't be put back to the
 * head. A taken name fails creation; only databases this run created are
 * dropped (upgrade-tail-scratch.test.ts). The fixture's role needs CREATEDB
 * and must own the fixture. */
const target = process.env.DATABASE_URL;
const SAFE_NAME = /^\/(fix_a_|deft_test_424fix_)/u;
const safe = (() => {
  if (!target) return false;
  const url = new URL(target);
  return ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port === '55440' && SAFE_NAME.test(url.pathname);
})();

const databaseName = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1));
const withDatabase = (url: string, name: string) => {
  const next = new URL(url);
  next.pathname = `/${encodeURIComponent(name)}`;
  return next.toString();
};
const scratchPrefix = safe ? SAFE_NAME.exec(new URL(target!).pathname)![1]! : '';

async function isReviewedHead(client: pg.Client) {
  try {
    return (await assertReviewedCurrent(client)).stage === 'current';
  } catch {
    return false;
  }
}

let fixtureChecked = false;

/** The fixture must be exactly a reviewed head: the head ledger row, no tail
 * row, and a catalogue that is a reviewed head variant. Read-only. */
async function assertFixtureAtHead() {
  if (fixtureChecked) return;
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  try {
    const head = await client.query('SELECT 1 FROM deft_schema_migrations WHERE version = $1', [CONVERGE_HEAD_VERSION]);
    assert.equal(head.rowCount, 1, 'fixture must be a reviewed head clone');
    const tail = await client.query('SELECT version FROM deft_schema_migrations WHERE version = ANY($1::text[]) ORDER BY version',
      [tailMigrations().map((migration) => migration.version)]);
    assert.deepEqual(tail.rows, [], 'fixture must have no tail migration applied; rebuild it at the head instead of upgrading it');
    assert.ok(await isReviewedHead(client), 'fixture is a reviewed .131 head variant');
  } finally {
    await client.end();
  }
  fixtureChecked = true;
}

async function maintenance<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: withDatabase(target!, 'postgres') });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const scratch = new ScratchDatabases((sql) => maintenance((client) => client.query(sql)));

/** Creates a new scratch copy of the fixture and points the upgrader (which
 * reads DATABASE_URL) at it. Nothing is created if the fixture check fails.
 * The fixture must have no other session open while it is copied. */
async function freshScratch(): Promise<{ client: pg.Client; name: string }> {
  await assertFixtureAtHead();
  const name = await scratch.create(scratchDatabaseName(scratchPrefix), databaseName(target!));
  const url = withDatabase(target!, name);
  process.env.DATABASE_URL = url;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return { client, name };
}

async function finish(client: pg.Client, name: string) {
  await client.end();
  await scratch.drop(name);
}

after(async () => {
  if (!safe) return;
  process.env.DATABASE_URL = target;
  await scratch.dropAll();
});

test('a .131 head applies the tail once and the second run is a no-op',
  { skip: !safe, timeout: 120000 }, async () => {
    const { client, name } = await freshScratch();
    try {
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
      const late = await client.query(`SELECT to_regclass('note_files') IS NOT NULL AS note_files,
        to_regclass('documents') IS NOT NULL AS tables,
        'document_shared' = ANY (enum_range(NULL::notification_type)::text[]) AS label,
        to_regclass('document_event_links') IS NOT NULL AS event_links,
        to_regclass('document_user_settings') IS NOT NULL AS edit_settings`);
      assert.deepEqual(late.rows[0], { note_files: true, tables: true, label: true, event_links: true, edit_settings: true },
        'the .154 note file links, the .155 drives tables and label, and the .156 meeting-notes links and edit settings exist after upgrade');

      const before = (await client.query('SELECT version FROM deft_schema_migrations ORDER BY version')).rows
        .map((row: { version: string }) => row.version);
      await runUpgrade([]);
      const after = (await client.query('SELECT version FROM deft_schema_migrations ORDER BY version')).rows
        .map((row: { version: string }) => row.version);
      assert.deepEqual(after, before, 'second upgrade run changes nothing');
    } finally {
      await finish(client, name);
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
      WHERE conname='app_connection_sessions_record_identity') AS session_constraint,
    to_regclass('note_files') IS NOT NULL AS note_files,
    to_regclass('documents') IS NOT NULL AS documents,
    (SELECT count(*)::int FROM pg_enum WHERE enumlabel = 'document_shared') AS document_labels,
    to_regclass('document_event_links') IS NOT NULL AS event_links,
    to_regclass('document_user_settings') IS NOT NULL AS edit_settings`)).rows[0];
  return { ledger, shape };
}

test('PR424-F11: --status and --dry-run on a .131 head change nothing',
  { skip: !safe, timeout: 120000 }, async () => {
    const { client, name } = await freshScratch();
    try {
      const before = await tailState(client);
      const tailVersions = new Set(tailMigrations().map((migration) => migration.version));
      assert.ok(!before.ledger.some((row: { version: string }) => tailVersions.has(row.version)),
        'fixture is at the .131 head');
      assert.equal(before.shape.resume_fn, 0, '.133 resume function is absent at the head');
      assert.equal(before.shape.note_files, false, '.154 note file links are absent at the head');
      assert.equal(before.shape.documents, false, '.155 drives tables are absent at the head');
      assert.equal(before.shape.event_links, false, '.156 meeting-notes links are absent at the head');
      assert.equal(before.shape.edit_settings, false, '.156 edit settings are absent at the head');
      await runUpgrade(['--status']);
      assert.deepEqual(await tailState(client), before, '--status is read-only');
      await runUpgrade(['--dry-run']);
      assert.deepEqual(await tailState(client), before, '--dry-run is read-only');
    } finally {
      await finish(client, name);
    }
  });

test('PR424-F13: concurrent upgrades of a .131 head both succeed and apply the tail once',
  { skip: !safe, timeout: 180000 }, async () => {
    const { client, name } = await freshScratch();
    try {
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
      assert.equal(state.shape.note_files, true);
      assert.equal(state.shape.documents, true);
      assert.equal(state.shape.document_labels, 1, 'the .155 label is added once');
      assert.equal(state.shape.event_links, true);
      assert.equal(state.shape.edit_settings, true);
    } finally {
      await finish(client, name);
    }
  });
