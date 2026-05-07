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

function serialize(result: unknown): ToolResult {
  // executeToolCall may return error objects shaped `{ error: string }` — surface them as MCP errors.
  if (result && typeof result === 'object' && 'error' in result && typeof (result as { error: unknown }).error === 'string') {
    return errorResult((result as { error: string }).error);
  }
  return textResult(result ?? {});
}

export async function taskDetail(args: {
  caller_employee_slug?: string;
  task_identifier: string;
}, ctx: ToolContext): Promise<ToolResult> {
  if (!args.task_identifier) return errorResult('task_identifier is required');
  const { result } = await executeToolCall(
    'get_task_detail',
    { task_identifier: args.task_identifier },
    ctx.org_id,
    ctx.employee_id,
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
  const { result } = await executeToolCall(
    'search_messages',
    {
      query: args.query,
      space_name: args.space_name,
      author_name: args.author_name,
      limit: args.limit,
    },
    ctx.org_id,
    ctx.employee_id,
    undefined,
    ctx.employee_id,
  );
  return serialize(result);
}

export async function projectProgress(args: {
  caller_employee_slug?: string;
  project_identifier?: string;
  project_name?: string;
}, ctx: ToolContext): Promise<ToolResult> {
  const params: Record<string, unknown> = {};
  if (args.project_identifier) params.project_identifier = args.project_identifier;
  if (args.project_name) params.project_name = args.project_name;
  const { result } = await executeToolCall(
    'get_project_progress',
    params,
    ctx.org_id,
    ctx.employee_id,
    undefined,
    ctx.employee_id,
  );
  return serialize(result);
}

export async function teamWorkload(args: {
  caller_employee_slug?: string;
  days?: number;
}, ctx: ToolContext): Promise<ToolResult> {
  const { result } = await executeToolCall(
    'get_team_workload',
    { days: args.days },
    ctx.org_id,
    ctx.employee_id,
    undefined,
    ctx.employee_id,
  );
  return serialize(result);
}
