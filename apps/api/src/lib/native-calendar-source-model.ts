import { z } from 'zod';
import { AppCalendarEventSchema, appCalendarInstant, type AppCalendarTime } from '../../../../packages/app-kit/src/app-calendar-event.js';
import { AppIntegrationSourceIdentitySchema, type AppIntegrationSourceIdentity } from '../../../../packages/app-kit/src/app-integration-source.js';
import { appIntegrationSourceDigest } from './app-integration-source.js';
import type { CalendarProjectionModel, CalendarProjectionRow } from './native-calendar-recurrence.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const NativeCalendarSourceModelSchema = z.strictObject({
  schema_version: z.literal('deft.app_calendar_source.v1'), source: AppIntegrationSourceIdentitySchema,
  source_scope_key: digest, event: AppCalendarEventSchema, source_model_digest: digest,
  publication_digest: digest, captured_at: z.iso.datetime(), applied_event_digest: digest,
});
export type NativeCalendarSourceModel = z.infer<typeof NativeCalendarSourceModelSchema>;
export type NativeCalendarSourceRow = CalendarProjectionRow & { org_id: string; user_id: string; updated_at?: Date };

/** Host supplies the owner; an app cannot nominate a different destination user. */
export function nativeCalendarSourceScopeKey(owner: { org_id: string; user_id: string }, source: AppIntegrationSourceIdentity) {
  return appIntegrationSourceDigest(['deft.app_calendar_source_scope.v1', owner.org_id, owner.user_id,
    source.installation_id, source.account_ref, source.store_key]);
}

/** Exclude only the self-referential applied digest. All editable native fields,
 * including extra Calendar metadata, remain part of the review revision. */
export function nativeCalendarSourceRevisionDigest(row: NativeCalendarSourceRow): string {
  const metadata = { ...(row.metadata as Record<string, unknown> | null) };
  const raw = metadata.app_calendar_source;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const { applied_event_digest: ignored, ...source } = raw as Record<string, unknown>;
    void ignored; metadata.app_calendar_source = source;
  }
  return appIntegrationSourceDigest({ id: row.id, org_id: row.org_id, user_id: row.user_id,
    title: row.title, body: row.body ?? null, url: row.url ?? null, timestamp: row.timestamp.toISOString(),
    metadata, updated_at: row.updated_at?.toISOString() ?? null });
}

export function readNativeCalendarSourceModel(row: NativeCalendarSourceRow): NativeCalendarSourceModel | null {
  const raw = (row.metadata as Record<string, unknown> | null)?.app_calendar_source;
  if (!raw || (raw as { schema_version?: unknown }).schema_version !== 'deft.app_calendar_source.v1') return null;
  const parsed = NativeCalendarSourceModelSchema.safeParse(raw);
  if (!parsed.success || parsed.data.source_scope_key !== nativeCalendarSourceScopeKey(row, parsed.data.source)) {
    throw new Error('CALENDAR_SOURCE_MODEL_INVALID');
  }
  return parsed.data;
}

function editedTime(original: AppCalendarTime, instant: string): AppCalendarTime {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error('CALENDAR_SOURCE_MODEL_INVALID');
  if (original.value_type === 'date') return { value: date.toISOString().slice(0,10).replaceAll('-',''), value_type:'date', time_zone:null, instant:null };
  if (!original.time_zone) return { value: date.toISOString().replace(/[-:]/gu,'').replace(/\.\d{3}Z$/u,'Z'), value_type:'date_time', time_zone:null, instant:date.toISOString() };
  const parts = new Map(new Intl.DateTimeFormat('en-US', { timeZone:original.time_zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' })
    .formatToParts(date).map(part=>[part.type,part.value]));
  return { ...original, value:`${parts.get('year')}${parts.get('month')}${parts.get('day')}T${parts.get('hour')}${parts.get('minute')}${parts.get('second')}`, instant:date.toISOString() };
}

/** Retained Calendar reads require no app runtime. The native row remains the
 * editable time source; imported recurrence and source identity stay unchanged. */
export function decodeNativeCalendarSourceRow(row: NativeCalendarSourceRow): CalendarProjectionModel | null {
  const stored = readNativeCalendarSourceModel(row);
  if (!stored) return null;
  const event = stored.event, metadata = row.metadata as Record<string, unknown>;
  const start = row.timestamp.toISOString(), end = typeof metadata.end === 'string' ? metadata.end : appCalendarInstant(event.end);
  return {
    // Four components cannot collide with the three-part retained identity.
    series_identity: ['deft.app_calendar_source.v1', stored.source_scope_key, 'series', event.series_key],
    uid: event.series_key,
    start: Date.parse(start) === Date.parse(appCalendarInstant(event.start)) ? event.start : editedTime(event.start,start),
    end: Date.parse(end) === Date.parse(appCalendarInstant(event.end)) ? event.end : editedTime(event.end,end),
    rrule:event.rrule, exdates:event.exdates, recurrence_id:event.recurrence_id, sequence:event.sequence, dtstamp:event.dtstamp,
  };
}
