import { and, eq } from 'drizzle-orm';
import { messages, spaceMembers, spaces } from '@deft/db/schema';
import { db } from './db.js';
import { toPlainText, truncatePlainText } from './plain-text.js';

export type VisibleReminderSource = {
  messageId: string;
  spaceId: string;
  preview: string;
};

/**
 * Resolve a message-backed reminder against current visibility. Reminder rows
 * can outlive space membership and soft-deleted messages, so callers must not
 * use a cached reminder.message value for source-backed reminders.
 */
export async function loadVisibleReminderSource(params: {
  sourceMessageId: string;
  orgId: string;
  userId: string;
}): Promise<VisibleReminderSource | null> {
  const [source] = await db
    .select({
      id: messages.id,
      space_id: messages.space_id,
      content: messages.content,
    })
    .from(messages)
    .innerJoin(spaces, and(
      eq(messages.space_id, spaces.id),
      eq(spaces.org_id, params.orgId),
      eq(spaces.is_archived, false),
    ))
    .innerJoin(spaceMembers, and(
      eq(spaceMembers.space_id, messages.space_id),
      eq(spaceMembers.user_id, params.userId),
    ))
    .where(and(
      eq(messages.id, params.sourceMessageId),
      eq(messages.org_id, params.orgId),
      eq(messages.is_deleted, false),
    ))
    .limit(1);

  if (!source) return null;
  return {
    messageId: source.id,
    spaceId: source.space_id,
    preview: truncatePlainText(toPlainText(source.content), 4000) || 'Message reminder',
  };
}
