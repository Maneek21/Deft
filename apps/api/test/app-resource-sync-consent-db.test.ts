import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { createReviewedResourceSyncFixture } from './fixtures/resource-sync-v5.js';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!databaseUrl || databaseUrl !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(databaseUrl);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && url.hostname === '127.0.0.1' && url.port === '55435'
      && /^\/gate_g_phase5_test_s05_(?:consent_v[0-9]+|root(?:_v[0-9]+)?)$/.test(url.pathname)
      && url.search === '' && url.hash === '';
  } catch { return false; }
})();
after(async () => { if (safe) await (await import('../src/lib/db.js')).closeDb(); });

function keyring() {
  const material = (seed: string) => createHash('sha256').update(`consent:${seed}`).digest('base64');
  const ring = (id: string) => ({ current: id, keys: { [id]: material(id) } });
  return JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: ring('consent-enc-v1'),
    receipt_signing: ring('consent-sign-v1'),
    fingerprint: ring('consent-fp-v1') });
}

test('owner-reviewed v2 consent pins current App, provider and session authority', { skip: !safe }, async () => {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_KEYRINGS = keyring();
  const [{ db }, schema, drizzle, keyrings, authority, secretsModule, v1Management, v1Authority, policy] =
    await Promise.all([import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
      import('../src/lib/app-run-keyrings.js'), import('../src/lib/app-resource-sync-authority.js'),
      import('../src/lib/app-resource-sync-secrets.js'), import('../src/lib/app-runtime-management.js'),
      import('../src/lib/app-runtime-authority.js'), import('../src/lib/app-resource-sync-policy.js')]);
  const keys = keyrings.parseEnvironmentAppRunKeyrings(keyring());
  try {
    let time = new Date('2026-09-24T12:00:00.000Z');
    const clock = () => time;
    const fixture = await createReviewedResourceSyncFixture({ keys, clock });
    const bindingAuthority = await db.transaction((tx) =>
      authority.loadLiveResourceSyncBindingAuthority(tx, { org_id: fixture.org_id,
        resource_binding_id: fixture.binding_id, clock }));
    assert.ok(bindingAuthority);
    assert.equal(bindingAuthority.binding.owner_user_id, fixture.owner_user_id);
    assert.equal(bindingAuthority.registration.operator_user_id, fixture.operator_user_id);
    assert.equal(bindingAuthority.provider_snapshot.adapter_contract_version,
      'deft.app_runtime_channel.v2');
    const safeSnapshot = bindingAuthority.provider_snapshot.safe_snapshot as {
      operations: Array<{ input_schema: unknown; output_schema: { properties: {
        upserts: { items: { properties: { data: unknown } } } } } }> };
    assert.deepEqual(safeSnapshot.operations[0]!.output_schema.properties.upserts.items.properties.data,
      { type: 'object', properties: { subject: { type: 'string', maxLength: 200 } },
        required: ['subject'], additionalProperties: false });
    const [checkpoint] = await db.select().from(schema.appSyncCheckpoints).where(drizzle.and(
      drizzle.eq(schema.appSyncCheckpoints.org_id, fixture.org_id),
      drizzle.eq(schema.appSyncCheckpoints.id, fixture.checkpoint_id)));
    assert.ok(checkpoint);
    assert.equal(checkpoint.generation, 1);
    assert.equal(checkpoint.cursor_sequence, 0);
    assert.equal(checkpoint.cursor_state, 'empty');
    const fingerprint = new secretsModule.AppResourceSyncSecretService(keys).cursorFingerprint(null,
      { org_id: fixture.org_id, resource_binding_id: fixture.binding_id,
        checkpoint_id: checkpoint.id, payload_kind: 'cursor', generation: 1, cursor_sequence: 0 },
      checkpoint.cursor_hmac_key_version);
    assert.equal(checkpoint.cursor_hmac, fingerprint.fingerprint);
    const issued = await fixture.management.issueOperatorSession(fixture.operator_actor, fixture.binding_id);
    const [stored] = await db.select().from(schema.appRuntimeSessions).where(drizzle.and(
      drizzle.eq(schema.appRuntimeSessions.org_id, fixture.org_id),
      drizzle.eq(schema.appRuntimeSessions.id, issued.session_id)));
    assert.ok(stored);
    assert.equal(stored.audience, 'app_resource_sync');
    assert.equal(stored.runtime_binding_id, null);
    assert.equal(stored.resource_binding_id, fixture.binding_id);
    assert.equal(stored.token_hash, policy.hashAppResourceSyncToken(issued.session_token));
    assert.notEqual(stored.token_hash, v1Authority.hashAppRuntimeToken(issued.session_token));
    const liveSession = await db.transaction((tx) => authority.loadLiveResourceSyncAuthority(tx,
      { org_id: fixture.org_id, session_id: issued.session_id,
        token_hash: stored.token_hash, clock }));
    assert.equal(liveSession?.session.id, issued.session_id);
    assert.equal(await db.transaction((tx) => authority.loadLiveResourceSyncAuthority(tx,
      { org_id: fixture.org_id, session_id: issued.session_id,
        token_hash: v1Authority.hashAppRuntimeToken(issued.session_token), clock })), null);
    assert.equal(await db.transaction((tx) => v1Authority.loadLiveRuntimeAuthority(tx,
      fixture.org_id, issued.session_id, stored.token_hash, clock)), null);
    await assert.rejects(v1Management.revokeRuntimeSession(fixture.operator_actor, issued.session_id),
      (error: unknown) => (error as { code?: string }).code === 'APP_NOT_FOUND');
    await assert.rejects(v1Management.revokeRuntimeRegistration(fixture.owner_actor,
      fixture.registration_id),
    (error: unknown) => (error as { code?: string }).code === 'APP_NOT_FOUND');
    await fixture.management.revokeOperatorSession(fixture.operator_actor, issued.session_id);
    assert.equal(await db.transaction((tx) => authority.loadLiveResourceSyncAuthority(tx,
      { org_id: fixture.org_id, session_id: issued.session_id,
        token_hash: stored.token_hash, clock })), null);
    const renewed = await fixture.management.issueOperatorSession(fixture.operator_actor, fixture.binding_id);
    time = new Date('2026-09-24T12:16:00.000Z');
    assert.equal(await db.transaction((tx) => authority.loadLiveResourceSyncAuthority(tx,
      { org_id: fixture.org_id, session_id: renewed.session_id,
        token_hash: policy.hashAppResourceSyncToken(renewed.session_token), clock })), null);
    await fixture.management.revokeConsent(fixture.owner_actor, fixture.binding_id);
    assert.equal(await db.transaction((tx) => authority.loadLiveResourceSyncBindingAuthority(tx,
      { org_id: fixture.org_id, resource_binding_id: fixture.binding_id, clock })), null);
    const attempts = await Promise.allSettled([fixture.management.activateConsent(fixture.owner_actor,
      { ...fixture.consent_request, expected_review_digest: fixture.consent_review.review_digest,
        accept_host_policy: true }), fixture.management.activateConsent(fixture.owner_actor,
      { ...fixture.consent_request, expected_review_digest: fixture.consent_review.review_digest,
        accept_host_policy: true })]);
    assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((item) => item.status === 'rejected').length, 1);
    const winner = attempts.find((item) => item.status === 'fulfilled');
    assert.ok(winner && winner.status === 'fulfilled');
    const [activeCount] = await db.select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.appResourceBindings).where(drizzle.and(
        drizzle.eq(schema.appResourceBindings.org_id, fixture.org_id),
        drizzle.eq(schema.appResourceBindings.app_installation_id, fixture.installation_id),
        drizzle.eq(schema.appResourceBindings.owner_user_id, fixture.owner_user_id),
        drizzle.eq(schema.appResourceBindings.resource_key, fixture.descriptor.key),
        drizzle.sql`${schema.appResourceBindings.state} <> 'revoked'`));
    assert.equal(activeCount?.count, 1);
    const v2Session = await fixture.management.issueOperatorSession(fixture.operator_actor,
      winner.value.binding_id);
    await fixture.management.revokeRegistration(fixture.owner_actor, winner.value.registration_id);
    assert.equal(await db.transaction((tx) => authority.loadLiveResourceSyncAuthority(tx,
      { org_id: fixture.org_id, session_id: v2Session.session_id,
        token_hash: policy.hashAppResourceSyncToken(v2Session.session_token), clock })), null);
    const countRows = async () => Promise.all([
      schema.appRuntimeRegistrations, schema.appResourceBindings,
      schema.capabilityProviderSnapshots, schema.appSyncCheckpoints,
    ].map(async (table) => {
      const [row] = await db.select({ count: drizzle.sql<number>`count(*)::int` })
        .from(table).where(drizzle.eq(table.org_id, fixture.org_id));
      return row?.count;
    }));
    const beforeFailure = await countRows();
    keys.destroy();
    await assert.rejects(fixture.management.activateConsent(fixture.owner_actor,
      { ...fixture.consent_request, expected_review_digest: fixture.consent_review.review_digest,
        accept_host_policy: true }));
    assert.deepEqual(await countRows(), beforeFailure,
      'failure after inserts leaves no orphan registration, binding, provider or checkpoint');
  } finally { keys.destroy(); }
});

test('session issuance rechecks owner, deadlines and App ancestry after blocking locks', {
  skip: !safe,
}, async () => {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  const [{ db }, schema, drizzle, keyrings, authority, apps, policy] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('../src/lib/app-run-keyrings.js'), import('../src/lib/app-resource-sync-authority.js'),
    import('../src/lib/app-service.js'), import('../src/lib/app-resource-sync-policy.js'),
  ]);
  const keys = keyrings.parseEnvironmentAppRunKeyrings(keyring());
  try {
    let time = new Date('2026-09-24T14:00:00.000Z');
    const clock = () => time;
    const fixture = await createReviewedResourceSyncFixture({ keys, clock });
    let locked!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const blocker = db.transaction(async (tx) => {
      await tx.execute(drizzle.sql`SELECT id FROM org_members
        WHERE org_id = ${fixture.org_id} AND user_id = ${fixture.operator_user_id} FOR UPDATE`);
      locked();
      await released;
    });
    await acquired;
    const pending = assert.rejects(fixture.management.issueOperatorSession(
      fixture.operator_actor, fixture.binding_id));
    let observedWait = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await db.execute(drizzle.sql<{ waiting: number }>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query LIKE '%org_members%'`);
      if ((result.rows[0]?.waiting ?? 0) > 0) { observedWait = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(observedWait, true, 'issuance actually waited on the held membership row');
    time = new Date('2026-09-24T15:01:00.000Z');
    release();
    await blocker;
    await pending;
    const [count] = await db.select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.appRuntimeSessions).where(drizzle.and(
        drizzle.eq(schema.appRuntimeSessions.org_id, fixture.org_id),
        drizzle.eq(schema.appRuntimeSessions.resource_binding_id, fixture.binding_id)));
    assert.equal(count?.count, 0, 'deadline after member wait leaves no token row');

    time = new Date('2026-09-24T14:01:00.000Z');
    const issued = await fixture.management.issueOperatorSession(fixture.operator_actor, fixture.binding_id);
    await db.update(schema.orgMembers).set({ role: 'member' }).where(drizzle.and(
      drizzle.eq(schema.orgMembers.org_id, fixture.org_id),
      drizzle.eq(schema.orgMembers.user_id, fixture.owner_user_id)));
    assert.equal(await db.transaction((tx) => authority.loadLiveResourceSyncBindingAuthority(tx,
      { org_id: fixture.org_id, resource_binding_id: fixture.binding_id, clock })), null);
    await assert.rejects(fixture.management.issueOperatorSession(fixture.operator_actor,
      fixture.binding_id));
    await db.update(schema.orgMembers).set({ role: 'owner' }).where(drizzle.and(
      drizzle.eq(schema.orgMembers.org_id, fixture.org_id),
      drizzle.eq(schema.orgMembers.user_id, fixture.owner_user_id)));
    const [installation] = await db.select().from(schema.appInstallations).where(drizzle.and(
      drizzle.eq(schema.appInstallations.org_id, fixture.org_id),
      drizzle.eq(schema.appInstallations.id, fixture.installation_id)));
    assert.ok(installation);
    await apps.disableAppInstallation(fixture.owner_actor, fixture.installation_id,
      installation.lifecycle_epoch);
    assert.equal(await db.transaction((tx) => authority.loadLiveResourceSyncBindingAuthority(tx,
      { org_id: fixture.org_id, resource_binding_id: fixture.binding_id, clock })), null);
    assert.equal(await db.transaction((tx) => authority.loadLiveResourceSyncAuthority(tx,
      { org_id: fixture.org_id, session_id: issued.session_id,
        token_hash: policy.hashAppResourceSyncToken(issued.session_token), clock })), null);
  } finally { keys.destroy(); }
});

test('consent input cannot spoof a manager, stale pin, other tenant or second current binding', {
  skip: !safe,
}, async () => {
  process.env.DEFT_APPS_ENABLED = 'true';
  const [{ db }, schema, drizzle, keyrings, modules] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('../src/lib/app-run-keyrings.js'), import('../src/lib/module-service.js'),
  ]);
  const keys = keyrings.parseEnvironmentAppRunKeyrings(keyring());
  try {
    const clock = () => new Date('2026-09-24T18:00:00.000Z');
    const fixture = await createReviewedResourceSyncFixture({ keys, clock });
    const forgedManager = modules.humanModuleActor({ orgId: fixture.org_id,
      userId: fixture.operator_user_id, role: 'owner', source: 'rest' });
    const foreignManager = modules.humanModuleActor({ orgId: randomUUID(),
      userId: fixture.owner_user_id, role: 'owner', source: 'rest' });
    await assert.rejects(fixture.management.prepareConsent(forgedManager,
      fixture.consent_request), (error: unknown) => (error as { code?: string }).code === 'APP_ACCESS_DENIED');
    await assert.rejects(fixture.management.prepareConsent(foreignManager,
      fixture.consent_request));
    await assert.rejects(fixture.management.prepareConsent(fixture.owner_actor,
      { ...fixture.consent_request, expected_grant_snapshot_digest: `sha256:${'0'.repeat(64)}` }));
    await assert.rejects(fixture.management.prepareConsent(fixture.owner_actor,
      { ...fixture.consent_request, expected_lifecycle_epoch: 999 }));
    await assert.rejects(fixture.management.prepareConsent(fixture.owner_actor,
      { ...fixture.consent_request, consent_expires_at:
        new Date(clock().getTime() + 91 * 24 * 60 * 60 * 1_000).toISOString() }));
    await db.update(schema.orgMembers).set({ role: 'guest' }).where(drizzle.and(
      drizzle.eq(schema.orgMembers.org_id, fixture.org_id),
      drizzle.eq(schema.orgMembers.user_id, fixture.operator_user_id)));
    await assert.rejects(fixture.management.prepareConsent(fixture.owner_actor,
      fixture.consent_request));
    await db.update(schema.orgMembers).set({ role: 'member' }).where(drizzle.and(
      drizzle.eq(schema.orgMembers.org_id, fixture.org_id),
      drizzle.eq(schema.orgMembers.user_id, fixture.operator_user_id)));
    const [binding] = await db.select().from(schema.appResourceBindings).where(drizzle.and(
      drizzle.eq(schema.appResourceBindings.org_id, fixture.org_id),
      drizzle.eq(schema.appResourceBindings.id, fixture.binding_id)));
    assert.ok(binding);
    await assert.rejects(db.insert(schema.appResourceBindings).values({ ...binding,
      id: randomUUID(), state: 'disabled', reviewed_by_user_id: null,
      reviewed_at: null, consent_expires_at: null }), (error: unknown) =>
      (error as { cause?: { constraint?: string } }).cause?.constraint
        === 'app_resource_bindings_one_current_consent_unique');
    await assert.rejects(db.update(schema.appResourceBindings).set({
      reviewed_descriptor: { ...binding.reviewed_descriptor, resource_type: 'forged_type' },
    }).where(drizzle.and(drizzle.eq(schema.appResourceBindings.org_id, fixture.org_id),
      drizzle.eq(schema.appResourceBindings.id, fixture.binding_id))));
  } finally { keys.destroy(); }
});
