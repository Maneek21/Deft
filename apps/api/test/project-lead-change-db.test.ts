// A project's lead reads every task in it, restricted ones included
// (lib/task-visibility.ts). So changing an existing project's lead needs an
// owner, an admin or the current lead (lib/project-lead.ts), on
// PATCH /api/projects/:id and MCP project_update; a guest never may. Setting
// a lead at creation is unchanged. A workflow rule's assign_to never names
// someone on a task they may not already see, whoever wrote or edited it.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { taskRoutes } from '../src/routes/tasks.js';
import { projectRoutes } from '../src/routes/projects.js';
import { humanProjectUpdate, type HumanToolContext } from '../src/lib/mcp-tools/human.js';
import { handleWorkflowExecute } from '../src/workers/handlers/workflow-execute.js';
import { and, eq } from 'drizzle-orm';
import { projects } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { leadChangeWriteCondition } from '../src/lib/project-lead.js';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
const run = randomUUID().slice(0, 8);
const org = randomUUID();
const owner = randomUUID(), admin = randomUUID(), member = randomUUID(), lead = randomUUID(), named = randomUUID(), guest = randomUUID();
const people: Array<[string, string, string]> = [
  [owner, 'Pia Owner', 'owner'], [admin, 'Pax Admin', 'admin'], [member, 'Pim Member', 'member'],
  [lead, 'Pel Lead', 'member'], [named, 'Pen Named', 'member'], [guest, 'Pug Guest', 'guest'],
];
const ALL = people.map(([id]) => id);
const who = (id: string) => people.find(([p]) => p === id)![1];
const room = randomUUID(), project = randomUUID(), restricted = randomUUID(), open = randomUUID();
// A project the guest does not belong to, with an unrestricted task.
const outside = randomUUID(), outsideTask = randomUUID();
const prefix = `L${run.slice(0, 4).toUpperCase()}`;

before(async () => {
  await c.connect();
  await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Project Lead', $2)`, [org, `project-lead-${run}`]);
  for (const [id, name, role] of people) {
    await c.query(`INSERT INTO users (id, email, name, kind, is_agent, password_hash) VALUES ($1, $2, $3, 'human', false, 'hash')`,
      [id, `plc-${run}-${role}-${id.slice(0, 4)}@test.local`, `${name} ${run}`]);
    await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, true)`, [org, id, role]);
  }
  await c.query(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, 'plc room', 'private', $3)`, [room, org, owner]);
  for (const id of ALL) await c.query(`INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [room, id]);
  await c.query(`INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES ($1, $2, 'plc project', $3, $4, 10)`, [project, org, prefix, lead]);
  await c.query(`INSERT INTO project_spaces (id, project_id, space_id) VALUES (gen_random_uuid()::text, $1, $2)`, [project, room]);
  await c.query(`INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES ($1, $2, 'plc outside', $3, NULL, 10)`,
    [outside, org, `O${run.slice(0, 4).toUpperCase()}`]);
  await c.query(`INSERT INTO tasks (id, org_id, project_id, number, title, created_by, status) VALUES ($1, $2, $3, 1, $4, $5, 'todo')`,
    [outsideTask, org, outside, `plc-${run}-outside`, owner]);
  await c.query(`INSERT INTO tasks (id, org_id, project_id, number, title, created_by, metadata, status) VALUES
      ($1, $3, $4, 1, $5, $6, $7, 'todo'), ($2, $3, $4, 2, $8, $6, NULL, 'todo')`,
  [restricted, open, org, project, `plc-${run}-restricted`, owner, JSON.stringify({ visibility: 'restricted', visible_user_ids: [named] }), `plc-${run}-open`]);
});

after(async () => {
  await c.query(`DELETE FROM notifications WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM job_queue WHERE org_id = $1`, [org]).catch(() => {});
  await c.query(`DELETE FROM idempotency_keys WHERE user_id = ANY($1::text[])`, [ALL]).catch(() => {});
  await c.query(`DELETE FROM oauth_audit_events WHERE org_id = $1`, [org]).catch(() => {});
  await c.query(`DELETE FROM workflow_runs WHERE rule_id IN (SELECT id FROM workflow_rules WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM workflow_rules WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM task_comments WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM task_activity WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM tasks WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM project_spaces WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM projects WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM messages WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)`, [org]);
  await c.query(`DELETE FROM spaces WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM org_members WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [ALL]);
  await c.query(`DELETE FROM orgs WHERE id = $1`, [org]);
  await c.end();
});

function app(viewer: string) {
  const role = people.find(([id]) => id === viewer)![2];
  const hono = new Hono();
  hono.use('*', async (ctx, next) => {
    // Every session claims 'admin': only org_members decides (lib/project-lead.ts).
    ctx.set('user', { id: viewer, org_id: org, email: `plc-${run}@test.local`, sid: 's', role: role === 'guest' ? 'member' : 'admin' } as never);
    await next();
  });
  hono.route('/api/tasks', taskRoutes);
  hono.route('/api/projects', projectRoutes);
  return hono;
}

async function call(viewer: string, path: string, init?: { method: string; body?: unknown }) {
  const res = await app(viewer).request(path, init ? {
    method: init.method, headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  } : undefined);
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body };
}
const patchLead = (viewer: string, leadId: string | null) => call(viewer, `/api/projects/${project}`, { method: 'PATCH', body: { lead_id: leadId } });
const currentLead = async () => (await c.query(`SELECT lead_id FROM projects WHERE id = $1`, [project])).rows[0].lead_id as string | null;
const setLead = (id: string | null) => c.query(`UPDATE projects SET lead_id = $2 WHERE id = $1`, [project, id]);
const mcp = (viewer: string): HumanToolContext => ({
  org_id: org, user_id: viewer, role: people.find(([id]) => id === viewer)![2] as HumanToolContext['role'], scopes: ['write:workspace'],
});

test('PATCH /api/projects/:id: a member who does not lead the project cannot change its lead, to themselves, another or none', async () => {
  assert.equal((await call(member, `/api/tasks/${restricted}`)).status, 404, 'the member cannot read the restricted task');
  for (const target of [member, named, null]) {
    const res = await patchLead(member, target);
    assert.equal(res.status, 403, `member sets lead to ${target === null ? 'none' : who(target)}`);
    assert.equal(res.body.code, 'FORBIDDEN');
    assert.equal(await currentLead(), lead, 'the lead is unchanged');
  }
  assert.equal((await call(member, `/api/tasks/${restricted}`)).status, 404, 'the member still cannot read it');
  // A project with no lead: a member who leads nothing cannot give it one.
  const noLead = await call(member, `/api/projects/${outside}`, { method: 'PATCH', body: { lead_id: member } });
  assert.equal(noLead.status, 403, 'member gives a lead to a project with none');
  assert.equal((await c.query(`SELECT lead_id FROM projects WHERE id = $1`, [outside])).rows[0].lead_id, null);
  const guestRes = await patchLead(guest, guest);
  assert.equal(guestRes.status, 403);
  assert.equal(guestRes.body.code, 'FORBIDDEN');
  assert.equal(await currentLead(), lead);
});

test('PATCH /api/projects/:id: the owner, an admin and the current lead can change the lead; other edits and an unchanged lead are not refused', async () => {
  for (const actor of [owner, admin]) {
    const res = await patchLead(actor, member);
    assert.equal(res.status, 200, who(actor));
    assert.equal(await currentLead(), member);
    await setLead(lead);
  }
  const handOver = await patchLead(lead, named);
  assert.equal(handOver.status, 200, 'the current lead hands over');
  assert.equal(await currentLead(), named);
  await setLead(lead);
  const same = await patchLead(member, lead);
  assert.equal(same.status, 200, 'naming the current lead again is no change');
  const rename = await call(member, `/api/projects/${project}`, { method: 'PATCH', body: { name: `plc project ${run}` } });
  assert.equal(rename.status, 200, 'a member may still edit other fields');
  assert.equal(await currentLead(), lead);
});

test('a current lead who is no longer an active member cannot change the lead', async () => {
  await c.query(`UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2`, [org, lead]);
  try {
    const res = await patchLead(lead, named);
    assert.equal(res.status, 403);
    assert.equal(await currentLead(), lead);
  } finally {
    await c.query(`UPDATE org_members SET is_active = true WHERE org_id = $1 AND user_id = $2`, [org, lead]);
  }
});

test('MCP project_update follows the same rule', async () => {
  for (const target of [member, null, randomUUID()]) {
    const res = await humanProjectUpdate({ project_id: project, lead_id: target }, mcp(member)) as any;
    assert.equal(res.isError, true, `member sets lead to ${target ?? 'none'}`);
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.code, 'FORBIDDEN', 'refused before the new lead is looked up, with its code');
    assert.match(body.error, /owner, an admin or the project lead/);
    assert.equal(await currentLead(), lead);
  }
  const same = await humanProjectUpdate({ project_id: project, lead_id: ` ${lead} `, name: `plc mcp ${run}` }, mcp(member)) as any;
  assert.notEqual(same.isError, true, 'naming the current lead again (with spaces) is no change');
  const blank = await humanProjectUpdate({ project_id: outside, lead_id: '', name: `plc outside ${run}` }, mcp(member)) as any;
  assert.notEqual(blank.isError, true, 'a blank lead on a project with none is no change');
  const guestRes = await humanProjectUpdate({ project_id: project, lead_id: guest }, mcp(guest)) as any;
  assert.equal(guestRes.isError, true);
  assert.equal(JSON.parse(guestRes.content[0].text).code, 'FORBIDDEN', 'a guest refusal carries its code');
  for (const actor of [owner, admin, lead]) {
    const res = await humanProjectUpdate({ project_id: project, lead_id: named }, mcp(actor)) as any;
    assert.notEqual(res.isError, true, who(actor));
    assert.equal(await currentLead(), named);
    await setLead(lead);
  }
});

test('a workflow assign_to never assigns a task to someone who may not already see it, whoever wrote or edited the rule', async () => {
  const rule = randomUUID();
  const runRule = async (assignee: string, task: string) => {
    await c.query(`UPDATE workflow_rules SET action_config = $2 WHERE id = $1`, [rule, JSON.stringify({ actions: [{ kind: 'assign_to', user_id: assignee }] })]);
    await handleWorkflowExecute({ id: randomUUID(), name: 'workflow-execute', attempts: 0, data: { workflow_id: rule, task_id: task, actor_user_id: member, org_id: org } });
    return (await c.query(`SELECT assignee_id FROM tasks WHERE id = $1`, [task])).rows[0].assignee_id as string | null;
  };
  // Written by the member, and (the same rule) as if written by the owner and edited by the member.
  for (const author of [member, owner]) {
    await c.query(`DELETE FROM workflow_runs WHERE rule_id = $1`, [rule]);
    await c.query(`DELETE FROM workflow_rules WHERE id = $1`, [rule]);
    await c.query(`INSERT INTO workflow_rules (id, org_id, name, trigger_type, trigger_config, action_type, action_config, created_by)
      VALUES ($1, $2, 'plc assign', 'task.status_changed', '{}'::jsonb, 'assign_to', '{}'::jsonb, $3)`, [rule, org, author]);
    assert.equal(await runRule(member, restricted), null, `rule by ${who(author)}: the restricted task is not assigned to the member`);
    assert.equal((await call(member, `/api/tasks/${restricted}`)).status, 404, 'the member still cannot read it');
    assert.equal(await runRule(named, restricted), named, `rule by ${who(author)}: assigned to someone it names`);
    await c.query(`UPDATE tasks SET assignee_id = NULL WHERE id = $1`, [restricted]);
    assert.equal(await runRule(member, open), member, `rule by ${who(author)}: an unrestricted task is assigned as before`);
    await c.query(`UPDATE tasks SET assignee_id = NULL WHERE id = $1`, [open]);
    assert.equal(await runRule(guest, outsideTask), guest, `rule by ${who(author)}: an unrestricted task is still assigned to a guest outside its project`);
    await c.query(`UPDATE tasks SET assignee_id = NULL WHERE id = $1`, [outsideTask]);
  }
});

test('PATCH /api/projects/:id: the new lead must be an active member of the workspace', async () => {
  const res = await patchLead(owner, randomUUID());
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.equal(await currentLead(), lead);
  // A blank id means no lead: a member is refused, as for null; the owner clears it.
  const blankByMember = await call(member, `/api/projects/${project}`, { method: 'PATCH', body: { lead_id: '' } });
  assert.equal(blankByMember.status, 403);
  const blankByOwner = await call(owner, `/api/projects/${project}`, { method: 'PATCH', body: { lead_id: '' } });
  assert.equal(blankByOwner.status, 200);
  assert.equal(await currentLead(), null);
  await setLead(lead);
});

test('the lead write itself carries the authority: it applies only for an active owner, admin or current lead, and only while the lead is unchanged', async () => {
  const write = async (actor: string, expected: string | null, next: string) => (await db.update(projects).set({ lead_id: next })
    .where(and(eq(projects.id, project), leadChangeWriteCondition(org, actor, expected))).returning({ id: projects.id })).length;
  assert.equal(await write(member, lead, member), 0, 'a member who does not lead');
  assert.equal(await write(admin, named, member), 0, 'an admin against a lead that changed meanwhile');
  await c.query(`UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [org, admin]);
  try {
    assert.equal(await write(admin, lead, member), 0, 'an admin demoted before the write');
  } finally {
    await c.query(`UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [org, admin]);
  }
  assert.equal(await currentLead(), lead);
  assert.equal(await write(lead, lead, named), 1, 'the current lead hands over');
  assert.equal(await write(admin, named, lead), 1, 'an admin puts it back');
  assert.equal(await currentLead(), lead);
});
