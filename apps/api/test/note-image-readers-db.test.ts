// An image pasted into a note loads for everyone who can read that note, and
// for nobody else. Since notes became documents (F15), that is through the
// note's document: the notes move (F14, run here with moveOrg) links each
// image a note showed to its document (document_attachments), and GET
// /api/files/:id serves a file documents link to whoever one of them admits.
// note_files (kept in step with a note's saves before the move, and by the
// backfill) only keeps a file from the staged-upload sweep: it grants nothing.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import type { ServerType } from '@hono/node-server';
import { processTestDatabaseUrl } from './fixtures/safe-test-database-target.js';
import { ensureTwoStepTables } from './fixtures/two-step-tables.js';
import { ensureNoteFilesTable } from './fixtures/note-files-table.js';

process.env.JWT_SECRET ||= 'synthetic-note-image-readers-only';
process.env.NODE_ENV ||= 'test';

// The sweep runs over the whole database: only ever on a disposable test database.
const url = processTestDatabaseUrl();
const skip = url ? false : 'Set DEFT_TEST_DATABASE_URL = DATABASE_URL to a disposable test database';

const c = new pg.Client({ connectionString: url });
const run = randomUUID().slice(0, 8);
const org = randomUUID();
const space = randomUUID();
const people = {
  author: { role: 'member' }, sharedMember: { role: 'member' }, spaceMember: { role: 'member' },
  workspaceMember: { role: 'member' }, outsider: { role: 'member' },
  sharedGuest: { role: 'guest' }, spaceGuest: { role: 'guest' }, outsiderGuest: { role: 'guest' },
} as const;
type Person = keyof typeof people;
const ids = Object.fromEntries(Object.keys(people).map((name) => [name, randomUUID()])) as Record<Person, string>;
const tokens = {} as Record<Person, string>;
const storageKeys: string[] = [];
// A valid PNG header: the upload detects it as an image.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);

let server: ServerType | undefined;
let base = '';
let mod: {
  db: typeof import('../src/lib/db.js')['db'];
  closeDb: typeof import('../src/lib/db.js')['closeDb'];
  localFileStore: typeof import('../src/lib/file-store.js')['localFileStore'];
  sweep: typeof import('../src/lib/attachment-retention.js')['sweepExpiredStagedAttachments'];
  claims: typeof import('../src/lib/note-file-claims.js');
  access: typeof import('../src/lib/attachment-access.js');
  move: typeof import('../src/lib/drives-move/move-org.js')['moveOrg'];
};

before(async () => {
  if (skip) return;
  await ensureTwoStepTables(url!);
  await ensureNoteFilesTable(url!);
  await c.connect();
  const [{ db, closeDb }, { localFileStore }, retention, claims, access, moveOrgModule, web, { Hono }, { serve }, { authMiddleware }, upload] = await Promise.all([
    import('../src/lib/db.js'), import('../src/lib/file-store.js'), import('../src/lib/attachment-retention.js'),
    import('../src/lib/note-file-claims.js'), import('../src/lib/attachment-access.js'), import('../src/lib/drives-move/move-org.js'),
    import('../src/lib/web-sessions.js'), import('hono'), import('@hono/node-server'),
    import('../src/middleware/auth.js'), import('../src/routes/upload.js'),
  ]);
  mod = { db, closeDb, localFileStore, sweep: retention.sweepExpiredStagedAttachments, claims, access, move: moveOrgModule.moveOrg };

  await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Note image readers', $2)`, [org, `nir2-${run}`]);
  for (const [name, { role }] of Object.entries(people) as Array<[Person, { role: string }]>) {
    await c.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'hash')`, [ids[name], `nir2-${run}-${name}@example.test`, name]);
    await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, true)`, [org, ids[name], role]);
  }
  await c.query(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, 'nir2 room', 'private', $3)`, [space, org, ids.author]);
  for (const name of ['author', 'spaceMember', 'spaceGuest'] as const) {
    await c.query(`INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [space, ids[name]]);
  }
  for (const name of Object.keys(people) as Person[]) {
    tokens[name] = (await web.createWebSession({ id: ids[name], org_id: org, email: `nir2-${run}-${name}@example.test` })).accessToken;
  }
  const app = new Hono();
  app.use('/api/*', authMiddleware);
  app.route('/api/files', upload.fileServingRoutes);
  app.route('/api/upload', upload.uploadRoutes);
  base = await new Promise<string>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => resolve(`http://127.0.0.1:${info.port}`));
  });
});

after(async () => {
  if (skip) return;
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  for (const key of storageKeys) await mod.localFileStore.delete(key).catch(() => {});
  const orgs = [org];
  for (const [table, column] of [['action_receipts', 'action_id'], ['agent_action_approvers', 'action_id'], ['module_mutation_receipts', 'agent_action_id']]) {
    await c.query(`DELETE FROM ${table} WHERE ${column} IN (SELECT id FROM agent_actions WHERE org_id = ANY($1::text[]))`, [orgs]).catch(() => {});
  }
  await c.query(`DELETE FROM agent_actions WHERE org_id = ANY($1::text[])`, [orgs]);
  await c.query(`DELETE FROM audit_log WHERE org_id = ANY($1::text[])`, [orgs]).catch(() => {});
  for (const table of ['attention_events', 'attention_items', 'notifications', 'doc_favorites', 'note_document_map', 'drives_move_runs',
    'document_attachments', 'document_versions', 'document_shares', 'documents', 'doc_folders', 'drive_members', 'drives']) {
    await c.query(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [orgs]).catch(() => {});
  }
  await c.query(`DELETE FROM note_shares WHERE note_id IN (SELECT id FROM notes WHERE org_id = ANY($1::text[]))`, [orgs]);
  await c.query(`DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE org_id = ANY($1::text[]))`, [orgs]);
  await c.query(`DELETE FROM notes WHERE org_id = ANY($1::text[])`, [orgs]);
  await c.query(`DELETE FROM files WHERE org_id = ANY($1::text[])`, [orgs]);
  await c.query(`DELETE FROM messages WHERE org_id = ANY($1::text[])`, [orgs]);
  await c.query(`DELETE FROM space_members WHERE space_id = $1`, [space]);
  await c.query(`DELETE FROM spaces WHERE org_id = ANY($1::text[])`, [orgs]);
  await c.query(`DELETE FROM idempotency_keys WHERE user_id = ANY($1::text[])`, [Object.values(ids)]).catch(() => {});
  await c.query(`DELETE FROM oauth_audit_events WHERE org_id = ANY($1::text[])`, [orgs]).catch(() => {});
  await c.query(`DELETE FROM job_queue WHERE org_id = ANY($1::text[])`, [orgs]).catch(() => {});
  await c.query(`DELETE FROM web_sessions WHERE org_id = ANY($1::text[])`, [orgs]).catch(() => {});
  await c.query(`DELETE FROM org_members WHERE org_id = ANY($1::text[])`, [orgs]);
  await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [Object.values(ids)]);
  await c.query(`DELETE FROM orgs WHERE id = ANY($1::text[])`, [orgs]);
  await c.end();
  await mod.closeDb();
});

const img = (id: string) => `<img data-file-id="${id}" data-protected-note-image="" alt="pasted.png" title="pasted.png">`;

async function upload(who: Person): Promise<string> {
  const form = new FormData();
  form.append('file', new File([PNG], 'pasted.png', { type: 'image/png' }));
  const res = await fetch(`${base}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[who]}` }, body: form });
  assert.equal(res.status, 201);
  const { id } = await res.json() as { id: string };
  const { rows } = await c.query(`SELECT storage_key, attachment_kind, staged_expires_at FROM files WHERE id = $1`, [id]);
  storageKeys.push(rows[0].storage_key);
  assert.equal(rows[0].attachment_kind, 'image');
  assert.notEqual(rows[0].staged_expires_at, null, 'a pasted image starts staged');
  return id;
}

async function call(who: Person, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

/** A note as Notes saved it before the move: the row, and its links to the images it shows (note-file-claims.ts). */
async function createNote(body: { content: string; visibility?: 'private' | 'org' | 'space'; visibility_space_id?: string }): Promise<string> {
  const id = randomUUID();
  const { rows: [note] } = await c.query(`INSERT INTO notes (id, org_id, user_id, title, content, visibility, visibility_space_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
  [id, org, ids.author, `nir2 ${run}`, body.content, body.visibility ?? 'private', body.visibility_space_id ?? null]);
  await mod.claims.syncNoteFiles(mod.db, { id: ids.author, org_id: org }, note);
  return id;
}

/** The notes move for this workspace: each note not moved yet becomes its document, its images linked to it. */
async function move(): Promise<void> {
  const report = await mod.move(org);
  assert.deepEqual(report.errors, [], 'the move finished');
}

const documentOf = async (noteId: string) => (await c.query(`SELECT target_id FROM note_document_map WHERE source_type = 'note' AND source_id = $1`,
  [noteId])).rows[0]?.target_id as string;

async function load(who: Person, fileId: string): Promise<number> {
  const res = await fetch(`${base}/api/files/${fileId}`, { headers: { Authorization: `Bearer ${tokens[who]}` } });
  if (res.status === 404) assert.equal((await res.json() as { code: string }).code, 'NOT_FOUND', 'answered as an unknown file');
  else await res.arrayBuffer();
  return res.status;
}

const links = async (noteId: string) => (await c.query(`SELECT file_id FROM note_files WHERE note_id = $1 ORDER BY file_id`, [noteId])).rows.map((row) => row.file_id as string);
const expiryOf = async (id: string) => (await c.query(`SELECT staged_expires_at FROM files WHERE id = $1`, [id])).rows[0]?.staged_expires_at ?? null;
const exists = async (id: string) => (await c.query(`SELECT 1 FROM files WHERE id = $1`, [id])).rowCount === 1;
const sweepStore = { delete: async () => {} } as unknown as import('../src/lib/file-store.js').FileStore;
const sweepAfter25h = () => mod.sweep({ now: new Date(Date.now() + 25 * 60 * 60 * 1000), store: sweepStore });

test('note_files on this database is the table the upgrade creates', { skip }, async () => {
  // Same definitions as the upgraded-database check in .github/workflows/ci.yml.
  const columns = await c.query(`SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY ordinal_position) AS v
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'note_files'`);
  assert.equal(columns.rows[0].v, 'org_id:text:NO,note_id:text:NO,file_id:text:NO,created_at:timestamp without time zone:NO');
  const constraints = await c.query(`SELECT string_agg(conname || ': ' || pg_get_constraintdef(oid), ' | ' ORDER BY conname) AS v
    FROM pg_constraint WHERE conrelid = 'public.note_files'::regclass`);
  assert.equal(constraints.rows[0].v, 'note_files_note_id_fkey: FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE'
    + ' | note_files_org_file_fk: FOREIGN KEY (org_id, file_id) REFERENCES files(org_id, id) ON DELETE CASCADE'
    + ' | note_files_pkey: PRIMARY KEY (note_id, file_id)');
  const indexes = await c.query(`SELECT string_agg(indexdef, ' | ' ORDER BY indexname) AS v FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'note_files'`);
  assert.equal(indexes.rows[0].v, 'CREATE INDEX note_files_org_file_idx ON public.note_files USING btree (org_id, file_id)'
    + ' | CREATE UNIQUE INDEX note_files_pkey ON public.note_files USING btree (note_id, file_id)');
});

test('after the move, the same note image loads for each person who can read the note, and is an unknown file to everyone else', { skip }, async () => {
  const shared = await upload('author');
  const inSpace = await upload('author');
  const workspace = await upload('author');
  const privateNote = await createNote({ content: `<p>private</p>${img(shared)}` });
  for (const who of ['sharedMember', 'sharedGuest'] as const) {
    await c.query(`INSERT INTO note_shares (id, note_id, shared_with_user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [privateNote, ids[who]]);
  }
  const spaceNote = await createNote({ content: img(inSpace), visibility: 'space', visibility_space_id: space });
  const workspaceNote = await createNote({ content: img(workspace), visibility: 'org' });
  assert.deepEqual(await links(privateNote), [shared]);
  // Before the move a note link grants nothing: only the uploader loads it.
  assert.equal(await load('sharedMember', shared), 404);
  assert.equal(await load('author', shared), 200);
  await move();
  for (const [note, file] of [[privateNote, shared], [spaceNote, inSpace], [workspaceNote, workspace]] as const) {
    const { rows } = await c.query(`SELECT in_current FROM document_attachments WHERE document_id = $1 AND file_id = $2`, [await documentOf(note), file]);
    assert.deepEqual(rows, [{ in_current: true }], 'the move linked the image to its document');
    assert.equal(await expiryOf(file), null, 'a linked image is kept');
  }

  // As the note rule had it: the workspace note is in the open Shared notes drive, which admits no guest.
  const expected: Record<Person, [privateNote: number, spaceNote: number, workspaceNote: number]> = {
    author: [200, 200, 200],
    sharedMember: [200, 404, 200],
    spaceMember: [404, 200, 200],
    workspaceMember: [404, 404, 200],
    outsider: [404, 404, 200],
    sharedGuest: [200, 404, 404],
    spaceGuest: [404, 200, 404],
    outsiderGuest: [404, 404, 404],
  };
  for (const who of Object.keys(expected) as Person[]) {
    const got = [await load(who, shared), await load(who, inSpace), await load(who, workspace)];
    assert.deepEqual(got, expected[who], `${who}: private (shared), space, workspace note image`);
  }
  const res = await fetch(`${base}/api/files/${shared}`, { headers: { Authorization: `Bearer ${tokens.sharedGuest}` } });
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG, 'the reader gets the image bytes');
  assert.equal(await load('sharedMember', randomUUID()), 404, 'a file that does not exist answers the same');

  // The resource projection reads through the same check.
  assert.ok(await mod.access.getVisibleAttachment(workspace, org, ids.workspaceMember));
  assert.equal(await mod.access.getVisibleAttachment(workspace, org, ids.outsiderGuest), null);
});

test('a deleted document grants nothing, its uploader included; restored, its images load again', { skip }, async () => {
  const file = await upload('author');
  const note = await createNote({ content: img(file), visibility: 'org' });
  await move();
  const documentId = await documentOf(note);
  assert.equal(await load('workspaceMember', file), 200);
  await c.query(`UPDATE documents SET is_deleted = true, deleted_at = now() WHERE id = $1`, [documentId]);
  assert.equal(await load('workspaceMember', file), 404, 'deleted document: unknown file');
  assert.equal(await load('author', file), 404, 'a file in documents is decided by them alone');
  assert.equal(await expiryOf(file), null, 'its image is kept');
  await sweepAfter25h();
  assert.equal(await exists(file), true);
  await c.query(`UPDATE documents SET is_deleted = false, deleted_at = NULL WHERE id = $1`, [documentId]);
  assert.equal(await load('workspaceMember', file), 200, 'restored document: loads again');
});

test('a download in progress is refused when the share is withdrawn before it is handed over', { skip }, async () => {
  const file = await upload('author');
  const note = await createNote({ content: img(file) });
  await c.query(`INSERT INTO note_shares (id, note_id, shared_with_user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [note, ids.sharedMember]);
  await move();
  const documentId = await documentOf(note);
  assert.equal(await load('sharedMember', file), 200);
  const { rows } = await c.query(`SELECT storage_key FROM files WHERE id = $1`, [file]);
  const store = mod.localFileStore;
  const original = store.get;
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  store.get = async function (key, options) {
    if (key === rows[0].storage_key) { entered(); await released; }
    return original.call(this, key, options);
  };
  try {
    const pending = load('sharedMember', file);
    await reading;
    await c.query(`DELETE FROM document_shares WHERE document_id = $1 AND principal_type = 'user' AND principal_id = $2`, [documentId, ids.sharedMember]);
    release();
    assert.equal(await pending, 404);
  } finally {
    release();
    store.get = original;
  }
});

test("another person's upload named in my note is not linked, and stays unknown to my readers", { skip }, async () => {
  const theirs = await upload('outsider');
  const note = await createNote({ content: img(theirs), visibility: 'org' });
  assert.deepEqual(await links(note), []);
  await move();
  const { rows } = await c.query(`SELECT 1 FROM document_attachments WHERE file_id = $1`, [theirs]);
  assert.equal(rows.length, 0, 'the move does not link it either');
  assert.notEqual(await expiryOf(theirs), null, 'their upload keeps its expiry');
  assert.equal(await load('workspaceMember', theirs), 404);
  assert.equal(await load('author', theirs), 404, 'nor does it reach me');
  assert.equal(await load('outsider', theirs), 200, 'its uploader still loads it');
});

test('the backfill links the images of notes saved before note_files by the save rule, and running it again changes nothing', { skip }, async () => {
  const file = async (uploader: Person, extra: { staged?: boolean; message?: string; kind?: string } = {}) => {
    const id = randomUUID();
    await c.query(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key, processing_status, attachment_kind, staged_expires_at, message_id)
      VALUES ($1, $2, $3, 'old.png', 'image/png', 4, $4, 'ready', $5, $6, $7)`,
    [id, org, ids[uploader], `nir2/${run}/${id}`, extra.kind ?? 'image', extra.staged ? new Date(Date.now() + 3600_000) : null, extra.message ?? null]);
    return id;
  };
  const message = randomUUID();
  await c.query(`INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, 'with file')`, [message, org, space, ids.author]);
  const kept = await file('author');
  const legacy = await file('author', { kind: 'binary' });
  await c.query(`UPDATE files SET processing_status = 'pending' WHERE id = $1`, [legacy]);
  const theirs = await file('outsider');
  const staged = await file('author', { staged: true });
  const onMessage = await file('author', { message });
  const pdf = await file('author', { kind: 'pdf' });
  const inDeleted = await file('author');
  const live = randomUUID(), deleted = randomUUID();
  await c.query(`INSERT INTO notes (id, org_id, user_id, title, content, visibility, is_deleted) VALUES
    ($1, $3, $4, 'old', $5, 'org', false), ($2, $3, $4, 'old deleted', $6, 'org', true)`,
  [live, deleted, org, ids.author,
    `<IMG DATA-FILE-ID="${kept}">` + [theirs, staged, onMessage, pdf, randomUUID()].map(img).join('') + `<img src="/api/files/${legacy}">`
      + `<p>text naming /api/files/${theirs}</p>`,
    img(inDeleted)]);
  assert.deepEqual(await links(live), []);

  await mod.claims.backfillNoteFileLinks(mod.db);
  assert.deepEqual(await links(live), [kept, staged].sort(), 'an older unprocessed upload is not linked: it is not known to be an image');
  assert.equal(await expiryOf(staged), null, 'an image still staged is linked and kept');
  assert.deepEqual(await links(deleted), [inDeleted], 'a deleted note is linked too, so its images are kept');
  // The link keeps the file from the sweep, and grants nothing since F15: a reader reads it through a document.
  assert.equal(await mod.access.getVisibleAttachment(kept, org, ids.workspaceMember), null);
  assert.ok(await mod.access.getVisibleAttachment(kept, org, ids.author), 'its uploader can load it');
  assert.equal(await mod.access.getVisibleAttachment(theirs, org, ids.workspaceMember), null);
  assert.equal(await mod.access.getVisibleAttachment(inDeleted, org, ids.workspaceMember), null);

  await mod.claims.backfillNoteFileLinks(mod.db, { batchSize: 1 });
  assert.deepEqual(await links(live), [kept, staged].sort(), 'idempotent');
  assert.deepEqual(await links(deleted), [inDeleted]);
  assert.equal(await mod.access.getVisibleAttachment(legacy, org, ids.workspaceMember), null);
});
