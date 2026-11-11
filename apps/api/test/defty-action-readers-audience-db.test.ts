/**
 * Item W2a3-2: readers of agent_actions with their own checks follow the
 * shared Defty action audience (requester, assigned approver, owner/admin;
 * a guest only for its own request). Assigned approvers reach the approvals
 * assigned to them on every approval surface.
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
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
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
  for (const viewer of [ids.requester, ids.approver, ids.admin]) {
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
  for (const viewer of [ids.requester, ids.approver, ids.admin]) {
    assert.equal(has(await read(viewer), '"title":"CANARY-PLAIN"'), true, `${roles[viewer]} keeps the approval payload`);
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

test('W2a3-2d: human MCP approval tools reach an assigned approver; others stay outside', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { humanApprovalList, humanApprovalGet } = await import('../src/lib/mcp-tools/human.js');
  const ctx = (viewer: string) => ({ org_id: orgId, user_id: viewer, role: roles[viewer]!, scopes: ['read:workspace', 'write:workspace'] });
  const listed = async (viewer: string) => JSON.stringify(await humanApprovalList({ status: 'pending' }, ctx(viewer)));
  const got = async (viewer: string) => (await humanApprovalGet({ action_id: actionId }, ctx(viewer))).isError !== true;
  assert.equal(has(await listed(ids.approver), actionId), true, 'an assigned approver lists the approval');
  assert.equal(await got(ids.approver), true, 'an assigned approver reads the approval');
  assert.equal(has(await listed(ids.peer), actionId), false);
  assert.equal(await got(ids.peer), false);
  assert.equal(has(await listed(ids.guestApprover), actionId), false, 'a guest approver stays requester-only');
  assert.equal(await got(ids.guestApprover), false);
  assert.equal(await got(ids.requester), true);
});

test('W2a3-2e: the legacy inbox approval filter lists approvals for their assigned approver', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const read = async (viewer: string) => {
    const response = await request(viewer, '/api/inbox', '?kind=pending_approval');
    assert.equal(response.status, 200, await response.clone().text());
    return JSON.stringify(await response.json());
  };
  assert.equal(has(await read(ids.approver), actionId), true);
  assert.equal(has(await read(ids.requester), actionId), true);
  assert.equal(has(await read(ids.peer), actionId), false);
  assert.equal(has(await read(ids.guestApprover), actionId), false);
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
  // The audience keeps working with its items, and responses carry no action params.
  const own = await itemOf(ids.approver);
  const seen = await request(ids.approver, '/api/attention', `/${own}/seen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
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

test('W2a3-R8: MCP approval tools mark approvals the caller cannot act on as view only and do not act on them', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { humanApprovalList, humanApprovalGet, humanApprovalApprove, humanApprovalReject } = await import('../src/lib/mcp-tools/human.js');
  const payload = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);
  const listed = (payload(await humanApprovalList({ status: 'pending' }, mcpCtx(ids.approver)) as any) as Array<{ id: string; actionable: boolean }>).find((row) => row.id === actionId)!;
  assert.equal(listed.actionable, false);
  assert.equal((payload(await humanApprovalGet({ action_id: actionId }, mcpCtx(ids.approver)) as any) as { actionable: boolean }).actionable, false);
  for (const act of [humanApprovalApprove, humanApprovalReject]) {
    const result = await act({ action_id: actionId, idempotency_key: randomUUID() }, mcpCtx(ids.approver));
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /view only/i);
  }
  const [row] = (await client!.query('SELECT approval_status FROM agent_actions WHERE id=$1', [actionId])).rows;
  assert.equal(row.approval_status, 'pending');
  assert.equal((payload(await humanApprovalGet({ action_id: actionId }, mcpCtx(ids.requester)) as any) as { actionable: boolean }).actionable, true);
  assert.equal((payload(await humanApprovalGet({ action_id: actionId }, mcpCtx(ids.admin)) as any) as { actionable: boolean }).actionable, true);
});

test('W2a3-R8: inbox approvals say whether the web approval route lets the caller act', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const resolverAction = randomUUID();
  await client!.query(`INSERT INTO agent_actions(id,org_id,user_id,action,params,approval_tier,approval_status,source)
    VALUES($1,$2,$3,'task_create',$4,'quick','pending','mcp')`, [resolverAction, orgId, ids.requester, JSON.stringify({ title: 'Resolver-owned' })]);
  await client!.query('INSERT INTO agent_action_approvers(id,org_id,action_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, resolverAction, ids.approver]);
  const items = async (viewer: string) => ((await (await request(viewer, '/api/inbox', '?kind=pending_approval')).json()) as { items: Array<{ approval?: { action_id: string; actionable: boolean } }> })
    .items.flatMap((item) => item.approval ? [item.approval] : []);
  const approverItems = await items(ids.approver);
  assert.equal(approverItems.find((item) => item.action_id === actionId)?.actionable, true, 'an assigned approver acts on a Defty action through the web route');
  assert.equal(approverItems.find((item) => item.action_id === resolverAction)?.actionable, false, 'resolver-owned approvals accept only the requester or an owner/admin');
  const requesterItems = await items(ids.requester);
  assert.equal(requesterItems.find((item) => item.action_id === actionId)?.actionable, false, 'assigned approvers, not the requester, review an action that has them');
});

test('W2a3-R8: web approval route facts — an assigned approver passes the route gate, the resolver accepts only requester or owner/admin', async (t) => {
  if (unavailable) return t.skip(unavailable);
  routes['/api/agent'] ??= (await import('../src/routes/agent.js')).agentRoutes;
  const make = async (action: string) => {
    const id = randomUUID();
    await client!.query(`INSERT INTO agent_actions(id,org_id,user_id,action,params,approval_tier,approval_status,source)
      VALUES($1,$2,$3,$4,$5,'quick','pending','mention')`, [id, orgId, ids.requester, action, JSON.stringify({ title: 'Fact check', content: 'Fact check' })]);
    await client!.query('INSERT INTO agent_action_approvers(id,org_id,action_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, id, ids.approver]);
    return id;
  };
  const approve = (id: string) => request(ids.approver, '/api/agent', `/actions/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const legacy = await approve(await make('create_reminder'));
  assert.ok(![403, 404].includes(legacy.status), `assigned approver passes the web gate for a Defty action (got ${legacy.status})`);
  const resolver = await approve(await make('task_create'));
  assert.equal(resolver.status, 403);
  assert.equal(((await resolver.json()) as { code: string }).code, 'FORBIDDEN');
});

test('W2a3-R3-1: employee turn receipts and turn payloads follow the action and source audience', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const turnSpace = randomUUID();
  await client!.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,\'private\',$4)', [turnSpace, orgId, `turns-${turnSpace}`, ids.requester]);
  await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), turnSpace, ids.requester]);
  const turnId = randomUUID();
  const at = new Date();
  await client!.query(`INSERT INTO agent_session_turns(id,org_id,employee_id,trigger_kind,space_id,input_messages_json,tool_calls_json,raw_reply_text,latency_ms,result,created_at)
    VALUES($1,$2,$3,'mention',$4,$5,$6,'CANARY-REPLY',10,'success',$7::timestamp)`,
    [turnId, orgId, deftyEmployeeId, turnSpace, JSON.stringify([{ role: 'user', content: 'CANARY-INPUT' }]), JSON.stringify([{ tool: 'wiki_read', params: { slug: 'CANARY-TOOL' } }]), at.toISOString()]);
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
