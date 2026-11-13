/**
 * Public spaces: members of a workspace can find and join public spaces.
 *
 * Browse lists the caller's org's public, unarchived spaces; join adds the
 * caller to one of them; leave removes the caller. Private spaces, DMs, group
 * DMs, agent conversations, archived spaces and other orgs' spaces are never
 * listed and cannot be joined. Guests and agent users cannot browse or
 * self-join. Reading stays membership-based.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/public-spaces-browse-join-db.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Hono } from 'hono';
import pg from 'pg';
import { setupSocket, getHuddleSpaceAccess, type SocketUser } from '../src/socket.js';

const { io: connectSocket } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const stamp = Date.now();
const ORG = `pubsp-org-${stamp}`;
const ORG_B = `pubsp-org-b-${stamp}`;
const id = (s: string) => `pubsp-${s}-${stamp}`;
const U = {
  owner: id('owner'), admin: id('admin'), member: id('member'), peer: id('peer'),
  guest: id('guest'), agent: id('agent'), system: id('system'), inactive: id('inactive'), outsider: id('outsider'),
};
const S = {
  joined: id('s-joined'), open: id('s-open'), other: id('s-other'), priv: id('s-priv'), dm: id('s-dm'),
  gdm: id('s-gdm'), agentConv: id('s-agentconv'), archived: id('s-archived'), foreign: id('s-foreign'),
};
const MISSING = id('s-missing');
const SECRET = `pubspsecret${stamp}`;
const NOT_A_MEMBER = { error: 'Not a member of this space', code: 'FORBIDDEN' };

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

before(async () => {
  await withClient(async (c) => {
    for (const org of [ORG, ORG_B]) await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)`, [org]);
    const people: Array<[string, string, string, 'human' | 'agent' | 'system', boolean]> = [
      [U.owner, ORG, 'owner', 'human', true], [U.admin, ORG, 'admin', 'human', true],
      [U.member, ORG, 'member', 'human', true], [U.peer, ORG, 'member', 'human', true],
      [U.guest, ORG, 'guest', 'human', true], [U.agent, ORG, 'member', 'agent', true], [U.system, ORG, 'member', 'system', true],
      [U.inactive, ORG, 'member', 'human', false], [U.outsider, ORG_B, 'member', 'human', true],
    ];
    for (const [uid, org, role, kind, active] of people) {
      await c.query(`INSERT INTO users (id, email, name, kind, is_agent) VALUES ($1, $2, $1, $3, $4)`, [uid, `${uid}@test.local`, kind, kind === 'agent']);
      await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, $4)`, [org, uid, role, active]);
    }
    const spaces: Array<[string, string, string, boolean, string[]]> = [
      [S.joined, ORG, 'public', false, [U.member, U.peer]],
      [S.open, ORG, 'public', false, [U.peer, U.inactive, U.outsider]],
      [S.other, ORG, 'public', false, []],
      [S.priv, ORG, 'private', false, [U.peer]],
      [S.dm, ORG, 'dm', false, [U.peer, U.owner]],
      [S.gdm, ORG, 'group_dm', false, [U.peer, U.owner, U.admin]],
      [S.agentConv, ORG, 'agent_conversation', false, [U.peer]],
      [S.archived, ORG, 'public', true, [U.peer]],
      [S.foreign, ORG_B, 'public', false, [U.outsider]],
    ];
    for (const [sid, org, type, archived, members] of spaces) {
      const name = sid === S.open ? `Open Alpha ${stamp}` : sid === S.other ? `Other Beta 5%_x\\y ${stamp}` : sid === S.joined ? `Joined Gamma ${stamp}` : `${SECRET} ${sid}`;
      await c.query(
        `INSERT INTO spaces (id, org_id, name, description, topic, type, is_archived, created_by) VALUES ($1, $2, $3, $4, 'topic', $5, $6, $7)`,
        [sid, org, name, `desc ${sid}`, type, archived, org === ORG ? U.peer : U.outsider],
      );
      for (const m of members) await c.query(`INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`, [sid, m]);
      await c.query(
        `INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES (gen_random_uuid()::text, $1, $2, $3, $4)`,
        [org, sid, org === ORG ? U.peer : U.outsider, `${SECRET} message in ${sid}`],
      );
    }
  });
});

after(async () => {
  await withClient(async (c) => {
    const all = [...Object.values(S)];
    await c.query(`DELETE FROM messages WHERE space_id = ANY($1)`, [all]).catch(() => undefined);
    await c.query(`DELETE FROM space_members WHERE space_id = ANY($1)`, [all]).catch(() => undefined);
    await c.query(`DELETE FROM spaces WHERE id = ANY($1)`, [all]).catch(() => undefined);
    await c.query(`DELETE FROM org_members WHERE org_id = ANY($1)`, [[ORG, ORG_B]]).catch(() => undefined);
    await c.query(`DELETE FROM users WHERE id = ANY($1)`, [Object.values(U)]).catch(() => undefined);
    await c.query(`DELETE FROM orgs WHERE id = ANY($1)`, [[ORG, ORG_B]]).catch(() => undefined);
  });
});

async function call(actor: string, method: string, path: string, opts: { org?: string; route?: 'spaces' | 'messages'; role?: 'owner' | 'member'; body?: unknown } = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    // The session role is never trusted: eligibility must come from the database.
    c.set('user', { id: actor, org_id: opts.org ?? ORG, email: `${actor}@test.local`, sid: `pubsp-sid-${stamp}`, role: opts.role ?? 'member' });
    await next();
  });
  if ((opts.route ?? 'spaces') === 'spaces') app.route('/api/spaces', (await import('../src/routes/spaces.js')).spaceRoutes);
  else app.route('/api/messages', (await import('../src/routes/messages.js')).messageRoutes);
  const res = await app.request(path, opts.body === undefined ? { method } : { method, body: JSON.stringify(opts.body), headers: { 'content-type': 'application/json' } });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text };
}

const browse = (actor: string, qs = '', org?: string, role?: 'owner') => call(actor, 'GET', `/api/spaces/browse${qs}`, { org, role });
const join = (actor: string, space: string, org?: string, role?: 'owner') => call(actor, 'POST', `/api/spaces/${space}/join`, { org, role });
const leave = (actor: string, space: string) => call(actor, 'DELETE', `/api/spaces/${space}/members/me`);
const readMessages = (actor: string, space: string) => call(actor, 'GET', `/api/messages/${space}`, { route: 'messages' });
const memberRows = (space: string, user: string) =>
  withClient(async (c) => Number((await c.query(`SELECT count(*)::int AS n FROM space_members WHERE space_id = $1 AND user_id = $2`, [space, user])).rows[0].n));
const socketUser = (uid: string, org = ORG): SocketUser => ({ id: uid, org_id: org, email: `${uid}@test.local`, sid: `pubsp-sock-${uid}` } as SocketUser);

test('a member browses only the unjoined public spaces of their own org, with counts and search', async () => {
  for (const actor of [U.member, U.admin, U.owner]) {
    const res = await browse(actor);
    assert.equal(res.status, 200, res.text);
    const ids = res.json.spaces.map((s: any) => s.id);
    assert.ok(!res.text.includes(SECRET), `browse leaked a non-public space or a message: ${res.text}`);
    for (const hidden of [S.priv, S.dm, S.gdm, S.agentConv, S.archived, S.foreign]) assert.ok(!ids.includes(hidden), `${hidden} listed`);
    assert.ok(ids.includes(S.open) && ids.includes(S.other), `${actor}: ${res.text}`);
    assert.equal(ids.includes(S.joined), actor !== U.member, 'only a joined space is left out');
  }
  const res = await browse(U.member);
  assert.deepEqual(res.json.spaces.map((s: any) => s.id).filter((x: string) => x.includes(String(stamp))), [S.open, S.other]);
  const open = res.json.spaces.find((s: any) => s.id === S.open);
  assert.deepEqual(Object.keys(open).sort(), ['created_at', 'description', 'id', 'is_member', 'member_count', 'name', 'topic']);
  assert.equal(open.member_count, 1, 'deactivated members and members of other orgs are not counted');
  assert.equal(open.is_member, false);
  assert.equal(res.json.spaces.find((s: any) => s.id === S.other).member_count, 0);

  const withJoined = await browse(U.member, '?include_joined=1');
  assert.deepEqual(withJoined.json.spaces.map((s: any) => s.id).filter((x: string) => x.includes(String(stamp))), [S.joined, S.open, S.other]);
  assert.ok(!withJoined.text.includes(SECRET), withJoined.text);
  const secret = await browse(U.member, `?include_joined=1&q=${SECRET}`);
  assert.deepEqual(secret.json.spaces, [], 'search never reaches non-public spaces');
  const joined = withJoined.json.spaces.find((s: any) => s.id === S.joined);
  assert.equal(joined?.is_member, true, withJoined.text);
  assert.equal(joined.member_count, 2);

  const searched = await browse(U.member, `?q=${encodeURIComponent('alpha')}`);
  assert.deepEqual(searched.json.spaces.map((s: any) => s.id).filter((x: string) => x.includes(String(stamp))), [S.open]);
  const literals: Array<[string, string[]]> = [
    ['%', [S.other]], ['_', [S.other]], ['\\', [S.other]], ['5%_x\\y', [S.other]], ['Alpha_', []], ['5%x', []],
  ];
  for (const [literal, expected] of literals) {
    const wildcard = await browse(U.member, `?q=${encodeURIComponent(literal)}`);
    assert.equal(wildcard.status, 200, wildcard.text);
    assert.deepEqual(wildcard.json.spaces.map((s: any) => s.id).filter((x: string) => x.includes(String(stamp))), expected, `q ${literal} is literal`);
  }
  assert.equal((await browse(U.member, '?limit=1')).json.spaces.length, 1);
  assert.equal((await browse(U.member, '?limit=0')).status, 400);
});

test('guests, agents, deactivated users and other orgs cannot browse or join', async () => {
  const denied: Array<[string, string?, 'owner'?]> = [
    [U.guest], [U.guest, undefined, 'owner'], [U.agent], [U.system], [U.inactive], [U.outsider, ORG],
  ];
  for (const [actor, org, role] of denied) {
    const res = await browse(actor, '', org, role);
    assert.equal(res.status, 403, `${actor} browse: ${res.text}`);
    assert.ok(!res.text.includes(String(stamp)), res.text);
    const j = await join(actor, S.other, org, role);
    assert.equal(j.status, 403, `${actor} join: ${j.text}`);
    assert.deepEqual(j.json, NOT_A_MEMBER);
    assert.equal(await memberRows(S.other, actor), 0);
  }
  // Join adds only the caller, whatever the body says.
  const self = await call(U.admin, 'POST', `/api/spaces/${S.other}/join`, { body: { user_id: U.owner } });
  assert.equal(self.status, 200, self.text);
  assert.equal(await memberRows(S.other, U.owner), 0);
  assert.equal(await memberRows(S.other, U.admin), 1);
  assert.equal((await leave(U.admin, S.other)).status, 200);
  // A member of org B browsing from org B never sees org A spaces.
  const foreign = await browse(U.outsider, '', ORG_B);
  assert.equal(foreign.status, 200, foreign.text);
  assert.ok(foreign.json.spaces.every((s: any) => s.id !== S.open && s.id !== S.other));
});

test('private, DM, group DM, agent conversation, archived, other-org and missing spaces cannot be joined', async () => {
  const baseline = await join(U.member, MISSING);
  assert.equal(baseline.status, 403, baseline.text);
  assert.deepEqual(baseline.json, NOT_A_MEMBER);
  for (const space of [S.priv, S.dm, S.gdm, S.agentConv, S.archived, S.foreign]) {
    const res = await join(U.member, space);
    assert.equal(res.status, 403, `${space}: ${res.text}`);
    assert.deepEqual(res.json, NOT_A_MEMBER);
    assert.equal(await memberRows(space, U.member), 0, `${space} membership written`);
  }
});

test('an unjoined member cannot read; after joining reads work; join is idempotent and emits one event', async () => {
  assert.equal((await readMessages(U.member, S.open)).status, 403);
  assert.equal((await call(U.member, 'GET', `/api/spaces/${S.open}`)).status, 403);
  assert.equal(await getHuddleSpaceAccess(S.open, socketUser(U.member)), undefined);

  const server = createServer();
  const sockets = setupSocket(server, {
    verifyAccess: async (token: string) => {
      const [uid, org] = token.split('|');
      return { ...socketUser(uid!, org || ORG), exp: Math.floor(Date.now() / 1000) + 600 } as any;
    },
    requireMembership: async () => ({ role: 'member' }) as any,
    recordLastSeen: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const open = async (uid: string) => {
    const client = connectSocket(`http://127.0.0.1:${port}`, { auth: { token: uid }, transports: ['websocket'], reconnection: false });
    const events: any[] = [];
    client.on('space:member_joined', (d: unknown) => events.push(d));
    await new Promise<void>((resolve) => client.once('presence:init', () => resolve()));
    return { client, events };
  };
  const peer = await open(U.peer);
  const self = await open(U.member);
  const outsider = await open(U.admin);
  const guest = await open(U.guest);
  const otherOrgSelf = await open(`${U.member}|${ORG_B}`);
  try {
    const roomSize = () => sockets.sockets.adapter.rooms.get(`space:${S.open}`)?.size ?? 0;
    const waitRoom = async (n: number) => {
      const deadline = Date.now() + 5_000;
      while (roomSize() !== n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert.equal(roomSize(), n);
    };
    // Non-members try to subscribe first; the realtime gate refuses them.
    for (const s of [outsider, guest, otherOrgSelf, self]) s.client.emit('space:join', S.open);
    peer.client.emit('space:join', S.open);
    await waitRoom(1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(roomSize(), 1, 'only the existing member is subscribed');

    const first = await join(U.member, S.open);
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.json, { space_id: S.open, already_member: false });
    const second = await join(U.member, S.open);
    assert.equal(second.status, 200, second.text);
    assert.deepEqual(second.json, { space_id: S.open, already_member: true });
    assert.equal(await memberRows(S.open, U.member), 1);

    const until = Date.now() + 5_000;
    while ((peer.events.length < 1 || self.events.length < 1) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(peer.events, [{ space_id: S.open, user_id: U.member }]);
    assert.deepEqual(self.events, [{ space_id: S.open, user_id: U.member }]);
    assert.deepEqual(outsider.events, [], 'a non-member of the space receives no join event');
    assert.deepEqual(guest.events, [], 'a guest receives no join event');
    assert.deepEqual(otherOrgSelf.events, [], 'the joiner session in another org receives no join event');

    const read = await readMessages(U.member, S.open);
    assert.equal(read.status, 200, read.text);
    assert.equal((await call(U.member, 'GET', `/api/spaces/${S.open}`)).status, 200);
    assert.ok(await getHuddleSpaceAccess(S.open, socketUser(U.member)), 'socket space:join gate admits the joined member');
    const listed = await call(U.member, 'GET', '/api/spaces');
    assert.ok(listed.json.some((s: any) => s.id === S.open), 'joined space appears in the member space list');
    assert.ok(!(await browse(U.member)).json.spaces.some((s: any) => s.id === S.open), 'joined space leaves the unjoined browse list');

    // A subscribed member who leaves is removed from the room and gets no later events.
    self.client.emit('space:join', S.open);
    await waitRoom(2);
    assert.equal((await leave(U.member, S.open)).status, 200);
    await waitRoom(1);
    assert.equal((await join(U.owner, S.open)).status, 200);
    const later = Date.now() + 5_000;
    while (peer.events.length < 2 && Date.now() < later) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(peer.events.at(-1), { space_id: S.open, user_id: U.owner });
    assert.equal(self.events.length, 1, 'a member who left receives no later join event');
    assert.equal((await readMessages(U.member, S.open)).status, 403);
  } finally {
    for (const s of [peer, self, outsider, guest, otherOrgSelf]) s.client.close();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  }
});

test('leave works for public and private spaces; a second leave changes nothing', async () => {
  const before = await join(U.admin, S.other);
  assert.equal(before.status, 200, before.text);
  const left = await leave(U.admin, S.other);
  assert.equal(left.status, 200, left.text);
  assert.equal(await memberRows(S.other, U.admin), 0);
  assert.equal((await readMessages(U.admin, S.other)).status, 403);
  assert.equal(await getHuddleSpaceAccess(S.other, socketUser(U.admin)), undefined, 'leave closes the realtime join gate');
  const again = await leave(U.admin, S.other);
  assert.notEqual(again.status, 200, again.text);
  assert.equal(await memberRows(S.other, U.admin), 0);
  assert.ok((await browse(U.admin)).json.spaces.some((s: any) => s.id === S.other), 'an empty public space stays findable');

  const privLeft = await leave(U.peer, S.priv);
  assert.equal(privLeft.status, 200, privLeft.text);
  assert.equal(await memberRows(S.priv, U.peer), 0);
});
