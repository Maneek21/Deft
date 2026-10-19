import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDeftAppPackage } from '@deft/app-kit';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';

for (const continuationBacked of [false, true]) test((continuationBacked ? 'ordinary continuation-backed ' : 'ordinary ') + 'historical sync closure after a reviewed version upgrade retains unknown evidence and a verified receipt', { timeout: 180_000 }, async t => {
  const target = new URL(process.env.DEFT_TEST_DATABASE_URL!);
  assert.equal(process.env.DATABASE_URL, process.env.DEFT_TEST_DATABASE_URL);
  assert.equal(target.hostname, '127.0.0.1'); assert.ok(['55437', '55438'].includes(target.port));
  assert.equal(target.pathname, '/deft_live_wiki_concurrency_test');
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
    DEFT_APP_PRIVATE_STATE_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true',
    DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
    DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true', DEFT_APP_OWNER_CONNECTIONS_ENABLED: 'true', DEFT_APP_RESOURCE_OBSERVATION_ENABLED: 'true' });
  // Preserve exact deterministic keys of retained normal fixtures in this
  // reused disposable DB; the global custody inventory remains unchanged.
  const ring = (id: string) => ({ current: `historical-closure-${id}`, keys: {
    [`historical-closure-${id}`]: createHash('sha256').update(`historical-closure:${id}`).digest('base64'),
    [id]: createHash('sha256').update(`runtime-setup:${id}`).digest('base64'),
    [`owner-${id}`]: createHash('sha256').update(`owner-connections:owner-${id}`).digest('base64'),
  } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: ring('enc'), receipt_signing: ring('sign'), fingerprint: ring('fp') });
  const [{ db, closeDb }, s, { and, eq }, { Hono }, web, runRuntime, attachmentRuntime,
    { appAttachmentRoutes }, { appOwnerConnectionRoutes }, { resourceSyncWebAuthority }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('hono'), import('../src/lib/web-sessions.js'),
    import('../src/lib/app-run-runtime.js'), import('../src/lib/app-attachment-runtime.js'), import('../src/routes/app-attachments.js'),
    import('../src/routes/app-owner-connections.js'), import('../src/lib/app-resource-sync-web-authority.js'),
  ]);
  t.after(async () => { await attachmentRuntime.shutdownAppAttachmentRuntime(); await runRuntime.shutdownAppRunRuntime(); if (continuationBacked) await closeDb(); });
  const org = randomUUID(), owner = randomUUID(), suffix = randomUUID();
  await db.insert(s.orgs).values({ id: org, name: 'Ordinary historical closure', slug: `historical-closure-${suffix}` });
  await db.insert(s.users).values({ id: owner, email: `${suffix}@example.test`, name: 'Synthetic owner', kind: 'human', is_agent: false });
  await db.insert(s.orgMembers).values({ id: randomUUID(), org_id: org, user_id: owner, role: 'owner', is_active: true });
  const session = await web.createWebSession({ id: owner, org_id: org, email: `${suffix}@example.test` });
  const { actor, guard, web_session } = await resourceSyncWebAuthority(`Bearer ${session.accessToken}`);
  const caller = { org_id: org, user_id: owner, sid: web_session.sid, access_expires_at: web_session.expires_at };
  const app = new Hono(); app.route('/api/apps/blob', appAttachmentRoutes); app.route('/api/app-owner-connections', appOwnerConnectionRoutes);
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await app.request('http://localhost' + path, { method, headers: { authorization: `Bearer ${session.accessToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const value = await response.json() as any;
    // Surface the existing runtime custody audit error in this isolated fixture
    // instead of treating the route's intentionally redacted 500 as target RED.
    if (!response.ok && value.code === 'INTERNAL_ERROR') await runRuntime.getAppRunRuntime();
    if (!response.ok && value.code === 'APP_STALE' && path === '/api/apps/blob/sync/unknown-runs/review') {
      // Same owner, request, guard and read-only service, solely to expose the
      // exact failing reconstruction line in this isolated regression.
      const { AppResourceSyncClosureService } = await import('../src/lib/app-resource-sync-closure.js');
      const runtime = await attachmentRuntime.getAppAttachmentRuntime();
      await new AppResourceSyncClosureService(runtime.keys, runtime.repository).review(actor, body, guard);
    }
    assert.ok(response.ok, `${path}: HTTP ${response.status} ${value.code ?? ''} ${value.error ?? ''}`); return value;
  };
  const fixture = JSON.parse((await runtimeSecurityPackage()).json);
  fixture.manifest.id = `community.example.historicalclosure.a${suffix.replaceAll('-', '')}`;
  fixture.manifest.owner_connections = [{ key: 'mailbox', resource_key: 'inbox', action_keys: [], max_consent_seconds: 86400 * 30,
    provider_profile_key: 'synthetic_mail', runtime_requirement_key: 'sync_provider' }];
  const packed = await buildDeftAppPackage({ manifest: fixture.manifest, artifacts: fixture.artifacts });
  const { app: installed } = await call('/api/apps/blob/composition/stage', 'POST', packed.json);
  const installContext = await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);
  const { review: installationReview } = await call(`/api/apps/blob/composition/${installed.id}/review`, 'POST', installContext.review_request);
  await call(`/api/apps/blob/composition/${installed.id}/activate`, 'POST', { ...installContext.review_request,
    expected_review_digest: installationReview.review_digest, accept_host_policy: true });
  const profile = { schema_version: 'deft.app_connection_profile.v1', key: 'synthetic_mail', provider_id: 'synthetic_mail',
    operator_user_id: owner, runtime_requirement_key: 'sync_provider', resource_key: 'inbox', action_keys: [],
    authorization_origin: 'https://provider.example.test', credential_custody: 'runtime', executable: false };
  const directory = await mkdtemp(join(tmpdir(), 'deft-ordinary-historical-closure-')), config = join(directory, 'connections.json');
  process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = config;
  const entries: unknown[] = [];
  const enroll = async (registrationId: string) => { entries.push({ org_id: org, installation_id: installed.id,
    runtime_registration_id: registrationId, runtime_epoch: 1, profile, endpoint: 'https://runtime.example.test/v1/connections',
    ...(continuationBacked ? { connection_protocol: 'v2' } : {}), runtime_auth_token: 'r'.repeat(43), authority_token_sha256: 'sha256:' + 'a'.repeat(64) });
    await writeFile(config, JSON.stringify({ schema_version: 'deft.app_connection_http_registrations.v1', entries }), { mode: 0o600 }); };
  await enroll(randomUUID()); // Profile-only enrollment before the normal administrative review.
  const pin = async () => {
    const [installation] = await db.select().from(s.appInstallations).where(eq(s.appInstallations.id, installed.id));
    const [version] = await db.select().from(s.appVersions).where(eq(s.appVersions.id, installation!.active_version_id!));
    const [grant] = await db.select().from(s.appGrantSnapshots).where(eq(s.appGrantSnapshots.id, installation!.active_grant_snapshot_id!));
    return { expected_app_version_id: version!.id, expected_package_digest: version!.package_digest,
      expected_grant_snapshot_digest: grant!.snapshot_digest, expected_lifecycle_epoch: installation!.lifecycle_epoch,
      expected_grant_epoch: installation!.grant_epoch };
  };
  const resource = async () => {
    const input = { installation_id: installed.id, policy_key: 'mailbox', operator_user_id: owner,
      limits: { max_records_per_page: 25, max_page_bytes: 65536, max_retained_records: 1000, max_retained_bytes: 1048576,
        min_interval_seconds: 300 }, ...await pin() };
    const { review } = await call('/api/app-owner-connections/admissions/review', 'POST', input);
    await call('/api/app-owner-connections/admissions/activate', 'POST', { ...input, expected_review_digest: review.review_digest, accept_host_policy: true });
    const context = await call(`/api/app-owner-connections/${installed.id}/context`), request = {
      ...context.policies[0].admission.resource_request, target_key: 'fresh_mailbox', ...(continuationBacked ? { consent_expires_at: new Date(Date.now() + 3600_000).toISOString() } : {}) };
    const { review: resourceReview } = await call('/api/app-owner-connections/resources/review', 'POST', request);
    const result = await call('/api/app-owner-connections/resources/activate', 'POST', { ...request,
      expected_review_digest: resourceReview.review_digest, accept_host_policy: true });
    await enroll(result.binding.registration_id); return result.binding;
  };
  const old = await resource();
  const [{ AppConnectionSessionService }, { PostgresAppConnectionSessionStore }, { currentAppConnectionSessionAuthority, currentAppConnectionSessionV2Authority },
    { AppResourceObservationService }, { loadLiveAttachmentSyncBindingAuthority }, { buildAttachmentSyncAuthorizationSnapshot },
    { buildResourceSyncAuthorizationSnapshot }] = await Promise.all([
    import('../src/lib/app-connection-session-service.js'), import('../src/lib/app-connection-session-store.js'),
    import('../src/lib/app-connection-session-authority.js'), import('../src/lib/app-resource-observation-service.js'),
    import('../src/lib/app-attachment-sync-authority.js'), import('../src/lib/app-attachment-sync-run.js'), import('../src/lib/app-resource-sync-authorization.js'),
  ]);
  let syntheticConnectionCalls = 0;
  const registeredRuntime = async (scope: { runtime_registration_id: string; operator_user_id: string; runtime_epoch: number }) => ({
    identity: { runtime_registration_id: scope.runtime_registration_id, operator_user_id: scope.operator_user_id, runtime_epoch: scope.runtime_epoch },
    request: async (input: { operation: string }) => {
      syntheticConnectionCalls++;
      return input.operation === 'begin' ? { state: 'awaiting_callback' as const, runtime_session_ref: 'synthetic_runtime_ref',
        authorization_url: 'https://provider.example.test/authorize' } : { state: 'connected' as const, account: { account_ref: 'synthetic_account', label: 'Synthetic mailbox' } };
    },
  });
  const connection = new AppConnectionSessionService({ store: new PostgresAppConnectionSessionStore(db, caller),
    currentAuthority: (active, nomination) => (continuationBacked ? currentAppConnectionSessionV2Authority : currentAppConnectionSessionAuthority)(active, nomination, guard),
    registeredRuntime, registeredRuntimeV2: registeredRuntime });
  const begun = await connection.begin(caller, { installation_id: installed.id, target_key: 'fresh_mailbox' });
  assert.equal(begun.state, 'awaiting_callback');
  const connected = await connection.callback(caller, { session_id: begun.session_id,
    state: (begun as { callback_state: string }).callback_state, outcome: 'authorized', code: 'synthetic_code' });
  assert.equal(connected.state, 'connected');
  let observedSession = connected, syntheticContinuationCalls = 0;
  if (continuationBacked) {
    const [{ AppConnectionConsentContinuationService, continuationDigest }, { appConnectionConsentContinuationReceiptValue },
      { validateContinuationCarrier }] = await Promise.all([
      import('../src/lib/app-connection-consent-continuation-service.js'), import('@deft/app-kit'),
      import('../src/lib/app-connection-consent-continuation-fence.js'),
    ]);
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://runtime.example.test/v1/connections');
      syntheticContinuationCalls++;
      const request = JSON.parse(String(init?.body));
      const base = { schema_version: 'deft.app_connection_consent_continuation_runtime.v1', session_id: request.session_id,
        account: { account_ref: 'synthetic_account', label: 'Synthetic mailbox' }, custody_generation: 1 };
      const result = request.operation === 'prepare'
        ? { ...base, state: 'eligible', custody_digest: 'sha256:' + 'c'.repeat(64) }
        : { ...base, state: 'connected', runtime_session_ref: 'synthetic_continued_ref',
          receipt_digest: continuationDigest(appConnectionConsentContinuationReceiptValue(request, request.review, 'synthetic_continued_ref')) };
      return Response.json(result);
    };
    const continuation = new AppConnectionConsentContinuationService(caller, guard);
    const review = await continuation.review({ request_id: randomUUID(), source_session_id: connected.session_id,
      installation_id: installed.id, target_key: 'fresh_mailbox', consent_expires_at: new Date(Date.now() + 7200_000).toISOString() });
    observedSession = await continuation.activate({ session_id: review.session_id, review_digest: review.review_digest });
    assert.equal(observedSession.state, 'connected'); assert.notEqual(observedSession.session_id, connected.session_id);
    assert.equal(observedSession.scope.resource_binding_id, old.binding_id, 'Normal continuation retains exact binding identity');
    assert.equal(observedSession.scope.consent_expires_at, review.scope.consent_expires_at, 'Observation uses the actual continued consent scope');
    const [carrier] = await db.select().from(s.appConnectionSessions).where(eq(s.appConnectionSessions.session_id, observedSession.session_id));
    const receipt = await db.transaction(tx => validateContinuationCarrier(tx, carrier!.record as any));
    assert.ok(receipt); assert.equal(receipt.custody_generation, 1);
    assert.equal((carrier!.record as any).upgrade, undefined, 'Receipt is retained in the continuation journal, not a guessed direct carrier field');
    globalThis.fetch = originalFetch;
  }
  const observation = new AppResourceObservationService();
  const observationReview = await observation.review(actor, { request_id: randomUUID(), connection_session_id: observedSession.session_id,
    interval_seconds: 300, expires_at: new Date(Date.now() + 3600_000).toISOString() }, guard);
  await observation.activate(actor, { consent_id: observationReview.consent_id, review_digest: observationReview.review_digest }, guard);
  await db.transaction(async tx => { const live = await loadLiveAttachmentSyncBindingAuthority(tx, { org_id: org, resource_binding_id: old.binding_id, clock: () => new Date() });
    assert.ok(live); const minimal = { ...live, installation: { id: live.installation.id,
      lifecycle_epoch: live.installation.lifecycle_epoch, grant_epoch: live.installation.grant_epoch } };
    assert.deepEqual(buildResourceSyncAuthorizationSnapshot(minimal), buildResourceSyncAuthorizationSnapshot(live));
    assert.deepEqual(buildAttachmentSyncAuthorizationSnapshot(minimal), buildAttachmentSyncAuthorizationSnapshot(live)); });
  const runtime = await runRuntime.getAppRunRuntime(), attachment = await attachmentRuntime.getAppAttachmentRuntime();
  const [{ AppRunAttemptRunner }, { AppResourceSyncSecretService }, { AppResourceSyncAdmissionService }, { AppRunSecretService }] = await Promise.all([
    import('../src/lib/app-run-attempt-runner.js'), import('../src/lib/app-resource-sync-secrets.js'),
    import('../src/lib/app-resource-sync-admission.js'), import('../src/lib/app-run-secrets.js'),
  ]);
  const runner = new AppRunAttemptRunner(attachment.repository, runtime.secretRepository, new AppRunSecretService(runtime.keys),
    { async execute() { assert.fail('This ordinary acknowledgement fixture never invokes a provider'); } },
    undefined, () => new Date(), 3000, 1000, undefined, undefined, undefined, null, 'attachment_v3');
  const admission = new AppResourceSyncAdmissionService(attachment.repository, runtime.secretRepository,
    new AppRunSecretService(runtime.keys), new AppResourceSyncSecretService(runtime.keys), runner, () => new Date(), () => true, 'attachment_v3');
  const admitted = await admission.admitDue({ org_id: org, resource_binding_id: old.binding_id }, undefined, undefined, undefined, true);
  assert.equal(admitted.state, 'created'); assert.ok('run_id' in admitted);
  // Construct one already-unknown historical obligation using actual admission
  // and repository transitions. No provider is called, interrupted or replayed.
  const selected = () => db.select().from(s.appRuns).where(and(eq(s.appRuns.org_id, org), eq(s.appRuns.id, admitted.run_id)));
  const [{ AppResourceSyncManagement }, { AppAttachmentSyncChannel }] = await Promise.all([
    import('../src/lib/app-resource-sync-management.js'), import('../src/lib/app-attachment-sync-channel.js')]);
  const management = new AppResourceSyncManagement(runtime.keys, () => new Date(), 'attachment_v3');
  const channelSession = await management.issueOperatorSession(actor, old.binding_id, guard);
  const channel = new AppAttachmentSyncChannel(runner, attachment.database);
  const identity = { schema_version: 'deft.app_runtime_channel.v3', audience: 'app_resource_sync',
    session_id: channelSession.session_id, session_token: channelSession.session_token };
  const claim = await channel.claim({ ...identity, max_claims: 1 }); assert.ok(claim); assert.equal(claim.run_id, admitted.run_id);
  assert.ok(await channel.start({ ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id,
    claim_token: claim.claim_token, sequence: claim.sequence }));
  const [startedAttempt] = await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.id, admitted.attempt_id));
  await new Promise(resolve => setTimeout(resolve, Math.max(0, startedAttempt!.lease_expires_at!.getTime() - Date.now() + 10)));
  await attachment.repository.transaction(async tx => {
    const run = await attachment.repository.lockRun(tx, org, admitted.run_id); assert.ok(run);
    await tx.update(s.appRunAttempts).set({ state: 'unknown_outcome', error_code: 'APP_RUN_UNKNOWN_OUTCOME', updated_at: new Date() })
      .where(eq(s.appRunAttempts.id, admitted.attempt_id));
    await attachment.repository.transition(tx, { run, state: 'unknown_outcome', now: new Date(),
      safe_outcome: { success: false, provider_call_attempted: true, result_status: 'unavailable', error_code: 'APP_RUN_UNKNOWN_OUTCOME' } });
  });
  const [before] = await selected(), [beforeAttempt] = await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.id, admitted.attempt_id));
  const nextPackage = await buildDeftAppPackage({ manifest: { ...fixture.manifest, version: '9.0.1' }, artifacts: fixture.artifacts });
  const upgrade = `/api/apps/blob/composition/${installed.id}/upgrade`, beforePins = await pin();
  const staged = await call(`${upgrade}/stage`, 'POST', { schema_version: 'deft.app_attachment_upgrade_stage.v1',
    package_json: nextPackage.json, expected_lifecycle_epoch: beforePins.expected_lifecycle_epoch });
  const upgradeContext = await call(`${upgrade}/context?app_version_id=${staged.app_version_id}`);
  const { review: upgradeReview } = await call(`${upgrade}/review`, 'POST', upgradeContext.review_request);
  await call(`${upgrade}/activate`, 'POST', { ...upgradeContext.review_request, expected_review_digest: upgradeReview.review_digest, accept_host_policy: true });
  const current = await resource(), root = '/api/apps/blob/sync/unknown-runs';
  const request = { run_id: admitted.run_id, current_resource_binding_id: current.binding_id };
  const [beforeCheckpoint] = await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.id, old.checkpoint_id));
  const { review } = await call(`${root}/review`, 'POST', request);
  assert.equal(review.app_version_id, before!.origin_app_version_id); assert.equal(review.lifecycle_epoch, beforePins.expected_lifecycle_epoch);
  assert.equal(review.historical_closure.current_app_version_id, staged.app_version_id);
  assert.notEqual(review.historical_closure.current_lifecycle_epoch, review.lifecycle_epoch);
  const receiptRequest = { ...request, expected_review_digest: review.review_digest };
  assert.deepEqual(await call(`${root}/receipt`, 'POST', receiptRequest), { status: 'unconfirmed' });
  assert.deepEqual((await selected())[0], before, 'read-only receipt absence cannot close an obligation');
  const { closure } = await call(`${root}/activate`, 'POST', { ...receiptRequest, accept_host_policy: true });
  assert.equal(closure.provider_outcome, 'unknown'); assert.equal(closure.state, 'failed'); assert.equal(closure.no_retry, true);
  assert.equal(closure.receipt.verified, true);
  assert.deepEqual((await call(`${root}/activate`, 'POST', { ...receiptRequest, accept_host_policy: true })).closure, closure);
  assert.deepEqual(await call(`${root}/receipt`, 'POST', receiptRequest), { status: 'closed', closure });
  const [after] = await selected(), [afterAttempt] = await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.id, admitted.attempt_id));
  assert.equal(after!.unknown_outcome_at!.toISOString(), before!.unknown_outcome_at!.toISOString()); assert.deepEqual(afterAttempt, beforeAttempt);
  const [afterCheckpoint] = await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.id, old.checkpoint_id));
  assert.deepEqual(afterCheckpoint, beforeCheckpoint, 'closure cannot advance or alter the original cursor');
  assert.equal(syntheticConnectionCalls, 2, 'closure does not call even the synthetic connection Runtime');
  assert.equal(syntheticContinuationCalls, continuationBacked ? 2 : 0, 'Only the ordinary setup review/activate contacts the synthetic continuation transport');
  const receipts = await db.select().from(s.appRunReceipts).where(and(eq(s.appRunReceipts.org_id, org), eq(s.appRunReceipts.run_id, admitted.run_id)));
  assert.equal(receipts.filter(row => row.receipt_kind === 'reconciliation').length, 1);
});
