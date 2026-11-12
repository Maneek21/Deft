import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const ids = {
  requester: randomUUID(), peer: randomUUID(), approver: randomUUID(),
  owner: randomUUID(), admin: randomUUID(), guest: randomUUID(),
};
const roles: Record<string, 'member' | 'owner' | 'admin' | 'guest'> = {
  [ids.requester]: 'member', [ids.peer]: 'member', [ids.approver]: 'member',
  [ids.owner]: 'owner', [ids.admin]: 'admin', [ids.guest]: 'guest',
};
const employeeId = randomUUID();
const employeeUserId = randomUUID();
const employeeSlug = `source-audience-${employeeId}`;
const spaceId = randomUUID();
const sourceMessageId = randomUUID();
const messageEventId = randomUUID();
const projectId = randomUUID();
const taskId = randomUUID();
const taskEventId = randomUUID();
const actions = {
  heartbeat: randomUUID(), trigger: randomUUID(), requested: randomUUID(), guestRequested: randomUUID(),
  defty: randomUUID(), deftyEnvelope: randomUUID(), message: randomUUID(), event: randomUUID(), task: randomUUID(),
  pendingDefty: randomUUID(), pendingByoa: randomUUID(), pendingRequester: randomUUID(),
  pendingGuest: randomUUID(), pendingGuestModule: randomUUID(),
};
const tokens: Record<string, string> = {};
const unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let client: pg.Client | undefined;
let seeded = false;
let routes: Record<string, Hono> = {};

async function request(viewer: string, path: string) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: viewer, org_id: orgId, email: `${viewer}@example.test`, role: roles[viewer] } as any);
    await next();
  });
  hono.route('/api/agent', routes.agent!);
  return hono.request(`/api/agent${path}`);
}

type ActionRow = { id: string; params: Record<string, unknown> };
async function read(viewer: string, path: string): Promise<ActionRow[]> {
  const response = await request(viewer, path);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as ActionRow[] | { actions: ActionRow[] };
  return Array.isArray(body) ? body : body.actions;
}

const pendingPath = `/actions/pending-by-space?space_id=${spaceId}`;
const employeeContext: ToolContext = {
  org_id: orgId, employee_id: employeeId, employee_slug: employeeSlug, trust_level: 'conservative',
};

function pendingRows(result: ToolResult): ActionRow[] {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const content = result.content.find((item) => item.type === 'text');
  assert.ok(content);
  return (JSON.parse(content.text) as { pending_actions: ActionRow[] }).pending_actions;
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await client.connect();
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Action source audience', `action-source-${orgId}`]);
  seeded = true;
  for (const [name, id] of Object.entries(ids)) {
    await client.query("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,'human',false)", [id, `${id}@example.test`, name]);
    await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, id, roles[id]]);
  }
  await client.query("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,'Source employee','agent',true)", [employeeUserId, `${employeeUserId}@example.test`]);
  await client.query("INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'member')", [randomUUID(), orgId, employeeUserId]);
  await client.query(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,trust_level,is_active,is_byoa,runtime_kind,created_by)
    VALUES($1,$2,$3,'Source employee',$4,'custom','Test.','conservative',true,true,'custom_mcp',$5)`,
  [employeeId, orgId, employeeUserId, employeeSlug, ids.requester]);
  const { ensureDeftyEmployee } = await import('../src/lib/ensure-defty-membership.js');
  const deftyEmployeeId = (await ensureDeftyEmployee(orgId)).employeeId;
  await client.query("INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,'Source room','private',$3)", [spaceId, orgId, ids.requester]);
  for (const user of [...Object.values(ids), employeeUserId]) {
    await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), spaceId, user]);
  }
  await client.query("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'Please help')", [sourceMessageId, orgId, spaceId, ids.requester]);
  await client.query(`INSERT INTO agent_channel_events(id,org_id,agent_employee_id,kind,source_kind,source_id,space_id,idempotency_key)
    VALUES($1,$2,$3,'message.created','message',$4,$5,$1)`, [messageEventId, orgId, employeeId, sourceMessageId, spaceId]);
  await client.query("INSERT INTO projects(id,org_id,name,prefix) VALUES($1,$2,'Source project','AUD')", [projectId, orgId]);
  await client.query(`INSERT INTO tasks(id,org_id,project_id,number,title,created_by,assignee_id,metadata)
    VALUES($1,$2,$3,1,'Source task',$4,$5,'{"visibility":"restricted"}')`, [taskId, orgId, projectId, ids.requester, employeeUserId]);
  await client.query(`INSERT INTO agent_channel_events(id,org_id,agent_employee_id,kind,source_kind,source_id,idempotency_key)
    VALUES($1,$2,$3,'task.assigned','task',$4,$1)`, [taskEventId, orgId, employeeId, taskId]);

  const insertAction = async (
    id: string, action: string, userId: string, params: Record<string, unknown>,
    options: { employee?: string | null; message?: string; event?: string; tier?: 'auto' | 'quick' } = {},
  ) => client!.query(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,message_id,channel_event_id,source,action,params,approval_tier,approval_status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`,
  [id, orgId, userId, options.employee === undefined ? employeeId : options.employee,
    options.message ?? null, options.event ?? null, action === 'heartbeat_tick' ? 'heartbeat' : action === 'trigger_dispatch' ? 'trigger' : 'mention',
    action, JSON.stringify(params), options.tier ?? 'auto']);

  await insertAction(actions.heartbeat, 'heartbeat_tick', employeeUserId, {
    heartbeat_prompt: 'CANARY-HEARTBEAT-PROMPT', source_user_id: ids.peer, origin_user_id: ids.guest,
  });
  await insertAction(actions.trigger, 'trigger_dispatch', employeeUserId, {
    event_data: { detail: 'CANARY-TRIGGER-EVENT' }, prompt: 'CANARY-TRIGGER-PROMPT',
  });
  await insertAction(actions.requested, 'trigger_dispatch', ids.requester, { prompt: 'CANARY-REQUESTED-PROMPT' });
  await insertAction(actions.guestRequested, 'trigger_dispatch', ids.guest, { prompt: 'CANARY-GUEST-PROMPT' });
  await insertAction(actions.defty, 'create_task', ids.requester, { title: 'Defty request' }, { employee: null });
  await insertAction(actions.deftyEnvelope, 'create_task', ids.requester, { title: 'Defty envelope' }, { employee: deftyEmployeeId });
  await insertAction(actions.message, 'create_task', employeeUserId, { title: 'CANARY-MESSAGE-SOURCE' }, { message: sourceMessageId });
  await insertAction(actions.event, 'create_task', employeeUserId, { title: 'CANARY-EVENT-SOURCE' }, { event: messageEventId });
  await insertAction(actions.task, 'create_task', employeeUserId, { title: 'CANARY-TASK-SOURCE' }, { event: taskEventId });
  await insertAction(actions.pendingDefty, 'create_task', ids.requester, { title: 'Pending Defty' }, { employee: null, message: sourceMessageId, tier: 'quick' });
  await insertAction(actions.pendingByoa, 'create_task', ids.requester, { title: 'CANARY-PENDING-BYOA' }, { message: sourceMessageId, tier: 'quick' });
  await insertAction(actions.pendingRequester, 'create_task', ids.requester, { title: 'Requester review' }, { employee: null, message: sourceMessageId, tier: 'quick' });
  await insertAction(actions.pendingGuest, 'create_task', ids.guest, { title: 'Guest request' }, { employee: null, message: sourceMessageId, tier: 'quick' });
  await insertAction(actions.pendingGuestModule, 'module_record_create', ids.guest, { data: {} }, { employee: null, message: sourceMessageId, tier: 'quick' });

  for (const action of [actions.heartbeat, actions.trigger, actions.defty, actions.deftyEnvelope]) {
    for (const user of [ids.approver, ids.guest]) {
      await client.query('INSERT INTO agent_action_approvers(id,org_id,action_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, action, user]);
    }
  }
  for (const action of [actions.pendingDefty, actions.pendingByoa]) {
    for (const user of [ids.requester, ids.approver, ids.owner, ids.admin, ids.guest]) {
      await client.query('INSERT INTO agent_action_approvers(id,org_id,action_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, action, user]);
    }
  }
  for (const user of [employeeUserId, ids.requester, ids.peer]) {
    const token = `dft_${randomUUID().replaceAll('-', '')}`;
    tokens[user] = token;
    await client.query(`INSERT INTO api_keys(id,org_id,name,key_hash,key_prefix,permissions,created_by,agent_employee_id)
      VALUES($1,$2,'source audience',$3,$4,ARRAY['read'],$5,$6)`,
    [randomUUID(), orgId, await bcrypt.hash(token, 4), token.slice(0, 12), user === employeeUserId ? ids.requester : user, user === employeeUserId ? employeeId : null]);
  }
  routes = {
    agent: (await import('../src/routes/agent.js')).agentRoutes,
    mcp: (await import('../src/routes/mcp-server.js')).mcpServerRoutes,
  };
});

after(async () => {
  try {
    if (seeded && client) {
      for (const table of ['api_keys', 'agent_action_approvers', 'agent_actions', 'agent_channel_events', 'task_activity', 'tasks', 'projects']) {
        await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
      }
      await client.query('DELETE FROM messages WHERE org_id=$1', [orgId]);
      await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
      for (const table of ['spaces', 'agent_employees', 'org_members']) {
        await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
      }
      await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
      await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [[...Object.values(ids), employeeUserId]]);
    }
  } finally {
    await client?.end();
    await closeDb();
  }
});

for (const path of ['/actions', '/actions/recent?limit=50']) {
  test(`W2a5b-1: ${path} limits source-less employee work to human requesters, assigned reviewers and current owners/admins`, async (t) => {
    if (unavailable) return t.skip(unavailable);
    // An assigned member reviews the work, so it reads it; an assigned guest does not.
    const reviewerRows = await read(ids.approver, path);
    for (const action of [actions.heartbeat, actions.trigger]) {
      assert.equal(reviewerRows.some((row) => row.id === action), true);
    }
    assert.equal(reviewerRows.some((row) => row.id === actions.requested), false, 'work it is not assigned to stays with its requester');
    // The heartbeat row names the peer as source_user_id, so the peer is its one requester;
    // origin_user_id (the guest) does not count once source_user_id is present.
    const peerRows = await read(ids.peer, path);
    assert.equal(peerRows.find((row) => row.id === actions.heartbeat)?.params.heartbeat_prompt, 'CANARY-HEARTBEAT-PROMPT');
    for (const action of [actions.trigger, actions.requested]) {
      assert.equal(peerRows.some((row) => row.id === action), false);
    }
    for (const canary of ['CANARY-TRIGGER-EVENT', 'CANARY-TRIGGER-PROMPT', 'CANARY-REQUESTED-PROMPT']) {
      assert.equal(JSON.stringify(peerRows).includes(canary), false, `member: ${canary}`);
    }
    const guestSourceRows = await read(ids.guest, path);
    for (const action of [actions.heartbeat, actions.trigger, actions.requested]) {
      assert.equal(guestSourceRows.some((row) => row.id === action), false);
    }
    for (const canary of ['CANARY-HEARTBEAT-PROMPT', 'CANARY-TRIGGER-EVENT', 'CANARY-TRIGGER-PROMPT', 'CANARY-REQUESTED-PROMPT']) {
      assert.equal(JSON.stringify(guestSourceRows).includes(canary), false, `guest: ${canary}`);
    }
    for (const viewer of [ids.owner, ids.admin]) {
      const rows = await read(viewer, path);
      assert.equal(rows.find((row) => row.id === actions.heartbeat)?.params.heartbeat_prompt, 'CANARY-HEARTBEAT-PROMPT');
      assert.equal(rows.find((row) => row.id === actions.trigger)?.params.prompt, 'CANARY-TRIGGER-PROMPT');
      assert.deepEqual(rows.find((row) => row.id === actions.trigger)?.params.event_data, { detail: 'CANARY-TRIGGER-EVENT' });
    }
    const requesterRows = await read(ids.requester, path);
    assert.equal(requesterRows.find((row) => row.id === actions.requested)?.params.prompt, 'CANARY-REQUESTED-PROMPT');
    assert.equal(requesterRows.some((row) => row.id === actions.heartbeat || row.id === actions.trigger), false);
    const guestRows = await read(ids.guest, path);
    assert.equal(guestRows.find((row) => row.id === actions.guestRequested)?.params.prompt, 'CANARY-GUEST-PROMPT');
    assert.equal((await read(ids.peer, path)).some((row) => row.id === actions.guestRequested), false);
  });

  test(`W2a5b-1: ${path} uses current employee and reader authority for message and channel sources`, async (t) => {
    if (unavailable) return t.skip(unavailable);
    const sourced: string[] = [actions.message, actions.event];
    const visible = async () => (await read(ids.peer, path)).filter((row) => sourced.includes(row.id));
    assert.equal((await visible()).length, 2);
    for (const user of [ids.peer, employeeUserId]) {
      await client!.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [spaceId, user]);
      try {
        assert.deepEqual(await visible(), []);
      } finally {
        await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), spaceId, user]);
      }
    }
    assert.equal((await visible()).length, 2);
  });

  test(`W2a5b-1: ${path} retains the Defty requester and reviewer audience`, async (t) => {
    if (unavailable) return t.skip(unavailable);
    for (const viewer of [ids.requester, ids.approver, ids.owner, ids.admin]) {
      const rows = await read(viewer, path);
      for (const id of [actions.defty, actions.deftyEnvelope]) assert.equal(rows.some((row) => row.id === id), true);
    }
    for (const viewer of [ids.peer, ids.guest]) {
      const rows = await read(viewer, path);
      for (const id of [actions.defty, actions.deftyEnvelope]) assert.equal(rows.some((row) => row.id === id), false);
    }
  });
}

test('W2a5b-1: task-sourced employee actions require current task authority for both principals', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const path of ['/actions', '/actions/recent?limit=50']) {
    assert.equal((await read(ids.requester, path)).some((row) => row.id === actions.task), true);
    assert.equal((await read(ids.peer, path)).some((row) => row.id === actions.task), false);
  }
  await client!.query('UPDATE tasks SET assignee_id=null WHERE id=$1 AND org_id=$2', [taskId, orgId]);
  try {
    for (const path of ['/actions', '/actions/recent?limit=50']) {
      assert.equal((await read(ids.requester, path)).some((row) => row.id === actions.task), false);
    }
  } finally {
    await client!.query('UPDATE tasks SET assignee_id=$1 WHERE id=$2 AND org_id=$3', [employeeUserId, taskId, orgId]);
  }
});

test('W2a5b-1: source-less human reads use the current org role', async (t) => {
  if (unavailable) return t.skip(unavailable);
  await client!.query("UPDATE org_members SET role='member' WHERE org_id=$1 AND user_id=$2", [orgId, ids.admin]);
  try {
    for (const path of ['/actions', '/actions/recent?limit=50']) {
      assert.equal((await read(ids.admin, path)).some((row) => row.id === actions.heartbeat || row.id === actions.trigger), false);
    }
  } finally {
    await client!.query("UPDATE org_members SET role='admin' WHERE org_id=$1 AND user_id=$2", [orgId, ids.admin]);
  }
});

test('W2a5b-1: employee MCP pending-work tools return their source-less work', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { fetchUnread } = await import('../src/lib/mcp-tools/messages.js');
  const { pollPendingWork } = await import('../src/lib/mcp-tools/cooperative.js');
  for (const result of [
    await fetchUnread({ caller_employee_slug: employeeSlug, limit: 1 }, employeeContext),
    await pollPendingWork({}, employeeContext),
  ]) {
    const rows = pendingRows(result);
    assert.equal(rows.find((row) => row.id === actions.heartbeat)?.params.heartbeat_prompt, 'CANARY-HEARTBEAT-PROMPT');
    assert.equal(rows.find((row) => row.id === actions.trigger)?.params.prompt, 'CANARY-TRIGGER-PROMPT');
    assert.equal(rows.find((row) => row.id === actions.requested)?.params.prompt, 'CANARY-REQUESTED-PROMPT');
  }
});

test('W2a5b-1: legacy MCP status supports employee work and the human requester', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const status = async (viewer: string, actionId: string) => {
    const app = new Hono();
    app.route('/api/mcp', routes.mcp!);
    return app.request(`/api/mcp/actions/${actionId}/status`, { headers: { authorization: `Bearer ${tokens[viewer]}` } });
  };
  for (const id of [actions.heartbeat, actions.trigger, actions.requested]) {
    const response = await status(employeeUserId, id);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json() as { id: string }).id, id);
  }
  assert.equal((await status(ids.requester, actions.requested)).status, 200);
  assert.equal((await status(ids.peer, actions.requested)).status, 404);
});

test('W2a5b-2: pending-by-space intersects the shared audience with assigned review authority', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const viewer of [ids.peer, ids.guest]) {
    const rows = await read(viewer, pendingPath);
    assert.equal(rows.some((row) => row.id === actions.pendingDefty), false);
    assert.equal(rows.some((row) => row.id === actions.pendingByoa), false);
  }
  for (const viewer of [ids.requester, ids.approver, ids.owner, ids.admin]) {
    const rows = await read(viewer, pendingPath);
    assert.equal(rows.some((row) => row.id === actions.pendingDefty), true);
    assert.equal(rows.some((row) => row.id === actions.pendingByoa), true);
  }
  assert.equal((await read(ids.guest, pendingPath)).some((row) => row.id === actions.pendingGuest), true);
  assert.equal((await read(ids.guest, pendingPath)).some((row) => row.id === actions.pendingGuestModule), false);
  for (const viewer of [ids.owner, ids.admin]) {
    assert.equal((await read(viewer, pendingPath)).some((row) => row.id === actions.pendingRequester), false);
  }
  assert.equal((await read(ids.requester, pendingPath)).some((row) => row.id === actions.pendingRequester), true);
});

test('W2a5b-2: pending-by-space requires current employee source access', async (t) => {
  if (unavailable) return t.skip(unavailable);
  assert.equal((await read(ids.approver, pendingPath)).some((row) => row.id === actions.pendingByoa), true);
  await client!.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [spaceId, employeeUserId]);
  try {
    const rows = await read(ids.approver, pendingPath);
    assert.equal(rows.some((row) => row.id === actions.pendingByoa), false);
    assert.equal(JSON.stringify(rows).includes('CANARY-PENDING-BYOA'), false);
    assert.equal(rows.some((row) => row.id === actions.pendingDefty), true);
  } finally {
    await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), spaceId, employeeUserId]);
  }
});

test('W2a5b-2: pending-by-space requires the reader space membership', async (t) => {
  if (unavailable) return t.skip(unavailable);
  await client!.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [spaceId, ids.approver]);
  try {
    assert.deepEqual(await read(ids.approver, pendingPath), []);
  } finally {
    await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), spaceId, ids.approver]);
  }
});
