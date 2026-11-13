/**
 * Workflow jobs act as, and address, only active members of the rule's
 * workspace; queued jobs reach their handler with the queue row's org and
 * scheduler key.
 *
 * Run: pnpm --filter @deft/api test test/workflow-member-scope.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  db, orgs, users, orgMembers, projects, tasks, taskRelationships, taskComments,
  notifications, workflowRules, workflowRuns, jobQueue,
} from '@deft/db';
import { handleWorkflowExecute } from '../src/workers/handlers/workflow-execute.js';
import { enqueue, dequeueJob, ensureCronJob, QUEUE_NAMES } from '../src/lib/queues.js';
import { _processDequeuedJobForTest } from '../src/workers/index.js';
import type { JobData } from '../src/workers/types.js';

const stamp = `wm${Date.now().toString(36)}`;
const ORG = crypto.randomUUID();
const OTHER_ORG = crypto.randomUUID();
const u = { actor: crypto.randomUUID(), member: crypto.randomUUID(), removed: crypto.randomUUID(), outsider: crypto.randomUUID() };
const projectId = crypto.randomUUID();
const t = { blocker: crypto.randomUUID(), depMember: crypto.randomUUID(), depRemoved: crypto.randomUUID(), depOutsider: crypto.randomUUID() };
const unblockRule = crypto.randomUUID();
const commentRule = crypto.randomUUID();

const job = (data: Record<string, unknown>) =>
  ({ id: crypto.randomUUID(), name: 'workflow-execute', attempts: 1, data: { org_id: ORG, task_id: t.blocker, ...data } }) as any;

before(async () => {
  await db.insert(orgs).values([
    { id: ORG, name: `${stamp}-a`, slug: `${stamp}-a` },
    { id: OTHER_ORG, name: `${stamp}-b`, slug: `${stamp}-b` },
  ]);
  await db.insert(users).values(Object.values(u).map((id, i) => ({ id, email: `${stamp}-${i}@t.local`, name: `${stamp} ${i}` })));
  await db.insert(orgMembers).values([
    { id: crypto.randomUUID(), org_id: ORG, user_id: u.actor, role: 'owner' },
    { id: crypto.randomUUID(), org_id: ORG, user_id: u.member, role: 'member' },
    { id: crypto.randomUUID(), org_id: ORG, user_id: u.removed, role: 'member', is_active: false },
    { id: crypto.randomUUID(), org_id: OTHER_ORG, user_id: u.outsider, role: 'member' },
  ] as any);
  await db.insert(projects).values({ id: projectId, org_id: ORG, name: stamp, prefix: `WM${Date.now()}`.slice(0, 10), created_by: u.actor } as any);
  const rows: Array<[string, number, string | null]> = [
    [t.blocker, 1, null], [t.depMember, 2, u.member], [t.depRemoved, 3, u.removed], [t.depOutsider, 4, u.outsider],
  ];
  await db.insert(tasks).values(rows.map(([id, number, assignee_id]) => ({
    id, org_id: ORG, project_id: projectId, number, title: `${stamp} ${number}`, status: 'todo', assignee_id, created_by: u.actor,
  })) as any);
  await db.insert(taskRelationships).values([t.depMember, t.depRemoved, t.depOutsider].map((target) => ({
    source_task_id: t.blocker, target_task_id: target, type: 'blocks',
  })) as any);
  await db.insert(workflowRules).values([
    { id: unblockRule, org_id: ORG, name: `${stamp}-u`, trigger_type: 'task.status_changed', trigger_config: {},
      action_type: 'unblock_dependents', action_config: { actions: [{ kind: 'unblock_dependents' }] }, is_active: true, created_by: u.actor },
    { id: commentRule, org_id: ORG, name: `${stamp}-c`, trigger_type: 'task.status_changed', trigger_config: {},
      action_type: 'add_comment', action_config: { actions: [{ kind: 'add_comment', template: `${stamp} note` }] }, is_active: true, created_by: u.actor },
  ] as any);
});

after(async () => {
  await db.delete(jobQueue).where(sql`${jobQueue.name} LIKE ${stamp + '%'}`);
  await db.delete(notifications).where(eq(notifications.org_id, ORG));
  await db.delete(taskComments).where(eq(taskComments.org_id, ORG));
  await db.delete(workflowRuns).where(inArray(workflowRuns.rule_id, [unblockRule, commentRule]));
  await db.delete(workflowRules).where(inArray(workflowRules.id, [unblockRule, commentRule]));
  await db.delete(taskRelationships).where(eq(taskRelationships.source_task_id, t.blocker));
  await db.delete(tasks).where(inArray(tasks.id, Object.values(t)));
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(orgMembers).where(inArray(orgMembers.org_id, [ORG, OTHER_ORG]));
  await db.delete(users).where(inArray(users.id, Object.values(u)));
  await db.delete(orgs).where(inArray(orgs.id, [ORG, OTHER_ORG]));
});

test('unblocked-task notices go only to assignees who are active members of the workspace', async () => {
  await handleWorkflowExecute(job({ workflow_id: unblockRule, actor_user_id: u.actor }));
  const rows = await db.select({ user_id: notifications.user_id }).from(notifications)
    .where(and(eq(notifications.org_id, ORG), sql`${notifications.metadata}->>'subtype' = 'unblocked'`));
  assert.deepEqual(rows.map((r) => r.user_id), [u.member]);
});

test('a workflow job runs only as an active member of the rule\'s workspace', async () => {
  const comments = async () => (await db.select({ user_id: taskComments.user_id }).from(taskComments)
    .where(and(eq(taskComments.task_id, t.blocker), eq(taskComments.content, `${stamp} note`))));
  const runs = async () => (await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.rule_id, commentRule))).length;
  for (const actor of [u.outsider, u.removed, undefined]) {
    await handleWorkflowExecute(job({ workflow_id: commentRule, actor_user_id: actor }));
  }
  assert.equal((await comments()).length, 0);
  assert.equal(await runs(), 0);
  await handleWorkflowExecute(job({ workflow_id: commentRule, actor_user_id: u.actor }));
  assert.deepEqual((await comments()).map((c) => c.user_id), [u.actor]);
  assert.equal(await runs(), 1);
});

test('a queued job reaches its handler with the queue row\'s workspace', async () => {
  const name = `${stamp}-org`;
  await enqueue(QUEUE_NAMES.AGENT_JOBS, name, { org_id: ORG });
  const claimed = await dequeueJob(QUEUE_NAMES.AGENT_JOBS, { jobName: name });
  assert.equal(claimed?.orgId, ORG);
  let seen: JobData | null = null;
  await _processDequeuedJobForTest(QUEUE_NAMES.AGENT_JOBS, claimed!, {
    resolveHandler: async () => async (j) => { seen = j; }, recurrence: null,
  });
  assert.equal((seen as JobData | null)?.orgId, ORG);
});

test('a recurring scheduler job reaches its handler with its key, and its successor keeps the key and empty data', async () => {
  const name = `${stamp}-cron`;
  const cronKey = `cron:${stamp}`;
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, name, cronKey, {});
  const claimed = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { jobName: name });
  assert.equal(claimed?.cronKey, cronKey);
  let seen: JobData | null = null;
  await _processDequeuedJobForTest(QUEUE_NAMES.SCHEDULED_JOBS, claimed!, {
    resolveHandler: async () => async (j) => { seen = j; }, recurrence: { cronKey, delayMs: 60_000 },
  });
  assert.equal((seen as JobData | null)?.cronKey, cronKey);
  assert.equal((seen as JobData | null)?.orgId ?? null, null);
  const [successor] = await db.select({ data: jobQueue.data, cron_key: jobQueue.cron_key }).from(jobQueue)
    .where(and(eq(jobQueue.name, name), eq(jobQueue.status, 'pending')));
  assert.equal(successor?.cron_key, cronKey);
  assert.deepEqual(successor?.data, {});
});
