// A guest sees only the people who share at least one space with them, and no
// email address but their own. Owners, admins and members are unchanged. A
// removed member is not found by people search, by anyone. (SFX1 item 1.)
//
// The guest's session and MCP token both claim role 'member': only the
// org_members row makes them a guest, so every check below proves the role is
// read from the database.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setupSocket } from '../src/socket.js';
import { peopleViewer } from '../src/lib/people-visibility.js';
import { memberRoutes } from '../src/routes/members.js';
import { searchRoutes } from '../src/routes/search.js';
import { spaceRoutes } from '../src/routes/spaces.js';
import { groupRoutes } from '../src/routes/groups.js';
import { teamRoutes } from '../src/routes/teams.js';
import { dailyNoteRoutes } from '../src/routes/daily-notes.js';
import { managerRoutes } from '../src/routes/manager.js';
import { taskRoutes } from '../src/routes/tasks.js';
import { agentRoutes } from '../src/routes/agent.js';
import { agentEmployeeRoutes } from '../src/routes/agent-employees.js';
import { sendMessage } from '../src/lib/mcp-tools/writes.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { searchNativeMentions, resolveNativeMentions } from '../src/lib/native-mentions.js';
import { nativeMentionRef } from '@deft/shared';
import { memberList } from '../src/lib/mcp-tools/members.js';
import {
  humanAgentEmployeeGet,
  humanAgentEmployeeList,
  humanTaskUpdate,
  humanMemberGet,
  humanMemberList,
  humanMessagesRecent,
  humanPlatformContext,
  humanResolveMember,
  humanResolveTargets,
  humanTaskGet,
  humanTeamGet,
  humanTeamList,
  humanTeamWorkload,
  type HumanToolContext,
} from '../src/lib/mcp-tools/human.js';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
const run = randomUUID().slice(0, 8);
const org = randomUUID(), otherOrg = randomUUID();
const owner = randomUUID(), admin = randomUUID(), sharer = randomUUID(), stranger = randomUUID();
const guest = randomUUID(), removed = randomUUID(), friend = randomUUID(), archivedPal = randomUUID();
const agentUser = randomUUID(), agentEmployee = randomUUID();
// An agent no guest shares a space with.
const hiddenAgentUser = randomUUID(), hiddenAgentEmployee = randomUUID();
const sharedRoom = randomUUID(), privateRoom = randomUUID(), strangerRoom = randomUUID();
const dmRoom = randomUUID(), archivedRoom = randomUUID(), otherOrgRoom = randomUUID();
const group = randomUUID(), team = randomUUID(), project = randomUUID(), task = randomUUID(), note = randomUUID();
// [id, name, org role, active, kind]
const people: Array<[string, string, string, boolean, 'human' | 'agent']> = [
  [owner, 'Olive Owner', 'owner', true, 'human'],
  [admin, 'Ada Admin', 'admin', true, 'human'],
  [sharer, 'Sam Sharer', 'member', true, 'human'],
  [stranger, 'Stella Stranger', 'member', true, 'human'],
  [guest, 'Gus Guest', 'guest', true, 'human'],
  [removed, 'Remy Removed', 'member', false, 'human'],
  [friend, 'Stella Friend', 'member', true, 'human'],
  [archivedPal, 'Archie Pal', 'member', true, 'human'],
  [agentUser, 'Agatha Agent', 'guest', true, 'agent'],
  [hiddenAgentUser, 'Hector Agent', 'member', true, 'agent'],
];
const emailOf = (id: string) => `gpv-${run}-${id}@test.local`;
const nameOf = (id: string) => `${people.find(([pid]) => pid === id)![1]} ${run}`;

before(async () => {
  await c.connect();
  await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Guest People', $2), ($3, 'Other Workspace', $4)`,
    [org, `guest-people-${run}`, otherOrg, `guest-people-other-${run}`]);
  for (const [id, , role, active, kind] of people) {
    await c.query(`INSERT INTO users (id, email, name, kind, is_agent, password_hash) VALUES ($1, $2, $3, $4, $5, 'hash')`,
      [id, emailOf(id), nameOf(id), kind, kind === 'agent']);
    await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, $4)`,
      [org, id, role, active]);
  }
  // The agent is a BYOA employee an owner made a guest.
  await c.query(`INSERT INTO agent_employees (id, org_id, user_id, slug, name, system_prompt, is_byoa, trust_level, runtime_kind, role, created_by)
    VALUES ($1, $2, $3, $4, 'Agatha Agent', 'test', true, 'standard', 'custom_mcp', 'custom', $5)`, [agentEmployee, org, agentUser, `gpv-agent-${run}`, owner]);
  await c.query(`INSERT INTO agent_employees (id, org_id, user_id, slug, name, system_prompt, is_byoa, trust_level, runtime_kind, role, created_by)
    VALUES ($1, $2, $3, $4, 'Hector Agent', 'test', true, 'standard', 'custom_mcp', 'custom', $5)`, [hiddenAgentEmployee, org, hiddenAgentUser, `gpv-hidden-agent-${run}`, owner]);
  // In another workspace the guest and Stella share a room: that must not
  // make Stella visible to the guest here.
  for (const id of [guest, stranger]) {
    await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, 'member', true)`, [otherOrg, id]);
  }
  await c.query(`INSERT INTO spaces (id, org_id, name, type, created_by, is_archived) VALUES
      ($1, $7, 'gpv shared', 'private', $8, false), ($2, $7, 'gpv owner room', 'private', $8, false),
      ($3, $7, 'gpv stranger room', 'public', $8, false), ($4, $7, 'gpv dm', 'dm', $9, false),
      ($5, $7, 'gpv archived', 'private', $8, true), ($6, $10, 'gpv elsewhere', 'private', $11, false)`,
  [sharedRoom, privateRoom, strangerRoom, dmRoom, archivedRoom, otherOrgRoom, org, owner, guest, otherOrg, stranger]);
  for (const [room, user] of [
    [sharedRoom, guest], [sharedRoom, admin], [sharedRoom, sharer], [sharedRoom, removed], [sharedRoom, agentUser],
    [privateRoom, owner], [privateRoom, stranger], [privateRoom, sharer],
    [strangerRoom, stranger], [strangerRoom, owner],
    [dmRoom, guest], [dmRoom, friend],
    [archivedRoom, guest], [archivedRoom, archivedPal],
    [otherOrgRoom, guest], [otherOrgRoom, stranger],
  ]) {
    await c.query(`INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [room, user]);
  }
  await c.query(`INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES (gen_random_uuid()::text, $1, $2, $3, 'gpv hello')`, [org, sharedRoom, sharer]);
  await c.query(`INSERT INTO user_groups (id, org_id, name, handle, created_by) VALUES ($1, $2, 'gpv group', $3, $4)`, [group, org, `gpv-${run}`, owner]);
  for (const user of [sharer, stranger, owner]) {
    await c.query(`INSERT INTO user_group_members (id, group_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [group, user]);
  }
  await c.query(`INSERT INTO teams (id, org_id, name, handle, visibility, lead_user_id, created_by) VALUES ($1, $2, 'gpv team', $3, 'org', $4, $4)`,
    [team, org, `gpv-team-${run}`, stranger]);
  for (const [user, role] of [[stranger, 'lead'], [sharer, 'member']]) {
    await c.query(`INSERT INTO team_members (id, org_id, team_id, user_id, role) VALUES (gen_random_uuid()::text, $1, $2, $3, $4)`, [org, team, user, role]);
  }
  await c.query(`INSERT INTO projects (id, org_id, name, prefix, lead_id) VALUES ($1, $2, 'gpv project', $3, $4)`, [project, org, `G${run.slice(0, 4).toUpperCase()}`, owner]);
  await c.query(`INSERT INTO tasks (id, org_id, project_id, number, title, created_by, assignee_id) VALUES ($1, $2, $3, 1, 'gpv task', $4, $5)`,
    [task, org, project, stranger, sharer]);
  await c.query(`INSERT INTO task_comments (id, org_id, task_id, user_id, content) VALUES (gen_random_uuid()::text, $1, $2, $3, 'gpv comment')`, [org, task, stranger]);
  await c.query(`INSERT INTO notes (id, org_id, user_id, title) VALUES ($1, $2, $3, 'gpv note')`, [note, org, guest]);
  await c.query(`INSERT INTO note_shares (id, note_id, shared_with_user_id, permission) VALUES (gen_random_uuid()::text, $1, $2, 'view')`, [note, sharer]);
});

after(async () => {
  const all = people.map(([id]) => id);
  await c.query(`DELETE FROM note_shares WHERE note_id = $1`, [note]);
  await c.query(`DELETE FROM notes WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM task_comments WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM task_activity WHERE org_id = $1`, [org]).catch(() => {});
  await c.query(`DELETE FROM tasks WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM projects WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM team_members WHERE team_id = $1`, [team]);
  await c.query(`DELETE FROM teams WHERE id = $1`, [team]);
  await c.query(`DELETE FROM user_group_members WHERE group_id = $1`, [group]);
  await c.query(`DELETE FROM user_groups WHERE id = $1`, [group]);
  await c.query(`DELETE FROM messages WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = ANY($1::text[]))`, [[org, otherOrg]]);
  await c.query(`DELETE FROM spaces WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]);
  await c.query(`DELETE FROM agent_employees WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM org_members WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]);
  await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [all]);
  await c.query(`DELETE FROM orgs WHERE id = ANY($1::text[])`, [[org, otherOrg]]);
  await c.end();
});

// The session claims 'member' for the guest; only org_members says guest.
const sessionRole = (viewer: string) => (viewer === guest ? 'member' : people.find(([id]) => id === viewer)![2]);

function app(viewer: string) {
  const hono = new Hono();
  hono.use('*', async (ctx, next) => {
    ctx.set('user', { id: viewer, org_id: org, email: emailOf(viewer), sid: 's', role: sessionRole(viewer) } as never);
    await next();
  });
  hono.route('/api/members', memberRoutes);
  hono.route('/api/search', searchRoutes);
  hono.route('/api/spaces', spaceRoutes);
  hono.route('/api/groups', groupRoutes);
  hono.route('/api/teams', teamRoutes);
  hono.route('/api/daily-notes', dailyNoteRoutes);
  hono.route('/api/manager', managerRoutes);
  hono.route('/api/tasks', taskRoutes);
  hono.route('/api/agent', agentRoutes);
  hono.route('/api/agent-employees', agentEmployeeRoutes);
  return hono;
}

async function call(viewer: string, path: string, init?: { method: string; body?: unknown }) {
  const res = await app(viewer).request(path, init ? {
    method: init.method,
    headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  } : undefined);
  return { status: res.status, body: await res.json() as any };
}
const get = (viewer: string, path: string) => call(viewer, path);

const mcp = (viewer: string): HumanToolContext => ({
  org_id: org,
  user_id: viewer,
  role: sessionRole(viewer) as HumanToolContext['role'],
  scopes: ['read:workspace', 'read:tasks', 'read:messages'],
});
const parse = (result: { content: Array<{ text: string }>; isError?: boolean }) => JSON.parse(result.content[0]!.text);
// A person's id: `user_id` where a row has its own id (team and group members), else `id`.
const personId = (row: { id?: string; user_id?: string }) => row.user_id ?? row.id;
const known = new Set(people.map(([id]) => id));
const ids = (rows: Array<{ id?: string; user_id?: string }>) => rows.map(personId).filter((id): id is string => known.has(id!)).sort();
const sorted = (...list: string[]) => [...list].sort();

const GUEST_SEES = sorted(guest, admin, sharer, friend, archivedPal, agentUser);
const MEMBER_SEES = sorted(owner, admin, sharer, stranger, guest, friend, archivedPal, agentUser, hiddenAgentUser);

function assertGuestEmails(rows: Array<{ id?: string; user_id?: string; email?: string | null }>, self = guest) {
  for (const row of rows) {
    const id = personId(row);
    if (id === self) assert.equal(row.email, emailOf(self), 'the viewer sees their own email');
    else assert.equal(row.email, null, `no email for ${id}`);
  }
}

test('GET /api/members: a guest sees only people sharing a space (a room, a DM, an archived room), without emails', async () => {
  const res = await get(guest, '/api/members');
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res.body), GUEST_SEES);
  assertGuestEmails(res.body);
  assert.equal(res.body.some((row: any) => row.id === stranger), false, 'a room shared in another workspace does not count');
});

test('GET /api/members: members and admins are unchanged', async () => {
  for (const viewer of [sharer, admin, owner]) {
    const res = await get(viewer, '/api/members');
    assert.equal(res.status, 200);
    assert.deepEqual(ids(res.body), MEMBER_SEES, viewer);
    for (const row of res.body.filter((r: any) => known.has(r.id))) assert.equal(row.email, emailOf(row.id));
  }
});

test('GET /api/members/directory: a guest sees only people sharing a space, without emails', async () => {
  const guestView = await get(guest, '/api/members/directory');
  assert.equal(guestView.status, 200);
  assert.deepEqual(ids(guestView.body.members), GUEST_SEES);
  assertGuestEmails(guestView.body.members);
  assert.deepEqual(guestView.body.invites, []);

  const memberView = await get(sharer, '/api/members/directory');
  assert.deepEqual(ids(memberView.body.members), MEMBER_SEES);
  const adminView = await get(admin, '/api/members/directory');
  assert.deepEqual(ids(adminView.body.members), sorted(...MEMBER_SEES, removed), 'admins still see removed members');
  assert.equal(adminView.body.members.find((m: any) => m.id === stranger).email, emailOf(stranger));
});

test('GET /api/members/:id and /:id/detail: a guest reaches only people sharing a space', async () => {
  const visible = await get(guest, `/api/members/${sharer}`);
  assert.equal(visible.status, 200);
  assert.equal(visible.body.email, null);
  assert.equal((await get(guest, `/api/members/${guest}`)).body.email, emailOf(guest));
  assert.equal((await get(guest, `/api/members/${friend}`)).status, 200, 'shared through a DM');
  assert.equal((await get(guest, `/api/members/${archivedPal}`)).status, 200, 'shared through an archived room');
  for (const hidden of [stranger, owner, removed, randomUUID()]) {
    const one = await get(guest, `/api/members/${hidden}`);
    assert.equal(one.status, 404, hidden);
    assert.deepEqual(one.body, { error: 'Member not found', code: 'NOT_FOUND' }, 'a hidden person answers like an unknown id');
    assert.equal((await get(guest, `/api/members/${hidden}/detail`)).status, 404, hidden);
  }

  const detail = await get(guest, `/api/members/${sharer}/detail`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.member.email, null);
  assert.deepEqual(detail.body.spaces.map((s: any) => s.id), [sharedRoom], 'only the spaces the guest shares');

  const memberView = await get(admin, `/api/members/${stranger}`);
  assert.equal(memberView.status, 200);
  assert.equal(memberView.body.email, emailOf(stranger));
  const memberDetail = await get(sharer, `/api/members/${stranger}/detail`);
  assert.equal(memberDetail.status, 200);
  assert.equal(memberDetail.body.member.email, emailOf(stranger));
  assert.equal(memberDetail.body.spaces.length, 2);
});

test('people search: removed members are absent for everyone; a guest finds only shared-space people by name', async () => {
  const search = async (viewer: string, q: string) => {
    const res = await get(viewer, `/api/search?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200);
    return res.body.people as Array<{ id: string; email: string | null }>;
  };
  for (const viewer of [owner, admin, sharer, guest]) {
    assert.deepEqual(ids(await search(viewer, nameOf(removed))), [], `removed member hidden from ${viewer}`);
    assert.deepEqual(ids(await search(viewer, emailOf(removed))), [], `removed member email hidden from ${viewer}`);
  }
  assert.deepEqual(ids(await search(guest, nameOf(sharer))), [sharer]);
  assert.equal((await search(guest, nameOf(sharer)))[0]!.email, null);
  assert.deepEqual(ids(await search(guest, nameOf(stranger))), []);
  assert.deepEqual(ids(await search(guest, emailOf(sharer))), [], 'a guest cannot search by email');
  assert.deepEqual(ids(await search(sharer, nameOf(stranger))), [stranger]);
  const byEmail = await search(owner, emailOf(stranger));
  assert.deepEqual(ids(byEmail), [stranger]);
  assert.equal(byEmail[0]!.email, emailOf(stranger));
});

test('a guest cannot make a hidden person visible: DMs, room adds and note shares answer like an unknown id', async () => {
  const unknown = randomUUID();
  const dmHidden = await call(guest, '/api/spaces', { method: 'POST', body: { name: 'dm', type: 'dm', user_ids: [stranger] } });
  const dmUnknown = await call(guest, '/api/spaces', { method: 'POST', body: { name: 'dm', type: 'dm', user_ids: [unknown] } });
  assert.equal(dmHidden.status, 400);
  assert.deepEqual(dmHidden, dmUnknown);
  const groupHidden = await call(guest, '/api/spaces', { method: 'POST', body: { name: 'g', type: 'group_dm', user_ids: [sharer, stranger] } });
  assert.deepEqual(groupHidden, dmUnknown);
  assert.equal((await get(guest, `/api/members/${stranger}`)).status, 404, 'still hidden');

  const addHidden = await call(guest, `/api/spaces/${sharedRoom}/members`, { method: 'POST', body: { user_id: stranger } });
  const addUnknown = await call(guest, `/api/spaces/${sharedRoom}/members`, { method: 'POST', body: { user_id: unknown } });
  assert.equal(addHidden.status, 404);
  assert.deepEqual(addHidden, addUnknown);

  const shareHidden = await call(guest, `/api/daily-notes/${note}/shares`, { method: 'POST', body: { user_id: stranger } });
  const shareUnknown = await call(guest, `/api/daily-notes/${note}/shares`, { method: 'POST', body: { user_id: unknown } });
  assert.equal(shareHidden.status, 404);
  assert.deepEqual(shareHidden, shareUnknown);
  const shares = await get(guest, `/api/daily-notes/${note}/shares`);
  assert.equal(shares.status, 200);
  assert.deepEqual(shares.body.shares.map((s: any) => [s.user_id, s.user_name, s.user_email]), [[sharer, nameOf(sharer), null]]);

  // A member is unchanged: the DM with Stella is created.
  const memberDm = await call(sharer, '/api/spaces', { method: 'POST', body: { name: 'dm', type: 'dm', user_ids: [stranger] } });
  assert.equal(memberDm.status, 201);
  await c.query(`DELETE FROM space_members WHERE space_id = $1`, [memberDm.body.id]);
  await c.query(`DELETE FROM spaces WHERE id = $1`, [memberDm.body.id]);
});

test('space members, group members and team members follow the same rule', async () => {
  const room = await get(guest, `/api/spaces/${sharedRoom}/members`);
  assert.equal(room.status, 200);
  assertGuestEmails(room.body);
  const roomForAdmin = await get(admin, `/api/spaces/${sharedRoom}/members`);
  assert.equal(roomForAdmin.body.find((m: any) => m.id === sharer).email, emailOf(sharer));

  const groupForGuest = await get(guest, `/api/groups/${group}`);
  assert.equal(groupForGuest.status, 200);
  assert.deepEqual(ids(groupForGuest.body.members), [sharer]);
  assertGuestEmails(groupForGuest.body.members);
  assert.deepEqual(ids((await get(sharer, `/api/groups/${group}`)).body.members), sorted(sharer, stranger, owner));

  const teamForGuest = await get(guest, `/api/teams/${team}`);
  assert.equal(teamForGuest.status, 200);
  assert.equal(teamForGuest.body.lead, null, 'a lead the guest shares no space with is not shown');
  assert.equal(teamForGuest.body.team.lead_user_id, null, '... nor their id');
  assert.equal(teamForGuest.body.team.created_by, null);
  assert.deepEqual(ids(teamForGuest.body.members), [sharer]);
  assertGuestEmails(teamForGuest.body.members);
  const listed = (await get(guest, '/api/teams')).body.find((row: any) => row.id === team);
  assert.equal(listed.lead_user_id, null);
  const teamForMember = await get(sharer, `/api/teams/${team}`);
  assert.equal(teamForMember.body.lead.email, emailOf(stranger));
  assert.equal(teamForMember.body.team.lead_user_id, stranger);
  assert.deepEqual(ids(teamForMember.body.members), sorted(stranger, sharer));
});

test('MCP member_list, member_get and resolve_member follow the rule', async () => {
  const guestList = parse(await humanMemberList({}, mcp(guest)));
  assert.deepEqual(ids(guestList), GUEST_SEES);
  assertGuestEmails(guestList);
  assert.deepEqual(ids(parse(await humanMemberList({ query: emailOf(sharer) }, mcp(guest)))), [], 'no email matching for a guest');
  const listForMember = parse(await humanMemberList({}, mcp(sharer)));
  assert.deepEqual(ids(listForMember), MEMBER_SEES);
  assert.equal(listForMember.find((m: any) => m.id === stranger).email, emailOf(stranger));

  const got = parse(await humanMemberGet({ user_id: sharer }, mcp(guest)));
  assert.equal(got.id, sharer);
  assert.equal(got.email, null);
  assert.equal((await humanMemberGet({ user_id: stranger }, mcp(guest))).isError, true);
  assert.equal((await humanMemberGet({ email: emailOf(sharer) }, mcp(guest))).isError, true, 'no lookup by email for a guest');
  assert.equal(parse(await humanMemberGet({ email: emailOf(stranger) }, mcp(sharer))).id, stranger);

  const resolvedForGuest = parse(await humanResolveMember({ query: nameOf(stranger) }, mcp(guest)));
  assert.equal(JSON.stringify(resolvedForGuest).includes(stranger), false, 'the stranger is not a candidate');
  const sam = parse(await humanResolveMember({ query: nameOf(sharer) }, mcp(guest)));
  assert.equal(sam.selected.id, sharer);
  assert.equal(JSON.stringify(sam).includes(emailOf(sharer)), false);
  assert.equal(parse(await humanResolveMember({ query: nameOf(stranger) }, mcp(sharer))).selected.id, stranger);

  const targets = parse(await humanResolveTargets({ members: [nameOf(stranger)] }, mcp(guest)));
  assert.equal(JSON.stringify(targets).includes(stranger), false);
});

test('MCP platform_context, team tools, task_get and messages_recent follow the rule', async () => {
  const context = parse(await humanPlatformContext({}, mcp(guest)));
  assert.deepEqual(ids(context.teammates), GUEST_SEES);
  assertGuestEmails(context.teammates);

  const teamView = parse(await humanTeamGet({ team_id: team }, mcp(guest)));
  assert.deepEqual(ids(teamView.members), [sharer]);
  assertGuestEmails(teamView.members);
  assert.equal(teamView.team.lead_name, null);
  assert.equal(teamView.team.lead_user_id, null);
  const listed = parse(await humanTeamList({}, mcp(guest))).teams.find((row: any) => row.id === team);
  assert.equal(listed.lead_user_id, null);
  assert.deepEqual(ids(parse(await humanTeamGet({ team_id: team }, mcp(sharer))).members), sorted(stranger, sharer));

  const workload = parse(await humanTeamWorkload({}, mcp(guest)));
  assert.deepEqual(ids(workload.workload), sorted(guest, admin, sharer, friend, archivedPal));
  assert.deepEqual(ids(parse(await humanTeamWorkload({}, mcp(sharer))).workload),
    sorted(owner, admin, sharer, stranger, guest, friend, archivedPal));

  const taskView = parse(await humanTaskGet({ task_id: task }, mcp(guest)));
  assert.equal(taskView.task.assignee_email, null);
  assert.equal(taskView.task.created_by_email, null);
  assert.ok(taskView.recent_comments.length > 0);
  for (const comment of taskView.recent_comments) assert.equal(comment.user_email, null);
  assert.equal(parse(await humanTaskGet({ task_id: task }, mcp(sharer))).task.created_by_email, emailOf(stranger));

  const forGuest = parse(await humanMessagesRecent({ space_id: sharedRoom }, mcp(guest)));
  const message = forGuest.messages.find((m: any) => m.user_id === sharer);
  assert.ok(message, 'the guest reads the shared room');
  assert.equal(message.user_email, null);
  const forMember = parse(await humanMessagesRecent({ space_id: sharedRoom }, mcp(sharer)));
  assert.equal(forMember.messages.find((m: any) => m.user_id === sharer).user_email, emailOf(sharer));
});

test('an agent employee an owner made a guest sees people as a guest does', async () => {
  const listed = parse(await memberList({ caller_employee_slug: `gpv-agent-${run}` }, {
    org_id: org, employee_id: agentEmployee, employee_slug: `gpv-agent-${run}`, trust_level: 'standard',
  } as never));
  assert.deepEqual(ids(listed), sorted(agentUser, guest, admin, sharer));
  assertGuestEmails(listed, agentUser);
});

test('native mentions: a guest finds and resolves only people sharing a space', async () => {
  const found = async (viewer: string, query: string) => (await searchNativeMentions({ orgId: org, userId: viewer }, query))
    .filter((p: any) => p.ref.resource_type === 'person' && p.state === 'available').map((p: any) => p.ref.resource_id);
  assert.deepEqual(await found(guest, `Stella`), [friend]);
  assert.deepEqual((await found(sharer, `Stella`)).sort(), sorted(friend, stranger));
  const [resolvedHidden] = await resolveNativeMentions({ orgId: org, userId: guest }, [nativeMentionRef('person', stranger)]);
  const [resolvedUnknown] = await resolveNativeMentions({ orgId: org, userId: guest }, [nativeMentionRef('person', randomUUID())]);
  assert.equal(resolvedHidden!.state, 'unavailable');
  assert.equal(resolvedUnknown!.state, 'unavailable');
});

test('Defty, asked by a guest: search_members filters before matching, and people analytics are refused', async () => {
  const forGuest = await executeToolCall('search_members', { query: nameOf(stranger) }, org, guest);
  assert.equal(forGuest.result.code, 'MEMBER_NOT_FOUND');
  assert.deepEqual(forGuest.result.matches, []);
  // Hidden "Stella Stranger" and visible "Stella Friend": the guest gets Stella Friend, not an ambiguity.
  const stella = await executeToolCall('search_members', { query: 'Stella' }, org, guest);
  assert.equal(stella.result.member.id, friend);
  assert.equal((await executeToolCall('search_members', { query: 'Stella' }, org, sharer)).result.code, 'MEMBER_AMBIGUOUS');
  assert.equal((await executeToolCall('search_members', { query: nameOf(stranger) }, org, sharer)).result.member.id, stranger);

  for (const tool of ['get_team_workload', 'get_user_activity', 'get_workload_balance', 'find_expert', 'get_team_dynamics',
    'get_team_performance', 'analyze_skills_gap', 'list_agent_employees', 'get_agent_economics']) {
    const refused = await executeToolCall(tool, { user_name: 'Stella', topic: 'launch' }, org, guest);
    assert.equal(refused.result.code, 'NOT_AVAILABLE_TO_GUESTS', tool);
  }
  const forMember = await executeToolCall('get_user_activity', { user_name: nameOf(stranger) }, org, sharer)
    .catch((error: unknown) => ({ result: { thrown: String(error) } as Record<string, unknown> }));
  assert.notEqual((forMember.result as { code?: string }).code, 'NOT_AVAILABLE_TO_GUESTS');
});

test('1:1 prep: a guest, and a report from another workspace, get "member not found"', async () => {
  const fromGuest = await call(guest, '/api/manager/oneone-prep', { method: 'POST', body: { report_id: sharer } });
  assert.equal(fromGuest.status, 404);
  const outsider = await call(admin, '/api/manager/oneone-prep', { method: 'POST', body: { report_id: stranger.replace(/./, '0') } });
  assert.deepEqual(fromGuest, outsider);
});

const { io: connectSocket } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');

test('presence: a guest is told only about people who share a space with them; members about everyone', async () => {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const tokens: Record<string, string> = { guest, sharer, stranger, owner };
  const server = createServer();
  const sockets = setupSocket(server, {
    verifyAccess: async (token: string) => {
      const id = tokens[token];
      if (!id) throw new Error('unknown token');
      return { id, org_id: org, email: emailOf(id), sid: `gpv-${token}`, exp } as never;
    },
    // The role comes from org_members, as in production.
    requireMembership: async (_org: string, userId: string) => ({ role: people.find(([id]) => id === userId)![2] }) as never,
    getSpaceAccess: async () => undefined,
    recordLastSeen: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const clients: any[] = [];
  const open = async (token: string) => {
    const client = connectSocket(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false });
    clients.push(client);
    const events: Array<{ event: string; data: any }> = [];
    client.onAny((event: string, data: unknown) => events.push({ event, data }));
    const init = await new Promise<Array<{ user_id: string }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`presence:init timed out for ${token}`)), 5_000);
      client.once('presence:init', (value: Array<{ user_id: string }>) => { clearTimeout(timer); resolve(value); });
    });
    return { client, events, init };
  };
  const onlineSeen = (events: Array<{ event: string; data: any }>, id: string) =>
    events.some((e) => e.event === 'presence:update' && e.data?.user_id === id);
  try {
    const watchingGuest = await open('guest');
    const watchingMember = await open('owner');
    await open('sharer');
    await open('stranger');
    const deadline = Date.now() + 5_000;
    while (!(onlineSeen(watchingMember.events, sharer) && onlineSeen(watchingMember.events, stranger)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(onlineSeen(watchingMember.events, stranger), 'a member sees everyone come online');
    assert.ok(onlineSeen(watchingGuest.events, sharer), 'the guest sees a person they share a space with');
    assert.equal(onlineSeen(watchingGuest.events, stranger), false, 'the guest is not told about a hidden person');
    assert.equal(onlineSeen(watchingGuest.events, owner), false);

    const lateGuest = await open('guest');
    const listed = lateGuest.init.map((entry) => entry.user_id);
    assert.ok(listed.includes(sharer));
    assert.equal(listed.includes(stranger), false, 'presence:init omits hidden people');
    assert.equal(listed.includes(owner), false);
    const lateMember = await open('sharer');
    assert.ok(lateMember.init.map((entry) => entry.user_id).includes(stranger));
  } finally {
    for (const client of clients) client.close();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  }
});

test('a guest cannot assign a hidden person, or start a conversation with a hidden agent; the agent list follows the rule', async () => {
  const unknown = randomUUID();
  const assignHidden = await call(guest, `/api/tasks/${task}/assignees`, { method: 'POST', body: { user_id: stranger } });
  const assignUnknown = await call(guest, `/api/tasks/${task}/assignees`, { method: 'POST', body: { user_id: unknown } });
  assert.equal(assignHidden.status, 400);
  assert.deepEqual(assignHidden, assignUnknown);
  const patchHidden = await call(guest, `/api/tasks/${task}`, { method: 'PATCH', body: { assignee_id: stranger } });
  const patchUnknown = await call(guest, `/api/tasks/${task}`, { method: 'PATCH', body: { assignee_id: unknown } });
  assert.equal(patchHidden.status, 400);
  assert.deepEqual(patchHidden, patchUnknown);
  // The task's current assignee re-sent with an edit is no change, even when the guest cannot see them.
  await c.query(`UPDATE tasks SET assignee_id = $1 WHERE id = $2`, [stranger, task]);
  const keep = await call(guest, `/api/tasks/${task}`, { method: 'PATCH', body: { assignee_id: stranger, title: 'gpv task edited' } });
  assert.equal(keep.status, 200, 're-sending a hidden current assignee is not a reassignment');
  await c.query(`UPDATE tasks SET assignee_id = $1, title = 'gpv task' WHERE id = $2`, [sharer, task]);

  const talkHidden = await call(guest, '/api/agent/conversations', { method: 'POST', body: { agent_employee_id: hiddenAgentEmployee } });
  const talkUnknown = await call(guest, '/api/agent/conversations', { method: 'POST', body: { agent_employee_id: randomUUID() } });
  assert.equal(talkHidden.status, 404);
  assert.deepEqual(talkHidden, talkUnknown);

  const agentsForGuest = await get(guest, '/api/agent-employees');
  assert.equal(agentsForGuest.status, 200);
  const listedAgents = agentsForGuest.body.map((row: any) => row.id).filter((id: string) => [agentEmployee, hiddenAgentEmployee].includes(id));
  assert.deepEqual(listedAgents, [agentEmployee]);
  assert.equal((await get(guest, `/api/agent-employees/${hiddenAgentEmployee}`)).status, 404);
  const agentsForMember = (await get(sharer, '/api/agent-employees')).body.map((row: any) => row.id);
  assert.ok(agentsForMember.includes(hiddenAgentEmployee));
});

test('an agent an owner made a guest cannot message a hidden person: answered like an unknown id', async () => {
  const ctx = { org_id: org, employee_id: agentEmployee, employee_slug: `gpv-agent-${run}`, trust_level: 'standard' } as never;
  const hidden = await sendMessage({ content: 'hi', target: { user_id: stranger } } as never, ctx);
  const unknown = await sendMessage({ content: 'hi', target: { user_id: randomUUID() } } as never, ctx);
  assert.equal(hidden.isError, true);
  assert.deepEqual(hidden, unknown);
});

test('MCP task_update, agent_employee_list/get and idempotent replays follow the rule', async () => {
  const writer = (viewer: string): HumanToolContext => ({ ...mcp(viewer), scopes: ['read:workspace', 'read:tasks', 'write:tasks'] });
  const hidden = await humanTaskUpdate({ task_id: task, patch: { assignee_id: stranger } }, writer(guest));
  const unknown = await humanTaskUpdate({ task_id: task, patch: { assignee_id: randomUUID() } }, writer(guest));
  assert.equal(hidden.isError, true);
  assert.deepEqual(hidden, unknown);

  const agents = parse(await humanAgentEmployeeList({ include_paused: true }, mcp(guest))).map((row: any) => row.id);
  assert.ok(agents.includes(agentEmployee));
  assert.equal(agents.includes(hiddenAgentEmployee), false);
  assert.equal((await humanAgentEmployeeGet({ employee_id: hiddenAgentEmployee }, mcp(guest))).isError, true);
  assert.ok(parse(await humanAgentEmployeeList({ include_paused: true }, mcp(sharer))).some((row: any) => row.id === hiddenAgentEmployee));

  // A result stored while Stella Friend was a member is not repeated to her as a guest.
  const key = `gpv-replay-${run}`;
  const first = await humanTaskUpdate({ task_id: task, patch: { priority: 'p1' }, idempotency_key: key }, writer(friend));
  assert.notEqual(first.isError, true, first.content[0]!.text);
  assert.ok(first.content[0]!.text.includes(task));
  await c.query(`UPDATE org_members SET role = 'guest' WHERE org_id = $1 AND user_id = $2`, [org, friend]);
  try {
    const replayed = parse(await humanTaskUpdate({ task_id: task, patch: { priority: 'p1' }, idempotency_key: key }, writer(friend)));
    assert.equal(replayed.status, 'already_completed');
    assert.equal(JSON.stringify(replayed).includes(sharer), false, 'no stored assignee id is repeated');
  } finally {
    await c.query(`UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [org, friend]);
  }
  // A guest's own replay is a receipt too: what they saw then may be hidden now.
  const guestKey = `gpv-guest-replay-${run}`;
  assert.notEqual((await humanTaskUpdate({ task_id: task, patch: { priority: 'p2' }, idempotency_key: guestKey }, writer(guest))).isError, true);
  assert.equal(parse(await humanTaskUpdate({ task_id: task, patch: { priority: 'p2' }, idempotency_key: guestKey }, writer(guest))).status, 'already_completed');
  // Re-sending the current assignee over MCP writes nothing for it and is not refused.
  const unchanged = await humanTaskUpdate({ task_id: task, patch: { assignee_id: ` ${sharer} ` } }, writer(guest));
  assert.notEqual(unchanged.isError, true, unchanged.content[0]!.text);
  await c.query(`UPDATE tasks SET priority = 'p2' WHERE id = $1`, [task]);
});

test('no membership row: a person gets the guest view; an agent employee keeps the view it had', async () => {
  const loneAgent = randomUUID(), loneEmployee = randomUUID(), lonePerson = randomUUID();
  await c.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, 'gpv lone agent'), ($3, $4, 'gpv lone person')`,
    [loneAgent, `gpv-lone-agent-${run}@test.local`, lonePerson, `gpv-lone-person-${run}@test.local`]);
  await c.query(`INSERT INTO agent_employees (id, org_id, user_id, slug, name, system_prompt, is_byoa, trust_level, runtime_kind, role, created_by)
    VALUES ($1, $2, $3, $4, 'gpv lone agent', 'test', true, 'standard', 'custom_mcp', 'custom', $5)`, [loneEmployee, org, loneAgent, `gpv-lone-${run}`, owner]);
  try {
    assert.equal((await peopleViewer(org, loneAgent)).guest, false, 'an agent employee of the workspace without a membership row');
    assert.equal((await peopleViewer(org, lonePerson)).guest, true, 'a person without a membership row');
    assert.equal((await peopleViewer(org, agentUser)).guest, true, 'an agent whose role is guest');
    assert.equal((await peopleViewer(org, sharer)).guest, false);
  } finally {
    await c.query(`DELETE FROM agent_employees WHERE id = $1`, [loneEmployee]);
    await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[loneAgent, lonePerson]]);
  }
});
