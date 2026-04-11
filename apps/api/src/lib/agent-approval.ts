/**
 * Trust level + approval tier routing for agent actions.
 *
 * Trust levels (set per org in Settings > Agent):
 *   conservative — every write action requires explicit user approval
 *   standard     — 'auto' tier actions execute immediately, 'quick'/'full' need approval
 *   autonomous   — 'auto' and 'quick' execute immediately, only 'full' needs approval
 *
 * Approval tiers (assigned per action tool):
 *   auto  — low-risk internal state changes (status update, assignment)
 *   quick — moderate-risk entity creation (create task, add knowledge, wiki write)
 *   full  — high-risk external/visible actions (post message, calendar event, github issue)
 */

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
};

/** Returns true if the action should be auto-executed (no user approval needed). */
export function shouldAutoExecute(
  action: string,
  trustLevel: TrustLevel,
): boolean {
  if (trustLevel === 'conservative') return false;

  const tier = TOOL_APPROVAL_TIERS[action] || 'full';

  if (trustLevel === 'standard') return tier === 'auto';
  if (trustLevel === 'autonomous') return tier === 'auto' || tier === 'quick';

  return false;
}

/** Returns the approval tier for an action tool. */
export function getApprovalTier(action: string): ApprovalTier {
  return TOOL_APPROVAL_TIERS[action] || 'full';
}
