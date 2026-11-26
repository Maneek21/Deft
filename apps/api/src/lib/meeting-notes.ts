// Meeting notes linked to calendar events (spec 5.5; plan Task M2).
//
// - "Notes for this meeting" (POST /api/calendar/events/:eventId/document)
//   creates a document from the built-in meeting_notes template and links it
//   to the event (document_event_links, upgrade 0.3.0-preview.156). The
//   caller must see the event (liveHumanCalendarEventCondition, the calendar's
//   own check) and needs edit on the drive, by default their My drive. The
//   document is created by createDocumentInTx, so the template content is
//   stored by the one create path (rule C2).
// - The title is "{event title} — {d MMM yyyy}": the event's own start date
//   in the workspace's time zone (orgs.timezone), and an all-day event's date
//   as it is stored (UTC midnight).
// - Under Attendees go the names of the attendees the caller can see (rule
//   C4, people-visibility): a workspace person is listed only when the
//   caller's people view shows them; someone hidden is left out, never shown
//   by their email instead. An attendee who is not an active person of the
//   workspace is listed by the name the calendar gives, else their address,
//   as the caller's own event shows them.
// - The calendar shows each event's linked documents that the viewer can open
//   (visibleDocumentCondition), in one IN (...) query.
// - The meeting-prep briefing cites the most recent document linked to an
//   earlier event of the workspace with the same title (case-insensitive)
//   that the briefing's recipient can open (visibleDocumentIdSql for the
//   recipient, never the link's creator), with up to 1,500 characters of its
//   current content.
import { and, asc, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { events, orgMembers, users } from '@deft/db/schema';
import { documentEventLinks, documents } from '@deft/db/documents';
import { jsonToText } from '@deft/doc-schema';
import { db } from './db.js';
import { liveHumanCalendarEventCondition } from './calendar-event-visibility.js';
import { visibleDocumentCondition, visibleDocumentIdSql } from './document-access.js';
import {
  createDocumentInTx, DocumentRefusal, linkTemplateFilesInTx, templateContentInTx, viewerDocumentInTx, type ViewerDocument,
} from './documents.js';
import { peopleViewer, personVisibleSql, type PeopleViewer } from './people-visibility.js';
import { getOrgTimezone } from './task-dates.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, 'select'>;
type JSONContent = Parameters<typeof jsonToText>[0];

/** How much of the last notes' text a meeting-prep briefing carries. */
export const MEETING_NOTES_EXCERPT_CHARS = 1500;
/** At most this many attendees are listed. */
const MAX_ATTENDEES = 100;
const MAX_NAME_CHARS = 200;
/** Leaves room for the date within the 500-character title limit. */
const MAX_TITLE_CHARS = 450;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const eventNotFound = () => new DocumentRefusal(404, 'NOT_FOUND', 'Event not found');

/** "{event title} — {d MMM yyyy}", dated in `timeZone`; an all-day event keeps its stored (UTC) date. */
export function meetingNotesTitle(eventTitle: string | null, start: Date, timeZone: string, allDay = false): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: allDay ? 'UTC' : timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(start);
  const part = (type: 'day' | 'month' | 'year') => Number(parts.find((p) => p.type === type)?.value);
  const name = (eventTitle ?? '').trim().slice(0, MAX_TITLE_CHARS) || 'Meeting';
  return `${name} — ${part('day')} ${MONTHS[part('month') - 1]} ${part('year')}`;
}

type Attendee = { email: string; name: string | null };

/** The event's attendees as the calendar stores them (metadata.attendees), each address once. */
export function eventAttendees(metadata: unknown): Attendee[] {
  const list = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).attendees : null;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: Attendee[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const given = [raw.displayName, raw.name].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    out.push({ email, name: given?.trim() ?? null });
    if (out.length === MAX_ATTENDEES) break;
  }
  return out;
}

/**
 * The names to list under Attendees for `viewer`, in the event's order. A
 * workspace person (an active member whose address matches) is listed by
 * their name only when the viewer may see them; a hidden one is left out.
 * Anyone else is listed as the calendar names them.
 */
export async function visibleAttendeeNames(reader: Reader, viewer: PeopleViewer, attendees: Attendee[]): Promise<string[]> {
  if (attendees.length === 0) return [];
  const people = await reader.select({
    email: users.email,
    name: users.name,
    visible: sql<boolean>`${personVisibleSql(viewer, users.id)}`,
  }).from(users)
    .innerJoin(orgMembers, and(eq(orgMembers.user_id, users.id), eq(orgMembers.org_id, viewer.orgId), eq(orgMembers.is_active, true)))
    .where(inArray(users.email, attendees.map((attendee) => attendee.email)));
  const byEmail = new Map(people.map((person) => [(person.email ?? '').trim().toLowerCase(), person]));
  const names: string[] = [];
  for (const attendee of attendees) {
    const person = byEmail.get(attendee.email);
    const name = person ? (person.visible === true ? (person.name.trim() || attendee.name) : null) : (attendee.name ?? attendee.email);
    if (name) names.push(name.slice(0, MAX_NAME_CHARS));
  }
  return names;
}

/** The template's content with `names` as a bulleted list under its Attendees heading. */
export function withAttendees(json: JSONContent, names: string[]): JSONContent {
  if (names.length === 0) return json;
  const content = [...(json.content ?? [])];
  const at = content.findIndex((node) => node.type === 'heading' && node.content?.[0]?.text === 'Attendees');
  const list: JSONContent = {
    type: 'bulletList',
    content: names.map((name) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: name }] }] })),
  };
  content.splice(at + 1, 0, list);
  return { ...json, content };
}

export type CreateMeetingNotesInput = { orgId: string; userId: string; eventId: string; driveId?: string; folderId?: string | null };

/**
 * "Notes for this meeting": the document (as the caller sees it) and the
 * post-commit step, which the caller runs after this returns. An event the
 * caller can't see, or that is deleted meanwhile, is a 404; the drive and
 * folder are refused as createDocumentInTx refuses them.
 */
export async function createMeetingNotes(input: CreateMeetingNotesInput): Promise<{ document: ViewerDocument; finish: () => Promise<void> }> {
  const { orgId, userId } = input;
  const timeZone = await getOrgTimezone(orgId);
  return db.transaction(async (tx) => {
    const [event] = await tx.select({ id: events.id, title: events.title, timestamp: events.timestamp, metadata: events.metadata })
      .from(events)
      .where(and(eq(events.id, input.eventId), liveHumanCalendarEventCondition(orgId, userId)))
      .limit(1);
    if (!event) throw eventNotFound();
    const allDay = (event.metadata as Record<string, unknown> | null)?.allDay === true;
    const names = await visibleAttendeeNames(tx, await peopleViewer(orgId, userId, tx), eventAttendees(event.metadata));
    const template = await templateContentInTx(tx, userId, orgId, { builtin: 'meeting_notes' });
    const { document, finish } = await createDocumentInTx(tx, {
      orgId, userId, driveId: input.driveId, folderId: input.folderId,
      title: meetingNotesTitle(event.title, event.timestamp, timeZone, allDay),
      json: withAttendees(template.json, names),
    });
    await linkTemplateFilesInTx(tx, orgId, userId, document.id, template.linkFileIds);
    // The event's key is checked here, after the drive locks: an event deleted since it was read is a 404.
    await linkInTx(tx, { orgId, userId, documentId: document.id, eventId: event.id });
    return { document: await viewerDocumentInTx(tx, userId, orgId, document.id), finish };
  });
}

/** Inserts the link; a refused event key (the event was deleted meanwhile) is a 404 and rolls the create back. */
async function linkInTx(tx: Tx, link: { orgId: string; userId: string; documentId: string; eventId: string }): Promise<void> {
  try {
    await tx.insert(documentEventLinks).values({
      org_id: link.orgId, document_id: link.documentId, event_id: link.eventId, created_by: link.userId,
    });
  } catch (error) {
    if (pgCode(error) === '23503') throw eventNotFound();
    throw error;
  }
}

/** A PostgreSQL error code, through drizzle's wrapper. */
function pgCode(error: unknown): string | undefined {
  const own = (error as { code?: unknown } | null)?.code;
  if (typeof own === 'string') return own;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === 'string' ? cause : undefined;
}

export type LinkedDocument = { id: string; title: string };

/** The documents linked to `eventIds` that `userId` can open. Exported for its planning test (`.toSQL()`). */
export function linkedDocumentsQuery(userId: string, orgId: string, eventIds: string[], reader: Reader = db) {
  return reader.select({ event_id: documentEventLinks.event_id, id: documents.id, title: documents.title })
    .from(documentEventLinks)
    .innerJoin(documents, and(eq(documents.org_id, documentEventLinks.org_id), eq(documents.id, documentEventLinks.document_id)))
    .where(and(
      eq(documentEventLinks.org_id, orgId),
      inArray(documentEventLinks.event_id, eventIds),
      visibleDocumentCondition(userId, orgId),
    ))
    .orderBy(asc(documentEventLinks.created_at), asc(documents.id));
}

/** GET /api/calendar: each event's linked documents that the viewer can open, oldest link first. */
export async function linkedDocumentsByEvent(userId: string, orgId: string, eventIds: readonly string[]): Promise<Map<string, LinkedDocument[]>> {
  const ids = [...new Set(eventIds)];
  const byEvent = new Map<string, LinkedDocument[]>();
  if (ids.length === 0) return byEvent;
  for (const row of await linkedDocumentsQuery(userId, orgId, ids)) {
    const list = byEvent.get(row.event_id) ?? [];
    list.push({ id: row.id, title: row.title });
    byEvent.set(row.event_id, list);
  }
  return byEvent;
}

export type MeetingForNotes = { id: string; org_id: string; title: string | null; timestamp: Date };

/**
 * The most recent document linked to an earlier event of the meeting's
 * workspace with the same title (case-insensitive) that `recipientId` can
 * open. Exported for its planning test (`.toSQL()`).
 */
export function previousMeetingNotesQuery(meeting: MeetingForNotes, title: string, recipientId: string, reader: Reader = db) {
  return reader.select({ id: documents.id, title: documents.title, content_json: documents.content_json })
    .from(documentEventLinks)
    .innerJoin(events, and(eq(events.id, documentEventLinks.event_id), eq(events.org_id, documentEventLinks.org_id)))
    .innerJoin(documents, and(eq(documents.org_id, documentEventLinks.org_id), eq(documents.id, documentEventLinks.document_id)))
    .where(and(
      eq(documentEventLinks.org_id, meeting.org_id),
      ne(events.id, meeting.id),
      lt(events.timestamp, meeting.timestamp),
      sql`lower(btrim(${events.title})) = lower(${title})`,
      visibleDocumentIdSql(recipientId, meeting.org_id, sql`${documentEventLinks.document_id}`),
    ))
    .orderBy(desc(events.timestamp), desc(documentEventLinks.created_at), desc(documents.id))
    .limit(1);
}

export type PreviousMeetingNotes = { id: string; title: string; excerpt: string };

/** previousMeetingNotesQuery's document, with up to MEETING_NOTES_EXCERPT_CHARS of its current text; null when there is none. */
export async function previousMeetingNotes(meeting: MeetingForNotes, recipientId: string, reader: Reader = db): Promise<PreviousMeetingNotes | null> {
  const title = meeting.title?.trim();
  if (!title) return null;
  const [row] = await previousMeetingNotesQuery(meeting, title, recipientId, reader);
  if (!row) return null;
  return { id: row.id, title: row.title, excerpt: excerptOf(jsonToText(row.content_json as JSONContent)) };
}

/** The first MEETING_NOTES_EXCERPT_CHARS characters, never ending inside a surrogate pair. */
function excerptOf(text: string): string {
  if (text.length <= MEETING_NOTES_EXCERPT_CHARS) return text;
  const cut = text.slice(0, MEETING_NOTES_EXCERPT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
