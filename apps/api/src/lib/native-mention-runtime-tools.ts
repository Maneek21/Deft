import { and, eq, or } from 'drizzle-orm';
import { agentEmployees } from '@deft/db/schema';
import { db } from './db.js';
import { canonicalDeftyEmployeeCondition, isCanonicalDeftyEmployee } from './defty-identity.js';
import { requireActiveOrgMembership } from './org-membership.js';
import { NativeMentionSearchArgsSchema, NativeMentionResolveArgsSchema, NATIVE_MENTION_AGENT_GUIDANCE } from './native-mention-agent-contract.js';
import { searchAgentNativeMentions, resolveAgentNativeMentions } from './native-mention-agent-reads.js';
import { nativeMentionsEnabled, type NativeMentionProjection } from './native-mentions.js';
import { mentionAttentionList, mentionAttentionAcknowledge } from './mcp-tools/mention-attention.js';

export async function executeNativeMentionRuntimeTool(name: string, args: Record<string, unknown>, orgId: string, userId: string, employeeId?: string): Promise<Record<string, unknown> & { items?: NativeMentionProjection[] }> {
  try { await requireActiveOrgMembership(orgId, userId); }
  catch { return { error: 'Active workspace membership is required' }; }
  const [employee] = await db.select().from(agentEmployees).where(and(
    eq(agentEmployees.org_id, orgId), eq(agentEmployees.is_active, true),
    or(eq(agentEmployees.is_deleted, false), canonicalDeftyEmployeeCondition()),
    employeeId ? eq(agentEmployees.id, employeeId) : canonicalDeftyEmployeeCondition(),
  )).limit(1);
  if (employeeId && !employee) return { error: 'Active agent employee is required' };
  // Native Defty reads retain the requesting human's access. External employee
  // runtimes read as their own bound shadow user, never the supplied human id.
  const actor = !employeeId || isCanonicalDeftyEmployee(employee)
    ? { orgId, userId } : { orgId, userId: employee!.user_id, employeeId: employee!.id };
  if (name === 'native_mentions_search') {
    const parsed = NativeMentionSearchArgsSchema.safeParse(args);
    if (!parsed.success) return { error: 'Invalid native mention search' };
    if (!nativeMentionsEnabled()) return { enabled: false, items: [] };
    return { enabled: true, items: await searchAgentNativeMentions(actor, parsed.data.query), usage: NATIVE_MENTION_AGENT_GUIDANCE };
  }
  if (name === 'native_mentions_resolve') {
    const parsed = NativeMentionResolveArgsSchema.safeParse(args);
    if (!parsed.success) return { error: 'Invalid native references' };
    return { items: await resolveAgentNativeMentions(actor, parsed.data.refs), untrusted: true };
  }
  if (!employee) return { error: 'Bound attention identity is unavailable' };
  const ctx = { org_id: orgId, employee_id: employee.id, employee_slug: employee.slug,
    trust_level: employee.trust_level as 'conservative' | 'standard' | 'autonomous' };
  const result = name === 'mention_attention_list'
    ? await mentionAttentionList(args, ctx) : await mentionAttentionAcknowledge(args, ctx);
  return result.isError ? { error: result.content[0]?.text ?? 'Mention attention failed' }
    : JSON.parse(result.content[0]!.text);
}
