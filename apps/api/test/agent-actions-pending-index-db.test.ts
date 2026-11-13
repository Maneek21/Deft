import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

// The same definition is asserted after `db:upgrade` in the Versioned Upgrade
// CI job, so a fresh install and an upgraded install end with one index.
const EXPECTED_INDEXDEF = "CREATE INDEX agent_action_pending_org_created_idx ON public.agent_actions USING btree (org_id, created_at) WHERE (approval_status = 'pending'::approval_status)";

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && ['55442', '5432'].includes(url.port)
      && /^\/deft_test/u.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
})();

test('a fresh install has the valid pending agent actions index', { skip: !safe }, async () => {
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  try {
    const { rows } = await client.query<{ indexdef: string; valid: boolean; ready: boolean }>(`
      SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid AS valid, i.indisready AS ready
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'agent_action_pending_org_created_idx'`);
    assert.equal(rows.length, 1, 'agent_action_pending_org_created_idx exists');
    assert.deepEqual(rows[0], { indexdef: EXPECTED_INDEXDEF, valid: true, ready: true });
  } finally {
    await client.end();
  }
});
