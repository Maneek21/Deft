/**
 * First-workspace signup: POST /api/auth/signup decides who owns a fresh
 * install.
 *
 *   - Hosted mode (DEFT_HOSTED=true): the one-time setup token is required,
 *     and every refusal looks the same.
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
const HOSTED_KEYS = ['DEFT_HOSTED', 'DEFT_SETUP_TOKEN_SHA256', 'DEFT_SETUP_TOKEN_EXPIRES_AT'] as const;
type HostedEnv = Partial<Record<(typeof HOSTED_KEYS)[number], string>>;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const TOKEN = randomBytes(32).toString('base64url');
const HASH = sha256(TOKEN);
const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();
const oneMinuteAgo = () => new Date(Date.now() - 60_000).toISOString();
const SETUP_REFUSAL = {
  error: 'This workspace can only be created from its setup link. The link is missing, incorrect, or has expired.',
  code: 'SETUP_TOKEN_INVALID',
};

test('first-workspace signup: setup token in hosted mode, one workspace under concurrency', { skip: !safe, timeout: 180_000 }, async (t) => {
  const schema = `signup_setup_${randomUUID().replaceAll('-', '')}`;
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
  const app = new Hono().route('/api/auth', authRoutes);

  t.after(async () => {
    await closeDb();
    if (savedOptions === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = savedOptions;
    setHostedEnv(savedHosted);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  function setHostedEnv(values: Record<string, string | undefined>) {
    for (const key of HOSTED_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  /** A fresh, empty install running with exactly these hosted settings. */
  async function freshInstall(values: HostedEnv) {
    await admin.query(`TRUNCATE ${TABLES.map((table) => `"${schema}".${table}`).join(', ')}`);
    setHostedEnv(values);
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
    assert.ok(first.json.accessToken && first.json.refreshToken, 'a session is issued');
    assert.ok(!first.text.includes(TOKEN) && !first.text.includes(HASH), 'the reply carries neither token nor hash');
    assert.equal(await orgCount(), 1);
    assert.equal(await ownerCount(), 1);

    const again = await signup(person({ setup_token: TOKEN }));
    assert.equal(again.status, 403);
    assert.equal(again.json.code, 'SINGLE_ORG_LIMIT');
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
  });
});
