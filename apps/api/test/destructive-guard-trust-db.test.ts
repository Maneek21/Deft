/**
 * Lane S2 — actions classed as destructive never auto-execute, at any trust
 * level, on the real employee MCP and plan-dependency handlers.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/destructive-guard-trust-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';

import { closeDb } from '../src/lib/db.js';
import { createPlanRow } from '../src/lib/agent-plans.js';
import {
  createModuleRecord,
  humanModuleActor,
  installModuleFromManifest,
  updateModuleInstallation,
} from '../src/lib/module-service.js';
import { MODULE_MCP_WRITE_TOOLS } from '../src/lib/mcp-tools/modules.js';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';
import { handlePlanExecutor } from '../src/workers/handlers/plan-executor.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
const canRun = Boolean(databaseUrl);

after(closeDb);

function payload(result: ToolResult): any {
  return JSON.parse(result.content[0]!.text);
}

test('S2-a: a Standard employee unlink (quick tier, destructive) waits for approval on MCP and plan-dependency paths', { skip: !canRun }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgId = randomUUID();
  const ownerId = randomUUID();
  const employeeUserId = randomUUID();
  const employeeId = randomUUID();
  const projectId = randomUUID();
  const mcpTaskId = randomUUID();
  const planTaskId = randomUUID();
  const employeeSlug = `s2-guard-${suffix}`;
  const slug = `s2-equipment-${suffix}`;
  const planIds: string[] = [];
  const ctx: ToolContext = {
    org_id: orgId,
    employee_id: employeeId,
    employee_slug: employeeSlug,
    trust_level: 'standard',
    scopes: ['write:modules', 'write:tasks'],
  };

  try {
    await client.query('INSERT INTO orgs (id,name,slug) VALUES ($1,$2,$3)', [orgId, 'S2 destructive guard', `s2-guard-${suffix}`]);
    await client.query(
      'INSERT INTO users (id,name,email) VALUES ($1,$2,$3),($4,$5,$6)',
      [ownerId, 'S2 owner', `s2-owner-${suffix}@example.test`, employeeUserId, 'S2 employee', `s2-employee-${suffix}@example.test`],
    );
    await client.query(
      `INSERT INTO org_members (id,org_id,user_id,role) VALUES ($1,$2,$3,'owner'),($4,$2,$5,'member')`,
      [randomUUID(), orgId, ownerId, randomUUID(), employeeUserId],
    );
    await client.query(
      `INSERT INTO agent_employees
       (id,org_id,user_id,name,slug,role,system_prompt,trust_level,created_by,project_ids)
       VALUES ($1,$2,$3,'S2 employee',$4,'custom','S2 destructive guard','standard',$5,$6)`,
      [employeeId, orgId, employeeUserId, employeeSlug, ownerId, [projectId]],
    );
    await client.query(
      `INSERT INTO projects (id,org_id,name,prefix,lead_id) VALUES ($1,$2,'S2 work',$3,$4)`,
      [projectId, orgId, `S${suffix.slice(0, 5)}`.toUpperCase(), ownerId],
    );
    await client.query(
      `INSERT INTO tasks (id,org_id,project_id,number,title,created_by,metadata) VALUES
       ($1,$2,$3,1,'MCP unlink target',$4,'{}'),($5,$2,$3,2,'Plan unlink target',$4,'{}')`,
      [mcpTaskId, orgId, projectId, ownerId, planTaskId],
    );

    const owner = humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
    const installation = await installModuleFromManifest(owner, {
      schema_version: '1', id: `test.deft.${slug}`, slug, version: '1.0.0', name: 'S2 equipment',
      collections: [{
        key: 'assets', name: 'Assets', singular_name: 'Asset',
        fields: [{ key: 'serial', label: 'Serial', type: 'text', required: true }],
        search: { title_field: 'serial', fields: ['serial'] },
        views: [{ key: 'all', name: 'All assets', type: 'table', fields: ['serial'] }],
      }],
    }, { source: 'sideloaded' });
    await updateModuleInstallation(owner, slug, { agent_access: 'write' });
    const created = await createModuleRecord(owner, {
      module_id: installation.module_id,
      collection_key: 'assets',
      data: { serial: `S2-${suffix}` },
      expected_manifest_digest: installation.manifest_digest,
      idempotency_key: `s2-seed-${suffix}`,
    });
    assert.ok(created.record);
    const resourceId = created.record!.resource_id;
    const edgeCount = async (taskId: string) => (await client.query(
      `SELECT count(*)::int AS count FROM cross_references
        WHERE org_id = $1 AND source_id = $2 AND target_id = $3`,
      [orgId, resourceId, taskId],
    )).rows[0].count as number;

    // Link both tasks (quick tier, not destructive: still runs under Standard).
    for (const taskId of [mcpTaskId, planTaskId]) {
      const linked = await MODULE_MCP_WRITE_TOOLS.module_record_task_link!({
        caller_employee_slug: employeeSlug, resource_id: resourceId,
        task_identifier: taskId, idempotency_key: `s2-link-${taskId}`,
      }, ctx);
      assert.equal(linked.isError, false, linked.content[0]?.text);
      assert.equal(await edgeCount(taskId), 1);
    }

    // 1. Employee MCP path: Standard unlink returns the approval pseudo-result,
    // queues exactly one pending action, and leaves the edge in place.
    const unlinkArgs = {
      caller_employee_slug: employeeSlug, resource_id: resourceId,
      task_identifier: mcpTaskId, idempotency_key: `s2-unlink-${suffix}`,
    };
    const unlinked = await MODULE_MCP_WRITE_TOOLS.module_record_task_unlink!(unlinkArgs, ctx);
    assert.equal(unlinked.isError ?? false, false, unlinked.content[0]?.text);
    const body = payload(unlinked);
    assert.equal(body.status, 'queued_for_approval', JSON.stringify(body));
    assert.equal(typeof body.approval_id, 'string');
    assert.equal(await edgeCount(mcpTaskId), 1, 'the destructive unlink must not run before approval');
    const replay = payload(await MODULE_MCP_WRITE_TOOLS.module_record_task_unlink!(unlinkArgs, ctx));
    assert.equal(replay.approval_id, body.approval_id, 'a retry reuses the single pending proposal');
    const pending = await client.query(
      `SELECT approval_status, executed_at FROM agent_actions
        WHERE org_id = $1 AND agent_employee_id = $2 AND action = 'module_record_task_unlink'`,
      [orgId, employeeId],
    );
    assert.equal(pending.rows.length, 1, 'exactly one action row: no double-queue');
    assert.equal(pending.rows[0].approval_status, 'pending');
    assert.equal(pending.rows[0].executed_at, null);

    // 2. Plan path: a destructive write that a later step depends on needs
    // its own approval under Standard (it no longer runs on plan approval).
    const plan = await createPlanRow({
      org_id: orgId,
      user_id: ownerId,
      agent_employee_id: employeeId,
      title: `S2 plan ${suffix}`,
      steps: [
        {
          id: 'unlink',
          description: 'Unlink the asset from the task',
          tool: 'module_record_task_unlink',
          params: { resource_id: resourceId, task_identifier: planTaskId, idempotency_key: `s2-plan-unlink-${suffix}` },
        },
        {
          id: 'after',
          description: 'Continue after the unlink',
          tool: 'list_projects',
          params: {},
          depends_on: ['unlink'],
        },
      ],
      fail_fast: true,
    });
    planIds.push(plan.plan_id);
    await client.query("UPDATE agent_plans SET status = 'approved' WHERE id = $1", [plan.plan_id]);
    await handlePlanExecutor({
      id: randomUUID(),
      name: 'plan-executor',
      data: { planId: plan.plan_id, orgId, userId: ownerId },
      attempts: 1,
    } as any);
    const planRow = await client.query<{ status: string; steps: Array<{ status: string }> }>(
      'SELECT status, steps FROM agent_plans WHERE id = $1',
      [plan.plan_id],
    );
    assert.equal(planRow.rows[0]?.status, 'paused', JSON.stringify(planRow.rows[0]));
    assert.equal(planRow.rows[0]?.steps[0]?.status, 'waiting_approval');
    const planActions = await client.query(
      `SELECT approval_status, executed_at FROM agent_actions
        WHERE org_id = $1 AND plan_id = $2 AND plan_step_id = 'unlink'`,
      [orgId, plan.plan_id],
    );
    assert.equal(planActions.rows.length, 1);
    assert.equal(planActions.rows[0].approval_status, 'pending');
    assert.equal(await edgeCount(planTaskId), 1, 'the destructive plan dependency must not run before approval');
  } finally {
    if (planIds.length) await client.query('DELETE FROM agent_plans WHERE id = ANY($1::text[])', [planIds]);
    for (const table of [
      'attention_items', 'notifications', 'job_queue', 'action_receipts', 'module_mutation_receipts', 'agent_actions',
      'agent_mcp_call_audit', 'cross_references', 'audit_log', 'module_record_relations', 'module_records',
      'module_versions', 'module_installations', 'task_activity', 'tasks', 'projects', 'agent_employees', 'org_members',
    ]) await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
    await client.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[ownerId, employeeUserId]]);
    await client.end();
  }
});
