import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';
const safe=securityTestDatabaseIsSafe();
const target=process.env.DEFT_TEST_DATABASE_URL;

test('reviewed v7 upgrade drains old work, preserves data and atomically recovers activation', { skip: !safe, timeout: 90000 }, async t => {
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
    DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`private-state-test:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1', run_encryption: ring('private-enc'), receipt_signing: ring('private-sign'), fingerprint: ring('private-fp') });
  const [{ app }, { db, closeDb }, s, orm, kit, web, modules, upgrade, { resourceSyncWebAuthority }] = await Promise.all([
    import('../src/index.js'), import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('@deft/app-kit'),
    import('../src/lib/web-sessions.js'), import('../src/lib/module-service.js'), import('../src/lib/app-runtime-upgrade.js'), import('../src/lib/app-resource-sync-web-authority.js'),
  ]);
  t.after(async () => { await (await import('../src/lib/app-attachment-runtime.js')).shutdownAppAttachmentRuntime();
    await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime(); await closeDb(); });
  const org = randomUUID(), owner = randomUUID(), peer = randomUUID(), suffix = randomUUID().replaceAll('-', '');
  await db.insert(s.orgs).values({ id: org, name: 'V7 upgrade fixture', slug: `v7-upgrade-${suffix}` });
  await db.insert(s.users).values([{ id: owner, name: 'Owner', email: `upgrade-owner-${suffix}@example.test` }, { id: peer, name: 'Peer', email: `upgrade-peer-${suffix}@example.test` }]);
  await db.insert(s.orgMembers).values([{ org_id: org, user_id: owner, role: 'owner', is_active: true }, { org_id: org, user_id: peer, role: 'member', is_active: true }]);
  const session = await web.createWebSession({ id: owner, org_id: org, email: `upgrade-owner-${suffix}@example.test` });
  const peerSession = await web.createWebSession({ id: peer, org_id: org, email: `upgrade-peer-${suffix}@example.test` });
  const request = async (path: string, method = 'GET', body?: unknown, token = session.accessToken) => {
    const response = await app.request('http://localhost' + path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (path: string, method = 'GET', body?: unknown, token = session.accessToken) => {
    const result = await request(path, method, body, token); assert.ok(result.status < 300, `${path}: ${JSON.stringify(result)}`); return result.body;
  };
  const source = JSON.parse((await runtimeSecurityPackage()).json);
  const moduleManifest = { schema_version: '1', id: `community.example.items.a${suffix}`, slug: `items-${suffix}`, version: '1.0.0', name: 'Items',
    collections: [{ key: 'items', name: 'Items', singular_name: 'Item', fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
      views: [{ key: 'all', name: 'All', type: 'table', fields: ['title'] }], search: { title_field: 'title', subtitle_fields: [], fields: ['title'] } }],
    navigation: { default_collection: 'items', default_view: 'all' } };
  const moduleArtifact = await kit.prepareModuleArtifact({ path: 'modules/items/deft.module.json', manifest: moduleManifest });
  const manifest = { ...source.manifest, id: `community.example.upgrade.a${suffix}`, version: '1.0.0', modules: [{ module_id: moduleManifest.id,
    version: moduleManifest.version, manifest_path: moduleArtifact.path, manifest_digest: moduleArtifact.digest }] };
  const firstPackage = await kit.buildDeftAppPackage({ manifest, artifacts: [...source.artifacts, moduleArtifact] });
  const { app: installed } = await call('/api/apps/blob/composition/stage', 'POST', firstPackage.json);
  const initial = await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);
  const { review: initialReview } = await call(`/api/apps/blob/composition/${installed.id}/review`, 'POST', initial.review_request);
  await call(`/api/apps/blob/composition/${installed.id}/activate`, 'POST', { ...initial.review_request, expected_review_digest: initialReview.review_digest, accept_host_policy: true });
  const actor = modules.humanModuleActor({ orgId: org, userId: owner, role: 'owner', source: 'rest' });
  const { guard } = await resourceSyncWebAuthority(`Bearer ${session.accessToken}`);
  const record = await modules.createModuleRecord(actor, { module_id: moduleManifest.id, collection_key: 'items', data: { title: 'Retained private fixture' },
    expected_manifest_digest: moduleArtifact.digest, idempotency_key: `upgrade-record-${suffix}` });
  assert.ok(record.record);
  const [oldBinding] = await db.select().from(s.appModuleBindings).where(orm.eq(s.appModuleBindings.app_version_id, installed.version_id));
  const receiptBefore = await db.select().from(s.moduleMutationReceipts).where(orm.eq(s.moduleMutationReceipts.org_id, org)); assert.ok(receiptBefore.length);
  const oldSession = await call(`/api/app-experiences/${installed.id}/main/sessions`, 'POST', {});
  const moduleNext = { ...moduleManifest, version: '1.1.0', collections: moduleManifest.collections.map(collection => ({ ...collection, fields: [...collection.fields,
    { key: 'note', label: 'Note', type: 'text', required: false }] })) };
  const nextArtifact = await kit.prepareModuleArtifact({ path: moduleArtifact.path, manifest: moduleNext });
  const nextPackage = await kit.buildDeftAppPackage({ manifest: { ...manifest, version: '1.1.0', modules: [{ ...manifest.modules[0], version: moduleNext.version, manifest_digest: nextArtifact.digest }] },
    artifacts: [...source.artifacts, nextArtifact] });
  const [priorInstallation] = await db.select().from(s.appInstallations).where(orm.eq(s.appInstallations.id, installed.id));
  const prefix = `/api/apps/blob/composition/${installed.id}/upgrade`;
  const staged = await call(prefix + '/stage', 'POST', { schema_version: 'deft.app_attachment_upgrade_stage.v1', package_json: nextPackage.json, expected_lifecycle_epoch: priorInstallation.lifecycle_epoch });
  const targetId = staged.app_version_id;
  const prepared = async () => {
    const context = await call(prefix + `/context?app_version_id=${targetId}`);
    const { review } = await call(prefix + '/review', 'POST', context.review_request);
    return { context, review, input: { ...context.review_request, expected_review_digest: review.review_digest, accept_host_policy: true } };
  };
  const firstReview = await prepared();
  assert.equal(firstReview.review.target_authority.schema, 'deft.app_blob_grant.v2');
  assert.equal((await request(prefix + '/review', 'POST', { ...firstReview.context.review_request, expected_prior_grant_snapshot_digest: `sha256:${'f'.repeat(64)}` })).status, 409);
  assert.equal((await request(prefix + '/review', 'POST', { ...firstReview.context.review_request, expected_package_digest: `sha256:${'e'.repeat(64)}` })).status, 409);
  assert.equal((await request(prefix + '/review', 'POST', firstReview.context.review_request, peerSession.accessToken)).status, 403);
  assert.equal((await request(prefix + '/stage', 'POST', { schema_version: 'deft.app_native_upgrade_stage.v1', package_json: nextPackage.json, expected_lifecycle_epoch: priorInstallation.lifecycle_epoch })).status, 400);
  const { setup } = await call(`/api/apps/blob/sync/setup?installation_id=${installed.id}&operator_user_id=${owner}`);
  const consent = setup.descriptors[0].consent_request;
  const { review: consentReview } = await call('/api/apps/blob/sync/reviews/prepare', 'POST', consent);
  const { binding: sync } = await call('/api/apps/blob/sync/bindings/activate', 'POST', { ...consent, expected_review_digest: consentReview.review_digest, accept_host_policy: true });
  const admitted = await call(`/api/apps/blob/sync/bindings/${sync.binding_id}/sync`, 'POST', {}); assert.equal(admitted.state, 'created');
  // Legal synthetic Run states prove blockers, without claiming provider effects.
  for (const state of ['pending', 'running', 'waiting_external', 'unknown_outcome'] as const) {
    if (state !== 'pending') await db.update(s.appRuns).set({ state }).where(orm.eq(s.appRuns.id, admitted.run_id));
    const blocked = await prepared(); assert.equal(blocked.review.blockers.old_work[state], 1);
    assert.equal((await request(prefix + '/activate', 'POST', blocked.input)).body.code, 'APP_UPGRADE_BLOCKED');
  }
  await db.update(s.appRuns).set({ state: 'failed', terminal_at: new Date() }).where(orm.eq(s.appRuns.id, admitted.run_id));
  const runtimeSetup = await call(`/api/apps/blob/composition/${installed.id}/runtime/context?app_version_id=${installed.version_id}`);
  const runtimeRequest = runtimeSetup.actions.find((action: any) => action.key === 'send_message').review_request;
  const { review: runtimeReview } = await call('/api/apps/blob/composition/runtime/reviews/prepare', 'POST', runtimeRequest);
  await call('/api/apps/blob/composition/runtime/bindings/activate', 'POST', { ...runtimeRequest, expected_review_digest: runtimeReview.review_digest, accept_host_policy: true });
  const { run: pendingApproval } = await call(`/api/app-experiences/sessions/${oldSession.pin.session_id}/actions/send_message`, 'POST', {
    request_id: 'request_1', input: { to: 'recipient@example.test', subject: 'Upgrade pending probe', body: 'Unsent private body', message_id: '<upgrade-probe@example.test>' },
  });
  const pendingReview = await prepared(); assert.equal(pendingReview.review.blockers.old_work.pending_approval, 1);
  assert.equal((await request(prefix + '/activate', 'POST', pendingReview.input)).body.code, 'APP_UPGRADE_BLOCKED');
  const runtime = await (await import('../src/lib/app-run-runtime.js')).getAppRunRuntime();
  const cancelled = await runtime.service.cancel(org, pendingApproval.id, { actor_type: 'human', user_id: owner });
  // Signed synthetic receipt tests byte preservation, without a provider effect.
  const { PostgresAppRunReceiptWriter } = await import('../src/lib/app-run-receipts.js');
  const { AppRunSecretService } = await import('../src/lib/app-run-secrets.js');
  const writer = new PostgresAppRunReceiptWriter(new AppRunSecretService(runtime.keys), runtime.secretRepository);
  await runtime.repository.transaction(tx => writer.write(tx, { receipt_key: 'synthetic-upgrade-preservation', receipt_kind: 'repair',
    run: cancelled, actor: { actor_type: 'human', user_id: owner }, facts: {}, occurred_at: new Date() }));
  const runReceipts = await db.select().from(s.appRunReceipts).where(orm.eq(s.appRunReceipts.org_id, org)); assert.ok(runReceipts.length);
  const drained = await prepared(); assert.deepEqual(drained.review.blockers.old_work, {});
  const oldRun = await db.select().from(s.appRuns).where(orm.eq(s.appRuns.id, admitted.run_id));
  const oldGrants = await db.select().from(s.appGrantSnapshots).where(orm.eq(s.appGrantSnapshots.app_installation_id, installed.id));
  const pg = (await import('pg')).default;
  const sid = JSON.parse(Buffer.from(session.accessToken.split('.')[1]!, 'base64url').toString()).sid;
  for (const mutation of ['human kind', 'action gate']) {
    const blocker = new pg.Client({ connectionString: target }); await blocker.connect();
    try {
      await blocker.query('BEGIN'); const { rows: [backend] } = await blocker.query('SELECT pg_backend_pid() AS id');
      await blocker.query('SELECT id FROM web_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE', [org, sid]);
      const activation = request(prefix + '/activate', 'POST', drained.input);
      let observed = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await blocker.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [backend.id]);
        if (result.rows[0].waiting) { observed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(observed, 'activation must reach its final Web SID fence');
      if (mutation === 'human kind') await blocker.query("UPDATE users SET kind='agent' WHERE id=$1", [owner]);
      else process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED = 'false';
      await blocker.query('COMMIT'); assert.ok((await activation).status >= 400);
      const [current] = await db.select().from(s.appInstallations).where(orm.eq(s.appInstallations.id, installed.id)); assert.deepEqual(current, priorInstallation);
      assert.deepEqual(await db.select().from(s.appGrantSnapshots).where(orm.eq(s.appGrantSnapshots.app_installation_id, installed.id)), oldGrants);
    } finally {
      await blocker.query('ROLLBACK'); await blocker.end(); process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED = 'true';
      await db.update(s.users).set({ kind: 'human' }).where(orm.eq(s.users.id, owner));
    }
  }
  for (const hook of ['failAfterModulePreparation', 'failBeforePointerSwap'] as const) {
    await assert.rejects(upgrade.activateAttachmentUpgrade(actor, installed.id, drained.input, { guard, testHooks: { [hook]: true } }), /Injected/);
    const [current] = await db.select().from(s.appInstallations).where(orm.eq(s.appInstallations.id, installed.id)); assert.deepEqual(current, priorInstallation);
    assert.deepEqual(await db.select().from(s.appGrantSnapshots).where(orm.eq(s.appGrantSnapshots.app_installation_id, installed.id)), oldGrants);
    assert.equal((await db.select().from(s.appModuleBindings).where(orm.eq(s.appModuleBindings.app_version_id, targetId))).length, 0);
  }
  const activated = await call(prefix + '/activate', 'POST', drained.input); assert.equal(activated.installation.id, installed.id);
  const [newBinding] = await db.select().from(s.appModuleBindings).where(orm.eq(s.appModuleBindings.app_version_id, targetId));
  assert.equal(newBinding.module_installation_id, oldBinding.module_installation_id); assert.notEqual(newBinding.module_version_id, oldBinding.module_version_id);
  const [retained] = await db.select().from(s.moduleRecords).where(orm.eq(s.moduleRecords.id, record.record.id)); assert.equal(retained.data.title, 'Retained private fixture');
  assert.deepEqual(await db.select().from(s.moduleMutationReceipts).where(orm.eq(s.moduleMutationReceipts.org_id, org)), receiptBefore);
  assert.deepEqual(await db.select().from(s.appRuns).where(orm.eq(s.appRuns.id, admitted.run_id)), oldRun);
  assert.deepEqual(await db.select().from(s.appRunReceipts).where(orm.eq(s.appRunReceipts.org_id, org)), runReceipts);
  assert.deepEqual((await db.select().from(s.appGrantSnapshots).where(orm.eq(s.appGrantSnapshots.app_installation_id, installed.id))).filter(row => oldGrants.some(old => old.id === row.id)), oldGrants);
  assert.equal((await request(`/api/app-experiences/sessions/${oldSession.pin.session_id}/live`)).status, 409);
  const recovered = await call(prefix + `/context?app_version_id=${targetId}`); assert.equal(recovered.review_request, null);
  assert.equal(recovered.current_activation.grant_snapshot_id, activated.grant_snapshot_id);
  assert.equal((await request(prefix + '/activate', 'POST', drained.input)).status, 409);
});
