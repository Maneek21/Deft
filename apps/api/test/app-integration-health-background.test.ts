import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

/** §P3b — background lease health derives healthy/paused/ended from
 * `until_revoked` runtime sessions and never crosses tenant/owner/installation.
 * Self-contained: the runtime tables are created in a dedicated schema so the
 * test is a no-op against the minimal local baseline and safe on a full push. */
const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && /^\/deft_test/u.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
})();
pg.defaults.parseInputDatesAsUTC = true;

const at = (ms: number) => new Date(ms);

test('background health derives state from runtime sessions and stays owner/tenant scoped',
  { skip: !safe, timeout: 120000 }, async () => {
    const pool = new pg.Pool({ connectionString: target, max: 2 });
    const schema = `p3b_bg_${randomUUID().replaceAll('-', '')}`;
    const q = (table: string) => `"${schema}".${table}`;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE ${q('app_runtime_sessions')} (
        id text PRIMARY KEY, org_id text NOT NULL, operator_user_id text NOT NULL,
        runtime_binding_id text, resource_binding_id text, renewal_lifetime text,
        expires_at timestamp NOT NULL, revoked_at timestamp,
        created_at timestamp NOT NULL, updated_at timestamp NOT NULL)`);
      await pool.query(`CREATE TABLE ${q('app_runtime_bindings')} (
        id text PRIMARY KEY, org_id text NOT NULL, app_installation_id text NOT NULL)`);
      await pool.query(`CREATE TABLE ${q('app_resource_bindings')} (
        id text PRIMARY KEY, org_id text NOT NULL, app_installation_id text NOT NULL)`);

      const { drizzle } = await import('drizzle-orm/node-postgres');
      const { default: schemaObj } = await import('@deft/db/schema');
      const { sql } = await import('drizzle-orm');
      const db = drizzle(pool, { schema: schemaObj });
      const { readBackgroundHealth } = await import('../src/lib/app-integration-capture-store.js');

      const orgA = randomUUID(), ownerA = randomUUID(), instA = randomUUID();
      const ownerB = randomUUID();
      const bindingA = randomUUID();
      await pool.query(`INSERT INTO ${q('app_runtime_bindings')} (id, org_id, app_installation_id) VALUES ($1,$2,$3)`,
        [bindingA, orgA, instA]);

      const now = Date.now();
      const seed = (expires: Date, revoked: Date | null) => pool.query(
        `INSERT INTO ${q('app_runtime_sessions')} (id, org_id, operator_user_id, runtime_binding_id, resource_binding_id, renewal_lifetime, expires_at, revoked_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,NULL,'until_revoked',$5,$6,$7,$7)`,
        [randomUUID(), orgA, ownerA, bindingA, expires, revoked, at(now - 60_000)]);

      const run = (orgId: string, userId: string, installationId: string) => db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL search_path TO "${schema}"`));
        return readBackgroundHealth(tx as never, { org_id: orgId, user_id: userId, kind: 'human', principal_id: userId } as never,
          installationId, now);
      });

      await seed(at(now + 60_000), null);
      assert.equal((await run(orgA, ownerA, instA))?.state, 'healthy');
      await seed(at(now - 20 * 60_000), null);
      assert.equal((await run(orgA, ownerA, instA))?.state, 'paused');
      await seed(at(now - 25 * 60 * 60_000), null);
      assert.equal((await run(orgA, ownerA, instA))?.state, 'ended');
      await seed(at(now + 60_000), at(now - 1));
      assert.equal((await run(orgA, ownerA, instA))?.state, 'ended');

      // Owner/tenant/installation isolation: the lease never leaks across.
      assert.equal(await run(randomUUID(), ownerA, instA), null, 'foreign tenant');
      assert.equal(await run(orgA, ownerB, instA), null, 'foreign owner');
      assert.equal(await run(orgA, ownerA, randomUUID()), null, 'foreign installation');
    } finally {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
      await pool.end();
    }
  });
