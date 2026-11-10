/**
 * Restore-access review, activation and review-freshness proof against a real
 * full-schema PostgreSQL database.
 *
 * Covers the probe findings A05 (action + record consent restores blocked by
 * the immutable-session / reviewed-consent guards), A07 (review freshness),
 * A08 (implicit opt-in of unselected defaults) and the until_revoked Defty
 * default regression. Reviews are server-stored, single-use records; no raw
 * digest-only freshness check remains.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

const key = (purpose: string) => createHash('sha256').update('restore-access-db:' + purpose).digest('base64');
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
      && ['55440', '5432'].includes(url.port)
      && /^\/(?:deft_test|fix_a_)/u.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
})();

const sha = (value: string) => 'sha256:' + value.repeat(64).slice(0, 64);
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

test('restore access: guarded action/record restores, stored reviews, explicit opt-in',
  { skip: !safe, timeout: 180000 }, async (t) => {
    Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true' });
    const client = new pg.Client({ connectionString: target });
    await client.connect();
    const [{ db, closeDb }, schema, drizzle, fixtureModule, keyrings] = await Promise.all([
      import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
      import('./fixtures/resource-sync-v5.js'), import('../src/lib/app-run-keyrings.js'),
    ]);
    const { getTableName, eq, and } = drizzle;
    const ring = keyrings.parseEnvironmentAppRunKeyrings(process.env.DEFT_APP_RUN_KEYRINGS!);
    const fixture = await fixtureModule.createReviewedResourceSyncFixture({ keys: ring, clock: () => new Date() });
    t.after(async () => { await client.end(); await closeDb(); });

    const org = fixture.org_id;
    const owner = fixture.owner_user_id;
    const webSessionId = randomUUID();
    const now = Date.now();
    await client.query(
      'INSERT INTO web_sessions(id,user_id,org_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,$5)',
      [webSessionId, owner, org, 'a'.repeat(64), new Date(now + 3600_000)]);
    const actor = { org_id: org, user_id: owner, sid: webSessionId, access_expires_at: now + 3600_000 };

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
    const recordFor = (sessionId: string, targetKey: string, createdAt: string, ownerId = owner) => ({
      session_id: sessionId, revision: 1, scope: scopeFor(targetKey, ownerId), profile, state: 'connected',
      callback_state_hash: 'a'.repeat(64), callback_consumed: true, callback_expires_at: at(60_000),
      runtime_session_ref: 'runtime_' + sessionId.replaceAll('-', ''),
      account: { account_ref: 'acct_' + fixture.owner_user_id.replaceAll('-', ''), label: 'Synthetic account' },
      created_at: createdAt, updated_at: createdAt,
    });

    /** Insert a session through the legal starting -> connected admission, so
     * the real `.128` guard is exercised rather than bypassed. */
    async function insertConnected(record: Record<string, unknown>, webId = webSessionId, ownerId = owner) {
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
    async function disconnect(record: Record<string, unknown>, ownerId = owner) {
      const next = { ...record, revision: (record.revision as number) + 1, state: 'disconnected', updated_at: at(-60_000) };
      await client.query(
        'UPDATE app_connection_sessions SET revision=$1,record=$2::jsonb,updated_at=$3 WHERE org_id=$4 AND owner_user_id=$5 AND session_id=$6',
        [next.revision, JSON.stringify(next), next.updated_at, org, ownerId, next.session_id]);
      return next;
    }

    /** Build one reconnected pair: a disconnected prior session (carrying an
     * optional action consent and record consent) and a connected current one. */
    async function createPair(targetKey: string, options: { action?: boolean; record?: boolean; ownerId?: string; webId?: string } = {}) {
      const ownerId = options.ownerId ?? owner;
      const webId = options.webId ?? webSessionId;
      const priorId = randomUUID(), currentId = randomUUID();
      const priorAt = at(-2 * 3600_000), currentAt = at(-60_000);
      let prior = recordFor(priorId, targetKey, priorAt, ownerId);
      if (options.action) {
        const actionConsentId = randomUUID();
        prior = { ...prior, action_consents: [{
          action_binding_id: actionConsentId, action_key: 'mirror_inbox', authority_epoch: 1,
          consent_id: actionConsentId, consent_digest: sha('d'), expires_at: null, consent_lifetime: 'until_revoked',
        }] };
      }
      prior = await insertConnected(prior, webId, ownerId);
      let recordConsentId: string | null = null;
      if (options.record) {
        recordConsentId = randomUUID();
        const scope = scopeFor(targetKey, ownerId);
        const recordExpiresAt = at(90 * 86400_000);
        const snapshot = {
          schema_version: 'deft.app_data_consent.v1', consent_id: recordConsentId, scope,
          connection: { session_id: priorId, session_revision: prior.revision,
            runtime_session_ref: prior.runtime_session_ref, account_ref: (prior.account as any).account_ref },
          store: { schema_version: 'deft.app_record_store.v1', key: 'inbox', resource_key: 'inbox',
            runtime_requirement_key: 'provider', max_record_bytes: 4096, max_files: 0,
            max_file_bytes: 1, max_total_file_bytes: 1 },
          data_policy_digest: sha('e'), purpose: 'human_record_write', expires_at: recordExpiresAt,
        };
        await client.query(
          "INSERT INTO app_data_consents(org_id,owner_user_id,consent_id,connection_session_id,store_key,state,consent_digest,snapshot,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,'inbox','proposed',$5,$6::jsonb,$7,$8,$8)",
          [org, ownerId, recordConsentId, priorId, sha('f'), JSON.stringify(snapshot), new Date(recordExpiresAt), new Date(priorAt)]);
        await client.query("UPDATE app_data_consents SET state='active' WHERE org_id=$1 AND owner_user_id=$2 AND consent_id=$3",
          [org, ownerId, recordConsentId]);
      }
      await disconnect(prior, ownerId);
      const current = await insertConnected(recordFor(currentId, targetKey, currentAt, ownerId), webId, ownerId);
      return { priorId, currentId, recordConsentId, prior, current };
    }

    let clock = now;
    // The module is imported after env/keyring setup, matching production.
    const { AppRestoreAccessService } = await import('../src/lib/app-restore-access-service.js');
    // This fixture has no live owner-connection runtime binding, so the live
    // runtime-authority reader is supplied here (PR424-F05). Production uses the
    // real reader; its refusal without a binding is proven in round2 F05.
    const liveActionConsents = async () => {
      const bindingId = randomUUID();
      return [{ action_binding_id: bindingId, action_key: 'mirror_inbox', authority_epoch: 1, consent_id: bindingId,
        consent_digest: sha('5'), expires_at: null, consent_lifetime: 'until_revoked' as const }];
    };
    const service = new AppRestoreAccessService({ database: db as never, guard: async () => {}, now: () => clock, liveActionConsents } as never);
    const nomination = (targetKey: string) => ({ installation_id: fixture.installation_id, target_key: targetKey });
    const envelope = (review: any, grantIds?: string[]) => ({
      installation_id: fixture.installation_id, target_key: 'unused', review_id: review.review_id,
      review_digest: review.review_digest, review_expires_at: review.review_expires_at,
      ...(grantIds === undefined ? {} : { grant_ids: grantIds }),
    });

    await t.test('record consent re-issues through proposed -> active with the real guard enabled', async () => {
      const key = 'record'; const pair = await createPair(key, { record: true });
      const review = await service.review(actor, nomination(key));
      const grant = review.grants.find((item: any) => item.kind === 'record_consent')!;
      assert.equal(grant.preselected, true);
      const result = await service.activate(actor, { ...envelope(review, [grant.grant_id]), target_key: key });
      assert.equal(result.grants.length, 1);
      const rows = await db.select().from(schema.appDataConsents).where(and(
        eq(schema.appDataConsents.org_id, org), eq(schema.appDataConsents.store_key, 'inbox')));
      const issued = rows.filter((row) => row.consent_id !== pair.recordConsentId && row.state === 'active');
      assert.equal(issued.length, 1, 'one new active record consent');
      assert.equal(issued[0]!.connection_session_id, pair.currentId);
      const old = rows.find((row) => row.consent_id === pair.recordConsentId)!;
      assert.equal(old.state, 'revoked', 'prior consent is soft-transitioned');
    });

    await t.test('action consent re-issues on a new supported session, never rewriting the existing record', async () => {
      const key = 'action'; const pair = await createPair(key, { action: true });
      const review = await service.review(actor, nomination(key));
      const grant = review.grants.find((item: any) => item.kind === 'action_consent')!;
      assert.equal(grant.preselected, false, 'action consents from prior sessions are not preselected');
      const result = await service.activate(actor, { ...envelope(review, [grant.grant_id]), target_key: key });
      assert.equal(result.grants.length, 1);
      assert.notEqual(result.session_id, pair.currentId, 'restore publishes a successor session');
      const rows = await db.select().from(schema.appConnectionSessions).where(eq(schema.appConnectionSessions.org_id, org));
      const original = rows.find((row) => row.session_id === pair.currentId)!;
      assert.equal((original.record as any).action_consents, undefined, 'existing session authority is untouched');
      const successor = rows.find((row) => row.session_id === result.session_id)!;
      assert.equal((successor.record as any).state, 'connected');
      const restored = (successor.record as any).action_consents.find((consent: any) => consent.action_key === 'mirror_inbox');
      assert.ok(restored, 'the action consent lives on the successor session');
      assert.equal((successor.record as any).revision, successor.revision);
    });

    await t.test('default selection does not re-issue an action consent, explicit selection does', async () => {
      const key = 'action_default'; const pair = await createPair(key, { action: true });
      clock = now;
      const review = await service.review(actor, nomination(key));
      const grant = review.grants.find((item: any) => item.kind === 'action_consent')!;
      assert.equal(grant.preselected, false);
      const defaulted = await service.activate(actor, { ...envelope(review), target_key: key });
      assert.deepEqual(defaulted.grants.map((item: any) => item.kind), [],
        'omitted selection does not re-issue the non-preselected action consent');
      assert.equal(defaulted.session_id, pair.currentId, 'no successor session is published');
      const explicit = await service.review(actor, nomination(key));
      const explicitGrant = explicit.grants.find((item: any) => item.kind === 'action_consent')!;
      const activated = await service.activate(actor, { ...envelope(explicit, [explicitGrant.grant_id]), target_key: key });
      assert.equal(activated.grants.length, 1);
      assert.equal(activated.grants[0]!.kind, 'action_consent');
      void pair;
    });

    await t.test('an issued review expires after ten minutes even when the caller rewrites the window', async () => {
      const key = 'expiry'; const pair = await createPair(key, { record: true });
      clock = now;
      const review = await service.review(actor, nomination(key));
      const before = await db.select().from(schema.appDataConsents).where(eq(schema.appDataConsents.org_id, org));
      clock = now + 11 * 60_000;
      await assert.rejects(service.activate(actor, { ...envelope(review, []), target_key: key,
        review_expires_at: new Date(clock + 10 * 60_000).toISOString() }), { code: 'APP_ACCESS_DENIED' });
      const after = await db.select().from(schema.appDataConsents).where(eq(schema.appDataConsents.org_id, org));
      assert.equal(after.length, before.length, 'no grant is issued by an expired review');
      void pair;
      clock = now;
    });

    await t.test('a review is single-use; a second activation is refused', async () => {
      const key = 'reuse'; await createPair(key, { record: true });
      const review = await service.review(actor, nomination(key));
      const input = { ...envelope(review, []), target_key: key };
      await service.activate(actor, input);
      await assert.rejects(service.activate(actor, input), { code: 'APP_ACCESS_DENIED' });
    });

    await t.test("another owner's review cannot be activated", async () => {
      const key = 'owner';
      const other = randomUUID();
      await client.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Other owner')", [other, other + '@example.test']);
      await client.query("INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,'owner',true)", [randomUUID(), org, other]);
      const otherWeb = randomUUID();
      await client.query('INSERT INTO web_sessions(id,user_id,org_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,$5)',
        [otherWeb, other, org, 'b'.repeat(64), new Date(now + 3600_000)]);
      const otherActor = { org_id: org, user_id: other, sid: otherWeb, access_expires_at: now + 3600_000 };
      await createPair(key, { record: true });
      await createPair(key, { record: true, ownerId: other, webId: otherWeb });
      clock = now;
      const review = await service.review(actor, nomination(key));
      await assert.rejects(service.activate(otherActor, { ...envelope(review, []), target_key: key }),
        { code: 'APP_ACCESS_DENIED' });
      const otherReview = await service.review(otherActor, nomination(key));
      await assert.rejects(service.activate(actor, { ...envelope(otherReview, []), target_key: key }),
        { code: 'APP_ACCESS_DENIED' });
    });

    await t.test('tampered grant ids and digests are refused', async () => {
      const key = 'tamper'; await createPair(key, { record: true });
      clock = now;
      const review = await service.review(actor, nomination(key));
      await assert.rejects(service.activate(actor, { ...envelope(review, [randomUUID()]), target_key: key }),
        { code: 'APP_ACCESS_DENIED' });
      await assert.rejects(service.activate(actor, { ...envelope(review, []), target_key: key,
        review_digest: sha('9') }), { code: 'APP_ACCESS_DENIED' });
      await assert.rejects(service.activate(actor, { ...envelope(review, []), target_key: 'other_target' }),
        { code: 'APP_ACCESS_DENIED' });
    });

    // A manifest read that offers one delegated read store + one agent policy,
    // exactly as a real installed manifest would. Every other query is real.
    const declaration = {
      key: 'mirror_saved', description: 'Mirror a saved record.', operation: 'draft', mode: 'review',
      store_key: 'inbox', resource_key: 'inbox', runtime_requirement_key: 'provider',
      input_schema: { type: 'object', properties: { account: { type: 'string' }, record_id: { type: 'string' } }, additionalProperties: false },
      account_input_key: 'account',
      data_operations: ['prepare_action'],
      input_pins: [{ operation: 'prepare_action', outer_key: 'record_id', inner_field: 'record_id', required: true }],
      action_key: 'mirror_inbox', visibility: 'delegated_tools',
    };
    function databaseWithManifest() {
      const wrapSelect = (target: any) => (...args: unknown[]) => {
        const query = (target.select as (...values: unknown[]) => { from(table: unknown): unknown }).apply(target, args);
        return { from(table: Parameters<typeof getTableName>[0]) {
          if (getTableName(table) === 'app_versions') {
            return { where() { return { limit: async () => [{ manifest: { integration_tools: [declaration] } }] }; } };
          }
          return query.from(table);
        } };
      };
      const wrapTransaction = (fn: (tx: unknown) => Promise<unknown>) => db.transaction(async (tx: any) => {
        const wrapped = Object.create(tx);
        wrapped.select = wrapSelect(tx);
        return fn(wrapped);
      });
      return {
        select: wrapSelect(db),
        execute: (...args: unknown[]) => (db.execute as (...values: unknown[]) => unknown).apply(db, args),
        insert: (...args: unknown[]) => (db.insert as (...values: unknown[]) => unknown).apply(db, args),
        update: (...args: unknown[]) => (db.update as (...values: unknown[]) => unknown).apply(db, args),
        transaction: wrapTransaction,
      };
    }
    const manifestService = new AppRestoreAccessService({ database: databaseWithManifest() as never, guard: async () => {}, now: () => clock });

    await t.test('omitting grant_ids activates only preselected items', async () => {
      const key = 'optin'; const pair = await createPair(key, { record: true });
      clock = now;
      const review = await manifestService.review(actor, nomination(key));
      const byKind = (kind: string) => review.grants.filter((item: any) => item.kind === kind);
      assert.equal(byKind('defty_read_grant')[0]!.preselected, false);
      assert.equal(byKind('agent_policy_default')[0]!.preselected, false);
      const result = await manifestService.activate(actor, { ...envelope(review), target_key: key });
      assert.deepEqual(result.grants.map((item: any) => item.kind), ['record_consent'],
        'only the preselected prior grant is re-issued');
      const issuedDefty = await client.query('SELECT count(*)::int AS count FROM app_integration_principal_grants WHERE org_id=$1 AND store_key=$2', [org, 'inbox']);
      assert.equal(issuedDefty.rows[0].count, 0, 'no implicit Defty read delegation');
      void pair;
    });

    await t.test('nothing preselected means an omitted selection activates nothing', async () => {
      const key = 'empty'; await createPair(key, {});
      clock = now;
      const review = await manifestService.review(actor, nomination(key));
      assert.ok(review.grants.length >= 2);
      assert.ok(review.grants.every((item: any) => item.preselected === false));
      const result = await manifestService.activate(actor, { ...envelope(review), target_key: key });
      assert.deepEqual(result.grants, []);
    });

    await t.test('until_revoked consent still restores a finite 90-day Defty read delegation', async () => {
      const key = 'defty'; await createPair(key, {});
      clock = now;
      const review = await manifestService.review(actor, nomination(key));
      const defty = review.grants.find((item: any) => item.kind === 'defty_read_grant')!;
      assert.deepEqual(defty.lifetime, { kind: 'duration', seconds: 90 * 86400 });
      const result = await manifestService.activate(actor, { ...envelope(review, [defty.grant_id]), target_key: key });
      assert.equal(result.grants.length, 1);
      assert.equal(result.grants[0]!.kind, 'defty_read_grant');
      const rows = await client.query('SELECT operations,principal_kind,expires_at FROM app_integration_principal_grants WHERE org_id=$1 AND owner_user_id=$2 AND store_key=$3',
        [org, owner, 'inbox']);
      assert.equal(rows.rows.length, 1);
      assert.deepEqual(rows.rows[0].operations, ['read']);
      assert.equal(rows.rows[0].principal_kind, 'defty');
      assert.ok(Math.abs(new Date(rows.rows[0].expires_at).getTime() - (now + 90 * 86400_000)) < 120_000);
    });
  });
