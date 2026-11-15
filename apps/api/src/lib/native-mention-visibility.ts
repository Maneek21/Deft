import { sql, type SQL } from 'drizzle-orm';
import { notifications } from '@deft/db/schema';
import { publicSpaceVisibleSql } from './space-visibility.js';

// Watchers are subscriptions, not sufficient authority for new mention surfaces.
export function nativeTaskAccessSql(userId: string): SQL {
  return sql`(coalesce(t.metadata->>'visibility', 'org') <> 'restricted'
    OR t.created_by = ${userId} OR t.assignee_id = ${userId} OR p.lead_id = ${userId}
    OR coalesce(t.metadata->'visible_user_ids', '[]'::jsonb) ? ${userId}
    OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ${userId}))`;
}

export function nativeSourceAccessSql(
  userId: string, kind: SQL, sourceId: SQL, orgId: SQL,
): SQL {
  return sql`(
    EXISTS (SELECT 1 FROM org_members nm WHERE nm.org_id = ${orgId}
      AND nm.user_id = ${userId} AND nm.is_active = true)
    AND (
      (${kind} = 'message' AND EXISTS (
        SELECT 1 FROM messages m JOIN spaces s ON s.id = m.space_id AND s.org_id = m.org_id
        WHERE m.id = ${sourceId} AND m.org_id = ${orgId} AND m.is_deleted = false
        AND (${publicSpaceVisibleSql(sql`s.type`, sql`s.org_id`, userId)} OR EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = s.id AND sm.user_id = ${userId}))))
      OR (${kind} = 'task' AND EXISTS (
        SELECT 1 FROM tasks t JOIN projects p ON p.id = t.project_id AND p.org_id = t.org_id
        WHERE t.id = ${sourceId} AND t.org_id = ${orgId} AND t.is_deleted = false AND p.is_deleted = false
        AND ${nativeTaskAccessSql(userId)}))
      OR (${kind} = 'task_comment' AND EXISTS (
        SELECT 1 FROM task_comments tc JOIN tasks t ON t.id = tc.task_id AND t.org_id = tc.org_id
        JOIN projects p ON p.id = t.project_id AND p.org_id = t.org_id
        WHERE tc.id = ${sourceId} AND tc.org_id = ${orgId} AND tc.is_deleted = false
        AND t.is_deleted = false AND p.is_deleted = false AND ${nativeTaskAccessSql(userId)}))
      OR (${kind} = 'wiki_page' AND EXISTS (
        SELECT 1 FROM wiki_pages w WHERE w.id = ${sourceId} AND w.org_id = ${orgId} AND w.is_deleted = false
        AND (w.scope = 'org' OR w.user_id = ${userId}
          OR (w.scope = 'space' AND EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = w.space_id AND sm.user_id = ${userId})))))
    )
  )`;
}

export function nativeDeliveryAccessSql(userId: string, deliveryId: SQL, orgId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM native_mention_deliveries nd
    JOIN native_reference_states nr ON nr.id = nd.source_state_id AND nr.org_id = nd.org_id
    WHERE nd.id = ${deliveryId} AND nd.org_id = ${orgId}
      AND nd.recipient_user_id = ${userId} AND nr.is_deleted = false
      AND ${nativeSourceAccessSql(userId, sql`nr.source_kind`, sql`nr.source_id`, sql`nr.org_id`)}
  )`;
}

/** The space is one `userId` can read today: they are in it, or it is public and they are not a guest. */
function readableSpaceSql(userId: string, spaceId: SQL, orgId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM spaces ns WHERE ns.id = ${spaceId} AND ns.org_id = ${orgId}
    AND (${publicSpaceVisibleSql(sql`ns.type`, sql`ns.org_id`, userId)}
      OR EXISTS (SELECT 1 FROM space_members nsm WHERE nsm.space_id = ns.id AND nsm.user_id = ${userId})))`;
}

/**
 * A notification with a mention delivery follows that delivery's source. Any
 * other notification that names a chat space or message is shown only while
 * the reader can still read it, the same rule the needs-you list applies
 * (lib/attention.ts): the space must be readable, and a named message must
 * exist, not be deleted and sit in a readable space. The space and message
 * are read from `metadata.space_id` / `metadata.message_id`, else from the
 * notification's link (`/chat?space=…&message=…`, or the old `/spaces/…`).
 * A notification that names neither (tasks, reminders without a source,
 * system notices) is unaffected.
 */
export function nativeNotificationAccessSql(
  userId: string, metadata: SQL, orgId: SQL, link: SQL = sql`${notifications.link}`,
): SQL {
  const spaceId = sql`coalesce(${metadata}->>'space_id',
    substring(${link} from '^/chat\\?(?:[^#]*&)?space=([^&#]+)'),
    substring(${link} from '^/spaces/([^/?#]+)$'))`;
  const messageId = sql`coalesce(${metadata}->>'message_id',
    substring(${link} from '^/chat\\?(?:[^#]*&)?message=([^&#]+)'))`;
  return sql`(CASE WHEN ${metadata}->>'native_mention_delivery_id' IS NOT NULL
    THEN ${nativeDeliveryAccessSql(userId, sql`${metadata}->>'native_mention_delivery_id'`, orgId)}
    ELSE (${spaceId} IS NULL OR ${readableSpaceSql(userId, spaceId, orgId)})
      AND (${messageId} IS NULL OR EXISTS (
        SELECT 1 FROM messages nlm WHERE nlm.id = ${messageId} AND nlm.org_id = ${orgId}
          AND nlm.is_deleted = false AND ${readableSpaceSql(userId, sql`nlm.space_id`, orgId)}))
    END)`;
}
