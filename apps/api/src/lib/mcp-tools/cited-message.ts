import { and, eq } from 'drizzle-orm';
import { agentChannelEvents, agentEmployees, messages, spaceMembers } from '@deft/db/schema';
import { db } from '../db.js';
import type { ToolContext } from './types.js';

export const CITED_MESSAGE_MISMATCH_ERROR = 'cited message is not the delivery being handled';
export const CITED_MESSAGE_UNAVAILABLE_ERROR = 'source message is unavailable';

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

/** Whether a live message of this org sits in a room the employee's user is a member of. */
export async function employeeCanReadCitedMessage(
  orgId: string,
  employeeUserId: string,
  messageId: string,
): Promise<boolean> {
  const [visible] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(spaceMembers, and(
      eq(spaceMembers.space_id, messages.space_id),
      eq(spaceMembers.user_id, employeeUserId),
    ))
    .where(and(
      eq(messages.id, messageId),
      eq(messages.org_id, orgId),
      eq(messages.is_deleted, false),
    ))
    .limit(1);
  return Boolean(visible);
}

/**
 * The `source_message_id` a proposal cites: null when the call cites none
 * (a missing, null or blank value), the verified id, or the refusal for a
 * citation of another delivery or of a message the employee cannot read.
 * Run it before any side effect of the call.
 */
export async function verifiedCitedMessage(
  ctx: Pick<ToolContext, 'org_id' | 'employee_id' | 'channel_event_id'>,
  value: unknown,
): Promise<{ messageId: string | null } | { refusal: string }> {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return { messageId: null };
  }
  if (typeof value !== 'string') return { refusal: CITED_MESSAGE_UNAVAILABLE_ERROR };
  const messageId = value.trim();
  const mismatch = await citedMessageRefusal(ctx, messageId);
  if (mismatch) return { refusal: mismatch };
  const [employee] = await db
    .select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, ctx.employee_id), eq(agentEmployees.org_id, ctx.org_id)))
    .limit(1);
  if (!employee?.user_id || !(await employeeCanReadCitedMessage(ctx.org_id, employee.user_id, messageId))) {
    return { refusal: CITED_MESSAGE_UNAVAILABLE_ERROR };
  }
  return { messageId };
}
