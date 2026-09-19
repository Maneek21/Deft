import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';

import { closeDb } from '../src/lib/db.js';
import {
  createModuleRecord,
  humanModuleActor,
  installModuleFromManifest,
  updateModuleInstallation,
} from '../src/lib/module-service.js';
import { MODULE_MCP_WRITE_TOOLS } from '../src/lib/mcp-tools/modules.js';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';
import { issuePersonalMcpToken } from '../src/lib/mcp-token.js';
import { mcpServerV1Routes } from '../src/routes/mcp-server-v1.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
const canRun = Boolean(databaseUrl);

after(closeDb);

function payload(result: ToolResult): any {
  return JSON.parse(result.content[0]!.text);
}

test('equipment task-link writes agree across employee and personal MCP boundaries', { skip: !canRun }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const ownerId = randomUUID();
  const employeeUserId = randomUUID();
  const otherOwnerId = randomUUID();
  const employeeId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const taskId = randomUUID();
  const pendingTaskId = randomUUID();
  const personalTaskId = randomUUID();
  const restrictedTaskId = randomUUID();
  const outOfProjectTaskId = randomUUID();
  const crossOrgTaskId = randomUUID();
  const employeeSlug = `equipment-mcp-${suffix}`;
  const slug = `equipment-${suffix}`;
  const humanWriteScopes = ['write:modules', 'write:tasks'];

  const employeeContext = (trustLevel: ToolContext['trust_level']): ToolContext => ({
    org_id: orgId,
    employee_id: employeeId,
    employee_slug: employeeSlug,
    trust_level: trustLevel,
    scopes: humanWriteScopes,
  });
  const employeeArgs = (taskIdentifier: string, idempotencyKey: string) => ({
    caller_employee_slug: employeeSlug,
    resource_id: '',
    task_identifier: taskIdentifier,
    idempotency_key: idempotencyKey,
  });
  const personalCall = async (token: string, name: string, args: Record<string, unknown>) => {
    const app = new Hono();
    app.route('/api/mcp/v1', mcpServerV1Routes);
    const response = await app.request('/api/mcp/v1/tools/call', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
    });
    return {
      status: response.status,
      body: await response.json() as ToolResult & { error?: { message?: string } },
    };
  };

  try {
    await client.query('INSERT INTO orgs (id,name,slug) VALUES ($1,$2,$3),($4,$5,$6)', [
      orgId, 'Equipment MCP parity', `equipment-mcp-${suffix}`,
      otherOrgId, 'Other equipment MCP parity', `other-equipment-mcp-${suffix}`,
    ]);
    await client.query(
      `INSERT INTO users (id,name,email) VALUES ($1,$2,$3),($4,$5,$6),($7,$8,$9)`,
      [
        ownerId, 'Equipment owner', `owner-${suffix}@example.test`,
        employeeUserId, 'Equipment employee', `employee-${suffix}@example.test`,
        otherOwnerId, 'Other owner', `other-owner-${suffix}@example.test`,
      ],
    );
    await client.query(
      `INSERT INTO org_members (id,org_id,user_id,role) VALUES
       ($1,$2,$3,'owner'),($4,$2,$5,'member'),($6,$7,$8,'owner')`,
      [randomUUID(), orgId, ownerId, randomUUID(), employeeUserId, randomUUID(), otherOrgId, otherOwnerId],
    );
    await client.query(
      `INSERT INTO agent_employees
       (id,org_id,user_id,name,slug,role,system_prompt,trust_level,created_by,project_ids)
       VALUES ($1,$2,$3,'Equipment employee',$4,'custom','Test task write parity','standard',$5,$6)`,
      [employeeId, orgId, employeeUserId, employeeSlug, ownerId, [projectId]],
    );
    await client.query(
      `INSERT INTO projects (id,org_id,name,prefix,lead_id) VALUES
       ($1,$2,'Equipment work',$3,$4),($5,$2,'Other equipment work',$6,$4),($7,$8,'Other org work',$9,$10)`,
      [projectId, orgId, `EQ${suffix.toUpperCase()}`, ownerId, otherProjectId, `EO${suffix.toUpperCase()}`, crossOrgTaskId, otherOrgId, `OX${suffix.toUpperCase()}`, otherOwnerId],
    );
    await client.query(
      `INSERT INTO tasks (id,org_id,project_id,number,title,created_by,metadata) VALUES
       ($1,$2,$3,1,'Inspect serial camera',$4,'{}'),
       ($5,$2,$3,2,'Queue equipment review',$4,'{}'),
       ($6,$2,$3,3,'Personal equipment review',$4,'{}'),
       ($7,$2,$3,4,'PRIVATE EQUIPMENT TASK',$4,$8),
       ($9,$2,$10,1,'Other project equipment task',$4,'{}'),
       ($11,$12,$13,1,'OTHER ORG EQUIPMENT TASK',$14,'{}')`,
      [
        taskId, orgId, projectId, ownerId,
        pendingTaskId, personalTaskId, restrictedTaskId, { visibility: 'restricted', visible_user_ids: [ownerId] },
        outOfProjectTaskId, otherProjectId,
        crossOrgTaskId, otherOrgId, crossOrgTaskId, otherOwnerId,
      ],
    );

    const owner = humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
    const installation = await installModuleFromManifest(owner, {
      schema_version: '1', id: `test.deft.${slug}`, slug, version: '1.0.0', name: 'Equipment register',
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
      data: { serial: `CAM-${suffix}` },
      expected_manifest_digest: installation.manifest_digest,
      idempotency_key: `seed-${suffix}`,
    });
    assert.ok(created.record);
    const resourceId = created.record!.resource_id;
    const args = (taskIdentifier: string, idempotencyKey: string) => ({
      ...employeeArgs(taskIdentifier, idempotencyKey), resource_id: resourceId,
    });

    const link = await MODULE_MCP_WRITE_TOOLS.module_record_task_link!(
      args(taskId, `employee-link-${suffix}`), employeeContext('standard'),
    );
    assert.equal(link.isError, false, link.content[0]?.text);
    const linked = payload(link);
    assert.deepEqual(Object.keys(linked).sort(), ['created', 'edge_id', 'resource_id', 'task_id']);
    assert.deepEqual(linked, {
      resource_id: resourceId, task_id: taskId, edge_id: linked.edge_id, created: true,
    });
    const replay = payload(await MODULE_MCP_WRITE_TOOLS.module_record_task_link!(
      args(taskId, `employee-link-${suffix}`), employeeContext('standard'),
    ));
    assert.deepEqual(replay, linked, 'an employee retry returns the stored link outcome');

    for (const taskIdentifier of [restrictedTaskId, outOfProjectTaskId, crossOrgTaskId]) {
      const denied = await MODULE_MCP_WRITE_TOOLS.module_record_task_link!(
        args(taskIdentifier, `boundary-${taskIdentifier}`), employeeContext('standard'),
      );
      assert.equal(denied.isError, true);
      assert.doesNotMatch(JSON.stringify(denied), /PRIVATE EQUIPMENT TASK|OTHER ORG EQUIPMENT TASK/);
    }
    const changedInput = await MODULE_MCP_WRITE_TOOLS.module_record_task_link!(
      args(pendingTaskId, `employee-link-${suffix}`), employeeContext('standard'),
    );
    assert.equal(changedInput.isError, true);
    assert.match(changedInput.content[0]!.text, /idempotency|different module task-link mutation/i);

    await client.query(
      `UPDATE agent_employees SET disabled_tools = ARRAY['module_record_task_link']::text[] WHERE id = $1`,
      [employeeId],
    );
    const disabled = await MODULE_MCP_WRITE_TOOLS.module_record_task_link!(
      args(pendingTaskId, `disabled-${suffix}`), employeeContext('standard'),
    );
    assert.equal(disabled.isError, true);
    await client.query('UPDATE agent_employees SET disabled_tools = ARRAY[]::text[] WHERE id = $1', [employeeId]);
    await updateModuleInstallation(owner, slug, { agent_access: 'read' });
    const revoked = await MODULE_MCP_WRITE_TOOLS.module_record_task_unlink!(
      args(taskId, `revoked-${suffix}`), employeeContext('standard'),
    );
    assert.equal(revoked.isError, true, 'live module-access revocation denies an otherwise valid edge mutation');
    await updateModuleInstallation(owner, slug, { agent_access: 'write' });

    await client.query("UPDATE agent_employees SET trust_level = 'conservative' WHERE id = $1", [employeeId]);
    const proposalKey = `conservative-${suffix}`;
    const proposed = payload(await MODULE_MCP_WRITE_TOOLS.module_record_task_link!(
      args(pendingTaskId, proposalKey), employeeContext('conservative'),
    ));
    const proposalReplay = payload(await MODULE_MCP_WRITE_TOOLS.module_record_task_link!(
      args(pendingTaskId, proposalKey), employeeContext('conservative'),
    ));
    assert.equal(typeof proposed.approval_id, 'string');
    assert.equal(proposalReplay.approval_id, proposed.approval_id);
    const pending = await client.query(
      `SELECT count(*)::int AS count FROM agent_actions
       WHERE org_id = $1 AND agent_employee_id = $2 AND action = 'module_record_task_link'
         AND approval_status = 'pending'`,
      [orgId, employeeId],
    );
    assert.equal(pending.rows[0].count, 1);
    const pendingEdges = await client.query(
      `SELECT count(*)::int AS count FROM cross_references
       WHERE org_id = $1 AND source_id = $2 AND target_id = $3`,
      [orgId, resourceId, pendingTaskId],
    );
    assert.equal(pendingEdges.rows[0].count, 0);

    const missingModuleToken = (await issuePersonalMcpToken({
      orgId, userId: ownerId, name: 'Missing module write', scopes: ['write:tasks'], createdBy: ownerId,
    })).raw;
    const missingTaskToken = (await issuePersonalMcpToken({
      orgId, userId: ownerId, name: 'Missing task write', scopes: ['write:modules'], createdBy: ownerId,
    })).raw;
    const personalToken = (await issuePersonalMcpToken({
      orgId, userId: ownerId, name: 'Task write parity', scopes: humanWriteScopes, createdBy: ownerId,
    })).raw;
    for (const [index, token] of [missingModuleToken, missingTaskToken].entries()) {
      const denied = await personalCall(token, 'module_record_task_link', {
        resource_id: resourceId, task_identifier: personalTaskId, idempotency_key: `scope-${index}-${suffix}`,
      });
      assert.ok([200, 403].includes(denied.status));
      assert.notEqual(denied.body.isError, false);
      assert.match(JSON.stringify(denied.body), /write:modules|write:tasks/);
    }

    const personalInput = {
      resource_id: resourceId, task_identifier: personalTaskId, idempotency_key: `personal-link-${suffix}`,
    };
    const personalFirst = await personalCall(personalToken, 'module_record_task_link', personalInput);
    assert.equal(personalFirst.status, 200);
    assert.equal(personalFirst.body.isError, false, personalFirst.body.content[0]?.text);
    const humanLinked = payload(personalFirst.body);
    assert.deepEqual(humanLinked, {
      resource_id: resourceId, task_id: personalTaskId, edge_id: humanLinked.edge_id, created: true,
    });
    const personalReplays = await Promise.all(Array.from({ length: 4 }, () => (
      personalCall(personalToken, 'module_record_task_link', personalInput)
    )));
    for (const personalReplay of personalReplays) {
      assert.equal(personalReplay.status, 200);
      assert.deepEqual(payload(personalReplay.body), humanLinked);
    }
    const humanChangedInput = await personalCall(personalToken, 'module_record_task_link', {
      ...personalInput, task_identifier: pendingTaskId,
    });
    assert.equal(humanChangedInput.status, 200);
    assert.equal(humanChangedInput.body.isError, true);
    assert.match(humanChangedInput.body.content[0]?.text ?? '', /idempotency|different module task-link mutation/i);
    await updateModuleInstallation(owner, slug, { enabled: false });
    const revokedModuleReplay = await personalCall(personalToken, 'module_record_task_link', personalInput);
    assert.notEqual(revokedModuleReplay.body.isError, false, 'a completed replay cannot bypass revoked module access');
    assert.doesNotMatch(JSON.stringify(revokedModuleReplay.body), /Personal equipment review/);
    await updateModuleInstallation(owner, slug, { enabled: true });

    const unlinkInput = { ...personalInput, idempotency_key: `personal-unlink-${suffix}` };
    const humanUnlinked = payload((await personalCall(personalToken, 'module_record_task_unlink', unlinkInput)).body);
    assert.deepEqual(humanUnlinked, {
      resource_id: resourceId, task_id: personalTaskId, removed: true,
    });
    const unlinkReplay = payload((await personalCall(personalToken, 'module_record_task_unlink', unlinkInput)).body);
    assert.deepEqual(unlinkReplay, humanUnlinked, 'unlink replays without deleting either native resource');
    const survivors = await client.query(
      'SELECT (SELECT count(*)::int FROM tasks WHERE id = $1) AS tasks, (SELECT count(*)::int FROM module_records WHERE id = $2) AS records',
      [personalTaskId, created.record!.id],
    );
    assert.deepEqual(survivors.rows[0], { tasks: 1, records: 1 });

    const recoveryTitle = `Recover equipment follow-up ${suffix}`;
    const taskCreateInput = {
      title: recoveryTitle, project_id: projectId, idempotency_key: `recovery-task-${suffix}`,
    };
    const taskCreated = await personalCall(personalToken, 'task_create', taskCreateInput);
    assert.equal(taskCreated.body.isError, false, taskCreated.body.content[0]?.text);
    const recoveryTask = payload(taskCreated.body);
    assert.equal(typeof recoveryTask.id, 'string');
    const recoveryLinkInput = {
      resource_id: resourceId, task_identifier: recoveryTask.id, idempotency_key: `recovery-link-${suffix}`,
    };
    await updateModuleInstallation(owner, slug, { enabled: false });
    const failedLink = await personalCall(personalToken, 'module_record_task_link', recoveryLinkInput);
    assert.equal(failedLink.body.isError, true);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM tasks WHERE id = $1', [recoveryTask.id])).rows[0].count, 1);
    await updateModuleInstallation(owner, slug, { enabled: true });
    const recoveredLink = await personalCall(personalToken, 'module_record_task_link', recoveryLinkInput);
    assert.equal(recoveredLink.body.isError, false, recoveredLink.body.content[0]?.text);
    assert.equal(payload(recoveredLink.body).task_id, recoveryTask.id);
    // Even a caller retrying the original task request must recover the same
    // native identity, rather than create a second follow-up to repair a link.
    const taskReplay = await personalCall(personalToken, 'task_create', taskCreateInput);
    assert.equal(payload(taskReplay.body).id, recoveryTask.id);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM tasks WHERE org_id = $1 AND title = $2', [orgId, recoveryTitle])).rows[0].count, 1);

    await client.query(
      'UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2',
      [orgId, ownerId],
    );
    const revokedPersonal = await personalCall(personalToken, 'module_record_task_link', {
      resource_id: resourceId, task_identifier: personalTaskId, idempotency_key: `revoked-personal-${suffix}`,
    });
    assert.notEqual(revokedPersonal.body.isError, false, 'a revoked personal principal cannot recreate the edge');
    const revokedEdges = await client.query(
      `SELECT count(*)::int AS count FROM cross_references
       WHERE org_id = $1 AND source_id = $2 AND target_id = $3`,
      [orgId, resourceId, personalTaskId],
    );
    assert.equal(revokedEdges.rows[0].count, 0);
  } finally {
    for (const id of [orgId, otherOrgId]) {
      for (const table of [
        'attention_items', 'action_receipts', 'module_mutation_receipts', 'agent_actions', 'agent_mcp_call_audit',
        'oauth_audit_events', 'mcp_tokens', 'cross_references', 'audit_log', 'module_record_relations',
        'module_records', 'module_versions', 'module_installations', 'task_activity', 'tasks', 'projects', 'agent_employees', 'org_members',
      ]) await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [id]);
      await client.query('DELETE FROM orgs WHERE id = $1', [id]);
    }
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[ownerId, employeeUserId, otherOwnerId]]);
    await client.end();
  }
});
