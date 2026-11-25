// A task restricted to named people (metadata.visibility = 'restricted') is
// seen only by the people it names and its project's lead, on every route
// that returns task rows, titles or counts (lib/task-visibility.ts). Owners
// are not exempt. Release 152 checks found two routes that still returned
// it to an unrelated member or admin (GET /api/tasks/project/:id and the
// team dashboard's top tasks); the sibling routes never did. These tests
// hold every task route to the sibling routes' answer, for every role.
//
// Also: GET /api/tasks/search finds the caller's tasks by title and key, and
// a guest cannot set a project lead when creating a project.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { taskRoutes } from '../src/routes/tasks.js';
import { projectRoutes } from '../src/routes/projects.js';
import { teamRoutes } from '../src/routes/teams.js';
import { dashboardRoutes } from '../src/routes/dashboard.js';
import { memberRoutes } from '../src/routes/members.js';
import { humanProjectCreate, humanProjectGet, humanProjectList, humanProjectProgress, humanTeamWorkload, type HumanToolContext } from '../src/lib/mcp-tools/human.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { generateOneOnePrep } from '../src/services/oneone-prep.js';
import { generateManagerPulse } from '../src/services/manager-pulse.js';
import { handleDuplicateDetect } from '../src/workers/handlers/duplicate-detect.js';
import { handleWorkflowExecute } from '../src/workers/handlers/workflow-execute.js';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
const run = randomUUID().slice(0, 8);
const org = randomUUID();
const owner = randomUUID(), admin = randomUUID(), member = randomUUID(), named = randomUUID(), lead = randomUUID(), guest = randomUUID();
const people: Array<[string, string, string]> = [
  [owner, 'Rita Owner', 'owner'],
  [admin, 'Rex Admin', 'admin'],
  [member, 'Ria Member', 'member'],
  [named, 'Ray Named', 'member'],
  [lead, 'Roy Lead', 'member'],
  [guest, 'Rue Guest', 'guest'],
];
const VIEWERS = people.map(([id]) => id);
// The restricted tasks are created by the owner and name `named`; `lead` leads the project.
const SEES_RESTRICTED = new Set([owner, named, lead]);
const nameOf = (id: string) => people.find(([p]) => p === id)![1];

const room = randomUUID(), project = randomUUID(), otherProject = randomUUID(), team = randomUUID();
// A prefix with a digit, like 'R8O': search must still find a task by its key.
const prefix = `R8${run.slice(0, 3).toUpperCase()}`;
const otherPrefix = `Q${run.slice(0, 4).toUpperCase()}`;
const ids = {
  open: randomUUID(),       // top level, assigned to member
  hidden: randomUUID(),     // top level, restricted
  openSub: randomUUID(),    // subtask of open
  hiddenSub: randomUUID(),  // restricted subtask of open
  hiddenChild: randomUUID(), // unrestricted child of the restricted task
  other: randomUUID(),      // in another project, assigned to member, blocked by hidden
};
type Key = keyof typeof ids;
// A title that ends in a digit, like 'rc8': search must still find it by title.
const titleOf = (key: Key) => `rt9 ${run} (${key})`;
const numberOf: Record<Key, number> = { open: 1, hidden: 2, openSub: 3, hiddenSub: 4, hiddenChild: 5, other: 1 };
const RESTRICTED: Key[] = ['hidden', 'hiddenSub'];

before(async () => {
  await c.connect();
  await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Restricted Tasks', $2)`, [org, `restricted-tasks-${run}`]);
  for (const [id, name, role] of people) {
    await c.query(`INSERT INTO users (id, email, name, kind, is_agent, password_hash) VALUES ($1, $2, $3, 'human', false, 'hash')`,
      [id, `rtr-${run}-${role}-${id.slice(0, 4)}@test.local`, `${name} ${run}`]);
    await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, true)`, [org, id, role]);
  }
  await c.query(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, 'rtr room', 'private', $3)`, [room, org, owner]);
  for (const id of VIEWERS) {
    await c.query(`INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [room, id]);
  }
  await c.query(`INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES ($1, $2, 'rtr project', $3, $4, 10),
      ($5, $2, 'rtr other', $6, null, 10)`, [project, org, prefix, lead, otherProject, otherPrefix]);
  for (const p of [project, otherProject]) {
    await c.query(`INSERT INTO project_spaces (id, project_id, space_id) VALUES (gen_random_uuid()::text, $1, $2)`, [p, room]);
  }
  const restricted = JSON.stringify({ visibility: 'restricted', visible_user_ids: [named] });
  const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const rows: Array<[Key, string, string | null, string | null, string | null, string]> = [
    // key, project, parent, assignee, metadata, due
    ['open', project, null, member, null, soon(3)],
    ['hidden', project, null, named, restricted, soon(1)],
    ['openSub', project, ids.open, member, null, soon(4)],
    ['hiddenSub', project, ids.open, null, restricted, soon(2)],
    ['hiddenChild', project, ids.hidden, member, null, soon(5)],
    ['other', otherProject, null, member, null, soon(6)],
  ];
  for (const [key, p, parent, assignee, metadata, due] of rows) {
    await c.query(`INSERT INTO tasks (id, org_id, project_id, number, title, description, created_by, assignee_id, parent_task_id, metadata, status, due_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'todo', $11)`,
    [ids[key], org, p, numberOf[key], titleOf(key), `${titleOf(key)} description`, key === 'other' ? member : owner, assignee, parent, metadata, due]);
  }
  // open blocks hidden; hidden blocks other.
  await c.query(`INSERT INTO task_relationships (id, source_task_id, target_task_id, type) VALUES
    (gen_random_uuid()::text, $1, $2, 'blocks'), (gen_random_uuid()::text, $2, $3, 'blocks')`, [ids.open, ids.hidden, ids.other]);
  // Both open and hidden were completed once this week (velocity).
  for (const key of ['open', 'hidden'] as const) {
    await c.query(`INSERT INTO task_activity (id, org_id, task_id, user_id, action, field, old_value, new_value, created_at)
      VALUES (gen_random_uuid()::text, $1, $2, $3, 'status_changed', 'status', 'todo', 'done', now() - interval '2 days')`, [org, ids[key], owner]);
  }
  await c.query(`INSERT INTO teams (id, org_id, name, handle, visibility, lead_user_id, created_by) VALUES ($1, $2, 'rtr team', $3, 'org', $4, $4)`,
    [team, org, `rtr-team-${run}`, owner]);
  for (const id of VIEWERS) {
    await c.query(`INSERT INTO team_members (id, org_id, team_id, user_id, role) VALUES (gen_random_uuid()::text, $1, $2, $3, 'member')`, [org, team, id]);
  }
  await c.query(`INSERT INTO team_resources (id, org_id, team_id, resource_type, resource_id) VALUES (gen_random_uuid()::text, $1, $2, 'project', $3)`,
    [org, team, project]);
});

after(async () => {
  await c.query(`DELETE FROM notifications WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM attention_events WHERE org_id = $1`, [org]).catch(() => {});
  await c.query(`DELETE FROM attention_items WHERE org_id = $1`, [org]).catch(() => {});
  await c.query(`DELETE FROM job_queue WHERE org_id = $1`, [org]).catch(() => {});
  await c.query(`DELETE FROM duplicate_flags WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM agent_nudges WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM oneone_preps WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM workflow_runs WHERE rule_id IN (SELECT id FROM workflow_rules WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM workflow_rules WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM idempotency_keys WHERE user_id = ANY($1::text[])`, [VIEWERS]).catch(() => {});
  await c.query(`DELETE FROM task_labels WHERE task_id IN (SELECT id FROM tasks WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM task_comments WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM team_resources WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM team_members WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM teams WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM task_activity WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM task_relationships WHERE source_task_id IN (SELECT id FROM tasks WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM tasks WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM project_spaces WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM projects WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM messages WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM spaces WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM org_members WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [VIEWERS]);
  await c.query(`DELETE FROM orgs WHERE id = $1`, [org]);
  await c.end();
});

function app(viewer: string) {
  const role = people.find(([id]) => id === viewer)![2];
  const hono = new Hono();
  hono.use('*', async (ctx, next) => {
    // A guest's session claims 'member': only org_members makes them a guest.
    ctx.set('user', { id: viewer, org_id: org, email: `rtr-${run}@test.local`, sid: 's', role: role === 'guest' ? 'member' : role } as never);
    await next();
  });
  hono.route('/api/tasks', taskRoutes);
  hono.route('/api/projects', projectRoutes);
  hono.route('/api/teams', teamRoutes);
  hono.route('/api/dashboard', dashboardRoutes);
  hono.route('/api/members', memberRoutes);
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
const mentions = (text: string, key: Key) => text.includes(ids[key]) || text.includes(titleOf(key));
const who = (viewer: string) => nameOf(viewer);
const sorted = (list: Iterable<string>) => [...list].sort();
const seesRestricted = (viewer: string) => SEES_RESTRICTED.has(viewer);

/** The top-level tasks of the project this viewer may see, by the sibling route. */
async function siblingProjectList(viewer: string) {
  const res = await get(viewer, `/api/projects/${project}/tasks`);
  assert.equal(res.status, 200, `${who(viewer)}: /api/projects/:id/tasks`);
  return res.body as Array<{ id: string; subtask_count: number }>;
}

test('GET /api/tasks/project/:id: an unrelated member and admin do not get a restricted task; the owner, named person and lead do', async () => {
  for (const viewer of VIEWERS) {
    const res = await get(viewer, `/api/tasks/project/${project}`);
    assert.equal(res.status, 200, who(viewer));
    if (viewer === guest) {
      assert.equal(mentions(res.text, 'hidden'), false, 'guest');
      continue;
    }
    assert.equal(mentions(res.text, 'hidden'), seesRestricted(viewer), `${who(viewer)}: restricted task on the board`);
    assert.ok(mentions(res.text, 'open'), `${who(viewer)}: the open task stays`);
  }
});

test('equivalence: for every role, GET /api/tasks/project/:id returns exactly what /api/projects/:id/tasks and /api/tasks/table return', async () => {
  for (const viewer of VIEWERS) {
    const sibling = await siblingProjectList(viewer);
    const board = await get(viewer, `/api/tasks/project/${project}`);
    const table = await get(viewer, `/api/tasks/table?project_id=${project}`);
    assert.equal(table.status, 200);
    const counts = (rows: Array<{ id: string; subtask_count: number }>) => sorted(rows.map((row) => `${row.id}:${row.subtask_count}`));
    assert.deepEqual(counts(board.body), counts(sibling), `${who(viewer)}: board vs project list`);
    assert.deepEqual(counts(table.body.data), counts(sibling), `${who(viewer)}: table vs project list`);
  }
});

test('subtask counts leave out a restricted subtask for people it does not name, on every list', async () => {
  for (const viewer of VIEWERS) {
    const expected = seesRestricted(viewer) ? 2 : 1;
    const lists: Array<[string, (body: any) => Array<{ id: string; subtask_count: number }>]> = [
      [`/api/tasks/project/${project}`, (body) => body],
      [`/api/projects/${project}/tasks`, (body) => body],
      [`/api/tasks/table?project_id=${project}`, (body) => body.data],
    ];
    for (const [path, rowsOf] of lists) {
      const res = await get(viewer, path);
      const open = rowsOf(res.body).find((row) => row.id === ids.open);
      assert.equal(open?.subtask_count, expected, `${who(viewer)} ${path}`);
    }
  }
  const mine = await get(member, '/api/tasks/my');
  assert.equal(mine.body.find((row: any) => row.id === ids.open)?.subtask_count, 1, 'member /api/tasks/my');
});

test('GET /api/teams/:id/dashboard: top tasks and counts leave out a restricted task for people it does not name', async () => {
  for (const viewer of VIEWERS) {
    const res = await get(viewer, `/api/teams/${team}/dashboard`);
    assert.equal(res.status, 200, who(viewer));
    const sees = viewer !== guest && seesRestricted(viewer);
    for (const key of RESTRICTED) assert.equal(mentions(res.text, key), sees, `${who(viewer)}: ${key}`);
    const topIds = (res.body.attention.top_tasks as Array<{ id: string }>).map((task) => task.id);
    // Open tasks in the project: open, openSub, hiddenChild, plus hidden and hiddenSub for those named.
    const visibleOpen = sees ? 5 : 3;
    assert.equal(res.body.workload.open_tasks, visibleOpen, `${who(viewer)}: open_tasks`);
    assert.equal(topIds.length, visibleOpen, `${who(viewer)}: top_tasks`);
    assert.equal(res.body.attention.due_soon_tasks, visibleOpen, `${who(viewer)}: due_soon_tasks`);
  }
});

test('GET /api/projects/:id task_counts and GET /api/projects totals agree with what the viewer may see', async () => {
  for (const viewer of VIEWERS) {
    const detail = await get(viewer, `/api/projects/${project}`);
    assert.equal(detail.status, 200, who(viewer));
    const sum = Object.values(detail.body.task_counts as Record<string, number>).reduce((a, b) => a + b, 0);
    const expected = seesRestricted(viewer) ? 5 : 3;
    assert.equal(sum, expected, `${who(viewer)}: task_counts sum`);
    const list = await get(viewer, '/api/projects');
    const row = (list.body as Array<{ id: string; total_tasks: number }>).find((p) => p.id === project);
    assert.equal(row?.total_tasks, sum, `${who(viewer)}: /api/projects total agrees with task_counts`);
  }
});

test('GET /api/projects/:id/velocity leaves out a restricted task completion for people it does not name', async () => {
  for (const viewer of VIEWERS) {
    const res = await get(viewer, `/api/projects/${project}/velocity`);
    assert.equal(res.status, 200, who(viewer));
    const completed = (res.body.velocity as Array<{ completed: number }>).reduce((a, v) => a + v.completed, 0);
    assert.equal(completed, seesRestricted(viewer) ? 2 : 1, who(viewer));
  }
});

test('a task\'s subtasks, parent, dependencies and subtree leave out a restricted task for people it does not name', async () => {
  for (const viewer of VIEWERS) {
    const sees = seesRestricted(viewer);
    const detail = await get(viewer, `/api/tasks/${ids.open}`);
    assert.equal(detail.status, 200, who(viewer));
    assert.equal(mentions(detail.text, 'hiddenSub'), sees, `${who(viewer)}: subtasks of open`);
    const deps = await get(viewer, `/api/tasks/${ids.open}/dependencies`);
    assert.equal(deps.status, 200);
    assert.equal(mentions(deps.text, 'hidden'), sees, `${who(viewer)}: dependencies of open`);
    const otherDeps = await get(viewer, `/api/tasks/${ids.other}/dependencies`);
    assert.equal(mentions(otherDeps.text, 'hidden'), sees, `${who(viewer)}: dependencies of other`);
    const subtree = await get(viewer, `/api/tasks/${ids.open}/subtree`);
    assert.equal(subtree.status, 200);
    assert.equal(mentions(subtree.text, 'hiddenSub'), sees, `${who(viewer)}: subtree of open`);
    if (viewer === guest) continue;
    const child = await get(viewer, `/api/tasks/${ids.hiddenChild}`);
    assert.equal(child.status, 200, `${who(viewer)}: the unrestricted child`);
    assert.equal(child.text.includes(titleOf('hidden')), sees, `${who(viewer)}: the child shows its restricted parent's title`);
    assert.equal(child.body.parent_task?.id ?? null, sees ? ids.hidden : null, `${who(viewer)}: parent_task`);
  }
});

test('the dashboard, people directory and member detail leave out a restricted task for people it does not name', async () => {
  for (const viewer of VIEWERS) {
    const sees = viewer !== guest && seesRestricted(viewer);
    const dash = await get(viewer, '/api/dashboard');
    assert.equal(dash.status, 200, who(viewer));
    const stats = (dash.body.projects as Array<{ id: string; total_tasks: number; done_tasks: number }>).find((p) => p.id === project);
    assert.equal(stats?.total_tasks, sees ? 5 : 3, `${who(viewer)}: dashboard project total`);
    if (!sees) for (const key of RESTRICTED) assert.equal(mentions(dash.text, key), false, `${who(viewer)}: dashboard ${key}`);
    const directory = await get(viewer, '/api/members/directory');
    if (directory.status === 200) {
      const row = (directory.body.members as Array<any>).find((m) => (m.user_id ?? m.id) === named);
      assert.equal(row?.stats.assigned_tasks_open, sees ? 1 : 0, `${who(viewer)}: directory count for the named person`);
    }
    const detail = await get(viewer, `/api/members/${named}/detail`);
    if (detail.status === 200) {
      assert.equal(mentions(detail.text, 'hidden'), sees, `${who(viewer)}: detail open tasks`);
      assert.equal(detail.body.member.stats.assigned_tasks_open, sees ? 1 : 0, `${who(viewer)}: detail count`);
    }
    if (viewer === owner || viewer === member) {
      assert.equal(directory.status, 200, `${who(viewer)}: directory`);
      assert.equal(detail.status, 200, `${who(viewer)}: detail`);
    }
  }
});

test('GET /api/tasks/search finds a task by title and by key, and never a hidden one', async () => {
  const ids_ = (body: any) => sorted((body as Array<{ id: string }>).map((row) => row.id));
  const byTitle = await get(owner, `/api/tasks/search?q=${encodeURIComponent(titleOf('open'))}`);
  assert.equal(byTitle.status, 200);
  assert.deepEqual(ids_(byTitle.body), [ids.open], 'owner by title');
  // A query that looks like a key ('rt9', like 'rc8') but is a title word.
  const titleWord = await get(owner, '/api/tasks/search?q=rt9');
  for (const key of Object.keys(ids) as Key[]) assert.ok(mentions(titleWord.text, key), `owner by the title word: ${key}`);
  for (const key of [`${prefix}-${numberOf.open}`, `${prefix.toLowerCase()}-${numberOf.open}`, `${prefix}${numberOf.open}`]) {
    const byKey = await get(owner, `/api/tasks/search?q=${encodeURIComponent(key)}`);
    assert.equal(byKey.status, 200);
    assert.deepEqual(ids_(byKey.body), [ids.open], `owner by key ${key}`);
  }
  const ownerHidden = await get(owner, `/api/tasks/search?q=${encodeURIComponent(titleOf('hidden'))}`);
  assert.deepEqual(ids_(ownerHidden.body), [ids.hidden], 'the owner created the restricted task');
  for (const viewer of [member, admin, guest]) {
    const all = await get(viewer, `/api/tasks/search?q=${encodeURIComponent(`rt9 ${run}`)}`);
    assert.equal(all.status, 200);
    for (const key of RESTRICTED) assert.equal(mentions(all.text, key), false, `${who(viewer)}: ${key} by title`);
    assert.ok(mentions(all.text, 'open'), `${who(viewer)}: open by title`);
    const hiddenKey = await get(viewer, `/api/tasks/search?q=${prefix}-${numberOf.hidden}`);
    assert.deepEqual(hiddenKey.body, [], `${who(viewer)}: the restricted task by key`);
  }
});

test('POST /api/projects: a guest cannot set a lead when creating a project; others still can', async () => {
  for (const leadId of [guest, owner]) {
    const res = await call(guest, '/api/projects', {
      method: 'POST', body: { name: `rtr guest ${leadId.slice(0, 4)}`, prefix: `G${run.slice(0, 3).toUpperCase()}${leadId === guest ? 'A' : 'B'}`, lead_id: leadId },
    });
    assert.equal(res.status, 403, `guest with lead ${leadId === guest ? 'self' : 'owner'}`);
    assert.equal(res.body.code, 'FORBIDDEN');
  }
  const { rows } = await c.query(`SELECT count(*)::int AS n FROM projects WHERE org_id = $1 AND name LIKE 'rtr guest%'`, [org]);
  assert.equal(rows[0].n, 0, 'no project was created');
  const plain = await call(guest, '/api/projects', { method: 'POST', body: { name: 'rtr guest plain', prefix: `G${run.slice(0, 3).toUpperCase()}C` } });
  assert.equal(plain.status, 201, 'a guest may still create a project without a lead');
  assert.equal(plain.body.lead_id, null);
  const byMember = await call(member, '/api/projects', { method: 'POST', body: { name: 'rtr member led', prefix: `M${run.slice(0, 3).toUpperCase()}D`, lead_id: owner } });
  assert.equal(byMember.status, 201, 'a member may set a lead');
  assert.equal(byMember.body.lead_id, owner);
});

// ── MCP tools, Defty tools, services and workers ─────────────────────────

const mcp = (viewer: string): HumanToolContext => ({
  org_id: org,
  user_id: viewer,
  role: people.find(([id]) => id === viewer)![2] as HumanToolContext['role'],
  scopes: ['read:workspace', 'read:tasks'],
});
const payload = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);

test('MCP project_list, project_get, project_progress and team_workload count a restricted task only for people it names', async () => {
  for (const viewer of VIEWERS) {
    const sees = seesRestricted(viewer);
    const list = payload(await humanProjectList({ query: prefix }, mcp(viewer)) as any) as Array<{ id: string; open_tasks: number }>;
    assert.equal(list.find((p) => p.id === project)?.open_tasks, sees ? 5 : 3, `${who(viewer)}: project_list open_tasks`);
    const detail = payload(await humanProjectGet({ project_id: project }, mcp(viewer)) as any);
    const counts = detail.project ?? detail;
    assert.equal(counts.total_tasks, sees ? 5 : 3, `${who(viewer)}: project_get total_tasks`);
    assert.equal(counts.open_tasks, sees ? 5 : 3, `${who(viewer)}: project_get open_tasks`);
    const progress = JSON.stringify(await humanProjectProgress({ project_id: project }, mcp(viewer)));
    for (const key of RESTRICTED) if (!sees) assert.equal(mentions(progress, key), false, `${who(viewer)}: project_progress ${key}`);
    if (viewer === guest) continue;
    const workload = payload(await humanTeamWorkload({}, mcp(viewer)) as any).workload as Array<{ user_id: string; open_tasks: number }>;
    assert.equal(workload.find((row) => row.user_id === named)?.open_tasks, sees ? 1 : 0, `${who(viewer)}: team_workload for the named person`);
  }
});

test('Defty get_team_performance and get_workload_balance count a restricted task only for people it names', async () => {
  for (const viewer of [owner, admin, member, named]) {
    const sees = seesRestricted(viewer);
    const performance = (await executeToolCall('get_team_performance', {}, org, viewer)).result as { weeks: Array<{ completed: number }> };
    assert.equal(performance.weeks.reduce((a, w) => a + w.completed, 0), sees ? 2 : 1, `${who(viewer)}: completions`);
    const balance = (await executeToolCall('get_workload_balance', {}, org, viewer)).result as { members: Array<{ name: string; task_count: number }> };
    assert.equal(balance.members.find((m) => m.name.startsWith(nameOf(named)))?.task_count, sees ? 1 : 0, `${who(viewer)}: workload of the named person`);
  }
});

test('a 1:1 prep names a restricted task only to a manager it names', async () => {
  await c.query(`UPDATE tasks SET status = 'in_progress' WHERE id = $1`, [ids.hidden]);
  try {
    for (const manager of [admin, owner]) {
      const prep = JSON.stringify(await generateOneOnePrep(manager, named, org));
      assert.equal(prep.includes(titleOf('hidden')), seesRestricted(manager), `${who(manager)}: prep for the named person`);
    }
  } finally {
    await c.query(`UPDATE tasks SET status = 'todo' WHERE id = $1`, [ids.hidden]);
  }
});

test('a duplicate and the next occurrence of a restricted task stay restricted to the same people', async () => {
  const dup = await call(owner, `/api/tasks/${ids.hidden}/duplicate`, { method: 'POST' });
  assert.equal(dup.status, 201);
  assert.equal(dup.body.metadata?.visibility, 'restricted');
  assert.equal((await get(member, `/api/tasks/${dup.body.id}`)).status, 404, 'member: the copy');
  assert.equal((await get(named, `/api/tasks/${dup.body.id}`)).status, 200, 'named: the copy');
  assert.ok(dup.body.metadata.visible_user_ids.includes(owner), 'the original creator is named on the copy');
  await c.query(`UPDATE tasks SET is_deleted = true WHERE id = $1`, [dup.body.id]);

  // The owner creates it, the admin watches it, the named person completes it:
  // the next occurrence still reaches all three, and not the member.
  const recurring = randomUUID();
  await c.query(`INSERT INTO tasks (id, org_id, project_id, number, title, created_by, metadata, status, recurrence)
    VALUES ($1, $2, $3, 90, $4, $5, $6, 'in_progress', 'weekly')`,
  [recurring, org, project, `rt9 ${run} (recurring)`, owner, JSON.stringify({ visibility: 'restricted', visible_user_ids: [named] })]);
  await c.query(`INSERT INTO task_watchers (id, task_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [recurring, admin]);
  const done = await call(named, `/api/tasks/${recurring}`, { method: 'PATCH', body: { status: 'done' } });
  assert.equal(done.status, 200);
  const { rows } = await c.query(`SELECT id, metadata FROM tasks WHERE recurrence_source_id = $1`, [recurring]);
  assert.equal(rows.length, 1, 'the next occurrence was made');
  assert.equal(rows[0].metadata?.visibility, 'restricted');
  assert.deepEqual(sorted(rows[0].metadata?.visible_user_ids), sorted([named, owner, admin]));
  for (const viewer of [owner, admin, named, lead]) {
    assert.equal((await get(viewer, `/api/tasks/${rows[0].id}`)).status, 200, `${who(viewer)}: the next occurrence`);
  }
  assert.equal((await get(member, `/api/tasks/${rows[0].id}`)).status, 404, 'member: the next occurrence');
  await c.query(`UPDATE tasks SET is_deleted = true WHERE id = ANY($1::text[])`, [[recurring, rows[0].id]]);
});

test('MCP project_create: a guest cannot set a project lead', async () => {
  const guestCtx = { ...mcp(guest), scopes: ['write:workspace'] };
  const refused = await humanProjectCreate({ name: 'rtr mcp guest', prefix: `H${run.slice(0, 3).toUpperCase()}A`, lead_id: guest }, guestCtx) as any;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /guest cannot set a project lead/);
  const { rows } = await c.query(`SELECT count(*)::int AS n FROM projects WHERE org_id = $1 AND name = 'rtr mcp guest'`, [org]);
  assert.equal(rows[0].n, 0);
  const plain = await humanProjectCreate({ name: 'rtr mcp guest plain', prefix: `H${run.slice(0, 3).toUpperCase()}B` }, guestCtx) as any;
  assert.notEqual(plain.isError, true, 'a guest may still create a project without a lead');
});

test('an @mention on a restricted task notifies only people it names', async () => {
  const res = await call(owner, `/api/tasks/${ids.hidden}`, {
    method: 'PATCH', body: { description: `<p>rt9 ${run} mention @Ria and @Ray</p>` },
  });
  assert.equal(res.status, 200);
  const notified = async (userId: string) => (await c.query(
    `SELECT count(*)::int AS n FROM notifications WHERE org_id = $1 AND user_id = $2 AND type = 'mention' AND metadata->>'task_id' = $3`,
    [org, userId, ids.hidden])).rows[0].n as number;
  assert.equal(await notified(member), 0, 'the unrelated member is not told');
  assert.equal(await notified(named), 1, 'the named person is told');
});

test('workflow notices and duplicate notices name a restricted task only to people it names', async () => {
  const rule = randomUUID();
  await c.query(`INSERT INTO workflow_rules (id, org_id, name, trigger_type, trigger_config, action_type, action_config, created_by)
    VALUES ($1, $2, 'rtr notify', 'task.status_changed', '{}'::jsonb, 'notify', $3, $4)`,
  [rule, org, JSON.stringify({ actions: [{ kind: 'notify', user_id: member }, { kind: 'notify', user_id: named }] }), owner]);
  await handleWorkflowExecute({ id: randomUUID(), name: 'workflow-execute', attempts: 0, data: { workflow_id: rule, task_id: ids.hidden, actor_user_id: owner, org_id: org } });
  const told = async (userId: string, text: string) => (await c.query(
    `SELECT count(*)::int AS n FROM notifications WHERE org_id = $1 AND user_id = $2 AND (coalesce(body, '') LIKE $3 OR title LIKE $3)`,
    [org, userId, `%${text}%`])).rows[0].n as number;
  assert.equal(await told(member, titleOf('hidden')), 0, 'workflow notify: the unrelated member');
  assert.equal(await told(named, titleOf('hidden')), 1, 'workflow notify: the named person');

  // A member makes a task titled like the restricted one: the duplicate notice does not name it.
  const copy = randomUUID();
  await c.query(`INSERT INTO tasks (id, org_id, project_id, number, title, created_by, status) VALUES ($1, $2, $3, 950, $4, $5, 'todo')`,
    [copy, org, project, titleOf('hidden'), member]);
  await handleDuplicateDetect({ id: randomUUID(), name: 'duplicate-detect', attempts: 0, data: { taskId: copy, title: titleOf('hidden'), projectId: project, orgId: org } });
  const { rows } = await c.query(`SELECT count(*)::int AS n FROM duplicate_flags WHERE org_id = $1 AND $2 IN (task_a_id, task_b_id)`, [org, ids.hidden]);
  assert.equal(rows[0].n, 0, 'no duplicate flag against the restricted task');
  const { rows: notices } = await c.query(`SELECT count(*)::int AS n FROM notifications WHERE org_id = $1 AND user_id = $2 AND metadata::text LIKE $3`,
    [org, member, `%${ids.hidden}%`]);
  assert.equal(notices[0].n, 0, 'no notice names the restricted task');
  await c.query(`UPDATE tasks SET is_deleted = true WHERE id = $1`, [copy]);
});

test('a manager pulse lists a stalled nudge about a restricted task only to a manager it names', async () => {
  for (const key of ['open', 'hidden'] as const) {
    await c.query(`INSERT INTO agent_nudges (id, org_id, user_id, task_id, nudge_type, message) VALUES (gen_random_uuid()::text, $1, $2, $3, 'stalled', $4)`,
      [org, named, ids[key], `rtr-nudge-${run}-${key}`]);
  }
  for (const manager of [admin, owner]) {
    const pulse = await generateManagerPulse(manager, org);
    const card = JSON.stringify(pulse.healthCards);
    assert.ok(card.includes(`rtr-nudge-${run}-open`), `${who(manager)}: the open task's nudge`);
    assert.equal(card.includes(`rtr-nudge-${run}-hidden`), seesRestricted(manager), `${who(manager)}: the restricted task's nudge`);
  }
});
