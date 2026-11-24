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
  cal: randomUUID(), pia: randomUUID(), dee: randomUUID(),
};
const projectId = randomUUID();
const planId = randomUUID();
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
  messageOnlyCapture: randomUUID(), planStep: randomUUID(),
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
    [rooms.removed]: [ids.mia, ids.olive, ids.adam, ids.dee],
    [rooms.left]: [ids.mia, ids.olive, ids.adam],
    [rooms.dm]: [ids.mia, ids.olive, ids.adam],
    // Gina and Pam read the public room without joining it.
    [rooms.open]: [ids.olive, ids.adam],
    [rooms.kept]: [ids.mia, ids.olive, ids.adam, ids.rita],
    [rooms.archived]: [ids.mia, ids.olive, ids.adam],
    [rooms.guard]: [ids.sam, ids.cal, ids.pia, ids.olive, ids.adam],
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
  // A capture that names only its source message (no space id in params).
  await client.query(`INSERT INTO agent_actions(id,org_id,user_id,source,action,params,approval_tier,approval_status)
    VALUES($1,$2,$3,'defty_capture','create_task',$4,'quick','pending')`, [
    act.messageOnlyCapture, orgId, ids.olive,
    JSON.stringify({ title: 'Follow up', source_user_id: ids.cal, source_message_id: await message(rooms.guard, ids.cal) }),
  ]);
  // A plan whose step's approval was cancelled (DFX2) before the plan resumed.
  await client.query('INSERT INTO projects(id,org_id,name,prefix,lead_id) VALUES($1,$2,$3,$4,$5)',
    [projectId, orgId, 'Lost room plans', `LR${orgId.slice(0, 4).toUpperCase()}`, ids.olive]);
  const planTitle = `Plan task ${planId}`;
  await client.query(`INSERT INTO agent_plans(id,org_id,user_id,title,steps,status,current_step,context)
    VALUES($1,$2,$3,'Lost room plan',$4::jsonb,'approved',0,'{}'::jsonb)`, [planId, orgId, ids.pia, JSON.stringify([
    { id: 'step-1', tool: 'create_task', params: { title: planTitle, resolved_project_id: projectId, priority: 'p2' }, status: 'waiting_approval' },
  ])]);
  await client.query(`INSERT INTO agent_actions(id,org_id,user_id,conversation_id,source,plan_id,plan_step_id,action,params,approval_tier,approval_status,error)
    VALUES($1,$2,$3,$4,'plan',$5,'step-1','create_task',$6,'quick','expired',$7)`, [
    act.planStep, orgId, ids.pia, rooms.guard, planId,
    JSON.stringify({ title: planTitle, resolved_project_id: projectId, priority: 'p2' }), REASON,
  ]);
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
      for (const table of ['attention_items', 'agent_action_approvers', 'action_receipts', 'work_intents', 'agent_actions', 'agent_plans', 'tasks', 'projects', 'messages']) {
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
  // Sam leaves the workspace by a path with no hook (as a future one might).
  // Owners and admins are now the action's reviewers and can read the room;
  // before DFX2 they could approve and run it.
  await silentlyRemoveFromWorkspace(ids.sam);
  for (const reviewer of [ids.olive, ids.adam]) {
    const refused = await call(reviewer, `/api/agent/actions/${act.guard}/approve`, { method: 'POST' });
    assert.notEqual(refused.status, 200, refused.text);
    await assertPending(act.guard, 'refused approval changes nothing');
  }
  const { cancelLostRoomActions } = await import('../src/lib/lost-room-action-cancellation.js');
  assert.deepEqual(await cancelLostRoomActions({ orgId }), [act.guard], 'the sweep closes exactly this one');
  await assertCancelled(act.guard, 'swept');
  const late = await call(ids.olive, `/api/agent/actions/${act.guard}/approve`, { method: 'POST' });
  assert.notEqual(late.status, 200, late.text);
  await assertCancelled(act.guard, 'still cancelled after a late approval attempt');
});

test('a loss closes every pending action from the room in its transaction, past one batch', async (t) => {
  if (unavailable) return t.skip(unavailable);
  await client!.query(`INSERT INTO agent_actions(id,org_id,user_id,conversation_id,source,action,params,approval_tier,approval_status)
    SELECT gen_random_uuid()::text, $1, $2, $3, 'mention', 'post_message', '{"content":"bulk"}'::jsonb, 'quick', 'pending'
    FROM generate_series(1, 501)`, [orgId, ids.dee, rooms.removed]);
  const removed = await call(ids.olive, `/api/spaces/${rooms.removed}/members/${ids.dee}`, { method: 'DELETE' });
  assert.equal(removed.status, 200, removed.text);
  const { rows } = await client!.query(`SELECT approval_status, error, count(*)::int AS n FROM agent_actions
    WHERE org_id=$1 AND user_id=$2 GROUP BY 1, 2`, [orgId, ids.dee]);
  assert.deepEqual(rows, [{ approval_status: 'expired', error: REASON, n: 501 }]);
  // Keep the history test's list (latest 200) on the other actions.
  await client!.query('DELETE FROM agent_actions WHERE org_id=$1 AND user_id=$2', [orgId, ids.dee]);
});

test('a capture that names only its source message is covered too', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { claimPendingApproval } = await import('../src/lib/agent-action-execution-lease.js');
  const { cancelLostRoomActions } = await import('../src/lib/lost-room-action-cancellation.js');
  // Cal stays in the workspace and loses only the room the message is in.
  await client!.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [rooms.guard, ids.cal]);
  assert.equal(await claimPendingApproval(await loadRow(act.messageOnlyCapture), ids.olive), null, 'claim refused');
  assert.deepEqual(await cancelLostRoomActions({ orgId }), [act.messageOnlyCapture]);
  await assertCancelled(act.messageOnlyCapture, 'capture with only a source message');
});

test('a resumed plan does not run a step whose approval was cancelled', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { executePlan } = await import('../src/lib/agent-plans.js');
  // A leaf create_task step would otherwise run directly on resume.
  await executePlan(planId, orgId, ids.pia);
  const { rows: tasks } = await client!.query('SELECT id FROM tasks WHERE org_id=$1', [orgId]);
  assert.equal(tasks.length, 0, 'no task was created');
  const { rows: stepActions } = await client!.query('SELECT id, approval_status FROM agent_actions WHERE plan_id=$1', [planId]);
  assert.deepEqual(stepActions, [{ id: act.planStep, approval_status: 'expired' }], 'no new approved action for the step');
  const { rows: [plan] } = await client!.query('SELECT status FROM agent_plans WHERE id=$1', [planId]);
  assert.equal(plan.status, 'paused');
  const { rows: [stopped] } = await client!.query('SELECT error FROM agent_plans WHERE id=$1', [planId]);
  assert.equal(stopped.error, "Plan step 'step-1' approval was expired", 'stopped because its approval was cancelled');
});

/**
 * Wait until `count` sessions are queued behind `holderPid`: blocked by it, or
 * by a session that is (the second waiter on a row waits on the first).
 */
async function lockWaiters(holderPid: number, count: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows: [row] } = await client!.query(`WITH RECURSIVE queued(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
        UNION
        SELECT activity.pid FROM pg_stat_activity activity JOIN queued ON queued.pid = ANY(pg_blocking_pids(activity.pid))
      ) SELECT count(*)::int AS n FROM queued`, [holderPid]);
    if (row.n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`expected ${count} sessions waiting on a lock`);
}

/** The loss as the routes do it: membership removed and actions closed in one transaction. */
async function loseRoomInOneTransaction(userId: string) {
  const { closeLostRoomActionsInTx } = await import('../src/lib/lost-room-action-cancellation.js');
  const { sql } = await import('drizzle-orm');
  return db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM space_members WHERE space_id = ${rooms.race} AND user_id = ${userId}`);
    return closeLostRoomActionsInTx(tx, { orgId, requesterId: userId });
  });
}

test('approval and loss together: the row lock orders them, and exactly one wins', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { claimPendingApproval } = await import('../src/lib/agent-action-execution-lease.js');

  // A loss that committed with no hook (the sweep has not run): the claim
  // refuses in its own statement.
  await client!.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [rooms.race, ids.ray]);
  assert.equal(await claimPendingApproval(await loadRow(act.raceLossFirst), ids.ray), null, 'claim after the loss is refused');
  await assertPending(act.raceLossFirst, 'nothing ran');
  await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), rooms.race, ids.ray]);

  for (const order of ['claim first', 'loss first'] as const) {
    const id = order === 'claim first' ? act.raceClaimFirst : act.raceTogether;
    const requester = order === 'claim first' ? ids.ray : ids.kay;
    const row = await loadRow(id);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      // Hold the action row so both statements queue on it in a known order.
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM agent_actions WHERE id=$1 FOR UPDATE', [id]);
      const { rows: [{ pid: holderPid }] } = await holder.query('SELECT pg_backend_pid() AS pid');
      let claim: Promise<unknown>;
      let loss: Promise<string[]>;
      if (order === 'claim first') {
        claim = claimPendingApproval(row, requester);
        await lockWaiters(holderPid, 1);
        loss = loseRoomInOneTransaction(requester);
        await lockWaiters(holderPid, 2);
      } else {
        loss = loseRoomInOneTransaction(requester);
        await lockWaiters(holderPid, 1);
        claim = claimPendingApproval(row, requester);
        await lockWaiters(holderPid, 2);
      }
      await holder.query('COMMIT');
      const [token, closed] = await Promise.all([claim, loss]);
      const final = await state(id);
      if (order === 'claim first') {
        // Approved while the requester still had the room; it committed
        // before the loss could, and the close found it no longer pending.
        assert.ok(token, 'claim won');
        assert.ok(!closed.includes(id), 'close skipped the approved row');
        assert.ok(closed.includes(act.raceLossFirst), "the requester's other pending action from the room closed");
        assert.equal(final.approval_status, 'approved');
      } else {
        assert.equal(token, null, 'claim found the row closed');
        assert.ok(closed.includes(id), 'close won');
        assert.equal(final.approval_status, 'expired');
        assert.equal(final.error, REASON);
      }
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
