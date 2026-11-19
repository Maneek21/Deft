/**
 * First-workspace signup: POST /api/auth/signup decides who owns a fresh
 * install.
 *
 *   - Hosted mode (DEFT_HOSTED=true): the one-time setup token is required,
 *     and every refusal looks the same. The token works once: its use is
 *     recorded as a marker on the uploads volume, so it stays used even when
 *     the database is lost or emptied.
 *   - Self-hosted mode (DEFT_HOSTED unset or "false"): no token, as before.
 *   - Both modes: the "no workspace yet" check and the creation of the first
 *     user, org and owner membership are one locked transaction, so signups
 *     arriving together produce exactly one workspace, and a signup that
 *     fails part-way leaves nothing behind.
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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';
import { ensureTwoStepTables } from './fixtures/two-step-tables.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
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
type HostedEnv = Partial<Record<(typeof HOSTED_KEYS)[number], string>>;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const TOKEN = randomBytes(32).toString('base64url');
const HASH = sha256(TOKEN);
const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();
const oneMinuteAgo = () => new Date(Date.now() - 60_000).toISOString();
const SETUP_REFUSAL = {
  // Check 12.2.9: every refusal says what happened and what to do next.
  error: "This setup link can't be used. It may be incomplete, expired, already used, or for a different workspace. "
    + 'To get a new link, reply to the email your setup link came in.',
  code: 'SETUP_TOKEN_INVALID',
};
const SETUP_UNAVAILABLE = {
  error: 'The workspace could not be created right now. Try the setup link again in a few minutes.',
  code: 'SETUP_UNAVAILABLE',
};

test('first-workspace signup: setup token in hosted mode, one workspace under concurrency', { skip: !safe, timeout: 180_000 }, async (t) => {
  const schema = `signup_setup_${randomUUID().replaceAll('-', '')}`;
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
  const volume = await mkdtemp(join(tmpdir(), 'deft-signup-volume-'));
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
  /**
   * A fresh, empty install running with exactly these hosted settings. With
   * keepVolume the uploads volume (and so any marker) survives: that is a
   * database lost or replaced by an empty one.
   */
  async function freshInstall(values: HostedEnv, { keepVolume = false } = {}) {
    await admin.query(`TRUNCATE ${TABLES.map((table) => `"${schema}".${table}`).join(', ')}`);
    if (!keepVolume) await rm(markerDir, { recursive: true, force: true });
    setHostedEnv(values);
  }
  /** The marker files on the uploads volume. */
  const markers = async () => {
    try { return await readdir(markerDir); } catch { return []; }
  };
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
    // An unhandled failure answers 500 with a plain-text body.
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json };
  }
  const count = async (sql: string) => (await admin.query<{ n: number }>(sql)).rows[0]!.n;
  const orgCount = () => count(`SELECT count(*)::int AS n FROM "${schema}".orgs`);
  const ownerCount = () => count(`SELECT count(*)::int AS n FROM "${schema}".org_members WHERE role = 'owner'`);
  const humanCount = () => count(`SELECT count(*)::int AS n FROM "${schema}".users WHERE password_hash IS NOT NULL`);
  /** No row in any table signup writes to. */
  async function assertNothingCreated(label: string) {
    for (const table of TABLES) {
      assert.equal(await count(`SELECT count(*)::int AS n FROM "${schema}".${table}`), 0, `${label}: no row in ${table}`);
    }
  }

  // The key lockFirstWorkspaceCreation takes (apps/api/src/lib/single-org-guard.ts).
  // If the two drift apart, the lock test below times out waiting.
  const LOCK_KEY = 'deft.first_workspace_creation.v1';
  /** Sessions in this database waiting for the first-workspace lock. */
  const waitingForLock = () => count(`
    SELECT count(*)::int AS n
    FROM pg_locks l, (SELECT hashtextextended('${LOCK_KEY}', 0) AS k) key
    WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND l.classid::bigint = ((key.k >> 32) & 4294967295) AND l.objid::bigint = (key.k & 4294967295)`);
  async function untilWaitingForLock() {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if ((await waitingForLock()) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('the signup never waited for the first-workspace lock');
  }

  await t.test('the route runs against the empty copies, not the shared tables', async () => {
    await freshInstall({});
    const res = await app.request('/api/auth/has-workspace');
    assert.deepEqual(await res.json(), { hasWorkspace: false });
  });

  await t.test('self-hosted: the first signup needs no token and becomes the owner; the next is refused', async () => {
    await freshInstall({});
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

  // A mistyped switch ("1", "TRUE", …) or a setup-token setting without
  // hosted mode never gets this far: the API refuses to start
  // (hosted-settings.test.ts). So self-hosted here means unset or "false".
  await t.test('self-hosted: DEFT_HOSTED=false needs no token, and a token in the body is ignored', async () => {
    for (const hosted of [undefined, 'false']) {
      await freshInstall(hosted === undefined ? {} : { DEFT_HOSTED: hosted });
      const res = await signup(person({ setup_token: 'ignored when not hosted' }));
      assert.equal(res.status, 201, `DEFT_HOSTED=${hosted}: ${res.text}`);
      assert.equal(await orgCount(), 1);
    }
  });

  await t.test('hosted: the right token succeeds once; a second signup is refused', async () => {
    await freshInstall({ DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: inOneHour() });
    const first = await signup(person({ setup_token: TOKEN }));
    assert.equal(first.status, 201, first.text);
    // A hosted owner must set up two-step verification first: no session yet,
    // only the enrol-only token.
    assert.ok(!first.json.accessToken && !first.json.refreshToken, 'no session before two-step setup');
    assert.equal(first.json.two_step?.status, 'enrolment_required');
    assert.ok(!first.text.includes(TOKEN) && !first.text.includes(HASH), 'the reply carries neither token nor hash');
    assert.equal(await orgCount(), 1);
    assert.equal(await ownerCount(), 1);

    assert.deepEqual(await markers(), [HASH], 'the token is marked used, by its hash');

    const again = await signup(person({ setup_token: TOKEN }));
    assert.equal(again.status, 403);
    assert.deepEqual(again.json, SETUP_REFUSAL, 'the replay is refused as a bad link');
    const withoutToken = await signup(person());
    assert.equal(withoutToken.status, 403);
    assert.equal(await orgCount(), 1);
    assert.equal(await ownerCount(), 1);
    assert.equal(await humanCount(), 1);
  });

  await t.test('hosted: wrong, expired and missing tokens and a missing hash are refused alike', async () => {
    const configured = { DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: inOneHour() };
    const cases: Array<[string, HostedEnv, Record<string, unknown>]> = [
      ['wrong token', configured, { setup_token: randomBytes(32).toString('base64url') }],
      ['near-miss token', configured, { setup_token: `${TOKEN.slice(0, -1)}${TOKEN.endsWith('A') ? 'B' : 'A'}` }],
      ['the hash presented as the token', configured, { setup_token: HASH }],
      ['expired token', { ...configured, DEFT_SETUP_TOKEN_EXPIRES_AT: oneMinuteAgo() }, { setup_token: TOKEN }],
      ['missing token', configured, {}],
      ['empty token', configured, { setup_token: '' }],
      ['token of the wrong type', configured, { setup_token: 12345 }],
      ['oversized token', configured, { setup_token: 'x'.repeat(10_000) }],
      ['missing hash', { DEFT_HOSTED: 'true' }, { setup_token: TOKEN }],
      ['missing hash and token', { DEFT_HOSTED: 'true' }, {}],
      ['hash without expiry', { DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: HASH }, { setup_token: TOKEN }],
      ['malformed hash', { ...configured, DEFT_SETUP_TOKEN_SHA256: HASH.toUpperCase() }, { setup_token: TOKEN }],
    ];
    for (const [label, values, extra] of cases) {
      await freshInstall(values);
      const res = await signup(person(extra));
      assert.equal(res.status, 403, `${label}: ${res.text}`);
      assert.deepEqual(res.json, SETUP_REFUSAL, `${label}: one refusal for every cause`);
      await assertNothingCreated(label);
    }

    // The same install still accepts the right token afterwards.
    await freshInstall(configured);
    assert.equal((await signup(person({ setup_token: 'wrong' }))).status, 403);
    assert.equal((await signup(person({ setup_token: TOKEN }))).status, 201);
    assert.equal(await orgCount(), 1);
  });

  await t.test('hosted: the token is never read from the address', async () => {
    await freshInstall({ DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: inOneHour() });
    const res = await app.request(`/api/auth/signup?setup_token=${TOKEN}&setup=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Token': TOKEN },
      body: JSON.stringify(person()),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SETUP_REFUSAL);
    await assertNothingCreated('token in the query string');
  });

  await t.test('hosted: has-workspace reveals neither the token nor its hash', async () => {
    await freshInstall({ DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: inOneHour() });
    const before = await app.request('/api/auth/has-workspace');
    assert.deepEqual(JSON.parse(await before.text()), { hasWorkspace: false });
    assert.equal((await signup(person({ setup_token: TOKEN }))).status, 201);
    const after = await app.request('/api/auth/has-workspace');
    assert.deepEqual(JSON.parse(await after.text()), { hasWorkspace: true });
  });

  await t.test('hosted: a signup that fails part-way leaves nothing behind and does not use up the token', async () => {
    await freshInstall({ DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: inOneHour() });
    // Make one insert fail after the user, org and owner membership rows exist
    // inside the transaction: first the last insert, then the first-space insert.
    for (const table of ['onboarding_state', 'spaces']) {
      await admin.query(`ALTER TABLE "${schema}".${table} ADD CONSTRAINT forced_failure CHECK (false) NOT VALID`);
      try {
        const failed = await signup(person({ setup_token: TOKEN }));
        assert.equal(failed.status, 500, `${table}: ${failed.text}`);
        assert.ok(!failed.text.includes(TOKEN) && !failed.text.includes(HASH), 'the failure reply carries neither token nor hash');
        await assertNothingCreated(`insert into ${table} failed`);
        assert.deepEqual(await markers(), [], `${table}: the token is not used up`);
      } finally {
        await admin.query(`ALTER TABLE "${schema}".${table} DROP CONSTRAINT forced_failure`);
      }
    }

    const retry = await signup(person({ setup_token: TOKEN }));
    assert.equal(retry.status, 201, retry.text);
    assert.equal(await orgCount(), 1);
    assert.equal(await ownerCount(), 1);
    assert.equal(await humanCount(), 1);
    const owners = await admin.query(`SELECT user_id, org_id FROM "${schema}".org_members WHERE role = 'owner'`);
    assert.deepEqual(owners.rows, [{ user_id: retry.json.user.id, org_id: retry.json.org.id }]);
    assert.deepEqual(await markers(), [HASH]);
  });

  await t.test('hosted: a refused request does not use up the token', async () => {
    await freshInstall({ DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: inOneHour() });
    // Invalid input with the right token, then a corrected retry, as the page
    // does after a failed request (#546 keeps the token for that retry).
    for (const body of [
      { ...person({ setup_token: TOKEN }), name: '' },
      { ...person({ setup_token: TOKEN }), email: 'not an email' },
      { ...person({ setup_token: TOKEN }), password: 'short' },
    ]) {
      const res = await signup(body);
      assert.equal(res.status, 400, res.text);
      await assertNothingCreated('invalid input');
      assert.deepEqual(await markers(), [], 'invalid input leaves the token unused');
    }
    const wrong = await signup(person({ setup_token: 'wrong' }));
    assert.equal(wrong.status, 403);
    assert.deepEqual(await markers(), [], 'a wrong token marks nothing');

    const retry = await signup(person({ setup_token: TOKEN }));
    assert.equal(retry.status, 201, retry.text);
    assert.deepEqual(await markers(), [HASH]);
  });

  await t.test('hosted: after the database is lost, the used link cannot claim the empty install', async () => {
    const settings = { DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: inOneHour() };
    await freshInstall(settings);
    assert.equal((await signup(person({ setup_token: TOKEN }))).status, 201);

    // The database comes back empty; the uploads volume, with the marker, survives.
    await freshInstall(settings, { keepVolume: true });
    assert.deepEqual(await markers(), [HASH]);
    const has = await app.request('/api/auth/has-workspace');
    assert.deepEqual(await has.json(), { hasWorkspace: false }, 'the database really is empty');
    const replay = await signup(person({ setup_token: TOKEN }));
    assert.equal(replay.status, 403, replay.text);
    assert.deepEqual(replay.json, SETUP_REFUSAL);
    await assertNothingCreated('replay into an empty database');

    // A fresh link from the hosting layer (a new hash) works on the same volume.
    const fresh = randomBytes(32).toString('base64url');
    await freshInstall({ ...settings, DEFT_SETUP_TOKEN_SHA256: sha256(fresh) }, { keepVolume: true });
    const claimed = await signup(person({ setup_token: fresh }));
    assert.equal(claimed.status, 201, claimed.text);
    assert.deepEqual((await markers()).sort(), [HASH, sha256(fresh)].sort());
  });

  /** Hold the first-workspace lock, start a signup that waits for it, run `meanwhile`, release. */
  async function whileSignupWaits(body: unknown, meanwhile: () => Promise<void>) {
    const holder = new pg.Client({ connectionString: target });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [LOCK_KEY]);
      const waiter = signup(body);
      await untilWaitingForLock();
      await meanwhile();
      await holder.query('COMMIT');
      return await waiter;
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
  }

  await t.test('hosted: when the use cannot be recorded or checked, the signup is refused and nothing is created', async () => {
    const settings = { DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: inOneHour() };

    // 1. The marker cannot be written. The check passes (no marker yet); then,
    //    while the signup waits for the lock, a regular file takes the marker
    //    directory's place, so the write inside the transaction fails after
    //    every row was inserted.
    await freshInstall(settings);
    try {
      const res = await whileSignupWaits(person({ setup_token: TOKEN }), async () => {
        await mkdir(dirname(markerDir), { recursive: true });
        await writeFile(markerDir, 'not a directory');
      });
      assert.equal(res.status, 503, res.text);
      assert.deepEqual(res.json, SETUP_UNAVAILABLE);
      assert.ok(!res.text.includes(TOKEN) && !res.text.includes(HASH), 'the reply carries neither token nor hash');
      await assertNothingCreated('marker write failed');
    } finally {
      await rm(markerDir, { force: true });
    }

    // 2. The check itself cannot answer (Linux, where cells run, reports
    //    ENOTDIR here; Windows reports ENOENT, so this part is Linux-only).
    if (process.platform !== 'win32') {
      await freshInstall(settings);
      await mkdir(dirname(markerDir), { recursive: true });
      await writeFile(markerDir, 'not a directory');
      try {
        const res = await signup(person({ setup_token: TOKEN }));
        assert.equal(res.status, 503, res.text);
        assert.deepEqual(res.json, SETUP_UNAVAILABLE);
        await assertNothingCreated('marker check failed');
      } finally {
        await rm(markerDir, { force: true });
      }
    }

    // Once the volume works again, the same token still claims the install.
    await freshInstall(settings);
    const retry = await signup(person({ setup_token: TOKEN }));
    assert.equal(retry.status, 201, retry.text);
    assert.equal(await ownerCount(), 1);
    assert.deepEqual(await markers(), [HASH]);
  });

  await t.test('hosted: a marker made while the signup waited for the lock refuses it and creates nothing', async () => {
    await freshInstall({ DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: inOneHour() });
    const res = await whileSignupWaits(person({ setup_token: TOKEN }), async () => {
      await mkdir(markerDir, { recursive: true });
      await writeFile(join(markerDir, HASH), 'used elsewhere');
    });
    assert.equal(res.status, 403, res.text);
    assert.deepEqual(res.json, SETUP_REFUSAL);
    await assertNothingCreated('marker appeared while waiting');
    assert.deepEqual(await markers(), [HASH]);
  });

  await t.test('a signup waits for the first-workspace lock and then acts on what the holder left', async () => {
    const scenarios = [
      { label: 'holder creates nothing and commits', rival: false, end: 'COMMIT', status: 201 },
      { label: 'holder creates a workspace and rolls back', rival: true, end: 'ROLLBACK', status: 201 },
      { label: 'holder creates a workspace and commits', rival: true, end: 'COMMIT', status: 403 },
    ];
    for (const { label, rival, end, status } of scenarios) {
      await freshInstall({});
      const holder = new pg.Client({ connectionString: target });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [LOCK_KEY]);
        if (rival) {
          await holder.query(`INSERT INTO "${schema}".orgs (id, name, slug) VALUES ($1, 'Rival workspace', $2)`,
            [randomUUID(), `rival-${randomUUID()}`]);
        }

        let settled = false;
        const waiter = signup(person()).finally(() => { settled = true; });
        await untilWaitingForLock();
        assert.equal(settled, false, `${label}: the signup is waiting, not answered`);
        assert.equal(await humanCount(), 0, `${label}: nothing is created while it waits`);

        await holder.query(end);
        const res = await waiter;
        assert.equal(res.status, status, `${label}: ${res.text}`);
        assert.equal(await waitingForLock(), 0, `${label}: nobody is left waiting`);
        assert.equal(await orgCount(), 1, `${label}: exactly one workspace`);
        if (status === 201) {
          const owners = await admin.query(`SELECT user_id, org_id FROM "${schema}".org_members WHERE role = 'owner'`);
          assert.deepEqual(owners.rows, [{ user_id: res.json.user.id, org_id: res.json.org.id }], label);
          assert.equal(await humanCount(), 1, label);
        } else {
          assert.equal(res.json.code, 'SINGLE_ORG_LIMIT', label);
          assert.equal(await humanCount(), 0, `${label}: the refused signup leaves no user behind`);
          assert.equal(await ownerCount(), 0, `${label}: and no owner`);
        }
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
    }
  });

  await t.test('self-hosted: signups arriving together create exactly one workspace', async () => {
    await freshInstall({});
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

  await t.test('hosted: signups arriving together with the right token create exactly one workspace', async () => {
    await freshInstall({ DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: inOneHour() });
    const results = await Promise.all(Array.from({ length: 4 }, () => signup(person({ setup_token: TOKEN }))));
    assert.deepEqual(results.map((res) => res.status).sort(), [201, 403, 403, 403]);
    assert.equal(await orgCount(), 1);
    assert.equal(await ownerCount(), 1);
    assert.equal(await humanCount(), 1);
    assert.deepEqual(await markers(), [HASH], 'one marker, written by the one signup that succeeded');
  });
});
