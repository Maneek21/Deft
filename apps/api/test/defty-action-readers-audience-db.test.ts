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
    for (const table of ['api_keys', 'attention_events', 'attention_items', 'agent_action_approvers', 'agent_actions', 'notifications', 'space_members', 'agent_employees', 'org_members']) {
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
