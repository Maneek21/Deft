/**
 * C11: a native action run directly or automatically leaves exactly one
 * signed receipt that names who actually acted, as an approved action does.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/direct-action-receipt-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { actionReceipts } from '@deft/db/schema';

import { executeActionDirect } from '../src/lib/agent-actions.js';
import { recordDirectActionReceipt } from '../src/lib/direct-action-receipt.js';
import { closeDb, db } from '../src/lib/db.js';
import { generateReceipt, verifyReceipt } from '../src/lib/receipts.js';
import { executePlan } from '../src/lib/agent-plans.js';
import { agentPlanRoutes } from '../src/routes/agent-plans.js';

const DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL;
const canRun = Boolean(DATABASE_URL);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const orgId = `direct-receipt-org-${suffix}`;
const ownerId = `direct-receipt-owner-${suffix}`;
const adminId = `direct-receipt-admin-${suffix}`;
const employeeUserId = `direct-receipt-shadow-${suffix}`;
const employeeId = `direct-receipt-employee-${suffix}`;
const projectId = `direct-receipt-project-${suffix}`;

let client: pg.Client;

before(async () => {
  if (!canRun) return;
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [orgId, 'Direct receipt org', `direct-receipt-${suffix}`]);
  await client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES
       ($1, $2, 'Receipt Owner', 'human', false, true),
       ($3, $4, 'Receipt Admin', 'human', false, true),
       ($5, NULL, 'Receipt Employee', 'agent', true, true)`,
    [ownerId, `direct-receipt-${suffix}@test.local`, adminId, `direct-receipt-admin-${suffix}@test.local`, employeeUserId],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES
       ($1, $2, $3, 'owner', true), ($4, $2, $5, 'admin', true), ($6, $2, $7, 'member', true)`,
    [randomUUID(), orgId, ownerId, randomUUID(), adminId, randomUUID(), employeeUserId],
  );
  await client.query(
    `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES ($1, $2, 'Receipt project', $3, $4, 0)`,
    [projectId, orgId, `DR${suffix.slice(0, 5).toUpperCase()}`, ownerId],
  );
  await client.query(
    `INSERT INTO agent_employees
      (id, org_id, user_id, name, slug, role, system_prompt, trust_level, max_daily_actions, daily_action_count,
       created_by, is_active, is_deleted, is_byoa)
     VALUES ($1, $2, $3, 'Receipt Employee', $4, 'project_manager', 'Receipt test', 'autonomous', 100, 0, $5, true, false, true)`,
    [employeeId, orgId, employeeUserId, `direct-receipt-${suffix}`, ownerId],
  );
});

after(async () => {
  if (!client) return;
  for (const statement of [
    'DELETE FROM job_queue WHERE org_id = $1',
    'DELETE FROM action_receipts WHERE org_id = $1',
    'DELETE FROM task_activity WHERE org_id = $1',
    'DELETE FROM audit_log WHERE org_id = $1',
    'DELETE FROM agent_actions WHERE org_id = $1',
    'DELETE FROM agent_plans WHERE org_id = $1',
    'DELETE FROM tasks WHERE org_id = $1',
    'DELETE FROM agent_employees WHERE org_id = $1',
    'DELETE FROM projects WHERE org_id = $1',
    'DELETE FROM org_members WHERE org_id = $1',
  ]) await client.query(statement, [orgId]).catch(() => undefined);
  await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[ownerId, adminId, employeeUserId]]).catch(() => undefined);
  await client.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => undefined);
  await client.end();
  await closeDb();
});

/** Every receipt for the action, each checked against its signature. */
async function receipts(actionId: string) {
  const rows = await db.select().from(actionReceipts).where(eq(actionReceipts.action_id, actionId));
  for (const row of rows) assert.equal(await verifyReceipt(row), true, 'the receipt verifies');
  return rows;
}

const createTask = (title: string) => ({ title: `${title} ${suffix}`, resolved_project_id: projectId, priority: 'p2' });

test('Defty: an automatically executed ordinary action leaves exactly one receipt', { skip: !canRun }, async () => {
  const executed = await executeActionDirect('create_task', createTask('Defty task'), orgId, ownerId, null, 'auto', { source: 'background' });
  assert.equal(executed.success, true, executed.error);
  const rows = await receipts(executed.actionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.decision, 'auto_executed');
  assert.equal(rows[0]!.proposer, 'defty');
  assert.equal(rows[0]!.proposer_id, ownerId);
  assert.equal(rows[0]!.approver_id, null);
  assert.equal(rows[0]!.decision_reason, null);
  await recordDirectActionReceipt({
    actionId: executed.actionId, orgId, userId: ownerId, action: 'create_task', agentEmployeeId: null,
    outcome: { success: true, result: executed.result },
  });
  assert.equal((await receipts(executed.actionId)).length, 1);
});

test('employee: the receipt names the agent employee', { skip: !canRun }, async () => {
  const executed = await executeActionDirect('create_task', createTask('Employee task'), orgId, employeeUserId, null, 'auto',
    { agentEmployeeId: employeeId, source: 'background' });
  assert.equal(executed.success, true, executed.error);
  const rows = await receipts(executed.actionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.proposer, 'employee');
  assert.equal(rows[0]!.proposer_id, employeeId);
  assert.equal(rows[0]!.employee_id, employeeId);
  assert.equal(rows[0]!.decision, 'auto_executed');
});

for (const source of ['mcp_api', 'mcp']) {
  test(`${source}: a personal call names the person behind the credential`, { skip: !canRun }, async () => {
    const executed = await executeActionDirect('create_task', createTask('Personal task'), orgId, ownerId, null, 'auto', { source });
    assert.equal(executed.success, true, executed.error);
    const rows = await receipts(executed.actionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.proposer, 'user');
    assert.equal(rows[0]!.proposer_id, ownerId);
    assert.equal(rows[0]!.decision, 'auto_executed');
  });
}

for (const route of ['approve', 'resume']) {
  test(`plan ${route}: HTTP records the reviewer and execution signs the step with that approver`, { skip: !canRun }, async () => {
    const planId = randomUUID();
    const steps = [{ id: 'step-1', tool: 'create_task', params: createTask('Plan task'),
      status: route === 'resume' ? 'waiting_approval' : 'pending' }];
    const context = { retained: { result: 'previous step' }, approved_by_user_id: ownerId };
    await client.query(
      `INSERT INTO agent_plans (id, org_id, user_id, title, steps, status, current_step, context)
       VALUES ($1, $2, $3, 'Receipt plan', $4::jsonb, $5, 0, $6::jsonb)`,
      [planId, orgId, ownerId, JSON.stringify(steps), route === 'resume' ? 'paused' : 'draft', JSON.stringify(context)],
    );
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('user', { id: adminId, org_id: orgId, role: 'admin' } as any);
      await next();
    });
    app.route('/api/agent/plans', agentPlanRoutes);
    const response = await app.request(`/api/agent/plans/${planId}/${route}`, { method: 'POST' });
    assert.equal(response.status, 200, await response.clone().text());
    const approved = (await client.query('SELECT context, status, steps FROM agent_plans WHERE id = $1', [planId])).rows[0];
    assert.deepEqual(approved.context, { ...context, approved_by_user_id: adminId });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.steps[0].status, 'pending');

    await executePlan(planId, orgId, ownerId);
    const actions = (await client.query('SELECT id, error, executed_at FROM agent_actions WHERE plan_id = $1 AND org_id = $2', [planId, orgId])).rows;
    assert.equal(actions.length, 1);
    assert.equal(actions[0].error, null);
    assert.ok(actions[0].executed_at);
    const rows = await receipts(actions[0].id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.decision, 'approved');
    assert.equal(rows[0]!.approver_id, adminId);
    assert.equal(rows[0]!.proposer, 'defty');
  });
}

test('an action that already has a receipt under another decision gets no second one', { skip: !canRun }, async () => {
  // No approver on the row, so the helper would sign "auto_executed"; the
  // existing "approved" receipt must stop it (generateReceipt alone would not).
  const actionId = randomUUID();
  await client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status, approved_at, executed_at)
     VALUES ($1, $2, $3, 'background', 'create_task', '{}'::jsonb, 'auto', 'approved', now(), now())`,
    [actionId, orgId, ownerId],
  );
  await generateReceipt({ actionId, orgId, proposer: 'defty', proposerId: ownerId, approverId: ownerId,
    decision: 'approved', actionName: 'create_task', actionParams: {}, resultJson: null });
  assert.equal((await receipts(actionId)).length, 1);
  await recordDirectActionReceipt({
    actionId, orgId, userId: ownerId, action: 'create_task', agentEmployeeId: null, outcome: { success: true, result: {} },
  });
  const rows = await receipts(actionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.decision, 'approved');
});

test('a failed direct action records the failure reason', { skip: !canRun }, async () => {
  const actionId = randomUUID();
  await client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status, approved_at, executed_at, error)
     VALUES ($1, $2, $3, 'background', 'create_task', '{}'::jsonb, 'auto', 'approved', now(), now(), 'Project not found')`,
    [actionId, orgId, ownerId],
  );
  await recordDirectActionReceipt({
    actionId, orgId, userId: ownerId, action: 'create_task', agentEmployeeId: null,
    outcome: { success: false, error: 'Project not found' },
  });
  const rows = await receipts(actionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.decision, 'auto_executed');
  assert.equal(rows[0]!.decision_reason, 'execution failed: Project not found');
});
