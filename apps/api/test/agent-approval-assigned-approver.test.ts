/**
 * Lane W2 approval recovery — assigned approvers.
 *
 * An `agent_action_approvers` row assigns a reviewer to a pending action.
 * An assignment counts only when it names one of the action's reviewers (its
 * requester when an active human member, otherwise an owner/admin), so it
 * never admits anyone else, on the routes or in the approval resolver.
 * Action-specific rules that are stricter still apply.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-approval-assigned-approver.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { approveAction, rejectAction } from '../src/lib/agent-approval-resolver.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;
let employeeId: string;
let shadowId: string;
let guestId: string;
let removedId: string;

async function addMember(role: string, active: boolean): Promise<string> {
  const id = randomUUID();
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, $3, 'human', false, true)`,
    [id, `assigned-${id}@example.test`, `Assigned ${role} ${id.slice(0, 4)}`],
  );
  await f.client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, $5)',
    [randomUUID(), f.orgId, id, role, active]);
  return id;
}

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('AA');
  employeeId = randomUUID();
  shadowId = randomUUID();
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, $3, 'agent', true, true)`,
    [shadowId, `assigned-agent-${shadowId}@example.test`, `Assigned agent ${shadowId.slice(0, 4)}`],
  );
  await f.client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
    [randomUUID(), f.orgId, shadowId, 'member']);
  await f.client.query(
    `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'Assigned agent', $4, 'project_manager', 'Fixture', 'conservative', true, true, $5)`,
    [employeeId, f.orgId, shadowId, `assigned-agent-${employeeId.slice(0, 8)}`, f.requesterId],
  );
  await f.client.query('UPDATE users SET agent_employee_id = $2 WHERE id = $1', [shadowId, employeeId]);
  guestId = await addMember('guest', true);
  removedId = await addMember('member', false);
});

after(async () => {
  if (f) await f.teardown();
});

/** A pending employee write, resolved by the approval resolver. */
async function employeeProposal(title = `assigned ${randomUUID()}`): Promise<string> {
  const id = randomUUID();
  await f.client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, $4, 'mcp', 'task_create', $5::jsonb, 'full', 'pending')`,
    [id, f.orgId, shadowId, employeeId, JSON.stringify({ title, project_id: f.projectId })],
  );
  return id;
}

async function assign(actionId: string, userId: string, orgId = f.orgId): Promise<void> {
  await f.client.query(
    `INSERT INTO agent_action_approvers (id, org_id, action_id, user_id, decision) VALUES ($1, $2, $3, $4, 'pending')`,
    [randomUUID(), orgId, actionId, userId],
  );
}

async function status(actionId: string): Promise<string> {
  return (await f.client.query('SELECT approval_status FROM agent_actions WHERE id = $1', [actionId])).rows[0].approval_status;
}

test('B-a: an assignment naming a member who is not a reviewer does not let them approve', { skip: !canRun }, async () => {
  const actionId = await employeeProposal();
  await assign(actionId, f.otherId);
  const response = await f.as(f.otherId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(response.status, 404, await response.clone().text());
  assert.equal(((await approveAction(actionId, f.otherId)) as { code?: string }).code, 'FORBIDDEN');
  assert.equal(await status(actionId), 'pending');
  // The action's reviewers (owners/admins, as its own user is an agent) still decide it.
  const admin = await f.as(f.adminId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(admin.status, 200, await admin.clone().text());
  assert.equal(await status(actionId), 'approved');
});

test('B-b: an assignment naming a member who is not a reviewer does not let them reject', { skip: !canRun }, async () => {
  const actionId = await employeeProposal();
  await assign(actionId, f.otherId);
  const response = await f.as(f.otherId, `/api/agent/actions/${actionId}/reject`, {
    method: 'POST', body: JSON.stringify({ reason: 'not now' }), headers: { 'content-type': 'application/json' },
  });
  assert.equal(response.status, 404, await response.clone().text());
  assert.equal(((await rejectAction(actionId, f.otherId)) as { code?: string }).code, 'FORBIDDEN');
  assert.equal(await status(actionId), 'pending');
});

test('B-c: a member who is not assigned is still refused', { skip: !canRun }, async () => {
  const actionId = await employeeProposal();
  await assign(actionId, f.adminId);
  assert.equal((await approveAction(actionId, f.otherId)).status, 'error');
  assert.equal(((await approveAction(actionId, f.otherId)) as { code?: string }).code, 'FORBIDDEN');
  assert.equal(((await rejectAction(actionId, f.otherId)) as { code?: string }).code, 'FORBIDDEN');
  const route = await f.as(f.otherId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(route.status, 404);
  assert.equal(await status(actionId), 'pending');
});

test('B-d: an assigned guest is refused', { skip: !canRun }, async () => {
  const actionId = await employeeProposal();
  await assign(actionId, guestId);
  // A guest is outside the audience of a proposal it did not request, so the route does not find it.
  const approve = await f.as(guestId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(approve.status, 404, await approve.clone().text());
  const reject = await f.as(guestId, `/api/agent/actions/${actionId}/reject`, { method: 'POST' });
  assert.equal(reject.status, 404, await reject.clone().text());
  assert.equal(await status(actionId), 'pending');
});

test('B-e: an assigned member who was removed from the workspace is refused', { skip: !canRun }, async () => {
  const actionId = await employeeProposal();
  await assign(actionId, removedId);
  assert.equal(((await approveAction(actionId, removedId)) as { code?: string }).code, 'FORBIDDEN');
  assert.equal(((await rejectAction(actionId, removedId)) as { code?: string }).code, 'FORBIDDEN');
  assert.equal(await status(actionId), 'pending');
});

test('B-f: an approver row recorded under another workspace grants nothing', { skip: !canRun }, async () => {
  const actionId = await employeeProposal();
  await assign(actionId, f.otherId, randomUUID());
  assert.equal(((await approveAction(actionId, f.otherId)) as { code?: string }).code, 'FORBIDDEN');
  assert.equal(((await rejectAction(actionId, f.otherId)) as { code?: string }).code, 'FORBIDDEN');
  assert.equal(await status(actionId), 'pending');
});

test('B-g: a record-mirror nomination stays approvable by its owner only', { skip: !canRun }, async () => {
  const actionId = randomUUID();
  await f.client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, $4, 'mcp', 'app_record_mirror_nominate', '{}'::jsonb, 'full', 'pending')`,
    [actionId, f.orgId, f.requesterId, employeeId],
  );
  await assign(actionId, f.otherId);
  const result = await approveAction(actionId, f.otherId);
  assert.equal((result as { code?: string }).code, 'FORBIDDEN');
  assert.equal(await status(actionId), 'pending');
});

test('B-h: an assigned member cannot reject a record-mirror nomination they do not own; the owner and an admin still can', { skip: !canRun }, async () => {
  const nomination = async () => {
    const actionId = randomUUID();
    await f.client.query(
      `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
       VALUES ($1, $2, $3, $4, 'mcp', 'app_record_mirror_nominate', '{}'::jsonb, 'full', 'pending')`,
      [actionId, f.orgId, f.requesterId, employeeId],
    );
    await assign(actionId, f.otherId);
    return actionId;
  };
  const refused = await nomination();
  assert.equal(((await rejectAction(refused, f.otherId)) as { code?: string }).code, 'FORBIDDEN');
  assert.equal(await status(refused), 'pending');

  const byOwner = await nomination();
  assert.equal((await rejectAction(byOwner, f.requesterId)).status, 'rejected');
  const byAdmin = await nomination();
  assert.equal((await rejectAction(byAdmin, f.adminId)).status, 'rejected');
});
