/**
 * Agent edit suggestions (plan Task M6, with the 25 Nov consult's changes):
 * proposing, the list everyone sees and the review only the asker sees,
 * applying some blocks (the executor, moved here from M7), conflicts,
 * rejection from the chat card, the 14-day expiry, and the paths that close
 * a suggestion without a decision (the room rule, access loss). Only the
 * person who asked decides, with no owner or admin fallback.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/document-suggestions-http-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import * as Y from 'yjs';
import { ensureBlockIds, jsonToText, yDocToJson } from '@deft/doc-schema';
import { readCurrentDocument } from '../src/collab/server.js';
import { _setReviewerRecheckHookForTest, viewerReviewAuthority } from '../src/lib/agent-approval-resolver.js';
import { maintainAttentionSystem } from '../src/lib/attention-maintenance.js';
import { closeDb, db } from '../src/lib/db.js';
import { applyOpsToJson, type DocumentEditOp } from '../src/lib/document-edit.js';
import {
  expireStaleSuggestions, proposeDocumentEdit, SUGGESTION_ACCESS_LOST_REASON, SUGGESTION_EXPIRED_REASON,
} from '../src/lib/document-suggestions.js';
import { writeDocument } from '../src/lib/document-writer.js';
import { ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';
import { cancelLostRoomActions, LOST_ROOM_CANCEL_REASON } from '../src/lib/lost-room-action-cancellation.js';
import { agentRoutes } from '../src/routes/agent.js';
import { documentRoutes } from '../src/routes/documents.js';
import { spaceRoutes } from '../src/routes/spaces.js';
import {
  documentSuggestionExpiryKey, ensureDocumentSuggestionExpiry, nextDocumentSuggestionExpiryRun,
} from '../src/workers/handlers/document-suggestion-expiry.js';
import { startCollabTestServer, type CollabTestServer } from './fixtures/collab-client.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';

type JSONContent = Parameters<typeof jsonToText>[0];

let fx: DrivesFixture | undefined;
let srv: CollabTestServer | undefined;
let deftyId = '';

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('suggest', {
    routes: [{ path: '/api/documents', app: documentRoutes }, { path: '/api/agent', app: agentRoutes }, { path: '/api/spaces', app: spaceRoutes }],
  });
  srv = await startCollabTestServer(fx);
  deftyId = await ensureDeftyMembership(fx.orgId);
});

after(async () => {
  _setReviewerRecheckHookForTest(null);
  await srv?.close();
  if (fx) {
    for (const table of ['document_suggestions', 'action_receipts', 'agent_action_approvers', 'agent_actions', 'messages', 'job_queue']) {
      await fx.client.query(`DELETE FROM ${table} WHERE org_id = $1`, [fx.orgId]);
    }
    await fx.client.query("DELETE FROM job_queue WHERE dedupe_key LIKE 'document-suggestion-expiry:%' AND org_id IS NULL");
    await fx.teardown();
  }
  await closeDb();
});

// ---------------------------------------------------------------------------
// Helpers

const paragraph = (id: string, text: string): JSONContent => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] });
const docOf = (...blocks: JSONContent[]): JSONContent => ({ type: 'doc', content: blocks });

type Doc = { id: string; a: string; b: string; c: string };

/** A document of three paragraphs (Alpha, Beta, Gamma) in the Workspace drive, or `driveId`. */
async function threeBlocks(driveId?: string): Promise<Doc> {
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  const id = await fx!.insertDocument({
    driveId: driveId ?? fx!.workspaceDriveId, title: 'Plan',
    json: docOf(paragraph(a, 'Alpha'), paragraph(b, 'Beta'), paragraph(c, 'Gamma')),
  });
  return { id, a, b, c };
}

/** The document's current content with block ids (live when loaded). */
async function liveJson(documentId: string): Promise<JSONContent> {
  const state = await readCurrentDocument(documentId, fx!.orgId);
  assert.ok(state, 'the document has a state');
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return ensureBlockIds(yDocToJson(doc));
  } finally {
    doc.destroy();
  }
}

/** The document's top-level blocks as [id, text]. */
async function blocks(documentId: string): Promise<Array<[string, string]>> {
  return ((await liveJson(documentId)).content ?? []).map((node) => [String(node.attrs?.id), jsonToText({ type: 'doc', content: [node] }).trim()]);
}

async function revision(documentId: string): Promise<number> {
  const { rows: [row] } = await fx!.client.query('SELECT revision FROM documents WHERE id = $1', [documentId]);
  return Number(row.revision);
}

/** Someone typing `text` at the end of block `id`, through the one writer. */
async function typeInto(documentId: string, userId: string, id: string, text: string): Promise<void> {
  await writeDocument({
    orgId: fx!.orgId, documentId, actor: { kind: 'user', userId }, reason: 'restore',
    mutate: (doc) => {
      const element = doc.getXmlFragment('default').toArray()
        .find((child): child is Y.XmlElement => child instanceof Y.XmlElement && child.getAttribute('id') === id);
      assert.ok(element, `block ${id} is in the document`);
      const run = element.toArray().find((child): child is Y.XmlText => child instanceof Y.XmlText);
      assert.ok(run, `block ${id} holds text`);
      doc.transact(() => run.insert(run.length, text));
    },
  });
}

/** A chat of `type` with `members`. */
async function room(type: 'dm' | 'private', members: string[]): Promise<string> {
  const id = randomUUID();
  await fx!.client.query('INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, $4, $5)',
    [id, fx!.orgId, `room-${id.slice(0, 8)}`, type, fx!.people.owner]);
  for (const user of members) {
    await fx!.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), id, user]);
  }
  return id;
}

const dms = new Map<string, string>();
/** The person's DM with Defty, where they asked. */
async function dmOf(userId: string): Promise<string> {
  if (!dms.has(userId)) dms.set(userId, await room('dm', [userId, deftyId]));
  return dms.get(userId)!;
}

const SUMMARY = 'Tighten the plan';

/** The three operations most tests use: replace a, add a block after b, delete c. */
const threeOps = (d: Doc): DocumentEditOp[] => [
  { op: 'replace', block_id: d.a, markdown: 'Alpha, tightened' },
  { op: 'insert_after', block_id: d.b, markdown: 'A new point' },
  { op: 'delete', block_id: d.c },
];

type Suggested = { actionId: string; suggestionId: string };

/**
 * A pending `edit_document` action, as Defty's reply in the asker's chat
 * stores it (M7), and its suggestion, proposed in the same transaction.
 */
async function suggest(d: Doc, i: { asker?: string; ops?: DocumentEditOp[]; room?: string } = {}): Promise<Suggested> {
  const asker = i.asker ?? fx!.people.member;
  const chat = i.room ?? await dmOf(asker);
  const messageId = randomUUID();
  await fx!.client.query("INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, 'I have a suggestion')",
    [messageId, fx!.orgId, chat, deftyId]);
  const actionId = randomUUID();
  await fx!.client.query(`INSERT INTO agent_actions (id, org_id, user_id, conversation_id, message_id, source, action, params, approval_tier, approval_status)
    VALUES ($1, $2, $3, $4, $5, 'mention', 'edit_document', $6, 'quick', 'pending')`,
  [actionId, fx!.orgId, asker, chat, messageId, JSON.stringify({ document_id: d.id, summary: SUMMARY })]);
  const { suggestionId } = await db.transaction((tx) => proposeDocumentEdit(tx, {
    orgId: fx!.orgId, documentId: d.id, actionId, askerId: asker, agentUserId: deftyId, ops: i.ops ?? threeOps(d),
  }));
  return { actionId, suggestionId };
}

type SuggestionState = {
  status: string; selected_block_ids: string[] | null; applied_block_ids: string[] | null; changed_block_ids: string[];
  resolved_by: string | null; resolved_at: Date | null; reviewed_revision: string | null;
};

async function suggestion(id: string): Promise<SuggestionState> {
  const { rows: [row] } = await fx!.client.query(`SELECT status, selected_block_ids, applied_block_ids, changed_block_ids, resolved_by, resolved_at,
    reviewed_revision FROM document_suggestions WHERE id = $1`, [id]);
  return row;
}

async function action(id: string): Promise<{ approval_status: string; error: string | null; executed_at: Date | null; approved_by_user_id: string | null; params: Record<string, unknown>; result: unknown }> {
  const { rows: [row] } = await fx!.client.query('SELECT approval_status, error, executed_at, approved_by_user_id, params, result FROM agent_actions WHERE id = $1', [id]);
  return row;
}

/** `value` as JSON reads it back (no undefined properties). */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const call = async (userId: string, method: string, path: string, body?: unknown) => {
  const response = await fx!.request(userId, method, path, body);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const listPath = (d: Doc) => `/api/documents/${d.id}/suggestions`;
const reviewPath = (d: Doc, s: Suggested) => `/api/documents/${d.id}/suggestions/${s.suggestionId}`;
const applyPath = (d: Doc, s: Suggested) => `${reviewPath(d, s)}/apply`;
const rejectPath = (d: Doc, s: Suggested) => `${reviewPath(d, s)}/reject`;

/** Makes the suggestion and its action look `ageMs` old (in the database's clock: timestamps carry no zone). */
async function age(s: Suggested, ageMs: number): Promise<void> {
  const at = "now() - ($2::bigint * interval '1 millisecond')";
  await fx!.client.query(`UPDATE document_suggestions SET created_at = ${at}, updated_at = ${at} WHERE id = $1`, [s.suggestionId, ageMs]);
  await fx!.client.query(`UPDATE agent_actions SET created_at = ${at}, updated_at = ${at} WHERE id = $1`, [s.actionId, ageMs]);
}

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The brief's tests

test('a proposed edit stores base, ops and proposed content and shows as pending to everyone, in full only to the asker', { skip: !url && SKIP }, async () => {
  const d = await threeBlocks();
  const base = await liveJson(d.id);
  const at = await revision(d.id);
  const s = await suggest(d);

  const { rows: [row] } = await fx!.client.query('SELECT * FROM document_suggestions WHERE id = $1', [s.suggestionId]);
  const preview = applyOpsToJson(base, threeOps(d), { idSeed: s.actionId });
  assert.deepEqual(row.base_json, plain(base), 'the base is the live content');
  assert.equal(Number(row.base_revision), at);
  assert.deepEqual(row.ops, threeOps(d));
  assert.deepEqual(row.proposed_json, plain(preview.json));
  assert.deepEqual(row.changed_block_ids, preview.changedBlockIds);
  assert.equal(preview.changedBlockIds.length, 3);
  assert.equal(row.status, 'pending');
  assert.equal(row.asker_user_id, fx!.people.member);
  assert.equal(row.agent_user_id, deftyId);
  // Rule C4: the action names the suggestion and carries no document text.
  assert.deepEqual((await action(s.actionId)).params, { document_id: d.id, summary: SUMMARY, suggestion_id: s.suggestionId });
  assert.equal(await revision(d.id), at, 'proposing changes nothing');

  // The asker sees their own in the list; everyone else who can open the document only a count and a name.
  const mine = await call(fx!.people.member, 'GET', listPath(d));
  assert.equal(mine.status, 200);
  assert.equal(mine.body.mine.length, 1);
  assert.equal(mine.body.mine[0].id, s.suggestionId);
  assert.equal(mine.body.mine[0].status, 'pending');
  assert.equal(mine.body.mine[0].summary, SUMMARY);
  assert.equal(mine.body.mine[0].block_count, 3);
  assert.deepEqual(mine.body.others, []);
  const theirs = await call(fx!.people.member2, 'GET', listPath(d));
  assert.deepEqual(theirs, { status: 200, body: { mine: [], others: [{ pending: 1, asker_name: 'member' }] } });
  // A guest who shares no chat with the asker reads "A collaborator".
  const guest = await fx!.addPerson({ role: 'guest' });
  await fx!.share(d.id, { user: guest }, 'view');
  assert.deepEqual(await call(guest, 'GET', listPath(d)), { status: 200, body: { mine: [], others: [{ pending: 1, asker_name: 'A collaborator' }] } });
  assert.equal((await call(fx!.people.guest, 'GET', listPath(d))).status, 404, 'someone who cannot open the document');
  assert.equal((await call(fx!.people.outsider, 'GET', listPath(d))).status, 404, 'another workspace');

  // In full, to the asker only.
  const review = await call(fx!.people.member, 'GET', reviewPath(d, s));
  assert.equal(review.status, 200);
  const blocksById = new Map((base.content ?? []).map((node) => [String(node.attrs?.id), node]));
  const proposedById = new Map((preview.json.content ?? []).map((node) => [String(node.attrs?.id), node]));
  const added = preview.changedBlockIds[1]!;
  assert.equal(review.body.suggestion.id, s.suggestionId);
  assert.equal(review.body.suggestion.status, 'pending');
  assert.deepEqual(review.body.suggestion.asker, { id: fx!.people.member, name: 'member' });
  assert.equal(review.body.suggestion.revision, at);
  assert.deepEqual(review.body.suggestion.blocks, plain([
    { block_id: d.a, before: blocksById.get(d.a), after: proposedById.get(d.a), conflict: false },
    { block_id: added, before: null, after: proposedById.get(added), conflict: false },
    { block_id: d.c, before: blocksById.get(d.c), after: null, conflict: false },
  ]));
  assert.equal(proposedById.get(added)?.type, 'paragraph');
  for (const viewer of [fx!.people.member2, fx!.people.owner, guest]) {
    const refused = await call(viewer, 'GET', reviewPath(d, s));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'NOT_REQUESTER');
    assert.doesNotMatch(JSON.stringify(refused.body), /Alpha|Beta|Gamma|new point/);
  }
  assert.equal((await call(fx!.people.guest, 'GET', reviewPath(d, s))).status, 404);
  assert.equal((await call(fx!.people.outsider, 'GET', reviewPath(d, s))).status, 404);
  assert.equal((await call(fx!.people.member, 'GET', `/api/documents/${(await threeBlocks()).id}/suggestions/${s.suggestionId}`)).status, 404,
    'a suggestion is read on its own document only');
});

test('only the asker may apply or reject; anyone else gets 403 NOT_REQUESTER', { skip: !url && SKIP }, async () => {
  const d = await threeBlocks();
  const s = await suggest(d);
  const before = await blocks(d.id);
  for (const viewer of [fx!.people.member2, fx!.people.owner, fx!.people.admin]) {
    const applied = await call(viewer, 'POST', applyPath(d, s), { block_ids: 'all' });
    assert.equal(applied.status, 403, 'apply');
    assert.equal(applied.body.code, 'NOT_REQUESTER');
    const rejected = await call(viewer, 'POST', rejectPath(d, s));
    assert.equal(rejected.status, 403, 'reject');
    assert.equal(rejected.body.code, 'NOT_REQUESTER');
  }
  assert.equal((await call(fx!.people.guest, 'POST', applyPath(d, s), { block_ids: 'all' })).status, 404);
  assert.equal((await call(fx!.people.outsider, 'POST', rejectPath(d, s))).status, 404);
  // A block the suggestion doesn't change, an empty choice and an unknown key are 400.
  for (const body of [{ block_ids: [d.b] }, { block_ids: [] }, { block_ids: 'all', extra: true }, { revision: 1 }]) {
    assert.equal((await call(fx!.people.member, 'POST', applyPath(d, s), body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await suggestion(s.suggestionId)).status, 'pending');
  assert.equal((await action(s.actionId)).approval_status, 'pending');
  assert.deepEqual(await blocks(d.id), before);
});

test('applying some blocks applies only those, marks the suggestion partially accepted and the action approved', { skip: !url && SKIP }, async () => {
  const d = await threeBlocks();
  const s = await suggest(d);
  const added = (await suggestion(s.suggestionId)).changed_block_ids[1]!;
  const at = await revision(d.id);
  const applied = await call(fx!.people.member, 'POST', applyPath(d, s), { block_ids: [added, d.a], revision: at });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.status, 'partially_accepted');
  assert.deepEqual(applied.body.applied_block_ids, [d.a, added]);
  // The deletion of Gamma wasn't chosen.
  assert.deepEqual(await blocks(d.id), [[d.a, 'Alpha, tightened'], [d.b, 'Beta'], [added, 'A new point'], [d.c, 'Gamma']]);

  const row = await suggestion(s.suggestionId);
  assert.equal(row.status, 'partially_accepted');
  assert.deepEqual(row.selected_block_ids, [d.a, added]);
  assert.deepEqual(row.applied_block_ids, [d.a, added]);
  assert.equal(row.resolved_by, fx!.people.member);
  assert.ok(row.resolved_at);
  assert.equal(Number(row.reviewed_revision), at);
  const done = await action(s.actionId);
  assert.equal(done.approval_status, 'approved');
  assert.equal(done.approved_by_user_id, fx!.people.member);
  assert.ok(done.executed_at);
  assert.equal(done.error, null);
  // References only (rule C4).
  assert.deepEqual(Object.keys(done.result as object).sort(), ['applied_block_ids', 'document_id', 'status', 'suggestion_id', 'version_id']);

  // The same agent version as a direct edit of those blocks: credited to the asker and Defty.
  const { rows: [version] } = await fx!.client.query(`SELECT id, kind, name, created_by, agent_user_id, edit_details FROM document_versions
    WHERE document_id = $1 AND action_id = $2`, [d.id, s.actionId]);
  assert.equal(version.id, applied.body.version_id);
  assert.equal(version.kind, 'agent');
  assert.equal(version.name, `Agent edit: ${SUMMARY}`);
  assert.equal(version.created_by, fx!.people.member);
  assert.equal(version.agent_user_id, deftyId);
  assert.deepEqual(version.edit_details.changed_block_ids, [d.a, added]);

  // Undo works on it as on a direct edit.
  const undone = await call(fx!.people.member, 'POST', `/api/documents/agent-edits/${s.actionId}/undo`);
  assert.equal(undone.status, 200);
  assert.deepEqual([...undone.body.restored_block_ids].sort(), [d.a, added].sort());
  assert.deepEqual(undone.body.conflicted_block_ids, []);
  assert.deepEqual(await blocks(d.id), [[d.a, 'Alpha'], [d.b, 'Beta'], [d.c, 'Gamma']]);
});

test('a block someone changed since the base is marked as a conflict; applying it anyway applies it', { skip: !url && SKIP }, async () => {
  const d = await threeBlocks();
  const s = await suggest(d, { ops: [{ op: 'replace', block_id: d.a, markdown: 'Alpha, tightened' }, { op: 'replace', block_id: d.b, markdown: 'Beta, tightened' }] });
  const first = await call(fx!.people.member, 'GET', reviewPath(d, s));
  await typeInto(d.id, fx!.people.member2, d.a, ' and more');
  const review = await call(fx!.people.member, 'GET', reviewPath(d, s));
  assert.deepEqual(review.body.suggestion.blocks.map((block: { block_id: string; conflict: boolean }) => [block.block_id, block.conflict]),
    [[d.a, true], [d.b, false]]);
  assert.ok(review.body.suggestion.revision > first.body.suggestion.revision);

  // Applying at the revision the first review was read at: the document moved since.
  const stale = await call(fx!.people.member, 'POST', applyPath(d, s), { block_ids: [d.a], revision: first.body.suggestion.revision });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'REVISION_CHANGED');
  assert.equal((await suggestion(s.suggestionId)).status, 'pending', 'still reviewable');
  assert.equal((await suggestion(s.suggestionId)).selected_block_ids, null);
  assert.equal((await action(s.actionId)).approval_status, 'pending');

  // At the revision just reviewed, the conflicted block goes in anyway: the asker chose.
  const applied = await call(fx!.people.member, 'POST', applyPath(d, s), { block_ids: [d.a], revision: review.body.suggestion.revision });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.status, 'partially_accepted');
  assert.deepEqual(await blocks(d.id), [[d.a, 'Alpha, tightened'], [d.b, 'Beta'], [d.c, 'Gamma']]);
});

test('rejecting from the chat card marks the suggestion rejected', { skip: !url && SKIP }, async () => {
  const d = await threeBlocks();
  const before = await blocks(d.id);
  const s = await suggest(d);
  const rejected = await call(fx!.people.member, 'POST', `/api/agent/actions/${s.actionId}/reject`, {});
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.status, 'rejected');
  const row = await suggestion(s.suggestionId);
  assert.equal(row.status, 'rejected');
  assert.equal(row.resolved_by, fx!.people.member);
  assert.ok(row.resolved_at);
  assert.equal((await action(s.actionId)).approval_status, 'rejected');
  assert.deepEqual(await blocks(d.id), before);
  // Settled: applying it now is refused.
  const late = await call(fx!.people.member, 'POST', applyPath(d, s), { block_ids: 'all' });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'SUGGESTION_ALREADY_RESOLVING');

  // From the document as well.
  const t = await suggest(d);
  assert.deepEqual(await call(fx!.people.member, 'POST', rejectPath(d, t)), { status: 200, body: { status: 'rejected' } });
  assert.equal((await suggestion(t.suggestionId)).status, 'rejected');
  assert.equal((await action(t.actionId)).approval_status, 'rejected');
  assert.deepEqual(await blocks(d.id), before);
});

test('a suggestion pending for 14 days expires, closes its action and leaves a version note', { skip: !url && SKIP }, async () => {
  const d = await threeBlocks();
  const old = await suggest(d);
  const recent = await suggest(d, { asker: fx!.people.member2 });
  await age(old, 14 * DAY + 60 * 60_000);
  await age(recent, 13 * DAY);
  const content = await liveJson(d.id);
  const at = await revision(d.id);
  // The day it was suggested, d MMM yyyy, as stored (UTC).
  const { rows: [{ day }] } = await fx!.client.query("SELECT to_char(created_at, 'FMDD Mon YYYY') AS day FROM document_suggestions WHERE id = $1",
    [old.suggestionId]);

  assert.ok(await expireStaleSuggestions(new Date()) >= 1);
  assert.equal((await suggestion(old.suggestionId)).status, 'expired');
  const closed = await action(old.actionId);
  assert.equal(closed.approval_status, 'expired');
  assert.equal(closed.error, SUGGESTION_EXPIRED_REASON);
  assert.equal((await suggestion(recent.suggestionId)).status, 'pending');
  assert.equal((await action(recent.actionId)).approval_status, 'pending');

  const { rows: notes } = await fx!.client.query("SELECT kind, name, content_json, created_by FROM document_versions WHERE document_id = $1 AND kind = 'named'", [d.id]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].name, `Defty's suggestion from ${day} expired without review`);
  assert.deepEqual(notes[0].content_json, plain(content), 'the note holds the content as it is');
  assert.equal(notes[0].created_by, null);
  assert.equal(await revision(d.id), at, 'no content change');
  assert.deepEqual(await liveJson(d.id), content);
  // A second pass closes nothing more.
  await expireStaleSuggestions(new Date());
  assert.equal((await fx!.client.query("SELECT 1 FROM document_versions WHERE document_id = $1 AND kind = 'named'", [d.id])).rowCount, 1);

  // The daily job: each day's run has its own key, scheduled once.
  assert.equal(documentSuggestionExpiryKey(new Date('2026-11-27T10:00:00Z')), 'document-suggestion-expiry:2026-11-27');
  assert.equal(nextDocumentSuggestionExpiryRun(new Date('2026-11-27T02:00:00Z')).toISOString(), '2026-11-27T03:00:00.000Z');
  assert.equal(nextDocumentSuggestionExpiryRun(new Date('2026-11-27T03:00:00Z')).toISOString(), '2026-11-28T03:00:00.000Z');
  const when = new Date('2031-01-15T09:00:00Z');
  const key = documentSuggestionExpiryKey(nextDocumentSuggestionExpiryRun(when));
  await fx!.client.query('DELETE FROM job_queue WHERE dedupe_key = $1', [key]);
  await ensureDocumentSuggestionExpiry(when);
  await ensureDocumentSuggestionExpiry(when);
  const { rows: jobs } = await fx!.client.query('SELECT name, org_id FROM job_queue WHERE dedupe_key = $1', [key]);
  assert.deepEqual(jobs, [{ name: 'document-suggestion-expiry', org_id: null }]);
  await fx!.client.query('DELETE FROM job_queue WHERE dedupe_key = $1', [key]);
});

test('removing the asker from the chat that gave them edit cancels the suggestion and its action', { skip: !url && SKIP }, async () => {
  const drive = await fx!.insertDrive({ kind: 'private' });
  const d = await threeBlocks(drive);
  await fx!.share(d.id, { space: fx!.spaces.team }, 'edit');
  const mine = await suggest(d);
  const theirs = await suggest(d, { asker: fx!.people.member2 });
  const removed = await call(fx!.people.owner, 'DELETE', `/api/spaces/${fx!.spaces.team}/members/${fx!.people.member}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await suggestion(mine.suggestionId)).status, 'cancelled');
  const closed = await action(mine.actionId);
  assert.equal(closed.approval_status, 'expired');
  assert.equal(closed.error, SUGGESTION_ACCESS_LOST_REASON);
  // member2 still edits it through the chat.
  assert.equal((await suggestion(theirs.suggestionId)).status, 'pending');
  assert.equal((await action(theirs.actionId)).approval_status, 'pending');
  assert.equal((await call(fx!.people.member, 'GET', reviewPath(d, mine))).status, 404);
  await fx!.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), fx!.spaces.team, fx!.people.member]);
});

// ---------------------------------------------------------------------------
// The consult's tests

test('a suggestion is still reviewable after 2 days', { skip: !url && SKIP }, async () => {
  const d = await threeBlocks();
  const s = await suggest(d);
  await age(s, 2 * DAY);
  await maintainAttentionSystem(new Date());
  await expireStaleSuggestions(new Date());
  assert.equal((await action(s.actionId)).approval_status, 'pending', 'the 24-hour approval TTL leaves it alone');
  assert.equal((await suggestion(s.suggestionId)).status, 'pending');
  assert.equal((await call(fx!.people.member, 'GET', reviewPath(d, s))).status, 200);
  const applied = await call(fx!.people.member, 'POST', applyPath(d, s), { block_ids: 'all', revision: await revision(d.id) });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.status, 'accepted');
  const added = (await suggestion(s.suggestionId)).changed_block_ids[1]!;
  assert.deepEqual(await blocks(d.id), [[d.a, 'Alpha, tightened'], [d.b, 'Beta'], [added, 'A new point']]);
});

test('a room-rule cancellation marks the suggestion cancelled', { skip: !url && SKIP }, async () => {
  const d = await threeBlocks();
  const chat = await room('private', [fx!.people.member]);
  const s = await suggest(d, { room: chat });
  // The person leaves the chat the request came from; they still edit the document (an open drive).
  await fx!.removeSpaceMember(chat, fx!.people.member);
  const closedIds = await cancelLostRoomActions({ orgId: fx!.orgId });
  assert.ok(closedIds.includes(s.actionId));
  const closed = await action(s.actionId);
  assert.equal(closed.approval_status, 'expired');
  assert.equal(closed.error, LOST_ROOM_CANCEL_REASON);
  assert.equal((await suggestion(s.suggestionId)).status, 'cancelled');
});

test("an admin can't approve or reject someone else's suggestion", { skip: !url && SKIP }, async () => {
  const d = await threeBlocks();
  const before = await blocks(d.id);
  // Asked in the public team chat, which owners and admins read.
  const s = await suggest(d, { room: fx!.spaces.team });
  const refusedFor = async (userId: string) => {
    for (const verb of ['approve', 'reject']) {
      const answer = await call(userId, 'POST', `/api/agent/actions/${s.actionId}/${verb}`, {});
      assert.ok(answer.status === 403 || answer.status === 404, `${verb}: ${answer.status} ${JSON.stringify(answer.body)}`);
    }
  };
  await refusedFor(fx!.people.admin);
  await refusedFor(fx!.people.owner);
  // With the asker no longer active, reviews of their ordinary actions fall to owners and admins; never this one.
  await fx!.client.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [fx!.orgId, fx!.people.member]);
  try {
    for (const userId of [fx!.people.admin, fx!.people.owner]) {
      for (const verb of ['approve', 'reject']) {
        const answer = await call(userId, 'POST', `/api/agent/actions/${s.actionId}/${verb}`, {});
        assert.equal(answer.status, 403, `${verb}: ${JSON.stringify(answer.body)}`);
      }
      const authority = (await viewerReviewAuthority({ id: userId, org_id: fx!.orgId }, [s.actionId])).get(s.actionId);
      assert.deepEqual(authority, { viewer_can_approve: false, viewer_can_reject: false });
    }
  } finally {
    await fx!.client.query('UPDATE org_members SET is_active = true WHERE org_id = $1 AND user_id = $2', [fx!.orgId, fx!.people.member]);
  }
  assert.equal((await action(s.actionId)).approval_status, 'pending');
  assert.equal((await suggestion(s.suggestionId)).status, 'pending');
  assert.deepEqual(await blocks(d.id), before);
});

test('two applies with different selections: one wins, the other gets 409', { skip: !url && SKIP }, async () => {
  const d = await threeBlocks();
  const s = await suggest(d, { ops: [{ op: 'replace', block_id: d.a, markdown: 'Alpha, tightened' }, { op: 'replace', block_id: d.b, markdown: 'Beta, tightened' }] });
  const at = await revision(d.id);
  const answers = await Promise.all([
    call(fx!.people.member, 'POST', applyPath(d, s), { block_ids: [d.a], revision: at }),
    call(fx!.people.member, 'POST', applyPath(d, s), { block_ids: [d.b], revision: at }),
  ]);
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 409], JSON.stringify(answers));
  const winner = answers.find((answer) => answer.status === 200)!;
  const loser = answers.find((answer) => answer.status === 409)!;
  assert.equal(loser.body.code, 'SUGGESTION_ALREADY_RESOLVING');
  const chosen = winner.body.applied_block_ids as string[];
  assert.equal(chosen.length, 1);
  assert.deepEqual((await suggestion(s.suggestionId)).applied_block_ids, chosen);
  // Only the winner's block changed.
  const expected: Array<[string, string]> = chosen[0] === d.a
    ? [[d.a, 'Alpha, tightened'], [d.b, 'Beta'], [d.c, 'Gamma']]
    : [[d.a, 'Alpha'], [d.b, 'Beta, tightened'], [d.c, 'Gamma']];
  assert.deepEqual(await blocks(d.id), expected);
});

test('approving from the card after the document changed sends the asker to the review', { skip: !url && SKIP }, async () => {
  const d = await threeBlocks();
  const s = await suggest(d);
  await typeInto(d.id, fx!.people.member2, d.b, ' (typed)');
  const afterTyping = await blocks(d.id);
  const card = await call(fx!.people.member, 'POST', `/api/agent/actions/${s.actionId}/approve`, {});
  assert.equal(card.status, 409, JSON.stringify(card.body));
  assert.equal(card.body.code, 'REVIEW_IN_DOCUMENT');
  assert.equal((await action(s.actionId)).approval_status, 'pending');
  const row = await suggestion(s.suggestionId);
  assert.equal(row.status, 'pending');
  assert.equal(row.selected_block_ids, null);
  assert.deepEqual(await blocks(d.id), afterTyping, 'nothing applied');
  // The review in the document applies it.
  const review = await call(fx!.people.member, 'GET', reviewPath(d, s));
  const applied = await call(fx!.people.member, 'POST', applyPath(d, s), { block_ids: 'all', revision: review.body.suggestion.revision });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.status, 'accepted');

  // A document no one has changed: the card applies every block, as it showed them.
  const e = await threeBlocks();
  const t = await suggest(e);
  const approved = await call(fx!.people.member, 'POST', `/api/agent/actions/${t.actionId}/approve`, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal((await suggestion(t.suggestionId)).status, 'accepted');
  const added = (await suggestion(t.suggestionId)).changed_block_ids[1]!;
  assert.deepEqual(await blocks(e.id), [[e.a, 'Alpha, tightened'], [e.b, 'Beta'], [added, 'A new point']]);

  // A change landing between the check and the write: nothing is applied, and the action and suggestion wait again.
  const f = await threeBlocks();
  const u = await suggest(f);
  _setReviewerRecheckHookForTest(async (point, actionId) => {
    if (point === 'before_decision' && actionId === u.actionId) await typeInto(f.id, fx!.people.member2, f.b, ' (late)');
  });
  try {
    const raced = await call(fx!.people.member, 'POST', `/api/agent/actions/${u.actionId}/approve`, {});
    assert.equal(raced.status, 409, JSON.stringify(raced.body));
    assert.equal(raced.body.code, 'REVIEW_IN_DOCUMENT');
  } finally {
    _setReviewerRecheckHookForTest(null);
  }
  const reopened = await action(u.actionId);
  assert.equal(reopened.approval_status, 'pending');
  assert.equal(reopened.executed_at, null);
  assert.equal((await suggestion(u.suggestionId)).status, 'pending');
  assert.deepEqual(await blocks(f.id), [[f.a, 'Alpha'], [f.b, 'Beta (late)'], [f.c, 'Gamma']]);
  assert.equal((await fx!.client.query("SELECT 1 FROM document_versions WHERE action_id = $1 AND kind = 'agent'", [u.actionId])).rowCount, 0);
});
