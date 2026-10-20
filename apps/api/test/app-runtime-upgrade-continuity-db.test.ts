import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { diffUpgradeAuthority, UPGRADE_NON_AUTHORITY_STRING_PATHS, UPGRADE_NON_AUTHORITY_DIGEST_PATHS } from '../src/lib/app-upgrade-manifest-diff.js';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = Boolean(target && target === process.env.DATABASE_URL && /(?:_test|deft_test)/.test(new URL(target).pathname));

test('trusted upgrade continuity through public Host APIs, PostgreSQL and authenticated Runtime delivery', { skip: !safe, timeout: 600000 }, async t => {
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
    DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true',
    DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_OWNER_CONNECTIONS_ENABLED: 'true',
    DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true', DEFT_PUBLIC_URL: 'https://host.example' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update('upgrade-continuity:' + id).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1', run_encryption: ring('p2-enc'),
    receipt_signing: ring('p2-sign'), fingerprint: ring('p2-fp') });
  const [{ Hono }, { db, closeDb }, s, d, kit, web, { authMiddleware }, { appRoutes }, blob, owner, connectionRoutes, observations,
    runtime, attachments, sessions, continuation, background, actionAuthority, attachmentAuthority] = await Promise.all([
    import('hono'), import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('@deft/app-kit'),
    import('../src/lib/web-sessions.js'), import('../src/middleware/auth.js'), import('../src/routes/apps.js'), import('../src/routes/app-attachments.js'),
    import('../src/routes/app-owner-connections.js'), import('../src/routes/app-connection-sessions.js'), import('../src/routes/app-resource-observations.js'),
    import('../src/lib/app-run-runtime.js'), import('../src/lib/app-attachment-runtime.js'), import('../src/lib/app-connection-session-authority.js'),
    import('../src/lib/app-connection-consent-continuation-service.js'), import('../src/lib/app-runtime-background-access.js'),
    import('../src/lib/app-runtime-authority.js'), import('../src/lib/app-attachment-sync-authority.js'),
  ]);
  await runtime.getAppRunRuntime();
  const { and, eq } = d;
  const directory = await mkdtemp(join(tmpdir(), 'deft-p2-continuity-')), configPath = join(directory, 'transport.json');
  const previousConfig = process.env.DEFT_APP_CONNECTION_HTTP_CONFIG, realFetch = globalThis.fetch;
  process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = configPath;
  const app = new Hono(); app.use('/api/apps/*', authMiddleware); app.route('/api/apps', appRoutes);
  app.route('/api/app-owner-connections', owner.appOwnerConnectionRoutes); app.route('/api/app-connection-sessions', connectionRoutes.appConnectionSessionRoutes);
  app.route('/api/app-resource-observations', observations.appResourceObservationRoutes);
  const entries: any[] = [], installed: any[] = [], dispatches: any[] = [], authorityChecks: string[] = [];
  let failDelivery = false;
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
      if (failDelivery) return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
      for (const item of body.channels) {
        const credential = item.channel.credential;
        const allowed = item.kind === 'action'
          ? await db.transaction(tx => actionAuthority.loadLiveRuntimeAuthority(tx, body.scope.org_id, credential.session_id, actionAuthority.hashAppRuntimeToken(credential.session_token), () => new Date()))
          : await db.transaction(async tx => attachmentAuthority.loadLiveAttachmentSyncAuthority(tx, { org_id: body.scope.org_id, session_id: credential.session_id,
            token_hash: (await import('../src/lib/app-attachment-policy.js')).hashAppAttachmentSessionToken(credential.session_token), clock: () => new Date() }));
        assert.ok(allowed, 'Runtime proves each delivered session against current Host authority');
        installed.push({ ...item, scope: body.scope });
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
    if (body.operation === 'prepare') return reply({ schema_version: body.schema_version, session_id: body.session_id,
      state: 'eligible', account, custody_generation: generation, custody_digest: 'sha256:' + 'c'.repeat(64) });
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
    if (stores) pack.manifest.record_stores = ['alpha', 'beta'].map(key => ({ schema_version: 'deft.app_record_store.v1', key, resource_key: 'inbox',
      runtime_requirement_key: 'sync_provider', max_record_bytes: 1024, max_files: 0, max_file_bytes: 1024, max_total_file_bytes: 1024 }));
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
    if (stores) {
      const data = new (await import('../src/lib/app-data-service.js')).AppDataService(caller, guard);
      for (const store_key of ['alpha', 'beta']) {
        const review = await data.review(connected.session_id, { store_key, expires_at: null, consent_lifetime: 'until_revoked' });
        await data.activate(connected.session_id, { store_key, consent_id: review.snapshot.consent_id, accept_host_policy: true, expected_review_digest: review.review_digest,
          expires_at: null, consent_lifetime: 'until_revoked' });
      }
    }
    if (trusted) await call(`/api/apps/${installation.id}/upgrade-trust`, adminWeb.accessToken, { trusted: true, expected_revision: 0 }, 'PUT');
    return { org, person, admin, installation, ownerWeb, adminWeb, current, manifest: pack.manifest, artifacts: pack.artifacts, connected, binding, actor, guard, caller, entry };
  };
  const upgrade = async (f: Awaited<ReturnType<typeof fixture>>, number: number, mutate?: (manifest: any) => void) => {
    const manifest = structuredClone(f.manifest); manifest.version = '9.0.' + number;
    const bundle = JSON.parse(f.artifacts[0].content);
    const artifact = await kit.prepareDeftExperienceArtifact(f.artifacts[0].path, { ...bundle, worker_source: bundle.worker_source + '\n// code release ' + number });
    manifest.experiences[0].artifact_digest = artifact.digest; mutate?.(manifest);
    const pack = await kit.buildDeftAppPackage({ manifest, artifacts: [artifact] }), prior = await f.current(), root = `/api/apps/blob/composition/${f.installation.id}/upgrade`;
    const staged = await call(root + '/stage', f.adminWeb.accessToken, { schema_version: 'deft.app_attachment_upgrade_stage.v1', package_json: pack.json, expected_lifecycle_epoch: prior.lifecycle_epoch });
    const context = await call(root + '/context?app_version_id=' + staged.app_version_id, f.adminWeb.accessToken);
    const { review } = await call(root + '/review', f.adminWeb.accessToken, context.review_request);
    const result = await call(root + '/activate', f.adminWeb.accessToken, { ...context.review_request, expected_review_digest: review.review_digest, accept_host_policy: true });
    return { result, review, prior };
  };
  await t.test('live database guard matches raw manifest authority comparison for real releases and every code pin', async () => {
    const functionRow = await db.execute<{ definition: string }>(d.sql`SELECT pg_get_functiondef('public.enforce_app_resource_binding()'::regprocedure) AS definition`);
    const definition = functionRow.rows[0]!.definition;
    const start = definition.indexOf('NOT EXISTS (\n                -- Walk both raw JSON trees.');
    assert.ok(start > 0, 'schema131 guard installed');
    const end = definition.indexOf('\n          )) )', start); assert.ok(end > start);
    const predicate = definition.slice(start, end);
    const release = (version: number | string) => JSON.parse(readFileSync(new URL('./fixtures/upgrade-authority-releases/' + version + '.manifest.json', import.meta.url), 'utf8'));
    const cases: { before: any; after: any; expected: boolean; name: string }[] = [];
    for (const [from,to] of [[17,18],[18,19],[19,20],[20,'main-pr14']] as const)
      cases.push({ before: release(from), after: release(to), expected: true, name: from + ' -> ' + to });
    const leaf = (value: any, path: string, replacement: unknown) => {
      const parts = path.slice(1).split('/').map(part => part === '*' ? '0' : part); let at = value;
      for (let index = 0; index < parts.length - 1; index++) at = at[parts[index]!] ??= parts[index + 1] === '0' ? [] : {};
      at[parts.at(-1)!] = replacement;
    };
    for (const path of [...UPGRADE_NON_AUTHORITY_STRING_PATHS, ...UPGRADE_NON_AUTHORITY_DIGEST_PATHS]) {
      const before = release(20), after = release(20), digest = path.endsWith('_digest');
      leaf(before, path, digest ? 'sha256:' + 'a'.repeat(64) : 'old'); leaf(after, path, digest ? 'sha256:' + 'b'.repeat(64) : 'new');
      cases.push({ before, after, expected: true, name: path });
      for (const bad of [null, { future_authority: true }, ['all']]) {
        const changed = structuredClone(after); leaf(changed, path, bad);
        cases.push({ before, after: changed, expected: false, name: path + ' malformed ' + JSON.stringify(bad) });
      }
    }
    for (const mutate of [(m:any) => { m.future_authority = true; }, (m:any) => { m.compatibility.permissions = ['all']; },
      (m:any) => { m.owner_connections.reverse(); }, (m:any) => { m.owner_connections[0].oauth_scopes = ['delete']; },
      (m:any) => { m.destinations = [{ origin: 'https://new.example', audience: 'public' }]; },
      (m:any) => { m.runtime_actions.push({ key: 'delete' }); }, (m:any) => { m.sync_descriptors[0].record_schema = {}; },
      (m:any) => { m.experiences[0].artifact_path = 'other.json'; }, (m:any) => { m.experiences.pop(); },
      (m:any) => { m.compatibility.host = { version: 'new' }; }, (m:any) => { m.owner_connections[0].authorization_origin = 'https://new.example'; }]) {
      const before = release(20), after = release(20); mutate(after); cases.push({ before, after, expected: false, name: 'authority/container change' });
    }
    for (const item of cases) {
      assert.equal(!diffUpgradeAuthority(item.before, item.after).requires_review, item.expected, item.name);
      const result = await db.execute<{ eligible: boolean }>(d.sql`SELECT ${d.sql.raw(predicate)} AS eligible FROM
        (SELECT ${JSON.stringify(item.before)}::jsonb manifest) prior CROSS JOIN (SELECT ${JSON.stringify(item.after)}::jsonb manifest) target`);
      assert.equal(result.rows[0]!.eligible, item.expected, 'live SQL parity: ' + item.name);
    }
    t.diagnostic(cases.length + ' raw JSON pairs agree between Host and live persistent-consent guard');
  });
  await t.test('trusted no-diff upgrade and a second upgrade keep background access with zero owner steps', async () => {
    const f = await fixture();
    const [oldBinding] = await db.select().from(s.appRuntimeBindings).where(and(eq(s.appRuntimeBindings.org_id, f.org), eq(s.appRuntimeBindings.owner_resource_binding_id, f.binding.binding_id)));
    const old = await (await import('../src/lib/app-runtime-management.js')).issueRuntimeOperatorSession(f.actor,
      oldBinding!.id, { guard: f.guard });
    assert.ok(old);
    await web.revokeWebSession(f.ownerWeb.refreshToken);
    for (const number of [1, 2]) {
      const before = installed.length, next = await upgrade(f, number);
      assert.equal(next.review.authority_carry_forward, true);
      if (next.result.upgrade_continuity?.[0]?.state !== 'installed') {
        const failures = await db.select().from(s.auditLog).where(and(eq(s.auditLog.org_id, f.org), eq(s.auditLog.action, 'app.upgrade_continuity.completed')));
        t.diagnostic(JSON.stringify(failures.map(row => row.metadata)));
      }
      assert.equal(next.result.upgrade_continuity?.[0]?.state, 'installed', JSON.stringify(next.result));
      assert.equal(installed.length - before, 2, 'successor action and observation sessions reach the Runtime');
      const current = await f.current(); assert.equal(current.lifecycle_epoch, next.prior.lifecycle_epoch + 1); assert.equal(current.grant_epoch, next.prior.grant_epoch + 1);
      assert.ok(installed.slice(before).every(item => item.scope.app_version_id === current.active_version_id));
    }
    assert.equal(await (await runtime.getAppRunRuntime()).runtimeChannel.complete({ schema_version: 'deft.app_runtime_channel.v1',
      session_id: old.session_id, session_token: old.session_token, run_id: randomUUID(), attempt_id: randomUUID(), claim_token: 'late-worker', sequence: 1,
      status: 'returned', provider_succeeded: true, output: {} }), null);
    const { getAppConnectionSessionRegistry } = await import('../src/lib/app-connection-session-registry.js');
    const state = await f.current();
    const [successor] = await db.select().from(s.appConnectionSessions).where(and(eq(s.appConnectionSessions.org_id, f.org),
      d.sql`${s.appConnectionSessions.record}->'scope'->>'app_version_id'=${state.active_version_id}`, d.sql`${s.appConnectionSessions.record}->>'state'='connected'`));
    const active = successor!.record as any;
    assert.equal((await getAppConnectionSessionRegistry()).protocol(active.scope, active.profile), 'v2');
    for (const change of ['transport', 'profile', 'protocol', 'removed']) {
      const original = structuredClone(f.entry);
      {
        if (change === 'transport') f.entry.endpoint = 'https://changed.example.test/v1/connections';
        else if (change === 'profile') f.entry.profile.authorization_origin = 'https://changed-provider.example';
        else if (change === 'protocol') f.entry.connection_protocol = 'credential_form.v1';
        else entries.length = 0;
        await writeConfig();
      }
      const registry = await getAppConnectionSessionRegistry();
      assert.throws(() => registry.protocol(active.scope, active.profile), change + ' must invalidate the successor transport alias');
      Object.assign(f.entry, original); if (!entries.length) entries.push(f.entry); await writeConfig();
    }
    await call(`/api/apps/${f.installation.id}/upgrade-trust`, f.adminWeb.accessToken, { trusted: false, expected_revision: 1 }, 'PUT');
    const untrustedRegistry = await getAppConnectionSessionRegistry();
    assert.throws(() => untrustedRegistry.protocol(active.scope, active.profile), 'disabling trust immediately closes registration aliases');
    assert.ok(authorityChecks.filter(path => path === 'reattach-authority').length >= 4, 'actual Runtime authority hook validates both prepare and activation');
    assert.equal(await db.transaction(tx => actionAuthority.loadLiveRuntimeAuthority(tx, f.org, old.session_id,
      actionAuthority.hashAppRuntimeToken(old.session_token), () => new Date())), null, 'late old-version worker has no commit/disclosure authority');
  });
  await t.test('shared operator and two private-store approvals retain their actual principals across two upgrades', async () => {
    const f = await fixture(true, true, true, true);
    for (const number of [1, 2]) {
      const before = installed.length, next = await upgrade(f, number);
      assert.equal(next.result.upgrade_continuity?.[0]?.state, 'installed', JSON.stringify(next.result));
      assert.equal(installed.length - before, 2);
      assert.ok(installed.slice(before).every(item => item.scope.operator_user_id === f.admin && item.scope.owner_user_id === f.person));
      const consents = await db.select().from(s.appDataConsents).where(and(eq(s.appDataConsents.org_id, f.org),
        eq(s.appDataConsents.connection_session_id, next.result.upgrade_continuity[0].session_id), eq(s.appDataConsents.state, 'active')));
      assert.equal(consents.length, 2); assert.ok(consents.every(row => row.expires_at === null));
    }
  });
  await t.test('untrusted upgrade retains existing manual recovery behavior', async () => {
    const f = await fixture(false), before = dispatches.length, next = await upgrade(f, 1);
    assert.equal(next.review.authority_carry_forward, false); assert.equal(next.result.upgrade_continuity, undefined);
    assert.equal(dispatches.length, before);
  });
  await t.test('effect addition requires review and carries no owner authority', async () => {
    const f = await fixture(), before = dispatches.length, next = await upgrade(f, 1, manifest => {
      manifest.private_capabilities.push({ ...manifest.private_capabilities[0], key: 'new_effect' });
      manifest.runtime_actions.push({ key: 'new_effect', label: 'New effect', capability_key: 'new_effect', runtime_requirement_key: 'mail_provider' });
    });
    assert.equal(next.review.upgrade_continuity.diff.requires_review, true); assert.equal(next.review.authority_carry_forward, false);
    assert.equal(next.result.upgrade_continuity, undefined); assert.equal(dispatches.length, before);
  });
  await t.test('added data destination requires review', async () => {
    const f = await fixture(), before = dispatches.length;
    const next = await upgrade(f, 1, manifest => { manifest.record_stores = [{ schema_version: 'deft.app_record_store.v1', key: 'extra_destination',
      resource_key: 'inbox', runtime_requirement_key: 'sync_provider', max_record_bytes: 1024, max_files: 0, max_file_bytes: 1024, max_total_file_bytes: 1024 }]; });
    assert.equal(next.review.authority_carry_forward, false); assert.equal(next.review.upgrade_continuity.diff.requires_review, true);
    assert.equal(next.result.upgrade_continuity, undefined); assert.equal(dispatches.length, before);
  });
  await t.test('unrecognized OAuth scope addition is rejected before activation', async () => {
    const f = await fixture(), prior = await f.current(), manifest = structuredClone(f.manifest);
    manifest.owner_connections[0].oauth_scopes = ['read', 'send']; manifest.version = '9.0.1';
    await assert.rejects(kit.buildDeftAppPackage({ manifest, artifacts: f.artifacts }));
    assert.equal((await f.current()).active_version_id, prior.active_version_id);
  });
  await t.test('revoked approval is never resurrected', async () => {
    const f = await fixture(); await (await attachments.getAppAttachmentRuntime()).management.revokeConsent(f.actor, f.binding.binding_id, f.guard);
    const next = await upgrade(f, 1), current = await f.current();
    assert.equal(next.result.upgrade_continuity, undefined);
    const successors = await db.select().from(s.appResourceBindings).where(and(eq(s.appResourceBindings.org_id, f.org), eq(s.appResourceBindings.app_version_id, current.active_version_id!)));
    assert.equal(successors.length, 0);
  });
  await t.test('finite consent keeps its exact deadline', async () => {
    const f = await fixture(true, false), expiry = f.connected.scope.consent_expires_at, next = await upgrade(f, 1);
    assert.equal(next.result.upgrade_continuity?.[0]?.state, 'installed', JSON.stringify(next.result));
    const [current] = await db.select().from(s.appResourceBindings).where(and(eq(s.appResourceBindings.org_id, f.org), eq(s.appResourceBindings.app_version_id, next.result.installation.active_version_id)));
    assert.equal(current!.consent_expires_at!.toISOString(), expiry); assert.equal(current!.consent_lifetime, null);
  });
  await t.test('expired finite approval is not resurrected', async () => {
    const f = await fixture(true, false, false, false, true), now = Date.now;
    try {
      Date.now = () => now() + 60000;
      const next = await upgrade(f, 1), state = await f.current();
      assert.equal(next.result.upgrade_continuity, undefined);
      const rows = await db.select().from(s.appResourceBindings).where(and(eq(s.appResourceBindings.org_id, f.org), eq(s.appResourceBindings.app_version_id, state.active_version_id!)));
      assert.equal(rows.length, 0);
    } finally { Date.now = now; }
  });
  await t.test('four concurrent trusted carry-forward authority transactions complete with the real four-connection pool', async () => {
    const f = await fixture(), next = await upgrade(f, 1);
    assert.equal(next.result.upgrade_continuity?.[0]?.state, 'installed', JSON.stringify(next.result));
    const { captureUpgradeApprovals } = await import('../src/lib/app-upgrade-trust-continuity.js');
    const { loadObservationConnection } = await import('../src/lib/app-resource-observation-authority.js');
    const { APP_DATABASE_POOL_BUDGET } = await import('../src/lib/app-database-pool-budget.js');
    assert.equal(APP_DATABASE_POOL_BUDGET.ordinary, 4);
    let entered = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => db.transaction(async tx => {
      await tx.execute(d.sql`SELECT 1`);
      if (++entered === 4) release(); await barrier;
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([(async () => {
          const captured = await captureUpgradeApprovals(tx, f.org, f.installation.id, next.result.installation.active_version_id, [f.person], f.guard);
          assert.equal(captured.length, 1);
          assert.equal(captured[0]!.source.scope.app_version_id, next.result.installation.active_version_id);
          const live = await attachmentAuthority.loadLiveAttachmentSyncBindingAuthority(tx, { org_id: f.org,
            resource_binding_id: captured[0]!.binding.id, clock: () => new Date() });
          assert.ok(live);
          const record = await loadObservationConnection(tx, live, captured[0]!.source.session_id);
          assert.equal(record.session_id, next.result.upgrade_continuity[0].session_id);
        })(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('TRUSTED_AUTHORITY_NESTED_POOL_WAIT')), 10000);
        })]);
      } finally { clearTimeout(timer!); }
    })));
    assert.equal(entered, 4); assert.ok(results.every(result => result.status === 'fulfilled'), JSON.stringify(results));
    const { getAppConnectionSessionRegistry } = await import('../src/lib/app-connection-session-registry.js');
    const [stored] = await db.select().from(s.appConnectionSessions).where(eq(s.appConnectionSessions.session_id, next.result.upgrade_continuity[0].session_id));
    const record = stored!.record as any;
    await assert.rejects(db.transaction(async tx => {
      await tx.insert(s.auditLog).values({ org_id: f.org, actor_type: 'human', actor_id: f.admin,
        action: 'app.upgrade_continuity_trust_changed', entity_type: 'app_installation', entity_id: f.installation.id,
        before_state: { trusted: true, revision: 1 }, after_state: { trusted: false, revision: 2 } });
      const explicit = await getAppConnectionSessionRegistry(tx);
      assert.throws(() => explicit.protocol(record.scope, record.profile), 'the explicit reader sees its own uncommitted trust change');
      const independent = await getAppConnectionSessionRegistry();
      assert.equal(independent.protocol(record.scope, record.profile), 'v2', 'a reader without tx keeps its independent committed-state read');
      throw Error('ROLLBACK_ISOLATION_TEST');
    }), /ROLLBACK_ISOLATION_TEST/);
  });
  await t.test('database guard rejects persistent initial activation without a live trust proof', async () => {
    const f = await fixture(false, false);
    const [source] = await db.select().from(s.appResourceBindings).where(eq(s.appResourceBindings.id, f.binding.binding_id));
    await assert.rejects(db.transaction(async tx => {
      const id = randomUUID();
      await tx.insert(s.appResourceBindings).values({ ...source!, id, target_key: 'unauthorized', state: 'disabled', reviewed_by_user_id: null,
        reviewed_at: null, consent_expires_at: null, consent_lifetime: null });
      await tx.update(s.appResourceBindings).set({ state: 'active', reviewed_by_user_id: f.person, reviewed_at: new Date(), consent_lifetime: 'until_revoked' })
        .where(eq(s.appResourceBindings.id, id));
    }), error => /APP_RESOURCE_BINDING_REVIEW_INVALID/.test(String((error as any).cause?.message ?? error)));
  });
  await t.test('delivery failure leaves a connected successor available to existing one-click recovery', async () => {
    const f = await fixture(); failDelivery = true;
    try { const next = await upgrade(f, 1); assert.equal(next.result.upgrade_continuity[0].state, 'recovery_required');
      const [record] = await db.select().from(s.appConnectionSessions).where(and(eq(s.appConnectionSessions.org_id, f.org), eq(s.appConnectionSessions.session_id, next.result.upgrade_continuity[0].session_id)));
      assert.equal(record!.record.state, 'connected');
    } finally { failDelivery = false; }
  });
});
