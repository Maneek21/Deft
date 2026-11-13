import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const otherOrgId = randomUUID();
const ids = { owner: randomUUID(), admin: randomUUID(), source: randomUUID(), other: randomUUID(), guest: randomUUID() };
const roles: Record<string, 'owner' | 'admin' | 'member' | 'guest'> = {
  [ids.owner]: 'owner', [ids.admin]: 'admin', [ids.source]: 'member', [ids.other]: 'member', [ids.guest]: 'guest',
};
const projectId = randomUUID();
const taskId = randomUUID();
const ruleId = randomUUID();
let client: pg.Client | undefined;
const unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;
let routes: Hono;

async function request(viewerId: string, id = ruleId, tenantId = orgId) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: viewerId, org_id: tenantId, email: `${viewerId}@example.test`, role: roles[viewerId] } as any);
    await next();
  });
  hono.route('/api/workflows', routes);
  return hono.request(`/api/workflows/${id}/runs`);
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  // A configured test database that cannot be reached fails the suite instead of skipping it.
  await client.connect();
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Workflow audience', `workflow-audience-${orgId}`]);
  for (const [name, id] of Object.entries(ids)) {
    await client.query('INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,\'human\',false)', [id, `${id}@example.test`, name]);
    await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, id, roles[id]]);
  }
  await client.query('INSERT INTO projects(id,org_id,name,prefix,lead_id) VALUES($1,$2,\'Workflow audience\',$3,$4)', [projectId, orgId, `WF${orgId.slice(0, 8)}`, ids.source]);
  await client.query(`INSERT INTO tasks(id,org_id,project_id,number,title,status,priority,created_by,metadata)
    VALUES($1,$2,$3,1,'Source task','todo','p2',$4,'{"visibility":"restricted"}')`, [taskId, orgId, projectId, ids.source]);
  await client.query(`INSERT INTO workflow_rules(id,org_id,name,trigger_type,trigger_config,action_type,action_config,created_by)
    VALUES($1,$2,'Audience rule','task.status_changed','{}','add_comment','{"template":"hello"}',$3)`, [ruleId, orgId, ids.source]);
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [otherOrgId, 'Other workflow org', 'other-workflow-' + otherOrgId]);
  await client.query("INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'owner')", [randomUUID(), otherOrgId, ids.owner]);
  routes = (await import('../src/routes/workflows.js')).workflowRoutes;
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    await client.query('DELETE FROM workflow_runs WHERE rule_id=$1', [ruleId]);
    await client.query('DELETE FROM workflow_rules WHERE id=$1', [ruleId]);
    await client.query('DELETE FROM task_watchers WHERE task_id=$1', [taskId]);
    await client.query('DELETE FROM task_comments WHERE task_id=$1', [taskId]);
    await client.query('DELETE FROM tasks WHERE id=$1', [taskId]);
    await client.query('DELETE FROM projects WHERE id=$1', [projectId]);
    await client.query('DELETE FROM org_members WHERE org_id=ANY($1::text[])', [[orgId, otherOrgId]]);
    await client.query('DELETE FROM orgs WHERE id=ANY($1::text[])', [[orgId, otherOrgId]]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(ids)]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

async function insertRun(source: string | null) {
  const id = randomUUID();
  await client!.query(`INSERT INTO workflow_runs(id,rule_id,triggered_by_user_id,status,result)
    VALUES($1,$2,$3,'failed',$4)`, [id, ruleId, ids.source, JSON.stringify({
    task_id: source, detail: 'CANARY-TASK-CONTENT',
    actions: [{ kind: 'add_comment', ok: false, error: 'CANARY-ERROR', nested: { title: 'CANARY-NESTED' } }],
  })]);
  return id;
}

async function readRun(viewer: string, id: string) {
  const response = await request(viewer);
  assert.equal(response.status, 200);
  const rows = await response.json() as Array<{ id: string; status: string; executed_at: string; triggered_by_user_id: string; result: Record<string, unknown> }>;
  const row = rows.find((run) => run.id === id);
  assert.ok(row, 'the run is listed');
  assert.equal(row.status, 'failed');
  assert.ok(row.executed_at);
  assert.equal(row.triggered_by_user_id, ids.source);
  return row;
}

test('workflow execution details follow the source task audience', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const id = await insertRun(taskId);
  for (const viewer of [ids.owner, ids.admin, ids.source]) {
    assert.ok(JSON.stringify(await readRun(viewer, id)).includes('CANARY-ERROR'));
  }
  for (const viewer of [ids.other, ids.guest]) {
    const row = await readRun(viewer, id);
    assert.deepEqual(row.result, { actions: [{ kind: 'add_comment', ok: false }] });
    assert.equal(JSON.stringify(row).includes('CANARY'), false);
  }
  await client!.query('INSERT INTO task_watchers(id,task_id,user_id) VALUES($1,$2,$3)', [randomUUID(), taskId, ids.guest]);
  assert.ok(JSON.stringify(await readRun(ids.guest, id)).includes('CANARY-ERROR'));
  await client!.query('DELETE FROM task_watchers WHERE task_id=$1', [taskId]);
  assert.deepEqual((await readRun(ids.guest, id)).result, { actions: [{ kind: 'add_comment', ok: false }] });
});

test('unresolved source tasks reserve execution detail for owners and admins', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const source of [null, randomUUID()]) {
    const id = await insertRun(source);
    for (const viewer of Object.values(ids)) {
      assert.equal(JSON.stringify(await readRun(viewer, id)).includes('CANARY-ERROR'), [ids.owner, ids.admin].includes(viewer));
    }
  }
  const id = await insertRun(taskId);
  await client!.query('UPDATE tasks SET is_deleted=true WHERE id=$1', [taskId]);
  assert.equal(JSON.stringify(await readRun(ids.source, id)).includes('CANARY'), false);
  await client!.query('UPDATE tasks SET is_deleted=false WHERE id=$1', [taskId]);
  assert.equal((await request(ids.owner, randomUUID())).status, 404);
  assert.equal((await request(ids.owner, ruleId, otherOrgId)).status, 404);
});

test('workflow worker records a bounded classified execution error', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { handleWorkflowExecute } = await import('../src/workers/handlers/workflow-execute.js');
  const missingAssignee = randomUUID();
  await client!.query('UPDATE workflow_rules SET action_type=\'assign_to\',action_config=$1 WHERE id=$2', [JSON.stringify({ user_id: missingAssignee }), ruleId]);
  await handleWorkflowExecute({ id: randomUUID(), name: 'workflow-execute', attempts: 1,
    data: { workflow_id: ruleId, task_id: taskId, actor_user_id: ids.source, org_id: orgId } });
  const { rows } = await client!.query("SELECT result FROM workflow_runs WHERE rule_id=$1 AND result->'actions'->0->>'code'='WORKFLOW_ACTION_FAILED'", [ruleId]);
  assert.equal(rows.length, 1);
  const action = rows[0].result.actions[0];
  assert.equal(action.ok, false);
  assert.equal(action.code, 'WORKFLOW_ACTION_FAILED');
  assert.equal(typeof action.error, 'string');
  assert.ok(action.error.length > 0 && action.error.length <= 300, action.error);
});
