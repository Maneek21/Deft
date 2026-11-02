/**
 * Restore-access review, HTTP + real PostgreSQL proof.
 *
 * Run with matching DEFT_TEST_DATABASE_URL/DATABASE_URL pointing at a local,
 * disposable test database (the brief's 127.0.0.1:55520/deft_test, or the
 * 127.0.0.1:5432/deft_test fallback).
 *
 * Covers design-p2-host.md §2-§5: read-only enumeration, same-lifetime
 * re-issue, never-widen, subset activation, lapsed vs revoked defaults,
 * tenant isolation, audit lineage, the same-account gate, and the app-neutral
 * grant-kind registry.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

// Deterministic disposable keys: env.ts validates a keyring at first import.
const key = (purpose: string) => createHash('sha256').update('restore-access:' + purpose).digest('base64');
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({
  schema_version: 'deft.app_run_keyring.v1',
  run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key('enc') } },
  receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key('sig') } },
  fingerprint: { current: 'fp-v1', keys: { 'fp-v1': key('fp') } },
});

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && /^\/deft_test/u.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
})();

const sha = (value: string) => 'sha256:' + value.repeat(64).slice(0, 64);
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const seconds = (iso: string | Date | null) => iso === null ? null : new Date(iso).getTime();

/** These app tables are absent from the minimal local deft_test baseline.
 * Creating them is idempotent; on a fully pushed database every statement is a
 * no-op. No production table is altered or dropped. */
async function ensureRelations(client: pg.Client) {
  await client.query(`CREATE TABLE IF NOT EXISTS web_sessions (
    id text PRIMARY KEY, user_id text NOT NULL, org_id text NOT NULL,
    refresh_token_hash text NOT NULL, expires_at timestamptz NOT NULL,
    revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_connection_sessions (
    org_id text NOT NULL, owner_user_id text NOT NULL, session_id text NOT NULL,
    web_session_id text NOT NULL, access_expires_at timestamptz NOT NULL,
    revision integer NOT NULL, record jsonb NOT NULL,
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
    PRIMARY KEY (org_id, owner_user_id, session_id))`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_data_consents (
    org_id text NOT NULL, owner_user_id text NOT NULL, consent_id text NOT NULL,
    connection_session_id text NOT NULL, store_key text NOT NULL, state text NOT NULL,
    consent_digest text NOT NULL, snapshot jsonb NOT NULL, expires_at timestamptz,
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
    PRIMARY KEY (org_id, owner_user_id, consent_id))`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_resource_observation_consents (
    org_id text NOT NULL, owner_user_id text NOT NULL, consent_id text NOT NULL,
    resource_binding_id text NOT NULL, connection_session_id text NOT NULL,
    state text NOT NULL, consent_digest text NOT NULL, snapshot jsonb NOT NULL,
    expires_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
    PRIMARY KEY (org_id, consent_id))`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS app_resource_observation_one_active
    ON app_resource_observation_consents (org_id, resource_binding_id) WHERE state = 'active'`);
}

test('restore access review re-issues prior grants at the same lifetime, never widened, owner-scoped',
  { skip: !safe, timeout: 120000 }, async (t) => {
    const client = new pg.Client({ connectionString: target });
    await client.connect();
    await ensureRelations(client);
    Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
      DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
      DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_OWNER_CONNECTIONS_ENABLED: 'true' });

    const [hono, dbModule, schema, drizzle, connections, web] = await Promise.all([
      import('hono'), import('../src/lib/db.js'), import('@deft/db/schema'),
      import('drizzle-orm'), import('../src/routes/app-connection-sessions.js'), import('../src/lib/web-sessions.js'),
    ]);
    const { db, closeDb } = dbModule;
    const { and, eq, inArray } = drizzle;

    const orgA = randomUUID(), orgB = randomUUID();
    const ownerA = randomUUID(), ownerB = randomUUID();
    const installation = randomUUID(), foreignInstallation = randomUUID();
    const binding = randomUUID();
    const targetKey = 'primary';
    const accountRef = 'acct_' + randomUUID().replaceAll('-', '');
    const cleanupOrgs = [orgA, orgB];

    t.after(async () => {
      for (const table of ['audit_log', 'app_resource_observation_consents', 'app_data_consents', 'app_connection_sessions']) {
        await client.query(`DELETE FROM ${table} WHERE org_id = ANY($1)`, [cleanupOrgs]).catch(() => {});
      }
      await client.query('DELETE FROM web_sessions WHERE org_id = ANY($1)', [cleanupOrgs]).catch(() => {});
      await client.query('DELETE FROM org_members WHERE org_id = ANY($1)', [cleanupOrgs]).catch(() => {});
      await client.query('DELETE FROM users WHERE id = ANY($1)', [[ownerA, ownerB]]).catch(() => {});
      await client.query('DELETE FROM orgs WHERE id = ANY($1)', [cleanupOrgs]).catch(() => {});
      await client.end();
      await closeDb();
    });

    await db.insert(schema.orgs).values([{ id: orgA, name: 'Restore A', slug: 'restore-a-' + orgA },
      { id: orgB, name: 'Restore B', slug: 'restore-b-' + orgB }]);
    await db.insert(schema.users).values([{ id: ownerA, name: 'Owner A', email: 'restore-a-' + ownerA + '@example.test', kind: 'human' },
      { id: ownerB, name: 'Owner B', email: 'restore-b-' + ownerB + '@example.test', kind: 'human' }]);
    await db.insert(schema.orgMembers).values([
      { id: randomUUID(), org_id: orgA, user_id: ownerA, role: 'owner', is_active: true },
      { id: randomUUID(), org_id: orgB, user_id: ownerB, role: 'owner', is_active: true },
    ]);
    const sessionA = await web.createWebSession({ id: ownerA, org_id: orgA, email: 'restore-a-' + ownerA + '@example.test' });
    const sessionB = await web.createWebSession({ id: ownerB, org_id: orgB, email: 'restore-b-' + ownerB + '@example.test' });

    const app = new hono.Hono();
    app.route('/api/app-connection-sessions', connections.appConnectionSessionRoutes);
    const call = async (path: string, token: string, value?: unknown, method?: string) => {
      const response = await app.request(path, {
        method: method ?? (value === undefined ? 'GET' : 'POST'),
        headers: { authorization: 'Bearer ' + token, ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
      return { status: response.status, body: await response.json() as any };
    };

    const profile = {
      schema_version: 'deft.app_connection_profile.v1', key: 'primary', provider_id: 'synthetic_provider',
      operator_user_id: ownerA, runtime_requirement_key: 'sync_provider', resource_key: 'inbox',
      action_keys: ['send_item'], authorization_origin: 'https://provider.example.test',
      credential_custody: 'runtime', executable: false,
    };
    const scope = (sessionId: string) => ({
      org_id: orgA, owner_user_id: ownerA, installation_id: installation,
      app_version_id: randomUUID(), grant_snapshot_id: randomUUID(),
      package_digest: sha('a'), grant_snapshot_digest: sha('b'), lifecycle_epoch: 1, grant_epoch: 1,
      target_key: targetKey, resource_key: 'inbox', resource_binding_id: binding,
      runtime_registration_id: randomUUID(), operator_user_id: ownerA, runtime_epoch: 1,
      profile_digest: sha('c'), consent_expires_at: at(180 * 86400_000),
    });
    const recordFor = (sessionId: string, state: string, createdAt: string, extras: Record<string, unknown> = {}) => {
      const s = scope(sessionId);
      return {
        session_id: sessionId, revision: 1, scope: s, profile, state,
        callback_state_hash: 'a'.repeat(64), callback_consumed: true, callback_expires_at: at(60_000),
        runtime_session_ref: 'runtime_' + sessionId.replaceAll('-', ''),
        account: { account_ref: accountRef, label: 'Synthetic account' },
        created_at: createdAt, updated_at: createdAt, ...extras,
      };
    };
    const sessionRow = (sessionId: string, record: Record<string, unknown>, createdAt: string, org = orgA, owner = ownerA) => ({
      org_id: org, owner_user_id: owner, session_id: sessionId, web_session_id: sessionA.accessToken ? randomUUID() : randomUUID(),
      access_expires_at: new Date(Date.now() + 3600_000), revision: 1, record,
      created_at: new Date(createdAt), updated_at: new Date(createdAt),
    });

    const priorSession = randomUUID();
    const currentSession = randomUUID();
    const priorCreated = at(-30 * 86400_000);
    const actionConsentId = randomUUID();
    await db.insert(schema.appConnectionSessions).values([
      sessionRow(priorSession, recordFor(priorSession, 'disconnected', priorCreated, {
        action_consents: [{
          action_binding_id: actionConsentId, action_key: 'send_item', authority_epoch: 1,
          consent_id: actionConsentId, consent_digest: sha('d'), expires_at: at(-25 * 86400_000),
        }],
      }), priorCreated),
      sessionRow(currentSession, recordFor(currentSession, 'connected', at(-60_000)), at(-60_000)),
    ]);

    const store = (key: string) => ({
      schema_version: 'deft.app_record_store.v1', key, resource_key: 'inbox',
      runtime_requirement_key: 'sync_provider', max_record_bytes: 4096, max_files: 0,
      max_file_bytes: 1, max_total_file_bytes: 1,
    });
    const consentRow = (input: { storeKey: string; state: string; createdAt: string; expiresAt: string | null; sessionId?: string; orgId?: string; owner?: string }) => {
      const consentId = randomUUID(), sessionId = input.sessionId ?? priorSession;
      const snapshot = {
        schema_version: 'deft.app_data_consent.v1', consent_id: consentId,
        scope: scope(sessionId),
        connection: { session_id: sessionId, session_revision: 1,
          runtime_session_ref: 'runtime_' + sessionId.replaceAll('-', ''), account_ref: accountRef },
        store: store(input.storeKey), data_policy_digest: sha('e'), purpose: 'human_record_write',
        expires_at: input.expiresAt,
      };
      return { consentId, row: {
        org_id: input.orgId ?? orgA, owner_user_id: input.owner ?? ownerA, consent_id: consentId,
        connection_session_id: sessionId, store_key: input.storeKey, state: input.state,
        consent_digest: sha('f'), snapshot, expires_at: input.expiresAt === null ? null : new Date(input.expiresAt),
        created_at: new Date(input.createdAt), updated_at: new Date(input.createdAt),
      } };
    };

    const alpha = consentRow({ storeKey: 'alpha', state: 'active', createdAt: at(-30 * 86400_000), expiresAt: at(60 * 86400_000) });
    const lapsed = consentRow({ storeKey: 'lapsed', state: 'active', createdAt: at(-7200_000), expiresAt: at(-3600_000) });
    const revoked = consentRow({ storeKey: 'revoked_store', state: 'revoked', createdAt: at(-30 * 86400_000), expiresAt: at(60 * 86400_000) });
    // A store the caller could try to add: it exists, but belongs to a different installation.
    const foreign = consentRow({ storeKey: 'foreign_store', state: 'active', createdAt: at(-30 * 86400_000), expiresAt: at(60 * 86400_000),
      sessionId: randomUUID(), orgId: orgA, owner: ownerA });
    const observationConsentId = randomUUID();
    const observationRow = {
      org_id: orgA, owner_user_id: ownerA, consent_id: observationConsentId, resource_binding_id: binding,
      connection_session_id: priorSession, state: 'active', consent_digest: sha('1'), expires_at: new Date(at(60 * 86400_000)),
      snapshot: {
        schema_version: 'deft.app_resource_observation_consent.v1', consent_id: observationConsentId,
        scope: scope(priorSession),
        connection: { session_id: priorSession, runtime_session_ref: 'runtime_' + priorSession.replaceAll('-', ''),
          account_ref: accountRef, expected_custody_generation: null, receipt_digest: null },
        resource_policy_digest: sha('2'), interval_seconds: 300, expires_at: at(60 * 86400_000),
      },
      created_at: new Date(at(-30 * 86400_000)), updated_at: new Date(at(-30 * 86400_000)),
    };
    await db.insert(schema.appDataConsents).values([alpha.row, lapsed.row, revoked.row, foreign.row]);
    await db.insert(schema.appResourceObservationConsents).values(observationRow);

    // §2.2 read-only context, scoped to the owner.
    const context = await call(`/api/app-connection-sessions/installations/${installation}/restore-context`, sessionA.accessToken);
    assert.equal(context.status, 200, JSON.stringify(context.body));
    assert.equal(context.body.schema_version, 'deft.app_restore_access_context.v1');
    assert.equal(context.body.target_key, targetKey);
    assert.equal(context.body.account_ref, accountRef);
    const contextGrants = context.body.grants as any[];
    const byKey = (list: any[], key: string) => list.filter((grant) => grant.store_key === key);
    assert.equal(byKey(contextGrants, 'alpha')[0].state, 'active');
    assert.equal(byKey(contextGrants, 'lapsed')[0].state, 'expired');
    assert.equal(byKey(contextGrants, 'lapsed')[0].preselected, false, 'lapsed grants are listed but not pre-selected (§5.3)');
    assert.equal(byKey(contextGrants, 'revoked_store')[0].state, 'revoked');
    assert.equal(byKey(contextGrants, 'revoked_store')[0].restorable, false);
    assert.equal(byKey(contextGrants, 'foreign_store').length, 0, 'grants from another installation are never enumerated');
    assert.equal(contextGrants.filter((grant) => grant.kind === 'action_consent')[0].action_key, 'send_item');
    assert.equal(contextGrants.filter((grant) => grant.kind === 'observation_consent')[0].interval_seconds, 300);
    assert.equal(contextGrants.filter((grant) => grant.kind === 'observation_consent')[0].state, 'active');

    // §3.2 tenant isolation: org B sees nothing and cannot open a review.
    const foreignContext = await call(`/api/app-connection-sessions/installations/${installation}/restore-context`, sessionB.accessToken);
    assert.equal(foreignContext.status, 200);
    assert.deepEqual(foreignContext.body.grants, []);
    const foreignReview = await call('/api/app-connection-sessions/restore/review', sessionB.accessToken,
      { installation_id: installation, target_key: targetKey });
    assert.equal(foreignReview.status, 403);

    // §2.3 signed review envelope.
    const review = await call('/api/app-connection-sessions/restore/review', sessionA.accessToken,
      { installation_id: installation, target_key: targetKey });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.equal(review.body.schema_version, 'deft.app_restore_access_review.v1');
    assert.match(review.body.review_digest, /^sha256:[a-f0-9]{64}$/u);
    const reviewGrants = review.body.grants as any[];
    const grantOf = (list: any[], key: string) => list.find((grant) => grant.store_key === key);
    assert.equal(grantOf(reviewGrants, 'alpha').lifetime.kind, 'duration');
    assert.equal(grantOf(reviewGrants, 'alpha').lifetime.seconds, 90 * 86400);
    assert.equal(grantOf(reviewGrants, 'alpha').preselected, true);
    assert.equal(grantOf(reviewGrants, 'lapsed').preselected, false);
    assert.equal(grantOf(reviewGrants, 'revoked_store').restorable, false);

    const envelope = {
      review_id: review.body.review_id, review_digest: review.body.review_digest,
      review_expires_at: review.body.review_expires_at, installation_id: installation, target_key: targetKey,
    };
    const chosen = ['alpha', 'lapsed'].map((key) => grantOf(reviewGrants, key).grant_id);
    chosen.push(reviewGrants.find((grant) => grant.kind === 'observation_consent').grant_id);
    chosen.push(reviewGrants.find((grant) => grant.kind === 'action_consent').grant_id);

    // §3.3 never widening: strict body rejects caller-supplied lifetimes.
    const widened = await call('/api/app-connection-sessions/restore/activate', sessionA.accessToken,
      { ...envelope, grant_ids: chosen, lifetime: { kind: 'duration', seconds: 99999999 } });
    assert.equal(widened.status, 400);
    assert.equal(widened.body.code, 'VALIDATION_ERROR');

    // A self-extended review window (never issued by review) is refused.
    const extended = await call('/api/app-connection-sessions/restore/activate', sessionA.accessToken,
      { ...envelope, grant_ids: chosen, review_expires_at: new Date(Date.now() + 86400_000).toISOString() });
    assert.equal(extended.status, 403);

    // §5.2 narrowing only: an unrelated/fabricated grant id is refused.
    const added = await call('/api/app-connection-sessions/restore/activate', sessionA.accessToken,
      { ...envelope, grant_ids: [...chosen, randomUUID()] });
    assert.equal(added.status, 403);
    // Revoked grants are never re-issued (§2.2/§5.3).
    const resurrect = await call('/api/app-connection-sessions/restore/activate', sessionA.accessToken,
      { ...envelope, grant_ids: [...chosen, grantOf(reviewGrants, 'revoked_store').grant_id] });
    assert.equal(resurrect.status, 403);
    const notInDigest = await call('/api/app-connection-sessions/restore/activate', sessionA.accessToken,
      { ...envelope, grant_ids: [foreign.consentId] });
    assert.equal(notInDigest.status, 403);
    // §3.2 a review opened by org A cannot be activated by org B.
    const crossTenant = await call('/api/app-connection-sessions/restore/activate', sessionB.accessToken,
      { ...envelope, grant_ids: chosen });
    assert.equal(crossTenant.status, 403);

    const before = await db.select().from(schema.appDataConsents).where(and(
      eq(schema.appDataConsents.org_id, orgA), eq(schema.appDataConsents.state, 'active')));
    assert.equal(before.filter((row) => row.store_key === 'alpha').length, 1, 'failed attempts issue nothing');

    // §2.3 one transaction, same lifetime, old rows soft-transitioned.
    const activated = await call('/api/app-connection-sessions/restore/activate', sessionA.accessToken,
      { ...envelope, grant_ids: chosen });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.schema_version, 'deft.app_restore_access_activate.v1');
    assert.equal(activated.body.grants.length, 4);
    const activatedKinds = activated.body.grants.map((grant: any) => grant.kind).sort();
    assert.deepEqual(activatedKinds, ['action_consent', 'observation_consent', 'record_consent', 'record_consent']);

    const rows = await db.select().from(schema.appDataConsents).where(eq(schema.appDataConsents.org_id, orgA));
    const alphaRows = rows.filter((row) => row.store_key === 'alpha');
    assert.equal(alphaRows.length, 2, 'original row is retained for audit, new row issued');
    const alphaOld = alphaRows.find((row) => row.consent_id === alpha.consentId)!;
    const alphaNew = alphaRows.find((row) => row.consent_id !== alpha.consentId)!;
    assert.equal(alphaOld.state, 'revoked');
    assert.equal(alphaNew.state, 'active');
    assert.equal(alphaNew.connection_session_id, currentSession);
    const alphaLifetime = (seconds(alphaNew.expires_at)!) - Date.now();
    assert.ok(Math.abs(alphaLifetime - 90 * 86400_000) < 120_000, 'same original lifetime is replayed');

    const lapsedRows = rows.filter((row) => row.store_key === 'lapsed');
    const lapsedNew = lapsedRows.find((row) => row.consent_id !== lapsed.consentId)!;
    assert.ok(Math.abs((seconds(lapsedNew.expires_at)!) - Date.now() - 3600_000) < 120_000, 'expired grant replays its original duration');

    const revokedRows = rows.filter((row) => row.store_key === 'revoked_store');
    assert.equal(revokedRows.length, 1);
    assert.equal(revokedRows[0]!.state, 'revoked', 'revoked grants are never re-issued');

    const observations = await db.select().from(schema.appResourceObservationConsents)
      .where(eq(schema.appResourceObservationConsents.org_id, orgA));
    const activeObservations = observations.filter((row) => row.state === 'active');
    assert.equal(activeObservations.length, 1, 'the unique active observation index is satisfied');
    assert.notEqual(activeObservations[0]!.consent_id, observationConsentId);
    assert.equal((activeObservations[0]!.snapshot as any).interval_seconds, 300);
    assert.equal(observations.find((row) => row.consent_id === observationConsentId)!.state, 'revoked');

    const [currentRow] = await db.select().from(schema.appConnectionSessions).where(and(
      eq(schema.appConnectionSessions.org_id, orgA), eq(schema.appConnectionSessions.session_id, currentSession)));
    const restoredAction = ((currentRow!.record as any).action_consents as any[])
      .find((consent) => consent.action_key === 'send_item');
    assert.ok(restoredAction, 'the action consent is re-issued on the reconnected session record');
    assert.notEqual(restoredAction.consent_id, actionConsentId);
    assert.ok(Math.abs(seconds(restoredAction.expires_at)! - Date.now() - 5 * 86400_000) < 120_000,
      'action consent replays its original duration');

    const audit = await db.select().from(schema.auditLog).where(and(
      eq(schema.auditLog.org_id, orgA), eq(schema.auditLog.action, 'app_restore_access_activate')));
    assert.equal(audit.length, 4);
    for (const entry of audit) {
      const metadata = entry.metadata as any;
      assert.equal(metadata.review_id, review.body.review_id);
      assert.ok(metadata.restored_from_grant_id);
      assert.ok(entry.entity_id);
    }
    assert.deepEqual(new Set(audit.map((entry) => (entry.metadata as any).kind)),
      new Set(['record_consent', 'observation_consent', 'action_consent']));

    // §5.1 same provider account only.
    const mismatchInstallation = randomUUID();
    const priorId = randomUUID(), currentId = randomUUID();
    const priorCreatedAt = at(-3600_000);
    await db.insert(schema.appConnectionSessions).values([
      sessionRow(priorId, {
        ...recordFor(priorId, 'disconnected', priorCreatedAt), scope: { ...scope(priorId),
          installation_id: mismatchInstallation, resource_binding_id: randomUUID() },
      }, priorCreatedAt),
      sessionRow(currentId, {
        ...recordFor(currentId, 'connected', at(-60_000)),
        account: { account_ref: 'acct_' + randomUUID().replaceAll('-', ''), label: 'Different account' },
        scope: { ...scope(currentId), installation_id: mismatchInstallation, resource_binding_id: randomUUID() },
      }, at(-60_000)),
    ]);
    const mismatch = await call('/api/app-connection-sessions/restore/review', sessionA.accessToken,
      { installation_id: mismatchInstallation, target_key: targetKey });
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.body.code, 'APP_REVIEW_REQUIRED');
    assert.deepEqual(mismatch.body.details.next_step,
      { kind: 'reconnect', installation_id: mismatchInstallation, target_key: targetKey });

    // §5.5 the kind registry covers every enumerable grant kind.
    const contextModule = await import('../src/lib/app-restore-access-context.js');
    const serviceModule = await import('../src/lib/app-restore-access-service.js');
    assert.deepEqual([...serviceModule.RESTORE_GRANT_HANDLERS.keys()].sort(),
      [...contextModule.RESTORE_GRANT_KINDS].sort());
  });
