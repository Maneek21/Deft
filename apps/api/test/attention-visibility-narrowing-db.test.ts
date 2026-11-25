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
 * - The review gate (an approval item's rule, and the approve and reject
 *   routes') composed to plan each check once (release 151) answers exactly
 *   as the composition it replaced, for every person, role and approval:
 *   pending, decided and expired; requesters, assignees who do and do not
 *   pass the checks, non-reviewers; module writes, employee, capture and plan
 *   actions; another workspace. Planning it costs about a third of before.
 * - The gate narrowed to the kinds of action a statement meets (release 152:
 *   no outside agent's action, no capture) answers as the whole gate on the
 *   actions it covers and false on the others; the Inbox rule narrowed by
 *   the entries a read adds, a room's pending approvals (against release
 *   151's statement, every role, room and approval state) and
 *   viewerReviewAuthority answer as before.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { agentActions, attentionItems } from '@deft/db/schema';
import { closeDb, db } from '../src/lib/db.js';
import {
  captureActionSql, currentRoleReviewableActionSql, employeeActionSql, reviewableActionSql, reviewsActionSql, type ReviewGateScope,
} from '../src/lib/agent-action-review-gate.js';
import { actionReviewAssignmentSql } from '../src/lib/agent-action-requester.js';
import { visibleCaptureActionSql } from '../src/lib/agent-action-visibility.js';
import { moduleRoleAudienceSql, sourceMessageRoomSql, visibleAgentActionSourceSql } from '../src/lib/module-action-visibility.js';
import { nativeNotificationAccessSql } from '../src/lib/native-mention-visibility.js';
import {
  ATTENTION_SOURCE_TYPES,
  ATTENTION_SOURCE_TYPES_WITH_ACCESS_RULE,
  filterVisibleAttentionItems,
  lockedAttentionIdsSql,
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
const actionByTitle = new Map<string, string>();
const plans: string[] = [];
const employeeUser = randomUUID();
const employeeId = randomUUID();
const otherOrgId = randomUUID();
const otherEmployeeUser = randomUUID();
const otherEmployeeId = randomUUID();
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

test('the locked ids of a change are one statement parameter, however many there are', () => {
  const ids = Array.from({ length: 70_000 }, (_, at) => `item-${at}`);
  const query = db.select({ id: attentionItems.id }).from(attentionItems).where(lockedAttentionIdsSql(ids)).toSQL();
  assert.equal(query.params.length, 1, 'one parameter (a statement may have at most 65,535)');
  assert.deepEqual(query.params[0], ids);
});

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
  type ActionShape = {
    status?: string; source?: string | null; action?: string; employee?: string | null; event?: string | null;
    plan?: string | null; conversation?: string | null; org?: string;
  };
  const action = async (requester: string, messageId: string | null, params: Record<string, unknown>, source = 'mention', shape: ActionShape = {}) => {
    const id = randomUUID();
    await q(`INSERT INTO agent_actions(id,org_id,user_id,action,params,approval_tier,approval_status,source,message_id,
        agent_employee_id,channel_event_id,plan_id,conversation_id)
      VALUES($1,$2,$3,$7,$4,'quick',$8,$5,$6,$9,$10,$11,$12)`, [id, shape.org ?? orgId, requester, JSON.stringify(params), shape.source === undefined ? source : shape.source, messageId,
      shape.action ?? 'create_task', shape.status ?? 'pending', shape.employee ?? null, shape.event ?? null, shape.plan ?? null, shape.conversation ?? null]);
    actions.push(id);
    actionByTitle.set(String(params.title), id);
    return id;
  };
  const assign = (actionId: string, user: string, decision = 'pending', org = orgId) => q(
    'INSERT INTO agent_action_approvers(id,org_id,action_id,user_id,decision) VALUES($1,$2,$3,$4,$5)', [randomUUID(), org, actionId, user, decision]);
  await action(people.member, messagesByRoom[rooms.priv]!, { title: 'from the private room' });
  await action(people.guest, messagesByRoom[rooms.pubGuest]!, { title: 'from the guest public room' });
  await action(people.member, null, { title: 'no room' });
  const assigned = await action(people.removed, messagesByRoom[rooms.adminOnly]!, { title: 'assigned' });
  await assign(assigned, people.admin);
  await action(people.member, null, { title: 'capture', source_user_id: people.member, source_space_id: rooms.priv }, 'defty_capture');

  // The review gate's cases (`reviewGateSql`): decided and expired approvals; the requester alone; an assignment
  // naming someone who is not a reviewer, or a reviewer who fails the room check; a module write; employee
  // actions (a cited message, a channel event, no source); plan steps; a capture from a room its requester
  // cannot read; an action of another workspace.
  for (const status of ['approved', 'rejected', 'expired']) {
    await action(people.member, messagesByRoom[rooms.priv]!, { title: status }, 'mention', { status });
  }
  await action(people.removed, null, { title: 'departed requester, no room' });
  await assign(await action(people.removed, messagesByRoom[rooms.priv]!, { title: 'assigned to a non-reviewer' }), people.member);
  await assign(await action(people.removed, messagesByRoom[rooms.adminOnly]!, { title: 'assignee outside the room' }), people.owner);
  await assign(await action(people.removed, null, { title: 'departed requester, assigned to the admin' }), people.admin, 'rejected');
  await assign(await action(people.member, null, { title: 'requester assigned, decided' }), people.member, 'approved');
  await assign(await action(people.member, null, { title: 'an admin assigned, the requester reviews' }), people.admin);
  const mixed = await action(people.member, null, { title: 'requester and an admin assigned' });
  await assign(mixed, people.member);
  await assign(mixed, people.admin);
  const departedMixed = await action(people.removed, null, { title: 'departed requester, owner and member assigned' });
  await assign(departedMixed, people.owner);
  await assign(departedMixed, people.member);
  // An assignment row of another workspace counts for nobody.
  await assign(await action(people.removed, null, { title: 'departed requester, assignment of another workspace' }), people.admin, 'pending', otherOrgId);
  await action(people.guest, null, { title: 'module write by a guest' }, 'mention', { action: 'module_record_create' });
  await action(people.member, null, { title: 'module write by a member' }, 'mention', { action: 'module_record_create' });
  await q("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,'Employee','agent',true)", [employeeUser, `${employeeUser}@example.test`]);
  await q("INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'member')", [randomUUID(), orgId, employeeUser]);
  await q(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,trust_level,is_active,is_byoa,runtime_kind,created_by)
    VALUES($1,$2,$3,'Employee',$4,'custom','Test.','conservative',true,true,'custom_mcp',$5)`, [employeeId, orgId, employeeUser, `employee-${employeeId}`, people.owner]);
  await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), rooms.priv, employeeUser]);
  const channelEvent = randomUUID();
  await q(`INSERT INTO agent_channel_events(id,org_id,agent_employee_id,kind,source_kind,source_id,space_id,idempotency_key)
    VALUES($1,$2,$3,'message.created','message',$4,$5,$1)`, [channelEvent, orgId, employeeId, messagesByRoom[rooms.priv], rooms.priv]);
  await action(people.member, messagesByRoom[rooms.priv]!, { title: 'employee, cited message' }, 'mcp', { employee: employeeId });
  await action(people.member, messagesByRoom[rooms.adminOnly]!, { title: 'employee, message in the admin room' }, 'mcp', { employee: employeeId });
  await action(people.member, null, { title: 'employee, channel event' }, 'mcp', { employee: employeeId, event: channelEvent });
  await action(people.member, null, { title: 'employee, no source' }, 'mcp', { employee: employeeId });
  await action(people.removed, null, { title: 'employee, no source, departed requester' }, 'mcp', { employee: employeeId });
  // The canonical Defty envelope is a Defty action: its rooms decide, not an employee's source rule.
  const { ensureDeftyEmployee } = await import('../src/lib/ensure-defty-membership.js');
  const deftyEmployee = (await ensureDeftyEmployee(orgId)).employeeId;
  await action(people.member, messagesByRoom[rooms.priv]!, { title: 'Defty envelope, private room' }, 'mention', { employee: deftyEmployee });
  await action(people.member, messagesByRoom[rooms.adminOnly]!, { title: 'Defty envelope, admin room' }, 'mention', { employee: deftyEmployee });
  for (const room of [rooms.priv, rooms.adminOnly]) {
    const plan = randomUUID();
    plans.push(plan);
    await q(`INSERT INTO agent_plans(id,org_id,user_id,conversation_id,title,steps,status,current_step,context)
      VALUES($1,$2,$3,$4,'plan','[]','executing',0,'{}')`, [plan, orgId, people.member, room]);
    await action(people.member, null, { title: `plan step, ${room === rooms.priv ? 'private' : 'admin'} room` }, 'mention', { plan, conversation: room });
  }
  await action(people.member, null, { title: 'capture from the admin room', source_user_id: people.member, source_space_id: rooms.adminOnly }, 'defty_capture');
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [otherOrgId, 'Another workspace', `attention-narrowing-${otherOrgId}`]);
  await action(people.member, null, { title: 'another workspace' }, 'mention', { org: otherOrgId });
  // A pending approval in every kind of room, for a room's pending-approvals poll (release 152): the
  // public room has only Defty actions and an employee's in a room of its own kind mix; the archived room
  // only Defty; the guest's public room a module write by the guest.
  await action(people.owner, messagesByRoom[rooms.pub]!, { title: 'Defty, public room' });
  await action(people.member, messagesByRoom[rooms.archived]!, { title: 'Defty, archived room' });
  await action(people.guest, messagesByRoom[rooms.pubGuest]!, { title: 'module write by a guest, in a room' }, 'mention', { action: 'module_record_create' });
  await action(people.owner, messagesByRoom[rooms.pubGuest]!, { title: 'employee, guest public room' }, 'mcp', { employee: employeeId });
  // Kinds at the edges of the review gate's scope (release 152): a capture that carries an employee, an
  // action with no source, an employee of another workspace on this workspace's action.
  await action(people.member, null, { title: 'capture with an employee', source_user_id: people.member, source_space_id: rooms.priv },
    'defty_capture', { employee: employeeId });
  await action(people.member, messagesByRoom[rooms.priv]!, { title: 'no source' }, 'mention', { source: null });
  await q("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,'Other employee','agent',true)", [otherEmployeeUser, `${otherEmployeeUser}@example.test`]);
  await q(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,trust_level,is_active,is_byoa,runtime_kind,created_by)
    VALUES($1,$2,$3,'Other employee',$4,'custom','Test.','conservative',true,true,'custom_mcp',$5)`, [otherEmployeeId, otherOrgId, otherEmployeeUser, `other-${otherEmployeeId}`, people.owner]);
  await action(people.member, messagesByRoom[rooms.priv]!, { title: 'employee of another workspace' }, 'mcp', { employee: otherEmployeeId });

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
      await q('DELETE FROM agent_actions WHERE org_id=$1', [otherOrgId]);
      await q('DELETE FROM agent_actions WHERE agent_employee_id=$1', [otherEmployeeId]);
      await q('DELETE FROM agent_employees WHERE org_id=$1', [otherOrgId]);
      for (const table of ['attention_events', 'attention_items', 'native_mention_deliveries', 'native_reference_states',
        'agent_action_approvers', 'agent_actions', 'agent_channel_events', 'agent_plans', 'agent_employees', 'messages']) {
        await q(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
      }
      await q('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
      for (const table of ['spaces', 'org_members']) await q(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
      await q('DELETE FROM orgs WHERE id=ANY($1::text[])', [[orgId, otherOrgId]]);
      await q('DELETE FROM users WHERE id=ANY($1::text[])', [[...Object.values(people), employeeUser, otherEmployeeUser]]);
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
      assert.deepEqual([...types.types].sort(), [...ATTENTION_SOURCE_TYPES].sort(), `${name}: every type read first`);
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

/**
 * The review gates as they were composed before release 151 (`reviewGateSql`), from the pieces that
 * remain in use: the user's own checks, then `actionReviewAssignmentSql`, which runs them again for
 * each assignee. The oracle the compact composition must match.
 */
const actionOrg = sql`${agentActions.org_id}`;
function formerReviewableActionSql(user: { id: string; org_id: string; role?: string }): SQL {
  return and(
    sql`${agentActions.org_id} = ${user.org_id}`,
    visibleCaptureActionSql(user),
    visibleAgentActionSourceSql({ userId: user.id, orgId: user.org_id }),
    moduleRoleAudienceSql(user.role, { userId: user.id, orgId: user.org_id }),
    sourceMessageRoomSql(user.id),
    actionReviewAssignmentSql(user.id),
  )!;
}
function formerCurrentRoleReviewableActionSql(userId: string | SQL): SQL {
  const hasRole = (roles: string[]) => sql`EXISTS (
      SELECT 1 FROM org_members review_role
      WHERE review_role.org_id = ${agentActions.org_id} AND review_role.user_id = ${userId}
        AND review_role.is_active = true
        AND review_role.role IN (${sql.join(roles.map((value) => sql`${value}`), sql`, `)})
    )`;
  return and(
    visibleCaptureActionSql({ id: userId, org_id: actionOrg }),
    visibleAgentActionSourceSql({ userId, orgId: actionOrg }),
    sql`(${hasRole(['owner', 'admin'])}
      OR (${hasRole(['member'])} AND ${moduleRoleAudienceSql('member', { userId, orgId: actionOrg })})
      OR (${hasRole(['guest'])} AND ${moduleRoleAudienceSql('guest', { userId, orgId: actionOrg })}))`,
    sourceMessageRoomSql(userId),
    actionReviewAssignmentSql(userId),
  )!;
}

/** The test actions a gate passes, as a filter and as a selected value (the two ways the code uses it). */
async function gateAnswers(gate: SQL): Promise<{ filtered: string[]; selected: string[] }> {
  const filtered = await db.select({ id: agentActions.id }).from(agentActions).where(and(inArray(agentActions.id, actions), gate));
  const selected = await db.select({ id: agentActions.id, passes: sql<boolean>`coalesce((${gate}), false)` })
    .from(agentActions).where(inArray(agentActions.id, actions));
  return {
    filtered: filtered.map((row) => row.id).sort(),
    selected: selected.filter((row) => row.passes).map((row) => row.id).sort(),
  };
}

test('the review gate answers exactly as the composition it replaced, for every person, role and approval', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const titleOf = new Map([...actionByTitle].map(([title, id]) => [id, title]));
  const named = (ids: string[]) => ids.map((id) => titleOf.get(id) ?? id);
  const passedBy = new Map<string, Set<string>>();
  for (const [name, person] of Object.entries(people)) {
    // The approve and reject routes' gate, under each role the caller's session may carry.
    for (const role of ['owner', 'admin', 'member', 'guest', undefined]) {
      const viewer = { id: person, org_id: orgId, role };
      const now = await gateAnswers(reviewableActionSql(viewer));
      const former = await gateAnswers(formerReviewableActionSql(viewer));
      assert.deepEqual(named(now.filtered), named(former.filtered), `${name} as ${role}: route gate as a filter`);
      assert.deepEqual(named(now.selected), named(former.selected), `${name} as ${role}: route gate as a value`);
      assert.deepEqual(now.filtered, now.selected, `${name} as ${role}: the filter and the value agree`);
    }
    // The Inbox's gate, with the role read in the statement: as before, and as the routes answer under that role.
    const current = await gateAnswers(currentRoleReviewableActionSql(person));
    const formerCurrent = await gateAnswers(formerCurrentRoleReviewableActionSql(person));
    assert.deepEqual(named(current.filtered), named(formerCurrent.filtered), `${name}: Inbox gate as a filter`);
    assert.deepEqual(named(current.selected), named(formerCurrent.selected), `${name}: Inbox gate as a value`);
    const asRoutes = person === people.removed ? { filtered: [], selected: [] }
      : await gateAnswers(reviewableActionSql({ id: person, org_id: orgId, role: roles[person] }));
    assert.deepEqual(named(current.filtered), named(asRoutes.filtered), `${name}: the Inbox gate is the routes' gate under their current role`);
    passedBy.set(name, new Set(current.filtered));
  }
  // Someone the workspace does not know reviews nothing, under either composition.
  const stranger = randomUUID();
  for (const role of ['owner', 'member', undefined]) {
    const viewer = { id: stranger, org_id: orgId, role };
    assert.deepEqual(await gateAnswers(reviewableActionSql(viewer)), { filtered: [], selected: [] }, `stranger as ${role}`);
    assert.deepEqual(await gateAnswers(formerReviewableActionSql(viewer)), { filtered: [], selected: [] }, `stranger as ${role} (former)`);
  }
  assert.deepEqual(await gateAnswers(currentRoleReviewableActionSql(stranger)), { filtered: [], selected: [] }, 'stranger, Inbox gate');
  // The gate's user is a column of the statement (the approval sweep, approver assignment).
  const sweep = (gate: (user: SQL) => SQL) => db.select({ id: attentionItems.id }).from(attentionItems).where(and(
    eq(attentionItems.org_id, orgId), eq(attentionItems.source_type, 'agent_action'),
    sql`EXISTS (SELECT 1 FROM ${agentActions} WHERE ${agentActions.id} = ${attentionItems.source_id}
      AND ${agentActions.org_id} = ${attentionItems.org_id} AND ${gate(sql`${attentionItems.user_id}`)})`,
  )).then((rows) => rows.map((row) => row.id).sort());
  assert.deepEqual(await sweep(currentRoleReviewableActionSql), await sweep(formerCurrentRoleReviewableActionSql), 'gate user as a column');
  // ... and of another table, per action (approver assignment, ensureActionApprovers).
  const recipients = async (gate: (user: SQL) => SQL) => (await db.execute(sql`SELECT a.id || ':' || om.user_id AS pair
    FROM agent_actions a JOIN org_members om ON om.org_id = ${orgId}
    WHERE a.id = ANY(${sql.param(actions)}::text[])
      AND EXISTS (SELECT 1 FROM ${agentActions} WHERE ${agentActions.id} = a.id AND ${agentActions.org_id} = ${orgId}
        AND ${gate(sql`om.user_id`)})`)).rows.map((row) => String((row as { pair: string }).pair)).sort();
  const recipientPairs = await recipients(currentRoleReviewableActionSql);
  assert.ok(recipientPairs.length > 0, 'some action has recipients');
  assert.deepEqual(recipientPairs, await recipients(formerCurrentRoleReviewableActionSql), 'gate user as a column of another table');

  // The fixture reaches the cases it names (so the comparison above is not vacuous).
  const passes = (name: string, title: string) => passedBy.get(name)!.has(actionByTitle.get(title)!);
  const expected: Array<[string, string, boolean]> = [
    ['member', 'from the private room', true], ['owner', 'from the private room', false], ['guest', 'from the private room', false],
    ['member', 'approved', true], ['member', 'rejected', true], ['member', 'expired', true], ['admin', 'expired', false],
    ['owner', 'departed requester, no room', true], ['admin', 'departed requester, no room', true], ['member', 'departed requester, no room', false],
    ['owner', 'assigned to a non-reviewer', true], ['admin', 'assigned to a non-reviewer', false], ['member', 'assigned to a non-reviewer', false],
    ['owner', 'assignee outside the room', false], ['admin', 'assignee outside the room', true],
    ['owner', 'departed requester, assigned to the admin', false], ['admin', 'departed requester, assigned to the admin', true],
    ['admin', 'assigned', true], ['owner', 'assigned', false],
    ['member', 'requester assigned, decided', true],
    ['member', 'an admin assigned, the requester reviews', true], ['admin', 'an admin assigned, the requester reviews', false],
    ['member', 'requester and an admin assigned', true], ['admin', 'requester and an admin assigned', false],
    ['owner', 'departed requester, owner and member assigned', true], ['admin', 'departed requester, owner and member assigned', false],
    ['member', 'departed requester, owner and member assigned', false],
    ['owner', 'departed requester, assignment of another workspace', true], ['admin', 'departed requester, assignment of another workspace', true],
    ['guest', 'module write by a guest', false], ['member', 'module write by a member', true],
    ['member', 'employee, cited message', true], ['guest', 'employee, cited message', false],
    ['member', 'employee, message in the admin room', false],
    ['member', 'Defty envelope, private room', true], ['member', 'Defty envelope, admin room', false],
    ['member', 'employee, channel event', true], ['member', 'employee, no source', true],
    ['owner', 'employee, no source, departed requester', true], ['member', 'employee, no source, departed requester', false],
    ['member', 'capture', true], ['member', 'capture from the admin room', false],
    ['member', 'plan step, private room', true], ['member', 'plan step, admin room', false],
    ['member', 'another workspace', false], ['removed', 'from the private room', false],
  ];
  for (const [name, title, shown] of expected) assert.equal(passes(name, title), shown, `${name}, "${title}": ${shown ? 'reviews' : 'does not review'}`);
});

test('an approval item is shown exactly when the rule it replaced showed it, pending, decided or expired', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const tally = new Map<string, { shown: number; hidden: number }>();
  const statusOf = new Map((await q('SELECT id, approval_status FROM agent_actions WHERE id = ANY($1::text[])', [actions]))
    .rows.map((row: { id: string; approval_status: string }) => [row.id, row.approval_status]));
  for (const [name, person] of Object.entries(people)) {
    const former = await db.select({ id: attentionItems.id, source_id: attentionItems.source_id }).from(attentionItems).where(and(
      eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, person), eq(attentionItems.source_type, 'agent_action'),
      sql`(${attentionItems.metadata}->>'legacy_notification_id' IS NULL OR
        ${nativeNotificationAccessSql(person, sql`${attentionItems.metadata}`, sql`${attentionItems.org_id}`, sql`${attentionItems.link}`)})`,
      sql`EXISTS (SELECT 1 FROM ${agentActions} WHERE ${agentActions.id} = ${attentionItems.source_id}
        AND ${agentActions.org_id} = ${attentionItems.org_id} AND ${formerCurrentRoleReviewableActionSql(person)})`,
    ));
    const expected = new Set(former.map((row) => row.id));
    assert.deepEqual(sorted(await visibleIds(person, ['agent_action'], 'agent_action')), sorted(expected), `${name}: approval items, narrowed`);
    const whole = await visibleIds(person, 'all');
    const ofType = await idsOfType(person, 'agent_action');
    assert.deepEqual(sorted(new Set([...ofType].filter((id) => whole.has(id)))), sorted(expected), `${name}: approval items, whole rule`);
    const rows = await db.select({ id: attentionItems.id, source_id: attentionItems.source_id }).from(attentionItems)
      .where(and(eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, person), eq(attentionItems.source_type, 'agent_action')));
    for (const row of rows) {
      const status = statusOf.get(row.source_id) ?? 'missing';
      const entry = tally.get(status) ?? { shown: 0, hidden: 0 };
      if (expected.has(row.id)) entry.shown += 1; else entry.hidden += 1;
      tally.set(status, entry);
    }
  }
  for (const status of ['pending', 'approved', 'rejected', 'expired']) {
    const entry = tally.get(status);
    assert.ok(entry && entry.shown > 0 && entry.hidden > 0, `${status}: shown ${entry?.shown}, hidden ${entry?.hidden}`);
  }
});

/** `reviewsActionSql` as composed before release 151: the user's own checks, then `actionReviewAssignmentSql`. */
function formerReviewsSql(userId: string): SQL {
  return and(
    visibleCaptureActionSql({ id: userId, org_id: actionOrg }),
    visibleAgentActionSourceSql({ userId, orgId: actionOrg }),
    sourceMessageRoomSql(userId),
    actionReviewAssignmentSql(userId),
  )!;
}

/** The room's pending approvals as release 151 listed them (routes/agent.ts, GET /actions/pending-by-space). */
function formerPendingInRoomSql(user: { id: string; org_id: string; role: string }, spaceId: string): SQL {
  return sql`SELECT a.id FROM agent_actions a JOIN messages msg ON msg.id = a.message_id
    WHERE msg.space_id = ${spaceId} AND msg.org_id = ${user.org_id} AND a.org_id = ${user.org_id}
      AND a.approval_status = 'pending' AND a.approval_tier IN ('quick', 'full')
      AND a.source IS DISTINCT FROM 'defty_capture'
      AND EXISTS (SELECT 1 FROM agent_actions WHERE agent_actions.id = a.id
        AND ${visibleAgentActionSourceSql({ userId: user.id, orgId: user.org_id })}
        AND ${sourceMessageRoomSql(user.id)})
      AND (${user.role !== 'guest'} OR a.action NOT IN ('module_record_create', 'module_record_bulk_create',
        'module_record_update', 'module_record_archive', 'module_record_task_link', 'module_record_task_unlink'))
      AND EXISTS (SELECT 1 FROM agent_actions WHERE agent_actions.id = a.id AND ${actionReviewAssignmentSql(user.id)})`;
}

type ActionKind = { employee: boolean; capture: boolean };

/** Each test action's kind (an outside agent's, a capture), as the gate's scope reads it. */
async function actionKinds(): Promise<Map<string, ActionKind>> {
  const rows = await db.select({ id: agentActions.id, employee: employeeActionSql(), capture: captureActionSql() })
    .from(agentActions).where(inArray(agentActions.id, actions));
  return new Map(rows.map((row) => [row.id, { employee: row.employee, capture: row.capture }]));
}

const PARTIAL_SCOPES: ReviewGateScope[] = [
  { employeeActions: false, captures: true },
  { employeeActions: true, captures: false },
  { employeeActions: false, captures: false },
];

const coveredBy = (scope: ReviewGateScope, kind: ActionKind | undefined) => kind !== undefined
  && (scope.employeeActions || !kind.employee) && (scope.captures || !kind.capture);

test('the review gate narrowed to the kinds of its actions answers as the whole gate on them, and false on the others', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const kinds = await actionKinds();
  const kindCount = (key: keyof ActionKind) => [...kinds.values()].filter((kind) => kind[key]).length;
  assert.ok(kindCount('employee') >= 3 && kindCount('capture') >= 2, 'the fixture has outside agents\' actions and captures');
  const kindOf = (title: string) => kinds.get(actionByTitle.get(title)!);
  assert.deepEqual(kindOf('capture with an employee'), { employee: true, capture: true });
  assert.deepEqual(kindOf('no source'), { employee: false, capture: false });
  assert.deepEqual(kindOf('employee of another workspace'), { employee: true, capture: false });
  assert.deepEqual(kindOf('Defty envelope, private room'), { employee: false, capture: false });
  let excluded = 0;
  let shown = 0;
  for (const scope of PARTIAL_SCOPES) {
    const label = `employee actions ${scope.employeeActions}, captures ${scope.captures}`;
    const covered = (ids: string[]) => ids.filter((id) => coveredBy(scope, kinds.get(id)));
    const same = (narrowed: { filtered: string[]; selected: string[] }, whole: { filtered: string[]; selected: string[] }, at: string) => {
      assert.deepEqual(narrowed.filtered, covered(whole.filtered), `${at}, ${label}: as a filter`);
      assert.deepEqual(narrowed.selected, covered(whole.selected), `${at}, ${label}: as a value`);
      excluded += whole.filtered.length - narrowed.filtered.length;
      shown += narrowed.filtered.length;
    };
    for (const [name, person] of Object.entries(people)) {
      for (const role of ['owner', 'admin', 'member', 'guest', undefined]) {
        const viewer = { id: person, org_id: orgId, role };
        same(await gateAnswers(reviewableActionSql(viewer, scope)), await gateAnswers(formerReviewableActionSql(viewer)), `${name} as ${role}, routes' gate`);
      }
      same(await gateAnswers(currentRoleReviewableActionSql(person, scope)), await gateAnswers(formerCurrentRoleReviewableActionSql(person)), `${name}, Inbox gate`);
      same(await gateAnswers(reviewsActionSql(person, scope)), await gateAnswers(formerReviewsSql(person)), `${name}, gate without audience`);
    }
  }
  for (const [name, person] of Object.entries(people)) {
    assert.deepEqual(await gateAnswers(reviewsActionSql(person)), await gateAnswers(formerReviewsSql(person)), `${name}, gate without audience, whole`);
  }
  assert.ok(shown > 0 && excluded > 0, `narrowed gates show ${shown} and leave out ${excluded} that the whole gate shows`);
});

test('while the Defty envelope is inactive or marked BYOA its actions count as an outside agent\'s, and narrowed gates still agree', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { rows: [envelope] } = await q("SELECT id FROM agent_employees WHERE org_id = $1 AND runtime_kind = 'defty_system'", [orgId]);
  assert.ok(envelope, 'the Defty envelope');
  const envelopeActions = actions.filter((id) => [...actionByTitle].some(([title, value]) => value === id && title.startsWith('Defty envelope')));
  assert.equal(envelopeActions.length, 2);
  for (const [state, change, restore] of [['inactive', 'is_active = false', 'is_active = true'], ['marked BYOA', 'is_byoa = true', 'is_byoa = false']]) {
    await q(`UPDATE agent_employees SET ${change} WHERE id = $1`, [envelope.id]);
    try {
      const kinds = await actionKinds();
      for (const id of envelopeActions) assert.equal(kinds.get(id)!.employee, true, `${state}: an envelope action is an outside agent's`);
      for (const scope of PARTIAL_SCOPES) {
        const covered = (ids: string[]) => ids.filter((id) => coveredBy(scope, kinds.get(id)));
        for (const [name, person] of Object.entries(people)) {
          const at = `${state}, ${name}, employee actions ${scope.employeeActions}, captures ${scope.captures}`;
          assert.deepEqual((await gateAnswers(reviewsActionSql(person, scope))).filtered, covered((await gateAnswers(formerReviewsSql(person))).filtered), `${at}: gate without audience`);
          assert.deepEqual((await gateAnswers(currentRoleReviewableActionSql(person, scope))).filtered,
            covered((await gateAnswers(formerCurrentRoleReviewableActionSql(person))).filtered), `${at}: Inbox gate`);
          const viewer = { id: person, org_id: orgId, role: roles[person] };
          assert.deepEqual((await gateAnswers(reviewableActionSql(viewer, scope))).filtered, covered((await gateAnswers(formerReviewableActionSql(viewer))).filtered), `${at}: routes' gate`);
        }
      }
    } finally {
      await q(`UPDATE agent_employees SET ${restore} WHERE id = $1`, [envelope.id]);
    }
  }
});

test('a read narrows the Inbox approval rule exactly, by the kinds it read and never by a stored source type', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const kinds = await actionKinds();
  const plainActions = actions.filter((id) => coveredBy({ employeeActions: false, captures: false }, kinds.get(id)));
  for (const [name, person] of Object.entries(people)) {
    const whole = await visibleIds(person, 'all');
    const items = await db.select({ id: attentionItems.id, source_id: attentionItems.source_id }).from(attentionItems)
      .where(and(eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, person), eq(attentionItems.source_type, 'agent_action')));
    for (const scope of PARTIAL_SCOPES) {
      const expected = new Set(items.filter((item) => whole.has(item.id) && coveredBy(scope, kinds.get(item.source_id))).map((item) => item.id));
      assert.deepEqual(sorted(await visibleIds(person, { types: ['agent_action'], approvals: scope }, 'agent_action')), sorted(expected),
        `${name}, employee actions ${scope.employeeActions}, captures ${scope.captures}`);
    }
    // A read of items whose actions are neither an outside agent's nor captures narrows both, and shows what the whole rule shows.
    const plainItems = and(eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, person),
      eq(attentionItems.source_type, 'agent_action'), inArray(attentionItems.source_id, plainActions));
    const read = await readAttentionWithSourceTypes(plainItems, async (tx, scope) => {
      assert.deepEqual(scope, { types: ['agent_action'], approvals: { employeeActions: false, captures: false } }, `${name}: what the read found`);
      return tx.select({ id: attentionItems.id }).from(attentionItems).where(and(plainItems, visibleAttentionCondition(person, scope)));
    });
    const plainExpected = new Set(items.filter((item) => whole.has(item.id) && plainActions.includes(item.source_id)).map((item) => item.id));
    assert.deepEqual(sorted(new Set(read.map((row) => row.id))), sorted(plainExpected), `${name}: plain approvals, read`);
    // Every approval item of the person (outside agents' and captures among them): the whole gate.
    const every = and(eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, person), eq(attentionItems.source_type, 'agent_action'));
    await readAttentionWithSourceTypes(every, async (_tx, scope) => assert.deepEqual(scope.approvals, { employeeActions: true, captures: true }, `${name}: whole`));
  }
  // Astra (review of 0148e174): a stored item whose source type is text that once meant "no captures" next to a
  // reviewable capture's item hid the capture. Source types are free text and never narrow the gate.
  const capture = [...itemIds.entries()].find(([key]) => key === `${people.member}|agent_action|${actionByTitle.get('capture')}|0`)![1];
  const lookalikes = ['agent_action:no-captures', 'agent_action:no-employee-actions'].map((type) => ({ id: randomUUID(), type }));
  for (const { id, type } of lookalikes) {
    await q(`INSERT INTO attention_items(id,org_id,user_id,kind,lane,dedupe_key,source_type,source_id,title)
      VALUES($1,$2,$3,'test','updates',$1,$4,$5,'look-alike')`, [id, orgId, people.member, type, randomUUID()]);
  }
  const both = and(eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, people.member),
    inArray(attentionItems.id, [capture, ...lookalikes.map((row) => row.id)]));
  const shown = await readAttentionWithSourceTypes(both, (tx, scope) => tx.select({ id: attentionItems.id }).from(attentionItems)
    .where(and(both, visibleAttentionCondition(people.member, scope))));
  assert.deepEqual(sorted(new Set(shown.map((row) => row.id))), sorted(new Set([capture, ...lookalikes.map((row) => row.id)])),
    'the capture and both look-alike items are shown');
  // A change takes stored types as they are (writeAttentionWithSourceTypes): the whole gate.
  assert.ok((await visibleIds(people.member, ['agent_action', 'agent_action:no-captures'], 'agent_action')).has(capture),
    'stored types passed as a list never narrow the gate');
});

test('a room\'s pending approvals are exactly what release 151 listed, for every role, room and approval state', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { Hono } = await import('hono');
  const { agentRoutes } = await import('../src/routes/agent.js');
  const kinds = await actionKinds();
  const listed = async (person: string, role: string, room: string) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('user' as never, { id: person, org_id: orgId, email: `${person}@example.test`, role } as never);
      await next();
    });
    app.route('/api/agent', agentRoutes);
    const response = await app.request(`/api/agent/actions/pending-by-space?space_id=${room}`);
    assert.equal(response.status, 200);
    return ((await response.json()) as Array<{ id: string }>).map((row) => row.id).sort();
  };
  const pendingKinds = new Map<string, ActionKind[]>();
  let nonEmpty = 0;
  for (const [roomName, room] of Object.entries(rooms)) {
    const { rows } = await q(`SELECT a.id FROM agent_actions a JOIN messages m ON m.id = a.message_id
      WHERE m.space_id = $1 AND a.approval_status = 'pending' AND a.org_id = $2`, [room, orgId]);
    pendingKinds.set(roomName, rows.map((row: { id: string }) => kinds.get(row.id)!).filter(Boolean));
    for (const [name, person] of Object.entries(people)) {
      const member = (await q('SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2', [room, person])).rowCount! > 0;
      for (const role of ['owner', 'admin', 'member', 'guest']) {
        const expected = member
          ? ((await db.execute(formerPendingInRoomSql({ id: person, org_id: orgId, role }, room))).rows as Array<{ id: string }>).map((row) => row.id).sort()
          : [];
        const got = await listed(person, role, room);
        assert.deepEqual(got, expected, `${name} as ${role}, ${roomName} room`);
        if (got.length > 0) nonEmpty += 1;
      }
    }
  }
  assert.ok(nonEmpty >= 6, `the rooms list approvals in ${nonEmpty} cases`);
  // Both plans ran: a room with only Defty actions pending, and one with an outside agent's.
  const mixes = [...pendingKinds.values()].filter((list) => list.length > 0);
  assert.ok(mixes.some((list) => list.every((kind) => !kind.employee)), 'a room with only Defty actions pending');
  assert.ok(mixes.some((list) => list.some((kind) => kind.employee)), 'a room with an outside agent\'s action pending');
  // Decided and expired approvals are never listed.
  const decided = actions.filter((id) => ['approved', 'rejected', 'expired'].includes([...actionByTitle].find(([, value]) => value === id)?.[0] ?? ''));
  assert.equal(decided.length, 3);
  for (const role of ['owner', 'member']) {
    for (const id of await listed(people.member, role, rooms.priv)) assert.ok(!decided.includes(id), 'a decided approval is not listed');
  }
});

test('viewerReviewAuthority answers the same for an action whether or not the page holds an outside agent\'s action or a capture', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { viewerReviewAuthority } = await import('../src/lib/agent-approval-resolver.js');
  const kinds = await actionKinds();
  const plain = actions.filter((id) => coveredBy({ employeeActions: false, captures: false }, kinds.get(id)));
  // Pages of one kind each: only plain actions, only outside agents' (and plain), only captures (and plain).
  const pages: Array<[string, string[]]> = [
    ['plain', plain],
    ['outside agents\'', actions.filter((id) => coveredBy({ employeeActions: true, captures: false }, kinds.get(id)))],
    ['captures', actions.filter((id) => coveredBy({ employeeActions: false, captures: true }, kinds.get(id)))],
  ];
  let canApprove = 0;
  for (const [name, person] of Object.entries(people)) {
    for (const role of ['owner', 'admin', 'member', 'guest']) {
      const viewer = { id: person, org_id: orgId, role };
      const whole = await viewerReviewAuthority(viewer, actions);
      for (const [page, ids] of pages) {
        const narrowed = await viewerReviewAuthority(viewer, ids);
        for (const id of ids) {
          assert.deepEqual(narrowed.get(id), whole.get(id), `${name} as ${role}, a page of ${page}: ${[...actionByTitle].find(([, value]) => value === id)?.[0]}`);
          if (narrowed.get(id)?.viewer_can_approve) canApprove += 1;
        }
      }
    }
  }
  assert.ok(canApprove > 0, `some viewer may approve on a narrowed page (${canApprove})`);
});

type Growth = { anon: number; peak: number };

/**
 * How much a fresh backend grows (kB) planning `statement` (by default the
 * Inbox rule narrowed to `scope`): its private memory (`RssAnon`, which the
 * backend keeps after the statement) and its peak resident size (`VmHWM`,
 * which also counts the shared catalog pages a new backend reads). Null when
 * the session cannot read /proc.
 *
 * With JIT off, as the API's connections run (lib/db.ts): on a database with
 * rows and statistics the estimated cost of these statements passes
 * jit_above_cost, and even a plain EXPLAIN then sets up JIT compilation,
 * which adds ~50 MB that has nothing to do with planning.
 */
async function planningGrowth(scope: AttentionSourceScope, statement?: { sql: string; params: unknown[] }): Promise<Growth | null> {
  const backend = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await backend.connect();
  try {
    await backend.query('SET jit = off');
    const read = async (): Promise<Growth | null> => {
      const { rows } = await backend.query(`SELECT substring(s from 'RssAnon:\\s*([0-9]+)')::int AS anon,
        substring(s from 'VmHWM:\\s*([0-9]+)')::int AS peak FROM pg_read_file('/proc/self/status') s`);
      return rows[0]?.anon == null || rows[0]?.peak == null ? null : { anon: rows[0].anon, peak: rows[0].peak };
    };
    let before: Growth | null;
    try { before = await read(); } catch (error) { if (inCi) throw error; return null; }
    if (before == null) { if (inCi) throw new Error('/proc/self/status gave no RssAnon or VmHWM'); return null; }
    const query = statement ?? db.select({ id: attentionItems.id }).from(attentionItems).where(and(
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
});

test('planning an approval item\'s review gate costs a backend about a third of what it did', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // Release 150 measured, on the CI image with JIT off, empty or full tables alike: approval items 79 MB
  // private (106 MB peak), the whole rule 84 MB (113 MB), the Inbox's load of a page's approvals (the gate
  // as a filter) 38 MB, the approve and reject routes' gate as a value (viewerReviewAuthority) 38 MB.
  // Release 151: 30, 35, 23 and 22 MB.
  const approval = await planningGrowth(['agent_action']);
  if (approval === null) return t.skip('this test database does not let a session read /proc/self/status');
  const whole = (await planningGrowth('all'))!;
  const pageApprovals = (await planningGrowth('all', db.select({ id: agentActions.id }).from(agentActions).where(and(
    inArray(agentActions.id, actions), eq(agentActions.org_id, orgId), currentRoleReviewableActionSql(people.member),
  )).toSQL()))!;
  const reviewAuthority = (await planningGrowth('all', db.select({
    id: agentActions.id,
    reviewable: sql<boolean>`coalesce((${reviewableActionSql({ id: people.member, org_id: orgId, role: 'member' })}), false)`,
  }).from(agentActions).where(inArray(agentActions.id, actions)).toSQL()))!;
  const mb = (kb: number) => Math.round(kb / 1024);
  const measured: Array<[string, Growth, number, number]> = [
    ['approval items', approval, 40, 64],
    ['whole rule', whole, 48, 72],
    ['a page\'s approvals (gate as a filter)', pageApprovals, 32, 56],
    ['review authority (gate as a value)', reviewAuthority, 32, 56],
  ];
  t.diagnostic(`backend growth planning: ${measured.map(([name, growth]) => `${name} ${mb(growth.anon)} MB private, ${mb(growth.peak)} MB peak`).join('; ')}`);
  for (const [name, growth, anonMb, peakMb] of measured) {
    assert.ok(growth.anon < anonMb * 1024, `${name}, private memory: ${growth.anon} kB`);
    assert.ok(growth.peak < peakMb * 1024, `${name}, peak: ${growth.peak} kB`);
  }
});

test('planning a room\'s pending approvals, and an Inbox approval of a Defty action, costs a backend a few MB', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // Release 151 measured, JIT off: a room's pending-approvals poll (every 5 s per open room) 36 MB private,
  // an Inbox approval item 30 MB. Release 152 plans the review gate only for the kinds of action the rows
  // are: a room with only Defty actions pending 7 MB, one with an outside agent's 19 MB.
  const roomPoll = (scope: ReviewGateScope) => planningGrowth('all', new PgDialect().sqlToQuery(sql`SELECT a.id
      FROM agent_actions a JOIN messages msg ON msg.id = a.message_id
      WHERE msg.space_id = ${rooms.priv} AND msg.org_id = ${orgId} AND a.org_id = ${orgId}
        AND a.approval_status = 'pending' AND a.approval_tier IN ('quick', 'full')
        AND a.source IS DISTINCT FROM 'defty_capture'
        AND COALESCE((SELECT ${reviewsActionSql(people.member, scope)} FROM agent_actions WHERE agent_actions.id = a.id), false)
      ORDER BY a.created_at DESC LIMIT 100`));
  const deftyRoom = await roomPoll({ employeeActions: false, captures: false });
  if (deftyRoom === null) return t.skip('this test database does not let a session read /proc/self/status');
  const employeeRoom = (await roomPoll({ employeeActions: true, captures: false }))!;
  const deftyApproval = (await planningGrowth({ types: ['agent_action'], approvals: { employeeActions: false, captures: false } }))!;
  const mb = (kb: number) => Math.round(kb / 1024);
  const measured: Array<[string, Growth, number, number]> = [
    ['a room with only Defty actions pending', deftyRoom, 12, 28],
    ['a room with an outside agent\'s action pending', employeeRoom, 26, 50],
    ['an Inbox approval of a Defty action', deftyApproval, 24, 50],
  ];
  t.diagnostic(`backend growth planning: ${measured.map(([name, growth]) => `${name} ${mb(growth.anon)} MB private, ${mb(growth.peak)} MB peak`).join('; ')}`);
  for (const [name, growth, anonMb, peakMb] of measured) {
    assert.ok(growth.anon < anonMb * 1024, `${name}, private memory: ${growth.anon} kB`);
    assert.ok(growth.peak < peakMb * 1024, `${name}, peak: ${growth.peak} kB`);
  }
});

test('a read takes the item types and the items from one snapshot: a type change committed in between changes nothing', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // A member's own task item (no legacy metadata), turned into a readable space item by a concurrent upsert.
  const [id] = [...itemIds.entries()].find(([key]) => key.startsWith(`${people.member}|task|`) && key.endsWith('|0'))!.slice(1);
  const where = and(eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, people.member), eq(attentionItems.id, id!));
  try {
    const seen = await readAttentionWithSourceTypes(where, async (tx, types) => {
      assert.deepEqual(types.types, ['task']);
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

test('a change takes the item types under a row lock: no type change can commit before it does, an event insert does not wait', async (t) => {
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
      await other.query(`INSERT INTO attention_events(id,org_id,attention_item_id,user_id,event_type,source_event_id)
        VALUES($1,$2,$3,$4,'test',$1)`, [randomUUID(), orgId, id, people.member]);
      return tx.update(attentionItems).set({ title: 'changed under lock' })
        .where(and(where, visibleAttentionCondition(people.member, types))).returning({ id: attentionItems.id });
    }, []);
    assert.deepEqual(changed, [{ id }]);
  } finally {
    await other.end();
  }
});

test('a gated change takes only the items it locked: items committed meanwhile stay out of it, whole, and it never waits on them', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // Items on a lane of their own, so the matrix above is untouched.
  const lane = `race-${randomUUID().slice(0, 8)}`;
  const insert = (id: string, type: string, source: string) => q(`INSERT INTO attention_items(id,org_id,user_id,kind,lane,dedupe_key,source_type,source_id,title)
    VALUES($1,$2,$3,'test',$4,$1,$5,$6,'race')`, [id, orgId, people.member, lane, type, source]);
  const first = randomUUID();
  await insert(first, 'task', randomUUID());
  const unseen = and(eq(attentionItems.org_id, orgId), eq(attentionItems.user_id, people.member),
    eq(attentionItems.lane, lane), eq(attentionItems.state, 'open_unseen'));
  const [space, task] = [randomUUID(), randomUUID()];
  const marked = await writeAttentionWithSourceTypes(unseen, async (tx, types, lockedIds) => {
    assert.deepEqual(types, ['task']);
    assert.deepEqual(lockedIds, [first]);
    // A readable space item and a task item arrive in one commit after the lock (as an upsert batch would).
    await q(`INSERT INTO attention_items(id,org_id,user_id,kind,lane,dedupe_key,source_type,source_id,title)
      VALUES($1,$3,$4,'test',$5,$1,'space',$6,'race'), ($2,$3,$4,'test',$5,$2,'task',$7,'race')`,
    [space, task, orgId, people.member, lane, rooms.priv, randomUUID()]);
    await tx.execute(sql`SET LOCAL lock_timeout = '300ms'`);
    return tx.update(attentionItems).set({ state: 'open_seen' })
      .where(and(unseen, lockedAttentionIdsSql(lockedIds), visibleAttentionCondition(people.member, types)))
      .returning({ id: attentionItems.id });
  }, []);
  assert.deepEqual(marked, [{ id: first }], 'only the locked item changed');
  const { rows } = await q('SELECT id, state FROM attention_items WHERE id = ANY($1::text[]) ORDER BY id', [[space, task]]);
  assert.deepEqual(rows.map((row: { state: string }) => row.state), ['open_unseen', 'open_unseen'], 'the items that arrived meanwhile are both left unseen');
  assert.deepEqual(await writeAttentionWithSourceTypes(and(unseen, eq(attentionItems.id, randomUUID())), async () => ['called'], []), [],
    'nothing locked: the change is not run');
});

test('mark-all-seen marks thousands of items and records an event for each, in one transaction', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { Hono } = await import('hono');
  const { attentionRoutes } = await import('../src/routes/attention.js');
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user' as never, { id: people.owner, org_id: orgId, email: `${people.owner}@example.test`, role: 'owner' } as never);
    await next();
  });
  app.route('/api/attention', attentionRoutes);
  // More events than one insert can carry (eight parameters each, at most 65,535 per statement).
  const many = 9_000;
  await q(`INSERT INTO attention_items(id,org_id,user_id,kind,lane,dedupe_key,source_type,source_id,title)
    SELECT 'bulk-' || n || '-' || $1, $1, $2, 'test', 'needs_you', 'bulk-' || n || '-' || $1, 'task', 'bulk-' || n, 'bulk'
    FROM generate_series(1, $3::int) n`, [orgId, people.owner, many]);
  const response = await app.request('/api/attention/mark-all-seen', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lane: 'needs_you' }),
  });
  assert.equal(response.status, 200);
  const { updated } = await response.json() as { updated: number };
  assert.equal(updated, many);
  const { rows } = await q(`SELECT
      (SELECT count(*)::int FROM attention_items WHERE org_id=$1 AND user_id=$2 AND id LIKE 'bulk-%' AND state='open_seen') AS seen,
      (SELECT count(*)::int FROM attention_events WHERE org_id=$1 AND user_id=$2 AND event_type='open_seen' AND attention_item_id LIKE 'bulk-%') AS events`,
  [orgId, people.owner]);
  assert.deepEqual(rows[0], { seen: many, events: many });
});
