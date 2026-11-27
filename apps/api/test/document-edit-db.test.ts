/**
 * The edit engine (plan Task M4, with the 25 Nov consult's changes):
 * block-id operations, applied to the live document through the one writer
 * (rule C2), credited to the asker and the agent in one `agent` version,
 * highlighted, audited, retry-safe per action, and undone block by block.
 *
 * Also the M4 carry-forwards: the engine reads live content (never the
 * lagging content_json), an agent edit makes no automatic version beside its
 * own, and a Defty edit's stored event carries the asker, so its backlinks
 * are re-authorized as the asker.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/document-edit-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import * as Y from 'yjs';
import { blockHash, ensureBlockIds, jsonToText, jsonToYDoc, yDocToJson } from '@deft/doc-schema';
import { setCollabLimitsForTest } from '../src/collab/limits.js';
import { readCurrentDocument } from '../src/collab/server.js';
import { closeDb } from '../src/lib/db.js';
import { startDocumentCrossReferences } from '../src/lib/document-cross-references.js';
import {
  applyDocumentEditDirect, applyOpsToJson, DocumentEditRefused, undoAgentEdit, type DocumentEditOp,
} from '../src/lib/document-edit.js';
import { startDocumentVersioning } from '../src/lib/document-versions.js';
import { writeDocument } from '../src/lib/document-writer.js';
import { ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';
import { documentRoutes } from '../src/routes/documents.js';
import { handleCrossReference } from '../src/workers/handlers/cross-reference.js';
import { connectCollab, pollUntil, startCollabTestServer, tokenFor, type CollabTestClient, type CollabTestServer } from './fixtures/collab-client.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';

type JSONContent = Parameters<typeof jsonToText>[0];

let fx: DrivesFixture | undefined;
let srv: CollabTestServer | undefined;
let deftyId = '';
let stopVersioning: (() => void) | undefined;
let stopCrossReferences: (() => void) | undefined;
let restoreLimits: (() => void) | undefined;

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('edit', { routes: [{ path: '/api/documents', app: documentRoutes }] });
  restoreLimits = setCollabLimitsForTest({ unloadAfterMs: 200 });
  srv = await startCollabTestServer(fx);
  stopVersioning = startDocumentVersioning();
  stopCrossReferences = startDocumentCrossReferences();
  deftyId = await ensureDeftyMembership(fx.orgId);
});

after(async () => {
  stopCrossReferences?.();
  stopVersioning?.();
  restoreLimits?.();
  await srv?.close();
  if (fx) {
    for (const table of ['cross_references', 'task_comments', 'task_activity', 'tasks', 'projects', 'job_queue']) {
      await fx.client.query(`DELETE FROM ${table} WHERE org_id = $1`, [fx.orgId]);
    }
    await fx.teardown();
  }
  await closeDb();
});

// ---------------------------------------------------------------------------
// Helpers

const paragraph = (id: string, text: string): JSONContent => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] });
const docOf = (...blocks: JSONContent[]): JSONContent => ({ type: 'doc', content: blocks });

/** `json` in canonical form with block ids, as a stored document holds it. */
function canonical(json: JSONContent): JSONContent {
  const doc = jsonToYDoc(json);
  try {
    return ensureBlockIds(yDocToJson(doc));
  } finally {
    doc.destroy();
  }
}

/** A Y.Doc holding the document's current state (live when loaded). */
async function liveDoc(documentId: string): Promise<Y.Doc> {
  const state = await readCurrentDocument(documentId, fx!.orgId);
  assert.ok(state, 'the document has a state');
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

/** The document's current top-level blocks: id, type, text and node. */
async function liveBlocks(documentId: string): Promise<Array<{ id: string; type: string; text: string; node: JSONContent }>> {
  const doc = await liveDoc(documentId);
  try {
    return (ensureBlockIds(yDocToJson(doc)).content ?? []).map((node) => ({
      id: String(node.attrs?.id), type: String(node.type), text: jsonToText({ type: 'doc', content: [node] }), node,
    }));
  } finally {
    doc.destroy();
  }
}

/** `deft_meta.agent_highlights` in the document's current state. */
async function highlights(documentId: string): Promise<Array<{ blockIds: string[]; label: string; until: string }>> {
  const doc = await liveDoc(documentId);
  try {
    return (doc.getMap('deft_meta').get('agent_highlights') ?? []) as Array<{ blockIds: string[]; label: string; until: string }>;
  } finally {
    doc.destroy();
  }
}

function elementById(doc: Y.Doc, id: string): Y.XmlElement | undefined {
  return doc.getXmlFragment('default').toArray()
    .find((child): child is Y.XmlElement => child instanceof Y.XmlElement && child.getAttribute('id') === id);
}

/** Types `text` at the end of the block `id` in `doc`, as a person's editor does. */
function typeInto(doc: Y.Doc, id: string, text: string): void {
  const element = elementById(doc, id);
  assert.ok(element, `block ${id} is in the editor`);
  const run = element.toArray().find((child): child is Y.XmlText => child instanceof Y.XmlText);
  assert.ok(run, `block ${id} holds text`);
  doc.transact(() => run.insert(run.length, text));
}

async function revision(documentId: string): Promise<number> {
  const { rows: [row] } = await fx!.client.query('SELECT revision FROM documents WHERE id = $1', [documentId]);
  return Number(row.revision);
}

type VersionRow = {
  id: string; kind: string; name: string | null; created_by: string | null; agent_user_id: string | null; action_id: string | null;
  content_json: JSONContent; edit_details: any;
};

/** The document's versions straight from the table, newest first. */
async function versionRows(documentId: string): Promise<VersionRow[]> {
  const { rows } = await fx!.client.query(`SELECT id, kind, name, created_by, agent_user_id, action_id, content_json, edit_details
    FROM document_versions WHERE document_id = $1 ORDER BY created_at DESC, id DESC`, [documentId]);
  return rows as VersionRow[];
}

/** Connects, tracked for cleanup, and waits until synced. */
async function open(t: { after(fn: () => void): void }, documentId: string, userId: string): Promise<CollabTestClient> {
  const client = connectCollab({ url: srv!.url, documentId, token: await tokenFor(userId, fx!.orgId) });
  t.after(() => client.destroy());
  await client.waitSynced();
  return client;
}

async function call(userId: string, method: string, path: string, body?: unknown) {
  const res = await fx!.request(userId, method, path, body);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const undoPath = (actionId: string) => `/api/documents/agent-edits/${actionId}/undo`;

/** A direct edit by Defty at `askerId`'s request (the member by default). */
function deftyEdit(documentId: string, ops: DocumentEditOp[], o: { actionId?: string; askerId?: string; summary?: string } = {}) {
  return applyDocumentEditDirect({
    orgId: fx!.orgId, documentId, agentUserId: deftyId, askerId: o.askerId ?? fx!.people.member,
    actionId: o.actionId ?? randomUUID(), ops, summary: o.summary ?? 'Tidy the document',
  });
}

/** A paragraph `id` holding `text`, inserted after the block `afterId`, through the one writer as `userId`. */
async function personInsertsAfter(documentId: string, afterId: string, id: string, text: string, userId: string): Promise<void> {
  await writeDocument({
    orgId: fx!.orgId, documentId, actor: { kind: 'user', userId }, reason: 'import',
    mutate: (doc) => {
      const fragment = doc.getXmlFragment('default');
      const index = fragment.toArray().findIndex((child) => child instanceof Y.XmlElement && child.getAttribute('id') === afterId);
      assert.ok(index >= 0);
      const element = new Y.XmlElement('paragraph');
      element.setAttribute('id', id);
      element.insert(0, [new Y.XmlText(text)]);
      fragment.insert(index + 1, [element]);
    },
  });
}

// ---------------------------------------------------------------------------
// The brief's five tests

test('applyOpsToJson replaces, inserts after, appends and deletes by block id and reports missing ids', () => {
  const base = docOf(paragraph('blk-a', 'Alpha'), paragraph('blk-b', 'Bravo'), paragraph('blk-c', 'Charlie'));
  const frozen = JSON.stringify(base);
  const ops: DocumentEditOp[] = [
    { op: 'replace', block_id: 'blk-a', markdown: 'Alpha **two**' },
    { op: 'insert_after', block_id: 'blk-b', markdown: 'Inserted one\n\nInserted two' },
    { op: 'append', markdown: '## Tail' },
    { op: 'delete', block_id: 'blk-c' },
    { op: 'replace', block_id: 'blk-missing', markdown: 'Nowhere' },
    { op: 'delete', block_id: 'blk-gone' },
  ];
  const result = applyOpsToJson(base, ops);
  assert.deepEqual(result.missingBlockIds, ['blk-missing', 'blk-gone']);
  assert.equal(JSON.stringify(base), frozen, 'the input is not changed');

  const blocks = result.json.content ?? [];
  const ids = blocks.map((node) => String(node.attrs?.id));
  assert.equal(ids.length, 5);
  assert.deepEqual(ids.slice(0, 2), ['blk-a', 'blk-b'], 'the replaced block keeps its place and id');
  const [one, two, tail] = ids.slice(2);
  assert.equal(new Set(ids).size, 5, 'every block id is unique');
  assert.deepEqual(blocks.map((node) => node.type), ['paragraph', 'paragraph', 'paragraph', 'paragraph', 'heading']);
  assert.deepEqual(blocks.map((node) => jsonToText({ type: 'doc', content: [node] })), ['Alpha two', 'Bravo', 'Inserted one', 'Inserted two', 'Tail']);
  assert.ok(blocks[0]!.content!.some((node) => node.marks?.some((mark) => mark.type === 'bold')), 'Markdown formatting is kept');

  assert.deepEqual([...result.changedBlockIds].sort(), ['blk-a', 'blk-c', one!, two!, tail!].sort());
  assert.ok(!result.changedBlockIds.includes('blk-b'), 'an anchor alone is not changed');
  assert.deepEqual(result.before['blk-a'], base.content![0]);
  assert.deepEqual(result.before['blk-c'], base.content![2]);
  assert.equal(result.before[one!], null);
  assert.equal(result.before[tail!], null);

  // An id written in the Markdown never takes a block's id away from it.
  const sneaky = applyOpsToJson(base, [{ op: 'insert_after', block_id: 'blk-a', markdown: '<!-- block:blk-b -->\nNot a duplicate' }]);
  const sneakyIds = (sneaky.json.content ?? []).map((node) => String(node.attrs?.id));
  assert.equal(new Set(sneakyIds).size, 4);
  assert.equal(sneakyIds[2], 'blk-b');

  // The same seed gives the same new ids; a selection keeps only the chosen blocks' changes.
  const seeded = applyOpsToJson(base, ops.slice(0, 4), { idSeed: 'action-1' });
  assert.deepEqual(applyOpsToJson(base, ops.slice(0, 4), { idSeed: 'action-1' }).changedBlockIds, seeded.changedBlockIds);
  const selected = applyOpsToJson(base, ops.slice(0, 4), { idSeed: 'action-1', selectedBlockIds: ['blk-a', 'blk-c'] });
  assert.deepEqual([...selected.changedBlockIds].sort(), ['blk-a', 'blk-c']);
  assert.deepEqual((selected.json.content ?? []).map((node) => jsonToText({ type: 'doc', content: [node] })), ['Alpha two', 'Bravo']);
});

test('a direct edit changes only the named blocks while a person types in another block of the same live document', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const doc = await fx!.insertDocument({
    driveId: fx!.workspaceDriveId, title: 'Live',
    json: canonical(docOf(paragraph('blk-a', 'Alpha'), paragraph('blk-b', 'Bravo'), paragraph('blk-c', 'Charlie'))),
  });
  const typist = await open(t, doc, people.member);
  const watcher = await open(t, doc, people.member2);
  const untouched = elementById(watcher.ydoc, 'blk-c');
  assert.ok(untouched);

  // The person's typing is in flight (their editor is offline) while the edit lands.
  typist.offline();
  typeInto(typist.ydoc, 'blk-b', ' and more');
  const result = await deftyEdit(doc, [{ op: 'replace', block_id: 'blk-a', markdown: 'Alpha rewritten' }], { askerId: people.member2 });
  assert.deepEqual(result.changedBlockIds, ['blk-a']);

  await pollUntil(() => watcher.text().includes('Alpha rewritten'), 'the edit reaches an open editor live');
  assert.equal(elementById(watcher.ydoc, 'blk-c'), untouched, 'a block the edit did not name is not rewritten');

  typist.online();
  await pollUntil(async () => (await liveBlocks(doc)).some((block) => block.text === 'Bravo and more'), 'the typing reaches the server');
  await pollUntil(() => typist.text().includes('Alpha rewritten'), 'the typist gets the edit');
  await pollUntil(() => watcher.text().includes('Bravo and more'), 'the watcher gets the typing');

  const blocks = await liveBlocks(doc);
  assert.deepEqual(blocks.map((block) => [block.id, block.text]), [['blk-a', 'Alpha rewritten'], ['blk-b', 'Bravo and more'], ['blk-c', 'Charlie']]);
  assert.equal(typist.text(), watcher.text(), 'both editors converge');
});

test('a direct edit creates one agent version credited to the asker and the agent, highlights the blocks and audits the action id', { skip: !url && SKIP }, async () => {
  const { people } = fx!;
  const doc = await fx!.insertDocument({
    driveId: fx!.workspaceDriveId, title: 'Credit', json: canonical(docOf(paragraph('blk-a', 'Alpha'), paragraph('blk-b', 'Bravo'))),
  });
  // A highlight from long ago, pruned by the next edit.
  await writeDocument({
    orgId: fx!.orgId, documentId: doc, actor: { kind: 'user', userId: people.member }, reason: 'import',
    mutate: (d) => d.getMap('deft_meta').set('agent_highlights', [{ blockIds: ['blk-b'], label: 'Old via Defty', until: '2026-01-01T00:00:00.000Z' }]),
  });

  const actionId = randomUUID();
  const startedAt = Date.now();
  const result = await deftyEdit(doc, [
    { op: 'replace', block_id: 'blk-a', markdown: 'New intro' },
    { op: 'append', markdown: 'Closing line' },
  ], { actionId, summary: 'Tidy the intro' });
  const blocks = await liveBlocks(doc);
  const added = blocks[2]!.id;
  assert.deepEqual(blocks.map((block) => block.text), ['New intro', 'Bravo', 'Closing line']);
  assert.deepEqual(result.changedBlockIds, ['blk-a', added]);

  const agentVersions = (await versionRows(doc)).filter((row) => row.kind === 'agent');
  assert.equal(agentVersions.length, 1, 'one agent version');
  const version = agentVersions[0]!;
  assert.equal(result.versionId, version.id);
  assert.equal(version.name, "Defty, at member's request: Tidy the intro");
  assert.equal(version.created_by, people.member, 'credited to the asker');
  assert.equal(version.agent_user_id, deftyId, 'and to the agent');
  assert.equal(version.action_id, actionId);
  assert.deepEqual(blocks.map((block) => block.text), (version.content_json.content ?? []).map((node) => jsonToText({ type: 'doc', content: [node] })));
  const details = version.edit_details;
  assert.equal(details.action_id, actionId);
  assert.deepEqual(details.changed_block_ids, ['blk-a', added]);
  assert.equal(jsonToText({ type: 'doc', content: [details.before['blk-a']] }), 'Alpha');
  assert.equal(details.before[added], null);
  assert.equal(details.after_hashes['blk-a'], blockHash(blocks[0]!.node));
  assert.equal(details.after_hashes[added], blockHash(blocks[2]!.node));

  const marks = await highlights(doc);
  assert.equal(marks.length, 1, 'the stale highlight is pruned and the new one appended');
  assert.deepEqual(marks[0]!.blockIds, ['blk-a', added]);
  assert.equal(marks[0]!.label, 'member via Defty');
  const until = Date.parse(marks[0]!.until);
  assert.equal(new Date(until).toISOString(), marks[0]!.until, 'until is ISO 8601');
  assert.ok(until >= startedAt + 30 * 60_000 - 1_000 && until <= Date.now() + 30 * 60_000 + 1_000, 'until is 30 minutes after the edit');

  const { rows: audits } = await fx!.client.query(
    `SELECT actor_type, actor_id, entity_type, entity_id, metadata FROM audit_log WHERE org_id = $1 AND action = 'edit_document' AND entity_id = $2`,
    [fx!.orgId, doc]);
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0], { actor_type: 'agent', actor_id: deftyId, entity_type: 'document', entity_id: doc, metadata: { action_id: actionId } });
  assert.ok(!JSON.stringify(audits).includes('New intro'), 'no document content in the audit');
});

test('undo restores the edited blocks; a block someone changed since is reported as conflicted and left alone', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const doc = await fx!.insertDocument({
    driveId: fx!.workspaceDriveId, title: 'Undo',
    json: canonical(docOf(paragraph('blk-a', 'Alpha'), paragraph('blk-b', 'Bravo'), paragraph('blk-c', 'Charlie'))),
  });
  const actionId = randomUUID();
  await deftyEdit(doc, [
    { op: 'replace', block_id: 'blk-a', markdown: 'Alpha by Defty' },
    { op: 'replace', block_id: 'blk-b', markdown: 'Bravo by Defty' },
    { op: 'insert_after', block_id: 'blk-c', markdown: 'Added by Defty' },
  ], { actionId });
  const added = (await liveBlocks(doc))[3]!.id;

  // Someone types in Bravo live. content_json lags the live state, so undo must read the live document.
  const editor = await open(t, doc, people.member2);
  await pollUntil(() => editor.text().includes('Bravo by Defty'), 'the editor has the edit');
  typeInto(editor.ydoc, 'blk-b', ', then a person');
  await pollUntil(async () => (await liveBlocks(doc)).some((block) => block.text === 'Bravo by Defty, then a person'), 'the typing reaches the server');
  const { rows: [stored] } = await fx!.client.query('SELECT content_text FROM documents WHERE id = $1', [doc]);
  assert.ok(!String(stored.content_text).includes('then a person'), 'the stored copy is behind the live document');

  const undone = await undoAgentEdit({ orgId: fx!.orgId, actionId, userId: people.member });
  assert.deepEqual([...undone.restoredBlockIds].sort(), ['blk-a', added].sort());
  assert.deepEqual(undone.conflictedBlockIds, ['blk-b']);
  const blocks = await liveBlocks(doc);
  assert.deepEqual(blocks.map((block) => [block.id, block.text]), [['blk-a', 'Alpha'], ['blk-b', 'Bravo by Defty, then a person'], ['blk-c', 'Charlie']]);
  await pollUntil(() => !editor.text().includes('Alpha by Defty') && !editor.text().includes('Added by Defty'), 'the undo reaches the open editor');

  const restores = (await versionRows(doc)).filter((row) => row.kind === 'restore');
  assert.equal(restores.length, 1, 'undo saves a restore version');
  assert.equal(restores[0]!.created_by, people.member);
  assert.equal(restores[0]!.edit_details.undo_of_action_id, actionId);

  // Undoing again restores nothing and reports no conflicts.
  const revisionBefore = await revision(doc);
  assert.deepEqual(await undoAgentEdit({ orgId: fx!.orgId, actionId, userId: people.member }), { restoredBlockIds: [], conflictedBlockIds: [] });
  assert.equal(await revision(doc), revisionBefore, 'a repeated undo writes nothing');
  assert.equal((await versionRows(doc)).filter((row) => row.kind === 'restore').length, 1);
});

test('undo needs can edit (a viewer gets 403)', { skip: !url && SKIP }, async () => {
  const { people } = fx!;
  const drive = await fx!.insertDrive({ kind: 'private' });
  await fx!.addDriveMember(drive, { user: people.member }, 'edit');
  const doc = await fx!.insertDocument({ driveId: drive, title: 'Private', json: canonical(docOf(paragraph('blk-a', 'Alpha'))) });
  await fx!.share(doc, { user: people.member2 }, 'view');
  const actionId = randomUUID();
  await deftyEdit(doc, [{ op: 'replace', block_id: 'blk-a', markdown: 'Alpha by Defty' }], { actionId });
  const versionsBefore = (await versionRows(doc)).length;

  const viewer = await call(people.member2, 'POST', undoPath(actionId));
  assert.equal(viewer.status, 403);
  assert.equal(viewer.body.code, 'FORBIDDEN_ROLE');
  const stranger = await call(people.guest, 'POST', undoPath(actionId));
  assert.equal(stranger.status, 404, 'someone who cannot open the document learns nothing');
  assert.equal(stranger.body.code, 'NOT_FOUND');
  assert.equal((await call(people.member, 'POST', undoPath(randomUUID()))).status, 404);
  assert.deepEqual((await liveBlocks(doc)).map((block) => block.text), ['Alpha by Defty'], 'refused undos change nothing');
  assert.equal((await versionRows(doc)).length, versionsBefore);

  const editor = await call(people.member, 'POST', undoPath(actionId));
  assert.equal(editor.status, 200);
  assert.deepEqual(editor.body, { restored_block_ids: ['blk-a'], conflicted_block_ids: [] });
  assert.deepEqual((await liveBlocks(doc)).map((block) => block.text), ['Alpha']);
});

// ---------------------------------------------------------------------------
// The consult's three tests

test('running the same action twice writes one version', { skip: !url && SKIP }, async () => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Retry', json: canonical(docOf(paragraph('blk-a', 'Alpha'))) });
  const actionId = randomUUID();
  const first = await deftyEdit(doc, [{ op: 'append', markdown: 'Appended once' }], { actionId });
  const revisionAfterFirst = await revision(doc);
  const second = await deftyEdit(doc, [{ op: 'append', markdown: 'Appended once' }], { actionId });
  assert.equal(second.versionId, first.versionId);
  assert.deepEqual(second.changedBlockIds, first.changedBlockIds);
  assert.equal(await revision(doc), revisionAfterFirst, 'the retry writes nothing');

  // Two runs at once: one write, one version, one audit.
  const raced = randomUUID();
  const [x, y] = await Promise.all([
    deftyEdit(doc, [{ op: 'append', markdown: 'Appended in a race' }], { actionId: raced }),
    deftyEdit(doc, [{ op: 'append', markdown: 'Appended in a race' }], { actionId: raced }),
  ]);
  assert.equal(x.versionId, y.versionId);
  const texts = (await liveBlocks(doc)).map((block) => block.text);
  assert.deepEqual(texts, ['Alpha', 'Appended once', 'Appended in a race']);
  const agentVersions = (await versionRows(doc)).filter((row) => row.kind === 'agent');
  assert.deepEqual(agentVersions.map((row) => row.action_id).sort(), [actionId, raced].sort());
  const { rows: audits } = await fx!.client.query(`SELECT metadata FROM audit_log WHERE org_id = $1 AND action = 'edit_document' AND entity_id = $2`,
    [fx!.orgId, doc]);
  assert.equal(audits.length, 2, 'each action is audited once');
});

test('replace keeps the block id, so comments on it stay anchored', { skip: !url && SKIP }, async () => {
  const doc = await fx!.insertDocument({
    driveId: fx!.workspaceDriveId, title: 'Anchors', json: canonical(docOf(paragraph('blk-a', 'Alpha'), paragraph('blk-b', 'Bravo'))),
  });
  const result = await deftyEdit(doc, [
    { op: 'replace', block_id: 'blk-a', markdown: 'First line\n\nSecond line' },
    { op: 'insert_after', block_id: 'blk-b', markdown: '<!-- block:blk-a -->\nNot a second blk-a' },
  ]);
  const blocks = await liveBlocks(doc);
  assert.deepEqual(blocks.map((block) => block.text), ['First line', 'Second line', 'Bravo', 'Not a second blk-a']);
  assert.equal(blocks[0]!.id, 'blk-a', 'the replaced block keeps its id');
  assert.equal(blocks[2]!.id, 'blk-b');
  assert.equal(new Set(blocks.map((block) => block.id)).size, 4, 'blocks the edit added get new ids');
  assert.deepEqual(result.changedBlockIds, ['blk-a', blocks[1]!.id, blocks[3]!.id]);

  const { rows: [stored] } = await fx!.client.query('SELECT content_json FROM documents WHERE id = $1', [doc]);
  assert.equal(stored.content_json.content[0].attrs.id, 'blk-a', 'the stored content keeps the id too');
  const [version] = (await versionRows(doc)).filter((row) => row.kind === 'agent');
  assert.equal(version!.edit_details.after_hashes['blk-a'], blockHash(blocks[0]!.node));
});

test('undo puts a deleted block back between the same neighbours', { skip: !url && SKIP }, async () => {
  const { people } = fx!;
  const doc = await fx!.insertDocument({
    driveId: fx!.workspaceDriveId, title: 'Placement',
    json: canonical(docOf(paragraph('blk-a', 'Alpha'), paragraph('blk-b', 'Bravo'), paragraph('blk-c', 'Charlie'), paragraph('blk-d', 'Delta'))),
  });
  const actionId = randomUUID();
  await deftyEdit(doc, [{ op: 'delete', block_id: 'blk-a' }, { op: 'delete', block_id: 'blk-c' }], { actionId });
  assert.deepEqual((await liveBlocks(doc)).map((block) => block.id), ['blk-b', 'blk-d']);
  const [version] = (await versionRows(doc)).filter((row) => row.kind === 'agent');
  assert.deepEqual(version!.edit_details.previous_sibling_ids, { 'blk-a': null, 'blk-c': 'blk-b' });

  // Someone adds a paragraph after Bravo meanwhile; Charlie goes back right after Bravo, its old neighbour.
  await personInsertsAfter(doc, 'blk-b', 'blk-x', 'Xray', people.member2);
  const undone = await undoAgentEdit({ orgId: fx!.orgId, actionId, userId: people.member });
  assert.deepEqual([...undone.restoredBlockIds].sort(), ['blk-a', 'blk-c']);
  assert.deepEqual(undone.conflictedBlockIds, []);
  assert.deepEqual((await liveBlocks(doc)).map((block) => [block.id, block.text]),
    [['blk-a', 'Alpha'], ['blk-b', 'Bravo'], ['blk-c', 'Charlie'], ['blk-x', 'Xray'], ['blk-d', 'Delta']]);
});

// ---------------------------------------------------------------------------
// Controller ruling and carry-forwards

test('a direct edit naming a block that is not there refuses the whole edit and writes nothing', { skip: !url && SKIP }, async () => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Missing', json: canonical(docOf(paragraph('blk-a', 'Alpha'))) });
  const revisionBefore = await revision(doc);
  await assert.rejects(deftyEdit(doc, [
    { op: 'replace', block_id: 'blk-a', markdown: 'Would change' },
    { op: 'delete', block_id: 'blk-nope' },
    { op: 'insert_after', block_id: 'blk-gone', markdown: 'Nowhere' },
  ]), (error: unknown) => {
    assert.ok(error instanceof DocumentEditRefused);
    assert.equal(error.code, 'BLOCK_NOT_FOUND');
    assert.deepEqual(error.blockIds, ['blk-nope', 'blk-gone']);
    return true;
  });
  assert.equal(await revision(doc), revisionBefore);
  assert.deepEqual((await liveBlocks(doc)).map((block) => block.text), ['Alpha']);
  assert.equal((await versionRows(doc)).length, 0);
});

test('an agent edit makes no automatic version beside its own agent version', { skip: !url && SKIP }, async () => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'No auto', json: canonical(docOf(paragraph('blk-a', 'Alpha'))) });
  await deftyEdit(doc, [{ op: 'replace', block_id: 'blk-a', markdown: 'Alpha by Defty' }]);
  assert.deepEqual((await versionRows(doc)).map((row) => row.kind), ['agent']);
});

test('a Defty edit naming a task key links the task, checked as the asker; a forged asker on another actor links nothing', { skip: !url && SKIP }, async () => {
  const { people, orgId } = fx!;
  const projectId = randomUUID();
  await fx!.client.query(`INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES ($1, $2, 'Edit links', 'EDK', null, 5)`,
    [projectId, orgId]);
  const openTask = randomUUID();
  const ownerOnly = randomUUID();
  const restricted = JSON.stringify({ visibility: 'restricted', visible_user_ids: [] });
  for (const [id, number, metadata] of [[openTask, 1, null], [ownerOnly, 2, restricted]] as const) {
    await fx!.client.query(`INSERT INTO tasks (id, org_id, project_id, number, title, created_by, status, priority, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, 'todo', 'p2', $7)`, [id, orgId, projectId, number, `Edit link task ${number}`, people.owner, metadata]);
  }
  const linkedFrom = async (documentId: string) => (await fx!.client.query(
    `SELECT target_id FROM cross_references WHERE source_type = 'document' AND source_id = $1 AND target_type = 'task'`, [documentId]))
    .rows.map((row) => row.target_id as string);
  const scanJobs = async (documentId: string) => (await fx!.client.query(
    `SELECT id, data FROM job_queue WHERE org_id = $1 AND name = 'cross-reference' AND data->>'sourceId' = $2`, [orgId, documentId])).rows;

  // Defty writes the keys at the member's request; the member can see EDK-1 only.
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Links', json: canonical(docOf(paragraph('blk-a', 'Nothing yet'))) });
  await writeDocument({
    orgId, documentId: doc, actor: { kind: 'agent', userId: deftyId, askerId: people.member, actionId: randomUUID() }, reason: 'agent_edit',
    mutate: (d) => {
      const element = new Y.XmlElement('paragraph');
      element.insert(0, [new Y.XmlText('See EDK-1 and EDK-2')]);
      d.getXmlFragment('default').push([element]);
    },
  });
  const jobs = await scanJobs(doc);
  assert.equal(jobs.length, 1, 'the edit queues one scan');
  assert.equal(jobs[0].data.userId, deftyId);
  assert.equal(jobs[0].data.askerId, people.member, 'the scan carries who asked');
  await handleCrossReference({ id: jobs[0].id, name: 'cross-reference', attempts: 0, data: jobs[0].data, orgId });
  assert.deepEqual(await linkedFrom(doc), [openTask], 'linked as the asker sees the tasks');

  // An asker named on a job for anyone but Defty is not honoured: the owner could see EDK-2, the agent user cannot.
  const forged = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Forged', json: canonical(docOf(paragraph('blk-a', 'See EDK-2'))) });
  await handleCrossReference({
    id: `forged-${forged}`, name: 'cross-reference', attempts: 0, orgId,
    data: { sourceType: 'document', sourceId: forged, content: '', orgId, userId: people.agentUser, askerId: people.owner },
  });
  assert.deepEqual(await linkedFrom(forged), []);
});
