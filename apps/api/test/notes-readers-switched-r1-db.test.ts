/**
 * F15 fix round 1 (review-F15-r1-findings.md): the old note reads answer
 * with the document's current title and content (A-I1); a document that
 * names a task key gets a backlink (A-I2); every canvas write is 410 after
 * authentication (A-m1); nothing outside the move writes notes or canvases
 * (A-m2); an executed note or canvas tool keeps no copy of its content in
 * its history, receipt or run details (B-I1); images a tool writes are
 * linked to the document as F10 links them (B-I2); an org note locks its
 * two drives in id order (B-I3).
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/notes-readers-switched-r1-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';
import { agentRoutes } from '../src/routes/agent.js';
import { canvasRoutes } from '../src/routes/canvas.js';
import { dailyNoteRoutes } from '../src/routes/daily-notes.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const skip = !url;
let fx: DrivesFixture;
const marker = `fifteenr${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const hex12 = () => randomUUID().replace(/-/g, '').slice(0, 12);
// Shared notes gets an id below any other drive's, so the lock-order test (B-I3) knows which drive sorts first.
const sharedNotesId = `00000000-0000-4000-8000-${hex12()}`;

before(async () => {
  if (skip) return;
  fx = await setupDrivesFixture('f15r1', {
    routes: [
      { path: '/api/daily-notes', app: dailyNoteRoutes },
      { path: '/api/spaces', app: canvasRoutes },
      { path: '/api/agent', app: agentRoutes },
    ],
  });
  await fx.client.query(`INSERT INTO drives (id, org_id, name, kind, system_key, default_role, created_by)
    VALUES ($1, $2, 'Shared notes', 'open', 'shared_notes', 'view', $3)`, [sharedNotesId, fx.orgId, fx.people.owner]);
  // write_canvas writes as Defty for the person who asked.
  await ensureDeftyMembership(fx.orgId);
});

after(async () => {
  if (skip) return;
  if (fx) {
    const q = (text: string) => fx.client.query(text, [[fx.orgId, fx.otherOrgId]]);
    await q('DELETE FROM action_receipts WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM agent_actions WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM job_queue WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM task_comments WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM cross_references WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM tasks WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM projects WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM message_attachments WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM document_attachments WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM files WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM messages WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM note_shares WHERE note_id IN (SELECT id FROM notes WHERE org_id = ANY($1::text[]))');
    await q('DELETE FROM notes WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM canvases WHERE org_id = ANY($1::text[])');
    await fx.teardown();
  }
  await closeDb();
});

const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const docJson = (...texts: string[]) => ({ type: 'doc', content: texts.map(paragraph) });

/** A personal drive for `userId`, as F4 makes it. */
const myDrives = new Map<string, string>();
async function myDrive(userId: string): Promise<string> {
  let id = myDrives.get(userId);
  if (!id) myDrives.set(userId, id = await fx.insertDrive({ kind: 'personal', ownerUserId: userId, name: 'My drive' }));
  return id;
}

/** A moved note: the legacy row (its own title and body) and its document, mapped. */
async function movedNote(i: { userId: string; legacyTitle: string; legacyContent: string; title: string; json: object; template?: boolean }) {
  const noteId = randomUUID();
  await fx.client.query(`INSERT INTO notes (id, org_id, user_id, title, content, visibility, is_template)
    VALUES ($1, $2, $3, $4, $5, 'org', $6)`, [noteId, fx.orgId, i.userId, i.legacyTitle, i.legacyContent, i.template === true]);
  const documentId = await fx.insertDocument({ driveId: await myDrive(i.userId), title: i.title, json: i.json as any });
  if (i.template) await fx.client.query('UPDATE documents SET is_template = true WHERE id = $1', [documentId]);
  await fx.client.query(`INSERT INTO note_document_map (id, org_id, source_type, source_id, target_type, target_id)
    VALUES ($1, $2, 'note', $3, 'document', $4)`, [randomUUID(), fx.orgId, noteId, documentId]);
  return { noteId, documentId };
}

/** A file row, as POST /api/upload writes one; staged unless `messageId`. */
async function insertFile(i: { uploadedBy: string; orgId?: string; messageId?: string }): Promise<string> {
  const id = randomUUID();
  await fx.client.query(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, detected_mime_type, size_bytes, storage_key,
      attachment_kind, processing_status, processed_at, staged_expires_at, message_id)
    VALUES ($1, $2, $3, 'pic.png', 'image/png', 'image/png', 10, $4, 'image', 'ready', now(),
      CASE WHEN $5::text IS NULL THEN now() + interval '24 hours' END, $5)`,
  [id, i.orgId ?? fx.orgId, i.uploadedBy, `${id}-pic.png`, i.messageId ?? null]);
  return id;
}

async function insertMessage(userId: string, metadata: object = {}): Promise<string> {
  const id = randomUUID();
  await fx.client.query('INSERT INTO messages (id, org_id, space_id, user_id, content, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
    [id, fx.orgId, fx.spaces.team, userId, '<p>reply</p>', JSON.stringify(metadata)]);
  return id;
}

const img = (fileId: string) => `<img data-file-id="${fileId}" src="/api/files/${fileId}">`;
const imageIdsOf = (json: any): string[] => {
  const ids: string[] = [];
  const walk = (node: any) => { if (node?.type === 'image' && node.attrs?.fileId) ids.push(node.attrs.fileId); node?.content?.forEach(walk); };
  walk(json);
  return ids;
};
/** Every image node of `json`, each as its fileId (null when it has none) and the host its source resolves to off this site (null when local). */
const imagesOf = (json: any): Array<{ fileId: string | null; remoteHost: string | null }> => {
  const images: Array<{ fileId: string | null; remoteHost: string | null }> = [];
  const walk = (node: any) => {
    if (node?.type === 'image') {
      const src = typeof node.attrs?.src === 'string' ? node.attrs.src : null;
      const host = src === null ? null : new URL(src, 'http://local.invalid').hostname;
      images.push({ fileId: typeof node.attrs?.fileId === 'string' ? node.attrs.fileId : null, remoteHost: host === 'local.invalid' ? null : host });
    }
    node?.content?.forEach(walk);
  };
  walk(json);
  return images;
};

// ---------------------------------------------------------------------------
// A-I1

test('the old note GETs answer with the document\'s current title and content, never the legacy row\'s', { skip }, async () => {
  const { member, member2 } = fx.people;
  const removed = `${marker}removedphrase`;
  const legacyTitle = `${marker} legacy title`;
  const title = `${marker} current title`;
  const note = await movedNote({
    userId: member, legacyTitle, legacyContent: `<p>${removed} in the old body</p>`, title, json: docJson(`${marker} current body`),
  });
  const template = await movedNote({
    userId: member, legacyTitle: `${marker} legacy template`, legacyContent: `<p>${removed} template body</p>`,
    title: `${marker} current template`, json: docJson(`${marker} template now`), template: true,
  });

  const one = await fx.request(member, 'GET', `/api/daily-notes/${note.noteId}`);
  assert.equal(one.status, 200);
  const body = await one.json() as any;
  assert.equal(body.id, note.noteId);
  assert.equal(body.document_id, note.documentId);
  assert.equal(body.title, title);
  assert.match(body.content, new RegExp(`<p[^>]*>${marker} current body</p>`));

  const list = await (await fx.request(member, 'GET', '/api/daily-notes')).json() as any[];
  const listed = list.find((row) => row.id === note.noteId);
  assert.equal(listed?.title, title);
  assert.match(listed?.content ?? '', new RegExp(`${marker} current body`));
  assert.ok(!list.some((row) => row.id === template.noteId), 'a template is not a note');
  // The title searched is the document's.
  const byLegacyTitle = await (await fx.request(member, 'GET', `/api/daily-notes?q=${encodeURIComponent(legacyTitle)}`)).json() as any[];
  assert.ok(!byLegacyTitle.some((row) => row.id === note.noteId));
  const byTitle = await (await fx.request(member, 'GET', `/api/daily-notes?q=${encodeURIComponent('current title')}`)).json() as any[];
  assert.ok(byTitle.some((row) => row.id === note.noteId));

  const templates = (await (await fx.request(member, 'GET', '/api/daily-notes/templates')).json() as any).templates as any[];
  const listedTemplate = templates.find((row) => row.id === template.noteId);
  assert.equal(listedTemplate?.title, `${marker} current template`);
  assert.match(listedTemplate?.content ?? '', new RegExp(`${marker} template now`));

  // Text the document no longer holds never comes back, whatever the old row says.
  for (const path of [`/api/daily-notes/${note.noteId}`, '/api/daily-notes', '/api/daily-notes/templates']) {
    const text = await (await fx.request(member, 'GET', path)).text();
    assert.ok(!text.includes(removed), `${path} answered removed text`);
    assert.ok(!text.includes(legacyTitle), `${path} answered the old title`);
  }

  // History and shares live on the document: 410 with its id for someone who can open it, 404 for anyone else.
  for (const suffix of ['history', 'shares']) {
    const moved = await fx.request(member, 'GET', `/api/daily-notes/${note.noteId}/${suffix}`);
    assert.equal(moved.status, 410, suffix);
    assert.deepEqual(await moved.json(), { error: 'Notes are documents now. Open it in Drive.', code: 'NOTES_MOVED', document_id: note.documentId });
    assert.equal((await fx.request(member2, 'GET', `/api/daily-notes/${note.noteId}/${suffix}`)).status, 404, `${suffix} for someone who can't open it`);
    assert.equal((await fx.request(member, 'GET', `/api/daily-notes/${randomUUID()}/${suffix}`)).status, 404, `${suffix} unknown`);
  }
});

// ---------------------------------------------------------------------------
// A-I2

test('a document edited to include a task key gets a backlink on the task, through the queued job', { skip }, async () => {
  const { startDocumentCrossReferences } = await import('../src/lib/document-cross-references.js');
  const { writeDocument } = await import('../src/lib/document-writer.js');
  const { handleCrossReference } = await import('../src/workers/handlers/cross-reference.js');
  const { applyJsonToYDoc } = await import('@deft/doc-schema');
  const { member } = fx.people;
  const prefix = `X${marker.slice(-5).toUpperCase().replace(/[^A-Z]/g, 'Q')}`;
  const projectId = randomUUID();
  const taskId = randomUUID();
  await fx.client.query('INSERT INTO projects (id, org_id, name, prefix, lead_id) VALUES ($1, $2, $3, $4, $5)',
    [projectId, fx.orgId, `${marker} project`, prefix, member]);
  await fx.client.query(`INSERT INTO tasks (id, org_id, project_id, number, title, status, created_by)
    VALUES ($1, $2, $3, 7, 'linked task', 'todo', $4)`, [taskId, fx.orgId, projectId, member]);
  const documentId = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: `${marker} xref`, json: docJson('nothing yet') });

  const stop = startDocumentCrossReferences();
  try {
    const { revision } = await writeDocument({
      orgId: fx.orgId, documentId, actor: { kind: 'user', userId: member }, reason: 'agent_edit',
      mutate: (doc) => applyJsonToYDoc(doc, docJson(`see ${prefix}-7 for the plan`) as any),
    });
    const { rows: jobs } = await fx.client.query(`SELECT id, name, data, attempts, dedupe_key FROM job_queue
      WHERE org_id = $1 AND name = 'cross-reference' AND data->>'sourceId' = $2`, [fx.orgId, documentId]);
    assert.equal(jobs.length, 1, 'one job for the store');
    assert.equal(jobs[0].dedupe_key, `doc-xref:${documentId}:${revision}`);
    assert.equal(jobs[0].data.sourceType, 'document');
    await handleCrossReference({ id: jobs[0].id, name: jobs[0].name, data: jobs[0].data, attempts: jobs[0].attempts });
    const { rows: links } = await fx.client.query(`SELECT source_type, target_id FROM cross_references
      WHERE org_id = $1 AND source_id = $2`, [fx.orgId, documentId]);
    assert.deepEqual(links, [{ source_type: 'document', target_id: taskId }]);

    // A store without a task key queues nothing; a new document with one is scanned once it's created.
    await writeDocument({
      orgId: fx.orgId, documentId, actor: { kind: 'user', userId: member }, reason: 'agent_edit',
      mutate: (doc) => applyJsonToYDoc(doc, docJson('no keys now') as any),
    });
    const { rows: [count] } = await fx.client.query(`SELECT count(*)::int AS n FROM job_queue
      WHERE org_id = $1 AND name = 'cross-reference' AND data->>'sourceId' = $2`, [fx.orgId, documentId]);
    assert.equal(count.n, 1);
    const { createNoteDocument } = await import('../src/lib/legacy-notes.js');
    const created = await createNoteDocument({ orgId: fx.orgId, userId: member, title: `${marker} new`, json: docJson(`about ${prefix}-7`) as any, visibility: 'private' });
    let queued: any[] = [];
    for (let i = 0; i < 50 && queued.length === 0; i += 1) {
      ({ rows: queued } = await fx.client.query(`SELECT dedupe_key FROM job_queue WHERE org_id = $1 AND name = 'cross-reference'
        AND data->>'sourceId' = $2`, [fx.orgId, created.id]));
      if (queued.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(queued.map((row) => row.dedupe_key), [`doc-xref:${created.id}:0`]);
  } finally {
    stop();
  }
});

// ---------------------------------------------------------------------------
// A-m1

test('every canvas write answers 410 CANVAS_MOVED after authentication, with the id only for someone who can open it', { skip }, async () => {
  const { member, member2, outsider } = fx.people;
  const canvasId = randomUUID();
  await fx.client.query(`INSERT INTO canvases (id, org_id, space_id, title, content) VALUES ($1, $2, $3, 'Canvas', $4::jsonb)`,
    [canvasId, fx.orgId, fx.spaces.other, JSON.stringify(docJson('other canvas'))]);
  const documentId = await fx.insertDocument({ driveId: await myDrive(member2), title: 'Other canvas', json: docJson('other canvas') });
  await fx.share(documentId, { space: fx.spaces.other }, 'edit');
  await fx.client.query(`INSERT INTO note_document_map (id, org_id, source_type, source_id, target_type, target_id)
    VALUES ($1, $2, 'canvas', $3, 'document', $4)`, [randomUUID(), fx.orgId, canvasId, documentId]);

  const patch = (userId: string, spaceId: string) => fx.request(userId, 'PATCH', `/api/spaces/${spaceId}/canvas`, { title: 'x' });
  const moved = { error: 'This canvas is a document now. Open it in Drive.', code: 'CANVAS_MOVED' };
  // A member of the chat who can open it.
  const own = await patch(member2, fx.spaces.other);
  assert.equal(own.status, 410);
  assert.deepEqual(await own.json(), { ...moved, document_id: documentId });
  // Not in the chat, or not in the workspace, or no such chat: the same 410, no id.
  for (const [userId, spaceId] of [[member, fx.spaces.other], [outsider, fx.spaces.other], [member, randomUUID()]] as const) {
    const response = await patch(userId, spaceId);
    assert.equal(response.status, 410, `${userId} ${spaceId}`);
    assert.deepEqual(await response.json(), moved);
  }
});

// ---------------------------------------------------------------------------
// A-m2

// The scan (fix round 2): .ts, .tsx, .mjs, .js and .sql under apps/, packages/
// and scripts/. Only the notes move itself (apps/api/src/lib/drives-move/, by
// exact path) and tests are left out; so are installed and built files
// (node_modules, dist, dot-directories such as .next), which aren't source.
const LEGACY_WRITERS = [
  /\binsert\s+into\s+(notes|note_versions|note_shares|note_folders|canvases)\b/i,
  /\bupdate\s+(notes|note_versions|note_shares|note_folders|canvases)\s+set\b/i,
  /\.(insert|update)\(\s*(notes|noteVersions|noteShares|noteFolders|canvases)\b/,
];
const MOVE_PREFIX = 'apps/api/src/lib/drives-move/';
const SCANNED_FILE = /\.(ts|tsx|mjs|js|sql)$/;
const isTestPath = (rel: string) => /(^|\/)(test|tests|__tests__)\//.test(rel) || /\.test\.[a-z]+$/.test(rel);

/** The files (repository-relative paths) whose text writes a legacy notes table, with the rule each breaks. */
function legacyWriterOffenders(files: Array<{ rel: string; text: string }>): string[] {
  return files.flatMap(({ rel, text }) => {
    if (!SCANNED_FILE.test(rel) || rel.startsWith(MOVE_PREFIX) || isTestPath(rel)) return [];
    return LEGACY_WRITERS.filter((pattern) => pattern.test(text)).map((pattern) => `${rel} (${pattern.source})`);
  });
}

test('the legacy-writer scan covers SQL files and every directory but the move\'s own', () => {
  const insert = 'INSERT INTO notes (id) VALUES ($1)';
  assert.deepEqual(legacyWriterOffenders([
    { rel: 'packages/db/upgrades/0.9.0-example.sql', text: insert },
    { rel: 'apps/web/src/drives-move/writer.ts', text: 'await db.insert(notes).values({})' },
    { rel: 'apps/api/src/lib/other/drives-move/x.ts', text: 'UPDATE canvases SET title = $1' },
    { rel: 'scripts/x.mjs', text: 'await tx.update(noteShares).set({})' },
    { rel: 'apps/api/src/lib/drives-move/move-notes.ts', text: insert },
    { rel: 'apps/api/test/x-db.test.ts', text: insert },
    { rel: 'packages/db/scripts/x.test.ts', text: insert },
    { rel: 'apps/api/src/lib/x.ts', text: 'SELECT id FROM notes; INSERT INTO note_files (id) VALUES ($1)' },
  ]).map((offender) => offender.split(' ')[0]), [
    'packages/db/upgrades/0.9.0-example.sql', 'apps/web/src/drives-move/writer.ts', 'apps/api/src/lib/other/drives-move/x.ts', 'scripts/x.mjs',
  ]);
});

test('nothing outside the notes move writes notes, note versions, note shares, note folders or canvases', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const files: Array<{ rel: string; text: string }> = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
        await walk(path);
      } else if (SCANNED_FILE.test(entry.name)) {
        files.push({ rel: relative(root, path).split(sep).join('/'), text: await readFile(path, 'utf8') });
      }
    }
  };
  for (const dir of ['apps', 'packages', 'scripts']) await walk(join(root, dir));
  assert.ok(files.some((file) => file.rel.endsWith('.sql')), 'the scan reads SQL files');
  assert.ok(files.some((file) => file.rel.startsWith(MOVE_PREFIX)), 'the scan reaches the move (and leaves it out)');
  assert.deepEqual(legacyWriterOffenders(files), []);
});

// ---------------------------------------------------------------------------
// B-I1

test('an executed create_note keeps no copy of its content in its history, receipt or run details', { skip }, async () => {
  const { executeAction } = await import('../src/lib/agent-actions.js');
  const { generateReceipt } = await import('../src/lib/receipts.js');
  const { member, member2, admin } = fx.people;
  const phrase = `${marker}secretcontent`;
  const content = `<p>${phrase} written by the tool</p>`;
  const params = { title: `${marker} tool note`, content };
  const toolUseId = `toolu_${hex12()}`;
  const messageId = await insertMessage(member, {
    is_agent_reply: true,
    agent_blocks: [{ type: 'text', text: 'Saving it.' }, { type: 'tool_use', id: toolUseId, name: 'create_note', input: params }],
    tool_calls: [{ tool: 'create_note', params }],
  });
  const actionId = randomUUID();
  await fx.client.query(`INSERT INTO agent_actions (id, org_id, user_id, conversation_id, message_id, tool_use_id, source, action, params,
      approval_tier, approval_status, approved_by_user_id)
    VALUES ($1, $2, $3, $4, $5, $6, 'chat', 'create_note', $7::jsonb, 'quick', 'approved', $3)`,
  [actionId, fx.orgId, member, fx.spaces.team, messageId, toolUseId, JSON.stringify(params)]);

  const result = await executeAction(actionId, 'create_note', { ...params }, fx.orgId, member);
  assert.equal(result.success, true, result.error);
  const documentId = result.result.document_id as string;
  // The approval path signs its receipt with the params it was given (agent-approval-resolver.ts).
  await generateReceipt({
    actionId, orgId: fx.orgId, employeeId: null, proposer: 'defty', proposerId: member, approverId: member,
    decision: 'approved', actionName: 'create_note', actionParams: params, resultJson: result.result,
  });

  const { rows: [stored] } = await fx.client.query('SELECT params FROM agent_actions WHERE id = $1', [actionId]);
  assert.deepEqual(stored.params, {
    title: params.title, content: { document_id: documentId, content_omitted: true, content_bytes: Buffer.byteLength(content) },
  });
  const { rows: [message] } = await fx.client.query('SELECT metadata FROM messages WHERE id = $1', [messageId]);
  assert.ok(!JSON.stringify(message.metadata).includes(phrase), 'run details keep no copy');
  assert.equal(message.metadata.agent_blocks[1].input.content.content_omitted, true);
  assert.equal(message.metadata.agent_blocks[0].text, 'Saving it.');
  const { rows: receipts } = await fx.client.query('SELECT action_params_json FROM action_receipts WHERE action_id = $1', [actionId]);
  assert.ok(receipts.length > 0);
  for (const row of receipts) assert.ok(!JSON.stringify(row.action_params_json).includes(phrase), 'the receipt keeps no copy');

  // An admin who can't open the document, and the requester once they can't either, see none of it.
  await fx.client.query('UPDATE documents SET drive_id = $2 WHERE id = $1', [documentId, await myDrive(member2)]);
  for (const userId of [admin, member]) {
    const recent = await fx.request(userId, 'GET', '/api/agent/actions/recent?limit=50');
    assert.equal(recent.status, 200);
    const text = await recent.text();
    assert.ok(text.includes(actionId), `${userId} sees the action`);
    assert.ok(!text.includes(phrase), `${userId} sees no content in history`);
    const receipt = await fx.request(userId, 'GET', `/api/agent/actions/${actionId}/receipt`);
    assert.equal(receipt.status, 200);
    assert.ok(!(await receipt.text()).includes(phrase), `${userId} sees no content in the receipt`);
  }
});

test('an executed write_canvas keeps no copy of its content; a pending one keeps its proposal', { skip }, async () => {
  const { executeAction } = await import('../src/lib/agent-actions.js');
  const { member } = fx.people;
  const canvasId = randomUUID();
  await fx.client.query(`INSERT INTO canvases (id, org_id, space_id, title, content) VALUES ($1, $2, $3, 'Canvas', $4::jsonb)`,
    [canvasId, fx.orgId, fx.spaces.team, JSON.stringify(docJson('team canvas'))]);
  const documentId = await fx.insertDocument({ driveId: await myDrive(member), title: 'Team canvas', json: docJson('team canvas') });
  await fx.share(documentId, { space: fx.spaces.team }, 'edit');
  await fx.client.query(`INSERT INTO note_document_map (id, org_id, source_type, source_id, target_type, target_id)
    VALUES ($1, $2, 'canvas', $3, 'document', $4)`, [randomUUID(), fx.orgId, canvasId, documentId]);
  const { rows: [team] } = await fx.client.query('SELECT name FROM spaces WHERE id = $1', [fx.spaces.team]);
  const phrase = `${marker}canvascontent`;
  const params = { space_name: team.name, content: `## ${phrase}` };
  const insertAction = async (status: string) => {
    const id = randomUUID();
    await fx.client.query(`INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status)
      VALUES ($1, $2, $3, 'chat', 'write_canvas', $4::jsonb, 'quick', $5)`, [id, fx.orgId, member, JSON.stringify(params), status]);
    return id;
  };
  const pending = await insertAction('pending');
  const executed = await insertAction('approved');
  const result = await executeAction(executed, 'write_canvas', { ...params }, fx.orgId, member);
  assert.equal(result.success, true, result.error);
  const paramsOf = async (id: string) => (await fx.client.query('SELECT params FROM agent_actions WHERE id = $1', [id])).rows[0].params;
  assert.deepEqual(await paramsOf(executed), {
    space_name: team.name, content: { document_id: documentId, content_omitted: true, content_bytes: Buffer.byteLength(params.content) },
  });
  assert.deepEqual(await paramsOf(pending), params, 'a pending proposal is not a document yet');
});

// ---------------------------------------------------------------------------
// B-I2

test('images a tool writes are linked to the document when the acting person uploaded them; anything else is a placeholder', { skip }, async () => {
  const { executeAction } = await import('../src/lib/agent-actions.js');
  const { getVisibleAttachment } = await import('../src/lib/attachment-access.js');
  const { sweepExpiredStagedAttachments } = await import('../src/lib/attachment-retention.js');
  const { member, member2, guest } = fx.people;
  const mine = await insertFile({ uploadedBy: member });
  const theirs = await insertFile({ uploadedBy: member2 });
  const onMessage = await insertFile({ uploadedBy: member, messageId: await insertMessage(member) });
  const elsewhere = await insertFile({ uploadedBy: member, orgId: fx.otherOrgId });

  // create_note: in the create's transaction.
  const created = await executeAction(randomUUID(), 'create_note', {
    title: `${marker} with images`, visibility: 'space', visibility_space_id: fx.spaces.team,
    content: `<p>pictures</p>${img(mine)}${img(theirs)}${img(onMessage)}${img(elsewhere)}`,
  }, fx.orgId, member);
  assert.equal(created.success, true, created.error);
  const documentId = created.result.document_id as string;
  const { rows: [doc] } = await fx.client.query('SELECT content_json, content_text FROM documents WHERE id = $1', [documentId]);
  assert.deepEqual(imageIdsOf(doc.content_json), [mine]);
  assert.equal((doc.content_text.match(/Image not available/g) ?? []).length, 3);
  const links = async (id: string) => (await fx.client.query(`SELECT file_id, in_current FROM document_attachments
    WHERE document_id = $1 ORDER BY file_id`, [id])).rows;
  assert.deepEqual(await links(documentId), [{ file_id: mine, in_current: true }]);
  const expiry = async (id: string) => (await fx.client.query('SELECT staged_expires_at FROM files WHERE id = $1', [id])).rows[0]?.staged_expires_at;
  assert.equal(await expiry(mine), null, 'claimed: no staged expiry');
  // A collaborator (the chat's members can view) loads it; someone else's upload stays theirs.
  assert.ok(await getVisibleAttachment(mine, fx.orgId, member2), 'a collaborator can load the image');
  assert.equal(await getVisibleAttachment(theirs, fx.orgId, guest), null);

  // write_canvas: through the writer's transaction, on a chat of member2's own.
  const room = randomUUID();
  const roomName = `${marker}-images`;
  await fx.client.query(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, 'private', $4)`, [room, fx.orgId, roomName, member2]);
  await fx.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), room, member2]);
  const canvasId = randomUUID();
  await fx.client.query(`INSERT INTO canvases (id, org_id, space_id, title, content) VALUES ($1, $2, $3, 'Canvas', $4::jsonb)`,
    [canvasId, fx.orgId, room, JSON.stringify(docJson('room canvas'))]);
  const canvasDocument = await fx.insertDocument({ driveId: await myDrive(member2), title: 'Room canvas', json: docJson('room canvas') });
  await fx.share(canvasDocument, { space: room }, 'edit');
  await fx.client.query(`INSERT INTO note_document_map (id, org_id, source_type, source_id, target_type, target_id)
    VALUES ($1, $2, 'canvas', $3, 'document', $4)`, [randomUUID(), fx.orgId, canvasId, canvasDocument]);
  const other = { name: roomName };
  const canvasImage = await insertFile({ uploadedBy: member2 });
  const written = await executeAction(randomUUID(), 'write_canvas', {
    space_name: other.name, content: `<p>canvas</p>${img(canvasImage)}${img(mine)}`,
  }, fx.orgId, member2);
  assert.equal(written.success, true, written.error);
  const { rows: [canvasDoc] } = await fx.client.query('SELECT content_json FROM documents WHERE id = $1', [canvasDocument]);
  assert.deepEqual(imageIdsOf(canvasDoc.content_json), [canvasImage], 'another document\'s image is a placeholder');
  assert.deepEqual(await links(canvasDocument), [{ file_id: canvasImage, in_current: true }]);
  assert.equal(await expiry(canvasImage), null);

  // Both survive the staged sweep; an unclaimed upload doesn't.
  const control = await insertFile({ uploadedBy: member });
  await fx.client.query(`UPDATE files SET staged_expires_at = now() - interval '1 hour' WHERE id = $1`, [control]);
  const store = { delete: async () => undefined } as any;
  await sweepExpiredStagedAttachments({ now: new Date(Date.now() + 25 * 60 * 60 * 1000), store });
  const exists = async (id: string) => (await fx.client.query('SELECT 1 FROM files WHERE id = $1', [id])).rowCount === 1;
  assert.equal(await exists(control), false, 'the sweep ran');
  assert.equal(await exists(mine), true, 'the note image is kept');
  assert.equal(await exists(canvasImage), true, 'the canvas image is kept');
});

test('an image named only by its /api/files source is linked when it qualifies, else a placeholder; another site\'s image always is', { skip }, async () => {
  const { executeAction } = await import('../src/lib/agent-actions.js');
  const { member, member2 } = fx.people;
  const links = async (id: string) => (await fx.client.query(`SELECT file_id, in_current FROM document_attachments
    WHERE document_id = $1 ORDER BY file_id`, [id])).rows;
  const textOf = async (id: string) => (await fx.client.query('SELECT content_json, content_text FROM documents WHERE id = $1', [id])).rows[0];

  // write_canvas with structured content: images named by fileId, by a relative source only, and from another site.
  const room = randomUUID();
  const roomName = `${marker}-sources`;
  await fx.client.query(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, 'private', $4)`, [room, fx.orgId, roomName, member2]);
  await fx.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), room, member2]);
  const canvasId = randomUUID();
  await fx.client.query(`INSERT INTO canvases (id, org_id, space_id, title, content) VALUES ($1, $2, $3, 'Canvas', $4::jsonb)`,
    [canvasId, fx.orgId, room, JSON.stringify(docJson('sources canvas'))]);
  const canvasDocument = await fx.insertDocument({ driveId: await myDrive(member2), title: 'Sources canvas', json: docJson('sources canvas') });
  await fx.share(canvasDocument, { space: room }, 'edit');
  await fx.client.query(`INSERT INTO note_document_map (id, org_id, source_type, source_id, target_type, target_id)
    VALUES ($1, $2, 'canvas', $3, 'document', $4)`, [randomUUID(), fx.orgId, canvasId, canvasDocument]);
  const srcMine = await insertFile({ uploadedBy: member2 });
  const srcTheirs = await insertFile({ uploadedBy: member });
  const named = await insertFile({ uploadedBy: member2 });
  const written = await executeAction(randomUUID(), 'write_canvas', {
    space_name: roomName,
    content: { type: 'doc', content: [
      paragraph('mixed'),
      { type: 'image', attrs: { src: `/api/files/${srcMine}` } },
      { type: 'image', attrs: { src: `/api/files/${srcTheirs}`, alt: 'theirs' } },
      { type: 'image', attrs: { fileId: named } },
      { type: 'image', attrs: { src: 'https://example.com/tracker.png', alt: 'remote' } },
    ] },
  }, fx.orgId, member2);
  assert.equal(written.success, true, written.error);
  const canvas = await textOf(canvasDocument);
  assert.deepEqual(imageIdsOf(canvas.content_json).sort(), [srcMine, named].sort());
  assert.match(canvas.content_text, /Image not available: theirs/);
  assert.match(canvas.content_text, /Image not available: remote/);
  // No image from another site is stored: every image left is a linked file, none points off this site.
  assert.deepEqual(imagesOf(canvas.content_json).filter((image) => image.remoteHost !== null || image.fileId === null), [],
    'no image from another site, or with no file, is stored');
  assert.deepEqual(await links(canvasDocument), [srcMine, named].sort().map((fileId) => ({ file_id: fileId, in_current: true })));

  // create_note, mixed: every named file qualifies, and another site's image is still a placeholder.
  const own = await insertFile({ uploadedBy: member });
  const created = await executeAction(randomUUID(), 'create_note', {
    title: `${marker} mixed images`, content: `<p>mixed</p>${img(own)}<img src="https://example.com/a.png" alt="remote">`,
  }, fx.orgId, member);
  assert.equal(created.success, true, created.error);
  const note = await textOf(created.result.document_id);
  assert.deepEqual(imageIdsOf(note.content_json), [own]);
  assert.match(note.content_text, /Image not available: remote/);
  assert.deepEqual(imagesOf(note.content_json).filter((image) => image.remoteHost !== null || image.fileId === null), []);
  assert.deepEqual(await links(created.result.document_id), [{ file_id: own, in_current: true }]);
});

// ---------------------------------------------------------------------------
// B-I3

test('an org note locks its two drives in id order, as a move does (a lock-order test)', { skip }, async () => {
  const { createNoteDocument } = await import('../src/lib/legacy-notes.js');
  const person = await fx.addPerson({ role: 'member' });
  // Their My drive sorts after Shared notes.
  const personalId = `ffffffff-ffff-4fff-bfff-${hex12()}`;
  await fx.client.query(`INSERT INTO drives (id, org_id, name, kind, owner_user_id, created_by) VALUES ($1, $2, 'My drive', 'personal', $3, $3)`,
    [personalId, fx.orgId, person]);
  await fx.addDriveMember(personalId, { user: person }, 'full');

  const holder = new pg.Client({ connectionString: url! });
  const probe = new pg.Client({ connectionString: url! });
  await holder.connect();
  await probe.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM drives WHERE id = $1 FOR UPDATE', [personalId]);
    const creating = createNoteDocument({ orgId: fx.orgId, userId: person, title: `${marker} org lock`, json: docJson('locks') as any, visibility: 'org' });
    creating.catch(() => undefined);
    // Wait until the create waits on the My drive lock the holder has.
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i += 1) {
      const { rows: [row] } = await probe.query(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.datname = current_database() AND a.pid <> pg_backend_pid() AND a.pid <> $1`, [(holder as any).processID]);
      waiting = row.n > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(waiting, 'the create waits on a lock');
    // Shared notes sorts first, so the create already holds it.
    await probe.query('BEGIN');
    await assert.rejects(probe.query('SELECT id FROM drives WHERE id = $1 FOR UPDATE NOWAIT', [sharedNotesId]), /could not obtain lock/);
    await probe.query('ROLLBACK');
    await holder.query('ROLLBACK');
    const document = await creating;
    assert.equal(document.drive_id, sharedNotesId);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
    await probe.end();
  }
});
