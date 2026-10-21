import { z } from 'zod';

const civilDate = (value: string) => `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
export const AppCalendarTimeSchema = z.strictObject({
  value: z.string().regex(/^(?:[0-9]{8}|[0-9]{8}T[0-9]{6}Z?)$/u),
  value_type: z.enum(['date', 'date_time']),
  time_zone: z.string().regex(/^[A-Za-z0-9_+./-]{1,128}$/u).nullable(),
  instant: z.iso.datetime().nullable(),
}).refine(time => {
  if (Number(time.value.slice(0,4)) < 1900) return false;
  const date = civilDate(time.value);
  if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) return false;
  if (time.value_type === 'date') return time.value.length === 8 && time.time_zone === null && time.instant === null;
  if (!time.instant || time.value.length < 15) return false;
  const instant = new Date(time.instant);
  if (instant.getUTCMilliseconds() !== 0) return false;
  if (time.time_zone) {
    if (time.value.endsWith('Z')) return false;
    try {
      const parts = new Map(new Intl.DateTimeFormat('en-US', { timeZone: time.time_zone,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).formatToParts(instant).map(part => [part.type, part.value]));
      return time.value === `${parts.get('year')}${parts.get('month')}${parts.get('day')}T${parts.get('hour')}${parts.get('minute')}${parts.get('second')}`;
    } catch { return false; }
  }
  return time.value === instant.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
});
export type AppCalendarTime = z.infer<typeof AppCalendarTimeSchema>;
export const appCalendarInstant = (time: AppCalendarTime) => time.instant ?? `${civilDate(time.value)}T00:00:00Z`;

const rule = z.string().regex(/^[A-Z0-9=;,+-]{1,1024}$/iu).refine(value => {
  const entries = value.toUpperCase().split(';').map(part => part.split('='));
  if (entries.some(parts => parts.length !== 2 || !parts[1]) || new Set(entries.map(parts => parts[0])).size !== entries.length) return false;
  const fields = new Map(entries.map(parts => [parts[0]!, parts[1]!]));
  const allowed = new Set(['FREQ','INTERVAL','COUNT','UNTIL','BYDAY','BYMONTHDAY','BYMONTH','BYSETPOS','BYYEARDAY','BYWEEKNO','WKST']);
  if ([...fields.keys()].some(key => !allowed.has(key)) || !['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(fields.get('FREQ') ?? '')) return false;
  if (fields.has('COUNT') && fields.has('UNTIL')) return false;
  for (const key of ['INTERVAL','COUNT']) if (fields.has(key) && (!/^[0-9]+$/u.test(fields.get(key)!) || Number(fields.get(key)) < 1 || Number(fields.get(key)) > 100000)) return false;
  for (const [key, bound] of [['BYMONTH',12],['BYMONTHDAY',31],['BYYEARDAY',366],['BYWEEKNO',53],['BYSETPOS',366]] as const) {
    if (fields.has(key) && fields.get(key)!.split(',').some(part => !/^[+-]?[0-9]{1,3}$/u.test(part)
      || Number(part) === 0 || Math.abs(Number(part)) > bound || key === 'BYMONTH' && Number(part) < 1)) return false;
  }
  if (fields.has('BYDAY') && fields.get('BYDAY')!.split(',').some(part => !/^(?:[+-]?(?:[1-9]|[1-4][0-9]|5[0-3]))?(?:MO|TU|WE|TH|FR|SA|SU)$/u.test(part))) return false;
  if (fields.has('WKST') && !/^(?:MO|TU|WE|TH|FR|SA|SU)$/u.test(fields.get('WKST')!)) return false;
  if (fields.has('UNTIL')) {
    const until = fields.get('UNTIL')!;
    if (!/^(?:[0-9]{8}|[0-9]{8}T[0-9]{6}Z)$/u.test(until)) return false;
    const date = civilDate(until);
    if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) return false;
    if (until.includes('T') && !AppCalendarTimeSchema.safeParse({ value: until, value_type: 'date_time', time_zone: null,
      instant: `${date}T${until.slice(9,11)}:${until.slice(11,13)}:${until.slice(13,15)}Z` }).success) return false;
  }
  return true;
});
/** An app nominates a local owner-only Calendar mutation. Provider transport and
 * replies are separate app actions; no implicit external side effect is defined. */
export const AppCalendarEventSchema = z.strictObject({
  schema_version: z.literal('deft.app_calendar_event.v1'),
  event_key: z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u),
  series_key: z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/u),
  source_revision: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u),
  status: z.enum(['confirmed','canceled']),
  start: AppCalendarTimeSchema, end: AppCalendarTimeSchema,
  rrule: rule.nullable(), exdates: z.array(AppCalendarTimeSchema).max(256),
  recurrence_id: AppCalendarTimeSchema.nullable(), sequence: z.number().int().nonnegative().max(2147483647),
  dtstamp: z.iso.datetime(),
}).refine(model => {
  const start = Date.parse(appCalendarInstant(model.start)), end = Date.parse(appCalendarInstant(model.end));
  return model.start.value_type === model.end.value_type && end > start && end - start <= 366 * 86400000
    && (!model.recurrence_id || model.recurrence_id.value_type === model.start.value_type)
    && model.exdates.every(time => time.value_type === model.start.value_type)
    && !(model.recurrence_id && model.rrule);
});
export type AppCalendarEvent = z.infer<typeof AppCalendarEventSchema>;
export const AppIntegrationCalendarDestinationSchema = z.strictObject({
  kind: z.literal('calendar'), schema_version: z.literal('deft.app_calendar_destination.v1'),
  audience: z.literal('current_user'), event: AppCalendarEventSchema,
});
