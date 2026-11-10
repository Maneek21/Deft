/**
 * PR #424 review round 2: restore-access defects F02-F10, each reproduced
 * against a real full-schema PostgreSQL database with every trigger enabled for
 * application calls (only explicitly marked synthetic history rows bypass
 * admission triggers via `fixtureInsert`).
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

const key = (purpose: string) => createHash('sha256').update('restore-access-round2:' + purpose).digest('base64');
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

test('PR424 restore access round 2 (F02-F10)', { skip: !safe, timeout: 300000 }, async (t) => {
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
    DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
    DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_OWNER_CONNECTIONS_ENABLED: 'true' });
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  const [{ db, closeDb }, schema, drizzle, fixtureModule, keyrings, web, webAuthority, hono, routes] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('./fixtures/resource-sync-v5.js'), import('../src/lib/app-run-keyrings.js'),
    import('../src/lib/web-sessions.js'), import('../src/lib/app-resource-sync-web-authority.js'),
    import('hono'), import('../src/routes/app-connection-sessions.js'),
  ]);
  const { getTableName, eq, and, sql } = drizzle;
  const ring = keyrings.parseEnvironmentAppRunKeyrings(process.env.DEFT_APP_RUN_KEYRINGS!);
  const fixture = await fixtureModule.createReviewedResourceSyncFixture({ keys: ring, clock: () => new Date() });
  t.after(async () => { await client.end(); await closeDb(); });

  /** Synthetic history only: inserted already in a later state. */
  async function fixtureInsert(table: any, rows: unknown) {
    await db.transaction(async (tx: any) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.insert(table).values(rows);
    });
  }

  const org = fixture.org_id;
  const owner = fixture.owner_user_id;
  const now = Date.now();
  const [ownerUser] = await db.select().from(schema.users).where(eq(schema.users.id, owner));
  const ownerSession = await web.createWebSession({ id: owner, org_id: org, email: ownerUser!.email });
  const ownerToken = ownerSession.accessToken;
  const sidOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sid as string;
  const webSessionId = sidOf(ownerToken);
  const actor = { org_id: org, user_id: owner, sid: webSessionId, access_expires_at: now + 3600_000 };
  const accountOf = (ownerId: string) => 'acct_' + ownerId.replaceAll('-', '');

  const profile = {
    schema_version: 'deft.app_connection_profile.v1', key: 'primary', provider_id: 'synthetic_provider',
    operator_user_id: fixture.operator_user_id, runtime_requirement_key: 'provider', resource_key: 'inbox',
    action_keys: ['mirror_inbox'], authorization_origin: 'https://provider.example.test',
    credential_custody: 'runtime', executable: false,
  };
  const scopeFor = (targetKey: string, ownerId = owner) => ({
    org_id: org, owner_user_id: ownerId, installation_id: fixture.installation_id,
    app_version_id: fixture.app_version_id, grant_snapshot_id: fixture.grant_snapshot_id,
    package_digest: sha('a'), grant_snapshot_digest: sha('b'), lifecycle_epoch: 1, grant_epoch: 1,
    target_key: targetKey, resource_key: 'inbox', resource_binding_id: fixture.binding_id,
    runtime_registration_id: fixture.registration_id, operator_user_id: fixture.operator_user_id,
    runtime_epoch: 1, profile_digest: sha('c'), consent_expires_at: null, consent_lifetime: 'until_revoked',
  });
  const recordFor = (sessionId: string, targetKey: string, createdAt: string, ownerId = owner, accountRef = accountOf(ownerId)) => ({
    session_id: sessionId, revision: 1, scope: scopeFor(targetKey, ownerId), profile, state: 'connected',
    callback_state_hash: 'a'.repeat(64), callback_consumed: true, callback_expires_at: at(60_000),
    runtime_session_ref: 'runtime_' + sessionId.replaceAll('-', ''),
    account: { account_ref: accountRef, label: 'Synthetic account' },
    created_at: createdAt, updated_at: createdAt,
  });

  async function insertConnected(record: Record<string, any>, webId: string, ownerId: string) {
    const starting = { ...record, revision: 0, state: 'starting', callback_consumed: false };
    await client.query(
      'INSERT INTO app_connection_sessions(org_id,owner_user_id,session_id,web_session_id,access_expires_at,revision,record,created_at,updated_at) VALUES($1,$2,$3,$4,$5,0,$6::jsonb,$7,$8)',
      [org, ownerId, starting.session_id, webId, new Date(now + 3600_000), JSON.stringify(starting), starting.created_at, starting.created_at]);
    const connected = { ...starting, revision: 1, state: 'connected', callback_consumed: true };
    await client.query(
      'UPDATE app_connection_sessions SET revision=1,record=$1::jsonb,updated_at=$2 WHERE org_id=$3 AND owner_user_id=$4 AND session_id=$5',
      [JSON.stringify(connected), connected.updated_at, org, ownerId, connected.session_id]);
    return connected;
  }
  /** A real lifecycle disconnect clears the account (state not_connected). */
  async function disconnect(record: Record<string, any>, ownerId: string, clearAccount: boolean) {
    const next = { ...record, revision: record.revision + 1, state: clearAccount ? 'not_connected' : 'disconnected',
      ...(clearAccount ? { account: null } : {}), updated_at: at(-60_000) };
    await client.query(
      'UPDATE app_connection_sessions SET revision=$1,record=$2::jsonb,updated_at=$3 WHERE org_id=$4 AND owner_user_id=$5 AND session_id=$6',
      [next.revision, JSON.stringify(next), next.updated_at, org, ownerId, next.session_id]);
    return next;
  }
  /** Record consent through the guarded proposed -> active lifecycle. */
  async function insertRecordConsent(session: Record<string, any>, ownerId: string, createdAt: string) {
    const consentId = randomUUID();
    const expiresAt = at(90 * 86400_000);
    const snapshot = {
      schema_version: 'deft.app_data_consent.v1', consent_id: consentId, scope: session.scope,
      connection: { session_id: session.session_id, session_revision: session.revision,
        runtime_session_ref: session.runtime_session_ref, account_ref: session.account.account_ref },
      store: { schema_version: 'deft.app_record_store.v1', key: 'inbox', resource_key: 'inbox',
        runtime_requirement_key: 'provider', max_record_bytes: 4096, max_files: 0,
        max_file_bytes: 1, max_total_file_bytes: 1 },
      data_policy_digest: sha('e'), purpose: 'human_record_write', expires_at: expiresAt,
    };
    await client.query(
      "INSERT INTO app_data_consents(org_id,owner_user_id,consent_id,connection_session_id,store_key,state,consent_digest,snapshot,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,'inbox','proposed',$5,$6::jsonb,$7,$8,$8)",
      [org, ownerId, consentId, session.session_id, sha('f'), JSON.stringify(snapshot), new Date(expiresAt), new Date(createdAt)]);
    await client.query("UPDATE app_data_consents SET state='active' WHERE org_id=$1 AND owner_user_id=$2 AND consent_id=$3",
      [org, ownerId, consentId]);
    return consentId;
  }

  type PairOptions = { action?: boolean; record?: boolean; observation?: boolean; ownerId?: string; webId?: string;
    clearAccount?: boolean; currentAccount?: string; currentRecord?: boolean };
  async function createPair(targetKey: string, options: PairOptions = {}) {
    const ownerId = options.ownerId ?? owner;
    const webId = options.webId ?? webSessionId;
    const priorId = randomUUID(), currentId = randomUUID();
    const priorAt = at(-2 * 3600_000), currentAt = at(-60_000);
    let prior: Record<string, any> = recordFor(priorId, targetKey, priorAt, ownerId);
    if (options.action) {
      const actionConsentId = randomUUID();
      prior = { ...prior, action_consents: [{
        action_binding_id: actionConsentId, action_key: 'mirror_inbox', authority_epoch: 1,
        consent_id: actionConsentId, consent_digest: sha('d'), expires_at: null, consent_lifetime: 'until_revoked',
      }] };
    }
    prior = await insertConnected(prior, webId, ownerId);
    const recordConsentId = options.record ? await insertRecordConsent(prior, ownerId, priorAt) : null;
    let observationConsentId: string | null = null;
    if (options.observation) {
      observationConsentId = randomUUID();
      // One active observation per binding: retire earlier cases' rows first.
      await client.query("UPDATE app_resource_observation_consents SET state='revoked',updated_at=now() WHERE org_id=$1 AND resource_binding_id=$2 AND state='active'",
        [org, fixture.binding_id]);
      await fixtureInsert(schema.appResourceObservationConsents, {
        org_id: org, owner_user_id: ownerId, consent_id: observationConsentId, resource_binding_id: fixture.binding_id,
        connection_session_id: priorId, state: 'active', consent_digest: sha('9'),
        snapshot: {
          schema_version: 'deft.app_resource_observation_consent.v1', consent_id: observationConsentId,
          scope: prior.scope,
          // The predecessor's custody receipt (generation 1). A reconnection
          // starts a new custody chain, so this can never be the current one.
          connection: { session_id: priorId, runtime_session_ref: prior.runtime_session_ref, account_ref: prior.account.account_ref,
            expected_custody_generation: 1, receipt_digest: sha('1') },
          resource_policy_digest: sha('7'), interval_seconds: 300, expires_at: null, consent_lifetime: 'until_revoked',
          review_expires_at: new Date(Date.parse(priorAt) + 300_000).toISOString(),
        },
        expires_at: null, created_at: new Date(priorAt), updated_at: new Date(priorAt),
      });
    }
    await disconnect(prior, ownerId, options.clearAccount ?? false);
    const current = await insertConnected(recordFor(currentId, targetKey, currentAt, ownerId, options.currentAccount ?? accountOf(ownerId)), webId, ownerId);
    const currentRecordConsentId = options.currentRecord ? await insertRecordConsent(current, ownerId, currentAt) : null;
    return { priorId, currentId, recordConsentId, observationConsentId, currentRecordConsentId, prior, current };
  }

  const clock = now;
  const { AppRestoreAccessService } = await import('../src/lib/app-restore-access-service.js');
  const noGuard = Object.assign(async () => {}, { current_web_session_expires_at: () => new Date(now + 3600_000) });
  const nomination = (targetKey: string) => ({ installation_id: fixture.installation_id, target_key: targetKey });
  const envelope = (review: any, targetKey: string, grantIds?: string[]) => ({
    installation_id: fixture.installation_id, target_key: targetKey, review_id: review.review_id,
    review_digest: review.review_digest, review_expires_at: review.review_expires_at,
    ...(grantIds === undefined ? {} : { grant_ids: grantIds }),
  });
  const sessionsOf = async (ownerId: string, targetKey: string) => (await db.select().from(schema.appConnectionSessions).where(and(
    eq(schema.appConnectionSessions.org_id, org), eq(schema.appConnectionSessions.owner_user_id, ownerId))))
    .filter((row) => (row.record as any).scope.target_key === targetKey);
  const reviewRow = async (reviewId: string) => (await client.query('SELECT consumed_at FROM app_restore_access_reviews WHERE id=$1', [reviewId])).rows[0];

  await t.test('PR424-F02: a member downgraded to guest can neither review nor activate restore', async () => {
    const member = randomUUID();
    const email = 'f02-' + member + '@example.test';
    await client.query("INSERT INTO users(id,email,name,kind) VALUES($1,$2,'F02 member','human')", [member, email]);
    await client.query("INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,'member',true)", [randomUUID(), org, member]);
    const session = await web.createWebSession({ id: member, org_id: org, email });
    const sid = sidOf(session.accessToken);
    const memberActor = { org_id: org, user_id: member, sid, access_expires_at: now + 3600_000 };
    const pair = await createPair('f02', { record: true, ownerId: member, webId: sid });
    const serviceFor = async () => {
      const auth = await webAuthority.resourceSyncWebAuthority('Bearer ' + session.accessToken);
      return new AppRestoreAccessService({ database: db as never, guard: auth.guard, now: () => clock });
    };
    // While still a member the review is issued (the guard is real).
    const review = await (await serviceFor()).review(memberActor, nomination('f02'));
    await client.query("UPDATE org_members SET role='guest' WHERE org_id=$1 AND user_id=$2", [org, member]);
    const asGuest = await serviceFor(); // authentication still accepts an active guest
    await assert.rejects(asGuest.review(memberActor, nomination('f02')), { code: 'APP_ACCESS_DENIED' });
    const grant = review.grants.find((item: any) => item.kind === 'record_consent')!;
    await assert.rejects(asGuest.activate(memberActor, envelope(review, 'f02', [grant.grant_id])), { code: 'APP_ACCESS_DENIED' });
    const consents = await client.query('SELECT consent_id,state FROM app_data_consents WHERE org_id=$1 AND owner_user_id=$2', [org, member]);
    assert.deepEqual(consents.rows.map((row) => [row.consent_id, row.state]), [[pair.recordConsentId, 'active']], 'a guest issues nothing');
    assert.equal((await reviewRow(review.review_id)).consumed_at, null, 'a refused activation leaves the review unconsumed');
    const reviews = await client.query('SELECT count(*)::int AS count FROM app_restore_access_reviews WHERE owner_user_id=$1', [member]);
    assert.equal(reviews.rows[0].count, 1, 'a guest review stores nothing');
  });

  await t.test('PR424-F03: restore context resolves the selected target, not the installation-wide newest', async () => {
    const pairA = await createPair('f03_a', { record: true });
    const pairB = await createPair('f03_b', { record: true }); // B is the newest connected session
    const app = new hono.Hono();
    app.route('/api/app-connection-sessions', routes.appConnectionSessionRoutes);
    const get = async (query: string) => {
      const response = await app.request(`/api/app-connection-sessions/installations/${fixture.installation_id}/restore-context${query}`,
        { headers: { authorization: 'Bearer ' + ownerToken } });
      return { status: response.status, body: await response.json() as any };
    };
    const selected = await get('?target_key=f03_a');
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    assert.equal(selected.body.target_key, 'f03_a');
    assert.equal(selected.body.session_id, pairA.currentId);
    assert.ok(selected.body.grants.some((grant: any) => grant.grant_id === pairA.recordConsentId));
    assert.ok(!selected.body.grants.some((grant: any) => grant.grant_id === pairB.recordConsentId), 'B grants are never offered for A');
    assert.equal((await get('?target_key=Bad-Key')).status, 400);
    assert.equal((await get('?other=1')).status, 400);
    // The review/activation pair stays bound to the selected target server-side.
    const service = new AppRestoreAccessService({ database: db as never, guard: noGuard, now: () => clock });
    const review = await service.review(actor, nomination('f03_a'));
    assert.equal(review.session_id, pairA.currentId);
    await assert.rejects(service.activate(actor, envelope(review, 'f03_b', [])), { code: 'APP_ACCESS_DENIED' });
  });

  // Manifest read offering one delegated read store + one agent policy, as a
  // real installed manifest would. Every other query is real.
  const declaration = {
    key: 'mirror_saved', description: 'Mirror a saved record.', operation: 'draft', mode: 'review',
    store_key: 'inbox', resource_key: 'inbox', runtime_requirement_key: 'provider',
    input_schema: { type: 'object', properties: { account: { type: 'string' }, record_id: { type: 'string' } }, additionalProperties: false },
    account_input_key: 'account', data_operations: ['prepare_action'],
    input_pins: [{ operation: 'prepare_action', outer_key: 'record_id', inner_field: 'record_id', required: true }],
    action_key: 'mirror_inbox', visibility: 'delegated_tools',
  };
  function databaseWithManifest() {
    const wrapSelect = (source: any) => (...args: unknown[]) => {
      const query = (source.select as (...values: unknown[]) => { from(table: unknown): unknown }).apply(source, args);
      return { from(table: Parameters<typeof getTableName>[0]) {
        if (getTableName(table) === 'app_versions') {
          return { where() { return { limit: async () => [{ manifest: { integration_tools: [declaration] } }] }; } };
        }
        return query.from(table);
      } };
    };
    return {
      select: wrapSelect(db),
      execute: (...args: unknown[]) => (db.execute as (...values: unknown[]) => unknown).apply(db, args),
      insert: (...args: unknown[]) => (db.insert as (...values: unknown[]) => unknown).apply(db, args),
      update: (...args: unknown[]) => (db.update as (...values: unknown[]) => unknown).apply(db, args),
      transaction: (fn: (tx: unknown) => Promise<unknown>) => db.transaction(async (tx: any) => {
        const wrapped = Object.create(tx);
        wrapped.select = wrapSelect(tx);
        return fn(wrapped);
      }),
    };
  }

  await t.test('PR424-F10: an expired but unrevoked Defty read delegation is renewed, not reported present', async () => {
    const member = owner;
    const memberActor = actor;
    await createPair('f10');
    const expiredId = randomUUID();
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(`INSERT INTO app_integration_principal_grants(id,org_id,owner_user_id,installation_id,resource_binding_id,account_ref,store_key,principal_kind,principal_id,operations,revision,expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,'inbox','defty',$3,ARRAY['read']::text[],1,$7,$8,$8)`,
        [expiredId, org, member, fixture.installation_id, fixture.binding_id, accountOf(member), new Date(now - 86400_000), new Date(now - 10 * 86400_000)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    const service = new AppRestoreAccessService({ database: databaseWithManifest() as never, guard: noGuard, now: () => clock });
    const review = await service.review(memberActor, nomination('f10'));
    const defty = review.grants.find((item: any) => item.kind === 'defty_read_grant')!;
    assert.equal(defty.preselected, true, 'a prior delegation pre-selects the default');
    const result = await service.activate(memberActor, envelope(review, 'f10', [defty.grant_id]));
    assert.equal(result.grants[0]!.outcome, 'issued', 'an expired delegation is not reported as already present');
    const rows = await client.query(`SELECT id,expires_at,operations,revoked_at FROM app_integration_principal_grants
      WHERE org_id=$1 AND owner_user_id=$2 AND store_key='inbox' AND principal_kind='defty' AND revoked_at IS NULL`, [org, member]);
    assert.equal(rows.rows.length, 1);
    assert.ok(new Date(rows.rows[0].expires_at).getTime() > Date.now(), 'restored delegation is live');
    assert.ok(Math.abs(new Date(rows.rows[0].expires_at).getTime() - (now + 90 * 86400_000)) < 120_000, 'renewed under the reviewed lifetime');
    assert.deepEqual(rows.rows[0].operations, ['read']);
    // A live delegation is left untouched and reported present.
    const again = await service.review(memberActor, nomination('f10'));
    const second = await service.activate(memberActor, envelope(again, 'f10', [again.grants.find((item: any) => item.kind === 'defty_read_grant')!.grant_id]));
    assert.equal(second.grants[0]!.outcome, 'already_present');
  });

  await t.test('PR424-F04: prior identity survives a lifecycle disconnect that clears the account', async () => {
    const service = new AppRestoreAccessService({ database: db as never, guard: noGuard, now: () => clock });
    const pair = await createPair('f04', { record: true, clearAccount: true });
    const priorRow = (await sessionsOf(owner, 'f04')).find((row) => row.session_id === pair.priorId)!;
    assert.equal((priorRow.record as any).account, null, 'precondition: the prior session lost its account');
    const review = await service.review(actor, nomination('f04'));
    const grant = review.grants.find((item: any) => item.grant_id === pair.recordConsentId);
    assert.ok(grant, 'the prior record consent is offered for the same account');
    const result = await service.activate(actor, envelope(review, 'f04', [pair.recordConsentId!]));
    assert.equal(result.grants.length, 1);
    // A different current account is still refused.
    await createPair('f04_other', { record: true, clearAccount: true, currentAccount: 'acct_someone_else' });
    await assert.rejects(service.review(actor, nomination('f04_other')), { code: 'APP_REVIEW_REQUIRED' });
  });

  await t.test('PR424-F05: action restore never fabricates runtime pins', async () => {
    // (a) Without a live runtime binding the production reader refuses; nothing is written.
    const strict = new AppRestoreAccessService({ database: db as never, guard: noGuard, now: () => clock });
    await createPair('f05_none', { action: true });
    const review = await strict.review(actor, nomination('f05_none'));
    const grant = review.grants.find((item: any) => item.kind === 'action_consent')!;
    await assert.rejects(strict.activate(actor, envelope(review, 'f05_none', [grant.grant_id])),
      (error: any) => ['APP_REVIEW_REQUIRED', 'APP_ACCESS_DENIED'].includes(error.code));
    assert.equal((await sessionsOf(owner, 'f05_none')).length, 2, 'no successor session is published');
    assert.equal((await reviewRow(review.review_id)).consumed_at, null);
    // (b) With a live binding the stored consent is exactly the live one.
    const bindingId = randomUUID();
    const liveConsent = { action_binding_id: bindingId, action_key: 'mirror_inbox', authority_epoch: 1,
      consent_id: bindingId, consent_digest: sha('5'), expires_at: null, consent_lifetime: 'until_revoked' as const };
    const live = new AppRestoreAccessService({ database: db as never, guard: noGuard, now: () => clock,
      liveActionConsents: async () => [liveConsent] });
    await createPair('f05_live', { action: true });
    const liveReview = await live.review(actor, nomination('f05_live'));
    const liveGrant = liveReview.grants.find((item: any) => item.kind === 'action_consent')!;
    const result = await live.activate(actor, envelope(liveReview, 'f05_live', [liveGrant.grant_id]));
    const successor = (await sessionsOf(owner, 'f05_live')).find((row) => row.session_id === result.session_id)!;
    assert.deepEqual((successor.record as any).action_consents, [liveConsent], 'the live runtime-authority consent is stored verbatim');
  });

  const liveConsentFor = () => {
    const bindingId = randomUUID();
    return { action_binding_id: bindingId, action_key: 'mirror_inbox', authority_epoch: 1,
      consent_id: bindingId, consent_digest: sha('6'), expires_at: null, consent_lifetime: 'until_revoked' as const };
  };

  await t.test('PR424-F06: publishing an action successor carries live saved-record consents', async () => {
    const consent = liveConsentFor();
    const service = new AppRestoreAccessService({ database: db as never, guard: noGuard, now: () => clock,
      liveActionConsents: async () => [consent] });
    const pair = await createPair('f06', { action: true, currentRecord: true });
    const review = await service.review(actor, nomination('f06'));
    const grant = review.grants.find((item: any) => item.kind === 'action_consent')!;
    const result = await service.activate(actor, envelope(review, 'f06', [grant.grant_id]));
    assert.notEqual(result.session_id, pair.currentId);
    const rows = (await client.query('SELECT consent_id,connection_session_id,state,expires_at FROM app_data_consents WHERE org_id=$1 AND owner_user_id=$2 AND connection_session_id = ANY($3)',
      [org, owner, [pair.currentId, result.session_id]])).rows;
    const old = rows.find((row) => row.consent_id === pair.currentRecordConsentId)!;
    const carried = rows.filter((row) => row.connection_session_id === result.session_id && row.state === 'active');
    assert.equal(carried.length, 1, 'the saved-record consent is live on the successor');
    assert.equal(old.state, 'revoked', 'the predecessor row is soft-transitioned');
    assert.equal(new Date(carried[0].expires_at).getTime(), new Date(old.expires_at).getTime(), 'expiry is preserved, never widened');
  });

  await t.test('PR424-F07: observation restore pins the current connection custody, not the predecessor receipt', async () => {
    const service = new AppRestoreAccessService({ database: db as never, guard: noGuard, now: () => clock,
      observationConnection: async () => ({ receipt: null, resource_policy_digest: sha('7'), min_interval_seconds: 60 }) });
    const pair = await createPair('f07', { observation: true });
    const review = await service.review(actor, nomination('f07'));
    const grant = review.grants.find((item: any) => item.kind === 'observation_consent')!;
    const result = await service.activate(actor, envelope(review, 'f07', [grant.grant_id]));
    assert.equal(result.grants.length, 1);
    const rows = (await client.query('SELECT snapshot,state FROM app_resource_observation_consents WHERE org_id=$1 AND consent_id=$2',
      [org, result.grants[0]!.grant_id])).rows;
    assert.equal(rows[0].state, 'active');
    assert.equal(rows[0].snapshot.connection.session_id, pair.currentId);
    assert.equal(rows[0].snapshot.connection.expected_custody_generation, null);
    assert.equal(rows[0].snapshot.connection.receipt_digest, null);
    // A changed resource policy is never silently re-consented.
    const changed = new AppRestoreAccessService({ database: db as never, guard: noGuard, now: () => clock,
      observationConnection: async () => ({ receipt: null, resource_policy_digest: sha('8'), min_interval_seconds: 60 }) });
    await createPair('f07_policy', { observation: true });
    const policyReview = await changed.review(actor, nomination('f07_policy'));
    const policyGrant = policyReview.grants.find((item: any) => item.kind === 'observation_consent')!;
    await assert.rejects(changed.activate(actor, envelope(policyReview, 'f07_policy', [policyGrant.grant_id])), { code: 'APP_ACCESS_DENIED' });
  });

  await t.test('PR424-F08: a connection carrying a completed protocol journal refuses action restore cleanly', async () => {
    const consent = liveConsentFor();
    const service = new AppRestoreAccessService({ database: db as never, guard: noGuard, now: () => clock,
      liveActionConsents: async () => [{ ...consent, expires_at: at(29 * 86400_000), consent_lifetime: undefined }] });
    const targetKey = 'f08';
    const priorId = randomUUID(), currentId = randomUUID();
    const consentExpiresAt = at(30 * 86400_000);
    const finiteScope = { ...scopeFor(targetKey), consent_expires_at: consentExpiresAt } as Record<string, unknown>;
    delete finiteScope.consent_lifetime;
    const actionConsentId = randomUUID();
    let prior: Record<string, any> = { ...recordFor(priorId, targetKey, at(-2 * 3600_000)), scope: finiteScope,
      action_consents: [{ action_binding_id: actionConsentId, action_key: 'mirror_inbox', authority_epoch: 1,
        consent_id: actionConsentId, consent_digest: sha('d'), expires_at: consentExpiresAt }] };
    prior = await insertConnected(prior, webSessionId, owner);
    await disconnect(prior, owner, false);
    const currentAt = at(-60_000);
    const current = { ...recordFor(currentId, targetKey, currentAt), scope: finiteScope,
      reattachment: {
        schema_version: 'deft.app_connection_reattachment.v1',
        source: { session_id: priorId, session_revision: 1, scope: finiteScope,
          runtime_session_ref: prior.runtime_session_ref, account_ref: accountOf(owner) },
        transport_digest: sha('3'), review_expires_at: at(3600_000),
        review: { digest: sha('4'), custody_generation: 1, custody_digest: sha('5'),
          account: { account_ref: accountOf(owner), label: 'Synthetic account' } },
        receipt: { custody_generation: 2, receipt_digest: sha('6') },
      } };
    await fixtureInsert(schema.appConnectionSessions, {
      org_id: org, owner_user_id: owner, session_id: currentId, web_session_id: webSessionId,
      access_expires_at: new Date(now + 3600_000), revision: 1, record: current,
      created_at: new Date(currentAt), updated_at: new Date(currentAt),
    });
    const review = await service.review(actor, nomination(targetKey));
    const grant = review.grants.find((item: any) => item.kind === 'action_consent')!;
    await assert.rejects(service.activate(actor, envelope(review, targetKey, [grant.grant_id])),
      (error: any) => error.code === 'APP_REVIEW_REQUIRED' && error.status === 403);
    assert.equal((await sessionsOf(owner, targetKey)).length, 2, 'no successor is attempted');
    assert.equal((await reviewRow(review.review_id)).consumed_at, null, 'the review stays usable for other items');
  });
});
