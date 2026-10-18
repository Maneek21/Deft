import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildDeftAppPackage } from '@deft/app-kit';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';

test('reviewed private Sync closure preserves unknown provider evidence and never closes Send', { timeout: 240_000 }, async t => {
  assert.ok(securityTestDatabaseIsSafe(), 'Use a guarded disposable database with matching test and application URLs');
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
    DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true',
    DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`sync-closure:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: ring('closure-enc'), receipt_signing: ring('closure-sign'), fingerprint: ring('closure-fp') });
  const [{ db, closeDb }, s, { and, eq }, web, runtimeModule, attachmentModule, { Hono }, { serve },
    blobRoutes, syncRoutes, experienceRoutes, channelRoutes, humanRoutes, humanService, exposure,
    { AppRunSecretService }, { PostgresAppRunReceiptWriter }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('../src/lib/web-sessions.js'),
    import('../src/lib/app-run-runtime.js'), import('../src/lib/app-attachment-runtime.js'), import('hono'),
    import('@hono/node-server'), import('../src/routes/app-attachments.js'), import('../src/routes/app-attachment-sync-channel.js'),
    import('../src/routes/app-experiences.js'), import('../src/routes/app-runtime-channel.js'),
    import('../src/lib/app-experience-human-action-routes.js'), import('../src/lib/app-experience-human-action-service.js'),
    import('../src/lib/app-experience-exposure.js'), import('../src/lib/app-run-secrets.js'), import('../src/lib/app-run-receipts.js'),
  ]);
  const app = new Hono();
  app.route('/api/apps/blob', blobRoutes.appAttachmentRoutes);
  app.route('/api/app-resource-sync-channel/v3', syncRoutes.appAttachmentSyncChannelRoutes);
  app.route('/api/app-runtime/channel', channelRoutes.appRuntimeChannelRoutes);
  app.route('/api/app-experiences', experienceRoutes.appExperienceRoutes);
  app.route('/api/app-experiences', humanRoutes.createExperienceHumanActionRoutes(async () => {
    const runtime = await runtimeModule.getAppRunRuntime();
    return new humanService.AppExperienceHumanActionService(new exposure.AppExperienceExposureService(runtime.keys), runtime);
  }));
  let server!: ReturnType<typeof serve>;
  const base = await new Promise<string>(resolve => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
    address => resolve(`http://127.0.0.1:${address.port}`)); });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve()));
    await attachmentModule.shutdownAppAttachmentRuntime(); await runtimeModule.shutdownAppRunRuntime(); await closeDb(); });
  const org = randomUUID(), foreignOrg = randomUUID(), suffix = randomUUID();
  await db.insert(s.orgs).values([{ id: org, name: 'Sync closure fixture', slug: `closure-${suffix}` },
    { id: foreignOrg, name: 'Foreign closure fixture', slug: `closure-foreign-${suffix}` }]);
  const people = { owner: { id: randomUUID(), role: 'owner' as const, org }, operator: { id: randomUUID(), role: 'admin' as const, org },
    other: { id: randomUUID(), role: 'admin' as const, org }, foreign: { id: randomUUID(), role: 'owner' as const, org: foreignOrg } };
  const sessions = {} as Record<keyof typeof people, Awaited<ReturnType<typeof web.createWebSession>>>;
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    const person = people[key], email = `closure-${key}-${suffix}@example.test`;
    await db.insert(s.users).values({ id: person.id, name: `Closure ${key}`, email, kind: 'human', is_agent: false });
    await db.insert(s.orgMembers).values({ id: randomUUID(), org_id: person.org, user_id: person.id, role: person.role, is_active: true });
    sessions[key] = await web.createWebSession({ id: person.id, org_id: person.org, email });
  }
  const request = async (path: string, method = 'GET', body?: unknown, token = sessions.owner.accessToken, scheme = 'Bearer') => {
    const response = await fetch(base + path, { method, headers: { authorization: `${scheme} ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const value = await response.json() as any;
    return { status: response.status, ok: response.ok, body: value, cache: response.headers.get('cache-control') };
  };
  const call = async (path: string, method = 'GET', body?: unknown, token = sessions.owner.accessToken, scheme = 'Bearer') => {
    const result = await request(path, method, body, token, scheme);
    assert.ok(result.ok, `${path}: HTTP ${result.status} ${JSON.stringify(result.body)}`); return result.body;
  };
  const deny = async (path: string, body: unknown, token = sessions.owner.accessToken, scheme = 'Bearer') => {
    const result = await request(path, 'POST', body, token, scheme);
    assert.ok([400, 401, 403, 404, 409, 503].includes(result.status), `${path}: expected denial, received ${result.status}`);
    assert.equal(typeof result.body.code, 'string');
    assert.equal(JSON.stringify(result.body).includes('PRIVATE-SYNC-CLOSURE-CANARY'), false);
    return result;
  };
  const fixture = JSON.parse((await runtimeSecurityPackage()).json);
  fixture.manifest.id = `community.example.syncclosure.a${suffix.replaceAll('-', '')}`;
  const packageJson = async () => (await buildDeftAppPackage({ manifest: fixture.manifest, artifacts: fixture.artifacts })).json;
  const { app: installed } = await call('/api/apps/blob/composition/stage', 'POST', await packageJson());
  const context = await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);
  const { review: installReview } = await call(`/api/apps/blob/composition/${installed.id}/review`, 'POST', context.review_request);
  await call(`/api/apps/blob/composition/${installed.id}/activate`, 'POST', { ...context.review_request,
    expected_review_digest: installReview.review_digest, accept_host_policy: true });
  const consent = async () => {
    const { setup } = await call(`/api/apps/blob/sync/setup?installation_id=${installed.id}&operator_user_id=${people.operator.id}`);
    const supplied = setup.descriptors.find((descriptor: any) => descriptor.resource_key === 'inbox').consent_request;
    const input = { ...supplied, target_key: 'primary', limits: { ...supplied.limits, min_interval_seconds: 60 } };
    const { review } = await call('/api/apps/blob/sync/reviews/prepare', 'POST', input);
    return (await call('/api/apps/blob/sync/bindings/activate', 'POST', { ...input,
      expected_review_digest: review.review_digest, accept_host_policy: true })).binding;
  };
  let resource = await consent();
  const runtime = await runtimeModule.getAppRunRuntime(), attachment = await attachmentModule.getAppAttachmentRuntime();
  const receipts = new PostgresAppRunReceiptWriter(new AppRunSecretService(runtime.keys), runtime.secretRepository);
  const [{ AppRunAttemptRunner }, { AppAttachmentSyncChannel }, { AppRuntimeChannel },
    { AppResourceSyncSecretService }, { AppResourceSyncStore }, { AppAttachmentPageLinker }] = await Promise.all([
    import('../src/lib/app-run-attempt-runner.js'), import('../src/lib/app-attachment-sync-channel.js'),
    import('../src/lib/app-runtime-channel.js'), import('../src/lib/app-resource-sync-secrets.js'),
    import('../src/lib/app-resource-sync-store.js'), import('../src/lib/app-attachment-page-linker.js'),
  ]);
  const shortRunner = new AppRunAttemptRunner(attachment.repository, runtime.secretRepository,
    new AppRunSecretService(runtime.keys), { async execute() { assert.fail('Closure fixture cannot execute a provider'); } },
    undefined, () => new Date(), 3_000, 1_000, receipts, undefined, undefined,
    new AppResourceSyncStore(new AppResourceSyncSecretService(runtime.keys), runtime.secretRepository,
      { linker: new AppAttachmentPageLinker(runtime.keys) }), 'attachment_v3');
  const shortSyncChannel = new AppAttachmentSyncChannel(shortRunner, attachment.database);
  const shortRuntimeChannel = new AppRuntimeChannel(shortRunner);
  const [{ AppResourceSyncAdmissionService }, { resourceSyncWebAuthority }] = await Promise.all([
    import('../src/lib/app-resource-sync-admission.js'), import('../src/lib/app-resource-sync-web-authority.js'),
  ]);
  // Advancing this host-only fixture clock exercises actual admission/CAS while
  // retaining the production sixty-second polling floor and immutable DB guards.
  let admissionClock = Date.now();
  const admission = new AppResourceSyncAdmissionService(attachment.repository, runtime.secretRepository,
    new AppRunSecretService(runtime.keys), new AppResourceSyncSecretService(runtime.keys), shortRunner,
    () => new Date(admissionClock), () => true, 'attachment_v3');
  const selectedRun = (runId: string) => db.select().from(s.appRuns).where(and(eq(s.appRuns.org_id, org), eq(s.appRuns.id, runId)));
  const selectedAttempts = (runId: string) => db.select().from(s.appRunAttempts).where(and(eq(s.appRunAttempts.org_id, org), eq(s.appRunAttempts.run_id, runId)));
  const syncAttempt = async (previousRunId?: string) => {
    admissionClock += 61_000;
    const { guard } = await resourceSyncWebAuthority('Bearer ' + sessions.owner.accessToken);
    const caller = { owner_user_id: people.owner.id, guard };
    const admitted = previousRunId
      ? await admission.resumeObservation({ org_id: org, resource_binding_id: resource.binding_id, previous_run_id: previousRunId }, caller)
      : await admission.admitDue({ org_id: org, resource_binding_id: resource.binding_id }, undefined, caller);
    assert.equal(admitted.state, 'created');
    assert.ok('run_id' in admitted);
    const { session } = await call(`/api/apps/blob/sync/bindings/${resource.binding_id}/sessions`, 'POST', {}, sessions.operator.accessToken);
    const identity = { schema_version: 'deft.app_runtime_channel.v3', audience: 'app_resource_sync', session_id: session.session_id };
    const invoke = async (path: string, body: unknown) => {
      const input = { ...(body as Record<string, unknown>), session_token: session.session_token };
      if (path === '/claim') return { claim: await shortSyncChannel.claim(input) };
      if (path === '/start') return { started: await shortSyncChannel.start(input) };
      assert.equal(path, '/result'); return { accepted: Boolean(await shortSyncChannel.complete(input)) };
    };
    const { claim } = await invoke('/claim', { ...identity, max_claims: 1 });
    assert.equal(claim.run_id, admitted.run_id);
    const attempt = { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence };
    assert.ok((await invoke('/start', attempt)).started);
    return { runId: claim.run_id as string, attemptId: claim.attempt_id as string, attempt, invoke };
  };
  const expire = async (runId: string, attemptId: string) => {
    // The production runner uses a bounded short lease in this fixture. Let it
    // actually expire; never bypass the immutable attempt guard or alter evidence.
    const [attempt] = await selectedAttempts(runId);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, attempt!.lease_expires_at!.getTime() - Date.now() + 10)));
    assert.equal(await shortRunner.recoverRun(org, runId, attemptId), 1);
    assert.equal((await selectedRun(runId))[0]!.state, 'unknown_outcome');
  };
  const first = await syncAttempt();
  await expire(first.runId, first.attemptId);
  const initialRun = (await selectedRun(first.runId))[0]!, initialAttempt = (await selectedAttempts(first.runId))[0]!;
  const closureRoot = '/api/apps/blob/sync/unknown-runs';
  const review = (runId: string, token = sessions.owner.accessToken) => call(closureRoot + '/review', 'POST', { run_id: runId }, token);
  const activation = (runId: string, digest: string) => ({ run_id: runId, expected_review_digest: digest, accept_host_policy: true });
  let originalReview: any;
  await t.test('current real web identity, tenant, participant and strict request boundaries deny forgery', async () => {
    for (const token of [sessions.foreign.accessToken, sessions.other.accessToken, sessions.owner.refreshToken]) {
      await deny(closureRoot + '/review', { run_id: first.runId }, token);
    }
    await deny(closureRoot + '/review', { run_id: first.runId }, 'synthetic-runtime-credential', 'AppRuntime');
    for (const extra of [{ state: 'succeeded' }, { provider_outcome: 'failed' }, { owner_user_id: people.other.id }, { no_retry: false }]) {
      await deny(closureRoot + '/review', { run_id: first.runId, ...extra });
    }
    originalReview = (await review(first.runId)).review;
    await deny(closureRoot + '/activate', activation(first.runId, 'sha256:' + '0'.repeat(64)));
    await deny(closureRoot + '/activate', activation(first.runId, originalReview.review_digest), sessions.other.accessToken);
    await deny(closureRoot + '/activate', { ...activation(first.runId, originalReview.review_digest), accept_host_policy: false });
    await db.update(s.orgMembers).set({ role: 'guest' }).where(and(eq(s.orgMembers.org_id, org), eq(s.orgMembers.user_id, people.owner.id)));
    try { await deny(closureRoot + '/activate', activation(first.runId, originalReview.review_digest)); }
    finally { await db.update(s.orgMembers).set({ role: 'owner' }).where(and(eq(s.orgMembers.org_id, org), eq(s.orgMembers.user_id, people.owner.id))); }
    const ephemeral = await web.createWebSession({ id: people.owner.id, org_id: org, email: `closure-owner-${suffix}@example.test` });
    const ephemeralReview = (await review(first.runId, ephemeral.accessToken)).review;
    await web.revokeWebSession(ephemeral.refreshToken);
    await deny(closureRoot + '/activate', activation(first.runId, ephemeralReview.review_digest), ephemeral.accessToken);
    assert.equal((await selectedRun(first.runId))[0]!.state, 'unknown_outcome');
  });
  await t.test('advanced checkpoint invalidates an old review without claiming the old Sync had no effect', async () => {
    const observed = await syncAttempt(first.runId);
    const accepted = await observed.invoke('/result', { ...observed.attempt, status: 'returned', provider_succeeded: true,
      page: { schema_version: 'deft.app_sync_page.v2', upserts: [], tombstones: [], next_cursor: null, has_more: false } });
    assert.equal(accepted.accepted, true);
    const [checkpoint] = await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.id, resource.checkpoint_id));
    assert.equal(checkpoint!.cursor_sequence, 1);
    assert.equal(checkpoint!.last_applied_run_id, observed.runId);
    await deny(closureRoot + '/activate', activation(first.runId, originalReview.review_digest));
    assert.equal((await selectedRun(first.runId))[0]!.state, 'unknown_outcome');
  });
  let firstClosure: any;
  await t.test('local failed closure retains the unknown attempt and timestamp, signs exactly one receipt and replays safely', async () => {
    const prepared = (await review(first.runId)).review;
    firstClosure = activation(first.runId, prepared.review_digest);
    const [beforeCheckpoint] = await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.id, resource.checkpoint_id));
    const closed = await call(closureRoot + '/activate', 'POST', firstClosure);
    assert.equal(closed.closure.run_id, first.runId); assert.equal(closed.closure.state, 'failed');
    assert.equal(closed.closure.basis, 'operator_closes_unknown_sync'); assert.equal(closed.closure.provider_outcome, 'unknown');
    assert.equal(closed.closure.no_retry, true);
    const [run] = await selectedRun(first.runId), [attempt] = await selectedAttempts(first.runId);
    assert.equal(run!.state, 'failed'); assert.equal(run!.safe_outcome!.error_code, 'APP_RUN_UNKNOWN_OUTCOME');
    assert.equal(run!.safe_outcome!.provider_call_attempted, true); assert.equal(run!.safe_outcome!.result_status, 'unavailable');
    assert.equal(run!.unknown_outcome_at!.getTime(), initialRun.unknown_outcome_at!.getTime());
    assert.ok(run!.reconciled_at); assert.deepEqual(attempt, initialAttempt);
    const [afterCheckpoint] = await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.id, resource.checkpoint_id));
    assert.deepEqual(afterCheckpoint, beforeCheckpoint, 'closure cannot change the mirror or cursor');
    assert.deepEqual((await call(closureRoot + '/activate', 'POST', firstClosure)).closure, closed.closure);
    const retained = await db.select().from(s.appRunReceipts).where(and(eq(s.appRunReceipts.org_id, org), eq(s.appRunReceipts.run_id, first.runId)));
    assert.equal(retained.filter(row => row.receipt_kind === 'attempt_terminal').length, 1);
    const reconciled = retained.filter(row => row.receipt_kind === 'reconciliation');
    assert.equal(reconciled.length, 1);
    const facts = reconciled[0]!.envelope.facts as Record<string, unknown>;
    assert.equal(facts.provider_outcome, 'unknown'); assert.equal(facts.no_retry, true);
    for (const receipt of retained) assert.equal(await receipts.verifyStored(org, first.runId, receipt.receipt_key), true);
    assert.equal((await selectedAttempts(first.runId)).length, 1, 'no retry attempt is created');
    // Commit another real page. A lost closure acknowledgement must still recover
    // its original receipt after the independently authorized checkpoint advances.
    const later = await syncAttempt();
    assert.equal((await later.invoke('/result', { ...later.attempt, status: 'returned', provider_succeeded: true,
      page: { schema_version: 'deft.app_sync_page.v2', upserts: [], tombstones: [], next_cursor: null, has_more: false } })).accepted, true);
    const [advanced] = await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.id, resource.checkpoint_id));
    assert.equal(advanced!.cursor_sequence, 2);
    assert.deepEqual((await call(closureRoot + '/activate', 'POST', firstClosure)).closure, closed.closure);
    assert.deepEqual((await selectedAttempts(first.runId))[0], initialAttempt);
    const replayReceipts = await db.select().from(s.appRunReceipts).where(and(eq(s.appRunReceipts.org_id, org), eq(s.appRunReceipts.run_id, first.runId)));
    assert.equal(replayReceipts.filter(row => row.receipt_kind === 'reconciliation').length, 1);
  });
  await t.test('reviewed upgrade drains the locally closed Sync and old closure pins cannot survive the current version change', async () => {
    fixture.manifest.version = '1.0.1';
    const [currentInstallation] = await db.select().from(s.appInstallations).where(eq(s.appInstallations.id, installed.id));
    const staged = await call(`/api/apps/blob/composition/${installed.id}/upgrade/stage`, 'POST', {
      schema_version: 'deft.app_attachment_upgrade_stage.v1', package_json: await packageJson(),
      expected_lifecycle_epoch: currentInstallation!.lifecycle_epoch });
    const target = staged.app_version_id;
    assert.equal(typeof target, 'string');
    const upgradeContext = await call(`/api/apps/blob/composition/${installed.id}/upgrade/context?app_version_id=${target}`);
    const { review: upgradeReview } = await call(`/api/apps/blob/composition/${installed.id}/upgrade/review`, 'POST', upgradeContext.review_request);
    await call(`/api/apps/blob/composition/${installed.id}/upgrade/activate`, 'POST', { ...upgradeContext.review_request,
      expected_review_digest: upgradeReview.review_digest, accept_host_policy: true });
    await deny(closureRoot + '/activate', firstClosure);
    await deny(closureRoot + '/review', { run_id: first.runId });
    installed.version_id = target;
    resource = await consent();
  });
  await t.test('an actual unknown Send remains excluded while the exact reviewed operator can close its own Sync', async () => {
    const currentSync = await syncAttempt(); await expire(currentSync.runId, currentSync.attemptId);
    const { actions } = await call(`/api/apps/blob/composition/${installed.id}/runtime/context?app_version_id=${installed.version_id}`);
    const actionInput = { ...actions.find((action: any) => action.key === 'send_message').review_request,
      owner_resource_binding_id: resource.binding_id, operator_user_id: people.operator.id };
    const { review: actionReview } = await call('/api/apps/blob/composition/runtime/reviews/prepare', 'POST', actionInput);
    const { binding: action } = await call('/api/apps/blob/composition/runtime/bindings/activate', 'POST', { ...actionInput,
      expected_review_digest: actionReview.review_digest, accept_host_policy: true });
    const opened = await call(`/api/app-experiences/${installed.id}/main/sessions`, 'POST', {});
    const experience = '/api/app-experiences/sessions/' + opened.pin.session_id;
    const access = await call(experience + '/access/review', 'POST', {});
    await call(experience + '/access/accept', 'POST', { review_token: access.review_token, review_digest: access.review_digest, accept_exposure: true });
    const prepared = await call(experience + '/human-actions/send_message/prepare', 'POST', {
      input: { to: 'recipient@example.test', subject: 'Private closure fixture', body: 'PRIVATE-SYNC-CLOSURE-CANARY', message_id: '<closure@example.test>' },
      idempotency_key: randomUUID() });
    const queued = await call(experience + '/human-actions/confirm', 'POST', { ticket: prepared.ticket, expected_input_digest: prepared.input_digest });
    const { session } = await call(`/api/apps/blob/composition/runtime/bindings/${action.binding_id}/sessions`, 'POST', {}, sessions.operator.accessToken);
    const identity = { schema_version: 'deft.app_runtime_channel.v1', session_id: session.session_id };
    const claim = await shortRuntimeChannel.claim({ ...identity, max_claims: 1, session_token: session.session_token });
    assert.ok(claim);
    assert.equal(claim.run_id, queued.run.id);
    const start = { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence };
    assert.ok(await shortRuntimeChannel.start({ ...start, session_token: session.session_token }));
    await expire(claim.run_id, claim.attempt_id);
    await deny(closureRoot + '/review', { run_id: claim.run_id });
    await deny(closureRoot + '/activate', activation(claim.run_id, 'sha256:' + '0'.repeat(64)));
    assert.equal((await selectedRun(claim.run_id))[0]!.operation_name, 'send_message');
    assert.equal((await selectedRun(claim.run_id))[0]!.state, 'unknown_outcome');
    const preparedSync = (await review(currentSync.runId, sessions.operator.accessToken)).review;
    const closed = await call(closureRoot + '/activate', 'POST', activation(currentSync.runId, preparedSync.review_digest), sessions.operator.accessToken);
    assert.equal(closed.closure.state, 'failed'); assert.equal(closed.closure.provider_outcome, 'unknown');
    assert.equal((await selectedRun(claim.run_id))[0]!.state, 'unknown_outcome');
    assert.equal((await selectedAttempts(claim.run_id)).length, 1);
  });
  await t.test('revoked registration rejects a retained review and leaves its unknown Run and receipts intact', async () => {
    const prior = await db.select({ id: s.appRuns.id }).from(s.appRuns).where(and(eq(s.appRuns.org_id, org),
      eq(s.appRuns.origin_resource_binding_id, resource.binding_id), eq(s.appRuns.state, 'failed')));
    assert.equal(prior.length, 1);
    const unknown = await syncAttempt(prior[0]!.id); await expire(unknown.runId, unknown.attemptId);
    const prepared = (await review(unknown.runId)).review;
    const [before] = await selectedRun(unknown.runId);
    await attachment.management.revokeRegistration(
      { kind: 'human', actor_id: people.owner.id, org_id: org, role: 'owner', source: 'rest' }, resource.registration_id);
    await deny(closureRoot + '/activate', activation(unknown.runId, prepared.review_digest));
    await deny(closureRoot + '/review', { run_id: unknown.runId }, sessions.operator.accessToken);
    assert.deepEqual((await selectedRun(unknown.runId))[0], before);
    const retained = await db.select().from(s.appRunReceipts).where(and(eq(s.appRunReceipts.org_id, org), eq(s.appRunReceipts.run_id, unknown.runId)));
    assert.equal(retained.length, 1); assert.equal(retained[0]!.receipt_kind, 'attempt_terminal');
  });
});
