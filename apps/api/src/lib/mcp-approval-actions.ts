/**
 * Action kinds that the native approval resolver can execute.
 *
 * Keep aliases here as compatibility shims only. New approval rows are
 * normalized to a canonical action before they are written.
 */
export const CANONICAL_MCP_ACTION_KINDS = [
  'task_create',
  'task_update',
  'message_post',
  'send_message',
  'memory_update',
  'wiki_create',
  'wiki_update',
] as const;

/**
 * Module mutations are queued only by their dedicated static MCP tools,
 * which validate the shared request schema and run ModuleService preflight
 * before persisting a proposal. They belong to the signed resolver path but
 * intentionally stay out of CANONICAL_MCP_ACTION_KINDS so the generic
 * request_human_approval tool cannot bypass that boundary.
 */
const GOVERNED_MODULE_ACTION_KINDS = [
  'module_record_create',
  'module_record_update',
  'module_record_archive',
] as const;

const MCP_ACTION_ALIASES = {
  add_task_comment: 'task_update',
} as const;

export const MCP_ACTION_KINDS = new Set<string>([
  ...CANONICAL_MCP_ACTION_KINDS,
  ...Object.keys(MCP_ACTION_ALIASES),
  ...GOVERNED_MODULE_ACTION_KINDS,
]);

type NormalizedApprovalAction =
  | {
      ok: true;
      action: (typeof CANONICAL_MCP_ACTION_KINDS)[number];
      params: Record<string, unknown>;
    }
  | { ok: false; error: string };

export function normalizeMcpApprovalAction(
  rawAction: string,
  rawParams: Record<string, unknown>,
  employeeSlug: string,
): NormalizedApprovalAction {
  const action = rawAction.trim();

  if (action === 'add_task_comment') {
    const taskId =
      typeof rawParams.task_id === 'string' ? rawParams.task_id.trim() : '';
    const comment =
      typeof rawParams.comment === 'string' ? rawParams.comment.trim() : '';
    if (!taskId || !comment) {
      return {
        ok: false,
        error: 'add_task_comment requires params.task_id and params.comment',
      };
    }

    const { comment: _comment, patch: _patch, ...reviewMetadata } = rawParams;
    return {
      ok: true,
      action: MCP_ACTION_ALIASES.add_task_comment,
      params: {
        ...reviewMetadata,
        caller_employee_slug: employeeSlug,
        task_id: taskId,
        patch: { comment },
      },
    };
  }

  if (!CANONICAL_MCP_ACTION_KINDS.includes(
    action as (typeof CANONICAL_MCP_ACTION_KINDS)[number],
  )) {
    return {
      ok: false,
      error:
        `unsupported approval action "${action}". Use one of: ` +
        `${CANONICAL_MCP_ACTION_KINDS.join(', ')}, add_task_comment`,
    };
  }

  return {
    ok: true,
    action: action as (typeof CANONICAL_MCP_ACTION_KINDS)[number],
    params: {
      ...rawParams,
      caller_employee_slug:
        typeof rawParams.caller_employee_slug === 'string' &&
        rawParams.caller_employee_slug.trim()
          ? rawParams.caller_employee_slug
          : employeeSlug,
    },
  };
}
