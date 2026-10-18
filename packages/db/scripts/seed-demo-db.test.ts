/** Requires a fresh, disposable schema; intentionally retains the protected marker fixture. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import pg from 'pg';

const enabled = process.env.DEFT_TEST_SEED_DEMO_PROFILE === 'native_retention';
const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('demo seed accepts fresh ledgered data and preserves native adoption retention', { skip: !enabled }, async () => {
  assert.ok(databaseUrl);
  assert.equal(process.env.DATABASE_URL, databaseUrl);
  const address = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost'].includes(address.hostname));
  assert.match(address.pathname, /^\/deft(?:_[a-z0-9]+)*_test$/);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const tables = (await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    assert.ok(tables.some((row) => row.tablename === 'native_email_adoptions'));
    for (const { tablename } of tables) {
      if (tablename === 'deft_schema_migrations') continue;
      const identifier = '"' + tablename.replaceAll('"', '""') + '"';
      assert.equal((await client.query(`SELECT EXISTS(SELECT 1 FROM public.${identifier}) AS populated`)).rows[0].populated, false, 'requires fresh table: ' + tablename);
    }
    const ledgerBefore = (await client.query('SELECT * FROM deft_schema_migrations ORDER BY version')).rows;
    assert.ok(ledgerBefore.length > 0, 'requires the normal fresh schema migration ledger');
    const invokeSeed = () => spawnSync(process.execPath, [fileURLToPath(import.meta.resolve('tsx/cli')), resolve(packageDir, 'seed-demo.ts')], {
      cwd: packageDir, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 120_000,
    });
    const fresh = invokeSeed();
    assert.equal(fresh.status, 0, fresh.stderr);
    const [workspace] = (await client.query("SELECT o.id AS org_id, m.user_id AS owner_user_id FROM orgs o JOIN org_members m ON m.org_id=o.id WHERE o.slug='testers-tomatoes' AND m.role='owner'")).rows;
    assert.ok(workspace, 'real demo workspace was seeded');
    assert.deepEqual((await client.query('SELECT * FROM deft_schema_migrations ORDER BY version')).rows, ledgerBefore, 'fresh seeding preserves the migration ledger');

    const accountId = 'seed_retention_' + randomUUID().replaceAll('-', '');
    await client.query(`INSERT INTO email_accounts(org_id,owner_user_id,account_id,provider,credential_source,resource_binding_id)
      VALUES($1,$2,$3,'gmail','native_owner_provider_v1',$4)`, [workspace.org_id, workspace.owner_user_id, accountId, randomUUID()]);
    await client.query(`INSERT INTO native_email_adoptions(org_id,owner_user_id,account_id,adoption_id,revision,state,
      source_generation,source_authority_revision,source_consent_revision,source_principal_digest,source_binding_digest,created_at,updated_at)
      VALUES($1,$2,$3,$4,1,'native_frozen',1,1,1,$5,$5,now(),now())`,
      [workspace.org_id, workspace.owner_user_id, accountId, randomUUID(), 'a'.repeat(64)]);
    const markerBefore = (await client.query('SELECT * FROM native_email_adoptions')).rows;
    const usersBefore = (await client.query('SELECT id FROM users ORDER BY id')).rows;
    const protectedReset = invokeSeed();
    assert.notEqual(protectedReset.status, 0, 'populated adoption must reject a destructive demo reset');
    assert.match(protectedReset.stderr, /EMAIL_NATIVE_(?:ADOPTION_MARKER_RETAINED|ADOPTION_DESTINATION_RETAINED|ACCOUNT_ADOPTED_READ_ONLY)/);
    assert.deepEqual((await client.query('SELECT * FROM native_email_adoptions')).rows, markerBefore);
    assert.deepEqual((await client.query('SELECT id FROM users ORDER BY id')).rows, usersBefore, 'rejected reset is atomic');
    assert.deepEqual((await client.query('SELECT * FROM deft_schema_migrations ORDER BY version')).rows, ledgerBefore);
  } finally {
    await client.end();
  }
});
