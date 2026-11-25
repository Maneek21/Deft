// A guest sees only the tasks of the projects they belong to (a project
// linked to a space they are a member of, archived or not, or one they lead)
// and the tasks that name them (assignee, co-assignee, creator, named
// viewer). Watching does not count: a watch made while every task was open to
// guests keeps nothing visible. Restricted tasks keep their own rule. Owners, admins and
// members are unchanged: the equivalence tests compare the rule before this
// change with the rule now over every task shape, for every non-guest.
//
// The guest's session and MCP token both claim role 'member': only the
// org_members row makes them a guest.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { emitOrgTaskEvent, getIO, setupSocket } from '../src/socket.js';
import { and, eq, sql } from 'drizzle-orm';
import { attentionItems, projects, tasks } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { taskAliasColumns, visibleTaskCondition, visibleTaskSql } from '../src/lib/task-visibility.js';
import { nativeTaskAccessSql } from '../src/lib/native-mention-visibility.js';
import { visibleAttentionCondition } from '../src/lib/attention.js';
import { getVisibleAttachment } from '../src/lib/attachment-access.js';
import { createNotificationIfAllowed, createNotificationsIfAllowed } from '../src/lib/notification-policy.js';
import { taskRoutes } from '../src/routes/tasks.js';
import { workflowRoutes } from '../src/routes/workflows.js';
import { projectRoutes } from '../src/routes/projects.js';
import { searchRoutes } from '../src/routes/search.js';
import { notificationRoutes } from '../src/routes/notifications.js';
import { inboxRoutes } from '../src/routes/inbox.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import {
  humanFetch,
  humanInboxList,
  humanListMyTasks,
  humanProjectProgress,
  humanSearch,
  humanTaskGet,
  humanTaskQuery,
  humanTaskUpdate,
  humanCommentOnTask,
  humanTeamWorkload,
  humanProjectUpdate,
  type HumanToolContext,
} from '../src/lib/mcp-tools/human.js';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
const run = randomUUID().slice(0, 8);
const org = randomUUID();
const owner = randomUUID(), admin = randomUUID(), member = randomUUID(), guest = randomUUID();
// An agent user with no membership row keeps the full view (people-visibility.ts).
const looseAgent = randomUUID();
// [id, name, org role (null: no membership), kind]
const people: Array<[string, string, string | null, 'human' | 'agent']> = [
  [owner, 'Olive Owner', 'owner', 'human'],
  [admin, 'Ada Admin', 'admin', 'human'],
  [member, 'Mo Member', 'member', 'human'],
  [guest, 'Gus Guest', 'guest', 'human'],
  [looseAgent, 'Lou Agent', null, 'agent'],
];
const NON_GUESTS = [owner, admin, member, looseAgent];
const guestRoom = randomUUID(), archivedRoom = randomUUID(), memberRoom = randomUUID();
const pIn = randomUUID(), pArchived = randomUUID(), pLed = randomUUID(), pOut = randomUUID(), pLoose = randomUUID();
const prefix = (n: number) => `T${run.slice(0, 4).toUpperCase()}${n}`;
const projectRows: Array<[string, string, string | null]> = [
  [pIn, prefix(1), null], [pArchived, prefix(2), null], [pLed, prefix(3), guest], [pOut, prefix(4), null], [pLoose, prefix(5), owner],
];
const prefixOf = (projectId: string) => projectRows.find(([id]) => id === projectId)![1];

type Shape = { project: string; assignee?: string; createdBy?: string; restricted?: boolean; named?: string[]; watcher?: string; coAssignee?: string };
const shapes = {
  inOrg: { project: pIn },
  archivedOrg: { project: pArchived },
  ledOrg: { project: pLed },
  outOrg: { project: pOut, assignee: member },
  outAssigned: { project: pOut, assignee: guest },
  outCoAssigned: { project: pOut, coAssignee: guest },
  outWatched: { project: pOut, watcher: guest },
  outCreated: { project: pOut, createdBy: guest },
  outNamed: { project: pOut, named: [guest] },
  restrictedIn: { project: pIn, restricted: true, named: [member], assignee: member },
  restrictedNamed: { project: pOut, restricted: true, named: [guest] },
  // Restricted, in the guest's project, watched by the guest: watching never counts for a guest.
  restrictedInWatched: { project: pIn, restricted: true, watcher: guest },
  looseOrg: { project: pLoose },
} satisfies Record<string, Shape>;
type TaskKey = keyof typeof shapes;
const taskIds = Object.fromEntries(Object.keys(shapes).map((key) => [key, randomUUID()])) as Record<TaskKey, string>;
const numberOf: Record<string, number> = {};
const titleOf = (key: string) => `gtv-${run}-${key}`;
const GUEST_SEES: TaskKey[] = ['inOrg', 'archivedOrg', 'ledOrg', 'outAssigned', 'outCoAssigned', 'outCreated', 'outNamed', 'restrictedNamed'];
// outWatched: a guest's watch on a task outside their projects (one made before this rule) grants nothing.
const GUEST_HIDDEN: TaskKey[] = ['outOrg', 'restrictedIn', 'looseOrg', 'outWatched', 'restrictedInWatched'];
const fileIn = randomUUID(), fileOut = randomUUID();
const commentText = `gtv-${run}-secret-comment`;
// Extra tasks with every combination of relations, for the equivalence tests.
const matrixIds: string[] = [];

async function insertTask(id: string, key: string, shape: Shape, number: number) {
  const metadata = shape.restricted || shape.named
    ? { ...(shape.restricted ? { visibility: 'restricted' } : {}), ...(shape.named ? { visible_user_ids: shape.named } : {}) }
    : null;
  await c.query(`INSERT INTO tasks (id, org_id, project_id, number, title, description, created_by, assignee_id, metadata, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'todo')`,
  [id, org, shape.project, number, titleOf(key), `${titleOf(key)} description`, shape.createdBy ?? member, shape.assignee ?? null,
    metadata === null ? null : JSON.stringify(metadata)]);
  if (shape.watcher) await c.query(`INSERT INTO task_watchers (id, task_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [id, shape.watcher]);
  if (shape.coAssignee) await c.query(`INSERT INTO task_assignees (id, task_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [id, shape.coAssignee]);
}

before(async () => {
  await c.connect();
  await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Guest Tasks', $2)`, [org, `guest-tasks-${run}`]);
  for (const [id, name, role, kind] of people) {
    await c.query(`INSERT INTO users (id, email, name, kind, is_agent, password_hash) VALUES ($1, $2, $3, $4, $5, 'hash')`,
      [id, `gtv-${run}-${id}@test.local`, `${name} ${run}`, kind, kind === 'agent']);
    if (role) {
      await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, true)`, [org, id, role]);
    }
  }
  await c.query(`INSERT INTO spaces (id, org_id, name, type, created_by, is_archived) VALUES
      ($1, $4, 'gtv guest room', 'private', $5, false), ($2, $4, 'gtv archived room', 'private', $5, true),
      ($3, $4, 'gtv member room', 'public', $5, false)`, [guestRoom, archivedRoom, memberRoom, org, owner]);
  for (const [room, user] of [
    [guestRoom, guest], [guestRoom, member], [guestRoom, owner],
    [archivedRoom, guest], [archivedRoom, member],
    [memberRoom, member], [memberRoom, owner], [memberRoom, admin],
  ]) {
    await c.query(`INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [room, user]);
  }
  for (const [id, pre, lead] of projectRows) {
    await c.query(`INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES ($1, $2, $3, $4, $5, 1000)`,
      [id, org, `gtv ${pre}`, pre, lead]);
  }
  for (const [project, room] of [[pIn, guestRoom], [pArchived, archivedRoom], [pOut, memberRoom]]) {
    await c.query(`INSERT INTO project_spaces (id, project_id, space_id) VALUES (gen_random_uuid()::text, $1, $2)`, [project, room]);
  }
  let number = 1;
  for (const [key, shape] of Object.entries(shapes) as Array<[TaskKey, Shape]>) {
    numberOf[key] = number;
    await insertTask(taskIds[key], key, shape, number++);
  }
  // Every combination of project, restriction and relation, for each person.
  const relations: Array<keyof Shape | 'none'> = ['none', 'assignee', 'createdBy', 'named', 'watcher', 'coAssignee'];
  for (const [project] of projectRows) {
    for (const restricted of [false, true]) {
      for (const relation of relations) {
        for (const [person] of people) {
          if (relation === 'none' && person !== owner) continue;
          const shape: Shape = { project, restricted };
          if (relation === 'assignee') shape.assignee = person;
          if (relation === 'createdBy') shape.createdBy = person;
          if (relation === 'named') shape.named = [person];
          if (relation === 'watcher') shape.watcher = person;
          if (relation === 'coAssignee') shape.coAssignee = person;
          const id = randomUUID();
          matrixIds.push(id);
          await insertTask(id, `matrix-${matrixIds.length}`, shape, number++);
        }
      }
    }
  }
  await c.query(`INSERT INTO task_comments (id, org_id, task_id, user_id, content) VALUES (gen_random_uuid()::text, $1, $2, $3, $4)`,
    [org, taskIds.outOrg, member, commentText]);
  await c.query(`INSERT INTO task_activity (id, org_id, task_id, user_id, action, field, old_value, new_value)
    VALUES (gen_random_uuid()::text, $1, $2, $3, 'status_changed', 'status', 'backlog', 'todo')`, [org, taskIds.outOrg, member]);
  for (const [file, key] of [[fileIn, 'inOrg'], [fileOut, 'outOrg']] as const) {
    await c.query(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key, processing_status, task_id)
      VALUES ($1, $2, $3, $4, 'text/plain', 5, $5, 'ready', $6)`, [file, org, member, `${titleOf(key)}.txt`, `gtv/${file}`, taskIds[key]]);
    await c.query(`INSERT INTO task_attachments (org_id, task_id, file_id, position) VALUES ($1, $2, $3, 0)`, [org, taskIds[key], file]);
  }
});

after(async () => {
  const all = people.map(([id]) => id);
  await c.query(`DELETE FROM attention_events WHERE org_id = $1`, [org]).catch(() => {});
  await c.query(`DELETE FROM attention_items WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM notifications WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM job_queue WHERE org_id = $1`, [org]).catch(() => {});
  await c.query(`DELETE FROM idempotency_keys WHERE user_id = ANY($1::text[])`, [people.map(([id]) => id)]).catch(() => {});
  await c.query(`DELETE FROM workflow_rules WHERE org_id = $1`, [org]).catch(() => {});
  await c.query(`DELETE FROM task_attachments WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM files WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM task_comments WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM task_activity WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM task_watchers WHERE task_id IN (SELECT id FROM tasks WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM task_assignees WHERE task_id IN (SELECT id FROM tasks WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM task_labels WHERE task_id IN (SELECT id FROM tasks WHERE org_id = $1)`, [org]).catch(() => {});
  await c.query(`DELETE FROM tasks WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM project_spaces WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM projects WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM spaces WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM org_members WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [all]);
  await c.query(`DELETE FROM orgs WHERE id = $1`, [org]);
  await c.end();
});

const sorted = (list: Iterable<string>) => [...list].sort();
const idsOf = (keys: TaskKey[]) => sorted(keys.map((key) => taskIds[key]));
const ALL_NAMED = Object.keys(shapes) as TaskKey[];

/** The restricted-task rule exactly as it was before the guest rule (task-visibility.ts on master). */
async function visibleBefore(userId: string): Promise<string[]> {
  const { rows } = await c.query(`SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.org_id = $1 AND t.is_deleted = false AND (
      coalesce(t.metadata->>'visibility', 'org') != 'restricted'
      OR t.assignee_id = $2 OR t.created_by = $2 OR p.lead_id = $2
      OR coalesce(t.metadata->'visible_user_ids', '[]'::jsonb) ? $2
      OR EXISTS (SELECT 1 FROM task_watchers w WHERE w.task_id = t.id AND w.user_id = $2)
      OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = $2))`, [org, userId]);
  return sorted(rows.map((row) => row.id as string));
}

/** nativeTaskAccessSql as it was before (mentions: watchers do not count). */
async function mentionAccessBefore(userId: string): Promise<string[]> {
  const { rows } = await c.query(`SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.org_id = $1 AND t.is_deleted = false AND (
      coalesce(t.metadata->>'visibility', 'org') <> 'restricted'
      OR t.created_by = $2 OR t.assignee_id = $2 OR p.lead_id = $2
      OR coalesce(t.metadata->'visible_user_ids', '[]'::jsonb) ? $2
      OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $2))`, [org, userId]);
  return sorted(rows.map((row) => row.id as string));
}

async function visibleNow(userId: string): Promise<string[]> {
  const rows = await db.select({ id: tasks.id }).from(tasks).innerJoin(projects, eq(projects.id, tasks.project_id))
    .where(and(eq(tasks.org_id, org), eq(tasks.is_deleted, false), visibleTaskCondition(userId)));
  return sorted(rows.map((row) => row.id));
}

async function visibleNowAliased(userId: string): Promise<string[]> {
  const result = await db.execute(sql`SELECT t.id FROM tasks t
    WHERE t.org_id = ${org} AND t.is_deleted = false AND ${visibleTaskSql(userId, taskAliasColumns('t'))}`);
  return sorted(((result as any).rows as Array<{ id: string }>).map((row) => row.id));
}

async function mentionAccessNow(userId: string): Promise<string[]> {
  const result = await db.execute(sql`SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.org_id = ${org} AND t.is_deleted = false AND ${nativeTaskAccessSql(userId)}`);
  return sorted(((result as any).rows as Array<{ id: string }>).map((row) => row.id));
}

test('equivalence: for owners, admins, members and agents without a membership, the rule is exactly the old one', async () => {
  for (const viewer of NON_GUESTS) {
    const before = await visibleBefore(viewer);
    assert.ok(before.length > matrixIds.length / 2, 'the matrix exercises many tasks');
    assert.deepEqual(await visibleNow(viewer), before, `visibleTaskCondition, ${viewer}`);
    assert.deepEqual(await visibleNowAliased(viewer), before, `visibleTaskSql, ${viewer}`);
    assert.deepEqual(await mentionAccessNow(viewer), await mentionAccessBefore(viewer), `nativeTaskAccessSql, ${viewer}`);
  }
});

test('the guest rule only narrows: a guest sees a subset of the old rule, and every task of their projects or naming them', async () => {
  const before = new Set(await visibleBefore(guest));
  const now = await visibleNow(guest);
  for (const id of now) assert.ok(before.has(id), 'nothing new becomes visible');
  assert.deepEqual(await visibleNowAliased(guest), now, 'both forms agree');
  const named = new Set(now);
  for (const key of GUEST_SEES) assert.ok(named.has(taskIds[key]), `guest sees ${key}`);
  for (const key of GUEST_HIDDEN) assert.ok(!named.has(taskIds[key]), `guest does not see ${key}`);
  // In the matrix: every task the guest sees is in one of their projects or names them.
  const { rows } = await c.query(`SELECT t.id FROM tasks t WHERE t.id = ANY($1::text[]) AND (
      (t.project_id IN ($2, $3) AND coalesce(t.metadata->>'visibility', 'org') != 'restricted')
      OR t.project_id = $4 OR t.assignee_id = $5 OR t.created_by = $5
      OR coalesce(t.metadata->'visible_user_ids', '[]'::jsonb) ? $5
      OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = $5))`,
  [matrixIds, pIn, pArchived, pLed, guest]);
  const allowed = new Set(rows.map((row) => row.id as string));
  const matrixSeen = now.filter((id) => matrixIds.includes(id));
  assert.deepEqual(sorted(matrixSeen), sorted([...allowed].filter((id) => before.has(id))));
  // A guest of the mention surfaces also loses org tasks outside their projects.
  const mention = new Set(await mentionAccessNow(guest));
  assert.equal(mention.has(taskIds.outOrg), false);
  assert.equal(mention.has(taskIds.looseOrg), false, 'an unassigned task');
  assert.equal(mention.has(taskIds.inOrg), true);
});

// ── REST ──────────────────────────────────────────────────────────────────

const sessionRole = (viewer: string) => (viewer === guest ? 'member' : people.find(([id]) => id === viewer)![2] ?? 'member');

function app(viewer: string) {
  const hono = new Hono();
  hono.use('*', async (ctx, next) => {
    ctx.set('user', { id: viewer, org_id: org, email: `gtv-${run}-${viewer}@test.local`, sid: 's', role: sessionRole(viewer) } as never);
    await next();
  });
  hono.route('/api/tasks', taskRoutes);
  hono.route('/api/projects', projectRoutes);
  hono.route('/api/search', searchRoutes);
  hono.route('/api/notifications', notificationRoutes);
  hono.route('/api/inbox', inboxRoutes);
  hono.route('/api/workflows', workflowRoutes);
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
const mentions = (text: string, key: TaskKey) => text.includes(taskIds[key]) || text.includes(titleOf(key));

test('GET /api/tasks/:id: a guest reads the tasks of their projects and those naming them; any other answers like an unknown id', async () => {
  for (const key of GUEST_SEES) {
    const res = await get(guest, `/api/tasks/${taskIds[key]}`);
    assert.equal(res.status, 200, key);
  }
  const unknown = await get(guest, `/api/tasks/${randomUUID()}`);
  for (const key of GUEST_HIDDEN) {
    const res = await get(guest, `/api/tasks/${taskIds[key]}`);
    assert.equal(res.status, unknown.status, key);
    assert.equal(res.body.code, unknown.body.code, key);
    assert.equal(mentions(res.text, key), false, `${key}: nothing of the task in the refusal`);
  }
});

test('GET /api/tasks/:id: owners, admins and members read exactly what they read before', async () => {
  for (const viewer of [owner, admin, member]) {
    const before = new Set(await visibleBefore(viewer));
    for (const key of ALL_NAMED) {
      const res = await get(viewer, `/api/tasks/${taskIds[key]}`);
      assert.equal(res.status, before.has(taskIds[key]) ? 200 : 404, `${viewer} ${key}`);
    }
  }
});

test('task comments, activity, attachments, watchers, dependencies and subtree of a hidden task answer like an unknown task', async () => {
  for (const suffix of ['comments', 'activity', 'attachments', 'watchers', 'assignees', 'dependencies', 'subtree', 'reactions', 'wiki-links']) {
    const hidden = await get(guest, `/api/tasks/${taskIds.outOrg}/${suffix}`);
    const unknown = await get(guest, `/api/tasks/${randomUUID()}/${suffix}`);
    assert.equal(hidden.status, unknown.status, suffix);
    assert.equal(hidden.text.includes(commentText), false, suffix);
    assert.equal(mentions(hidden.text, 'outOrg'), false, suffix);
    const visible = await get(member, `/api/tasks/${taskIds.outOrg}/${suffix}`);
    assert.equal(visible.status, 200, `member ${suffix}`);
  }
  const comments = await get(member, `/api/tasks/${taskIds.outOrg}/comments`);
  assert.ok(comments.text.includes(commentText), 'the member still reads the comment');
  const attachments = await get(guest, `/api/tasks/${taskIds.inOrg}/attachments`);
  assert.equal(attachments.status, 200);
  assert.ok(attachments.text.includes(fileIn), 'the guest lists the files of a task in their project');
});

test('writes to a hidden task by a guest are refused like an unknown task', async () => {
  const attempts: Array<[string, string, unknown]> = [
    ['PATCH', '', { title: 'guest edit' }],
    ['POST', '/comments', { content: 'guest comment' }],
    ['POST', '/watch', undefined],
    ['POST', '/reactions', { emoji: '👍' }],
    ['POST', '/dependencies', { target_task_id: taskIds.inOrg, type: 'relates_to' }],
    ['POST', '/duplicate', undefined],
    ['DELETE', '', undefined],
  ];
  for (const [method, suffix, body] of attempts) {
    const hidden = await call(guest, `/api/tasks/${taskIds.outOrg}${suffix}`, { method, body });
    const unknown = await call(guest, `/api/tasks/${randomUUID()}${suffix}`, { method, body });
    assert.equal(hidden.status, unknown.status, `${method} ${suffix}`);
    assert.equal(mentions(hidden.text, 'outOrg'), false, `${method} ${suffix}`);
  }
  // A dependency from a visible task to a hidden one is refused too.
  const dependency = await call(guest, `/api/tasks/${taskIds.inOrg}/dependencies`, {
    method: 'POST', body: { target_task_id: taskIds.outOrg, type: 'relates_to' },
  });
  assert.notEqual(dependency.status, 201);
  assert.notEqual(dependency.status, 200);
  const { rows } = await c.query(`SELECT title FROM tasks WHERE id = $1`, [taskIds.outOrg]);
  assert.equal(rows[0].title, titleOf('outOrg'), 'the hidden task is unchanged');
  const { rows: commentRows } = await c.query(`SELECT count(*)::int AS n FROM task_comments WHERE task_id = $1`, [taskIds.outOrg]);
  assert.equal(commentRows[0].n, 1, 'no comment was added');
});

test('task lists, search, table, boards and project counts leave out hidden tasks for a guest only', async () => {
  const paths = [
    '/api/tasks/my',
    `/api/tasks/search?q=${encodeURIComponent(`gtv-${run}`)}`,
    `/api/tasks/table?project_id=${pOut}`,
    `/api/tasks/project/${pOut}`,
    `/api/projects/${pOut}/tasks`,
    `/api/search?q=${encodeURIComponent(`gtv-${run}`)}`,
  ];
  for (const path of paths) {
    const res = await get(guest, path);
    assert.equal(res.status, 200, path);
    for (const key of GUEST_HIDDEN) assert.equal(mentions(res.text, key), false, `${path}: ${key}`);
  }
  const board = await get(guest, `/api/tasks/project/${pOut}`);
  assert.ok(mentions(board.text, 'outAssigned'), 'a task naming the guest stays on the board');
  for (const path of [`/api/tasks/project/${pOut}`, `/api/projects/${pOut}/tasks`, `/api/tasks/table?project_id=${pOut}`]) {
    const res = await get(member, path);
    assert.ok(mentions(res.text, 'outOrg'), `member ${path}`);
  }
  const projectsForGuest = await get(guest, '/api/projects');
  const outCount = projectsForGuest.body.find((row: any) => row.id === pOut);
  const ownerCount = (await get(owner, '/api/projects')).body.find((row: any) => row.id === pOut);
  const before = new Set(await visibleBefore(owner));
  const { rows } = await c.query(`SELECT id FROM tasks WHERE project_id = $1`, [pOut]);
  assert.equal(ownerCount.total_tasks, rows.filter((row) => before.has(row.id)).length, 'owner count unchanged');
  const guestNow = new Set(await visibleNow(guest));
  assert.equal(outCount.total_tasks, rows.filter((row) => guestNow.has(row.id)).length, 'guest count only of tasks they see');
  assert.ok(outCount.total_tasks < ownerCount.total_tasks);
});

test('a guest cannot make themselves a project lead to read its tasks; members still change leads', async () => {
  const refused = await call(guest, `/api/projects/${pOut}`, { method: 'PATCH', body: { lead_id: guest } });
  assert.equal(refused.status, 403);
  assert.equal(mentions(refused.text, 'outOrg'), false);
  const viaMcp = await humanProjectUpdate({ project_id: pOut, lead_id: guest },
    { ...mcp(guest), scopes: ['read:workspace', 'write:workspace'] });
  assert.equal(viaMcp.isError, true);
  const { rows } = await c.query(`SELECT lead_id FROM projects WHERE id = $1`, [pOut]);
  assert.equal(rows[0].lead_id, null, 'the lead is unchanged');
  assert.equal((await get(guest, `/api/tasks/${taskIds.outOrg}`)).status, 404, 'the task stays hidden');
  // A guest may still rename a project, as before; only the lead is refused.
  const renamed = await call(guest, `/api/projects/${pOut}`, { method: 'PATCH', body: { color: '#123456' } });
  assert.equal(renamed.status, 200);
  const byMember = await call(member, `/api/projects/${pOut}`, { method: 'PATCH', body: { lead_id: member } });
  assert.equal(byMember.status, 200, 'a member still changes the lead');
  await c.query(`UPDATE projects SET lead_id = NULL, color = NULL WHERE id = $1`, [pOut]);
});

test('on the board of a project they belong to, a guest sees no restricted task that does not name them', async () => {
  const board = await get(guest, `/api/tasks/project/${pIn}`);
  assert.equal(board.status, 200);
  assert.ok(mentions(board.text, 'inOrg'));
  assert.equal(mentions(board.text, 'restrictedIn'), false);
  for (const path of ['/api/tasks/templates', `/api/projects/${pIn}/tasks`, `/api/tasks/table?project_id=${pIn}`]) {
    assert.equal(mentions((await get(guest, path)).text, 'restrictedIn'), false, path);
  }
});

test('a guest cannot write workflow rules (a rule could assign them a hidden task); members still can', async () => {
  const rule = {
    name: 'gtv rule', trigger_type: 'task.status_changed', trigger_config: { to_status: 'done' },
    action_type: 'assign_to', action_config: { user_id: guest },
  };
  assert.equal((await call(guest, '/api/workflows', { method: 'POST', body: rule })).status, 403);
  const created = await call(member, '/api/workflows', { method: 'POST', body: rule });
  assert.equal(created.status, 201);
  assert.equal((await call(guest, `/api/workflows/${created.body.id}`, { method: 'PATCH', body: { name: 'x' } })).status, 403);
  assert.equal((await call(guest, `/api/workflows/${created.body.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await call(member, `/api/workflows/${created.body.id}`, { method: 'DELETE' })).status, 200);
});

test('a subtask parent must be a task the caller may see: hidden, missing and foreign parents answer alike', async () => {
  const subtask = (parent: string) => call(guest, `/api/tasks/project/${pIn}`, {
    method: 'POST', body: { title: `gtv-${run}-sub`, parent_task_id: parent },
  });
  const hidden = await subtask(taskIds.outOrg);
  const missing = await subtask(randomUUID());
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.body, missing.body);
  assert.equal(mentions(hidden.text, 'outOrg'), false);
  const visible = await subtask(taskIds.inOrg);
  assert.equal(visible.status, 201, visible.text);
  await c.query(`DELETE FROM task_activity WHERE task_id = $1`, [visible.body.id]);
  await c.query(`DELETE FROM tasks WHERE id = $1`, [visible.body.id]);

  // A task the guest sees whose parent is hidden from them names no parent, not even by id.
  const child = randomUUID();
  await c.query(`INSERT INTO tasks (id, org_id, project_id, number, title, created_by, parent_task_id, assignee_id)
    VALUES ($1, $2, $3, 9000, $4, $5, $6, $7)`, [child, org, pIn, `gtv-${run}-child`, member, taskIds.outOrg, guest]);
  try {
    const forGuest = await get(guest, `/api/tasks/${child}`);
    assert.equal(forGuest.status, 200);
    assert.equal(forGuest.body.parent_task_id, null);
    assert.equal(forGuest.body.parent_task, null);
    assert.equal(mentions(forGuest.text, 'outOrg'), false);
    const forMember = await get(member, `/api/tasks/${child}`);
    assert.equal(forMember.body.parent_task_id, taskIds.outOrg, 'members unchanged');
    const viaMcp = JSON.parse(text(await humanTaskGet({ task_id: child }, mcp(guest))));
    assert.equal(viaMcp.task.parent_task_id, null, 'MCP task_get');
    assert.equal(JSON.parse(text(await humanTaskGet({ task_id: child }, mcp(member)))).task.parent_task_id, taskIds.outOrg);
    const mine = JSON.parse(text(await humanListMyTasks({ include_completed: true, limit: 50 }, mcp(guest)))) as Array<{ id: string; parent_task_id: string | null }>;
    assert.equal(mine.find((row) => row.id === child)?.parent_task_id, null, 'MCP list_my_tasks');
    // Subtree of a visible task through a hidden middle task: the visible grandchild names no hidden parent.
    await c.query(`UPDATE tasks SET parent_task_id = $1 WHERE id = $2`, [taskIds.inOrg, taskIds.outOrg]);
    await c.query(`UPDATE tasks SET parent_task_id = $1 WHERE id = $2`, [taskIds.outOrg, child]);
    const tree = await get(guest, `/api/tasks/${taskIds.inOrg}/subtree`);
    assert.equal(tree.status, 200);
    assert.equal(mentions(tree.text, 'outOrg'), false, 'the hidden middle task is not named');
    const placed = tree.body.subtasks.find((row: any) => row.id === child);
    assert.equal(placed.parent_task_id, taskIds.inOrg, 'hangs from the root');
    assert.equal(placed.depth, 0, 'no hidden level is counted');
    const memberTree = await get(member, `/api/tasks/${taskIds.inOrg}/subtree`);
    assert.ok(mentions(memberTree.text, 'outOrg'), 'members unchanged');
  } finally {
    await c.query(`UPDATE tasks SET parent_task_id = NULL WHERE id = $1`, [taskIds.outOrg]);
    await c.query(`DELETE FROM tasks WHERE id = $1`, [child]);
  }
});

test('task files: a guest downloads a file of a task in their project, never one of a hidden task', async () => {
  assert.ok(await getVisibleAttachment(fileIn, org, guest), 'guest, task in their project');
  assert.equal(await getVisibleAttachment(fileOut, org, guest), null, 'guest, org task outside their projects');
  for (const viewer of [owner, admin, member]) {
    assert.ok(await getVisibleAttachment(fileIn, org, viewer), viewer);
    assert.ok(await getVisibleAttachment(fileOut, org, viewer), viewer);
  }
});

// ── MCP and Defty ─────────────────────────────────────────────────────────

const mcp = (viewer: string, write = false): HumanToolContext => ({
  org_id: org,
  user_id: viewer,
  role: sessionRole(viewer) as HumanToolContext['role'],
  scopes: ['read:workspace', 'read:tasks', 'read:messages', ...(write ? ['write:tasks'] : [])],
});
const text = (result: { content: Array<{ text: string }> }) => result.content.map((part) => part.text).join('\n');

test('MCP task tools: hidden tasks are unknown to a guest; members unchanged', async () => {
  for (const key of GUEST_HIDDEN) {
    const hidden = await humanTaskGet({ task_id: taskIds[key] }, mcp(guest));
    const unknown = await humanTaskGet({ task_id: randomUUID() }, mcp(guest));
    assert.equal(hidden.isError, unknown.isError, key);
    assert.equal(mentions(text(hidden), key), false, key);
  }
  for (const key of GUEST_SEES) {
    assert.notEqual((await humanTaskGet({ task_id: taskIds[key] }, mcp(guest))).isError, true, key);
  }
  assert.notEqual((await humanTaskGet({ task_id: taskIds.outOrg }, mcp(member))).isError, true);

  const lists = [
    (viewer: string) => humanListMyTasks({ include_completed: true, limit: 100 }, mcp(viewer)),
    (viewer: string) => humanTaskQuery({ query: `gtv-${run}`, limit: 100 } as never, mcp(viewer)),
    (viewer: string) => humanTaskQuery({ filter: { project_id: pOut }, limit: 100 } as never, mcp(viewer)),
    (viewer: string) => humanSearch({ query: `gtv-${run}`, limit: 50 }, mcp(viewer)),
    (viewer: string) => humanFetch({ id: `task:${taskIds.outOrg}` }, mcp(viewer)),
  ];
  for (const [index, list] of lists.entries()) {
    const forGuest = text(await list(guest));
    for (const key of GUEST_HIDDEN) assert.equal(mentions(forGuest, key), false, `list ${index}: ${key}`);
  }
  assert.ok(mentions(text(await lists[2]!(member)), 'outOrg'), 'member task_query still sees the project task');

  const progress = JSON.parse(text(await humanProjectProgress({ project_id: pOut } as never, mcp(guest))));
  const memberProgress = JSON.parse(text(await humanProjectProgress({ project_id: pOut } as never, mcp(member))));
  assert.ok(JSON.stringify(progress) !== JSON.stringify(memberProgress), 'project progress counts only what the guest sees');
  const workload = text(await humanTeamWorkload({}, mcp(guest)));
  assert.ok(!workload.includes(titleOf('outOrg')));

  const update = await humanTaskUpdate({ task_id: taskIds.outOrg, patch: { priority: 'p0' } }, mcp(guest, true));
  assert.equal(update.isError, true);
  assert.equal(mentions(text(update), 'outOrg'), false);
  const comment = await humanCommentOnTask({ task_id: taskIds.outOrg, content: 'guest via mcp' }, mcp(guest, true));
  assert.equal(comment.isError, true);
  const { rows } = await c.query(`SELECT priority FROM tasks WHERE id = $1`, [taskIds.outOrg]);
  assert.notEqual(rows[0].priority, 'p0');
});

test("Defty's task tools leave out tasks hidden from a guest", async () => {
  const search = JSON.stringify(await executeToolCall('search_tasks', { query: `gtv-${run}` }, org, guest));
  for (const key of GUEST_HIDDEN) assert.equal(search.includes(titleOf(key)), false, `search_tasks ${key}`);
  const ref = `${prefixOf(pOut)}-${numberOf.outOrg}`;
  const detail = JSON.stringify(await executeToolCall('get_task_detail', { task_identifier: ref }, org, guest));
  assert.equal(detail.includes(titleOf('outOrg')), false, 'get_task_detail by reference');
  const byId = JSON.stringify(await executeToolCall('get_task_detail', { task_identifier: taskIds.outOrg }, org, guest));
  assert.equal(byId.includes(titleOf('outOrg')), false, 'get_task_detail by id');
  const memberDetail = JSON.stringify(await executeToolCall('get_task_detail', { task_identifier: ref }, org, member));
  assert.ok(memberDetail.includes(titleOf('outOrg')), 'a member still gets the detail');
  const mine = JSON.stringify(await executeToolCall('list_my_tasks', {}, org, guest));
  assert.equal(mine.includes(titleOf('outOrg')), false);
});

// ── Notifications, Inbox and attention ────────────────────────────────────

test('a notification naming a hidden task is not created for a guest, and an old one is not shown', async () => {
  const notice = (userId: string, key: TaskKey, how: 'metadata' | 'link') => ({
    org_id: org,
    user_id: userId,
    type: 'mention' as const,
    title: `about ${titleOf(key)}`,
    link: how === 'link' ? `/tasks?task=${prefixOf(shapes[key].project)}-${numberOf[key]}` : null,
    metadata: how === 'metadata' ? { task_id: taskIds[key] } : {},
  });
  for (const how of ['metadata', 'link'] as const) {
    assert.equal(await createNotificationIfAllowed(notice(guest, 'outOrg', how), { bypassUserPreferences: true }), null, `hidden, ${how}`);
    // An unassigned task: the rule must not treat a NULL assignee as "unknown".
    assert.equal(await createNotificationIfAllowed(notice(guest, 'looseOrg', how), { bypassUserPreferences: true }), null, `hidden unassigned, ${how}`);
    assert.ok(await createNotificationIfAllowed(notice(guest, 'inOrg', how), { bypassUserPreferences: true }), `visible, ${how}`);
    assert.ok(await createNotificationIfAllowed(notice(member, 'outOrg', how), { bypassUserPreferences: true }), `member, ${how}`);
  }
  const batch = await createNotificationsIfAllowed([notice(guest, 'outOrg', 'metadata'), notice(guest, 'outAssigned', 'metadata'), notice(admin, 'outOrg', 'metadata')], { bypassUserPreferences: true });
  assert.deepEqual(sorted(batch.map((row) => `${row.user_id}:${(row.metadata as any).task_id}`)),
    sorted([`${guest}:${taskIds.outAssigned}`, `${admin}:${taskIds.outOrg}`]));

  // Rows written before this rule (or by a direct insert) are filtered when read.
  const oldNotice = randomUUID(), oldLinkNotice = randomUUID();
  await c.query(`INSERT INTO notifications (id, org_id, user_id, type, title, metadata, link) VALUES
      ($1, $3, $4, 'task_updated', $5, $6, NULL), ($2, $3, $4, 'task_assigned', $5, '{}', $7)`,
  [oldNotice, oldLinkNotice, org, guest, `old ${titleOf('outOrg')}`, JSON.stringify({ task_id: taskIds.outOrg }),
    `/tasks?task=${prefixOf(pOut)}-${numberOf.outOrg}`]);
  for (const path of ['/api/notifications', '/api/inbox', '/api/inbox?count_only=1']) {
    const res = await get(guest, path);
    assert.equal(res.status, 200, path);
    assert.equal(res.text.includes(titleOf('outOrg')), false, path);
  }
  const inbox = await get(guest, '/api/inbox');
  assert.ok(inbox.text.includes(`about ${titleOf('inOrg')}`), 'a notice of a visible task is still listed');
  assert.equal(text(await humanInboxList({ limit: 100 }, mcp(guest))).includes(titleOf('outOrg')), false, 'MCP inbox_list');
  const memberInbox = await get(member, '/api/notifications');
  assert.ok(memberInbox.text.includes(`about ${titleOf('outOrg')}`), 'members still get theirs');
  // An old blocked alert about a task the guest sees, listing a blocking task hidden from them.
  await c.query(`INSERT INTO notifications (id, org_id, user_id, type, title, metadata) VALUES ($1, $2, $3, 'agent_suggestion', $4, $5)`,
    [randomUUID(), org, guest, `gtv-${run}-old-blocked-alert`, JSON.stringify({ task_id: taskIds.inOrg, nudge_type: 'blocked', blocking_deps: [taskIds.outOrg] })]);
  assert.equal((await get(guest, '/api/notifications')).text.includes(`gtv-${run}-old-blocked-alert`), false, 'blocking_deps');
});

test('an attention item about a hidden task is not shown to a guest; members unchanged', async () => {
  const item = async (userId: string, key: TaskKey) => {
    const id = randomUUID();
    await c.query(`INSERT INTO attention_items (id, org_id, user_id, kind, lane, dedupe_key, source_type, source_id, title)
      VALUES ($1, $2, $3, 'task_update', 'needs_you', $1, 'task', $4, $5)`, [id, org, userId, taskIds[key], `item ${titleOf(key)}`]);
    return id;
  };
  const hidden = await item(guest, 'outOrg');
  const hiddenUnassigned = await item(guest, 'looseOrg');
  const shown = await item(guest, 'inOrg');
  const memberItem = await item(member, 'outOrg');
  // An agent's request for help names its task in metadata (mcp-tools/cooperative.ts).
  const helpItem = randomUUID();
  await c.query(`INSERT INTO attention_items (id, org_id, user_id, kind, lane, dedupe_key, source_type, source_id, title, metadata)
    VALUES ($1, $2, $3, 'agent_assistance', 'needs_you', $1, 'agent_channel_event', $4, 'needs help', $5)`,
  [helpItem, org, guest, randomUUID(), JSON.stringify({ task_id: taskIds.looseOrg })]);
  const visible = async (userId: string) => sorted((await db.select({ id: attentionItems.id }).from(attentionItems)
    .where(and(eq(attentionItems.org_id, org), eq(attentionItems.user_id, userId), visibleAttentionCondition(userId, 'all'))))
    .map((row) => row.id));
  const forGuest = await visible(guest);
  assert.equal(forGuest.includes(hidden), false);
  assert.equal(forGuest.includes(hiddenUnassigned), false, 'an unassigned hidden task');
  assert.equal(forGuest.includes(helpItem), false, 'a help request about a hidden task');
  assert.equal(forGuest.includes(shown), true);
  assert.deepEqual(await visible(member), [memberItem]);
  const narrowed = sorted((await db.select({ id: attentionItems.id }).from(attentionItems)
    .where(and(eq(attentionItems.org_id, org), eq(attentionItems.user_id, guest), visibleAttentionCondition(guest, ['task']))))
    .map((row) => row.id));
  assert.equal(narrowed.includes(hidden), false, 'narrowed to its type');
});

// ── Live task events ──────────────────────────────────────────────────────

const { io: connectSocket } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');

test('live task events: a guest gets them only for tasks they see; members get every one, as before', async () => {
  const roleOf = (id: string) => people.find(([pid]) => pid === id)![2] ?? 'member';
  const server = createServer();
  const sockets = setupSocket(server, {
    verifyAccess: async (token: string) => ({ id: token, org_id: org, email: `${token}@test.local`, sid: `gtv-${token}`, exp: Math.floor(Date.now() / 1000) + 600 }) as any,
    requireMembership: async (_orgId: string, userId: string) => ({ role: roleOf(userId) }) as any,
    getSpaceAccess: async () => undefined,
    recordLastSeen: () => {},
  } as any);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const clients: any[] = [];
  const open = async (userId: string) => {
    const client = connectSocket(`http://127.0.0.1:${port}`, { auth: { token: userId }, transports: ['websocket'], reconnection: false });
    clients.push(client);
    const events: Array<{ event: string; data: any }> = [];
    client.onAny((event: string, data: unknown) => events.push({ event, data }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`presence:init timed out for ${userId}`)), 5_000);
      client.once('presence:init', () => { clearTimeout(timer); resolve(); });
    });
    return events;
  };
  try {
    const guestEvents = await open(guest);
    const memberEvents = await open(member);
    for (const key of ['inOrg', 'outOrg', 'outAssigned'] as const) {
      emitOrgTaskEvent(org, 'task:updated', { id: taskIds[key], project_id: shapes[key].project, changed_fields: ['status'] });
      getIO()!.to(`org:${org}`).emit('task:agent_progress', { task_id: taskIds[key], step_description: `step ${titleOf(key)}`, status: 'started' });
    }
    emitOrgTaskEvent(org, 'task:bulk_updated', { task_ids: [taskIds.inOrg, taskIds.outOrg] });
    const seen = (events: typeof guestEvents, event: string, key: TaskKey) =>
      events.some((e) => e.event === event && (e.data?.id === taskIds[key] || e.data?.task_id === taskIds[key]));
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !(memberEvents.length >= 7 && seen(guestEvents, 'task:agent_progress', 'outAssigned'))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const event of ['task:updated', 'task:agent_progress']) {
      for (const key of ['inOrg', 'outOrg', 'outAssigned'] as const) assert.ok(seen(memberEvents, event, key), `member ${event} ${key}`);
      assert.ok(seen(guestEvents, event, 'inOrg'), `guest ${event} inOrg`);
      assert.ok(seen(guestEvents, event, 'outAssigned'), `guest ${event} outAssigned`);
      assert.equal(seen(guestEvents, event, 'outOrg'), false, `guest ${event} outOrg`);
    }
    assert.equal(JSON.stringify(guestEvents).includes(taskIds.outOrg), false, 'no event carries the hidden task id to the guest');
    assert.equal(JSON.stringify(guestEvents).includes(titleOf('outOrg')), false);
    const memberBulk = memberEvents.find((e) => e.event === 'task:bulk_updated');
    assert.deepEqual(sorted(memberBulk!.data.task_ids), idsOf(['inOrg', 'outOrg']), 'members get the whole bulk event');
    const guestBulk = guestEvents.find((e) => e.event === 'task:bulk_updated');
    assert.deepEqual(guestBulk!.data.task_ids, [taskIds.inOrg], 'a guest gets only the ids they see');
    const progress = memberEvents.find((e) => e.event === 'task:agent_progress' && e.data?.task_id === taskIds.outOrg);
    assert.equal(progress!.data.step_description, `step ${titleOf('outOrg')}`, 'member progress payload unchanged');
  } finally {
    for (const client of clients) client.close();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  }
});
