import type { notificationTypeEnum } from '@deft/db/schema';

/** The labels schema.ts's `notificationTypeEnum` declares: the type Drizzle
 * gives `notifications.type`. */
export type NotificationType = (typeof notificationTypeEnum.enumValues)[number];

/** `notification_type` labels that only upgrade SQL adds. schema.ts's enum is
 * part of the fresh-install fingerprint, so it stays as it is and Drizzle
 * doesn't know these labels, but every install's database has them. Add a
 * label here in the same change as its `ALTER TYPE notification_type ADD VALUE`. */
export const UPGRADE_NOTIFICATION_TYPES = ['document_shared'] as const;

export type AnyNotificationType = NotificationType | (typeof UPGRADE_NOTIFICATION_TYPES)[number];

/** The one sanctioned cast from a widened notification type to the stored
 * Drizzle type, for writing `notifications.type`. Every value is a real label
 * of the database enum. */
export function asStoredNotificationType(type: AnyNotificationType): NotificationType {
  return type as NotificationType;
}
