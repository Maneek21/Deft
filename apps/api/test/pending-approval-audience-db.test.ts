/**
 * Approval lists and counts presented to a viewer for action hold the
 * approvals that viewer can review: an ordinary action goes to its requester
 * when an active human member, otherwise to the owners/admins who pass the
 * room check. App Run releases and record-mirror nominations keep each
 * surface's own rule. Activity feeds and history stay readable by the read
 * audience and say whether the viewer can review each row.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const otherOrgId = randomUUID();
const ids = {
  owner: randomUUID(), admin: randomUUID(), requester: randomUUID(), peer: randomUUID(),
  departed: randomUUID(), guest: randomUUID(),
};
const roles: Record<string, string> = {
  [ids.owner]: 'owner', [ids.admin]: 'admin', [ids.requester]: 'member', [ids.peer]: 'member',
  [ids.departed]: 'member', [ids.guest]: 'guest',
};
const a = {
  ord: randomUUID(), ordAuto: randomUUID(), fallback: randomUUID(), mirror: randomUUID(), otherOrg: randomUUID(),
  full: randomUUID(), decided: randomUUID(), otherOrgMirror: randomUUID(),
};
const viewers = ['owner', 'admin', 'requester', 'peer', 'guest'] as const;
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;
let deftyEmployeeId = '';
const agentUserId = randomUUID();
const employeeId = randomUUID();
let teamId = '';
let routes: Record<string, Hono> = {};

async function request(viewerId: string, mount: string, path: string) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: viewerId, org_id: orgId, email: `${viewerId}@example.test`, role: roles[viewerId] } as any);
    await next();
  });
  hono.route(mount, routes[mount]!);
  return hono.request(`${mount}${path}`);
}

async function json<T>(viewerId: string, mount: string, path: string): Promise<T> {
  const response = await request(viewerId, mount, path);
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as T;
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  const q = (text: string, values: unknown[]) => client!.query(text, values);
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3),($4,$5,$6)',
    [orgId, 'Review queues', `review-queues-${orgId}`, otherOrgId, 'Other', `review-queues-${otherOrgId}`]);
  for (const [name, id] of Object.entries(ids)) {
    await q('INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,\'human\',false)', [id, `${id}@example.test`, name]);
    await q('INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), orgId, id, roles[id], id !== ids.departed]);
  }
  const { ensureDeftyEmployee } = await import('../src/lib/ensure-defty-membership.js');
  deftyEmployeeId = (await ensureDeftyEmployee(orgId)).employeeId;
  await q("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,'Rita','agent',true)", [agentUserId, `${agentUserId}@example.test`]);
  await q("INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'member')", [randomUUID(), orgId, agentUserId]);
  await q(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,expertise_description,trust_level,is_active,is_byoa,runtime_kind,wake_mode,certification_status,created_by)
    VALUES($1,$2,$3,'Rita',$4,'custom','Test.','Test.','conservative',true,true,'custom_mcp','manual','token_issued',$5)`,
    [employeeId, orgId, agentUserId, `rita-${employeeId.slice(0, 8)}`, ids.owner]);
  // A private room the admin shares with the departed member; the owner is outside it.
  const room = randomUUID();
  await q('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,\'private\',$4)', [room, orgId, `room-${room}`, ids.admin]);
  for (const user of [ids.admin, ids.departed]) await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), room, user]);
  const base = Date.now() - 60_000;
  const insert = (id: string, org: string, user: string, employee: string | null, action: string, tier: string,
    source: string, params: Record<string, unknown>, offsetSec: number, status = 'pending') => q(
    `INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,action,params,approval_tier,approval_status,source,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$10,$8,$9)`,
    [id, org, user, employee, action, JSON.stringify(params), tier, source, new Date(base + offsetSec * 1000), status]);
  await insert(a.ord, orgId, ids.requester, employeeId, 'create_task', 'quick', 'mention', { title: 'ORD' }, 5);
  await insert(a.ordAuto, orgId, ids.requester, employeeId, 'create_task', 'auto', 'mention', { title: 'AUTO' }, 4);
  // As written by Defty: stored under Defty's user, requested by the message author.
  const deftyUserId = (await q('SELECT user_id FROM agent_employees WHERE id=$1', [deftyEmployeeId])).rows[0].user_id as string;
  await insert(a.fallback, orgId, deftyUserId, deftyEmployeeId, 'create_task', 'quick', 'defty_capture',
    { title: 'FALLBACK', source_user_id: ids.departed, source_space_id: room }, 3);
  // App Run releases share this branch (same action list); a record-mirror nomination stands for both.
  await insert(a.mirror, orgId, ids.requester, employeeId, 'app_record_mirror_nominate', 'full', 'app_record_mirror', {}, 1);
  await insert(a.full, orgId, ids.requester, employeeId, 'create_task', 'full', 'mention', { title: 'FULL' }, 4.5);
  await insert(a.decided, orgId, ids.requester, employeeId, 'create_task', 'quick', 'mention', { title: 'DECIDED' }, 4.2, 'approved');
  await insert(a.otherOrgMirror, otherOrgId, ids.requester, null, 'app_record_mirror_nominate', 'full', 'app_record_mirror', {}, 7);
  await insert(a.otherOrg, otherOrgId, ids.requester, null, 'create_task', 'quick', 'mention', { title: 'OTHER' }, 6);
  teamId = randomUUID();
  await q('INSERT INTO teams(id,org_id,name,handle,created_by) VALUES($1,$2,\'Review team\',$3,$4)', [teamId, orgId, `rt-${teamId.slice(0, 8)}`, ids.owner]);
  for (const user of [ids.requester, ids.departed]) {
    await q('INSERT INTO team_members(id,org_id,team_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, teamId, user]);
  }
  routes = {
    '/api/inbox': (await import('../src/routes/inbox.js')).inboxRoutes,
    '/api/agent-employees': (await import('../src/routes/agent-employees.js')).agentEmployeeRoutes,
    '/api/teams': (await import('../src/routes/teams.js')).teamRoutes,
    '/api/dashboard': (await import('../src/routes/dashboard.js')).dashboardRoutes,
    '/api/agent': (await import('../src/routes/agent.js')).agentRoutes,
  };
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    for (const org of [orgId, otherOrgId]) {
      await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [org]);
      for (const table of ['team_members', 'teams', 'attention_events', 'attention_items', 'agent_action_approvers', 'agent_actions', 'notifications', 'agent_employees', 'spaces', 'org_members']) {
        await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [org]);
      }
      await client.query('DELETE FROM orgs WHERE id=$1', [org]);
    }
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [[...Object.values(ids), agentUserId]]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

const KINDS = 'kind=pending_approval,work_capture';
type InboxBody = { items: Array<{ approval?: { action_id: string } }>; unread_count: number; next_cursor: string | null };

/** Every approval id over all Inbox pages, and the count each page reports. */
async function inboxApprovals(viewer: string, limit = 100) {
  const seen: string[] = [];
  const counts = new Set<number>();
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const body: InboxBody = await json<InboxBody>(viewer, '/api/inbox',
      `?${KINDS}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    counts.add(body.unread_count);
    seen.push(...body.items.flatMap((item) => item.approval ? [item.approval.action_id] : []));
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  const countOnly = await json<{ unread_count: number }>(viewer, '/api/inbox', `?${KINDS}&count_only=1`);
  return { ids: seen, counts: [...counts], countOnly: countOnly.unread_count };
}

const expected: Record<(typeof viewers)[number], string[]> = {
  requester: [a.ord, a.full, a.mirror],
  owner: [a.mirror],
  admin: [a.fallback, a.mirror],
  peer: [],
  guest: [],
};

test('AL2-1: the Inbox approval list and its count hold the approvals each viewer can review', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const viewer of viewers) {
    const got = await inboxApprovals(ids[viewer]);
    assert.deepEqual([...got.ids].sort(), [...expected[viewer]].sort(), `${viewer} list`);
    assert.deepEqual(got.counts, [expected[viewer].length], `${viewer} count`);
    assert.equal(got.countOnly, expected[viewer].length, `${viewer} count_only`);
    for (const foreign of [a.otherOrg, a.otherOrgMirror]) assert.equal(got.ids.includes(foreign), false, `${viewer} never gets another workspace's action`);
    assert.equal(got.ids.includes(a.decided), false, `${viewer} does not get a decided action`);
  }
});

test('AL2-2: Inbox approvals page through the cursor to the last one, with the full count on every page', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const viewer of ['requester', 'admin'] as const) {
    const got = await inboxApprovals(ids[viewer], 1);
    assert.deepEqual(got.ids, [...expected[viewer]], `${viewer} pages in order without repeats`);
    assert.deepEqual(got.counts, [expected[viewer].length]);
  }
  const ordinaryOnly = await json<InboxBody>(ids.requester, '/api/inbox', '?kind=pending_approval&limit=100');
  assert.deepEqual(ordinaryOnly.items.map((item) => item.approval?.action_id), [a.ord, a.full, a.mirror]);
  const capturesOnly = await json<InboxBody>(ids.admin, '/api/inbox', '?kind=work_capture&count_only=1');
  assert.equal(capturesOnly.unread_count, 1);
});

test('AL2-3: employee and task pending counts hold the approvals the viewer can review', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const want = { requester: 3, owner: 1, admin: 1, peer: 1, guest: 1 } as const;
  const wantDefty = { requester: 0, owner: 0, admin: 1, peer: 0, guest: 0 } as const;
  const { reviewableApprovalCountsByEmployee } = await import('../src/lib/pending-approval-audience.js');
  for (const viewer of viewers) {
    const rows = await json<Array<{ id: string; pending_action_count: number }>>(ids[viewer], '/api/agent-employees', '?expand=stats');
    assert.equal(rows.find((row) => row.id === employeeId)?.pending_action_count, want[viewer], `${viewer} employee badge`);
    const counts = await reviewableApprovalCountsByEmployee({ id: ids[viewer], org_id: orgId, role: roles[ids[viewer]] }, [employeeId, deftyEmployeeId]);
    assert.equal(counts.get(employeeId) ?? 0, want[viewer], `${viewer} task pending count`);
    assert.equal(counts.get(deftyEmployeeId) ?? 0, wantDefty[viewer], `${viewer} Defty pending count`);
  }
});

test('AL2-4: the team Approvals count holds team members\' approvals the viewer can review', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const want = { requester: 3, owner: 1, admin: 2, peer: 1 } as const;
  for (const viewer of ['requester', 'owner', 'admin', 'peer'] as const) {
    const body = await json<{ attention: { pending_agent_actions: number } }>(ids[viewer], '/api/teams', `/${teamId}/dashboard`);
    assert.equal(body.attention.pending_agent_actions, want[viewer], `${viewer} team approvals`);
  }
});

type FeedRow = { id: string; viewer_can_review: boolean };

test('AL2-5: activity feeds keep the read audience, check the capture room and say who can review', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const feed = async (viewer: string) => new Map((await json<FeedRow[]>(viewer, '/api/dashboard', '/agent-activity'))
    .map((row) => [row.id, row.viewer_can_review]));
  const owner = await feed(ids.owner);
  assert.equal(owner.get(a.ord), false, 'an owner reads another member\'s pending action without a review link');
  assert.equal(owner.has(a.fallback), false, 'a capture outside the owner\'s rooms is not listed');
  const admin = await feed(ids.admin);
  assert.equal(admin.get(a.ord), false);
  assert.equal(admin.get(a.fallback), true, 'the in-room admin reviews the capture with no active requester');
  const requester = await feed(ids.requester);
  assert.equal(requester.get(a.ord), true);
  assert.equal(requester.get(a.full), true);
  assert.equal(requester.get(a.decided), false, 'a decided action has no review link');
  assert.equal(requester.has(a.ordAuto), true, 'queue rows stay in the feed');
  assert.equal(requester.get(a.ordAuto), false, 'a queue row has no review link');

  type Dashboard = { agent_activity: FeedRow[]; attention: Array<{ kind: string; action_id?: string }> };
  const ownerDash = await json<Dashboard>(ids.owner, '/api/dashboard', '');
  assert.equal(ownerDash.agent_activity.find((row) => row.id === a.ord)?.viewer_can_review, false);
  assert.equal(ownerDash.attention.some((item) => item.kind === 'agent_approval' && item.action_id === a.ord), false);
  const requesterDash = await json<Dashboard>(ids.requester, '/api/dashboard', '');
  assert.equal(requesterDash.attention.some((item) => item.kind === 'agent_approval' && item.action_id === a.ord), true);

  const activity = async (viewer: string, employee: string) => JSON.stringify(await json(viewer, '/api/agent-employees', `/${employee}/activity`));
  assert.equal((await activity(ids.owner, employeeId)).includes(a.ord), true, 'the employee activity feed keeps the read audience');
  assert.equal((await activity(ids.owner, deftyEmployeeId)).includes(a.fallback), false, 'a capture outside the owner\'s rooms is not listed');
  assert.equal((await activity(ids.admin, deftyEmployeeId)).includes(a.fallback), true);

  const recent = JSON.stringify(await json(ids.admin, '/api/agent', '/actions/recent?limit=50'));
  assert.equal(recent.includes(a.ord), true, 'action history keeps the read audience');
});
