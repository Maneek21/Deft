import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Hono } from 'hono';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { eq } from 'drizzle-orm';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
test('web session HTTP and database rotation/revocation boundaries', { skip: !databaseUrl }, async (t) => {
  const target = new URL(databaseUrl!);
  const disposableName = target.pathname.startsWith('/preview_') || (process.env.CI === 'true' && target.pathname === '/deft_test');
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && disposableName, 'Only disposable local preview or declared CI databases');
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = 'preview-session-tests-access-only';
  process.env.JWT_REFRESH_SECRET = 'preview-session-tests-refresh-only';
  const { db, closeDb } = await import('../src/lib/db.js');
  const { users, orgs, orgMembers, webSessions } = await import('@deft/db/schema');
  const { createWebSession, rotateWebSession, verifyWebAccess, revokeWebSession, changeWebPassword, revokeMemberWebSessions } = await import('../src/lib/web-sessions.js');
  const { authRoutes } = await import('../src/routes/auth.js');
  const { authMiddleware } = await import('../src/middleware/auth.js');
  const userId = randomUUID();
  const orgId = randomUUID();
  const identity = { id: userId, org_id: orgId, email: `${userId}@preview-session.local` };
  await db.insert(users).values({ id: userId, name: 'Session regression', email: identity.email, email_verified: true });
  await db.insert(orgs).values({ id: orgId, name: 'Session regression', slug: `session-${orgId}` });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: userId, role: 'owner' });
  t.after(closeDb);
  const app = new Hono();
  app.route('/api/auth', authRoutes);
  app.use('/api/*', authMiddleware);
  app.get('/api/probe', (c) => c.json({ ok: true }));
  const post = (route: string, body: unknown) => app.request(`/api/auth/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const probe = (token: string) => app.request('/api/probe', { headers: { Authorization: `Bearer ${token}` } });

  await t.test('one-use rotation revokes descendants and access on replay', async () => {
    const initial = await createWebSession(identity);
    const rotated = await rotateWebSession(initial.refreshToken);
    assert.notEqual(rotated.refreshToken, initial.refreshToken);
    assert.equal((await probe(rotated.accessToken)).status, 200);
    assert.equal((await post('refresh', { refreshToken: initial.refreshToken })).status, 401);
    await assert.rejects(() => rotateWebSession(rotated.refreshToken));
    assert.equal((await probe(initial.accessToken)).status, 401);
    assert.equal((await probe(rotated.accessToken)).status, 401);
  });
  await t.test('concurrent use rotates at most once then fails closed for the family', async () => {
    const initial = await createWebSession(identity);
    const results = await Promise.allSettled([rotateWebSession(initial.refreshToken), rotateWebSession(initial.refreshToken)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const result of results) if (result.status === 'fulfilled') await assert.rejects(() => verifyWebAccess(result.value.accessToken));
  });
  await t.test('logout revokes access and refresh; repeated logout is idempotent', async () => {
    const pair = await createWebSession(identity);
    assert.equal((await post('logout', { refreshToken: pair.refreshToken })).status, 200);
    assert.equal((await post('logout', { refreshToken: pair.refreshToken })).status, 200);
    assert.equal((await probe(pair.accessToken)).status, 401);
    assert.equal((await app.request('/api/auth/me', { headers: { Authorization: `Bearer ${pair.accessToken}` } })).status, 401);
    await assert.rejects(() => rotateWebSession(pair.refreshToken));
  });
  await t.test('malformed bodies are bounded structured 400 responses', async () => {
    for (const route of ['refresh', 'logout', 'login', 'signup']) {
      for (const body of [null, [], { refreshToken: {} }]) assert.equal((await post(route, body)).status, 400);
      assert.equal((await app.request(`/api/auth/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    }
  });
  await t.test('legacy, wrong purpose, expired and inactive-member credentials are denied', async () => {
    const pair = await createWebSession(identity);
    const legacy = jwt.sign(identity, process.env.JWT_SECRET!, { expiresIn: '15m' });
    assert.equal((await probe(legacy)).status, 401);
    assert.equal((await probe(pair.refreshToken)).status, 401);
    const sid = (jwt.decode(pair.accessToken) as { sid: string }).sid;
    await db.update(webSessions).set({ expires_at: new Date(0) }).where(eq(webSessions.id, sid));
    await assert.rejects(() => verifyWebAccess(pair.accessToken));
    const active = await createWebSession(identity);
    await db.update(orgMembers).set({ is_active: false }).where(eq(orgMembers.user_id, userId));
    assert.equal((await probe(active.accessToken)).status, 403);
    await assert.rejects(() => rotateWebSession(active.refreshToken));
    await revokeMemberWebSessions(orgId, userId);
    await db.update(orgMembers).set({ is_active: true }).where(eq(orgMembers.user_id, userId));
    await assert.rejects(() => verifyWebAccess(active.accessToken), 'reactivating membership must not revive revoked sessions');
    await revokeWebSession(active.refreshToken);
  });
  await t.test('password change revokes all user families and reset token is one-use', async () => {
    const first = await createWebSession(identity);
    const second = await createWebSession(identity);
    const resetToken = `disposable-one-use-reset-${userId}`;
    await changeWebPassword(userId, 'test-hash-not-for-login', { resetToken, passwordVersion: 0, orgId });
    await assert.rejects(() => verifyWebAccess(first.accessToken));
    await assert.rejects(() => rotateWebSession(second.refreshToken));
    await assert.rejects(() => changeWebPassword(userId, 'replacement', { resetToken, passwordVersion: 0, orgId }));
    await assert.rejects(() => changeWebPassword(userId, 'replacement', { resetToken: `other-${resetToken}`, passwordVersion: 0, orgId }), 'all older reset links are invalid after any password change');
    await assert.rejects(() => changeWebPassword(userId, 'replacement', { expectedPasswordHash: 'old-password-hash' }), 'a stale password comparison cannot overwrite a concurrent reset');
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    assert.equal(user.password_hash, 'test-hash-not-for-login');
    await assert.rejects(() => createWebSession(identity, 'old-password-hash'));
  });
  await t.test('HTTP reset links bind the current password generation and active organization', async () => {
    const [before] = await db.select().from(users).where(eq(users.id, userId));
    const reset = (org_id: string, generation = before.password_version) => jwt.sign({
      id: userId, org_id, purpose: 'password-reset', password_version: generation, jti: randomUUID(),
    }, process.env.JWT_SECRET!, { expiresIn: '15m' });
    const pair = await createWebSession(identity);
    const token = reset(orgId);
    const sibling = reset(orgId);
    const password = 'Reset-regression-only-2026!';
    assert.equal((await post('reset-password', { token: reset(randomUUID()), password })).status, 400);
    const results = await Promise.all([
      post('reset-password', { token, password }),
      post('reset-password', { token: sibling, password: `${password}other` }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    assert.equal((await post('reset-password', { token, password })).status, 400);
    assert.equal((await post('reset-password', { token: sibling, password })).status, 400);
    const [after] = await db.select().from(users).where(eq(users.id, userId));
    assert.equal(after.password_version, before.password_version + 1);
    await assert.rejects(() => verifyWebAccess(pair.accessToken));
    const legacy = jwt.sign({ id: userId, org_id: orgId, purpose: 'password-reset' }, process.env.JWT_SECRET!, { expiresIn: '15m' });
    assert.equal((await post('reset-password', { token: legacy, password })).status, 400);
  });
  await t.test('a real connected socket is evicted on logout and rejects revoked reconnect', async () => {
    const { setupSocket } = await import('../src/socket.js');
    const { io: connect } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');
    const server = createServer();
    const sockets = setupSocket(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const pair = await createWebSession(identity);
    const client = connect(`http://127.0.0.1:${port}`, { auth: { token: pair.accessToken }, transports: ['websocket'], reconnection: false });
    const event = (name: string) => new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Socket ${name} timed out`)), 8000);
      client.once(name, (value: unknown) => { clearTimeout(timer); resolve(value); });
    });
    try {
      await event('connect');
      const disconnected = event('disconnect');
      await revokeWebSession(pair.refreshToken);
      assert.equal(await disconnected, 'io server disconnect');
      const denied = event('connect_error');
      client.connect();
      assert.match(String(await denied), /Invalid token/);
    } finally {
      client.close();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    }
  });
});
