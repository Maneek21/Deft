/**
 * MCP task_query project-scope regression tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/mcp-task-query-project-scope.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import {
  agentEmployees,
  orgMembers,
  orgs,
  projects,
  tasks,
  users,
} from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { taskQuery } from '../src/lib/mcp-tools/tasks.js';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';

let orgId: string;
let userId: string;
let scopedEmployeeId: string;
let unscopedEmployeeId: string;
let allowedProjectId: string;
let deniedProjectId: string;
let deletedProjectId: string;
let allowedTaskId: string;
let deniedTaskId: string;
let deletedTaskId: string;

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function parseResult(result: { content?: Array<{ text: string }> }): any {
  return JSON.parse(result.content?.[0]?.text ?? 'null');
}

function context(employeeId: string, employeeSlug: string): ToolContext {
  return {
    org_id: orgId,
    employee_id: employeeId,
    employee_slug: employeeSlug,
    trust_level: 'standard',
  };
}

before(async () => {
  const [org] = await db.insert(orgs).values({
    name: 'MCP task query project scope',
    slug: `mcp-task-scope-${suffix}`,
  }).returning({ id: orgs.id });
  orgId = org!.id;

  const [user] = await db.insert(users).values({
    email: `mcp-task-scope-${suffix}@test.local`,
    name: 'MCP Task Scope Agent',
    kind: 'agent',
    is_agent: true,
    email_verified: true,
  }).returning({ id: users.id });
  userId = user!.id;

  await db.insert(orgMembers).values({
    org_id: orgId,
    user_id: userId,
    role: 'member',
  });

  const [allowedProject] = await db.insert(projects).values({
    org_id: orgId,
    name: 'Allowed MCP project',
    prefix: 'MAP',
    lead_id: userId,
    task_counter: 1,
  }).returning({ id: projects.id });
  allowedProjectId = allowedProject!.id;

  const [deniedProject] = await db.insert(projects).values({
    org_id: orgId,
    name: 'Denied MCP project',
    prefix: 'MDP',
    lead_id: userId,
    task_counter: 1,
  }).returning({ id: projects.id });
  deniedProjectId = deniedProject!.id;

  const [deletedProject] = await db.insert(projects).values({
    org_id: orgId,
    name: 'Soft-deleted MCP project',
    prefix: 'MXP',
    lead_id: userId,
    task_counter: 1,
    is_deleted: true,
  }).returning({ id: projects.id });
  deletedProjectId = deletedProject!.id;

  const [allowedTask] = await db.insert(tasks).values({
    org_id: orgId,
    project_id: allowedProjectId,
    number: 1,
    title: 'Allowed project task',
    status: 'todo',
    priority: 'p2',
    created_by: userId,
  }).returning({ id: tasks.id });
  allowedTaskId = allowedTask!.id;

  const [deniedTask] = await db.insert(tasks).values({
    org_id: orgId,
    project_id: deniedProjectId,
    number: 1,
    title: 'Denied project task',
    status: 'todo',
    priority: 'p2',
    created_by: userId,
  }).returning({ id: tasks.id });
  deniedTaskId = deniedTask!.id;

  const [deletedTask] = await db.insert(tasks).values({
    org_id: orgId,
    project_id: deletedProjectId,
    number: 1,
    title: 'Task in soft-deleted project',
    status: 'todo',
    priority: 'p0',
    created_by: userId,
  }).returning({ id: tasks.id });
  deletedTaskId = deletedTask!.id;

  const [scopedEmployee] = await db.insert(agentEmployees).values({
    org_id: orgId,
    user_id: userId,
    name: 'Project-scoped MCP employee',
    slug: `scoped-${suffix}`,
    role: 'project_manager',
    system_prompt: 'Test project-scoped task reads.',
    project_ids: [allowedProjectId],
    trust_level: 'standard',
    is_byoa: true,
    is_active: true,
    created_by: userId,
  }).returning({ id: agentEmployees.id });
  scopedEmployeeId = scopedEmployee!.id;

  const [unscopedEmployee] = await db.insert(agentEmployees).values({
    org_id: orgId,
    user_id: userId,
    name: 'Org-wide MCP employee',
    slug: `unscoped-${suffix}`,
    role: 'project_manager',
    system_prompt: 'Test legacy org-wide task reads.',
    project_ids: [],
    trust_level: 'standard',
    is_byoa: true,
    is_active: true,
    created_by: userId,
  }).returning({ id: agentEmployees.id });
  unscopedEmployeeId = unscopedEmployee!.id;
});

after(async () => {
  await db.delete(tasks).where(eq(tasks.org_id, orgId));
  await db.delete(agentEmployees).where(eq(agentEmployees.org_id, orgId));
  await db.delete(projects).where(eq(projects.org_id, orgId));
  await db.delete(orgMembers).where(and(
    eq(orgMembers.org_id, orgId),
    eq(orgMembers.user_id, userId),
  ));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
});

test('task_query without a project filter returns only configured employee projects', async () => {
  const result = await taskQuery(
    { caller_employee_slug: `scoped-${suffix}`, limit: 100 },
    context(scopedEmployeeId, `scoped-${suffix}`),
  );

  assert.equal(result.isError, false, JSON.stringify(result));
  const rows = parseResult(result);
  assert.deepEqual(rows.map((row: { id: string }) => row.id), [allowedTaskId]);
  assert.equal(rows.some((row: { id: string }) => row.id === deniedTaskId), false);
});

test('task_query allows an explicit configured project', async () => {
  const result = await taskQuery(
    {
      caller_employee_slug: `scoped-${suffix}`,
      project_id: allowedProjectId,
      limit: 100,
    },
    context(scopedEmployeeId, `scoped-${suffix}`),
  );

  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(parseResult(result).map((row: { id: string }) => row.id), [allowedTaskId]);
});

test('task_query does not leak tasks from an explicit project outside employee scope', async () => {
  const result = await taskQuery(
    {
      caller_employee_slug: `scoped-${suffix}`,
      filter: { project_id: deniedProjectId },
      limit: 100,
    },
    context(scopedEmployeeId, `scoped-${suffix}`),
  );

  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(parseResult(result), []);
  assert.doesNotMatch(result.content?.[0]?.text ?? '', /Denied project task/);
});

test('task_query preserves org-wide reads for an empty employee project scope', async () => {
  const result = await taskQuery(
    { caller_employee_slug: `unscoped-${suffix}`, limit: 100 },
    context(unscopedEmployeeId, `unscoped-${suffix}`),
  );

  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(
    new Set(parseResult(result).map((row: { id: string }) => row.id)),
    new Set([allowedTaskId, deniedTaskId]),
  );
  assert.equal(parseResult(result).some((row: { id: string }) => row.id === deletedTaskId), false);
});

test('task_query returns no rows for an explicitly requested soft-deleted project', async () => {
  const result = await taskQuery(
    {
      caller_employee_slug: `unscoped-${suffix}`,
      project_id: deletedProjectId,
      limit: 100,
    },
    context(unscopedEmployeeId, `unscoped-${suffix}`),
  );

  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(parseResult(result), []);
  assert.doesNotMatch(result.content?.[0]?.text ?? '', /Task in soft-deleted project/);
});

test('task_query fails closed for an inactive employee', async () => {
  await db.update(agentEmployees)
    .set({ is_active: false })
    .where(eq(agentEmployees.id, scopedEmployeeId));
  try {
    const result = await taskQuery(
      { caller_employee_slug: `scoped-${suffix}`, limit: 100 },
      context(scopedEmployeeId, `scoped-${suffix}`),
    );
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? '', /caller employee not found/);
  } finally {
    await db.update(agentEmployees)
      .set({ is_active: true })
      .where(eq(agentEmployees.id, scopedEmployeeId));
  }
});
