/**
 * The approval resolver and the personal MCP approval tools apply the web's
 * reviewer rule and room check: an action whose requester is an active human
 * member is reviewed by that requester only; otherwise by active owners and
 * admins who can see the action's room. App Run and record-mirror rows keep
 * the resolver's own rules on the resolver.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/approval-reviewer-rule-resolver-mcp-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { approveAction, rejectAction } from '../src/lib/agent-approval-resolver.js';
import {
  humanApprovalApprove,
  humanApprovalGet,
  humanApprovalList,
  humanApprovalReject,
} from '../src/lib/mcp-tools/human.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;
let employeeId: string;
let shadowId: string;
let outsideAdminId: string;
let departedId: string;
let defty: { userId: string; employeeId: string };
const otherOrg = { orgId: randomUUID(), adminId: randomUUID() };
const roles: Record<string, 'owner' | 'admin' | 'member' | 'guest'> = {};

async function addMember(role: 'admin' | 'member', active = true): Promise<string> {
  const id = randomUUID();
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, $3, 'human', false, true)`,
    [id, `al1-${id}@example.test`, `AL1 ${role} ${id.slice(0, 4)}`],
  );
  await f.client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, $5)',
    [randomUUID(), f.orgId, id, role, active]);
  roles[id] = role;
  return id;
}

async function room(members: string[]): Promise<string> {
  const id = randomUUID();
  await f.client.query(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, 'private', $4)`,
    [id, f.orgId, `al1-room-${id.slice(0, 8)}`, f.requesterId]);
  for (const user of members) {
    await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), id, user]);
  }
  return id;
}

async function leaveRoom(spaceId: string, userId: string): Promise<void> {
  await f.client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, userId]);
}

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('AL1');
  roles[f.requesterId] = 'member';
  roles[f.otherId] = 'member';
  roles[f.adminId] = 'admin';
  employeeId = randomUUID();
  shadowId = randomUUID();
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, $3, 'agent', true, true)`,
    [shadowId, `al1-agent-${shadowId}@example.test`, `AL1 agent ${shadowId.slice(0, 4)}`],
  );
  await f.client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
    [randomUUID(), f.orgId, shadowId, 'member']);
  await f.client.query(
    `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'AL1 agent', $4, 'project_manager', 'Fixture', 'conservative', true, true, $5)`,
    [employeeId, f.orgId, shadowId, `al1-agent-${employeeId.slice(0, 8)}`, f.requesterId],
  );
  await f.client.query('UPDATE users SET agent_employee_id = $2 WHERE id = $1', [shadowId, employeeId]);
  outsideAdminId = await addMember('admin');
  departedId = await addMember('member', false);
  const { ensureDeftyEmployee } = await import('../src/lib/ensure-defty-membership.js');
  defty = await ensureDeftyEmployee(f.orgId);
  await f.client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)',
    [otherOrg.orgId, 'AL1 other', `al1-other-${otherOrg.orgId.slice(0, 8)}`]);
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, 'AL1 other admin', 'human', false, true)`,
    [otherOrg.adminId, `al1-other-${otherOrg.adminId}@example.test`],
  );
  await f.client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
    [randomUUID(), otherOrg.orgId, otherOrg.adminId, 'admin']);
});

after(async () => {
  if (!f) return;
  await f.client.query('DELETE FROM oauth_audit_events WHERE org_id = $1', [f.orgId]).catch(() => undefined);
  await f.client.query('DELETE FROM org_members WHERE org_id = $1', [otherOrg.orgId]).catch(() => undefined);
  await f.client.query('DELETE FROM orgs WHERE id = $1', [otherOrg.orgId]).catch(() => undefined);
  await f.client.query('DELETE FROM users WHERE id = $1', [otherOrg.adminId]).catch(() => undefined);
  await f.teardown();
});

const ctx = (userId: string, orgId = f.orgId, role = roles[userId] ?? 'admin') => ({
  org_id: orgId, user_id: userId, role, scopes: ['read:workspace', 'write:workspace'],
});

/** A pending employee write requested by `userId`. */
async function proposal(userId: string, title = `al1 ${randomUUID()}`): Promise<string> {
  const id = randomUUID();
  await f.client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, $4, 'mcp', 'task_create', $5::jsonb, 'full', 'pending')`,
    [id, f.orgId, userId, employeeId, JSON.stringify({ title, project_id: f.projectId })],
  );
  return id;
}

/** A pending Defty capture of a message `authorId` wrote in `spaceId`. */
async function capture(authorId: string, spaceId: string): Promise<string> {
  const id = randomUUID();
  const title = `AL1 capture ${id.slice(0, 8)}`;
  await f.client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, $4, 'defty_capture', 'wiki_create', $5::jsonb, 'quick', 'pending')`,
    [id, f.orgId, defty.userId, defty.employeeId, JSON.stringify({
      title, content: `Decision: ${title}.`, summary: title, type: 'decision', scope: 'org',
      space_id: spaceId, source_space_id: spaceId, source_user_id: authorId,
      capture_kind: 'decision_candidate', proposed_by: 'defty',
    })],
  );
  return id;
}

async function status(actionId: string): Promise<string> {
  return (await f.client.query('SELECT approval_status FROM agent_actions WHERE id = $1', [actionId])).rows[0].approval_status;
}

const code = (result: unknown) => (result as { code?: string }).code;
const text = (result: { content?: Array<{ text?: string }> }) => (result.content ?? []).map((part) => part.text ?? '').join('');
const listed = async (userId: string, actionId: string, orgId = f.orgId) =>
  text(await humanApprovalList({ status: 'all', limit: 100 }, ctx(userId, orgId))).includes(actionId);
const opened = async (userId: string, actionId: string, orgId = f.orgId) =>
  (await humanApprovalGet({ action_id: actionId }, ctx(userId, orgId))).isError !== true;

test('AL1-1: the resolver refuses an owner/admin decision on an active member\'s action; the requester decides it', { skip: !canRun }, async () => {
  const actionId = await proposal(f.requesterId);
  assert.equal(code(await approveAction(actionId, f.adminId)), 'FORBIDDEN');
  assert.equal(code(await rejectAction(actionId, f.adminId)), 'FORBIDDEN');
  assert.equal(await status(actionId), 'pending');
  assert.equal((await approveAction(actionId, f.requesterId)).status, 'approved');
  assert.equal(await status(actionId), 'approved');
});

test('AL1-2: personal MCP serves an active member\'s action to that member only', { skip: !canRun }, async () => {
  const actionId = await proposal(f.requesterId);
  assert.equal(await listed(f.adminId, actionId), false);
  assert.equal(await opened(f.adminId, actionId), false);
  assert.equal((await humanApprovalApprove({ action_id: actionId }, ctx(f.adminId))).isError, true);
  assert.equal((await humanApprovalReject({ action_id: actionId }, ctx(f.adminId))).isError, true);
  assert.equal(await status(actionId), 'pending');

  assert.equal(await listed(f.requesterId, actionId), true);
  assert.equal(await opened(f.requesterId, actionId), true);
  const approved = await humanApprovalApprove({ action_id: actionId }, ctx(f.requesterId));
  assert.notEqual(approved.isError, true, text(approved));
  assert.equal(await status(actionId), 'approved');

  const rejected = await proposal(f.requesterId);
  assert.notEqual((await humanApprovalReject({ action_id: rejected }, ctx(f.requesterId))).isError, true);
  assert.equal(await status(rejected), 'rejected');
});

test('AL1-3: without an active human requester, owners/admins who can see the room review it; members and admins outside the room do not', { skip: !canRun }, async () => {
  const agentRequested = await proposal(shadowId);
  assert.equal(await opened(f.otherId, agentRequested), false);
  assert.equal((await humanApprovalApprove({ action_id: agentRequested }, ctx(f.otherId))).isError, true);
  assert.equal(code(await approveAction(agentRequested, f.otherId)), 'FORBIDDEN');
  assert.equal(await status(agentRequested), 'pending');
  const approved = await humanApprovalApprove({ action_id: agentRequested }, ctx(f.adminId));
  assert.notEqual(approved.isError, true, text(approved));
  assert.equal(await status(agentRequested), 'approved');

  const spaceId = await room([f.requesterId, f.adminId]);
  const departedCapture = await capture(departedId, spaceId);
  assert.equal(await listed(outsideAdminId, departedCapture), false);
  assert.equal(await opened(outsideAdminId, departedCapture), false);
  assert.equal((await humanApprovalReject({ action_id: departedCapture }, ctx(outsideAdminId))).isError, true);
  assert.equal(code(await rejectAction(departedCapture, outsideAdminId)), 'FORBIDDEN');
  assert.equal(code(await approveAction(departedCapture, outsideAdminId)), 'FORBIDDEN');
  assert.equal(await status(departedCapture), 'pending');
  assert.equal(await listed(f.adminId, departedCapture), true);
  assert.equal(await opened(f.adminId, departedCapture), true);
  assert.notEqual((await humanApprovalReject({ action_id: departedCapture }, ctx(f.adminId))).isError, true);
  assert.equal(await status(departedCapture), 'rejected');
});

test('AL1-4: a capture from a room its requester has left is not listed, opened or decided', { skip: !canRun }, async () => {
  const spaceId = await room([f.requesterId, f.adminId]);
  const actionId = await capture(f.requesterId, spaceId);
  assert.equal(await listed(f.requesterId, actionId), true);
  await leaveRoom(spaceId, f.requesterId);
  assert.equal(await listed(f.requesterId, actionId), false);
  assert.equal(await opened(f.requesterId, actionId), false);
  assert.equal((await humanApprovalApprove({ action_id: actionId }, ctx(f.requesterId))).isError, true);
  assert.equal((await humanApprovalReject({ action_id: actionId }, ctx(f.requesterId))).isError, true);
  assert.equal(code(await rejectAction(actionId, f.requesterId)), 'FORBIDDEN');
  assert.equal(code(await approveAction(actionId, f.requesterId)), 'FORBIDDEN');
  assert.equal(await status(actionId), 'pending');
});

test('AL1-5: an internal capture approval needs the author to see the source room', { skip: !canRun }, async () => {
  const spaceId = await room([f.requesterId, f.adminId, defty.userId]);
  const actionId = await capture(f.requesterId, spaceId);
  await leaveRoom(spaceId, f.requesterId);
  assert.equal(code(await approveAction(actionId, defty.userId, { internal: true })), 'FORBIDDEN');
  assert.equal(await status(actionId), 'pending');
});

test('AL1-6: an idempotency key answers only for its own action and only while the caller may still see it', { skip: !canRun }, async () => {
  const key = `al1-${randomUUID()}`;
  const first = await proposal(f.requesterId, 'AL1 first');
  const second = await proposal(f.requesterId, 'AL1 second');
  const a = await humanApprovalApprove({ action_id: first, idempotency_key: key }, ctx(f.requesterId));
  assert.notEqual(a.isError, true, text(a));
  const b = await humanApprovalApprove({ action_id: second, idempotency_key: key }, ctx(f.requesterId));
  assert.notEqual(b.isError, true, text(b));
  assert.equal(await status(second), 'approved');
  assert.equal(text(b).includes('AL1 first'), false);

  const spaceId = await room([f.requesterId, f.adminId]);
  const captured = await capture(f.requesterId, spaceId);
  const rejectKey = `al1-${randomUUID()}`;
  const rejected = await humanApprovalReject({ action_id: captured, idempotency_key: rejectKey }, ctx(f.requesterId));
  assert.notEqual(rejected.isError, true, text(rejected));
  await leaveRoom(spaceId, f.requesterId);
  const replay = await humanApprovalReject({ action_id: captured, idempotency_key: rejectKey }, ctx(f.requesterId));
  assert.equal(replay.isError, true);
  assert.equal(text(replay).includes('rejected'), false);
});

test('AL1-7: record-mirror rows keep the resolver\'s rules; MCP applies the web gate to them', { skip: !canRun }, async () => {
  const nomination = async () => {
    const id = randomUUID();
    await f.client.query(
      `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
       VALUES ($1, $2, $3, $4, 'mcp', 'app_record_mirror_nominate', '{}'::jsonb, 'full', 'pending')`,
      [id, f.orgId, f.requesterId, employeeId],
    );
    return id;
  };
  const byAdmin = await nomination();
  assert.equal((await rejectAction(byAdmin, f.adminId)).status, 'rejected');
  const overMcp = await nomination();
  assert.equal(await opened(f.adminId, overMcp), false);
  assert.equal((await humanApprovalReject({ action_id: overMcp }, ctx(f.adminId))).isError, true);
  assert.equal(await status(overMcp), 'pending');
  assert.equal(code(await approveAction(overMcp, f.adminId)), 'FORBIDDEN');
});

test('AL1-8: an admin of another workspace sees and decides nothing', { skip: !canRun }, async () => {
  const actionId = await proposal(shadowId);
  assert.equal(await listed(otherOrg.adminId, actionId, otherOrg.orgId), false);
  assert.equal(await opened(otherOrg.adminId, actionId, otherOrg.orgId), false);
  assert.equal((await humanApprovalApprove({ action_id: actionId }, ctx(otherOrg.adminId, otherOrg.orgId, 'admin'))).isError, true);
  assert.equal((await humanApprovalReject({ action_id: actionId }, ctx(otherOrg.adminId, otherOrg.orgId, 'admin'))).isError, true);
  assert.equal(code(await approveAction(actionId, otherOrg.adminId)), 'FORBIDDEN');
  assert.equal(code(await rejectAction(actionId, otherOrg.adminId)), 'FORBIDDEN');
  assert.equal(await status(actionId), 'pending');
});

test('AL1-9: a stored result recorded without its action answers no later call', { skip: !canRun }, async () => {
  const key = `al1-${randomUUID()}`;
  await f.client.query(
    `INSERT INTO oauth_audit_events (id, org_id, user_id, client_id, event, metadata)
     VALUES ($1, $2, $3, 'personal-token:unknown', 'mcp_idempotency_result', $4::jsonb)`,
    [randomUUID(), f.orgId, f.requesterId, JSON.stringify({
      tool_name: 'approval_approve', idempotency_key: key, fallback_signature: null,
      result: { content: [{ type: 'text', text: 'AL1-STORED-CANARY' }] },
    })],
  );
  const actionId = await proposal(f.requesterId);
  const result = await humanApprovalApprove({ action_id: actionId, idempotency_key: key }, ctx(f.requesterId));
  assert.notEqual(result.isError, true, text(result));
  assert.equal(text(result).includes('AL1-STORED-CANARY'), false);
  assert.equal(await status(actionId), 'approved');
});
