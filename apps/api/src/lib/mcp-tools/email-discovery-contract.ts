/** Email authority comes from the exact personal credential's current App grants,
 * never from a workspace OAuth scope. Execution still performs its own checks. */
export const HUMAN_INDEPENDENT_TOOL_AUTHORITIES = {
  email_accounts: 'personal_mcp_app_grant',
  email_list: 'personal_mcp_app_grant',
  email_search: 'personal_mcp_app_grant',
  email_read: 'personal_mcp_app_grant',
  email_thread: 'personal_mcp_app_grant',
  email_draft_get: 'personal_mcp_app_grant',
  email_draft_save: 'personal_mcp_app_grant',
  email_triage: 'personal_mcp_app_grant',
  email_send: 'personal_mcp_app_grant',
  email_send_status: 'personal_mcp_app_grant',
  email_recipient_suggestions: 'personal_mcp_app_grant',
} as const;

export function isIndependentlyGovernedEmailTool(name: string): boolean {
  return Object.hasOwn(HUMAN_INDEPENDENT_TOOL_AUTHORITIES, name);
}

type Principal = { principal_kind?: string; org_id: string; user_id: string; token_id?: string };
type Caller = { kind: 'personal_mcp'; org_id: string; user_id: string; token_id: string };
type Schema = { name: string; description: string; inputSchema: Record<string, unknown> };
type Discover = (caller: Caller) => Promise<Schema[]>;

/** Both tools/list and workspace_capabilities use the same current discovery. */
export async function discoverPersonalEmailToolSchemas(principal: Principal, discover: Discover = async caller => {
  const { emailIntegrationToolSchemas } = await import('../email-integration-agent-tools.js');
  return emailIntegrationToolSchemas(caller);
}): Promise<Schema[]> {
  if (principal.principal_kind !== 'human' || !principal.token_id) return [];
  return discover({ kind: 'personal_mcp', org_id: principal.org_id,
    user_id: principal.user_id, token_id: principal.token_id });
}
