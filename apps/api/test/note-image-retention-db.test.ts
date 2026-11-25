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
import { sweepExpiredStagedAttachments } from '../src/lib/attachment-retention.js';
import { noteFileIds, claimNoteFiles } from '../src/lib/note-file-claims.js';
import { humanNoteCreate, humanNoteUpdate, type HumanToolContext } from '../src/lib/mcp-tools/human.js';
import { db } from '../src/lib/db.js';
import type { FileStore } from '../src/lib/file-store.js';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
const run = randomUUID().slice(0, 8);
const org = randomUUID(), otherOrg = randomUUID();
const alice = randomUUID(), bob = randomUUID();
const fileIds: string[] = [];

async function stagedFile(orgId: string, uploader: string): Promise<string> {
  const id = randomUUID();
  fileIds.push(id);
  await c.query(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key, processing_status, staged_expires_at)
    VALUES ($1, $2, $3, 'pasted.png', 'image/png', 4, $4, 'ready', now() + interval '24 hours')`, [id, orgId, uploader, `nir/${run}/${id}`]);
  return id;
}

const exists = async (id: string) => (await c.query(`SELECT 1 FROM files WHERE id = $1`, [id])).rowCount === 1;
const deletedKeys: string[] = [];
const store = { delete: async (key: string) => { deletedKeys.push(key); } } as unknown as FileStore;
/** A retention run 25 hours from now, as retention maintenance would run it. */
const sweepAfter25h = () => sweepExpiredStagedAttachments({ now: new Date(Date.now() + 25 * 60 * 60 * 1000), store });

before(async () => {
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
});

after(async () => {
  await c.query(`DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE org_id = ANY($1::text[]))`, [[org, otherOrg]]);
  await c.query(`DELETE FROM notes WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]);
  await c.query(`DELETE FROM files WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]);
  await c.query(`DELETE FROM idempotency_keys WHERE user_id = ANY($1::text[])`, [[alice, bob]]).catch(() => {});
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
  return hono;
}
async function send(userId: string, method: string, path: string, body: unknown) {
  const res = await app(userId).request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}
const img = (id: string) => `<img data-file-id="${id}" data-protected-note-image="" alt="pasted.png" title="pasted.png">`;

test('noteFileIds reads the editor form and the older /api/files/ form, once each', () => {
  const a = randomUUID(), b = randomUUID();
  assert.deepEqual(noteFileIds(`<p>x</p>${img(a)}<img src="/api/files/${b}"><img data-file-id='${a}'>`), [a, b]);
  assert.deepEqual(noteFileIds(null), []);
  assert.deepEqual(noteFileIds('<p>/api/files/</p><img data-file-id="">'), []);
});

test('a note image created and edited in a note survives a sweep after 25 hours; an unreferenced staged file still goes', async () => {
  const pastedAtCreate = await stagedFile(org, alice);
  const pastedLater = await stagedFile(org, alice);
  const legacy = await stagedFile(org, alice);
  const unreferenced = await stagedFile(org, alice);

  const created = await send(alice, 'POST', '/api/daily-notes', { title: `nir ${run}`, content: `<p>hello</p>${img(pastedAtCreate)}` });
  assert.equal(created.status, 201);
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

test('a staged file of another person, or of another workspace, named in my note is not claimed', async () => {
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

test('MCP note_create and note_update claim the same way', async () => {
  const ctx: HumanToolContext = { org_id: org, user_id: alice, role: 'member', scopes: ['read:workspace', 'write:workspace'] };
  const atCreate = await stagedFile(org, alice);
  const atUpdate = await stagedFile(org, alice);
  const bobs = await stagedFile(org, bob);
  const created = await humanNoteCreate({ title: `nir mcp ${run}`, content: img(atCreate) }, ctx);
  const note = JSON.parse(created.content[0]!.text).note as { id: string };
  await humanNoteUpdate({ note_id: note.id, content: `${img(atCreate)}${img(atUpdate)}${img(bobs)}` }, ctx);
  await sweepAfter25h();
  assert.equal(await exists(atCreate), true);
  assert.equal(await exists(atUpdate), true);
  assert.equal(await exists(bobs), false);
});

test('claimNoteFiles counts only the files it claimed', async () => {
  const mine = await stagedFile(org, alice);
  const bobs = await stagedFile(org, bob);
  assert.equal(await claimNoteFiles(db, { id: alice, org_id: org }, `${img(mine)}${img(bobs)}${img(randomUUID())}`), 1);
  assert.equal(await claimNoteFiles(db, { id: alice, org_id: org }, img(mine)), 0, 'an already claimed file is not counted again');
});
