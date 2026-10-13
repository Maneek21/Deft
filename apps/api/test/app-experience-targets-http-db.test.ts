import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildDeftAppPackage } from '@deft/app-kit';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';

test('owner-private Experience targets route reviewed resources and Send authority independently', { timeout: 120_000 }, async t => {
  assert.ok(securityTestDatabaseIsSafe(), 'Set matching DATABASE_URL and DEFT_TEST_DATABASE_URL to the guarded disposable database');
  // The focused connection proof needs its personal/work authority fixtures,
  // while unrelated metadata/foreign-installation fixtures belong to later cases.
  const focusConnection = process.env.DEFT_TEST_FOCUS_CONNECTION === 'true', beganAt = performance.now();
  const fixtureTimings: { stage: string; ms: number }[] = [], connectionQueries: number[] = [];
  const connectionRequests: { operation: string; ms: number; status: number }[] = [];
  const mark = (stage: string) => { fixtureTimings.push({ stage, ms: Math.round(performance.now() - beganAt) }); };
  t.after(() => {
    if (focusConnection) t.diagnostic(JSON.stringify({ fixture_ms: fixtureTimings, current_projection_queries: {
      count: connectionQueries.length, total_ms: Math.round(connectionQueries.reduce((sum, ms) => sum + ms, 0)),
      max_ms: Math.round(Math.max(0, ...connectionQueries)),
    }, requests: connectionRequests }));
  });
  Object.assign(process.env, {
    DEFT_APPS_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
    DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true',
    DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true',
  });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`private-state-test:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: ring('private-enc'), receipt_signing: ring('private-sign'), fingerprint: ring('private-fp') });
  const [{ db, closeDb }, s, { and, eq, inArray }, web, runtime, attachments, { Hono }, { serve }, experienceRoutes,
    blobRoutes, channelRoutes, syncRoutes, humanRoutes, humanService, exposure] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('../src/lib/web-sessions.js'),
    import('../src/lib/app-run-runtime.js'), import('../src/lib/app-attachment-runtime.js'), import('hono'),
    import('@hono/node-server'), import('../src/routes/app-experiences.js'), import('../src/routes/app-attachments.js'),
    import('../src/routes/app-runtime-channel.js'), import('../src/routes/app-attachment-sync-channel.js'),
    import('../src/lib/app-experience-human-action-routes.js'), import('../src/lib/app-experience-human-action-service.js'),
    import('../src/lib/app-experience-exposure.js'),
  ]);
  const app = new Hono();
  mark('imports');
  app.route('/api/apps/blob', blobRoutes.appAttachmentRoutes);
  app.route('/api/app-experiences', experienceRoutes.appExperienceRoutes);
  app.route('/api/app-experiences', humanRoutes.createExperienceHumanActionRoutes(async () => {
    const current = await runtime.getAppRunRuntime();
    return new humanService.AppExperienceHumanActionService(new exposure.AppExperienceExposureService(current.keys), current);
  }));
  app.route('/api/app-runtime/channel', channelRoutes.appRuntimeChannelRoutes);
  app.route('/api/app-resource-sync-channel/v3', syncRoutes.appAttachmentSyncChannelRoutes);
  let server!: ReturnType<typeof serve>;
  const base = await new Promise<string>(resolve => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, address => resolve(`http://127.0.0.1:${address.port}`));
  });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await attachments.shutdownAppAttachmentRuntime(); await runtime.shutdownAppRunRuntime(); await closeDb();
  });
  const org = randomUUID(), owner = randomUUID(), other = randomUUID(), foreignOrg = randomUUID(), foreignOwner = randomUUID();
  const suffix = randomUUID();
  await db.insert(s.orgs).values([
    { id: org, name: 'Target isolation fixture', slug: `targets-${suffix}` },
    { id: foreignOrg, name: 'Foreign target fixture', slug: `foreign-targets-${suffix}` },
  ]);
  await db.insert(s.users).values([
    { id: owner, name: 'Target owner', email: `targets-owner-${suffix}@example.test` },
    { id: other, name: 'Other target owner', email: `targets-other-${suffix}@example.test` },
    { id: foreignOwner, name: 'Foreign tenant owner', email: `targets-foreign-${suffix}@example.test` },
  ]);
  await db.insert(s.orgMembers).values([
    { id: randomUUID(), org_id: org, user_id: owner, role: 'owner', is_active: true },
    { id: randomUUID(), org_id: org, user_id: other, role: 'admin', is_active: true },
    { id: randomUUID(), org_id: foreignOrg, user_id: foreignOwner, role: 'owner', is_active: true },
  ]);
  const ownerSession = await web.createWebSession({ id: owner, org_id: org, email: `targets-owner-${suffix}@example.test` });
  const otherSession = await web.createWebSession({ id: other, org_id: org, email: `targets-other-${suffix}@example.test` });
  const foreignSession = await web.createWebSession({ id: foreignOwner, org_id: foreignOrg, email: `targets-foreign-${suffix}@example.test` });
  mark('actor_sessions');
  const request = async (path: string, method = 'GET', body?: unknown, token = ownerSession.accessToken, scheme = 'Bearer') => {
    const response = await fetch(base + path, { method,
      headers: { authorization: `${scheme} ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { assert.fail(`${path}: HTTP ${response.status}, expected a structured JSON response`); }
    return { status: response.status, ok: response.ok, body: parsed };
  };
  const call = async (path: string, method = 'GET', body?: unknown, token = ownerSession.accessToken, scheme = 'Bearer') => {
    const response = await request(path, method, body, token, scheme);
    assert.ok(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(response.body)}`); return response.body;
  };
  const assertClosed = (response: { status: number; body: any }, path: string) => {
    assert.ok([400, 403, 404, 409].includes(response.status), `${path}: expected closed authorization, got ${response.status}`);
    assert.equal(typeof response.body.code, 'string');
    assert.equal(JSON.stringify(response.body).includes('PRIVATE-TARGET-'), false, 'Denied request cannot disclose another target');
    return response;
  };
  const deny = async (path: string, method = 'GET', body?: unknown, token = ownerSession.accessToken) =>
    assertClosed(await request(path, method, body, token), path);
  const fixture = JSON.parse((await runtimeSecurityPackage()).json);
  fixture.manifest.id = `community.example.targets.a${suffix.replaceAll('-', '')}`;
  fixture.manifest.private_state.find((declaration: any) => declaration.key === 'drafts').max_records = 2;
  // A second reviewed resource can share a target without being exposed by this
  // Experience; action uniqueness must still use the effective owner target.
  fixture.manifest.sync_descriptors.push({ ...structuredClone(fixture.manifest.sync_descriptors.find((descriptor: any) => descriptor.key === 'inbox')), key: 'inbox2' });
  const sendContract = fixture.manifest.private_capabilities.find((capability: any) => capability.key === 'send_message').input_schema;
  Object.assign(sendContract.properties.to, { minLength: 1, format: 'email' });
  Object.assign(sendContract.properties.subject, { minLength: 1, format: 'single_line' });
  const packed = (await buildDeftAppPackage({ manifest: fixture.manifest, artifacts: fixture.artifacts })).json;
  const install = async (token = ownerSession.accessToken) => {
    const { app: installed } = await call('/api/apps/blob/composition/stage', 'POST', packed, token);
    const context = await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`, 'GET', undefined, token);
    const { review } = await call(`/api/apps/blob/composition/${installed.id}/review`, 'POST', context.review_request, token);
    await call(`/api/apps/blob/composition/${installed.id}/activate`, 'POST', { ...context.review_request,
      expected_review_digest: review.review_digest, accept_host_policy: true }, token);
    return installed;
  };
  const installed = await install();
  mark('owner_installation');
  const consent = async (targetKey: string | undefined, ownerId = owner, token = ownerSession.accessToken, installationId = installed.id, resourceKey = 'inbox', expiresAt?: string) => {
    const { setup } = await call(`/api/apps/blob/sync/setup?installation_id=${installationId}&operator_user_id=${ownerId}`, 'GET', undefined, token);
    const input = { ...setup.descriptors.find((descriptor: any) => descriptor.resource_key === resourceKey).consent_request,
      ...(targetKey === undefined ? {} : { target_key: targetKey }), ...(expiresAt ? { consent_expires_at: expiresAt } : {}) };
    const { review } = await call('/api/apps/blob/sync/reviews/prepare', 'POST', input, token);
    const { binding } = await call('/api/apps/blob/sync/bindings/activate', 'POST', { ...input,
      expected_review_digest: review.review_digest, accept_host_policy: true }, token);
    return { binding, input, review };
  };
  const personal = await consent('personal'), work = await consent('work');
  mark('personal_work_resources');
  const { actions } = await call(`/api/apps/blob/composition/${installed.id}/runtime/context?app_version_id=${installed.version_id}`);
  const actionInput = actions.find((action: any) => action.key === 'send_message').review_request;
  const bindAction = async (resourceBindingId?: string) => {
    const input = { ...actionInput, ...(resourceBindingId ? { owner_resource_binding_id: resourceBindingId } : {}) };
    const { review } = await call('/api/apps/blob/composition/runtime/reviews/prepare', 'POST', input);
    const { binding } = await call('/api/apps/blob/composition/runtime/bindings/activate', 'POST', { ...input,
      expected_review_digest: review.review_digest, accept_host_policy: true });
    return { binding, input, review };
  };
  const personalSend = await bindAction(personal.binding.binding_id), workSend = await bindAction(work.binding.binding_id);
  mark('personal_work_actions');
  const publish = async (bindingId: string, target: string) => {
    const admitted = await call(`/api/apps/blob/sync/bindings/${bindingId}/sync`, 'POST', {}); assert.equal(admitted.state, 'created');
    const { session } = await call(`/api/apps/blob/sync/bindings/${bindingId}/sessions`, 'POST', {});
    const channel = '/api/app-resource-sync-channel/v3', identity = {
      schema_version: 'deft.app_runtime_channel.v3', audience: 'app_resource_sync', session_id: session.session_id,
    };
    const invoke = (path: string, body: unknown) => call(channel + path, 'POST', body, session.session_token, 'AppRuntime');
    const { claim } = await invoke('/claim', { ...identity, max_claims: 1 }); assert.ok(claim); assert.equal(claim.run_id, admitted.run_id);
    const attempt = { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence };
    assert.ok((await invoke('/start', attempt)).started);
    const result = await invoke('/result', { ...attempt, status: 'returned', provider_succeeded: true,
      page: { schema_version: 'deft.app_sync_page.v2', upserts: [0, 1].map(index => ({ id: `same-provider-message-${index}`, revision: '1',
        data: { subject: `PRIVATE-TARGET-${target}-${index}`, body: `PRIVATE-TARGET-${target}-BODY-${index}` }, attachments: [] })),
        tombstones: [], next_cursor: null, has_more: false } }); assert.equal(result.accepted, true);
  };
  const open = async (targetKey?: string, token = ownerSession.accessToken) => {
    const created = await call(`/api/app-experiences/${installed.id}/main/sessions`, 'POST', targetKey ? { resource_target_key: targetKey } : {}, token);
    const path = '/api/app-experiences/sessions/' + created.pin.session_id;
    const review = await call(path + '/access/review', 'POST', {}, token);
    await call(path + '/access/accept', 'POST', { review_token: review.review_token, review_digest: review.review_digest, accept_exposure: true }, token);
    return { path, id: created.pin.session_id as string, review };
  };
  const personalExperience = await open('personal'), workExperience = await open('work');
  mark('connection_ready');
  const list = { schema_version: 'deft.experience_resource_request.v1', operation: 'list_summary', limit: 1 };
  const input = { to: 'recipient@example.test', subject: 'Target exact Send', body: 'PRIVATE-TARGET-OUTGOING', message_id: '<target-probe@example.test>' };
  const actionPath = (experience: { path: string }) => experience.path + '/human-actions/send_message';
  const prepare = (experience: { path: string }) => call(actionPath(experience) + '/prepare', 'POST', { input, idempotency_key: randomUUID() });
  const confirm = (experience: { path: string }, ticket: any) => call(experience.path + '/human-actions/confirm', 'POST', {
    ticket: ticket.ticket, expected_input_digest: ticket.input_digest,
  });
  await t.test('configured connection dispatch rederives exact owner target and action authority through authenticated HTTP', async () => {
    const [{ AppConnectionRegistry }, { createAppConnectionAdapter }, { createEncryptedEmailCustody }] = await Promise.all([
      import('../src/lib/app-connection-registry.js'),
      import(new URL('../../../examples/apps/email/providers/connection-http.mjs', import.meta.url).href),
      import(new URL('../../../examples/apps/email/providers/custody-encrypted.mjs', import.meta.url).href),
    ]);
    type ConnectionContext = import('../src/lib/app-connection-contract.js').AppConnectionContext;
    const [stored] = await db.select().from(s.appExperienceSessions).where(eq(s.appExperienceSessions.id, personalExperience.id));
    const pins = { org_id: org, owner_user_id: owner, installation_id: installed.id,
      app_version_id: stored.app_version_id, grant_snapshot_id: stored.grant_snapshot_id,
      target_key: 'personal', resource_key: 'inbox', resource_binding_id: personal.binding.binding_id,
      action_key: 'send_message', action_binding_id: personalSend.binding.binding_id };
    type CustodyRow = { revision: number; value: unknown };
    type CustodyTx = { read: () => Promise<CustodyRow | null>;
      compareAndSwap: (input: { expected_revision: number | null; value: unknown }) => Promise<boolean> };
    const rows = new Map<string, CustodyRow>(), queues = new Map<string, Promise<void>>();
    const custody = createEncryptedEmailCustody({ encryption_key: new Uint8Array(32).fill(13), key_id: 'http-connection-test',
      store: { async withLock({ key }: { key: string }, callback: (tx: CustodyTx) => Promise<unknown>) {
        const prior = queues.get(key) ?? Promise.resolve(); let release!: () => void;
        const next = new Promise<void>(resolve => { release = resolve; }); queues.set(key, next); await prior;
        try { return await callback({ async read() { return structuredClone(rows.get(key) ?? null); },
          async compareAndSwap({ expected_revision, value }) {
            const row = rows.get(key); if ((row?.revision ?? null) !== expected_revision) return false;
            rows.set(key, { revision: (row?.revision ?? 0) + 1, value: structuredClone(value) }); return true;
          } }); } finally { release(); if (queues.get(key) === next) queues.delete(key); }
      } } });
    const providerCalls: string[] = [];
    const adapter = await createAppConnectionAdapter({ custody, host: {
      async resolveContext(context: ConnectionContext) { return context.projection; },
      async assertCurrent(context: ConnectionContext) {
        const queryAt = performance.now();
        try { return await context.recheck(); } finally { connectionQueries.push(performance.now() - queryAt); }
      },
    }, options: { origin: 'https://deft.example.test', account_id: 'personal-google', provider: 'gmail', authority_epoch: 9,
      connection_target: 'personal', resource_binding_id: personal.binding.binding_id,
      action_binding_id: personalSend.binding.binding_id, capabilities: ['read', 'send'], clients: {
        gmail: { client_id: 'mock-google-client', client_secret: 'MOCK-PRIVATE-CLIENT',
          redirect_uri: 'https://deft.example.test/apps/connections/callback', verify_aliases: true },
      } }, fetch: async (url: string, init: RequestInit) => {
      providerCalls.push(url); assert.equal(init.redirect, 'error');
      if (url === 'https://oauth2.googleapis.com/token') {
        assert.ok(init.body instanceof URLSearchParams); assert.equal(init.body.get('grant_type'), 'authorization_code');
        assert.equal(init.body.get('code'), 'mock-personal-code'); assert.ok(init.body.get('code_verifier'));
        return Response.json({ access_token: 'MOCK-PRIVATE-ACCESS', refresh_token: 'MOCK-PRIVATE-REFRESH',
          token_type: 'Bearer', expires_in: 120, scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send' });
      }
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer MOCK-PRIVATE-ACCESS');
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({
        sub: 'MOCK-PRIVATE-SUBJECT', email: 'personal-verified@example.test', email_verified: true, name: 'Personal verified Gmail' });
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') return Response.json({ emailAddress: 'personal-verified@example.test' });
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs') return Response.json({ sendAs: [
        { sendAsEmail: 'personal-verified@example.test', verificationStatus: 'accepted' },
        { sendAsEmail: 'personal-alias@example.test', verificationStatus: 'accepted' },
        { sendAsEmail: 'unverified@example.test', verificationStatus: 'pending' },
      ] });
      assert.fail('Unexpected provider operation; this fixture never sends mail');
    } });
    let calls = 0;
    const registry = new AppConnectionRegistry([{ pins, adapter: { async handle(raw, context) {
      calls++; assert.equal(raw.headers.get('authorization'), null); assert.equal(raw.headers.get('cookie'), null);
      assert.equal(context.projection.owner_user_id, owner);
      assert.equal(context.projection.target_key, 'personal');
      assert.equal(context.projection.resource_binding_id, personal.binding.binding_id);
      assert.equal(context.projection.action_binding_id, personalSend.binding.binding_id);
      const purpose = new URL(raw.url).pathname.endsWith('/manage')
        ? ((await raw.clone().json()) as { operation?: 'status' | 'disconnect' }).operation ?? 'status' : 'connect';
      assert.equal(context.projection.purpose, purpose);
      assert.ok(context.projection.expires_at > Date.now());
      const rechecked = await context.recheck();
      assert.equal(rechecked.descriptor_digest, context.projection.descriptor_digest); assert.equal(rechecked.purpose, purpose);
      return adapter.handle(raw, context);
    } } }]);
    const connectionApp = new Hono();
    connectionApp.route('/api/app-experiences', experienceRoutes.createAppExperienceRoutes(undefined, { connectionRegistry: registry }));
    const invoke = async (experience: { path: string }, token = ownerSession.accessToken, body: unknown = {},
      operation: 'begin' | 'callback' | 'manage' = 'manage') => {
      const requestedAt = performance.now();
      const result = await connectionApp.request(experience.path + '/connections/' + operation, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: 'https://deft.example.test' }, body: JSON.stringify(body) });
      connectionRequests.push({ operation, ms: Math.round(performance.now() - requestedAt), status: result.status });
      return { status: result.status, body: await result.json() };
    };
    const initial = await invoke(personalExperience); assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, { state: 'not_connected', account: null }); assert.equal(calls, 1);
    for (const denied of [await invoke(workExperience), await invoke(personalExperience, otherSession.accessToken),
      await invoke(personalExperience, foreignSession.accessToken), await invoke(personalExperience, ownerSession.accessToken, { account_id: 'forged' })]) {
      assert.ok([400, 403, 503].includes(denied.status));
    }
    assert.equal(calls, 1, 'denied nominations never reach provider code');
    assert.equal(providerCalls.length, 0);
    const begin = await invoke(personalExperience, ownerSession.accessToken, {}, 'begin'); assert.equal(begin.status, 200);
    assert.equal(typeof begin.body.expires_at, 'number'); const authorization = new URL(begin.body.authorization_url);
    assert.equal(authorization.origin, 'https://accounts.google.com'); assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorization.searchParams.get('scope')!.includes('gmail.send'));
    const callbackBody = { state: authorization.searchParams.get('state')!, code: 'mock-personal-code' };
    for (const denied of [await invoke(workExperience, ownerSession.accessToken, callbackBody, 'callback'),
      await invoke(personalExperience, otherSession.accessToken, callbackBody, 'callback'),
      await invoke(personalExperience, foreignSession.accessToken, callbackBody, 'callback')]) {
      assert.ok([403, 503].includes(denied.status));
    }
    assert.equal(providerCalls.length, 0, 'foreign owner/tenant/target callbacks cannot disclose a code to Google');
    const connected = await invoke(personalExperience, ownerSession.accessToken, callbackBody, 'callback');
    assert.equal(connected.status, 200, `Callback after ${providerCalls.length} fixed provider calls: ${JSON.stringify(connected.body)}`);
    assert.equal(connected.body.state, 'connected'); assert.equal(connected.body.account.health, 'connected');
    assert.equal(connected.body.account.primary_address, 'personal-verified@example.test');
    assert.deepEqual(connected.body.account.capabilities, ['read', 'send']);
    assert.deepEqual(connected.body.account.verified_sender_identities, ['personal-verified@example.test', 'personal-alias@example.test']);
    assert.equal(providerCalls.length, 4);
    const status = await invoke(personalExperience); assert.equal(status.status, 200); assert.deepEqual(status.body, connected.body);
    const differentSid = await web.createWebSession({ id: owner, org_id: org, email: `targets-owner-${suffix}@example.test` });
    assert.equal((await invoke(personalExperience, differentSid.accessToken)).status, 403, 'The same owner cannot use another SID for custody');
    const replay = await invoke(personalExperience, ownerSession.accessToken, callbackBody, 'callback');
    assert.equal(replay.status, 403); assert.equal(providerCalls.length, 4, 'replayed code/state causes no second provider exchange');
    const pending = await invoke(personalExperience, ownerSession.accessToken, {}, 'begin'); assert.equal(pending.status, 200);
    const sendFlag = process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED;
    let disconnected!: Awaited<ReturnType<typeof invoke>>;
    try {
      process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED = 'false';
      const withoutSend = await invoke(personalExperience); assert.equal(withoutSend.status, 200);
      assert.equal(withoutSend.body.state, 'connected', 'Current resource authority still permits status with Send disabled');
      const deniedConnect = await invoke(personalExperience, ownerSession.accessToken, {}, 'begin');
      assertClosed(deniedConnect, 'Disabled Send never permits Connect');
      disconnected = await invoke(personalExperience, ownerSession.accessToken, { operation: 'disconnect' });
      assert.equal(disconnected.status, 200); assert.equal(disconnected.body.state, 'revoked'); assert.equal(disconnected.body.account.health, 'revoked');
      assert.equal(providerCalls.length, 4, 'Disabled Send status/disconnect causes no provider call');
    } finally {
      if (sendFlag === undefined) delete process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED;
      else process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED = sendFlag;
    }
    const staleCallback = await invoke(personalExperience, ownerSession.accessToken, {
      state: new URL(pending.body.authorization_url).searchParams.get('state')!, code: 'mock-personal-code' }, 'callback');
    assert.equal(staleCallback.status, 403); assert.equal((await invoke(personalExperience)).body.state, 'revoked');
    assert.equal(providerCalls.length, 4, 'disconnect and status never refresh, revoke remotely or send mail');
    const publicResponses = JSON.stringify([begin.body, connected.body, status.body, replay.body, disconnected.body, staleCallback.body]);
    for (const field of ['MOCK-PRIVATE-', 'access_token', 'refresh_token', 'provider_subject', 'client_secret',
      'connection_target', 'resource_binding_id', 'action_binding_id', 'authority_epoch']) assert.equal(publicResponses.includes(field), false, field);
    const durablePayloads = JSON.stringify([...rows.values()]);
    for (const secret of ['MOCK-PRIVATE-ACCESS', 'MOCK-PRIVATE-REFRESH', 'MOCK-PRIVATE-SUBJECT', 'personal-verified@example.test', callbackBody.state]) {
      assert.equal(durablePayloads.includes(secret), false, 'durable custody contains ciphertext rather than ' + secret);
    }
    const current = await runtime.getAppRunRuntime();
    const projection = new exposure.AppExperienceExposureService(current.keys);
    const identity = await web.verifyWebAccess(ownerSession.accessToken);
    const actor = { org_id: org, user_id: owner, sid: identity.sid, access_expires_at: identity.exp * 1000 };
    await assert.rejects(projection.connectionSetup(actor, personalExperience.id, { ...pins, action_binding_id: workSend.binding.binding_id }));
    await assert.rejects(projection.connectionSetup(actor, personalExperience.id, { ...pins, resource_binding_id: work.binding.binding_id }));
    await assert.rejects(projection.connectionSetup(actor, personalExperience.id, { ...pins, grant_snapshot_id: randomUUID() }));
    if (focusConnection) {
      // Revocation is terminal. These disposable fixture mutations run only in
      // the focused path, which never continues to unrelated active-Send cases.
      const [{ revokeRuntimeBinding }, { resourceSyncWebAuthority }] = await Promise.all([
        import('../src/lib/app-runtime-management.js'), import('../src/lib/app-resource-sync-web-authority.js'),
      ]);
      const { actor: manager } = await resourceSyncWebAuthority(`Bearer ${ownerSession.accessToken}`);
      assert.equal((await revokeRuntimeBinding(manager, personalSend.binding.binding_id)).revoked, true);
      assert.equal((await invoke(personalExperience)).status, 200, 'Revoked Send does not revoke resource status authority');
      const cleanup = await invoke(personalExperience, ownerSession.accessToken, { operation: 'disconnect' });
      assert.equal(cleanup.status, 200); assert.equal(cleanup.body.state, 'revoked');
      const connectRevoked = await invoke(personalExperience, ownerSession.accessToken, {}, 'begin');
      assertClosed(connectRevoked, 'Revoked Send prevents Connect');
      assert.equal((await invoke(personalExperience, ownerSession.accessToken, { purpose: 'status' }, 'begin')).status, 400,
        'Browser cannot turn Connect into cleanup authority');
      assert.equal((await invoke(personalExperience, otherSession.accessToken)).status, 403);
      assert.equal((await invoke(personalExperience, differentSid.accessToken, { operation: 'disconnect' })).status, 403);
      assert.ok([403, 503].includes((await invoke(workExperience)).status));
      assert.equal(providerCalls.length, 4, 'Revoked Send cleanup and denied Connect never contact Google');
      await call(`/api/apps/blob/sync/bindings/${personal.binding.binding_id}/revoke`, 'POST', {});
      for (const result of [await invoke(personalExperience),
        await invoke(personalExperience, ownerSession.accessToken, { operation: 'disconnect' }),
        await invoke(personalExperience, ownerSession.accessToken, {}, 'begin')]) {
        assertClosed(result, 'Revoked resource denies every connection purpose');
      }
      assert.equal(providerCalls.length, 4, 'Resource revocation never contacts Google');
    }
  });
  mark('connection_complete');
  if (focusConnection) return;
  const foreignInstalled = await install(foreignSession.accessToken);
  const primary = await consent(undefined);
  const secondPrimaryResource = await consent('primary', owner, ownerSession.accessToken, installed.id, 'inbox2');
  const otherTarget = await consent('other_only', other, otherSession.accessToken);
  const foreignTarget = await consent('foreign_only', foreignOwner, foreignSession.accessToken, foreignInstalled.id);
  const legacySend = await bindAction();
  await publish(primary.binding.binding_id, 'primary'); await publish(personal.binding.binding_id, 'personal'); await publish(work.binding.binding_id, 'work');
  const primarySession = await open();
  await t.test('reviewed targets select exact action bindings and isolate identical provider IDs', async () => {
    assert.notEqual(personal.review.review_digest, work.review.review_digest);
    assert.notEqual(personalSend.review.review_digest, workSend.review.review_digest);
    for (const [experience, target, actionBinding] of [
      [personalExperience, 'personal', personalSend.binding.binding_id], [workExperience, 'work', workSend.binding.binding_id],
    ] as const) {
      const context = await call(actionPath(experience) + '/context'); assert.equal(context.runtime_binding_id, actionBinding);
      const page = await call(experience.path + '/resources/inbox', 'POST', list);
      assert.equal(page.output.items.length, 1); assert.ok(page.output.items[0].label.startsWith(`PRIVATE-TARGET-${target}-`));
      const detail = await call(experience.path + '/resources/inbox', 'POST', { schema_version: list.schema_version,
        operation: 'read_one', record_id: page.output.items[0].record_id });
      assert.ok(detail.output.item.data.body.startsWith(`PRIVATE-TARGET-${target}-BODY-`));
    }
    const records = await db.select().from(s.appResourceProjections).where(and(eq(s.appResourceProjections.org_id, org),
      inArray(s.appResourceProjections.resource_binding_id, [personal.binding.binding_id, work.binding.binding_id])));
    assert.equal(records.length, 4); assert.equal(new Set(records.map(record => record.id)).size, 4);
  });
  await t.test('cross-target record, cursor and immutable Send ticket substitution fail closed', async () => {
    const personalPage = await call(personalExperience.path + '/resources/inbox', 'POST', list);
    assert.ok(personalPage.output.next_cursor);
    await deny(workExperience.path + '/resources/inbox', 'POST', { schema_version: list.schema_version,
      operation: 'read_one', record_id: personalPage.output.items[0].record_id });
    await deny(workExperience.path + '/resources/inbox', 'POST', { ...list, cursor: personalPage.output.next_cursor });
    const personalTicket = await prepare(personalExperience);
    await deny(workExperience.path + '/human-actions/confirm', 'POST', {
      ticket: personalTicket.ticket, expected_input_digest: personalTicket.input_digest,
    });
    assert.equal((await db.select().from(s.appRuns).where(and(eq(s.appRuns.org_id, org), eq(s.appRuns.operation_name, 'send_message')))).length, 0);
  });
  await t.test('host confirmation binds the current encrypted draft revision and cannot substitute saved input', async () => {
    const draftId = randomUUID(), statePath = personalExperience.path + '/state/drafts';
    const value = { mode: 'compose', to: input.to, subject: 'Saved exact subject', body: 'PRIVATE-TARGET-SAVED-SEND', reply_record_id: '' };
    await call(statePath, 'POST', { operation: 'put', record_id: draftId, expected_revision: 0, value });
    const actionInput = { ...input, to: value.to, subject: value.subject, body: value.body };
    const draft_ref = { draft_state_key: 'drafts', draft_id: draftId, expected_revision: 1 };
    const requestBody = { input: actionInput, idempotency_key: draftId, draft_ref };
    await deny(actionPath(personalExperience) + '/prepare', 'POST', { ...requestBody, draft_ref: { ...draft_ref, expected_revision: 99 } });
    await deny(actionPath(personalExperience) + '/prepare', 'POST', { ...requestBody, input: { ...actionInput, body: 'PRIVATE-TARGET-SUBSTITUTED' } });
    await deny(actionPath(personalExperience) + '/prepare', 'POST', { ...requestBody, idempotency_key: randomUUID() });
    await deny(actionPath(workExperience) + '/prepare', 'POST', requestBody);
    await deny(actionPath(personalExperience) + '/prepare', 'POST', requestBody, otherSession.accessToken);
    await deny(actionPath(personalExperience) + '/prepare', 'POST', { ...requestBody, draft_ref: { ...draft_ref, draft_state_key: 'unreviewed' } });
    const stale = await call(actionPath(personalExperience) + '/prepare', 'POST', requestBody);
    const changed = { ...value, body: 'PRIVATE-TARGET-UPDATED-SAVED-SEND' };
    await call(statePath, 'POST', { operation: 'put', record_id: draftId, expected_revision: 1, value: changed });
    await deny(personalExperience.path + '/human-actions/confirm', 'POST', { ticket: stale.ticket, expected_input_digest: stale.input_digest });
    assert.equal((await call(actionPath(personalExperience) + '/submissions/' + draftId)).run, null);
    const current = await call(actionPath(personalExperience) + '/prepare', 'POST', {
      ...requestBody, input: { ...actionInput, body: changed.body }, draft_ref: { ...draft_ref, expected_revision: 2 },
    });
    const confirmed = await confirm(personalExperience, current);
    assert.equal((await confirm(personalExperience, current)).run.id, confirmed.run.id, 'Repeated exact confirmation returns one durable Run');
    assert.equal((await call(actionPath(personalExperience) + '/submissions/' + draftId)).run.id, confirmed.run.id);
    await call(statePath, 'POST', { operation: 'delete', record_id: draftId, expected_revision: 2 });
    await deny(personalExperience.path + '/human-actions/confirm', 'POST', { ticket: current.ticket, expected_input_digest: current.input_digest });
  });
  await t.test('encrypted draft persistence and CAS are isolated by selected target', async () => {
    const personalId = randomUUID(), workId = randomUUID();
    const value = { mode: 'compose', to: 'recipient@example.test', subject: '', body: 'PRIVATE-TARGET-PERSONAL-DRAFT', reply_record_id: '' };
    const state = (experience: { path: string }, body: unknown) => call(experience.path + '/state/drafts', 'POST', body);
    const write = await state(personalExperience, { operation: 'put', record_id: personalId, expected_revision: 0, value });
    assert.equal(write.output.item.revision, 1);
    assert.equal((await state(personalExperience, { operation: 'read', record_id: personalId })).output.item.value.body, value.body);
    assert.equal((await state(workExperience, { operation: 'list' })).output.items.length, 0);
    await deny(workExperience.path + '/state/drafts', 'POST', { operation: 'read', record_id: personalId });
    await deny(workExperience.path + '/state/drafts', 'POST', { operation: 'put', record_id: personalId, expected_revision: 0, value });
    await deny(personalExperience.path + '/state/drafts', 'POST', { operation: 'put', record_id: personalId, expected_revision: 0, value });
    await state(workExperience, { operation: 'put', record_id: workId, expected_revision: 0, value: { ...value, body: 'PRIVATE-TARGET-WORK-DRAFT' } });
    const overQuotaId = randomUUID();
    const quota = await request(primarySession.path + '/state/drafts', 'POST', {
      operation: 'put', record_id: overQuotaId, expected_revision: 0, value: { ...value, body: 'PRIVATE-TARGET-PRIMARY-OVER-QUOTA' },
    });
    assert.equal(quota.status, 409, 'The declared owner/key quota includes records from personal and work');
    assert.equal(quota.body.code, 'APP_STATE_CONFLICT');
    assert.equal((await state(primarySession, { operation: 'list' })).output.items.length, 0);
    assert.equal((await state(personalExperience, { operation: 'list' })).output.items.length, 1);
    assert.equal((await state(workExperience, { operation: 'list' })).output.items.length, 1);
    assert.equal((await db.select().from(s.appPrivateStateRecords).where(and(eq(s.appPrivateStateRecords.org_id, org),
      eq(s.appPrivateStateRecords.installation_id, installed.id), eq(s.appPrivateStateRecords.owner_user_id, owner),
      eq(s.appPrivateStateRecords.state_key, 'drafts')))).filter(row => !row.deleted_at).length, 2);
    const reopened = await open('personal');
    assert.equal((await state(reopened, { operation: 'read', record_id: personalId })).output.item.value.body, value.body);
    const [row] = await db.select().from(s.appPrivateStateRecords).where(eq(s.appPrivateStateRecords.record_id, personalId));
    assert.equal(row.resource_target_key, 'personal');
    assert.equal(JSON.stringify(row.body).includes(value.body), false);
    await db.update(s.appPrivateStateRecords).set({ body: row.body, key_version: row.key_version, byte_length: row.byte_length }).where(eq(s.appPrivateStateRecords.record_id, workId));
    await deny(workExperience.path + '/state/drafts', 'POST', { operation: 'read', record_id: workId });
    await call(reopened.path, 'DELETE');
  });
  await t.test('target discovery and guessed references respect owner and tenant boundaries', async () => {
    const path = `/api/app-experiences/${installed.id}/main/targets`;
    const targets = await call(path); assert.equal(targets.schema_version, 'deft.experience_targets.v1');
    assert.deepEqual(targets.targets.map((target: { key: string }) => target.key), ['personal', 'primary', 'work']);
    assert.ok(targets.targets.every((target: { label: string }) => typeof target.label === 'string'));
    const otherTargets = await call(path, 'GET', undefined, otherSession.accessToken);
    assert.deepEqual(otherTargets.targets.map((target: { key: string }) => target.key), ['other_only']);
    await deny(path, 'GET', undefined, foreignSession.accessToken);
    await deny(`/api/app-experiences/${installed.id}/main/sessions`, 'POST', { resource_target_key: 'other_only' });
    await deny(`/api/app-experiences/${installed.id}/main/sessions`, 'POST', { resource_target_key: 'personal' }, otherSession.accessToken);
    await deny(personalExperience.path + '/resources/inbox', 'POST', list, otherSession.accessToken);
    await deny(personalExperience.path + '/resources/inbox', 'POST', list, foreignSession.accessToken);
    for (const bindingId of [otherTarget.binding.binding_id, foreignTarget.binding.binding_id]) {
      await deny('/api/apps/blob/composition/runtime/reviews/prepare', 'POST', { ...actionInput, owner_resource_binding_id: bindingId });
    }
  });
  await t.test('v1 omitted target retains primary resource and unanchored action behavior', async () => {
    const [resource] = await db.select().from(s.appResourceBindings).where(eq(s.appResourceBindings.id, primary.binding.binding_id));
    const [session] = await db.select().from(s.appExperienceSessions).where(eq(s.appExperienceSessions.id, primarySession.id));
    const [binding] = await db.select().from(s.appRuntimeBindings).where(eq(s.appRuntimeBindings.id, legacySend.binding.binding_id));
    assert.equal(resource.target_key, 'primary'); assert.equal(session.resource_target_key, 'primary'); assert.equal(binding.owner_resource_binding_id, null);
    assert.equal((await call(actionPath(primarySession) + '/context')).runtime_binding_id, legacySend.binding.binding_id);
    assert.ok((await call(primarySession.path + '/resources/inbox', 'POST', list)).output.items[0].label.startsWith('PRIVATE-TARGET-primary-'));
  });
  await t.test('persisted resource, runtime and session target linkage cannot be rewritten', async () => {
    await assert.rejects(db.update(s.appResourceBindings).set({ target_key: 'replacement' }).where(eq(s.appResourceBindings.id, personal.binding.binding_id)));
    await assert.rejects(db.update(s.appRuntimeBindings).set({ owner_resource_binding_id: work.binding.binding_id }).where(eq(s.appRuntimeBindings.id, personalSend.binding.binding_id)));
    await assert.rejects(db.update(s.appExperienceSessions).set({ resource_target_key: 'work' }).where(eq(s.appExperienceSessions.id, personalExperience.id)));
    assert.equal((await call(actionPath(personalExperience) + '/context')).runtime_binding_id, personalSend.binding.binding_id);
  });
  await t.test('one target revocation fences prepared confirmation and queued claim while the other remains readable', async () => {
    const personalQueued = await confirm(personalExperience, await prepare(personalExperience));
    const revokedTicket = await prepare(personalExperience);
    const { session } = await call(`/api/apps/blob/composition/runtime/bindings/${personalSend.binding.binding_id}/sessions`, 'POST', {});
    await call(`/api/apps/blob/sync/bindings/${personal.binding.binding_id}/revoke`, 'POST', {});
    await deny(personalExperience.path + '/human-actions/confirm', 'POST', { ticket: revokedTicket.ticket, expected_input_digest: revokedTicket.input_digest });
    await deny(personalExperience.path + '/resources/inbox', 'POST', list);
    const claim = await call('/api/app-runtime/channel/claim', 'POST', { schema_version: 'deft.app_runtime_channel.v1', session_id: session.session_id,
      max_claims: 1 }, session.session_token, 'AppRuntime'); assert.equal(claim.claim, null);
    assert.equal((await call(actionPath(workExperience) + '/context')).runtime_binding_id, workSend.binding.binding_id);
    assert.ok((await call(workExperience.path + '/resources/inbox', 'POST', list)).output.items[0].label.startsWith('PRIVATE-TARGET-work-'));
    const [run] = await db.select().from(s.appRuns).where(eq(s.appRuns.id, personalQueued.run.id));
    assert.equal(run.origin_runtime_binding_id, personalSend.binding.binding_id);
    assert.ok((await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.run_id, run.id))).every(attempt => attempt.provider_call_started_at === null));
  });
  await t.test('withdrawal after exact metadata claim fences plaintext dispatch and starts no mail provider', async () => {
    const queued = await confirm(workExperience, await prepare(workExperience));
    const { session } = await call(`/api/apps/blob/composition/runtime/bindings/${workSend.binding.binding_id}/sessions`, 'POST', {});
    const identity = { schema_version: 'deft.app_runtime_channel.v1', session_id: session.session_id };
    const { claim } = await call('/api/app-runtime/channel/claim', 'POST', { ...identity, max_claims: 1 }, session.session_token, 'AppRuntime');
    assert.ok(claim); assert.equal(claim.run_id, queued.run.id); assert.equal('input' in claim, false);
    await call(`/api/apps/blob/sync/bindings/${work.binding.binding_id}/revoke`, 'POST', {});
    const started = await request('/api/app-runtime/channel/start', 'POST', { ...identity, run_id: claim.run_id,
      attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence }, session.session_token, 'AppRuntime');
    assert.equal(started.status, 403); assert.equal(started.body.started, undefined);
    const runs = await db.select().from(s.appRuns).where(and(eq(s.appRuns.org_id, org), inArray(s.appRuns.origin_runtime_binding_id,
      [personalSend.binding.binding_id, workSend.binding.binding_id, legacySend.binding.binding_id])));
    assert.equal(runs.length, 3, 'Two legacy submissions and the draft-bound exact submission are retained');
    const attempts = await db.select().from(s.appRunAttempts).where(inArray(s.appRunAttempts.run_id, runs.map(run => run.id)));
    assert.equal(attempts.length, 3); assert.ok(attempts.every(attempt => attempt.provider_call_started_at === null));
    assert.equal((await call(actionPath(primarySession) + '/context')).runtime_binding_id, legacySend.binding.binding_id);
  });
  await t.test('legacy primary Send conflicts with another reviewed Send anchored to the same primary target', async () => {
    const input = { ...actionInput, owner_resource_binding_id: primary.binding.binding_id };
    const { review } = await call('/api/apps/blob/composition/runtime/reviews/prepare', 'POST', input);
    assert.notEqual(review.review_digest, legacySend.review.review_digest, 'Review preserves explicit target linkage');
    const activated = await request('/api/apps/blob/composition/runtime/bindings/activate', 'POST', {
      ...input, expected_review_digest: review.review_digest, accept_host_policy: true,
    });
    assert.equal(activated.status, 409, 'Legacy omitted target and an explicit primary anchor have the same effective owner target');
    assert.equal(activated.body.code, 'APP_STATE_CONFLICT');
    const bindings = await db.select().from(s.appRuntimeBindings).where(and(eq(s.appRuntimeBindings.org_id, org),
      eq(s.appRuntimeBindings.app_installation_id, installed.id), eq(s.appRuntimeBindings.action_key, 'send_message'),
      inArray(s.appRuntimeBindings.state, ['disabled', 'active'])));
    assert.equal(bindings.length, 3, 'No fourth live Send authority was created');
    assert.equal((await call(actionPath(primarySession) + '/context')).runtime_binding_id, legacySend.binding.binding_id);
  });
  await t.test('different reviewed resource anchors cannot register the same action for one effective owner target', async () => {
    const action = actions.find((candidate: any) => candidate.key === 'archive_message').review_request;
    const anchored = { ...action, owner_resource_binding_id: primary.binding.binding_id };
    const { review } = await call('/api/apps/blob/composition/runtime/reviews/prepare', 'POST', anchored);
    const { binding } = await call('/api/apps/blob/composition/runtime/bindings/activate', 'POST', {
      ...anchored, expected_review_digest: review.review_digest, accept_host_policy: true,
    });
    const alternate = { ...action, owner_resource_binding_id: secondPrimaryResource.binding.binding_id };
    const { review: alternateReview } = await call('/api/apps/blob/composition/runtime/reviews/prepare', 'POST', alternate);
    assert.notEqual(alternateReview.review_digest, review.review_digest);
    const conflict = await request('/api/apps/blob/composition/runtime/bindings/activate', 'POST', {
      ...alternate, expected_review_digest: alternateReview.review_digest, accept_host_policy: true,
    });
    assert.equal(conflict.status, 409, 'An inbox2 anchor cannot bypass the existing inbox target/action authority');
    assert.equal(conflict.body.code, 'APP_STATE_CONFLICT');
    const current = await db.select().from(s.appRuntimeBindings).where(and(eq(s.appRuntimeBindings.org_id, org),
      eq(s.appRuntimeBindings.app_installation_id, installed.id), eq(s.appRuntimeBindings.action_key, 'archive_message'),
      inArray(s.appRuntimeBindings.state, ['disabled', 'active'])));
    assert.deepEqual(current.map(row => row.id), [binding.binding_id]);
  });
  for (const boundary of ['retained input', 'committed transaction'] as const) {
    await t.test(`target consent expiring while ${boundary} is held denies exact provider input delivery`, async () => {
      const expiresAt = new Date(Date.now() + 15_000);
      const targetKey = boundary === 'retained input' ? 'read_expiring' : 'commit_expiring';
      const expiring = await consent(targetKey, owner, ownerSession.accessToken, installed.id, 'inbox', expiresAt.toISOString());
      const expiringSend = await bindAction(expiring.binding.binding_id);
      await publish(expiring.binding.binding_id, targetKey);
      const experience = await open(targetKey);
      const queued = await confirm(experience, await prepare(experience));
      const { session } = await call(`/api/apps/blob/composition/runtime/bindings/${expiringSend.binding.binding_id}/sessions`, 'POST', {});
      const identity = { schema_version: 'deft.app_runtime_channel.v1', session_id: session.session_id };
      const { claim } = await call('/api/app-runtime/channel/claim', 'POST', { ...identity, max_claims: 1 }, session.session_token, 'AppRuntime');
      assert.ok(claim); assert.equal(claim.run_id, queued.run.id); assert.equal('input' in claim, false);
      const current = await runtime.getAppRunRuntime();
      const readInput = current.secretRepository.readInput.bind(current.secretRepository);
      const transaction = current.repository.transaction.bind(current.repository);
      let entered!: () => void, release!: () => void;
      let exactInput: unknown, inputWasRead = false;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      current.secretRepository.readInput = async (...args) => {
        const exactRun = args[0] === org && args[1] === queued.run.id;
        const [dispatch] = exactRun ? await args[2]!.select({ state: s.appRunAttempts.state })
          .from(s.appRunAttempts).where(and(eq(s.appRunAttempts.org_id, org),
            eq(s.appRunAttempts.id, claim.attempt_id))).limit(1) : [];
        const deliveryRead = exactRun && dispatch?.state === 'provider_call_started';
        // The earlier payload preflight must finish before the durable marker.
        // Hold only this attempt's subsequent plaintext-delivery read.
        if (deliveryRead && boundary === 'retained input') { entered(); await held; }
        const value = await readInput(...args);
        if (deliveryRead) { exactInput = value; inputWasRead = true; }
        return value;
      };
      if (boundary === 'committed transaction') current.repository.transaction = async work => {
        // The real transaction resolves only after COMMIT. Hold only the exact
        // plaintext return, never an earlier claim or authority transaction.
        const value = await transaction(work);
        if (inputWasRead && value && typeof value === 'object' && 'exact' in value
          && value.exact === exactInput) { entered(); await held; }
        return value;
      };
      const pending = request('/api/app-runtime/channel/start', 'POST', { ...identity, run_id: claim.run_id,
        attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence }, session.session_token, 'AppRuntime');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([enteredPromise, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Exact ${boundary} boundary was not reached`)), 5_000);
        })]);
        clearTimeout(timer); timer = undefined;
        assert.ok(Date.now() < expiresAt.getTime(), 'Current target consent must still be live when the boundary is held');
        if (boundary === 'committed transaction') {
          assert.deepEqual(exactInput, input, 'The held transaction contains the exact retained input');
          const [committed] = await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.id, claim.attempt_id));
          assert.equal(committed.state, 'provider_call_started', 'The actual transaction committed before its return was held');
        }
        await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 30)));
        release();
        const denied = await pending;
        assert.equal(denied.status, 403, `An expiry during ${boundary} must fence plaintext delivery`);
        assert.equal(denied.body.code, 'APP_RUNTIME_ACCESS_DENIED');
        assert.equal(denied.body.started, undefined);
        assert.equal(JSON.stringify(denied.body).includes(input.body), false);
        const [attempt] = await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.id, claim.attempt_id));
        assert.equal(attempt.state, 'provider_call_started', 'The earlier durable dispatch marker remains honest');
        assert.ok(attempt.provider_call_started_at);
      } finally {
        if (timer) clearTimeout(timer);
        release(); current.secretRepository.readInput = readInput; current.repository.transaction = transaction;
        await pending;
      }
    });
  }
});
