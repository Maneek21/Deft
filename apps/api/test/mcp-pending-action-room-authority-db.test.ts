import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { fetchUnread } from '../src/lib/mcp-tools/messages.js';
import { pollPendingWork } from '../src/lib/mcp-tools/cooperative.js';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';
import { handleAgentEmployeeMessage } from '../src/workers/handlers/agent-employee-message.js';
import { handleAgentEmployeeTask } from '../src/workers/handlers/agent-employee-task.js';

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'a disposable database is required; do not skip this boundary');
const orgId = randomUUID(), otherOrgId = randomUUID();
const humanId = randomUUID(), agentUserId = randomUUID(), employeeId = randomUUID();
const slug = `pending-room-${randomUUID()}`;
const rooms = { private: randomUUID(), public: randomUUID(), archived: randomUUID(), foreign: randomUUID() };
const source = { private: randomUUID(), public: randomUUID(), deleted: randomUUID(), archived: randomUUID(), foreign: randomUUID() };
const actions = Object.fromEntries(['private', 'public', 'deleted', 'archived', 'foreign', 'unbound', 'general', 'foreignAction'].map(key => [key, randomUUID()]));
const privateCanary = `private-fallback-${randomUUID()}`;
const projectId = randomUUID(), outsideProjectId = randomUUID(), taskId = randomUUID();
const taskEventId = randomUUID(), wrongEventId = randomUUID();
const taskActions = { bound: randomUUID(), unbound: randomUUID(), wrongKind: randomUUID() };
const taskCanary = `task-fallback-${randomUUID()}`;
const ctx: ToolContext = { org_id: orgId, employee_id: employeeId, employee_slug: slug, trust_level: 'conservative' };

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

function parsed(result: ToolResult): { pending_actions: Array<{ id: string }> } {
  assert.ok(!result.isError, JSON.stringify(result));
  const text = result.content.find(item => item.type === 'text');
  assert.ok(text && 'text' in text);
  return JSON.parse(text.text);
}

before(async () => withClient(async client => {
  await client.query('INSERT INTO orgs (id,name,slug,timezone) VALUES ($1,$2,$3,$4),($5,$6,$7,$4)',
    [orgId, 'Pending source room test', `pending-${orgId}`, 'UTC', otherOrgId, 'Foreign pending room test', `pending-${otherOrgId}`]);
  await client.query("INSERT INTO users (id,email,name,kind,is_agent,email_verified) VALUES ($1,$2,'Room Human','human',false,true),($3,$4,'Room Employee','agent',true,true)",
    [humanId, `${humanId}@test.invalid`, agentUserId, `${agentUserId}@test.invalid`]);
  await client.query("INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES ($1,$2,$3,'owner',true),($4,$2,$5,'member',true),($6,$7,$3,'owner',true)",
    [randomUUID(),orgId,humanId,randomUUID(),agentUserId,randomUUID(),otherOrgId]);
  await client.query("INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,trust_level,is_byoa,is_active,created_by) VALUES ($1,$2,$3,'Room Employee',$4,'engineering_lead','test','conservative',true,true,$5)",
    [employeeId,orgId,agentUserId,slug,humanId]);
  for (const [kind,id] of Object.entries(rooms)) {
    await client.query('INSERT INTO spaces(id,org_id,name,type,created_by,is_archived) VALUES ($1,$2,$3,$4,$5,$6)',
      [id,kind === 'foreign' ? otherOrgId : orgId,`pending-room-${kind}`,kind === 'public' || kind === 'foreign' ? 'public' : 'private',humanId,kind === 'archived']);
    await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES ($1,$2,$3)',[randomUUID(),id,humanId]);
  }
  for (const kind of ['private','public','archived'] as const) {
    await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES ($1,$2,$3)',[randomUUID(),rooms[kind],agentUserId]);
  }
  for (const [kind,id] of Object.entries(source)) {
    const room = kind === 'deleted' ? rooms.public : rooms[kind as keyof typeof rooms];
    await client.query('INSERT INTO messages(id,org_id,space_id,user_id,content,is_deleted) VALUES ($1,$2,$3,$4,$5,$6)',
      [id,kind === 'foreign' ? otherOrgId : orgId,room,humanId,kind === 'private' ? privateCanary : `source-${kind}`,kind === 'deleted']);
  }
  for (const [kind,id] of Object.entries(actions)) {
    const general = kind === 'general' || kind === 'foreignAction';
    // The forged public locator must never override the canonical message's private room.
    const params = { content: kind === 'private' ? privateCanary : `pending-${kind}`, space_id: rooms.public, message_id: source.public };
    await client.query("INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,message_id,source,action,params,approval_tier,approval_status) VALUES ($1,$2,$3,$4,$5,'mention',$6,$7::jsonb,'auto','pending')",
      [id,kind === 'foreignAction' ? otherOrgId : orgId,humanId,employeeId,general || kind === 'unbound' ? null : source[kind as keyof typeof source],general ? 'create_task' : 'chat_mention',JSON.stringify(params)]);
  }
  await client.query("INSERT INTO projects(id,org_id,name,prefix) VALUES ($1,$2,'Source project','SRC'),($3,$2,'Other project','OTHER')",[projectId,orgId,outsideProjectId]);
  await client.query("INSERT INTO tasks(id,org_id,project_id,number,title,description,created_by,assignee_id,metadata) VALUES ($1,$2,$3,1,$4,$4,$5,$6,'{\"visibility\":\"restricted\"}')",
    [taskId,orgId,projectId,taskCanary,humanId,agentUserId]);
  await client.query("INSERT INTO agent_channel_events(id,org_id,agent_employee_id,kind,source_kind,source_id,idempotency_key) VALUES ($1,$2,$3,'task.assigned','task',$4,$1),($5,$2,$3,'message.created','message',$6,$5)",
    [taskEventId,orgId,employeeId,taskId,wrongEventId,source.public]);
  // A readable message event cannot be substituted for the canonical task source.
  await client.query('UPDATE agent_channel_events SET space_id=$1 WHERE id=$2',[rooms.public,wrongEventId]);
  for (const [kind,id] of Object.entries(taskActions)) {
    await client.query("INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,channel_event_id,source,action,params,approval_tier,approval_status) VALUES ($1,$2,$3,$4,$5,'task_assignment','task_assigned',$6::jsonb,'auto','pending')",
      [id,orgId,humanId,employeeId,kind === 'bound' ? taskEventId : kind === 'wrongKind' ? wrongEventId : null,JSON.stringify({ task_id: taskId,title: taskCanary,description: taskCanary })]);
  }
}));

after(async () => withClient(async client => {
  await client.query('DELETE FROM notifications WHERE org_id=$1',[orgId]);
  await client.query('DELETE FROM task_activity WHERE org_id=$1',[orgId]);
  await client.query('DELETE FROM agent_actions WHERE org_id=ANY($1::text[])',[[orgId,otherOrgId]]);
  await client.query('DELETE FROM agent_channel_events WHERE org_id=$1',[orgId]);
  await client.query('DELETE FROM tasks WHERE org_id=$1',[orgId]);
  await client.query('DELETE FROM projects WHERE org_id=$1',[orgId]);
  await client.query('DELETE FROM messages WHERE space_id=ANY($1::text[])',[Object.values(rooms)]);
  await client.query('DELETE FROM space_members WHERE space_id=ANY($1::text[])',[Object.values(rooms)]);
  await client.query('DELETE FROM spaces WHERE id=ANY($1::text[])',[Object.values(rooms)]);
  await client.query('DELETE FROM agent_employees WHERE id=$1',[employeeId]);
  await client.query('DELETE FROM org_members WHERE org_id=ANY($1::text[])',[[orgId,otherOrgId]]);
  await client.query('DELETE FROM users WHERE id=ANY($1::text[])',[[humanId,agentUserId]]);
  await client.query('DELETE FROM orgs WHERE id=ANY($1::text[])',[[orgId,otherOrgId]]);
}));

for (const [name, invoke] of [
  ['fetch_unread', () => fetchUnread({ caller_employee_slug: slug, limit: 1 }, ctx)],
  ['poll_pending_work', () => pollPendingWork({}, ctx)],
] as const) {
  test(`${name} revalidates pending chat source authority and never returns revoked private payloads`, async () => {
    await withClient(client => client.query('INSERT INTO space_members(id,space_id,user_id) VALUES ($1,$2,$3) ON CONFLICT (space_id,user_id) DO NOTHING',
      [randomUUID(),rooms.private,agentUserId]));
    const allowed = parsed(await invoke()).pending_actions.map(action => action.id);
    assert.ok(allowed.includes(actions.private!), 'a currently authorized private source remains readable');
    assert.ok(allowed.includes(actions.public!), 'a current public source remains readable');
    await withClient(client => client.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2',[rooms.private,agentUserId]));
    const result = await invoke();
    const visible = parsed(result).pending_actions.map(action => action.id);
    assert.ok(!visible.includes(actions.private!), 'revoked private source must disappear from pending_actions');
    assert.ok(!JSON.stringify(result).includes(privateCanary), 'no copied private body may survive source revocation');
    assert.ok(visible.includes(actions.public!), 'public work is preserved after an unrelated membership removal');
    assert.ok(visible.includes(actions.general!), 'unbound non-chat work retains its existing behavior');
    for (const denied of ['deleted','archived','foreign','unbound','foreignAction']) {
      assert.ok(!visible.includes(actions[denied]!), `${denied} source/action must fail closed`);
    }
  });
  test(`${name} revalidates canonical task visibility and project scope without trusting copied task params`, async () => {
    await withClient(client => client.query('UPDATE agent_employees SET project_ids=$1::text[] WHERE id=$2',[[projectId],employeeId]));
    const allowed = parsed(await invoke()).pending_actions.map(action => action.id);
    assert.ok(allowed.includes(taskActions.bound), 'currently assigned restricted task remains visible');
    assert.ok(!allowed.includes(taskActions.unbound), 'legacy unbound task assignment fails closed');
    assert.ok(!allowed.includes(taskActions.wrongKind), 'a message event cannot authorize task payloads');
    await withClient(client => client.query('UPDATE agent_employees SET project_ids=$1::text[] WHERE id=$2',[[outsideProjectId],employeeId]));
    let result = await invoke();
    assert.ok(!parsed(result).pending_actions.some(action => action.id === taskActions.bound), 'scope removal hides queued task');
    assert.ok(!JSON.stringify(result).includes(taskCanary), 'no task body survives revoked scope');
    await withClient(async client => {
      await client.query('UPDATE agent_employees SET project_ids=$1::text[] WHERE id=$2',[[projectId],employeeId]);
      await client.query('UPDATE tasks SET assignee_id=null WHERE id=$1',[taskId]);
    });
    result = await invoke();
    assert.ok(!parsed(result).pending_actions.some(action => action.id === taskActions.bound), 'restricted task reassignment hides queued payload');
    await withClient(async client => {
      await client.query('UPDATE tasks SET assignee_id=$1,is_deleted=true WHERE id=$2',[agentUserId,taskId]);
    });
    assert.ok(!parsed(await invoke()).pending_actions.some(action => action.id === taskActions.bound), 'deleted task fails closed');
    await withClient(client => client.query('UPDATE tasks SET is_deleted=false WHERE id=$1',[taskId]));
  });
}

test('real mention and task workers bind pull fallbacks to canonical sources, including idempotent task publication', async () => {
  await withClient(async client => {
    await client.query('UPDATE agent_employees SET project_ids=$1::text[] WHERE id=$2',[[projectId],employeeId]);
    await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES ($1,$2,$3)',[randomUUID(),rooms.private,agentUserId]);
  });
  await handleAgentEmployeeMessage({ id: randomUUID(),name: 'agent-employee-message',attempts: 0,
    data: {messageId: source.private,spaceId: rooms.private,orgId,employeeId,isDM: false} });
  await handleAgentEmployeeTask({ id: randomUUID(),name: 'agent-employee-task',attempts: 0,
    data: {taskId,orgId,employeeId,assignedBy: humanId} });
  await handleAgentEmployeeTask({ id: randomUUID(),name: 'agent-employee-task',attempts: 0,
    data: {taskId,orgId,employeeId,assignedBy: humanId} });
  await withClient(async client => {
    const mention = (await client.query("SELECT message_id FROM agent_actions WHERE org_id=$1 AND action='chat_mention' AND message_id=$2 AND id<>$3",[orgId,source.private,actions.private])).rows;
    assert.equal(mention.length,1,'worker persists the verified canonical message column');
    const taskRows = (await client.query("SELECT a.channel_event_id,e.source_id,e.source_kind,e.kind FROM agent_actions a LEFT JOIN agent_channel_events e ON e.id=a.channel_event_id WHERE a.org_id=$1 AND a.action='task_assigned' AND a.id<>ALL($2::text[])",[orgId,Object.values(taskActions)])).rows;
    assert.equal(taskRows.length,2,'both original and replay fallback are queued');
    assert.ok(taskRows.every(row => row.channel_event_id && row.source_id === taskId && row.source_kind === 'task' && row.kind === 'task.assigned'));
    assert.equal(new Set(taskRows.map(row => row.channel_event_id)).size,1,'idempotent publication binds both fallbacks to the existing canonical event');
  });
});
