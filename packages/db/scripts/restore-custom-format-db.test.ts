/**
 * Proves that a database holding real rows survives both restore routes:
 * `pg_dump -Fc` + `pg_restore` (custom format) and `pg_dump` + `psql` (plain
 * SQL, the route docs/self-hosting.md documents).
 *
 * Both routes restore with an empty search_path. A CHECK constraint that calls
 * a helper function is only restorable when that helper, and every helper it
 * calls, can be found without the session's search_path
 * (upgrades/0.3.0-preview.148-restore-safe-check-helpers.sql).
 *
 * Database-backed and local, like the other *-db tests in this folder. It needs:
 *   - DATABASE_URL: a migrated, disposable test database on this machine whose
 *     name contains "test" (it gets a few fixture rows, removed afterwards);
 *   - pg_dump, pg_restore and psql on PATH, or their folder in DEFT_PG_BIN;
 *   - a role that can create the vector extension and one scratch database, named after the source with
 *     "_restore_test" at the end (override with DEFT_RESTORE_TEST_DATABASE).
 * Run: pnpm --filter @deft/db test:restore
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';

const sourceUrl = process.env.DATABASE_URL;

function tool(name: 'pg_dump' | 'pg_restore' | 'psql') {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  return process.env.DEFT_PG_BIN ? join(process.env.DEFT_PG_BIN, file) : file;
}

type Plan = { skip: string } | { skip: false; source: URL; sourceName: string; targetName: string };

const plan: Plan = (() => {
  if (!sourceUrl) return { skip: 'DATABASE_URL is not set' };
  let source: URL;
  try { source = new URL(sourceUrl); } catch { return { skip: 'DATABASE_URL is not a URL' }; }
  const sourceName = decodeURIComponent(source.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(source.protocol)
    || !['127.0.0.1', 'localhost'].includes(source.hostname)
    || !/^[a-z0-9_]+$/u.test(sourceName) || !sourceName.includes('test')) {
    return { skip: 'DATABASE_URL is not a local disposable test database (its name must contain "test")' };
  }
  const targetName = process.env.DEFT_RESTORE_TEST_DATABASE
    ?? `${sourceName.replace(/_test$/u, '')}_restore_test`;
  if (!/^[a-z0-9_]+_restore_test$/u.test(targetName) || targetName === sourceName) {
    return { skip: 'the scratch database name must end with "_restore_test"' };
  }
  for (const name of ['pg_dump', 'pg_restore', 'psql'] as const) {
    if (spawnSync(tool(name), ['--version'], { windowsHide: true }).status !== 0) {
      // In CI a missing tool must fail the rehearsal, not skip it into a green run.
      if (process.env.CI) throw new Error(`${name} is not available; the restore rehearsal cannot run`);
      return { skip: `${name} is not available; put it on PATH or set DEFT_PG_BIN` };
    }
  }
  return { skip: false, source, sourceName, targetName };
})();

function urlFor(source: URL, database: string) {
  const url = new URL(source.href);
  url.pathname = `/${database}`;
  return url.href;
}

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

/** A newer pg_dump writes settings an older server rejects (pg_dump 17 emits SET transaction_timeout,
 * unknown to a 16 server), so a mismatch is reported as such instead of as a failed restore. */
test('the dump tools are the same major version as the server', { skip: plan.skip }, async () => {
  const server = await withClient(sourceUrl!, async (client) =>
    Number((await client.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]!.v.slice(0, -4)));
  for (const name of ['pg_dump', 'pg_restore', 'psql'] as const) {
    const out = spawnSync(tool(name), ['--version'], { encoding: 'utf8', windowsHide: true }).stdout;
    assert.equal(Number(/(\d+)(?:\.\d+)?\s*(?:\(|$)/u.exec(out.trim())?.[1]), server,
      `${name} (${out.trim()}) must be major version ${server}, the server's; set DEFT_PG_BIN to its folder`);
  }
});

/** Runs a PostgreSQL client tool. The password travels in the environment, never in the arguments. */
function run(name: 'pg_dump' | 'pg_restore' | 'psql', source: URL, database: string, args: readonly string[]) {
  return new Promise<{ code: number; output: string }>((resolveRun, reject) => {
    const child = spawn(tool(name), [...args], {
      env: {
        ...process.env,
        PGHOST: source.hostname,
        PGPORT: source.port || '5432',
        PGUSER: decodeURIComponent(source.username),
        PGPASSWORD: decodeURIComponent(source.password),
        PGDATABASE: database,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code: code ?? 1, output }));
  });
}

/** Functions PostgreSQL runs while it loads a dump: those called by CHECK
 * constraints (table and domain), index expressions and predicates, generated
 * columns and materialized views. Extension members are not ours to change. */
const RESTORE_TIME_FUNCTIONS_WITHOUT_SEARCH_PATH = `
  WITH restore_time AS (
    SELECT d.refobjid AS fn FROM pg_constraint k
      JOIN pg_depend d ON d.classid = 'pg_constraint'::regclass AND d.objid = k.oid AND d.refclassid = 'pg_proc'::regclass
     WHERE k.contype = 'c'
    UNION
    SELECT d.refobjid FROM pg_index x
      JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = x.indexrelid AND d.refclassid = 'pg_proc'::regclass
    UNION
    SELECT d.refobjid FROM pg_attrdef ad
      JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum AND a.attgenerated <> ''
      JOIN pg_depend d ON d.classid = 'pg_attrdef'::regclass AND d.objid = ad.oid AND d.refclassid = 'pg_proc'::regclass
    UNION
    SELECT d.refobjid FROM pg_rewrite rw
      JOIN pg_class c ON c.oid = rw.ev_class AND c.relkind = 'm'
      JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = rw.oid AND d.refclassid = 'pg_proc'::regclass
  )
  SELECT p.oid::regprocedure::text AS function
    FROM restore_time r
    JOIN pg_proc p ON p.oid = r.fn
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND NOT EXISTS (SELECT 1 FROM pg_depend e
                      WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e')
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) AS setting
                      WHERE setting LIKE 'search_path=%')
   ORDER BY 1`;

test('every function a dump restore runs carries its own search_path', { skip: plan.skip }, async () => {
  assert.ok(plan.skip === false);
  const unpinned = await withClient(sourceUrl!, async (client) =>
    (await client.query<{ function: string }>(RESTORE_TIME_FUNCTIONS_WITHOUT_SEARCH_PATH)).rows.map((row) => row.function));
  assert.deepEqual(unpinned, [],
    'these functions are called by a CHECK constraint, index or generated column but resolve names through the session search_path, '
    + 'which is empty during a restore; add "SET search_path = pg_catalog, public, pg_temp" to each');
});

type Fixture = { org: string; user: string; member: string; webSession: string; sessionId: string; record: unknown };

/** One connection session whose record carries an action consent: the CHECK on
 * app_connection_sessions then calls deft_app_consent_deadline, which calls
 * deft_app_consent_valid by its bare name. */
async function insertFixture(client: pg.Client): Promise<Fixture> {
  const tag = randomUUID().replace(/-/gu, '').slice(0, 12);
  const fixture: Fixture = {
    org: `org_restore_${tag}`, user: `user_restore_${tag}`, member: randomUUID(),
    webSession: `ws_restore_${tag}`, sessionId: randomUUID(), record: null,
  };
  const actionBinding = randomUUID();
  fixture.record = {
    session_id: fixture.sessionId, revision: 0,
    scope: {
      org_id: fixture.org, owner_user_id: fixture.user, installation_id: randomUUID(), target_key: 'inbox',
      resource_key: 'inbox', resource_binding_id: randomUUID(), consent_expires_at: '2099-01-01T00:00:00.000Z',
    },
    profile: {
      schema_version: 'deft.app_connection_profile.v1', key: 'primary', provider_id: 'p',
      operator_user_id: fixture.user, runtime_requirement_key: 'r', resource_key: 'inbox', action_keys: [],
      authorization_origin: 'https://example.test', credential_custody: 'runtime', executable: false,
    },
    state: 'starting', callback_state_hash: 'a'.repeat(64), callback_consumed: false,
    callback_expires_at: '2098-12-01T00:00:00.000Z', runtime_session_ref: null, account: null,
    created_at: '2026-11-16T00:00:00.000Z', updated_at: '2026-11-16T00:00:00.000Z',
    action_consent: {
      action_binding_id: actionBinding, action_key: 'send', authority_epoch: 1, consent_id: actionBinding,
      consent_digest: `sha256:${'b'.repeat(64)}`, expires_at: '2098-12-15T00:00:00.000Z',
    },
  };
  await client.query('BEGIN');
  try {
    await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [fixture.org, 'Restore test', `restore-${tag}`]);
    await client.query('INSERT INTO users(id,name,email,kind) VALUES($1,$2,$3,$4)',
      [fixture.user, 'Restore test', `${fixture.user}@example.test`, 'human']);
    await client.query(`INSERT INTO org_members(id,org_id,user_id,role,is_active,app_run_authorization_version,joined_at,created_at,updated_at)
      VALUES($1,$2,$3,'owner',true,1,now(),now(),now())`, [fixture.member, fixture.org, fixture.user]);
    await client.query(`INSERT INTO web_sessions(id,user_id,org_id,refresh_token_hash,expires_at)
      VALUES($1,$2,$3,$4,now() + interval '1 hour')`, [fixture.webSession, fixture.user, fixture.org, 'a'.repeat(64)]);
    await client.query(`INSERT INTO app_connection_sessions
      (org_id,owner_user_id,session_id,web_session_id,access_expires_at,revision,record,created_at,updated_at)
      VALUES($1,$2,$3,$4,now() + interval '1 hour',0,$5::jsonb,$6,$6)`,
    [fixture.org, fixture.user, fixture.sessionId, fixture.webSession, JSON.stringify(fixture.record), '2026-11-16T00:00:00.000Z']);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return fixture;
}

async function removeFixture(client: pg.Client, fixture: Fixture) {
  await client.query('DELETE FROM app_connection_sessions WHERE org_id=$1 AND session_id=$2', [fixture.org, fixture.sessionId]);
  await client.query('DELETE FROM web_sessions WHERE id=$1', [fixture.webSession]);
  await client.query('DELETE FROM org_members WHERE id=$1', [fixture.member]);
  await client.query('DELETE FROM users WHERE id=$1', [fixture.user]);
  await client.query('DELETE FROM orgs WHERE id=$1', [fixture.org]);
}

async function rowCounts(url: string) {
  return withClient(url, async (client) => {
    const tables = (await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows;
    const counts: Record<string, number> = {};
    for (const { tablename } of tables) {
      const name = `public."${tablename.replaceAll('"', '""')}"`;
      counts[tablename] = Number((await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${name}`)).rows[0]!.count);
    }
    return counts;
  });
}

const routes = [
  { name: 'custom format (pg_dump -Fc, pg_restore)', file: 'database.dump', dump: ['--format=custom'],
    restore: (file: string) => ['pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', '', file]] as const },
  { name: 'plain SQL (pg_dump, psql)', file: 'database.sql', dump: ['--format=plain', '--clean', '--if-exists'],
    restore: (file: string) => ['psql', ['--quiet', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '--file', file]] as const },
] as const;

for (const route of routes) {
  test(`a database with stored rows restores from a ${route.name} dump`, { skip: plan.skip, timeout: 600_000 }, async () => {
    assert.ok(plan.skip === false);
    const { source, sourceName, targetName } = plan;
    const directory = mkdtempSync(join(tmpdir(), 'deft-restore-test-'));
    const file = join(directory, route.file);
    let fixture: Fixture | undefined;
    let scratchCreated = false;
    try {
      fixture = await withClient(sourceUrl!, insertFixture);
      const expected = await rowCounts(sourceUrl!);
      assert.equal(expected.app_connection_sessions! >= 1, true);

      await withClient(urlFor(source, 'postgres'), (client) => client.query(`CREATE DATABASE "${targetName}"`));
      scratchCreated = true;
      const dumped = await run('pg_dump', source, sourceName,
        [...route.dump, '--no-owner', '--no-privileges', '--file', file]);
      assert.equal(dumped.code, 0, `pg_dump failed:\n${dumped.output}`);

      const [program, args] = route.restore(file);
      const restored = await run(program, source, targetName,
        args.map((arg) => arg === '' ? targetName : arg));
      assert.equal(restored.code, 0, `${program} could not restore the dump:\n${restored.output}`);

      assert.deepEqual(await rowCounts(urlFor(source, targetName)), expected, 'every table keeps every row');
      const record = await withClient(urlFor(source, targetName), async (client) =>
        (await client.query<{ record: unknown }>(
          'SELECT record FROM app_connection_sessions WHERE org_id=$1 AND session_id=$2',
          [fixture!.org, fixture!.sessionId])).rows[0]?.record);
      assert.deepEqual(record, fixture.record, 'the stored connection session is restored unchanged');
    } finally {
      if (fixture) await withClient(sourceUrl!, (client) => removeFixture(client, fixture!));
      if (scratchCreated) await withClient(urlFor(source, 'postgres'), (client) => client.query(`DROP DATABASE "${targetName}"`));
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
