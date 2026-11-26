/**
 * Document images (plan Task F10): a file uploaded into a document
 * (`POST /api/upload?document_id=`) is linked to it through
 * `document_attachments` in the upload's transaction, is never staged, and is
 * never swept. `GET /api/files/:id` serves it to everyone the access check
 * (lib/document-access.ts) lets open the document while the image is in the
 * document (`in_current`), only to its editors once it is only in history,
 * and to nobody else: anyone else gets the answer a missing file gets. A file
 * linked to several documents is served when any one of them admits the
 * reader. Uploading into a document needs edit: 404 for someone who can't
 * open it, 403 for a viewer or commenter.
 *
 * Tests 4 to 6 link their files with SQL, so what they show is the access
 * rule alone, whatever the upload does.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/document-attachments-http-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import { authorizeAttachmentDownload, AttachmentDownloadAuthorityError, getVisibleAttachment } from '../src/lib/attachment-access.js';
import { sweepExpiredStagedAttachments } from '../src/lib/attachment-retention.js';
import { closeDb } from '../src/lib/db.js';
import { localFileStore, type FileStore } from '../src/lib/file-store.js';
import { createWebSession, verifyWebAccess } from '../src/lib/web-sessions.js';
import { authMiddleware } from '../src/middleware/auth.js';
import { fileServingRoutes, uploadRoutes } from '../src/routes/upload.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';

// A valid PNG header: the upload detects it as an image.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);

let fx: DrivesFixture | undefined;
/** Everyone the tests act as: the fixture's people plus the ones added in `before`. */
let who: {
  editor: string; editor2: string; commenter: string; viewer: string; viewer2: string; stranger: string;
  chatMember: string; guest: string; outsider: string;
};
const tokens = new Map<string, string>();

const app = new Hono();
app.use('/api/*', authMiddleware);
app.route('/api/upload', uploadRoutes);
app.route('/api/files', fileServingRoutes);

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('doc-images');
  who = {
    editor: fx.people.member,
    editor2: await fx.addPerson(),
    commenter: await fx.addPerson(),
    viewer: await fx.addPerson(),
    viewer2: await fx.addPerson(),
    stranger: await fx.addPerson(),
    chatMember: fx.people.member2, // the only member of the `other` chat
    guest: fx.people.guest,
    outsider: fx.people.outsider, // a member of the other workspace only
  };
  for (const userId of Object.values(who)) {
    const orgId = userId === who.outsider ? fx.otherOrgId : fx.orgId;
    tokens.set(userId, (await createWebSession({ id: userId, email: `${userId}@images.test`, org_id: orgId })).accessToken);
  }
});

after(async () => {
  if (fx) {
    const orgs = [fx.orgId, fx.otherOrgId];
    const { rows } = await fx.client.query('SELECT storage_key FROM files WHERE org_id = ANY($1::text[])', [orgs]);
    for (const row of rows) await localFileStore.delete(row.storage_key as string).catch(() => undefined);
    for (const table of ['document_attachments', 'attachment_derivatives', 'files', 'web_sessions']) {
      await fx.client.query(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [orgs]);
    }
    await fx.teardown();
  }
  await closeDb();
});

/** A private drive where the editor (the uploader) holds edit as a member. */
async function privateDrive(): Promise<string> {
  const driveId = await fx!.insertDrive({ kind: 'private', name: 'Images' });
  await fx!.addDriveMember(driveId, { user: who.editor }, 'edit');
  return driveId;
}

/** A document in its own private drive: the editor edits, editor2, the commenter and the viewer hold shares. */
async function sharedDocument(title: string): Promise<string> {
  const documentId = await fx!.insertDocument({ driveId: await privateDrive(), title });
  await fx!.share(documentId, { user: who.editor2 }, 'edit');
  await fx!.share(documentId, { user: who.commenter }, 'comment');
  await fx!.share(documentId, { user: who.viewer }, 'view');
  return documentId;
}

async function upload(userId: string, query = ''): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.append('file', new File([PNG], 'pasted.png', { type: 'image/png' }));
  const res = await app.request(`/api/upload${query}`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.get(userId)}` }, body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** What a file nobody has answers: the answer for everyone who may not see a file. */
let missingAnswer: { status: number; body: unknown } | undefined;

/** GET /api/files/:id as `userId`: the status. A 200 must carry the image's bytes, a 404 the missing file's answer exactly. */
async function load(userId: string, fileId: string): Promise<number> {
  const get = async (id: string) => app.request(`/api/files/${id}`, { headers: { Authorization: `Bearer ${tokens.get(userId)}` } });
  missingAnswer ??= await (async () => {
    const res = await get(randomUUID());
    return { status: res.status, body: await res.json() };
  })();
  const res = await get(fileId);
  if (res.status === 200) {
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG, 'the image’s bytes');
  } else if (res.status === 404) {
    assert.deepEqual({ status: res.status, body: await res.json() }, missingAnswer, 'answered as a file that doesn’t exist');
  } else {
    await res.body?.cancel();
  }
  return res.status;
}

/** The status each person gets for `fileId`, by name. */
async function loads(fileId: string, names: Array<keyof typeof who>): Promise<Record<string, number>> {
  const got: Record<string, number> = {};
  for (const name of names) got[name] = await load(who[name], fileId);
  return got;
}

/**
 * A plain upload (no parent: today's behaviour, unchanged) linked to each
 * document with SQL and taken out of staging, as an upload into a document
 * leaves it.
 */
async function linkedImage(uploader: string, links: Array<{ documentId: string; inCurrent: boolean }>): Promise<string> {
  const { status, body } = await upload(uploader);
  assert.equal(status, 201, JSON.stringify(body));
  await fx!.client.query('UPDATE files SET staged_expires_at = NULL WHERE id = $1', [body.id]);
  for (const link of links) {
    await fx!.client.query(`INSERT INTO document_attachments (id, org_id, document_id, file_id, in_current, added_by)
      VALUES ($1, $2, $3, $4, $5, $6)`, [randomUUID(), fx!.orgId, link.documentId, body.id, link.inCurrent, uploader]);
  }
  return body.id as string;
}

const setInCurrent = (documentId: string, fileId: string, inCurrent: boolean) => fx!.client.query(
  'UPDATE document_attachments SET in_current = $3 WHERE document_id = $1 AND file_id = $2', [documentId, fileId, inCurrent]);

/** The second gate GET /api/files/:id passes through, called directly: the file row, or the refusal's code. */
async function authorize(userId: string, fileId: string): Promise<string> {
  const token = tokens.get(userId)!;
  const current = await verifyWebAccess(token);
  const { rows: [file] } = await fx!.client.query('SELECT * FROM files WHERE id = $1', [fileId]);
  try {
    const result = await authorizeAttachmentDownload({
      org_id: current.org_id, user_id: current.id, sid: current.sid, jwt_expires_at: current.exp * 1000,
      file: file as Parameters<typeof authorizeAttachmentDownload>[0]['file'], signal: new AbortController().signal,
    });
    return result.file.id;
  } catch (error) {
    if (error instanceof AttachmentDownloadAuthorityError) return error.code;
    throw error;
  }
}

const fileCount = async () => Number((await fx!.client.query('SELECT count(*) FROM files WHERE org_id = $1', [fx!.orgId])).rows[0].count);

// ---------------------------------------------------------------------------
// The brief's four tests

test('an image uploaded into a document is visible to everyone who can open the document', { skip: !url && SKIP }, async () => {
  const documentId = await sharedDocument('Images: everyone who can open it');
  const driveId = (await fx!.client.query('SELECT drive_id FROM documents WHERE id = $1', [documentId])).rows[0].drive_id as string;
  await fx!.addDriveMember(driveId, { space: fx!.spaces.other }, 'view');
  await fx!.share(documentId, { user: who.guest }, 'view');

  const { status, body } = await upload(who.editor, `?document_id=${documentId}`);
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(typeof body.id, 'string');
  assert.deepEqual(
    { name: body.name, type: body.type, size: body.size, url: body.url, kind: body.kind },
    { name: 'pasted.png', type: 'image/png', size: PNG.length, url: `/api/files/${body.id}`, kind: 'image' },
    'the existing upload payload',
  );
  const { rows: links } = await fx!.client.query('SELECT document_id, in_current, added_by, org_id FROM document_attachments WHERE file_id = $1', [body.id]);
  assert.deepEqual(links, [{ document_id: documentId, in_current: true, added_by: who.editor, org_id: fx!.orgId }], 'linked to the document');
  const { rows: [file] } = await fx!.client.query('SELECT staged_expires_at, task_id, message_id FROM files WHERE id = $1', [body.id]);
  assert.deepEqual(file, { staged_expires_at: null, task_id: null, message_id: null });

  assert.deepEqual(await loads(body.id, ['editor', 'editor2', 'commenter', 'viewer', 'chatMember', 'guest', 'stranger', 'viewer2', 'outsider']), {
    editor: 200, editor2: 200, commenter: 200, viewer: 200, chatMember: 200, guest: 200,
    stranger: 404, viewer2: 404, outsider: 404,
  }, 'every role on the document, a person or through a chat, and nobody else');
  assert.equal(await authorize(who.viewer, body.id), body.id, 'the download authority admits a viewer too');

  // On an open drive every member of the workspace can open the document; a guest can't.
  const openDocument = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Images: open drive' });
  const open = await upload(who.editor, `?document_id=${openDocument}`);
  assert.equal(open.status, 201, JSON.stringify(open.body));
  assert.deepEqual(await loads(open.body.id, ['editor', 'stranger', 'viewer2', 'guest', 'outsider']), {
    editor: 200, stranger: 200, viewer2: 200, guest: 404, outsider: 404,
  });
});

test('uploading into a document needs can edit', { skip: !url && SKIP }, async () => {
  const documentId = await sharedDocument('Images: needs edit');
  const deleted = await fx!.insertDocument({ driveId: await privateDrive(), title: 'Images: deleted', deleted: true });
  const before = await fileCount();

  const refused = async (userId: string, query: string) => {
    const { status, body } = await upload(userId, query);
    return { status, code: body?.code };
  };
  assert.deepEqual(await refused(who.viewer, `?document_id=${documentId}`), { status: 403, code: 'FORBIDDEN_ROLE' }, 'a viewer');
  assert.deepEqual(await refused(who.commenter, `?document_id=${documentId}`), { status: 403, code: 'FORBIDDEN_ROLE' }, 'a commenter');
  assert.deepEqual(await refused(who.stranger, `?document_id=${documentId}`), { status: 404, code: 'NOT_FOUND' }, 'someone who can’t open it');
  assert.deepEqual(await refused(who.guest, `?document_id=${documentId}`), { status: 404, code: 'NOT_FOUND' }, 'a guest it isn’t shared with');
  assert.deepEqual(await refused(who.outsider, `?document_id=${documentId}`), { status: 404, code: 'NOT_FOUND' }, 'someone from another workspace');
  assert.deepEqual(await refused(who.editor, `?document_id=${randomUUID()}`), { status: 404, code: 'NOT_FOUND' }, 'a document that doesn’t exist');
  assert.deepEqual(await refused(who.editor, `?document_id=${deleted}`), { status: 404, code: 'NOT_FOUND' }, 'a deleted document');
  assert.deepEqual(await refused(who.editor, `?document_id=${documentId}&task_id=${randomUUID()}`), { status: 400, code: 'VALIDATION_ERROR' }, 'a document and a task');
  assert.deepEqual(await refused(who.editor, `?document_id=${documentId}&message_id=${randomUUID()}`), { status: 400, code: 'VALIDATION_ERROR' }, 'a document and a message');
  assert.equal(await fileCount(), before, 'a refused upload stores no file');
  const { rows } = await fx!.client.query('SELECT 1 FROM document_attachments WHERE document_id = $1', [documentId]);
  assert.equal(rows.length, 0, 'and links nothing');

  const ok = await upload(who.editor2, `?document_id=${documentId}`);
  assert.equal(ok.status, 201, 'edit through a share is enough');
  const { rows: [link] } = await fx!.client.query('SELECT added_by FROM document_attachments WHERE document_id = $1 AND file_id = $2', [documentId, ok.body.id]);
  assert.equal(link?.added_by, who.editor2);
});

test('a document image gets no staged expiry and survives the staged sweep', { skip: !url && SKIP }, async () => {
  const documentId = await sharedDocument('Images: kept');
  const { status, body } = await upload(who.editor, `?document_id=${documentId}`);
  assert.equal(status, 201, JSON.stringify(body));
  const expiry = async (id: string) => (await fx!.client.query('SELECT staged_expires_at FROM files WHERE id = $1', [id])).rows[0]?.staged_expires_at;
  assert.equal(await expiry(body.id), null, 'never staged');

  // Staged again by another path (a note's save stages a file when it loses
  // its last note link), and removed from the document: still kept, since
  // its versions show it.
  await fx!.client.query(`UPDATE files SET staged_expires_at = now() - interval '1 hour' WHERE id = $1`, [body.id]);
  await setInCurrent(documentId, body.id, false);
  const staged = await upload(who.editor); // a plain upload nobody claims: the sweep's control
  assert.equal(staged.status, 201);
  const deletedKeys: string[] = [];
  const store = { delete: async (key: string) => { deletedKeys.push(key); } } as unknown as FileStore;
  await sweepExpiredStagedAttachments({ now: new Date(Date.now() + 25 * 60 * 60 * 1000), store });
  const exists = async (id: string) => (await fx!.client.query('SELECT 1 FROM files WHERE id = $1', [id])).rowCount === 1;
  assert.equal(await exists(staged.body.id), false, 'the sweep ran: the unclaimed upload is gone');
  assert.equal(await exists(body.id), true, 'the document image is kept');
  const { rows: [kept] } = await fx!.client.query('SELECT storage_key FROM files WHERE id = $1', [body.id]);
  assert.ok(!deletedKeys.includes(kept.storage_key), 'and so are its bytes');

  // Nor can its uploader delete it as an unattached upload.
  const res = await app.request(`/api/files/${body.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokens.get(who.editor)}` } });
  assert.equal(res.status, 404, await res.text());
  assert.equal(await exists(body.id), true);
});

test('someone who can\'t open the document gets 404 for the image', { skip: !url && SKIP }, async () => {
  const documentId = await sharedDocument('Images: no access');
  const driveId = (await fx!.client.query('SELECT drive_id FROM documents WHERE id = $1', [documentId])).rows[0].drive_id as string;
  const fileId = await linkedImage(who.editor, [{ documentId, inCurrent: true }]);

  assert.deepEqual(await loads(fileId, ['stranger', 'guest', 'chatMember', 'outsider']), {
    stranger: 404, guest: 404, chatMember: 404, outsider: 404,
  });
  assert.equal(await getVisibleAttachment(fileId, fx!.orgId, who.stranger), null);
  assert.equal(await authorize(who.stranger, fileId), 'NOT_FOUND', 'the download authority refuses on its own too');

  // Its uploader, once they can't open the document either.
  await fx!.client.query(`DELETE FROM drive_members WHERE drive_id = $1 AND principal_type = 'user' AND principal_id = $2`, [driveId, who.editor]);
  assert.equal(await load(who.editor, fileId), 404, 'the uploader without access');
  assert.equal(await authorize(who.editor, fileId), 'NOT_FOUND');

  // A share taken away.
  assert.equal(await load(who.viewer, fileId), 200);
  await fx!.client.query(`DELETE FROM document_shares WHERE document_id = $1 AND principal_id = $2`, [documentId, who.viewer]);
  assert.equal(await load(who.viewer, fileId), 404, 'a viewer whose share was removed');

  // The document deleted.
  assert.equal(await load(who.editor2, fileId), 200);
  await fx!.client.query('UPDATE documents SET is_deleted = true, deleted_at = now() WHERE id = $1', [documentId]);
  assert.equal(await load(who.editor2, fileId), 404, 'an editor of a deleted document');
});

// ---------------------------------------------------------------------------
// Added by the consult, and by the dispatch

test('an image removed from the document can be downloaded only by editors', { skip: !url && SKIP }, async () => {
  const documentId = await sharedDocument('Images: history');
  const fileId = await linkedImage(who.editor, [{ documentId, inCurrent: false }]);

  assert.deepEqual(await loads(fileId, ['editor', 'editor2', 'commenter', 'viewer', 'stranger']), {
    editor: 200, editor2: 200, commenter: 404, viewer: 404, stranger: 404,
  }, 'only in history: the history role, edit');
  assert.equal(await authorize(who.editor2, fileId), fileId);
  assert.equal(await authorize(who.viewer, fileId), 'NOT_FOUND');

  await setInCurrent(documentId, fileId, true);
  assert.deepEqual(await loads(fileId, ['editor2', 'commenter', 'viewer', 'stranger']), {
    editor2: 200, commenter: 200, viewer: 200, stranger: 404,
  }, 'back in the document: view again');
});

test('a file linked to two documents is visible to readers of either', { skip: !url && SKIP }, async () => {
  const first = await fx!.insertDocument({ driveId: await privateDrive(), title: 'Images: first' });
  const second = await fx!.insertDocument({ driveId: await privateDrive(), title: 'Images: second' });
  await fx!.share(first, { user: who.viewer }, 'view');
  await fx!.share(first, { user: who.editor2 }, 'edit');
  await fx!.share(second, { user: who.viewer2 }, 'view');
  const fileId = await linkedImage(who.editor, [{ documentId: first, inCurrent: true }, { documentId: second, inCurrent: true }]);

  assert.deepEqual(await loads(fileId, ['viewer', 'viewer2', 'editor2', 'stranger']), {
    viewer: 200, viewer2: 200, editor2: 200, stranger: 404,
  }, 'a reader of either document');
  assert.equal(await authorize(who.viewer2, fileId), fileId);

  // Out of the first document's text: its viewers lose it, its editors and the second's readers keep it.
  await setInCurrent(first, fileId, false);
  assert.deepEqual(await loads(fileId, ['viewer', 'viewer2', 'editor2', 'stranger']), {
    viewer: 404, viewer2: 200, editor2: 200, stranger: 404,
  });
  assert.equal(await authorize(who.viewer, fileId), 'NOT_FOUND');
});
