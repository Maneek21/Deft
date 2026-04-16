/**
 * Trust level + approval tier routing for agent actions.
 *
 * Trust levels (set per org in Settings > Agent):
 *   conservative — every write action requires explicit user approval
 *   standard     — 'auto' and 'quick' execute immediately, only 'full' needs approval
 *   autonomous   — 'auto' and 'quick' execute immediately, only 'full' needs approval
 *
 * Matrix update (task #58 / Option 2 — 2026-04-14):
 *   Previously `standard` was near-identical to `conservative` — it only
 *   auto-executed `auto` tier, so task_create / memory_update / wiki_write
 *   all queued. The mental model in plan doc §0 was "routine stuff auto,
 *   risky stuff queued" which wasn't matching reality. Loosening standard
 *   to auto-exec quick-tier makes it behave like the plan promises.
 *   Autonomous and standard now share the same matrix; the distinction is
 *   primarily a UX affordance (autonomous implies "you read the receipts
 *   after the fact and trust the agent") vs standard (you still occasionally
 *   check the queue for full-tier actions). Receipts make both modes safe.
 *
 * Approval tiers (assigned per action tool):
 *   auto  — low-risk internal state changes (status update, assignment)
 *   quick — moderate-risk entity creation (create task, add knowledge, wiki write)
 *   full  — high-risk external/visible actions (post message, calendar event, github issue)
 */

import type { ToolResult } from './mcp-tools/types.js';
import { textResult } from './mcp-tools/types.js';

export type TrustLevel = 'conservative' | 'standard' | 'autonomous';
export type ApprovalTier = 'auto' | 'quick' | 'full';

/** Default approval tier for each action tool */
export const TOOL_APPROVAL_TIERS: Record<string, ApprovalTier> = {
  update_task_status: 'auto',
  assign_task: 'auto',
  create_task: 'quick',
  add_knowledge: 'quick',
  wiki_write: 'quick',
  post_message: 'full',
  create_calendar_event: 'full',
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
  memory_update: 'quick',
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
};

/** Returns true if the action should be auto-executed (no user approval needed). */
export function shouldAutoExecute(
  action: string,
  trustLevel: TrustLevel,
): boolean {
  if (trustLevel === 'conservative') return false;

  const tier = TOOL_APPROVAL_TIERS[action] || 'full';

  if (trustLevel === 'standard') return tier === 'auto' || tier === 'quick';
  if (trustLevel === 'autonomous') return tier === 'auto' || tier === 'quick';

  return false;
}

/** Returns the approval tier for an action tool. */
export function getApprovalTier(action: string): ApprovalTier {
  return TOOL_APPROVAL_TIERS[action] || 'full';
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
