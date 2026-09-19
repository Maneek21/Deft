/**
 * Plan-worker identity regressions for Defty's canonical soft-hidden employee.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api exec tsx --test test/agent-plan-defty-worker-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';

import { closeDb } from '../src/lib/db.js';
import { executeActionDirect } from '../src/lib/agent-actions.js';
import { ensureDeftyEmployee } from '../src/lib/ensure-defty-membership.js';
import { createPlanRow } from '../src/lib/agent-plans.js';
import {
  createModuleRecord,
  humanModuleActor,
  installBundledModule,
  updateModuleInstallation,
} from '../src/lib/module-service.js';
import { agentRoutes } from '../src/routes/agent.js';
import { agentPlanRoutes } from '../src/routes/agent-plans.js';
import { handlePlanExecutor } from '../src/workers/handlers/plan-executor.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
const canRun = Boolean(databaseUrl);
const suffix = randomUUID();
const orgId = randomUUID();
const otherOrgId = randomUUID();
const ownerId = randomUUID();
const inactiveUserId = randomUUID();
const forgedUserId = randomUUID();
const crossOrgUserId = randomUUID();
const inactiveEmployeeId = randomUUID();
const forgedEmployeeId = randomUUID();
const crossOrgEmployeeId = randomUUID();
const projectId = randomUUID();
const projectName = `Defty plan project ${suffix}`;
const planIds: string[] = [];

let client: pg.Client;

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('user', {
    id: ownerId,
    org_id: orgId,
    email: `defty-plan-owner-${suffix}@example.test`,
    role: 'owner',
  } as any);
  await next();
});
app.route('/api/agent', agentRoutes);
app.route('/api/agent-plans', agentPlanRoutes);

function dependencySteps(label: string) {
  return [
    {
      id: 'create-followup',
      description: 'Create a follow-up task',
      tool: 'create_task',
      params: { title: label, project_name: projectName },
    },
    {
      id: 'inspect-followup',
      description: 'Inspect the created follow-up task',
      tool: 'get_task_detail',
      params: { task_identifier: '$step.create-followup.result.task_id' },
      depends_on: ['create-followup'],
    },
  ];
}

async function planAction(planId: string) {
  const result = await client.query<{
    id: string;
    approval_status: string;
    executed_at: Date | null;
    runtime_request_key: string | null;
  }>(
    `SELECT id, approval_status, executed_at, runtime_request_key
       FROM agent_actions
      WHERE org_id = $1 AND plan_id = $2 AND plan_step_id = 'create-followup'
      ORDER BY created_at`,
    [orgId, planId],
  );
  return result.rows;
}

async function resumePlan(planId: string): Promise<void> {
  const response = await app.request(`/api/agent-plans/${planId}/resume`, { method: 'POST' });
  assert.equal(response.status, 200, await response.text());
}

async function createApprovedPlan(
  agentEmployeeId: string,
  steps = [{
    id: 'list-projects',
    description: 'List visible projects',
    tool: 'list_projects',
    params: {},
  }],
  options?: { failFast?: boolean },
): Promise<string> {
  const plan = await createPlanRow({
    org_id: orgId,
    user_id: ownerId,
    agent_employee_id: agentEmployeeId,
    title: `Defty worker boundary ${suffix}`,
    steps,
    fail_fast: options?.failFast ?? true,
  });
  planIds.push(plan.plan_id);
  await client.query("UPDATE agent_plans SET status = 'approved' WHERE id = $1", [plan.plan_id]);
  return plan.plan_id;
}

function planJob(planId: string) {
  return {
    id: randomUUID(),
    name: 'plan-executor',
    data: { planId, orgId, userId: ownerId },
    attempts: 1,
  };
}

before(async () => {
  if (!canRun) return;
  client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(
    `INSERT INTO orgs (id, name, slug)
     VALUES ($1, 'Defty plan boundary', $2), ($3, 'Other plan boundary', $4)`,
    [orgId, `defty-plan-${suffix}`, otherOrgId, `defty-plan-other-${suffix}`],
  );
  const userIds = [ownerId, inactiveUserId, forgedUserId, crossOrgUserId];
  for (const [index, userId] of userIds.entries()) {
    await client.query(
      `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [
        userId,
        `defty-plan-${index}-${suffix}@example.test`,
        `Defty plan user ${index}`,
        index === 0 ? 'human' : 'agent',
        index !== 0,
      ],
    );
  }
  await client.query(
    'INSERT INTO projects (id, org_id, name, prefix, lead_id) VALUES ($1, $2, $3, $4, $5)',
    [projectId, orgId, projectName, `DP${suffix.slice(0, 5)}`.toUpperCase(), ownerId],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES
       ($1, $2, $3, 'owner', true),
       ($4, $2, $5, 'member', true),
       ($6, $2, $7, 'member', true),
       ($8, $9, $10, 'member', true)`,
    [
      randomUUID(), orgId, ownerId,
      randomUUID(), inactiveUserId,
      randomUUID(), forgedUserId,
      randomUUID(), otherOrgId, crossOrgUserId,
    ],
  );
  await client.query(
    `INSERT INTO agent_employees
      (id, org_id, user_id, name, slug, role, system_prompt, runtime_kind,
       trust_level, max_daily_actions, created_by, is_active, is_deleted, is_byoa)
     VALUES
       ($1, $2, $3, 'Inactive employee', $4, 'custom', 'inactive',
        'custom_mcp', 'standard', 50, $5, false, false, true),
       ($6, $2, $7, 'Forged Defty runtime', $8, 'custom', 'forged',
        'defty_system', 'standard', 50, $5, true, true, true),
       ($9, $10, $11, 'Cross-org employee', $12, 'custom', 'cross org',
        'custom_mcp', 'standard', 50, $11, true, false, true)`,
    [
      inactiveEmployeeId, orgId, inactiveUserId, `inactive-${suffix}`, ownerId,
      forgedEmployeeId, forgedUserId, `forged-${suffix}`,
      crossOrgEmployeeId, otherOrgId, crossOrgUserId, `cross-org-${suffix}`,
    ],
  );
});

after(async () => {
  if (!client) {
    await closeDb();
    return;
  }
  try {
    if (planIds.length > 0) {
      await client.query('DELETE FROM agent_plans WHERE id = ANY($1::text[])', [planIds]);
    }
    await client.query('DELETE FROM action_receipts WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM notifications WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM attention_items WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM job_queue WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM module_mutation_receipts WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM agent_actions WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM module_records WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM module_versions WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM module_installations WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM task_activity WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM task_comments WHERE org_id = $1', [orgId]);
    await client.query(
      `DELETE FROM task_relationships
        WHERE source_task_id IN (SELECT id FROM tasks WHERE org_id = $1)
           OR target_task_id IN (SELECT id FROM tasks WHERE org_id = $1)`,
      [orgId],
    );
    await client.query(
      'DELETE FROM task_labels WHERE task_id IN (SELECT id FROM tasks WHERE org_id = $1)',
      [orgId],
    );
    await client.query('DELETE FROM audit_log WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM tasks WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM projects WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM agent_employees WHERE org_id = ANY($1::text[])', [[orgId, otherOrgId]]);
    await client.query('DELETE FROM org_members WHERE org_id = ANY($1::text[])', [[orgId, otherOrgId]]);
    await client.query('DELETE FROM orgs WHERE id = ANY($1::text[])', [[orgId, otherOrgId]]);
    await client.query(
      'DELETE FROM users WHERE id = ANY($1::text[])',
      [[ownerId, inactiveUserId, forgedUserId, crossOrgUserId]],
    );
  } finally {
    await client.end();
    await closeDb();
  }
});

test('plan worker executes a native read for canonical soft-hidden Defty', { skip: !canRun }, async () => {
  const defty = await ensureDeftyEmployee(orgId);
  const planId = await createApprovedPlan(defty.employeeId);

  await assert.doesNotReject(handlePlanExecutor(planJob(planId)));

  const result = await client.query<{ status: string; current_step: number; steps: Array<{ status: string; result: unknown }> }>(
    'SELECT status, current_step, steps FROM agent_plans WHERE id = $1',
    [planId],
  );
  assert.equal(result.rows[0]?.status, 'completed');
  assert.equal(result.rows[0]?.current_step, 1);
  assert.equal(result.rows[0]?.steps[0]?.status, 'completed');
  const projects = result.rows[0]?.steps[0]?.result as Array<{ id: string }>;
  assert.deepEqual(projects.map((project) => project.id), [projectId]);
});

test('plan worker still denies inactive, noncanonical deleted, and cross-org employees', { skip: !canRun }, async () => {
  for (const employeeId of [inactiveEmployeeId, forgedEmployeeId, crossOrgEmployeeId]) {
    const planId = await createApprovedPlan(employeeId);
    await assert.rejects(
      handlePlanExecutor(planJob(planId)),
      /Plan agent employee is inactive, deleted, or outside this organization/,
    );
    const result = await client.query<{ status: string }>(
      'SELECT status FROM agent_plans WHERE id = $1',
      [planId],
    );
    assert.equal(result.rows[0]?.status, 'approved');
  }
});

test('conservative dependency writes pause with one actionable approval proposal', { skip: !canRun }, async () => {
  const defty = await ensureDeftyEmployee(orgId);
  const taskTitle = `Follow up ${suffix}`;
  const planId = await createApprovedPlan(defty.employeeId, dependencySteps(taskTitle));

  await Promise.all([
    handlePlanExecutor(planJob(planId)),
    handlePlanExecutor(planJob(planId)),
  ]);

  const plan = await client.query<{ status: string; current_step: number; steps: Array<{ status: string }> }>(
    'SELECT status, current_step, steps FROM agent_plans WHERE id = $1',
    [planId],
  );
  assert.equal(plan.rows[0]?.status, 'paused');
  assert.equal(plan.rows[0]?.current_step, 0);
  assert.equal(plan.rows[0]?.steps[0]?.status, 'waiting_approval');

  const actions = await planAction(planId);
  assert.equal(actions.length, 1, 'the paused plan step must create exactly one reviewable action');
  assert.equal(actions[0]?.approval_status, 'pending');
  assert.equal(actions[0]?.executed_at, null);
  assert.match(actions[0]?.runtime_request_key ?? '', /^plan-step:/);

  await resumePlan(planId);
  await Promise.all([
    handlePlanExecutor(planJob(planId)),
    handlePlanExecutor(planJob(planId)),
  ]);
  assert.equal((await planAction(planId)).length, 1, 'manual resume and concurrent workers reuse the pending action');

  const tasks = await client.query<{ count: string }>(
    'SELECT count(*) FROM tasks WHERE org_id = $1 AND title = $2',
    [orgId, taskTitle],
  );
  assert.equal(tasks.rows[0]?.count, '0', 'the dependency write must not execute before approval');
});

test('human route approval and manual resume continue the same plan without duplicating the write', { skip: !canRun }, async () => {
  const defty = await ensureDeftyEmployee(orgId);
  const taskTitle = `Approved follow up ${suffix}`;
  const planId = await createApprovedPlan(defty.employeeId, dependencySteps(taskTitle));
  await handlePlanExecutor(planJob(planId));
  const [action] = await planAction(planId);
  assert.ok(action);

  const approval = await app.request(`/api/agent/actions/${action.id}/approve`, { method: 'POST' });
  assert.equal(approval.status, 200, await approval.text());
  await resumePlan(planId);
  await Promise.all([
    handlePlanExecutor(planJob(planId)),
    handlePlanExecutor(planJob(planId)),
  ]);

  const plan = await client.query<{ status: string; current_step: number; steps: Array<{ status: string }> }>(
    'SELECT status, current_step, steps FROM agent_plans WHERE id = $1',
    [planId],
  );
  assert.equal(plan.rows[0]?.status, 'completed');
  assert.equal(plan.rows[0]?.current_step, 2);
  assert.deepEqual(plan.rows[0]?.steps.map((step) => step.status), ['completed', 'completed']);
  assert.equal((await planAction(planId)).length, 1);
  const tasks = await client.query<{ count: string }>(
    'SELECT count(*) FROM tasks WHERE org_id = $1 AND title = $2',
    [orgId, taskTitle],
  );
  assert.equal(tasks.rows[0]?.count, '1');
});

test('completed module update replay rechecks access without rejecting its consumed revision', { skip: !canRun }, async () => {
  const defty = await ensureDeftyEmployee(orgId);
  const owner = humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
  const installed = await installBundledModule(owner, 'contacts');
  const configured = await updateModuleInstallation(owner, 'contacts', { agent_access: 'write' });
  const created = await createModuleRecord(owner, {
    module_id: installed.module_id,
    collection_key: 'contacts',
    data: { name: `Plan replay contact ${suffix}`, status: 'lead' },
    expected_manifest_digest: configured.manifest_digest,
    idempotency_key: `plan-replay-create-${suffix}`,
  });
  assert.ok(created.record);
  const planId = await createApprovedPlan(defty.employeeId, [
    {
      id: 'update-contact',
      description: 'Update a contact after review',
      tool: 'module_record_update',
      params: {
        record_id: created.record.id,
        patch: { status: 'active' },
        expected_revision: created.record.revision,
        expected_manifest_digest: configured.manifest_digest,
        idempotency_key: `plan-replay-update-${suffix}`,
      },
    },
    {
      id: 'inspect-projects',
      description: 'Continue after the reviewed update',
      tool: 'list_projects',
      params: {},
      depends_on: ['update-contact'],
    },
  ]);

  await handlePlanExecutor(planJob(planId));
  const paused = await client.query<{ status: string; error: string | null; steps: Array<{ status: string; error?: string }> }>(
    'SELECT status, error, steps FROM agent_plans WHERE id = $1',
    [planId],
  );
  assert.equal(paused.rows[0]?.status, 'paused', JSON.stringify(paused.rows[0]));
  const actionResult = await client.query<{ id: string; action: string; plan_step_id: string | null }>(
    `SELECT id, action, plan_step_id FROM agent_actions
      WHERE org_id = $1 AND plan_id = $2`,
    [orgId, planId],
  );
  const actionId = actionResult.rows[0]?.id;
  assert.ok(actionId, JSON.stringify({ plan: paused.rows[0], actions: actionResult.rows }));
  const approval = await app.request(`/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(approval.status, 200, await approval.text());

  await resumePlan(planId);
  await handlePlanExecutor(planJob(planId));

  const plan = await client.query<{ status: string; steps: Array<{ status: string }> }>(
    'SELECT status, steps FROM agent_plans WHERE id = $1',
    [planId],
  );
  assert.equal(plan.rows[0]?.status, 'completed');
  assert.deepEqual(plan.rows[0]?.steps.map((step) => step.status), ['completed', 'completed']);
  const record = await client.query<{ revision: number; data: Record<string, unknown> }>(
    'SELECT revision, data FROM module_records WHERE id = $1 AND org_id = $2',
    [created.record.id, orgId],
  );
  assert.equal(record.rows[0]?.revision, created.record.revision + 1);
  assert.equal(record.rows[0]?.data.status, 'active');

  const collisionRecord = await createModuleRecord(owner, {
    module_id: installed.module_id,
    collection_key: 'contacts',
    data: { name: `Plan collision contact ${suffix}`, status: 'lead' },
    expected_manifest_digest: configured.manifest_digest,
    idempotency_key: `plan-collision-create-${suffix}`,
  });
  assert.ok(collisionRecord.record);
  const collisionParams = {
    record_id: collisionRecord.record.id,
    patch: { status: 'active' },
    expected_revision: collisionRecord.record.revision,
    expected_manifest_digest: configured.manifest_digest,
    idempotency_key: `plan-collision-update-${suffix}`,
  };
  const prior = await executeActionDirect(
    'module_record_update',
    collisionParams,
    orgId,
    ownerId,
    null,
    'full',
    { agentEmployeeId: defty.employeeId, source: 'native' },
  );
  assert.equal(prior.requiresApproval, true);
  const collisionPlanId = await createApprovedPlan(defty.employeeId, [
    {
      id: 'collision-update',
      description: 'Review the colliding update in this plan',
      tool: 'module_record_update',
      params: collisionParams,
    },
    {
      id: 'collision-read',
      description: 'Continue only after the reviewed update',
      tool: 'list_projects',
      params: {},
      depends_on: ['collision-update'],
    },
  ], { failFast: false });

  await handlePlanExecutor(planJob(collisionPlanId));

  const collision = await client.query<{
    status: string;
    error: string | null;
    steps: Array<{ status: string; error?: string }>;
  }>('SELECT status, error, steps FROM agent_plans WHERE id = $1', [collisionPlanId]);
  assert.equal(collision.rows[0]?.status, 'paused');
  assert.equal(collision.rows[0]?.steps[0]?.status, 'failed');
  assert.match(collision.rows[0]?.error ?? '', /different approval context/);
  const scopedActions = await client.query<{ count: string }>(
    'SELECT count(*) FROM agent_actions WHERE org_id = $1 AND plan_id = $2',
    [orgId, collisionPlanId],
  );
  assert.equal(scopedActions.rows[0]?.count, '0');
});

test('plan terminal state remains failed when processed steps contain failures', { skip: !canRun }, async () => {
  const defty = await ensureDeftyEmployee(orgId);
  const planId = await createApprovedPlan(defty.employeeId);
  const processedSteps = [
    {
      id: 'bad-reference',
      description: 'A previously failed result reference',
      tool: 'list_projects',
      params: {},
      status: 'failed',
      error: 'Referenced result field was unavailable',
    },
    {
      id: 'blocked-dependent',
      description: 'A dependency that could not run',
      tool: 'list_projects',
      params: {},
      depends_on: ['bad-reference'],
      status: 'failed',
      error: 'Dependencies not met',
    },
  ];
  await client.query(
    `UPDATE agent_plans
        SET steps = $2::jsonb, current_step = 2, status = 'approved', error = NULL
      WHERE id = $1`,
    [planId, JSON.stringify(processedSteps)],
  );

  await handlePlanExecutor(planJob(planId));

  const terminal = await client.query<{ status: string; error: string | null }>(
    'SELECT status, error FROM agent_plans WHERE id = $1',
    [planId],
  );
  assert.equal(terminal.rows[0]?.status, 'failed');
  assert.match(terminal.rows[0]?.error ?? '', /2 plan steps failed/);
});

test('rejected, changed-input, and changed-tool approvals pause fail closed without recovery or replacement actions', { skip: !canRun }, async () => {
  const defty = await ensureDeftyEmployee(orgId);
  for (const mode of ['rejected', 'changed', 'tool_changed'] as const) {
    const taskTitle = `${mode} follow up ${suffix}`;
    const planId = await createApprovedPlan(
      defty.employeeId,
      dependencySteps(taskTitle),
      { failFast: false },
    );
    await handlePlanExecutor(planJob(planId));
    const [action] = await planAction(planId);
    assert.ok(action);

    if (mode === 'rejected') {
      const rejection = await app.request(`/api/agent/actions/${action.id}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Do not create this follow-up' }),
      });
      assert.equal(rejection.status, 200, await rejection.text());
    } else {
      const editedSteps = mode === 'tool_changed'
        ? [
          {
            id: 'create-followup',
            description: 'Create a different reviewed artifact',
            tool: 'create_note',
            params: { title: `${taskTitle} note`, content: 'Changed after review request' },
          },
          {
            id: 'inspect-followup',
            description: 'Inspect the changed artifact',
            tool: 'list_projects',
            params: {},
            depends_on: ['create-followup'],
          },
        ]
        : dependencySteps(`${taskTitle} changed`);
      const edit = await app.request(`/api/agent-plans/${planId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ steps: editedSteps }),
      });
      assert.equal(edit.status, 200, await edit.text());
    }

    await resumePlan(planId);
    await handlePlanExecutor(planJob(planId));
    const state = await client.query<{ status: string; error: string | null }>(
      'SELECT status, error FROM agent_plans WHERE id = $1',
      [planId],
    );
    assert.equal(state.rows[0]?.status, 'paused');
    assert.match(state.rows[0]?.error ?? '', mode === 'rejected' ? /rejected/ : /input changed/);
    const actions = await planAction(planId);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.approval_status, mode === 'rejected' ? 'rejected' : 'expired');
    const tasks = await client.query<{ count: string }>(
      'SELECT count(*) FROM tasks WHERE org_id = $1 AND title LIKE $2',
      [orgId, `${taskTitle}%`],
    );
    assert.equal(tasks.rows[0]?.count, '0');
  }
});

test('approved action with no durable execution outcome pauses fail closed without recovery', { skip: !canRun }, async () => {
  const defty = await ensureDeftyEmployee(orgId);
  const taskTitle = `Unknown outcome ${suffix}`;
  const planId = await createApprovedPlan(
    defty.employeeId,
    dependencySteps(taskTitle),
    { failFast: false },
  );
  await handlePlanExecutor(planJob(planId));
  const [action] = await planAction(planId);
  assert.ok(action);
  await client.query(
    `UPDATE agent_actions
        SET approval_status = 'approved', approved_at = now(), executed_at = NULL, result = NULL
      WHERE id = $1`,
    [action.id],
  );

  await resumePlan(planId);
  await handlePlanExecutor(planJob(planId));

  const state = await client.query<{ status: string; error: string | null }>(
    'SELECT status, error FROM agent_plans WHERE id = $1',
    [planId],
  );
  assert.equal(state.rows[0]?.status, 'paused');
  assert.match(state.rows[0]?.error ?? '', /execution outcome is unavailable/);
  assert.equal((await planAction(planId)).length, 1);
  const tasks = await client.query<{ count: string }>(
    'SELECT count(*) FROM tasks WHERE org_id = $1 AND title = $2',
    [orgId, taskTitle],
  );
  assert.equal(tasks.rows[0]?.count, '0');
});

test('membership revocation blocks approved-result replay before plan continuation', { skip: !canRun }, async () => {
  const defty = await ensureDeftyEmployee(orgId);
  const taskTitle = `Revoked replay ${suffix}`;
  const planId = await createApprovedPlan(defty.employeeId, dependencySteps(taskTitle));
  await handlePlanExecutor(planJob(planId));
  const [action] = await planAction(planId);
  assert.ok(action);
  const approval = await app.request(`/api/agent/actions/${action.id}/approve`, { method: 'POST' });
  assert.equal(approval.status, 200, await approval.text());

  await client.query(
    'UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2',
    [orgId, ownerId],
  );
  try {
    await client.query(
      `UPDATE agent_plans
          SET status = 'approved',
              steps = jsonb_set(steps, '{0,status}', '"pending"'::jsonb)
        WHERE id = $1`,
      [planId],
    );
    await handlePlanExecutor(planJob(planId));
    const plan = await client.query<{ status: string; context: Record<string, unknown> }>(
      'SELECT status, context FROM agent_plans WHERE id = $1',
      [planId],
    );
    assert.equal(plan.rows[0]?.status, 'paused');
    assert.equal(plan.rows[0]?.context['create-followup'], undefined);
    assert.equal((await planAction(planId)).length, 1);
  } finally {
    await client.query(
      'UPDATE org_members SET is_active = true WHERE org_id = $1 AND user_id = $2',
      [orgId, ownerId],
    );
  }
  const tasks = await client.query<{ count: string }>(
    'SELECT count(*) FROM tasks WHERE org_id = $1 AND title = $2',
    [orgId, taskTitle],
  );
  assert.equal(tasks.rows[0]?.count, '1', 'only the already approved effect exists');
});
