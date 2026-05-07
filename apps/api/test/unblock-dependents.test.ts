/**
 * Block 2.5 — unblock_dependents workflow action test.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/unblock-dependents.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import {
  db, tasks, projects, taskRelationships, workflowRules, workflowRuns,
  notifications, orgs, users, orgMembers,
} from '@deft/db';
import { handleWorkflowExecute } from '../src/workers/handlers/workflow-execute.js';

let testOrgId: string;
let testUserId: string;
let assigneeId: string;
let projectId: string;
let blockerId: string;
let dependentId: string;
let doneDepId: string;
let unassignedDepId: string;
let ruleId: string;

before(async () => {
  const existingOrg = await db.query.orgs.findFirst();
  testOrgId = existingOrg?.id ?? crypto.randomUUID();
  if (!existingOrg) await db.insert(orgs).values({ id: testOrgId, name: 'b25', slug: 'b25' });

  const existingUser = await db.query.users.findFirst();
  testUserId = existingUser?.id ?? crypto.randomUUID();
  if (!existingUser) await db.insert(users).values({ id: testUserId, email: `b25-${Date.now()}@t.local`, name: 'b25' });

  const member = await db.query.orgMembers.findFirst({
    where: (m, { and, eq }) => and(eq(m.user_id, testUserId), eq(m.org_id, testOrgId)),
  });
  if (!member) {
    await db.insert(orgMembers).values({ id: crypto.randomUUID(), org_id: testOrgId, user_id: testUserId, role: 'admin' });
  }

  // Distinct assignee user so we can verify notifications delivered to them.
  assigneeId = crypto.randomUUID();
  await db.insert(users).values({ id: assigneeId, email: `b25-assignee-${Date.now()}@t.local`, name: 'b25 assignee' });
  await db.insert(orgMembers).values({ id: crypto.randomUUID(), org_id: testOrgId, user_id: assigneeId, role: 'member' });

  projectId = crypto.randomUUID();
  await db.insert(projects).values({
    id: projectId, org_id: testOrgId, name: 'b25-project', prefix: `B25${Date.now()}`.slice(0, 10),
    created_by: testUserId,
  });

  // Blocker task (this one transitions to done)
  blockerId = crypto.randomUUID();
  await db.insert(tasks).values({
    id: blockerId, org_id: testOrgId, project_id: projectId, number: 1,
    title: 'Blocker task', status: 'in_progress' as any,
    created_by: testUserId,
  });

  // Dependent — todo + has an assignee → should receive notification
  dependentId = crypto.randomUUID();
  await db.insert(tasks).values({
    id: dependentId, org_id: testOrgId, project_id: projectId, number: 2,
    title: 'Waiting task', status: 'todo' as any,
    assignee_id: assigneeId,
    created_by: testUserId,
  });

  // Dependent that is already done — should be SKIPPED
  doneDepId = crypto.randomUUID();
  await db.insert(tasks).values({
    id: doneDepId, org_id: testOrgId, project_id: projectId, number: 3,
    title: 'Already done dependent', status: 'done' as any,
    assignee_id: assigneeId,
    created_by: testUserId,
  });

  // Dependent with no assignee — should be SKIPPED
  unassignedDepId = crypto.randomUUID();
  await db.insert(tasks).values({
    id: unassignedDepId, org_id: testOrgId, project_id: projectId, number: 4,
    title: 'Unassigned dependent', status: 'todo' as any,
    created_by: testUserId,
  });

  // Edges: blocker → depends (all three)
  await db.insert(taskRelationships).values([
    { source_task_id: blockerId, target_task_id: dependentId, type: 'blocks' as any },
    { source_task_id: blockerId, target_task_id: doneDepId, type: 'blocks' as any },
    { source_task_id: blockerId, target_task_id: unassignedDepId, type: 'blocks' as any },
  ]);

  // Workflow rule that wraps unblock_dependents.
  ruleId = crypto.randomUUID();
  await db.insert(workflowRules).values({
    id: ruleId, org_id: testOrgId, name: 'b25-rule',
    trigger_type: 'task.status_changed',
    trigger_config: { to_status: 'done' } as any,
    action_type: 'unblock_dependents',
    action_config: { actions: [{ kind: 'unblock_dependents' }] } as any,
    is_active: true,
    created_by: testUserId,
  });
});

after(async () => {
  await db.delete(notifications).where(eq(notifications.user_id, assigneeId));
  await db.delete(workflowRuns).where(eq(workflowRuns.rule_id, ruleId));
  await db.delete(workflowRules).where(eq(workflowRules.id, ruleId));
  await db.delete(taskRelationships).where(eq(taskRelationships.source_task_id, blockerId));
  await db.delete(tasks).where(inArray(tasks.id, [blockerId, dependentId, doneDepId, unassignedDepId]));
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(orgMembers).where(eq(orgMembers.user_id, assigneeId));
  await db.delete(users).where(eq(users.id, assigneeId));
});

test('unblock_dependents notifies only open, assigned dependents', async () => {
  await handleWorkflowExecute({
    id: 'test-job',
    name: 'workflow-execute',
    data: {
      workflow_id: ruleId,
      task_id: blockerId,
      actor_user_id: testUserId,
    },
  } as any);

  const notifs = await db
    .select()
    .from(notifications)
    .where(eq(notifications.user_id, assigneeId));
  const unblockNotifs = notifs.filter(
    (n) => (n.metadata as any)?.subtype === 'unblocked',
  );

  // Should be exactly 1: the open+assigned dependent.
  // NOT the done one, NOT the unassigned one.
  assert.equal(unblockNotifs.length, 1, `expected 1, got ${unblockNotifs.length}`);
  assert.equal((unblockNotifs[0]!.metadata as any).task_id, dependentId);
  assert.equal((unblockNotifs[0]!.metadata as any).unblocker_task_id, blockerId);
});

test('workflow run recorded with success', async () => {
  const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.rule_id, ruleId));
  assert.ok(runs.length >= 1);
  const last = runs[runs.length - 1]!;
  assert.equal(last.status, 'success');
  const actions = (last.result as any).actions as any[];
  assert.ok(actions.some((a) => a.kind === 'unblock_dependents' && a.ok === true));
});
