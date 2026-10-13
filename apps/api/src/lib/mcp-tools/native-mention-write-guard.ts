import { agentMentionWriteRefs, validateAgentMentionRefs } from '../native-mention-agent-writes.js';
import { nativeMentionsEnabled } from '../native-mentions.js';
import { loadEmployeeProjectAccess } from './employee-project-access.js';
import type { ToolContext } from './types.js';

export async function employeeMentionWriteError(operation: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string | null> {
  if (!nativeMentionsEnabled()) return null;
  let refs;
  try { refs = agentMentionWriteRefs(operation, args); }
  catch { return 'Native references exceed the supported limit.'; }
  if (!refs.length) return null;
  const access = await loadEmployeeProjectAccess(ctx);
  if (!access.resolved) return 'Native references require an active bound employee.';
  return validateAgentMentionRefs({ orgId: ctx.org_id, userId: access.userId, employeeId: ctx.employee_id }, refs, ctx.token_id ? ctx.scopes ?? [] : undefined);
}
