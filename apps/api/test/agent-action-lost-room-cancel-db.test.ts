// DFX2: when a person loses a room — removed from a space or a DM, left it,
// the space made private without them, made a guest of the workspace, or
// removed from the workspace — their pending assistant actions from that
// room are cancelled with a recorded reason. No later approval runs one,
// whoever reviews it, including when approval and loss happen together.
// Owners and admins keep the history.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { agentActions } from '@deft/db/schema';
import { closeDb, db } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
const orgId = randomUUID();
const ids = {
  mia: randomUUID(), olive: randomUUID(), adam: randomUUID(), rita: randomUUID(),
  gina: randomUUID(), pam: randomUUID(), sam: randomUUID(), ray: randomUUID(), kay: randomUUID(),
};
const roles: Record<string, 'member' | 'owner' | 'admin' | 'guest'> = Object.fromEntries(
  Object.values(ids).map((id) => [id, id === ids.olive ? 'owner' : id === ids.adam ? 'admin' : 'member']),
);
const rooms = {
  removed: randomUUID(), left: randomUUID(), dm: randomUUID(), open: randomUUID(),
  kept: randomUUID(), archived: randomUUID(), guard: randomUUID(), race: randomUUID(),
};
const act = {
  removed: randomUUID(), capture: randomUUID(), approvedHistory: randomUUID(), left: randomUUID(), dm: randomUUID(),
  kept: randomUUID(), archived: randomUUID(), guest: randomUUID(), madePrivate: randomUUID(), workspace: randomUUID(),
  guard: randomUUID(), raceClaimFirst: randomUUID(), raceLossFirst: randomUUID(), raceTogether: randomUUID(),
};
let client: pg.Client | undefined;
let seeded = false;
let routes: { agent?: Hono; spaces?: Hono; members?: Hono } = {};
let REASON = '';

function app(viewer: string) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: viewer, org_id: orgId, email: `${viewer}@example.test`, role: roles[viewer] } as any);
    await next();
  });
  hono.route('/api/agent', routes.agent!);
  hono.route('/api/spaces', routes.spaces!);
  hono.route('/api/members', routes.members!);
  return hono;
}

async function call(viewer: string, path: string, init?: RequestInit) {
  const response = await app(viewer).request(path, init);
  return { status: response.status, text: await response.text() };
}

async function state(id: string) {
  const { rows } = await client!.query('SELECT approval_status, error, approved_at, executed_at FROM agent_actions WHERE id=$1', [id]);
  return rows[0] as { approval_status: string; error: string | null; approved_at: Date | null; executed_at: Date | null };
}

async function assertCancelled(id: string, label: string) {
  const row = await state(id);
  assert.equal(row.approval_status, 'expired', label);
  assert.equal(row.error, REASON, `${label}: reason recorded`);
  assert.equal(row.approved_at, null, `${label}: never approved`);
  assert.equal(row.executed_at, null, `${label}: never ran`);
}

async function assertPending(id: string, label: string) {
  assert.equal((await state(id)).approval_status, 'pending', label);
}

async function loadRow(id: string) {
  const [row] = await db.select().from(agentActions).where(and(eq(agentActions.id, id), eq(agentActions.org_id, orgId))).limit(1);
  return row!;
}

/** The person stops being in the room and in the workspace, with no route (so nothing cancels at once). */
async function silentlyRemoveFromWorkspace(userId: string) {
  await client!.query('DELETE FROM space_members WHERE user_id=$1 AND space_id IN (SELECT id FROM spaces WHERE org_id=$2)', [userId, orgId]);
  await client!.query('UPDATE org_members SET is_active=false WHERE org_id=$1 AND user_id=$2', [orgId, userId]);
}

before(async () => {
  if (unavailable) return;
  ({ LOST_ROOM_CANCEL_REASON: REASON } = await import('../src/lib/lost-room-action-cancellation.js'));
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await client.connect();
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Lost room cancel', `lost-room-cancel-${orgId}`]);
  seeded = true;
  for (const [name, id] of Object.entries(ids)) {
    await client.query("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,'human',false)", [id, `${id}@example.test`, name]);
    await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, id, roles[id]]);
  }
  const roomMembers: Record<string, string[]> = {
    [rooms.removed]: [ids.mia, ids.olive, ids.adam],
    [rooms.left]: [ids.mia, ids.olive, ids.adam],
    [rooms.dm]: [ids.mia, ids.olive, ids.adam],
    // Gina and Pam read the public room without joining it.
    [rooms.open]: [ids.olive, ids.adam],
    [rooms.kept]: [ids.mia, ids.olive, ids.adam, ids.rita],
    [rooms.archived]: [ids.mia, ids.olive, ids.adam],
    [rooms.guard]: [ids.sam, ids.olive, ids.adam],
    [rooms.race]: [ids.ray, ids.kay, ids.olive, ids.adam],
  };
  for (const [room, members] of Object.entries(roomMembers)) {
    const type = room === rooms.dm ? 'group_dm' : room === rooms.open ? 'public' : 'private';
    await client.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,$4,$5)', [room, orgId, `room-${room.slice(0, 8)}`, type, ids.olive]);
    for (const user of members) await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), room, user]);
  }
  const message = async (room: string, author: string) => {
    const id = randomUUID();
    await client!.query("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'@Defty post the summary')", [id, orgId, room, author]);
    return id;
  };
  const insert = async (id: string, requester: string, room: string, opts: { status?: string; source?: string; params?: object; viaMessage?: boolean } = {}) => {
    const viaMessage = opts.viaMessage ?? true;
    await client!.query(`INSERT INTO agent_actions(id,org_id,user_id,conversation_id,message_id,source,action,params,approval_tier,approval_status)
      VALUES($1,$2,$3,$4,$5,$6,'post_message',$7,'quick',$8)`, [
      id, orgId, requester, room, viaMessage ? await message(room, requester) : null, opts.source ?? 'mention',
      JSON.stringify(opts.params ?? { space_id: room, content: 'summary' }), opts.status ?? 'pending',
    ]);
  };
  await insert(act.removed, ids.mia, rooms.removed);
  await insert(act.approvedHistory, ids.mia, rooms.removed, { status: 'approved' });
  // A capture's requester is the message author named in its params; its row's user is someone else.
  await client.query(`INSERT INTO agent_actions(id,org_id,user_id,source,action,params,approval_tier,approval_status)
    VALUES($1,$2,$3,'defty_capture','create_task',$4,'quick','pending')`, [
    act.capture, orgId, ids.olive, JSON.stringify({ title: 'Follow up', source_user_id: ids.mia, source_space_id: rooms.removed }),
  ]);
  await insert(act.left, ids.mia, rooms.left);
  await insert(act.dm, ids.mia, rooms.dm);
  await insert(act.kept, ids.mia, rooms.kept);
  await insert(act.archived, ids.mia, rooms.archived);
  await insert(act.guest, ids.gina, rooms.open, { viaMessage: false });
  await insert(act.madePrivate, ids.pam, rooms.open, { viaMessage: false });
  await insert(act.workspace, ids.rita, rooms.kept);
  await insert(act.guard, ids.sam, rooms.guard);
  await insert(act.raceClaimFirst, ids.ray, rooms.race);
  await insert(act.raceLossFirst, ids.ray, rooms.race);
  await insert(act.raceTogether, ids.kay, rooms.race);
  await client.query(`INSERT INTO attention_items(id,org_id,user_id,kind,lane,dedupe_key,source_type,source_id,title)
    VALUES($1,$2,$3,'approval','approvals',$4,'agent_action',$5,'Approve: post the summary')`, [randomUUID(), orgId, ids.mia, `dfx2-${act.removed}`, act.removed]);
  routes = {
    agent: (await import('../src/routes/agent.js')).agentRoutes,
    spaces: (await import('../src/routes/spaces.js')).spaceRoutes,
    members: (await import('../src/routes/members.js')).memberRoutes,
  };
});

after(async () => {
  try {
    if (seeded && client) {
      for (const table of ['attention_items', 'agent_action_approvers', 'agent_actions', 'messages']) {
        await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
      }
      await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
      for (const table of ['spaces', 'agent_employees', 'org_members']) await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
      await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
      await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(ids)]);
    }
  } finally {
    await client?.end();
    await closeDb();
  }
});

test('removed from a space, left a space, removed from a DM: pending assistant actions from it are cancelled with a reason', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const id of [act.removed, act.capture, act.left, act.dm, act.kept, act.archived]) await assertPending(id, 'before');

  const removed = await call(ids.olive, `/api/spaces/${rooms.removed}/members/${ids.mia}`, { method: 'DELETE' });
  assert.equal(removed.status, 200, removed.text);
  await assertCancelled(act.removed, 'removed from a private space');
  await assertCancelled(act.capture, 'a capture from that space (requester from params)');
  assert.equal((await state(act.approvedHistory)).approval_status, 'approved', 'decided history is not rewritten');
  const { rows: attention } = await client!.query('SELECT state FROM attention_items WHERE org_id=$1 AND source_id=$2', [orgId, act.removed]);
  assert.deepEqual(attention.map((row) => row.state), ['resolved'], 'its Inbox approval item closes');
  await assertPending(act.left, 'another room is untouched');

  const left = await call(ids.mia, `/api/spaces/${rooms.left}/members/me`, { method: 'DELETE' });
  assert.equal(left.status, 200, left.text);
  await assertCancelled(act.left, 'left a space');

  const dm = await call(ids.olive, `/api/spaces/${rooms.dm}/members/${ids.mia}`, { method: 'DELETE' });
  assert.equal(dm.status, 200, dm.text);
  await assertCancelled(act.dm, 'removed from a group DM');

  // Rooms she keeps, including an archived one, keep their pending actions.
  await client!.query('UPDATE spaces SET is_archived=true WHERE id=$1', [rooms.archived]);
  const { maintainAttentionSystem } = await import('../src/lib/attention-maintenance.js');
  await maintainAttentionSystem();
  await assertPending(act.kept, 'a room she is still in');
  await assertPending(act.archived, 'an archived room she is still in');
});

test('made a guest of the workspace, a public room made private without them, removed from the workspace', async (t) => {
  if (unavailable) return t.skip(unavailable);
  await assertPending(act.guest, 'before');
  const demoted = await call(ids.olive, `/api/members/${ids.gina}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'guest' }),
  });
  assert.equal(demoted.status, 200, demoted.text);
  roles[ids.gina] = 'guest';
  await assertCancelled(act.guest, 'a guest reads no unjoined public room');

  // No route changes a space's type today; the sweep covers it whichever way it happens.
  await assertPending(act.madePrivate, 'before');
  await client!.query("UPDATE spaces SET type='private' WHERE id=$1", [rooms.open]);
  const { maintainAttentionSystem } = await import('../src/lib/attention-maintenance.js');
  await maintainAttentionSystem();
  await assertCancelled(act.madePrivate, 'made private without them (sweep)');

  await assertPending(act.workspace, 'before');
  const gone = await call(ids.olive, `/api/members/${ids.rita}`, { method: 'DELETE' });
  assert.equal(gone.status, 200, gone.text);
  await assertCancelled(act.workspace, 'removed from the workspace');
});

test('no later approval runs it: the fallback reviewer is refused before the sweep has run', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // Sam leaves the workspace without the route's cancellation running.
  // Owners and admins are now the action's reviewers and can read the room;
  // before DFX2 they could approve and run it.
  await silentlyRemoveFromWorkspace(ids.sam);
  for (const reviewer of [ids.olive, ids.adam]) {
    const refused = await call(reviewer, `/api/agent/actions/${act.guard}/approve`, { method: 'POST' });
    assert.notEqual(refused.status, 200, refused.text);
    await assertPending(act.guard, 'refused approval changes nothing');
  }
  const { cancelLostRoomActions } = await import('../src/lib/lost-room-action-cancellation.js');
  assert.deepEqual(await cancelLostRoomActions(), [act.guard], 'the sweep closes exactly this one');
  await assertCancelled(act.guard, 'swept');
  const late = await call(ids.olive, `/api/agent/actions/${act.guard}/approve`, { method: 'POST' });
  assert.notEqual(late.status, 200, late.text);
  await assertCancelled(act.guard, 'still cancelled after a late approval attempt');
});

test('approval and loss together: exactly one wins, in a consistent order', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { claimPendingApproval } = await import('../src/lib/agent-action-execution-lease.js');
  const { cancelLostRoomActions } = await import('../src/lib/lost-room-action-cancellation.js');

  // 1. The approval claim runs first, while Ray still has the room: it stands,
  //    and the cancellation after the loss leaves it alone.
  assert.ok(await claimPendingApproval(await loadRow(act.raceClaimFirst), ids.ray), 'claimed while a member');
  await client!.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [rooms.race, ids.ray]);
  const closed = await cancelLostRoomActions({ orgId });
  assert.ok(!closed.includes(act.raceClaimFirst));
  assert.equal((await state(act.raceClaimFirst)).approval_status, 'approved', 'an approval made before the loss is kept');

  // 2. The loss commits first and the cancellation has not run yet: the claim
  //    itself refuses (it re-reads the room in its own statement).
  assert.ok(closed.includes(act.raceLossFirst), 'the same sweep closed the other one');
  await client!.query("UPDATE agent_actions SET approval_status='pending', error=NULL WHERE id=$1", [act.raceLossFirst]);
  assert.equal(await claimPendingApproval(await loadRow(act.raceLossFirst), ids.ray), null, 'claim after the loss is refused');
  await assertPending(act.raceLossFirst, 'nothing ran');

  // 3. Together: the claim starts while Kay still has the room, the loss
  //    commits while the claim waits on the row, and the cancellation runs at
  //    once. Both statements lock the action row; exactly one changes it.
  for (let round = 0; round < 3; round += 1) {
    await client!.query("UPDATE agent_actions SET approval_status='pending', approved_at=NULL, approved_by_user_id=NULL, result=NULL, error=NULL WHERE id=$1", [act.raceTogether]);
    await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [randomUUID(), rooms.race, ids.kay]);
    const row = await loadRow(act.raceTogether);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM agent_actions WHERE id=$1 FOR UPDATE', [act.raceTogether]);
      const claim = claimPendingApproval(row, ids.kay);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await client!.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [rooms.race, ids.kay]);
      const cancel = cancelLostRoomActions({ orgId, requesterId: ids.kay });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await holder.query('COMMIT');
      const [token, cancelled] = await Promise.all([claim, cancel]);
      const final = await state(act.raceTogether);
      const claimed = Boolean(token);
      const wasCancelled = cancelled.includes(act.raceTogether);
      assert.notEqual(claimed, wasCancelled, `round ${round}: exactly one of claim and cancel wins`);
      assert.equal(final.approval_status, claimed ? 'approved' : 'expired', `round ${round}: the row shows the winner`);
      if (!claimed) assert.equal(final.error, REASON);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
    }
  }
});

test('owners and admins keep the history of cancelled actions; the person who lost the room does not see it', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const cancelled = [act.removed, act.capture, act.left, act.dm, act.guest, act.madePrivate, act.workspace, act.guard];
  for (const viewer of [ids.olive, ids.adam]) {
    const { status, text } = await call(viewer, '/api/agent/actions?limit=200');
    assert.equal(status, 200, text);
    const body = JSON.parse(text) as Array<{ id: string; approval_status: string }> | { actions: Array<{ id: string; approval_status: string }> };
    const rows = new Map((Array.isArray(body) ? body : body.actions).map((row) => [row.id, row.approval_status]));
    for (const id of cancelled) assert.equal(rows.get(id), 'expired', `${roles[viewer]} keeps ${id}`);
  }
  const mine = await call(ids.mia, '/api/agent/actions?limit=200');
  assert.equal(mine.status, 200, mine.text);
  for (const id of [act.removed, act.capture, act.left, act.dm]) assert.ok(!mine.text.includes(id), 'hidden from the person (DFX1)');
});
