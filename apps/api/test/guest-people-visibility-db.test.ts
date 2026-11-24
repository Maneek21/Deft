// A guest sees only the people who share at least one space with them, and no
// email address but their own. Owners, admins and members are unchanged. A
// removed member is not found by people search, by anyone. (SFX1 item 1.)
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { memberRoutes } from '../src/routes/members.js';
import { searchRoutes } from '../src/routes/search.js';
import { spaceRoutes } from '../src/routes/spaces.js';
import { groupRoutes } from '../src/routes/groups.js';
import { teamRoutes } from '../src/routes/teams.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import {
  humanMemberGet,
  humanMemberList,
  humanMessagesRecent,
  humanPlatformContext,
  humanResolveMember,
  humanResolveTargets,
  humanTeamGet,
  humanTeamWorkload,
  type HumanToolContext,
} from '../src/lib/mcp-tools/human.js';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
const run = randomUUID().slice(0, 8);
const org = randomUUID();
const owner = randomUUID(), admin = randomUUID(), sharer = randomUUID(), stranger = randomUUID();
const guest = randomUUID(), removed = randomUUID();
const sharedRoom = randomUUID(), privateRoom = randomUUID(), strangerRoom = randomUUID();
const group = randomUUID(), team = randomUUID();
const people: Array<[string, string, string, boolean]> = [
  [owner, 'Olive Owner', 'owner', true],
  [admin, 'Ada Admin', 'admin', true],
  [sharer, 'Sam Sharer', 'member', true],
  [stranger, 'Stella Stranger', 'member', true],
  [guest, 'Gus Guest', 'guest', true],
  [removed, 'Remy Removed', 'member', false],
];
const emailOf = (id: string) => `gpv-${run}-${id}@test.local`;
const nameOf = (id: string) => people.find(([pid]) => pid === id)![1];

before(async () => {
  await c.connect();
  await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Guest People', $2)`, [org, `guest-people-${run}`]);
  for (const [id, name, role, active] of people) {
    await c.query(`INSERT INTO users (id, email, name, kind, password_hash) VALUES ($1, $2, $3, 'human', 'hash')`, [id, emailOf(id), `${name} ${run}`]);
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, $4)`,
      [org, id, role, active],
    );
  }
  // The guest shares one room with the admin and Sam (and the removed member,
  // who must still not appear). Stella and the owner share nothing with them.
  await c.query(
    `INSERT INTO spaces (id, org_id, name, type, created_by) VALUES
      ($1, $4, 'gpv shared', 'private', $5), ($2, $4, 'gpv owner room', 'private', $5), ($3, $4, 'gpv stranger room', 'public', $5)`,
    [sharedRoom, privateRoom, strangerRoom, org, owner],
  );
  for (const [room, user] of [
    [sharedRoom, guest], [sharedRoom, admin], [sharedRoom, sharer], [sharedRoom, removed],
    [privateRoom, owner], [privateRoom, stranger], [privateRoom, sharer],
    [strangerRoom, stranger], [strangerRoom, owner],
  ]) {
    await c.query(`INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [room, user]);
  }
  await c.query(`INSERT INTO user_groups (id, org_id, name, handle, created_by) VALUES ($1, $2, 'gpv group', $3, $4)`, [group, org, `gpv-${run}`, owner]);
  for (const user of [sharer, stranger, owner]) {
    await c.query(`INSERT INTO user_group_members (id, group_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [group, user]);
  }
  await c.query(
    `INSERT INTO teams (id, org_id, name, handle, visibility, lead_user_id, created_by) VALUES ($1, $2, 'gpv team', $3, 'org', $4, $4)`,
    [team, org, `gpv-team-${run}`, stranger],
  );
  await c.query(`INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES (gen_random_uuid()::text, $1, $2, $3, 'gpv hello')`, [org, sharedRoom, sharer]);
  for (const [user, role] of [[stranger, 'lead'], [sharer, 'member']]) {
    await c.query(`INSERT INTO team_members (id, org_id, team_id, user_id, role) VALUES (gen_random_uuid()::text, $1, $2, $3, $4)`, [org, team, user, role]);
  }
});

after(async () => {
  await c.query(`DELETE FROM team_members WHERE team_id = $1`, [team]);
  await c.query(`DELETE FROM teams WHERE id = $1`, [team]);
  await c.query(`DELETE FROM user_group_members WHERE group_id = $1`, [group]);
  await c.query(`DELETE FROM user_groups WHERE id = $1`, [group]);
  await c.query(`DELETE FROM messages WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM space_members WHERE space_id = ANY($1::text[])`, [[sharedRoom, privateRoom, strangerRoom]]);
  await c.query(`DELETE FROM spaces WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM org_members WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [people.map(([id]) => id)]);
  await c.query(`DELETE FROM orgs WHERE id = $1`, [org]);
  await c.end();
});

function app(viewer: string) {
  const role = people.find(([id]) => id === viewer)![2];
  const hono = new Hono();
  hono.use('*', async (ctx, next) => {
    ctx.set('user', { id: viewer, org_id: org, email: emailOf(viewer), sid: 's', role } as never);
    await next();
  });
  hono.route('/api/members', memberRoutes);
  hono.route('/api/search', searchRoutes);
  hono.route('/api/spaces', spaceRoutes);
  hono.route('/api/groups', groupRoutes);
  hono.route('/api/teams', teamRoutes);
  return hono;
}

async function get(viewer: string, path: string) {
  const res = await app(viewer).request(path);
  return { status: res.status, body: await res.json() as any };
}

const mcp = (viewer: string): HumanToolContext => ({
  org_id: org,
  user_id: viewer,
  role: people.find(([id]) => id === viewer)![2] as HumanToolContext['role'],
  scopes: ['read:workspace', 'read:tasks', 'read:messages'],
});
const parse = (result: { content: Array<{ text: string }>; isError?: boolean }) => JSON.parse(result.content[0]!.text);
// A person's id: `user_id` where a row has its own id (team and group members), else `id`.
const personId = (row: { id?: string; user_id?: string }) => row.user_id ?? row.id;
const ids = (rows: Array<{ id?: string; user_id?: string }>) => rows.map(personId).filter((id) => people.some(([pid]) => pid === id)).sort();
const sorted = (...list: string[]) => [...list].sort();

const GUEST_SEES = sorted(guest, admin, sharer);
const MEMBER_SEES = sorted(owner, admin, sharer, stranger, guest);

function assertGuestEmails(rows: Array<{ id?: string; user_id?: string; email?: string | null }>) {
  for (const row of rows) {
    const id = personId(row);
    if (id === guest) assert.equal(row.email, emailOf(guest), 'a guest sees their own email');
    else assert.equal(row.email, null, `no email for ${id}`);
  }
}

test('GET /api/members: a guest sees only people sharing a space, without emails', async () => {
  const res = await get(guest, '/api/members');
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res.body), GUEST_SEES);
  assertGuestEmails(res.body);
});

test('GET /api/members: members and admins are unchanged', async () => {
  for (const viewer of [sharer, admin, owner]) {
    const res = await get(viewer, '/api/members');
    assert.equal(res.status, 200);
    assert.deepEqual(ids(res.body), MEMBER_SEES, viewer);
    for (const row of res.body.filter((r: any) => people.some(([id]) => id === r.id))) assert.equal(row.email, emailOf(row.id));
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
  for (const hidden of [stranger, owner, removed]) {
    assert.equal((await get(guest, `/api/members/${hidden}`)).status, 404, hidden);
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
    assert.deepEqual(ids(await search(viewer, `Remy Removed ${run}`)), [], `removed member hidden from ${viewer}`);
    assert.deepEqual(ids(await search(viewer, emailOf(removed))), [], `removed member email hidden from ${viewer}`);
  }

  assert.deepEqual(ids(await search(guest, `Sam Sharer ${run}`)), [sharer]);
  assert.equal((await search(guest, `Sam Sharer ${run}`))[0]!.email, null);
  assert.deepEqual(ids(await search(guest, `Stella Stranger ${run}`)), []);
  assert.deepEqual(ids(await search(guest, emailOf(sharer))), [], 'a guest cannot search by email');

  assert.deepEqual(ids(await search(sharer, `Stella Stranger ${run}`)), [stranger]);
  const byEmail = await search(owner, emailOf(stranger));
  assert.deepEqual(ids(byEmail), [stranger]);
  assert.equal(byEmail[0]!.email, emailOf(stranger));
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
  assert.deepEqual(ids(teamForGuest.body.members), [sharer]);
  assertGuestEmails(teamForGuest.body.members);
  const teamForMember = await get(sharer, `/api/teams/${team}`);
  assert.equal(teamForMember.body.lead.email, emailOf(stranger));
  assert.deepEqual(ids(teamForMember.body.members), sorted(stranger, sharer));
});

test('MCP member_list, member_get and resolve_member follow the rule', async () => {
  const guestList = parse(await humanMemberList({}, mcp(guest)));
  assert.deepEqual(ids(guestList), GUEST_SEES);
  assertGuestEmails(guestList);
  assert.deepEqual(ids(parse(await humanMemberList({ query: emailOf(sharer) }, mcp(guest)))), [], 'no email matching for a guest');
  const memberList = parse(await humanMemberList({}, mcp(sharer)));
  assert.deepEqual(ids(memberList), MEMBER_SEES);
  assert.equal(memberList.find((m: any) => m.id === stranger).email, emailOf(stranger));

  const got = parse(await humanMemberGet({ user_id: sharer }, mcp(guest)));
  assert.equal(got.id, sharer);
  assert.equal(got.email, null);
  assert.equal((await humanMemberGet({ user_id: stranger }, mcp(guest))).isError, true);
  assert.equal((await humanMemberGet({ email: emailOf(sharer) }, mcp(guest))).isError, true, 'no lookup by email for a guest');
  assert.equal(parse(await humanMemberGet({ email: emailOf(stranger) }, mcp(sharer))).id, stranger);

  const resolvedForGuest = parse(await humanResolveMember({ query: `Stella Stranger ${run}` }, mcp(guest)));
  assert.notEqual(resolvedForGuest.selected?.id, stranger);
  assert.equal(JSON.stringify(resolvedForGuest).includes(stranger), false, 'the stranger is not a candidate');
  const sam = parse(await humanResolveMember({ query: `Sam Sharer ${run}` }, mcp(guest)));
  assert.equal(sam.selected.id, sharer);
  assert.equal(JSON.stringify(sam).includes(emailOf(sharer)), false);
  assert.equal(parse(await humanResolveMember({ query: `Stella Stranger ${run}` }, mcp(sharer))).selected.id, stranger);

  const targets = parse(await humanResolveTargets({ members: [`Stella Stranger ${run}`] }, mcp(guest)));
  assert.equal(JSON.stringify(targets).includes(stranger), false);
});

test('MCP platform_context, team_get and team_workload follow the rule', async () => {
  const context = parse(await humanPlatformContext({}, mcp(guest)));
  assert.deepEqual(ids(context.teammates), GUEST_SEES);
  assertGuestEmails(context.teammates);

  const teamView = parse(await humanTeamGet({ team_id: team }, mcp(guest)));
  assert.deepEqual(ids(teamView.members), [sharer]);
  assertGuestEmails(teamView.members);
  assert.equal(teamView.team.lead_name, null);
  assert.deepEqual(ids(parse(await humanTeamGet({ team_id: team }, mcp(sharer))).members), sorted(stranger, sharer));

  const workload = parse(await humanTeamWorkload({}, mcp(guest)));
  assert.deepEqual(ids(workload.workload), GUEST_SEES);
  assert.deepEqual(ids(parse(await humanTeamWorkload({}, mcp(sharer))).workload), MEMBER_SEES);
});

test('Defty search_members asked by a guest finds only people sharing a space', async () => {
  const forGuest = await executeToolCall('search_members', { query: `Stella Stranger ${run}` }, org, guest);
  assert.equal(forGuest.result.code, 'MEMBER_NOT_FOUND');
  assert.deepEqual(forGuest.result.matches, []);
  const samForGuest = await executeToolCall('search_members', { query: `Sam Sharer ${run}` }, org, guest);
  assert.equal(samForGuest.result.member.id, sharer);
  const forMember = await executeToolCall('search_members', { query: `Stella Stranger ${run}` }, org, sharer);
  assert.equal(forMember.result.member.id, stranger);
});

test('MCP messages_recent shows a guest no author email but their own', async () => {
  const forGuest = parse(await humanMessagesRecent({ space_id: sharedRoom }, mcp(guest)));
  const message = forGuest.messages.find((m: any) => m.user_id === sharer);
  assert.ok(message, 'the guest reads the shared room');
  assert.equal(message.user_email, null);
  const forMember = parse(await humanMessagesRecent({ space_id: sharedRoom }, mcp(sharer)));
  assert.equal(forMember.messages.find((m: any) => m.user_id === sharer).user_email, emailOf(sharer));
});
