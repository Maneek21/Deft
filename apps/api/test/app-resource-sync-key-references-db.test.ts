import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { runtimeV3PackageJson } from './fixtures/runtime-v3-package.js';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const safeDatabase = (() => {
  if (!databaseUrl || databaseUrl !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(databaseUrl);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && url.hostname === '127.0.0.1' && url.port === '55435'
      && url.pathname === '/gate_g_phase5_test_s04_runtime_keyrefs'
      && url.search === '' && url.hash === '';
  } catch { return false; }
})();

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const hmac = (value: string) => `hmac-sha256:${createHash('sha256').update(value).digest('hex')}`;
const material = (seed: string) => createHash('sha256').update(seed).digest('base64');
function keyringDocument(fingerprintIds: readonly string[], encryptionIds: readonly string[]) {
  const keys = (purpose: string, ids: readonly string[]) => Object.fromEntries(ids.map((id) =>
    [id, material(`sync-keyrefs:${purpose}:${id}`)]));
  return JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: encryptionIds[0], keys: keys('encryption', encryptionIds) },
    receipt_signing: { current: 'fixture-signing',
      keys: keys('signing', ['fixture-signing']) },
    fingerprint: { current: fingerprintIds[0], keys: keys('fingerprint', fingerprintIds) },
  });
}

test('sync key inventory retains private projection and unresolved intent keys with tenant scope', {
  skip: !safeDatabase,
}, async () => {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
  process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
  process.env.DEFT_APP_RUN_KEYRINGS = keyringDocument(['initial-fp'], ['initial-enc']);
  const [{ db, closeDb }, schema, appService, reviewService, moduleService, fixture,
    inventory, keyrings, drizzle, runtimeModule, runtimeAuthority, runtimeChannel] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'),
    import('../src/lib/app-service.js'), import('../src/lib/app-runtime-review.js'),
    import('../src/lib/module-service.js'),
    import('../../../packages/db/scripts/fixtures/app-resource-sync-schema-fixture.js'),
    import('../src/lib/app-resource-sync-key-references.js'),
    import('../src/lib/app-run-keyrings.js'), import('drizzle-orm'),
    import('../src/lib/app-run-runtime.js'),
    import('../src/lib/app-runtime-authority.js'),
    import('../src/lib/app-runtime-channel.js'),
  ]);
  const { and, eq } = drizzle;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    async function lineage(label: string) {
      const orgId = randomUUID();
      const ownerId = randomUUID();
      await db.insert(schema.orgs).values({ id: orgId, name: `Sync inventory ${label}`,
        slug: `sync-inventory-${label}-${randomUUID()}` });
      await db.insert(schema.users).values({ id: ownerId,
        email: `sync-inventory-${label}-${randomUUID()}@example.test`, name: 'Synthetic owner' });
      await db.insert(schema.orgMembers).values({ id: randomUUID(), org_id: orgId,
        user_id: ownerId, role: 'owner', is_active: true });
      const owner = moduleService.humanModuleActor({ orgId, userId: ownerId,
        role: 'owner', source: 'ui' });
      const staged = await appService.stageAppPackage(owner, await runtimeV3PackageJson());
      const [version] = await db.select().from(schema.appVersions).where(and(
        eq(schema.appVersions.org_id, orgId), eq(schema.appVersions.id, staged.version_id)));
      assert.ok(version?.requested_grant_snapshot_id);
      const [requested] = await db.select().from(schema.appGrantSnapshots).where(and(
        eq(schema.appGrantSnapshots.org_id, orgId),
        eq(schema.appGrantSnapshots.id, version.requested_grant_snapshot_id)));
      assert.ok(requested);
      const request = { app_version_id: version.id,
        expected_package_digest: version.package_digest,
        expected_requested_snapshot_digest: requested.snapshot_digest,
        expected_lifecycle_epoch: staged.lifecycle_epoch,
        expected_grant_epoch: staged.grant_epoch };
      const prepared = await reviewService.prepareRuntimeAppReview(owner, staged.id, request);
      const active = await reviewService.activateRuntimeApp(owner, staged.id, {
        ...request, expected_review_digest: prepared.review_digest, accept_host_policy: true,
      });
      return { org_id: orgId, app_installation_id: staged.id,
        app_version_id: version.id, grant_snapshot_id: active.grant_snapshot_id,
        owner_user_id: ownerId };
    }

    const a = await lineage('a');
    const b = await lineage('b');
    // The v2 rows are SQL ancestry fixtures, not a supported author submission.
    const aIds = await fixture.insertAppResourceSyncSchemaFixture(client, a,
      { key_suffix: 'a', with_projections: false });
    const bIds = await fixture.insertAppResourceSyncSchemaFixture(client, b,
      { key_suffix: 'b', with_run_intent: false, with_projections: true,
        projection_states: ['tombstone'] });

    // A valid resource-sync session deliberately uses the *v1 token hash*.
    // This proves the channel/authority audience and exclusive-target checks,
    // rather than merely relying on a future token-domain hash difference.
    const v1Token = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
    const sessionId = randomUUID();
    const tokenHash = runtimeAuthority.hashAppRuntimeToken(v1Token);
    const installationEpochs = await client.query<{
      lifecycle_epoch: number; grant_epoch: number;
    }>('SELECT lifecycle_epoch, grant_epoch FROM app_installations WHERE org_id=$1 AND id=$2',
    [a.org_id, a.app_installation_id]);
    assert.equal(installationEpochs.rows.length, 1);
    await client.query(`INSERT INTO app_runtime_sessions
      (id, org_id, runtime_registration_id, runtime_binding_id, resource_binding_id,
       operator_user_id, token_hash, audience, session_epoch, runtime_epoch,
       lifecycle_epoch, grant_epoch, expires_at)
      VALUES ($1,$2,$3,NULL,$4,$5,$6,'app_resource_sync',0,1,$7,$8,$9)`, [
      sessionId, a.org_id, aIds.registration_id, aIds.binding_id,
      a.owner_user_id, tokenHash, installationEpochs.rows[0]!.lifecycle_epoch,
      installationEpochs.rows[0]!.grant_epoch, new Date(Date.now() + 60_000),
    ]);
    let runnerCalls = 0;
    const forbiddenRunner = Object.fromEntries(['claimRuntimeAttempt', 'startRuntimeAttempt',
      'heartbeatRuntimeAttempt', 'completeRuntimeAttempt'].map((name) => [name, () => {
      runnerCalls += 1;
      throw new Error(`v1 channel invoked runner ${name}`);
    }]));
    const channel = new runtimeChannel.AppRuntimeChannel(forbiddenRunner as unknown as
      ConstructorParameters<typeof runtimeChannel.AppRuntimeChannel>[0]);
    assert.equal(runtimeChannel.appRuntimeChannelEnabled(), true,
      'audience denial must run with the v1 channel actually enabled');
    const credential = { schema_version: 'deft.app_runtime_channel.v1' as const,
      session_id: sessionId, session_token: v1Token };
    const attempt = { ...credential, run_id: randomUUID(), attempt_id: randomUUID(),
      claim_token: randomUUID(), sequence: 1 };
    assert.equal(await channel.claim({ ...credential, max_claims: 1 }), null);
    assert.equal(await channel.start(attempt), null);
    assert.equal(await channel.heartbeat(attempt), false);
    assert.equal(await channel.complete({ ...attempt, status: 'indeterminate' }), null);
    assert.equal(runnerCalls, 0);
    assert.equal(await db.transaction((tx) => runtimeAuthority.loadLiveRuntimeAuthority(
      tx, a.org_id, sessionId, tokenHash, () => new Date())), null);

    assert.deepEqual(await inventory.listAppResourceSyncKeyReferences(a.org_id), [
      { purpose: 'fingerprint', key_id: 'fixture-fp-a' },
    ], 'empty cursor has no AES reference');
    assert.deepEqual(await inventory.listAppResourceSyncKeyReferences(b.org_id), [
      { purpose: 'fingerprint', key_id: 'fixture-fp-b' },
      { purpose: 'run_encryption', key_id: 'fixture-enc-b' },
    ], 'a tombstone alone retains encrypted provider identity and locator keys');
    assert.deepEqual(await inventory.listAppResourceSyncKeyReferences(randomUUID()), []);
    await assert.rejects(inventory.listAppResourceSyncKeyReferences(null as unknown as string));
    await db.update(schema.appResourceBindings).set({ state: 'revoked' }).where(and(
      eq(schema.appResourceBindings.org_id, b.org_id),
      eq(schema.appResourceBindings.id, bIds.binding_id)));
    assert.deepEqual(await inventory.listAppResourceSyncKeyReferences(b.org_id), [
      { purpose: 'fingerprint', key_id: 'fixture-fp-b' },
      { purpose: 'run_encryption', key_id: 'fixture-enc-b' },
    ], 'revocation does not erase retained ciphertext references');

    const [firstRun] = await db.select().from(schema.appRuns).where(and(
      eq(schema.appRuns.org_id, a.org_id), eq(schema.appRuns.id, aIds.run_id)));
    const [firstIntent] = await db.select().from(schema.appSyncIntents).where(and(
      eq(schema.appSyncIntents.org_id, a.org_id), eq(schema.appSyncIntents.run_id, aIds.run_id)));
    assert.ok(firstRun && firstIntent);
    const settledRunId = randomUUID();
    await db.insert(schema.appRuns).values({ ...firstRun, id: settledRunId,
      root_run_id: settledRunId, idempotency_fingerprint: hmac(settledRunId + ':idempotency'),
      input_fingerprint: hmac(settledRunId + ':input') });
    await db.insert(schema.appSyncIntents).values({ ...firstIntent,
      id: randomUUID(), run_id: settledRunId });
    const now = new Date();
    const encryptedCursor = Buffer.from(JSON.stringify('next-cursor'), 'utf8');
    await db.update(schema.appSyncCheckpoints).set({ cursor_sequence: 1,
      cursor_hmac_key_version: 'fixture-fp-a-next', cursor_hmac: hmac('next-cursor'),
      cursor_state: 'value', cursor_envelope_version: 'deft.secret.v1',
      cursor_algorithm: 'aes-256-gcm', cursor_key_version: 'fixture-enc-a-cursor',
      cursor_nonce_b64: Buffer.alloc(12, 4).toString('base64'),
      cursor_ciphertext_b64: encryptedCursor.toString('base64'),
      cursor_auth_tag_b64: Buffer.alloc(16, 5).toString('base64'),
      cursor_bytes: encryptedCursor.length,
      last_applied_run_id: settledRunId, last_applied_page_digest: digest('synthetic-page'),
      last_applied_at: now, last_checked_at: now }).where(and(
      eq(schema.appSyncCheckpoints.org_id, a.org_id),
      eq(schema.appSyncCheckpoints.id, aIds.checkpoint_id)));
    for (const runId of [aIds.run_id, settledRunId]) {
      await db.update(schema.appRuns).set({ state: 'running',
        execution_release_kind: 'policy_satisfied', execution_released_at: now,
        started_at: now }).where(and(eq(schema.appRuns.org_id, a.org_id),
        eq(schema.appRuns.id, runId)));
    }
    await db.update(schema.appRuns).set({ state: 'unknown_outcome',
      unknown_outcome_at: now }).where(and(eq(schema.appRuns.org_id, a.org_id),
      eq(schema.appRuns.id, aIds.run_id)));
    await db.update(schema.appRuns).set({ state: 'succeeded', terminal_at: now })
      .where(and(eq(schema.appRuns.org_id, a.org_id),
        eq(schema.appRuns.id, settledRunId)));
    assert.deepEqual(await inventory.listAppResourceSyncKeyReferences(a.org_id), [
      { purpose: 'fingerprint', key_id: 'fixture-fp-a' },
      { purpose: 'fingerprint', key_id: 'fixture-fp-a-next' },
      { purpose: 'run_encryption', key_id: 'fixture-enc-a-cursor' },
    ], 'unknown Run retains its old starting cursor key after another page advances');
    const withoutOldFingerprint = keyrings.parseEnvironmentAppRunKeyrings(JSON.stringify({
      schema_version: 'deft.app_run_keyring.v1',
      run_encryption: { current: 'fixture-enc-b', keys: {
        'fixture-enc-b': material('sync-keyrefs:enc-b'),
        'fixture-enc-a-cursor': material('sync-keyrefs:enc-a-cursor'),
      } },
      receipt_signing: { current: 'fixture-signing',
        keys: { 'fixture-signing': material('sync-keyrefs:signing') } },
      fingerprint: { current: 'fixture-fp-a-next', keys: {
        'fixture-fp-a-next': material('sync-keyrefs:fp-a-next'),
        'fixture-fp-b': material('sync-keyrefs:fp-b'),
      } },
    }));
    try {
      const references = await inventory.listAppResourceSyncKeyReferences(a.org_id);
      assert.throws(() => keyrings.assertAppRunReferencedKeysAvailable(withoutOldFingerprint,
        references),
      keyrings.AppRunKeyVersionUnavailableError);
    } finally { withoutOldFingerprint.destroy(); }
    await db.update(schema.appRuns).set({ state: 'succeeded', terminal_at: new Date() })
      .where(and(eq(schema.appRuns.org_id, a.org_id), eq(schema.appRuns.id, aIds.run_id)));
    assert.deepEqual(await inventory.listAppResourceSyncKeyReferences(a.org_id), [
      { purpose: 'fingerprint', key_id: 'fixture-fp-a-next' },
      { purpose: 'run_encryption', key_id: 'fixture-enc-a-cursor' },
    ], 'terminal intent alone no longer retains its historical cursor key');
    assert.deepEqual(await inventory.listAppResourceSyncKeyReferences(), [
      { purpose: 'fingerprint', key_id: 'fixture-fp-a-next' },
      { purpose: 'fingerprint', key_id: 'fixture-fp-b' },
      { purpose: 'run_encryption', key_id: 'fixture-enc-a-cursor' },
      { purpose: 'run_encryption', key_id: 'fixture-enc-b' },
    ]);

    const available = keyrings.parseEnvironmentAppRunKeyrings(JSON.stringify({
      schema_version: 'deft.app_run_keyring.v1',
      run_encryption: { current: 'fixture-enc-b', keys: {
        'fixture-enc-b': material('sync-keyrefs:enc-b'),
        'fixture-enc-a-cursor': material('sync-keyrefs:enc-a-cursor'),
      } },
      receipt_signing: { current: 'fixture-signing',
        keys: { 'fixture-signing': material('sync-keyrefs:signing') } },
      fingerprint: { current: 'fixture-fp-a-next', keys: {
        'fixture-fp-a-next': material('sync-keyrefs:fp-a-next'),
        'fixture-fp-b': material('sync-keyrefs:fp-b'),
      } },
    }));
    try {
      const references = await inventory.listAppResourceSyncKeyReferences();
      assert.doesNotThrow(() => keyrings.assertAppRunReferencedKeysAvailable(available, references));
    } finally { available.destroy(); }
    const missingEncryption = keyrings.parseEnvironmentAppRunKeyrings(JSON.stringify({
      schema_version: 'deft.app_run_keyring.v1',
      run_encryption: { current: 'replacement-enc',
        keys: { 'replacement-enc': material('sync-keyrefs:replacement-enc') } },
      receipt_signing: { current: 'fixture-signing',
        keys: { 'fixture-signing': material('sync-keyrefs:signing') } },
      fingerprint: { current: 'fixture-fp-a-next', keys: {
        'fixture-fp-a-next': material('sync-keyrefs:fp-a-next'),
        'fixture-fp-b': material('sync-keyrefs:fp-b'),
      } },
    }));
    try {
      const references = await inventory.listAppResourceSyncKeyReferences();
      assert.throws(() => keyrings.assertAppRunReferencedKeysAvailable(missingEncryption,
        references),
      keyrings.AppRunKeyVersionUnavailableError);
    } finally { missingEncryption.destroy(); }
    // The composition root inventories sync state at process bootstrap. Its
    // existing per-Run key scan is satisfied by fixture-fp-a in each ring.
    process.env.DEFT_APP_RUN_KEYRINGS = keyringDocument(
      ['fixture-fp-a', 'fixture-fp-a-next', 'fixture-fp-b'],
      ['fixture-enc-a-cursor']);
    await assert.rejects(runtimeModule.getAppRunRuntime(),
      keyrings.AppRunKeyVersionUnavailableError,
      'a tombstone provider-ID encryption key cannot be retired');
    process.env.DEFT_APP_RUN_KEYRINGS = keyringDocument(
      ['fixture-fp-a', 'fixture-fp-a-next'],
      ['fixture-enc-a-cursor', 'fixture-enc-b']);
    await assert.rejects(runtimeModule.getAppRunRuntime(),
      keyrings.AppRunKeyVersionUnavailableError,
      'a tombstone locator HMAC key cannot be retired');
    process.env.DEFT_APP_RUN_KEYRINGS = keyringDocument(
      ['fixture-fp-a', 'fixture-fp-a-next', 'fixture-fp-b'],
      ['fixture-enc-a-cursor', 'fixture-enc-b']);
    assert.ok(await runtimeModule.getAppRunRuntime(),
      'bootstrap accepts complete retained sync key inventory');
  } finally {
    await runtimeModule.shutdownAppRunRuntime();
    await client.end();
    await closeDb();
  }
});
