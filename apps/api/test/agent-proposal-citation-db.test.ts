/**
 * An agent employee's queued task, chat, wiki and module record proposals may
 * cite the chat message they answer (`source_message_id`). The server verifies
 * the citation (same org, a room the employee is a member of), stores it as
 * the proposal's `message_id`, and a proposal that answers a member's message
 * is reviewed by that member. A call handling the delivery of one message that
 * cites another is refused before it writes anything. The citation never
 * changes whether a call needs approval.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-proposal-citation-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;
let bob: string; // member
let alice: string; // member
let outsideAdmin: string; // admin in no room below
let inRoomAdmin: string; // admin in the shared room
let owner: string;
let employeeE: string;
let shadowE: string;
let room: string; // private: bob, alice, inRoomAdmin, E
let lonelyRoom: string; // private: alice only
let taskId: string;
let moduleId: string;
let manifestDigest: string;
let foreignOrg: string;
let foreignMessage: string;
const extraUsers: string[] = [];
const SLUG = 'r4b-e';

type Tool = (args: any, ctx: ToolContext) => Promise<ToolResult>;
type Tools = Record<string, Tool>;
let tools: Tools;

async function addUser(label: string, role: string, kind = 'human'): Promise<string> {
  const id = randomUUID();
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, $3, $4, $5, true)`,
    [id, `r4b-${label}-${id}@example.test`, `R4b ${label}`, kind, kind === 'agent'],
  );
  await f.client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
    [randomUUID(), f.orgId, id, role]);
  extraUsers.push(id);
  return id;
}

async function addSpace(type: string, members: string[]): Promise<string> {
  const id = randomUUID();
  await f.client.query('INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, $4, $5)',
    [id, f.orgId, `r4b-${type}-${id.slice(0, 8)}`, type, members[0]]);
  for (const user of members) {
    await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), id, user]);
  }
  return id;
}

/** A message from `author` addressed to the employee, run through the message worker. */
async function addressed(author: string, spaceId: string) {
  const { handleAgentEmployeeMessage } = await import('../src/workers/handlers/agent-employee-message.js');
  const messageId = randomUUID();
  await f.client.query('INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)',
    [messageId, f.orgId, spaceId, author, `please handle ${messageId.slice(0, 6)}`]);
  await handleAgentEmployeeMessage({
    id: randomUUID(), name: 'agent-employee-message',
    data: { messageId, spaceId, orgId: f.orgId, employeeId: employeeE, isDM: false },
  } as any);
  const event = (await f.client.query(
    `SELECT id FROM agent_channel_events WHERE org_id = $1 AND agent_employee_id = $2 AND idempotency_key = $3`,
    [f.orgId, employeeE, `message:${messageId}:employee:${employeeE}`],
  )).rows[0] as { id: string } | undefined;
  assert.ok(event, 'the worker records the delivery');
  return { messageId, eventId: event.id };
}

function ctxFor(trust: string, channelEventId?: string): ToolContext {
  return {
    org_id: f.orgId, employee_id: employeeE, employee_slug: SLUG, trust_level: trust,
    ...(channelEventId ? { channel_event_id: channelEventId } : {}),
  } as ToolContext;
}

function text(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

function queuedId(result: ToolResult, label: string): string {
  assert.notEqual(result.isError, true, `${label}: ${text(result)}`);
  const body = JSON.parse(text(result));
  assert.equal(body.status, 'queued_for_approval', `${label}: ${text(result)}`);
  return body.approval_id as string;
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

let seq = 0;
/** One call of each tool family, citing `messageId` when given. */
function calls(messageId?: string): Array<[string, string, Record<string, unknown>]> {
  const cite = messageId === undefined ? {} : { source_message_id: messageId };
  const n = ++seq;
  return [
    ['task_create', 'task_create', { caller_employee_slug: SLUG, title: `R4b task ${n}`, project_id: f.projectId, ...cite }],
    ['task_update', 'task_update', { caller_employee_slug: SLUG, task_id: taskId, patch: { title: `R4b renamed ${n}` }, ...cite }],
    ['wiki_create', 'wiki_create', { caller_employee_slug: SLUG, title: `R4b page ${n} ${randomUUID().slice(0, 6)}`, content: 'R4b knowledge', ...cite }],
    ['module_record_create', 'module_record_create', {
      caller_employee_slug: SLUG, module_id: moduleId, collection_key: 'assets', data: { serial: `R4b-${n}-${randomUUID().slice(0, 6)}` },
      expected_manifest_digest: manifestDigest, idempotency_key: `r4b-${n}-${randomUUID()}`, ...cite,
    }],
  ];
}

function chatCalls(messageId?: string): Array<[string, string, Record<string, unknown>]> {
  const cite = messageId === undefined ? {} : { source_message_id: messageId };
  const n = ++seq;
  return [
    ['send_message', 'send_message', { caller_employee_slug: SLUG, target: { space_id: room }, content: `R4b reply ${n}`, ...cite }],
    ['message_post', 'message_post', { caller_employee_slug: SLUG, space_id: room, content: `R4b post ${n}`, ...cite }],
  ];
}

async function setUnhealthy(value: boolean) {
  await f.client.query('UPDATE agent_employees SET unhealthy = $2 WHERE id = $1', [employeeE, value]);
}

/** Runs each call; the employee's own chat posts queue only while it is unhealthy. */
async function eachQueued(
  messageId: string | undefined,
  ctx: ToolContext,
  check: (label: string, actionId: string) => Promise<void>,
) {
  for (const [label, name, args] of calls(messageId)) await check(label, queuedId(await tools[name]!(args, ctx), label));
  await setUnhealthy(true);
  try {
    for (const [label, name, args] of chatCalls(messageId)) await check(label, queuedId(await tools[name]!(args, ctx), label));
  } finally {
    await setUnhealthy(false);
  }
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of ['agent_actions', 'messages', 'spaces', 'tasks', 'wiki_pages', 'module_records', 'task_activity']) {
    out[table] = (await f.client.query(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [f.orgId])).rows[0].n;
  }
  out.task_title = (await f.client.query('SELECT title FROM tasks WHERE id = $1', [taskId])).rows[0].title;
  return out;
}

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('R4B');
  bob = f.requesterId;
  alice = f.otherId;
  outsideAdmin = f.adminId;
  inRoomAdmin = await addUser('room-admin', 'admin');
  owner = await addUser('owner', 'owner');
  shadowE = await addUser('agent-e', 'member', 'agent');
  employeeE = randomUUID();
  await f.client.query(
    `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'R4b E', $4, 'project_manager', 'Fixture', 'conservative', true, true, $5)`,
    [employeeE, f.orgId, shadowE, SLUG, f.adminId],
  );
  await f.client.query('UPDATE users SET agent_employee_id = $2 WHERE id = $1', [shadowE, employeeE]);
  room = await addSpace('private', [bob, alice, inRoomAdmin, shadowE]);
  lonelyRoom = await addSpace('private', [alice]);
  taskId = randomUUID();
  await f.client.query(
    `INSERT INTO tasks (id, org_id, project_id, number, title, created_by, metadata) VALUES ($1, $2, $3, 9001, 'R4b target', $4, '{}')`,
    [taskId, f.orgId, f.projectId, bob],
  );

  const { humanModuleActor, installModuleFromManifest, updateModuleInstallation } = await import('../src/lib/module-service.js');
  const slug = `r4b-assets-${randomUUID().slice(0, 8)}`;
  const actor = humanModuleActor({ orgId: f.orgId, userId: owner, role: 'owner', source: 'rest' });
  const installation = await installModuleFromManifest(actor, {
    schema_version: '1', id: `test.deft.${slug}`, slug, version: '1.0.0', name: 'R4b assets',
    collections: [{
      key: 'assets', name: 'Assets', singular_name: 'Asset',
      fields: [{ key: 'serial', label: 'Serial', type: 'text', required: true }],
      search: { title_field: 'serial', fields: ['serial'] },
      views: [{ key: 'all', name: 'All assets', type: 'table', fields: ['serial'] }],
    }],
  } as any, { source: 'sideloaded' });
  await updateModuleInstallation(actor, slug, { agent_access: 'write' });
  moduleId = installation.module_id;
  manifestDigest = installation.manifest_digest;

  foreignOrg = randomUUID();
  await f.client.query("INSERT INTO orgs (id, name, slug, trust_level) VALUES ($1, 'R4b foreign', $2, 'standard')",
    [foreignOrg, `r4b-foreign-${foreignOrg.slice(0, 8)}`]);
  const foreignSpace = randomUUID();
  await f.client.query("INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, 'r4b foreign', 'private', $3)",
    [foreignSpace, foreignOrg, bob]);
  await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), foreignSpace, shadowE]);
  foreignMessage = randomUUID();
  await f.client.query('INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)',
    [foreignMessage, foreignOrg, foreignSpace, bob, 'foreign']);

  const writes = await import('../src/lib/mcp-tools/writes.js');
  const wiki = await import('../src/lib/mcp-tools/wiki-create.js');
  const modules = await import('../src/lib/mcp-tools/modules.js');
  tools = {
    task_create: writes.taskCreate as Tool,
    task_update: writes.taskUpdate as Tool,
    send_message: writes.sendMessage as Tool,
    message_post: writes.messagePost as Tool,
    wiki_create: wiki.wikiCreate as Tool,
    wiki_update: wiki.wikiUpdate as Tool,
    ...(modules.MODULE_MCP_WRITE_TOOLS as Tools),
    ...(modules.MODULE_MCP_READ_TOOLS as Tools),
  };
});

after(async () => {
  if (!f) return;
  for (const table of ['action_receipts', 'module_mutation_receipts', 'agent_mcp_call_audit', 'cross_references',
    'module_record_relations', 'module_records', 'module_versions', 'module_installations', 'agent_channel_events']) {
    await f.client.query(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [[f.orgId, foreignOrg]]).catch(() => undefined);
  }
  await f.client.query('DELETE FROM messages WHERE org_id = $1', [foreignOrg]).catch(() => undefined);
  await f.client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = ANY($1::text[]))',
    [[f.orgId, foreignOrg]]).catch(() => undefined);
  await f.client.query('DELETE FROM spaces WHERE org_id = $1', [foreignOrg]).catch(() => undefined);
  await f.client.query('DELETE FROM orgs WHERE id = $1', [foreignOrg]).catch(() => undefined);
  await f.teardown();
});

test('a member who messaged the employee in a private room reviews each queued proposal that cites the message', { skip: !canRun, timeout: 900_000 }, async () => {
  const fromBob = await addressed(bob, room);
  await eachQueued(fromBob.messageId, ctxFor('conservative', fromBob.eventId), async (label, actionId) => {
    assert.equal((await loadAction(actionId)).message_id, fromBob.messageId, `${label} stores the citation`);
    assert.equal(await requesterOf(actionId), bob, `${label} requester`);
    assert.deepEqual(await reviewersOf(actionId), [bob], `${label} reviewers`);
  });
  // Poll mode (no delivery being handled) cites the held message too.
  const [label, name, args] = calls(fromBob.messageId)[0]!;
  const polled = queuedId(await tools[name]!(args, ctxFor('conservative')), `${label} polled`);
  assert.equal(await requesterOf(polled), bob);
});

test('a proposal without a citation carries no message and keeps its reviewers', { skip: !canRun, timeout: 900_000 }, async () => {
  await eachQueued(undefined, ctxFor('conservative'), async (label, actionId) => {
    const row = await loadAction(actionId);
    assert.equal(row.message_id, null, label);
    assert.equal(await requesterOf(actionId), row.user_id, `${label} requester`);
    assert.ok((await reviewersOf(actionId)).includes(outsideAdmin), `${label} admins review`);
  });
});

test('a citation that does not bind still limits the fallback reviewers to people who can read its room', { skip: !canRun, timeout: 900_000 }, async () => {
  const fromBob = await addressed(bob, room);
  await f.client.query(`UPDATE agent_channel_events SET created_at = created_at - interval '25 hours' WHERE id = $1`, [fromBob.eventId]);
  const [label, name, args] = calls(fromBob.messageId)[0]!;
  const actionId = queuedId(await tools[name]!(args, ctxFor('conservative')), label);
  assert.equal((await loadAction(actionId)).message_id, fromBob.messageId);
  assert.equal(await requesterOf(actionId), shadowE, 'older than 24 hours: not bound');
  const { viewerReviewAuthority } = await import('../src/lib/agent-approval-resolver.js');
  const canApprove = async (id: string, role: string) => Boolean(
    (await viewerReviewAuthority({ id, org_id: f.orgId, role }, [actionId])).get(actionId)?.viewer_can_approve);
  assert.equal(await canApprove(inRoomAdmin, 'admin'), true, 'an admin in the room reviews');
  assert.equal(await canApprove(outsideAdmin, 'admin'), false, 'an admin outside the room does not');
  assert.equal(await canApprove(bob, 'member'), false, 'the author does not');
});

test('a call citing a message other than the delivery it handles is refused before it writes anything', { skip: !canRun, timeout: 900_000 }, async () => {
  const fromBob = await addressed(bob, room);
  const fromAlice = await addressed(alice, room);
  const before = await counts();
  for (const trust of ['conservative', 'autonomous']) {
    const delivery = ctxFor(trust, fromBob.eventId);
    const all = [
      ...calls(fromAlice.messageId),
      ...chatCalls(fromAlice.messageId),
      ['send_message dm', 'send_message', { caller_employee_slug: SLUG, target: { user_id: alice }, content: 'R4b dm', source_message_id: fromAlice.messageId }],
      ['wiki_update', 'wiki_update', { caller_employee_slug: SLUG, slug: 'r4b-missing', patch: { content: 'x' }, source_message_id: fromAlice.messageId }],
      ['module_record_task_link', 'module_record_task_link', {
        caller_employee_slug: SLUG, resource_id: 'module_record:r4b', task_identifier: taskId, idempotency_key: `r4b-link-${randomUUID()}`,
        source_message_id: fromAlice.messageId,
      }],
    ] as Array<[string, string, Record<string, unknown>]>;
    for (const [label, name, args] of all) {
      const result = await tools[name]!(args, delivery);
      assert.equal(result.isError, true, `${trust} ${label}: ${text(result)}`);
      assert.match(text(result), /cited message is not the delivery being handled/, `${trust} ${label}`);
    }
  }
  assert.deepEqual(await counts(), before, 'nothing was written, posted or queued');
});

test('the citation never changes whether a call needs approval', { skip: !canRun, timeout: 900_000 }, async () => {
  const fromBob = await addressed(bob, room);
  const delivery = ctxFor('conservative', fromBob.eventId);
  // The employee's own chat post still posts at once.
  for (const [label, name, args] of chatCalls(fromBob.messageId)) {
    const result = await tools[name]!(args, delivery);
    assert.notEqual(result.isError, true, `${label}: ${text(result)}`);
    const body = JSON.parse(text(result));
    assert.notEqual(body.status, 'queued_for_approval', label);
    const posted = await f.client.query('SELECT id FROM messages WHERE id = $1 AND space_id = $2', [body.id ?? body.message_id, room]);
    assert.equal(posted.rows.length, 1, `${label} posted`);
  }
  // A call allowed at its trust level still runs at once.
  const [, , taskArgs] = calls(fromBob.messageId)[0]!;
  const created = await tools.task_create!(taskArgs, ctxFor('autonomous', fromBob.eventId));
  assert.notEqual(created.isError, true, text(created));
  const createdBody = JSON.parse(text(created));
  assert.notEqual(createdBody.status, 'queued_for_approval');
  assert.equal(createdBody.source_message_id, fromBob.messageId);
  // A call that queues without a citation still queues with one (covered per tool
  // in the first test); here the same post with and without a citation agree.
  await setUnhealthy(true);
  try {
    for (const cite of [undefined, fromBob.messageId]) {
      const [label, name, args] = chatCalls(cite)[0]!;
      queuedId(await tools[name]!(args, delivery), `${label} unhealthy cited=${Boolean(cite)}`);
    }
  } finally {
    await setUnhealthy(false);
  }
});

test('an unreadable, deleted or other-workspace citation is refused', { skip: !canRun, timeout: 900_000 }, async () => {
  const inLonelyRoom = randomUUID();
  await f.client.query('INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)',
    [inLonelyRoom, f.orgId, lonelyRoom, alice, 'not for the employee']);
  const deleted = await addressed(bob, room);
  await f.client.query('UPDATE messages SET is_deleted = true WHERE id = $1', [deleted.messageId]);
  const before = await counts();
  for (const citation of [randomUUID(), inLonelyRoom, deleted.messageId, foreignMessage]) {
    for (const trust of ['conservative', 'autonomous']) {
      for (const [label, name, args] of [...calls(citation), ...chatCalls(citation)]) {
        const result = await tools[name]!(args, ctxFor(trust));
        assert.equal(result.isError, true, `${trust} ${label}: ${text(result)}`);
        assert.match(text(result), /source message is unavailable/, `${trust} ${label}`);
      }
    }
  }
  assert.deepEqual(await counts(), before, 'nothing was written, posted or queued');
});

test('module tools accept the citation on writes only and still refuse any other unknown key', { skip: !canRun, timeout: 900_000 }, async () => {
  const fromBob = await addressed(bob, room);
  const [, , args] = calls(fromBob.messageId)[3]!;
  const extra = await tools.module_record_create!({ ...args, unexpected: true }, ctxFor('conservative'));
  assert.equal(extra.isError, true, text(extra));
  const read = await tools.module_record_query!({
    caller_employee_slug: SLUG, module_id: moduleId, collection_key: 'assets', source_message_id: fromBob.messageId,
  }, ctxFor('conservative'));
  assert.equal(read.isError, true, text(read));
  const { MODULE_MCP_TOOL_SCHEMAS } = await import('../src/lib/mcp-tools/modules.js');
  for (const schema of MODULE_MCP_TOOL_SCHEMAS) {
    const properties = (schema.inputSchema as { properties: Record<string, unknown> }).properties;
    const write = !(schema.annotations as { readOnlyHint: boolean }).readOnlyHint;
    assert.equal('source_message_id' in properties, write, String(schema.name));
  }
});
