/**
 * The approval queues polled by the web (Attention list, counts and badge,
 * Inbox list and count, team and employee approval counts, attention
 * backfill and maintenance) serve each viewer exactly the approvals that
 * viewer reviews, across every kind of pending action: Defty proposals with
 * and without a source message, captures with a room, employee actions with
 * and without a source, module writes, record-mirror nominations, departed
 * and agent requesters, approver assignments that do and do not count,
 * archived rooms and settled or auto-tier rows.
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
const people = ['owner', 'admin', 'member', 'peer', 'guest', 'departed'] as const;
type Person = (typeof people)[number];
const ids = Object.fromEntries(people.map((p) => [p, randomUUID()])) as Record<Person, string>;
const roles: Record<Person, string> = {
  owner: 'owner', admin: 'admin', member: 'member', peer: 'member', guest: 'guest', departed: 'member',
};
const viewers = ['owner', 'admin', 'member', 'peer', 'guest'] as const;
const roomIds = { pub: randomUUID(), room: randomUUID(), peerRoom: randomUUID(), archived: randomUUID() };
const agentUserId = randomUUID();
const employeeId = randomUUID();
let deftyEmployeeId = '';
let deftyUserId = '';
let teamId = '';
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;
let routes: Record<string, Hono> = {};
/** action id -> label */
const labelOf = new Map<string, string>();
const idOf = new Map<string, string>();

const q = (text: string, values: unknown[] = []) => client!.query(text, values);

async function json<T>(viewer: Person, mount: string, path: string): Promise<T> {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: ids[viewer], org_id: orgId, email: `${ids[viewer]}@example.test`, role: roles[viewer] } as any);
    await next();
  });
  hono.route(mount, routes[mount]!);
  const response = await hono.request(`${mount}${path}`);
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as T;
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Queue audience', `queue-audience-${orgId}`]);
  for (const person of people) {
    await q("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,'human',false)", [ids[person], `${ids[person]}@example.test`, person]);
    await q('INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), orgId, ids[person], roles[person], person !== 'departed']);
  }
  const { ensureDeftyEmployee } = await import('../src/lib/ensure-defty-membership.js');
  const defty = await ensureDeftyEmployee(orgId);
  deftyEmployeeId = defty.employeeId;
  deftyUserId = defty.userId;
  await q("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,'Rita','agent',true)", [agentUserId, `${agentUserId}@example.test`]);
  await q("INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'member')", [randomUUID(), orgId, agentUserId]);
  await q(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,expertise_description,trust_level,is_active,is_byoa,runtime_kind,wake_mode,certification_status,created_by)
    VALUES($1,$2,$3,'Rita',$4,'custom','Test.','Test.','conservative',true,true,'custom_mcp','manual','token_issued',$5)`,
    [employeeId, orgId, agentUserId, `rita-${employeeId.slice(0, 8)}`, ids.owner]);

  const space = async (id: string, type: string, members: string[], archived = false) => {
    await q('INSERT INTO spaces(id,org_id,name,type,created_by,is_archived) VALUES($1,$2,$3,$4,$5,$6)',
      [id, orgId, `s-${id}`, type, ids.owner, archived]);
    for (const user of members) await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), id, user]);
  };
  await space(roomIds.pub, 'public', [ids.owner, ids.admin, ids.member, ids.guest, agentUserId]);
  // A private room of the member and the admin (and the departed member); the owner is outside it.
  await space(roomIds.room, 'private', [ids.member, ids.admin, ids.departed]);
  await space(roomIds.peerRoom, 'private', [ids.peer, ids.owner]);
  await space(roomIds.archived, 'private', [ids.member, ids.admin, ids.owner], true);
  const msg = async (spaceId: string, author: string) => {
    const id = randomUUID();
    await q("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'hi')", [id, orgId, spaceId, author]);
    return id;
  };
  const m = {
    room: await msg(roomIds.room, ids.member), peerRoom: await msg(roomIds.peerRoom, ids.peer),
    pub: await msg(roomIds.pub, ids.guest), archived: await msg(roomIds.archived, ids.member),
    departedRoom: await msg(roomIds.room, ids.departed),
  };

  let offset = 0;
  const action = async (label: string, row: {
    user: string; employee?: string | null; action?: string; tier?: string; status?: string; source?: string;
    message?: string | null; params?: Record<string, unknown>; approvers?: Array<[string, string?]>;
  }) => {
    const id = randomUUID();
    labelOf.set(id, label); idOf.set(label, id);
    offset += 1;
    await q(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,action,params,approval_tier,approval_status,source,message_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, orgId, row.user, row.employee ?? null, row.action ?? 'create_task',
      JSON.stringify(row.params ?? { title: label }), row.tier ?? 'quick', row.status ?? 'pending', row.source ?? 'mention',
      row.message ?? null, new Date(Date.now() - 600_000 + offset * 1000)]);
    for (const [user, decision] of row.approvers ?? []) {
      await q('INSERT INTO agent_action_approvers(id,org_id,action_id,user_id,decision) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), orgId, id, user, decision ?? 'pending']);
    }
  };
  const cap = (source_user_id: string | null, source_space_id: string | null, source_message_id: string | null) => ({
    title: 'cap', ...(source_user_id ? { source_user_id } : {}), ...(source_space_id ? { source_space_id } : {}),
    ...(source_message_id ? { source_message_id } : {}),
  });
  await action('defty-plain-member', { user: ids.member, source: 'native' });
  await action('defty-msg-member', { user: ids.member, message: m.room });
  await action('defty-msg-peer-outside', { user: ids.peer, message: m.room });
  await action('defty-msg-archived', { user: ids.member, message: m.archived });
  await action('defty-envelope-msg', { user: ids.member, employee: deftyEmployeeId, message: m.room });
  await action('defty-plain-guest', { user: ids.guest, source: 'native' });
  await action('defty-msg-guest-pub', { user: ids.guest, message: m.pub });
  await action('defty-plain-departed', { user: ids.departed, source: 'native' });
  await action('defty-msg-departed-room', { user: ids.departed, message: m.departedRoom });
  await action('capture-member-room', { user: deftyUserId, source: 'defty_capture', params: cap(ids.member, roomIds.room, m.room) });
  await action('capture-guest-pub', { user: deftyUserId, source: 'defty_capture', params: cap(ids.guest, roomIds.pub, m.pub) });
  await action('capture-departed-room', { user: deftyUserId, source: 'defty_capture', params: cap(ids.departed, roomIds.room, null) });
  await action('capture-no-room', { user: deftyUserId, source: 'defty_capture', params: cap(ids.member, null, null) });
  await action('capture-peer-room', { user: deftyUserId, source: 'defty_capture', params: cap(ids.peer, roomIds.peerRoom, m.peerRoom) });
  await action('capture-blank-user', { user: ids.peer, source: 'defty_capture', params: { title: 'cap', source_user_id: '  ', source_space_id: roomIds.pub } });
  await action('employee-sourceless', { user: agentUserId, employee: employeeId, source: 'mcp' });
  await action('employee-msg-pub', { user: agentUserId, employee: employeeId, source: 'mcp', message: m.pub });
  await action('employee-for-member', { user: ids.member, employee: employeeId, source: 'mcp' });
  await action('employee-chat-mention-nomsg', { user: ids.member, employee: employeeId, source: 'mcp', action: 'chat_mention' });
  await action('module-member', { user: ids.member, employee: employeeId, source: 'mcp', action: 'module_record_create' });
  await action('module-agent', { user: agentUserId, employee: employeeId, source: 'mcp', action: 'module_record_create' });
  await action('mirror-member', { user: ids.member, employee: employeeId, source: 'app_record_mirror', action: 'app_record_mirror_nominate', tier: 'full', params: {} });
  await action('mirror-peer', { user: ids.peer, employee: employeeId, source: 'app_record_mirror', action: 'app_record_mirror_nominate', tier: 'full', params: {} });
  await action('assign-admin-on-departed', { user: ids.departed, source: 'native', approvers: [[ids.admin]] });
  await action('assign-owner-outside-room', { user: ids.departed, message: m.departedRoom, approvers: [[ids.owner]] });
  await action('assign-peer-on-member', { user: ids.member, source: 'native', approvers: [[ids.peer]] });
  await action('assign-decided-admin', { user: ids.departed, source: 'native', approvers: [[ids.admin, 'approved']] });
  await action('assign-guest-on-departed', { user: ids.departed, source: 'native', approvers: [[ids.guest]] });
  await action('assign-member-self', { user: ids.member, source: 'native', approvers: [[ids.member], [ids.admin]] });
  await action('agent-requester-defty', { user: agentUserId, source: 'native' });
  await action('full-member', { user: ids.member, tier: 'full', source: 'native' });
  await action('auto-member', { user: ids.member, tier: 'auto', source: 'native' });
  await action('settled-member', { user: ids.member, status: 'approved', source: 'native' });

  teamId = randomUUID();
  await q("INSERT INTO teams(id,org_id,name,handle,created_by) VALUES($1,$2,'Queue team',$3,$4)", [teamId, orgId, `qt-${teamId.slice(0, 8)}`, ids.owner]);
  for (const person of ['member', 'peer', 'guest', 'departed'] as const) {
    await q('INSERT INTO team_members(id,org_id,team_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, teamId, ids[person]]);
  }
  routes = {
    '/api/attention': (await import('../src/routes/attention.js')).attentionRoutes,
    '/api/inbox': (await import('../src/routes/inbox.js')).inboxRoutes,
    '/api/teams': (await import('../src/routes/teams.js')).teamRoutes,
  };
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    await q('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
    for (const table of ['team_members', 'teams', 'attention_deliveries', 'attention_events', 'attention_items', 'agent_action_approvers',
      'agent_actions', 'messages', 'notifications', 'agent_employees', 'spaces', 'org_members']) {
      await q(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
    }
    await q('DELETE FROM orgs WHERE id=$1', [orgId]);
    await q('DELETE FROM users WHERE id=ANY($1::text[])', [[...Object.values(ids), agentUserId]]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

const labels = (actionIds: Iterable<string>) => [...actionIds].map((id) => labelOf.get(id) ?? `?${id}`).sort();

type AttentionBody = {
  items: Array<{ id: string; source_type: string; source_id: string; approval: unknown }>;
  counts: { needs_you: { count: number; unseen: number }; updates: { count: number; unseen: number } };
};
type InboxBody = { items: Array<{ approval?: { action_id: string } }>; unread_count: number };

/** Everything the polled queues give one viewer, by action label. */
async function observe(viewer: Person) {
  const attention = await json<AttentionBody>(viewer, '/api/attention', '?lane=needs_you&limit=100');
  const badge = await json<AttentionBody>(viewer, '/api/attention', '?lane=needs_you&limit=1');
  const allStates = await json<AttentionBody>(viewer, '/api/attention', '?state=all&limit=100');
  const inbox = await json<InboxBody>(viewer, '/api/inbox', '?limit=100');
  const inboxCount = await json<{ unread_count: number }>(viewer, '/api/inbox', '?count_only=1');
  const { reviewableApprovalCountsByEmployee } = await import('../src/lib/pending-approval-audience.js');
  const byEmployee = await reviewableApprovalCountsByEmployee({ id: ids[viewer], org_id: orgId, role: roles[viewer] });
  const team = viewer === 'guest' ? null
    : (await json<{ attention: { pending_agent_actions: number } }>(viewer, '/api/teams', `/${teamId}/dashboard`)).attention.pending_agent_actions;
  const items = (await q(`SELECT source_id, state FROM attention_items WHERE org_id=$1 AND user_id=$2 AND source_type='agent_action'`,
    [orgId, ids[viewer]])).rows as Array<{ source_id: string; state: string }>;
  return {
    attention: labels(attention.items.filter((item) => item.source_type === 'agent_action').map((item) => item.source_id)),
    attentionAll: labels(allStates.items.filter((item) => item.source_type === 'agent_action' && item.approval).map((item) => item.source_id)),
    counts: [attention.counts.needs_you.count, attention.counts.needs_you.unseen, badge.counts.needs_you.unseen],
    inbox: labels(inbox.items.flatMap((item) => item.approval ? [item.approval.action_id] : [])),
    inboxCount: [inbox.unread_count, inboxCount.unread_count],
    employees: [byEmployee.get(employeeId) ?? 0, byEmployee.get(deftyEmployeeId) ?? 0],
    team,
    stored: items.map((item) => `${labelOf.get(item.source_id)}:${item.state}`).sort(),
  };
}

async function observeAll() {
  const out: Record<string, unknown> = {};
  for (const viewer of viewers) out[viewer] = await observe(viewer);
  return out;
}

async function sweep() {
  const { resolveApprovalItemsWithoutReviewer } = await import('../src/lib/attention.js');
  for (let pass = 0; pass < 5; pass += 1) await resolveApprovalItemsWithoutReviewer(500);
}

/** Recorded on the review rule as it stands; every change to these queries must keep it. */
const INITIAL: Record<string, unknown> = {
  owner: {
    attention: ['agent-requester-defty', 'assign-guest-on-departed', 'defty-plain-departed', 'employee-msg-pub', 'employee-sourceless', 'module-agent'],
    attentionAll: ['agent-requester-defty', 'assign-guest-on-departed', 'defty-plain-departed', 'employee-msg-pub', 'employee-sourceless', 'module-agent'],
    counts: [6, 6, 6],
    inbox: ['agent-requester-defty', 'assign-guest-on-departed', 'defty-plain-departed', 'employee-msg-pub', 'employee-sourceless', 'mirror-member', 'mirror-peer', 'module-agent'],
    inboxCount: [8, 8],
    employees: [5, 0],
    team: 4,
    stored: ['agent-requester-defty:open_unseen', 'assign-guest-on-departed:open_unseen', 'defty-plain-departed:open_unseen', 'employee-msg-pub:open_unseen', 'employee-sourceless:open_unseen', 'module-agent:open_unseen'],
  },
  admin: {
    attention: ['agent-requester-defty', 'assign-admin-on-departed', 'assign-decided-admin', 'assign-guest-on-departed', 'assign-owner-outside-room', 'capture-departed-room', 'defty-msg-departed-room', 'defty-plain-departed', 'employee-msg-pub', 'employee-sourceless', 'module-agent'],
    attentionAll: ['agent-requester-defty', 'assign-admin-on-departed', 'assign-decided-admin', 'assign-guest-on-departed', 'assign-owner-outside-room', 'capture-departed-room', 'defty-msg-departed-room', 'defty-plain-departed', 'employee-msg-pub', 'employee-sourceless', 'module-agent'],
    counts: [11, 11, 11],
    inbox: ['agent-requester-defty', 'assign-admin-on-departed', 'assign-decided-admin', 'assign-guest-on-departed', 'assign-owner-outside-room', 'defty-msg-departed-room', 'defty-plain-departed', 'employee-msg-pub', 'employee-sourceless', 'mirror-member', 'mirror-peer', 'module-agent'],
    inboxCount: [12, 12],
    employees: [5, 0],
    team: 9,
    stored: ['agent-requester-defty:open_unseen', 'assign-admin-on-departed:open_unseen', 'assign-decided-admin:open_unseen', 'assign-guest-on-departed:open_unseen', 'assign-owner-outside-room:open_unseen', 'capture-departed-room:open_unseen', 'defty-msg-departed-room:open_unseen', 'defty-plain-departed:open_unseen', 'employee-msg-pub:open_unseen', 'employee-sourceless:open_unseen', 'module-agent:open_unseen'],
  },
  member: {
    attention: ['assign-member-self', 'assign-peer-on-member', 'capture-member-room', 'capture-no-room', 'defty-envelope-msg', 'defty-msg-member', 'defty-plain-member', 'employee-for-member', 'full-member', 'mirror-member', 'module-member'],
    attentionAll: ['assign-member-self', 'assign-peer-on-member', 'capture-member-room', 'capture-no-room', 'defty-envelope-msg', 'defty-msg-member', 'defty-plain-member', 'employee-for-member', 'full-member', 'mirror-member', 'module-member'],
    counts: [11, 11, 11],
    inbox: ['assign-member-self', 'assign-peer-on-member', 'defty-envelope-msg', 'defty-msg-member', 'defty-plain-member', 'employee-for-member', 'full-member', 'mirror-member', 'module-member'],
    inboxCount: [9, 9],
    employees: [4, 1],
    team: 12,
    stored: ['assign-member-self:open_unseen', 'assign-peer-on-member:open_unseen', 'capture-member-room:open_unseen', 'capture-no-room:open_unseen', 'defty-envelope-msg:open_unseen', 'defty-msg-member:open_unseen', 'defty-plain-member:open_unseen', 'employee-for-member:open_unseen', 'full-member:open_unseen', 'mirror-member:open_unseen', 'module-member:open_unseen'],
  },
  peer: {
    attention: ['capture-peer-room', 'mirror-peer'],
    attentionAll: ['capture-peer-room', 'mirror-peer'],
    counts: [2, 2, 2],
    inbox: ['mirror-peer'],
    inboxCount: [1, 1],
    employees: [2, 0],
    team: 3,
    stored: ['capture-peer-room:open_unseen', 'mirror-peer:open_unseen'],
  },
  guest: {
    attention: ['capture-guest-pub', 'defty-msg-guest-pub', 'defty-plain-guest'],
    attentionAll: ['capture-guest-pub', 'defty-msg-guest-pub', 'defty-plain-guest'],
    counts: [3, 3, 3],
    inbox: ['defty-msg-guest-pub', 'defty-plain-guest'],
    inboxCount: [2, 2],
    employees: [2, 0],
    team: null,
    stored: ['capture-guest-pub:open_unseen', 'defty-msg-guest-pub:open_unseen', 'defty-plain-guest:open_unseen'],
  },
};
/** The member after leaving the private room and the maintenance sweep. */
const MEMBER_AFTER_LEAVE = {
    attention: ['assign-member-self', 'assign-peer-on-member', 'capture-no-room', 'defty-plain-member', 'employee-for-member', 'full-member', 'mirror-member', 'module-member'],
    attentionAll: ['assign-member-self', 'assign-peer-on-member', 'capture-no-room', 'defty-plain-member', 'employee-for-member', 'full-member', 'mirror-member', 'module-member'],
    counts: [8, 8, 8],
    inbox: ['assign-member-self', 'assign-peer-on-member', 'defty-plain-member', 'employee-for-member', 'full-member', 'mirror-member', 'module-member'],
    inboxCount: [7, 7],
    employees: [4, 0],
    team: 9,
    stored: ['assign-member-self:open_unseen', 'assign-peer-on-member:open_unseen', 'capture-member-room:resolved', 'capture-no-room:open_unseen', 'defty-envelope-msg:resolved', 'defty-msg-member:resolved', 'defty-plain-member:open_unseen', 'employee-for-member:open_unseen', 'full-member:open_unseen', 'mirror-member:open_unseen', 'module-member:open_unseen'],
};

test('PERF-A: every polled approval queue serves each viewer the same approvals through room changes and maintenance', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const observed: Record<string, unknown> = {};
  observed.initial = await observeAll();
  // The member leaves the private room: Defty proposals and captures anchored there leave the member's queues.
  await q('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [roomIds.room, ids.member]);
  await sweep();
  observed.afterLeave = await observeAll();
  // Back in the room: the items closed for lost access open again.
  await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), roomIds.room, ids.member]);
  await sweep();
  observed.afterReturn = await observeAll();
  if (process.env.PRINT_QUEUE_AUDIENCE) console.log(JSON.stringify(observed));
  assert.deepEqual(observed.initial, INITIAL);
  assert.deepEqual(observed.afterLeave, { ...INITIAL, member: MEMBER_AFTER_LEAVE });
  assert.deepEqual(observed.afterReturn, INITIAL);
});

type Statement = { text: string; values: unknown[] };

/** Every statement the app sends while `run` runs. */
async function statementsOf(run: () => Promise<unknown>): Promise<Statement[]> {
  const proto = pg.Client.prototype as any;
  const original = proto.query;
  const seen: Statement[] = [];
  proto.query = function (this: unknown, config: any, values?: unknown, ...rest: unknown[]) {
    if (this !== client) {
      const text = typeof config === 'string' ? config : config?.text;
      if (text) seen.push({ text, values: (typeof config === 'string' ? values : config?.values ?? values) as unknown[] ?? [] });
    }
    return original.call(this, config, values, ...rest);
  };
  try { await run(); } finally { proto.query = original; }
  return seen;
}

/** The review check, as inlined into Attention statements. */
const REVIEW_CHECK = 'review_role';

test('PERF-B: a steady Attention poll runs the review check for the backfill only on candidate actions', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const poll = (viewer: Person) => json(viewer, '/api/attention', '?lane=needs_you&limit=1');
  for (const viewer of viewers) await poll(viewer);
  // Nothing to raise or reopen for the admin: no statement runs the review check for the backfill.
  const adminPoll = await statementsOf(() => poll('admin'));
  const backfill = (rows: Statement[]) => rows.filter((row) => row.text.includes(REVIEW_CHECK)
    && (row.text.includes('approval-requested:') || /^\s*update/i.test(row.text)));
  assert.deepEqual(backfill(adminPoll).map((row) => row.text.slice(0, 60)), []);
  // The member still has own pending actions it cannot review (an archived room, a room it is
  // not in): the backfill checks those candidates only, not every pending action of the workspace.
  const memberPoll = backfill(await statementsOf(() => poll('member')));
  assert.equal(memberPoll.length, 1, 'one backfill statement with the review check');
  const plan = (await q(`EXPLAIN (ANALYZE, FORMAT JSON) ${memberPoll[0]!.text}`, memberPoll[0]!.values)).rows[0]['QUERY PLAN'][0];
  const subplanLoops: number[] = [];
  const walk = (node: any) => {
    if (node['Parent Relationship'] === 'SubPlan') subplanLoops.push(node['Actual Loops'] ?? 0);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan.Plan);
  const count = async (where: string) => Number((await q(`SELECT count(*) FROM agent_actions a WHERE a.org_id=$1
    AND a.approval_status='pending' AND a.approval_tier IN ('quick','full') AND ${where}`, [orgId, ids.member])).rows[0].count);
  const pending = await count('$2::text IS NOT NULL');
  const own = await count(`(a.user_id=$2 AND a.source IS DISTINCT FROM 'defty_capture' OR a.params->>'source_user_id'=$2)`);
  assert.ok(own > 0 && own < pending / 2, `${own} own of ${pending} pending`);
  assert.ok(Math.max(...subplanLoops) <= own,
    `checks run only on the member's own ${own} pending actions, not all ${pending} (loops: ${subplanLoops.join(',')})`);
  // A new approval is still raised on the next poll.
  const fresh = randomUUID();
  labelOf.set(fresh, 'fresh-member');
  await q(`INSERT INTO agent_actions(id,org_id,user_id,action,params,approval_tier,approval_status,source)
    VALUES($1,$2,$3,'create_task','{"title":"fresh"}','quick','pending','native')`, [fresh, orgId, ids.member]);
  const after = await json<AttentionBody>('member', '/api/attention', '?lane=needs_you&limit=100');
  assert.ok(after.items.some((item) => item.source_id === fresh), 'the new approval is raised');
  assert.equal((await statementsOf(() => poll('admin'))).filter((row) => backfill([row]).length).length, 0);
});
