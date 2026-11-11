/**
 * Trust level + approval tier routing for agent actions.
 *
 * Trust levels (set per org in Settings > Agent):
 *   conservative — only 'auto' executes immediately
 *   standard     — 'auto' and 'quick' execute immediately, only 'full' needs approval
 *   autonomous   — 'auto', 'quick', AND 'full' execute immediately
 *   At EVERY level, destructive actions queue (see below), whatever their tier.
 *
 * Approval matrix (tier × trust), for non-destructive actions:
 *   tier \ trust  | conservative | standard | autonomous
 *   auto          |    exec      |   exec   |    exec
 *   quick         |    queue     |   exec   |    exec
 *   full          |    queue     |   queue  |    exec
 *
 * Destructive guard (queues at every trust level, native and MCP tools,
 * names compared case-insensitively after stripping any mcp__<connection>__
 * prefix):
 *   - admin tool set: manage_agent_employee, manage_mcp_connection, remove_member
 *   - module operations classed destructive (unlink, archive) + bulk create
 *   - remove_dependency
 *   - tool name starts with "delete_" (future-proof for delete_task, delete_project, etc.)
 *   - params.mode or params.action matches /^(delete|pause|revoke)$/i (only when params are passed)
 *   - connected tool annotations.destructiveHint === true (only when annotations are passed)
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
  workspace_plan_import: 'full',
  document_send: 'full',
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
  module_record_task_links: 'auto',
  module_record_task_link: 'quick',
  module_record_task_unlink: 'quick',

  // Declarative modules — the shared operation contract is authoritative.
  // Keeping these references (instead of repeating literals) prevents the
  // Defty and MCP adapters from drifting on policy.
  module_list: MODULE_OPERATION_DEFINITIONS.module_list.approval_tier,
  module_schema_get: MODULE_OPERATION_DEFINITIONS.module_schema_get.approval_tier,
  module_record_search: MODULE_OPERATION_DEFINITIONS.module_record_search.approval_tier,
  module_record_query: MODULE_OPERATION_DEFINITIONS.module_record_query.approval_tier,
  module_record_get: MODULE_OPERATION_DEFINITIONS.module_record_get.approval_tier,
  module_record_incoming: MODULE_OPERATION_DEFINITIONS.module_record_incoming.approval_tier,
  module_record_latest_related: MODULE_OPERATION_DEFINITIONS.module_record_latest_related.approval_tier,
  module_record_create: MODULE_OPERATION_DEFINITIONS.module_record_create.approval_tier,
  module_record_bulk_create: 'full',
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
  [
    ...MODULE_OPERATION_NAMES.filter(
      (operation) => MODULE_OPERATION_DEFINITIONS[operation].destructive,
    ),
    // High-volume batch mutations always retain a human checkpoint, even for
    // Autonomous employees.
    'module_record_bulk_create',
  ],
);

/**
 * Native tools that physically remove data without a delete_ prefix.
 * remove_dependency deletes a task relationship row.
 */
const DESTRUCTIVE_NATIVE_TOOLS: ReadonlySet<string> = new Set(['remove_dependency']);

/**
 * Parameter keys whose value selects a destructive operation. `mode` is the
 * historical key; `action` is the operation selector used by the native
 * manage_* tools (manage_triggers, manage_agent_employee).
 */
const DESTRUCTIVE_PARAM_KEYS = ['mode', 'action'] as const;

/** MCP tool annotations as advertised by the provider. */
export type ToolAnnotations = { destructiveHint?: unknown } | null | undefined;

/**
 * Returns true if the tool call should be treated as a destructive action
 * and therefore queued for human review even under Autonomous trust.
 *
 * Any one condition is sufficient. Names are compared case-insensitively,
 * with and without the mcp__<connection>__ prefix:
 *   1. Tool name is in the hardcoded admin set.
 *   2. Tool name is a destructive module operation or remove_dependency.
 *   3. Tool name starts with "delete_" (future-proof for delete_task, delete_project, etc.).
 *   4. params is an object whose `mode` or `action` string matches delete|pause|revoke.
 *   5. The connected tool declares annotations.destructiveHint === true. Deft
 *      believes the hint when present; its absence changes nothing.
 */
export function isDestructiveAction(
  toolName: string,
  params?: unknown,
  toolAnnotations?: ToolAnnotations,
): boolean {
  if (toolAnnotations && toolAnnotations.destructiveHint === true) return true;
  // MCP tools are exposed to the model as mcp__<connection>__<tool>. Strip the
  // connection prefix BEFORE every name-based check so a connected tool named
  // like an admin tool, a delete_* tool or a module operation is classed
  // exactly like its native namesake. The unprefixed name is still checked
  // too, so nothing classed destructive today is narrowed. Comparison is
  // case-insensitive so a connected tool named Delete_contact or
  // REMOVE_MEMBER is classed like delete_contact or remove_member.
  const lowerToolName = toolName.toLowerCase();
  const effectiveToolName = lowerToolName.startsWith('mcp__')
    ? lowerToolName.split('__').slice(2).join('__')
    : lowerToolName;
  for (const name of [lowerToolName, effectiveToolName]) {
    if (DESTRUCTIVE_ADMIN_TOOLS.has(name)) return true;
    // Archive/unlink/bulk-create do not use the legacy `delete_` prefix, so
    // their classification comes from the shared module operation definition.
    if (DESTRUCTIVE_MODULE_TOOLS.has(name)) return true;
    if (DESTRUCTIVE_NATIVE_TOOLS.has(name)) return true;
    if (name.startsWith('delete_')) return true;
  }
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    for (const key of DESTRUCTIVE_PARAM_KEYS) {
      const value = (params as Record<string, unknown>)[key];
      if (typeof value === 'string' && /^(delete|pause|revoke)$/i.test(value)) return true;
    }
  }
  return false;
}

/**
 * Returns true if the action should be auto-executed (no user approval needed).
 *
 * One rule, enforced here for every trust level: an action classed as
 * destructive (isDestructiveAction) is never auto-executed, for native and
 * connected (MCP) tools alike, whatever tier it carries — including an
 * `auto`/`quick` tier taken from a connection or tool override. Destructive
 * tool names are caught without params; a params-dependent destructive call
 * (params.mode / params.action = delete|pause|revoke) is caught only when the
 * caller passes the invocation params, and a connected tool's destructiveHint
 * only when the caller passes its annotations, so callers that have them must
 * pass them.
 */
export function shouldAutoExecute(
  action: string,
  trustLevel: TrustLevel,
  params?: unknown,
  approvalTierOverride?: ApprovalTier,
  toolAnnotations?: ToolAnnotations,
): boolean {
  if (isDestructiveAction(action, params, toolAnnotations)) return false;

  const tier = getApprovalTier(action, approvalTierOverride);

  if (trustLevel === 'conservative') return tier === 'auto';
  if (trustLevel === 'standard') return tier === 'auto' || tier === 'quick';
  if (trustLevel === 'autonomous') {
    return tier === 'auto' || tier === 'quick' || tier === 'full';
  }

  return false;
}

/**
 * Tier a held-for-review call is stored at. A destructive call always needs a
 * full review, whatever tier its tool, connection or proposal carries, so it
 * is listed with the other full-review approvals. Apply it after every other
 * tier adjustment, with the live tool annotations when known.
 */
export function mandatoryApprovalTier(
  action: string,
  tier: ApprovalTier,
  params?: unknown,
  toolAnnotations?: ToolAnnotations,
): ApprovalTier {
  return isDestructiveAction(action, params, toolAnnotations) ? 'full' : tier;
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
