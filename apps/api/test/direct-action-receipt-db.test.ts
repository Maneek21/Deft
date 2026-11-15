/**
 * C11: a native action the built-in assistant runs directly or automatically
 * leaves exactly one signed receipt, as an approved action does.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/direct-action-receipt-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';

import { executeActionDirect } from '../src/lib/agent-actions.js';
import { recordDirectActionReceipt } from '../src/lib/direct-action-receipt.js';
import { closeDb } from '../src/lib/db.js';
import { generateReceipt } from '../src/lib/receipts.js';

const DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL;
const canRun = Boolean(DATABASE_URL);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const orgId = `direct-receipt-org-${suffix}`;
const ownerId = `direct-receipt-owner-${suffix}`;
const projectId = `direct-receipt-project-${suffix}`;

let client: pg.Client;

before(async () => {
  if (!canRun) return;
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [orgId, 'Direct receipt org', `direct-receipt-${suffix}`]);
  await client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, 'Receipt Owner', 'human', false, true)`,
    [ownerId, `direct-receipt-${suffix}@test.local`],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'owner', true)`,
    [randomUUID(), orgId, ownerId],
  );
  await client.query(
    `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES ($1, $2, 'Receipt project', $3, $4, 0)`,
    [projectId, orgId, `DR${suffix.slice(0, 5).toUpperCase()}`, ownerId],
  );
});

after(async () => {
  if (!client) return;
  for (const statement of [
    'DELETE FROM action_receipts WHERE org_id = $1',
    'DELETE FROM task_activity WHERE org_id = $1',
    'DELETE FROM audit_log WHERE org_id = $1',
    'DELETE FROM agent_actions WHERE org_id = $1',
    'DELETE FROM tasks WHERE org_id = $1',
    'DELETE FROM projects WHERE org_id = $1',
    'DELETE FROM org_members WHERE org_id = $1',
  ]) await client.query(statement, [orgId]).catch(() => undefined);
  await client.query('DELETE FROM users WHERE id = $1', [ownerId]).catch(() => undefined);
  await client.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => undefined);
  await client.end();
  await closeDb();
});

async function receipts(actionId: string) {
  return (await client.query(
    'SELECT decision, proposer, proposer_id, approver_id, decision_reason FROM action_receipts WHERE action_id = $1',
    [actionId],
  )).rows;
}

test('an automatically executed ordinary action leaves exactly one receipt', { skip: !canRun }, async () => {
  const executed = await executeActionDirect(
    'create_task',
    { title: `Receipt task ${suffix}`, resolved_project_id: projectId, priority: 'p2' },
    orgId,
    ownerId,
    null,
    'auto',
    { source: 'runner' },
  );
  assert.equal(executed.success, true, executed.error);
  const rows = await receipts(executed.actionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'auto_executed');
  assert.equal(rows[0].proposer, 'defty');
  assert.equal(rows[0].proposer_id, ownerId);
  assert.equal(rows[0].approver_id, null);
  assert.equal(rows[0].decision_reason, null);

  // Recording again, as a retry or a second path would, adds nothing.
  await recordDirectActionReceipt({
    actionId: executed.actionId, orgId, userId: ownerId, action: 'create_task', agentEmployeeId: null,
    outcome: { success: true, result: executed.result },
  });
  assert.equal((await receipts(executed.actionId)).length, 1);
});

test('an action that already has a receipt of another decision gets no second one', { skip: !canRun }, async () => {
  const actionId = randomUUID();
  await client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status, approved_at, approved_by_user_id, executed_at)
     VALUES ($1, $2, $3, 'runner', 'create_task', '{}'::jsonb, 'quick', 'approved', now(), $3, now())`,
    [actionId, orgId, ownerId],
  );
  // The approval path signed this action already, as "approved".
  await generateReceipt({ actionId, orgId, proposer: 'defty', proposerId: ownerId, approverId: ownerId,
    decision: 'approved', actionName: 'create_task', actionParams: {}, resultJson: null });
  assert.equal((await receipts(actionId)).length, 1);
  await recordDirectActionReceipt({
    actionId, orgId, userId: ownerId, action: 'create_task', agentEmployeeId: null, outcome: { success: true, result: {} },
  });
  assert.equal((await receipts(actionId)).length, 1);
});

test('a failed direct action records the failure reason', { skip: !canRun }, async () => {
  const actionId = randomUUID();
  await client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status, approved_at, executed_at, error)
     VALUES ($1, $2, $3, 'runner', 'create_task', '{}'::jsonb, 'auto', 'approved', now(), now(), 'Project not found')`,
    [actionId, orgId, ownerId],
  );
  await recordDirectActionReceipt({
    actionId, orgId, userId: ownerId, action: 'create_task', agentEmployeeId: null,
    outcome: { success: false, error: 'Project not found' },
  });
  const rows = await receipts(actionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'auto_executed');
  assert.equal(rows[0].decision_reason, 'execution failed: Project not found');
});
