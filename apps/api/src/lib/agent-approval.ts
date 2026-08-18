/**
 * Trust level + approval tier routing for agent actions.
 *
 * Trust levels (set per org in Settings > Agent):
 *   conservative — every write action requires explicit user approval
 *   standard     — 'auto' and 'quick' execute immediately, only 'full' needs approval
 *   autonomous   — 'auto', 'quick', AND 'full' execute immediately,
 *                  EXCEPT destructive actions (admin tools, delete_* names, mode=delete/pause/revoke)
 *
 * Approval matrix (tier × trust):
 *   tier \ trust  | conservative | standard | autonomous
 *   auto          |    queue     |   exec   |    exec
 *   quick         |    queue     |   exec   |    exec
 *   full          |    queue     |   queue  |    exec (unless destructive)
 *
 * Destructive guard (still queues even under Autonomous):
 *   - admin tool set: manage_agent_employee, manage_mcp_connection, remove_member
 *   - tool name starts with "delete_" (future-proof for delete_task, delete_project, etc.)
 *   - params.mode matches /^(delete|pause|revoke)$/i
 *
 * Matrix update (task #58 / Option 2 — 2026-04-14):
 *   Previously `standard` was near-identical to `conservative` — it only
 *   auto-executed `auto` tier, so task_create / memory_update / wiki_write
 *   all queued. The mental model in plan doc §0 was "routine stuff auto,
 *   risky stuff queued" which wasn't matching reality. Loosening standard
 *   to auto-exec quick-tier makes it behave like the plan promises.
 *
 * Matrix update (autonomy tier — 2026-04-18):
 *   Autonomous was identical to Standard before this change. Now Autonomous
 *   auto-executes full-tier actions (post_message, message_post) while still queuing destructive
 *   admin operations (manage_agent_employee, manage_mcp_connection, remove_member)
 *   and any tool whose name begins with "delete_" or whose params.mode is
 *   delete/pause/revoke.
 *
 * Approval tiers (assigned per action tool):
 *   auto  — low-risk internal state changes (status update, assignment)
 *   quick — moderate-risk entity creation (create task, add knowledge, wiki write)
 *   full  - high-risk external/visible actions (post message, MCP writes)
 */

import type { ToolResult } from './mcp-tools/types.js';
import { textResult } from './mcp-tools/types.js';
import {
  MODULE_OPERATION_DEFINITIONS,
  MODULE_OPERATION_NAMES,
} from '@deft/shared/modules';

export type TrustLevel = 'conservative' | 'standard' | 'autonomous';
export type ApprovalTier = 'auto' | 'quick' | 'full';

/** Default approval tier for each action tool */
export const TOOL_APPROVAL_TIERS: Record<string, ApprovalTier> = {
  update_task_status: 'auto',
  bulk_update_tasks: 'full',
  assign_task: 'auto',
  create_task: 'quick',
  add_knowledge: 'quick',
  wiki_write: 'quick',
  post_message: 'full',
  create_github_issue: 'full',

  // Superintendent tools (Defty only)
  manage_agent_employee: 'full',
  list_agent_employees: 'auto',
  get_agent_activity: 'auto',
  manage_mcp_connection: 'full',
  get_agent_economics: 'auto',
  manage_triggers: 'quick',

  // Plans
  create_plan: 'auto',

  // ─── Phase 4 — MCP write tools ─────────────────────────────────────
  // task_create / task_update are entity-shape quick-approve writes.
  // message_post is full-review because it posts to a shared channel as
  // the employee's shadow user.
  // memory_update defaults to quick (scope promotion path); own-scope
  // content edits bypass the tier check in the handler.
  // space_memory_set and space_memory_get are always auto (space-scoped,
  // no side effects outside the bag).
  // delegation_self_report is an audit log entry, always auto.
  task_create: 'quick',
  task_update: 'quick',
  message_post: 'full',
  send_message: 'full',
  memory_update: 'quick',
  wiki_create: 'quick',
  wiki_update: 'quick',
  space_memory_set: 'auto',
  space_memory_get: 'auto',
  delegation_self_report: 'auto',

  // ─── Task 3.4 — new task-mutation tools ─────────────────────────────
  comment_on_task: 'quick',
  set_due_date: 'auto',
  set_priority: 'auto',
  add_label: 'auto',

  // ─── Task 3.5 — status shortcuts ────────────────────────────────────
  close_task: 'auto',
  reopen_task: 'auto',

  // ─── Task 3.6 — dependency tools ────────────────────────────────────
  add_dependency: 'quick',
  remove_dependency: 'quick',

  // ─── Block 0.5 — reminder tool ──────────────────────────────────────
  create_reminder: 'quick',

  // ─── Block 2.1 — note tools ─────────────────────────────────────────
  // search_notes + read_note are read-only (not in ACTION_TOOLS).
  // create_note is quick — it only writes to the caller's own note bag.
  // note_to_wiki is quick — wiki promotion is a copy, not overwrite; the
  // agent can only see org-visible pages.
  create_note: 'quick',
  note_to_wiki: 'quick',

  // ─── Block 2.2 — thread reply ───────────────────────────────────────
  // Same tier as post_message (full) — it posts as the agent's shadow
  // user to a shared channel.
  post_thread_reply: 'full',

  // ─── Block 2.3 — canvas tools ───────────────────────────────────────
  // read_canvas is read-only (not in ACTION_TOOLS). write_canvas
  // overwrites shared-canvas state visible to every space member, so
  // tier 'quick' — gated under Conservative, auto under Standard+.
  write_canvas: 'quick',

  // ─── Block 2.6 — decision tools ─────────────────────────────────────
  // Both actions only touch links / a single timestamp, not the
  // decision text itself. Tier 'quick' — gated under Conservative.
  link_decision_to_tasks: 'quick',
  mark_decision_implemented: 'quick',

  // Declarative modules — the shared operation contract is authoritative.
  // Keeping these references (instead of repeating literals) prevents the
  // Defty and MCP adapters from drifting on policy.
  module_list: MODULE_OPERATION_DEFINITIONS.module_list.approval_tier,
  module_schema_get: MODULE_OPERATION_DEFINITIONS.module_schema_get.approval_tier,
  module_record_search: MODULE_OPERATION_DEFINITIONS.module_record_search.approval_tier,
  module_record_query: MODULE_OPERATION_DEFINITIONS.module_record_query.approval_tier,
  module_record_get: MODULE_OPERATION_DEFINITIONS.module_record_get.approval_tier,
  module_record_create: MODULE_OPERATION_DEFINITIONS.module_record_create.approval_tier,
  module_record_update: MODULE_OPERATION_DEFINITIONS.module_record_update.approval_tier,
  module_record_archive: MODULE_OPERATION_DEFINITIONS.module_record_archive.approval_tier,
};

/**
 * Admin-only tools that must always queue for human review, even under
 * Autonomous trust. These carry org-wide side-effects that cannot be
 * undone with a simple undo action.
 */
const DESTRUCTIVE_ADMIN_TOOLS = new Set([
  'manage_agent_employee',
  'manage_mcp_connection',
  'remove_member',
]);

const DESTRUCTIVE_MODULE_TOOLS: ReadonlySet<string> = new Set(
  MODULE_OPERATION_NAMES.filter(
    (operation) => MODULE_OPERATION_DEFINITIONS[operation].destructive,
  ),
);

/**
 * Returns true if the tool call should be treated as a destructive action
 * and therefore queued for human review even under Autonomous trust.
 *
 * Three conditions (any one is sufficient):
 *   1. Tool name is in the hardcoded admin set.
 *   2. Tool name starts with "delete_" (future-proof for delete_task, delete_project, etc.).
 *   3. params is an object with a `mode` string key matching delete|pause|revoke.
 */
export function isDestructiveAction(toolName: string, params?: unknown): boolean {
  if (DESTRUCTIVE_ADMIN_TOOLS.has(toolName)) return true;
  // MCP tools are exposed to the model as mcp__<connection>__<tool>. Apply
  // destructive-name policy to the server's original tool name as well as to
  // native tool names so prefixing cannot bypass Autonomous review.
  const effectiveToolName = toolName.startsWith('mcp__')
    ? toolName.split('__').slice(2).join('__')
    : toolName;
  // Archive does not use the legacy `delete_` prefix, so its destructive
  // classification must come from the shared module operation definition.
  // Check both native and MCP-prefixed forms.
  if (
    DESTRUCTIVE_MODULE_TOOLS.has(toolName)
    || DESTRUCTIVE_MODULE_TOOLS.has(effectiveToolName)
  ) {
    return true;
  }
  if (effectiveToolName.startsWith('delete_')) return true;
  if (
    params !== null &&
    typeof params === 'object' &&
    !Array.isArray(params) &&
    typeof (params as Record<string, unknown>).mode === 'string' &&
    /^(delete|pause|revoke)$/i.test((params as Record<string, unknown>).mode as string)
  ) {
    return true;
  }
  return false;
}

/** Returns true if the action should be auto-executed (no user approval needed). */
export function shouldAutoExecute(
  action: string,
  trustLevel: TrustLevel,
  params?: unknown,
  approvalTierOverride?: ApprovalTier,
): boolean {
  const tier = getApprovalTier(action, approvalTierOverride);

  if (trustLevel === 'conservative') return tier === 'auto';
  if (trustLevel === 'standard') return tier === 'auto' || tier === 'quick';
  if (trustLevel === 'autonomous') {
    if (isDestructiveAction(action, params)) return false;
    return tier === 'auto' || tier === 'quick' || tier === 'full';
  }

  return false;
}

/** Returns the approval tier for an action tool. */
export function getApprovalTier(action: string, approvalTierOverride?: ApprovalTier): ApprovalTier {
  return approvalTierOverride ?? TOOL_APPROVAL_TIERS[action] ?? 'full';
}

/**
 * Build an MCP ToolResult shaped like the "queued for approval" pseudo-response
 * from §3.4 of the Deft Agentic Vision plan. The LLM reads the JSON string in
 * content[0].text and is instructed by AGENTS.md to tell the user that the
 * action is pending human review.
 */
export function asPseudoResult(actionId: string, message: string): ToolResult {
  return textResult({
    status: 'queued_for_approval',
    approval_id: actionId,
    message,
  });
}
