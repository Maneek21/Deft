import test from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray } from 'drizzle-orm';
import {
  auditLog,
  agentActions,
  agentEmployees,
  actionReceipts,
  crossReferences,
  db,
  moduleInstallations,
  moduleMutationReceipts,
  moduleRecordRelations,
  moduleRecords,
  moduleSavedViews,
  moduleVersions,
  orgMembers,
  orgs,
  projects,
  tasks,
  users,
} from '@deft/db';
import {
  createModuleRecord,
  deftyModuleActor,
  employeeModuleActor,
  humanModuleActor,
  installModuleFromManifest,
  updateModuleInstallation,
} from '../src/lib/module-service.js';
import {
  linkModuleRecordToTask,
  listModuleRecordTaskLinks,
  listTaskModuleRecordLinks,
  unlinkModuleRecordFromTask,
} from '../src/lib/module-task-links.js';
import {
  claimModuleTaskLinkAgentAction,
  executeActionDirect,
} from '../src/lib/agent-actions.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import {
  humanApprovalApprove,
  humanApprovalGet,
  humanApprovalList,
} from '../src/lib/mcp-tools/human.js';
import { approvalToAttentionDraft } from '../src/lib/attention.js';

function toolPayload(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0]!.text);
}

test('module record task links enforce native task and module boundaries', async () => {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const orgId = `module-task-org-${suffix}`;
  const otherOrgId = `module-task-other-org-${suffix}`;
  const ownerId = `module-task-owner-${suffix}`;
  const memberId = `module-task-member-${suffix}`;
  const guestId = `module-task-guest-${suffix}`;
  const outsiderId = `module-task-outsider-${suffix}`;
  const employeeUserId = `module-task-employee-user-${suffix}`;
  const employeeId = `module-task-employee-${suffix}`;
  const projectId = `module-task-project-${suffix}`;
  const taskId = `module-task-visible-${suffix}`;
  const restrictedTaskId = `module-task-restricted-${suffix}`;
  const slug = `equipment-${crypto.randomUUID().slice(0, 8)}`;
  const moduleId = `test.deft.${slug}`;
  const privateRecordTitle = `CONFIDENTIAL-CONTACT-${crypto.randomUUID()}`;

  await db.insert(orgs).values([
    { id: orgId, name: 'Module task links', slug: `module-task-${suffix}` },
    { id: otherOrgId, name: 'Other module task links', slug: `module-task-other-${suffix}` },
  ]);
  await db.insert(users).values([
    { id: ownerId, email: `${ownerId}@test.local`, name: 'Owner' },
    { id: memberId, email: `${memberId}@test.local`, name: 'Member' },
    { id: guestId, email: `${guestId}@test.local`, name: 'Guest' },
    { id: outsiderId, email: `${outsiderId}@test.local`, name: 'Outsider' },
    {
      id: employeeUserId,
      email: `${employeeUserId}@test.local`,
      name: 'Module task employee',
      kind: 'agent',
      is_agent: true,
      agent_employee_id: employeeId,
    },
  ]);
  await db.insert(orgMembers).values([
    { id: crypto.randomUUID(), org_id: orgId, user_id: ownerId, role: 'owner' },
    { id: crypto.randomUUID(), org_id: orgId, user_id: memberId, role: 'member' },
    { id: crypto.randomUUID(), org_id: orgId, user_id: guestId, role: 'guest' },
    { id: crypto.randomUUID(), org_id: otherOrgId, user_id: outsiderId, role: 'owner' },
    { id: crypto.randomUUID(), org_id: orgId, user_id: employeeUserId, role: 'member' },
  ]);
  await db.insert(agentEmployees).values({
    id: employeeId,
    org_id: orgId,
    user_id: employeeUserId,
    name: 'Module task employee',
    slug: `module-task-employee-${crypto.randomUUID().slice(0, 8)}`,
    role: 'custom',
    system_prompt: 'Test module task link policy',
    trust_level: 'autonomous',
    created_by: ownerId,
  });
  await db.insert(projects).values({
    id: projectId,
    org_id: orgId,
    name: 'Operations',
    prefix: `MT${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
    lead_id: ownerId,
  });
  await db.insert(tasks).values([
    {
      id: taskId,
      org_id: orgId,
      project_id: projectId,
      number: 1,
      title: 'Inspect camera',
      status: 'todo',
      priority: 'p1',
      created_by: ownerId,
    },
    {
      id: restrictedTaskId,
      org_id: orgId,
      project_id: projectId,
      number: 2,
      title: 'Restricted inspection',
      created_by: ownerId,
      metadata: { visibility: 'restricted', visible_user_ids: [ownerId] },
    },
  ]);

  const owner = humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
  const member = humanModuleActor({ orgId, userId: memberId, role: 'member', source: 'rest' });
  const guest = humanModuleActor({ orgId, userId: guestId, role: 'guest', source: 'rest' });
  const outsider = humanModuleActor({ orgId: otherOrgId, userId: outsiderId, role: 'owner', source: 'rest' });

  try {
    const installation = await installModuleFromManifest(owner, {
      schema_version: '1',
      id: moduleId,
      slug,
      version: '1.0.0',
      name: 'Equipment register',
      collections: [{
        key: 'assets',
        name: 'Assets',
        singular_name: 'Asset',
        fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
        search: { title_field: 'name', fields: ['name'] },
        views: [{ key: 'all', name: 'All assets', type: 'table', fields: ['name'] }],
      }],
    }, { source: 'sideloaded' });
    const created = await createModuleRecord(member, {
      module_id: moduleId,
      collection_key: 'assets',
      data: { name: privateRecordTitle },
      expected_manifest_digest: installation.manifest_digest,
      idempotency_key: crypto.randomUUID(),
    });
    const record = created.record!;

    const first = await linkModuleRecordToTask(member, taskId, record.resource_id);
    const replay = await linkModuleRecordToTask(member, taskId, record.resource_id);
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(first.link.title, privateRecordTitle);
    assert.equal(first.link.module_name, 'Equipment register');
    assert.equal(first.link.collection_name, 'Assets');
    assert.equal(first.link.url, `/modules/${slug}/assets/${record.id}`);

    const taskLinks = await listTaskModuleRecordLinks(member, taskId);
    assert.deepEqual(taskLinks.map((link) => link.resource_id), [record.resource_id]);
    const recordLinks = await listModuleRecordTaskLinks(member, slug, record.id);
    assert.equal(recordLinks.length, 1);
    assert.equal(recordLinks[0]?.task_id, taskId);
    assert.match(recordLinks[0]?.identifier ?? '', /^MT[A-F0-9]+-1$/);

    await assert.rejects(
      linkModuleRecordToTask(member, restrictedTaskId, record.resource_id),
      (error: any) => error?.code === 'TASK_NOT_FOUND',
    );
    await assert.rejects(
      listTaskModuleRecordLinks(guest, taskId),
      (error: any) => error?.code === 'MODULE_ACCESS_DENIED',
    );
    await assert.rejects(
      linkModuleRecordToTask(outsider, taskId, record.resource_id),
      (error: any) => error?.code === 'TASK_NOT_FOUND',
    );

    await updateModuleInstallation(owner, slug, { enabled: false });
    assert.deepEqual(await listTaskModuleRecordLinks(owner, taskId), []);
    await assert.rejects(
      linkModuleRecordToTask(owner, taskId, record.resource_id),
      (error: any) => error?.code === 'MODULE_DISABLED',
    );
    await assert.rejects(
      unlinkModuleRecordFromTask(owner, taskId, record.id),
      (error: any) => error?.code === 'MODULE_DISABLED',
    );

    await updateModuleInstallation(owner, slug, { enabled: true });
    await unlinkModuleRecordFromTask(member, taskId, record.id);
    assert.deepEqual(await listTaskModuleRecordLinks(member, taskId), []);

    // Defty cannot turn read access into a generic edge write. The denial is
    // enforced inside the mutation transaction for both link and unlink.
    const defty = deftyModuleActor({ orgId, userId: ownerId, role: 'owner' });
    await updateModuleInstallation(owner, slug, { agent_access: 'read' });
    await assert.rejects(
      linkModuleRecordToTask(defty, taskId, record.resource_id),
      (error: any) => error?.code === 'MODULE_ACCESS_DENIED',
    );
    await linkModuleRecordToTask(owner, taskId, record.resource_id);
    await assert.rejects(
      unlinkModuleRecordFromTask(defty, taskId, record.id),
      (error: any) => error?.code === 'MODULE_ACCESS_DENIED',
    );
    const deniedKey = crypto.randomUUID();
    await assert.rejects(
      executeActionDirect(
        'module_record_task_link',
        { resource_id: record.resource_id, task_identifier: taskId, idempotency_key: deniedKey },
        orgId,
        ownerId,
        null,
        'quick',
      ),
      (error: any) => error?.code === 'MODULE_ACCESS_DENIED',
    );
    const deniedActions = await db
      .select({ id: agentActions.id })
      .from(agentActions)
      .where(eq(agentActions.org_id, orgId));
    assert.equal(deniedActions.length, 0, 'denied edge writes never persist an action proposal');
    await unlinkModuleRecordFromTask(owner, taskId, record.id);

    // Static Defty writes claim one durable action by caller-stable key. A
    // lost-response retry reuses its result, budget slot, approval and receipt.
    await updateModuleInstallation(owner, slug, { agent_access: 'write' });
    const employee = employeeModuleActor({
      orgId,
      employeeId,
      trustLevel: 'autonomous',
      source: 'runtime',
    });
    await db.update(agentEmployees).set({
      unhealthy: true,
      unhealthy_reason: 'test circuit breaker',
    }).where(eq(agentEmployees.id, employeeId));
    await assert.rejects(
      linkModuleRecordToTask(employee, taskId, record.resource_id),
      (error: any) => error?.code === 'MODULE_ACCESS_DENIED' && /unhealthy/i.test(error.message),
    );
    await db.update(agentEmployees).set({
      unhealthy: false,
      unhealthy_reason: null,
      disabled_tools: ['module_record_task_link'],
    }).where(eq(agentEmployees.id, employeeId));
    await assert.rejects(
      linkModuleRecordToTask(employee, taskId, record.resource_id),
      (error: any) => error?.code === 'MODULE_ACCESS_DENIED' && /disabled/i.test(error.message),
    );
    await db.update(agentEmployees).set({
      disabled_tools: ['module_record_task_unlink'],
    }).where(eq(agentEmployees.id, employeeId));
    await assert.rejects(
      unlinkModuleRecordFromTask(employee, taskId, record.id),
      (error: any) => error?.code === 'MODULE_ACCESS_DENIED' && /disabled/i.test(error.message),
    );
    await db.update(agentEmployees).set({
      disabled_tools: [],
      trust_level: 'conservative',
    }).where(eq(agentEmployees.id, employeeId));
    const trustRaceKey = crypto.randomUUID();
    const trustRegated = await claimModuleTaskLinkAgentAction({
      action: 'module_record_task_link',
      input: {
        resource_id: record.resource_id,
        task_identifier: taskId,
        idempotency_key: trustRaceKey,
      },
      orgId,
      userId: employeeUserId,
      agentEmployeeId: employeeId,
      values: {
        org_id: orgId,
        user_id: employeeUserId,
        agent_employee_id: employeeId,
        source: 'auto_execute',
        action: 'module_record_task_link',
        params: {},
        approval_tier: 'quick',
        approval_status: 'approved',
        approved_at: new Date(),
      },
    });
    assert.equal(trustRegated.action.approval_status, 'pending');
    await db.delete(agentActions).where(eq(agentActions.id, trustRegated.action.id));
    await db.update(agentEmployees).set({ trust_level: 'autonomous' }).where(eq(agentEmployees.id, employeeId));

    const pendingKey = crypto.randomUUID();
    const pendingValues = {
      org_id: orgId,
      user_id: ownerId,
      action: 'module_record_task_link',
      params: {},
      approval_tier: 'quick' as const,
      approval_status: 'pending' as const,
    };
    const pendingClaim = await claimModuleTaskLinkAgentAction({
      action: 'module_record_task_link',
      input: { resource_id: record.resource_id, task_identifier: taskId, idempotency_key: pendingKey },
      orgId,
      userId: ownerId,
      values: pendingValues,
    });
    const pendingReplay = await claimModuleTaskLinkAgentAction({
      action: 'module_record_task_link',
      input: { resource_id: record.resource_id, task_identifier: taskId, idempotency_key: pendingKey },
      orgId,
      userId: ownerId,
      values: pendingValues,
    });
    assert.equal(pendingReplay.reused, true);
    assert.equal(pendingReplay.action.id, pendingClaim.action.id);

    const attentionDraft = approvalToAttentionDraft(pendingClaim.action, ownerId);
    assert.equal(JSON.stringify(attentionDraft.metadata).includes(pendingKey), false);
    const workspaceOnlyMcp = {
      org_id: orgId,
      user_id: ownerId,
      role: 'owner' as const,
      scopes: ['read:workspace', 'write:workspace'],
      principal_kind: 'human' as const,
    };
    const hiddenApprovalList = await humanApprovalList({ status: 'pending' }, workspaceOnlyMcp);
    assert.equal(JSON.stringify(toolPayload(hiddenApprovalList)).includes(pendingClaim.action.id), false);
    assert.equal((await humanApprovalGet(
      { action_id: pendingClaim.action.id },
      workspaceOnlyMcp,
    )).isError, true);
    const readModuleMcp = {
      ...workspaceOnlyMcp,
      scopes: [...workspaceOnlyMcp.scopes, 'read:modules'],
    };
    assert.equal((await humanApprovalGet(
      { action_id: pendingClaim.action.id },
      readModuleMcp,
    )).isError, false);
    assert.equal((await humanApprovalApprove(
      { action_id: pendingClaim.action.id },
      readModuleMcp,
    )).isError, true, 'write:modules is required to approve a module task-link action');

    const [guestOwnedAction] = await db.insert(agentActions).values({
      org_id: orgId,
      user_id: guestId,
      action: 'module_record_task_link',
      params: {
        resource_id: record.resource_id,
        task_identifier: taskId,
        idempotency_key: `guest-hidden-${privateRecordTitle}`,
      },
      approval_tier: 'quick',
      approval_status: 'pending',
    }).returning();
    const guestModuleMcp = {
      org_id: orgId,
      user_id: guestId,
      role: 'guest' as const,
      scopes: ['read:workspace', 'write:workspace', 'read:modules', 'write:modules'],
      principal_kind: 'human' as const,
    };
    const guestApprovals = await humanApprovalList({ status: 'pending' }, guestModuleMcp);
    assert.equal(JSON.stringify(toolPayload(guestApprovals)).includes(guestOwnedAction!.id), false);
    assert.equal((await humanApprovalGet(
      { action_id: guestOwnedAction!.id },
      guestModuleMcp,
    )).isError, true);
    await db.delete(agentActions).where(eq(agentActions.id, guestOwnedAction!.id));
    await db.delete(agentActions).where(eq(agentActions.id, pendingClaim.action.id));

    const linkKey = crypto.randomUUID();
    const agentLink = await executeActionDirect(
      'module_record_task_link',
      { resource_id: record.resource_id, task_identifier: taskId, idempotency_key: linkKey },
      orgId,
      ownerId,
      null,
      'quick',
    );
    assert.equal(agentLink.success, true, agentLink.error);
    assert.equal(agentLink.result.created, true);
    const agentLinkReplay = await executeActionDirect(
      'module_record_task_link',
      { resource_id: record.resource_id, task_identifier: taskId, idempotency_key: linkKey },
      orgId,
      ownerId,
      null,
      'quick',
    );
    assert.equal(agentLinkReplay.actionId, agentLink.actionId);
    assert.equal(agentLinkReplay.success, true, agentLinkReplay.error);
    assert.equal(agentLinkReplay.result.created, true, 'replay returns the stored terminal result');
    await assert.rejects(
      executeActionDirect(
        'module_record_task_link',
        { resource_id: record.resource_id, task_identifier: restrictedTaskId, idempotency_key: linkKey },
        orgId,
        ownerId,
        null,
        'quick',
      ),
      /different module task-link mutation/i,
    );

    // Exercise Defty's actual non-action read dispatcher, not the direct
    // action executor used by the governed writes.
    const agentRead = await executeToolCall(
      'module_record_task_links',
      { resource_id: record.resource_id },
      orgId,
      ownerId,
    );
    assert.equal(agentRead.result.count, 1);
    assert.equal(agentRead.result.tasks[0].task_id, taskId);
    assert.deepEqual(agentRead.citations.map((citation) => citation.id), [taskId]);

    const [terminalLinkAction] = await db
      .select({ params: agentActions.params })
      .from(agentActions)
      .where(eq(agentActions.id, agentLink.actionId));
    const terminalLinkParams = terminalLinkAction?.params as Record<string, unknown>;
    assert.equal('idempotency_key' in terminalLinkParams, false);
    assert.match(String(terminalLinkParams.idempotency_digest), /^sha256:[a-f0-9]{64}$/);
    const linkReceipts = await db
      .select({ id: actionReceipts.id })
      .from(actionReceipts)
      .where(eq(actionReceipts.action_id, agentLink.actionId));
    assert.equal(linkReceipts.length, 1);

    const unlinkKey = crypto.randomUUID();
    const agentUnlink = await executeActionDirect(
      'module_record_task_unlink',
      { resource_id: record.resource_id, task_identifier: taskId, idempotency_key: unlinkKey },
      orgId,
      ownerId,
      null,
      'quick',
    );
    assert.equal(agentUnlink.success, true, agentUnlink.error);
    assert.equal(agentUnlink.result.removed, true);
    const agentUnlinkReplay = await executeActionDirect(
      'module_record_task_unlink',
      { resource_id: record.resource_id, task_identifier: taskId, idempotency_key: unlinkKey },
      orgId,
      ownerId,
      null,
      'quick',
    );
    assert.equal(agentUnlinkReplay.actionId, agentUnlink.actionId);
    assert.equal(agentUnlinkReplay.success, true, agentUnlinkReplay.error);
    assert.equal(agentUnlinkReplay.result.removed, true);
    const unlinkReceipts = await db
      .select({ id: actionReceipts.id })
      .from(actionReceipts)
      .where(eq(actionReceipts.action_id, agentUnlink.actionId));
    assert.equal(unlinkReceipts.length, 1);

    // Five concurrent lost-response-equivalent calls serialize on the same
    // stable claim. Only the winner can consume employee budget or write the
    // edge/audit/receipt; the other four replay its terminal action.
    const employeeLinkKey = crypto.randomUUID();
    const [budgetBefore] = await db
      .select({ count: agentEmployees.daily_action_count })
      .from(agentEmployees)
      .where(eq(agentEmployees.id, employeeId));
    const linkAuditsBefore = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(
        eq(auditLog.org_id, orgId),
        eq(auditLog.action, 'module_record.task_linked'),
      ));
    const concurrentLinks = await Promise.all(Array.from({ length: 5 }, () =>
      executeActionDirect(
        'module_record_task_link',
        {
          resource_id: record.resource_id,
          task_identifier: taskId,
          idempotency_key: employeeLinkKey,
        },
        orgId,
        employeeUserId,
        null,
        'quick',
        { agentEmployeeId: employeeId, source: 'auto_execute' },
      ),
    ));
    assert.equal(new Set(concurrentLinks.map((result) => result.actionId)).size, 1);
    assert.equal(concurrentLinks.every((result) => result.success), true);
    assert.equal(concurrentLinks.every((result) => result.result.created === true), true);
    const concurrentActionId = concurrentLinks[0]!.actionId;
    const concurrentActions = await db
      .select({ id: agentActions.id })
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, orgId),
        eq(agentActions.action, 'module_record_task_link'),
        eq(agentActions.agent_employee_id, employeeId),
      ));
    assert.deepEqual(concurrentActions.map((row) => row.id), [concurrentActionId]);
    const concurrentEdges = await db
      .select({ id: crossReferences.id })
      .from(crossReferences)
      .where(and(
        eq(crossReferences.org_id, orgId),
        eq(crossReferences.source_type, 'module_record'),
        eq(crossReferences.source_id, record.resource_id),
        eq(crossReferences.target_type, 'task'),
        eq(crossReferences.target_id, taskId),
      ));
    assert.equal(concurrentEdges.length, 1);
    const linkAuditsAfter = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(
        eq(auditLog.org_id, orgId),
        eq(auditLog.action, 'module_record.task_linked'),
      ));
    assert.equal(linkAuditsAfter.length - linkAuditsBefore.length, 1);
    const concurrentReceipts = await db
      .select({ id: actionReceipts.id })
      .from(actionReceipts)
      .where(eq(actionReceipts.action_id, concurrentActionId));
    assert.equal(concurrentReceipts.length, 1);
    const [budgetAfter] = await db
      .select({ count: agentEmployees.daily_action_count })
      .from(agentEmployees)
      .where(eq(agentEmployees.id, employeeId));
    assert.equal(budgetAfter!.count - budgetBefore!.count, 1);
    const memberActivity = await executeToolCall(
      'get_agent_activity',
      { limit: 100 },
      orgId,
      memberId,
    );
    assert.equal(JSON.stringify(memberActivity.result).includes(concurrentActionId), false);
    const ownerActivity = await executeToolCall(
      'get_agent_activity',
      { limit: 100 },
      orgId,
      ownerId,
    );
    assert.equal(JSON.stringify(ownerActivity.result).includes(concurrentActionId), true);
    await unlinkModuleRecordFromTask(owner, taskId, record.id);

    const terminalAgentActions = await db
      .select({ params: agentActions.params, result: agentActions.result })
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, orgId),
        inArray(agentActions.action, ['module_record_task_link', 'module_record_task_unlink']),
      ));
    const terminalReceipts = await db
      .select({
        params: actionReceipts.action_params_json,
        result: actionReceipts.result_json,
      })
      .from(actionReceipts)
      .where(eq(actionReceipts.org_id, orgId));
    const durableAgentHistory = JSON.stringify({ terminalAgentActions, terminalReceipts });
    assert.equal(durableAgentHistory.includes(privateRecordTitle), false);
    assert.equal(durableAgentHistory.includes(linkKey), false);
    assert.equal(durableAgentHistory.includes(unlinkKey), false);
    assert.equal(durableAgentHistory.includes(deniedKey), false);
    assert.equal(durableAgentHistory.includes(employeeLinkKey), false);

    const linkAudits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(
        eq(auditLog.org_id, orgId),
        inArray(auditLog.action, ['module_record.task_linked', 'module_record.task_unlinked']),
      ));
    assert.deepEqual(linkAudits.map((row) => row.action).sort(), [
      'module_record.task_linked',
      'module_record.task_linked',
      'module_record.task_linked',
      'module_record.task_linked',
      'module_record.task_unlinked',
      'module_record.task_unlinked',
      'module_record.task_unlinked',
      'module_record.task_unlinked',
    ]);
  } finally {
    await db.delete(crossReferences).where(eq(crossReferences.org_id, orgId));
    await db.delete(auditLog).where(eq(auditLog.org_id, orgId));
    await db.delete(actionReceipts).where(eq(actionReceipts.org_id, orgId));
    await db.delete(agentActions).where(eq(agentActions.org_id, orgId));
    await db.delete(moduleRecordRelations).where(eq(moduleRecordRelations.org_id, orgId));
    await db.delete(moduleSavedViews).where(eq(moduleSavedViews.org_id, orgId));
    await db.delete(moduleMutationReceipts).where(eq(moduleMutationReceipts.org_id, orgId));
    await db.delete(moduleRecords).where(eq(moduleRecords.org_id, orgId));
    await db.delete(moduleVersions).where(eq(moduleVersions.org_id, orgId));
    await db.delete(moduleInstallations).where(eq(moduleInstallations.org_id, orgId));
    await db.delete(tasks).where(eq(tasks.org_id, orgId));
    await db.delete(projects).where(eq(projects.org_id, orgId));
    await db.delete(agentEmployees).where(eq(agentEmployees.id, employeeId));
    await db.delete(orgMembers).where(inArray(orgMembers.org_id, [orgId, otherOrgId]));
    await db.delete(users).where(inArray(users.id, [
      ownerId,
      memberId,
      guestId,
      outsiderId,
      employeeUserId,
    ]));
    await db.delete(orgs).where(inArray(orgs.id, [orgId, otherOrgId]));
  }
});
