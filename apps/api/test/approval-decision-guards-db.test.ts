/**
 * The approval resolver re-checks the reviewer rule inside the statements
 * that claim or apply a decision, and again before it returns anything about
 * the action: a reviewer who loses the right on the way is refused and the
 * action stays as it was, or gets no content back once it was decided.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/approval-decision-guards-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, afterEach, before } from 'node:test';

import { _setReviewerRecheckHookForTest, approveAction, rejectAction } from '../src/lib/agent-approval-resolver.js';
import { humanApprovalApprove, humanApprovalReject } from '../src/lib/mcp-tools/human.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;
let employeeId: string;
let shadowId: string;

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('AL1B');
  employeeId = randomUUID();
  shadowId = randomUUID();
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, 'AL1B agent', 'agent', true, true)`,
    [shadowId, `al1b-agent-${shadowId}@example.test`],
  );
  await f.client.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'member', true)`,
    [randomUUID(), f.orgId, shadowId]);
  await f.client.query(
    `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'AL1B agent', $4, 'project_manager', 'Fixture', 'conservative', true, true, $5)`,
    [employeeId, f.orgId, shadowId, `al1b-agent-${employeeId.slice(0, 8)}`, f.requesterId],
  );
  await f.client.query('UPDATE users SET agent_employee_id = $2 WHERE id = $1', [shadowId, employeeId]);
});

afterEach(() => _setReviewerRecheckHookForTest(null));

after(async () => {
  if (!f) return;
  await f.client.query('DELETE FROM oauth_audit_events WHERE org_id = $1', [f.orgId]).catch(() => undefined);
  await f.teardown();
});

const ctx = (userId: string, role: 'admin' | 'member') => ({
  org_id: f.orgId, user_id: userId, role, scopes: ['read:workspace', 'write:workspace'],
});
const text = (result: { content?: Array<{ text?: string }> }) => (result.content ?? []).map((part) => part.text ?? '').join('');

async function proposal(userId: string): Promise<string> {
  const id = randomUUID();
  await f.client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, $4, 'mcp', 'task_create', $5::jsonb, 'full', 'pending')`,
    [id, f.orgId, userId, employeeId, JSON.stringify({ title: `AL1B ${id.slice(0, 8)}`, project_id: f.projectId })],
  );
  return id;
}

async function setRole(userId: string, role: string): Promise<void> {
  await f.client.query('UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2', [f.orgId, userId, role]);
}

async function status(actionId: string): Promise<string> {
  return (await f.client.query('SELECT approval_status FROM agent_actions WHERE id = $1', [actionId])).rows[0].approval_status;
}

/** Runs `change` once, at the given point, for the given action. */
function onPoint(point: 'before_decision' | 'before_return', actionId: string, change: () => Promise<void>) {
  let fired = false;
  _setReviewerRecheckHookForTest(async (at, id) => {
    if (at !== point || id !== actionId || fired) return;
    fired = true;
    await change();
  });
}

test('AL1B-1: an admin demoted between the check and the claim is refused; the action stays pending', { skip: !canRun }, async () => {
  for (const decide of [humanApprovalApprove, humanApprovalReject]) {
    const actionId = await proposal(shadowId);
    onPoint('before_decision', actionId, () => setRole(f.adminId, 'member'));
    try {
      const result = await decide({ action_id: actionId }, ctx(f.adminId, 'admin'));
      assert.equal(result.isError, true, text(result));
      assert.equal(await status(actionId), 'pending');
    } finally {
      await setRole(f.adminId, 'admin');
    }
  }
});

test('AL1B-2: a requester who becomes an active member again before the claim takes the review back from the admin', { skip: !canRun }, async () => {
  for (const decide of [humanApprovalApprove, humanApprovalReject]) {
    await f.client.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [f.orgId, f.otherId]);
    const actionId = await proposal(f.otherId);
    onPoint('before_decision', actionId, async () => {
      await f.client.query('UPDATE org_members SET is_active = true WHERE org_id = $1 AND user_id = $2', [f.orgId, f.otherId]);
    });
    const result = await decide({ action_id: actionId }, ctx(f.adminId, 'admin'));
    assert.equal(result.isError, true, text(result));
    assert.equal(await status(actionId), 'pending');
  }
});

test('AL1B-3: a reviewer who loses the right after the decision gets no content back from the resolver', { skip: !canRun }, async () => {
  const approved = await proposal(shadowId);
  onPoint('before_return', approved, () => setRole(f.adminId, 'member'));
  try {
    const result = await approveAction(approved, f.adminId);
    assert.equal((result as { code?: string }).code, 'FORBIDDEN');
    assert.equal(JSON.stringify(result).includes('AL1B'), false);
    assert.equal(await status(approved), 'approved');
  } finally {
    await setRole(f.adminId, 'admin');
  }
  const rejected = await proposal(shadowId);
  onPoint('before_return', rejected, () => setRole(f.adminId, 'member'));
  try {
    const result = await rejectAction(rejected, f.adminId, 'AL1B reason');
    assert.equal((result as { code?: string }).code, 'FORBIDDEN');
    assert.equal(JSON.stringify(result).includes('AL1B reason'), false);
    assert.equal(await status(rejected), 'rejected');
  } finally {
    await setRole(f.adminId, 'admin');
  }
});

test('AL1B-4: a reviewer who keeps the right decides as before', { skip: !canRun }, async () => {
  const approved = await proposal(f.requesterId);
  const a = await humanApprovalApprove({ action_id: approved }, ctx(f.requesterId, 'member'));
  assert.notEqual(a.isError, true, text(a));
  assert.equal(await status(approved), 'approved');
  const rejected = await proposal(shadowId);
  const r = await humanApprovalReject({ action_id: rejected }, ctx(f.adminId, 'admin'));
  assert.notEqual(r.isError, true, text(r));
  assert.equal(await status(rejected), 'rejected');
});
