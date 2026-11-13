import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import pg from 'pg';
import { db, orgMembers, orgs, projects, tasks, users } from '@deft/db';
import { icsPublishTokens } from '@deft/db/ics-publish-tokens';
import { icsPublicRoutes, icsRoutes } from '../src/routes/ics.js';

const s = crypto.randomUUID().replace(/-/g, '');
const orgA = crypto.randomUUID();
const orgB = crypto.randomUUID();
const person = crypto.randomUUID();
const legacy = { one: crypto.randomUUID(), two: crypto.randomUUID(), none: crypto.randomUUID() };
const upgradeSql = readFileSync(resolve(import.meta.dirname, '../../../packages/db/upgrades/0.3.0-preview.137-ics-publish-tokens.sql'), 'utf8');
const projectA = crypto.randomUUID();
const projectB = crypto.randomUUID();
const due = new Date(Date.now() + 24 * 60 * 60 * 1000);
let session = { id: person, org_id: orgA };

const app = new Hono();
app.route('/api/ics', icsPublicRoutes);
const authed = new Hono();
authed.use('*', async (c, next) => {
  c.set('user' as never, { ...session, email: `x-${s}@test.local`, sid: 'sid' } as never);
  await next();
});
authed.route('/api/ics', icsRoutes);

async function feedUrlIn(orgId: string, regenerate = false, userId = person): Promise<string> {
  session = { id: userId, org_id: orgId };
  const res = regenerate
    ? await authed.request('/api/ics/my-feed-url/regenerate', { method: 'POST' })
    : await authed.request('/api/ics/my-feed-url');
  assert.equal(res.status, 200);
  const { feed_url } = await res.json() as { feed_url: string };
  return feed_url.slice(feed_url.indexOf('/feed/') + '/feed/'.length);
}

async function fetchFeed(token: string) {
  const res = await app.request(`/api/ics/feed/${token}`);
  return { status: res.status, headers: [...res.headers.entries()], body: await res.text() };
}
const unknownAnswer = () => fetchFeed(`nosuchtoken${s}`);

before(async () => {
  await db.insert(orgs).values([
    { id: orgA, name: `WS A ${s}`, slug: `ws-a-${s}` },
    { id: orgB, name: `WS B ${s}`, slug: `ws-b-${s}` },
  ]);
  await db.insert(users).values({ id: person, email: `ws-person-${s}@test.local`, name: 'WS Person' });
  await db.insert(orgMembers).values([{ org_id: orgA, user_id: person }, { org_id: orgB, user_id: person }]);
  await db.insert(projects).values([
    { id: projectA, org_id: orgA, name: 'A', prefix: `A${s.slice(0, 6)}` },
    { id: projectB, org_id: orgB, name: 'B', prefix: `B${s.slice(0, 6)}` },
  ]);
  await db.insert(tasks).values([
    { org_id: orgA, project_id: projectA, number: 1, title: 'TASK-IN-A', assignee_id: person, created_by: person, due_date: due },
    { org_id: orgB, project_id: projectB, number: 1, title: 'TASK-IN-B', assignee_id: person, created_by: person, due_date: due },
  ]);
});

after(async () => {
  const everyone = [person, ...Object.values(legacy)];
  await db.delete(icsPublishTokens).where(inArray(icsPublishTokens.user_id, everyone));
  await db.delete(tasks).where(inArray(tasks.org_id, [orgA, orgB]));
  await db.delete(projects).where(inArray(projects.org_id, [orgA, orgB]));
  await db.delete(orgMembers).where(inArray(orgMembers.org_id, [orgA, orgB]));
  await db.delete(users).where(inArray(users.id, everyone));
  await db.delete(orgs).where(inArray(orgs.id, [orgA, orgB]));
});

test('each workspace has its own feed that serves only that workspace', async () => {
  const tokenA = await feedUrlIn(orgA);
  const tokenB = await feedUrlIn(orgB);
  assert.notEqual(tokenA, tokenB);
  assert.equal(await feedUrlIn(orgA), tokenA, 'the URL is stable per workspace');
  const a = await fetchFeed(tokenA);
  const b = await fetchFeed(tokenB);
  assert.equal(a.status, 200);
  assert.match(a.body, /TASK-IN-A/);
  assert.doesNotMatch(a.body, /TASK-IN-B/);
  assert.equal(b.status, 200);
  assert.match(b.body, /TASK-IN-B/);
  assert.doesNotMatch(b.body, /TASK-IN-A/);
});

test('regenerating in one workspace leaves the other workspace feed working', async () => {
  const oldA = await feedUrlIn(orgA);
  const tokenB = await feedUrlIn(orgB);
  const newA = await feedUrlIn(orgA, true);
  assert.notEqual(newA, oldA);
  assert.deepEqual(await fetchFeed(oldA), await unknownAnswer());
  assert.match((await fetchFeed(newA)).body, /TASK-IN-A/);
  assert.equal(await feedUrlIn(orgB), tokenB);
  assert.match((await fetchFeed(tokenB)).body, /TASK-IN-B/);
});

test('leaving a workspace makes its feed unknown without serving another workspace', async () => {
  const tokenA = await feedUrlIn(orgA);
  const tokenB = await feedUrlIn(orgB);
  await db.update(orgMembers).set({ is_active: false })
    .where(and(eq(orgMembers.org_id, orgA), eq(orgMembers.user_id, person)));
  try {
    const left = await fetchFeed(tokenA);
    assert.deepEqual(left, await unknownAnswer());
    assert.doesNotMatch(left.body, /TASK-IN-B/);
    assert.match((await fetchFeed(tokenB)).body, /TASK-IN-B/);
  } finally {
    await db.update(orgMembers).set({ is_active: true })
      .where(and(eq(orgMembers.org_id, orgA), eq(orgMembers.user_id, person)));
  }
});

test('malformed, unknown and revoked tokens get one answer', async () => {
  const unknown = await unknownAnswer();
  assert.equal(unknown.status, 404);
  assert.deepEqual(await fetchFeed('short'), unknown);
  const revoked = await feedUrlIn(orgB);
  await feedUrlIn(orgB, true);
  assert.deepEqual(await fetchFeed(revoked), unknown);
});

test('the upgrade binds an existing feed link only for people in exactly one workspace', async () => {
  const sqlText = upgradeSql;
  const insert = sqlText.slice(sqlText.indexOf('INSERT INTO ics_publish_tokens'));
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const ids = { one: crypto.randomUUID(), two: crypto.randomUUID(), none: crypto.randomUUID(), noToken: crypto.randomUUID() };
  try {
    await client.query('BEGIN');
    await client.query('DROP TABLE ics_publish_tokens');
    for (const [k, id] of Object.entries(ids)) {
      await client.query('INSERT INTO users (id, email, name, ics_publish_token) VALUES ($1, $2, $3, $4)',
        [id, `mig-${k}-${s}@test.local`, `Mig ${k}`, k === 'noToken' ? null : `legacy${k}${s}`]);
    }
    const member = (orgId: string, userId: string, active = true) =>
      client.query('INSERT INTO org_members (id, org_id, user_id, is_active) VALUES ($1, $2, $3, $4)', [crypto.randomUUID(), orgId, userId, active]);
    await member(orgA, ids.one);
    await member(orgB, ids.one, false);
    await member(orgA, ids.two);
    await member(orgB, ids.two);
    await member(orgA, ids.noToken);
    await client.query(sqlText);
    const rows = async () => (await client.query<{ org_id: string; user_id: string; token: string; revoked_at: Date | null }>(
      'SELECT org_id, user_id, token, revoked_at FROM ics_publish_tokens WHERE user_id = ANY($1) ORDER BY user_id',
      [Object.values(ids)])).rows;
    assert.deepEqual(await rows(), [{ org_id: orgA, user_id: ids.one, token: `legacyone${s}`, revoked_at: null }]);
    await client.query(insert);
    assert.equal((await rows()).length, 1, 're-running the data step neither fails nor duplicates');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
});

test('a fresh install has the published feed table as the upgrade creates it', async () => {
  // Same definitions as the Versioned Upgrade job checks after db:upgrade.
  const columns = await db.execute(sql`SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY ordinal_position) AS v
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ics_publish_tokens'`);
  const indexes = await db.execute(sql`SELECT string_agg(pg_get_indexdef(i.indexrelid), ' | ' ORDER BY c.relname) AS v
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.ics_publish_tokens'::regclass AND NOT i.indisprimary`);
  assert.equal(columns.rows[0]?.v, 'id:text:NO,org_id:text:NO,user_id:text:NO,token:text:NO,revoked_at:timestamp without time zone:YES,created_at:timestamp without time zone:NO,updated_at:timestamp without time zone:NO');
  assert.equal(indexes.rows[0]?.v, 'CREATE UNIQUE INDEX ics_publish_tokens_live_uidx ON public.ics_publish_tokens USING btree (org_id, user_id) WHERE (revoked_at IS NULL) | CREATE UNIQUE INDEX ics_publish_tokens_token_uidx ON public.ics_publish_tokens USING btree (token)');
});

test('after the upgrade a kept link serves its workspace and other old links are unknown', async () => {
  for (const [k, id] of Object.entries(legacy)) {
    await db.insert(users).values({ id, email: `legacy-${k}-${s}@test.local`, name: `Legacy ${k}`, ics_publish_token: `oldlink${k}${s}` });
  }
  await db.insert(orgMembers).values([
    { org_id: orgA, user_id: legacy.one },
    { org_id: orgA, user_id: legacy.two },
    { org_id: orgB, user_id: legacy.two },
  ]);
  await db.insert(tasks).values([
    { org_id: orgA, project_id: projectA, number: 9, title: 'LEGACY-ONE-TASK', assignee_id: legacy.one, created_by: legacy.one, due_date: due },
  ]);
  await db.execute(sql.raw(upgradeSql.slice(upgradeSql.indexOf('INSERT INTO ics_publish_tokens'))));
  const unknown = await unknownAnswer();
  const kept = await fetchFeed(`oldlinkone${s}`);
  assert.equal(kept.status, 200);
  assert.match(kept.body, /LEGACY-ONE-TASK/);
  assert.deepEqual(await fetchFeed(`oldlinktwo${s}`), unknown);
  assert.deepEqual(await fetchFeed(`oldlinknone${s}`), unknown);
  assert.equal(await feedUrlIn(orgA, false, legacy.one), `oldlinkone${s}`);
  await feedUrlIn(orgA, true, legacy.one);
  assert.deepEqual(await fetchFeed(`oldlinkone${s}`), unknown, 'a rotated link stays unknown though users still holds it');
});

test('overlapping loads and rotations keep one live feed per workspace', async () => {
  const tokenB = await feedUrlIn(orgB);
  session = { id: person, org_id: orgA };
  const loads = await Promise.all([1, 2, 3].map(() => authed.request('/api/ics/my-feed-url').then((r) => r.json() as Promise<{ feed_url: string }>)));
  const rotations = await Promise.all([1, 2, 3].map(() => authed.request('/api/ics/my-feed-url/regenerate', { method: 'POST' }).then((r) => r.json() as Promise<{ feed_url: string }>)));
  assert.equal(loads.length + rotations.length, 6);
  const live = await db.select({ token: icsPublishTokens.token }).from(icsPublishTokens)
    .where(and(eq(icsPublishTokens.org_id, orgA), eq(icsPublishTokens.user_id, person), isNull(icsPublishTokens.revoked_at)));
  assert.equal(live.length, 1);
  assert.ok(rotations.some((r) => r.feed_url.endsWith(`/feed/${live[0]!.token}`)), 'a returned URL is the live one');
  assert.match((await fetchFeed(live[0]!.token)).body, /TASK-IN-A/);
  assert.equal(await feedUrlIn(orgB), tokenB);
});
