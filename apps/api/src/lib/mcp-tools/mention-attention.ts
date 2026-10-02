import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { agentEmployees } from '@deft/db/schema';
import { NativeMentionSourceSchema } from '@deft/shared';
import { db } from '../db.js';
import { listNativeMentionAttention, loadNativeSource, nativeMentionsEnabled } from '../native-mentions.js';
import { transitionAttentionItem } from '../attention.js';
import { textResult, errorResult, type ToolContext } from './types.js';

export async function boundMentionAttention(ctx: ToolContext) {
  if (!nativeMentionsEnabled()) return [];
  if (ctx.token_id && !ctx.scopes?.includes('read:workspace')) return [];
  const [employee] = await db.select({ user_id: agentEmployees.user_id }).from(agentEmployees).where(and(
    eq(agentEmployees.id, ctx.employee_id), eq(agentEmployees.org_id, ctx.org_id),
    eq(agentEmployees.is_active, true), eq(agentEmployees.is_deleted, false),
  ));
  if (!employee) return [];
  const context = { orgId: ctx.org_id, userId: employee.user_id, employeeId: ctx.employee_id };
  const items = await listNativeMentionAttention(context);
  const result = [];
  for (const item of items) {
    if (item.state === 'acknowledged') continue;
    const source = NativeMentionSourceSchema.safeParse((item.metadata as Record<string, unknown>).native_mention_source);
    if (!source.success) continue;
    const scope = source.data.kind === 'message' ? 'read:messages' :
      source.data.kind === 'task' || source.data.kind === 'task_comment' ? 'read:tasks' :
        source.data.kind === 'wiki_page' ? 'read:wiki' : 'read:workspace';
    if (ctx.token_id && !ctx.scopes?.includes(scope)) continue;
    const current = await loadNativeSource(context, source.data);
    if (current) result.push({ ...item, source: source.data, current_source: {
      label: current.label, content: current.content.slice(0, 5000), truncated: current.content.length > 5000,
    } });
  }
  return result;
}
export async function mentionAttentionList(args: unknown, ctx: ToolContext) {
  const parsed = z.object({ caller_employee_slug: z.string().optional() }).strict().safeParse(args);
  if (!parsed.success) return errorResult('Invalid mention attention arguments');
  return textResult({ mention_attention: await boundMentionAttention(ctx), passive: true });
}
export async function mentionAttentionAcknowledge(args: unknown, ctx: ToolContext) {
  const parsed = z.object({ attention_id: z.string().min(1), caller_employee_slug: z.string().optional() }).strict().safeParse(args);
  if (!parsed.success) return errorResult('attention_id is required');
  if (ctx.token_id && !ctx.scopes?.includes('write:workspace')) return errorResult('Missing MCP scope: write:workspace');
  const item = (await boundMentionAttention(ctx)).find(item => item.id === parsed.data.attention_id);
  if (!item) return errorResult('Mention attention item not found');
  const updated = await transitionAttentionItem({ orgId: ctx.org_id, userId: item.user_id,
    itemId: item.id, state: 'acknowledged', actorUserId: item.user_id });
  return textResult({ acknowledged: Boolean(updated), attention_id: item.id, passive: true });
}
