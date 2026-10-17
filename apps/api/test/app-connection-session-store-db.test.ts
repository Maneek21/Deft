import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

function disposableDatabase() {
  const target = process.env.DEFT_E2_TEST_DATABASE_URL;
  if (!target || target !== process.env.DATABASE_URL) return false;
  try { const url = new URL(target); return ['postgres:', 'postgresql:'].includes(url.protocol)
    && url.hostname === '127.0.0.1' && url.port === '33954' && url.username === 'e2_connection_test'
    && url.pathname === '/e2_connection_test' && !url.search && !url.hash; } catch { return false; }
}

test('real PostgreSQL stores across connections, owner scope, single callback CAS and restart uncertainty',
  { skip: !disposableDatabase(), timeout: 60000 }, async t => {
    const [{ drizzle }, { default: pg }, schema, { PostgresAppConnectionSessionStore }, { AppConnectionSessionRecordSchema },
      { and, eq }, { closeDb }] = await Promise.all([import('drizzle-orm/node-postgres'), import('pg'), import('@deft/db/schema'),
      import('../src/lib/app-connection-session-store.js'), import('../src/lib/app-connection-session-service.js'),
      import('drizzle-orm'), import('../src/lib/db.js')]);
    const poolA = new pg.Pool({ connectionString: process.env.DATABASE_URL }), poolB = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    t.after(async () => { await Promise.all([poolA.end(), poolB.end(), closeDb()]); });
    const databaseA = drizzle(poolA, { schema }), databaseB = drizzle(poolB, { schema });
    const org = randomUUID(), user = randomUUID(), sid = randomUUID(), sessionId = randomUUID(), operator = randomUUID();
    const now = new Date().toISOString(), expiry = new Date(Date.now() + 600000).toISOString();
    await databaseA.insert(schema.orgs).values({ id: org, name: 'E2 connection isolated fixture', slug: 'e2-' + org });
    await databaseA.insert(schema.users).values({ id: user, email: 'e2-' + user + '@example.test', name: 'Synthetic owner', kind: 'human', is_agent: false });
    await databaseA.insert(schema.orgMembers).values({ id: randomUUID(), org_id: org, user_id: user, role: 'owner', is_active: true });
    await databaseA.insert(schema.webSessions).values({ id: sid, org_id: org, user_id: user, refresh_token_hash: 'synthetic', expires_at: new Date(expiry) });
    const caller = { org_id: org, user_id: user, sid, access_expires_at: Date.parse(expiry) };
    const storeA = new PostgresAppConnectionSessionStore(databaseA, caller), storeB = new PostgresAppConnectionSessionStore(databaseB, caller);
    const locator = { org_id: org, owner_user_id: user, session_id: sessionId };
    const profile = { schema_version: 'deft.app_connection_profile.v1', key: 'mail', provider_id: 'google_mail', operator_user_id: operator,
      runtime_requirement_key: 'mail', resource_key: 'messages', action_keys: ['send_message'], authorization_origin: 'https://accounts.google.com', credential_custody: 'runtime', executable: false };
    const record = AppConnectionSessionRecordSchema.parse({ session_id: sessionId, revision: 0, scope: { org_id: org, owner_user_id: user,
      installation_id: randomUUID(), app_version_id: randomUUID(), grant_snapshot_id: randomUUID(), package_digest: 'sha256:' + '1'.repeat(64),
      grant_snapshot_digest: 'sha256:' + '2'.repeat(64), lifecycle_epoch: 1, grant_epoch: 1, target_key: 'personal', resource_key: 'messages',
      resource_binding_id: randomUUID(), runtime_registration_id: randomUUID(), operator_user_id: operator, runtime_epoch: 1,
      profile_digest: 'sha256:' + '3'.repeat(64), consent_expires_at: expiry }, profile, state: 'starting', callback_state_hash: '4'.repeat(64),
      callback_consumed: false, callback_expires_at: expiry, runtime_session_ref: null, account: null, created_at: now, updated_at: now });
    assert.equal(await storeA.create(record), true); assert.equal(await storeB.create(record), false);
    assert.deepEqual(await storeB.read(locator), record);
    assert.equal(await storeB.read({ ...locator, org_id: randomUUID() }), null);
    assert.equal(await storeB.read({ ...locator, owner_user_id: randomUUID() }), null);
    const awaiting = { ...record, revision: 1, state: 'awaiting_callback' as const, runtime_session_ref: 'runtime_ref' };
    assert.equal(await storeA.compareAndSet(locator, 0, awaiting), true);
    const connecting = { ...awaiting, revision: 2, state: 'connecting' as const, callback_consumed: true };
    const winners = await Promise.all([storeA.compareAndSet(locator, 1, connecting), storeB.compareAndSet(locator, 1, connecting)]);
    assert.deepEqual(winners.sort(), [false, true]);
    assert.equal((await new PostgresAppConnectionSessionStore(databaseB).read(locator))?.state, 'connecting');
    assert.equal(await storeB.compareAndSet(locator, 2, { ...connecting, revision: 3, callback_consumed: false }), false);
    assert.equal(await storeB.compareAndSet(locator, 2, { ...connecting, revision: 3, scope: { ...connecting.scope, runtime_epoch: 2 } }), false);
    // Database guard separately prevents raw writes from bypassing the store.
    await assert.rejects(databaseB.update(schema.appConnectionSessions).set({ revision: 3, record: { ...connecting, revision: 3,
      callback_consumed: false } }).where(and(eq(schema.appConnectionSessions.org_id, org), eq(schema.appConnectionSessions.session_id, sessionId))));
    assert.equal((await storeA.read(locator))?.revision, 2);
  });
