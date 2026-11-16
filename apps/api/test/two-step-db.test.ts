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
import { and, eq, isNull } from 'drizzle-orm';
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
  const { users, orgs, orgMembers, invites, webSessions } = await import('@deft/db/schema');
  const { userTwoStep, userTwoStepRecoveryCodes, twoStepChallenges } = await import('@deft/db/two-step');
  const { authRoutes } = await import('../src/routes/auth.js');
  const { twoStepRoutes } = await import('../src/routes/two-step.js');
  const { inviteRoutes } = await import('../src/routes/invites.js');
  const { memberRoutes } = await import('../src/routes/members.js');
  const { authMiddleware } = await import('../src/middleware/auth.js');
  const { createWebSession, verifyWebAccess, rotateWebSession } = await import('../src/lib/web-sessions.js');
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
  async function enrol(bearer: string) {
    const started = await post('/api/auth/two-step/enrol/start', {}, bearer);
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const secret = started.json.secret as string;
    const confirmed = await post('/api/auth/two-step/enrol/confirm', { code: codeFor(secret) }, bearer);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
    return { secret, started: started.json, confirmed: confirmed.json, recoveryCodes: confirmed.json.recovery_codes as string[] };
  }
  /** A member who has two-step verification, plus a signed-in session. */
  async function enrolledPerson(role: 'owner' | 'admin' | 'member' = 'member') {
    const who = await person(role);
    const first = await login(who.email);
    const bearer = (first.json.accessToken ?? first.json.two_step?.token) as string;
    const enrolment = await enrol(bearer);
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
    const { secret, started, recoveryCodes, confirmed } = await enrol(before.accessToken);

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

    // Sessions issued before enrolment never saw a code: all of them end.
    assert.equal((await probe(before.accessToken)).status, 401);
    assert.equal((await probe(other.accessToken)).status, 401);
    assert.equal((await post('/api/auth/refresh', { refreshToken: other.refreshToken })).status, 401);
    assert.equal((await probe(confirmed.accessToken)).status, 200);

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
    const started = await post('/api/auth/two-step/enrol/start', {}, session.accessToken);
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
    await post('/api/auth/two-step/enrol/start', {}, memberSession.accessToken);
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
      const token = jwt.sign({ user_id: id, org_id: orgId, email, inviter_id: inviter.id, role, purpose: 'invite-accept' }, env.JWT_SECRET, { expiresIn: '7d' });
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
    const signup = () => {
      const id = randomUUID();
      return post('/api/auth/signup', { name: 'First owner', email: `two-step-signup-${id}@test.local`, password: PASSWORD, org_name: `Signup ${id}` });
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
    await assert.rejects(() => issueSession({ via: 'enrolment', identity: ownerIdentity }), SecondStepRequiredError);
    assert.equal((await issueSession({ via: 'signup', identity: ownerIdentity })).status, 'enrolment_required');
    hosted(false);
    assert.equal((await issueSession({ via: 'signup', identity: ownerIdentity })).status, 'session');
  });
});
