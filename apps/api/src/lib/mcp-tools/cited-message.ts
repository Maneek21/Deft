import { and, eq } from 'drizzle-orm';
import { agentChannelEvents } from '@deft/db/schema';
import { db } from '../db.js';
import type { ToolContext } from './types.js';

export const CITED_MESSAGE_MISMATCH_ERROR = 'cited message is not the delivery being handled';

/**
 * The refusal for a call that cites a chat message while handling the
 * delivery of a different message, or null. A call that handles no delivery,
 * or a delivery that is not a message, may cite any message it can read.
 */
export async function citedMessageRefusal(
  ctx: Pick<ToolContext, 'org_id' | 'employee_id' | 'channel_event_id'>,
  messageId: string,
): Promise<string | null> {
  if (!ctx.channel_event_id) return null;
  const [delivery] = await db
    .select({ kind: agentChannelEvents.kind, source_kind: agentChannelEvents.source_kind, source_id: agentChannelEvents.source_id })
    .from(agentChannelEvents)
    .where(and(
      eq(agentChannelEvents.id, ctx.channel_event_id),
      eq(agentChannelEvents.org_id, ctx.org_id),
      eq(agentChannelEvents.agent_employee_id, ctx.employee_id),
    ))
    .limit(1);
  if (!delivery || (delivery.kind !== 'message.created' && delivery.source_kind !== 'message')) return null;
  return delivery.source_id === messageId ? null : CITED_MESSAGE_MISMATCH_ERROR;
}
