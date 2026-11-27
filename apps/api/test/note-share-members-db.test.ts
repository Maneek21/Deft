// The note Share dialog lists people from GET /api/members and sends the
// picked person's id to POST /api/daily-notes/:id/shares. On 156 it read a
// `user_id` field the members list does not have and sent `{}`, which the
// route refuses with 400 "user_id required". This pins the contract the
// dialog relies on: the members list gives each person as `id`, that id shares
// the note, the person can then read it and nobody else can, the shares list
// gives each person as `user_id`, and removing by that id unshares.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { memberRoutes } from '../src/routes/members.js';
import { dailyNoteRoutes } from '../src/routes/daily-notes.js';
import { ensureDeftyDm, ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
const run = randomUUID().slice(0, 8);
const org = randomUUID();
const owner = randomUUID(), raj = randomUUID(), ana = randomUUID(), gus = randomUUID();
const note = randomUUID();
const people: Array<[string, string, string]> = [
  [owner, 'Sam Owner', 'owner'],
  [raj, 'Raj Patel', 'member'],
  [ana, 'Ana Silva', 'member'],
  [gus, 'Gus Guest', 'guest'],
];
const emailOf = (id: string) => `nsm-${run}-${id}@test.local`;

before(async () => {
  await c.connect();
  await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Note Share', $2)`, [org, `note-share-${run}`]);
  for (const [id, name, role] of people) {
    await c.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'hash')`, [id, emailOf(id), `${name} ${run}`]);
    await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, true)`, [org, id, role]);
  }
  await c.query(`INSERT INTO notes (id, org_id, user_id, title, content, visibility) VALUES ($1, $2, $3, 'nsm note', '<p>plan</p>', 'private')`, [note, org, owner]);
});

after(async () => {
  await c.query(`DELETE FROM note_shares WHERE note_id = $1`, [note]);
  await c.query(`DELETE FROM notes WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM messages WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM spaces WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM org_members WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [people.map(([id]) => id)]);
  await c.query(`DELETE FROM orgs WHERE id = $1`, [org]);
  await c.end();
});

function app(viewer: string) {
  const hono = new Hono();
  hono.use('*', async (ctx, next) => {
    ctx.set('user', { id: viewer, org_id: org, email: emailOf(viewer), sid: 's', role: people.find(([id]) => id === viewer)![2] } as never);
    await next();
  });
  hono.route('/api/members', memberRoutes);
  hono.route('/api/daily-notes', dailyNoteRoutes);
  return hono;
}

async function call(viewer: string, path: string, init?: { method: string; body?: unknown }) {
  const res = await app(viewer).request(path, init ? {
    method: init.method,
    headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  } : undefined);
  return { status: res.status, body: await res.json() as any };
}

test('note share: the id GET /api/members gives a person shares the note with them, and only them', async () => {
  const members = await call(owner, '/api/members');
  assert.equal(members.status, 200);
  const rajRow = (members.body as Array<Record<string, unknown>>).find((m) => m.email === emailOf(raj));
  assert.ok(rajRow, 'Raj is listed');
  assert.equal(rajRow.id, raj, 'the members list gives each person as `id`');
  assert.equal('user_id' in rajRow, false, 'and has no `user_id` field');

  // What the 156 dialog sent.
  const empty = await call(owner, `/api/daily-notes/${note}/shares`, { method: 'POST', body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'user_id required');

  assert.equal((await call(raj, `/api/daily-notes/${note}`)).status, 404, 'Raj cannot read the private note before the share');
  const shared = await call(owner, `/api/daily-notes/${note}/shares`, { method: 'POST', body: { user_id: rajRow.id } });
  assert.equal(shared.status, 201);
  assert.equal(shared.body.shared_with_user_id, raj);

  assert.equal((await call(raj, `/api/daily-notes/${note}`)).status, 200, 'Raj reads the note once it is shared');
  assert.equal((await call(ana, `/api/daily-notes/${note}`)).status, 404, 'Ana, not shared with, still cannot');

  // The dialog lists shares by `user_id` and removes by it.
  const list = await call(owner, `/api/daily-notes/${note}/shares`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.shares.map((s: { user_id: string }) => s.user_id), [raj]);
  const removed = await call(owner, `/api/daily-notes/${note}/shares/${raj}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal((await call(raj, `/api/daily-notes/${note}`)).status, 404, 'Raj cannot read it once unshared');
});

test('note share: only the note\'s owner can share it', async () => {
  const res = await call(raj, `/api/daily-notes/${note}/shares`, { method: 'POST', body: { user_id: ana } });
  assert.equal(res.status, 404);
  const count = await c.query(`SELECT count(*)::int AS n FROM note_shares WHERE note_id = $1 AND shared_with_user_id = $2`, [note, ana]);
  assert.equal(count.rows[0].n, 0);
});

test('members list: Defty is flagged is_defty, also for a guest, who sees no email addresses', async () => {
  // The Share dialog leaves Defty out by this flag: Defty reads notes as the
  // person asking it, so a share gives it nothing.
  const defty = await ensureDeftyMembership(org);
  await ensureDeftyDm(org, gus);
  const asOwner = (await call(owner, '/api/members')).body as Array<Record<string, unknown>>;
  assert.equal(asOwner.find((m) => m.id === defty)?.is_defty, true);
  assert.equal(asOwner.find((m) => m.id === raj)?.is_defty, false);
  const asGuest = (await call(gus, '/api/members')).body as Array<Record<string, unknown>>;
  const deftyForGuest = asGuest.find((m) => m.id === defty);
  assert.ok(deftyForGuest, 'the guest sees Defty, with whom they have a DM');
  assert.equal(deftyForGuest.email, null, 'a guest sees no one else\'s email address');
  assert.equal(deftyForGuest.is_defty, true);
});
