/**
 * An agent employee's proposal that answers a member's message is reviewed
 * by that member. The proposal cites the message (`agent_actions.message_id`)
 * and the requester is its author when the server recorded that the author
 * addressed this employee (the `message.created` delivery event the message
 * worker writes), the author was not a guest when writing and is now an
 * active non-guest member who can read the room, the employee is a member of
 * the room, the proposal is tied to no other delivery and to no other room,
 * and it was made within 24 hours of the event. Otherwise the requester is
 * the action's own user, as before.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-action-requester-message-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';

import { agentRoutes } from '../src/routes/agent.js';
import { inboxRoutes } from '../src/routes/inbox.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;
let app: Hono;
const roles = new Map<string, string>();
let bob: string; // member
let alice: string; // member
let gina: string; // guest
let outsideAdmin: string; // admin in no room below
let inRoomAdmin: string; // admin in the shared room
let employeeE: string;
let employeeF: string;
let shadowE: string;
let shadowF: string;
let dmSpace: string; // bob + E
let room: string; // private: bob, alice, gina, inRoomAdmin, E, F
let otherRoom: string; // private: alice, E
let foreignOrg: string;
const extraUsers: string[] = [];

async function addUser(label: string, role: string, kind = 'human'): Promise<string> {
  const id = randomUUID();
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, $3, $4, $5, true)`,
    [id, `r4-${label}-${id}@example.test`, `R4 ${label}`, kind, kind === 'agent'],
  );
  await f.client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
    [randomUUID(), f.orgId, id, role]);
  roles.set(id, role);
  extraUsers.push(id);
  return id;
}

async function addEmployee(label: string, shadow: string): Promise<string> {
  const id = randomUUID();
  await f.client.query(
    `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, 'project_manager', 'Fixture', 'conservative', true, true, $6)`,
    [id, f.orgId, shadow, `R4 ${label}`, `r4-${label}-${id.slice(0, 8)}`, f.adminId],
  );
  await f.client.query('UPDATE users SET agent_employee_id = $2 WHERE id = $1', [shadow, id]);
  return id;
}

async function addSpace(type: string, members: string[]): Promise<string> {
  const id = randomUUID();
  await f.client.query('INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, $4, $5)',
    [id, f.orgId, `r4-${type}-${id.slice(0, 8)}`, type, members[0]]);
  for (const user of members) {
    await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), id, user]);
  }
  return id;
}

/** A message from `author` addressed to `employee`, run through the message worker. */
async function addressed(author: string, spaceId: string, employee: string, isDM = false) {
  const { handleAgentEmployeeMessage } = await import('../src/workers/handlers/agent-employee-message.js');
  const messageId = randomUUID();
  await f.client.query('INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)',
    [messageId, f.orgId, spaceId, author, `please handle ${messageId.slice(0, 6)}`]);
  await handleAgentEmployeeMessage({
    id: randomUUID(), name: 'agent-employee-message',
    data: { messageId, spaceId, orgId: f.orgId, employeeId: employee, isDM },
  } as any);
  const event = (await f.client.query(
    `SELECT id, created_at FROM agent_channel_events WHERE org_id = $1 AND agent_employee_id = $2 AND idempotency_key = $3`,
    [f.orgId, employee, `message:${messageId}:employee:${employee}`],
  )).rows[0] as { id: string; created_at: Date } | undefined;
  return { messageId, eventId: event?.id ?? null, eventAt: event?.created_at ?? null };
}

type Proposal = {
  messageId?: string | null;
  employee?: string;
  source?: string;
  conversationId?: string | null;
  channelEventId?: string | null;
  createdAt?: string;
};

/** A pending proposal of an employee, as its MCP writers store it. */
async function propose(spec: Proposal): Promise<string> {
  const id = randomUUID();
  const employee = spec.employee ?? employeeE;
  await f.client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status,
       message_id, conversation_id, channel_event_id, created_at)
     VALUES ($1, $2, $3, $4, $5, 'task_create', $6::jsonb, 'full', 'pending', $7, $8, $9, coalesce($10::timestamp, now()))`,
    [id, f.orgId, employee === employeeE ? shadowE : shadowF, employee, spec.source ?? 'mcp',
      JSON.stringify({ title: `r4 ${id.slice(0, 6)}`, project_id: f.projectId }),
      spec.messageId ?? null, spec.conversationId ?? null, spec.channelEventId ?? null, spec.createdAt ?? null],
  );
  return id;
}

async function loadAction(id: string) {
  const { db } = await import('../src/lib/db.js');
  const { agentActions } = await import('@deft/db/schema');
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select().from(agentActions).where(eq(agentActions.id, id));
  return row!;
}

async function requesterOf(id: string): Promise<string> {
  const { loadActionRequesterIds } = await import('../src/lib/agent-action-requester.js');
  return (await loadActionRequesterIds([await loadAction(id)])).get(id)!;
}

async function reviewersOf(id: string): Promise<string[]> {
  const { loadActionReviewers } = await import('../src/lib/agent-action-requester.js');
  return (await loadActionReviewers([await loadAction(id)])).get(id) ?? [];
}

async function listed(userId: string, path: string, actionId: string): Promise<boolean> {
  const response = await app.request(path, { headers: { 'x-test-user': userId } });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.text()).includes(actionId);
}

/** Every review surface answers the same for the user, without deciding. */
async function reviews(userId: string, actionId: string): Promise<boolean> {
  const { viewerReviewAuthority } = await import('../src/lib/agent-approval-resolver.js');
  const { humanApprovalGet, humanApprovalList } = await import('../src/lib/mcp-tools/human.js');
  const role = roles.get(userId) ?? 'member';
  const flags = (await viewerReviewAuthority({ id: userId, org_id: f.orgId, role }, [actionId])).get(actionId);
  const inbox = await listed(userId, '/api/inbox?kind=pending_approval&limit=100', actionId);
  const ctx = { org_id: f.orgId, user_id: userId, role, scopes: ['read:workspace'] };
  const mcpGet = !(await humanApprovalGet({ action_id: actionId }, ctx)).isError;
  const mcpList = JSON.stringify((await humanApprovalList({ status: 'pending' }, ctx)).content).includes(actionId);
  const answers = [Boolean(flags?.viewer_can_approve), Boolean(flags?.viewer_can_reject), inbox, mcpGet, mcpList];
  assert.ok(answers.every((answer) => answer === answers[0]), `surfaces disagree for ${userId}: ${answers}`);
  return answers[0]!;
}

/** Bound to `human`; with `surfaces`, every review surface agrees (slower). */
async function assertBoundTo(actionId: string, human: string, label: string, surfaces = false) {
  assert.equal(await requesterOf(actionId), human, `${label} requester`);
  assert.deepEqual(await reviewersOf(actionId), [human], `${label} reviewers`);
  if (!surfaces) return;
  assert.equal(await reviews(human, actionId), true, `${label} bound member reviews`);
  for (const other of [outsideAdmin, inRoomAdmin, bob, alice].filter((id) => id !== human)) {
    assert.equal(await reviews(other, actionId), false, `${label} ${other} does not review`);
  }
}

async function assertUnbound(actionId: string, label: string) {
  const row = await loadAction(actionId);
  assert.equal(await requesterOf(actionId), row.user_id, `${label} requester stays the action's own user`);
  for (const member of [bob, alice, gina]) {
    assert.equal((await reviewersOf(actionId)).includes(member), false, `${label} ${member}`);
  }
}

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('R4');
  roles.set(f.requesterId, 'member').set(f.otherId, 'member').set(f.adminId, 'admin');
  bob = f.requesterId;
  alice = f.otherId;
  outsideAdmin = f.adminId;
  gina = await addUser('guest', 'guest');
  inRoomAdmin = await addUser('room-admin', 'admin');
  shadowE = await addUser('agent-e', 'member', 'agent');
  shadowF = await addUser('agent-f', 'member', 'agent');
  employeeE = await addEmployee('e', shadowE);
  employeeF = await addEmployee('f', shadowF);
  dmSpace = await addSpace('dm', [bob, shadowE]);
  room = await addSpace('private', [bob, alice, gina, inRoomAdmin, shadowE, shadowF]);
  otherRoom = await addSpace('private', [alice, shadowE]);
  foreignOrg = randomUUID();
  await f.client.query("INSERT INTO orgs (id, name, slug, trust_level) VALUES ($1, 'R4 foreign', $2, 'standard')",
    [foreignOrg, `r4-foreign-${foreignOrg.slice(0, 8)}`]);
  app = new Hono();
  app.use('*', async (c, next) => {
    const id = c.req.header('x-test-user')!;
    c.set('user', { id, org_id: f.orgId, email: `${id}@example.test`, sid: '', role: roles.get(id) } as any);
    await next();
  });
  app.route('/api/agent', agentRoutes).route('/api/inbox', inboxRoutes);
});

after(async () => {
  if (!f) return;
  await f.client.query('DELETE FROM agent_channel_events WHERE org_id = ANY($1::text[])', [[f.orgId, foreignOrg]]).catch(() => undefined);
  await f.client.query('DELETE FROM space_members WHERE space_id = ANY($1::text[])', [[dmSpace, room, otherRoom]]).catch(() => undefined);
  await f.client.query('DELETE FROM orgs WHERE id = $1', [foreignOrg]).catch(() => undefined);
  await f.teardown();
});

test('a member who messaged an employee in a DM or a private room reviews the proposal that cites it', { skip: !canRun, timeout: 900_000 }, async () => {
  const dm = await addressed(bob, dmSpace, employeeE, true);
  assert.ok(dm.eventId, 'the worker records the delivery');
  const inDm = await propose({ messageId: dm.messageId, conversationId: dmSpace, channelEventId: dm.eventId });
  await assertBoundTo(inDm, bob, 'dm', true);

  const mention = await addressed(bob, room, employeeE);
  const inRoom = await propose({ messageId: mention.messageId });
  await assertBoundTo(inRoom, bob, 'room', true);

  // The bound member decides; an admin of the room is refused by the resolver and the route.
  const { rejectAction } = await import('../src/lib/agent-approval-resolver.js');
  const refused = await rejectAction(inRoom, inRoomAdmin);
  assert.equal(refused.status, 'error');
  assert.equal((refused as { code?: string }).code, 'FORBIDDEN');
  const { syncApprovalToAttention } = await import('../src/lib/attention.js');
  const items = await syncApprovalToAttention(await loadAction(inRoom), { deliver: false });
  assert.deepEqual(items.map((item) => item?.user_id), [bob]);
  const response = await app.request(`/api/agent/actions/${inRoom}/reject`, {
    method: 'POST', body: '{}', headers: { 'x-test-user': bob, 'content-type': 'application/json' },
  });
  assert.equal(response.status, 200, await response.text());
});

test('a proposal citing another member\'s message to the same employee binds to that member only', { skip: !canRun, timeout: 900_000 }, async () => {
  const fromAlice = await addressed(alice, room, employeeE);
  const actionId = await propose({ messageId: fromAlice.messageId });
  await assertBoundTo(actionId, alice, 'accepted limit', true);
});

test('proposals without server evidence that the author addressed this employee keep their own requester', { skip: !canRun, timeout: 900_000 }, async () => {
  const mention = await addressed(bob, room, employeeE);
  await assertUnbound(await propose({}), 'no cited message');
  for (const source of ['mention', 'heartbeat', 'trigger', 'mcp_api', 'task_assignment']) {
    await assertUnbound(await propose({ messageId: mention.messageId, source }), `source ${source}`);
  }
  // A message addressed to a different employee.
  const toF = await addressed(bob, room, employeeF);
  await assertUnbound(await propose({ messageId: toF.messageId }), 'message to another employee');
  // A message nobody addressed to an employee (no delivery event).
  const plain = randomUUID();
  await f.client.query('INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)',
    [plain, f.orgId, room, bob, 'not addressed']);
  await assertUnbound(await propose({ messageId: plain }), 'no delivery event');
  // An event recorded for another workspace.
  const foreign = await addressed(bob, room, employeeE);
  await f.client.query('UPDATE agent_channel_events SET org_id = $2 WHERE id = $1', [foreign.eventId, foreignOrg]);
  await assertUnbound(await propose({ messageId: foreign.messageId }), 'event of another workspace');
  // An event without the author's recorded role.
  const unrecorded = await addressed(bob, room, employeeE);
  await f.client.query(`UPDATE agent_channel_events SET payload = payload - 'author_role' WHERE id = $1`, [unrecorded.eventId]);
  await assertUnbound(await propose({ messageId: unrecorded.messageId }), 'no recorded author role');
  // Another room as the action's conversation; another delivery as its correlation.
  await assertUnbound(await propose({ messageId: mention.messageId, conversationId: otherRoom }), 'other conversation');
  const later = await addressed(alice, otherRoom, employeeE);
  await assertUnbound(await propose({ messageId: mention.messageId, channelEventId: later.eventId }), 'other delivery');
  await assertBoundTo(await propose({ messageId: mention.messageId, channelEventId: mention.eventId }), bob, 'own delivery');
});

test('the 24-hour window runs from the delivery event', { skip: !canRun, timeout: 900_000 }, async () => {
  const mention = await addressed(bob, room, employeeE);
  const at = (await f.client.query(
    `SELECT (created_at + interval '24 hours')::text AS edge, (created_at + interval '24 hours 1 second')::text AS past,
            (created_at - interval '1 second')::text AS early FROM agent_channel_events WHERE id = $1`, [mention.eventId],
  )).rows[0] as { edge: string; past: string; early: string };
  await assertBoundTo(await propose({ messageId: mention.messageId, createdAt: at.edge }), bob, 'exactly 24h');
  await assertUnbound(await propose({ messageId: mention.messageId, createdAt: at.past }), 'past 24h');
  await assertUnbound(await propose({ messageId: mention.messageId, createdAt: at.early }), 'before the event');
});

test('a guest\'s message never binds, and the author must still qualify now', { skip: !canRun, timeout: 900_000 }, async () => {
  const fromGina = await addressed(gina, room, employeeE);
  const guestAction = await propose({ messageId: fromGina.messageId });
  await assertUnbound(guestAction, 'guest author');
  await f.client.query('UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2', [f.orgId, gina, 'member']);
  roles.set(gina, 'member');
  await assertUnbound(guestAction, 'guest author promoted later');
  await assertUnbound(await propose({ messageId: fromGina.messageId }), 'guest author promoted, new proposal');

  const fromAlice = await addressed(alice, room, employeeE);
  const actionId = await propose({ messageId: fromAlice.messageId });
  await assertBoundTo(actionId, alice, 'member author');
  const flip = async (sql: string, params: unknown[], label: string) => {
    await f.client.query(sql, params);
    await assertUnbound(actionId, label);
  };
  await flip('UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2', [f.orgId, alice, 'guest'], 'author demoted');
  await f.client.query('UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2', [f.orgId, alice, 'member']);
  await assertBoundTo(actionId, alice, 'author restored');
  await flip('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [f.orgId, alice], 'author deactivated');
  await f.client.query('UPDATE org_members SET is_active = true WHERE org_id = $1 AND user_id = $2', [f.orgId, alice]);
  await flip('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [room, alice], 'author left the room');
  await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), room, alice]);
  await flip('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [room, shadowE], 'employee left the room');
  await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), room, shadowE]);
  await assertBoundTo(actionId, alice, 'all restored');
  await flip('UPDATE messages SET is_deleted = true WHERE id = $1', [fromAlice.messageId], 'message deleted');
});

test('a public room binds only while the employee is a member of it', { skip: !canRun, timeout: 900_000 }, async () => {
  const publicRoom = await addSpace('public', [bob]);
  const mention = await addressed(bob, publicRoom, employeeE);
  assert.ok(mention.eventId, 'public rooms are delivered without membership');
  const actionId = await propose({ messageId: mention.messageId });
  assert.equal(await requesterOf(actionId), shadowE, 'not bound without membership');
  await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), publicRoom, shadowE]);
  assert.equal(await requesterOf(actionId), bob, 'bound with membership');
  await f.client.query('DELETE FROM space_members WHERE space_id = $1', [publicRoom]);
});

test('an employee\'s call citing a message other than the delivery it handles is refused', { skip: !canRun, timeout: 900_000 }, async () => {
  const { requestHumanApproval } = await import('../src/lib/mcp-tools/cooperative.js');
  const { documentSend } = await import('../src/lib/mcp-tools/document-send.js');
  const { workspacePlanImport } = await import('../src/lib/mcp-tools/workspace-plan-import.js');
  const fromBob = await addressed(bob, room, employeeE);
  const fromAlice = await addressed(alice, room, employeeE);
  const ctx = {
    org_id: f.orgId, employee_id: employeeE, employee_slug: 'r4-e', trust_level: 'conservative',
    channel_event_id: fromBob.eventId!,
  } as any;
  const ask = (messageId: string) => requestHumanApproval({
    action: 'task_create', summary: 'Track the request',
    params: { title: 'R4 cited', project_id: f.projectId, source_message_id: messageId },
  } as any, ctx);
  const mismatched = await ask(fromAlice.messageId);
  assert.equal(mismatched.isError, true);
  assert.match(mismatched.content[0]!.text, /cited message is not the delivery being handled/);
  const sent = await documentSend({ source_message_id: fromAlice.messageId, title: 'R4', format: 'markdown', content: 'x' } as any, ctx);
  assert.equal(sent.isError, true);
  assert.match(sent.content[0]!.text, /cited message is not the delivery being handled/);
  const imported = await workspacePlanImport({ message_id: fromAlice.messageId } as any, ctx);
  assert.equal(imported.isError, true);
  assert.match(imported.content[0]!.text, /cited message is not the delivery being handled/);

  const matched = await ask(fromBob.messageId);
  assert.equal(matched.isError, false, matched.content[0]?.text);
  const actionId = JSON.parse(matched.content[0]!.text).action_id as string;
  await assertBoundTo(actionId, bob, 'approval request citing its delivery');
  // With no delivery correlation (poll mode) the citation stands.
  const polled = await requestHumanApproval({
    action: 'task_create', summary: 'Track the request',
    params: { title: 'R4 polled', project_id: f.projectId, source_message_id: fromAlice.messageId },
  } as any, { ...ctx, channel_event_id: undefined });
  assert.equal(polled.isError, false, polled.content[0]?.text);
  await assertBoundTo(JSON.parse(polled.content[0]!.text).action_id as string, alice, 'poll-mode approval request');
});

test('the batch loader and the SQL rule agree for every action here, and the employee\'s creator keeps uncited requests', { skip: !canRun, timeout: 300_000 }, async () => {
  const { db } = await import('../src/lib/db.js');
  const { sql } = await import('drizzle-orm');
  const { actionRequesterIdSql, loadActionRequesterIds } = await import('../src/lib/agent-action-requester.js');
  const rows = (await f.client.query('SELECT id FROM agent_actions WHERE org_id = $1', [f.orgId])).rows as Array<{ id: string }>;
  const loaded = await loadActionRequesterIds(await Promise.all(rows.map((row) => loadAction(row.id))));
  const inSql = (await db.execute(sql`SELECT agent_actions.id, ${actionRequesterIdSql()} AS requester
    FROM agent_actions WHERE agent_actions.org_id = ${f.orgId}`)).rows as Array<{ id: string; requester: string }>;
  assert.ok(inSql.length > 10);
  for (const row of inSql) assert.equal(loaded.get(row.id), row.requester, row.id);

  // An approval request citing no message stays with the employee's creator.
  const { requestHumanApproval } = await import('../src/lib/mcp-tools/cooperative.js');
  const uncited = await requestHumanApproval({
    action: 'task_create', summary: 'Track it', params: { title: 'R4 uncited', project_id: f.projectId },
  } as any, { org_id: f.orgId, employee_id: employeeE, employee_slug: 'r4-e', trust_level: 'conservative' } as any);
  assert.equal(uncited.isError, false, uncited.content[0]?.text);
  assert.equal(await requesterOf(JSON.parse(uncited.content[0]!.text).action_id as string), f.adminId);
});
