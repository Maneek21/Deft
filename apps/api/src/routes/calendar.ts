import { Hono } from 'hono';
import { eq, and, between, desc, inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { tasks, events, notes, projects, meetingBriefs, reminders } from '@deft/db/schema';
import { getOrgTimezone, getDayBoundaries } from '../lib/task-dates.js';

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
  const [taskRows, eventRows, noteRows, reminderRows] = await Promise.all([
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
    }).from(events)
      .where(and(
        eq(events.org_id, user.org_id),
        eq(events.user_id, user.id),
        between(events.timestamp, from, to),
      ))
      .orderBy(events.timestamp),

    // Notes created by this user in range
    db.select({
      id: notes.id,
      title: notes.title,
      icon: notes.icon,
      created_at: notes.created_at,
    }).from(notes)
      .where(and(
        eq(notes.org_id, user.org_id),
        eq(notes.user_id, user.id),
        eq(notes.is_deleted, false),
        between(notes.created_at, from, to),
      ))
      .orderBy(desc(notes.created_at)),

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
  ]);

  return c.json({
    tasks: taskRows,
    events: eventRows,
    notes: noteRows,
    reminders: reminderRows,
  });
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
  }).from(meetingBriefs)
    .where(and(
      eq(meetingBriefs.user_id, user.id),
      inArray(meetingBriefs.event_id, eventIds),
    ))
    .orderBy(desc(meetingBriefs.created_at))
    .limit(50);

  return c.json({ briefs: rows });
});
