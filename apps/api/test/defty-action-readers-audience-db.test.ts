/**
 * Item W2a3-2: readers of agent_actions with their own checks follow the
 * shared Defty action audience (requester, assigned approver, owner/admin;
 * a guest only for its own request). Approval surfaces serve an action to its
 * reviewers: the requester when an active human member, otherwise the
 * owners/admins; an assignment counts only when it names one of them.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const ids = { requester: randomUUID(), peer: randomUUID(), approver: randomUUID(), admin: randomUUID(), guestApprover: randomUUID() };
const roles: Record<string, 'member' | 'admin' | 'guest'> = {
  [ids.requester]: 'member', [ids.peer]: 'member', [ids.approver]: 'member', [ids.admin]: 'admin', [ids.guestApprover]: 'guest',
};
const actionId = randomUUID();
const employeeActionId = randomUUID();
const tokens: Record<string, string> = {};
let deftyEmployeeId = '';
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;
let routes: Record<string, Hono> = {};
const extraUsers: string[] = [];

async function request(viewerId: string, mount: string, path: string, init?: RequestInit) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: viewerId, org_id: orgId, email: `${viewerId}@example.test`, role: roles[viewerId] } as any);
    await next();
  });
  hono.route(mount, routes[mount]!);
  return hono.request(`${mount}${path}`, init);
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Action readers', `action-readers-${orgId}`]);
  for (const [name, id] of Object.entries(ids)) {
    await client.query('INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,\'human\',false)', [id, `${id}@example.test`, name]);
    await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, id, roles[id]]);
  }
  const { ensureDeftyEmployee } = await import('../src/lib/ensure-defty-membership.js');
  deftyEmployeeId = (await ensureDeftyEmployee(orgId)).employeeId;
  const insertAction = (id: string, employeeId: string | null, title: string) => client!.query(
    `INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,action,params,approval_tier,approval_status,source,error)
     VALUES($1,$2,$3,$4,'create_task',$5,'quick','pending','mention',$6)`,
    [id, orgId, ids.requester, employeeId, JSON.stringify({ title }), `${title}-ERROR`]);
  await insertAction(actionId, null, 'CANARY-PLAIN');
  await insertAction(employeeActionId, deftyEmployeeId, 'CANARY-ENVELOPE');
  for (const user of [ids.approver, ids.guestApprover]) {
    for (const action of [actionId, employeeActionId]) {
      await client.query('INSERT INTO agent_action_approvers(id,org_id,action_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, action, user]);
    }
  }
  // Attention items as they were synced to each reader when the approval was opened.
  for (const user of Object.values(ids)) {
    await client.query(`INSERT INTO attention_items(id,org_id,user_id,lane,kind,dedupe_key,source_type,source_id,title,body,state,last_event_at)
      VALUES($1,$2,$3,'needs_you','approval',$4,'agent_action',$5,'Review create task','CANARY-PLAIN','open_unseen',now())`,
      [randomUUID(), orgId, user, `test-approval:${actionId}`, actionId]);
  }
  for (const user of [ids.requester, ids.peer]) {
    const token = `dft_${randomUUID().replaceAll('-', '')}`;
    tokens[user] = token;
    await client.query(`INSERT INTO api_keys(id,org_id,name,key_hash,key_prefix,permissions,created_by)
      VALUES($1,$2,'legacy',$3,$4,ARRAY['read'],$5)`, [randomUUID(), orgId, await bcrypt.hash(token, 4), token.slice(0, 12), user]);
  }
  routes = {
    '/api/agent-employees': (await import('../src/routes/agent-employees.js')).agentEmployeeRoutes,
    '/api/attention': (await import('../src/routes/attention.js')).attentionRoutes,
    '/api/inbox': (await import('../src/routes/inbox.js')).inboxRoutes,
    '/api/mcp': (await import('../src/routes/mcp-server.js')).mcpServerRoutes,
  };
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    for (const table of ['api_keys', 'attention_events', 'attention_items', 'action_receipts', 'agent_session_turns', 'agent_action_approvers', 'agent_actions', 'notifications', 'space_members', 'agent_employees', 'org_members']) {
      if (table === 'space_members') await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
      else await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
    }
    await client.query('DELETE FROM messages WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [extraUsers]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(ids)]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

const has = (body: string, canary: string) => body.includes(canary);

test('W2a3-2a: employee activity for the Defty envelope lists its actions only to the action audience', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const read = async (viewer: string) => {
    const response = await request(viewer, '/api/agent-employees', `/${deftyEmployeeId}/activity`);
    assert.equal(response.status, 200, await response.clone().text());
    return JSON.stringify(await response.json());
  };
  assert.equal(has(await read(ids.peer), employeeActionId), false, 'a member outside the audience does not receive the action');
  assert.equal(has(await read(ids.guestApprover), employeeActionId), false, 'a guest approver does not receive the action');
  assert.equal(has(await read(ids.approver), employeeActionId), false, 'an assigned member who is not a reviewer does not receive the action');
  for (const viewer of [ids.requester, ids.admin]) {
    assert.equal(has(await read(viewer), employeeActionId), true, `${roles[viewer]} audience member keeps the action`);
  }
});

test('W2a3-2b: attention hydration returns an action only to its current audience', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const read = async (viewer: string) => {
    const response = await request(viewer, '/api/attention', '?lane=needs_you');
    assert.equal(response.status, 200, await response.clone().text());
    return JSON.stringify(await response.json());
  };
  // The peer and the guest each hold an item synced before their access changed.
  for (const viewer of [ids.peer, ids.guestApprover]) {
    const body = await read(viewer);
    assert.equal(has(body, 'CANARY-PLAIN'), false, `${viewer === ids.peer ? 'peer' : 'guest'} receives neither the item nor its params`);
  }
  assert.equal(has(await read(ids.requester), '"title":"CANARY-PLAIN"'), true, 'the requester keeps the approval payload');
  // Approval items are served to the action's reviewers: here, its requester.
  for (const viewer of [ids.approver, ids.admin]) {
    assert.equal(has(await read(viewer), 'CANARY-PLAIN'), false, `${roles[viewer]} who is not a reviewer receives no approval item`);
  }
});

test('W2a3-2c: legacy MCP action status answers only the key owner\'s own actions', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const status = (viewer: string) => request(viewer, '/api/mcp', `/actions/${actionId}/status`, { headers: { authorization: `Bearer ${tokens[viewer]}` } });
  assert.equal((await status(ids.peer)).status, 404);
  const own = await status(ids.requester);
  assert.equal(own.status, 200);
  assert.equal((await own.json() as { id: string }).id, actionId);
});

test('W2a3-2d: human MCP approval tools list and open approvals for the requester and owners/admins only', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { humanApprovalList, humanApprovalGet } = await import('../src/lib/mcp-tools/human.js');
  const ctx = (viewer: string) => ({ org_id: orgId, user_id: viewer, role: roles[viewer]!, scopes: ['read:workspace', 'write:workspace'] });
  const listed = async (viewer: string) => JSON.stringify(await humanApprovalList({ status: 'pending' }, ctx(viewer)));
  const got = async (viewer: string) => (await humanApprovalGet({ action_id: actionId }, ctx(viewer))).isError !== true;
  for (const viewer of [ids.requester, ids.admin]) {
    assert.equal(has(await listed(viewer), actionId), true);
    assert.equal(await got(viewer), true);
  }
  for (const viewer of [ids.approver, ids.peer, ids.guestApprover]) {
    assert.equal(has(await listed(viewer), actionId), false);
    assert.equal(await got(viewer), false);
  }
});
test('W2a3-2e: the legacy inbox approval filter lists approvals for their requester only', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const read = async (viewer: string) => {
    const response = await request(viewer, '/api/inbox', '?kind=pending_approval');
    assert.equal(response.status, 200, await response.clone().text());
    return JSON.stringify(await response.json());
  };
  assert.equal(has(await read(ids.requester), actionId), true);
  for (const viewer of [ids.approver, ids.peer, ids.guestApprover]) assert.equal(has(await read(viewer), actionId), false);
});

const itemOf = async (viewer: string) => (await client!.query(
  `SELECT id FROM attention_items WHERE org_id=$1 AND user_id=$2 AND source_id=$3 LIMIT 1`, [orgId, viewer, actionId])).rows[0]?.id as string;
const mcpCtx = (viewer: string) => ({ org_id: orgId, user_id: viewer, role: roles[viewer]!, scopes: ['read:workspace', 'write:workspace'] });

test('W2a3-R5: attention mutations, counts and MCP attention tools follow the current action audience', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const viewer of [ids.peer, ids.guestApprover]) {
    const item = await itemOf(viewer);
    for (const step of ['seen', 'acknowledge', 'resolve']) {
      const response = await request(viewer, '/api/attention', `/${item}/${step}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 404, `${step} for an item outside the audience`);
    }
    const list = await (await request(viewer, '/api/attention', '?lane=needs_you')).json() as { counts: { needs_you: { count: number } } };
    assert.equal(list.counts.needs_you.count, 0, 'lane counts exclude items the viewer cannot open');
    const { humanAttentionList, humanAttentionGet, humanAttentionAcknowledge } = await import('../src/lib/mcp-tools/human.js');
    assert.equal(has(JSON.stringify(await humanAttentionList({ lane: 'all' } as any, mcpCtx(viewer))), 'CANARY-PLAIN'), false);
    assert.equal((await humanAttentionGet({ attention_id: item }, mcpCtx(viewer))).isError, true);
    assert.equal((await humanAttentionAcknowledge({ attention_id: item, idempotency_key: randomUUID() }, mcpCtx(viewer))).isError, true);
  }
  // The reviewer keeps working with its items, and responses carry no action params.
  const own = await itemOf(ids.requester);
  const seen = await request(ids.requester, '/api/attention', `/${own}/seen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(seen.status, 200);
  assert.equal(((await seen.json()) as any).item.metadata.params, undefined);
});

test('W2a3-R5: approval attention items store no action params', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { approvalToAttentionDraft } = await import('../src/lib/attention.js');
  const [row] = (await client!.query('SELECT * FROM agent_actions WHERE id=$1', [actionId])).rows;
  const draft = approvalToAttentionDraft(row, ids.approver);
  assert.equal(Object.hasOwn(draft.metadata, 'params'), false);
  assert.equal(draft.metadata.action, 'create_task');
});

test('W2a3-R5: backfill does not create approval items outside the viewer\'s current audience', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const guestOnly = randomUUID();
  await client!.query(`INSERT INTO agent_actions(id,org_id,user_id,action,params,approval_tier,approval_status,source)
    VALUES($1,$2,$3,'create_task',$4,'quick','pending','mention')`, [guestOnly, orgId, ids.requester, JSON.stringify({ title: 'CANARY-BACKFILL' })]);
  await client!.query('INSERT INTO agent_action_approvers(id,org_id,action_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, guestOnly, ids.guestApprover]);
  const { ensureAttentionBackfillForUser } = await import('../src/lib/attention.js');
  await ensureAttentionBackfillForUser({ orgId, userId: ids.guestApprover, role: 'guest' });
  const rows = (await client!.query('SELECT count(*)::int AS n FROM attention_items WHERE org_id=$1 AND source_id=$2', [orgId, guestOnly])).rows;
  assert.equal(rows[0].n, 0);
});

test('W2a3-R3-3: a Defty action is decided by its requester; an assignment naming another member does not count', async (t) => {
  if (unavailable) return t.skip(unavailable);
  routes['/api/agent'] ??= (await import('../src/routes/agent.js')).agentRoutes;
  const { approveAction } = await import('../src/lib/agent-approval-resolver.js');
  const make = async (action: string, approver: string) => {
    const id = randomUUID();
    await client!.query(`INSERT INTO agent_actions(id,org_id,user_id,action,params,approval_tier,approval_status,source)
      VALUES($1,$2,$3,$4,$5,'quick','pending','mention')`, [id, orgId, ids.requester, action, JSON.stringify({ title: 'Fact check', content: 'Fact check' })]);
    await client!.query('INSERT INTO agent_action_approvers(id,org_id,action_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, id, approver]);
    return id;
  };
  const approveAs = (viewer: string, id: string) => request(viewer, '/api/agent', `/actions/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const legacyAction = await make('create_reminder', ids.approver);
  assert.equal((await approveAs(ids.approver, legacyAction)).status, 404, 'an assigned member who is not a reviewer');
  const legacy = await approveAs(ids.requester, legacyAction);
  assert.ok(![403, 404].includes(legacy.status), `the requester passes the web gate for a Defty action (got ${legacy.status})`);

  // The resolver accepts the requester; this queued MCP write then
  // stops on its own precondition (it names no agent employee), not on
  // authorization, and nothing is claimed.
  const resolverAction = await make('task_create', ids.approver);
  const resolver = await approveAs(ids.requester, resolverAction);
  assert.equal(resolver.status, 400);
  assert.equal(((await resolver.json()) as { code: string }).code, 'EMPLOYEE_MISSING');
  const [unclaimed] = (await client!.query('SELECT approval_status FROM agent_actions WHERE id=$1', [resolverAction])).rows;
  assert.equal(unclaimed.approval_status, 'pending');

  // An assigned guest is outside the action's audience on the web route,
  // and the resolver refuses it as well.
  const guestAction = await make('task_create', ids.guestApprover);
  assert.equal((await approveAs(ids.guestApprover, guestAction)).status, 404);
  const guestDirect = await approveAction(guestAction, ids.guestApprover);
  assert.equal(guestDirect.status, 'error');
  assert.equal((guestDirect as { code: string }).code, 'FORBIDDEN');

  // A member who is neither assigned nor the requester is refused by the
  // web gate and by the resolver itself.
  const notAssigned = await make('task_create', ids.approver);
  assert.equal((await approveAs(ids.peer, notAssigned)).status, 404);
  const direct = await approveAction(notAssigned, ids.peer);
  assert.equal(direct.status, 'error');
  assert.equal((direct as { code: string }).code, 'FORBIDDEN');
});

test('W2a3-R3-1: employee turn receipts and turn payloads follow the action and source audience', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const turnSpace = randomUUID();
  await client!.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,\'private\',$4)', [turnSpace, orgId, `turns-${turnSpace}`, ids.requester]);
  await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), turnSpace, ids.requester]);
  const turnId = randomUUID();
  const at = new Date();
  const turnAsk = randomUUID();
  await client!.query('INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,$5)', [turnAsk, orgId, turnSpace, ids.requester, '@Defty look this up']);
  await client!.query(`INSERT INTO agent_session_turns(id,org_id,employee_id,trigger_kind,space_id,triggering_message_id,input_messages_json,tool_calls_json,raw_reply_text,latency_ms,result,created_at)
    VALUES($1,$2,$3,'mention',$4,$8,$5,$6,'CANARY-REPLY',10,'success',$7::timestamp)`,
    [turnId, orgId, deftyEmployeeId, turnSpace, JSON.stringify([{ role: 'user', content: 'CANARY-INPUT' }]), JSON.stringify([{ tool: 'wiki_read', params: { slug: 'CANARY-TOOL' } }]), at.toISOString(), turnAsk]);
  // Receipt times use the same parameter encoding as the route's window bound.
  // The requester's receipt, then a newer receipt for an action outside the requester's audience.
  const guestOwn = randomUUID();
  await client!.query(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,action,params,approval_tier,approval_status,source)
    VALUES($1,$2,$3,$4,'create_task',$5,'quick','approved','mention')`, [guestOwn, orgId, ids.guestApprover, deftyEmployeeId, JSON.stringify({ title: 'CANARY-OTHER' })]);
  const receipt = (actionId: string, title: string, offsetMs: number) => client!.query(`INSERT INTO action_receipts(id,org_id,action_id,employee_id,proposer,decision,action_name,action_params_json,signature_hmac,created_at)
    VALUES($1,$2,$3,$4,'defty','approved','create_task',$5,'sig',$6::timestamp)`, [randomUUID(), orgId, actionId, deftyEmployeeId, JSON.stringify({ title }), new Date(at.getTime() + offsetMs)]);
  await receipt(employeeActionId, 'CANARY-RECEIPT', 1000);
  await receipt(guestOwn, 'CANARY-OTHER', 2000);
  const receiptAs = async (viewer: string) => {
    const response = await request(viewer, '/api/agent-employees', `/${deftyEmployeeId}/turns/${turnId}/receipt`);
    return { status: response.status, body: await response.text() };
  };
  const own = await receiptAs(ids.requester);
  assert.equal(own.status, 200);
  assert.equal(has(own.body, 'CANARY-RECEIPT'), true, 'the requester gets its own receipt, not a newer one it cannot see');
  assert.equal(has(own.body, 'CANARY-OTHER'), false);
  assert.equal((await receiptAs(ids.peer)).status, 404);
  const turnsAs = async (viewer: string) => {
    const response = await request(viewer, '/api/agent-employees', `/${deftyEmployeeId}/turns`);
    assert.equal(response.status, 200);
    return JSON.stringify(((await response.json()) as { turns: Array<{ id: string }> }).turns.filter((turn) => turn.id === turnId));
  };
  const peerTurn = await turnsAs(ids.peer);
  assert.equal(has(peerTurn, turnId), true, 'members still see that the turn happened');
  for (const canary of ['CANARY-INPUT', 'CANARY-TOOL', 'CANARY-REPLY']) assert.equal(has(peerTurn, canary), false, canary);
  for (const viewer of [ids.requester, ids.admin]) {
    const body = await turnsAs(viewer);
    for (const canary of ['CANARY-INPUT', 'CANARY-TOOL', 'CANARY-REPLY']) assert.equal(has(body, canary), true, `${roles[viewer]} ${canary}`);
  }
});

test('W2a3-R4-B: turn content follows the requester or source audience, never bare space membership', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const q = (text: string, values: unknown[]) => client!.query(text, values);
  const space = async (type: string, members: string[]) => {
    const id = randomUUID();
    await q('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,$4,$5)', [id, orgId, `turn-${id}`, type, ids.requester]);
    for (const user of members) await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), id, user]);
    return id;
  };
  const message = async (spaceId: string, author: string) => {
    const id = randomUUID();
    await q('INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,\'@agent please\')', [id, orgId, spaceId, author]);
    return id;
  };
  const turn = async (employeeId: string, canary: string, spaceId: string | null, triggerId: string | null) => {
    const id = randomUUID();
    await q(`INSERT INTO agent_session_turns(id,org_id,employee_id,trigger_kind,space_id,triggering_message_id,input_messages_json,latency_ms,result)
      VALUES($1,$2,$3,'mention',$4,$5,$6,10,'success')`, [id, orgId, employeeId, spaceId, triggerId, JSON.stringify([{ role: 'user', content: canary }])]);
    return id;
  };
  const sees = async (viewer: string, employeeId: string, turnId: string, canary: string) => {
    const response = await request(viewer, '/api/agent-employees', `/${employeeId}/turns?limit=100`);
    assert.equal(response.status, 200);
    const rows = ((await response.json()) as { turns: Array<{ id: string }> }).turns.filter((row) => row.id === turnId);
    assert.equal(rows.length, 1, 'every member sees that the turn happened');
    return has(JSON.stringify(rows), canary);
  };

  // Defty turn in a shared channel.
  const channel = await space('public', [ids.requester, ids.peer, ids.approver]);
  const ask = await message(channel, ids.requester);
  const deftyTurn = await turn(deftyEmployeeId, 'CANARY-DEFTY-TURN', channel, ask);
  const anchored = randomUUID();
  await q(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,action,params,approval_tier,approval_status,source)
    VALUES($1,$2,$3,$4,'create_task',$5,'quick','pending','mention')`, [anchored, orgId, ids.requester, deftyEmployeeId, JSON.stringify({ title: 'x', source_message_id: ask })]);
  await q('INSERT INTO agent_action_approvers(id,org_id,action_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, anchored, ids.approver]);
  // A peer's own action that names the requester's message as its source does not open the requester's turn.
  await q(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,action,params,approval_tier,approval_status,source)
    VALUES($1,$2,$3,$4,'create_task',$5,'quick','pending','mention')`, [randomUUID(), orgId, ids.peer, deftyEmployeeId, JSON.stringify({ title: 'y', source_message_id: ask })]);
  for (const viewer of [ids.requester, ids.admin]) assert.equal(await sees(viewer, deftyEmployeeId, deftyTurn, 'CANARY-DEFTY-TURN'), true, `defty turn: ${viewer}`);
  for (const viewer of [ids.peer, ids.approver, ids.guestApprover]) assert.equal(await sees(viewer, deftyEmployeeId, deftyTurn, 'CANARY-DEFTY-TURN'), false, `defty turn: ${viewer}`);

  // Defty turn with no resolvable requester: owners/admins only.
  const orphan = await turn(deftyEmployeeId, 'CANARY-ORPHAN-TURN', null, null);
  assert.equal(await sees(ids.admin, deftyEmployeeId, orphan, 'CANARY-ORPHAN-TURN'), true);
  for (const viewer of [ids.requester, ids.peer]) assert.equal(await sees(viewer, deftyEmployeeId, orphan, 'CANARY-ORPHAN-TURN'), false);

  // BYOA turn: the employee source rule (current employee access and reader access to the source).
  const agentUser = randomUUID();
  extraUsers.push(agentUser);
  const byoa = randomUUID();
  await q('INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,\'Rita\',\'agent\',true)', [agentUser, `${agentUser}@example.test`]);
  await q('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,\'member\')', [randomUUID(), orgId, agentUser]);
  await q(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,expertise_description,trust_level,is_active,is_byoa,runtime_kind,wake_mode,certification_status,created_by)
    VALUES($1,$2,$3,'Rita',$4,'custom','Test.','Test.','conservative',true,true,'custom_mcp','manual','token_issued',$5)`, [byoa, orgId, agentUser, `rita-${byoa.slice(0, 8)}`, ids.requester]);
  const room = await space('private', [ids.requester, ids.peer, agentUser]);
  const byoaTurn = await turn(byoa, 'CANARY-BYOA-TURN', room, await message(room, ids.requester));
  assert.equal(await sees(ids.peer, byoa, byoaTurn, 'CANARY-BYOA-TURN'), true, 'a reader of the source sees an employee turn');
  assert.equal(await sees(ids.approver, byoa, byoaTurn, 'CANARY-BYOA-TURN'), false, 'a non-reader of the source does not');
  await q('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [room, agentUser]);
  assert.equal(await sees(ids.peer, byoa, byoaTurn, 'CANARY-BYOA-TURN'), false, 'revoked employee access closes the content');
  assert.equal(await sees(ids.admin, byoa, byoaTurn, 'CANARY-BYOA-TURN'), true);
  const byoaOrphan = await turn(byoa, 'CANARY-BYOA-ORPHAN', null, null);
  assert.equal(await sees(ids.peer, byoa, byoaOrphan, 'CANARY-BYOA-ORPHAN'), false);
});
