// A note that names a task by its key links to that task even when the
// project prefix holds a digit (R9G-1, RC8-12). Release 153 checks found the
// cross-reference scanner reading R9G-1 as G-1, so such a note got no
// backlink (or one to the wrong project's task). The scanner now matches a
// key whole with the same rule task search uses (lib/task-key.ts), and still
// links only tasks the note's author may see (visibleTaskCondition).
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { handleCrossReference } from '../src/workers/handlers/cross-reference.js';
import { taskKeysIn } from '../src/lib/task-key.js';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
const run = randomUUID().slice(0, 8);
const org = randomUUID();
const owner = randomUUID();
const member = randomUUID();
const people = [owner, member];

// R9G holds a digit; G is the project the old scanner read R9G-1 as.
const projectIds = { r9g: randomUUID(), rc8: randomUUID(), g: randomUUID() };
const prefixes = { r9g: 'R9G', rc8: 'RC8', g: 'G' };
const taskIds = {
  r9g1: randomUUID(),   // R9G-1
  rc812: randomUUID(),  // RC8-12
  g1: randomUUID(),     // G-1 (decoy)
  hidden: randomUUID(), // R9G-3, restricted to the owner
};

before(async () => {
  await c.connect();
  await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Note Backlink Keys', $2)`, [org, `note-backlink-keys-${run}`]);
  for (const [id, role] of [[owner, 'owner'], [member, 'member']] as const) {
    await c.query(`INSERT INTO users (id, email, name, kind, is_agent, password_hash) VALUES ($1, $2, $3, 'human', false, 'hash')`,
      [id, `nbk-${run}-${role}@test.local`, `NBK ${role} ${run}`]);
    await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, true)`, [org, id, role]);
  }
  for (const key of ['r9g', 'rc8', 'g'] as const) {
    await c.query(`INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES ($1, $2, $3, $4, null, 20)`,
      [projectIds[key], org, `nbk ${key} ${run}`, prefixes[key]]);
  }
  const restricted = JSON.stringify({ visibility: 'restricted', visible_user_ids: [] });
  const rows: Array<[string, string, number, string | null]> = [
    [taskIds.r9g1, projectIds.r9g, 1, null],
    [taskIds.rc812, projectIds.rc8, 12, null],
    [taskIds.g1, projectIds.g, 1, null],
    [taskIds.hidden, projectIds.r9g, 3, restricted],
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
  await c.query(`DELETE FROM notes WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM tasks WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM projects WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM org_members WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [people]);
  await c.query(`DELETE FROM orgs WHERE id = $1`, [org]).catch(() => {});
  await c.end();
});

/** Writes a note by `author` with `text`, runs the scanner, returns the task ids it links. */
async function scanNote(author: string, text: string): Promise<string[]> {
  const note = randomUUID();
  const content = `<p>${text}</p>`;
  await c.query(`INSERT INTO notes (id, org_id, user_id, title, content, visibility) VALUES ($1, $2, $3, 'nbk note', $4, 'org')`,
    [note, org, author, content]);
  await handleCrossReference({
    id: `nbk-${note}`,
    name: 'cross-reference',
    attempts: 0,
    data: { sourceType: 'note', sourceId: note, content, orgId: org, userId: author },
  });
  const { rows } = await c.query(`SELECT target_id FROM cross_references WHERE source_type = 'note' AND source_id = $1 AND target_type = 'task'`, [note]);
  return rows.map((row) => row.target_id as string).sort();
}

test('taskKeysIn reads a key whose prefix holds a digit whole, once each', () => {
  assert.deepEqual(taskKeysIn('see R9G-1, RC8-12 and DEFT-5; again R9G-1'), ['R9G-1', 'RC8-12', 'DEFT-5']);
  assert.deepEqual(taskKeysIn('due 2026-11-26, covid-19, r9g-1'), []);
});

test('a note naming R9G-1 and RC8-12 links those tasks, not G-1', async () => {
  const linked = await scanNote(member, 'Blocked on R9G-1 and RC8-12.');
  assert.deepEqual(linked, [taskIds.r9g1, taskIds.rc812].sort());
  assert.ok(!linked.includes(taskIds.g1), 'R9G-1 is not read as G-1');
});

test('G-1 written on its own still links the G project task', async () => {
  assert.deepEqual(await scanNote(member, 'See G-1.'), [taskIds.g1]);
});

test('a zero-padded key (R9G-01) links nothing, as task search finds nothing for it', async () => {
  assert.deepEqual(await scanNote(member, 'See R9G-01 and RC8-012.'), []);
});

test('a restricted task is linked only from a note whose author may see it', async () => {
  assert.deepEqual(await scanNote(member, 'Also R9G-3.'), [], 'a member the task does not name gets no link');
  assert.deepEqual(await scanNote(owner, 'Also R9G-3.'), [taskIds.hidden], 'its creator gets the link');
});
