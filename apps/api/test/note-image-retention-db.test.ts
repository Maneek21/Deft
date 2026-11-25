// An image pasted into a note is a staged upload: without a claim, the
// retention sweep deleted it (row and bytes) 24 hours later, and the note
// showed a broken image. Saving a note now claims the files it embeds, but
// only files of the note's workspace that the person saving uploaded.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { dailyNoteRoutes } from '../src/routes/daily-notes.js';
import { scheduledRoutes } from '../src/routes/scheduled.js';
import { sweepExpiredStagedAttachments } from '../src/lib/attachment-retention.js';
import { noteFileIds, claimNoteFiles } from '../src/lib/note-file-claims.js';
import { humanNoteCreate, humanNoteUpdate, type HumanToolContext } from '../src/lib/mcp-tools/human.js';
import { db } from '../src/lib/db.js';
import type { FileStore } from '../src/lib/file-store.js';
import { executeActionDirect } from '../src/lib/agent-actions.js';
import { createNativeNote } from '../src/lib/native-context-create.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

// The sweep below runs over the whole database: only ever on a disposable test database.
const url = safeTestDatabaseUrl();
const unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';

// The fixture client uses the checked URL, the same database the API and the sweep use.
const c = new pg.Client({ connectionString: url });
const run = randomUUID().slice(0, 8);
const org = randomUUID(), otherOrg = randomUUID();
const alice = randomUUID(), bob = randomUUID();
const fileIds: string[] = [];
const room = randomUUID();

async function stagedFile(orgId: string, uploader: string, kind = 'image', status = 'ready'): Promise<string> {
  const id = randomUUID();
  fileIds.push(id);
  await c.query(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key, processing_status, attachment_kind, staged_expires_at)
    VALUES ($1, $2, $3, 'pasted.png', 'image/png', 4, $4, $5, $6, now() + interval '24 hours')`, [id, orgId, uploader, `nir/${run}/${id}`, status, kind]);
  return id;
}

const expiryOf = async (id: string) => (await c.query(`SELECT staged_expires_at FROM files WHERE id = $1`, [id])).rows[0]?.staged_expires_at ?? null;
const exists = async (id: string) => (await c.query(`SELECT 1 FROM files WHERE id = $1`, [id])).rowCount === 1;
const deletedKeys: string[] = [];
const store = { delete: async (key: string) => { deletedKeys.push(key); } } as unknown as FileStore;
/** A retention run 25 hours from now, as retention maintenance would run it. */
const sweepAfter25h = () => sweepExpiredStagedAttachments({ now: new Date(Date.now() + 25 * 60 * 60 * 1000), store });

before(async () => {
  if (unavailable) return;
  await c.connect();
  for (const [id, slug] of [[org, `nir-${run}`], [otherOrg, `nir-other-${run}`]]) {
    await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Note Images', $2)`, [id, slug]);
  }
  for (const [id, name] of [[alice, 'Alice'], [bob, 'Bob']]) {
    await c.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'hash')`, [id, `nir-${run}-${id}@test.local`, name]);
    for (const orgId of [org, otherOrg]) {
      await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, 'member', true)`, [orgId, id]);
    }
  }
  await c.query(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, 'nir room', 'private', $3)`, [room, org, alice]);
  await c.query(`INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [room, alice]);
});

after(async () => {
  if (unavailable) return;
  // Rows Defty's create_note wrote.
  for (const [table, column] of [['action_receipts', 'action_id'], ['agent_action_approvers', 'action_id'], ['module_mutation_receipts', 'agent_action_id']]) {
    await c.query(`DELETE FROM ${table} WHERE ${column} IN (SELECT id FROM agent_actions WHERE org_id = ANY($1::text[]))`, [[org, otherOrg]]).catch(() => {});
  }
  await c.query(`DELETE FROM agent_actions WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]);
  await c.query(`DELETE FROM audit_log WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]).catch(() => {});
  await c.query(`DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE org_id = ANY($1::text[]))`, [[org, otherOrg]]);
  await c.query(`DELETE FROM notes WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]);
  await c.query(`DELETE FROM files WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]);
  await c.query(`DELETE FROM messages WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]);
  await c.query(`DELETE FROM scheduled_messages WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]).catch(() => {});
  await c.query(`DELETE FROM space_members WHERE space_id = $1`, [room]);
  await c.query(`DELETE FROM spaces WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]);
  await c.query(`DELETE FROM idempotency_keys WHERE user_id = ANY($1::text[])`, [[alice, bob]]).catch(() => {});
  await c.query(`DELETE FROM oauth_audit_events WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]).catch(() => {});
  await c.query(`DELETE FROM job_queue WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]).catch(() => {});
  await c.query(`DELETE FROM org_members WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]);
  await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[alice, bob]]);
  await c.query(`DELETE FROM orgs WHERE id = ANY($1::text[])`, [[org, otherOrg]]);
  await c.end();
});

function app(userId: string) {
  const hono = new Hono();
  hono.use('*', async (ctx, next) => {
    ctx.set('user', { id: userId, org_id: org, email: `nir-${run}-${userId}@test.local`, sid: 's', role: 'member' } as never);
    await next();
  });
  hono.route('/api/daily-notes', dailyNoteRoutes);
  hono.route('/api/scheduled-messages', scheduledRoutes);
  return hono;
}
async function send(userId: string, method: string, path: string, body: unknown) {
  const res = await app(userId).request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}
const img = (id: string) => `<img data-file-id="${id}" data-protected-note-image="" alt="pasted.png" title="pasted.png">`;

test('noteFileIds reads images as the editor does: data-file-id, else an older /api/files/ src', () => {
  const a = randomUUID(), b = randomUUID(), c2 = randomUUID();
  assert.deepEqual(noteFileIds(`<p>x</p>${img(a)}<img src="/api/files/${b}"><img data-file-id='${a}'><IMG data-file-id=${c2} alt=x>`), [a, b, c2]);
  assert.deepEqual(noteFileIds(`<img data-file-id="${a}" src="/api/files/${b}">`), [a], 'data-file-id wins, as in the editor');
  assert.deepEqual(noteFileIds(`<p>see /api/files/${a}</p><a href="/api/files/${b}">x</a>`), [], 'text and links are not images');
  assert.deepEqual(noteFileIds(null), []);
  assert.deepEqual(noteFileIds('<img src="/api/files/"><img data-file-id="">'), []);
  assert.deepEqual(noteFileIds(`<img alt="A > B" data-file-id="${a}">`), [a], 'a quoted > does not end the tag');
  assert.deepEqual(noteFileIds(`<!-- ${img(b)} -->${img(a)}`), [a], 'an image in a comment is not shown');
  assert.deepEqual(noteFileIds(`${img(a)}<!-- unclosed ${img(b)}`), [a], 'nor one after an unclosed comment');
  assert.deepEqual(noteFileIds(`<img alt="<!--" data-file-id="${a}"><!-- caption -->`), [a], 'a comment opener inside a quoted value is not a comment');
  assert.deepEqual(noteFileIds(`<p title="<!--">${img(a)}</p>`), [a], 'nor inside another tag');
  assert.deepEqual(noteFileIds(`<p title='<img data-file-id="${b}">'>x</p>${img(a)}`), [a], 'an img inside a quoted value is not an image');
  assert.deepEqual(noteFileIds(`<imgx data-file-id="${b}">${img(a)}`), [a], 'only img itself');
  assert.deepEqual(noteFileIds(`<img alt=' data-file-id="${b}"' data-file-id="${a}">`), [a], 'an attribute inside a quoted value is not an attribute');
  assert.deepEqual(noteFileIds(`<img data-file-id="${a}" data-file-id="${b}">`), [a], 'the first of a repeated attribute wins');
  assert.deepEqual(noteFileIds(`<textarea>${img(b)}</textarea>${img(a)}`), [a], 'an img inside a textarea is text');
  assert.deepEqual(noteFileIds(`<textarea><p title="</textarea><img data-file-id=${a}>`), [a], 'a textarea ends at its end tag');
  assert.deepEqual(noteFileIds(`<img alt=one /data-file-id=${b} src=/api/files/${a}>`), [a], 'a non-breaking space is not whitespace');
  assert.deepEqual(noteFileIds(`<img/data-file-id="&#97;&#x62;" src="/api/files/${b}">`), ['ab'], 'character references are decoded');
  // Crafted input with no closing '>' is read in one pass, not backtracked.
  const started = Date.now();
  noteFileIds('<a "<a" '.repeat(250_000));
  noteFileIds('<img '.repeat(400_000));
  noteFileIds('<!--'.repeat(500_000));
  assert.ok(Date.now() - started < 10_000, `parsing crafted input took ${Date.now() - started} ms`);
  const many = Array.from({ length: 1200 }, () => randomUUID());
  assert.equal(noteFileIds(many.map(img).join('')).length, 1200, 'no cap on images per note');
});

test('a note image created and edited in a note survives a sweep after 25 hours; an unreferenced staged file still goes', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const pastedAtCreate = await stagedFile(org, alice);
  const pastedLater = await stagedFile(org, alice);
  const legacy = await stagedFile(org, alice);
  const unreferenced = await stagedFile(org, alice);

  const created = await send(alice, 'POST', '/api/daily-notes', { title: `nir ${run}`, content: `<p>hello</p>${img(pastedAtCreate)}` });
  assert.equal(created.status, 201);
  assert.equal(await expiryOf(pastedAtCreate), null, 'claimed on create');
  assert.notEqual(await expiryOf(pastedLater), null, 'not yet in the note');
  const patched = await send(alice, 'PATCH', `/api/daily-notes/${created.body.id}`, {
    content: `<p>hello</p>${img(pastedAtCreate)}${img(pastedLater)}<img src="/api/files/${legacy}">`,
  });
  assert.equal(patched.status, 200);

  await sweepAfter25h();
  assert.equal(await exists(pastedAtCreate), true, 'image saved on create is kept');
  assert.equal(await exists(pastedLater), true, 'image saved on edit is kept');
  assert.equal(await exists(legacy), true, 'an older /api/files/ image is kept');
  assert.equal(await exists(unreferenced), false, 'an upload no note names is still swept');
});

test('an edit that is refused claims nothing', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const note = await send(alice, 'POST', '/api/daily-notes', { title: `nir refused ${run}`, content: '<p>mine</p>' });
  const bobs = await stagedFile(org, bob);
  const refused = await send(bob, 'PATCH', `/api/daily-notes/${note.body.id}`, { content: img(bobs) });
  assert.notEqual(refused.status, 200);
  assert.notEqual(await expiryOf(bobs), null, "Bob's upload keeps its expiry");
});

test('scheduling and cancelling a message that carries a note image keeps the image', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const file = await stagedFile(org, alice);
  const note = await send(alice, 'POST', '/api/daily-notes', { title: `nir sched ${run}`, content: img(file) });
  assert.equal(note.status, 201);
  const scheduled = await send(alice, 'POST', '/api/scheduled-messages', {
    space_id: room, content: `see [[file:${file}:pasted.png]]`, scheduled_for: new Date(Date.now() + 3600_000).toISOString(),
  });
  assert.equal(scheduled.status, 201, JSON.stringify(scheduled.body));
  assert.equal(await expiryOf(file), null, 'scheduling does not stage a claimed file again');
  const cancelled = await app(alice).request(`/api/scheduled-messages/${scheduled.body.id}`, { method: 'DELETE' });
  assert.equal(cancelled.status, 200);
  assert.equal(await expiryOf(file), null, 'cancelling does not stage it again');
  await sweepAfter25h();
  assert.equal(await exists(file), true);
});

test('a staged file of another person, or of another workspace, named in my note is not claimed', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const bobs = await stagedFile(org, bob);
  const mineElsewhere = await stagedFile(otherOrg, alice);
  const res = await send(alice, 'POST', '/api/daily-notes', { title: `nir theft ${run}`, content: `${img(bobs)}${img(mineElsewhere)}` });
  assert.equal(res.status, 201);
  const { rows } = await c.query(`SELECT id, staged_expires_at FROM files WHERE id = ANY($1::text[])`, [[bobs, mineElsewhere]]);
  for (const row of rows) assert.notEqual(row.staged_expires_at, null, `${row.id} keeps its expiry`);
  await sweepAfter25h();
  assert.equal(await exists(bobs), false, "another person's staged upload is swept as before");
  assert.equal(await exists(mineElsewhere), false, 'my upload in another workspace is swept as before');
});

test('MCP note_create and note_update claim the same way', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const ctx: HumanToolContext = { org_id: org, user_id: alice, role: 'member', scopes: ['read:workspace', 'write:workspace'] };
  const atCreate = await stagedFile(org, alice);
  const atUpdate = await stagedFile(org, alice);
  const bobs = await stagedFile(org, bob);
  const created = await humanNoteCreate({ title: `nir mcp ${run}`, content: img(atCreate) }, ctx);
  const note = JSON.parse(created.content[0]!.text).note as { id: string };
  assert.equal(await expiryOf(atCreate), null, 'claimed on create');
  await humanNoteUpdate({ note_id: note.id, content: `${img(atCreate)}${img(atUpdate)}${img(bobs)}` }, ctx);
  await sweepAfter25h();
  assert.equal(await exists(atCreate), true);
  assert.equal(await exists(atUpdate), true);
  assert.equal(await exists(bobs), false);
});

test('Defty create_note claims the same way', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const mine = await stagedFile(org, alice);
  const bobs = await stagedFile(org, bob);
  const res = await executeActionDirect('create_note', { title: `nir defty ${run}`, content: `${img(mine)}${img(bobs)}` }, org, alice, null, 'auto');
  assert.equal((res as { success?: boolean }).success, true, JSON.stringify(res));
  assert.equal(await expiryOf(mine), null);
  assert.notEqual(await expiryOf(bobs), null);
});

test('a note save that rolls back leaves the claim undone', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const file = await stagedFile(org, alice);
  const title = `nir rollback ${run}`;
  await assert.rejects(db.transaction(async (tx) => {
    await createNativeNote(tx, { id: alice, org_id: org }, { title, content: img(file) });
    throw new Error('rolled back');
  }), /rolled back/);
  assert.notEqual(await expiryOf(file), null, 'the file keeps its expiry');
  assert.equal((await c.query(`SELECT 1 FROM notes WHERE org_id = $1 AND title = $2`, [org, title])).rowCount, 0);
});

test('only an image the editor can show is claimed: not a PDF, not a blocked upload', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const pdf = await stagedFile(org, alice, 'pdf');
  const blocked = await stagedFile(org, alice, 'image', 'blocked');
  const image = await stagedFile(org, alice);
  assert.equal(await claimNoteFiles(db, { id: alice, org_id: org }, `${img(pdf)}${img(blocked)}${img(image)}`), 1);
  assert.notEqual(await expiryOf(pdf), null);
  assert.notEqual(await expiryOf(blocked), null);
  assert.equal(await expiryOf(image), null);
});

test('claimNoteFiles counts only the files it claimed, and leaves an attached file alone', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // A file on a message that still carries an expiry: the sweep never deletes it, and a note does not change it.
  const attached = await stagedFile(org, alice);
  const message = randomUUID();
  await c.query(`INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, 'with file')`, [message, org, room, alice]);
  await c.query(`UPDATE files SET message_id = $2 WHERE id = $1`, [attached, message]);
  assert.equal(await claimNoteFiles(db, { id: alice, org_id: org }, img(attached)), 0);
  assert.notEqual(await expiryOf(attached), null);
  const mine = await stagedFile(org, alice);
  const bobs = await stagedFile(org, bob);
  assert.equal(await claimNoteFiles(db, { id: alice, org_id: org }, `${img(mine)}${img(bobs)}${img(randomUUID())}`), 1);
  assert.equal(await claimNoteFiles(db, { id: alice, org_id: org }, img(mine)), 0, 'an already claimed file is not counted again');
});
