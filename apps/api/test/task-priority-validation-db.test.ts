// An unknown task priority (such as 'urgent'; valid values are p0-p3) is a
// validation error on every path that writes a priority, never a 500 from the
// task_priority enum and never silently replaced by p2. Release 153 checks
// found POST /api/projects/:id/tasks answering 500 for priority 'urgent'.
// Every path checks with the one schema in lib/task-priority.ts.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { taskRoutes } from '../src/routes/tasks.js';
import { projectRoutes } from '../src/routes/projects.js';
import { humanTaskBulkUpdate, humanTaskCreate, humanTaskUpdate, type HumanToolContext } from '../src/lib/mcp-tools/human.js';
import { taskCreate, taskUpdate } from '../src/lib/mcp-tools/writes.js';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';
import { executeActionDirect } from '../src/lib/agent-actions.js';
import { ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
const run = randomUUID().slice(0, 8);
const org = randomUUID();
const owner = randomUUID();
const agentUser = randomUUID();
const employee = randomUUID();
const employeeSlug = `prio-${run}`;
const project = randomUUID();
const projectName = `prio project ${run}`;
const prefix = `PV${run.slice(0, 3).toUpperCase()}`;
const existing = randomUUID();
const other = randomUUID();

before(async () => {
  await c.connect();
  await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Priority Validation', $2)`, [org, `priority-validation-${run}`]);
  await c.query(`INSERT INTO users (id, email, name, kind, is_agent, password_hash) VALUES ($1, $2, $3, 'human', false, 'hash')`,
    [owner, `prio-${run}-owner@test.local`, `Pia Owner ${run}`]);
  await c.query(`INSERT INTO users (id, email, name, kind, is_agent) VALUES ($1, $2, $3, 'agent', true)`,
    [agentUser, `prio-${run}-agent@test.local`, `Prio Agent ${run}`]);
  await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES
    (gen_random_uuid()::text, $1, $2, 'owner', true), (gen_random_uuid()::text, $1, $3, 'member', true)`, [org, owner, agentUser]);
  await c.query(`INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, max_daily_actions, created_by, is_active, is_byoa)
    VALUES ($1, $2, $3, 'Prio Agent', $4, 'project_manager', 'test', 'autonomous', 100, $5, true, true)`,
  [employee, org, agentUser, employeeSlug, owner]);
  await ensureDeftyMembership(org);
  await c.query(`INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES ($1, $2, $3, $4, $5, 2)`,
    [project, org, projectName, prefix, owner]);
  await c.query(`INSERT INTO tasks (id, org_id, project_id, number, title, created_by, status, priority) VALUES
    ($1, $3, $4, 1, $5, $6, 'todo', 'p2'), ($2, $3, $4, 2, $7, $6, 'todo', 'p2')`,
  [existing, other, org, project, `prio existing ${run}`, owner, `prio other ${run}`]);
});

after(async () => {
  const taskIds = `SELECT id FROM tasks WHERE org_id = $1`;
  await c.query(`DELETE FROM notifications WHERE org_id = $1`, [org]).catch(() => {});
  await c.query(`DELETE FROM job_queue WHERE org_id = $1`, [org]).catch(() => {});
  await c.query(`DELETE FROM action_receipts WHERE org_id = $1`, [org]).catch(() => {});
  await c.query(`DELETE FROM audit_log WHERE org_id = $1`, [org]).catch(() => {});
  await c.query(`DELETE FROM idempotency_keys WHERE user_id = ANY($1::text[])`, [[owner, agentUser]]).catch(() => {});
  await c.query(`DELETE FROM task_relationships WHERE source_task_id IN (${taskIds}) OR target_task_id IN (${taskIds})`, [org]);
  await c.query(`DELETE FROM task_watchers WHERE task_id IN (${taskIds})`, [org]);
  await c.query(`DELETE FROM task_assignees WHERE task_id IN (${taskIds})`, [org]);
  await c.query(`DELETE FROM task_comments WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM task_activity WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM agent_actions WHERE org_id = $1`, [org]).catch(() => {});
  await c.query(`DELETE FROM tasks WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM projects WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM agent_employees WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM org_members WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[owner, agentUser]]);
  await c.query(`DELETE FROM orgs WHERE id = $1`, [org]).catch(() => {});
  await c.end();
});

function app() {
  const hono = new Hono();
  hono.use('*', async (ctx, next) => {
    ctx.set('user', { id: owner, org_id: org, email: `prio-${run}@test.local`, sid: 's', role: 'owner' } as never);
    await next();
  });
  hono.route('/api/tasks', taskRoutes);
  hono.route('/api/projects', projectRoutes);
  return hono;
}

async function call(method: string, path: string, body: unknown) {
  const res = await app().request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json };
}

async function taskCount() {
  const { rows } = await c.query(`SELECT count(*)::int AS n FROM tasks WHERE org_id = $1`, [org]);
  return rows[0].n as number;
}

async function priorityOf(id: string) {
  const { rows } = await c.query(`SELECT priority FROM tasks WHERE id = $1`, [id]);
  return rows[0]?.priority as string | undefined;
}

async function resetPriorities() {
  await c.query(`UPDATE tasks SET priority = 'p2' WHERE id = ANY($1::text[])`, [[existing, other]]);
}

const human: HumanToolContext = { org_id: org, user_id: owner, role: 'owner', scopes: ['write:tasks', 'read:tasks', 'read:workspace'] };
const byoa = (): ToolContext => ({ org_id: org, employee_id: employee, employee_slug: employeeSlug, trust_level: 'autonomous' });
const text = (result: { content?: Array<{ text: string }> }) => result.content?.[0]?.text ?? '';

// ── REST ────────────────────────────────────────────────────────────────

const REST_CREATES: Array<[string, string, (priority: string) => Record<string, unknown>]> = [
  ['POST /api/tasks', '/api/tasks', (priority) => ({ project_id: project, title: `rest root ${run}`, priority })],
  ['POST /api/projects/:id/tasks', `/api/projects/${project}/tasks`, (priority) => ({ title: `rest project ${run}`, priority })],
  ['POST /api/tasks/project/:projectId', `/api/tasks/project/${project}`, (priority) => ({ title: `rest legacy ${run}`, priority })],
];

for (const [name, path, body] of REST_CREATES) {
  test(`${name}: an unknown priority is 400 VALIDATION_ERROR and creates nothing`, async () => {
    const before = await taskCount();
    for (const priority of ['urgent', 'P1', '', 'p4']) {
      const res = await call('POST', path, body(priority));
      assert.equal(res.status, 400, `${name} priority ${JSON.stringify(priority)}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body?.code, 'VALIDATION_ERROR');
    }
    assert.equal(await taskCount(), before, 'nothing created');
  });

  test(`${name}: a valid priority is kept, and a missing or null one is p2`, async () => {
    const valid = await call('POST', path, body('p1'));
    assert.equal(valid.status, 201, JSON.stringify(valid.body));
    assert.equal(valid.body.priority, 'p1');
    const missing = await call('POST', path, { ...body('p1'), priority: undefined });
    assert.equal(missing.status, 201, JSON.stringify(missing.body));
    assert.equal(missing.body.priority, 'p2');
    const nulled = await call('POST', path, { ...body('p1'), priority: null });
    assert.equal(nulled.status, 201, JSON.stringify(nulled.body));
    assert.equal(nulled.body.priority, 'p2');
  });
}

test('PATCH /api/tasks/:id: an unknown priority is 400 VALIDATION_ERROR; a valid one is written', async () => {
  await resetPriorities();
  const bad = await call('PATCH', `/api/tasks/${existing}`, { priority: 'urgent' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body?.code, 'VALIDATION_ERROR');
  assert.equal(await priorityOf(existing), 'p2');
  const good = await call('PATCH', `/api/tasks/${existing}`, { priority: 'p0' });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(await priorityOf(existing), 'p0');
});

test('PATCH /api/tasks/bulk: an unknown priority is 400 VALIDATION_ERROR; a valid one is written', async () => {
  await resetPriorities();
  const bad = await call('PATCH', '/api/tasks/bulk', { task_ids: [existing, other], updates: { priority: 'urgent' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body?.code, 'VALIDATION_ERROR');
  assert.equal(await priorityOf(existing), 'p2');
  const good = await call('PATCH', '/api/tasks/bulk', { task_ids: [existing, other], updates: { priority: 'p3' } });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(await priorityOf(existing), 'p3');
  assert.equal(await priorityOf(other), 'p3');
});

// ── Personal MCP (human) ───────────────────────────────────────────────

test('MCP task_create (personal): an unknown priority, on the task or a subtask, is a tool error and creates nothing', async () => {
  const before = await taskCount();
  const bad = await humanTaskCreate({ title: `mcp human ${run}`, project_id: project, priority: 'urgent' }, human);
  assert.equal(bad.isError, true, text(bad));
  assert.match(text(bad), /priority/);
  const badSub = await humanTaskCreate({ title: `mcp human sub ${run}`, project_id: project, priority: 'p1', subtasks: [{ title: 'child', priority: 'high' }] }, human);
  assert.equal(badSub.isError, true, text(badSub));
  assert.match(text(badSub), /priority/);
  assert.equal(await taskCount(), before, 'nothing created');
  const good = await humanTaskCreate({ title: `mcp human ok ${run}`, project_id: project, priority: 'p1', subtasks: [{ title: 'child', priority: 'p3' }] }, human);
  assert.notEqual(good.isError, true, text(good));
  const created = JSON.parse(text(good));
  assert.equal(await priorityOf(created.id), 'p1');
  assert.equal(created.subtasks?.[0]?.priority, 'p3');
});

test('MCP task_update (personal): an unknown priority is a tool error; a valid one is written', async () => {
  await resetPriorities();
  const bad = await humanTaskUpdate({ task_id: existing, patch: { priority: 'urgent' } }, human);
  assert.equal(bad.isError, true, text(bad));
  assert.match(text(bad), /priority/);
  assert.equal(await priorityOf(existing), 'p2');
  const good = await humanTaskUpdate({ task_id: existing, patch: { priority: 'p0' } }, human);
  assert.notEqual(good.isError, true, text(good));
  assert.equal(await priorityOf(existing), 'p0');
});

test('MCP task_bulk_update (personal): an unknown priority is a tool error; a valid one is written', async () => {
  await resetPriorities();
  const bad = await humanTaskBulkUpdate({ task_ids: [existing, other], updates: { priority: 'urgent' } }, human);
  assert.equal(bad.isError, true, text(bad));
  assert.equal(await priorityOf(existing), 'p2');
  const good = await humanTaskBulkUpdate({ task_ids: [existing, other], updates: { priority: 'p1' } }, human);
  assert.notEqual(good.isError, true, text(good));
  assert.equal(await priorityOf(other), 'p1');
});

// ── Agent employee MCP (BYOA) ──────────────────────────────────────────

test('MCP task_create (agent employee): an unknown priority is a tool error, not silently p2', async () => {
  const before = await taskCount();
  const bad = await taskCreate({ caller_employee_slug: employeeSlug, title: `byoa ${run}`, project_id: project, priority: 'urgent' } as any, byoa());
  assert.equal(bad.isError, true, text(bad));
  assert.match(text(bad), /priority/);
  const badSub = await taskCreate({ caller_employee_slug: employeeSlug, title: `byoa sub ${run}`, project_id: project, subtasks: [{ title: 'child', priority: 'high' }] } as any, byoa());
  assert.equal(badSub.isError, true, text(badSub));
  assert.equal(await taskCount(), before, 'nothing created');
  const good = await taskCreate({ caller_employee_slug: employeeSlug, title: `byoa ok ${run}`, project_id: project, priority: 'p1' } as any, byoa());
  assert.notEqual(good.isError, true, text(good));
  const { rows } = await c.query(`SELECT priority FROM tasks WHERE org_id = $1 AND title = $2`, [org, `byoa ok ${run}`]);
  assert.equal(rows[0]?.priority, 'p1');
});

test('MCP task_create / task_update (agent employee, conservative trust): an unknown priority is refused before anything is queued for approval', async () => {
  const conservative = (): ToolContext => ({ ...byoa(), trust_level: 'conservative' });
  const queued = async () => (await c.query(`SELECT count(*)::int AS n FROM agent_actions WHERE org_id = $1`, [org])).rows[0].n as number;
  const before = await queued();
  const create = await taskCreate({ caller_employee_slug: employeeSlug, title: `byoa queued ${run}`, project_id: project, priority: 'urgent' } as any, conservative());
  assert.equal(create.isError, true, text(create));
  const update = await taskUpdate({ caller_employee_slug: employeeSlug, task_id: existing, patch: { priority: 'urgent' } } as any, conservative());
  assert.equal(update.isError, true, text(update));
  assert.equal(await queued(), before, 'nothing queued');
});

test('MCP task_update (agent employee): an unknown priority is a tool error, not silently ignored', async () => {
  await resetPriorities();
  const bad = await taskUpdate({ caller_employee_slug: employeeSlug, task_id: existing, patch: { priority: 'urgent' } } as any, byoa());
  assert.equal(bad.isError, true, text(bad));
  assert.match(text(bad), /priority/);
  assert.equal(await priorityOf(existing), 'p2');
  const good = await taskUpdate({ caller_employee_slug: employeeSlug, task_id: existing, patch: { priority: 'p0' } } as any, byoa());
  assert.notEqual(good.isError, true, text(good));
  assert.equal(await priorityOf(existing), 'p0');
});

// ── Defty's task tools ─────────────────────────────────────────────────

test("Defty create_task: an unknown priority, on the task or a subtask, fails and creates nothing", async () => {
  const before = await taskCount();
  const bad = await executeActionDirect('create_task', { title: `defty ${run}`, resolved_project_id: project, project_name: projectName, priority: 'urgent' }, org, owner, null, 'quick');
  assert.equal(bad.success, false, JSON.stringify(bad));
  assert.match(String(bad.error), /priority/);
  const empty = await executeActionDirect('create_task', { title: `defty empty ${run}`, resolved_project_id: project, project_name: projectName, priority: '' }, org, owner, null, 'quick');
  assert.equal(empty.success, false, JSON.stringify(empty));
  const badSub = await executeActionDirect('create_task', { title: `defty sub ${run}`, resolved_project_id: project, project_name: projectName, subtasks: [{ title: 'child', priority: 'high' }] }, org, owner, null, 'quick');
  assert.equal(badSub.success, false, JSON.stringify(badSub));
  assert.equal(await taskCount(), before, 'nothing created');
  const good = await executeActionDirect('create_task', { title: `defty ok ${run}`, resolved_project_id: project, project_name: projectName, priority: 'p3' }, org, owner, null, 'quick');
  assert.equal(good.success, true, JSON.stringify(good));
  const { rows } = await c.query(`SELECT priority FROM tasks WHERE org_id = $1 AND title = $2`, [org, `defty ok ${run}`]);
  assert.equal(rows[0]?.priority, 'p3');
});

test('Defty set_priority and bulk_update_tasks: an unknown priority fails; a valid one is written', async () => {
  await resetPriorities();
  const bad = await executeActionDirect('set_priority', { task_identifier: existing, priority: 'urgent' }, org, owner, null, 'quick');
  assert.equal(bad.success, false, JSON.stringify(bad));
  const badBulk = await executeActionDirect('bulk_update_tasks', { task_identifiers: [`${prefix}-1`, `${prefix}-2`], updates: { priority: 'urgent' } }, org, owner, null, 'quick');
  assert.equal(badBulk.success, false, JSON.stringify(badBulk));
  assert.equal(await priorityOf(existing), 'p2');
  const good = await executeActionDirect('set_priority', { task_identifier: existing, priority: 'p1' }, org, owner, null, 'quick');
  assert.equal(good.success, true, JSON.stringify(good));
  assert.equal(await priorityOf(existing), 'p1');
});

// ── Status: the same rule, from the task_status enum ──────────────────

async function statusOf(id: string) {
  const { rows } = await c.query(`SELECT status FROM tasks WHERE id = $1`, [id]);
  return rows[0]?.status as string | undefined;
}

for (const [name, path, body] of REST_CREATES) {
  test(`${name}: an unknown status is 400 VALIDATION_ERROR and creates nothing; a valid or null one works`, async () => {
    const before = await taskCount();
    for (const status of ['open', 'DONE', '']) {
      const res = await call('POST', path, { ...body('p1'), status });
      assert.equal(res.status, 400, `${name} status ${JSON.stringify(status)}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body?.code, 'VALIDATION_ERROR');
    }
    assert.equal(await taskCount(), before, 'nothing created');
    const valid = await call('POST', path, { ...body('p1'), status: 'todo' });
    assert.equal(valid.status, 201, JSON.stringify(valid.body));
    assert.equal(valid.body.status, 'todo');
    const nulled = await call('POST', path, { ...body('p1'), status: null });
    assert.equal(nulled.status, 201, JSON.stringify(nulled.body));
    assert.equal(nulled.body.status, 'backlog');
  });
}

test('PATCH /api/tasks/:id and /api/tasks/bulk: an unknown status is a 400', async () => {
  const one = await call('PATCH', `/api/tasks/${existing}`, { status: 'open' });
  assert.equal(one.status, 400, JSON.stringify(one.body));
  const bulk = await call('PATCH', '/api/tasks/bulk', { task_ids: [existing, other], updates: { status: 'open' } });
  assert.equal(bulk.status, 400, JSON.stringify(bulk.body));
  assert.equal(bulk.body?.code, 'VALIDATION_ERROR');
  assert.equal(await statusOf(existing), 'todo');
});

test('MCP task_update (personal and agent employee): an unknown status is a tool error', async () => {
  const personal = await humanTaskUpdate({ task_id: existing, patch: { status: 'open' } }, human);
  assert.equal(personal.isError, true, text(personal));
  const employee = await taskUpdate({ caller_employee_slug: employeeSlug, task_id: existing, patch: { status: 'open' } } as any, byoa());
  assert.equal(employee.isError, true, text(employee));
  assert.equal(await statusOf(existing), 'todo');
});

test('Defty update_task_status: an unknown status fails with a validation message; a valid one is written', async () => {
  const bad = await executeActionDirect('update_task_status', { resolved_task_id: other, new_status: 'open' }, org, owner, null, 'quick');
  assert.equal(bad.success, false, JSON.stringify(bad));
  assert.match(String(bad.error), /status must be one of/);
  assert.equal(await statusOf(other), 'todo');
  const good = await executeActionDirect('update_task_status', { resolved_task_id: other, new_status: 'in_progress' }, org, owner, null, 'quick');
  assert.equal(good.success, true, JSON.stringify(good));
  assert.equal(await statusOf(other), 'in_progress');
  await c.query(`UPDATE tasks SET status = 'todo' WHERE id = $1`, [other]);
});
