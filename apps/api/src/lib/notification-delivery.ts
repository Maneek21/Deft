import { and, eq, sql } from 'drizzle-orm';
import { notifications } from '@deft/db/schema';
import { db } from './db.js';
import { nativeNotificationAccessSql } from './native-mention-visibility.js';
import { withoutUnverifiableReplyText } from './reply-notification-text.js';
import { emitToUser } from '../socket.js';

/** Reload and authorize a legacy notification immediately before socket delivery. */
export async function emitVisibleNotification(target: { id: string; org_id: string; user_id: string }): Promise<boolean> {
  const [current] = await db.select().from(notifications).where(and(
    eq(notifications.id, target.id), eq(notifications.org_id, target.org_id), eq(notifications.user_id, target.user_id),
    nativeNotificationAccessSql(target.user_id, sql`${notifications.metadata}`, sql`${notifications.org_id}`),
  )).limit(1);
  if (!current) return false;
  emitToUser(current.org_id, current.user_id, 'notification:new', withoutUnverifiableReplyText(current));
  return true;
}
