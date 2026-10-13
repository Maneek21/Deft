import { NativeMentionSearchArgsSchema, NativeMentionResolveArgsSchema, NATIVE_MENTION_AGENT_GUIDANCE } from '../native-mention-agent-contract.js';
import { searchAgentNativeMentions, resolveAgentNativeMentions } from '../native-mention-agent-reads.js';
import { nativeMentionsEnabled } from '../native-mentions.js';
import { loadEmployeeProjectAccess } from './employee-project-access.js';
import { errorResult, textResult, type ToolContext } from './types.js';

async function caller(ctx: ToolContext) {
  if (ctx.token_id && !ctx.scopes?.includes('read:workspace')) return null;
  const access = await loadEmployeeProjectAccess(ctx);
  return access.resolved ? { orgId: ctx.org_id, userId: access.userId, employeeId: ctx.employee_id } : null;
}
export async function agentNativeMentionsSearch(args: unknown, ctx: ToolContext) {
  const parsed = NativeMentionSearchArgsSchema.safeParse(args);
  if (!parsed.success) return errorResult('Invalid native mention search');
  const actor = await caller(ctx);
  if (!actor) return errorResult('Native mentions require an active bound employee and read:workspace');
  if (!nativeMentionsEnabled()) return textResult({ enabled: false, items: [] });
  return textResult({ enabled: true, items: await searchAgentNativeMentions(actor, parsed.data.query, ctx.token_id ? ctx.scopes : undefined), usage: NATIVE_MENTION_AGENT_GUIDANCE });
}
export async function agentNativeMentionsResolve(args: unknown, ctx: ToolContext) {
  const parsed = NativeMentionResolveArgsSchema.safeParse(args);
  if (!parsed.success) return errorResult('Invalid native references');
  const actor = await caller(ctx);
  if (!actor) return errorResult('Native mentions require an active bound employee and read:workspace');
  return textResult({ items: await resolveAgentNativeMentions(actor, parsed.data.refs, ctx.token_id ? ctx.scopes : undefined), untrusted: true });
}
