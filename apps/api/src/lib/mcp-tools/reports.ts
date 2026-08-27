/**
 * Path C Phase 1 — the 4 read-only tools that lived in the old
 * `/mcp` (api_keys-gated REST surface) but had no /api/mcp/v1 equivalent:
 *
 *   - task_detail          (deft_get_task_detail)
 *   - messages_search      (deft_search_messages)
 *   - project_progress     (deft_get_project_progress)
 *   - team_workload        (deft_get_team_workload)
 *
 * The underlying implementations already live in `agent-context.ts` as
 * cases of `executeToolCall`. These handlers are thin wrappers that
 * translate MCP tool args to the `executeToolCall` shape and format the
 * result as a `ToolResult`.
 *
 * Parameter naming follows the internal tool convention (`task_identifier`,
 * not `task_id`; `days` for team workload windows). The JSON schemas in
 * `mcp-tools/index.ts` mirror these names so clients see the same shape.
 */
import type { ToolContext, ToolResult } from './types.js';
import { textResult, errorResult } from './types.js';
import { executeToolCall } from '../agent-context.js';
import { and, eq, ilike, inArray } from 'drizzle-orm';
import { projects, tasks } from '@deft/db/schema';
import { db } from '../db.js';
import {
  employeeProjectAccessAllows,
  loadEmployeeProjectAccess,
  type EmployeeProjectAccess,
} from './employee-project-access.js';

function serialize(result: unknown): ToolResult {
  // executeToolCall may return error objects shaped `{ error: string }` — surface them as MCP errors.
  if (result && typeof result === 'object' && 'error' in result && typeof (result as { error: unknown }).error === 'string') {
    return errorResult((result as { error: string }).error);
  }
  return textResult(result ?? {});
}

async function resolveTaskProjectId(
  taskIdentifier: string,
  ctx: ToolContext,
): Promise<string | null> {
  const taskKey = taskIdentifier.match(/^([A-Z]+)-(\d+)$/);
  if (taskKey) {
    const [task] = await db
      .select({ project_id: tasks.project_id })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.project_id))
      .where(and(
        eq(tasks.org_id, ctx.org_id),
        eq(projects.org_id, ctx.org_id),
        eq(projects.prefix, taskKey[1]!),
        eq(tasks.number, Number(taskKey[2]!)),
        eq(tasks.is_deleted, false),
      ))
      .limit(1);
    return task?.project_id ?? null;
  }

  const [task] = await db
    .select({ project_id: tasks.project_id })
    .from(tasks)
    .where(and(
      eq(tasks.id, taskIdentifier),
      eq(tasks.org_id, ctx.org_id),
      eq(tasks.is_deleted, false),
    ))
    .limit(1);
  return task?.project_id ?? null;
}

async function resolveProgressProject(
  args: {
    project_id?: string;
    project_identifier?: string;
    project_name?: string;
  },
  ctx: ToolContext,
  access: EmployeeProjectAccess,
) {
  const conditions = [
    eq(projects.org_id, ctx.org_id),
    eq(projects.is_deleted, false),
  ];
  if (args.project_id) conditions.push(eq(projects.id, args.project_id));
  else if (args.project_identifier) conditions.push(eq(projects.prefix, args.project_identifier));
  else if (args.project_name) conditions.push(ilike(projects.name, `%${args.project_name}%`));
  else return null;
  if (access.resolved && !access.unrestricted) {
    conditions.push(inArray(projects.id, access.projectIds));
  }

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(...conditions))
    .limit(1);
  return project ?? null;
}

export async function taskDetail(args: {
  caller_employee_slug?: string;
  task_identifier: string;
}, ctx: ToolContext): Promise<ToolResult> {
  if (!args.task_identifier) return errorResult('task_identifier is required');
  const access = await loadEmployeeProjectAccess(ctx);
  if (!access.resolved) return errorResult('agent employee identity could not be resolved');
  const projectId = await resolveTaskProjectId(args.task_identifier, ctx);
  if (!projectId || !employeeProjectAccessAllows(access, projectId)) {
    return errorResult('Task not found');
  }
  const { result } = await executeToolCall(
    'get_task_detail',
    { task_identifier: args.task_identifier },
    ctx.org_id,
    access.userId,
    undefined,
    ctx.employee_id,
  );
  return serialize(result);
}

export async function messagesSearch(args: {
  caller_employee_slug?: string;
  query: string;
  space_name?: string;
  author_name?: string;
  limit?: number;
}, ctx: ToolContext): Promise<ToolResult> {
  if (!args.query) return errorResult('query is required');
  const access = await loadEmployeeProjectAccess(ctx);
  if (!access.resolved) return errorResult('agent employee identity could not be resolved');
  const { result } = await executeToolCall(
    'search_messages',
    {
      query: args.query,
      space_name: args.space_name,
      author_name: args.author_name,
      limit: args.limit,
    },
    ctx.org_id,
    access.userId,
    undefined,
    ctx.employee_id,
  );
  return serialize(result);
}

export async function projectProgress(args: {
  caller_employee_slug?: string;
  project_id?: string;
  project_identifier?: string;
  project_name?: string;
}, ctx: ToolContext): Promise<ToolResult> {
  const access = await loadEmployeeProjectAccess(ctx);
  if (!access.resolved) return errorResult('agent employee identity could not be resolved');
  const project = await resolveProgressProject(args, ctx, access);
  if (!project) return errorResult('Project not found');
  const { result } = await executeToolCall(
    'get_project_progress',
    { project_id: project.id },
    ctx.org_id,
    access.userId,
    undefined,
    ctx.employee_id,
  );
  return serialize(result);
}

export async function teamWorkload(args: {
  caller_employee_slug?: string;
  days?: number;
}, ctx: ToolContext): Promise<ToolResult> {
  const access = await loadEmployeeProjectAccess(ctx);
  if (!access.resolved) return errorResult('agent employee identity could not be resolved');
  const { result } = await executeToolCall(
    'get_team_workload',
    {
      days: args.days,
      ...(access.unrestricted ? {} : { project_ids: access.projectIds }),
    },
    ctx.org_id,
    access.userId,
    undefined,
    ctx.employee_id,
  );
  return serialize(result);
}
