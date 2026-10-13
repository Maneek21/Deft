import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildDeftAppPackage } from '@deft/app-kit';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';

test('reviewed owner connection admission enables only each eligible member’s own account', { timeout: 180000 }, async t => {
  assert.ok(securityTestDatabaseIsSafe(), 'Use matching DATABASE_URL and DEFT_TEST_DATABASE_URL for the disposable test database');
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
    DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true',
    DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
    DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true', DEFT_APP_OWNER_CONNECTIONS_ENABLED: 'true' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`owner-connections:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: ring('owner-enc'), receipt_signing: ring('owner-sign'), fingerprint: ring('owner-fp') });
  const [{ db, closeDb }, s, { and, eq }, web, runtime, attachments, { Hono }, { serve }, ownerRoutes,
    blobRoutes, experienceRoutes, channelRoutes, humanRoutes, { AppExperienceHumanActionService }, { AppExperienceExposureService }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('../src/lib/web-sessions.js'),
    import('../src/lib/app-run-runtime.js'), import('../src/lib/app-attachment-runtime.js'), import('hono'), import('@hono/node-server'),
    import('../src/routes/app-owner-connections.js'), import('../src/routes/app-attachments.js'), import('../src/routes/app-experiences.js'),
    import('../src/routes/app-runtime-channel.js'), import('../src/lib/app-experience-human-action-routes.js'),
    import('../src/lib/app-experience-human-action-service.js'), import('../src/lib/app-experience-exposure.js'),
  ]);
  const app = new Hono();
  app.route('/api/app-resource-sync-channel/v3', (await import('../src/routes/app-attachment-sync-channel.js')).appAttachmentSyncChannelRoutes);
  app.route('/api/app-owner-connections', ownerRoutes.appOwnerConnectionRoutes);
  app.route('/api/apps/blob', blobRoutes.appAttachmentRoutes);
  app.route('/api/app-experiences', experienceRoutes.appExperienceRoutes);
  app.route('/api/app-experiences', humanRoutes.createExperienceHumanActionRoutes(async () => {
    const current = await runtime.getAppRunRuntime();
    return new AppExperienceHumanActionService(new AppExperienceExposureService(current.keys), current);
  }));
  app.route('/api/app-runtime/channel', channelRoutes.appRuntimeChannelRoutes);
  let server!: ReturnType<typeof serve>;
  const base = await new Promise<string>(resolve => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
    address => resolve(`http://127.0.0.1:${address.port}`)); });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve()));
    await attachments.shutdownAppAttachmentRuntime(); await runtime.shutdownAppRunRuntime(); await closeDb(); });
  const org = randomUUID(), foreignOrg = randomUUID(), suffix = randomUUID();
  await db.insert(s.orgs).values([{ id: org, name: 'Owner connection test', slug: `owner-connect-${suffix}` },
    { id: foreignOrg, name: 'Foreign connection test', slug: `foreign-connect-${suffix}` }]);
  const people = {
    owner: { id: randomUUID(), role: 'owner' as const, org }, admin: { id: randomUUID(), role: 'admin' as const, org },
    member: { id: randomUUID(), role: 'member' as const, org }, other: { id: randomUUID(), role: 'member' as const, org },
    guest: { id: randomUUID(), role: 'guest' as const, org }, agent: { id: randomUUID(), role: 'member' as const, org },
    inactive: { id: randomUUID(), role: 'member' as const, org }, foreign: { id: randomUUID(), role: 'owner' as const, org: foreignOrg },
  };
  const tokens: Record<keyof typeof people, string> = {} as Record<keyof typeof people, string>;
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    const person = people[key], email = `connect-${key}-${suffix}@example.test`;
    await db.insert(s.users).values({ id: person.id, name: `Connection ${key}`, email,
      kind: key === 'agent' ? 'agent' : 'human', is_agent: key === 'agent' });
    await db.insert(s.orgMembers).values({ id: randomUUID(), org_id: person.org, user_id: person.id, role: person.role, is_active: true });
    tokens[key] = (await web.createWebSession({ id: person.id, org_id: person.org, email })).accessToken;
  }
  const membership = (id: string) => and(eq(s.orgMembers.org_id, org), eq(s.orgMembers.user_id, id));
  await db.update(s.orgMembers).set({ is_active: false }).where(membership(people.inactive.id));
  const request = async (path: string, method = 'GET', body?: unknown, token = tokens.owner, scheme = 'Bearer') => {
    const response = await fetch(base + path, { method, headers: { authorization: `${scheme} ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (path: string, method = 'GET', body?: unknown, token = tokens.owner, scheme = 'Bearer') => {
    const result = await request(path, method, body, token, scheme);
    assert.ok(result.status >= 200 && result.status < 300, `${path}: HTTP ${result.status} ${JSON.stringify(result.body)}`); return result.body;
  };
  const deny = async (path: string, method = 'GET', body?: unknown, token = tokens.member, scheme = 'Bearer') => {
    const result = await request(path, method, body, token, scheme);
    assert.ok([400, 401, 403, 404, 409, 503].includes(result.status), `${path}: expected denial, got ${result.status} ${JSON.stringify(result.body)}`);
    assert.equal(typeof result.body.code, 'string');
    assert.equal(JSON.stringify(result.body).includes('PRIVATE-OWNER-INPUT'), false); return result;
  };
  const fixture = JSON.parse((await runtimeSecurityPackage()).json);
  fixture.manifest.id = `community.example.ownerconnect.a${suffix.replaceAll('-', '')}`;
  fixture.manifest.owner_connections = [{ key: 'personal_mailbox', resource_key: 'inbox', action_keys: ['send_message'], max_consent_seconds: 86400 * 30 }];
  const packed = (await buildDeftAppPackage({ manifest: fixture.manifest, artifacts: fixture.artifacts })).json;
  const { app: installed } = await call('/api/apps/blob/composition/stage', 'POST', packed);
  const installContext = await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);
  const { review: installReview } = await call(`/api/apps/blob/composition/${installed.id}/review`, 'POST', installContext.review_request);
  await call(`/api/apps/blob/composition/${installed.id}/activate`, 'POST', { ...installContext.review_request,
    expected_review_digest: installReview.review_digest, accept_host_policy: true });
  const root = '/api/app-owner-connections', contextPath = `${root}/${installed.id}/context`;
  const { setup } = await call(`/api/apps/blob/sync/setup?installation_id=${installed.id}&operator_user_id=${people.owner.id}`);
  const legacyInput = setup.descriptors.find((descriptor: any) => descriptor.resource_key === 'inbox').consent_request;
  const admissionInput = { installation_id: installed.id, policy_key: 'personal_mailbox', operator_user_id: people.owner.id,
    limits: { ...legacyInput.limits, max_records_per_page: 25 }, expected_app_version_id: legacyInput.expected_app_version_id,
    expected_package_digest: legacyInput.expected_package_digest, expected_grant_snapshot_digest: legacyInput.expected_grant_snapshot_digest,
    expected_lifecycle_epoch: legacyInput.expected_lifecycle_epoch, expected_grant_epoch: legacyInput.expected_grant_epoch };
  await t.test('deployment approval is admin-only; legacy setup and closed request boundaries stay intact', async () => {
    assert.equal((await call(contextPath, 'GET', undefined, tokens.member)).policies[0].status, 'deployment_review_required');
    for (const actor of ['guest', 'agent', 'inactive', 'foreign'] as const) await deny(contextPath, 'GET', undefined, tokens[actor]);
    await deny(contextPath + '?owner_user_id=' + people.owner.id);
    await deny(`${root}/admissions/review`, 'POST', admissionInput);
    await deny(`/api/apps/blob/sync/setup?installation_id=${installed.id}&operator_user_id=${people.owner.id}`);
    await deny('/api/apps/blob/sync/reviews/prepare', 'POST', legacyInput);
    await deny(`${root}/admissions/review`, 'POST', { ...admissionInput, expected_lifecycle_epoch: admissionInput.expected_lifecycle_epoch + 1 }, tokens.owner);
    await deny(`${root}/admissions/review`, 'POST', { ...admissionInput, operator_user_id: people.foreign.id }, tokens.owner);
    const { review } = await call(`${root}/admissions/review`, 'POST', admissionInput, tokens.admin);
    await deny(`${root}/admissions/activate`, 'POST', { ...admissionInput, expected_review_digest: review.review_digest, accept_host_policy: true });
    await deny(`${root}/admissions/activate`, 'POST', { ...admissionInput, expected_review_digest: 'sha256:' + '0'.repeat(64), accept_host_policy: true }, tokens.admin);
  });
  const { review: admissionReview } = await call(`${root}/admissions/review`, 'POST', admissionInput, tokens.admin);
  const { admission } = await call(`${root}/admissions/activate`, 'POST', { ...admissionInput,
    expected_review_digest: admissionReview.review_digest, accept_host_policy: true }, tokens.admin);
  const context = await call(contextPath, 'GET', undefined, tokens.member), policy = context.policies[0];
  assert.equal(policy.status, 'admitted'); assert.equal(policy.admission.operator_user_id, people.owner.id);
  assert.equal(policy.admission.admission_id, admission.admission_id);
  const resourceInput = { ...policy.admission.resource_request, limits: { ...policy.admission.resource_request.limits, max_records_per_page: 1 } };
  await t.test('turning off the opt-in feature denies setup without changing the admission', async () => {
    process.env.DEFT_APP_OWNER_CONNECTIONS_ENABLED = 'false';
    try { assert.equal((await deny(contextPath)).status, 503);
      assert.equal((await deny(`${root}/resources/review`, 'POST', resourceInput)).status, 503);
    } finally { process.env.DEFT_APP_OWNER_CONNECTIONS_ENABLED = 'true'; }
    assert.equal((await call(contextPath, 'GET', undefined, tokens.member)).policies[0].admission.admission_id, admission.admission_id);
  });
  await t.test('owner requests cannot nominate code, operator, another owner or broader consent', async () => {
    for (const extra of [{ owner_user_id: people.owner.id }, { operator_user_id: people.member.id }, { module_path: '/unreviewed.mjs' },
      { provider: 'gmail' }, { reviewed_by_user_id: people.owner.id }, { limits: { ...resourceInput.limits, max_records_per_page: 26 } },
      { consent_expires_at: new Date(Date.now() + 86400 * 31 * 1000).toISOString() }, { admission_digest: 'sha256:' + '0'.repeat(64) }]) {
      await deny(`${root}/resources/review`, 'POST', { ...resourceInput, ...extra });
    }
    for (const actor of ['guest', 'agent', 'inactive', 'foreign'] as const) await deny(`${root}/resources/review`, 'POST', resourceInput, tokens[actor]);
    const { review } = await call(`${root}/resources/review`, 'POST', resourceInput, tokens.member);
    await deny(`${root}/resources/activate`, 'POST', { ...resourceInput, expected_review_digest: review.review_digest, accept_host_policy: true }, tokens.other);
  });
  const connect = async (token: string) => {
    const { review } = await call(`${root}/resources/review`, 'POST', resourceInput, token);
    const { binding: resource } = await call(`${root}/resources/activate`, 'POST', { ...resourceInput,
      expected_review_digest: review.review_digest, accept_host_policy: true }, token);
    const input = { ...admission, owner_resource_binding_id: resource.binding_id, action_key: 'send_message' };
    const { review: actionReview } = await call(`${root}/actions/review`, 'POST', input, token);
    const { binding: action } = await call(`${root}/actions/activate`, 'POST', { ...input,
      expected_review_digest: actionReview.review_digest, accept_host_policy: true }, token);
    const opened = await call(`/api/app-experiences/${installed.id}/main/sessions`, 'POST', { resource_target_key: resourceInput.target_key }, token);
    const path = `/api/app-experiences/sessions/${opened.pin.session_id}`;
    const access = await call(path + '/access/review', 'POST', {}, token);
    await call(path + '/access/accept', 'POST', { review_token: access.review_token, review_digest: access.review_digest, accept_exposure: true }, token);
    return { resource, action, input, path, token };
  };
  const first = await connect(tokens.member), second = await connect(tokens.other);
  await t.test('connection action projection admits only the current owner resource reviewed action and exact deadline', async () => {
    const current=await runtime.getAppRunRuntime();
    const claims=JSON.parse(Buffer.from(first.token.split('.')[1]!,'base64url').toString());
    const caller={org_id:org,user_id:people.member.id,sid:claims.sid,access_expires_at:claims.exp*1000};
    const pins={org_id:org,owner_user_id:people.member.id,installation_id:installed.id,app_version_id:installed.version_id,
      grant_snapshot_id:first.resource.grant_snapshot_id,target_key:resourceInput.target_key,resource_key:'inbox',
      resource_binding_id:first.resource.binding_id,action_key:'send_message',action_binding_id:first.action.binding_id};
    const [stored]=await db.select().from(s.appResourceBindings).where(eq(s.appResourceBindings.id,first.resource.binding_id));
    pins.grant_snapshot_id=stored.grant_snapshot_id;
    const authority=new AppExperienceExposureService(current.keys);
    const projection=await authority.connectionSetup(caller,first.path.split('/').at(-1)!,pins);
    assert.deepEqual(projection.reviewed_action_keys,['send_message']);
    assert.ok(projection.expires_at<=stored.consent_expires_at!.getTime());
    assert.equal(projection.resource_binding_id,first.resource.binding_id);
    assert.deepEqual((await authority.connectionSetup(caller,first.path.split('/').at(-1)!,pins,undefined,'browse_resource')).reviewed_action_keys,undefined);
    await assert.rejects(authority.connectionSetup({...caller,user_id:people.other.id},first.path.split('/').at(-1)!,pins));
    await assert.rejects(authority.connectionSetup(caller,first.path.split('/').at(-1)!,{...pins,resource_binding_id:second.resource.binding_id}));
  });
  const list = { schema_version: 'deft.experience_resource_request.v1', operation: 'list_summary', limit: 1 };
  const read = (connection: typeof first) => call(connection.path + '/resources/inbox', 'POST', list, connection.token);
  await t.test('two members receive distinct private targets and cannot adopt another owner’s action anchor', async () => {
    assert.notEqual(first.resource.binding_id, second.resource.binding_id); assert.notEqual(first.action.binding_id, second.action.binding_id);
    await read(first); await read(second);
    await deny(first.path + '/resources/inbox', 'POST', list, tokens.other);
    await deny(`${root}/actions/review`, 'POST', first.input, tokens.other);
    await deny(`${root}/actions/review`, 'POST', { ...first.input, action_key: 'archive_message' });
    await deny(`${root}/actions/review`, 'POST', { ...first.input, operator_user_id: people.member.id });
    const ownContext = await call(contextPath, 'GET', undefined, tokens.member);
    assert.deepEqual(ownContext.policies[0].bindings.map((row: any) => row.binding_id), [first.resource.binding_id]);
    const [registration] = await db.select().from(s.appRuntimeRegistrations).where(eq(s.appRuntimeRegistrations.id, first.resource.registration_id));
    assert.equal(registration.owner_connection_admission_id, admission.admission_id);
    assert.equal(registration.reviewed_by_user_id, people.member.id); assert.equal(registration.operator_user_id, people.owner.id);
    const { review } = await call('/api/apps/blob/sync/reviews/prepare', 'POST', legacyInput);
    const { binding } = await call('/api/apps/blob/sync/bindings/activate', 'POST', { ...legacyInput, expected_review_digest: review.review_digest, accept_host_policy: true });
    const [legacy] = await db.select().from(s.appRuntimeRegistrations).where(eq(s.appRuntimeRegistrations.id, binding.registration_id));
    assert.equal(legacy.owner_connection_admission_id, null); assert.equal(legacy.owner_connection_admission_digest, null);
  });
  await t.test('page-limit review and CAS activation preserve custody, identity and deadlines and rotate only sync sessions', async () => {
    const reviewPath = `${root}/resources/limits/review`, activatePath = `${root}/resources/limits/activate`;
    const input = { binding_id: first.resource.binding_id, max_records_per_page: 25 };
    const [before] = await db.select().from(s.appResourceBindings).where(eq(s.appResourceBindings.id, input.binding_id));
    const [registration] = await db.select().from(s.appRuntimeRegistrations).where(eq(s.appRuntimeRegistrations.id, before.runtime_registration_id));
    const [checkpoint] = await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.resource_binding_id, input.binding_id));
    const [action] = await db.select().from(s.appRuntimeBindings).where(eq(s.appRuntimeBindings.id, first.action.binding_id));
    const { session: oldSync } = await call(`/api/apps/blob/sync/bindings/${input.binding_id}/sessions`, 'POST', {});
    const { session: actionSession } = await call(`/api/apps/blob/composition/runtime/bindings/${first.action.binding_id}/sessions`, 'POST', {});
    for (const actor of ['owner', 'admin', 'other', 'guest', 'agent', 'inactive', 'foreign'] as const)
      await deny(reviewPath, 'POST', input, tokens[actor]);
    for (const extra of [{ max_records_per_page: 26 }, { owner_user_id: people.member.id }, { min_interval_seconds: 0 },
      { consent_expires_at: new Date(Date.now() + 86400000).toISOString() }, { attachment_policy: {} }])
      await deny(reviewPath, 'POST', { ...input, ...extra });
    const { review } = await call(reviewPath, 'POST', input, tokens.member);
    assert.equal(review.previous_max_records_per_page, 1); assert.equal(review.consent.limits.max_records_per_page, 25);
    const activation = { ...input, expected_review_digest: review.review_digest, accept_host_policy: true };
    await deny(activatePath, 'POST', { ...activation, expected_review_digest: 'sha256:' + '0'.repeat(64) });
    const raced = await Promise.all([request(activatePath, 'POST', activation, tokens.member), request(activatePath, 'POST', activation, tokens.member)]);
    assert.deepEqual(raced.map(r => r.status).sort(), [200, 409]);
    const [after] = await db.select().from(s.appResourceBindings).where(eq(s.appResourceBindings.id, input.binding_id));
    const stable = (row: typeof before) => { const { max_records_per_page: _p, attachment_consent_digest: _d, updated_at: _u, ...rest } = row; return rest; };
    assert.deepEqual(stable(after), stable(before)); assert.equal(after.max_records_per_page, 25);
    assert.notEqual(after.attachment_consent_digest, before.attachment_consent_digest);
    assert.deepEqual((await db.select().from(s.appRuntimeRegistrations).where(eq(s.appRuntimeRegistrations.id, registration.id)))[0], registration);
    assert.deepEqual((await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.id, checkpoint.id)))[0], checkpoint);
    assert.deepEqual((await db.select().from(s.appRuntimeBindings).where(eq(s.appRuntimeBindings.id, action.id)))[0], action);
    assert.ok((await db.select().from(s.appRuntimeSessions).where(eq(s.appRuntimeSessions.id, oldSync.session_id)))[0].revoked_at);
    assert.equal((await db.select().from(s.appRuntimeSessions).where(eq(s.appRuntimeSessions.id, actionSession.session_id)))[0].revoked_at, null);
    for (const patch of [
      { max_records_per_page: 20 }, { attachment_consent_digest: 'sha256:' + '1'.repeat(64) },
      { max_records_per_page: 26, attachment_consent_digest: 'sha256:' + '2'.repeat(64) },
      { max_records_per_page: 20, attachment_consent_digest: 'sha256:' + '3'.repeat(64), min_interval_seconds: after.min_interval_seconds + 1 },
      { max_records_per_page: 20, attachment_consent_digest: 'sha256:' + '4'.repeat(64), consent_expires_at: new Date(after.consent_expires_at!.getTime() + 1000) },
    ]) await assert.rejects(db.update(s.appResourceBindings).set(patch).where(eq(s.appResourceBindings.id, input.binding_id)),
      'preview61 keeps page-only, digest-only, admission-ceiling, interval and expiry writes closed');
    await read(first); await read(second);
  });
  await t.test('web revocation while page-limit activation waits rolls back consent and session changes', async () => {
    const input = { binding_id: first.resource.binding_id, max_records_per_page: 20 };
    const { review } = await call(`${root}/resources/limits/review`, 'POST', input, tokens.member);
    const webSession = await web.createWebSession({ id: people.member.id, org_id: org, email: `connect-member-${suffix}@example.test` });
    const [before] = await db.select().from(s.appResourceBindings).where(eq(s.appResourceBindings.id, input.binding_id));
    const { session: oldSync } = await call(`/api/apps/blob/sync/bindings/${input.binding_id}/sessions`, 'POST', {});
    const [sessionBefore] = await db.select().from(s.appRuntimeSessions).where(eq(s.appRuntimeSessions.id, oldSync.session_id));
    const { sql } = await import('drizzle-orm');
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(ready => { release = ready; }), locked = new Promise<void>(ready => { entered = ready; });
    const blocker = db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM org_members WHERE org_id=${org} AND user_id=${people.member.id} FOR UPDATE`);
      entered(); await held;
    });
    await locked;
    try {
      const pending = request(`${root}/resources/limits/activate`, 'POST', { ...input, expected_review_digest: review.review_digest, accept_host_policy: true }, webSession.accessToken);
      let observed = false;
      for (let i = 0; i < 100; i++) {
        const waiting = await db.execute(sql<{ waiting: number }>`SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%org_members%'`);
        if (waiting.rows[0]!.waiting > 0) { observed = true; break; }
        await new Promise(ready => setTimeout(ready, 20));
      }
      assert.ok(observed, 'HTTP activation actually waited on a member lock');
      await web.revokeWebSession(webSession.refreshToken); release(); await blocker;
      assert.equal((await pending).status, 401);
      assert.deepEqual((await db.select().from(s.appResourceBindings).where(eq(s.appResourceBindings.id, input.binding_id)))[0], before);
      assert.deepEqual((await db.select().from(s.appRuntimeSessions).where(eq(s.appRuntimeSessions.id, oldSync.session_id)))[0], sessionBefore);
    } finally { release(); await blocker; }
  });
  await t.test('owner continuation bypasses only polling after authenticated committed non-null cursor and keeps one active Run', async () => {
    const bindingId = first.resource.binding_id, syncPath = `/api/apps/blob/sync/bindings/${bindingId}/sync`;
    for (const input of [{ continue: true }, { continue: false }, { force: true }, { cursor: 'forged' }])
      await deny(syncPath, 'POST', input);
    const admitted = await call(syncPath, 'POST', {}, tokens.member); assert.equal(admitted.state, 'created');
    const limitInput = { binding_id: bindingId, max_records_per_page: 20 };
    const { review } = await call(`${root}/resources/limits/review`, 'POST', limitInput, tokens.member);
    await deny(`${root}/resources/limits/activate`, 'POST', { ...limitInput, expected_review_digest: review.review_digest, accept_host_policy: true });
    const { session } = await call(`/api/apps/blob/sync/bindings/${bindingId}/sessions`, 'POST', {});
    const channel = '/api/app-resource-sync-channel/v3';
    const identity = { schema_version: 'deft.app_runtime_channel.v3', audience: 'app_resource_sync', session_id: session.session_id };
    const settle = async (expectedRun: string, cursor: string | null) => {
      const { claim } = await call(channel + '/claim', 'POST', { ...identity, max_claims: 1 }, session.session_token, 'AppRuntime');
      assert.equal(claim.run_id, expectedRun);
      const started = await call(channel + '/start', 'POST', { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id,
        claim_token: claim.claim_token, sequence: claim.sequence }, session.session_token, 'AppRuntime');
      assert.equal(started.started.input.max_items, 25);
      await call(channel + '/result', 'POST', { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id,
        claim_token: claim.claim_token, sequence: claim.sequence, status: 'returned', provider_succeeded: true,
        page: { schema_version: 'deft.app_sync_page.v2', upserts: [], tombstones: [], next_cursor: cursor, has_more: cursor !== null } }, session.session_token, 'AppRuntime');
      assert.equal((await db.select().from(s.appRuns).where(eq(s.appRuns.id, expectedRun)))[0].state, 'succeeded');
    };
    await settle(admitted.run_id, 'committed-baseline-page-2');
    assert.equal((await call(syncPath, 'POST', {}, tokens.member)).state, 'not_due');
    const [committedCheckpoint] = await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.resource_binding_id, bindingId));
    await assert.rejects(db.update(s.appSyncCheckpoints).set({ cursor_hmac: 'hmac-sha256:' + '0'.repeat(64) })
      .where(eq(s.appSyncCheckpoints.id, committedCheckpoint.id)), 'database rejects cursor tampering without a committed CAS');
    const { AppResourceSyncSecretService } = await import('../src/lib/app-resource-sync-secrets.js');
    const openJson = AppResourceSyncSecretService.prototype.openJson;
    AppResourceSyncSecretService.prototype.openJson = function(envelope, context) {
      return context.resource_binding_id === bindingId ? 'forged-cursor-plaintext' : openJson.call(this, envelope, context);
    };
    try { await deny(syncPath, 'POST', { continue: true }); }
    finally { AppResourceSyncSecretService.prototype.openJson = openJson; }
    await db.update(s.orgMembers).set({ role: 'guest' }).where(membership(people.member.id));
    try { await deny(syncPath, 'POST', { continue: true }); }
    finally { await db.update(s.orgMembers).set({ role: 'member' }).where(membership(people.member.id)); }
    await deny(syncPath, 'POST', { continue: true }, tokens.owner);
    await deny(syncPath, 'POST', { continue: true }, tokens.other);
    const { sql } = await import('drizzle-orm');
    const shortSession = await web.createWebSession({ id: people.member.id, org_id: org, email: `connect-member-${suffix}@example.test` });
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(ready => { release = ready; }), locked = new Promise<void>(ready => { entered = ready; });
    const blocker = db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM app_sync_checkpoints WHERE org_id=${org} AND id=${committedCheckpoint.id} FOR UPDATE`);
      entered(); await held;
    });
    await locked;
    try {
      const pending = request(syncPath, 'POST', { continue: true }, shortSession.accessToken);
      let observed = false;
      for (let i = 0; i < 100; i++) {
        const waiting = await db.execute(sql<{ waiting: number }>`SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%app_sync_checkpoints%'`);
        if (waiting.rows[0]!.waiting > 0) { observed = true; break; }
        await new Promise(ready => setTimeout(ready, 20));
      }
      assert.ok(observed, 'HTTP continuation actually waited on the checkpoint');
      await web.revokeWebSession(shortSession.refreshToken); release(); await blocker;
      assert.equal((await pending).status, 401);
      const currentRuns = await db.select().from(s.appSyncIntents).where(eq(s.appSyncIntents.resource_binding_id, bindingId));
      assert.equal(currentRuns.length, 1, 'revoked continuation rolls back the Run, attempt and intent');
    } finally { release(); await blocker; }
    const raced = await Promise.all([call(syncPath, 'POST', { continue: true }, tokens.member), call(syncPath, 'POST', { continue: true }, tokens.member)]);
    assert.deepEqual(raced.map(r => r.state).sort(), ['created', 'existing']); assert.equal(raced[0].run_id, raced[1].run_id);
    await settle(raced[0].run_id, null);
    await deny(syncPath, 'POST', { continue: true });
    assert.equal((await call(syncPath, 'POST', {}, tokens.member)).state, 'not_due');
    const [checkpoint] = await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.resource_binding_id, bindingId));
    assert.equal(checkpoint.cursor_sequence, 2); assert.equal(checkpoint.cursor_state, 'empty');
  });
  const queue = async (connection: typeof first) => {
    const input = { to: 'recipient@example.test', subject: 'Member consent fixture', body: 'PRIVATE-OWNER-INPUT', message_id: '<member-test@example.test>' };
    const ticket = await call(connection.path + '/human-actions/send_message/prepare', 'POST', { input, idempotency_key: randomUUID() }, connection.token);
    const queued = await call(connection.path + '/human-actions/confirm', 'POST', { ticket: ticket.ticket, expected_input_digest: ticket.input_digest }, connection.token);
    const { session } = await call(`/api/apps/blob/composition/runtime/bindings/${connection.action.binding_id}/sessions`, 'POST', {});
    const identity = { schema_version: 'deft.app_runtime_channel.v1', session_id: session.session_id };
    const { claim } = await call('/api/app-runtime/channel/claim', 'POST', { ...identity, max_claims: 1 }, session.session_token, 'AppRuntime');
    assert.equal(claim.run_id, queued.run.id); assert.equal(claim.input, undefined);
    return { session, start: { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence } };
  };
  await t.test('member demotion fences existing reads, human actions and a claimed Runtime attempt, preserving the other account', async () => {
    const queued = await queue(first);
    await db.update(s.orgMembers).set({ role: 'guest' }).where(membership(people.member.id));
    try {
      await deny(first.path + '/resources/inbox', 'POST', list);
      await deny(first.path + '/human-actions/send_message/prepare', 'POST', { input: {}, idempotency_key: randomUUID() });
      const result = await deny('/api/app-runtime/channel/start', 'POST', queued.start, queued.session.session_token, 'AppRuntime');
      assert.equal(result.body.started, undefined); await read(second);
    } finally { await db.update(s.orgMembers).set({ role: 'member' }).where(membership(people.member.id)); }
  });
  await t.test('retained credentials remain owner-manageable after read/Send is revoked without reviving provider authority',async()=>{
    const [{AppConnectionRegistry},{AppConnectionService}]=await Promise.all([import('../src/lib/app-connection-registry.js'),import('../src/lib/app-connection-service.js')]);
    const [source]=await db.select().from(s.appResourceBindings).where(eq(s.appResourceBindings.id,first.resource.binding_id));
    const [action]=await db.select().from(s.appRuntimeBindings).where(eq(s.appRuntimeBindings.id,first.action.binding_id));
    const pins={org_id:org,owner_user_id:people.member.id,installation_id:installed.id,app_version_id:source.app_version_id,
      grant_snapshot_id:source.grant_snapshot_id,target_key:source.target_key,resource_key:source.resource_key,resource_binding_id:source.id,
      action_binding_id:action.id,action_key:action.action_key};
    let calls=0;
    const registry=new AppConnectionRegistry([{pins,adapter:{async handle(_request,context){
      calls++;assert.deepEqual(context.projection.allowed_operations,[]);await context.recheck();return Response.json({state:'not_connected'});
    }}}]);
    const authority=new AppExperienceExposureService((await runtime.getAppRunRuntime()).keys);
    const service=new AppConnectionService(registry,authority);
    const fresh=await web.createWebSession({id:people.member.id,org_id:org,email:`connect-member-${suffix}@example.test`});
    const claims=JSON.parse(Buffer.from(fresh.accessToken.split('.')[1]!,'base64url').toString());
    const caller={org_id:org,user_id:people.member.id,sid:claims.sid,access_expires_at:claims.exp*1000};
    const originalClaims=JSON.parse(Buffer.from(first.token.split('.')[1]!,'base64url').toString());
    const originalCaller={...caller,sid:originalClaims.sid,access_expires_at:originalClaims.exp*1000};
    const nomination={installation_id:installed.id,target_key:source.target_key};
      // Revoked retains reviewed custody; disabled represents an unreviewed binding with null consent.
      await db.update(s.appResourceBindings).set({state:'revoked'}).where(eq(s.appResourceBindings.id,source.id));
      await db.update(s.appRuntimeBindings).set({state:'revoked',revoked_at:new Date()}).where(eq(s.appRuntimeBindings.id,action.id));
      await assert.rejects(authority.connectionSetup(originalCaller,first.path.split('/').at(-1)!,pins,undefined,'connect'));
      assert.deepEqual(await service.invokeRetained(caller,nomination,{},undefined),{state:'not_connected'});
      assert.deepEqual(await service.invokeRetained(caller,nomination,{operation:'disconnect'},undefined),{state:'not_connected'});
      assert.equal(calls,2);
      await assert.rejects(service.invokeRetained({...caller,user_id:people.other.id},nomination,{},undefined));
      await web.revokeWebSession(fresh.refreshToken);
      await assert.rejects(service.invokeRetained(caller,nomination,{},undefined));assert.equal(calls,2);
  });
  await t.test('withdrawn deployment admission fences existing member access and pending dispatch', async () => {
    const queued = await queue(second);
    await deny(`${root}/admissions/${admission.admission_id}/revoke`, 'POST', {});
    await call(`${root}/admissions/${admission.admission_id}/revoke`, 'POST', {}, tokens.admin);
    await deny(second.path + '/resources/inbox', 'POST', list, tokens.other);
    await deny(`${root}/resources/review`, 'POST', resourceInput, tokens.other);
    const result = await deny('/api/app-runtime/channel/start', 'POST', queued.start, queued.session.session_token, 'AppRuntime');
    assert.equal(result.body.started, undefined);
  });
});
