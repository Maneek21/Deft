/**
 * Guests see only the spaces they are members of, on every surface: the
 * personal MCP tools, team context, the assistant's tools and room resolver,
 * the reader audience helpers, native mention sources and attention items.
 * Owners, admins and members keep their current results; another workspace's
 * public space is invisible to everyone outside it. The role is read from the
 * database, never from the caller's context.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/guest-space-visibility-db.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { closeDb, db } from '../src/lib/db.js';
import {
  humanFetch, humanMessagePost, humanMessagesRecent, humanMessagesSearch, humanResolveSpace, humanSearch,
  humanSpaceGet, humanSpaceList, humanThreadFetch, type HumanToolContext,
} from '../src/lib/mcp-tools/human.js';
import { getTeamContext } from '../src/lib/mcp-tools/team-context.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { resolveReadableRoom } from '../src/lib/retrieve-context.js';
import { currentUserSpaceAuthoritySql } from '../src/lib/agent-channel-authority.js';
import { nativeSourceAccessSql } from '../src/lib/native-mention-visibility.js';
import { filterVisibleAttentionItems } from '../src/lib/attention.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
// Fixed ids and timestamps so a member's results can be compared byte for byte across runs.
const ORG = 'gvis-org-a';
const ORG_B = 'gvis-org-b';
const U = { owner: 'gvis-owner', member: 'gvis-member', guest: 'gvis-guest', outsider: 'gvis-outsider' };
const S = { pub: 'gvis-s-pub', joined: 'gvis-s-joined', priv: 'gvis-s-priv', foreign: 'gvis-s-foreign' };
const M = { pub: 'gvis-m-pub', pubReply: 'gvis-m-pub-reply', joined: 'gvis-m-joined', priv: 'gvis-m-priv', foreign: 'gvis-m-foreign' };
const TEAM = 'gvis-team';
const TOKEN = 'gvistoken';
const AT = '2026-11-01T10:00:00.000Z';
const SINCE = '2026-10-01T00:00:00.000Z';
const NAMES: Record<string, string> = {
  [S.pub]: `${TOKEN} Pubroom`, [S.joined]: `${TOKEN} Joinedroom`, [S.priv]: `${TOKEN} Privroom`, [S.foreign]: `${TOKEN} Foreignroom`,
};
const ALL_SCOPES = ['read:messages', 'write:messages', 'read:workspace', 'read:wiki'];

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function cleanup(c: pg.Client) {
  await c.query(`DELETE FROM attention_items WHERE org_id = ANY($1)`, [[ORG, ORG_B]]).catch(() => undefined);
  await c.query(`DELETE FROM team_resources WHERE team_id = $1`, [TEAM]).catch(() => undefined);
  await c.query(`DELETE FROM teams WHERE id = $1`, [TEAM]).catch(() => undefined);
  await c.query(`DELETE FROM messages WHERE org_id = ANY($1)`, [[ORG, ORG_B]]);
  await c.query(`DELETE FROM space_members WHERE space_id = ANY($1)`, [Object.values(S)]);
  await c.query(`DELETE FROM spaces WHERE org_id = ANY($1)`, [[ORG, ORG_B]]);
  await c.query(`DELETE FROM org_members WHERE org_id = ANY($1)`, [[ORG, ORG_B]]);
  await c.query(`DELETE FROM users WHERE id = ANY($1)`, [Object.values(U)]);
  await c.query(`DELETE FROM orgs WHERE id = ANY($1)`, [[ORG, ORG_B]]);
}

before(async () => {
  await withClient(async (c) => {
    await cleanup(c);
    for (const org of [ORG, ORG_B]) await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)`, [org]);
    const people: Array<[string, string, string]> = [
      [U.owner, ORG, 'owner'], [U.member, ORG, 'member'], [U.guest, ORG, 'guest'], [U.outsider, ORG_B, 'member'],
    ];
    for (const [uid, org, role] of people) {
      await c.query(`INSERT INTO users (id, email, name, kind, created_at, updated_at) VALUES ($1, $2, $1, 'human', $3, $3)`, [uid, `${uid}@test.local`, AT]);
      await c.query(`INSERT INTO org_members (id, org_id, user_id, role, created_at, updated_at, joined_at) VALUES ($1, $2, $3, $4, $5, $5, $5)`, [`om-${uid}`, org, uid, role, AT]);
    }
    const spaces: Array<[string, string, string, string[], string]> = [
      [S.pub, ORG, 'public', [U.owner], M.pub],
      [S.joined, ORG, 'public', [U.guest, U.member], M.joined],
      [S.priv, ORG, 'private', [U.owner], M.priv],
      [S.foreign, ORG_B, 'public', [U.outsider], M.foreign],
    ];
    // Distinct message times so every ordered listing is deterministic.
    let minute = 0;
    const msgAt = () => `2026-11-01T10:${String(++minute).padStart(2, '0')}:00.000Z`;
    for (const [sid, org, type, members, mid] of spaces) {
      const author = org === ORG ? members[0]! : U.outsider;
      await c.query(
        `INSERT INTO spaces (id, org_id, name, description, topic, type, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, 'topic', $5, $6, $7, $7)`,
        [sid, org, NAMES[sid], `${TOKEN} desc ${sid}`, type, author, AT],
      );
      for (const m of members) await c.query(`INSERT INTO space_members (id, space_id, user_id, joined_at) VALUES ($1, $2, $3, $4)`, [`sm-${sid}-${m}`, sid, m, AT]);
      await c.query(
        `INSERT INTO messages (id, org_id, space_id, user_id, content, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [mid, org, sid, author, `${TOKEN} message ${mid} for gvis-guest gvis-member`, msgAt()],
      );
    }
    await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content, parent_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [M.pubReply, ORG, S.pub, U.owner, `${TOKEN} reply ${M.pubReply}`, M.pub, msgAt()],
    );
    await c.query(
      `INSERT INTO teams (id, org_id, name, handle, visibility, created_at, updated_at) VALUES ($1, $2, 'Gvis Team', 'gvis-team', 'org', $3, $3)`,
      [TEAM, ORG, AT],
    );
    for (const sid of [S.pub, S.joined]) {
      await c.query(
        `INSERT INTO team_resources (id, org_id, team_id, resource_type, resource_id, label, created_at) VALUES ($1, $2, $3, 'space', $4, $5, $6)`,
        [`tr-${sid}`, ORG, TEAM, sid, `label ${sid}`, AT],
      );
    }
  });
});

after(async () => {
  await withClient(cleanup).catch(() => undefined);
  await closeDb();
});

// The context role is deliberately 'member' for everyone: visibility must come from the database.
const ctx = (user: string, org = ORG): HumanToolContext => ({ org_id: org, user_id: user, role: 'member', scopes: ALL_SCOPES, principal_kind: 'human' });
const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');

/** Every read surface for one viewer, as text. */
async function readAll(user: string, org = ORG): Promise<Record<string, string>> {
  const c = ctx(user, org);
  const out: Record<string, string> = {};
  out.space_list = text(await humanSpaceList({}, c));
  out.space_list_query = text(await humanSpaceList({ query: TOKEN }, c));
  out.resolve_space_pub = text(await humanResolveSpace({ query: NAMES[S.pub] }, c));
  out.space_get_pub = text(await humanSpaceGet({ space_id: S.pub }, c));
  out.space_get_joined = text(await humanSpaceGet({ space_id: S.joined }, c));
  out.messages_recent_all = text(await humanMessagesRecent({ since: SINCE }, c));
  out.messages_recent_pub_id = text(await humanMessagesRecent({ space_id: S.pub, since: SINCE }, c));
  out.messages_recent_pub_name = text(await humanMessagesRecent({ space_name: NAMES[S.pub], since: SINCE }, c));
  out.messages_search = text(await humanMessagesSearch({ query: TOKEN }, c));
  out.search = text(await humanSearch({ query: TOKEN }, c));
  out.thread_fetch_pub = text(await humanThreadFetch({ parent_message_id: M.pub }, c));
  out.fetch_pub = text(await humanFetch({ id: `message:${M.pub}` }, c));
  out.fetch_joined = text(await humanFetch({ id: `message:${M.joined}` }, c));
  out.team_context = JSON.stringify(await getTeamContext({ org_id: org, user_id: user, role: 'member', can_read_messages: true }, { team_id: TEAM }));
  out.assistant_list_spaces = JSON.stringify((await executeToolCall('list_spaces', {}, org, user)).result);
  out.assistant_search_messages = JSON.stringify((await executeToolCall('search_messages', { query: TOKEN }, org, user)).result);
  out.assistant_search_pub_room = JSON.stringify((await executeToolCall('search_messages', { query: TOKEN, space_name: NAMES[S.pub] }, org, user)).result);
  out.room_resolver_pub = JSON.stringify(await resolveReadableRoom({ orgId: org, userId: user, name: NAMES[S.pub], includePublic: true }));
  for (const sid of Object.values(S)) {
    const rows: any = await db.execute(sql`SELECT ${currentUserSpaceAuthoritySql(sql`${org}`, sql`${user}`, sql`${sid}`)} AS ok`);
    out[`reader_authority_${sid}`] = String((rows.rows ?? rows)[0].ok);
  }
  for (const mid of Object.values(M)) {
    const rows: any = await db.execute(sql`SELECT ${nativeSourceAccessSql(user, sql`'message'`, sql`${mid}`, sql`${org}`)} AS ok`);
    out[`native_source_${mid}`] = String((rows.rows ?? rows)[0].ok);
  }
  return out;
}

const PUB_MARKERS = [S.pub, M.pub, M.pubReply, NAMES[S.pub]!];
// These surfaces are asked for the room by name, so the name may be echoed back in a "not found" answer.
const ASKED_BY_NAME = new Set(['resolve_space_pub', 'messages_recent_pub_name', 'assistant_search_pub_room', 'room_resolver_pub']);
const contains = (s: string, markers: string[], surface = '') =>
  markers.filter((m) => s.includes(m) && !(ASKED_BY_NAME.has(surface) && Object.values(NAMES).includes(m)));

test('a guest sees nothing of a public space they have not joined, on any surface', async () => {
  const out = await readAll(U.guest);
  for (const [surface, value] of Object.entries(out)) {
    if (surface.startsWith('reader_authority_') || surface.startsWith('native_source_')) continue;
    assert.deepEqual(contains(value, PUB_MARKERS.filter((m) => !(surface === 'team_context' && m === S.pub)), surface), [], `${surface} shows the unjoined public space: ${value}`);
    assert.deepEqual(contains(value, [NAMES[S.foreign]!, M.foreign, S.foreign], surface), [], `${surface} shows another workspace's space`);
    assert.ok(!value.includes(M.priv), `${surface} shows a private space`);
  }
  // Team context keeps the linked id but marks it restricted, as for any space the viewer cannot read.
  const team = JSON.parse(out.team_context!);
  const pubResource = team.resources.find((r: any) => r.resource_id === S.pub);
  assert.equal(pubResource.access, 'restricted');
  assert.equal(pubResource.metadata?.name, undefined);
  assert.equal(out[`reader_authority_${S.pub}`], 'false');
  assert.equal(out[`reader_authority_${S.foreign}`], 'false');
  assert.equal(out[`native_source_${M.pub}`], 'false');
  assert.equal(out[`native_source_${M.pubReply}`], 'false');
});

test('a guest still sees the spaces they are a member of', async () => {
  const out = await readAll(U.guest);
  assert.ok(out.space_list!.includes(S.joined));
  assert.ok(out.space_get_joined!.includes(NAMES[S.joined]!));
  assert.ok(out.messages_recent_all!.includes(M.joined));
  assert.ok(out.messages_search!.includes(M.joined));
  assert.ok(out.search!.includes(M.joined));
  assert.ok(out.fetch_joined!.includes(M.joined));
  assert.ok(out.assistant_list_spaces!.includes(S.joined));
  assert.ok(out.assistant_search_messages!.includes(M.joined));
  const team = JSON.parse(out.team_context!);
  assert.equal(team.resources.find((r: any) => r.resource_id === S.joined).access, 'visible');
  assert.equal(out[`reader_authority_${S.joined}`], 'true');
  assert.equal(out[`native_source_${M.joined}`], 'true');
});

test('a guest cannot post into a public space they have not joined, and learns only "not found"', async () => {
  const res = await humanMessagePost({ space_id: S.pub, content: `${TOKEN} guest post` }, ctx(U.guest));
  assert.equal(res.isError, true);
  assert.match(text(res), /not found or not visible/);
  const n = await withClient(async (c) => (await c.query(`SELECT count(*)::int AS n FROM messages WHERE space_id = $1 AND user_id = $2`, [S.pub, U.guest])).rows[0].n);
  assert.equal(n, 0);
});

test('attention items from an unjoined public space are hidden from a guest, kept for a member', async () => {
  const rows = await withClient(async (c) => {
    const insert = async (id: string, user: string, sourceType: string, sourceId: string) => (await c.query(
      `INSERT INTO attention_items (id, org_id, user_id, kind, lane, source_type, source_id, title, dedupe_key)
       VALUES ($1, $2, $3, 'mention', 'fyi', $4, $5, 'gvis', $1) RETURNING *`, [id, ORG, user, sourceType, sourceId])).rows[0];
    return {
      guest: [await insert('gvis-att-g-m', U.guest, 'message', M.pub), await insert('gvis-att-g-s', U.guest, 'space', S.pub), await insert('gvis-att-g-j', U.guest, 'space', S.joined)],
      member: [await insert('gvis-att-m-m', U.member, 'message', M.pub), await insert('gvis-att-m-s', U.member, 'space', S.pub)],
    };
  });
  const guestVisible = await filterVisibleAttentionItems(U.guest, rows.guest as any);
  assert.deepEqual(guestVisible.map((r) => r.id), ['gvis-att-g-j']);
  const memberVisible = await filterVisibleAttentionItems(U.member, rows.member as any);
  assert.deepEqual(memberVisible.map((r) => r.id), ['gvis-att-m-m', 'gvis-att-m-s']);
});

test('owners and members keep seeing joined and unjoined public spaces; other workspaces stay hidden', async () => {
  const snapshot: Record<string, Record<string, string>> = {};
  for (const user of [U.owner, U.member]) {
    snapshot[user] = await readAll(user);
  }
  snapshot[U.outsider] = await readAll(U.outsider, ORG_B);
  // Byte-for-byte comparison across a base run and a change run.
  if (process.env.GVIS_SNAPSHOT_OUT) writeFileSync(process.env.GVIS_SNAPSHOT_OUT, JSON.stringify(snapshot, null, 2));
  for (const user of [U.owner, U.member]) {
    const out = snapshot[user]!;
    for (const [surface, value] of Object.entries(out)) {
      if (surface.startsWith('reader_authority_') || surface.startsWith('native_source_')) continue;
      assert.deepEqual(contains(value, [NAMES[S.foreign]!, M.foreign, S.foreign], surface), [], `${surface} shows another workspace's space`);
    }
    assert.ok(out.space_list!.includes(S.pub) && out.space_list!.includes(S.joined), out.space_list);
    assert.ok(out.messages_search!.includes(M.pub), out.messages_search);
    assert.ok(out.thread_fetch_pub!.includes(M.pubReply), out.thread_fetch_pub);
    assert.ok(out.assistant_list_spaces!.includes(S.pub));
    assert.equal(out[`reader_authority_${S.pub}`], 'true');
    assert.equal(out[`native_source_${M.pub}`], 'true');
  }
  for (const [surface, value] of Object.entries(snapshot[U.outsider]!)) {
    if (surface.startsWith('reader_authority_') || surface.startsWith('native_source_')) continue;
    assert.deepEqual(contains(value, [S.pub, S.joined, M.pub, M.joined, NAMES[S.pub]!, NAMES[S.joined]!], surface), [], `${surface} shows org A spaces to org B`);
  }
  for (const sid of [S.pub, S.joined, S.priv]) assert.equal(snapshot[U.outsider]![`reader_authority_${sid}`], 'false');
  for (const mid of [M.pub, M.joined]) assert.equal(snapshot[U.outsider]![`native_source_${mid}`], 'false');
});
