import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

/** §Fix B A09 — background lease health must follow the connection owner whose
 * grant/consent the `until_revoked` lease runs on, never the runtime operator.
 * A shared Runtime owned by one human and operated by another must report the
 * lease to the owner only. Self-contained: the runtime tables are created in a
 * dedicated schema so the test is a no-op against a minimal baseline and safe
 * on a full push. */
const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.search && !url.hash;
  } catch { return false; }
})();
pg.defaults.parseInputDatesAsUTC = true;

test('background health belongs to the connection owner, not the runtime operator',
  { skip: !safe, timeout: 120000 }, async () => {
    const pool = new pg.Pool({ connectionString: target, max: 2 });
    const schema = `owner_bg_${randomUUID().replaceAll('-', '')}`;
    const q = (table: string) => `"${schema}".${table}`;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE ${q('app_runtime_sessions')} (
        id text PRIMARY KEY, org_id text NOT NULL, operator_user_id text NOT NULL,
        runtime_binding_id text, resource_binding_id text, renewal_lifetime text,
        expires_at timestamp NOT NULL, revoked_at timestamp,
        created_at timestamp NOT NULL, updated_at timestamp NOT NULL)`);
      await pool.query(`CREATE TABLE ${q('app_runtime_bindings')} (
        id text PRIMARY KEY, org_id text NOT NULL, app_installation_id text NOT NULL,
        owner_resource_binding_id text)`);
      await pool.query(`CREATE TABLE ${q('app_resource_bindings')} (
        id text PRIMARY KEY, org_id text NOT NULL, app_installation_id text NOT NULL,
        owner_user_id text NOT NULL, target_key text NOT NULL)`);

      const { drizzle } = await import('drizzle-orm/node-postgres');
      const { default: schemaObj } = await import('@deft/db/schema');
      const { sql } = await import('drizzle-orm');
      const db = drizzle(pool, { schema: schemaObj });
      const { readBackgroundHealth } = await import('../src/lib/app-integration-capture-store.js');

      const org = randomUUID(), owner = randomUUID(), operator = randomUUID(), inst = randomUUID();
      const resourceBinding = randomUUID(), runtimeBinding = randomUUID();
      await pool.query(`INSERT INTO ${q('app_resource_bindings')} (id, org_id, app_installation_id, owner_user_id, target_key) VALUES ($1,$2,$3,$4,$5)`,
        [resourceBinding, org, inst, owner, 'primary']);
      await pool.query(`INSERT INTO ${q('app_runtime_bindings')} (id, org_id, app_installation_id, owner_resource_binding_id) VALUES ($1,$2,$3,$4)`,
        [runtimeBinding, org, inst, resourceBinding]);

      const now = Date.now();
      // The operator (an admin) operates the shared runtime; the lease runs on
      // the owner's consent, so only the owner sees it as healthy.
      await pool.query(`INSERT INTO ${q('app_runtime_sessions')} (id, org_id, operator_user_id, runtime_binding_id, resource_binding_id, renewal_lifetime, expires_at, revoked_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,NULL,'until_revoked',$5,NULL,$6,$6)`,
        [randomUUID(), org, operator, runtimeBinding, new Date(now + 60_000), new Date(now - 60_000)]);

      const run = (userId: string) => db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL search_path TO "${schema}"`));
        return readBackgroundHealth(tx as never, { org_id: org, user_id: userId, kind: 'human', principal_id: userId } as never, inst, now);
      });

      assert.equal((await run(owner))?.state, 'healthy', 'owner sees the lease');
      assert.equal(await run(operator), null, 'operating a Runtime does not make the operator the account owner');
      assert.equal(await run(randomUUID()), null, 'foreign user sees no lease');
    } finally {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
      await pool.end();
    }
  });
