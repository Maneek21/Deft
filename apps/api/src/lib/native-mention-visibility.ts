import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from './db.js';
import { notifications, users } from '@deft/db/schema';
import { publicSpaceVisibleSql } from './space-visibility.js';
import { readableSpaceSql } from './space-membership.js';
import { guestTaskScopeSql, memberProjectOrNamedTaskSql, taskAliasColumns, taskHiddenFromGuestSql } from './task-visibility.js';
import { fullWorkspaceViewSql } from './people-visibility-sql.js';
import { visibleDriveIdSql } from './document-access.js';

// Watchers are subscriptions, not sufficient authority for new mention
// surfaces on a restricted task.
function nativeRestrictedTaskAccessSql(userId: string | SQL): SQL {
  return sql`(coalesce(t.metadata->>'visibility', 'org') <> 'restricted'
    OR t.created_by = ${userId} OR t.assignee_id = ${userId} OR p.lead_id = ${userId}
    OR coalesce(t.metadata->'visible_user_ids', '[]'::jsonb) ? ${userId}
    OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ${userId}))`;
}

// The restricted rule above, and a guest sees only the tasks of their
// projects and the tasks that name them (task-visibility.ts). For a query
// naming the task `t` and its project `p`.
export function nativeTaskAccessSql(userId: string | SQL): SQL {
  return sql`COALESCE((${nativeRestrictedTaskAccessSql(userId)} AND ${guestTaskScopeSql(userId, taskAliasColumns('t'))}), false)`;
}

// A task or task comment source follows the restricted rule in its branch,
// and the guest rule (nativeTaskAccessSql) once for both kinds at the end.
export function nativeSourceAccessSql(
  userId: string | SQL, kind: SQL, sourceId: SQL, orgId: SQL,
): SQL {
  return sql`(
    EXISTS (SELECT 1 FROM org_members nm WHERE nm.org_id = ${orgId}
      AND nm.user_id = ${userId} AND nm.is_active = true)
    AND (
      (${kind} = 'message' AND EXISTS (
        SELECT 1 FROM messages m JOIN spaces s ON s.id = m.space_id AND s.org_id = m.org_id
        WHERE m.id = ${sourceId} AND m.org_id = ${orgId} AND m.is_deleted = false
        AND ((s.is_archived = false AND ${publicSpaceVisibleSql(sql`s.type`, sql`s.org_id`, userId)})
          OR EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = s.id AND sm.user_id = ${userId}))))
      OR (${kind} = 'task' AND EXISTS (
        SELECT 1 FROM tasks t JOIN projects p ON p.id = t.project_id AND p.org_id = t.org_id
        WHERE t.id = ${sourceId} AND t.org_id = ${orgId} AND t.is_deleted = false AND p.is_deleted = false
        AND ${nativeRestrictedTaskAccessSql(userId)}))
      OR (${kind} = 'task_comment' AND EXISTS (
        SELECT 1 FROM task_comments tc JOIN tasks t ON t.id = tc.task_id AND t.org_id = tc.org_id
        JOIN projects p ON p.id = t.project_id AND p.org_id = t.org_id
        WHERE tc.id = ${sourceId} AND tc.org_id = ${orgId} AND tc.is_deleted = false
        AND t.is_deleted = false AND p.is_deleted = false AND ${nativeRestrictedTaskAccessSql(userId)}))
      OR (${kind} = 'wiki_page' AND EXISTS (
        SELECT 1 FROM wiki_pages w WHERE w.id = ${sourceId} AND w.org_id = ${orgId} AND w.is_deleted = false
        AND (w.scope = 'org' OR w.user_id = ${userId}
          OR (w.scope = 'space' AND EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = w.space_id AND sm.user_id = ${userId})))))
    )
    AND NOT (${kind} IN ('task', 'task_comment') AND ${taskHiddenFromGuestSql(
      userId,
      sql`CASE WHEN ${kind} = 'task' THEN ${sourceId} ELSE (SELECT guest_comment.task_id FROM task_comments guest_comment
        WHERE guest_comment.id = ${sourceId} AND guest_comment.org_id = ${orgId}) END`,
      orgId,
    )})
  )`;
}

export function nativeDeliveryAccessSql(userId: string | SQL, deliveryId: SQL, orgId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM native_mention_deliveries nd
    JOIN native_reference_states nr ON nr.id = nd.source_state_id AND nr.org_id = nd.org_id
    WHERE nd.id = ${deliveryId} AND nd.org_id = ${orgId}
      AND nd.recipient_user_id = ${userId} AND nr.is_deleted = false
      AND ${nativeSourceAccessSql(userId, sql`nr.source_kind`, sql`nr.source_id`, sql`nr.org_id`)}
  )`;
}

/**
 * A notification with a mention delivery follows that delivery's source. Any
 * other notification that names a chat space or message is shown only while
 * the reader can still read it, the same rule the needs-you list applies
 * (lib/attention.ts): the space must be readable, and a named message must
 * exist, not be deleted and sit in a readable space. The space and message
 * are read from `metadata.space_id` / `metadata.message_id`, else from the
 * notification's link (`/chat?space=…&message=…`, or the old `/spaces/…`).
 * A notification that names a task is hidden from a guest who may not see
 * that task (noticeNamesGuestHiddenTaskSql). A notification that names a
 * drive (`metadata.drive_id`) and no document is shown only while the reader
 * can view that drive (visibleDriveIdSql): a drive shared with them, or an
 * admin's change to a private drive's members. That check stands outside the
 * mention/source CASE, so it holds whichever branch the notification takes,
 * a mention delivery included. F9 adds the document branch. A notification
 * that names none of these (reminders without a source, system notices) is
 * unaffected.
 */
export function nativeNotificationAccessSql(
  userId: string | SQL, metadata: SQL, orgId: SQL, link: SQL = sql`${notifications.link}`,
): SQL {
  const spaceId = sql`coalesce(${metadata}->>'space_id',
    substring(${link} from '^/chat\\?(?:[^#]*&)?space=([^&#]+)'),
    substring(${link} from '^/spaces/([^/?#]+)$'))`;
  const messageId = sql`coalesce(${metadata}->>'message_id',
    substring(${link} from '^/chat\\?(?:[^#]*&)?message=([^&#]+)'))`;
  const driveId = sql`(${metadata}->>'drive_id')`;
  return sql`((CASE WHEN ${metadata}->>'native_mention_delivery_id' IS NOT NULL
    THEN ${nativeDeliveryAccessSql(userId, sql`${metadata}->>'native_mention_delivery_id'`, orgId)}
    ELSE (${spaceId} IS NULL OR ${readableSpaceSql(userId, spaceId, orgId)})
      AND (${messageId} IS NULL OR EXISTS (
        SELECT 1 FROM messages nlm WHERE nlm.id = ${messageId} AND nlm.org_id = ${orgId}
          AND nlm.is_deleted = false AND ${readableSpaceSql(userId, sql`nlm.space_id`, orgId)}))
    END)
    AND (${driveId} IS NULL OR ${metadata}->>'document_id' IS NOT NULL OR ${visibleDriveIdSql(userId, orgId, driveId)})
    AND NOT ${noticeNamesGuestHiddenTaskSql(userId, metadata, orgId, link)})`;
}

/**
 * True when a notice (a notification or an attention item) names a task that
 * `userId`, as a guest of `orgId`, may not see (task-visibility.ts). A task
 * is named by a metadata key ending in `task_id` (or `taskId`), by the
 * `task_ids` or `blocking_deps` arrays, or by a `/tasks?task=` link holding a key (`PREFIX-N`,
 * any prefix) or a task id. Always false for an owner, admin or member.
 *
 * One lookup (a scalar subquery), no IN or EXISTS: PostgreSQL plans this on
 * every Inbox read (lib/attention.ts), and plans an IN or EXISTS twice.
 */
export function noticeNamesGuestHiddenTaskSql(userId: string | SQL, metadata: SQL, orgId: SQL, link: SQL): SQL {
  const object = sql`CASE WHEN jsonb_typeof(${metadata}) = 'object' THEN ${metadata} ELSE '{}'::jsonb END`;
  const taskIds = sql`CASE WHEN jsonb_typeof(${metadata}->'task_ids') = 'array' THEN ${metadata}->'task_ids' ELSE '[]'::jsonb END
    || CASE WHEN jsonb_typeof(${metadata}->'blocking_deps') = 'array' THEN ${metadata}->'blocking_deps' ELSE '[]'::jsonb END`;
  // The link's task reference, URL-decoded only for the separators a key or id may hold.
  const ref = sql`replace(substring(${link} from '^/tasks\\?(?:[^#]*&)?task=([^&#]+)'), '%2D', '-')`;
  const refNumber = sql`substring(${ref} from '-([0-9]{1,9})$')`;
  const refPrefix = sql`left(${ref}, length(${ref}) - length(${refNumber}) - 1)`;
  return sql`(NOT ${fullWorkspaceViewSql(userId, orgId)} AND COALESCE((
    SELECT true FROM (
        SELECT named.value AS task_id FROM jsonb_each_text(${object}) named
          WHERE right(named.key, 7) = 'task_id' OR named.key = 'taskId'
        UNION ALL SELECT listed.value FROM jsonb_array_elements_text(${taskIds}) listed
        UNION ALL SELECT ${ref}
        UNION ALL SELECT ref_task.id FROM tasks ref_task
          JOIN projects ref_project ON ref_project.id = ref_task.project_id AND ref_project.org_id = ${orgId}
          WHERE ${refNumber} IS NOT NULL AND ref_task.org_id = ${orgId}
            AND upper(ref_project.prefix) = upper(${refPrefix})
            AND ref_task.number = ${refNumber}::int
      ) noticed
      JOIN tasks noticed_task ON noticed_task.id = noticed.task_id AND noticed_task.org_id = ${orgId}
    WHERE ${memberProjectOrNamedTaskSql(userId, taskAliasColumns('noticed_task'))} IS NOT TRUE
    LIMIT 1), false))`;
}

/** True when a notification about to be created may name a task (cheap pre-check before `noticeNamesGuestHiddenTaskSql`). */
export function noticeMayNameTask(metadata: unknown, link: string | null | undefined): boolean {
  if (typeof link === 'string' && link.startsWith('/tasks?')) return true;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  return Object.keys(metadata).some((key) => key.endsWith('task_id') || key === 'taskId' || key === 'task_ids' || key === 'blocking_deps');
}

/**
 * True when a notification about to be created for `userId` in `orgId` names
 * a task that they, as a guest, may not see: such a notification is not
 * created, so neither its row nor its live event reaches them.
 */
export async function noticeHidesTaskFrom(
  values: { user_id: string; org_id: string; metadata?: unknown; link?: string | null },
): Promise<boolean> {
  if (!noticeMayNameTask(values.metadata, values.link)) return false;
  const metadata = values.metadata && typeof values.metadata === 'object' ? JSON.stringify(values.metadata) : '{}';
  // Read as a value on the recipient's user row: a recipient that does not
  // exist gets no notification anyway (notification-policy.ts).
  const [row] = await db.select({
    hidden: sql<boolean>`${noticeNamesGuestHiddenTaskSql(
      values.user_id, sql`${metadata}::jsonb`, sql`${values.org_id}::text`, sql`${values.link ?? null}::text`,
    )}`,
  }).from(users).where(eq(users.id, values.user_id)).limit(1);
  return row?.hidden === true;
}

/**
 * The notification ids among `ids` the user may still read, checked again
 * right before a list responds: a source deleted or a room left while the
 * route did its other queries drops the row instead of sending its body.
 */
export async function currentlyVisibleNotificationIds(user: { id: string; org_id: string }, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.select({ id: notifications.id }).from(notifications).where(and(
    inArray(notifications.id, ids),
    eq(notifications.user_id, user.id),
    eq(notifications.org_id, user.org_id),
    nativeNotificationAccessSql(user.id, sql`${notifications.metadata}`, sql`${notifications.org_id}`),
  ));
  return new Set(rows.map((row) => row.id));
}
