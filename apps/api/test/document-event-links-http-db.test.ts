/**
 * Meeting notes linked to calendar events (M2; routes/calendar.ts,
 * lib/meeting-notes.ts, lib/meeting-prep-automation.ts):
 * - POST /api/calendar/events/:eventId/document creates a document from the
 *   meeting_notes template, titled "{event title} — {d MMM yyyy}" in the
 *   workspace's time zone, with the attendees the caller can see under
 *   Attendees, and links it to the event;
 * - GET /api/calendar gives each event the linked documents this viewer can
 *   open;
 * - the meeting-prep briefing cites the last notes linked to an earlier event
 *   of the same title that the recipient can open.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/document-event-links-http-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, mock } from 'node:test';
import { closeDb } from '../src/lib/db.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

// No model configured: the briefing is written from the evidence alone, with no model call.
const actualAiConfig = await import('../src/lib/org-ai-config.js');
mock.module(new URL('../src/lib/org-ai-config.ts', import.meta.url).href, { namedExports: {
  ...actualAiConfig,
  resolveReasonProvider: async () => ({ provider: 'anthropic', model: 'test-model', apiKey: '' }),
} });
const { calendarRoutes } = await import('../src/routes/calendar.js');
const { generateMeetingPrep } = await import('../src/lib/meeting-prep-automation.js');

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let fx: DrivesFixture | undefined;

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('event-links', { routes: [{ path: '/api/calendar', app: calendarRoutes }] });
});

after(async () => {
  try {
    if (fx) {
      for (const table of ['document_event_links', 'meeting_briefs', 'automation_runs', 'events']) {
        await fx.client.query(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [[fx.orgId, fx.otherOrgId]]);
      }
    }
    await fx?.teardown();
  } finally {
    await closeDb();
  }
});

async function call(userId: string, method: string, path: string, body: unknown, status: number): Promise<any> {
  const res = await fx!.request(userId, method, path, body);
  const text = await res.text();
  assert.equal(res.status, status, `${method} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

/** A calendar event of `userId` in the workspace, stored as the app stores it (UTC wall time). */
async function insertEvent(userId: string, title: string, at: Date, metadata: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await fx!.client.query(`INSERT INTO events (id, org_id, user_id, source, event_type, external_id, title, timestamp, metadata)
    VALUES ($1, $2, $3, 'native', 'calendar_event', $1, $4, $5, $6::jsonb)`,
  [id, fx!.orgId, userId, title, at.toISOString().replace('Z', ''), JSON.stringify(metadata)]);
  return id;
}

async function link(eventId: string, documentId: string, createdBy: string): Promise<void> {
  await fx!.client.query(`INSERT INTO document_event_links (id, org_id, document_id, event_id, created_by)
    VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), fx!.orgId, documentId, eventId, createdBy]);
}

async function emailOf(userId: string): Promise<string> {
  return (await fx!.client.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0].email;
}

const paragraph = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

/** The names listed under the Attendees heading, and the headings, of a stored document. */
async function stored(documentId: string) {
  const { rows: [row] } = await fx!.client.query(`SELECT d.title, d.drive_id, d.content_json, d.content_text, d.created_by,
      dr.kind AS drive_kind, dr.owner_user_id
    FROM documents d JOIN drives dr ON dr.id = d.drive_id WHERE d.id = $1`, [documentId]);
  const nodes = row.content_json.content as any[];
  const headings = nodes.filter((n) => n.type === 'heading').map((n) => n.content[0].text);
  const at = nodes.findIndex((n) => n.type === 'heading' && n.content[0].text === 'Attendees');
  const next = nodes[at + 1];
  const attendees = next?.type === 'bulletList'
    ? (next.content as any[]).map((item) => item.content[0].content[0].text)
    : [];
  return { ...row, headings, attendees };
}

test('"Notes for this meeting" creates a meeting-notes document titled after the event and links it', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2, owner, guest, outsider } = fx.people;
  await fx.client.query(`UPDATE orgs SET timezone = 'Asia/Kolkata' WHERE id = $1`, [fx.orgId]);
  // 20:00 UTC on 4 Dec is 01:30 on 5 Dec in Kolkata: the title carries the workspace's date.
  const event = await insertEvent(member, '  Weekly sync ', new Date('2026-12-04T20:00:00Z'), {
    attendees: [
      { email: (await emailOf(member2)).toUpperCase(), displayName: 'Calendar name', responseStatus: 'accepted' },
      { email: 'pat@example.com', displayName: 'Pat External' },
      { email: 'sam@example.com' },
      { email: await emailOf(outsider), displayName: 'Out Sider' },
      { email: 'pat@example.com', displayName: 'Pat again' },
      { displayName: 'No address' },
    ],
  });
  const path = `/api/calendar/events/${event}/document`;

  const { document } = await call(member, 'POST', path, undefined, 201);
  assert.equal(document.title, 'Weekly sync — 5 Dec 2026');
  const mine = await stored(document.id);
  assert.equal(mine.drive_kind, 'personal', 'no drive named: My drive');
  assert.equal(mine.owner_user_id, member);
  assert.equal(mine.created_by, member);
  assert.deepEqual(mine.headings, ['Attendees', 'Agenda', 'Notes', 'Decisions', 'Action items'], 'the meeting_notes template');
  assert.deepEqual(mine.attendees, ['member2', 'Pat External', 'sam@example.com', 'Out Sider'],
    'a workspace person by their name, others as the calendar names them, each address once');
  const { rows: links } = await fx.client.query('SELECT org_id, event_id, created_by FROM document_event_links WHERE document_id = $1', [document.id]);
  assert.deepEqual(links, [{ org_id: fx.orgId, event_id: event, created_by: member }]);

  // A drive the caller names: one they can edit, never one they can only view, and a folder of that drive.
  const inWorkspace = (await call(member, 'POST', path, { drive_id: fx.workspaceDriveId }, 201)).document;
  assert.equal((await stored(inWorkspace.id)).drive_id, fx.workspaceDriveId);
  const viewOnly = await fx.insertDrive({ kind: 'open', defaultRole: 'view' });
  assert.equal((await call(member, 'POST', path, { drive_id: viewOnly }, 403)).code, 'FORBIDDEN_ROLE');
  const otherFolder = await fx.insertFolder({ driveId: viewOnly });
  await call(member, 'POST', path, { drive_id: fx.workspaceDriveId, folder_id: otherFolder }, 400);
  await call(member, 'POST', path, { drive_id: 7 }, 400);
  await call(member, 'POST', path, { title: 'Not a field here' }, 400);

  // Someone who can't see the event gets a 404, and nothing is made.
  const count = async () => (await fx!.client.query('SELECT count(*)::int AS n FROM documents WHERE org_id = $1', [fx!.orgId])).rows[0].n;
  const before = await count();
  assert.equal((await call(member2, 'POST', path, {}, 404)).code, 'NOT_FOUND');
  await call(outsider, 'POST', path, {}, 404);
  await call(member, 'POST', `/api/calendar/events/${randomUUID()}/document`, {}, 404);
  assert.equal(await count(), before);
  const { rows: [{ n: linked }] } = await fx.client.query('SELECT count(*)::int AS n FROM document_event_links WHERE event_id = $1', [event]);
  assert.equal(linked, 2, 'one link per document made');

  // A guest sees only the people they share a chat with: the owner is left out, not listed by address.
  // In Los Angeles, UTC midnight on 7 Dec is still 6 Dec: an all-day event keeps its own date.
  await fx.client.query(`UPDATE orgs SET timezone = 'America/Los_Angeles' WHERE id = $1`, [fx.orgId]);
  const guestDrive = await fx.insertDrive({ kind: 'private' });
  await fx.addDriveMember(guestDrive, { user: guest }, 'edit');
  const ownerEmail = await emailOf(owner);
  const guestEvent = await insertEvent(guest, 'Client call', new Date('2026-12-07T00:00:00Z'), {
    allDay: true,
    attendees: [
      { email: await emailOf(member), displayName: 'M' },
      { email: ownerEmail, displayName: 'The Owner' },
      { email: 'ext@example.com', displayName: 'Ext Person' },
    ],
  });
  const forGuest = (await call(guest, 'POST', `/api/calendar/events/${guestEvent}/document`, { drive_id: guestDrive }, 201)).document;
  assert.equal(forGuest.title, 'Client call — 7 Dec 2026', 'an all-day event keeps its own date');
  const guestNotes = await stored(forGuest.id);
  assert.deepEqual(guestNotes.attendees, ['member', 'Ext Person']);
  assert.doesNotMatch(guestNotes.content_text, /The Owner/);
  assert.ok(!guestNotes.content_text.includes(ownerEmail));
});

test('the event lists only linked documents this viewer can open', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const now = Date.now();
  const meeting = await insertEvent(member, 'Planning', new Date(now + 2 * HOUR));
  const plain = await insertEvent(member, 'No notes', new Date(now + 3 * HOUR));
  const hiddenDrive = await fx.insertDrive({ kind: 'private' });
  await fx.addDriveMember(hiddenDrive, { user: member2 }, 'full');
  const open = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Planning notes' });
  const hidden = await fx.insertDocument({ driveId: hiddenDrive, title: 'Private planning' });
  const deleted = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Old planning', deleted: true });
  for (const documentId of [open, hidden, deleted]) await link(meeting, documentId, member2);

  const range = `from=${new Date(now - DAY).toISOString()}&to=${new Date(now + DAY).toISOString()}`;
  const read = async (userId: string) => {
    const body = await call(userId, 'GET', `/api/calendar?${range}`, undefined, 200);
    return new Map((body.events as any[]).map((event) => [event.id, event.documents]));
  };
  const byTitle = (list: Array<{ title: string }>) => [...list].sort((a, b) => a.title.localeCompare(b.title));

  const first = await read(member);
  assert.deepEqual(first.get(meeting), [{ id: open, title: 'Planning notes' }], 'not the private or the deleted document');
  assert.deepEqual(first.get(plain), [], 'an event with no notes lists none');

  await fx.share(hidden, { user: member }, 'view');
  assert.deepEqual(byTitle((await read(member)).get(meeting)), [{ id: open, title: 'Planning notes' }, { id: hidden, title: 'Private planning' }]);

  // The links' creator could open the private one; the calendar never shows another person's events.
  assert.equal((await read(member2)).has(meeting), false);
});

test("the meeting-prep briefing cites the last linked notes the recipient can open, and not ones they can't", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const now = Date.now();
  const twoWeeksAgo = await insertEvent(member2, 'design review', new Date(now - 14 * DAY));
  const lastWeek = await insertEvent(member2, 'Design Review', new Date(now - 7 * DAY));
  const nextWeek = await insertEvent(member2, 'Design review', new Date(now + 7 * DAY));
  const otherTitle = await insertEvent(member2, 'Design review sync', new Date(now - DAY));
  const meeting = await insertEvent(member, 'Design Review ', new Date(now + 20 * 60_000));

  const longText = `Decided to ship the beta. ${'x'.repeat(2000)} TAIL-MARKER`;
  const visible = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Design review notes (old)', json: paragraph(longText) as any });
  const privateDrive = await fx.insertDrive({ kind: 'private' });
  await fx.addDriveMember(privateDrive, { user: member2 }, 'full');
  const hidden = await fx.insertDocument({ driveId: privateDrive, title: 'Design review notes (private)', json: paragraph('SECRET-PLAN') as any });
  const future = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Future notes', json: paragraph('FUTURE-MARKER') as any });
  const wrongTitle = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Sync notes', json: paragraph('WRONG-TITLE-MARKER') as any });
  // member2 links every one, and can open every one; the recipient can't open the private one.
  await link(twoWeeksAgo, visible, member2);
  await link(lastWeek, hidden, member2);
  await link(nextWeek, future, member2);
  await link(otherTitle, wrongTitle, member2);

  const result = await generateMeetingPrep(meeting) as any;
  assert.deepEqual(result.citations, [{ type: 'document', id: visible, title: 'Design review notes (old)' }]);
  const text: string = result.brief.brief_text;
  assert.ok(text.includes(longText.slice(0, 1500)), 'the first 1,500 characters of the notes');
  assert.ok(!text.includes(longText.slice(0, 1501)));
  assert.doesNotMatch(text, /TAIL-MARKER|SECRET-PLAN|private|FUTURE-MARKER|WRONG-TITLE-MARKER/);
  const { rows: [run] } = await fx.client.query(`SELECT output FROM automation_runs
    WHERE org_id = $1 AND user_id = $2 AND kind = 'meeting_prep' AND subject_id = $3`, [fx.orgId, member, meeting]);
  assert.deepEqual(run.output.citations, [{ type: 'document', id: visible, title: 'Design review notes (old)' }]);
  assert.doesNotMatch(JSON.stringify(run.output), /Decided to ship|SECRET-PLAN/, 'the run details carry a reference, not the text');

  // Once the recipient can open the newer notes, the next briefing cites them.
  await fx.share(hidden, { user: member }, 'view');
  const next = await insertEvent(member, 'design review', new Date(now + 25 * 60_000));
  const second = await generateMeetingPrep(next) as any;
  assert.deepEqual(second.citations, [{ type: 'document', id: hidden, title: 'Design review notes (private)' }]);
  assert.match(second.brief.brief_text, /SECRET-PLAN/);
});
