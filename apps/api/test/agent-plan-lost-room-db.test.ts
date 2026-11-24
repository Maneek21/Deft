// Check 13 (DFX3): a Defty plan made in a room its creator later lost —
// removed, left, or removed from the workspace — leaves their plan list and
// views, cannot be edited, approved, run or resumed by them, and an owner or
// admin cannot run it on their behalf. A run already approved stops before
// its next step. Plans from rooms the creator keeps are unchanged.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
const orgId = randomUUID();
const ids = { mia: randomUUID(), olive: randomUUID(), adam: randomUUID(), rita: randomUUID() };
const roles: Record<string, string> = { [ids.mia]: 'member', [ids.olive]: 'owner', [ids.adam]: 'admin', [ids.rita]: 'member' };
const rooms = { lost: randomUUID(), kept: randomUUID(), team: randomUUID(), race: randomUUID(), msgOnly: randomUUID(), pubArc: randomUUID() };
const projectId = randomUUID();
const plans = {
  lostDraft: randomUUID(), lostByMessage: randomUUID(), lostApproved: randomUUID(),
  kept: randomUUID(), departedPaused: randomUUID(), departedApproved: randomUUID(),
  reserved: randomUUID(), raceApproved: randomUUID(),
  twoRooms: randomUUID(), parent: randomUUID(), child: randomUUID(), oddBinding: randomUUID(), archiveRace: randomUUID(),
};
const title = (plan: string) => `Plan task ${plan}`;
let client: pg.Client | undefined;
let seeded = false;
let routes: { plans?: Hono; spaces?: Hono; members?: Hono; agent?: Hono; inbox?: Hono } = {};
const departedStepAction = randomUUID();
const twoRoomsStep = randomUUID();

function app(viewer: string) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: viewer, org_id: orgId, email: `${viewer}@example.test`, role: roles[viewer] } as any);
    await next();
  });
  hono.route('/api/agent-plans', routes.plans!);
  hono.route('/api/spaces', routes.spaces!);
  hono.route('/api/members', routes.members!);
  hono.route('/api/agent', routes.agent!);
  hono.route('/api/inbox', routes.inbox!);
  return hono;
}

async function call(viewer: string, method: string, path: string, body?: unknown) {
  const response = await app(viewer).request(path, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
}

async function listedPlans(viewer: string): Promise<string[]> {
  const { status, text } = await call(viewer, 'GET', '/api/agent-plans');
  assert.equal(status, 200, text);
  return (JSON.parse(text) as Array<{ id: string }>).map((plan) => plan.id);
}

async function tasksCreated(plan: string): Promise<number> {
  const { rows } = await client!.query('SELECT count(*)::int AS n FROM tasks WHERE org_id=$1 AND title=$2', [orgId, title(plan)]);
  return rows[0].n;
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await client.connect();
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Lost room plans', `lost-room-plans-${orgId}`]);
  seeded = true;
  for (const [name, id] of Object.entries(ids)) {
    await client.query("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,'human',false)", [id, `${id}@example.test`, name]);
    await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, id, roles[id]]);
  }
  for (const room of Object.values(rooms)) {
    const type = room === rooms.pubArc ? 'public' : 'private';
    await client.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,$4,$5)', [room, orgId, `room-${room.slice(0, 8)}`, type, ids.olive]);
    for (const user of room === rooms.pubArc ? [ids.olive, ids.adam] : Object.values(ids)) {
      await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), room, user]);
    }
  }
  await client.query('INSERT INTO projects(id,org_id,name,prefix,lead_id) VALUES($1,$2,$3,$4,$5)',
    [projectId, orgId, 'Lost room plans', `LP${orgId.slice(0, 4).toUpperCase()}`, ids.olive]);
  const message = randomUUID();
  await client.query("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'@Defty plan this')", [message, orgId, rooms.lost, ids.mia]);
  const insertPlan = async (id: string, creator: string, status: string, room: string | null, context: object = {}) => {
    await client!.query(`INSERT INTO agent_plans(id,org_id,user_id,conversation_id,title,steps,status,current_step,context)
      VALUES($1,$2,$3,$4,'Lost room plan',$5::jsonb,$6,0,$7::jsonb)`, [id, orgId, creator, room, JSON.stringify([
      { id: 'step-1', tool: 'create_task', params: { title: title(id), resolved_project_id: projectId, priority: 'p2' }, status: 'pending' },
    ]), status, JSON.stringify(context)]);
  };
  await insertPlan(plans.lostDraft, ids.mia, 'draft', rooms.lost);
  await insertPlan(plans.lostByMessage, ids.mia, 'draft', null, { source_message_id: message });
  await insertPlan(plans.lostApproved, ids.mia, 'approved', rooms.lost);
  await insertPlan(plans.kept, ids.mia, 'draft', rooms.kept);
  await insertPlan(plans.departedPaused, ids.rita, 'paused', rooms.team);
  await insertPlan(plans.departedApproved, ids.rita, 'approved', rooms.team);
  await insertPlan(plans.raceApproved, ids.mia, 'approved', rooms.race);
  // A plan in a room Mia keeps whose source message is in another room; its finished step's row names only the first.
  const twoRoomsMessage = randomUUID();
  await client.query("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'@Defty plan across rooms')", [twoRoomsMessage, orgId, rooms.msgOnly, ids.mia]);
  await insertPlan(plans.twoRooms, ids.mia, 'completed', rooms.kept, { source_message_id: twoRoomsMessage });
  await client.query(`INSERT INTO agent_actions(id,org_id,user_id,conversation_id,source,plan_id,plan_step_id,action,params,approval_tier,approval_status,executed_at)
    VALUES($1,$2,$3,$4,'plan',$5,'step-1','create_task',$6,'quick','approved',now())`, [
    twoRoomsStep, orgId, ids.mia, rooms.kept, plans.twoRooms, JSON.stringify({ title: 'CANARY-two-rooms', resolved_project_id: projectId }),
  ]);
  // A source binding that is not a string fails closed.
  await insertPlan(plans.oddBinding, ids.mia, 'draft', null, { source_message_id: { result: 'overwritten' } });
  // A plan in a public room Mia reads without joining.
  await insertPlan(plans.archiveRace, ids.mia, 'approved', rooms.pubArc);
  // A step whose id is a reserved context key.
  await client.query(`INSERT INTO agent_plans(id,org_id,user_id,conversation_id,title,steps,status,current_step,context)
    VALUES($1,$2,$3,$4,'Reserved step',$5::jsonb,'approved',0,'{}'::jsonb)`, [plans.reserved, orgId, ids.mia, rooms.kept, JSON.stringify([
    { id: 'source_message_id', tool: 'create_task', params: { title: title(plans.reserved), resolved_project_id: projectId, priority: 'p2' }, status: 'pending' },
  ])]);
  // A step of Rita's paused plan waiting for approval; its row names no room (only the plan does).
  await client.query(`INSERT INTO agent_actions(id,org_id,user_id,source,plan_id,plan_step_id,action,params,approval_tier,approval_status)
    VALUES($1,$2,$3,'plan',$4,'step-1','create_task',$5,'quick','pending')`, [
    departedStepAction, orgId, ids.rita, plans.departedPaused,
    JSON.stringify({ title: title(plans.departedPaused), resolved_project_id: projectId, priority: 'p2' }),
  ]);
  routes = {
    plans: (await import('../src/routes/agent-plans.js')).agentPlanRoutes,
    spaces: (await import('../src/routes/spaces.js')).spaceRoutes,
    members: (await import('../src/routes/members.js')).memberRoutes,
    agent: (await import('../src/routes/agent.js')).agentRoutes,
    inbox: (await import('../src/routes/inbox.js')).inboxRoutes,
  };
});

after(async () => {
  try {
    if (seeded && client) {
      await client.query('DELETE FROM job_queue WHERE payload::text LIKE $1', [`%${orgId}%`]).catch(() => {});
      for (const table of ['agent_actions', 'action_receipts', 'tasks', 'agent_plans', 'projects', 'messages', 'agent_employees']) {
        await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]).catch(() => {});
      }
      await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
      for (const table of ['spaces', 'org_members']) await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
      await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
      await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(ids)]);
    }
  } finally {
    await client?.end();
    await closeDb();
  }
});

test('a plan from a room its creator lost leaves their views and cannot be edited, approved, run or resumed', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const before = await listedPlans(ids.mia);
  for (const plan of [plans.lostDraft, plans.lostByMessage, plans.lostApproved, plans.kept]) assert.ok(before.includes(plan), 'listed while a member');
  assert.equal((await call(ids.mia, 'GET', `/api/agent-plans/${plans.lostDraft}`)).status, 200);

  const removed = await call(ids.olive, 'DELETE', `/api/spaces/${rooms.lost}/members/${ids.mia}`);
  assert.equal(removed.status, 200, removed.text);

  const after = await listedPlans(ids.mia);
  for (const plan of [plans.lostDraft, plans.lostByMessage, plans.lostApproved]) assert.ok(!after.includes(plan), 'gone from the list');
  assert.ok(after.includes(plans.kept), 'a plan from a room she keeps stays');
  for (const plan of [plans.lostDraft, plans.lostByMessage]) {
    assert.equal((await call(ids.mia, 'GET', `/api/agent-plans/${plan}`)).status, 404, 'read');
    assert.equal((await call(ids.mia, 'PUT', `/api/agent-plans/${plan}`, { title: 'Edited' })).status, 404, 'edit');
    for (const action of ['approve', 'execute', 'resume']) {
      assert.equal((await call(ids.mia, 'POST', `/api/agent-plans/${plan}/${action}`)).status, 404, `${action} by the creator`);
      assert.equal((await call(ids.olive, 'POST', `/api/agent-plans/${plan}/${action}`)).status, 404, `${action} by an owner`);
    }
  }
  // A plan from a room she keeps: unchanged.
  assert.equal((await call(ids.mia, 'GET', `/api/agent-plans/${plans.kept}`)).status, 200);
  assert.equal((await call(ids.mia, 'POST', `/api/agent-plans/${plans.kept}/approve`)).status, 200);
  // Stopping stays possible, and shows nothing of the plan.
  const aborted = await call(ids.mia, 'POST', `/api/agent-plans/${plans.lostDraft}/abort`);
  assert.equal(aborted.status, 200, aborted.text);
  assert.deepEqual(JSON.parse(aborted.text), { id: plans.lostDraft, status: 'failed' });
});

test('a run approved before the loss stops before its next step', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { executePlan, PLAN_ROOM_LOST_ERROR } = await import('../src/lib/agent-plans.js');
  // Independent of the test before: Mia is out of the room.
  await client!.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [rooms.lost, ids.mia]);
  await executePlan(plans.lostApproved, orgId, ids.mia);
  assert.equal(await tasksCreated(plans.lostApproved), 0, 'no step ran');
  const { rows: [plan] } = await client!.query('SELECT status, error FROM agent_plans WHERE id=$1', [plans.lostApproved]);
  assert.deepEqual(plan, { status: 'paused', error: PLAN_ROOM_LOST_ERROR });
});

test('an owner or admin cannot run a departed member\'s plan for them', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const gone = await call(ids.olive, 'DELETE', `/api/members/${ids.rita}`);
  assert.equal(gone.status, 200, gone.text);
  for (const viewer of [ids.olive, ids.adam]) {
    for (const action of ['approve', 'execute', 'resume']) {
      assert.equal((await call(viewer, 'POST', `/api/agent-plans/${plans.departedPaused}/${action}`)).status, 404, `${action} by ${roles[viewer]}`);
    }
  }
  // Rita's plan step waiting for approval: closed with the removal, and an owner cannot approve it.
  for (const viewer of [ids.olive, ids.adam]) {
    const refused = await call(viewer, 'POST', `/api/agent/actions/${departedStepAction}/approve`);
    assert.notEqual(refused.status, 200, refused.text);
  }
  const { rows: [step] } = await client!.query('SELECT approval_status FROM agent_actions WHERE id=$1', [departedStepAction]);
  assert.equal(step.approval_status, 'expired');
  assert.equal(await tasksCreated(plans.departedPaused), 0, 'the step never ran');
  const { executePlan } = await import('../src/lib/agent-plans.js');
  await executePlan(plans.departedApproved, orgId, ids.rita);
  assert.equal(await tasksCreated(plans.departedApproved), 0, 'the queued run creates nothing');
});

test('a step whose id is a reserved context key never runs', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { executePlan } = await import('../src/lib/agent-plans.js');
  await executePlan(plans.reserved, orgId, ids.mia);
  assert.equal(await tasksCreated(plans.reserved), 0);
  const { rows: [plan] } = await client!.query('SELECT status, error, context FROM agent_plans WHERE id=$1', [plans.reserved]);
  assert.equal(plan.status, 'paused');
  assert.match(plan.error, /reserved/);
  assert.deepEqual(plan.context, {}, 'the context keeps no step result under a reserved key');
});

test('a step waits for a loss in progress and then does not run', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { executePlan, PLAN_ROOM_LOST_ERROR } = await import('../src/lib/agent-plans.js');
  const holder = new pg.Client({ connectionString: url });
  await holder.connect();
  try {
    // Mia is being removed from the room: her room-access lock, then the removal, uncommitted.
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`deft-room-access:${orgId}:${ids.mia}`]);
    await holder.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [rooms.race, ids.mia]);
    const { rows: [{ pid }] } = await holder.query('SELECT pg_backend_pid() AS pid');
    const run = executePlan(plans.raceApproved, orgId, ids.mia);
    let waiting = false;
    for (let attempt = 0; attempt < 200 && !waiting; attempt += 1) {
      const { rows: [row] } = await client!.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid]);
      waiting = row.n > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(waiting, 'the step waited for the loss');
    await holder.query('COMMIT');
    await run;
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    await holder.end();
  }
  assert.equal(await tasksCreated(plans.raceApproved), 0, 'the step did not run');
  const { rows: [plan] } = await client!.query('SELECT status, error FROM agent_plans WHERE id=$1', [plans.raceApproved]);
  assert.deepEqual(plan, { status: 'paused', error: PLAN_ROOM_LOST_ERROR });
});

test('a plan step whose own row omits a room of its plan leaves the member action history with that room', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const history = async () => (await call(ids.mia, 'GET', '/api/agent/actions?limit=200')).text;
  assert.ok((await history()).includes(twoRoomsStep), 'visible while she has both rooms');
  const removed = await call(ids.olive, 'DELETE', `/api/spaces/${rooms.msgOnly}/members/${ids.mia}`);
  assert.equal(removed.status, 200, removed.text);
  const after = await history();
  assert.ok(!after.includes(twoRoomsStep) && !after.includes('CANARY-two-rooms'), 'hidden once she lost the source room');
  assert.equal((await call(ids.mia, 'GET', `/api/agent-plans/${plans.twoRooms}`)).status, 404);
});

test('a plan whose source binding is not a string fails closed', async (t) => {
  if (unavailable) return t.skip(unavailable);
  assert.equal((await call(ids.mia, 'GET', `/api/agent-plans/${plans.oddBinding}`)).status, 404);
});

test('a step claim waits for an archive of its public room in progress, then the step does not run', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { executePlan, PLAN_ROOM_LOST_ERROR } = await import('../src/lib/agent-plans.js');
  const holder = new pg.Client({ connectionString: url });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('UPDATE spaces SET is_archived=true WHERE id=$1', [rooms.pubArc]);
    const { rows: [{ pid }] } = await holder.query('SELECT pg_backend_pid() AS pid');
    const run = executePlan(plans.archiveRace, orgId, ids.mia);
    let waiting = false;
    for (let attempt = 0; attempt < 200 && !waiting; attempt += 1) {
      const { rows: [row] } = await client!.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid]);
      waiting = row.n > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(waiting, 'the step claim waited for the archive');
    await holder.query('COMMIT');
    await run;
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    await holder.end();
  }
  assert.equal(await tasksCreated(plans.archiveRace), 0);
  const { rows: [plan] } = await client!.query('SELECT status, error FROM agent_plans WHERE id=$1', [plans.archiveRace]);
  assert.deepEqual(plan, { status: 'paused', error: PLAN_ROOM_LOST_ERROR });
});

test('a plan step leaves the review gate once its creator loses a room of its plan: pending, employee-run and finished steps', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const kept = randomUUID();
  const source = randomUUID();
  // Another member who shares both rooms and the employee, and keeps them.
  const peer = randomUUID();
  await client!.query("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,'Gate peer','human',false)", [peer, `${peer}@example.test`]);
  await client!.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, peer, 'member']);
  t.after(async () => {
    await client!.query('DELETE FROM space_members WHERE user_id = $1', [peer]);
    await client!.query('DELETE FROM org_members WHERE user_id = $1', [peer]);
    await client!.query('DELETE FROM users WHERE id = $1', [peer]);
  });
  for (const room of [kept, source]) {
    await client!.query("INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,'private',$4)", [room, orgId, `gate-${room.slice(0, 8)}`, ids.olive]);
    for (const user of [ids.mia, ids.olive, peer]) await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), room, user]);
  }
  const sourceMessage = randomUUID();
  await client!.query("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'@Defty plan this')", [sourceMessage, orgId, source, ids.mia]);
  const plan = randomUUID();
  await client!.query(`INSERT INTO agent_plans(id,org_id,user_id,conversation_id,title,steps,status,current_step,context)
    VALUES($1,$2,$3,$4,'Gate plan','[]'::jsonb,'paused',0,$5::jsonb)`, [plan, orgId, ids.mia, kept, JSON.stringify({ source_message_id: sourceMessage })]);
  // A Conservative BYOA employee the plan runs as (sol): its step waits for Mia.
  const employee = randomUUID();
  const shadow = randomUUID();
  await client!.query("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,'Gate agent','agent',true)", [shadow, `${shadow}@agents.example.test`]);
  await client!.query(`INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
    VALUES ($1, $2, $3, 'Gate agent', $4, 'project_manager', 'Fixture', 'conservative', true, true, $5)`, [employee, orgId, shadow, `gate-${employee.slice(0, 8)}`, ids.mia]);
  await client!.query('UPDATE users SET agent_employee_id = $2 WHERE id = $1', [shadow, employee]);
  t.after(async () => {
    await client!.query('UPDATE users SET agent_employee_id = NULL WHERE id = $1', [shadow]);
    await client!.query('DELETE FROM agent_actions WHERE agent_employee_id = $1', [employee]);
    await client!.query('DELETE FROM agent_employees WHERE id = $1', [employee]);
    await client!.query('DELETE FROM users WHERE id = $1', [shadow]);
  });
  const step = async (id: string, status: string, extra: { employee?: string; result?: object } = {}) => client!.query(
    `INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,conversation_id,source,plan_id,plan_step_id,action,params,approval_tier,approval_status,executed_at,result)
      VALUES($1,$2,$3,$4,$5,'plan',$6,$1,'create_task',$7,'quick',$8,$9,$10)`,
    [id, orgId, ids.mia, extra.employee ?? null, kept, plan, JSON.stringify({ title: `CANARY-gate-${id}`, resolved_project_id: projectId }),
      status, status === 'approved' ? new Date() : null, extra.result ? JSON.stringify(extra.result) : null]);
  const finished = randomUUID();
  const byEmployee = randomUUID();
  await step(finished, 'approved', { result: { note: 'CANARY-gate-result' } });
  await step(byEmployee, 'pending', { employee });
  const pendingText = async () => (await call(ids.mia, 'GET', '/api/agent/actions/pending')).text
    + (await call(ids.mia, 'GET', '/api/inbox?kind=pending_approval')).text;
  assert.ok((await pendingText()).includes(byEmployee), 'the employee step waits for Mia while she has both rooms');
  // Another plan of Mia's run as the employee reads its activity: the result reaches her.
  const { executeToolCall } = await import('../src/lib/agent-context.js');
  const activity = async () => JSON.stringify((await executeToolCall('get_agent_activity', { limit: 100 }, orgId, ids.mia, undefined, employee)).result);
  assert.ok((await activity()).includes(byEmployee), 'in the employee activity she reads while she has both rooms');
  assert.ok(JSON.stringify((await executeToolCall('get_agent_activity', { limit: 100 }, orgId, peer, undefined, employee)).result).includes(byEmployee),
    'in the activity another member reads through the employee while Mia has both rooms');
  // The employee's own pending-work queues (fetch_unread, poll_pending_work).
  const { fetchUnread } = await import('../src/lib/mcp-tools/messages.js');
  const { pollPendingWork } = await import('../src/lib/mcp-tools/cooperative.js');
  const ctx = { org_id: orgId, employee_id: employee, employee_slug: `gate-${employee.slice(0, 8)}`, trust_level: 'conservative' } as any;
  const queues = async () => JSON.stringify(await fetchUnread({} as any, ctx)) + JSON.stringify(await pollPendingWork({} as any, ctx));
  assert.ok((await queues()).includes(byEmployee), 'in the employee queues while she has both rooms');

  const removed = await call(ids.olive, 'DELETE', `/api/spaces/${source}/members/${ids.mia}`);
  assert.equal(removed.status, 200, removed.text);
  // Queued after the loss (astra): its row names only the room she kept.
  const late = randomUUID();
  await step(late, 'pending');

  const after = await pendingText();
  const seen: string[] = [];
  if (after.includes(byEmployee) || after.includes(`CANARY-gate-${byEmployee}`)) seen.push('employee step in pending list or Inbox');
  if (after.includes(late) || after.includes(`CANARY-gate-${late}`)) seen.push('late step in pending list or Inbox');
  const activityAfter = await activity();
  const queuesAfter = await queues();
  const peerActivity = JSON.stringify((await executeToolCall('get_agent_activity', { limit: 100 }, orgId, peer, undefined, employee)).result);
  if (peerActivity.includes(byEmployee) || peerActivity.includes(`CANARY-gate-${byEmployee}`)) seen.push('employee step in the activity another member reads');
  if (queuesAfter.includes(byEmployee) || queuesAfter.includes(`CANARY-gate-${byEmployee}`)) seen.push('employee step in the employee pending-work queues');
  if (activityAfter.includes(byEmployee) || activityAfter.includes(`CANARY-gate-${byEmployee}`)) seen.push('employee step in the employee activity she reads');
  const retry = await call(ids.mia, 'POST', `/api/agent/actions/${finished}/approve`);
  if (retry.status !== 404 || retry.text.includes('CANARY-gate-result')) seen.push(`finished step retry ${retry.status}`);
  for (const id of [byEmployee, late]) {
    const approve = await call(ids.mia, 'POST', `/api/agent/actions/${id}/approve`);
    if (approve.status === 200) seen.push(`approve ${id === late ? 'late' : 'employee'} step 200`);
  }
  assert.deepEqual(seen, [], 'nothing of the plan is seen or approvable after the loss');
  assert.equal(await tasksCreated(`gate-${late}`), 0);
});

test('a plan can be created only in a room its creator can read', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const closed = randomUUID();
  await client!.query("INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,'private',$4)", [closed, orgId, `closed-${closed.slice(0, 8)}`, ids.olive]);
  await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), closed, ids.olive]);
  const body = (room: string) => ({ title: `Bound plan ${room}`, conversation_id: room,
    steps: [{ id: 'step-1', tool: 'create_task', params: { title: 'x', resolved_project_id: projectId } }] });
  const refused = await call(ids.mia, 'POST', '/api/agent-plans', body(closed));
  assert.equal(refused.status, 404, refused.text);
  const { rows } = await client!.query('SELECT count(*)::int AS n FROM agent_plans WHERE org_id=$1 AND conversation_id=$2', [orgId, closed]);
  assert.equal(rows[0].n, 0, 'nothing stored');
  const made = await call(ids.olive, 'POST', '/api/agent-plans', body(closed));
  assert.equal(made.status, 201, made.text);
});

test('a plan bound to no room (148 recovery draft) is not readable or runnable by its member creator', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // Release 148's failed-step recovery called create_plan with no conversation
  // (agent-plans.ts:762 -> agent-runner.ts:909 -> agent-context.ts:2489 at 4aa4de9c).
  const { executeToolCall } = await import('../src/lib/agent-context.js');
  const draftTitle = `Recovery draft ${randomUUID()}`;
  const { result } = await executeToolCall('create_plan', {
    title: draftTitle,
    steps: [{ id: 'step-1', tool: 'create_task', params: { title: title(draftTitle), resolved_project_id: projectId, priority: 'p2' } }],
  }, orgId, ids.mia, undefined);
  const draft = (result as { plan_id: string }).plan_id;
  const { rows: [row] } = await client!.query('SELECT conversation_id, context FROM agent_plans WHERE id=$1', [draft]);
  assert.deepEqual(row, { conversation_id: null, context: {} }, 'the draft names no room');

  assert.ok(!(await listedPlans(ids.mia)).includes(draft), 'not in her list');
  assert.equal((await call(ids.mia, 'GET', `/api/agent-plans/${draft}`)).status, 404);
  for (const action of ['approve', 'execute']) {
    assert.equal((await call(ids.mia, 'POST', `/api/agent-plans/${draft}/${action}`)).status, 404, `${action} by Mia`);
    assert.equal((await call(ids.olive, 'POST', `/api/agent-plans/${draft}/${action}`)).status, 404, `${action} by the owner for her`);
  }
  await client!.query("UPDATE agent_plans SET status='approved' WHERE id=$1", [draft]);
  const { executePlan } = await import('../src/lib/agent-plans.js');
  await executePlan(draft, orgId, ids.mia);
  assert.equal(await tasksCreated(draftTitle), 0, 'it never runs');
});
