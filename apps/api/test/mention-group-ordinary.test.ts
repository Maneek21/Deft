import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

test('ordinary configured two-member group handle delivers one mention to each member', async () => {
  const url = safeTestDatabaseUrl();
  assert.ok(url, 'Requires guarded isolated test database');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const org = randomUUID(), room = randomUUID(), group = randomUUID();
  const sender = randomUUID(), amina = randomUUID(), noah = randomUUID();
  try {
    await c.query('INSERT INTO orgs (id,name,slug) VALUES ($1,$2,$3)', [org, 'Ordinary mention fixture', `mention-${org}`]);
    for (const [id, name] of [[sender, 'Maya'], [amina, 'Amina'], [noah, 'Noah']]) {
      await c.query("INSERT INTO users (id,email,name,kind,is_agent) VALUES ($1,$2,$3,'human',false)", [id, `${id}@example.test`, name]);
      await c.query("INSERT INTO org_members (id,org_id,user_id,role,is_active) VALUES (gen_random_uuid()::text,$1,$2,'member',true)", [org, id]);
    }
    await c.query("INSERT INTO spaces (id,org_id,name,type,created_by) VALUES ($1,$2,'Synthetic launch','public',$3)", [room, org, sender]);
    for (const id of [sender, amina, noah]) await c.query('INSERT INTO space_members (id,space_id,user_id) VALUES (gen_random_uuid()::text,$1,$2)', [room, id]);
    await c.query("INSERT INTO user_groups (id,org_id,name,handle,created_by) VALUES ($1,$2,'Launch reviewers','synthetic-reviewers',$3)", [group, org, sender]);
    for (const id of [amina, noah]) await c.query('INSERT INTO user_group_members (id,group_id,user_id) VALUES (gen_random_uuid()::text,$1,$2)', [group, id]);
    const { messageRoutes } = await import('../src/routes/messages.js');
    const { groupRoutes } = await import('../src/routes/groups.js');
    const app = new Hono();
    app.use('*', async (ctx, next) => { ctx.set('user', { id: sender, org_id: org, role: 'member' } as any); await next(); });
    app.route('/api/messages', messageRoutes); app.route('/api/groups', groupRoutes);
    const discovered = await app.request('/api/groups');
    assert.equal(discovered.status, 200);
    const groups = await discovered.json();
    assert.equal(groups.find((value: any) => value.id === group).member_count, 2);
    const posted = await app.request(`/api/messages/${room}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '<p>@synthetic-reviewers Please review the synthetic checklist.</p>' }) });
    assert.equal(posted.status, 201, await posted.clone().text());
    const result = await posted.json();
    const message = result.message ?? result;
    const notifications = await c.query("SELECT user_id, link FROM notifications WHERE org_id=$1 AND type='mention' ORDER BY user_id", [org]);
    assert.deepEqual(notifications.rows.map(row => row.user_id).sort(), [amina, noah].sort());
    for (const row of notifications.rows) assert.equal(row.link, `/chat?space=${room}&message=${message.id}`);
  } finally {
    await c.query('DELETE FROM notifications WHERE org_id=$1', [org]);
    await c.query("DELETE FROM job_queue WHERE data->>'orgId'=$1 OR data->>'org_id'=$1", [org]);
    await c.query('DELETE FROM messages WHERE org_id=$1', [org]);
    await c.query('DELETE FROM user_group_members WHERE group_id=$1', [group]);
    await c.query('DELETE FROM user_groups WHERE id=$1', [group]);
    await c.query('DELETE FROM space_members WHERE space_id=$1', [room]);
    await c.query('DELETE FROM spaces WHERE id=$1', [room]);
    await c.query('DELETE FROM org_members WHERE org_id=$1', [org]);
    await c.query('DELETE FROM orgs WHERE id=$1', [org]);
    await c.query('DELETE FROM users WHERE id=ANY($1::text[])', [[sender, amina, noah]]);
    await c.end();
  }
});
