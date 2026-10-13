import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { emailNotificationPushStillCurrent } from '../src/lib/web-push.js';

const target = 'postgresql://gate_g_test@127.0.0.1:55435/email_stage34_notifications_87_upgrade';
const safe = process.env.DATABASE_URL === target && process.env.DEFT_TEST_DATABASE_URL === target;
const isAccessDenied = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error
  && error.code === 'EMAIL_ACCESS_DENIED';

// Reduced App graph proof: the DB rows below are real and the loader reads them,
// but descriptor/registry snapshot validation remains delegated to the existing loader tests.
test('supported-upgrade PG authority checks real SID and queue lease rows with an injected App-graph loader',
  { skip: !safe, timeout: 60_000 }, async () => {
    Object.assign(process.env, { NODE_ENV: 'test', DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true' });
    const material = (label: string) => createHash('sha256').update(`email-authority:${label}`).digest('base64');
    const initialKeyring = (purpose: string, id: string) => ({ current: id, keys: { [id]: material(purpose) } });
    process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
      run_encryption: initialKeyring('run', 'enc-v1'), receipt_signing: initialKeyring('sign', 'sig-v1'),
      fingerprint: initialKeyring('fingerprint', 'fp-v1') });
    const [{ db, closeDb }, schema, kit, syncKit, moduleService, reviewService, appService, keyrings, authorityModule, orm] = await Promise.all([
      import('../src/lib/db.js'), import('@deft/db/schema'), import('@deft/app-kit'),
      import('@deft/app-kit/experimental/resource-sync'), import('../src/lib/module-service.js'),
      import('../src/lib/app-runtime-review.js'), import('../src/lib/app-service.js'),
      import('./fixtures/app-run-test-keyrings.js'), import('../src/lib/email-mailbox-authority.js'), import('drizzle-orm'),
    ]);
    const keyring = await keyrings.databaseCompleteAppRunTestKeyringFixture('email-authority-fresh-schema');
    process.env.DEFT_APP_RUN_KEYRINGS = keyring.environment;
    const now = new Date();
    const org = randomUUID(), owner = randomUUID(), installationSuffix = randomUUID().replaceAll('-', '');
    const accountId = `email-authority-${randomUUID()}`, secondAccountId = `email-authority-${randomUUID()}`;
    const bindingId = randomUUID(), registrationId = randomUUID(), providerSnapshotId = randomUUID();
    const sessionId = randomUUID(), queueId = randomUUID(), lockToken = randomUUID();
    try {
      await db.insert(schema.orgs).values({ id: org, name: 'Email authority fixture', slug: `email-authority-${installationSuffix}` });
      await db.insert(schema.users).values({ id: owner, name: 'Synthetic mailbox owner', email: `${owner}@example.test` });
      await db.insert(schema.orgMembers).values({ id: randomUUID(), org_id: org, user_id: owner, role: 'owner', is_active: true });
      const expiry = new Date(now.getTime() + 60 * 60_000);
      await db.insert(schema.webSessions).values({ id: sessionId, org_id: org, user_id: owner,
        refresh_token_hash: `fixture:${randomUUID()}`, expires_at: expiry });

      const manifest = kit.parseDeftAppManifest({ schema_version: '3', id: `community.example.emailauthority${installationSuffix}`,
        version: '1.0.0', name: 'Email authority fixture', license: 'AGPL-3.0-only',
        compatibility: { app_protocol: '3' }, modules: [], navigation: [],
        runtime_requirements: [{ key: 'provider', protocol_version: 'deft.app_runtime_channel.v1' }],
        private_capabilities: [{ key: 'read', version: '1', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
          output_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
        runtime_actions: [{ key: 'read', label: 'Read', capability_key: 'read', runtime_requirement_key: 'provider' }],
      });
      const packed = await kit.buildDeftAppPackage({ manifest, artifacts: [] });
      const actor = moduleService.humanModuleActor({ orgId: org, userId: owner, role: 'owner', source: 'rest' });
      const staged = await appService.stageAppPackage(actor, packed.json);
      const { and, eq, sql } = orm;
      const [version] = await db.select().from(schema.appVersions).where(and(eq(schema.appVersions.org_id, org), eq(schema.appVersions.id, staged.version_id)));
      assert.ok(version?.requested_grant_snapshot_id);
      const [requested] = await db.select().from(schema.appGrantSnapshots).where(and(eq(schema.appGrantSnapshots.org_id, org), eq(schema.appGrantSnapshots.id, version.requested_grant_snapshot_id)));
      assert.ok(requested);
      const reviewInput = { app_version_id: version.id, expected_package_digest: version.package_digest,
        expected_requested_snapshot_digest: requested.snapshot_digest, expected_lifecycle_epoch: staged.lifecycle_epoch,
        expected_grant_epoch: staged.grant_epoch };
      const review = await reviewService.prepareRuntimeAppReview(actor, staged.id, reviewInput);
      const active = await reviewService.activateRuntimeApp(actor, staged.id, {
        ...reviewInput, expected_review_digest: review.review_digest, accept_host_policy: true,
      });
      const descriptor = syncKit.parseSyncDescriptor({ schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox',
        runtime_requirement_key: 'provider', resource_type: 'message', requested_visibility: 'user_private',
        record_schema: { type: 'object', properties: { label: { type: 'string', maxLength: 80 } }, required: ['label'], additionalProperties: false }, label_field: 'label' });
      const descriptorDigest = await syncKit.digestResourceSyncDescriptor(descriptor);
      await db.insert(schema.appRuntimeRegistrations).values({ id: registrationId, org_id: org, app_installation_id: staged.id,
        app_version_id: version.id, grant_snapshot_id: active.grant_snapshot_id, operator_user_id: owner, contract_version: 'deft.app_runtime_channel.v2' });
      await db.update(schema.appRuntimeRegistrations).set({ state: 'active', runtime_epoch: 1, reviewed_by_user_id: owner, reviewed_at: now })
        .where(and(eq(schema.appRuntimeRegistrations.org_id, org), eq(schema.appRuntimeRegistrations.id, registrationId)));
      await db.insert(schema.capabilityProviderSnapshots).values({ id: providerSnapshotId, org_id: org, provider_kind: 'app_runtime',
        provider_instance_id: registrationId, adapter_contract_version: 'deft.app_runtime_channel.v2',
        snapshot_digest: `sha256:${createHash('sha256').update(registrationId).digest('hex')}`, safe_snapshot: {}, captured_at: now });
      await db.insert(schema.appResourceBindings).values({ id: bindingId, org_id: org, app_installation_id: staged.id,
        app_version_id: version.id, grant_snapshot_id: active.grant_snapshot_id, runtime_registration_id: registrationId,
        provider_instance_id: registrationId, provider_snapshot_id: providerSnapshotId, resource_key: 'inbox', resource_family: 'message',
        operation_name: 'sync_inbox', interface_identity: `deft.resource_sync.v2:${org}:${staged.id}:inbox`,
        reviewed_descriptor: descriptor, descriptor_digest: descriptorDigest, owner_user_id: owner, max_records_per_page: 100,
        max_page_bytes: 524288, max_retained_records: 100, max_retained_bytes: 1_073_741_824, min_interval_seconds: 60 });
      await db.update(schema.appResourceBindings).set({ state: 'active', reviewed_by_user_id: owner, reviewed_at: now, consent_expires_at: expiry })
        .where(and(eq(schema.appResourceBindings.org_id, org), eq(schema.appResourceBindings.id, bindingId)));

      await db.execute(sql`INSERT INTO email_accounts(org_id,owner_user_id,account_id,provider,resource_binding_id,principal_digest,state,authority_revision,consented_at)
        VALUES(${org},${owner},${accountId},'gmail',${bindingId},${'a'.repeat(64)},'active',1,${now})`);
      await db.execute(sql`INSERT INTO email_accounts(org_id,owner_user_id,account_id,provider,resource_binding_id,principal_digest,state,authority_revision,consented_at)
        VALUES(${org},${owner},${secondAccountId},'microsoft',${bindingId},${'b'.repeat(64)},'active',1,${now})`);
      await db.insert(schema.jobQueue).values({ id: queueId, org_id: org, queue: 'scheduled-jobs', name: 'native-email-sync',
        data: { org_id: org, owner_user_id: owner, account_id: accountId, authority_revision: 1 }, status: 'running', attempts: 1,
        max_attempts: 5, run_at: now, lock_token: lockToken, locked_by: 'email-authority-fixture', lock_expires_at: expiry });

      const loadBinding = async (tx: any, input: { org_id: string; resource_binding_id: string }) => {
        const [binding] = await tx.select().from(schema.appResourceBindings).where(and(eq(schema.appResourceBindings.org_id, input.org_id), eq(schema.appResourceBindings.id, input.resource_binding_id))).limit(1);
        if (!binding) return null;
        const [registration] = await tx.select().from(schema.appRuntimeRegistrations).where(and(eq(schema.appRuntimeRegistrations.org_id, org), eq(schema.appRuntimeRegistrations.id, registrationId))).limit(1);
        const [installation] = await tx.select().from(schema.appInstallations).where(and(eq(schema.appInstallations.org_id, org), eq(schema.appInstallations.id, staged.id))).limit(1);
        const [versionRow] = await tx.select().from(schema.appVersions).where(and(eq(schema.appVersions.org_id, org), eq(schema.appVersions.id, version.id))).limit(1);
        const [grant] = await tx.select().from(schema.appGrantSnapshots).where(and(eq(schema.appGrantSnapshots.org_id, org), eq(schema.appGrantSnapshots.id, active.grant_snapshot_id))).limit(1);
        const [provider_snapshot] = await tx.select().from(schema.capabilityProviderSnapshots).where(and(eq(schema.capabilityProviderSnapshots.org_id, org), eq(schema.capabilityProviderSnapshots.id, providerSnapshotId))).limit(1);
        return { binding, registration, installation, version: versionRow, grant, provider_snapshot,
          descriptor_digest: binding.descriptor_digest, checked_at: now } as any;
      };
      const authority = new authorityModule.PostgresEmailMailboxAuthority(db, { now: () => now, loadBinding });
      const scope = { org_id: org, owner_user_id: owner, account_id: accountId };
      const secondScope = { ...scope, account_id: secondAccountId };
      const human = { user_id: owner, web_session_id: sessionId, access_expires_at: expiry.getTime() };
      const humanCapability = await authority.current(human, scope, 'human_read');
      assert.equal(humanCapability.resource_binding_id, bindingId);
      await assert.rejects(db.transaction(async tx => {
        await authority.current(human, scope, 'human_read', tx);
        await authority.current(human, secondScope, 'human_read', tx);
      }), isAccessDenied,
      'a held authority transaction deliberately rejects a new account fence; the current unified finalizer cannot loop healthy accounts in one transaction');
      for (const accountScope of [scope, secondScope].sort((left, right) => left.account_id.localeCompare(right.account_id))) {
        const capability = await authority.current(human, accountScope, 'human_read');
        assert.equal(capability.scope.account_id, accountScope.account_id,
          'fresh per-account authority transactions preserve each account check after a held multi-scope transaction is rejected');
      }
      await assert.rejects(authority.current({ ...human, web_session_id: randomUUID() }, scope, 'human_read'), isAccessDenied);
      await db.update(schema.webSessions).set({ revoked_at: now }).where(eq(schema.webSessions.id, sessionId));
      await assert.rejects(authority.current(human, scope, 'human_read'), isAccessDenied);
      const serviceCapability = await authority.currentService(scope, { job_id: queueId, lock_token: lockToken });
      assert.equal(serviceCapability.resource_binding_id, bindingId);
      await assert.rejects(authority.currentService(scope, { job_id: queueId, lock_token: randomUUID() }), isAccessDenied);
      const notificationId = randomUUID(), notificationJobId = randomUUID(), notificationLock = randomUUID();
      await db.insert(schema.jobQueue).values({ id: notificationJobId, org_id: org, queue: 'scheduled-jobs', name: 'native-email-notification-dispatch',
        data: { org_id: org, owner_user_id: owner, account_id: accountId, notification_id: notificationId, revision: 1, authority_revision: 1 },
        status: 'running', attempts: 1, max_attempts: 5, run_at: now, lock_token: notificationLock, locked_by: 'email-notification-fixture', lock_expires_at: expiry });
      const notificationLease = { job_id: notificationJobId, lock_token: notificationLock, job_name: 'native-email-notification-dispatch' as const,
        notification_id: notificationId, revision: 1, authority_revision: 1 };
      assert.equal((await authority.currentService(scope, notificationLease)).resource_binding_id, bindingId);
      await assert.rejects(authority.currentService(scope, { ...notificationLease, revision: 2 }), isAccessDenied);
      await assert.rejects(authority.currentService(scope, { ...notificationLease, authority_revision: 2 }), isAccessDenied);
      await db.update(schema.jobQueue).set({ data: { org_id: org, owner_user_id: owner, account_id: accountId, notification_id: notificationId,
        revision: 1, authority_revision: 2 } }).where(eq(schema.jobQueue.id, notificationJobId));
      await assert.rejects(authority.currentService(scope, { ...notificationLease, authority_revision: 2 }), isAccessDenied);
      await db.update(schema.jobQueue).set({ data: { org_id: org, owner_user_id: owner, account_id: accountId, authority_revision: 2 } })
        .where(eq(schema.jobQueue.id, queueId));
      await assert.rejects(authority.currentService(scope, { job_id: queueId, lock_token: lockToken }), isAccessDenied);
      await db.update(schema.jobQueue).set({ data: { org_id: org, owner_user_id: owner, account_id: accountId, authority_revision: 1 } })
        .where(eq(schema.jobQueue.id, queueId));
      await db.update(schema.jobQueue).set({ lock_expires_at: new Date(now.getTime() - 1) }).where(eq(schema.jobQueue.id, queueId));
      await assert.rejects(authority.currentService(scope, { job_id: queueId, lock_token: lockToken }), isAccessDenied);

      const logicalId = `mail_${'c'.repeat(64)}`;
      await db.insert(schema.emailNotificationEvents).values({ org_id: org, owner_user_id: owner, account_id: accountId,
        notification_id: notificationId, logical_message_id: logicalId, revision: 1, authority_revision: 1, state: 'projected' });
      const pushItem = { org_id: org, user_id: owner, source_type: 'email', source_id: logicalId,
        metadata: { account_id: accountId, notification_id: notificationId, notification_revision: 1, authority_revision: 1 } } as const;
      assert.equal(await emailNotificationPushStillCurrent(pushItem), true, 'exact active account event is eligible for opted-in push policy');
      await db.update(schema.emailAccounts).set({ state: 'paused', authority_revision: 2 }).where(and(
        eq(schema.emailAccounts.org_id, org), eq(schema.emailAccounts.owner_user_id, owner), eq(schema.emailAccounts.account_id, accountId)));
      assert.equal(await emailNotificationPushStillCurrent(pushItem), false, 'queued push is suppressed after account pause/revocation');
      await db.update(schema.emailAccounts).set({ state: 'active', authority_revision: 3 }).where(and(
        eq(schema.emailAccounts.org_id, org), eq(schema.emailAccounts.owner_user_id, owner), eq(schema.emailAccounts.account_id, accountId)));
      assert.equal(await emailNotificationPushStillCurrent(pushItem), false, 'old projected event cannot deliver after authority revision changes');
      await db.delete(schema.jobQueue).where(eq(schema.jobQueue.id, notificationJobId));
    } finally {
      keyring.keys.destroy();
      await closeDb();
    }
  });
