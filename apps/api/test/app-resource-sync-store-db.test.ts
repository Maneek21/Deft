import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const safeDatabase = (() => {
  if (!databaseUrl || databaseUrl !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(databaseUrl);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && url.hostname === '127.0.0.1' && url.port === '55435'
      && url.pathname === '/gate_g_phase5_test_s05_sync_store'
      && url.search === '' && url.hash === '';
  } catch { return false; }
})();

const material = (seed: string) => createHash('sha256').update(`sync-store:${seed}`).digest('base64');
const shapedHmac = (value: string) => `hmac-sha256:${createHash('sha256').update(value).digest('hex')}`;
function keyring(currentEncryption: string, currentFingerprint: string,
  fingerprintKeys = ['fixture-fp-v1', 'fixture-fp-v2']) {
  const keys = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, material(id)]));
  return JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: currentEncryption,
      keys: keys(['fixture-enc-v1', 'fixture-enc-v2']) },
    receipt_signing: { current: 'fixture-signing', keys: keys(['fixture-signing']) },
    fingerprint: { current: currentFingerprint, keys: keys(fingerprintKeys) },
  });
}

test('resource sync store encrypts one atomic page and fences stale or unsafe writes', {
  skip: !safeDatabase,
}, async () => {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_KEYRINGS = keyring('fixture-enc-v1', 'fixture-fp-v1');
  const [{ db, closeDb }, schema, kit, syncKit, appService, reviewService, moduleService,
    keyrings, runSecretsModule, runInputModule, syncSecretsModule, storeModule,
    drizzle] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('@deft/app-kit'),
    import('@deft/app-kit/experimental/resource-sync'),
    import('../src/lib/app-service.js'), import('../src/lib/app-runtime-review.js'),
    import('../src/lib/module-service.js'), import('../src/lib/app-run-keyrings.js'),
    import('../src/lib/app-run-secrets.js'), import('../src/lib/app-run-secret-repository.js'),
    import('../src/lib/app-resource-sync-secrets.js'),
    import('../src/lib/app-resource-sync-store.js'), import('drizzle-orm'),
  ]);
  const { and, eq, sql } = drizzle;
  const firstRing = keyrings.parseEnvironmentAppRunKeyrings(
    keyring('fixture-enc-v1', 'fixture-fp-v1'));
  const rotatedRing = keyrings.parseEnvironmentAppRunKeyrings(
    keyring('fixture-enc-v2', 'fixture-fp-v2'));
  const missingHistoricalRing = keyrings.parseEnvironmentAppRunKeyrings(
    keyring('fixture-enc-v2', 'fixture-fp-v2', ['fixture-fp-v2']));
  const firstSecrets = new syncSecretsModule.AppResourceSyncSecretService(firstRing);
  const rotatedSecrets = new syncSecretsModule.AppResourceSyncSecretService(rotatedRing);
  const firstInputs = new runInputModule.AppRunSecretRepository(
    new runSecretsModule.AppRunSecretService(firstRing));
  const rotatedInputs = new runInputModule.AppRunSecretRepository(
    new runSecretsModule.AppRunSecretService(rotatedRing));
  const missingInputs = new runInputModule.AppRunSecretRepository(
    new runSecretsModule.AppRunSecretService(missingHistoricalRing));
  const firstStore = new storeModule.AppResourceSyncStore(firstSecrets, firstInputs);
  const rotatedStore = new storeModule.AppResourceSyncStore(rotatedSecrets, rotatedInputs);
  const missingStore = new storeModule.AppResourceSyncStore(
    new syncSecretsModule.AppResourceSyncSecretService(missingHistoricalRing), missingInputs);
  try {
    const orgId = randomUUID();
    const ownerId = randomUUID();
    await db.insert(schema.orgs).values({ id: orgId, name: 'Sync store synthetic org',
      slug: `sync-store-${randomUUID()}` });
    await db.insert(schema.users).values({ id: ownerId,
      email: `sync-store-${randomUUID()}@example.test`, name: 'Synthetic owner' });
    await db.insert(schema.orgMembers).values({ id: randomUUID(), org_id: orgId,
      user_id: ownerId, role: 'owner', is_active: true });
    const owner = moduleService.humanModuleActor({ orgId, userId: ownerId,
      role: 'owner', source: 'ui' });
    const packageJson = (await kit.buildDeftAppPackage({ manifest: {
      schema_version: '3', id: `community.example.syncstoreapp${randomUUID().replaceAll('-', '')}`,
      version: '1.0.0', name: 'Sync store fixture', license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '3' }, modules: [], navigation: [],
      runtime_requirements: [{ key: 'provider', protocol_version: 'deft.app_runtime_channel.v1' }],
      private_capabilities: [{ key: 'deliver', version: '1',
        input_schema: { type: 'object', properties: { item: { type: 'string', maxLength: 80 } },
          required: ['item'], additionalProperties: false },
        output_schema: { type: 'object', properties: { done: { type: 'boolean' } },
          required: ['done'], additionalProperties: false } }],
      runtime_actions: [{ key: 'deliver', label: 'Deliver', capability_key: 'deliver',
        runtime_requirement_key: 'provider' }],
    }, artifacts: [] })).json;
    const staged = await appService.stageAppPackage(owner, packageJson);
    const [version] = await db.select().from(schema.appVersions).where(and(
      eq(schema.appVersions.org_id, orgId), eq(schema.appVersions.id, staged.version_id)));
    assert.ok(version?.requested_grant_snapshot_id);
    const [requested] = await db.select().from(schema.appGrantSnapshots).where(and(
      eq(schema.appGrantSnapshots.org_id, orgId),
      eq(schema.appGrantSnapshots.id, version.requested_grant_snapshot_id)));
    assert.ok(requested);
    const reviewInput = { app_version_id: version.id,
      expected_package_digest: version.package_digest,
      expected_requested_snapshot_digest: requested.snapshot_digest,
      expected_lifecycle_epoch: staged.lifecycle_epoch,
      expected_grant_epoch: staged.grant_epoch };
    const prepared = await reviewService.prepareRuntimeAppReview(owner, staged.id, reviewInput);
    const active = await reviewService.activateRuntimeApp(owner, staged.id, {
      ...reviewInput, expected_review_digest: prepared.review_digest, accept_host_policy: true,
    });
    const now = new Date();
    const registrationId = randomUUID();
    const snapshotId = randomUUID();
    const bindingId = randomUUID();
    const checkpointId = randomUUID();
    const sessionId = randomUUID();
    const descriptor = syncKit.parseSyncDescriptor({
      schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox',
      runtime_requirement_key: 'provider', resource_type: 'message',
      requested_visibility: 'user_private',
      record_schema: { type: 'object', properties: {
        label: { type: 'string', maxLength: 120 },
        owner_id: { type: 'string', maxLength: 120 },
      }, required: ['label'], additionalProperties: false },
      label_field: 'label',
    });
    const descriptorDigest = await syncKit.digestResourceSyncDescriptor(descriptor);
    await db.insert(schema.appRuntimeRegistrations).values({ id: registrationId,
      org_id: orgId, app_installation_id: staged.id, app_version_id: version.id,
      grant_snapshot_id: active.grant_snapshot_id, operator_user_id: ownerId,
      contract_version: 'deft.app_runtime_channel.v2' });
    await db.update(schema.appRuntimeRegistrations).set({ state: 'active', runtime_epoch: 1,
      reviewed_by_user_id: ownerId, reviewed_at: now }).where(and(
      eq(schema.appRuntimeRegistrations.org_id, orgId),
      eq(schema.appRuntimeRegistrations.id, registrationId)));
    await db.insert(schema.capabilityProviderSnapshots).values({ id: snapshotId,
      org_id: orgId, provider_kind: 'app_runtime', provider_instance_id: registrationId,
      adapter_contract_version: 'deft.app_runtime_channel.v2',
      snapshot_digest: `sha256:${createHash('sha256').update(registrationId).digest('hex')}`,
      safe_snapshot: {}, captured_at: now });
    await db.insert(schema.appResourceBindings).values({ id: bindingId, org_id: orgId,
      app_installation_id: staged.id, app_version_id: version.id,
      grant_snapshot_id: active.grant_snapshot_id,
      runtime_registration_id: registrationId, provider_instance_id: registrationId,
      provider_snapshot_id: snapshotId, resource_key: 'inbox', resource_family: 'message',
      operation_name: 'sync_inbox',
      interface_identity: `deft.resource_sync.v2:${orgId}:${staged.id}:inbox`,
      reviewed_descriptor: descriptor, descriptor_digest: descriptorDigest,
      owner_user_id: ownerId, max_records_per_page: 100,
      max_page_bytes: 524288, max_retained_records: 2,
      max_retained_bytes: 1_073_741_824, min_interval_seconds: 60 });
    await db.update(schema.appResourceBindings).set({ state: 'active',
      reviewed_by_user_id: ownerId, reviewed_at: now,
      consent_expires_at: new Date(now.getTime() + 24 * 60 * 60_000) }).where(and(
      eq(schema.appResourceBindings.org_id, orgId), eq(schema.appResourceBindings.id, bindingId)));
    const cursorContext = { org_id: orgId, resource_binding_id: bindingId,
      checkpoint_id: checkpointId, payload_kind: 'cursor' as const,
      generation: 1, cursor_sequence: 0 };
    const initialCursor = firstSecrets.cursorFingerprint(null, cursorContext);
    await db.insert(schema.appSyncCheckpoints).values({ id: checkpointId,
      org_id: orgId, resource_binding_id: bindingId,
      cursor_hmac_key_version: initialCursor.key_version,
      cursor_hmac: initialCursor.fingerprint });
    const [installation] = await db.select().from(schema.appInstallations).where(and(
      eq(schema.appInstallations.org_id, orgId), eq(schema.appInstallations.id, staged.id)));
    assert.ok(installation);
    await db.insert(schema.appRuntimeSessions).values({ id: sessionId,
      org_id: orgId, runtime_registration_id: registrationId,
      resource_binding_id: bindingId, operator_user_id: ownerId,
      token_hash: `sha256:${createHash('sha256').update(sessionId).digest('hex')}`,
      audience: 'app_resource_sync', runtime_epoch: 1,
      lifecycle_epoch: installation.lifecycle_epoch, grant_epoch: installation.grant_epoch,
      expires_at: new Date(now.getTime() + 60 * 60_000) });

    async function createRun(cursor: string | null) {
      const [checkpoint] = await db.select().from(schema.appSyncCheckpoints).where(and(
        eq(schema.appSyncCheckpoints.org_id, orgId), eq(schema.appSyncCheckpoints.id, checkpointId)));
      assert.ok(checkpoint);
      const runId = randomUUID();
      const attemptId = randomUUID();
      const created = new Date();
      const inputExpiresAt = new Date(created.getTime() + 60 * 60_000);
      await db.insert(schema.appRuns).values({ id: runId, org_id: orgId,
        contract_version: 'deft.app_run.v1', origin_kind: 'app',
        initiating_actor_type: 'system', initiating_actor_id: bindingId,
        execution_actor_type: 'system', execution_actor_id: bindingId,
        provider_kind: 'app_runtime', provider_instance_id: registrationId,
        operation_name: 'sync_inbox', provider_snapshot_id: snapshotId,
        origin_app_installation_id: staged.id, origin_app_version_id: version.id,
        origin_app_grant_snapshot_id: active.grant_snapshot_id,
        origin_resource_binding_id: bindingId,
        risk_class: 'internal_write', review_requirement: 'policy',
        review_scope: 'reviewed_resource_sync', retry_class: 'unsafe_or_unknown',
        retention_class: 'standard',
        idempotency_key_version: 'fixture-fp-v1',
        idempotency_fingerprint: shapedHmac(`${runId}:idempotency`),
        input_fingerprint_key_version: 'fixture-fp-v1',
        input_fingerprint: shapedHmac(`${runId}:input`),
        authorization_snapshot: {}, safe_preview: {}, root_run_id: runId,
        input_expires_at: inputExpiresAt,
        result_expires_at: new Date(created.getTime() + 2 * 60 * 60_000),
        idempotency_expires_at: new Date(created.getTime() + 3 * 60 * 60_000),
        attempt_limit: 1 });
      await db.insert(schema.appSyncIntents).values({ id: randomUUID(), org_id: orgId,
        run_id: runId, resource_binding_id: bindingId, checkpoint_id: checkpointId,
        app_installation_id: staged.id, app_version_id: version.id,
        grant_snapshot_id: active.grant_snapshot_id, provider_snapshot_id: snapshotId,
        owner_user_id: ownerId, descriptor_digest: descriptorDigest,
        generation: checkpoint.generation,
        expected_cursor_sequence: checkpoint.cursor_sequence,
        expected_cursor_hmac_key_version: checkpoint.cursor_hmac_key_version,
        expected_cursor_hmac: checkpoint.cursor_hmac });
      await db.transaction(async (tx) => firstInputs.insertInput(tx, { org_id: orgId,
        run_id: runId, value: { schema_version: 'deft.app_sync_request.v1',
          cursor, max_items: 100 }, expires_at: inputExpiresAt }));
      await db.update(schema.appRuns).set({ state: 'running',
        execution_release_kind: 'policy_satisfied', execution_released_at: created,
        started_at: created }).where(and(eq(schema.appRuns.org_id, orgId),
        eq(schema.appRuns.id, runId)));
      await db.insert(schema.appRunAttempts).values({ id: attemptId, org_id: orgId,
        run_id: runId, attempt_number: 1, state: 'provider_call_started',
        claim_owner: 'sync-store-test', claim_token: randomUUID(),
        claimed_at: created, lease_expires_at: new Date(created.getTime() + 60 * 60_000),
        provider_call_started_at: created, resource_binding_id: bindingId,
        runtime_session_id: sessionId, runtime_session_epoch: 0,
        runtime_epoch: 1, runtime_sequence: 1 });
      return { run_id: runId, attempt_id: attemptId };
    }
    const first = await createRun(null);
    const firstPage = { schema_version: 'deft.app_sync_page.v1',
      upserts: [
        { id: 'provider-a', revision: 'r1', data: { label: 'Private A', owner_id: ownerId } },
        { id: 'provider-b', revision: 'r1', data: { label: 'Private B' } },
      ], tombstones: [], next_cursor: 'cursor-one', has_more: true };
    const firstApplied = await db.transaction((tx) => firstStore.applyPageInTransaction(tx,
      { org_id: orgId, ...first, page: firstPage, clock: () => new Date() }));
    assert.equal(firstApplied.applied_sequence, 1);
    assert.equal(firstApplied.has_more, true);
    let projections = await db.select().from(schema.appResourceProjections).where(and(
      eq(schema.appResourceProjections.org_id, orgId),
      eq(schema.appResourceProjections.checkpoint_id, checkpointId)));
    assert.equal(projections.length, 2);
    const aProjection = projections.find((row) => rotatedSecrets.openJson({
      schema_version: row.provider_id_envelope_version,
      algorithm: row.provider_id_algorithm, key_version: row.provider_id_key_version,
      nonce_b64: row.provider_id_nonce_b64, ciphertext_b64: row.provider_id_ciphertext_b64,
      auth_tag_b64: row.provider_id_auth_tag_b64,
    }, { org_id: orgId, resource_binding_id: bindingId, checkpoint_id: checkpointId,
      payload_kind: 'projection', generation: 1, projection_id: row.id,
      slot: 'provider_id' }) === 'provider-a');
    assert.ok(aProjection);
    assert.equal(aProjection.provider_id_key_version, 'fixture-enc-v1');
    assert.equal(aProjection.body_ciphertext_b64?.includes('Private A'), false);
    assert.deepEqual(firstSecrets.openJson({
      schema_version: aProjection.body_envelope_version,
      algorithm: aProjection.body_algorithm, key_version: aProjection.body_key_version,
      nonce_b64: aProjection.body_nonce_b64,
      ciphertext_b64: aProjection.body_ciphertext_b64,
      auth_tag_b64: aProjection.body_auth_tag_b64,
    }, { org_id: orgId, resource_binding_id: bindingId, checkpoint_id: checkpointId,
      payload_kind: 'projection', generation: 1, projection_id: aProjection.id,
      slot: 'record' }), { data: { label: 'Private A', owner_id: ownerId }, revision: 'r1' });
    const [afterFirst] = await db.select().from(schema.appSyncCheckpoints).where(and(
      eq(schema.appSyncCheckpoints.org_id, orgId), eq(schema.appSyncCheckpoints.id, checkpointId)));
    assert.equal(afterFirst?.cursor_sequence, 1);
    assert.equal(afterFirst.retained_record_count, 2);
    assert.equal(afterFirst.fresh_until, null);
    await assert.rejects(db.transaction((tx) => firstStore.applyPageInTransaction(tx,
      { org_id: orgId, ...first, page: firstPage, clock: () => new Date() })),
    /APP_RESOURCE_SYNC_START_CURSOR_STALE/);

    const second = await createRun('cursor-one');
    const stale = await createRun('cursor-one');
    await assert.rejects(db.transaction((tx) => rotatedStore.applyPageInTransaction(tx,
      { org_id: randomUUID(), ...second, page: firstPage, clock: () => new Date() })),
    /APP_RESOURCE_SYNC_RUN_NOT_RELEASED/);
    await assert.rejects(db.transaction((tx) => rotatedStore.applyPageInTransaction(tx,
      { org_id: orgId, run_id: second.run_id, attempt_id: first.attempt_id,
        page: firstPage, clock: () => new Date() })), /APP_RESOURCE_SYNC_ATTEMPT_NOT_CURRENT/);
    const duplicatePage = { schema_version: 'deft.app_sync_page.v1',
      upserts: [{ id: 'provider-a', revision: 'r2', data: { label: 'Duplicate' } }],
      tombstones: [{ id: 'provider-a', revision: 'r2' }],
      next_cursor: 'cursor-two', has_more: false };
    await assert.rejects(db.transaction((tx) => rotatedStore.applyPageInTransaction(tx,
      { org_id: orgId, ...second, page: duplicatePage, clock: () => new Date() })));
    const secondPage = { schema_version: 'deft.app_sync_page.v1',
      tombstones: [{ id: 'provider-a', revision: 'r2' }],
      upserts: [{ id: 'provider-b', revision: 'r2', data: { label: 'Private B updated' } }],
      next_cursor: 'cursor-two', has_more: false };
    const secondApplied = await db.transaction((tx) => rotatedStore.applyPageInTransaction(tx,
      { org_id: orgId, ...second, page: secondPage, clock: () => new Date() }));
    assert.equal(secondApplied.applied_sequence, 2);
    projections = await db.select().from(schema.appResourceProjections).where(and(
      eq(schema.appResourceProjections.org_id, orgId),
      eq(schema.appResourceProjections.checkpoint_id, checkpointId)));
    assert.equal(projections.length, 2);
    const stableA = projections.find((row) => row.id === aProjection.id);
    assert.ok(stableA);
    assert.equal(stableA.state, 'tombstone');
    assert.equal(stableA.body_key_version, null);
    assert.equal(stableA.provider_id_key_version, 'fixture-enc-v2');
    assert.equal(rotatedSecrets.openJson({
      schema_version: stableA.provider_id_envelope_version,
      algorithm: stableA.provider_id_algorithm,
      key_version: stableA.provider_id_key_version,
      nonce_b64: stableA.provider_id_nonce_b64,
      ciphertext_b64: stableA.provider_id_ciphertext_b64,
      auth_tag_b64: stableA.provider_id_auth_tag_b64,
    }, { org_id: orgId, resource_binding_id: bindingId, checkpoint_id: checkpointId,
      payload_kind: 'projection', generation: 1, projection_id: stableA.id,
      slot: 'provider_id' }), 'provider-a');
    const stableB = projections.find((row) => row.id !== aProjection.id);
    assert.ok(stableB);
    assert.equal(stableB.state, 'live');
    assert.equal(stableB.provider_id_key_version, stableB.body_key_version);
    assert.equal(stableB.provider_id_key_version, 'fixture-enc-v2');
    assert.deepEqual(rotatedSecrets.openJson({
      schema_version: stableB.body_envelope_version,
      algorithm: stableB.body_algorithm, key_version: stableB.body_key_version,
      nonce_b64: stableB.body_nonce_b64, ciphertext_b64: stableB.body_ciphertext_b64,
      auth_tag_b64: stableB.body_auth_tag_b64,
    }, { org_id: orgId, resource_binding_id: bindingId, checkpoint_id: checkpointId,
      payload_kind: 'projection', generation: 1, projection_id: stableB.id,
      slot: 'record' }), { data: { label: 'Private B updated' }, revision: 'r2' });
    await assert.rejects(db.transaction((tx) => rotatedStore.applyPageInTransaction(tx,
      { org_id: orgId, ...stale, page: secondPage, clock: () => new Date() })),
    /APP_RESOURCE_SYNC_START_CURSOR_STALE/);

    const third = await createRun('cursor-two');
    const badInput = await createRun('wrong-cursor');
    const thirdPage = { schema_version: 'deft.app_sync_page.v1',
      upserts: [{ id: 'provider-c', revision: 'r1', data: { label: 'Private C' } }],
      tombstones: [], next_cursor: null, has_more: false };
    await assert.rejects(db.transaction((tx) => rotatedStore.applyPageInTransaction(tx,
      { org_id: orgId, ...badInput, page: thirdPage, clock: () => new Date() })),
    /APP_RESOURCE_SYNC_RUN_INPUT_MISMATCH/);
    await assert.rejects(db.transaction((tx) => rotatedStore.applyPageInTransaction(tx,
      { org_id: orgId, ...third, page: thirdPage,
        clock: () => new Date(Date.now() + 4 * 60 * 60_000) })),
    /APP_RESOURCE_SYNC_SETTLEMENT_EXPIRED/,
    'deadline is rechecked after the checkpoint lock');
    await assert.rejects(db.transaction((tx) => missingStore.applyPageInTransaction(tx,
      { org_id: orgId, ...third, page: thirdPage, clock: () => new Date() })),
    keyrings.AppRunKeyVersionUnavailableError,
    'a missing retained locator key denies even a new provider ID');
    await assert.rejects(db.transaction((tx) => missingStore.applyPageInTransaction(tx,
      { org_id: orgId, ...third, page: { ...thirdPage, upserts: [] }, clock: () => new Date() })),
    keyrings.AppRunKeyVersionUnavailableError,
    'an empty page cannot bypass historical locator-key availability');
    await assert.rejects(db.transaction((tx) => rotatedStore.applyPageInTransaction(tx,
      { org_id: orgId, ...third, page: thirdPage, clock: () => new Date() })),
    (error: unknown) => {
      assert.match(String((error as { cause?: unknown }).cause), /APP_SYNC_CAPACITY_EXCEEDED/);
      return true;
    });
    const rollbackPage = { ...thirdPage, upserts: [
      { id: 'provider-b', revision: 'r3', data: { label: 'Rolled back' } },
    ] };
    let settlementClockReads = 0;
    await assert.rejects(db.transaction((tx) => rotatedStore.applyPageInTransaction(tx,
      { org_id: orgId, ...third, page: rollbackPage,
        clock: () => ++settlementClockReads === 1 ? new Date()
          : new Date(Date.now() + 4 * 60 * 60_000) })),
    /APP_RESOURCE_SYNC_SETTLEMENT_EXPIRED/,
    'expiry after projection writes rolls back the page');
    assert.equal(settlementClockReads, 2);
    await assert.rejects(db.transaction(async (tx) => {
      await rotatedStore.applyPageInTransaction(tx,
        { org_id: orgId, ...third, page: rollbackPage, clock: () => new Date() });
      throw new Error('synthetic downstream receipt failure');
    }), /synthetic downstream receipt failure/);
    const [afterRollback] = await db.select().from(schema.appSyncCheckpoints).where(and(
      eq(schema.appSyncCheckpoints.org_id, orgId), eq(schema.appSyncCheckpoints.id, checkpointId)));
    assert.equal(afterRollback?.cursor_sequence, 2);
    assert.equal(afterRollback.retained_record_count, 2);
    const finalRows = await db.select().from(schema.appResourceProjections).where(and(
      eq(schema.appResourceProjections.org_id, orgId),
      eq(schema.appResourceProjections.checkpoint_id, checkpointId)));
    assert.equal(finalRows.length, 2);
    assert.equal(finalRows.find((row) => row.id === stableB.id)?.applied_sequence, 2);

    // Distinct Runs with the same immutable starting intent race at the
    // checkpoint. The loser must observe the winner's CAS and write nothing.
    const competingA = await createRun('cursor-two');
    const competingB = await createRun('cursor-two');
    const competingPage = { schema_version: 'deft.app_sync_page.v1',
      upserts: [{ id: 'provider-b', revision: 'r3',
        data: { label: 'Concurrent winner' } }],
      tombstones: [], next_cursor: 'cursor-three', has_more: false };
    const race = await Promise.allSettled([competingA, competingB].map((run) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '4s'`);
        return rotatedStore.applyPageInTransaction(tx,
          { org_id: orgId, ...run, page: competingPage, clock: () => new Date() });
      })));
    const winners = race.filter((result) => result.status === 'fulfilled');
    const losers = race.filter((result) => result.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.match(String(losers[0]!.reason), /APP_RESOURCE_SYNC_START_CURSOR_STALE/);
    const [afterRace] = await db.select().from(schema.appSyncCheckpoints).where(and(
      eq(schema.appSyncCheckpoints.org_id, orgId), eq(schema.appSyncCheckpoints.id, checkpointId)));
    assert.ok(afterRace);
    assert.equal(afterRace.cursor_sequence, 3);
    assert.equal(afterRace.retained_record_count, 2);
    const winningRun = race[0]!.status === 'fulfilled' ? competingA.run_id : competingB.run_id;
    assert.equal(afterRace.last_applied_run_id, winningRun);
    const afterRaceRows = await db.select().from(schema.appResourceProjections).where(and(
      eq(schema.appResourceProjections.org_id, orgId),
      eq(schema.appResourceProjections.checkpoint_id, checkpointId)));
    assert.equal(afterRaceRows.length, 2);
    assert.equal(afterRaceRows.find((row) => row.id === stableB.id)?.applied_sequence, 3);

    // Adversarial retained state: two different locator-key versions identify
    // the same provider ID. The schema allows a privileged host rekey marker;
    // this test deliberately seeds a duplicate through that marker only to
    // prove normal page application rejects ambiguity instead of choosing a
    // UUID. It is not a supported rekey implementation.
    const duplicateLocator = rotatedSecrets.locator('provider-a', {
      org_id: orgId, resource_binding_id: bindingId, checkpoint_id: checkpointId,
    });
    const duplicateIdEnvelope = rotatedSecrets.sealJson('provider-a', {
      org_id: orgId, resource_binding_id: bindingId, checkpoint_id: checkpointId,
      payload_kind: 'projection', generation: 1, projection_id: stableB.id,
      slot: 'provider_id',
    });
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL deft.app_resource_sync_rekey = 'on'`);
      await tx.update(schema.appResourceProjections).set({
        resource_id_hmac_key_version: duplicateLocator.key_version,
        resource_id_hmac: duplicateLocator.fingerprint,
        provider_id_envelope_version: duplicateIdEnvelope.schema_version,
        provider_id_algorithm: duplicateIdEnvelope.algorithm,
        provider_id_key_version: duplicateIdEnvelope.key_version,
        provider_id_nonce_b64: duplicateIdEnvelope.nonce_b64,
        provider_id_ciphertext_b64: duplicateIdEnvelope.ciphertext_b64,
        provider_id_auth_tag_b64: duplicateIdEnvelope.auth_tag_b64,
        provider_id_bytes: Buffer.byteLength(duplicateIdEnvelope.ciphertext_b64, 'base64'),
      }).where(and(eq(schema.appResourceProjections.org_id, orgId),
        eq(schema.appResourceProjections.id, stableB.id)));
    });
    const ambiguousRun = await createRun('cursor-three');
    await assert.rejects(db.transaction((tx) => rotatedStore.applyPageInTransaction(tx,
      { org_id: orgId, ...ambiguousRun,
        page: { ...competingPage, upserts: [{ id: 'provider-a', revision: 'r4',
          data: { label: 'Must reject ambiguity' } }], next_cursor: null },
        clock: () => new Date() })), /APP_RESOURCE_SYNC_AMBIGUOUS_LOCATOR/);
    const [afterAmbiguity] = await db.select().from(schema.appSyncCheckpoints).where(and(
      eq(schema.appSyncCheckpoints.org_id, orgId), eq(schema.appSyncCheckpoints.id, checkpointId)));
    assert.equal(afterAmbiguity?.cursor_sequence, 3);
  } finally {
    firstRing.destroy(); rotatedRing.destroy(); missingHistoricalRing.destroy();
    await closeDb();
  }
});
