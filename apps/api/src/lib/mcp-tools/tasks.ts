import { queryCompactTasks, type CompactTaskQuery } from '../task-compact-query.js';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';
import { loadEmployeeProjectAccess } from './employee-project-access.js';

export type TaskQueryArgs = CompactTaskQuery & {
  caller_employee_slug: string;
  filter?: {
    status?: string;
    assignee_id?: string;
    project_id?: string;
  };
};

export async function taskQuery(args: TaskQueryArgs, ctx: ToolContext): Promise<ToolResult> {
  try {
    const projectAccess = await loadEmployeeProjectAccess(ctx);
    if (!projectAccess.resolved) return errorResult('task_query: caller employee not found');
    const legacy = args.filter ?? {};
    const rows = await queryCompactTasks({
      ...args,
      project_id: args.project_id ?? legacy.project_id,
      statuses: args.statuses ?? (legacy.status ? [legacy.status] : undefined),
      assignee_ids: args.assignee_ids ?? (legacy.assignee_id ? [legacy.assignee_id] : undefined),
    }, {
      orgId: ctx.org_id,
      userId: projectAccess.userId,
      projectIds: projectAccess.unrestricted ? null : projectAccess.projectIds,
    });
    return textResult(rows);
  } catch (err) {
    return errorResult(`task_query failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
