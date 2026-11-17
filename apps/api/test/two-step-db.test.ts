/**
 * Two-step verification and recovery codes, against a real database.
 *
 * Run: DEFT_TEST_DATABASE_URL=<disposable test db> pnpm --filter @deft/api test test/two-step-db.test.ts
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Hono } from 'hono';
import pg from 'pg';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { isSafeTestDatabaseTarget } from './fixtures/safe-test-database-target.js';
import { ensureTwoStepTables } from './fixtures/two-step-tables.js';

const databaseUrl = isSafeTestDatabaseTarget(process.env.DEFT_TEST_DATABASE_URL, process.env.DATABASE_URL);
const PASSWORD = 'Two-step-regression-2026!';

type Json = Record<string, any>;

test('two-step verification', { skip: !databaseUrl && 'needs DEFT_TEST_DATABASE_URL = DATABASE_URL on a disposable test database' }, async (t) => {
  const hostedBefore = process.env.DEFT_HOSTED;
  delete process.env.DEFT_HOSTED;
  await ensureTwoStepTables(databaseUrl!);

  // Signup only runs on an install with no workspace. This database has
  // workspaces, so the count is the one thing faked, and only when asked.
  let pretendEmptyInstall = false;
  const guard = await import('../src/lib/single-org-guard.js');
  mock.module(new URL('../src/lib/single-org-guard.ts', import.meta.url).href, {
    namedExports: { ...guard, countOrgs: async () => (pretendEmptyInstall ? 0 : guard.countOrgs()) },
  });

  const { db, closeDb } = await import('../src/lib/db.js');
  const { env } = await import('../src/lib/env.js');
  const { users, orgs, orgMembers, invites, webSessions, agentEmployees } = await import('@deft/db/schema');
  const { userTwoStep, userTwoStepRecoveryCodes, twoStepChallenges } = await import('@deft/db/two-step');
  const { authRoutes } = await import('../src/routes/auth.js');
  const { twoStepRoutes } = await import('../src/routes/two-step.js');
  const { inviteRoutes } = await import('../src/routes/invites.js');
  const { memberRoutes } = await import('../src/routes/members.js');
  const { agentEmployeeRoutes } = await import('../src/routes/agent-employees.js');
  const { authMiddleware } = await import('../src/middleware/auth.js');
  const { createWebSession, verifyWebAccess, rotateWebSession, WebCredentialsChangedError } = await import('../src/lib/web-sessions.js');
  const { issueSession } = await import('../src/lib/session-issuance.js');
  const { SecondStepRequiredError } = await import('../src/lib/two-step-policy.js');
  const { twoStepCodeForStep, twoStepStepAt, hashRecoveryCode } = await import('../src/lib/two-step.js');
  const { decrypt } = await import('../src/lib/encryption.js');
  const service = await import('../src/lib/two-step-service.js');

  t.after(async () => {
    if (hostedBefore === undefined) delete process.env.DEFT_HOSTED; else process.env.DEFT_HOSTED = hostedBefore;
    mock.restoreAll();
    await closeDb();
  });

  // Mounted the way index.ts mounts them.
  const app = new Hono();
  app.route('/api/auth/two-step', twoStepRoutes);
  app.route('/api/auth', authRoutes);
  app.route('/api/invites', inviteRoutes);
  app.use('/api/*', authMiddleware);
  app.get('/api/probe', (c) => c.json({ ok: true, role: c.get('user').role }));
  app.route('/api/members', memberRoutes);
  app.route('/api/agent-employees', agentEmployeeRoutes);

  const call = async (method: string, path: string, body?: unknown, bearer?: string, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: Json = {};
    try { json = JSON.parse(text) as Json; } catch { /* not JSON */ }
    return { status: res.status, json, headers: res.headers };
  };
  const post = (path: string, body?: unknown, bearer?: string, headers?: Record<string, string>) => call('POST', path, body ?? {}, bearer, headers);
  const probe = (bearer: string) => call('GET', '/api/probe', undefined, bearer);
  const hosted = (on: boolean | string) => {
    if (on === false) delete process.env.DEFT_HOSTED; else process.env.DEFT_HOSTED = on === true ? 'true' : on;
  };

  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const orgId = randomUUID();
  await db.insert(orgs).values({ id: orgId, name: 'Two-step regression', slug: `two-step-${orgId}` });

  async function person(role: 'owner' | 'admin' | 'member' | 'guest', org = orgId) {
    const id = randomUUID();
    const email = `two-step-${id}@test.local`;
    await db.insert(users).values({ id, name: `Two-step ${role}`, email, email_verified: true, password_hash: passwordHash });
    await db.insert(orgMembers).values({ org_id: org, user_id: id, role });
    return { id, email, org_id: org };
  }
  const login = (email: string, password = PASSWORD) => post('/api/auth/login', { email, password });
  const codeFor = (secret: string, drift = 0) => twoStepCodeForStep(secret, twoStepStepAt(Date.now()) + drift);
  /** Lets a test use a second code inside the same 30 seconds. Not used where replay is the subject. */
  const forgetUsedStep = (userId: string) => db.update(userTwoStep).set({ last_used_step: 0 }).where(eq(userTwoStep.user_id, userId));
  const wrongCode = (secret: string) => {
    const near = new Set([-1, 0, 1].map((drift) => codeFor(secret, drift)));
    let code = '000000';
    while (near.has(code)) code = String(Number(code) + 1).padStart(6, '0');
    return code;
  };

  /** Enrols through the HTTP routes with whatever bearer the person holds. */
  async function enrol(bearer: string, refreshToken?: string) {
    // A signed-in person also gives their password; an enrol-only token does not.
    const started = await post('/api/auth/two-step/enrol/start', bearer.startsWith('tsc_') ? {} : { current_password: PASSWORD }, bearer);
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const secret = started.json.secret as string;
    const confirmed = await post('/api/auth/two-step/enrol/confirm', { code: codeFor(secret) }, bearer);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
    // A signed-in caller keeps its session and gets no new tokens; the holder
    // of an enrol-only token gets a session issued now.
    const enrolOnly = bearer.startsWith('tsc_');
    assert.equal(Boolean(confirmed.json.accessToken), enrolOnly);
    const session = enrolOnly ? confirmed.json : { ...confirmed.json, accessToken: bearer, refreshToken };
    return { secret, started: started.json, confirmed: session, recoveryCodes: confirmed.json.recovery_codes as string[] };
  }
  /** A member who has two-step verification, plus a signed-in session. */
  async function enrolledPerson(role: 'owner' | 'admin' | 'member' = 'member') {
    const who = await person(role);
    const first = await login(who.email);
    const bearer = (first.json.accessToken ?? first.json.two_step?.token) as string;
    const enrolment = await enrol(bearer, first.json.refreshToken);
    await forgetUsedStep(who.id);
    return { ...who, ...enrolment, accessToken: enrolment.confirmed.accessToken as string, refreshToken: enrolment.confirmed.refreshToken as string };
  }
  async function loginWithCode(who: { id: string; email: string; secret: string }) {
    const first = await login(who.email);
    assert.equal(first.json.two_step?.status, 'code_required');
    const second = await post('/api/auth/two-step/verify', { challenge_token: first.json.two_step.token, code: codeFor(who.secret) });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    await forgetUsedStep(who.id);
    return second.json as { accessToken: string; refreshToken: string };
  }

  // ── Self-hosted: available to anyone, required of nobody ─────────────────

  await t.test('self-hosted: nobody is required to enrol, whatever their role', async () => {
    for (const value of [false, '1', 'TRUE', 'yes', ' true'] as const) {
      hosted(value);
      for (const role of ['owner', 'admin', 'member', 'guest'] as const) {
        const who = await person(role);
        const res = await login(who.email);
        assert.equal(res.status, 200);
        assert.equal(res.json.two_step, undefined, `${role} with DEFT_HOSTED=${String(value)}`);
        assert.equal((await probe(res.json.accessToken)).status, 200);
        const status = await call('GET', '/api/auth/two-step', undefined, res.json.accessToken);
        assert.deepEqual(status.json, { enabled: false, confirmed_at: null, recovery_codes_remaining: 0, required: false, can_disable: false });
      }
    }
    hosted(false);
  });

  await t.test('enrolment: secret and otpauth address once, recovery codes once, nothing stored in the clear', async () => {
    const who = await person('member');
    const before = (await login(who.email)).json;
    const other = (await login(who.email)).json;
    const { secret, started, recoveryCodes, confirmed } = await enrol(before.accessToken, before.refreshToken);

    assert.match(secret, /^[A-Z2-7]{32}$/);
    const otpauth = new URL(started.otpauth_url);
    assert.equal(otpauth.protocol, 'otpauth:');
    assert.equal(otpauth.searchParams.get('secret'), secret);
    assert.equal(decodeURIComponent(otpauth.pathname), `/Deft:${who.email}`);

    assert.equal(recoveryCodes.length, 10);
    assert.equal(new Set(recoveryCodes).size, 10);

    const [row] = await db.select().from(userTwoStep).where(eq(userTwoStep.user_id, who.id));
    assert.ok(row?.confirmed_at);
    assert.equal(row.pending_secret_encrypted, null);
    assert.ok(row.secret_encrypted && !row.secret_encrypted.includes(secret), 'the secret is stored encrypted');
    assert.equal(decrypt(row.secret_encrypted), secret);
    const stored = await db.select().from(userTwoStepRecoveryCodes).where(eq(userTwoStepRecoveryCodes.user_id, who.id));
    assert.deepEqual(stored.map((code) => code.code_hash).sort(), recoveryCodes.map((code) => hashRecoveryCode(code)!).sort());
    for (const code of recoveryCodes) assert.ok(!JSON.stringify(stored).includes(code), 'recovery codes are stored only as hashes');

    // Every other session never saw a code: they end. The session that
    // enrolled (password and code) continues, and keeps refreshing, so other
    // tabs using it are not signed out while this one shows the codes.
    assert.equal((await probe(other.accessToken)).status, 401);
    assert.equal((await post('/api/auth/refresh', { refreshToken: other.refreshToken })).status, 401);
    assert.equal(confirmed.accessToken, before.accessToken);
    assert.equal((await probe(before.accessToken)).status, 200);
    const refreshed = await post('/api/auth/refresh', { refreshToken: before.refreshToken });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
    assert.equal((await probe(refreshed.json.accessToken)).status, 200);

    const status = await call('GET', '/api/auth/two-step', undefined, confirmed.accessToken);
    assert.equal(status.json.enabled, true);
    assert.equal(status.json.recovery_codes_remaining, 10);
    assert.equal(status.json.can_disable, true);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.equal(JSON.stringify(status.json).includes(secret), false, 'the secret is never shown again');
  });

  await t.test('enrolment needs a right code, and an enrolled person must prove the second step to replace it', async () => {
    const who = await person('member');
    const session = (await login(who.email)).json;
    // A signed-in session alone cannot add an authenticator: the password is needed too.
    for (const body of [{}, { current_password: 'not-the-password' }]) {
      const refused = await post('/api/auth/two-step/enrol/start', body, session.accessToken);
      assert.equal(refused.status, 403);
      assert.equal(refused.json.code, 'INVALID_CREDENTIALS');
    }
    assert.equal((await db.select().from(userTwoStep).where(eq(userTwoStep.user_id, who.id))).length, 0, 'nothing stored');
    const started = await post('/api/auth/two-step/enrol/start', { current_password: PASSWORD }, session.accessToken);
    const wrong = await post('/api/auth/two-step/enrol/confirm', { code: wrongCode(started.json.secret) }, session.accessToken);
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.code, 'TWO_STEP_CODE_INVALID');
    assert.equal((await login(who.email)).json.two_step, undefined, 'an unconfirmed secret requires nothing');
    assert.equal((await post('/api/auth/two-step/enrol/confirm', { code: '12' }, session.accessToken)).status, 400);
    assert.equal((await post('/api/auth/two-step/enrol/start', {})).status, 401);

    const enrolled = await enrolledPerson();
    const bare = await post('/api/auth/two-step/enrol/start', {}, enrolled.accessToken);
    assert.equal(bare.status, 403);
    assert.equal(bare.json.code, 'TWO_STEP_CODE_REQUIRED');
    const replaced = await post('/api/auth/two-step/enrol/start', { code: codeFor(enrolled.secret) }, enrolled.accessToken);
    assert.equal(replaced.status, 200);
    assert.notEqual(replaced.json.secret, enrolled.secret);
    // Until the new authenticator is confirmed the old one stays in force.
    await forgetUsedStep(enrolled.id);
    await loginWithCode(enrolled);
  });

  // ── Login: a correct password alone gives no session ─────────────────────

  await t.test('a correct password alone gives an enrolled person a challenge, not a session', async () => {
    const who = await enrolledPerson();
    const first = await login(who.email);
    assert.equal(first.status, 200);
    assert.equal(first.json.accessToken, undefined);
    assert.equal(first.json.refreshToken, undefined);
    assert.equal(first.json.two_step.status, 'code_required');
    const challenge = first.json.two_step.token as string;
    assert.ok(new Date(first.json.two_step.expires_at).getTime() - Date.now() <= service.VERIFY_CHALLENGE_TTL_MS);

    // The challenge is single-purpose: it is not a session of any kind.
    assert.equal((await probe(challenge)).status, 401);
    assert.equal((await call('GET', '/api/auth/me', undefined, challenge)).status, 401);
    assert.equal((await post('/api/auth/refresh', { refreshToken: challenge })).status, 401);
    assert.equal((await call('GET', '/api/auth/two-step', undefined, challenge)).status, 401);
    assert.equal((await post('/api/auth/two-step/enrol/start', {}, challenge)).status, 401);
    await assert.rejects(() => verifyWebAccess(challenge));
    assert.equal((await db.select().from(webSessions).where(and(eq(webSessions.user_id, who.id), isNull(webSessions.revoked_at)))).length, 1,
      'only the session from enrolment exists; the password created none');

    for (const body of [{ challenge_token: challenge }, { challenge_token: challenge, code: codeFor(who.secret), recovery_code: who.recoveryCodes[0] }, { code: codeFor(who.secret) }]) {
      assert.equal((await post('/api/auth/two-step/verify', body)).status, 400);
    }
    const wrong = await post('/api/auth/two-step/verify', { challenge_token: challenge, code: wrongCode(who.secret) });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.code, 'TWO_STEP_CODE_INVALID');
    assert.equal(wrong.json.accessToken, undefined);

    const right = await post('/api/auth/two-step/verify', { challenge_token: challenge, code: codeFor(who.secret) });
    assert.equal(right.status, 200, JSON.stringify(right.json));
    assert.equal((await probe(right.json.accessToken)).status, 200);
    const rotated = await post('/api/auth/refresh', { refreshToken: right.json.refreshToken });
    assert.equal(rotated.status, 200, 'a session issued against a code refreshes normally');
    assert.equal((await probe(rotated.json.accessToken)).status, 200);
  });

  await t.test('a code cannot be replayed, and a challenge works once', async () => {
    const who = await enrolledPerson();
    const code = codeFor(who.secret);
    const first = await login(who.email);
    const used = await post('/api/auth/two-step/verify', { challenge_token: first.json.two_step.token, code });
    assert.equal(used.status, 200);

    // Same challenge again: it was used up.
    const again = await post('/api/auth/two-step/verify', { challenge_token: first.json.two_step.token, code: codeFor(who.secret, 1) });
    assert.equal(again.status, 401);
    assert.equal(again.json.code, 'TWO_STEP_CHALLENGE_INVALID');

    // Same code on a new login, still inside its 30 seconds: refused.
    const second = await login(who.email);
    const replay = await post('/api/auth/two-step/verify', { challenge_token: second.json.two_step.token, code });
    assert.equal(replay.status, 401);
    assert.equal(replay.json.code, 'TWO_STEP_CODE_INVALID');
    // An older step than the one already used is refused too.
    const older = await post('/api/auth/two-step/verify', { challenge_token: second.json.two_step.token, code: codeFor(who.secret, -1) });
    assert.equal(older.status, 401);

    // Two requests racing with one fresh code: exactly one session.
    await db.update(userTwoStep).set({ last_used_step: 0, failed_attempts: 0, locked_until: null }).where(eq(userTwoStep.user_id, who.id));
    const [a, b] = [await login(who.email), await login(who.email)];
    const fresh = codeFor(who.secret);
    const race = await Promise.all([a, b].map((res) => post('/api/auth/two-step/verify', { challenge_token: res.json.two_step.token, code: fresh })));
    assert.deepEqual(race.map((res) => res.status).sort(), [200, 401]);
  });

  await t.test('replacing the authenticator with a recovery code ends every other session at once', async () => {
    const who = await enrolledPerson();
    const elsewhere = await loginWithCode(who);
    const started = await post('/api/auth/two-step/enrol/start', { recovery_code: who.recoveryCodes[0] }, who.accessToken);
    assert.equal(started.status, 200, JSON.stringify(started.json));
    // Not confirmed, yet the other session is over and this one continues.
    assert.equal((await probe(elsewhere.accessToken)).status, 401);
    assert.equal((await probe(who.accessToken)).status, 200);
    // A code from the current authenticator does not end anything.
    const again = await loginWithCode(who);
    assert.equal((await post('/api/auth/two-step/enrol/start', { code: codeFor(who.secret) }, who.accessToken)).status, 200);
    assert.equal((await probe(again.accessToken)).status, 200);
  });

  await t.test('enrolment confirmation re-checks the caller, and a session after a code is bound to the credentials it checked', async () => {
    // The session that started enrolment ended (say, a password reset) before confirmation.
    const who = await person('member');
    const session = (await login(who.email)).json;
    const started = await post('/api/auth/two-step/enrol/start', { current_password: PASSWORD }, session.accessToken);
    await db.update(webSessions).set({ revoked_at: new Date() }).where(eq(webSessions.user_id, who.id));
    assert.equal((await service.confirmTwoStepEnrolment(who.id, codeFor(started.json.secret), { sid: 'not-a-session' })).ok, false);
    const [anySession] = await db.select({ id: webSessions.id }).from(webSessions).where(eq(webSessions.user_id, who.id)).limit(1);
    const lost = await service.confirmTwoStepEnrolment(who.id, codeFor(started.json.secret), { sid: anySession!.id });
    assert.deepEqual(lost, { ok: false, reason: 'authority_lost' });
    assert.equal((await service.getTwoStepStatus(who.id)).enabled, false);

    // A code checked against an older password or authenticator gives no session.
    const enrolled = await enrolledPerson();
    const [current] = await db.select({ confirmed_at: userTwoStep.confirmed_at }).from(userTwoStep).where(eq(userTwoStep.user_id, enrolled.id));
    const [account] = await db.select({ password_version: users.password_version }).from(users).where(eq(users.id, enrolled.id));
    const identity = { id: enrolled.id, email: enrolled.email, org_id: orgId };
    const verified = (passwordVersion: number, confirmedAt: Date) => ({ secondStep: 'verified' as const, verified: { passwordVersion, confirmedAt } });
    await assert.rejects(() => createWebSession(identity, undefined, verified(account!.password_version - 1, current!.confirmed_at!)), WebCredentialsChangedError);
    await assert.rejects(() => createWebSession(identity, undefined, verified(account!.password_version, new Date(0))), WebCredentialsChangedError);
    await createWebSession(identity, undefined, verified(account!.password_version, current!.confirmed_at!));
  });

  await t.test('a recovery code works once and ends every other session', async () => {
    const who = await enrolledPerson();
    const elsewhere = await loginWithCode(who);
    assert.equal((await probe(who.accessToken)).status, 200);
    assert.equal((await probe(elsewhere.accessToken)).status, 200);

    const recovery = who.recoveryCodes[3]!;
    const first = await login(who.email);
    const typed = recovery.toLowerCase().replace(/-/g, ' ');
    const used = await post('/api/auth/two-step/verify', { challenge_token: first.json.two_step.token, recovery_code: typed });
    assert.equal(used.status, 200, JSON.stringify(used.json));
    assert.equal((await probe(used.json.accessToken)).status, 200);

    // Every other session of the person is over.
    assert.equal((await probe(who.accessToken)).status, 401);
    assert.equal((await probe(elsewhere.accessToken)).status, 401);
    assert.equal((await post('/api/auth/refresh', { refreshToken: elsewhere.refreshToken })).status, 401);
    const live = await db.select().from(webSessions).where(and(eq(webSessions.user_id, who.id), isNull(webSessions.revoked_at)));
    assert.equal(live.length, 1);

    const second = await login(who.email);
    const reused = await post('/api/auth/two-step/verify', { challenge_token: second.json.two_step.token, recovery_code: recovery });
    assert.equal(reused.status, 401);
    assert.equal(reused.json.code, 'TWO_STEP_CODE_INVALID');
    const another = await post('/api/auth/two-step/verify', { challenge_token: second.json.two_step.token, recovery_code: who.recoveryCodes[4] });
    assert.equal(another.status, 200);
    const status = await call('GET', '/api/auth/two-step', undefined, another.json.accessToken);
    assert.equal(status.json.recovery_codes_remaining, 8);
    // Someone else's recovery code is no use.
    const stranger = await enrolledPerson();
    const third = await login(who.email);
    assert.equal((await post('/api/auth/two-step/verify', { challenge_token: third.json.two_step.token, recovery_code: stranger.recoveryCodes[0] })).status, 401);
  });

  await t.test('regenerating recovery codes and turning it off both need a current code', async () => {
    const who = await enrolledPerson();
    for (const route of ['recovery-codes', 'disable']) {
      assert.equal((await post(`/api/auth/two-step/${route}`, { code: codeFor(who.secret) })).status, 401, 'needs a session');
      const wrong = await post(`/api/auth/two-step/${route}`, { code: wrongCode(who.secret) }, who.accessToken);
      assert.equal(wrong.status, 403);
      assert.equal(wrong.json.code, 'TWO_STEP_CODE_INVALID');
      assert.equal((await post(`/api/auth/two-step/${route}`, { code: who.recoveryCodes[0]!.replace(/-/g, '') }, who.accessToken)).status, 403, 'a recovery code is not a current code');
      assert.equal((await post(`/api/auth/two-step/${route}`, {}, who.accessToken)).status, 400);
    }
    await db.update(userTwoStep).set({ failed_attempts: 0, locked_until: null }).where(eq(userTwoStep.user_id, who.id));

    const regenerated = await post('/api/auth/two-step/recovery-codes', { code: codeFor(who.secret) }, who.accessToken);
    assert.equal(regenerated.status, 200);
    const fresh = regenerated.json.recovery_codes as string[];
    assert.equal(fresh.length, 10);
    assert.equal(fresh.some((code) => who.recoveryCodes.includes(code)), false);
    await forgetUsedStep(who.id);
    const first = await login(who.email);
    assert.equal((await post('/api/auth/two-step/verify', { challenge_token: first.json.two_step.token, recovery_code: who.recoveryCodes[1] })).status, 401, 'old recovery codes stop working');
    assert.equal((await post('/api/auth/two-step/verify', { challenge_token: first.json.two_step.token, recovery_code: fresh[0] })).status, 200);

    // Off: self-hosted, anyone may. Afterwards a password is enough again.
    const session = await loginWithCode(who);
    const off = await post('/api/auth/two-step/disable', { code: codeFor(who.secret) }, session.accessToken);
    assert.equal(off.status, 200, JSON.stringify(off.json));
    const [row] = await db.select().from(userTwoStep).where(eq(userTwoStep.user_id, who.id));
    assert.equal(row?.confirmed_at, null);
    assert.equal(row?.secret_encrypted, null);
    assert.equal((await db.select().from(userTwoStepRecoveryCodes).where(eq(userTwoStepRecoveryCodes.user_id, who.id))).length, 0);
    const plain = await login(who.email);
    assert.equal(plain.json.two_step, undefined);
    assert.equal((await probe(plain.json.accessToken)).status, 200);
  });

  // ── No side doors ────────────────────────────────────────────────────────

  await t.test('a password reset neither removes nor bypasses the second step', async () => {
    const who = await enrolledPerson();
    const [before] = await db.select().from(users).where(eq(users.id, who.id));
    const pending = await login(who.email);
    const resetToken = jwt.sign({ id: who.id, email: who.email, org_id: orgId, purpose: 'password-reset', password_version: before!.password_version }, env.JWT_SECRET, { expiresIn: '15m' });
    const newPassword = 'Reset-does-not-clear-2026!';
    const reset = await post('/api/auth/reset-password', { token: resetToken, password: newPassword });
    assert.equal(reset.status, 200);
    assert.equal(reset.json.accessToken, undefined, 'a reset issues no session');
    assert.equal(reset.json.two_step, undefined);

    const [row] = await db.select().from(userTwoStep).where(eq(userTwoStep.user_id, who.id));
    assert.ok(row?.confirmed_at, 'still enrolled');
    assert.equal(decrypt(row.secret_encrypted!), who.secret);
    assert.equal((await db.select().from(userTwoStepRecoveryCodes).where(and(eq(userTwoStepRecoveryCodes.user_id, who.id), isNull(userTwoStepRecoveryCodes.used_at)))).length, 10);

    // A challenge earned with the old password died with it.
    const stale = await post('/api/auth/two-step/verify', { challenge_token: pending.json.two_step.token, code: codeFor(who.secret) });
    assert.equal(stale.status, 401);
    assert.equal(stale.json.code, 'TWO_STEP_CHALLENGE_INVALID');

    assert.equal((await login(who.email)).status, 401, 'the old password is gone');
    const after = await login(who.email, newPassword);
    assert.equal(after.status, 200);
    assert.equal(after.json.accessToken, undefined, 'the new password alone still gives no session');
    assert.equal(after.json.two_step.status, 'code_required');
    assert.equal((await post('/api/auth/two-step/verify', { challenge_token: after.json.two_step.token, recovery_code: who.recoveryCodes[0] })).status, 200);
  });

  await t.test('an admin cannot make a recovery link for the owner or another admin; the owner can for anyone', async () => {
    const ownerOrg = randomUUID();
    await db.insert(orgs).values({ id: ownerOrg, name: 'Recovery links', slug: `recovery-${ownerOrg}` });
    const owner = await person('owner', ownerOrg);
    const admin = await person('admin', ownerOrg);
    const otherAdmin = await person('admin', ownerOrg);
    const member = await person('member', ownerOrg);
    const guest = await person('guest', ownerOrg);
    for (const hostedMode of [false, true]) {
      hosted(false);
      const sessions = Object.fromEntries(await Promise.all([owner, admin, member].map(async (who) => [who.id, (await createWebSession(who)).accessToken] as const)));
      hosted(hostedMode);
      if (hostedMode) {
        // Hosted owners and admins need the second step to act at all.
        for (const who of [owner, admin]) {
          const token = (await login(who.email)).json.two_step.token as string;
          sessions[who.id] = (await enrol(token)).confirmed.accessToken;
        }
      }
      const link = (caller: { id: string }, target: { id: string }) => post(`/api/members/${target.id}/recovery-url`, {}, sessions[caller.id]);

      for (const target of [owner, otherAdmin, admin]) {
        const refused = await link(admin, target);
        assert.equal(refused.status, 403, `admin -> ${target.id} hosted=${hostedMode}`);
        assert.equal(refused.json.code, 'FORBIDDEN');
        assert.equal(refused.json.recovery_url, undefined);
      }
      for (const target of [member, guest]) assert.equal((await link(admin, target)).status, 200, 'an admin can still help members and guests');
      for (const target of [member, guest, admin, otherAdmin]) {
        const made = await link(owner, target);
        assert.equal(made.status, 200, `owner -> ${target.id}`);
        assert.match(made.json.recovery_url, /token=/);
      }
      assert.equal((await link(member, guest)).status, 403, 'members make no recovery links');
    }
    hosted(false);
  });

  // ── Attempt limits are per account ───────────────────────────────────────

  await t.test('wrong codes kill the challenge, then delay the account, whatever address they come from', async () => {
    const who = await enrolledPerson();
    const first = await login(who.email);
    const challenge = first.json.two_step.token as string;
    for (let attempt = 1; attempt <= service.CHALLENGE_MAX_FAILURES; attempt += 1) {
      // A different claimed network address each time changes nothing.
      const res = await post('/api/auth/two-step/verify', { challenge_token: challenge, code: wrongCode(who.secret) }, undefined, { 'X-Forwarded-For': `203.0.113.${attempt}`, 'X-Real-IP': `198.51.100.${attempt}` });
      assert.equal(res.status, 401);
      assert.equal(res.json.code, attempt < service.CHALLENGE_MAX_FAILURES ? 'TWO_STEP_CODE_INVALID' : 'TWO_STEP_CHALLENGE_DEAD');
    }
    // The challenge is dead even for the right code: a new login is needed.
    const dead = await post('/api/auth/two-step/verify', { challenge_token: challenge, code: codeFor(who.secret) });
    assert.equal(dead.status, 401);
    assert.equal(dead.json.code, 'TWO_STEP_CHALLENGE_INVALID');

    // The account is now delayed: a new challenge, the right code, another
    // address — still refused until the delay has passed.
    const second = await login(who.email);
    const locked = await post('/api/auth/two-step/verify', { challenge_token: second.json.two_step.token, code: codeFor(who.secret) }, undefined, { 'X-Forwarded-For': '192.0.2.77' });
    assert.equal(locked.status, 429);
    assert.equal(locked.json.code, 'TWO_STEP_LOCKED');
    assert.ok(locked.json.retry_after_seconds > 0 && locked.json.retry_after_seconds <= 30);
    assert.equal(locked.headers.get('retry-after'), String(locked.json.retry_after_seconds));
    // The delay also covers the signed-in routes that take a code.
    assert.equal((await post('/api/auth/two-step/disable', { code: codeFor(who.secret) }, who.accessToken)).status, 429);

    // Each further wrong code doubles the delay.
    const lockedFor = async () => {
      const [row] = await db.select().from(userTwoStep).where(eq(userTwoStep.user_id, who.id));
      return { failed: row!.failed_attempts, ms: row!.locked_until ? row!.locked_until.getTime() - Date.now() : 0 };
    };
    assert.equal((await lockedFor()).failed, 5);
    await db.update(userTwoStep).set({ locked_until: new Date(Date.now() - 1000) }).where(eq(userTwoStep.user_id, who.id));
    assert.equal((await post('/api/auth/two-step/verify', { challenge_token: second.json.two_step.token, code: wrongCode(who.secret) })).status, 401);
    const sixth = await lockedFor();
    assert.equal(sixth.failed, 6);
    assert.ok(sixth.ms > 45_000 && sixth.ms <= 60_000, `second delay is about a minute, got ${sixth.ms}`);
    assert.deepEqual([4, 5, 6, 7, 8, 30].map(service.twoStepLockDelayMs), [0, 30_000, 60_000, 120_000, 240_000, 3_600_000]);

    // A right code after the delay clears the count.
    await db.update(userTwoStep).set({ locked_until: new Date(Date.now() - 1000) }).where(eq(userTwoStep.user_id, who.id));
    const third = await login(who.email);
    assert.equal((await post('/api/auth/two-step/verify', { challenge_token: third.json.two_step.token, code: codeFor(who.secret) })).status, 200);
    assert.deepEqual(await lockedFor(), { failed: 0, ms: 0 });

    // Another account is unaffected throughout.
    const bystander = await enrolledPerson();
    await loginWithCode(bystander);
  });

  await t.test('an expired challenge is refused', async () => {
    const who = await enrolledPerson();
    const first = await login(who.email);
    await db.update(twoStepChallenges).set({ expires_at: new Date(Date.now() - 1000) }).where(eq(twoStepChallenges.user_id, who.id));
    const res = await post('/api/auth/two-step/verify', { challenge_token: first.json.two_step.token, code: codeFor(who.secret) });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'TWO_STEP_CHALLENGE_INVALID');
    const stored = await db.select().from(twoStepChallenges).where(eq(twoStepChallenges.user_id, who.id));
    assert.ok(stored.length > 0 && stored.every((row) => !JSON.stringify(row).includes(first.json.two_step.token)), 'only a hash of the challenge is stored');
  });

  // ── Hosted mode: owners and admins must have it ──────────────────────────

  await t.test('hosted: an owner or admin who has not enrolled gets a session that can only enrol', async () => {
    hosted(true);
    for (const role of ['owner', 'admin'] as const) {
      const who = await person(role);
      const first = await login(who.email);
      assert.equal(first.status, 200);
      assert.equal(first.json.accessToken, undefined);
      assert.equal(first.json.refreshToken, undefined);
      assert.equal(first.json.two_step.status, 'enrolment_required');
      const restricted = first.json.two_step.token as string;

      // Nothing ordinary accepts the restricted session.
      assert.equal((await probe(restricted)).status, 401);
      assert.equal((await call('GET', '/api/members', undefined, restricted)).status, 401);
      assert.equal((await call('GET', '/api/auth/me', undefined, restricted)).status, 401);
      assert.equal((await call('PATCH', '/api/auth/me', { name: 'x' }, restricted)).status, 401);
      assert.equal((await post('/api/auth/refresh', { refreshToken: restricted })).status, 401);
      assert.equal((await post('/api/auth/two-step/verify', { challenge_token: restricted, code: '123456' })).status, 401);
      assert.equal((await post('/api/auth/two-step/recovery-codes', { code: '123456' }, restricted)).status, 401);
      assert.equal((await post('/api/auth/two-step/disable', { code: '123456' }, restricted)).status, 401);
      await assert.rejects(() => verifyWebAccess(restricted));
      assert.equal((await db.select().from(webSessions).where(eq(webSessions.user_id, who.id))).length, 0, 'no session row exists');

      assert.equal((await call('GET', '/api/auth/two-step', undefined, restricted)).status, 401);

      // It can do exactly one thing.
      const { confirmed, secret } = await enrol(restricted);
      assert.equal(confirmed.recovery_codes.length, 10);
      const full = await probe(confirmed.accessToken);
      assert.equal(full.status, 200);
      assert.equal(full.json.role, role);
      // The restricted token ended with enrolment.
      assert.equal((await post('/api/auth/two-step/enrol/start', {}, restricted)).status, 401);

      // From now on: password, then code.
      await forgetUsedStep(who.id);
      const next = await login(who.email);
      assert.equal(next.json.two_step.status, 'code_required');
      const session = await post('/api/auth/two-step/verify', { challenge_token: next.json.two_step.token, code: codeFor(secret) });
      assert.equal(session.status, 200);

      // Owners and admins cannot turn it off in hosted mode.
      await forgetUsedStep(who.id);
      const off = await post('/api/auth/two-step/disable', { code: codeFor(secret) }, session.json.accessToken);
      assert.equal(off.status, 403);
      assert.equal(off.json.code, 'TWO_STEP_REQUIRED_FOR_ROLE');
      const now = await call('GET', '/api/auth/two-step', undefined, session.json.accessToken);
      assert.equal(now.json.enabled, true);
      assert.equal(now.json.required, true);
      assert.equal(now.json.can_disable, false);
    }
    hosted(false);
  });

  await t.test('hosted: members and guests are not required, may choose it, and may turn it off', async () => {
    hosted(true);
    for (const role of ['member', 'guest'] as const) {
      const who = await person(role);
      const res = await login(who.email);
      assert.equal(res.json.two_step, undefined);
      assert.equal((await probe(res.json.accessToken)).status, 200);
    }
    const who = await enrolledPerson('member');
    const session = await loginWithCode(who);
    assert.equal((await post('/api/auth/two-step/disable', { code: codeFor(who.secret) }, session.accessToken)).status, 200);
    hosted(false);
  });

  await t.test('only the owner changes an admin\'s role, so an admin cannot demote a peer to reach a recovery link', async () => {
    const roleOrg = randomUUID();
    await db.insert(orgs).values({ id: roleOrg, name: 'Peer admins', slug: `peer-${roleOrg}` });
    hosted(false);
    const owner = await person('owner', roleOrg);
    const admin = await person('admin', roleOrg);
    const peer = await person('admin', roleOrg);
    const member = await person('member', roleOrg);
    const adminSession = (await login(admin.email)).json.accessToken as string;
    const ownerSession = (await login(owner.email)).json.accessToken as string;
    const demote = await call('PATCH', `/api/members/${peer.id}`, { role: 'member' }, adminSession);
    assert.equal(demote.status, 403);
    assert.equal(demote.json.code, 'FORBIDDEN');
    assert.equal((await call('POST', `/api/members/${peer.id}/recovery-url`, {}, adminSession)).status, 403, 'and so no link for the peer');
    // Nor by removing the peer and re-inviting them as a member.
    const removed = await call('DELETE', `/api/members/${peer.id}`, {}, adminSession);
    assert.equal(removed.status, 403);
    assert.equal(removed.json.code, 'FORBIDDEN');
    const [still] = await db.select({ role: orgMembers.role, is_active: orgMembers.is_active }).from(orgMembers)
      .where(and(eq(orgMembers.org_id, roleOrg), eq(orgMembers.user_id, peer.id)));
    assert.deepEqual(still, { role: 'admin', is_active: true });
    assert.equal((await call('POST', '/api/members/invite', { email: peer.email, role: 'member' }, adminSession)).status, 409, 'an active admin cannot be re-invited');
    // Members and guests are still the admin's to change; the owner changes anyone.
    assert.equal((await call('PATCH', `/api/members/${member.id}`, { role: 'guest' }, adminSession)).status, 200);
    assert.equal((await call('PATCH', `/api/members/${peer.id}`, { role: 'member' }, ownerSession)).status, 200);
    // The owner may remove an admin.
    const other = await person('admin', roleOrg);
    assert.equal((await call('DELETE', `/api/members/${other.id}`, {}, ownerSession)).status, 200);
  });

  await t.test('every writer of a membership role or active state goes through the one guard', async () => {
    const guardOrg = randomUUID();
    await db.insert(orgs).values({ id: guardOrg, name: 'Guard', slug: `guard-${guardOrg}` });
    hosted(false);
    const owner = await person('owner', guardOrg);
    const admin = await person('admin', guardOrg);
    const ownerSession = (await login(owner.email)).json.accessToken as string;
    const adminSession = (await login(admin.email)).json.accessToken as string;
    const generation = async (id: string) => (await db.select({ v: users.password_version }).from(users).where(eq(users.id, id)))[0]!.v;
    const membership = async (id: string) => (await db.select({ role: orgMembers.role, is_active: orgMembers.is_active }).from(orgMembers)
      .where(and(eq(orgMembers.org_id, guardOrg), eq(orgMembers.user_id, id))))[0];

    // A recovery link made by the owner dies at a role change too: whoever made it.
    const ownersMember = await person('member', guardOrg);
    const ownersLink = (await call('POST', `/api/members/${ownersMember.id}/recovery-url`, {}, ownerSession)).json.recovery_url as string;
    assert.equal((await call('PATCH', `/api/members/${ownersMember.id}`, { role: 'guest' }, ownerSession)).status, 200);
    const ownersToken = new URLSearchParams(new URL(ownersLink).hash.slice(1)).get('token');
    assert.equal((await post('/api/auth/reset-password', { token: ownersToken, password: 'A-new-password-2026!' })).status, 400);

    // PATCH /api/members/:id: a role change ends the links made before it.
    const member = await person('member', guardOrg);
    const early = (await call('POST', `/api/members/${member.id}/recovery-url`, {}, adminSession)).json.recovery_url as string;
    assert.equal((await call('PATCH', `/api/members/${member.id}`, { role: 'guest' }, adminSession)).status, 200);
    const earlyToken = new URLSearchParams(new URL(early).hash.slice(1)).get('token');
    assert.equal((await post('/api/auth/reset-password', { token: earlyToken, password: 'A-new-password-2026!' })).status, 400, 'the link made before the role change is dead');

    // DELETE /api/members/:id: only the owner removes an admin (tested above);
    // the owner's removal moves the generation on.
    const leaving = await person('admin', guardOrg);
    const before = await generation(leaving.id);
    assert.equal((await call('DELETE', `/api/members/${leaving.id}`, {}, adminSession)).status, 403);
    assert.equal(await generation(leaving.id), before, 'a refused removal changes nothing');
    assert.equal((await call('DELETE', `/api/members/${leaving.id}`, {}, ownerSession)).status, 200);
    assert.ok((await generation(leaving.id)) > before);

    // POST /api/members/invite: re-activating a former member goes through the guard too.
    // A removed admin is still an admin's role to the guard: an admin cannot
    // bring them back as a member (and then recover the account).
    const afterRemoval = await generation(leaving.id);
    const backAsMember = await call('POST', '/api/members/invite', { email: leaving.email, role: 'member' }, adminSession);
    assert.equal(backAsMember.status, 403, JSON.stringify(backAsMember.json));
    assert.deepEqual(await membership(leaving.id), { role: 'admin', is_active: false });
    assert.equal((await call('POST', '/api/members/invite', { email: leaving.email, role: 'member' }, ownerSession)).status, 201);
    assert.deepEqual(await membership(leaving.id), { role: 'member', is_active: true });
    assert.ok((await generation(leaving.id)) > afterRemoval, 're-activation ends earlier links');

    // DELETE /api/members/invites/:id: an admin cannot revoke the owner's pending admin invite.
    const pendingEmail = `guard-pending-${randomUUID()}@test.local`;
    const invited = await call('POST', '/api/members/invite', { email: pendingEmail, role: 'admin' }, ownerSession);
    assert.equal(invited.status, 201, JSON.stringify(invited.json));
    const [inviteRow] = await db.select({ id: invites.id }).from(invites).where(eq(invites.email, pendingEmail));
    // POST /api/members/invites/:id/reissue: a new link for the owner's admin
    // invite is the owner's to make, not another admin's.
    const reissueByAdmin = await call('POST', `/api/members/invites/${inviteRow!.id}/reissue`, {}, adminSession);
    assert.equal(reissueByAdmin.status, 403, JSON.stringify(reissueByAdmin.json));
    assert.equal(reissueByAdmin.json.invite_url, undefined);
    assert.equal((await call('POST', `/api/members/invites/${inviteRow!.id}/reissue`, {}, ownerSession)).status, 200);
    const revokeByAdmin = await call('DELETE', `/api/members/invites/${inviteRow!.id}`, undefined, adminSession);
    assert.equal(revokeByAdmin.status, 403, JSON.stringify(revokeByAdmin.json));
    assert.deepEqual(await membership(invited.json.user_id), { role: 'admin', is_active: true });
    assert.equal((await call('DELETE', `/api/members/invites/${inviteRow!.id}`, undefined, ownerSession)).status, 200);
    assert.deepEqual(await membership(invited.json.user_id), { role: 'admin', is_active: false });

    // An admin cannot invite anyone as an admin: only the owner makes admins.
    const ownEmail = `guard-own-${randomUUID()}@test.local`;
    const own = await call('POST', '/api/members/invite', { email: ownEmail, role: 'admin' }, adminSession);
    assert.equal(own.status, 403, JSON.stringify(own.json));
    assert.equal((await db.select({ id: users.id }).from(users).where(eq(users.email, ownEmail))).length, 0, 'nothing was created');

    // DELETE /api/agent-employees/:id: an agent the owner made admin is removed only by the owner.
    const agentUser = randomUUID();
    const employeeId = randomUUID();
    await db.insert(users).values({ id: agentUser, name: 'Guard agent', email: `${agentUser}@agents.test`, kind: 'agent', is_agent: true, email_verified: true });
    await db.insert(orgMembers).values({ org_id: guardOrg, user_id: agentUser, role: 'admin' });
    await db.insert(agentEmployees).values({
      id: employeeId, org_id: guardOrg, user_id: agentUser, name: 'Guard agent', slug: `guard-agent-${employeeId.slice(0, 8)}`,
      role: 'project_manager', system_prompt: 'Fixture', trust_level: 'conservative', is_byoa: true, is_active: true, created_by: owner.id,
    });
    const agentByAdmin = await call('DELETE', `/api/agent-employees/${employeeId}`, undefined, adminSession);
    assert.equal(agentByAdmin.status, 403, JSON.stringify(agentByAdmin.json));
    assert.equal((await db.select({ is_deleted: agentEmployees.is_deleted }).from(agentEmployees).where(eq(agentEmployees.id, employeeId)))[0]!.is_deleted, false, 'nothing was deleted');
    assert.deepEqual(await membership(agentUser), { role: 'admin', is_active: true });
  });

  await t.test('an invite link does not outlive a role or active-state change', async () => {
    const inviteOrg = randomUUID();
    await db.insert(orgs).values({ id: inviteOrg, name: 'Invite links', slug: `invites-${inviteOrg}` });
    hosted(false);
    const owner = await person('owner', inviteOrg);
    const admin = await person('admin', inviteOrg);
    const ownerSession = (await login(owner.email)).json.accessToken as string;
    const adminSession = (await login(admin.email)).json.accessToken as string;
    const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;
    const accept = (url: string) => post('/api/invites/accept', { token: tokenOf(url), password: 'Taken-over-2026!' });
    const inviteRowFor = async (email: string) => (await db.select({ id: invites.id }).from(invites)
      .where(and(eq(invites.email, email), isNull(invites.accepted_at))).orderBy(desc(invites.created_at)).limit(1))[0]!.id;

    // The owner invites E as a member; another admin reissues it and keeps
    // the link; the owner then makes E an admin. The kept link is dead, and
    // the admin can no longer reissue it.
    const e = `invite-promoted-${randomUUID()}@test.local`;
    const invitedE = await call('POST', '/api/members/invite', { email: e, role: 'member' }, ownerSession);
    const eRow = await inviteRowFor(e);
    const kept = await call('POST', `/api/members/invites/${eRow}/reissue`, {}, adminSession);
    assert.equal(kept.status, 200);
    assert.equal((await call('PATCH', `/api/members/${invitedE.json.user_id}`, { role: 'admin' }, ownerSession)).status, 200);
    const stale = await accept(kept.json.invite_url);
    assert.equal(stale.status, 400);
    assert.equal(stale.json.code, 'INVITE_REVOKED');
    assert.equal((await call('POST', `/api/members/invites/${eRow}/reissue`, {}, adminSession)).status, 403, 'made as a member invite: not the admin\'s to reissue now');
    const fresh = await call('POST', `/api/members/invites/${eRow}/reissue`, {}, ownerSession);
    assert.equal(fresh.status, 200);
    assert.equal((await accept(fresh.json.invite_url)).status, 200, 'the owner\'s new link works');

    // Opus round 5: an admin invites F as a member and keeps the link; F is
    // removed (this kills F's invite rows) and the owner re-invites F as an
    // admin. The admin's old link is dead.
    const f = `invite-reinvited-${randomUUID()}@test.local`;
    const oldLink = await call('POST', '/api/members/invite', { email: f, role: 'member' }, adminSession);
    assert.equal((await call('DELETE', `/api/members/${oldLink.json.user_id}`, {}, ownerSession)).status, 200);
    assert.equal((await db.select({ id: invites.id }).from(invites).where(eq(invites.email, f))).length, 0, 'removal kills the pending invites');
    const newLink = await call('POST', '/api/members/invite', { email: f, role: 'admin' }, ownerSession);
    assert.equal(newLink.status, 201, JSON.stringify(newLink.json));
    const takeover = await accept(oldLink.json.invite_url);
    assert.equal(takeover.status, 400);
    assert.ok(['INVITE_INVALID', 'INVITE_REVOKED'].includes(takeover.json.code), takeover.json.code);
    assert.equal((await accept(newLink.json.invite_url)).status, 200, 'the person accepts the owner\'s link');

    // A link made before links carried a generation counts as made at the
    // starting generation 0: refused once the generation has moved at all
    // (sol and astra round 6: member -> guest -> member must not revive it).
    const legacyMember = async (email: string) => {
      const made = await call('POST', '/api/members/invite', { email, role: 'member' }, ownerSession);
      const token = jwt.sign({ purpose: 'invite-accept', user_id: made.json.user_id, org_id: inviteOrg, email, inviter_id: owner.id, role: 'member' }, env.JWT_SECRET, { expiresIn: '1h' });
      await db.update(invites).set({ token }).where(eq(invites.id, await inviteRowFor(email)));
      return { token, userId: made.json.user_id as string };
    };
    const changed = await legacyMember(`invite-legacy-changed-${randomUUID()}@test.local`);
    assert.equal((await call('PATCH', `/api/members/${changed.userId}`, { role: 'guest' }, ownerSession)).status, 200);
    assert.equal((await post('/api/invites/accept', { token: changed.token, password: 'A-password-2026!' })).json.code, 'INVITE_REVOKED');
    const revived = await legacyMember(`invite-legacy-revived-${randomUUID()}@test.local`);
    assert.equal((await call('PATCH', `/api/members/${revived.userId}`, { role: 'guest' }, ownerSession)).status, 200);
    assert.equal((await call('PATCH', `/api/members/${revived.userId}`, { role: 'member' }, ownerSession)).status, 200);
    const revivedAccept = await post('/api/invites/accept', { token: revived.token, password: 'A-password-2026!' });
    assert.equal(revivedAccept.status, 400, 'member -> guest -> member does not revive it');
    assert.equal(revivedAccept.json.code, 'INVITE_REVOKED');
    const unchanged = await legacyMember(`invite-legacy-same-${randomUUID()}@test.local`);
    assert.equal((await post('/api/invites/accept', { token: unchanged.token, password: 'A-password-2026!' })).status, 200, 'an unchanged legacy member link still works');
  });

  await t.test('round 6 reproductions (sol and astra) are refused', async () => {
    const r6Org = randomUUID();
    await db.insert(orgs).values({ id: r6Org, name: 'Round 6', slug: `r6-${r6Org}` });
    hosted(false);
    const owner = await person('owner', r6Org);
    const admin = await person('admin', r6Org);
    const ownerSession = (await login(owner.email)).json.accessToken as string;
    const adminSession = (await login(admin.email)).json.accessToken as string;
    const roleOf = async (userId: string) => (await db.select({ role: orgMembers.role, is_active: orgMembers.is_active }).from(orgMembers)
      .where(and(eq(orgMembers.org_id, r6Org), eq(orgMembers.user_id, userId))))[0];
    const inviteRowFor = async (email: string) => (await db.select({ id: invites.id }).from(invites)
      .where(and(eq(invites.email, email), isNull(invites.accepted_at))).orderBy(desc(invites.created_at)).limit(1))[0]!.id;

    // 1. The owner invites A as admin and removes A; a peer admin re-invites
    // A (as admin, or as member) and would accept the new link.
    const a = `r6-removed-admin-${randomUUID()}@test.local`;
    const invitedA = await call('POST', '/api/members/invite', { email: a, role: 'admin' }, ownerSession);
    assert.equal((await call('DELETE', `/api/members/${invitedA.json.user_id}`, {}, ownerSession)).status, 200);
    for (const role of ['admin', 'member'] as const) {
      const again = await call('POST', '/api/members/invite', { email: a, role }, adminSession);
      assert.equal(again.status, 403, `${role}: ${JSON.stringify(again.json)}`);
      assert.equal(again.json.invite_url, undefined);
    }
    assert.deepEqual(await roleOf(invitedA.json.user_id), { role: 'admin', is_active: false });

    // 2. A reissue racing the owner's promotion: the promotion holds the
    // account and membership rows; the reissue waits for them, then sees an
    // admin and is refused (it no longer checks before it locks).
    const e = `r6-race-${randomUUID()}@test.local`;
    const invitedE = await call('POST', '/api/members/invite', { email: e, role: 'member' }, ownerSession);
    const eInvite = await inviteRowFor(e);
    const promotion = new pg.Client({ connectionString: databaseUrl! });
    await promotion.connect();
    try {
      await promotion.query('BEGIN');
      await promotion.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [invitedE.json.user_id]);
      await promotion.query('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2 FOR UPDATE', [r6Org, invitedE.json.user_id]);
      const reissue = call('POST', `/api/members/invites/${eInvite}/reissue`, {}, adminSession);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await promotion.query("UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2", [r6Org, invitedE.json.user_id]);
      await promotion.query('UPDATE users SET password_version = password_version + 1 WHERE id = $1', [invitedE.json.user_id]);
      await promotion.query('COMMIT');
      const raced = await reissue;
      assert.equal(raced.status, 403, JSON.stringify(raced.json));
      assert.equal(raced.json.invite_url, undefined);
    } finally {
      await promotion.end();
    }

    // 3. A peer admin's member invite; the owner promotes the pending person;
    // the peer may no longer revoke it (and so deactivate an admin).
    const pEmail = `r6-revoke-${randomUUID()}@test.local`;
    const madeByPeer = await call('POST', '/api/members/invite', { email: pEmail, role: 'member' }, adminSession);
    assert.equal(madeByPeer.status, 201);
    assert.equal((await call('PATCH', `/api/members/${madeByPeer.json.user_id}`, { role: 'admin' }, ownerSession)).status, 200);
    const peerRevoke = await call('DELETE', `/api/members/invites/${await inviteRowFor(pEmail)}`, undefined, adminSession);
    assert.equal(peerRevoke.status, 403, JSON.stringify(peerRevoke.json));
    assert.deepEqual(await roleOf(madeByPeer.json.user_id), { role: 'admin', is_active: true });
  });

  await t.test('owner-only table: actor role x the target\'s past and present role x operation', async () => {
    const tableOrg = randomUUID();
    await db.insert(orgs).values({ id: tableOrg, name: 'Owner-only table', slug: `table-${tableOrg}` });
    hosted(false);
    const owner = await person('owner', tableOrg);
    const admin = await person('admin', tableOrg);
    const sessions = {
      owner: (await login(owner.email)).json.accessToken as string,
      admin: (await login(admin.email)).json.accessToken as string,
    };
    type State = 'member' | 'admin' | 'demoted_admin' | 'removed_admin' | 'removed_member' | 'pending_member' | 'pending_admin' | 'new_address';
    const isProtected: Record<State, boolean> = {
      member: false, admin: true, demoted_admin: true, removed_admin: true, removed_member: false, pending_member: false, pending_admin: true, new_address: false,
    };
    async function make(state: State): Promise<{ id: string; email: string }> {
      const as = sessions.owner;
      if (state === 'member' || state === 'admin') return person(state, tableOrg);
      if (state === 'demoted_admin' || state === 'removed_admin' || state === 'removed_member') {
        const who = await person(state === 'removed_member' ? 'member' : 'admin', tableOrg);
        const step = state === 'demoted_admin'
          ? await call('PATCH', `/api/members/${who.id}`, { role: 'member' }, as)
          : await call('DELETE', `/api/members/${who.id}`, {}, as);
        assert.equal(step.status, 200, `${state} setup`);
        return who;
      }
      const email = `table-${state}-${randomUUID()}@test.local`;
      if (state === 'new_address') return { id: '', email };
      const made = await call('POST', '/api/members/invite', { email, role: state === 'pending_admin' ? 'admin' : 'member' }, as);
      assert.equal(made.status, 201, `${state} setup`);
      return { id: made.json.user_id as string, email };
    }
    const latestInvite = async (email: string) => (await db.select({ id: invites.id }).from(invites)
      .where(and(eq(invites.email, email), isNull(invites.accepted_at))).orderBy(desc(invites.created_at)).limit(1))[0]!.id;
    type Op = { name: string; makesAdmin: boolean; states: State[]; run: (target: { id: string; email: string }, as: string) => Promise<{ status: number; json: Json }> };
    const ops: Op[] = [
      { name: 'change role to guest', makesAdmin: false, states: ['member', 'admin', 'demoted_admin', 'pending_member', 'pending_admin'],
        run: (t, as) => call('PATCH', `/api/members/${t.id}`, { role: 'guest' }, as) },
      { name: 'change role to admin', makesAdmin: true, states: ['member', 'demoted_admin', 'pending_member'],
        run: (t, as) => call('PATCH', `/api/members/${t.id}`, { role: 'admin' }, as) },
      { name: 'remove', makesAdmin: false, states: ['member', 'admin', 'demoted_admin', 'pending_member', 'pending_admin'],
        run: (t, as) => call('DELETE', `/api/members/${t.id}`, {}, as) },
      { name: 'make a recovery link', makesAdmin: false, states: ['member', 'admin', 'demoted_admin'],
        run: (t, as) => call('POST', `/api/members/${t.id}/recovery-url`, {}, as) },
      { name: 'invite as member', makesAdmin: false, states: ['removed_admin', 'removed_member', 'new_address'],
        run: (t, as) => call('POST', '/api/members/invite', { email: t.email, role: 'member' }, as) },
      { name: 'invite as admin', makesAdmin: true, states: ['removed_admin', 'removed_member', 'new_address'],
        run: (t, as) => call('POST', '/api/members/invite', { email: t.email, role: 'admin' }, as) },
      { name: 'reissue the invite', makesAdmin: false, states: ['pending_member', 'pending_admin'],
        run: async (t, as) => call('POST', `/api/members/invites/${await latestInvite(t.email)}/reissue`, {}, as) },
      { name: 'revoke the invite', makesAdmin: false, states: ['pending_member', 'pending_admin'],
        run: async (t, as) => call('DELETE', `/api/members/invites/${await latestInvite(t.email)}`, undefined, as) },
    ];
    let cases = 0;
    for (const actor of ['owner', 'admin'] as const) {
      for (const op of ops) {
        for (const state of op.states) {
          const target = await make(state);
          const res = await op.run(target, sessions[actor]);
          const allowed = actor === 'owner' || (!isProtected[state] && !op.makesAdmin);
          const label = `${actor} / ${state} / ${op.name}: ${res.status} ${JSON.stringify(res.json)}`;
          if (allowed) assert.ok(res.status === 200 || res.status === 201, label);
          else assert.equal(res.status, 403, label);
          cases += 1;
        }
      }
    }
    assert.equal(cases, 2 * ops.reduce((n, op) => n + op.states.length, 0));
  });

  await t.test('a recovery link for an owner or admin is checked again when it is used', async () => {
    const linkOrg = randomUUID();
    await db.insert(orgs).values({ id: linkOrg, name: 'Link use', slug: `link-${linkOrg}` });
    hosted(false);
    const owner = await person('owner', linkOrg);
    const admin = await person('admin', linkOrg);
    const member = await person('member', linkOrg);
    const ownerSession = (await login(owner.email)).json.accessToken as string;
    const adminSession = (await login(admin.email)).json.accessToken as string;
    // The token travels after `#` (lib/secret-links.ts).
    const reset = (url: string) => post('/api/auth/reset-password', { token: new URLSearchParams(new URL(url).hash.slice(1)).get('token'), password: 'A-new-password-2026!' });

    // An admin's link for a member stops working once that member is an admin.
    const forMember = (await call('POST', `/api/members/${member.id}/recovery-url`, {}, adminSession)).json.recovery_url as string;
    assert.equal((await call('PATCH', `/api/members/${member.id}`, { role: 'admin' }, ownerSession)).status, 200);
    const refused = await reset(forMember);
    assert.equal(refused.status, 400);
    assert.equal((await login(member.email)).status, 200, 'the password did not change');

    // A link without its maker (made before this rule) is refused for an admin.
    const legacy = jwt.sign({ id: admin.id, email: admin.email, org_id: linkOrg, purpose: 'password-reset', password_version: 0 }, env.JWT_SECRET, { expiresIn: '1h' });
    assert.equal((await post('/api/auth/reset-password', { token: legacy, password: 'A-new-password-2026!' })).status, 400);

    // The owner's link for an admin works; so does an operator's link for the owner.
    const forAdmin = (await call('POST', `/api/members/${admin.id}/recovery-url`, {}, ownerSession)).json.recovery_url as string;
    assert.equal((await reset(forAdmin)).status, 200);
    const { makeOperatorRecoveryUrl } = await import('../src/scripts/make-recovery-url.js');
    const operator = await makeOperatorRecoveryUrl(owner.email);
    assert.equal((await reset(operator.url)).status, 200);
    assert.equal((await login(owner.email, 'A-new-password-2026!')).status, 200);
  });

  await t.test('hosted: nobody becomes an admin before they have two-step verification on', async () => {
    const roleOrg = randomUUID();
    await db.insert(orgs).values({ id: roleOrg, name: 'Role change', slug: `role-${roleOrg}` });
    const roleOf = async (userId: string) => (await db.select({ role: orgMembers.role }).from(orgMembers)
      .where(and(eq(orgMembers.org_id, roleOrg), eq(orgMembers.user_id, userId))))[0]?.role;

    // Self-hosted: nothing is required.
    hosted(false);
    const selfOwner = await person('owner', roleOrg);
    const selfMember = await person('member', roleOrg);
    const selfActor = (await login(selfOwner.email)).json.accessToken as string;
    assert.equal((await call('PATCH', `/api/members/${selfMember.id}`, { role: 'admin' }, selfActor)).status, 200);
    assert.equal(await roleOf(selfMember.id), 'admin');

    hosted(true);
    const owner = await person('owner', roleOrg);
    const actor = (await enrol((await login(owner.email)).json.two_step.token)).confirmed.accessToken as string;
    const member = await person('member', roleOrg);
    const memberSession = (await login(member.email)).json;

    // Refused, and nothing changes: same role, same session.
    const refused = await call('PATCH', `/api/members/${member.id}`, { role: 'admin' }, actor);
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.equal(refused.json.code, 'TWO_STEP_NOT_ENROLLED');
    assert.equal(await roleOf(member.id), 'member');
    assert.equal((await probe(memberSession.accessToken)).json.role, 'member');

    // A started but unconfirmed enrolment is not enough.
    await post('/api/auth/two-step/enrol/start', { current_password: PASSWORD }, memberSession.accessToken);
    assert.equal((await call('PATCH', `/api/members/${member.id}`, { role: 'admin' }, actor)).status, 409);
    assert.equal(await roleOf(member.id), 'member');

    // Once they have turned it on themselves, the promotion goes through and
    // the session they enrolled on carries the role.
    const enrolment = await enrol(memberSession.accessToken);
    await forgetUsedStep(member.id);
    const promoted = await call('PATCH', `/api/members/${member.id}`, { role: 'admin' }, actor);
    assert.equal(promoted.status, 200, JSON.stringify(promoted.json));
    assert.equal((await probe(enrolment.confirmed.accessToken)).json.role, 'admin');

    // And they cannot turn it off now, through the route or the service.
    const off = await post('/api/auth/two-step/disable', { code: codeFor(enrolment.secret) }, enrolment.confirmed.accessToken);
    assert.equal(off.status, 403);
    assert.equal(off.json.code, 'TWO_STEP_REQUIRED_FOR_ROLE');
    assert.deepEqual(await service.disableTwoStep(member.id, codeFor(enrolment.secret)), { ok: false, mandatory: true });
    assert.ok((await service.getTwoStepStatus(member.id)).enabled);
    hosted(false);
  });

  await t.test('hosted: a session that predates the requirement is refused on every request and on refresh', async () => {
    hosted(false);
    const who = await person('owner');
    const session = (await login(who.email)).json;
    const second = (await login(who.email)).json;
    assert.equal((await probe(session.accessToken)).status, 200);

    hosted(true);
    const refused = await probe(session.accessToken);
    assert.equal(refused.status, 401);
    assert.equal(refused.json.code, 'TWO_STEP_ENROLMENT_REQUIRED');
    assert.equal((await call('GET', '/api/auth/me', undefined, session.accessToken)).status, 401);
    assert.equal((await call('GET', '/api/auth/two-step', undefined, session.accessToken)).status, 401, 'not even the enrolment routes: sign in again');
    await assert.rejects(() => verifyWebAccess(session.accessToken), SecondStepRequiredError);

    const refresh = await post('/api/auth/refresh', { refreshToken: session.refreshToken });
    assert.equal(refresh.status, 401);
    assert.equal(refresh.json.code, 'TWO_STEP_ENROLMENT_REQUIRED');
    assert.equal(refresh.json.accessToken, undefined);
    await assert.rejects(() => rotateWebSession(second.refreshToken), SecondStepRequiredError);

    // The refusal revoked them: turning hosted mode off again does not revive them.
    hosted(false);
    assert.equal((await probe(session.accessToken)).status, 401);
    assert.equal((await post('/api/auth/refresh', { refreshToken: second.refreshToken })).status, 401);
  });

  await t.test('refresh cannot stand in for a code', async () => {
    const who = await person('member');
    const before = (await login(who.email)).json;
    const keep = (await login(who.email)).json;
    await enrol(before.accessToken);
    // Suppose a session from before enrolment had survived it.
    const [row] = await db.select().from(webSessions).where(and(eq(webSessions.user_id, who.id), eq(webSessions.refresh_token_hash,
      createHash('sha256').update(keep.refreshToken).digest('hex'))));
    assert.ok(row?.revoked_at, 'enrolment revoked it');
    await db.update(webSessions).set({ revoked_at: null }).where(eq(webSessions.id, row.id));
    const refresh = await post('/api/auth/refresh', { refreshToken: keep.refreshToken });
    assert.equal(refresh.status, 401);
    assert.equal(refresh.json.code, 'TWO_STEP_REQUIRED');
    assert.equal(refresh.json.accessToken, undefined);
    const [again] = await db.select().from(webSessions).where(eq(webSessions.id, row.id));
    assert.ok(again?.revoked_at, 'and the refusal revokes it again');
  });

  await t.test('accepting an invite goes through the same policy', async () => {
    const inviter = await person('owner');
    async function invite(role: 'admin' | 'member') {
      const id = randomUUID();
      const email = `two-step-invite-${id}@test.local`;
      await db.insert(users).values({ id, name: 'Invited', email, password_hash: null });
      await db.insert(orgMembers).values({ org_id: orgId, user_id: id, role });
      const token = jwt.sign({ user_id: id, org_id: orgId, email, inviter_id: inviter.id, role, purpose: 'invite-accept', password_version: 0 }, env.JWT_SECRET, { expiresIn: '7d' });
      await db.insert(invites).values({ org_id: orgId, email, token, invited_by: inviter.id, expires_at: new Date(Date.now() + 86_400_000) });
      return { id, email, token };
    }
    hosted(false);
    for (const role of ['admin', 'member'] as const) {
      const accepted = await post('/api/invites/accept', { token: (await invite(role)).token, password: PASSWORD });
      assert.equal(accepted.status, 200);
      assert.equal(accepted.json.two_step, undefined, `self-hosted ${role}`);
      assert.equal((await probe(accepted.json.accessToken)).status, 200);
    }

    hosted(true);
    const member = await post('/api/invites/accept', { token: (await invite('member')).token, password: PASSWORD });
    assert.equal(member.json.two_step, undefined);
    assert.equal((await probe(member.json.accessToken)).status, 200);

    const admin = await invite('admin');
    const accepted = await post('/api/invites/accept', { token: admin.token, password: PASSWORD });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.accessToken, undefined, 'a new hosted admin gets no session from the invite');
    assert.equal(accepted.json.refreshToken, undefined);
    assert.equal(accepted.json.two_step.status, 'enrolment_required');
    assert.equal((await probe(accepted.json.two_step.token)).status, 401);
    assert.equal((await db.select().from(webSessions).where(eq(webSessions.user_id, admin.id))).length, 0);
    const done = await enrol(accepted.json.two_step.token);
    assert.equal((await probe(done.confirmed.accessToken)).json.role, 'admin');
    hosted(false);
  });

  await t.test('signup goes through the same policy', async () => {
    // A hosted cell's first signup also needs its one-time setup token.
    const setupToken = `setup-${randomUUID()}`;
    const setupBefore = { hash: process.env.DEFT_SETUP_TOKEN_SHA256, expires: process.env.DEFT_SETUP_TOKEN_EXPIRES_AT };
    process.env.DEFT_SETUP_TOKEN_SHA256 = createHash('sha256').update(setupToken).digest('hex');
    process.env.DEFT_SETUP_TOKEN_EXPIRES_AT = new Date(Date.now() + 3600_000).toISOString();
    const signup = () => {
      const id = randomUUID();
      return post('/api/auth/signup', { name: 'First owner', email: `two-step-signup-${id}@test.local`, password: PASSWORD, org_name: `Signup ${id}`, setup_token: setupToken });
    };
    pretendEmptyInstall = true;
    try {
      hosted(false);
      const selfHosted = await signup();
      assert.equal(selfHosted.status, 201, JSON.stringify(selfHosted.json));
      assert.equal(selfHosted.json.two_step, undefined);
      assert.equal((await probe(selfHosted.json.accessToken)).json.role, 'owner');

      hosted(true);
      const cell = await signup();
      assert.equal(cell.status, 201, JSON.stringify(cell.json));
      assert.equal(cell.json.accessToken, undefined, 'the first owner of a hosted workspace gets no session from signup');
      assert.equal(cell.json.refreshToken, undefined);
      assert.equal(cell.json.two_step.status, 'enrolment_required');
      assert.equal((await probe(cell.json.two_step.token)).status, 401);
      assert.equal((await db.select().from(webSessions).where(eq(webSessions.user_id, cell.json.user.id))).length, 0);
      const done = await enrol(cell.json.two_step.token);
      assert.equal((await probe(done.confirmed.accessToken)).json.role, 'owner');
    } finally {
      pretendEmptyInstall = false;
      hosted(false);
      for (const [key, value] of [['DEFT_SETUP_TOKEN_SHA256', setupBefore.hash], ['DEFT_SETUP_TOKEN_EXPIRES_AT', setupBefore.expires]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  await t.test('the issuing function itself refuses, whatever calls it', async () => {
    const enrolled = await enrolledPerson();
    const identity = { id: enrolled.id, email: enrolled.email, org_id: orgId };
    await assert.rejects(() => createWebSession(identity), SecondStepRequiredError);
    await assert.rejects(() => createWebSession(identity, passwordHash), SecondStepRequiredError);
    for (const via of ['signup', 'login', 'invite'] as const) {
      const issued = await issueSession(via === 'signup' ? { via, identity } : { via, identity, expectedPasswordHash: passwordHash });
      assert.equal(issued.status, 'code_required', via);
    }
    hosted(true);
    const owner = await person('owner');
    const ownerIdentity = { id: owner.id, email: owner.email, org_id: orgId };
    await assert.rejects(() => createWebSession(ownerIdentity), SecondStepRequiredError);
    // Not even a claimed second step helps someone who has not enrolled.
    await assert.rejects(() => issueSession({ via: 'enrolment', identity: ownerIdentity, credentials: { passwordVersion: 0, confirmedAt: new Date() } }), SecondStepRequiredError);
    assert.equal((await issueSession({ via: 'signup', identity: ownerIdentity })).status, 'enrolment_required');
    hosted(false);
    assert.equal((await issueSession({ via: 'signup', identity: ownerIdentity })).status, 'session');
  });
});
