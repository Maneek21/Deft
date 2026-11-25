// A guest sees only the notes they were added to: their own notes, notes
// shared with them (note_shares) and space notes of spaces they belong to.
// A note visible to the whole workspace (visibility 'org') is not shown to a
// guest. Owners, admins, members and agents are unchanged: the equivalence
// tests compare the rule before this change with the rule now over every note
// shape, for every non-guest.
//
// Search used its own copy of the rule, without the shares branch: a member
// now finds a note shared with them there too.
//
// The guest's session and MCP token both claim role 'member': only the
// org_members row makes them a guest.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { notes } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { visibleNoteCondition } from '../src/lib/note-visibility.js';
import { promotableNoteSql } from '../src/lib/agent-action-visibility.js';
import { retrieveContext } from '../src/lib/retrieve-context.js';
import { resolveNativeNoteDisplay } from '../src/lib/native-content-projections.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { getTeamContext } from '../src/lib/mcp-tools/team-context.js';
import { humanNoteGet, humanNoteList, type HumanToolContext } from '../src/lib/mcp-tools/human.js';
import { dailyNoteRoutes } from '../src/routes/daily-notes.js';
import { searchRoutes } from '../src/routes/search.js';
import { tagRoutes } from '../src/routes/tags.js';
import { crossReferenceRoutes } from '../src/routes/cross-references.js';
import { teamRoutes } from '../src/routes/teams.js';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
const run = randomUUID().slice(0, 8);
const org = randomUUID();
const owner = randomUUID(), admin = randomUUID(), member = randomUUID(), guest = randomUUID();
// An agent user with no membership row keeps the full view (people-visibility-sql.ts).
const looseAgent = randomUUID();
const people: Array<[string, string, string | null, 'human' | 'agent']> = [
  [owner, 'Olive Owner', 'owner', 'human'],
  [admin, 'Ada Admin', 'admin', 'human'],
  [member, 'Mo Member', 'member', 'human'],
  [guest, 'Gus Guest', 'guest', 'human'],
  [looseAgent, 'Lou Agent', null, 'agent'],
];
const NON_GUESTS = [owner, admin, member, looseAgent];
const guestRoom = randomUUID(), memberRoom = randomUUID();
const project = randomUUID(), task = randomUUID(), tag = randomUUID(), team = randomUUID();
const word = `gnv${run}`;

type Shape = { author: string; visibility: 'private' | 'org' | 'space'; space?: string; sharedWith?: string; template?: boolean };
const shapes = {
  orgNote: { author: member, visibility: 'org' },
  orgTemplate: { author: member, visibility: 'org', template: true },
  privateOther: { author: member, visibility: 'private' },
  spaceOut: { author: member, visibility: 'space', space: memberRoom },
  guestOwn: { author: guest, visibility: 'private' },
  guestOwnOrg: { author: guest, visibility: 'org' },
  sharedToGuest: { author: member, visibility: 'private', sharedWith: guest },
  spaceIn: { author: member, visibility: 'space', space: guestRoom },
  sharedToMember: { author: owner, visibility: 'private', sharedWith: member },
} satisfies Record<string, Shape>;
type NoteKey = keyof typeof shapes;
const noteIds = Object.fromEntries(Object.keys(shapes).map((key) => [key, randomUUID()])) as Record<NoteKey, string>;
const titleOf = (key: string) => `${word} ${key}`;
const GUEST_SEES: NoteKey[] = ['guestOwn', 'guestOwnOrg', 'sharedToGuest', 'spaceIn'];
const GUEST_HIDDEN: NoteKey[] = ['orgNote', 'privateOther', 'spaceOut', 'sharedToMember'];
const NOT_TEMPLATES = (Object.keys(shapes) as NoteKey[]).filter((key) => key !== 'orgTemplate');
const matrixIds: string[] = [];

async function insertNote(id: string, key: string, shape: Shape) {
  // Matrix notes are older, so the named notes stay inside the notes list's 100 rows.
  await c.query(`INSERT INTO notes (id, org_id, user_id, title, content, visibility, visibility_space_id, is_template, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - ($9 || ' days')::interval)`,
  [id, org, shape.author, titleOf(key), `<p>${titleOf(key)} body</p>`, shape.visibility, shape.space ?? null, shape.template ?? false,
    key.startsWith('matrix-') ? '1' : '0']);
  if (shape.sharedWith) {
    await c.query(`INSERT INTO note_shares (id, note_id, shared_with_user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [id, shape.sharedWith]);
  }
}

before(async () => {
  await c.connect();
  await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Guest Notes', $2)`, [org, `guest-notes-${run}`]);
  for (const [id, name, role, kind] of people) {
    await c.query(`INSERT INTO users (id, email, name, kind, is_agent, password_hash) VALUES ($1, $2, $3, $4, $5, 'hash')`,
      [id, `gnv-${run}-${id}@test.local`, `${name} ${run}`, kind, kind === 'agent']);
    if (role) {
      await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, true)`, [org, id, role]);
    }
  }
  await c.query(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES
      ($1, $3, 'gnv guest room', 'private', $4), ($2, $3, 'gnv member room', 'public', $4)`, [guestRoom, memberRoom, org, owner]);
  for (const [room, user] of [[guestRoom, guest], [guestRoom, member], [memberRoom, member], [memberRoom, owner], [memberRoom, admin]]) {
    await c.query(`INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [room, user]);
  }
  for (const [key, shape] of Object.entries(shapes) as Array<[NoteKey, Shape]>) await insertNote(noteIds[key], key, shape);
  // Every author, visibility and share, for the equivalence tests.
  for (const [author] of people) {
    for (const [visibility, space] of [['private', null], ['org', null], ['space', guestRoom], ['space', memberRoom]] as const) {
      for (const sharedWith of [undefined, ...people.map(([id]) => id)]) {
        const id = randomUUID();
        matrixIds.push(id);
        await insertNote(id, `matrix-${matrixIds.length}`, { author, visibility, space: space ?? undefined, sharedWith });
      }
    }
  }
  // A task the guest may see (its project is linked to the guest's room), referenced from notes.
  await c.query(`INSERT INTO projects (id, org_id, name, prefix, task_counter) VALUES ($1, $2, 'gnv project', $3, 10)`,
    [project, org, `N${run.slice(0, 4).toUpperCase()}`]);
  await c.query(`INSERT INTO project_spaces (id, project_id, space_id) VALUES (gen_random_uuid()::text, $1, $2)`, [project, guestRoom]);
  await c.query(`INSERT INTO tasks (id, org_id, project_id, number, title, created_by, status) VALUES ($1, $2, $3, 1, 'gnv task', $4, 'todo')`,
    [task, org, project, member]);
  await c.query(`INSERT INTO tags (id, org_id, name) VALUES ($1, $2, $3)`, [tag, org, `gnv-${run}`]);
  await c.query(`INSERT INTO teams (id, org_id, name, handle, visibility, lead_user_id) VALUES ($1, $2, 'gnv team', $3, 'org', $4)`,
    [team, org, `gnv-${run}`, member]);
  await c.query(`INSERT INTO team_members (id, org_id, team_id, user_id) VALUES (gen_random_uuid()::text, $1, $2, $3)`, [org, team, guest]);
  for (const key of Object.keys(shapes) as NoteKey[]) {
    await c.query(`INSERT INTO cross_references (id, org_id, source_type, source_id, target_type, target_id, created_by)
      VALUES (gen_random_uuid()::text, $1, 'note', $2, 'task', $3, $4)`, [org, noteIds[key], task, member]);
    await c.query(`INSERT INTO entity_tags (id, org_id, tag_id, entity_type, entity_id) VALUES (gen_random_uuid()::text, $1, $2, 'note', $3)`,
      [org, tag, noteIds[key]]);
    await c.query(`INSERT INTO team_resources (id, org_id, team_id, resource_type, resource_id, label) VALUES (gen_random_uuid()::text, $1, $2, 'note', $3, $4)`,
      [org, team, noteIds[key], titleOf(key)]);
  }
});

after(async () => {
  await c.query(`DELETE FROM team_resources WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM team_members WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM teams WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM entity_tags WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM tags WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM cross_references WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM tasks WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM project_spaces WHERE project_id = $1`, [project]);
  await c.query(`DELETE FROM projects WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM note_shares WHERE note_id IN (SELECT id FROM notes WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM notes WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM idempotency_keys WHERE user_id = ANY($1::text[])`, [people.map(([id]) => id)]).catch(() => {});
  await c.query(`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM spaces WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM org_members WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [people.map(([id]) => id)]);
  await c.query(`DELETE FROM orgs WHERE id = $1`, [org]);
  await c.end();
});

const sorted = (list: Iterable<string>) => [...list].sort();

/** visibleNoteCondition exactly as it was before the guest rule (note-visibility.ts on master). */
async function visibleBefore(userId: string): Promise<string[]> {
  const { rows } = await c.query(`SELECT n.id FROM notes n WHERE n.org_id = $1 AND n.is_deleted = false AND (
      n.user_id = $2 OR n.visibility = 'org'
      OR EXISTS (SELECT 1 FROM note_shares s WHERE s.note_id = n.id AND s.shared_with_user_id = $2)
      OR EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = n.visibility_space_id AND m.user_id = $2 AND n.visibility = 'space'))`,
  [org, userId]);
  return sorted(rows.map((row) => row.id as string));
}

/** promotableNoteSql as it was before. */
async function promotableBefore(userId: string): Promise<string[]> {
  const { rows } = await c.query(`SELECT n.id FROM notes n WHERE n.org_id = $1 AND n.is_deleted = false AND (
      n.user_id = $2 OR n.visibility = 'org'
      OR (n.visibility = 'space' AND EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id = sm.space_id
        WHERE sm.space_id = n.visibility_space_id AND s.org_id = n.org_id AND sm.user_id = $2)))`, [org, userId]);
  return sorted(rows.map((row) => row.id as string));
}

async function visibleNow(userId: string): Promise<string[]> {
  const rows = await db.select({ id: notes.id }).from(notes)
    .where(and(eq(notes.org_id, org), eq(notes.is_deleted, false), visibleNoteCondition(userId)));
  return sorted(rows.map((row) => row.id));
}

async function promotableNow(userId: string): Promise<string[]> {
  const rows = await db.select({ id: notes.id }).from(notes)
    .where(and(eq(notes.org_id, org), eq(notes.is_deleted, false), promotableNoteSql(userId)));
  return sorted(rows.map((row) => row.id));
}

test('equivalence: for owners, admins, members and agents without a membership, the note rule is exactly the old one', async () => {
  for (const viewer of NON_GUESTS) {
    const before = await visibleBefore(viewer);
    assert.ok(before.length > matrixIds.length / 3, 'the matrix exercises many notes');
    assert.deepEqual(await visibleNow(viewer), before, `visibleNoteCondition, ${viewer}`);
    assert.deepEqual(await promotableNow(viewer), await promotableBefore(viewer), `promotableNoteSql, ${viewer}`);
  }
});

test('the guest rule only narrows: a guest keeps own, shared and space notes and loses every other org note', async () => {
  const before = new Set(await visibleBefore(guest));
  const now = await visibleNow(guest);
  for (const id of now) assert.ok(before.has(id), 'nothing new becomes visible');
  const seen = new Set(now);
  for (const key of GUEST_SEES) assert.ok(seen.has(noteIds[key]), `guest sees ${key}`);
  for (const key of GUEST_HIDDEN) assert.ok(!seen.has(noteIds[key]), `guest does not see ${key}`);
  const { rows } = await c.query(`SELECT n.id FROM notes n WHERE n.org_id = $1 AND n.is_deleted = false AND (
      n.user_id = $2
      OR EXISTS (SELECT 1 FROM note_shares s WHERE s.note_id = n.id AND s.shared_with_user_id = $2)
      OR (n.visibility = 'space' AND n.visibility_space_id = $3))`, [org, guest, guestRoom]);
  assert.deepEqual(now, sorted(rows.map((row) => row.id as string)), 'exactly own, shared and space notes');
  const promotable = new Set(await promotableNow(guest));
  assert.equal(promotable.has(noteIds.orgNote), false, 'an org note is not promotable by a guest');
  assert.equal(promotable.has(noteIds.spaceIn), true);
  assert.equal(promotable.has(noteIds.guestOwnOrg), true);
});

// ── REST ──────────────────────────────────────────────────────────────────

const sessionRole = (viewer: string) => (viewer === guest ? 'member' : people.find(([id]) => id === viewer)![2] ?? 'member');

function app(viewer: string) {
  const hono = new Hono();
  hono.use('*', async (ctx, next) => {
    ctx.set('user', { id: viewer, org_id: org, email: `gnv-${run}-${viewer}@test.local`, sid: 's', role: sessionRole(viewer) } as never);
    await next();
  });
  hono.route('/api/daily-notes', dailyNoteRoutes);
  hono.route('/api/search', searchRoutes);
  hono.route('/api/tags', tagRoutes);
  hono.route('/api/teams', teamRoutes);
  hono.route('/api', crossReferenceRoutes);
  return hono;
}

async function call(viewer: string, path: string, init?: { method: string; body?: unknown }) {
  const res = await app(viewer).request(path, init ? {
    method: init.method,
    headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  } : undefined);
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, text, body };
}
const get = (viewer: string, path: string) => call(viewer, path);
const names = (text: string, key: NoteKey) => text.includes(noteIds[key]) || text.includes(titleOf(key));
const namedIn = (text: string, keys: NoteKey[]) => keys.filter((key) => names(text, key));

test('GET /api/daily-notes and /:id: a guest lists and reads own, shared and space notes; an org note answers like an unknown id', async () => {
  const list = await get(guest, '/api/daily-notes');
  assert.equal(list.status, 200);
  const listed = new Set((list.body as Array<{ id: string }>).map((row) => row.id));
  for (const key of GUEST_SEES) assert.ok(listed.has(noteIds[key]), `listed: ${key}`);
  for (const key of GUEST_HIDDEN) assert.ok(!listed.has(noteIds[key]), `not listed: ${key}`);
  for (const key of GUEST_SEES) assert.equal((await get(guest, `/api/daily-notes/${noteIds[key]}`)).status, 200, key);
  const unknown = await get(guest, `/api/daily-notes/${randomUUID()}`);
  for (const key of GUEST_HIDDEN) {
    const res = await get(guest, `/api/daily-notes/${noteIds[key]}`);
    assert.equal(res.status, unknown.status, key);
    assert.equal(res.body.code, unknown.body.code, key);
    assert.equal(names(res.text, key), false, key);
  }
  const patch = await call(guest, `/api/daily-notes/${noteIds.orgNote}`, { method: 'PATCH', body: { title: 'x' } });
  assert.equal(patch.status, 404, 'an edit of a hidden note answers like an unknown one');
  const templates = await get(guest, '/api/daily-notes/templates');
  assert.equal(names(templates.text, 'orgTemplate'), false, 'an org template is hidden from a guest');
  assert.equal(names((await get(member, '/api/daily-notes/templates')).text, 'orgTemplate'), true, 'a member keeps it');
});

test('GET /api/daily-notes: owners, admins and members list exactly what they listed before', async () => {
  for (const viewer of [owner, admin, member]) {
    const before = new Set(await visibleBefore(viewer));
    const res = await get(viewer, '/api/daily-notes');
    const listed = (res.body as Array<{ id: string }>).map((row) => row.id).filter((id) => Object.values(noteIds).includes(id));
    const expected = NOT_TEMPLATES.map((key) => noteIds[key]).filter((id) => before.has(id));
    assert.deepEqual(sorted(listed), sorted(expected), viewer);
  }
});

test('GET /api/search: a guest finds no org note; a member now finds a note shared with them', async () => {
  const guestSearch = await get(guest, `/api/search?q=${word}`);
  assert.equal(guestSearch.status, 200);
  assert.deepEqual(namedIn(guestSearch.text, GUEST_HIDDEN), [], 'no hidden note in any group');
  // The quick notes group returns five rows at most; the guest's own notes are among them.
  assert.ok((guestSearch.body.notes as unknown[]).length > 0);
  const memberSearch = await get(member, `/api/search?q=${encodeURIComponent(titleOf('sharedToMember'))}`);
  const found = (memberSearch.body.notes as Array<{ id: string }>).map((row) => row.id);
  assert.ok(found.includes(noteIds.sharedToMember), 'the shared note is in the notes group');
  const admins = await get(admin, `/api/search?q=${encodeURIComponent(titleOf('sharedToMember'))}`);
  assert.equal((admins.body.notes as Array<{ id: string }>).some((row) => row.id === noteIds.sharedToMember), false,
    'an admin it is not shared with still does not find it');
  const orgSearch = await get(admin, `/api/search?q=${encodeURIComponent(titleOf('orgNote'))}`);
  assert.ok((orgSearch.body.notes as Array<{ id: string }>).some((row) => row.id === noteIds.orgNote), 'an admin finds an org note');
});

test('tags, backlinks and team links: a guest sees no hidden note there; members keep theirs', async () => {
  const entities = await get(guest, `/api/tags/${tag}/entities`);
  assert.equal(entities.status, 200);
  assert.deepEqual(namedIn(entities.text, GUEST_HIDDEN), []);
  const ids = new Set((entities.body as Array<{ entity_id: string }>).map((row) => row.entity_id));
  for (const key of GUEST_SEES) assert.ok(ids.has(noteIds[key]), `tagged: ${key}`);
  const tagList = await get(guest, '/api/tags');
  const counted = (tagList.body as Array<{ id: string; count: number }>).find((row) => row.id === tag);
  assert.equal(counted?.count, GUEST_SEES.length, 'the tag count leaves out hidden notes');
  const memberTags = (await get(member, '/api/tags')).body as Array<{ id: string; count: number }>;
  const memberSees = new Set(await visibleBefore(member));
  assert.equal(memberTags.find((row) => row.id === tag)?.count,
    (Object.keys(shapes) as NoteKey[]).filter((key) => memberSees.has(noteIds[key])).length, 'a member count is unchanged');

  const refs = await get(guest, `/api/tasks/${task}/references`);
  assert.equal(refs.status, 200);
  assert.deepEqual(namedIn(refs.text, GUEST_HIDDEN), []);
  for (const key of GUEST_SEES) assert.ok(names(refs.text, key), `backlink: ${key}`);
  const noteRefs = await get(guest, `/api/notes/${noteIds.orgNote}/references`);
  const unknownRefs = await get(guest, `/api/notes/${randomUUID()}/references`);
  assert.equal(noteRefs.status, unknownRefs.status, 'the references of a hidden note answer like an unknown note');

  const teamRes = await get(guest, `/api/teams/${team}`);
  assert.equal(teamRes.status, 200);
  assert.deepEqual(namedIn(JSON.stringify(teamRes.body.resources.map((row: any) => row.label)), GUEST_HIDDEN), [], 'no label of a hidden note');
  const hiddenRow = teamRes.body.resources.find((row: any) => row.resource_id === noteIds.orgNote);
  assert.equal(hiddenRow.access, 'restricted');
  const memberTeam = await get(member, `/api/teams/${team}`);
  assert.equal(memberTeam.body.resources.find((row: any) => row.resource_id === noteIds.orgNote).label, titleOf('orgNote'));
  const link = await call(guest, `/api/teams/${team}/resources`, { method: 'POST', body: { resource_type: 'note', resource_id: noteIds.orgNote } });
  assert.notEqual(link.status, 201, 'a hidden note cannot be linked');

  const context = JSON.stringify(await getTeamContext({ org_id: org, user_id: guest, role: 'member' }, { team_id: team } as never));
  assert.ok(context.includes(noteIds.spaceIn), 'the team context lists the links');
  assert.deepEqual(GUEST_HIDDEN.filter((key) => context.includes(titleOf(key))), [], 'no title or label of a hidden note');
});

// ── MCP, Defty and the shared readers ─────────────────────────────────────

const mcp = (viewer: string): HumanToolContext => ({
  org_id: org,
  user_id: viewer,
  role: sessionRole(viewer) as HumanToolContext['role'],
  scopes: ['read:workspace', 'read:wiki', 'read:tasks', 'read:messages'],
});
const text = (result: { content: Array<{ text: string }> }) => result.content.map((part) => part.text).join('\n');

test('MCP note_list and note_get: a hidden note is unknown to a guest; members unchanged', async () => {
  const list = text(await humanNoteList({ query: word, limit: 100 }, mcp(guest)));
  assert.deepEqual(namedIn(list, GUEST_HIDDEN), []);
  for (const key of GUEST_SEES) assert.ok(names(list, key), `listed: ${key}`);
  const unknown = text(await humanNoteGet({ note_id: randomUUID() }, mcp(guest)));
  for (const key of GUEST_HIDDEN) assert.equal(text(await humanNoteGet({ note_id: noteIds[key] }, mcp(guest))), unknown, key);
  const memberGet = text(await humanNoteGet({ note_id: noteIds.orgNote }, mcp(member)));
  assert.equal(names(memberGet, 'orgNote'), true, 'a member still reads it');
});

test('Defty search_notes and read_note, retrieval and mention display follow the guest rule', async () => {
  const search = JSON.stringify(await executeToolCall('search_notes', { query: word, limit: 50 }, org, guest));
  assert.deepEqual(namedIn(search, GUEST_HIDDEN), []);
  const read = JSON.stringify(await executeToolCall('read_note', { note_id: noteIds.orgNote }, org, guest));
  assert.equal(names(read, 'orgNote'), false);
  assert.ok(names(JSON.stringify(await executeToolCall('read_note', { note_id: noteIds.orgNote }, org, member)), 'orgNote'));

  const retrieved = await retrieveContext({ query: word, org_id: org, user_id: guest, types: ['notes'], limit: 50, hybrid: false });
  assert.deepEqual(namedIn(JSON.stringify(retrieved), GUEST_HIDDEN), []);
  const memberRetrieved = await retrieveContext({ query: titleOf('sharedToMember'), org_id: org, user_id: member, types: ['notes'], limit: 50, hybrid: false });
  assert.ok(memberRetrieved.some((row) => row.source_id === noteIds.sharedToMember), 'retrieval finds a note shared with a member');

  assert.equal(await resolveNativeNoteDisplay({ org_id: org, user_id: guest, role: 'member' } as never, noteIds.orgNote), null);
  assert.notEqual(await resolveNativeNoteDisplay({ org_id: org, user_id: guest, role: 'member' } as never, noteIds.spaceIn), null);
  assert.notEqual(await resolveNativeNoteDisplay({ org_id: org, user_id: member, role: 'member' } as never, noteIds.orgNote), null);
});

test('the export reads the same rule: the condition holds inside a subquery on the bare table', async () => {
  const result = await db.execute(sql`SELECT export_note.id FROM notes export_note
    WHERE export_note.org_id = ${org} AND EXISTS (SELECT 1 FROM notes WHERE notes.id = export_note.id
      AND notes.is_deleted = false AND ${visibleNoteCondition(guest)})`);
  const ids = ((result as any).rows as Array<{ id: string }>).map((row) => row.id);
  assert.deepEqual(sorted(ids), await visibleNow(guest));
});
