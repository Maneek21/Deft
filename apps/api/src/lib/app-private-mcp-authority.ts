import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { agentEmployees, mcpTokens, orgMembers, users } from '@deft/db/schema';
import type { AppRunTransaction } from './app-run-repository.js';
import { accessUnavailable } from './app-resource-access-contract.js';
import { privateSharingEnabled } from './app-resource-access-service.js';
import { isAgentToolDisabled } from './agent-tool-policy.js';
import { privateMcpInvocationAuthority, type PrivateMcpInvocation } from './mcp-token.js';
import type { PRIVATE_MCP_TOOL_NAMES } from './app-private-mcp-contract.js';

export const privateMcpEnabled = () => privateSharingEnabled()
  && process.env.DEFT_APP_PRIVATE_MCP_ENABLED === 'true';

export function requirePrivateMcpInvocation(invocation: PrivateMcpInvocation) {
  const authority = privateMcpInvocationAuthority(invocation);
  if (!authority || !privateMcpEnabled() || authority.deadline <= performance.now()) throw accessUnavailable();
  authority.signal.throwIfAborted();
  return authority;
}

/** Caller has already locked all memberships and, for employee destinations,
 * the exact employee row BEFORE App/parent/grant locks. Token is terminal. */
export async function finalPrivateMcpCredential(
  tx: AppRunTransaction,
  invocation: PrivateMcpInvocation,
  tool: typeof PRIVATE_MCP_TOOL_NAMES[number],
  expiresAt: Date,
  clock: () => Date,
) {
  const { authentication: stamp } = requirePrivateMcpInvocation(invocation);
  await tx.execute(sql`SELECT id FROM mcp_tokens WHERE org_id=${stamp.org_id} AND id=${stamp.token_id} FOR SHARE`);
  const [token] = await tx.select().from(mcpTokens).where(and(eq(mcpTokens.org_id, stamp.org_id), eq(mcpTokens.id, stamp.token_id))).limit(1);
  if (!token || token.revoked_at || token.principal_kind !== stamp.principal_kind
    || token.app_run_authorization_version !== stamp.token_authorization_version
    || createHash('sha256').update(token.token_hash).digest('hex') !== stamp.token_hash_digest
    || JSON.stringify([...(token.scopes ?? [])].sort()) !== JSON.stringify(stamp.scopes)
    || !token.scopes.includes('read:app-private-resources')) throw accessUnavailable();
  const [subject] = await tx.select({ kind: users.kind, active: orgMembers.is_active, role: orgMembers.role, authorization_version: orgMembers.app_run_authorization_version })
    .from(orgMembers).innerJoin(users, eq(users.id, orgMembers.user_id))
    .where(and(eq(orgMembers.org_id, stamp.org_id), eq(orgMembers.user_id, stamp.user_id))).limit(1);
  if (!subject?.active || subject.role === 'guest' || subject.authorization_version !== stamp.membership_authorization_version) throw accessUnavailable();
  if (stamp.principal_kind === 'human') {
    if (token.user_id !== stamp.user_id || token.agent_employee_id || subject.kind !== 'human') throw accessUnavailable();
  } else {
    const [employee] = await tx.select().from(agentEmployees).where(and(eq(agentEmployees.org_id, stamp.org_id), eq(agentEmployees.id, stamp.employee_id!))).limit(1);
    if (!employee || token.agent_employee_id !== employee.id || token.user_id
      || employee.user_id !== stamp.user_id || subject.kind !== 'agent'
      || employee.app_run_authorization_version !== stamp.employee_authorization_version
      || !employee.is_active || employee.is_deleted || employee.unhealthy
      || isAgentToolDisabled(employee.disabled_tools, tool)) throw accessUnavailable();
  }
  // Recheck after every awaited row/query, including gate withdrawal and abort.
  requirePrivateMcpInvocation(invocation);
  if (expiresAt <= clock()) throw accessUnavailable();
}
