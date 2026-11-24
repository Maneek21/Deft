// Check 13, fix 1 (cases 13.1 and 13.2): an assistant action that came from a
// room a person lost — removed by the creator, or left by themselves — leaves
// every list, count and detail view of theirs, and approving it is refused
// without naming the room. Owners/admins keep the action history, and a member
// of an archived room keeps its history.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import bcrypt from 'bcryptjs';
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
const rooms = { removed: randomUUID(), left: randomUUID(), groupDm: randomUUID(), kept: randomUUID(), archived: randomUUID() };
const lostRooms = [rooms.removed, rooms.left, rooms.groupDm];
const roomNames: Record<string, string> = {
  [rooms.removed]: 'lostroom-removed', [rooms.left]: 'lostroom-left', [rooms.groupDm]: 'lostroom-group-dm',
  [rooms.kept]: 'keptroom', [rooms.archived]: 'archivedroom',
};
// Per room, Mia's Defty actions:
// - pending: a proposal attached to her message in the room;
// - envelope: the same in the Defty envelope;
// - approved: an approved one, for the single-action reads;
// - plan: a plan step, which carries only the room as its conversation;
// - cross: attached to her message in the kept room, drafted from a message of this room.
// And one pending proposal Gus (guest) asked for.
type RoomActions = { pending: string; envelope: string; approved: string; plan: string; cross: string; guest: string };
const actions = Object.fromEntries(Object.values(rooms).map((room) => [room, {
  pending: randomUUID(), envelope: randomUUID(), approved: randomUUID(), plan: randomUUID(), cross: randomUUID(), guest: randomUUID(),
}])) as Record<string, RoomActions>;
const tokens = { [ids.mia]: `dft_${randomUUID().replaceAll('-', '')}`, [ids.olive]: `dft_${randomUUID().replaceAll('-', '')}` };
// An approved Defty action Olive (owner) asked for in the room she later leaves.
const oliveAction = randomUUID();
let client: pg.Client | undefined;
let seeded = false;
let routes: { agent?: Hono; inbox?: Hono; spaces?: Hono; mcp?: Hono } = {};

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

async function inboxApprovalIds(viewer: string): Promise<Set<string>> {
  const { status, text } = await json(viewer, '/api/inbox?kind=pending_approval&limit=100');
  assert.equal(status, 200, text);
  const body = JSON.parse(text) as { items: Array<{ approval?: { action_id: string } }> };
  return new Set(body.items.flatMap((item) => item.approval ? [item.approval.action_id] : []));
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

async function mcpStatus(actionId: string, holder = ids.mia): Promise<number> {
  const hono = new Hono();
  hono.route('/api/mcp', routes.mcp!);
  const response = await hono.request(`/api/mcp/actions/${actionId}/status`, { headers: { authorization: `Bearer ${tokens[holder]}` } });
  return response.status;
}

/** The kept room's inline approval cards for Mia. */
async function keptRoomCards(): Promise<Set<string>> {
  return listIds(ids.mia, `/api/agent/actions/pending-by-space?space_id=${rooms.kept}`);
}

function owned(viewer: string, room: string) {
  const own = actions[room]!;
  return viewer === ids.gus
    ? { all: [own.guest], pending: [own.guest] }
    : { all: [own.pending, own.envelope, own.approved, own.plan, own.cross], pending: [own.pending, own.envelope, own.plan, own.cross] };
}

/** How many of the viewer's actions from the room each read surface returns. */
async function views(viewer: string, room: string) {
  const mine = owned(viewer, room);
  const list = await listIds(viewer, '/api/agent/actions');
  const recent = await listIds(viewer, '/api/agent/actions/recent?limit=50');
  const pending = await listIds(viewer, '/api/agent/actions/pending');
  const inbox = await inboxApprovalIds(viewer);
  return {
    list: mine.all.filter((id) => list.has(id)).length,
    recent: mine.all.filter((id) => recent.has(id)).length,
    pending: mine.pending.filter((id) => pending.has(id)).length,
    inbox: mine.pending.filter((id) => inbox.has(id)).length,
  };
}

async function assertNothingLeaks(viewer: string, room: string) {
  for (const path of ['/api/agent/actions', '/api/agent/actions/recent?limit=50', '/api/agent/actions/pending', '/api/inbox?kind=pending_approval']) {
    const { status, text } = await json(viewer, path);
    assert.equal(status, 200, text);
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
  for (const [holder, token] of Object.entries(tokens)) {
    await client.query(`INSERT INTO api_keys(id,org_id,name,key_hash,key_prefix,permissions,created_by)
      VALUES($1,$2,'lost room',$3,$4,ARRAY['read'],$5)`, [randomUUID(), orgId, await bcrypt.hash(token, 4), token.slice(0, 12), holder]);
  }
  const { ensureDeftyEmployee } = await import('../src/lib/ensure-defty-membership.js');
  const deftyEmployeeId = (await ensureDeftyEmployee(orgId)).employeeId;
  const message = async (room: string, author: string) => {
    const id = randomUUID();
    await client!.query("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'@Defty post the summary here')",
      [id, orgId, room, author]);
    return id;
  };
  for (const room of Object.values(rooms)) {
    const type = room === rooms.groupDm ? 'group_dm' : 'private';
    await client.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,$4,$5)', [room, orgId, roomNames[room], type, ids.olive]);
    const members = room === rooms.groupDm ? [ids.mia, ids.olive, ids.adam] : Object.values(ids);
    for (const user of members) {
      await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), room, user]);
    }
  }
  for (const room of Object.values(rooms)) {
    const insert = async (
      id: string, requester: string, employee: string | null, status: 'pending' | 'approved',
      anchor: { message?: string; conversation?: string; source?: string },
    ) => client!.query(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,conversation_id,message_id,source,action,params,approval_tier,approval_status)
        VALUES($1,$2,$3,$4,$5,$6,'mention','post_message',$7,'quick',$8)`,
    [id, orgId, requester, employee, anchor.conversation ?? null, anchor.message ?? null,
      JSON.stringify({
        space_id: room, space_name: roomNames[room], content: `CANARY-${room}`,
        ...(anchor.source ? { source_message_id: anchor.source } : {}),
      }), status]);
    const own = actions[room]!;
    await insert(own.pending, ids.mia, null, 'pending', { message: await message(room, ids.mia), conversation: room });
    await insert(own.envelope, ids.mia, deftyEmployeeId, 'pending', { message: await message(room, ids.mia) });
    await insert(own.approved, ids.mia, null, 'approved', { message: await message(room, ids.mia) });
    await insert(own.plan, ids.mia, null, 'pending', { conversation: room });
    await insert(own.cross, ids.mia, null, 'pending', {
      message: await message(rooms.kept, ids.mia), conversation: rooms.kept, source: await message(room, ids.olive),
    });
    if (room !== rooms.groupDm) await insert(own.guest, ids.gus, null, 'pending', { message: await message(room, ids.gus) });
    if (room === rooms.removed) await insert(oliveAction, ids.olive, null, 'approved', { message: await message(room, ids.olive), conversation: room });
  }
  routes = {
    agent: (await import('../src/routes/agent.js')).agentRoutes,
    inbox: (await import('../src/routes/inbox.js')).inboxRoutes,
    spaces: (await import('../src/routes/spaces.js')).spaceRoutes,
    mcp: (await import('../src/routes/mcp-server.js')).mcpServerRoutes,
  };
});

after(async () => {
  try {
    if (seeded && client) {
      for (const table of ['api_keys', 'agent_action_approvers', 'agent_actions', 'messages']) {
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
  const everything = { list: 5, recent: 5, pending: 4, inbox: 4 };
  const nothing = { list: 0, recent: 0, pending: 0, inbox: 0 };

  // While a member of every room, the requester sees each room's actions.
  for (const room of Object.values(rooms)) assert.deepEqual(await views(ids.mia, room), everything, roomNames[room]);
  assert.deepEqual(await views(ids.gus, rooms.removed), { list: 1, recent: 1, pending: 1, inbox: 1 });
  assert.equal(await receiptError(ids.mia, actions[rooms.removed]!.approved), 'no receipt for action');
  assert.equal(await mcpStatus(actions[rooms.removed]!.approved), 200);
  assert.equal(await approvalCount(ids.mia), 20, 'four pending approvals in each of five rooms');
  const keptOwn = [actions[rooms.kept]!.pending, actions[rooms.kept]!.envelope];
  const lostCross = lostRooms.map((room) => actions[room]!.cross);
  const cardsBefore = await keptRoomCards();
  for (const id of [...keptOwn, ...lostCross]) assert.ok(cardsBefore.has(id), 'kept room cards before');
  assert.equal(await mcpStatus(oliveAction, ids.olive), 200);

  // 13.1: the creator removes Mia and Gus from a private room and Mia from a group DM.
  for (const [room, user] of [[rooms.removed, ids.mia], [rooms.removed, ids.gus], [rooms.groupDm, ids.mia]] as const) {
    const removed = await json(ids.olive, `/api/spaces/${room}/members/${user}`, { method: 'DELETE' });
    assert.equal(removed.status, 200, removed.text);
  }
  // 13.2: Mia leaves the other private room herself.
  const left = await json(ids.mia, `/api/spaces/${rooms.left}/members/me`, { method: 'DELETE' });
  assert.equal(left.status, 200, left.text);
  // A room Mia stays in is archived.
  await client!.query('UPDATE spaces SET is_archived=true WHERE id=$1', [rooms.archived]);

  for (const room of lostRooms) {
    assert.deepEqual(await views(ids.mia, room), nothing, `${roomNames[room]}: lists, recent, pending and Inbox`);
    await assertNothingLeaks(ids.mia, room);
    assert.equal(await receiptError(ids.mia, actions[room]!.approved), 'action not found', 'single-action read');
    assert.equal(await mcpStatus(actions[room]!.approved), 404, 'legacy MCP status read');
    for (const id of owned(ids.mia, room).pending) {
      const refused = await json(ids.mia, `/api/agent/actions/${id}/approve`, { method: 'POST' });
      assert.equal(refused.status, 404, refused.text);
      assert.deepEqual(JSON.parse(refused.text), { error: 'Not found', code: 'NOT_FOUND' });
    }
  }
  assert.deepEqual(await views(ids.gus, rooms.removed), nothing, 'a guest removed from the room');
  await assertNothingLeaks(ids.gus, rooms.removed);

  // The kept room's inline cards drop the actions drafted from a lost room.
  const cardsAfter = await keptRoomCards();
  for (const id of keptOwn) assert.ok(cardsAfter.has(id), 'kept room cards stay');
  for (const id of lostCross) assert.ok(!cardsAfter.has(id), 'a card drafted from a lost room is gone');

  // A room the requester still belongs to is unchanged.
  assert.deepEqual(await views(ids.mia, rooms.kept), everything);
  assert.equal(await receiptError(ids.mia, actions[rooms.kept]!.approved), 'no receipt for action');
  assert.equal(await mcpStatus(actions[rooms.kept]!.approved), 200);
  // An archived room keeps its history for its members; nothing in it is reviewable.
  assert.deepEqual(await views(ids.mia, rooms.archived), { list: 5, recent: 5, pending: 0, inbox: 0 });
  assert.equal(await receiptError(ids.mia, actions[rooms.archived]!.approved), 'no receipt for action');
  assert.equal(await approvalCount(ids.mia), 4, 'the Inbox approval count keeps only the room Mia is still in');

  // DFX2: losing the room cancelled them (with a reason); the refused
  // approvals ran nothing.
  const refusedIds = lostRooms.flatMap((room) => owned(ids.mia, room).pending);
  const { rows } = await client!.query('SELECT approval_status, approved_at, executed_at FROM agent_actions WHERE id=ANY($1::text[])', [refusedIds]);
  assert.deepEqual(rows.map((row) => [row.approval_status, row.approved_at, row.executed_at]), Array(refusedIds.length).fill(['expired', null, null]));

  // Owners and admins keep the whole action history, whatever rooms they are in.
  const removedAdmin = await json(ids.olive, `/api/spaces/${rooms.removed}/members/${ids.adam}`, { method: 'DELETE' });
  assert.equal(removedAdmin.status, 200, removedAdmin.text);
  const ownerLeft = await json(ids.olive, `/api/spaces/${rooms.removed}/members/me`, { method: 'DELETE' });
  assert.equal(ownerLeft.status, 200, ownerLeft.text);
  assert.equal(await mcpStatus(oliveAction, ids.olive), 200, 'an owner keeps the status of her own action');
  for (const viewer of [ids.olive, ids.adam]) {
    const list = await listIds(viewer, '/api/agent/actions');
    for (const room of lostRooms) {
      for (const id of owned(ids.mia, room).all) assert.ok(list.has(id), `${roles[viewer]} keeps ${roomNames[room]} history`);
    }
  }
});
