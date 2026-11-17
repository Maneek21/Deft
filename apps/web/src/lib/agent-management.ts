/**
 * An agent that is or was an owner or admin is managed only by the workspace
 * owner (apps/api/src/lib/agent-management.ts). The API sends
 * `management` with each agent; the settings pages use it to disable the
 * controls a viewer may not use. The API decides again on every write.
 */
export type AgentManagement = { owner_only: boolean; can_manage: boolean };

export const OWNER_ONLY_AGENT_NOTE = 'Only the workspace owner can manage this agent, because it is or was an owner or admin.';

/** No `management` (an older API): show the controls and let the API decide. */
export function canManageAgent(management: AgentManagement | null | undefined): boolean {
  return management ? management.can_manage : true;
}
