/**
 * MCP task_update lifecycle regression tests.
 *
 * These cover the BYOA dogfood failures where task_update wrote directly to
 * the tasks table, bypassing status transitions and workflow enqueueing.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/mcp-task-update-lifecycle.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../src/lib/db.js';
import {
  actionReceipts,
  agentActions,
  agentEmployees,
  jobQueue,
  orgMembers,
  orgs,
  projects,
  taskActivity,
  taskComments,
  tasks,
  users,
  workflowRules,
  workflowRuns,
} from '@deft/db/schema';
import { taskUpdate } from '../src/lib/mcp-tools/writes.js';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';

let orgId: string;
let userId: string;
let employeeId: string;
let projectId: string;
let workflowId: string;

const employeeSlug = `mcp-task-lifecycle-${Date.now()}`;

function parseResult(r: { content?: Array<{ type: string; text: string }>; isError?: boolean }): any {
  if (!r.content?.[0]?.text) return null;
  try {
    return JSON.parse(r.content[0].text);
  } catch {
    return r.content[0].text;
  }
}

function ctx(): ToolContext {
  return {
    org_id: orgId,
    employee_id: employeeId,
    employee_slug: employeeSlug,
    trust_level: 'autonomous',
  };
}

async function createTask(status: string): Promise<string> {
  const [counter] = await db
    .update(projects)
    .set({ task_counter: sql`${projects.task_counter} + 1` as any })
    .where(eq(projects.id, projectId))
    .returning({ task_counter: projects.task_counter });

  const [task] = await db
    .insert(tasks)
    .values({
      org_id: orgId,
      project_id: projectId,
      number: counter!.task_counter,
      title: `MCP lifecycle task ${Date.now()}`,
      status,
      priority: 'p2',
      created_by: userId,
    })
    .returning({ id: tasks.id });

  return task!.id;
}

before(async () => {
  const [org] = await db
    .insert(orgs)
    .values({ name: 'mcp task lifecycle', slug: `mcp-task-life-${Date.now()}` })
    .returning({ id: orgs.id });
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({
      email: `mcp-task-life-${Date.now()}@test.local`,
      name: 'MCP Task Lifecycle Agent User',
      kind: 'agent',
      is_agent: true,
      email_verified: true,
    })
    .returning({ id: users.id });
  userId = user!.id;

  await db.insert(orgMembers).values({
    org_id: orgId,
    user_id: userId,
    role: 'member',
  });

  const [employee] = await db
    .insert(agentEmployees)
    .values({
      org_id: orgId,
      user_id: userId,
      name: 'MCP Task Lifecycle Employee',
      slug: employeeSlug,
      role: 'engineering_lead',
      system_prompt: 'test task lifecycle employee',
      trust_level: 'autonomous',
      is_byoa: true,
      is_active: true,
      created_by: userId,
    })
    .returning({ id: agentEmployees.id });
  employeeId = employee!.id;

  const [project] = await db
    .insert(projects)
    .values({
      org_id: orgId,
      name: 'MCP Task Lifecycle Project',
      prefix: 'MTL',
      lead_id: userId,
      task_counter: 0,
    })
    .returning({ id: projects.id });
  projectId = project!.id;

  const [workflow] = await db
    .insert(workflowRules)
    .values({
      org_id: orgId,
      project_id: projectId,
      name: 'MCP lifecycle done workflow',
      trigger_type: 'task.status_changed',
      trigger_config: { to_status: 'done' },
      action_type: 'add_comment',
      action_config: { template: 'MCP lifecycle workflow fired' },
      created_by: userId,
      is_active: true,
    })
    .returning({ id: workflowRules.id });
  workflowId = workflow!.id;
});

after(async () => {
  await db.delete(jobQueue).where(sql`${jobQueue.data}->>'workflow_id' = ${workflowId}`);
  await db.delete(actionReceipts).where(eq(actionReceipts.employee_id, employeeId));
  await db.delete(agentActions).where(eq(agentActions.agent_employee_id, employeeId));
  await db.delete(taskActivity).where(eq(taskActivity.org_id, orgId));
  await db.delete(taskComments).where(eq(taskComments.org_id, orgId));
  await db.delete(tasks).where(eq(tasks.org_id, orgId));
  await db.delete(workflowRuns).where(eq(workflowRuns.rule_id, workflowId));
  await db.delete(workflowRules).where(eq(workflowRules.id, workflowId));
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(agentEmployees).where(eq(agentEmployees.id, employeeId));
  await db.delete(orgMembers).where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, userId)));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
});

test('task_update rejects invalid status transitions', async () => {
  const taskId = await createTask('backlog');

  const result = await taskUpdate(
    {
      caller_employee_slug: employeeSlug,
      task_id: taskId,
      patch: { status: 'done' },
    },
    ctx(),
  );

  assert.equal(result.isError, true, `expected invalid transition error: ${JSON.stringify(result)}`);
  assert.match(result.content?.[0]?.text ?? '', /invalid status transition/i);

  const [row] = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  assert.equal(row?.status, 'backlog', 'invalid transition must not update the task');
});

test('task_update enqueues workflow and records activity on valid status change', async () => {
  const taskId = await createTask('in_progress');

  const result = await taskUpdate(
    {
      caller_employee_slug: employeeSlug,
      task_id: taskId,
      patch: { status: 'done' },
    },
    ctx(),
  );

  assert.ok(!result.isError, `valid transition should succeed: ${result.content?.[0]?.text}`);
  const parsed = parseResult(result);
  assert.equal(parsed.status, 'done');

  const [activity] = await db
    .select()
    .from(taskActivity)
    .where(and(
      eq(taskActivity.task_id, taskId),
      eq(taskActivity.action, 'status_changed'),
    ))
    .limit(1);
  assert.ok(activity, 'status_changed activity row should be written');
  assert.equal(activity?.user_id, userId, 'activity should be authored by agent shadow user');

  const [job] = await db
    .select()
    .from(jobQueue)
    .where(and(
      eq(jobQueue.queue, 'agent-jobs'),
      eq(jobQueue.name, 'workflow-execute'),
      sql`${jobQueue.data}->>'workflow_id' = ${workflowId}`,
      sql`${jobQueue.data}->>'task_id' = ${taskId}`,
    ))
    .limit(1);

  assert.ok(job, 'workflow-execute job should be enqueued for MCP status change');
});

test('task_update supports due date and comment patches', async () => {
  const taskId = await createTask('todo');

  const result = await taskUpdate(
    {
      caller_employee_slug: employeeSlug,
      task_id: taskId,
      patch: {
        due_date: '2026-07-15',
        comment: 'Customer confirmed the target date.',
      },
    },
    ctx(),
  );

  assert.ok(!result.isError, `due date/comment patch should succeed: ${result.content?.[0]?.text}`);
  const parsed = parseResult(result);
  assert.equal(parsed.comment_id !== null, true);

  const [task] = await db
    .select({ due_date: tasks.due_date })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  assert.equal(task?.due_date?.toISOString().slice(0, 10), '2026-07-15');

  const [comment] = await db
    .select({ content: taskComments.content, user_id: taskComments.user_id })
    .from(taskComments)
    .where(eq(taskComments.id, parsed.comment_id))
    .limit(1);
  assert.equal(comment?.content, 'Customer confirmed the target date.');
  assert.equal(comment?.user_id, userId);

  const activities = await db
    .select({ action: taskActivity.action, field: taskActivity.field })
    .from(taskActivity)
    .where(eq(taskActivity.task_id, taskId));
  assert.ok(
    activities.some((entry) => entry.action === 'due_date_changed' && entry.field === 'due_date'),
    'due date activity should be written',
  );
  assert.ok(
    activities.some((entry) => entry.action === 'commented' && entry.field === 'comment'),
    'comment activity should be written',
  );
});
