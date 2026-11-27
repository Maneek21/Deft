// A native Deft calendar event lists its attendees by email. It shows, read
// only, on the calendar of each attendee who is an active owner, admin or
// member of the event's workspace, and nowhere else: not to a member who is
// not an attendee, not to a guest (attendee or not), not to a deactivated
// attendee, not to an attendee's session in another workspace, and not for an
// imported event: neither one from another calendar nor an invitation accepted
// from email or an app, which is stored as a native event too. Every calendar
// read is checked: the calendar list, the dashboard, the published ICS feed,
// the human MCP tools (calendar_list, calendar_get, calendar_availability,
// fetch, search, events_query, attention_digest), Defty's check_calendar, an
// agent employee's events_query and the native resource display. Only the
// creator can change or cancel it.
//
// Run:
//   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/calendar-attendee-visibility-db.test.ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { Hono } from 'hono';
import { calendarRoutes } from '../src/routes/calendar.js';
import { dashboardRoutes } from '../src/routes/dashboard.js';
import { eventRoutes } from '../src/routes/events.js';
import { icsPublicRoutes } from '../src/routes/ics.js';
import {
  humanAttentionDigest,
  humanCalendarAvailability,
  humanCalendarEventCancel,
  humanCalendarEventUpdate,
  humanCalendarGet,
  humanCalendarList,
  humanEventsQuery,
  humanFetch,
  humanSearch,
  type HumanToolContext,
} from '../src/lib/mcp-tools/human.js';
import { eventsQuery } from '../src/lib/mcp-tools/events.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { resolveNativeCalendarDisplay } from '../src/lib/native-calendar-file-projections.js';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
const run = randomUUID().slice(0, 8);
const org = randomUUID(), otherOrg = randomUUID();
const sam = randomUUID(), raj = randomUUID(), ana = randomUUID(), gus = randomUUID(), dee = randomUUID(), olga = randomUUID();
const helperUser = randomUUID(), helper = randomUUID(), loneUser = randomUUID(), lone = randomUUID();
const event = randomUUID(), imported = randomUUID(), malformed = randomUUID();
// Invitations accepted from email or an app, stored as native events with the
// sender's attendee list (native-calendar-invitation-create.ts).
const emailInvite = randomUUID(), appInvite = randomUUID(), rsvpInvite = randomUUID();
// Any other field Deft does not write itself fails closed too.
const otherImport = randomUUID();
const SHOWN = [event, imported, malformed];
const INVITES = [emailInvite, appInvite, rsvpInvite, otherImport];
// [id, name, role in org (null: not a member), active, kind]
const people: Array<[string, string, string | null, boolean, 'human' | 'agent']> = [
  [sam, 'Sam Creator', 'owner', true, 'human'],
  [raj, 'Raj Attendee', 'member', true, 'human'],
  [ana, 'Ana NotInvited', 'member', true, 'human'],
  [gus, 'Gus GuestAttendee', 'guest', true, 'human'],
  [dee, 'Dee Deactivated', 'member', false, 'human'],
  [olga, 'Olga Elsewhere', null, true, 'human'],
  [helperUser, 'Helper Agent', 'member', true, 'agent'],
  [loneUser, 'Lone Agent', 'member', true, 'agent'],
];
const emailOf = (id: string) => `cav-${run}-${id}@test.local`;
const TITLE = `cav standup ${run}`;
const titles: Record<string, string> = {};
const now = new Date();
const tokenOf = (id: string) => `cav-feed-${run}-${id}`.padEnd(40, 'x');

before(async () => {
  await c.connect();
  await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Calendar Attendees', $2), ($3, 'Elsewhere', $4)`,
    [org, `cal-attendees-${run}`, otherOrg, `cal-elsewhere-${run}`]);
  for (const [id, name, role, active, kind] of people) {
    await c.query(`INSERT INTO users (id, email, name, kind, is_agent, password_hash, timezone) VALUES ($1, $2, $3, $4, $5, 'hash', 'UTC')`,
      [id, emailOf(id), `${name} ${run}`, kind, kind === 'agent']);
    if (role) {
      await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, $4)`, [org, id, role, active]);
    }
  }
  // Olga and Raj are members of the other workspace too.
  for (const id of [olga, raj]) {
    await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, 'member', true)`, [otherOrg, id]);
  }
  for (const [employee, user, slug] of [[helper, helperUser, 'helper'], [lone, loneUser, 'lone']]) {
    await c.query(`INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
      VALUES ($1, $2, $3, $4, $5, 'custom', 'test', 'standard', true, true, $6)`, [employee, org, user, `${slug} ${run}`, `cav-${slug}-${run}`, sam]);
  }
  const attendees = (ids: string[], others: string[] = []) => JSON.stringify([
    ...ids.map((id) => ({ email: id === raj ? emailOf(id).toUpperCase() : emailOf(id), displayName: id })),
    ...others.map((email) => ({ email, displayName: email })),
  ]);
  const insertEvent = (id: string, source: string, title: string, metadataAttendees: string, extra: Record<string, unknown> = {}) => {
    titles[title] = id;
    return c.query(
      `INSERT INTO events (id, org_id, source, event_type, title, body, actor, timestamp, user_id, metadata)
       VALUES ($1, $2, $3, 'calendar_event', $4, 'agenda', $5, $6::timestamp, $7,
         jsonb_build_object('start', $8::text, 'end', $9::text, 'status', 'confirmed', 'allDay', false, 'location', null, 'attendees', $10::jsonb) || $11::jsonb)`,
      [id, org, source, title, emailOf(sam), now.toISOString().slice(0, 23), sam,
        now.toISOString(), new Date(now.getTime() + 30 * 60_000).toISOString(), metadataAttendees, JSON.stringify(extra)]);
  };
  // Raj (by an upper-cased address), the guest, the deactivated member, Olga
  // (not a member here), an outsider and the helper agent are invited.
  await insertEvent(event, 'native', TITLE, attendees([raj, gus, dee, olga, helperUser], [`outsider-${run}@example.test`]));
  // An imported event lists Raj too; imported calendars stay their owner's.
  await insertEvent(imported, 'google_calendar', `${TITLE} imported`, attendees([raj]));
  // Attendees that are not a list must not break any read.
  await insertEvent(malformed, 'native', `${TITLE} malformed`, JSON.stringify({ email: emailOf(raj) }));
  // Sam's copies of invitations that list Raj: they stay Sam's.
  // Any email_invitation marks one. (A v1 row also needs the full stored
  // invitation model, or the owner's Calendar projection refuses it.)
  await insertEvent(emailInvite, 'native', `${TITLE} email invite`, attendees([raj]), { email_invitation: { schema_version: 'test.email_invitation' }, email_invitation_response: 'accepted' });
  await insertEvent(appInvite, 'native', `${TITLE} app invite`, attendees([raj]), { app_integration_invitation: { schema_version: 'deft.app_calendar_invitation.v1' }, email_invitation_response: null });
  await insertEvent(rsvpInvite, 'native', `${TITLE} rsvp invite`, attendees([raj]), { email_invitation_response: null });
  await insertEvent(otherImport, 'native', `${TITLE} other import`, attendees([raj]), { source_ref: 'another-app' });
  // ics_publish_tokens comes from an upgrade a partial local push-full may lack;
  // if so, create it exactly as the upgrade does.
  if (!(await c.query(`SELECT to_regclass('public.ics_publish_tokens') AS t`)).rows[0].t) {
    const upgrade = readFileSync(resolve(import.meta.dirname, '../../../packages/db/upgrades/0.3.0-preview.137-ics-publish-tokens.sql'), 'utf8');
    await c.query(upgrade.slice(0, upgrade.indexOf('INSERT INTO ics_publish_tokens')));
  }
  for (const id of [sam, raj, ana, gus, dee]) {
    await c.query(`INSERT INTO ics_publish_tokens (id, org_id, user_id, token) VALUES (gen_random_uuid()::text, $1, $2, $3)`, [org, id, tokenOf(id)]);
  }
});

after(async () => {
  const all = people.map(([id]) => id);
  await c.query(`DELETE FROM ics_publish_tokens WHERE user_id = ANY($1::text[])`, [all]);
  await c.query(`DELETE FROM events WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM agent_employees WHERE org_id = $1`, [org]);
  await c.query(`DELETE FROM org_members WHERE org_id = ANY($1::text[])`, [[org, otherOrg]]);
  await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [all]);
  await c.query(`DELETE FROM orgs WHERE id = ANY($1::text[])`, [[org, otherOrg]]);
  await c.end();
});

const roleOf = (viewer: string) => (people.find(([id]) => id === viewer)![2] ?? 'member') as HumanToolContext['role'];

function app(viewer: string, orgId: string) {
  const hono = new Hono();
  hono.use('*', async (ctx, next) => {
    ctx.set('user', { id: viewer, org_id: orgId, email: emailOf(viewer), sid: 's', role: roleOf(viewer) } as never);
    await next();
  });
  hono.route('/api/calendar', calendarRoutes);
  hono.route('/api/dashboard', dashboardRoutes);
  hono.route('/api/events', eventRoutes);
  hono.route('/api/ics', icsPublicRoutes);
  return hono;
}

async function call(viewer: string, path: string, init?: { method: string; body?: unknown }, orgId = org) {
  const res = await app(viewer, orgId).request(path, init ? {
    method: init.method,
    headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  } : undefined);
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* text/calendar */ }
  return { status: res.status, body, text };
}

const mcp = (viewer: string, orgId = org): HumanToolContext => ({
  org_id: orgId,
  user_id: viewer,
  role: roleOf(viewer),
  scopes: ['read:workspace', 'read:calendar', 'write:calendar'],
});
const parse = (result: { content: Array<{ text: string }>; isError?: boolean }) => (result.isError ? { error: result.content[0]!.text } : JSON.parse(result.content[0]!.text));
const ids = (rows: unknown): string[] => (Array.isArray(rows) ? rows.map((r: any) => String(r.id ?? r.event_id ?? '').replace(/^event:/, '')) : []);

/** A list read that must answer, not fail: a failure would look like "nothing visible". */
function listed(result: { content: Array<{ text: string }>; isError?: boolean }, label: string) {
  assert.notEqual(result.isError, true, `${label} answered an error: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]!.text);
}

/** Which of the `watched` events `viewer` sees, by read surface. */
async function surfaces(viewer: string, orgId = org, watched = SHOWN): Promise<Record<string, string[]>> {
  const from = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const to = new Date(now.getTime() + 24 * 3600_000).toISOString();
  const list = await call(viewer, `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, undefined, orgId);
  assert.equal(list.status, 200, 'calendar list');
  const dashboard = await call(viewer, '/api/dashboard', undefined, orgId);
  assert.equal(dashboard.status, 200, 'dashboard');
  // A feed serves only an active member: the deactivated member's link is refused.
  const feed = orgId === org && [sam, raj, ana, gus, dee].includes(viewer) ? await call(viewer, `/api/ics/feed/${tokenOf(viewer)}`) : null;
  if (feed) assert.equal(feed.status, viewer === dee ? 404 : 200, 'ICS feed');
  const ctx = mcp(viewer, orgId);
  const get = async (id: string) => (parse(await humanCalendarGet({ event_id: id }, ctx)).id === id ? [id] : []);
  const fetched = async (id: string) => (parse(await humanFetch({ id: `event:${id}` }, ctx)).id === id ? [id] : []);
  const each = async (read: (id: string) => Promise<string[]>) => (await Promise.all(watched.map(read))).flat();
  const defty = await executeToolCall('check_calendar', {}, orgId, viewer);
  assert.ok(Array.isArray(defty.result), `check_calendar answered ${JSON.stringify(defty.result)}`);
  const display = async (id: string) => ((await resolveNativeCalendarDisplay({ org_id: orgId, user_id: viewer } as never, id)) ? [id] : []);
  const digest = listed(await humanAttentionDigest({ include_calendar: true, limit: 50 }, { ...ctx, scopes: ['read:calendar'] }), 'attention_digest');
  const mine = (found: string[]) => found.filter((id) => watched.includes(id)).sort();
  return {
    list: mine(ids(list.body.events)),
    dashboard: mine(ids(dashboard.body.calendar_events)),
    ics: feed && feed.status === 200 ? watched.filter((id) => feed.text.includes(id)).sort() : [],
    calendar_list: mine(ids(listed(await humanCalendarList({ from, until: to }, ctx), 'calendar_list'))),
    calendar_get: mine(await each(get)),
    calendar_availability: mine(ids(listed(await humanCalendarAvailability({ from, until: to }, ctx), 'calendar_availability').busy)),
    fetch: mine(await each(fetched)),
    search: mine(ids(listed(await humanSearch({ query: TITLE, limit: 50 }, ctx), 'search'))),
    events_query: mine(ids(listed(await humanEventsQuery({ limit: 200 }, ctx), 'events_query'))),
    attention_digest: mine(ids(digest.upcoming_events)),
    defty_check_calendar: mine((defty.result as Array<{ title: string }>).map((r) => titles[r.title] ?? '')),
    native_display: mine(await each(display)),
  };
}

const everywhere = (found: string[]) => ({
  list: found, dashboard: found, ics: found, calendar_list: found, calendar_get: found, calendar_availability: found,
  fetch: found, search: found, events_query: found, attention_digest: found, defty_check_calendar: found, native_display: found,
});

test('the creator sees all three of their events everywhere (the ICS feed publishes native and ICS events only)', async () => {
  assert.deepEqual(await surfaces(sam), { ...everywhere([event, imported, malformed].sort()), ics: [event, malformed].sort() });
});

test('an attendee who is a member sees the native event everywhere, and not the imported or malformed ones', async () => {
  assert.deepEqual(await surfaces(raj), everywhere([event]));
});

test('an invitation the creator accepted, or any event with fields Deft does not write, stays theirs, though it lists the attendee', async () => {
  assert.deepEqual(await surfaces(raj, org, INVITES), everywhere([]));
  // The creator still has them where they had them before (the calendar list
  // and dashboard show email invitations through their own projection).
  const own = await surfaces(sam, org, INVITES);
  assert.deepEqual(own.calendar_list, [...INVITES].sort());
  assert.deepEqual(own.events_query, [...INVITES].sort());
});

test('a member who is not an attendee sees nothing', async () => {
  assert.deepEqual(await surfaces(ana), everywhere([]));
});

test('a guest who is an attendee sees nothing', async () => {
  assert.deepEqual(await surfaces(gus), everywhere([]));
});

test('a deactivated attendee, an attendee from another workspace and an attendee\'s other-workspace session see nothing', async () => {
  assert.deepEqual(await surfaces(dee), everywhere([]));
  assert.deepEqual(await surfaces(olga, otherOrg), everywhere([]));
  assert.deepEqual(await surfaces(raj, otherOrg), everywhere([]));
});

test('agent employees: an invited one sees the native event through events_query, another sees nothing', async () => {
  const employeeCtx = (employee: string, slug: string) => ({ org_id: org, employee_id: employee, employee_slug: `cav-${slug}-${run}`, trust_level: 'standard' }) as never;
  const seenBy = async (employee: string, slug: string) => {
    const rows = parse(await eventsQuery({ caller_employee_slug: `cav-${slug}-${run}`, limit: 200 }, employeeCtx(employee, slug)));
    return ids(rows).filter((id) => [event, imported, malformed].includes(id)).sort();
  };
  assert.deepEqual(await seenBy(helper, 'helper'), [event]);
  assert.deepEqual(await seenBy(lone, 'lone'), []);
});

test('the calendar list marks the event read-only for an attendee and editable for its creator', async () => {
  const from = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const to = new Date(now.getTime() + 24 * 3600_000).toISOString();
  const row = async (viewer: string) => (await call(viewer, `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).body.events.find((e: any) => e.id === event);
  assert.equal((await row(sam)).viewer_is_owner, true);
  assert.equal((await row(raj)).viewer_is_owner, false);
});

test('an attendee cannot change, cancel or delete the event', async () => {
  const before = (await c.query(`SELECT title, metadata FROM events WHERE id = $1`, [event])).rows[0];
  assert.equal((await call(raj, `/api/events/${event}`, { method: 'PATCH', body: { title: 'hijacked' } })).status, 404);
  assert.equal((await call(raj, `/api/events/${event}`, { method: 'DELETE' })).status, 404);
  assert.equal((await humanCalendarEventUpdate({ event_id: event, title: 'hijacked' }, mcp(raj))).isError, true);
  assert.equal((await humanCalendarEventCancel({ event_id: event }, mcp(raj))).isError, true);
  const after = (await c.query(`SELECT title, metadata FROM events WHERE id = $1`, [event])).rows[0];
  assert.deepEqual(after, before);
});
