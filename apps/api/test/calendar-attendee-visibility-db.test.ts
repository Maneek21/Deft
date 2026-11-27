// A native Deft calendar event lists its attendees by email. It shows, read
// only, on the calendar of each attendee who is an active owner, admin or
// member of the event's workspace, and nowhere else: not to a member who is
// not an attendee, not to a guest (attendee or not), not to a deactivated
// attendee, not to an attendee's session in another workspace, and not for an
// imported (non-native) event. Every calendar read is checked: the calendar
// list, the dashboard, the published ICS feed, the human MCP tools
// (calendar_list, calendar_get, calendar_availability, fetch, search,
// events_query), Defty's check_calendar, an agent employee's events_query and
// the native resource display. Only the creator can change or cancel it.
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
  const attendees = (ids: string[]) => JSON.stringify(ids.map((id) => ({ email: id === raj ? emailOf(id).toUpperCase() : emailOf(id), displayName: id })));
  const insertEvent = (id: string, source: string, metadataAttendees: string) => c.query(
    `INSERT INTO events (id, org_id, source, event_type, title, body, actor, timestamp, user_id, metadata)
     VALUES ($1, $2, $3, 'calendar_event', $4, 'agenda', $5, $6::timestamp, $7,
       jsonb_build_object('start', $8::text, 'end', $9::text, 'status', 'confirmed', 'allDay', false, 'location', null, 'attendees', $10::jsonb))`,
    [id, org, source, source === 'native' ? TITLE : `${TITLE} imported`, emailOf(sam), now.toISOString().slice(0, 23), sam,
      now.toISOString(), new Date(now.getTime() + 30 * 60_000).toISOString(), metadataAttendees]);
  // Raj (by an upper-cased address), the guest, the deactivated member, Olga
  // (not a member here), an outsider and the helper agent are invited.
  await insertEvent(event, 'native', attendees([raj, gus, dee, olga, helperUser]).replace(']', `,{"email":"outsider-${run}@example.test"}]`));
  // An imported event lists Raj too; imported calendars stay their owner's.
  await insertEvent(imported, 'google_calendar', attendees([raj]));
  // Attendees that are not a list must not break any read.
  await insertEvent(malformed, 'native', JSON.stringify({ email: emailOf(raj) }));
  await c.query(`UPDATE events SET title = $2 WHERE id = $1`, [malformed, `${TITLE} malformed`]);
  // ics_publish_tokens comes from an upgrade a partial local push-full may lack;
  // if so, create it exactly as the upgrade does.
  if (!(await c.query(`SELECT to_regclass('public.ics_publish_tokens') AS t`)).rows[0].t) {
    const upgrade = readFileSync(resolve(import.meta.dirname, '../../../packages/db/upgrades/0.3.0-preview.137-ics-publish-tokens.sql'), 'utf8');
    await c.query(upgrade.slice(0, upgrade.indexOf('INSERT INTO ics_publish_tokens')));
  }
  for (const id of [sam, raj, ana, gus]) {
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

/** Where `viewer` sees each of the three events, by read surface. */
async function surfaces(viewer: string, orgId = org): Promise<Record<string, string[]>> {
  const from = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const to = new Date(now.getTime() + 24 * 3600_000).toISOString();
  const list = await call(viewer, `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, undefined, orgId);
  const dashboard = await call(viewer, '/api/dashboard', undefined, orgId);
  const feed = orgId === org && [sam, raj, ana, gus].includes(viewer) ? await call(viewer, `/api/ics/feed/${tokenOf(viewer)}`) : null;
  const ctx = mcp(viewer, orgId);
  const get = async (id: string) => (parse(await humanCalendarGet({ event_id: id }, ctx)).id === id ? [id] : []);
  const fetched = async (id: string) => (parse(await humanFetch({ id: `event:${id}` }, ctx)).id === id ? [id] : []);
  const defty = await executeToolCall('check_calendar', {}, orgId, viewer);
  const display = async (id: string) => ((await resolveNativeCalendarDisplay({ org_id: orgId, user_id: viewer } as never, id)) ? [id] : []);
  const mine = (found: string[]) => found.filter((id) => [event, imported, malformed].includes(id)).sort();
  return {
    list: mine(ids(list.body?.events)),
    dashboard: mine(ids(dashboard.body?.calendar_events)),
    ics: feed ? [event, imported, malformed].filter((id) => feed.text.includes(id)).sort() : [],
    calendar_list: mine(ids(parse(await humanCalendarList({ from, until: to }, ctx)))),
    calendar_get: mine([...(await get(event)), ...(await get(imported)), ...(await get(malformed))]),
    calendar_availability: mine(ids(parse(await humanCalendarAvailability({ from, until: to }, ctx)).busy)),
    fetch: mine([...(await fetched(event)), ...(await fetched(imported)), ...(await fetched(malformed))]),
    search: mine(ids(parse(await humanSearch({ query: TITLE, limit: 50 }, ctx)))),
    events_query: mine(ids(parse(await humanEventsQuery({ limit: 200 }, ctx)))),
    defty_check_calendar: (Array.isArray(defty.result) ? defty.result : []).filter((r: any) => String(r.title).startsWith(TITLE)).map((r: any) => (r.title === TITLE ? event : String(r.title).endsWith('imported') ? imported : malformed)).sort(),
    native_display: mine([...(await display(event)), ...(await display(imported)), ...(await display(malformed))]),
  };
}

const everywhere = (found: string[]) => ({
  list: found, dashboard: found, ics: found, calendar_list: found, calendar_get: found, calendar_availability: found,
  fetch: found, search: found, events_query: found, defty_check_calendar: found, native_display: found,
});

test('the creator sees all three of their events everywhere (the ICS feed publishes native and ICS events only)', async () => {
  assert.deepEqual(await surfaces(sam), { ...everywhere([event, imported, malformed].sort()), ics: [event, malformed].sort() });
});

test('an attendee who is a member sees the native event everywhere, and not the imported or malformed ones', async () => {
  assert.deepEqual(await surfaces(raj), everywhere([event]));
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
