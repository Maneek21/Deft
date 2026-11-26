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

// By default no model is configured: the briefing is written from the evidence alone, with no model call.
// A test sets `modelReply` to script the model's answer, and `duringSynthesis` to act while the briefing is written.
let modelReply: string | null = null;
let duringSynthesis: (() => Promise<void>) | null = null;
const actualAiConfig = await import('../src/lib/org-ai-config.js');
mock.module(new URL('../src/lib/org-ai-config.ts', import.meta.url).href, { namedExports: {
  ...actualAiConfig,
  resolveReasonProvider: async () => {
    if (duringSynthesis) await duringSynthesis();
    return { provider: 'anthropic', model: 'test-model', apiKey: modelReply === null ? '' : 'test-key' };
  },
} });
const actualRunner = await import('../src/lib/agent-runner.js');
mock.module(new URL('../src/lib/agent-runner.ts', import.meta.url).href, { namedExports: {
  ...actualRunner,
  runAgentQuery: async () => ({ text: modelReply ?? '', model: 'test-model' }),
} });
const { calendarRoutes } = await import('../src/routes/calendar.js');
const { documentRoutes } = await import('../src/routes/documents.js');
const { notificationRoutes } = await import('../src/routes/notifications.js');
const { generateMeetingPrep } = await import('../src/lib/meeting-prep-automation.js');
const { canSeePerson, peopleViewer, visiblePersonIds } = await import('../src/lib/people-visibility.js');

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let fx: DrivesFixture | undefined;

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('event-links', { routes: [
    { path: '/api/calendar', app: calendarRoutes },
    { path: '/api/documents', app: documentRoutes },
    { path: '/api/notifications', app: notificationRoutes },
  ] });
});

/** Runs `body` with a scripted model answer and/or an action during synthesis, then restores the defaults. */
async function withModel<T>(reply: string | null, during: (() => Promise<void>) | null, body: () => Promise<T>): Promise<T> {
  modelReply = reply;
  duringSynthesis = during;
  try {
    return await body();
  } finally {
    modelReply = null;
    duringSynthesis = null;
  }
}

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

// ── Fix round 1 ──

test('a long event title is kept whole while the title fits 500 characters, and cut with … past it', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  await fx.client.query(`UPDATE orgs SET timezone = 'UTC' WHERE id = $1`, [fx.orgId]);
  const whole = 'W'.repeat(469) + 'Z';
  const fits = await insertEvent(member, whole, new Date('2026-12-14T10:00:00Z'));
  const kept = (await call(member, 'POST', `/api/calendar/events/${fits}/document`, {}, 201)).document;
  assert.equal(kept.title, `${whole} — 14 Dec 2026`, 'a 470-character title is kept whole');
  assert.ok(kept.title.length <= 500);
  const long = 'L'.repeat(600);
  const over = await insertEvent(member, long, new Date('2026-12-14T10:00:00Z'));
  const cut = (await call(member, 'POST', `/api/calendar/events/${over}/document`, {}, 201)).document;
  assert.equal(cut.title.length, 500, 'the title fits the 500-character limit exactly');
  assert.ok(cut.title.endsWith('… — 14 Dec 2026'));
  assert.equal(cut.title, `${'L'.repeat(500 - ' — 14 Dec 2026'.length - 1)}… — 14 Dec 2026`);
  // The cut title can be saved again unchanged (PATCH refuses more than 500 characters).
  await call(member, 'PATCH', `/api/documents/${cut.id}`, { title: cut.title }, 200);
});

test('an attendee address that matches a workspace person in any letter case is theirs: shown by name, or left out, never as an outside attendee', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { guest, member } = fx.people;
  // Not in any chat with the guest: hidden from them by people-visibility.
  const hidden = await fx.addPerson({ role: 'member' });
  await fx.client.query(`UPDATE users SET email = upper(email), name = 'SECRET-HIDDEN-ATTENDEE' WHERE id = $1`, [hidden]);
  const former = await fx.addPerson({ role: 'member', active: false });
  await fx.client.query(`UPDATE users SET name = 'FORMER-MEMBER' WHERE id = $1`, [former]);
  const guestView = await peopleViewer(fx.orgId, guest);
  assert.equal(canSeePerson(await visiblePersonIds(guestView), hidden), false, 'people-visibility hides them from the guest');
  // The member shares a chat with the guest; their stored address is upper case too.
  await fx.client.query(`UPDATE users SET email = upper(email) WHERE id = $1`, [member]);
  try {
    const guestDrive = await fx.insertDrive({ kind: 'private' });
    await fx.addDriveMember(guestDrive, { user: guest }, 'edit');
    const event = await insertEvent(guest, 'Case check', new Date('2026-12-15T10:00:00Z'), {
      attendees: [
        { email: (await emailOf(hidden)).toLowerCase(), displayName: 'SECRET-HIDDEN-ATTENDEE' },
        { email: (await emailOf(member)).toLowerCase(), displayName: 'Calendar name' },
        { email: (await emailOf(former)).toLowerCase(), displayName: 'FORMER-MEMBER' },
        { email: 'outside@example.com', displayName: 'Outside Person' },
      ],
    });
    const created = (await call(guest, 'POST', `/api/calendar/events/${event}/document`, { drive_id: guestDrive }, 201)).document;
    const notes = await stored(created.id);
    assert.deepEqual(notes.attendees, ['member', 'Outside Person'],
      'the visible member by name; the hidden person and the former member left out; only the outside address as given');
    assert.doesNotMatch(JSON.stringify(notes.content_json), /SECRET-HIDDEN-ATTENDEE|FORMER-MEMBER/);
  } finally {
    await fx.client.query(`UPDATE users SET email = lower(email) WHERE id = $1`, [member]);
  }
});

/** Notes in a private drive that member2 manages, linked to an earlier "title" meeting, and the recipient's next one. */
async function notesForNextMeeting(title: string, notesTitle: string, text: string, minutesAhead: number) {
  const { member, member2 } = fx!.people;
  const now = Date.now();
  const drive = await fx!.insertDrive({ kind: 'private' });
  await fx!.addDriveMember(drive, { user: member2 }, 'full');
  const notes = await fx!.insertDocument({ driveId: drive, title: notesTitle, json: paragraph(text) as any });
  const earlier = await insertEvent(member2, title, new Date(now - 7 * DAY));
  await link(earlier, notes, member2);
  const meeting = await insertEvent(member, title, new Date(now + minutesAhead * 60_000));
  return { notes, meeting };
}

async function briefingNotification(meeting: string) {
  const { rows } = await fx!.client.query(`SELECT body, metadata FROM notifications
    WHERE org_id = $1 AND user_id = $2 AND metadata->>'event_id' = $3`, [fx!.orgId, fx!.people.member, meeting]);
  assert.equal(rows.length, 1);
  return rows[0] as { body: string; metadata: Record<string, unknown> };
}

async function storedRun(meeting: string) {
  const { rows: [run] } = await fx!.client.query(`SELECT output FROM automation_runs
    WHERE org_id = $1 AND user_id = $2 AND kind = 'meeting_prep' AND subject_id = $3`, [fx!.orgId, fx!.people.member, meeting]);
  return run.output as Record<string, any>;
}

test('a briefing that cites notes is hidden once the recipient loses them: the notifications list, the unread count and the saved brief', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const { notes, meeting } = await notesForNextMeeting('Board sync', 'Board sync notes', 'REVOKE-EXCERPT next steps for the board', 30);
  const { share } = await call(member2, 'POST', `/api/documents/${notes}/shares`, { principal_type: 'user', principal_id: member, role: 'view' }, 201);

  const result = await generateMeetingPrep(meeting) as any;
  assert.deepEqual(result.citations, [{ type: 'document', id: notes, title: 'Board sync notes' }]);
  const delivered = await briefingNotification(meeting);
  assert.equal(delivered.metadata.document_id, notes, 'the notification names the cited document');
  assert.match(delivered.body, /REVOKE-EXCERPT/);

  const inbox = async () => call(member, 'GET', '/api/notifications', undefined, 200);
  const briefs = async () => (await call(member, 'GET', `/api/calendar/briefs?event_ids=${meeting}`, undefined, 200)).briefs as any[];
  const before = await inbox();
  assert.ok(before.notifications.some((n: any) => n.metadata?.event_id === meeting), 'listed while the recipient can open the notes');
  const namingNotes = before.notifications.filter((n: any) => n.metadata?.document_id === notes && !n.is_read).length;
  assert.ok(namingNotes >= 1);
  assert.equal((await briefs()).length, 1);
  assert.match(JSON.stringify(await briefs()), /REVOKE-EXCERPT/);

  // The share is removed the way the product removes it; the recipient can no longer open the notes.
  await call(member2, 'DELETE', `/api/documents/${notes}/shares/${share.id}`, undefined, 200);
  await call(member, 'GET', `/api/documents/${notes}`, undefined, 404);

  const after = await inbox();
  assert.ok(!after.notifications.some((n: any) => n.metadata?.event_id === meeting), 'not listed');
  assert.equal(after.unread_count, before.unread_count - namingNotes, 'not counted');
  const saved = await briefs();
  assert.deepEqual(saved, [], 'the saved brief is hidden');
  assert.doesNotMatch(JSON.stringify(saved), /REVOKE-EXCERPT|Board sync notes/);
});

test('notes the recipient loses while the briefing is written are left out of it: no excerpt, citation or item that cites them', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const { notes, meeting } = await notesForNextMeeting('Retro', 'Retro notes', 'DELAYED-EXCERPT from the last retro', 35);
  await fx.share(notes, { user: member }, 'view');
  const reply = JSON.stringify({
    agenda: [
      { text: 'Delayed echo of the old notes', source_ids: [`document:${notes}`] },
      { text: 'Plan the retro', source_ids: [`event:${meeting}`] },
    ],
    decisions: [],
    updates: [],
  });
  const revoke = async () => {
    await fx!.client.query(`DELETE FROM document_shares WHERE document_id = $1 AND principal_type = 'user' AND principal_id = $2`, [notes, member]);
  };
  const result = await withModel(reply, revoke, () => generateMeetingPrep(meeting)) as any;

  assert.deepEqual(result.citations, []);
  const text: string = result.brief.brief_text;
  assert.match(text, /Plan the retro/, 'the rest of the briefing is delivered');
  assert.doesNotMatch(text, /DELAYED-EXCERPT|Retro notes|Delayed echo/);
  const delivered = await briefingNotification(meeting);
  assert.equal(delivered.metadata.document_id, undefined);
  assert.deepEqual(delivered.metadata.citations, []);
  assert.doesNotMatch(delivered.body, /DELAYED-EXCERPT|Delayed echo/);
  const output = await storedRun(meeting);
  assert.deepEqual(output.citations, []);
  assert.doesNotMatch(JSON.stringify(output), /DELAYED-EXCERPT|Delayed echo/);
});

test('the stored run details keep no text from the notes when the model quotes them', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const { notes, meeting } = await notesForNextMeeting('Quarterly plan', 'Quarterly plan notes', 'Quoted zebra marker kept for the record', 40);
  await fx.share(notes, { user: member }, 'view');
  const reply = JSON.stringify({
    agenda: [
      { text: 'Quoted zebra marker kept for the record', source_ids: [`document:${notes}`] },
      { text: 'Review the plan together', source_ids: [`event:${meeting}`] },
    ],
    decisions: [],
    updates: [],
  });
  const result = await withModel(reply, null, () => generateMeetingPrep(meeting)) as any;

  assert.equal(result.run.generator, 'agent');
  assert.match(result.brief.brief_text, /Quoted zebra marker/, 'the recipient, who can open the notes, reads the quote');
  const output = await storedRun(meeting);
  assert.doesNotMatch(JSON.stringify(output), /zebra/i, 'not in the stored run details');
  assert.deepEqual(output.draft.agenda, [
    { document_id: notes, content_omitted: true },
    { text: 'Review the plan together', source_ids: [`event:${meeting}`] },
  ]);
  assert.deepEqual(output.citations, [{ type: 'document', id: notes, title: 'Quarterly plan notes' }]);
});
