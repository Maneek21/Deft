import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { SyncDescriptorV1, SyncPageV1 } from '@deft/app-kit/experimental/resource-sync';
import type { AppRunTransaction } from '../src/lib/app-run-repository.js';

const assigned = process.env.DATABASE_URL === process.env.DEFT_TEST_DATABASE_URL
  && process.env.DATABASE_URL === 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_20260926_private_read';

test('owner-private reads of actual reviewed and settled v5 resources', { skip: !assigned }, async (t) => {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
  process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
  const key = (purpose: string) => createHash('sha256').update(`private-read:${purpose}`).digest('base64');
  const ring = { schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: 'read-enc', keys: { 'read-enc': key('enc') } },
    receipt_signing: { current: 'read-sig', keys: { 'read-sig': key('sig') } },
    fingerprint: { current: 'read-fp', keys: { 'read-fp': key('fp') } } };
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify(ring);
  const [{ db, closeDb }, schema, { and, eq, sql }, fixture, keyrings, repositories,
    secretModule, inputModule, syncSecretModule, storeModule, admissionModule,
    runnerModule, channelModule, providerModule, queueModule, receiptModule, readModule] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('./fixtures/resource-sync-v5.js'), import('../src/lib/app-run-keyrings.js'),
    import('../src/lib/app-run-repository.js'), import('../src/lib/app-run-secrets.js'),
    import('../src/lib/app-run-secret-repository.js'), import('../src/lib/app-resource-sync-secrets.js'),
    import('../src/lib/app-resource-sync-store.js'), import('../src/lib/app-resource-sync-admission.js'),
    import('../src/lib/app-run-attempt-runner.js'), import('../src/lib/app-resource-sync-channel.js'),
    import('../src/lib/app-run-provider-executor.js'), import('../src/lib/app-run-scheduler.js'),
    import('../src/lib/app-run-receipts.js'), import('../src/lib/app-resource-private-read.js'),
  ]);
  const keys = keyrings.parseEnvironmentAppRunKeyrings(JSON.stringify(ring));
  let checkedAt = new Date();
  const clock = () => new Date(checkedAt);
  const repository = new repositories.PostgresAppRunRepository();
  const secrets = new secretModule.AppRunSecretService(keys);
  const inputs = new inputModule.AppRunSecretRepository(secrets);
  const syncSecrets = new syncSecretModule.AppResourceSyncSecretService(keys);
  const receiptWriter = new receiptModule.PostgresAppRunReceiptWriter(secrets, inputs);
  const makeRunner = (writer: typeof receiptWriter = receiptWriter) => new runnerModule.AppRunAttemptRunner(repository, inputs, secrets,
    new providerModule.PinnedMcpAppRunProviderExecutor(), undefined, clock, 60_000, 20_000,
    writer, undefined,
    queueModule.postgresAppRunAttemptQueue, new storeModule.AppResourceSyncStore(syncSecrets, inputs));
  const runner = makeRunner();
  const admission = new admissionModule.AppResourceSyncAdmissionService(repository, inputs,
    secrets, syncSecrets, runner, clock, () => true);
  const channel = new channelModule.AppResourceSyncChannel(runner);
  const reader = new readModule.AppResourcePrivateReadService(keys, clock);
  type Fixture = Awaited<ReturnType<typeof fixture.createReviewedResourceSyncFixture>>;
  const subject = (owned: Fixture) => ({ kind: 'human' as const,
    org_id: owned.org_id, user_id: owned.owner_user_id });
  const target = (owned: Fixture) => ({ resource_binding_id: owned.binding_id });
  const unavailable = (error: unknown) => {
    assert.ok(error instanceof readModule.AppResourcePrivateReadError);
    assert.equal(error.message, 'Private resource unavailable');
    assert.equal(error.status, 404);
    return error.code === 'APP_RESOURCE_PRIVATE_UNAVAILABLE';
  };
  const settle = async (owned: Fixture, upserts: SyncPageV1['upserts'],
    tombstones: SyncPageV1['tombstones'] = [], settleChannel = channel) => {
    checkedAt = new Date(checkedAt.getTime() + 61_000);
    const admitted = await admission.admitDue({ org_id: owned.org_id, resource_binding_id: owned.binding_id });
    assert.equal(admitted.state, 'created');
    const issued = await owned.management.issueOperatorSession(owned.operator_actor, owned.binding_id);
    const base = { schema_version: 'deft.app_runtime_channel.v2' as const,
      audience: 'app_resource_sync' as const, session_id: issued.session_id, session_token: issued.session_token };
    const claim = await channel.claim({ ...base, max_claims: 1 });
    assert.ok(claim);
    const attempt = { ...base, run_id: claim.run_id, attempt_id: claim.attempt_id,
      claim_token: claim.claim_token, sequence: claim.sequence };
    assert.ok(await channel.start(attempt));
    assert.ok(await settleChannel.complete({ ...attempt, status: 'returned', provider_succeeded: true,
      page: { schema_version: 'deft.app_sync_page.v1', upserts, tombstones,
        next_cursor: `provider-cursor-${randomUUID()}`, has_more: false } }));
  };
  const fresh = async (descriptor?: SyncDescriptorV1) => {
    const owned = await fixture.createReviewedResourceSyncFixture({ keys, clock, descriptor });
    await settle(owned, [{ id: 'provider-private-id', revision: 'r1', data: { subject: 'Private label' } }]);
    return owned;
  };
  const waitForLock = async (marker: string) => {
    for (let i = 0; i < 300; i++) {
      const result = await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE application_name = ${marker} AND wait_event_type = 'Lock'`);
      if (Number((result as { rows: Array<{ count: number }> }).rows[0]?.count) > 0) return;
      await delay(10);
    }
    assert.fail('actual PostgreSQL lock wait was not observed');
  };
  const markedReader = (marker: string, readClock = clock,
    guard?: (tx: AppRunTransaction) => Promise<void>) => {
    class WaitingRepository extends repositories.PostgresAppRunRepository {
      override transaction<T>(work: (tx: AppRunTransaction) => Promise<T>): Promise<T> {
        return super.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('application_name', ${marker}, true)`);
          await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
          return work(tx);
        });
      }
    }
    return new readModule.AppResourcePrivateReadService(keys, readClock, new WaitingRepository(), guard);
  };
  try {
    const owned = await fixture.createReviewedResourceSyncFixture({ keys, clock });
    await settle(owned, Array.from({ length: 31 }, (_, i) => ({ id: `provider-${i}`, revision: `r${i}`,
      data: { subject: `  Private\tmessage ${i}  ` } })));
    const first = await reader.listOwnerPrivateResourcePage(subject(owned), target(owned));
    await t.test('owner receives bounded normalized records and stable host UUID refs with unknown freshness', async () => {
      assert.equal(first.items.length, 25);
      assert.ok(first.next_cursor);
      assert.equal(first.checkpoint.freshness, 'unknown');
      assert.equal(first.checkpoint.cursor_sequence, 1);
      assert.ok(first.checkpoint.last_applied_at);
      for (const item of first.items) {
        assert.match(item.label, /^Private message \d+$/u);
        assert.equal(item.ref.schema_version, 'deft.resource_ref.v2');
        assert.equal(item.ref.provider.kind, 'app_runtime');
        assert.equal(item.ref.provider.provider_instance_id, owned.registration_id);
        assert.equal(item.ref.resource_id, item.projection_id);
        assert.equal(item.ref.resource_type, 'email_message');
        assert.equal(item.freshness, 'unknown');
        assert.deepEqual((await reader.getOwnerPrivateResource(subject(owned), {
          ...target(owned), projection_id: item.projection_id })).item, item);
      }
      const text = JSON.stringify(first);
      for (const forbidden of ['provider-private-id', 'provider-cursor-', 'ciphertext', 'owner_user_id',
        'resource_id_hmac', 'provider_id', owned.owner_user_id, owned.operator_user_id]) {
        assert.equal(text.includes(forbidden), false);
      }
      assert.equal(Buffer.byteLength(text) <= 1_048_576, true);
      assert.deepEqual(await reader.listOwnerPrivateResourcePage(subject(owned), target(owned)), first);
    });
    await t.test('keyset pagination returns every record exactly once and enforces a closed bounded input', async () => {
      const second = await reader.listOwnerPrivateResourcePage(subject(owned), {
        ...target(owned), cursor: first.next_cursor! });
      assert.equal(second.items.length, 6);
      assert.equal(second.next_cursor, null);
      const ids = [...first.items, ...second.items].map((item) => item.projection_id);
      assert.equal(new Set(ids).size, 31);
      assert.deepEqual(ids, [...ids].sort());
      for (const input of [{ ...target(owned), limit: 26 }, { ...target(owned), limit: 0 },
        { ...target(owned), offset: 2 }, { ...target(owned), resource_binding_id: 'bad' }]) {
        await assert.rejects(reader.listOwnerPrivateResourcePage(subject(owned), input),
          (error: unknown) => (error as { code: string }).code === 'APP_RESOURCE_PRIVATE_INPUT_INVALID');
      }
    });
    await t.test('foreign org, same-org nonowner, guessed row and cursor tampering disclose no private data', async () => {
      await assert.rejects(reader.listOwnerPrivateResourcePage({ ...subject(owned), org_id: randomUUID() }, target(owned)), unavailable);
      await assert.rejects(reader.listOwnerPrivateResourcePage({ ...subject(owned), user_id: owned.operator_user_id }, target(owned)), unavailable);
      await assert.rejects(reader.getOwnerPrivateResource(subject(owned), { ...target(owned), projection_id: randomUUID() }), unavailable);
      await assert.rejects(reader.listOwnerPrivateResourcePage(subject(owned), { ...target(owned), cursor: `${first.next_cursor!.slice(0, -2)}AA` }), unavailable);
      const other = await fresh();
      await assert.rejects(reader.listOwnerPrivateResourcePage(subject(other), { ...target(other), cursor: first.next_cursor! }), unavailable);
      await assert.rejects(reader.getOwnerPrivateResource(subject(other), { ...target(other), projection_id: first.items[0]!.projection_id }), unavailable);
    });
    await t.test('settled tombstone removes the body and label; changed checkpoint invalidates prior cursor', async () => {
      const old = first.items[0]!;
      const index = Number(old.revision.slice(1));
      await settle(owned, [], [{ id: `provider-${index}`, revision: 'deleted' }]);
      await assert.rejects(reader.getOwnerPrivateResource(subject(owned), { ...target(owned), projection_id: old.projection_id }), unavailable);
      await assert.rejects(reader.listOwnerPrivateResourcePage(subject(owned), { ...target(owned), cursor: first.next_cursor! }),
        (error: unknown) => (error as { code: string }).code === 'APP_RESOURCE_PRIVATE_CURSOR_STALE');
      const current = await reader.listOwnerPrivateResourcePage(subject(owned), target(owned));
      assert.equal(current.items.some((item) => item.projection_id === old.projection_id), false);
      assert.equal(current.items.some((item) => item.label === old.label), false);
    });
    for (const change of ['binding', 'registration', 'owner', 'operator', 'demoted', 'disabled', 'grant', 'consent'] as const) {
      await t.test(`live authority denies ${change} revocation or expiry`, async () => {
        const changed = await fresh();
        if (change === 'binding') await changed.management.revokeConsent(changed.owner_actor, changed.binding_id);
        if (change === 'registration') await changed.management.revokeRegistration(changed.owner_actor, changed.registration_id);
        if (change === 'owner' || change === 'operator') await db.update(schema.orgMembers).set({ is_active: false }).where(and(
          eq(schema.orgMembers.org_id, changed.org_id), eq(schema.orgMembers.user_id, change === 'owner' ? changed.owner_user_id : changed.operator_user_id)));
        if (change === 'demoted') await db.update(schema.orgMembers).set({ role: 'member' }).where(and(
          eq(schema.orgMembers.org_id, changed.org_id), eq(schema.orgMembers.user_id, changed.owner_user_id)));
        if (change === 'disabled') {
          const [installation] = await db.select().from(schema.appInstallations)
            .where(eq(schema.appInstallations.id, changed.installation_id));
          assert.ok(installation);
          await (await import('../src/lib/app-service.js')).disableAppInstallation(
            changed.owner_actor, changed.installation_id, installation.lifecycle_epoch);
        }
        if (change === 'grant') {
          const [grant] = await db.select().from(schema.appGrantSnapshots).where(eq(schema.appGrantSnapshots.id, changed.grant_snapshot_id));
          assert.ok(grant);
          const replacementId = randomUUID();
          await db.insert(schema.appGrantSnapshots).values({ ...grant, id: replacementId, supersedes_snapshot_id: grant.id });
          await db.update(schema.appInstallations).set({ active_grant_snapshot_id: replacementId,
            grant_epoch: sql`${schema.appInstallations.grant_epoch} + 1` })
            .where(eq(schema.appInstallations.id, changed.installation_id));
        }
        const expiryReader = change === 'consent' ? new readModule.AppResourcePrivateReadService(keys,
          () => new Date(checkedAt.getTime() + 3_600_000)) : reader;
        await assert.rejects(expiryReader.listOwnerPrivateResourcePage(subject(changed), target(changed)), unavailable);
      });
    }
    await t.test('missing encryption and cursor keys fail closed without fallback', async () => {
      const changed = await fresh();
      const missingEncryption = keyrings.parseEnvironmentAppRunKeyrings(JSON.stringify({ ...ring,
        run_encryption: { current: 'enc2', keys: { enc2: key('enc2') } } }));
      const missingFingerprint = keyrings.parseEnvironmentAppRunKeyrings(JSON.stringify({ ...ring,
        fingerprint: { current: 'fp2', keys: { fp2: key('fp2') } } }));
      try {
        await assert.rejects(new readModule.AppResourcePrivateReadService(missingEncryption, clock)
          .listOwnerPrivateResourcePage(subject(changed), target(changed)), unavailable);
        await assert.rejects(new readModule.AppResourcePrivateReadService(missingFingerprint, clock)
          .listOwnerPrivateResourcePage(subject(owned), { ...target(owned), cursor: first.next_cursor! }), unavailable);
      } finally { missingEncryption.destroy(); missingFingerprint.destroy(); }
    });
    await t.test('consent expiring during decryption prevents the completed page from escaping', async () => {
      const changed = await fresh();
      let clockReads = 0;
      const lateReader = new readModule.AppResourcePrivateReadService(keys,
        () => new Date(checkedAt.getTime() + (++clockReads >= 3 ? 3_600_000 : 0)));
      await assert.rejects(lateReader.listOwnerPrivateResourcePage(subject(changed), target(changed)), unavailable);
      assert.equal(clockReads, 3);
    });
    await t.test('tampered ciphertext and authenticated descriptor-invalid plaintext fail the whole page', async () => {
      const changed = await fresh();
      const [row] = await db.select().from(schema.appResourceProjections).where(eq(schema.appResourceProjections.resource_binding_id, changed.binding_id));
      assert.ok(row);
      // Deliberate at-rest corruption injection under the retained-key test marker.
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL deft.app_resource_sync_rekey = 'on'`);
        await tx.update(schema.appResourceProjections).set({ body_auth_tag_b64: Buffer.alloc(16, 42).toString('base64') })
          .where(eq(schema.appResourceProjections.id, row.id));
      });
      await assert.rejects(reader.listOwnerPrivateResourcePage(subject(changed), target(changed)), unavailable);
      const envelope = syncSecrets.sealJson({ revision: 'r2', data: { subject: 'Looks valid', unreviewed: 'SECRET' } }, {
        org_id: changed.org_id, resource_binding_id: changed.binding_id, checkpoint_id: changed.checkpoint_id,
        payload_kind: 'projection', projection_id: row.id, generation: row.generation, slot: 'record' });
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL deft.app_resource_sync_rekey = 'on'`);
        await tx.update(schema.appResourceProjections).set({ body_auth_tag_b64: envelope.auth_tag_b64,
          body_ciphertext_b64: envelope.ciphertext_b64, body_nonce_b64: envelope.nonce_b64,
          body_bytes: Buffer.byteLength(envelope.ciphertext_b64, 'base64') }).where(eq(schema.appResourceProjections.id, row.id));
      });
      await assert.rejects(reader.listOwnerPrivateResourcePage(subject(changed), target(changed)), unavailable);
    });
    await t.test('byte-capped keyset pages include every large record without silent skips', async () => {
      const descriptor: SyncDescriptorV1 = { ...owned.descriptor, record_schema: { type: 'object',
        properties: { subject: { type: 'string', maxLength: 200 },
          ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field_${i}`, { type: 'string' as const, maxLength: 16_384 }])) },
        required: ['subject'], additionalProperties: false } };
      const big = await fixture.createReviewedResourceSyncFixture({ keys, clock, descriptor });
      for (let i = 0; i < 3; i++) await settle(big, [{ id: `large-${i}`, revision: 'r1', data: {
        subject: `Large ${i}`, ...Object.fromEntries(Array.from({ length: 30 }, (_, f) => [`field_${f}`, 'x'.repeat(16_384)])),
      } }]);
      const page = await reader.listOwnerPrivateResourcePage(subject(big), target(big));
      assert.equal(page.items.length, 2);
      assert.ok(page.next_cursor);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1_048_576);
      const remaining = await reader.listOwnerPrivateResourcePage(subject(big), { ...target(big), cursor: page.next_cursor });
      assert.equal(remaining.items.length, 1);
      assert.equal(remaining.next_cursor, null);
      assert.equal(new Set([...page.items, ...remaining.items].map((item) => item.projection_id)).size, 3);
    });
    await t.test('checkpoint lock wait rechecks consent after the actual database wait', async () => {
      const changed = await fresh();
      const marker = `private-read-${randomUUID()}`;
      class WaitingRepository extends repositories.PostgresAppRunRepository {
        override transaction<T>(work: (tx: AppRunTransaction) => Promise<T>): Promise<T> {
          return super.transaction(async (tx) => {
            await tx.execute(sql`SELECT set_config('application_name', ${marker}, true)`);
            await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
            return work(tx);
          });
        }
      }
      let expired = false;
      const waitingReader = new readModule.AppResourcePrivateReadService(keys,
        () => new Date(checkedAt.getTime() + (expired ? 3_600_000 : 0)), new WaitingRepository());
      let unlock!: () => void;
      let ready!: () => void;
      const locked = new Promise<void>((resolve) => { ready = resolve; });
      const release = new Promise<void>((resolve) => { unlock = resolve; });
      const holder = db.transaction(async (tx) => {
        await tx.select().from(schema.appSyncCheckpoints).where(eq(schema.appSyncCheckpoints.id, changed.checkpoint_id)).for('update');
        ready();
        await release;
      });
      await locked;
      const pending = assert.rejects(waitingReader.listOwnerPrivateResourcePage(subject(changed), target(changed)), unavailable);
      try {
        let observed = false;
        for (let i = 0; i < 300; i++) {
          const result = await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE application_name = ${marker} AND wait_event_type = 'Lock'`);
          if (Number((result as { rows: Array<{ count: number }> }).rows[0]?.count) > 0) { observed = true; break; }
          await delay(10);
        }
        assert.ok(observed, 'actual PostgreSQL checkpoint lock wait observed');
        expired = true;
      } finally { unlock(); await holder; }
      await pending;
    });
    await t.test('revocation committed during an observed member lock wait denies the reader', async () => {
      const changed = await fresh();
      const marker = `read-revocation-${randomUUID()}`;
      const waitingReader = markedReader(marker);
      let unlock!: () => void;
      let ready!: () => void;
      const locked = new Promise<void>((resolve) => { ready = resolve; });
      const release = new Promise<void>((resolve) => { unlock = resolve; });
      const holder = db.transaction(async (tx) => {
        await tx.update(schema.orgMembers).set({ is_active: false }).where(and(
          eq(schema.orgMembers.org_id, changed.org_id), eq(schema.orgMembers.user_id, changed.owner_user_id)));
        ready();
        await release;
      });
      await locked;
      const pending = assert.rejects(waitingReader.listOwnerPrivateResourcePage(subject(changed), target(changed)), unavailable);
      try { await waitForLock(marker); }
      finally { unlock(); await holder; }
      await pending;
    });
    await t.test('actual page settlement committed during checkpoint lock wait invalidates the old cursor', async () => {
      const changed = await fixture.createReviewedResourceSyncFixture({ keys, clock });
      await settle(changed, [{ id: 'first', revision: 'r1', data: { subject: 'First' } },
        { id: 'second', revision: 'r1', data: { subject: 'Second' } }]);
      const prior = await reader.listOwnerPrivateResourcePage(subject(changed), { ...target(changed), limit: 1 });
      assert.ok(prior.next_cursor);
      let unlock!: () => void;
      let ready!: () => void;
      const locked = new Promise<void>((resolve) => { ready = resolve; });
      const release = new Promise<void>((resolve) => { unlock = resolve; });
      const gatedWriter = { async write(tx: Parameters<typeof receiptWriter.write>[0],
        value: Parameters<typeof receiptWriter.write>[1]) {
        await receiptWriter.write(tx, value);
        if (value.receipt_kind === 'attempt_terminal' && value.run.state === 'succeeded') {
          ready();
          await release;
        }
      } };
      const holder = settle(changed, [{ id: 'third', revision: 'r1', data: { subject: 'Third' } }], [],
        new channelModule.AppResourceSyncChannel(makeRunner(gatedWriter as typeof receiptWriter)));
      await locked;
      const marker = `read-settlement-${randomUUID()}`;
      const pending = assert.rejects(markedReader(marker).listOwnerPrivateResourcePage(subject(changed), {
        ...target(changed), cursor: prior.next_cursor,
      }), (error: unknown) => (error as { code: string }).code === 'APP_RESOURCE_PRIVATE_CURSOR_STALE');
      try { await waitForLock(marker); }
      finally { unlock(); await holder; }
      await pending;
      const current = await reader.listOwnerPrivateResourcePage(subject(changed), target(changed));
      assert.equal(current.items.length, 3);
      assert.equal(current.checkpoint.cursor_sequence, 2);
    });
    await t.test('final delivery guard lock wait cannot release a page after consent expires', async () => {
      const changed = await fresh();
      const sid = randomUUID();
      await db.insert(schema.webSessions).values({ id: sid, org_id: changed.org_id,
        user_id: changed.owner_user_id, refresh_token_hash: 'synthetic-private-read',
        expires_at: new Date(checkedAt.getTime() + 86_400_000) });
      let unlock!: () => void;
      let ready!: () => void;
      const locked = new Promise<void>((resolve) => { ready = resolve; });
      const release = new Promise<void>((resolve) => { unlock = resolve; });
      const holder = db.transaction(async (tx) => {
        await tx.select().from(schema.webSessions).where(eq(schema.webSessions.id, sid)).for('update');
        ready();
        await release;
      });
      await locked;
      let expired = false;
      const marker = `read-final-guard-${randomUUID()}`;
      const guarded = markedReader(marker,
        () => new Date(checkedAt.getTime() + (expired ? 3_600_000 : 0)), async (tx) => {
          await tx.select().from(schema.webSessions).where(eq(schema.webSessions.id, sid)).for('share');
        });
      const pending = assert.rejects(guarded.listOwnerPrivateResourcePage(subject(changed), target(changed)), unavailable);
      try { await waitForLock(marker); expired = true; }
      finally { unlock(); await holder; }
      await pending;
    });
  } finally { keys.destroy(); await closeDb(); }
});
