/**
 * First-workspace signup: POST /api/auth/signup decides who owns a fresh
 * install. The "no workspace yet" check and the creation of the first user,
 * org and owner membership are one locked transaction, so signups arriving
 * together produce exactly one workspace.
 *
 * The shared test database always holds fixture orgs, and signup only does
 * anything on an install with none. So this file gives its own process empty
 * copies of the tables signup touches, in a throwaway schema placed first on
 * the search path (PGOPTIONS is read by pg when each connection opens). The
 * real route, transaction and lock run unchanged against those copies.
 *
 * Run: pnpm --filter @deft/api test test/signup-first-workspace-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.search && !url.hash;
  } catch { return false; }
})();

const TABLES = ['users', 'orgs', 'org_members', 'spaces', 'space_members', 'onboarding_state', 'web_sessions'];

test('first-workspace signup: one owner, one workspace under concurrency', { skip: !safe, timeout: 180_000 }, async (t) => {
  const schema = `signup_first_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: target, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  for (const table of TABLES) {
    await admin.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
  }

  const savedOptions = process.env.PGOPTIONS;
  process.env.PGOPTIONS = `-c search_path=${schema},public`;
  const { authRoutes } = await import('../src/routes/auth.js');
  const { closeDb } = await import('../src/lib/db.js');
  const app = new Hono().route('/api/auth', authRoutes);

  t.after(async () => {
    await closeDb();
    if (savedOptions === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = savedOptions;
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  /** A fresh, empty install. */
  async function freshInstall() {
    await admin.query(`TRUNCATE ${TABLES.map((table) => `"${schema}".${table}`).join(', ')}`);
  }
  let people = 0;
  const person = (extra: Record<string, unknown> = {}) => {
    people += 1;
    return {
      name: `Owner ${people}`,
      email: `owner-${people}-${schema}@signup.test`,
      password: 'correct-horse-battery-staple',
      org_name: `Workspace ${people}`,
      ...extra,
    };
  };
  async function signup(body: unknown) {
    const res = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) as Record<string, any> };
  }
  const count = async (sql: string) => (await admin.query<{ n: number }>(sql)).rows[0]!.n;
  const orgCount = () => count(`SELECT count(*)::int AS n FROM "${schema}".orgs`);
  const ownerCount = () => count(`SELECT count(*)::int AS n FROM "${schema}".org_members WHERE role = 'owner'`);
  const humanCount = () => count(`SELECT count(*)::int AS n FROM "${schema}".users WHERE password_hash IS NOT NULL`);

  await t.test('the route runs against the empty copies, not the shared tables', async () => {
    await freshInstall();
    const res = await app.request('/api/auth/has-workspace');
    assert.deepEqual(await res.json(), { hasWorkspace: false });
  });

  await t.test('the first signup becomes the owner; the next is refused', async () => {
    await freshInstall();
    const first = await signup(person());
    assert.equal(first.status, 201, first.text);
    assert.ok(first.json.accessToken && first.json.refreshToken, 'a session is issued');
    assert.equal(await orgCount(), 1);
    const owners = await admin.query(
      `SELECT user_id, org_id, is_active FROM "${schema}".org_members WHERE role = 'owner'`);
    assert.deepEqual(owners.rows, [{ user_id: first.json.user.id, org_id: first.json.org.id, is_active: true }]);
    assert.equal(await count(`SELECT count(*)::int AS n FROM "${schema}".spaces WHERE is_default AND name = 'general'`), 1);
    assert.equal(await count(`SELECT count(*)::int AS n FROM "${schema}".onboarding_state WHERE org_created`), 1);

    const second = await signup(person());
    assert.equal(second.status, 403);
    assert.equal(second.json.code, 'SINGLE_ORG_LIMIT');
    assert.equal(await orgCount(), 1);
    assert.equal(await humanCount(), 1);
  });

  await t.test('signups arriving together create exactly one workspace', async () => {
    await freshInstall();
    const results = await Promise.all(Array.from({ length: 6 }, () => signup(person())));
    assert.deepEqual(results.map((res) => res.status).sort(), [201, 403, 403, 403, 403, 403]);
    for (const res of results.filter((entry) => entry.status === 403)) assert.equal(res.json.code, 'SINGLE_ORG_LIMIT');
    assert.equal(await orgCount(), 1);
    assert.equal(await ownerCount(), 1);
    assert.equal(await humanCount(), 1, 'the refused signups leave no user behind');
    const winner = results.find((res) => res.status === 201)!;
    const owners = await admin.query(`SELECT user_id, org_id FROM "${schema}".org_members WHERE role = 'owner'`);
    assert.deepEqual(owners.rows, [{ user_id: winner.json.user.id, org_id: winner.json.org.id }]);
  });
});
