import { and, eq, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { events, orgMembers } from '@deft/db/schema';
import { hostRetainedSourceStorage } from './host-source-storage.js';
import { decodeNativeCalendarSourceRow } from './native-calendar-source-model.js';
import { projectNativeCalendarEvents, type CalendarProjectionRow } from './native-calendar-recurrence.js';

/** Recognize even unknown stored versions so they cannot silently become a
 * misleading one-off event through the ordinary reader. */
export function appSourceCalendarEventCondition() {
  return or(sql`${events.metadata} ? 'app_calendar_source'`, hostRetainedSourceStorage.calendar.condition)!;
}
export function ordinaryCalendarEventCondition() {
  return sql`not coalesce((${appSourceCalendarEventCondition()}), false)`;
}

export function decodeAppSourceCalendarRow(row: CalendarProjectionRow, owner: { org_id: string; user_id: string }) {
  const modern = Object.hasOwn(row.metadata ?? {}, 'app_calendar_source');
  if (modern && hostRetainedSourceStorage.calendar.hasRecord(row)) throw new Error('CALENDAR_SOURCE_MODEL_AMBIGUOUS');
  return modern ? decodeNativeCalendarSourceRow({ ...row, ...owner })
    : hostRetainedSourceStorage.calendar.decodeProjectionModel(row);
}

/** Native Calendar owns retained reads without an app callback. Exact owner and
 * current membership apply before expansion, including old masters before the
 * window. Keep the public row shape and retained occurrence identities intact. */
export async function readAppSourceCalendarOccurrences(database: Pick<NodePgDatabase, 'select'>, input: {
  org_id: string; owner_user_id: string; from: Date; to: Date;
}) {
  const rows = await database.select({ id: events.id, title: events.title, body: events.body, url: events.url,
    event_type: events.event_type, timestamp: events.timestamp, metadata: events.metadata, source: events.source })
    .from(events).where(and(eq(events.org_id, input.org_id), eq(events.user_id, input.owner_user_id),
      sql`exists (select 1 from ${orgMembers} where ${orgMembers.org_id} = ${events.org_id}
        and ${orgMembers.user_id} = ${events.user_id} and ${orgMembers.is_active} = true)`,
      eq(events.source, 'native'), eq(events.event_type, 'calendar_event'),
      appSourceCalendarEventCondition(), lte(events.timestamp, input.to))).limit(513);
  return projectNativeCalendarEvents(rows, input.from, input.to, row => decodeAppSourceCalendarRow(row,
    { org_id: input.org_id, user_id: input.owner_user_id }));
}
