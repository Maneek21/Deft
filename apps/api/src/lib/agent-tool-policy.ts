import { and, eq, or, sql } from 'drizzle-orm';
import { agentEmployees } from '@deft/db/schema';
import { db } from './db.js';
import { canonicalMcpToolName } from './mcp-tools.js';

export interface ActiveAgentToolPolicy {
  employeeId: string;
  disabledTools: string[];
  trustLevel: 'conservative' | 'standard' | 'autonomous';
  unhealthy: boolean;
  unhealthyReason: string | null;
}

const HEALTH_GATED_TOOLS = new Set([
  'module_record_create',
  'module_record_update',
  'module_record_archive',
]);

const NATIVE_TOOL_ALIASES: Record<string, string> = {
  close_task: 'update_task_status',
  reopen_task: 'update_task_status',
  wiki_search: 'memory_recall',
};

export function isAgentToolDisabled(
  disabledTools: string[] | null | undefined,
  toolName: string,
  aliases: Record<string, string> = NATIVE_TOOL_ALIASES,
): boolean {
  const canonicalRequested = aliases[toolName] ?? canonicalMcpToolName(toolName);
  return (disabledTools ?? []).some((configuredName) => {
    const canonicalConfigured = aliases[configuredName] ?? canonicalMcpToolName(configuredName);
    return configuredName === toolName || canonicalConfigured === canonicalRequested;
  });
}

export async function getActiveAgentToolPolicy(
  orgId: string,
  agentEmployeeId: string,
): Promise<ActiveAgentToolPolicy | null> {
  const [employee] = await db
    .select({
      id: agentEmployees.id,
      disabled_tools: agentEmployees.disabled_tools,
      trust_level: agentEmployees.trust_level,
      unhealthy: agentEmployees.unhealthy,
      unhealthy_reason: agentEmployees.unhealthy_reason,
    })
    .from(agentEmployees)
    .where(and(
      eq(agentEmployees.id, agentEmployeeId),
      eq(agentEmployees.org_id, orgId),
      eq(agentEmployees.is_active, true),
      or(
        eq(agentEmployees.is_deleted, false),
        eq(agentEmployees.runtime_kind, 'defty_system'),
      ),
    ))
    .limit(1);
  if (!employee) return null;
  return {
    employeeId: employee.id,
    disabledTools: employee.disabled_tools ?? [],
    trustLevel: employee.trust_level,
    unhealthy: employee.unhealthy,
    unhealthyReason: employee.unhealthy_reason,
  };
}

/** Atomically reserve one write-action slot. Concurrent agent turns cannot
 * race past max_daily_actions because the limit predicate and increment live
 * in the same UPDATE. */
export async function consumeAgentDailyActionBudget(
  orgId: string,
  agentEmployeeId: string,
  options: { requireHealthy?: boolean } = {},
): Promise<{ allowed: true; count: number; limit: number } | { allowed: false; error: string }> {
  const [updated] = await db
    .update(agentEmployees)
    .set({
      daily_action_count: sql`${agentEmployees.daily_action_count} + 1`,
    })
    .where(and(
      eq(agentEmployees.id, agentEmployeeId),
      eq(agentEmployees.org_id, orgId),
      eq(agentEmployees.is_active, true),
      or(
        eq(agentEmployees.is_deleted, false),
        eq(agentEmployees.runtime_kind, 'defty_system'),
      ),
      options.requireHealthy ? eq(agentEmployees.unhealthy, false) : undefined,
      sql`${agentEmployees.daily_action_count} < ${agentEmployees.max_daily_actions}`,
    ))
    .returning({
      count: agentEmployees.daily_action_count,
      limit: agentEmployees.max_daily_actions,
    });
  if (updated) return { allowed: true, count: updated.count, limit: updated.limit };

  const policy = await getActiveAgentToolPolicy(orgId, agentEmployeeId);
  return {
    allowed: false,
    error: !policy
      ? 'Agent employee is inactive, deleted, or outside this organization'
      : options.requireHealthy && policy.unhealthy
        ? `Agent employee is unhealthy and cannot execute module writes${policy.unhealthyReason ? `: ${policy.unhealthyReason}` : ''}`
        : 'Daily action limit reached. Ask an admin to increase the limit or wait for the daily reset.',
  };
}

export async function agentToolPolicyError(
  orgId: string,
  agentEmployeeId: string | null | undefined,
  toolName: string,
): Promise<string | null> {
  if (!agentEmployeeId) return null;
  const policy = await getActiveAgentToolPolicy(orgId, agentEmployeeId);
  if (!policy) return 'Agent employee is inactive, deleted, or outside this organization';
  if (policy.unhealthy && HEALTH_GATED_TOOLS.has(canonicalMcpToolName(toolName))) {
    return `Agent employee is unhealthy and cannot execute module writes${policy.unhealthyReason ? `: ${policy.unhealthyReason}` : ''}`;
  }
  if (isAgentToolDisabled(policy.disabledTools, toolName)) {
    return `Tool '${toolName}' is disabled for this agent employee`;
  }
  return null;
}
