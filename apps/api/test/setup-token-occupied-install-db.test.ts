/**
 * Launch check 12.2, rows 12 and 13: on a hosted install that already has
 * an owner, a NEW valid setup token never makes a second owner or a second
 * organisation. Row 12 restarts the install with a fresh token hash (its
 * marker unused); row 13 replaces only the stored hash and keeps the owner.
 * Either way signup with the matching new token is refused, and the install
 * still has one organisation, one owner and one person.
 *
 * Like signup-first-workspace-db.test.ts, this file gives its own process
 * empty copies of the tables signup touches, in a throwaway schema placed
 * first on the search path, because the shared test database always holds
 * fixture workspaces. The real route, transaction and lock run unchanged.
 *
 * In CI the disposable database is always there, so this file fails rather
 * than skips when it cannot use one.
 *
 * Run: pnpm --filter @deft/api test test/setup-token-occupied-install-db.test.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';
import { ensureTwoStepTables } from './fixtures/two-step-tables.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const inCi = process.env.CI === 'true';
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.search && !url.hash;
  } catch { return false; }
})();

// A hosted signup also writes the two-step tables (the owner gets an enrol-only challenge).
const TABLES = ['users', 'orgs', 'org_members', 'spaces', 'space_members', 'onboarding_state', 'web_sessions', 'user_two_step', 'two_step_challenges'];
const HOSTED_KEYS = ['DEFT_HOSTED', 'DEFT_SETUP_TOKEN_SHA256', 'DEFT_SETUP_TOKEN_EXPIRES_AT'] as const;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();

test('hosted: a new valid setup token on an install that already has an owner makes no second owner or organisation', {
  skip: !safe && !inCi ? 'Set DEFT_TEST_DATABASE_URL (equal to DATABASE_URL) to a disposable localhost test database' : false,
  timeout: 180_000,
}, async (t) => {
  assert.ok(safe, 'CI must provide a disposable localhost test database (DEFT_TEST_DATABASE_URL equal to DATABASE_URL)');
  const schema = `setup_occupied_${randomUUID().replaceAll('-', '')}`;
  await ensureTwoStepTables(target!);
  const admin = new pg.Pool({ connectionString: target, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  for (const table of TABLES) {
    await admin.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
  }

  const savedOptions = process.env.PGOPTIONS;
  const savedHosted = Object.fromEntries(HOSTED_KEYS.map((key) => [key, process.env[key]]));
  process.env.PGOPTIONS = `-c search_path=${schema},public`;
  const { authRoutes } = await import('../src/routes/auth.js');
  const { closeDb } = await import('../src/lib/db.js');
  const { setupTokenUseStore } = await import('../src/lib/setup-token-use.js');
  const app = new Hono().route('/api/auth', authRoutes);
  // This process's own uploads volume, so markers never land in apps/api/uploads.
  const volume = await mkdtemp(join(tmpdir(), 'deft-setup-occupied-'));
  const savedMarkerDir = setupTokenUseStore.dir;
  setupTokenUseStore.dir = join(volume, 'uploads', '.setup-token-used');
  const markerDir = setupTokenUseStore.dir;

  t.after(async () => {
    await closeDb();
    if (savedOptions === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = savedOptions;
    setHostedEnv(savedHosted);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    setupTokenUseStore.dir = savedMarkerDir;
    await rm(volume, { recursive: true, force: true });
  });

  function setHostedEnv(values: Record<string, string | undefined>) {
    for (const key of HOSTED_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  /** The install restarted with this token's hash as its setup token, valid for an hour. */
  function runWithToken(token: string) {
    setHostedEnv({ DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: sha256(token), DEFT_SETUP_TOKEN_EXPIRES_AT: inOneHour() });
  }
  const markers = async () => {
    try { return (await readdir(markerDir)).sort(); } catch { return []; }
  };
  let people = 0;
  const person = (extra: Record<string, unknown> = {}) => {
    people += 1;
    return {
      name: `Person ${people}`,
      email: `person-${people}-${schema}@signup.test`,
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
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json };
  }
  const count = async (query: string) => (await admin.query<{ n: number }>(query)).rows[0]!.n;
  const orgCount = () => count(`SELECT count(*)::int AS n FROM "${schema}".orgs`);
  const ownerCount = () => count(`SELECT count(*)::int AS n FROM "${schema}".org_members WHERE role = 'owner'`);
  const humanCount = () => count(`SELECT count(*)::int AS n FROM "${schema}".users WHERE password_hash IS NOT NULL`);
  const owners = async () => (await admin.query(`SELECT user_id, org_id FROM "${schema}".org_members WHERE role = 'owner' ORDER BY user_id`)).rows;

  /** The install as each row starts it: empty, then claimed by its first owner with the original setup token. */
  async function occupiedInstall() {
    await admin.query(`TRUNCATE ${TABLES.map((table) => `"${schema}".${table}`).join(', ')}`);
    await rm(markerDir, { recursive: true, force: true });
    const original = newToken();
    runWithToken(original);
    const first = await signup(person({ setup_token: original }));
    assert.equal(first.status, 201, `the first owner claims the install: ${first.text}`);
    assert.deepEqual([await orgCount(), await ownerCount(), await humanCount()], [1, 1, 1]);
    return { original, owner: await owners() };
  }

  /** A signup with `token` is refused, and the install still has its one organisation, owner and person. */
  async function assertRefusedAndUnchanged(label: string, token: string, owner: unknown, body: Record<string, unknown> = {}) {
    const before = await markers();
    const res = await signup(person({ setup_token: token, ...body }));
    assert.equal(res.status, 403, `${label}: refused: ${res.text}`);
    assert.ok(['SINGLE_ORG_LIMIT', 'SETUP_TOKEN_INVALID'].includes(res.json.code), `${label}: refused as a setup or single-workspace refusal: ${res.text}`);
    assert.ok(!res.json.accessToken && !res.json.refreshToken && !res.json.two_step, `${label}: no session and no enrolment`);
    assert.equal(await orgCount(), 1, `${label}: no second organisation`);
    assert.equal(await ownerCount(), 1, `${label}: no second owner`);
    assert.equal(await humanCount(), 1, `${label}: no second person`);
    assert.deepEqual(await owners(), owner, `${label}: the owner is the original one`);
    assert.deepEqual(await markers(), before, `${label}: the refused signup used up no token`);
    return res;
  }

  await t.test('row 12: restarted with a fresh token hash (its marker unused), signup with the new token is refused', async () => {
    const { owner } = await occupiedInstall();
    const fresh = newToken();
    runWithToken(fresh);
    const refused = await assertRefusedAndUnchanged('row 12', fresh, owner);
    assert.equal(refused.json.code, 'SINGLE_ORG_LIMIT', 'refused because the install already has its workspace');
    // The same new token again: still refused.
    await assertRefusedAndUnchanged('row 12, again', fresh, owner);
  });

  await t.test('row 12: the uploads volume was also replaced (no markers at all), and the fresh token is still refused', async () => {
    const { owner } = await occupiedInstall();
    await rm(markerDir, { recursive: true, force: true });
    const fresh = newToken();
    runWithToken(fresh);
    await assertRefusedAndUnchanged('row 12, no markers', fresh, owner);
  });

  await t.test('row 13: only the stored hash is replaced, the owner kept; the token for the replacement hash is refused', async () => {
    const { original, owner } = await occupiedInstall();
    const replacement = newToken();
    // Only DEFT_SETUP_TOKEN_SHA256 changes; the expiry and everything else stay as they were.
    const expiry = process.env.DEFT_SETUP_TOKEN_EXPIRES_AT;
    process.env.DEFT_SETUP_TOKEN_SHA256 = sha256(replacement);
    assert.equal(process.env.DEFT_SETUP_TOKEN_EXPIRES_AT, expiry);
    await assertRefusedAndUnchanged('row 13', replacement, owner);
    // The original token no longer matches the stored hash either.
    await assertRefusedAndUnchanged('row 13, original token', original, owner);
  });

  await t.test('rows 12 and 13: several signups at once with the new valid token all fail', async () => {
    const { owner } = await occupiedInstall();
    const fresh = newToken();
    runWithToken(fresh);
    const results = await Promise.all(Array.from({ length: 4 }, () => signup(person({ setup_token: fresh }))));
    assert.deepEqual(results.map((res) => res.status), [403, 403, 403, 403], results.map((res) => res.text).join('\n'));
    assert.deepEqual([await orgCount(), await ownerCount(), await humanCount()], [1, 1, 1]);
    assert.deepEqual(await owners(), owner);
  });
});
