import { extractNativeMentions, nativeMentionToken, type NativeMentionRef } from '@deft/shared';
import { and, eq, or } from 'drizzle-orm';
import { agentEmployees } from '@deft/db/schema';
import { db } from './db.js';
import { canonicalDeftyEmployeeCondition, isCanonicalDeftyEmployee } from './defty-identity.js';
import { requireActiveOrgMembership } from './org-membership.js';
import { nativeMentionsEnabled, resolveNativeMentions, type NativeMentionContext } from './native-mentions.js';

const unavailable = 'Native references are unavailable. Copy exact tokens from native_mentions_search and wait for create results before linking new resources. Do not use placeholder IDs.';

// Closed content surface: changing notes/calendar is outside this feature.
export function agentMentionWriteRefs(operation: string, args: Record<string, unknown>): NativeMentionRef[] {
  const patch = args.patch && typeof args.patch === 'object' ? args.patch as Record<string, unknown> : {};
  let contents: unknown[] = [];
  if (['send_message', 'message_post', 'post_message', 'comment_on_task', 'wiki_create', 'wiki_write'].includes(operation)) contents = [args.content];
  if (['task_create', 'create_task'].includes(operation)) contents = [args.description, ...(Array.isArray(args.subtasks) ? args.subtasks.map(item => item?.description) : [])];
  if (operation === 'task_update') contents = [patch.description, patch.comment];
  if (operation === 'wiki_update') contents = [patch.content];
  const refs = new Map<string, NativeMentionRef>();
  for (const content of contents) {
    if (typeof content !== 'string') continue;
    for (const ref of extractNativeMentions(content)) refs.set(nativeMentionToken(ref), ref);
  }
  if (refs.size > 100) throw new Error('Too many references');
  return [...refs.values()];
}

export async function validateAgentMentionRefs(actor: NativeMentionContext, refs: NativeMentionRef[], scopes?: readonly string[]): Promise<string | null> {
  if (scopes && (!scopes.includes('read:workspace') || refs.some(ref =>
    ref.resource_type !== 'person' && !scopes.includes(ref.resource_type === 'task' ? 'read:tasks' : 'read:wiki')))) return unavailable;
  const resolved = await resolveNativeMentions(actor, refs);
  return resolved.length === refs.length && resolved.every(item => item.state === 'available') ? null : unavailable;
}

export async function validateNativeAgentMentionWrite(operation: string, args: Record<string, unknown>, orgId: string, userId: string, employeeId?: string): Promise<string | null> {
  if (!nativeMentionsEnabled()) return null;
  let refs: NativeMentionRef[];
  try { refs = agentMentionWriteRefs(operation, args); } catch { return unavailable; }
  if (!refs.length) return null;
  try { await requireActiveOrgMembership(orgId, userId); } catch { return unavailable; }
  const [employee] = await db.select().from(agentEmployees).where(and(
    eq(agentEmployees.org_id, orgId), eq(agentEmployees.is_active, true),
    or(eq(agentEmployees.is_deleted, false), canonicalDeftyEmployeeCondition()),
    employeeId ? eq(agentEmployees.id, employeeId) : canonicalDeftyEmployeeCondition(),
  )).limit(1);
  if (employeeId && !employee) return unavailable;
  const actor = !employeeId || isCanonicalDeftyEmployee(employee)
    ? { orgId, userId } : { orgId, userId: employee!.user_id, employeeId: employee!.id };
  return validateAgentMentionRefs(actor, refs);
}
