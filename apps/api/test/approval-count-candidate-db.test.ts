/**
 * The approval counts (Inbox count, team "Approvals" count, an agent
 * employee's pending count) count, for every viewer, exactly the pending
 * actions the web review gate (`reviewableActionSql`) lets that viewer review,
 * and run that gate only on the viewer's candidate actions
 * (`actionReviewerCandidateSql`), not on every pending action of the workspace.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { and, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import { agentActions } from '@deft/db/schema';
import { closeDb, db } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
/** A second workspace where the admin is an owner and the departed member is still active. */
const otherOrgId = randomUUID();
const people = ['owner', 'admin', 'member', 'peer', 'guest', 'departed'] as const;
type Person = (typeof people)[number];
const ids = Object.fromEntries(people.map((p) => [p, randomUUID()])) as Record<Person, string>;
const roles: Record<Person, string> = {
  owner: 'owner', admin: 'admin', member: 'member', peer: 'member', guest: 'guest', departed: 'member',
};
const roomIds = { pub: randomUUID(), room: randomUUID(), peerRoom: randomUUID(), archived: randomUUID() };
const agentUserId = randomUUID();
const employeeId = randomUUID();
const BULK = 120;
let deftyUserId = '';
let teamId = '';
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;
let routes: Record<string, Hono> = {};
const labelOf = new Map<string, string>();

const q = (text: string, values: unknown[] = []) => client!.query(text, values);
const SPECIAL = ['app_run_invoke', 'app_record_mirror_nominate'];

async function json<T>(viewer: Person, mount: string, path: string, org = orgId): Promise<T> {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: ids[viewer], org_id: org, email: `${ids[viewer]}@example.test`, role: roleIn(viewer, org) } as any);
    await next();
  });
  hono.route(mount, routes[mount]!);
  const response = await hono.request(`${mount}${path}`);
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as T;
}
const roleIn = (viewer: Person, org: string) => (org === orgId ? roles[viewer] : viewer === 'admin' ? 'owner' : 'member');

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Count audience', `count-audience-${orgId}`]);
  for (const person of people) {
    await q("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,'human',false)", [ids[person], `${ids[person]}@example.test`, person]);
    await q('INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), orgId, ids[person], roles[person], person !== 'departed']);
  }
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [otherOrgId, 'Other', `count-other-${otherOrgId}`]);
  await q("INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,'member',true)", [randomUUID(), otherOrgId, ids.departed]);
  await q("INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,'owner',true)", [randomUUID(), otherOrgId, ids.admin]);
  const { ensureDeftyEmployee } = await import('../src/lib/ensure-defty-membership.js');
  const defty = await ensureDeftyEmployee(orgId);
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
    departedRoom: await msg(roomIds.room, ids.departed), pubByMember: await msg(roomIds.pub, ids.member),
  };
  // The member addressed the employee with that message, so the proposal citing it is the member's.
  await q(`INSERT INTO agent_channel_events(id,org_id,agent_employee_id,kind,source_kind,source_id,space_id,actor_user_id,payload,idempotency_key,created_at)
    VALUES($1,$2,$3,'message.created','message',$4,$5,$6,'{"author_role":"member"}',$7,$8)`,
    [randomUUID(), orgId, employeeId, m.pubByMember, roomIds.pub, ids.member, `message:${m.pubByMember}:employee:${employeeId}`,
      new Date(Date.now() - 900_000)]);

  let offset = 0;
  const action = async (label: string, row: {
    user: string; org?: string; employee?: string | null; action?: string; tier?: string; status?: string; source?: string | null;
    message?: string | null; params?: Record<string, unknown>; approvers?: Array<[string, string?]>;
  }) => {
    const id = randomUUID();
    labelOf.set(id, label);
    offset += 1;
    await q(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,action,params,approval_tier,approval_status,source,message_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, row.org ?? orgId, row.user, row.employee ?? null, row.action ?? 'create_task',
      JSON.stringify(row.params ?? { title: label }), row.tier ?? 'quick', row.status ?? 'pending', row.source === undefined ? 'mention' : row.source,
      row.message ?? null, new Date(Date.now() - 600_000 + offset * 1000)]);
    for (const [user, decision] of row.approvers ?? []) {
      await q('INSERT INTO agent_action_approvers(id,org_id,action_id,user_id,decision) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), row.org ?? orgId, id, user, decision ?? 'pending']);
    }
  };
  const cap = (source_user_id: unknown, source_space_id: string | null, source_message_id: string | null) => ({
    title: 'cap', ...(source_user_id !== undefined ? { source_user_id } : {}), ...(source_space_id ? { source_space_id } : {}),
    ...(source_message_id ? { source_message_id } : {}),
  });
  await action('defty-plain-member', { user: ids.member, source: 'native' });
  await action('defty-msg-member', { user: ids.member, message: m.room });
  await action('defty-msg-peer-outside', { user: ids.peer, message: m.room });
  await action('defty-msg-archived', { user: ids.member, message: m.archived });
  await action('defty-envelope-msg', { user: ids.member, employee: defty.employeeId, message: m.room });
  await action('defty-plain-guest', { user: ids.guest, source: 'native' });
  await action('defty-msg-guest-pub', { user: ids.guest, message: m.pub });
  await action('defty-plain-departed', { user: ids.departed, source: 'native' });
  await action('defty-msg-departed-room', { user: ids.departed, message: m.departedRoom });
  await action('system-requester', { user: deftyUserId, source: 'native' });
  await action('capture-member-room', { user: deftyUserId, source: 'defty_capture', params: cap(ids.member, roomIds.room, m.room) });
  await action('capture-guest-pub', { user: deftyUserId, source: 'defty_capture', params: cap(ids.guest, roomIds.pub, m.pub) });
  await action('capture-departed-room', { user: deftyUserId, source: 'defty_capture', params: cap(ids.departed, roomIds.room, null) });
  await action('capture-no-room', { user: deftyUserId, source: 'defty_capture', params: cap(ids.member, null, null) });
  await action('capture-peer-room', { user: deftyUserId, source: 'defty_capture', params: cap(ids.peer, roomIds.peerRoom, m.peerRoom) });
  await action('capture-blank-user', { user: ids.peer, source: 'defty_capture', params: cap('  ', roomIds.pub, null) });
  await action('capture-number-user', { user: ids.member, source: 'defty_capture', params: cap(7, null, null) });
  await action('capture-origin-member', { user: deftyUserId, source: 'defty_capture', params: { title: 'cap', source_user_id: null, origin_user_id: ids.member } });
  await action('employee-sourceless', { user: agentUserId, employee: employeeId, source: 'mcp' });
  await action('employee-msg-pub', { user: agentUserId, employee: employeeId, source: 'mcp', message: m.pub });
  await action('employee-bound-member', { user: agentUserId, employee: employeeId, source: 'mcp', message: m.pubByMember });
  await action('employee-for-member', { user: ids.member, employee: employeeId, source: 'mcp' });
  await action('employee-for-guest', { user: ids.guest, employee: employeeId, source: 'mcp' });
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
  await action('agent-requester', { user: agentUserId, source: 'native' });
  await action('full-member', { user: ids.member, tier: 'full', source: 'native' });
  await action('null-source-member', { user: ids.member, source: null });
  await action('null-source-agent', { user: agentUserId, source: null });
  await action('auto-member', { user: ids.member, tier: 'auto', source: 'native' });
  await action('settled-member', { user: ids.member, status: 'approved', source: 'native' });
  await action('foreign-departed', { user: ids.departed, org: otherOrgId, source: 'native' });
  await action('foreign-agent', { user: agentUserId, org: otherOrgId, source: 'native' });
  // Many pending employee actions that only the peer reviews: no other viewer is a candidate for them.
  await q(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,action,params,approval_tier,approval_status,source,created_at)
    SELECT gen_random_uuid()::text, $1, $2, $3, 'create_task', '{"title":"bulk"}', 'quick', 'pending', 'mcp', now() - interval '1 hour'
    FROM generate_series(1, ${BULK})`, [orgId, ids.peer, employeeId]);

  teamId = randomUUID();
  await q("INSERT INTO teams(id,org_id,name,handle,created_by) VALUES($1,$2,'Count team',$3,$4)", [teamId, orgId, `ct-${teamId.slice(0, 8)}`, ids.owner]);
  for (const person of ['member', 'peer', 'guest', 'departed'] as const) {
    await q('INSERT INTO team_members(id,org_id,team_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, teamId, ids[person]]);
  }
  routes = {
    '/api/inbox': (await import('../src/routes/inbox.js')).inboxRoutes,
    '/api/teams': (await import('../src/routes/teams.js')).teamRoutes,
  };
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    await q('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
    for (const org of [orgId, otherOrgId]) {
      for (const table of ['team_members', 'teams', 'attention_deliveries', 'attention_events', 'attention_items', 'agent_action_approvers',
        'agent_actions', 'agent_channel_events', 'messages', 'notifications', 'agent_employees', 'spaces', 'org_members']) {
        await q(`DELETE FROM ${table} WHERE org_id=$1`, [org]);
      }
    }
    await q('DELETE FROM orgs WHERE id=ANY($1::text[])', [[orgId, otherOrgId]]);
    await q('DELETE FROM users WHERE id=ANY($1::text[])', [[...Object.values(ids), agentUserId]]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

type Viewer = { id: string; org_id: string; role: string };
const viewerOf = (person: Person, org = orgId): Viewer => ({ id: ids[person], org_id: org, role: roleIn(person, org) });

/** Ordinary pending approvals the viewer reviews, by the unchanged full gate. */
async function referenceOrdinary(viewer: Viewer): Promise<SQL> {
  const { reviewableActionSql } = await import('../src/lib/agent-action-review-gate.js');
  return and(
    eq(agentActions.org_id, viewer.org_id), eq(agentActions.approval_status, 'pending'),
    inArray(agentActions.approval_tier, ['quick', 'full']), notInArray(agentActions.action, SPECIAL),
    reviewableActionSql(viewer),
  )!;
}
const idsWhere = async (where: SQL) => (await db.select({ id: agentActions.id }).from(agentActions).where(where))
  .map((row) => labelOf.get(row.id) ?? 'bulk').sort();

/** Every count path for one viewer, next to the same counts by the unchanged full gate. */
async function observe(person: Person, org = orgId) {
  const viewer = viewerOf(person, org);
  const { ordinaryPendingApprovalSql, reviewableApprovalCountsByEmployee } = await import('../src/lib/pending-approval-audience.js');
  const { actionRequesterIdSql } = await import('../src/lib/agent-action-requester.js');
  const reference = await referenceOrdinary(viewer);
  const ordinary = await idsWhere(ordinaryPendingApprovalSql(viewer));
  const expectedOrdinary = await idsWhere(reference);
  // The Inbox shows captures only on its captures tab.
  const expectedInboxOrdinary = (await idsWhere(and(reference, sql`${agentActions.source} IS DISTINCT FROM 'defty_capture'`)!)).length;
  const inbox = await json<{ items: Array<{ approval?: { action: string } }>; unread_count: number }>(person, '/api/inbox', '?limit=100', org);
  const inboxCount = (await json<{ unread_count: number }>(person, '/api/inbox', '?count_only=1', org)).unread_count;
  // The Inbox's own rule for App Run releases and record-mirror nominations.
  const { visibleCaptureActionSql } = await import('../src/lib/agent-action-visibility.js');
  const { visibleModuleActionSql } = await import('../src/lib/module-action-visibility.js');
  const expectedSpecial = (await idsWhere(and(
    eq(agentActions.org_id, org), eq(agentActions.approval_status, 'pending'), inArray(agentActions.approval_tier, ['quick', 'full']),
    inArray(agentActions.action, SPECIAL), visibleCaptureActionSql(viewer),
    visibleModuleActionSql(viewer.role, { userId: viewer.id, orgId: viewer.org_id }),
    viewer.role === 'owner' || viewer.role === 'admin' ? sql`TRUE` : sql`${actionRequesterIdSql()} = ${viewer.id}`,
  )!)).length;
  const kinds = async (kind: string) => [
    (await json<{ unread_count: number }>(person, '/api/inbox', `?count_only=1&kind=${kind}`, org)).unread_count,
    (await json<{ unread_count: number }>(person, '/api/inbox', `?limit=100&kind=${kind}`, org)).unread_count,
  ];
  const byEmployee = Object.fromEntries((await reviewableApprovalCountsByEmployee(viewer)).entries());
  const expectedByEmployee = Object.fromEntries((await db.select({ e: agentActions.agent_employee_id, n: sql<number>`count(*)::int` })
    .from(agentActions).where(and(eq(agentActions.org_id, org), sql`${agentActions.agent_employee_id} IS NOT NULL`,
      sql`((${inArray(agentActions.action, SPECIAL)} AND ${agentActions.approval_status} = 'pending') OR ${reference})`))
    .groupBy(agentActions.agent_employee_id)).map((row) => [row.e!, Number(row.n)]));
  let team: number[] | null = null;
  if (org === orgId && person !== 'guest' && person !== 'departed') {
    const teamMembers = [ids.member, ids.peer, ids.guest, ids.departed];
    const [expected] = await db.select({ n: sql<number>`count(*)::int` }).from(agentActions).where(and(eq(agentActions.org_id, org),
      sql`((${inArray(agentActions.action, SPECIAL)} AND ${agentActions.approval_status} = 'pending' AND ${inArray(agentActions.user_id, teamMembers)})
        OR (${reference} AND ${inArray(actionRequesterIdSql(), teamMembers)}))`));
    const got = (await json<{ attention: { pending_agent_actions: number } }>(person, '/api/teams', `/${teamId}/dashboard`)).attention.pending_agent_actions;
    team = [got, Number(expected!.n)];
  }
  return {
    ordinary: [ordinary, expectedOrdinary],
    inboxCount: [inboxCount, inbox.unread_count, expectedInboxOrdinary + expectedSpecial],
    approvalsKind: await kinds('pending_approval'),
    capturesKind: await kinds('work_capture'),
    employees: [byEmployee, expectedByEmployee],
    team,
  };
}

async function assertEquivalent(stage: string) {
  const cases: Array<[Person, string]> = [...people.map((p) => [p, orgId] as [Person, string]), ['admin', otherOrgId], ['departed', otherOrgId]];
  for (const [person, org] of cases) {
    const o = await observe(person, org);
    const at = `${stage} ${person}${org === otherOrgId ? ' (other workspace)' : ''}`;
    assert.deepEqual(o.ordinary[0], o.ordinary[1], `${at}: ordinary approvals`);
    assert.equal(o.inboxCount[0], o.inboxCount[2], `${at}: inbox count_only`);
    assert.equal(o.inboxCount[1], o.inboxCount[2], `${at}: inbox list count`);
    assert.equal(o.approvalsKind[0], o.approvalsKind[1], `${at}: approvals tab count`);
    assert.equal(o.capturesKind[0], o.capturesKind[1], `${at}: captures tab count`);
    assert.deepEqual(o.employees[0], o.employees[1], `${at}: employee counts`);
    if (o.team) assert.equal(o.team[0], o.team[1], `${at}: team count`);
  }
}

test('COUNT-A: every approval count equals the full review gate for every viewer, through a room leave and rejoin', async (t) => {
  if (unavailable) return t.skip(unavailable);
  await assertEquivalent('initial');
  // Sanity: the matrix is not empty for the viewers that review something.
  const { ordinaryPendingApprovalSql } = await import('../src/lib/pending-approval-audience.js');
  for (const person of ['owner', 'admin', 'member', 'peer', 'guest'] as const) {
    assert.ok((await idsWhere(ordinaryPendingApprovalSql(viewerOf(person)))).length > 0, `${person} reviews something`);
  }
  await q('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [roomIds.room, ids.member]);
  await assertEquivalent('after leave');
  await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), roomIds.room, ids.member]);
  await assertEquivalent('after rejoin');
});

type Statement = { text: string; values: unknown[] };

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

/** The gate starting as the THEN arm of a CASE whose WHEN is a subquery (the candidate test). */
const GUARDED_GATE = /CASE WHEN \(SubPlan \d+\) THEN \(\(agent_actions\.org_id = [^)]+\) AND \(\(agent_actions\.source IS DISTINCT FROM 'defty_capture'/g;

/**
 * Largest number of times a subquery of the review gate ran (the subplans named
 * in the agent_actions filter after the gate's first test, its capture-room
 * check, the last one in the filter), and whether the gate in the filter sits
 * behind the candidate test.
 */
async function reviewGateLoops(statement: Statement): Promise<{ loops: number; guarded: boolean }> {
  const plan = (await q(`EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) ${statement.text}`, statement.values)).rows[0]['QUERY PLAN'][0];
  const named = new Set<string>();
  const loops = new Map<string, number>();
  let guarded = false;
  const walk = (node: any, main: boolean) => {
    if (main && node.Alias === 'agent_actions' && typeof node.Filter === 'string') {
      const filter: string = node.Filter;
      const start = filter.lastIndexOf("IS DISTINCT FROM 'defty_capture'");
      assert.ok(start >= 0, 'the filter holds the review gate');
      for (const match of filter.slice(start).matchAll(/SubPlan (\d+)/g)) named.add(`SubPlan ${match[1]}`);
      guarded = [...filter.matchAll(GUARDED_GATE)].some((match) => match.index! + match[0].length
        === start + "IS DISTINCT FROM 'defty_capture'".length);
    }
    if (node['Subplan Name']) loops.set(node['Subplan Name'], Math.max(loops.get(node['Subplan Name']) ?? 0, node['Actual Loops'] ?? 0));
    for (const child of node.Plans ?? []) walk(child, main && !['SubPlan', 'InitPlan'].includes(child['Parent Relationship']));
  };
  walk(plan.Plan, true);
  assert.ok(named.size > 0, 'the filter names the review gate subplans');
  return { loops: Math.max(...[...named].map((name) => loops.get(name) ?? 0)), guarded };
}

test('COUNT-B: the counts run the review gate only on the viewer\'s candidate actions', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const pending = Number((await q(`SELECT count(*) FROM agent_actions WHERE org_id=$1 AND approval_status='pending'
    AND approval_tier IN ('quick','full') AND action <> ALL($2::text[])`, [orgId, SPECIAL])).rows[0].count);
  const { reviewableApprovalCountsByEmployee } = await import('../src/lib/pending-approval-audience.js');
  const { actionRequesterIdSql } = await import('../src/lib/agent-action-requester.js');
  const slow: string[] = [];
  for (const person of ['member', 'owner'] as const) {
    const viewer = viewerOf(person);
    // Candidates by the closed rule: the viewer requested it, or the viewer is an active
    // owner/admin and its requester is not an active human member.
    const candidates = Number(((await db.execute(sql`SELECT count(*) FROM agent_actions
      WHERE org_id = ${orgId} AND approval_status = 'pending' AND approval_tier IN ('quick','full')
        AND action NOT IN ('app_run_invoke', 'app_record_mirror_nominate')
        AND (${actionRequesterIdSql()} = ${viewer.id} OR (${person === 'owner'} AND ${actionRequesterIdSql()} NOT IN (
          SELECT u.id FROM users u JOIN org_members om ON om.user_id = u.id
          WHERE om.org_id = ${orgId} AND om.is_active AND u.kind = 'human' AND NOT u.is_agent)))`)).rows[0] as { count: string }).count);
    assert.ok(candidates > 0 && candidates < pending / 4, `${person}: ${candidates} candidates of ${pending} pending`);
    const inboxCount = (await statementsOf(() => json(person, '/api/inbox', '?count_only=1')))
      .filter((row) => row.text.includes('"agent_actions"') && row.text.includes('approval_tier'));
    assert.equal(inboxCount.length, 1, `${person}: one approval statement for the inbox count`);
    assert.ok(/count\(\*\) FILTER/.test(inboxCount[0]!.text) && !inboxCount[0]!.text.includes('"agent_employees"'),
      `${person}: the inbox count counts rows instead of loading them`);
    const employees = (await statementsOf(() => reviewableApprovalCountsByEmployee(viewer)));
    assert.equal(employees.length, 1);
    for (const [name, statement] of [['inbox count', inboxCount[0]!], ['employee counts', employees[0]!]] as const) {
      const { loops, guarded } = await reviewGateLoops(statement);
      if (loops > candidates) slow.push(`${person} ${name}: the gate runs on ${loops} rows, not only the ${candidates} candidates`);
      // Whatever order the planner picks, the gate stays behind the candidate test.
      if (!guarded) slow.push(`${person} ${name}: the gate is not behind the candidate test`);
    }
  }
  assert.deepEqual(slow, []);
  // Control: the same count without the candidate test (the gate kept in one CASE whose WHEN
  // the planner cannot fold, so it cannot reorder the gate's parts) runs the gate on every
  // pending action and is not seen as guarded.
  const { reviewableActionSql } = await import('../src/lib/agent-action-review-gate.js');
  const reference = and(
    eq(agentActions.org_id, orgId), eq(agentActions.approval_status, 'pending'),
    inArray(agentActions.approval_tier, ['quick', 'full']), notInArray(agentActions.action, SPECIAL),
    sql`(CASE WHEN length(${agentActions.id}) > 0 THEN ${reviewableActionSql(viewerOf('member'))} ELSE false END)`,
  )!;
  const plain = db.select({ n: sql`count(*)` }).from(agentActions).where(reference).toSQL();
  const { loops: control, guarded: controlGuarded } = await reviewGateLoops({ text: plain.sql, values: plain.params });
  assert.equal(controlGuarded, false, 'control: the gate is not behind a candidate test');
  assert.ok(control >= BULK, `control: the gate without the candidate test runs ${control} times of ${pending}`);
  const plainEmployees = db.select({ n: sql`count(*)` }).from(agentActions)
    .where(and(reference, sql`${agentActions.agent_employee_id} IS NOT NULL`)).toSQL();
  const { loops: employeeControl } = await reviewGateLoops({ text: plainEmployees.sql, values: plainEmployees.params });
  assert.ok(employeeControl >= BULK, `control: the plain gate runs ${employeeControl} times on employee actions`);
});
