// A document that names a task by its key links to that task even when the
// project prefix holds a digit (R9G-1, RC8-12). Release 153 checks found the
// cross-reference scanner reading R9G-1 as G-1, so such a note got no
// backlink (or one to the wrong project's task). The scanner now matches a
// key whole with the same rule task search uses (lib/task-key.ts), and still
// links only tasks the author may see (visibleTaskCondition), from a document
// they can open (lib/document-access.ts). Notes are documents since the notes
// move (F15): the scanner reads documents, and an edit to a document queues
// its scan (lib/document-cross-references.ts).
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyJsonToYDoc } from '@deft/doc-schema';
import { closeDb } from '../src/lib/db.js';
import { startDocumentCrossReferences } from '../src/lib/document-cross-references.js';
import { writeDocument } from '../src/lib/document-writer.js';
import { handleCrossReference } from '../src/workers/handlers/cross-reference.js';
import { taskKeysIn } from '../src/lib/task-key.js';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
const run = randomUUID().slice(0, 8);
const org = randomUUID();
const owner = randomUUID();
const member = randomUUID();
const people = [owner, member];
/** Each person's My drive: a document there opens for its owner alone. */
const myDrive: Record<string, string> = { [owner]: randomUUID(), [member]: randomUUID() };

// R9G holds a digit; G is the project the old scanner read R9G-1 as.
// 9RC starts with a digit; RC is its decoy. AB- ends in a dash, so its task 1
// would read AB-1 without the dash rule; AB is the project AB-1 names.
const projectIds = { r9g: randomUUID(), rc8: randomUUID(), g: randomUUID(), n9rc: randomUUID(), rc: randomUUID(), ab: randomUUID(), abDash: randomUUID() };
const prefixes = { r9g: 'R9G', rc8: 'RC8', g: 'G', n9rc: '9RC', rc: 'RC', ab: 'AB', abDash: 'AB-' };
type ProjectKey = keyof typeof projectIds;
const taskIds = {
  r9g1: randomUUID(),   // R9G-1
  rc812: randomUUID(),  // RC8-12
  g1: randomUUID(),     // G-1 (decoy)
  hidden: randomUUID(), // R9G-3, restricted to the owner
  n9rc1: randomUUID(),  // 9RC-1
  rc1: randomUUID(),    // RC-1 (decoy)
  ab1: randomUUID(),    // AB-1, restricted to the owner
  abDash1: randomUUID(), // AB--1 (decoy), open
};

before(async () => {
  await c.connect();
  await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Note Backlink Keys', $2)`, [org, `note-backlink-keys-${run}`]);
  for (const [id, role] of [[owner, 'owner'], [member, 'member']] as const) {
    await c.query(`INSERT INTO users (id, email, name, kind, is_agent, password_hash) VALUES ($1, $2, $3, 'human', false, 'hash')`,
      [id, `nbk-${run}-${role}@test.local`, `NBK ${role} ${run}`]);
    await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, true)`, [org, id, role]);
    // As ensurePersonalDrive (F4) makes it: the owner holds full access through a drive_members row.
    await c.query(`INSERT INTO drives (id, org_id, name, kind, owner_user_id, created_by) VALUES ($1, $2, 'My drive', 'personal', $3, $3)`,
      [myDrive[id], org, id]);
    await c.query(`INSERT INTO drive_members (id, org_id, drive_id, principal_type, principal_id, role, added_by)
      VALUES (gen_random_uuid()::text, $1, $2, 'user', $3, 'full', $3)`, [org, myDrive[id], id]);
  }
  for (const key of Object.keys(projectIds) as ProjectKey[]) {
    await c.query(`INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES ($1, $2, $3, $4, null, 20)`,
      [projectIds[key], org, `nbk ${key} ${run}`, prefixes[key]]);
  }
  const restricted = JSON.stringify({ visibility: 'restricted', visible_user_ids: [] });
  const rows: Array<[string, string, number, string | null]> = [
    [taskIds.r9g1, projectIds.r9g, 1, null],
    [taskIds.rc812, projectIds.rc8, 12, null],
    [taskIds.g1, projectIds.g, 1, null],
    [taskIds.hidden, projectIds.r9g, 3, restricted],
    [taskIds.n9rc1, projectIds.n9rc, 1, null],
    [taskIds.rc1, projectIds.rc, 1, null],
    [taskIds.ab1, projectIds.ab, 1, restricted],
    [taskIds.abDash1, projectIds.abDash, 1, null],
  ];
  for (const [id, project, number, metadata] of rows) {
    await c.query(`INSERT INTO tasks (id, org_id, project_id, number, title, created_by, status, priority, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, 'todo', 'p2', $7)`, [id, org, project, number, `nbk task ${number} ${run}`, owner, metadata]);
  }
});

after(async () => {
  await c.query(`DELETE FROM cross_references WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM task_comments WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM task_activity WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM job_queue WHERE org_id = $1`, [org]);
  for (const table of ['document_versions', 'document_attachments', 'documents', 'drive_members', 'drives']) {
    await c.query(`DELETE FROM ${table} WHERE org_id = $1`, [org]);
  }
  await c.query(`DELETE FROM tasks WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM projects WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM org_members WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [people]);
  await c.query(`DELETE FROM orgs WHERE id = $1`, [org]).catch(() => {});
  await c.end();
  await closeDb();
});

const docOf = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

/** A document in `author`'s My drive holding `text`. */
async function insertDocument(author: string, text: string): Promise<string> {
  const id = randomUUID();
  const json = JSON.stringify(docOf(text));
  await c.query(`INSERT INTO documents (id, org_id, drive_id, title, content_json, content_text, size_bytes, created_by)
    VALUES ($1, $2, $3, 'nbk document', $4::jsonb, $5, $6, $7)`, [id, org, myDrive[author], json, text, Buffer.byteLength(json), author]);
  return id;
}

/** The task ids the scanner linked from `documentId`. */
async function linkedFrom(documentId: string): Promise<string[]> {
  const { rows } = await c.query(`SELECT target_id FROM cross_references WHERE source_type = 'document' AND source_id = $1 AND target_type = 'task'`,
    [documentId]);
  return rows.map((row) => row.target_id as string).sort();
}

/** Writes a document by `author` with `text`, runs the scanner for `scanner` (the author by default), returns the task ids it links. */
async function scanDocument(author: string, text: string, scanner = author): Promise<string[]> {
  const documentId = await insertDocument(author, text);
  await handleCrossReference({
    id: `nbk-${documentId}`,
    name: 'cross-reference',
    attempts: 0,
    data: { sourceType: 'document', sourceId: documentId, content: '', orgId: org, userId: scanner },
  });
  return linkedFrom(documentId);
}

test('taskKeysIn reads a key whose prefix holds a digit whole, once each', () => {
  assert.deepEqual(taskKeysIn('see R9G-1, RC8-12 and DEFT-5; again R9G-1'), ['R9G-1', 'RC8-12', 'DEFT-5']);
  assert.deepEqual(taskKeysIn('due 2026-11-26, covid-19, r9g-1'), []);
  assert.deepEqual(taskKeysIn('9RC-1 (DEFT-5), "RC8-12".'), ['9RC-1', 'DEFT-5', 'RC8-12']);
  assert.deepEqual(taskKeysIn('preR9G-1, R9G-1draft, x9RC-1'), []);
});

test('a document naming R9G-1 and RC8-12 links those tasks, not G-1 (an edit queues the scan)', async () => {
  const documentId = await insertDocument(member, 'Nothing blocked yet.');
  const stop = startDocumentCrossReferences();
  try {
    // The member's edit is stored through the one writer; its stored listener queues the scan.
    const { revision } = await writeDocument({
      orgId: org, documentId, actor: { kind: 'user', userId: member }, reason: 'agent_edit',
      mutate: (doc) => applyJsonToYDoc(doc, docOf('Blocked on R9G-1 and RC8-12.') as any),
    });
    const { rows: jobs } = await c.query(`SELECT id, name, data, attempts FROM job_queue
      WHERE org_id = $1 AND name = 'cross-reference' AND dedupe_key = $2`, [org, `doc-xref:${documentId}:${revision}`]);
    assert.equal(jobs.length, 1, 'the edit queued one scan');
    assert.deepEqual({ sourceType: jobs[0].data.sourceType, sourceId: jobs[0].data.sourceId, userId: jobs[0].data.userId },
      { sourceType: 'document', sourceId: documentId, userId: member });
    await handleCrossReference({ id: jobs[0].id, name: jobs[0].name, data: jobs[0].data, attempts: jobs[0].attempts });
  } finally {
    stop();
  }
  const linked = await linkedFrom(documentId);
  assert.deepEqual(linked, [taskIds.r9g1, taskIds.rc812].sort());
  assert.ok(!linked.includes(taskIds.g1), 'R9G-1 is not read as G-1');
});

test('G-1 written on its own still links the G project task', async () => {
  assert.deepEqual(await scanDocument(member, 'See G-1.'), [taskIds.g1]);
});

test('a zero-padded key (R9G-01) links nothing, as task search finds nothing for it', async () => {
  assert.deepEqual(await scanDocument(member, 'See R9G-01 and RC8-012.'), []);
});

test('a restricted task is linked only from a document whose author may see it', async () => {
  assert.deepEqual(await scanDocument(member, 'Also R9G-3.'), [], 'a member the task does not name gets no link');
  assert.deepEqual(await scanDocument(owner, 'Also R9G-3.'), [taskIds.hidden], 'its creator gets the link');
});

test('a document is scanned only for someone who can open it', async () => {
  // The owner's own document, queued for the member, who can't open it: no link, though G-1 is open to both.
  assert.deepEqual(await scanDocument(owner, 'See G-1.', member), []);
});

test('a prefix that starts with a digit (9RC-1) links that task, not RC-1', async () => {
  assert.deepEqual(await scanDocument(member, 'Waiting on 9RC-1.'), [taskIds.n9rc1]);
});

test('a key inside a longer word (preR9G-1, R9G-1draft) links nothing', async () => {
  assert.deepEqual(await scanDocument(member, 'preR9G-1 and R9G-1draft'), []);
});

test('AB-1 links only project AB task 1, never project AB- task 1, even when AB-1 is hidden from the author', async () => {
  assert.deepEqual(await scanDocument(member, 'See AB-1.'), [], 'the member cannot see AB-1 and AB- task 1 is not AB-1');
  assert.deepEqual(await scanDocument(owner, 'See AB-1.'), [taskIds.ab1]);
});
