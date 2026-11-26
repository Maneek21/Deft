// Meeting notes on a calendar event (plan Task M2). The event detail footer
// offers "Open meeting notes" when the event has a linked document the viewer
// can open (GET /api/calendar gives each event only those), and "Notes for
// this meeting" otherwise, which creates the notes in the viewer's My drive
// (POST /api/calendar/events/:id/document) and opens them. A refusal comes
// back as a message to show, as createDocumentAndOpen's do (quick-actions.ts).
import type { api as ApiClient } from './api';
import { driveWrite } from './drive-actions';

export type LinkedDocument = { id: string; title: string };

type EventWithNotes = { event_type: string; documents?: LinkedDocument[] | null };

export type MeetingNotesAction =
  | { kind: 'open'; label: 'Open meeting notes'; href: string; title: string }
  | { kind: 'create'; label: 'Notes for this meeting' };

export const meetingNotesHref = (documentId: string) => `/d/${encodeURIComponent(documentId)}`;

/** What the footer offers: the first linked notes, else creating them (calendar events only); null for anything else. */
export function meetingNotesAction(event: EventWithNotes): MeetingNotesAction | null {
  const linked = event.documents?.[0];
  if (linked) return { kind: 'open', label: 'Open meeting notes', href: meetingNotesHref(linked.id), title: linked.title };
  return event.event_type === 'calendar_event' ? { kind: 'create', label: 'Notes for this meeting' } : null;
}

export type CreateMeetingNotesOutcome = { ok: true; id: string } | { ok: false; message: string };

const FALLBACK = 'Could not create the meeting notes';

/** Creates the event's meeting notes in the caller's My drive. */
export async function createMeetingNotes(client: Pick<typeof ApiClient, 'post'>, eventId: string): Promise<CreateMeetingNotesOutcome> {
  const created = await driveWrite<{ document?: { id?: string } }>(
    () => client.post(`/api/calendar/events/${encodeURIComponent(eventId)}/document`),
    FALLBACK,
  );
  if (!created.ok) {
    if (created.status === 503) return { ok: false, message: 'The workspace is paused right now. Try again when it resumes.' };
    if (created.status === 403) return { ok: false, message: "You can't create documents in your drive." };
    if (created.status === 404) return { ok: false, message: 'This event is no longer on your calendar.' };
    return { ok: false, message: created.message };
  }
  const id = created.body.document?.id;
  return id ? { ok: true, id } : { ok: false, message: FALLBACK };
}
