import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingNotes, meetingNotesAction } from './meeting-notes';

// The event detail footer (plan Task M2): "Open meeting notes" when the event
// has notes the viewer can open, "Notes for this meeting" otherwise.

test('the footer opens the first linked notes, or offers to create them on a calendar event', () => {
  assert.deepEqual(meetingNotesAction({ event_type: 'calendar_event', documents: [{ id: 'd 1', title: 'Sync — 4 Dec 2026' }, { id: 'd2', title: 'Other' }] }),
    { kind: 'open', label: 'Open meeting notes', href: '/d/d%201', title: 'Sync — 4 Dec 2026' });
  assert.deepEqual(meetingNotesAction({ event_type: 'calendar_event', documents: [] }), { kind: 'create', label: 'Notes for this meeting' });
  assert.deepEqual(meetingNotesAction({ event_type: 'calendar_event' }), { kind: 'create', label: 'Notes for this meeting' },
    'an older API without documents');
  assert.equal(meetingNotesAction({ event_type: 'pr_merged', documents: [] }), null, 'not a meeting');
});

const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('creating the notes posts to the event and answers the new id, or a message for a refusal', async () => {
  const paths: string[] = [];
  const client = (answer: () => Promise<Response>) => ({ post: async (path: string) => { paths.push(path); return answer(); } }) as any;

  assert.deepEqual(await createMeetingNotes(client(respond(201, { document: { id: 'doc-1' } })), 'ev/1'), { ok: true, id: 'doc-1' });
  assert.deepEqual(paths, ['/api/calendar/events/ev%2F1/document']);
  assert.deepEqual(await createMeetingNotes(client(respond(404, { error: 'Event not found', code: 'NOT_FOUND' })), 'e'),
    { ok: false, message: 'This event is no longer on your calendar.' });
  assert.deepEqual(await createMeetingNotes(client(respond(403, { error: 'x', code: 'FORBIDDEN_ROLE' })), 'e'),
    { ok: false, message: "You can't create documents in your drive." });
  assert.deepEqual(await createMeetingNotes(client(respond(503, {})), 'e'),
    { ok: false, message: 'The workspace is paused right now. Try again when it resumes.' });
  assert.deepEqual(await createMeetingNotes(client(respond(413, { error: 'The document is too large', code: 'TOO_LARGE' })), 'e'),
    { ok: false, message: 'The document is too large' });
  assert.deepEqual(await createMeetingNotes(client(respond(201, {})), 'e'), { ok: false, message: 'Could not create the meeting notes' });
  assert.deepEqual(await createMeetingNotes(client(async () => { throw new Error('offline'); }), 'e'),
    { ok: false, message: 'Could not reach the server. Check your connection and try again.' });
});
