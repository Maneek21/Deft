import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, between, desc, inArray, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { tasks, events, projects, meetingBriefs, reminders, automationRuns, orgMembers } from '@deft/db/schema';
import { documents } from '@deft/db/documents';
import { visibleDocumentCondition } from '../lib/document-access.js';
import { getOrgTimezone, getDayBoundaries } from '../lib/task-dates.js';
import {readEmailCalendarOccurrences} from '../lib/email-calendar-projection.js';
import { DocumentRefusal } from '../lib/documents.js';
import { briefCitationsVisibleSql, createMeetingNotes, linkedDocumentsByEvent } from '../lib/meeting-notes.js';
import { jsonBody, noBodyOrJson } from '../lib/request-body.js';
import { liveHumanCalendarEventCondition } from '../lib/calendar-event-visibility.js';

export const calendarRoutes = new Hono();

// GET /?from=ISO&to=ISO — unified calendar data for a date range
calendarRoutes.get('/', async (c) => {
  const user = c.get('user');
  const fromStr = c.req.query('from');
  const toStr = c.req.query('to');

  if (!fromStr || !toStr) {
    return c.json({ error: 'from and to query params required', code: 'MISSING_PARAMS' }, 400);
  }

  const fromRaw = new Date(fromStr);
  const toRaw = new Date(toStr);

  if (isNaN(fromRaw.getTime()) || isNaN(toRaw.getTime())) {
    return c.json({ error: 'Invalid date format', code: 'INVALID_DATE' }, 400);
  }

  // Max range: 45 days (6 weeks + padding)
  const diffDays = (toRaw.getTime() - fromRaw.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays > 45 || diffDays < 0) {
    return c.json({ error: 'Date range must be 0-45 days', code: 'RANGE_TOO_LARGE' }, 400);
  }

  // Reinterpret `from`/`to` as org-local calendar-day boundaries. A client
  // asking for "from 2025-07-15" expects "start of Jul 15 in the org's tz",
  // not a UTC midnight instant — otherwise a Los_Angeles user would miss
  // tasks due at 02:00 UTC on Jul 15 (which is still Jul 14 locally).
  const orgTz = await getOrgTimezone(user.org_id);
  const fromWC = new Date(fromRaw.getTime());
  const toWC = new Date(toRaw.getTime());
  const { start: from } = getDayBoundaries(orgTz, 0, fromWC);
  const { end: to } = getDayBoundaries(orgTz, 0, toWC);

  // Run three queries in parallel
  const [taskRows, eventRows, documentRows, reminderRows, invitationOccurrences] = await Promise.all([
    // Tasks assigned to this user with due dates in range
    db.select({
      id: tasks.id,
      number: tasks.number,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      due_date: tasks.due_date,
      project_prefix: projects.prefix,
      project_color: projects.color,
    }).from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(and(
        eq(tasks.org_id, user.org_id),
        eq(tasks.assignee_id, user.id),
        eq(tasks.is_deleted, false),
        between(tasks.due_date, from, to),
      ))
      .orderBy(tasks.due_date),

    // Events for this user in range
    db.select({
      id: events.id,
      title: events.title,
      body: events.body,
      event_type: events.event_type,
      url: events.url,
      timestamp: events.timestamp,
      metadata: events.metadata,
      source: events.source,
      // An attendee sees someone else's event read-only (calendar-event-visibility.ts).
      viewer_is_owner: sql<boolean>`${events.user_id} = ${user.id}`,
    }).from(events)
      .where(and(
        liveHumanCalendarEventCondition(user.org_id, user.id),
        between(events.timestamp, from, to),
        sql`${events.metadata}->'email_invitation'->>'schema_version' IS DISTINCT FROM 'deft.email_calendar_event.v1'`,
      ))
      .orderBy(events.timestamp),

    // Documents this user created in range, that they can still open (the
    // notes of the day before the notes move, F15).
    db.select({
      id: documents.id,
      title: documents.title,
      icon: documents.icon,
      created_at: documents.created_at,
    }).from(documents)
      .where(and(
        eq(documents.org_id, user.org_id),
        eq(documents.created_by, user.id),
        between(documents.created_at, from, to),
        visibleDocumentCondition(user.id, user.org_id),
      ))
      .orderBy(desc(documents.created_at))
      .limit(200),

    // Reminders for this user in range
    db.select({
      id: reminders.id,
      message: reminders.message,
      remind_at: reminders.remind_at,
      is_sent: reminders.is_sent,
    }).from(reminders)
      .where(and(
        eq(reminders.user_id, user.id),
        eq(reminders.is_sent, false),
        between(reminders.remind_at, from, to),
      ))
      .orderBy(reminders.remind_at),
    readEmailCalendarOccurrences(db,{org_id:user.org_id,owner_user_id:user.id,from,to}),
  ]);
  const calendarEvents = [...eventRows,...invitationOccurrences].sort((a,b)=>a.timestamp.getTime()-b.timestamp.getTime());
  // Each event's meeting notes this viewer can open (M2), in one query.
  const linkedDocuments = await linkedDocumentsByEvent(user.id, user.org_id, calendarEvents.map((event) => event.id));

  return c.json({
    tasks: taskRows,
    events: calendarEvents.map((event) => ({ ...event, documents: linkedDocuments.get(event.id) ?? [] })),
    documents: documentRows.map((row) => ({ ...row, url: `/d/${row.id}` })),
    // Empty, for clients that still read the old key until the web reads documents (F16).
    notes: [],
    reminders: reminderRows,
  });
});

const meetingNotesSchema = z.object({
  drive_id: z.string().trim().min(1).max(200).optional(),
  folder_id: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();

// POST /events/:eventId/document { drive_id?, folder_id? } — "Notes for this
// meeting" (M2): a document from the meeting notes template, linked to the
// event. The caller must see the event and have edit on the drive (by
// default their My drive); see lib/meeting-notes.ts.
calendarRoutes.post('/events/:eventId/document', async (c) => {
  const user = c.get('user');
  const eventId = c.req.param('eventId');
  if (!(await noBodyOrJson(c))) return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  const parsed = meetingNotesSchema.safeParse((await jsonBody(c)) ?? {});
  if (!parsed.success) return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  if (eventId.length > 200) return c.json({ error: 'Event not found', code: 'NOT_FOUND' }, 404);
  try {
    const { document, finish } = await createMeetingNotes({
      orgId: user.org_id, userId: user.id, eventId, driveId: parsed.data.drive_id, folderId: parsed.data.folder_id,
    });
    await finish();
    return c.json({ document }, 201);
  } catch (error) {
    if (error instanceof DocumentRefusal) return c.json({ error: error.message, code: error.code }, error.status);
    console.error('[calendar] creating meeting notes failed');
    return c.json({ error: 'Failed to create the meeting notes', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /briefs?event_ids=id1,id2 — meeting prep briefs for specific events
calendarRoutes.get('/briefs', async (c) => {
  const user = c.get('user');
  const idsParam = c.req.query('event_ids');

  if (!idsParam) {
    return c.json({ briefs: [] });
  }

  const eventIds = idsParam.split(',').filter(Boolean).slice(0, 50);
  if (eventIds.length === 0) {
    return c.json({ briefs: [] });
  }

  const rows = await db.select({
    id: meetingBriefs.id,
    event_id: meetingBriefs.event_id,
    brief_text: meetingBriefs.brief_text,
    created_at: meetingBriefs.created_at,
    generator: sql<string | null>`(
      SELECT ${automationRuns.generator} FROM ${automationRuns}
      WHERE ${automationRuns.result_entity_id} = ${meetingBriefs.id}
        AND ${automationRuns.org_id} = ${meetingBriefs.org_id}
      ORDER BY ${automationRuns.updated_at} DESC LIMIT 1
    )`,
  }).from(meetingBriefs)
    .innerJoin(events, and(eq(events.id, meetingBriefs.event_id), eq(events.org_id, user.org_id)))
    .innerJoin(orgMembers, and(
      eq(orgMembers.org_id, user.org_id),
      eq(orgMembers.user_id, user.id),
      eq(orgMembers.is_active, true),
    ))
    .where(and(
      eq(meetingBriefs.org_id, user.org_id),
      eq(meetingBriefs.user_id, user.id),
      inArray(meetingBriefs.event_id, eventIds),
      // A brief that carries an excerpt of meeting notes is hidden once this reader can't open them (M2).
      briefCitationsVisibleSql(user.id, user.org_id),
    ))
    .orderBy(desc(meetingBriefs.created_at))
    .limit(50);

  return c.json({ briefs: rows });
});
