// Check 13, fix 1 (cases 13.1 and 13.2): an assistant action that came from a
// room a person lost — removed by the creator, or left by themselves — leaves
// every list, count and detail view of theirs, and approving it is refused
// without naming the room. Owners/admins keep the action history.
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
const ids = { mia: randomUUID(), olive: randomUUID(), adam: randomUUID(), gus: randomUUID() };
const roles: Record<string, 'member' | 'owner' | 'admin' | 'guest'> = {
  [ids.mia]: 'member', [ids.olive]: 'owner', [ids.adam]: 'admin', [ids.gus]: 'guest',
};
const rooms = { removed: randomUUID(), left: randomUUID(), groupDm: randomUUID(), kept: randomUUID() };
const roomNames: Record<string, string> = {
  [rooms.removed]: 'lostroom-removed', [rooms.left]: 'lostroom-left',
  [rooms.groupDm]: 'lostroom-group-dm', [rooms.kept]: 'keptroom',
};
// Per room: a pending Defty proposal (no employee), a pending proposal in the
// Defty envelope, an approved one (for the single-action receipt read), and a
// pending one the guest asked for.
type RoomActions = { pending: string; envelope: string; approved: string; guest: string };
const actions = Object.fromEntries(Object.values(rooms).map((room) => [room, {
  pending: randomUUID(), envelope: randomUUID(), approved: randomUUID(), guest: randomUUID(),
}])) as Record<string, RoomActions>;
let client: pg.Client | undefined;
let seeded = false;
let routes: { agent?: Hono; inbox?: Hono; spaces?: Hono } = {};

function app(viewer: string) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: viewer, org_id: orgId, email: `${viewer}@example.test`, role: roles[viewer] } as any);
    await next();
  });
  hono.route('/api/agent', routes.agent!);
  hono.route('/api/inbox', routes.inbox!);
  hono.route('/api/spaces', routes.spaces!);
  return hono;
}

async function json(viewer: string, path: string, init?: RequestInit) {
  const response = await app(viewer).request(path, init);
  return { status: response.status, text: await response.text() };
}

async function listIds(viewer: string, path: string): Promise<Set<string>> {
  const { status, text } = await json(viewer, path);
  assert.equal(status, 200, text);
  const body = JSON.parse(text) as Array<{ id: string }> | { actions: Array<{ id: string }> };
  return new Set((Array.isArray(body) ? body : body.actions).map((row) => row.id));
}

async function approvalCount(viewer: string): Promise<number> {
  const { status, text } = await json(viewer, '/api/inbox?kind=pending_approval&count_only=1');
  assert.equal(status, 200, text);
  return (JSON.parse(text) as { unread_count: number }).unread_count;
}

async function receiptError(viewer: string, actionId: string): Promise<string> {
  const { status, text } = await json(viewer, `/api/agent/actions/${actionId}/receipt`);
  assert.equal(status, 404, text);
  return (JSON.parse(text) as { error: string }).error;
}

/** Every read surface of `viewer`'s for the room's actions. */
async function views(viewer: string, room: string) {
  const own = actions[room]!;
  const mine = viewer === ids.gus ? [own.guest] : [own.pending, own.envelope, own.approved];
  const list = await listIds(viewer, '/api/agent/actions');
  const recent = await listIds(viewer, '/api/agent/actions/recent?limit=50');
  const pending = await listIds(viewer, '/api/agent/actions/pending');
  return {
    list: mine.filter((id) => list.has(id)).length,
    recent: mine.filter((id) => recent.has(id)).length,
    pending: mine.filter((id) => pending.has(id)).length,
  };
}

async function assertNothingLeaks(viewer: string, room: string) {
  for (const path of ['/api/agent/actions', '/api/agent/actions/recent?limit=50', '/api/agent/actions/pending', '/api/inbox?kind=pending_approval']) {
    const { text } = await json(viewer, path);
    assert.ok(!text.includes(roomNames[room]!), `${path} names the lost room`);
    assert.ok(!text.includes(`CANARY-${room}`), `${path} carries the lost room's content`);
  }
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await client.connect();
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Lost room actions', `lost-room-${orgId}`]);
  seeded = true;
  for (const [name, id] of Object.entries(ids)) {
    await client.query("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,'human',false)", [id, `${id}@example.test`, name]);
    await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, id, roles[id]]);
  }
  const { ensureDeftyEmployee } = await import('../src/lib/ensure-defty-membership.js');
  const deftyEmployeeId = (await ensureDeftyEmployee(orgId)).employeeId;
  for (const room of Object.values(rooms)) {
    const type = room === rooms.groupDm ? 'group_dm' : 'private';
    await client.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,$4,$5)', [room, orgId, roomNames[room], type, ids.olive]);
    const members = room === rooms.groupDm ? [ids.mia, ids.olive, ids.adam] : Object.values(ids);
    for (const user of members) {
      await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), room, user]);
    }
    const insert = async (id: string, requester: string, employee: string | null, status: 'pending' | 'approved') => {
      const message = randomUUID();
      await client!.query("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'@Defty post the summary here')",
        [message, orgId, room, requester]);
      await client!.query(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,message_id,source,action,params,approval_tier,approval_status)
        VALUES($1,$2,$3,$4,$5,'mention','post_message',$6,'quick',$7)`,
      [id, orgId, requester, employee, message,
        JSON.stringify({ space_id: room, space_name: roomNames[room], content: `CANARY-${room}` }), status]);
    };
    const own = actions[room]!;
    await insert(own.pending, ids.mia, null, 'pending');
    await insert(own.envelope, ids.mia, deftyEmployeeId, 'pending');
    await insert(own.approved, ids.mia, null, 'approved');
    if (room !== rooms.groupDm) await insert(own.guest, ids.gus, null, 'pending');
  }
  routes = {
    agent: (await import('../src/routes/agent.js')).agentRoutes,
    inbox: (await import('../src/routes/inbox.js')).inboxRoutes,
    spaces: (await import('../src/routes/spaces.js')).spaceRoutes,
  };
});

after(async () => {
  try {
    if (seeded && client) {
      for (const table of ['agent_action_approvers', 'agent_actions', 'messages']) {
        await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
      }
      await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
      for (const table of ['spaces', 'agent_employees', 'org_members']) {
        await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
      }
      await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
      await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(ids)]);
    }
  } finally {
    await client?.end();
    await closeDb();
  }
});

test('a lost room takes its assistant actions out of every list, count and detail view, and approval is refused cleanly', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const everything = { list: 3, recent: 3, pending: 2 };
  const nothing = { list: 0, recent: 0, pending: 0 };

  // While a member of every room, the requester sees each room's actions.
  for (const room of Object.values(rooms)) assert.deepEqual(await views(ids.mia, room), everything, roomNames[room]);
  assert.deepEqual(await views(ids.gus, rooms.removed), { list: 1, recent: 1, pending: 1 });
  assert.equal(await receiptError(ids.mia, actions[rooms.removed]!.approved), 'no receipt for action');
  const countBefore = await approvalCount(ids.mia);
  assert.equal(countBefore, 8, 'two pending approvals in each of four rooms');

  // 13.1: the creator removes Mia and Gus from a private room and Mia from a group DM.
  for (const [room, user] of [[rooms.removed, ids.mia], [rooms.removed, ids.gus], [rooms.groupDm, ids.mia]] as const) {
    const removed = await json(ids.olive, `/api/spaces/${room}/members/${user}`, { method: 'DELETE' });
    assert.equal(removed.status, 200, removed.text);
  }
  // 13.2: Mia leaves the other private room herself.
  const left = await json(ids.mia, `/api/spaces/${rooms.left}/members/me`, { method: 'DELETE' });
  assert.equal(left.status, 200, left.text);

  for (const room of [rooms.removed, rooms.left, rooms.groupDm]) {
    assert.deepEqual(await views(ids.mia, room), nothing, `${roomNames[room]}: lists, recent and pending`);
    await assertNothingLeaks(ids.mia, room);
    assert.equal(await receiptError(ids.mia, actions[room]!.approved), 'action not found', 'single-action read');
    for (const id of [actions[room]!.pending, actions[room]!.envelope]) {
      const refused = await json(ids.mia, `/api/agent/actions/${id}/approve`, { method: 'POST' });
      assert.equal(refused.status, 404, refused.text);
      assert.deepEqual(JSON.parse(refused.text), { error: 'Not found', code: 'NOT_FOUND' });
    }
  }
  assert.deepEqual(await views(ids.gus, rooms.removed), nothing, 'a guest removed from the room');
  await assertNothingLeaks(ids.gus, rooms.removed);
  assert.equal(await approvalCount(ids.mia), 2, 'the Inbox approval count keeps only the room Mia is still in');

  // A room the requester still belongs to is unchanged.
  assert.deepEqual(await views(ids.mia, rooms.kept), everything);
  assert.equal(await receiptError(ids.mia, actions[rooms.kept]!.approved), 'no receipt for action');

  // Refused approvals changed nothing.
  const { rows } = await client!.query('SELECT approval_status FROM agent_actions WHERE id=ANY($1::text[])',
    [[rooms.removed, rooms.left, rooms.groupDm].flatMap((room) => [actions[room]!.pending, actions[room]!.envelope])]);
  assert.deepEqual(rows.map((row) => row.approval_status), Array(6).fill('pending'));

  // Owners and admins keep the whole action history, whatever rooms they are in.
  const removedAdmin = await json(ids.olive, `/api/spaces/${rooms.removed}/members/${ids.adam}`, { method: 'DELETE' });
  assert.equal(removedAdmin.status, 200, removedAdmin.text);
  for (const viewer of [ids.olive, ids.adam]) {
    const list = await listIds(viewer, '/api/agent/actions');
    for (const room of [rooms.removed, rooms.left, rooms.groupDm]) {
      for (const id of [actions[room]!.pending, actions[room]!.envelope, actions[room]!.approved]) {
        assert.ok(list.has(id), `${roles[viewer]} keeps ${roomNames[room]} history`);
      }
    }
  }
});
