import { and, inArray, sql } from 'drizzle-orm';
import { notifications } from '@deft/db/schema';
import { db } from './db.js';
import { nativeNotificationAccessSql } from './native-mention-visibility.js';
import { withoutUnverifiableReplyText } from './reply-notification-text.js';
import { emitToUser } from '../socket.js';

type NotificationTarget = { id: string; org_id: string; user_id: string };

/** One current-source query for the whole fan-out, with each row's own recipient. */
export async function emitVisibleNotifications(targets: NotificationTarget[]): Promise<number> {
  if (targets.length === 0) return 0;
  const expected = new Map(targets.map(target => [target.id, target]));
  const visible = await db.select().from(notifications).where(and(
    inArray(notifications.id, [...expected.keys()]),
    nativeNotificationAccessSql(sql`${notifications.user_id}`, sql`${notifications.metadata}`, sql`${notifications.org_id}`),
  ));
  let sent = 0;
  for (const current of visible) {
    const target = expected.get(current.id);
    if (target?.org_id !== current.org_id || target.user_id !== current.user_id) continue;
    emitToUser(current.org_id, current.user_id, 'notification:new', withoutUnverifiableReplyText(current));
    sent++;
  }
  return sent;
}

/** Reload and authorize a legacy notification immediately before socket delivery. */
export async function emitVisibleNotification(target: NotificationTarget): Promise<boolean> {
  return (await emitVisibleNotifications([target])) === 1;
}
