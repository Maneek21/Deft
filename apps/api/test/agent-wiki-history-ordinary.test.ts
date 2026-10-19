import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
if (!databaseUrl) throw new Error('Ordinary wiki history test requires the guarded disposable database');

test('ordinary approved wiki update exposes original v1 through history and leaves no-op history unchanged', async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const orgId = randomUUID();
  const userId = randomUUID();
  const pageId = randomUUID();
  const actionId = randomUUID();
  const noOpActionId = randomUUID();
  const slug = `ordinary-history-${randomUUID()}`;
  const title = 'Synthetic ordinary reviewed publication';
  const summary = 'Synthetic publication summary';
  const original = 'Original approved facts and source reference.\n\nRetain the unresolved start.';
  const updated = `${original}\n\nThe customer technical-review owner is assigned.`;
  try {
    await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, title, slug]);
    await client.query('INSERT INTO users(id,email,name,is_agent) VALUES($1,$2,$3,false)', [userId, `${userId}@invalid.example`, 'Synthetic ordinary editor']);
    await client.query("INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,'admin',true)", [randomUUID(), orgId, userId]);
    await client.query("INSERT INTO wiki_pages(id,org_id,scope,type,title,slug,summary,content,version,user_id) VALUES($1,$2,'org','decision',$3,$4,$5,$6,1,$7)", [pageId, orgId, title, slug, summary, original, userId]);
    const params = { slug, title, summary, type: 'decision', content: updated };
    await client.query("INSERT INTO agent_actions(id,org_id,user_id,source,action,params,approval_tier,approval_status) VALUES($1,$2,$3,'native','wiki_write',$4::jsonb,'quick','approved')", [actionId, orgId, userId, JSON.stringify(params)]);

    const { executeAction } = await import('../src/lib/agent-actions.js');
    const { wikiRoutes } = await import('../src/routes/wiki.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('user', { id: userId, org_id: orgId, role: 'admin', email: `${userId}@invalid.example` } as any);
      await next();
    });
    app.route('/api/wiki', wikiRoutes);
    const result = await executeAction(actionId, 'wiki_write', params, orgId, userId);
    assert.equal(result.success, true, result.error);

    const historyResponse = await app.request(`/api/wiki/${slug}/history`);
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json() as { versions: Array<Record<string, unknown>> };
    assert.equal(history.versions.length, 1, 'The prior full version must be discoverable, not only previous_content');
    assert.equal(history.versions[0]!.version, 1);
    assert.equal(history.versions[0]!.title, title);
    assert.equal(history.versions[0]!.summary, summary);
    assert.equal(history.versions[0]!.content, original);
    assert.equal(history.versions[0]!.edited_by, userId);
    const originalResponse = await app.request(`/api/wiki/${slug}/history/1`);
    assert.equal(originalResponse.status, 200);
    assert.equal((await originalResponse.json() as { content: string }).content, original);
    const currentResponse = await app.request(`/api/wiki/${slug}`);
    assert.equal(currentResponse.status, 200);
    const current = await currentResponse.json() as { version: number; content: string; previous_content: string };
    assert.equal(current.version, 2);
    assert.equal(current.content, updated);
    assert.equal(current.previous_content, original);

    // A separate ordinary unchanged-content action is not an execution replay.
    await client.query("INSERT INTO agent_actions(id,org_id,user_id,source,action,params,approval_tier,approval_status) VALUES($1,$2,$3,'native','wiki_write',$4::jsonb,'quick','approved')", [noOpActionId, orgId, userId, JSON.stringify(params)]);
    const noOp = await executeAction(noOpActionId, 'wiki_write', params, orgId, userId);
    assert.equal(noOp.success, true, noOp.error);
    const afterNoOp = await client.query('SELECT version FROM wiki_page_versions WHERE page_id=$1 ORDER BY version', [pageId]);
    assert.deepEqual(afterNoOp.rows.map(row => row.version), [1]);
    const afterCurrent = await client.query('SELECT version,content FROM wiki_pages WHERE id=$1', [pageId]);
    assert.equal(afterCurrent.rows[0].version, 2);
    assert.equal(afterCurrent.rows[0].content, updated);
  } finally {
    await client.query('DELETE FROM wiki_ops_log WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM audit_log WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM agent_actions WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM wiki_pages WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=$1', [userId]);
    await client.end();
    const { closeDb } = await import('../src/lib/db.js');
    await closeDb();
  }
});
