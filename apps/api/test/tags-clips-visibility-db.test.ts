/**
 * Before-strangers fix 2: tags and clips must not reach items the caller cannot see.
 *
 *   - Tag counts count only the tagged items the caller can see (the same
 *     rule as the tagged-items list), so a count says nothing about a private
 *     space, a restricted task or someone's private note.
 *   - Deleting a tag removes it from every item, including ones the caller
 *     cannot see, so it is for owners and admins only.
 *   - The clips list of a space leaves out a clip the caller could not open
 *     directly (its message was deleted, or sits in a thread they cannot read).
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/tags-clips-visibility-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const ids = { owner: randomUUID(), admin: randomUUID(), insider: randomUUID(), outsider: randomUUID(), guest: randomUUID() };
const roles: Record<string, 'owner' | 'admin' | 'member' | 'guest'> = {
  [ids.owner]: 'owner', [ids.admin]: 'admin', [ids.insider]: 'member', [ids.outsider]: 'member', [ids.guest]: 'guest',
};
const S = { secret: randomUUID(), shared: randomUUID() };
const M = { secret: randomUUID(), secretReply: randomUUID(), shared: randomUUID(), deleted: randomUUID() };
const projectId = randomUUID();
const tasks = { open: randomUUID(), restricted: randomUUID() };
const notes = { org: randomUUID(), private: randomUUID() };
const clips = { ok: randomUUID(), deletedMessage: randomUUID(), secretThread: randomUUID() };
const tags = { main: randomUUID(), secretOnly: randomUUID(), forAdmin: randomUUID(), forOwner: randomUUID() };
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;
let app: Hono | undefined;

async function call(actor: string, method: string, path: string, sessionRole?: string) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: actor, org_id: orgId, email: `${actor}@example.test`, sid: `tags-${actor}`, role: sessionRole ?? roles[actor] } as any);
    await next();
  });
  hono.route('/', app!);
  const response = await hono.request(path, { method });
  const text = await response.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: response.status, json, text };
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  const q = (text: string, values: unknown[]) => client!.query(text, values);
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Tags and clips', `tags-clips-${orgId}`]);
  for (const [name, id] of Object.entries(ids)) {
    await q(`INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,'human',false)`, [id, `${id}@example.test`, name]);
    await q('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, id, roles[id]]);
  }
  for (const [id, members] of [[S.secret, [ids.insider]], [S.shared, [ids.insider, ids.outsider]]] as const) {
    await q(`INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,'private',$4)`, [id, orgId, `private-${id}`, ids.insider]);
    for (const member of members) await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), id, member]);
  }
  const message = (id: string, space: string, parent: string | null, deleted: boolean) => q(
    'INSERT INTO messages(id,org_id,space_id,user_id,content,parent_id,is_deleted) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [id, orgId, space, ids.insider, 'CANARY-MESSAGE', parent, deleted]);
  await message(M.secret, S.secret, null, false);
  await message(M.secretReply, S.secret, M.secret, false);
  await message(M.shared, S.shared, null, false);
  await message(M.deleted, S.shared, null, true);

  await q('INSERT INTO projects(id,org_id,name,prefix) VALUES($1,$2,$3,$4)', [projectId, orgId, 'Tags', 'TGS']);
  await q(`INSERT INTO tasks(id,org_id,project_id,number,title,status,created_by) VALUES($1,$2,$3,1,'Open task','todo',$4)`,
    [tasks.open, orgId, projectId, ids.insider]);
  await q(`INSERT INTO tasks(id,org_id,project_id,number,title,status,created_by,metadata) VALUES($1,$2,$3,2,'CANARY-TASK','todo',$4,'{"visibility":"restricted"}')`,
    [tasks.restricted, orgId, projectId, ids.insider]);
  await q(`INSERT INTO notes(id,org_id,user_id,title,visibility) VALUES($1,$2,$3,'Org note','org')`, [notes.org, orgId, ids.insider]);
  await q(`INSERT INTO notes(id,org_id,user_id,title,visibility) VALUES($1,$2,$3,'CANARY-NOTE','private')`, [notes.private, orgId, ids.insider]);

  // Three clips filed under the shared space. Only the first can be opened by everyone in it.
  const clip = (id: string, messageId: string, contextType: 'space' | 'thread', contextId: string, transcript: string) => q(
    `INSERT INTO clips(id,org_id,space_id,message_id,context_type,context_id,created_by,file_key,status,transcript)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ready',$9)`,
    [id, orgId, S.shared, messageId, contextType, contextId, ids.insider, `${id}.webm`, transcript]);
  await clip(clips.ok, M.shared, 'space', S.shared, 'shared clip');
  await clip(clips.deletedMessage, M.deleted, 'space', S.shared, 'CANARY-CLIP-DELETED');
  await clip(clips.secretThread, M.secretReply, 'thread', M.secret, 'CANARY-CLIP-THREAD');

  for (const [id, name] of [[tags.main, 'main'], [tags.secretOnly, 'secret-only'], [tags.forAdmin, 'for-admin'], [tags.forOwner, 'for-owner']] as const) {
    await q('INSERT INTO tags(id,org_id,name) VALUES($1,$2,$3)', [id, orgId, name]);
  }
  const apply = (tag: string, type: string, entity: string) => q(
    'INSERT INTO entity_tags(id,org_id,tag_id,entity_type,entity_id) VALUES($1,$2,$3,$4,$5)', [randomUUID(), orgId, tag, type, entity]);
  for (const [type, entity] of [
    ['message', M.shared], ['task', tasks.open], ['note', notes.org], ['clip', clips.ok], // visible to everyone in the shared space
    ['message', M.secret], ['message', M.deleted], ['task', tasks.restricted], ['note', notes.private], // not visible to the outsider
    ['clip', clips.secretThread], ['clip', clips.deletedMessage],
  ] as const) await apply(tags.main, type, entity);
  await apply(tags.secretOnly, 'message', M.secret);
  await apply(tags.forAdmin, 'message', M.secret);
  await apply(tags.forOwner, 'message', M.secret);

  app = new Hono()
    .route('/api/tags', (await import('../src/routes/tags.js')).tagRoutes)
    .route('/api/clips', (await import('../src/routes/clips.js')).clipRoutes);
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    for (const table of ['entity_tags', 'tags', 'clips', 'notes', 'task_activity', 'tasks', 'projects']) {
      await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
    }
    await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
    await client.query('UPDATE messages SET parent_id=NULL WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM messages WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(ids)]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

const countsFor = async (actor: string) => {
  const response = await call(actor, 'GET', '/api/tags');
  assert.equal(response.status, 200, response.text);
  return Object.fromEntries((response.json as Array<{ name: string; count: number }>).map((tag) => [tag.name, tag.count]));
};
const tagRows = async (tag: string) =>
  Number((await client!.query('SELECT count(*)::int AS n FROM entity_tags WHERE tag_id=$1', [tag])).rows[0].n);
const tagExists = async (tag: string) =>
  (await client!.query('SELECT 1 FROM tags WHERE id=$1', [tag])).rowCount === 1;

test('tag counts count only the items the caller can see', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // The insider is in both spaces and owns the restricted task and the private note.
  // The clip whose message was deleted and the deleted message itself are visible to nobody.
  assert.deepEqual(await countsFor(ids.insider), { 'for-admin': 1, 'for-owner': 1, main: 8, 'secret-only': 1 });
  // The outsider sees the shared-space message and clip, the open task and the org note.
  assert.deepEqual(await countsFor(ids.outsider), { 'for-admin': 0, 'for-owner': 0, main: 4, 'secret-only': 0 });
  // Owners and admins get no wider view than their own access: the count matches the list they are shown.
  assert.deepEqual(await countsFor(ids.admin), { 'for-admin': 0, 'for-owner': 0, main: 2, 'secret-only': 0 });
  // A guest in no space sees the open task and the org note, as in the tagged-items list.
  assert.deepEqual(await countsFor(ids.guest), { 'for-admin': 0, 'for-owner': 0, main: 2, 'secret-only': 0 });

  for (const actor of [ids.insider, ids.outsider, ids.admin, ids.guest]) {
    const listed = await call(actor, 'GET', `/api/tags/${tags.main}/entities`);
    assert.equal(listed.status, 200, listed.text);
    assert.equal((await countsFor(actor)).main, listed.json.length, 'the count equals the number of items listed');
  }
});

test('only owners and admins can delete a tag', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const [actor, sessionRole] of [[ids.outsider, undefined], [ids.insider, undefined], [ids.guest, undefined], [ids.outsider, 'owner']] as const) {
    const refused = await call(actor, 'DELETE', `/api/tags/${tags.secretOnly}`, sessionRole);
    assert.equal(refused.status, 403, refused.text);
    assert.deepEqual(refused.json, { error: 'Only owners and admins can delete tags', code: 'FORBIDDEN' });
  }
  assert.equal(await tagExists(tags.secretOnly), true);
  assert.equal(await tagRows(tags.secretOnly), 1, 'the tag is still on the item the member cannot see');

  for (const [actor, tag] of [[ids.admin, tags.forAdmin], [ids.owner, tags.forOwner]] as const) {
    const deleted = await call(actor, 'DELETE', `/api/tags/${tag}`);
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(await tagExists(tag), false);
    assert.equal(await tagRows(tag), 0);
  }
  const missing = await call(ids.admin, 'DELETE', `/api/tags/${randomUUID()}`);
  assert.equal(missing.status, 404, missing.text);
});

test('the clips list of a space leaves out clips the caller cannot open', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const listFor = async (actor: string) => {
    const response = await call(actor, 'GET', `/api/clips/space/${S.shared}`);
    assert.equal(response.status, 200, response.text);
    return response;
  };
  const outsider = await listFor(ids.outsider);
  assert.deepEqual(outsider.json.map((clip: any) => clip.id), [clips.ok]);
  assert.ok(!outsider.text.includes('CANARY'), outsider.text);
  // The list now agrees with opening each clip directly.
  for (const [clip, status] of [[clips.ok, 200], [clips.deletedMessage, 404], [clips.secretThread, 404]] as const) {
    assert.equal((await call(ids.outsider, 'GET', `/api/clips/${clip}`)).status, status);
  }
  // Someone who can read the thread still gets its clip; nobody gets the clip of a deleted message.
  const insider = await listFor(ids.insider);
  assert.deepEqual(insider.json.map((clip: any) => clip.id).sort(), [clips.ok, clips.secretThread].sort());
  // Not in the space at all: refused as before.
  assert.equal((await call(ids.admin, 'GET', `/api/clips/space/${S.shared}`)).status, 403);
});
