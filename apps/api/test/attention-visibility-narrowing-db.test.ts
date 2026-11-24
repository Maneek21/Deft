/**
 * The Inbox visibility rule (`visibleAttentionCondition`) narrowed to the
 * source types a statement can meet gives exactly the answer of the whole
 * rule, and costs a database backend a few MB instead of ~85 MB.
 *
 * Why: PostgreSQL plans every branch of the rule whatever the row. Planning
 * the whole rule (the approval branch is the review gate) took a backend from
 * 3 MB to 86 MB, which it kept until its connection closed; four pooled
 * connections doing it at once ran a 512 MB database machine out of memory
 * after a few chat messages (release 145 to 149).
 *
 * - Every source type the code writes is in `ATTENTION_SOURCE_TYPES` (the
 *   column is free text), so a new type cannot skip the decision about its
 *   own access rule.
 * - Over a matrix of people (owner, admin, member, guest, removed member),
 *   rooms (private, public, archived, joined or not), approvals (requester,
 *   assigned reviewer, none) and every source type, the narrowed rule shows
 *   exactly the items the whole rule shows: per type, for the types read
 *   first, and through the delivery filter.
 * - Planning the rule for message items stays a few MB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { attentionItems } from '@deft/db/schema';
import { closeDb, db } from '../src/lib/db.js';
import {
  ATTENTION_SOURCE_TYPES,
  ATTENTION_SOURCE_TYPES_WITH_ACCESS_RULE,
  filterVisibleAttentionItems,
  readAttentionWithSourceTypes,
  visibleAttentionCondition,
  writeAttentionWithSourceTypes,
  type AttentionSourceScope,
} from '../src/lib/attention.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
/** In CI the database is there: a failure to reach it, or to read /proc on its Linux image, fails instead of skipping. */
const inCi = process.env.CI === 'true';
const orgId = randomUUID();
const people = {
  owner: randomUUID(), admin: randomUUID(), member: randomUUID(), guest: randomUUID(), removed: randomUUID(),
};
const roles: Record<string, string> = {
  [people.owner]: 'owner', [people.admin]: 'admin', [people.member]: 'member', [people.guest]: 'guest', [people.removed]: 'member',
};
const rooms = {
  priv: randomUUID(), pub: randomUUID(), pubGuest: randomUUID(), archived: randomUUID(), adminOnly: randomUUID(),
};
const messagesByRoom: Record<string, string> = {};
let deletedMessage = '';
const actions: string[] = [];
const deliveries: string[] = [];
/** `${person}|${type}|${source}|${metadata variant}` → item id; variant 0 has empty metadata. */
const itemIds = new Map<string, string>();
let client: pg.Client | undefined;
let seeded = false;

const q = (text: string, values: unknown[] = []) => client!.query(text, values);

/** Every `sourceType` literal the API writes or matches (`sourceType: 'x'`, `sourceType = 'x'`). */
function writtenSourceTypes(): Map<string, string[]> {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const found = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith('.ts')) {
        const text = readFileSync(path, 'utf8');
        for (const match of text.matchAll(/\bsourceType\s*(?::|=(?!=))\s*([^,;\n)}]+)/g)) {
          for (const literal of match[1]!.matchAll(/'([a-z_]+)'/g)) {
            found.set(literal[1]!, [...(found.get(literal[1]!) ?? []), relative(root, path)]);
          }
        }
      }
    }
  };
  walk(root);
  return found;
}

test('every attention source type the code writes is listed, with a decided access rule', () => {
  const written = writtenSourceTypes();
  assert.ok(written.size >= 10, `the scan found the writers (${written.size} types)`);
  const listed = new Set<string>(ATTENTION_SOURCE_TYPES);
  for (const [type, files] of written) {
    assert.ok(listed.has(type),
      `source type '${type}' (${files.join(', ')}) is not in ATTENTION_SOURCE_TYPES (lib/attention.ts): add it, and decide whether it needs an access rule`);
  }
  for (const type of ATTENTION_SOURCE_TYPES_WITH_ACCESS_RULE) assert.ok(listed.has(type), `${type} has a rule but is not listed`);
});

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) {
    if (inCi) throw error;
    unavailable = String(error);
    return;
  }
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Attention narrowing', `attention-narrowing-${orgId}`]);
  seeded = true;
  for (const [name, id] of Object.entries(people)) {
    await q("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,'human',false)", [id, `${id}@example.test`, name]);
    await q('INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), orgId, id, roles[id], id !== people.removed]);
  }
  const roomSetup: Array<[string, string, boolean, string[]]> = [
    [rooms.priv, 'private', false, [people.owner, people.member, people.guest, people.removed]],
    [rooms.pub, 'public', false, [people.owner]],
    [rooms.pubGuest, 'public', false, [people.owner, people.guest]],
    [rooms.archived, 'public', true, [people.member]],
    [rooms.adminOnly, 'private', false, [people.admin]],
  ];
  for (const [id, type, archived, members] of roomSetup) {
    await q('INSERT INTO spaces(id,org_id,name,type,created_by,is_archived) VALUES($1,$2,$3,$4,$5,$6)',
      [id, orgId, `room-${id.slice(0, 8)}`, type, people.owner, archived]);
    for (const user of members) await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), id, user]);
    messagesByRoom[id] = randomUUID();
    await q("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'hello @Defty')",
      [messagesByRoom[id], orgId, id, members[0]]);
  }
  deletedMessage = randomUUID();
  await q("INSERT INTO messages(id,org_id,space_id,user_id,content,is_deleted) VALUES($1,$2,$3,$4,'gone',true)",
    [deletedMessage, orgId, rooms.priv, people.member]);

  // Approvals: the requester reviews; a removed requester's action has an assigned reviewer; one names no room; one is a capture.
  const action = async (requester: string, messageId: string | null, params: Record<string, unknown>, source = 'mention') => {
    const id = randomUUID();
    await q(`INSERT INTO agent_actions(id,org_id,user_id,action,params,approval_tier,approval_status,source,message_id)
      VALUES($1,$2,$3,'create_task',$4,'quick','pending',$5,$6)`, [id, orgId, requester, JSON.stringify(params), source, messageId]);
    actions.push(id);
    return id;
  };
  await action(people.member, messagesByRoom[rooms.priv]!, { title: 'from the private room' });
  await action(people.guest, messagesByRoom[rooms.pubGuest]!, { title: 'from the guest public room' });
  await action(people.member, null, { title: 'no room' });
  const assigned = await action(people.removed, messagesByRoom[rooms.adminOnly]!, { title: 'assigned' });
  await q('INSERT INTO agent_action_approvers(id,org_id,action_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, assigned, people.admin]);
  await action(people.member, null, { title: 'capture', source_user_id: people.member, source_space_id: rooms.priv }, 'defty_capture');

  // Mentions: a live message in the private room, one in the admin room, one whose source is deleted; one delivery per person.
  for (const [room, deleted] of [[rooms.priv, false], [rooms.adminOnly, false], [rooms.pub, true]] as const) {
    const state = randomUUID();
    await q(`INSERT INTO native_reference_states(id,org_id,source_kind,source_id,content_hash,is_deleted)
      VALUES($1,$2,'message',$3,'h',$4)`, [state, orgId, messagesByRoom[room], deleted]);
    for (const recipient of Object.values(people)) {
      const delivery = randomUUID();
      await q(`INSERT INTO native_mention_deliveries(id,org_id,source_state_id,publication_revision,recipient_user_id,actor_user_id)
        VALUES($1,$2,$3,1,$4,$5)`, [delivery, orgId, state, recipient, people.owner]);
      deliveries.push(delivery);
    }
  }

  // Each person gets items of every source type: every source of the ruled types, and for every
  // type a set of legacy-notification metadata (none, a room, a message, a mention delivery).
  const allMessages = [...Object.values(messagesByRoom), deletedMessage];
  const legacy = (person: string): Array<Record<string, unknown>> => [
    {},
    { legacy_notification_id: randomUUID() },
    { legacy_notification_id: randomUUID(), space_id: rooms.priv },
    { legacy_notification_id: randomUUID(), space_id: rooms.adminOnly },
    { legacy_notification_id: randomUUID(), space_id: rooms.pub },
    { legacy_notification_id: randomUUID(), message_id: messagesByRoom[rooms.adminOnly] },
    { legacy_notification_id: randomUUID(), native_mention_delivery_id: deliveries.find((id, at) => at % 5 === Object.values(people).indexOf(person)) },
  ];
  const sourcesOf = (type: string): string[] => {
    if (type === 'message') return [...allMessages, randomUUID()];
    if (type === 'space') return [...Object.values(rooms), randomUUID()];
    if (type === 'agent_action') return [...actions, randomUUID()];
    if (type === 'native_mention') return [...deliveries, randomUUID()];
    return [randomUUID()];
  };
  const rows: unknown[][] = [];
  for (const person of Object.values(people)) {
    for (const type of ATTENTION_SOURCE_TYPES) {
      const sources = sourcesOf(type);
      for (const source of sources) {
        // The first source of each type also gets every legacy-notification variant.
        const variants = source === sources[0] ? legacy(person) : [{}];
        variants.forEach((metadata, variant) => {
          const id = randomUUID();
          itemIds.set(`${person}|${type}|${source}|${variant}`, id);
          rows.push([id, orgId, person, type, source, JSON.stringify(metadata)]);
        });
      }
    }
  }
  for (const row of rows) {
    await q(`INSERT INTO attention_items(id,org_id,user_id,kind,lane,dedupe_key,source_type,source_id,title,metadata)
      VALUES($1,$2,$3,'test','updates',$1,$4,$5,'item',$6::jsonb)`, row);
  }
});

after(async () => {
  try {
    if (seeded && client) {
      for (const table of ['attention_events', 'attention_items', 'native_mention_deliveries', 'native_reference_states',
        'agent_action_approvers', 'agent_actions', 'messages']) {
        await q(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
      }
      await q('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
      for (const table of ['spaces', 'org_members']) await q(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
      await q('DELETE FROM orgs WHERE id=$1', [orgId]);
      await q('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(people)]);
    }
  } finally {
    await client?.end();
    await closeDb();
  }
});

async function visibleIds(person: string, scope: AttentionSourceScope, sourceType?: string): Promise<Set<string>> {
  const rows = await db.select({ id: attentionItems.id }).from(attentionItems).where(and(
    eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, person),
    sourceType ? eq(attentionItems.source_type, sourceType) : undefined,
    visibleAttentionCondition(person, scope),
  ));
  return new Set(rows.map((row) => row.id));
}

async function idsOfType(person: string, sourceType: string): Promise<Set<string>> {
  const { rows } = await q('SELECT id FROM attention_items WHERE org_id=$1 AND user_id=$2 AND source_type=$3', [orgId, person, sourceType]);
  return new Set(rows.map((row: { id: string }) => row.id));
}

const sorted = (ids: Set<string>) => [...ids].sort();

test('the rule narrowed to the types a statement meets shows exactly what the whole rule shows, for every person and type', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const outcomes = new Map<string, { shown: number; hidden: number }>();
  for (const [name, person] of Object.entries(people)) {
    const whole = await visibleIds(person, 'all');
    for (const type of ATTENTION_SOURCE_TYPES) {
      const ofType = await idsOfType(person, type);
      assert.ok(ofType.size > 0, `${name} has ${type} items`);
      const expected = new Set([...ofType].filter((id) => whole.has(id)));
      assert.deepEqual(sorted(await visibleIds(person, [type], type)), sorted(expected), `${name}, ${type}: narrowed to its own type`);
      const tally = outcomes.get(type) ?? { shown: 0, hidden: 0 };
      tally.shown += expected.size;
      tally.hidden += ofType.size - expected.size;
      outcomes.set(type, tally);
    }
    // A list reads its rows' types first, on the same snapshot (routes/attention.ts, the MCP tools).
    const mine = and(eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, person));
    const listed = await readAttentionWithSourceTypes(mine, async (tx, types) => {
      assert.deepEqual([...types].sort(), [...ATTENTION_SOURCE_TYPES].sort(), `${name}: every type read first`);
      return tx.select({ id: attentionItems.id }).from(attentionItems).where(and(mine, visibleAttentionCondition(person, types)));
    });
    assert.deepEqual(sorted(new Set(listed.map((row) => row.id))), sorted(whole), `${name}: the types read first`);
    // Fail closed: a ruled type that was not asked for shows nothing, and nothing the whole rule hides appears.
    const messageOnly = await visibleIds(person, ['message']);
    for (const id of messageOnly) assert.ok(whole.has(id), `${name}: the message-only rule shows nothing the whole rule hides`);
    for (const type of ATTENTION_SOURCE_TYPES_WITH_ACCESS_RULE.filter((ruled) => ruled !== 'message')) {
      for (const id of await idsOfType(person, type)) assert.ok(!messageOnly.has(id), `${name}: a ${type} item is not shown by the message-only rule`);
    }
  }
  // The matrix reaches both outcomes for every type with a rule, and for the legacy check.
  for (const type of ATTENTION_SOURCE_TYPES_WITH_ACCESS_RULE) {
    const tally = outcomes.get(type)!;
    assert.ok(tally.shown > 0 && tally.hidden > 0, `${type}: shown ${tally.shown}, hidden ${tally.hidden}`);
  }
  const unruled = outcomes.get('task')!;
  assert.ok(unruled.shown > 0 && unruled.hidden > 0, `legacy check: shown ${unruled.shown}, hidden ${unruled.hidden}`);
});

test('each access rule shows and hides the items it should, under the whole rule and narrowed (empty metadata)', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const delivery = (state: number, person: string) => deliveries[state * 5 + Object.values(people).indexOf(person)]!;
  /** The item of `person` and `type` from `source` (any source when omitted) with legacy-metadata `variant`. */
  const item = (person: string, type: string, source: string | null, variant = 0) => {
    const found = [...itemIds.entries()].find(([key]) => {
      const [p, ty, src, v] = key.split('|');
      return p === person && ty === type && (source === null || src === source) && v === String(variant);
    });
    assert.ok(found, `fixture ${person} ${type} ${source} ${variant}`);
    return found[1];
  };
  const { owner, member, guest } = people;
  // [label, person, item id, shown]
  const expectations: Array<[string, string, string, boolean]> = [
    ['member, message in their private room', member, item(member, 'message', messagesByRoom[rooms.priv]!), true],
    ['member, message in the admin-only room', member, item(member, 'message', messagesByRoom[rooms.adminOnly]!), false],
    ['member, deleted message', member, item(member, 'message', deletedMessage), false],
    ['guest, message in a public room they joined', guest, item(guest, 'message', messagesByRoom[rooms.pubGuest]!), true],
    ['guest, message in a public room they did not join', guest, item(guest, 'message', messagesByRoom[rooms.pub]!), false],
    ['member, their private room', member, item(member, 'space', rooms.priv), true],
    ['member, a public room they did not join', member, item(member, 'space', rooms.pub), true],
    ['member, the admin-only room', member, item(member, 'space', rooms.adminOnly), false],
    ['guest, a public room they joined', guest, item(guest, 'space', rooms.pubGuest), true],
    ['guest, a public room they did not join', guest, item(guest, 'space', rooms.pub), false],
    ['member, their mention in their private room', member, item(member, 'native_mention', delivery(0, member)), true],
    ['member, their mention in the admin-only room', member, item(member, 'native_mention', delivery(1, member)), false],
    ['member, their mention whose source was deleted', member, item(member, 'native_mention', delivery(2, member)), false],
    ["member, the owner's mention", member, item(member, 'native_mention', delivery(0, owner)), false],
    ['member, the approval they asked for', member, item(member, 'agent_action', actions[0]!), true],
    ["guest, the member's approval", guest, item(guest, 'agent_action', actions[0]!), false],
    // The legacy-notification check, on a type with no rule of its own (variants: see `legacy`).
    ['member, task item, no metadata', member, item(member, 'task', null, 0), true],
    ['member, task item, legacy notice of their private room', member, item(member, 'task', null, 2), true],
    ['member, task item, legacy notice of the admin-only room', member, item(member, 'task', null, 3), false],
    ['member, task item, legacy notice of an admin-only message', member, item(member, 'task', null, 5), false],
    ['guest, task item, legacy notice of a public room they did not join', guest, item(guest, 'task', null, 4), false],
  ];
  for (const [label, person, id, shown] of expectations) {
    const type = [...itemIds.entries()].find(([, value]) => value === id)![0].split('|')[1]!;
    assert.equal((await visibleIds(person, 'all')).has(id), shown, `${label}: ${shown ? 'shown' : 'hidden'} (whole rule)`);
    assert.equal((await visibleIds(person, [type], type)).has(id), shown, `${label}: ${shown ? 'shown' : 'hidden'} (narrowed)`);
  }
});

test('the delivery and list filter (filterVisibleAttentionItems) keeps exactly the items the whole rule shows', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const [name, person] of Object.entries(people)) {
    const whole = await visibleIds(person, 'all');
    const rows = await db.select().from(attentionItems).where(and(eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, person)));
    const kept = await filterVisibleAttentionItems(person, rows);
    assert.deepEqual(sorted(new Set(kept.map((row) => row.id))), sorted(whole), `${name}: filtered`);
    // One type at a time, as delivery calls it for a message's recipients.
    for (const type of ATTENTION_SOURCE_TYPES) {
      const current = await db.select().from(attentionItems).where(and(
        eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, person), eq(attentionItems.source_type, type),
      ));
      const keptOfType = await filterVisibleAttentionItems(person, current);
      assert.deepEqual(sorted(new Set(keptOfType.map((row) => row.id))), sorted(new Set(current.map((row) => row.id).filter((id) => whole.has(id)))),
        `${name}, ${type}: filtered alone`);
    }
  }
});

type Growth = { anon: number; peak: number };

/**
 * How much a fresh backend grows (kB) planning `scope`'s rule: its private
 * memory (`RssAnon`, which the backend keeps after the statement) and its
 * peak resident size (`VmHWM`, which also counts the shared catalog pages a
 * new backend reads). Null when the session cannot read /proc.
 */
async function planningGrowth(scope: AttentionSourceScope): Promise<Growth | null> {
  const backend = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await backend.connect();
  try {
    const read = async (): Promise<Growth | null> => {
      const { rows } = await backend.query(`SELECT substring(s from 'RssAnon:\\s*([0-9]+)')::int AS anon,
        substring(s from 'VmHWM:\\s*([0-9]+)')::int AS peak FROM pg_read_file('/proc/self/status') s`);
      return rows[0]?.anon == null || rows[0]?.peak == null ? null : { anon: rows[0].anon, peak: rows[0].peak };
    };
    let before: Growth | null;
    try { before = await read(); } catch (error) { if (inCi) throw error; return null; }
    if (before == null) { if (inCi) throw new Error('/proc/self/status gave no RssAnon or VmHWM'); return null; }
    const query = db.select({ id: attentionItems.id }).from(attentionItems).where(and(
      eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, people.member), visibleAttentionCondition(people.member, scope),
    )).toSQL();
    await backend.query(`EXPLAIN ${query.sql}`, query.params);
    const afterPlanning = (await read())!;
    return { anon: afterPlanning.anon - before.anon, peak: afterPlanning.peak - before.peak };
  } finally {
    await backend.end();
  }
}

test('planning the rule for message items costs a backend a few MB, not the whole rule', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const message = await planningGrowth(['message']);
  if (message === null) return t.skip('this test database does not let a session read /proc/self/status');
  const whole = (await planningGrowth('all'))!;
  const mb = (kb: number) => Math.round(kb / 1024);
  t.diagnostic(`backend growth planning the rule: message items ${mb(message.anon)} MB private, ${mb(message.peak)} MB peak; `
    + `whole rule ${mb(whole.anon)} MB private, ${mb(whole.peak)} MB peak`);
  assert.ok(message.anon < 16 * 1024, `message-only rule, private memory: ${message.anon} kB`);
  assert.ok(message.peak < 48 * 1024, `message-only rule, peak: ${message.peak} kB`);
  assert.ok(message.anon * 4 < Math.max(whole.anon, whole.peak),
    `message-only ${message.anon} kB is a small part of the whole rule's ${Math.max(whole.anon, whole.peak)} kB`);
});

test('a read takes the item types and the items from one snapshot: a type change committed in between changes nothing', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // A member's own task item (no legacy metadata), turned into a readable space item by a concurrent upsert.
  const [id] = [...itemIds.entries()].find(([key]) => key.startsWith(`${people.member}|task|`) && key.endsWith('|0'))!.slice(1);
  const where = and(eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, people.member), eq(attentionItems.id, id!));
  try {
    const seen = await readAttentionWithSourceTypes(where, async (tx, types) => {
      assert.deepEqual(types, ['task']);
      await q("UPDATE attention_items SET source_type='space', source_id=$2, version=version+1 WHERE id=$1", [id, rooms.priv]);
      return tx.select({ id: attentionItems.id, source_type: attentionItems.source_type }).from(attentionItems)
        .where(and(where, visibleAttentionCondition(people.member, types)));
    });
    assert.deepEqual(seen, [{ id, source_type: 'task' }], 'the item as it was when its type was read');
    assert.ok((await visibleIds(people.member, ['space'], 'space')).has(id!), 'and afterwards, as a space item');
  } finally {
    await q("UPDATE attention_items SET source_type='task', source_id=$2 WHERE id=$1",
      [id, [...itemIds.keys()].find((key) => itemIds.get(key) === id)!.split('|')[2]]);
  }
});

test('a change takes the item types under a row lock: no type change can commit before it does', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const [id] = [...itemIds.entries()].find(([key]) => key.startsWith(`${people.member}|task|`) && key.endsWith('|0'))!.slice(1);
  const where = and(eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, people.member), eq(attentionItems.id, id!));
  const other = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await other.connect();
  try {
    await other.query("SET lock_timeout = '300ms'");
    const changed = await writeAttentionWithSourceTypes(where, async (tx, types) => {
      assert.deepEqual(types, ['task']);
      await assert.rejects(other.query("UPDATE attention_items SET source_type='space' WHERE id=$1", [id]), /lock timeout/,
        'a concurrent type change waits for the lock');
      return tx.update(attentionItems).set({ title: 'changed under lock' })
        .where(and(where, visibleAttentionCondition(people.member, types))).returning({ id: attentionItems.id });
    });
    assert.deepEqual(changed, [{ id }]);
  } finally {
    await other.end();
  }
});
