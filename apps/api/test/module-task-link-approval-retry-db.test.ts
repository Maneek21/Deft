import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';

import { closeDb } from '../src/lib/db.js';
import { approveAction, rejectAction } from '../src/lib/agent-approval-resolver.js';
import { executeActionDirect } from '../src/lib/agent-actions.js';
import {
  createModuleRecord,
  humanModuleActor,
  installModuleFromManifest,
  updateModuleInstallation,
} from '../src/lib/module-service.js';
import { linkModuleRecordToTask } from '../src/lib/module-task-links.js';
import { executeHumanModuleTaskWrite } from '../src/lib/module-task-write-operation.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
after(closeDb);

test('reviewed task-link actions preserve retry identity and recover approved claims', {
  skip: !databaseUrl,
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgId = randomUUID();
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const employeeUserId = randomUUID();
  const employeeId = randomUUID();
  const projectId = randomUUID();
  const firstTaskId = randomUUID();
  const secondTaskId = randomUUID();
  const slug = `approval-equipment-${suffix}`;
  let resourceId = '';

  const propose = (
    action: 'module_record_task_link' | 'module_record_task_unlink',
    taskIdentifier: string,
    idempotencyKey: string,
  ) => executeActionDirect(action, {
    resource_id: resourceId,
    task_identifier: taskIdentifier,
    idempotency_key: idempotencyKey,
  }, orgId, ownerId, null, 'quick', {
    source: 'agent_chat',
    agentEmployeeId: employeeId,
  });

  const assertTerminalEnvelope = async (actionId: string, expectedTaskId: string) => {
    const terminal = await client.query(
      'SELECT params FROM agent_actions WHERE org_id = $1 AND id = $2',
      [orgId, actionId],
    );
    assert.equal(terminal.rowCount, 1);
    const params = terminal.rows[0].params as Record<string, unknown>;
    assert.equal(params.resource_id, resourceId);
    assert.equal(params.task_identifier, expectedTaskId);
    assert.equal('idempotency_key' in params, false);
    assert.match(String(params.idempotency_digest), /^sha256:[a-f0-9]{64}$/);
    assert.match(String(params.input_digest), /^sha256:[a-f0-9]{64}$/);
  };

  try {
    await client.query('INSERT INTO orgs (id,name,slug) VALUES ($1,$2,$3)', [
      orgId, 'Task-link approval retry', `task-link-approval-${suffix}`,
    ]);
    await client.query(
      `INSERT INTO users (id,name,email,kind,is_agent) VALUES
       ($1,'Owner',$2,'human',false),($3,'Member',$4,'human',false),
       ($5,'Employee',$6,'agent',true)`,
      [
        ownerId, `owner-${suffix}@example.test`, memberId, `member-${suffix}@example.test`,
        employeeUserId, `employee-${suffix}@example.test`,
      ],
    );
    await client.query(
      `INSERT INTO org_members (id,org_id,user_id,role,is_active) VALUES
       ($1,$2,$3,'owner',true),($4,$2,$5,'member',true),($6,$2,$7,'member',true)`,
      [randomUUID(), orgId, ownerId, randomUUID(), memberId, randomUUID(), employeeUserId],
    );
    await client.query(
      `INSERT INTO projects (id,org_id,name,prefix,lead_id)
       VALUES ($1,$2,'Approval work',$3,$4)`,
      [projectId, orgId, `AR${suffix.toUpperCase()}`, ownerId],
    );
    await client.query(
      `INSERT INTO tasks (id,org_id,project_id,number,title,created_by,metadata) VALUES
       ($1,$2,$3,1,'First approval target',$4,'{}'),
       ($5,$2,$3,2,'Second approval target',$4,'{}')`,
      [firstTaskId, orgId, projectId, ownerId, secondTaskId],
    );
    await client.query(
      `INSERT INTO agent_employees
       (id,org_id,user_id,name,slug,role,system_prompt,trust_level,created_by,project_ids)
       VALUES ($1,$2,$3,'Approval employee',$4,'custom','Test task-link approval retry','conservative',$5,$6)`,
      [employeeId, orgId, employeeUserId, `approval-employee-${suffix}`, ownerId, [projectId]],
    );

    const owner = humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
    const installation = await installModuleFromManifest(owner, {
      schema_version: '1',
      id: `test.deft.${slug}`,
      slug,
      version: '1.0.0',
      name: 'Approval equipment',
      collections: [{
        key: 'assets',
        name: 'Assets',
        singular_name: 'Asset',
        fields: [{ key: 'serial', label: 'Serial', type: 'text', required: true }],
        search: { title_field: 'serial', fields: ['serial'] },
        views: [{ key: 'all', name: 'All assets', type: 'table', fields: ['serial'] }],
      }],
    }, { source: 'sideloaded' });
    await updateModuleInstallation(owner, slug, { agent_access: 'write' });
    const created = await createModuleRecord(owner, {
      module_id: installation.module_id,
      collection_key: 'assets',
      data: { serial: `SERIAL-${suffix}` },
      expected_manifest_digest: installation.manifest_digest,
      idempotency_key: `seed-${suffix}`,
    });
    assert.ok(created.record);
    resourceId = created.record!.resource_id;

    const linkKey = `review-link-${suffix}`;
    const pendingLink = await propose('module_record_task_link', firstTaskId, linkKey);
    assert.equal(pendingLink.requiresApproval, true);
    const approvedLink = await approveAction(pendingLink.actionId, ownerId);
    assert.equal(approvedLink.status, 'approved');
    await assertTerminalEnvelope(pendingLink.actionId, firstTaskId);

    const linkReplay = await propose('module_record_task_link', firstTaskId, linkKey);
    assert.equal(linkReplay.actionId, pendingLink.actionId);
    assert.equal(linkReplay.success, true, linkReplay.error);
    await assert.rejects(
      propose('module_record_task_link', secondTaskId, linkKey),
      /different module task-link mutation/i,
    );

    const unlinkKey = `review-unlink-${suffix}`;
    const pendingUnlink = await propose('module_record_task_unlink', firstTaskId, unlinkKey);
    assert.equal(pendingUnlink.requiresApproval, true);
    const approvedUnlink = await approveAction(pendingUnlink.actionId, ownerId);
    assert.equal(approvedUnlink.status, 'approved');
    await assertTerminalEnvelope(pendingUnlink.actionId, firstTaskId);
    const unlinkReplay = await propose('module_record_task_unlink', firstTaskId, unlinkKey);
    assert.equal(unlinkReplay.actionId, pendingUnlink.actionId);
    assert.equal(unlinkReplay.success, true, unlinkReplay.error);

    const recoveryKey = `review-recovery-${suffix}`;
    const pendingRecovery = await propose('module_record_task_link', secondTaskId, recoveryKey);
    assert.equal(pendingRecovery.requiresApproval, true);
    await client.query(
      `UPDATE agent_actions SET approval_status='approved', approved_at=now(), approved_by_user_id=$2
       WHERE org_id=$1 AND id=$3 AND approval_status='pending'`,
      [orgId, ownerId, pendingRecovery.actionId],
    );
    const recovered = await approveAction(pendingRecovery.actionId, ownerId);
    assert.equal(recovered.status, 'approved');
    await assertTerminalEnvelope(pendingRecovery.actionId, secondTaskId);

    await linkModuleRecordToTask(owner, firstTaskId, resourceId);
    for (const [action, taskIdentifier] of [
      ['module_record_task_link', firstTaskId],
      ['module_record_task_unlink', firstTaskId],
    ] as const) {
      const rejectedProposal = await propose(action, taskIdentifier, `reject-${action}-${suffix}`);
      assert.equal(rejectedProposal.requiresApproval, true);
      const rejected = await rejectAction(rejectedProposal.actionId, ownerId, 'Reviewer declined');
      assert.equal(rejected.status, 'rejected');
      await assertTerminalEnvelope(rejectedProposal.actionId, taskIdentifier);
      assert.equal((await rejectAction(rejectedProposal.actionId, ownerId)).status, 'rejected');
      const receipts = await client.query(
        `SELECT decision, approver_id, action_params_json FROM action_receipts
         WHERE org_id=$1 AND action_id=$2`,
        [orgId, rejectedProposal.actionId],
      );
      assert.equal(receipts.rowCount, 1);
      assert.equal(receipts.rows[0].decision, 'rejected');
      assert.equal(receipts.rows[0].approver_id, ownerId);
      assert.equal(receipts.rows[0].action_params_json.resource_id, resourceId);
      assert.equal(receipts.rows[0].action_params_json.task_identifier, taskIdentifier);
    }

    const originalPrefix = 'RMAP';
    const originalProjectId = randomUUID();
    const replacementProjectId = randomUUID();
    const originalTaskId = randomUUID();
    const replacementTaskId = randomUUID();
    await client.query(
      `INSERT INTO projects (id,org_id,name,prefix,lead_id) VALUES
       ($1,$2,'Original remap project',$3,$4),
       ($5,$2,'Replacement remap project',$6,$4)`,
      [originalProjectId, orgId, originalPrefix, ownerId, replacementProjectId, 'NEXT'],
    );
    await client.query(
      `INSERT INTO tasks (id,org_id,project_id,number,title,created_by,metadata) VALUES
       ($1,$2,$3,1,'Original remap task',$4,'{}'),
       ($5,$2,$6,1,'Replacement remap task',$4,'{}')`,
      [originalTaskId, orgId, originalProjectId, ownerId, replacementTaskId, replacementProjectId],
    );
    const memberMcpActor = humanModuleActor({
      orgId,
      userId: memberId,
      role: 'member',
      source: 'mcp',
      scopes: ['write:modules', 'write:tasks'],
    });
    const remapInput = {
      resource_id: resourceId,
      task_identifier: `${originalPrefix}-1`,
      idempotency_key: `prefix-remap-${suffix}`,
    };
    const firstHumanLink = await executeHumanModuleTaskWrite(
      'module_record_task_link', memberMcpActor, remapInput, `client-${suffix}`,
    );
    assert.equal(firstHumanLink.task_id, originalTaskId);
    await client.query(
      `UPDATE tasks SET metadata=$3::jsonb WHERE org_id=$1 AND id=$2`,
      [orgId, originalTaskId, JSON.stringify({ visibility: 'restricted', visible_user_ids: [ownerId] })],
    );
    await client.query('UPDATE projects SET prefix=$3 WHERE org_id=$1 AND id=$2', [
      orgId, originalProjectId, 'OLDX',
    ]);
    await client.query('UPDATE projects SET prefix=$3 WHERE org_id=$1 AND id=$2', [
      orgId, replacementProjectId, originalPrefix,
    ]);
    await assert.rejects(
      executeHumanModuleTaskWrite(
        'module_record_task_link', memberMcpActor, remapInput, `client-${suffix}`,
      ),
      (error: any) => error?.code === 'TASK_NOT_FOUND',
      'a symbolic-key replay must reauthorize the originally mutated task',
    );
  } finally {
    for (const table of [
      'attention_deliveries', 'attention_events', 'attention_items', 'action_receipts',
      'module_mutation_receipts', 'agent_actions', 'cross_references', 'audit_log',
      'module_record_relations', 'module_records', 'module_versions', 'module_installations',
      'task_activity', 'tasks', 'projects', 'agent_employees', 'org_members',
    ]) await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
    await client.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[ownerId, memberId, employeeUserId]]);
    await client.end();
  }
});
