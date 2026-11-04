import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = Boolean(target && target === process.env.DATABASE_URL && ['127.0.0.1','localhost'].includes(new URL(target).hostname) && new URL(target).port === '55440' && /(?:fix_a_|probe_|deft_test)/.test(new URL(target).pathname));

test('full-schema grace resume and authority denials', { skip: !safe, timeout: 600000 }, async t => {
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
    DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true',
    DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_OWNER_CONNECTIONS_ENABLED: 'true',
    DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true', DEFT_PUBLIC_URL: 'https://host.example' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update('upgrade-continuity:' + id).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1', run_encryption: ring('p2-enc'),
    receipt_signing: ring('p2-sign'), fingerprint: ring('p2-fp') });
  const [{ Hono }, { db, closeDb }, s, d, kit, web, { authMiddleware }, { appRoutes }, blob, owner, connectionRoutes, observations,
    runtime, attachments, continuation, background, actionAuthority] = await Promise.all([
    import('hono'), import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('@deft/app-kit'),
    import('../src/lib/web-sessions.js'), import('../src/middleware/auth.js'), import('../src/routes/apps.js'), import('../src/routes/app-attachments.js'),
    import('../src/routes/app-owner-connections.js'), import('../src/routes/app-connection-sessions.js'), import('../src/routes/app-resource-observations.js'),
    import('../src/lib/app-run-runtime.js'), import('../src/lib/app-attachment-runtime.js'),
    import('../src/lib/app-connection-consent-continuation-service.js'), import('../src/lib/app-runtime-background-access.js'),
    import('../src/lib/app-runtime-authority.js'),
  ]);
  const complete = await (await import('./fixtures/app-run-test-keyrings.js')).databaseCompleteAppRunTestKeyringFixture('grace-renewal');
  process.env.DEFT_APP_RUN_KEYRINGS = complete.environment; complete.keys.destroy();
  await runtime.getAppRunRuntime();
  const { and, eq } = d;
  const directory = await mkdtemp(join(tmpdir(), 'deft-p2-continuity-')), configPath = join(directory, 'transport.json');
  const previousConfig = process.env.DEFT_APP_CONNECTION_HTTP_CONFIG, realFetch = globalThis.fetch;
  process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = configPath;
  const app = new Hono(); app.route('/api/apps/blob', blob.appAttachmentRoutes);
  app.route('/api/app-runtime/channel', (await import('../src/routes/app-runtime-channel.js')).appRuntimeChannelRoutes); app.use('/api/apps/*', authMiddleware); app.route('/api/apps', appRoutes);
  app.route('/api/app-owner-connections', owner.appOwnerConnectionRoutes); app.route('/api/app-connection-sessions', connectionRoutes.appConnectionSessionRoutes);
  app.route('/api/app-resource-observations', observations.appResourceObservationRoutes);
  app.route('/api/app-experiences', (await import('../src/routes/app-experiences.js')).appExperienceRoutes);
  const entries: any[] = [], dispatches: any[] = [], authorityChecks: string[] = [];
  const preparedReplies=new Map<string,any>();
  const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(kit.canonicalConnectionReattachmentJson(value)).digest('hex');
  const generations = new Map<string, number>();
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'runtime.example.test') return realFetch(input, init);
    const body = JSON.parse(String(init?.body)), account = { account_ref: 'account_' + body.scope.owner_user_id.replaceAll('-', ''), label: 'Synthetic account' };
    assert.equal((init?.headers as Record<string,string>).Authorization, 'Bearer ' + 'r'.repeat(43));
    dispatches.push({ schema: body.schema_version, operation: body.operation, scope: body.scope });
    const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (body.schema_version === background.CHANNEL_INSTALL_SCHEMA) {
      const pool = db.$client as unknown as { totalCount: number; idleCount: number };
      assert.equal(pool.totalCount - pool.idleCount, 0, 'successor issuance commits before the Runtime delivery network call');
      for (const item of body.channels) {
        const credential = item.channel.credential;
        const allowed = item.kind === 'action'
          ? await db.transaction(tx => actionAuthority.loadLiveRuntimeAuthority(tx, body.scope.org_id, credential.session_id, actionAuthority.hashAppRuntimeToken(credential.session_token), () => new Date()))
          : true;
        assert.ok(allowed, 'Runtime proves each delivered session against current Host authority');
      }
      return reply({ schema_version: 'deft.app_runtime_channel_install_result.v1', installed: body.channels.map((item: any) => ({ kind: item.kind,
        runtime_registration_id: item.channel.registration.runtime_registration_id, session_id: item.channel.credential.session_id, expires_at: item.channel.technical_renewal.expires_at })) });
    }
    if (body.schema_version === 'deft.app_connection_runtime.v2') {
      if (body.operation === 'begin') { generations.set(account.account_ref, 1); return reply({ state: 'awaiting_callback', runtime_session_ref: randomUUID(), authorization_url: 'https://provider.example/authorize' }); }
      return reply({ state: 'connected', account });
    }
    const reattach = body.schema_version === 'deft.app_connection_reattach_runtime.v2';
    assert.ok(reattach || body.schema_version === 'deft.app_connection_consent_continuation_runtime.v1');
    const path = reattach ? 'reattach-authority' : 'consent-continuation-authority';
    const checked = await app.request('/api/app-connection-sessions/runtime/' + path, { method: 'POST', headers: {
      authorization: 'Bearer ' + 'a'.repeat(43), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const verdict = await checked.json() as any;
    assert.equal(checked.status, 200, JSON.stringify(verdict)); authorityChecks.push(path);
    const generation = generations.get(account.account_ref) ?? 1;
    if (body.operation === 'prepare') {
      const eligible={schema_version:body.schema_version,session_id:body.session_id,state:'eligible',account,custody_generation:generation,custody_digest:'sha256:'+'c'.repeat(64)};
      if(reattach){preparedReplies.set(body.session_id,eligible);}
      return reply(eligible);
    }
    if(reattach&&body.operation==='status'&&preparedReplies.has(body.session_id))return reply(preparedReplies.get(body.session_id));
    if(reattach&&body.operation==='activate')preparedReplies.delete(body.session_id);
    const runtime_session_ref = randomUUID(), custody_generation = reattach ? generation + 1 : generation;
    const result: any = { schema_version: body.schema_version, session_id: body.session_id, state: 'connected', account, runtime_session_ref, custody_generation, receipt_digest: 'sha256:' + '0'.repeat(64) };
    if (reattach) {
      const [stored] = await db.select().from(s.appConnectionSessions).where(and(eq(s.appConnectionSessions.org_id, body.scope.org_id), eq(s.appConnectionSessions.session_id, body.session_id)));
      result.receipt_digest = (await import('../src/lib/app-connection-reattachment-service.js')).connectionReattachmentReceiptDigest(stored!.record as any, result);
      generations.set(account.account_ref, custody_generation);
    } else result.receipt_digest = digest(kit.appConnectionConsentContinuationReceiptValue(body, body.review, runtime_session_ref));
    return reply(result);
  }) as typeof fetch;
  t.after(async () => { globalThis.fetch = realFetch; process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = previousConfig;
    await attachments.shutdownAppAttachmentRuntime(); await runtime.shutdownAppRunRuntime(); await closeDb(); await rm(directory, { recursive: true, force: true }); });
  const writeConfig = () => writeFile(configPath, JSON.stringify({ schema_version: 'deft.app_connection_http_registrations.v1', entries }), { mode: 0o600 });
  const call = async (path: string, token: string, value?: unknown, method?: string) => {
    const response = await app.request(path, { method: method ?? (value === undefined ? 'GET' : 'POST'), headers: { authorization: 'Bearer ' + token,
      ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const body = await response.json() as any; assert.ok(response.ok, path + ': ' + response.status + ' ' + JSON.stringify(body)); return body;
  };
  const fixture = async (trusted = true, persistent = true, shared = false, stores = false, shortConsent = false) => {
    entries.length = 0;
    const org = randomUUID(), person = randomUUID(), admin = randomUUID();
    await db.insert(s.orgs).values({ id: org, name: 'Upgrade continuity', slug: 'p2-' + org });
    await db.insert(s.users).values([person, admin].map(id => ({ id, name: 'Synthetic owner', email: id + '@example.test' })));
    await db.insert(s.orgMembers).values([{ org_id: org, user_id: person, role: 'owner', is_active: true }, { org_id: org, user_id: admin, role: 'admin', is_active: true }]);
    const ownerWeb = await web.createWebSession({ id: person, org_id: org, email: person + '@example.test' });
    const adminWeb = await web.createWebSession({ id: admin, org_id: org, email: admin + '@example.test' });
    const pack = JSON.parse((await runtimeSecurityPackage()).json); pack.manifest.id = 'community.example.continuity.a' + org.replaceAll('-', '');
    const operatorId = shared ? admin : person;
    pack.manifest.owner_connections = [{ key: 'account', resource_key: 'inbox', action_keys: ['send_message'], max_consent_seconds: 86400 * 90,
      allow_until_revoked: true, provider_profile_key: 'test_provider', runtime_requirement_key: 'sync_provider' }];
    const packageJson = (await kit.buildDeftAppPackage({ manifest: pack.manifest, artifacts: pack.artifacts })).json;
    const { app: installation } = await call('/api/apps/blob/composition/stage', adminWeb.accessToken, JSON.parse(packageJson));
    const context = await call(`/api/apps/blob/composition/${installation.id}/context?app_version_id=${installation.version_id}`, adminWeb.accessToken);
    const { review } = await call(`/api/apps/blob/composition/${installation.id}/review`, adminWeb.accessToken, context.review_request);
    await call(`/api/apps/blob/composition/${installation.id}/activate`, adminWeb.accessToken, { ...context.review_request, expected_review_digest: review.review_digest, accept_host_policy: true });
    const current = async () => (await db.select().from(s.appInstallations).where(eq(s.appInstallations.id, installation.id)))[0]!;
    const state = await current(), [version] = await db.select().from(s.appVersions).where(eq(s.appVersions.id, state.active_version_id!)),
      [grant] = await db.select().from(s.appGrantSnapshots).where(eq(s.appGrantSnapshots.id, state.active_grant_snapshot_id!));
    const entry = { org_id: org, installation_id: installation.id, runtime_registration_id: randomUUID(), runtime_epoch: 1, connection_protocol: 'v2',
      profile: { schema_version: 'deft.app_connection_profile.v1', key: 'test_provider', provider_id: 'test_provider', operator_user_id: operatorId,
        runtime_requirement_key: 'sync_provider', resource_key: 'inbox', action_keys: ['send_message'], authorization_origin: 'https://provider.example', credential_custody: 'runtime', executable: false },
      endpoint: 'https://runtime.example.test/v1/connections', runtime_auth_token: 'r'.repeat(43), authority_token_sha256: 'sha256:' + createHash('sha256').update('a'.repeat(43)).digest('hex') };
    entries.push(entry); await writeConfig();
    const input = { installation_id: installation.id, policy_key: 'account', operator_user_id: operatorId,
      limits: { max_records_per_page: 1, max_page_bytes: 65536, max_retained_records: 100, max_retained_bytes: 1048576, min_interval_seconds: 60 },
      expected_app_version_id: version!.id, expected_package_digest: version!.package_digest, expected_grant_snapshot_digest: grant!.snapshot_digest,
      expected_lifecycle_epoch: state.lifecycle_epoch, expected_grant_epoch: state.grant_epoch };
    const { review: admissionReview } = await call('/api/app-owner-connections/admissions/review', adminWeb.accessToken, input);
    const { admission } = await call('/api/app-owner-connections/admissions/activate', adminWeb.accessToken, { ...input, expected_review_digest: admissionReview.review_digest, accept_host_policy: true });
    const ownerContext = await call(`/api/app-owner-connections/${installation.id}/context`, ownerWeb.accessToken);
    const resourceInput = { ...ownerContext.policies[0].admission.resource_request, consent_expires_at: new Date(Date.now() + (shortConsent ? 30000 : 3600000)).toISOString() };
    const { review: resourceReview } = await call('/api/app-owner-connections/resources/review', ownerWeb.accessToken, resourceInput);
    const { binding } = await call('/api/app-owner-connections/resources/activate', ownerWeb.accessToken, { ...resourceInput, expected_review_digest: resourceReview.review_digest, accept_host_policy: true });
    entry.runtime_registration_id = binding.registration_id; await writeConfig();
    const actionInput = { ...admission, owner_resource_binding_id: binding.binding_id, action_key: 'send_message' };
    const { review: actionReview } = await call('/api/app-owner-connections/actions/review', ownerWeb.accessToken, actionInput);
    await call('/api/app-owner-connections/actions/activate', ownerWeb.accessToken, { ...actionInput, expected_review_digest: actionReview.review_digest, accept_host_policy: true });
    const { actor, guard, web_session } = await (await import('../src/lib/app-resource-sync-web-authority.js')).resourceSyncWebAuthority('Bearer ' + ownerWeb.accessToken);
    const caller = { org_id: org, user_id: person, sid: web_session.sid, access_expires_at: web_session.expires_at };
    const begin = await call('/api/app-connection-sessions/v2/begin', ownerWeb.accessToken,
      { installation_id: installation.id, target_key: resourceInput.target_key });
    let connected: any = await call('/api/app-connection-sessions/v2/callback', ownerWeb.accessToken,
      { session_id: begin.session_id, state: begin.callback_state, outcome: 'authorized', code: 'synthetic-code' });
    if (persistent) {
      const continuationService = new continuation.AppConnectionConsentContinuationService(caller, guard);
      const reviewed = await continuationService.review({ installation_id: installation.id, target_key: resourceInput.target_key, source_session_id: connected.session_id,
        request_id: randomUUID(), consent_expires_at: null, consent_lifetime: 'until_revoked' });
      connected = await continuationService.activate({ session_id: reviewed.session_id, review_digest: reviewed.review_digest });

    }
    const observationService = new (await import('../src/lib/app-resource-observation-service.js')).AppResourceObservationService();
    const observation = await observationService.review(actor, { connection_session_id: connected.session_id, request_id: randomUUID(), interval_seconds: 60,
      expires_at: persistent ? null : resourceInput.consent_expires_at, ...(persistent ? { consent_lifetime: 'until_revoked' } : {}) }, guard);
    await observationService.activate(actor, { consent_id: observation.consent_id, review_digest: observation.review_digest }, guard);
    if (trusted) await call(`/api/apps/${installation.id}/upgrade-trust`, adminWeb.accessToken, { trusted: true, expected_revision: 0 }, 'PUT');
    return { org, person, admin, installation, ownerWeb, adminWeb, current, manifest: pack.manifest, artifacts: pack.artifacts, connected, binding, actor, guard, caller, entry };
  };
  // Ordinary public setup above creates the exact owner/admission/continuation
  // authority. The only fixture bypass below simulates time passage or changes
  // to our own synthetic authority rows; all application calls run with every
  // database trigger enabled. No schema, trigger, or other tenant is changed.
  const f = await fixture(false);
  const management = await import('../src/lib/app-runtime-management.js');
  const [actionBinding] = await db.select().from(s.appRuntimeBindings).where(and(
    eq(s.appRuntimeBindings.org_id, f.org), eq(s.appRuntimeBindings.owner_resource_binding_id, f.binding.binding_id)));
  assert.ok(actionBinding);
  const bypassFixture = (work: (tx: typeof db) => Promise<unknown>) => db.transaction(async tx => {
    await tx.execute(d.sql`SET LOCAL session_replication_role = replica`);
    await work(tx as unknown as typeof db);
  });
  const issue = async (persistent = true) => {
    const session = await management.issueRuntimeOperatorSession(f.actor, actionBinding.id, { guard: f.guard,
      technical_renewal: { requested_until: persistent ? null : new Date(Date.now() + 3600000), sid: f.caller.sid,
        ...(persistent ? { renewal_lifetime: 'until_revoked' as const } : {}) } });
    assert.ok(session);
    return session;
  };
  const age = async (session: Awaited<ReturnType<typeof issue>>, gap: number) => {
    const expiry = new Date(Date.now() - gap), created = new Date(expiry.getTime() - 900000);
    await bypassFixture(async tx => tx.update(s.appRuntimeSessions).set({ expires_at: expiry, created_at: created,
      updated_at: created }).where(and(eq(s.appRuntimeSessions.org_id, f.org), eq(s.appRuntimeSessions.id, session.session_id))));
    return { ...session, expires_at: expiry };
  };
  const renew = async (session: Awaited<ReturnType<typeof issue>>, token = session.session_token) => {
    const response = await app.request('/api/app-runtime/channel/renew', { method: 'POST', headers: {
      authorization: 'AppRuntime ' + token, 'content-type': 'application/json' }, body: JSON.stringify({
      schema_version: 'deft.app_runtime_channel.v1', session_id: session.session_id, expected_expires_at: session.expires_at.toISOString() }) });
    return { status: response.status, body: await response.json() as any };
  };
  const countAudits = async (id: string) => (await db.select().from(s.auditLog).where(and(
    eq(s.auditLog.org_id, f.org), eq(s.auditLog.entity_id, id), eq(s.auditLog.action, 'runtime_session_resumed')))).length;
  await t.test('live persistent renewal keeps the same session and rolling 15-minute ceiling', async () => {
    const session = await issue(), start = Date.now(), result = await renew(session);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.renewed.session_id, session.session_id);
    assert.equal(result.body.renewed.renewal_lifetime, 'until_revoked');
    assert.ok(Date.parse(result.body.renewed.expires_at) <= Date.now() + 900000);
    assert.ok(Date.parse(result.body.renewed.expires_at) >= start);
    assert.equal(await countAudits(session.session_id), 0);
  });
  await t.test('20 minutes after expiry resumes through HTTP and commits exactly one audit', async () => {
    const session = await age(await issue(), 20 * 60000), before = Date.now();
    const result = await renew(session);
    let databaseError: unknown;
    if (result.status === 500) {
      try { await actionAuthority.renewAppRuntimeSession({ session_id: session.session_id, session_token: session.session_token,
        expected_expires_at: session.expires_at.toISOString() }); }
      catch (error: any) { databaseError = { code: error.cause?.code ?? error.code, message: error.cause?.message }; }
    }
    assert.equal(result.status, 200, JSON.stringify({ body: result.body, database_error: databaseError }));
    assert.equal(result.body.renewed.session_id, session.session_id);
    assert.ok(Date.parse(result.body.renewed.expires_at) > before);
    assert.ok(Date.parse(result.body.renewed.expires_at) <= Date.now() + 900000);
    const audits = await db.select().from(s.auditLog).where(and(eq(s.auditLog.org_id, f.org),
      eq(s.auditLog.entity_id, session.session_id), eq(s.auditLog.action, 'runtime_session_resumed')));
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.entity_type, 'app_runtime_session');
    assert.ok((audits[0]!.metadata as { gap_ms: number }).gap_ms >= 20 * 60000);
    assert.equal((await renew(session)).status, 200, 'lost ACK is idempotent');
    assert.equal(await countAudits(session.session_id), 1);
  });
  const denied = async (session: Awaited<ReturnType<typeof issue>>, token?: string) => {
    const before = await db.select().from(s.appRuntimeSessions).where(eq(s.appRuntimeSessions.id, session.session_id));
    const result = await renew(session, token);
    assert.equal(result.status, 403, JSON.stringify(result.body));
    assert.equal(result.body.code, 'APP_RUNTIME_ACCESS_DENIED');
    assert.equal(await countAudits(session.session_id), 0);
    const after = await db.select().from(s.appRuntimeSessions).where(eq(s.appRuntimeSessions.id, session.session_id));
    assert.deepEqual(after, before, 'refusal does not mutate the session');
  };
  await t.test('25 hours after expiry is refused', async () => denied(await age(await issue(), 25 * 3600000)));
  await t.test('wrong credential inside the grace period is refused', async () => denied(await age(await issue(), 20 * 60000), 'x'.repeat(43)));
  await t.test('finite renewal cannot resume', async () => denied(await age(await issue(false), 20 * 60000)));
  await t.test('revoked runtime session cannot resume', async () => {
    const session = await age(await issue(), 20 * 60000);
    await db.update(s.appRuntimeSessions).set({ revoked_at: new Date() }).where(eq(s.appRuntimeSessions.id, session.session_id));
    await denied(session);
  });
  const [originalInstallation] = await db.select().from(s.appInstallations).where(eq(s.appInstallations.id, f.installation.id));
  const changes = [
    ['grant epoch changed', async (tx: typeof db) => tx.update(s.appInstallations).set({ grant_epoch: originalInstallation!.grant_epoch + 1 }).where(eq(s.appInstallations.id, f.installation.id)),
      async (tx: typeof db) => tx.update(s.appInstallations).set({ grant_epoch: originalInstallation!.grant_epoch }).where(eq(s.appInstallations.id, f.installation.id))],
    ['binding revoked', async (tx: typeof db) => tx.update(s.appRuntimeBindings).set({ state: 'revoked', revoked_at: new Date() }).where(eq(s.appRuntimeBindings.id, actionBinding.id)),
      async (tx: typeof db) => tx.update(s.appRuntimeBindings).set({ state: actionBinding.state, revoked_at: actionBinding.revoked_at }).where(eq(s.appRuntimeBindings.id, actionBinding.id))],
    ['org membership removed', async (tx: typeof db) => tx.update(s.orgMembers).set({ is_active: false }).where(and(eq(s.orgMembers.org_id, f.org), eq(s.orgMembers.user_id, f.person))),
      async (tx: typeof db) => tx.update(s.orgMembers).set({ is_active: true }).where(and(eq(s.orgMembers.org_id, f.org), eq(s.orgMembers.user_id, f.person)))],
    ['app version changed', async (tx: typeof db) => tx.update(s.appInstallations).set({ active_version_id: randomUUID() }).where(eq(s.appInstallations.id, f.installation.id)),
      async (tx: typeof db) => tx.update(s.appInstallations).set({ active_version_id: originalInstallation!.active_version_id }).where(eq(s.appInstallations.id, f.installation.id))],
  ] as const;
  for (const [name, change, restore] of changes) await t.test(name + ' refuses resume', async () => {
    const session = await age(await issue(), 20 * 60000);
    try { await bypassFixture(change); await denied(session); } finally { await bypassFixture(restore); }
  });
  await t.test('ended owner consent refuses resume', async () => {
    const session = await age(await issue(), 20 * 60000);
    const [binding] = await db.select().from(s.appResourceBindings).where(eq(s.appResourceBindings.id, f.binding.binding_id));
    try {
      await bypassFixture(async tx => tx.update(s.appResourceBindings).set({ consent_lifetime: null,
        consent_expires_at: new Date(Date.now() - 1) }).where(eq(s.appResourceBindings.id, f.binding.binding_id)));
      await denied(session);
    } finally { await bypassFixture(async tx => tx.update(s.appResourceBindings).set({ consent_lifetime: binding!.consent_lifetime,
      consent_expires_at: binding!.consent_expires_at }).where(eq(s.appResourceBindings.id, f.binding.binding_id))); }
  });
  await t.test('deadline helper caps a resumed lease at the owner target deadline', async () => {
    const { runtimeResumeDeadline } = await import('../src/lib/app-runtime-renewal.js');
    const now = new Date(), expired = new Date(now.getTime() - 1200000), deadline = new Date(now.getTime() + 60000);
    assert.equal(runtimeResumeDeadline({ now, current_expires_at: expired, expected_expires_at: expired, target_expires_at: deadline })?.toISOString(), deadline.toISOString());
    assert.equal(runtimeResumeDeadline({ now, current_expires_at: expired, expected_expires_at: expired, target_expires_at: new Date(now.getTime() - 1) }), null);
  });
});
