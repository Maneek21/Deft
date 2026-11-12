/**
 * Meeting briefs are generated for, delivered to and shown to active members
 * of the workspace they belong to.
 *
 * A person in two workspaces who is no longer an active member of one gets no
 * new brief for that workspace's meetings and reads none of its briefs from
 * the other workspace, while briefs in the workspace they remain in are
 * generated and shown as before. Membership is read before the run is claimed,
 * after it is claimed, and while the brief is stored. Briefs are read only
 * within the session's workspace, for an active member, and only when the
 * brief and its meeting both belong to that workspace.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, mock, test } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';

let providerLookups = 0;
let duringSynthesis: (() => Promise<void>) | null = null;
const actualAiConfig = await import('../src/lib/org-ai-config.js');
mock.module(new URL('../src/lib/org-ai-config.ts', import.meta.url).href, { namedExports: {
  ...actualAiConfig,
  // No model configured: the evidence-only brief is produced without a model call.
  resolveReasonProvider: async () => {
    providerLookups += 1;
    if (duringSynthesis) await duringSynthesis();
    return { provider: 'anthropic', model: 'test-model', apiKey: '' };
  },
} });

// Scripted membership answers, consumed in order; when empty, the database answers.
const membershipAnswers: boolean[] = [];
const actualMembership = await import('../src/lib/org-membership.js');
mock.module(new URL('../src/lib/org-membership.ts', import.meta.url).href, { namedExports: {
  ...actualMembership,
  getActiveOrgMembership: async (orgId: string, userId: string) => {
    const scripted = membershipAnswers.shift();
    if (scripted === undefined) return actualMembership.getActiveOrgMembership(orgId, userId);
    return scripted ? { id: 'scripted', role: 'member' as const } : null;
  },
} });

const emitted: Array<{ orgId: string; userId: string; event: string }> = [];
const actualSocket = await import('../src/socket.js');
mock.module(new URL('../src/socket.ts', import.meta.url).href, { namedExports: {
  ...actualSocket,
  emitToUser: (orgId: string, userId: string, event: string) => { emitted.push({ orgId, userId, event }); },
} });

const actualPrep = await import('../src/lib/meeting-prep-automation.js');
const scheduled: string[] = [];
mock.module(new URL('../src/lib/meeting-prep-automation.ts', import.meta.url).href, { namedExports: {
  ...actualPrep,
  generateMeetingPrep: async (eventId: string, now?: Date) => {
    scheduled.push(eventId);
    return actualPrep.generateMeetingPrep(eventId, now);
  },
} });

const { generateMeetingPrep } = actualPrep;
const { handleMeetingPrepCheck } = await import('../src/workers/handlers/meeting-prep-check.js');
const { calendarRoutes } = await import('../src/routes/calendar.js');
const { closeDb } = await import('../src/lib/db.js');

after(closeDb);

type Fixture = { orgA: string; orgB: string; person: string; colleague: string; eventA: string; eventB: string; colleagueEvent: string };

async function seed(c: pg.Client): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const orgA = randomUUID(), orgB = randomUUID(), person = randomUUID(), colleague = randomUUID();
  const eventA = randomUUID(), eventB = randomUUID(), colleagueEvent = randomUUID();
  for (const org of [orgA, orgB]) await c.query('INSERT INTO orgs(id,name,slug) VALUES($1,$1,$1)', [org]);
  for (const [user, name] of [[person, `Person ${tag}`], [colleague, `Colleague ${tag}`]]) {
    await c.query(`INSERT INTO users(id,email,name) VALUES($1,$1||'@test.local',$2)`, [user, name]);
  }
  for (const [org, user] of [[orgA, person], [orgB, person], [orgA, colleague]]) {
    await c.query(`INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'member')`, [randomUUID(), org, user]);
  }
  // Inside the scheduler's 30-minute window, written as UTC wall time as the app stores it.
  const when = new Date(Date.now() + 20 * 60_000).toISOString().replace('Z', '');
  for (const [id, org, user, title] of [[eventA, orgA, person, 'Alpha sync'], [eventB, orgB, person, 'Beta sync'], [colleagueEvent, orgA, colleague, 'Alpha review']]) {
    await c.query(
      `INSERT INTO events(id,org_id,user_id,source,event_type,external_id,title,timestamp,metadata)
       VALUES($1,$2,$3,'ics','calendar_event',$4,$5,$6,'{}'::jsonb)`,
      [id, org, user, `brief-member-${id}`, title, when],
    );
  }
  providerLookups = 0; duringSynthesis = null; membershipAnswers.length = 0; emitted.length = 0; scheduled.length = 0;
  return { orgA, orgB, person, colleague, eventA, eventB, colleagueEvent };
}

async function cleanup(c: pg.Client, f: Fixture) {
  duringSynthesis = null; membershipAnswers.length = 0;
  for (const sql of [
    'DELETE FROM attention_items WHERE org_id=$1',
    'DELETE FROM notifications WHERE org_id=$1',
    'DELETE FROM meeting_briefs WHERE org_id=$1',
    'DELETE FROM automation_runs WHERE org_id=$1',
    'DELETE FROM events WHERE org_id=$1',
    'DELETE FROM org_members WHERE org_id=$1',
    'DELETE FROM orgs WHERE id=$1',
  ]) {
    for (const org of [f.orgA, f.orgB]) await c.query(sql, [org]).catch(() => undefined);
  }
  await c.query('DELETE FROM users WHERE id = ANY($1)', [[f.person, f.colleague]]).catch(() => undefined);
}

async function setActive(c: pg.Client, org: string, user: string, active: boolean) {
  await c.query('UPDATE org_members SET is_active=$3, updated_at=now() WHERE org_id=$1 AND user_id=$2', [org, user, active]);
}

async function readBriefs(sessionOrg: string, userId: string, eventIds: string[]) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: sessionOrg, email: `${userId}@test.local`, sid: 'test' } as any);
    await next();
  });
  app.route('/api/calendar', calendarRoutes);
  const res = await app.request(`/api/calendar/briefs?event_ids=${eventIds.join(',')}`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { briefs: Array<{ id: string; event_id: string; generator: string | null }> }).briefs;
}

async function counts(c: pg.Client, org: string, user: string) {
  const one = async (sql: string) => Number((await c.query(sql, [org, user])).rows[0].n);
  return {
    briefs: await one('SELECT count(*) AS n FROM meeting_briefs WHERE org_id=$1 AND user_id=$2'),
    runs: await one(`SELECT count(*) AS n FROM automation_runs WHERE org_id=$1 AND user_id=$2 AND kind='meeting_prep'`),
    notifications: await one('SELECT count(*) AS n FROM notifications WHERE org_id=$1 AND user_id=$2'),
    attention: await one('SELECT count(*) AS n FROM attention_items WHERE org_id=$1 AND user_id=$2'),
  };
}

async function onlyRun(c: pg.Client, org: string, user: string) {
  const rows = (await c.query(`SELECT status, output, error FROM automation_runs WHERE org_id=$1 AND user_id=$2 AND kind='meeting_prep'`, [org, user])).rows;
  assert.equal(rows.length, 1);
  return rows[0] as { status: string; output: unknown; error: string | null };
}

const nothing = { briefs: 0, runs: 0, notifications: 0, attention: 0 };

async function withFixture(body: (c: pg.Client, f: Fixture) => Promise<void>) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const f = await seed(c);
  try { await body(c, f); } finally { await cleanup(c, f); await c.end(); }
}

test('a person no longer active in a workspace gets no new brief there and still gets briefs where they remain', () => withFixture(async (c, f) => {
  await setActive(c, f.orgA, f.person, false);

  const skipped = await generateMeetingPrep(f.eventA);
  assert.equal(skipped.brief, null, 'no brief for a workspace the recipient is not active in');
  assert.deepEqual(await counts(c, f.orgA, f.person), nothing);
  assert.equal(providerLookups, 0, 'no synthesis is started');
  assert.equal(emitted.length, 0, 'nothing is pushed');

  const kept = await generateMeetingPrep(f.eventB);
  assert.ok(kept.brief, 'the workspace the person remains in still gets its brief');
  assert.equal(kept.brief!.org_id, f.orgB);
  const inB = await counts(c, f.orgB, f.person);
  assert.deepEqual([inB.briefs, inB.runs, inB.notifications], [1, 1, 1]);
  assert.ok(emitted.some((push) => push.event === 'meeting-brief:new' && push.orgId === f.orgB && push.userId === f.person));
  assert.ok(emitted.every((push) => push.orgId === f.orgB), 'pushes go only to the active workspace');
}));

test('an active member, guests included, keeps getting briefs', () => withFixture(async (c, f) => {
  const result = await generateMeetingPrep(f.colleagueEvent);
  assert.ok(result.brief);
  assert.equal(result.alreadyExisted, false);
  assert.equal(result.run?.status, 'delivered');
  const again = await generateMeetingPrep(f.colleagueEvent);
  assert.equal(again.alreadyExisted, true);
  assert.equal(again.brief?.id, result.brief!.id);

  await c.query(`UPDATE org_members SET role='guest' WHERE org_id=$1 AND user_id=$2`, [f.orgA, f.person]);
  const guest = await generateMeetingPrep(f.eventA);
  assert.ok(guest.brief, 'an active guest gets the brief');
}));

test('a removal that lands during synthesis stores and delivers nothing', () => withFixture(async (c, f) => {
  duringSynthesis = async () => { await setActive(c, f.orgA, f.person, false); };
  const result = await generateMeetingPrep(f.eventA);
  assert.equal(result.brief, null);
  assert.equal(providerLookups, 1);
  const run = await onlyRun(c, f.orgA, f.person);
  assert.equal(run.status, 'failed');
  assert.equal(run.output, null, 'no draft or evidence is kept on the run');
  assert.deepEqual({ ...(await counts(c, f.orgA, f.person)), runs: 0 }, nothing);
  assert.equal(emitted.length, 0);
}));

test('a removal that lands while the run is claimed stops the run and the cached return', () => withFixture(async (c, f) => {
  membershipAnswers.push(true, false);
  const claimed = await generateMeetingPrep(f.eventA);
  assert.equal(claimed.brief, null);
  assert.equal(providerLookups, 0, 'no evidence is gathered or synthesized');
  assert.equal((await onlyRun(c, f.orgA, f.person)).status, 'failed');
  assert.deepEqual({ ...(await counts(c, f.orgA, f.person)), runs: 0 }, nothing);

  const delivered = await generateMeetingPrep(f.eventA);
  assert.ok(delivered.brief, 'an active member gets the brief on the next run');
  membershipAnswers.push(true, false);
  const cached = await generateMeetingPrep(f.eventA);
  assert.equal(cached.brief, null, 'the stored brief is not handed back');
  assert.equal(cached.run, null);
}));

test('a stored brief is kept, hidden while its recipient is inactive, and shown again after reactivation', () => withFixture(async (c, f) => {
  const first = await generateMeetingPrep(f.eventA);
  assert.ok(first.brief);
  await setActive(c, f.orgA, f.person, false);
  assert.equal((await generateMeetingPrep(f.eventA)).brief, null, 'the stored brief is not handed back');
  assert.deepEqual(await readBriefs(f.orgA, f.person, [f.eventA]), [], 'not shown to an inactive member');
  assert.equal((await c.query('SELECT 1 FROM meeting_briefs WHERE id=$1', [first.brief!.id])).rowCount, 1, 'the stored brief is kept');

  await setActive(c, f.orgA, f.person, true);
  assert.equal((await generateMeetingPrep(f.eventA)).brief?.id, first.brief!.id);
  assert.deepEqual((await readBriefs(f.orgA, f.person, [f.eventA])).map((row) => row.id), [first.brief!.id]);
}));

test('the scheduler prepares briefs only for active members', () => withFixture(async (c, f) => {
  await setActive(c, f.orgA, f.person, false);
  await handleMeetingPrepCheck({} as any);
  assert.ok(!scheduled.includes(f.eventA), 'an inactive recipient\'s meeting is not attempted');
  assert.ok(scheduled.includes(f.eventB) && scheduled.includes(f.colleagueEvent));
  assert.deepEqual(await counts(c, f.orgA, f.person), nothing);
  assert.equal((await counts(c, f.orgB, f.person)).briefs, 1);
  assert.equal((await counts(c, f.orgA, f.colleague)).briefs, 1);
}));

test('briefs are read only within the session workspace', () => withFixture(async (c, f) => {
  const a = await generateMeetingPrep(f.eventA);
  const b = await generateMeetingPrep(f.eventB);
  assert.ok(a.brief && b.brief);

  // Active in both: each session sees only its own workspace's brief.
  assert.deepEqual((await readBriefs(f.orgB, f.person, [f.eventA, f.eventB])).map((row) => row.id), [b.brief!.id]);
  assert.deepEqual((await readBriefs(f.orgA, f.person, [f.eventA, f.eventB])).map((row) => row.id), [a.brief!.id]);

  // After leaving workspace A, the B session still does not see the A brief.
  await setActive(c, f.orgA, f.person, false);
  assert.deepEqual((await readBriefs(f.orgB, f.person, [f.eventA, f.eventB])).map((row) => row.id), [b.brief!.id]);
  assert.deepEqual(await readBriefs(f.orgB, f.person, [f.eventA]), []);
}));

test('a brief whose meeting or run belongs to another workspace is not read across', () => withFixture(async (c, f) => {
  const b = await generateMeetingPrep(f.eventB);
  assert.ok(b.brief);
  // A brief row in B that points at A's meeting.
  await c.query(
    'INSERT INTO meeting_briefs(id,org_id,user_id,event_id,brief_text) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), f.orgB, f.person, f.eventA, 'mismatched brief'],
  );
  // A newer run in A that points at B's brief.
  await c.query(
    `INSERT INTO automation_runs(id,org_id,kind,subject_id,user_id,idempotency_key,scheduled_for,status,generator,result_entity_id,updated_at)
     VALUES($1,$2,'meeting_prep',$3,$4,$5,now(),'delivered','agent',$6,now() + interval '1 hour')`,
    [randomUUID(), f.orgA, f.eventB, f.person, `cross-${randomUUID()}`, b.brief!.id],
  );
  const rows = await readBriefs(f.orgB, f.person, [f.eventA, f.eventB]);
  assert.deepEqual(rows.map((row) => row.id), [b.brief!.id]);
  assert.equal(rows[0]!.generator, b.run!.generator, 'the generator comes from the brief\'s own workspace run');
}));

test('a rescheduled meeting\'s brief is returned once', () => withFixture(async (c, f) => {
  const first = await generateMeetingPrep(f.eventB);
  assert.ok(first.brief);
  await c.query(`UPDATE events SET timestamp = timestamp + interval '5 minutes' WHERE id=$1`, [f.eventB]);
  const second = await generateMeetingPrep(f.eventB);
  assert.equal(second.brief?.id, first.brief!.id);
  assert.equal(Number((await c.query('SELECT count(*) AS n FROM automation_runs WHERE result_entity_id=$1', [first.brief!.id])).rows[0].n), 2);
  assert.deepEqual((await readBriefs(f.orgB, f.person, [f.eventB])).map((row) => row.id), [first.brief!.id]);
}));

test('a stored brief from another workspace for the same meeting is left untouched', () => withFixture(async (c, f) => {
  const foreign = randomUUID();
  await c.query(
    'INSERT INTO meeting_briefs(id,org_id,user_id,event_id,brief_text) VALUES($1,$2,$3,$4,$5)',
    [foreign, f.orgB, f.person, f.eventA, 'other workspace brief'],
  );
  await assert.rejects(generateMeetingPrep(f.eventA));
  const row = (await c.query('SELECT org_id, brief_text FROM meeting_briefs WHERE id=$1', [foreign])).rows[0];
  assert.deepEqual(row, { org_id: f.orgB, brief_text: 'other workspace brief' });
  assert.equal((await onlyRun(c, f.orgA, f.person)).status, 'failed');
  assert.deepEqual({ ...(await counts(c, f.orgA, f.person)), runs: 0 }, nothing);
}));

test('a removal that lands after the brief is stored stops delivery', () => withFixture(async (c, f) => {
  membershipAnswers.push(true, true, false);
  const result = await generateMeetingPrep(f.eventA);
  assert.equal(result.brief, null);
  assert.equal((await onlyRun(c, f.orgA, f.person)).status, 'failed');
  const left = await counts(c, f.orgA, f.person);
  assert.equal(left.briefs, 1, 'the stored brief is kept');
  assert.deepEqual([left.notifications, left.attention], [0, 0]);
  assert.equal(emitted.length, 0);
}));
