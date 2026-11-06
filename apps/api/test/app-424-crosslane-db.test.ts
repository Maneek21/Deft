import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildDeftAppPackage } from '@deft/app-kit';
import * as kitCore from '@deft/app-kit/core';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';

const safe = (() => {
  const target = process.env.DEFT_TEST_DATABASE_URL;
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.search && !url.hash && /^\/deft_test/u.test(url.pathname);
  } catch { return false; }
})();

interface Ctx {
  app: any;
  db: any;
  s: any;
  d: any;
  sql: any;
  ownerWeb: any;
  org: string;
  person: string;
  installation: string;
  binding: { binding_id: string };
  resourceInput: any;
  targetKey: string;
  beginSessionId: string;
  cleanup: () => Promise<void>;
}

async function bootstrap(t: any): Promise<Ctx> {
  Object.assign(process.env, {
    DEFT_APPS_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
    DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true',
    DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_OWNER_CONNECTIONS_ENABLED: 'true',
    DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true', DEFT_PUBLIC_URL: 'https://host.example',
  });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update('crosslane:' + id).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: ring('enc'), receipt_signing: ring('sign'), fingerprint: ring('fp') });
  const directory = await mkdtemp(join(tmpdir(), 'deft-crosslane-')), configPath = join(directory, 'transport.json');
  const previousConfig = process.env.DEFT_APP_CONNECTION_HTTP_CONFIG, realFetch = globalThis.fetch;
  process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = configPath;
  const [{ Hono }, { db, closeDb }, s, d, kit, web, { authMiddleware }, { appRoutes }, owner, connectionRoutes, background, exp] = await Promise.all([
    import('hono'), import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('@deft/app-kit'),
    import('../src/lib/web-sessions.js'), import('../src/middleware/auth.js'), import('../src/routes/apps.js'), import('../src/routes/app-owner-connections.js'),
    import('../src/routes/app-connection-sessions.js'), import('../src/lib/app-runtime-background-access.js'), import('../src/routes/app-experiences.js'),
  ]);
  const complete = await (await import('./fixtures/app-run-test-keyrings.js')).databaseCompleteAppRunTestKeyringFixture('crosslane');
  process.env.DEFT_APP_RUN_KEYRINGS = complete.environment; complete.keys.destroy();
  const { and, eq, sql } = d;
  const app = new Hono(); app.use('/api/apps/*', authMiddleware); app.route('/api/apps', appRoutes);
  app.use('/api/app-runtime-management/*', authMiddleware);
  app.use('/api/app-resource-sync-management/*', authMiddleware);
  app.route('/api/app-owner-connections', owner.appOwnerConnectionRoutes); app.route('/api/app-connection-sessions', connectionRoutes.appConnectionSessionRoutes);
  app.route('/api/app-experiences', exp.appExperienceRoutes);
  // also runtime management + resource sync management routes for revoke
  const runtimeMgmt = await import('../src/routes/app-runtime-management.js');
  const resourceSyncMgmt = await import('../src/routes/app-resource-sync-management.js');
  app.route('/api/app-runtime-management', runtimeMgmt.appRuntimeManagementRoutes);
  app.route('/api/app-resource-sync-management', resourceSyncMgmt.appResourceSyncManagementRoutes);
  t.after(async () => { globalThis.fetch = realFetch; process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = previousConfig; await rm(directory, { recursive: true, force: true }); });

  const entries: any[] = [];
  const writeConfig = () => writeFile(configPath, JSON.stringify({ schema_version: 'deft.app_connection_http_registrations.v1', entries }), { mode: 0o600 });
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname !== 'runtime.example.test') return realFetch(input, init);
    const body = JSON.parse(String(init?.body));
    const account = { account_ref: 'account_' + body.scope.owner_user_id.replaceAll('-', ''), label: 'Synthetic account' };
    if (body.schema_version === 'deft.app_connection_runtime.v2') {
      if (body.operation === 'begin') return new Response(JSON.stringify({ state: 'awaiting_callback', runtime_session_ref: randomUUID(), authorization_url: 'https://provider.example/authorize' }), { headers: { 'content-type': 'application/json' } });
      if (body.operation === 'disconnect') return new Response(JSON.stringify({ state: 'disconnected' }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ state: 'connected', account }), { headers: { 'content-type': 'application/json' } });
    }
    if (body.schema_version === 'deft.app_connection_consent_continuation_runtime.v1') {
      const checked = await app.request('/api/app-connection-sessions/runtime/consent-continuation-authority', { method: 'POST', headers: { authorization: 'Bearer ' + 'a'.repeat(43), 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!checked.ok) return new Response(await checked.text(), { status: checked.status, headers: { 'content-type': 'application/json' } });
      const account = { account_ref: 'account_' + body.scope.owner_user_id.replaceAll('-', ''), label: 'Synthetic account' };
      if (body.operation === 'prepare') {
        return new Response(JSON.stringify({ schema_version: body.schema_version, session_id: body.session_id, state: 'eligible',
          account, custody_generation: 1, custody_digest: 'sha256:' + 'c'.repeat(64) }), { headers: { 'content-type': 'application/json' } });
      }
      const newRef = randomUUID();
      const receiptValue = kitCore.appConnectionConsentContinuationReceiptValue(body, body.review, newRef);
      const receiptDigest = 'sha256:' + createHash('sha256').update(kitCore.canonicalConnectionConsentContinuationJson(receiptValue)).digest('hex');
      return new Response(JSON.stringify({ schema_version: body.schema_version, session_id: body.session_id, state: 'connected',
        account, runtime_session_ref: newRef, custody_generation: 1, receipt_digest: receiptDigest }), { headers: { 'content-type': 'application/json' } });
    }
    if (body.schema_version === 'deft.app_connection_runtime.v1') {
      if (body.operation === 'disconnect') return new Response(JSON.stringify({ state: 'disconnected' }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ state: 'connected', account }), { headers: { 'content-type': 'application/json' } });
    }
    if (body.schema_version === background.CHANNEL_INSTALL_SCHEMA) {
      return new Response(JSON.stringify({ schema_version: 'deft.app_runtime_channel_install_result.v1', installed: body.channels.map((item: any) => ({ kind: item.kind, runtime_registration_id: item.channel.registration.runtime_registration_id, session_id: item.channel.credential.session_id, expires_at: item.channel.technical_renewal.expires_at })) }), { headers: { 'content-type': 'application/json' } });
    }
    throw Error('unexpected provider operation ' + body.schema_version + ' ' + body.operation);
  }) as typeof fetch;

  const call = async (path: string, token: string, value?: unknown, method?: string) => {
    const response = await app.request(path, { method: method ?? (value === undefined ? 'GET' : 'POST'), headers: { authorization: 'Bearer ' + token,
      ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const body = await response.json() as any; assert.ok(response.ok, path + ': ' + response.status + ' ' + JSON.stringify(body)); return body;
  };
  const callRaw = async (path: string, token: string, value?: unknown, method?: string) => {
    const response = await app.request(path, { method: method ?? (value === undefined ? 'GET' : 'POST'), headers: { authorization: 'Bearer ' + token,
      ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const body = await response.json() as any; return { status: response.status, body };
  };

  const org = randomUUID(), person = randomUUID();
  await db.insert(s.orgs).values({ id: org, name: 'Crosslane', slug: 'cl-' + org });
  await db.insert(s.users).values({ id: person, name: 'Synthetic owner', email: person + '@example.test' });
  await db.insert(s.orgMembers).values({ org_id: org, user_id: person, role: 'owner', is_active: true });
  const ownerWeb = await web.createWebSession({ id: person, org_id: org, email: person + '@example.test' });
  const pack = JSON.parse((await runtimeSecurityPackage()).json); pack.manifest.id = 'community.example.crosslane.a' + org.replaceAll('-', '');
  pack.manifest.record_stores = [{ schema_version: 'deft.app_record_store.v1', key: 'records', resource_key: 'inbox', runtime_requirement_key: 'sync_provider',
    max_record_bytes: 1024, max_files: 0, max_file_bytes: 1024, max_total_file_bytes: 1024 }];
  pack.manifest.owner_connections = [{ key: 'account', resource_key: 'inbox', action_keys: ['send_message'], max_consent_seconds: 86400 * 90,
    allow_until_revoked: true, provider_profile_key: 'test_provider', runtime_requirement_key: 'sync_provider' }];
  const artifact = await kit.prepareDeftExperienceArtifact('experiences/main.json', { schema_version: 'deft.experience_bundle.v3',
    worker_source: 'self.onmessage=()=>{};', entry_view: 'main', resource_keys: ['inbox'],
    action_keys: ['archive_message', 'reply_message', 'send_message'], state_keys: ['drafts', 'requests'], record_store_keys: ['records'] });
  pack.manifest.experiences = [{ key: 'main', label: 'Synthetic workspace', artifact_path: artifact.path, artifact_digest: artifact.digest,
    bridge_version: 'deft.experience_bridge.v1', renderer_version: 'deft.trusted_renderer.v1' }];
  const packageJson = (await kit.buildDeftAppPackage({ manifest: pack.manifest, artifacts: [artifact] })).json;
  const { app: installation } = await call('/api/apps/blob/composition/stage', ownerWeb.accessToken, JSON.parse(packageJson));
  const context = await call(`/api/apps/blob/composition/${installation.id}/context?app_version_id=${installation.version_id}`, ownerWeb.accessToken);
  const { review } = await call(`/api/apps/blob/composition/${installation.id}/review`, ownerWeb.accessToken, context.review_request);
  await call(`/api/apps/blob/composition/${installation.id}/activate`, ownerWeb.accessToken, { ...context.review_request, expected_review_digest: review.review_digest, accept_host_policy: true });
  const state = (await db.select().from(s.appInstallations).where(eq(s.appInstallations.id, installation.id)))[0]!;
  const [version] = await db.select().from(s.appVersions).where(eq(s.appVersions.id, state.active_version_id!));
  const [grant] = await db.select().from(s.appGrantSnapshots).where(eq(s.appGrantSnapshots.id, state.active_grant_snapshot_id!));
  entries.push({ org_id: org, installation_id: installation.id, runtime_registration_id: randomUUID(), runtime_epoch: 1, connection_protocol: 'v2',
    profile: { schema_version: 'deft.app_connection_profile.v1', key: 'test_provider', provider_id: 'test_provider', operator_user_id: person,
      runtime_requirement_key: 'sync_provider', resource_key: 'inbox', action_keys: ['send_message'], authorization_origin: 'https://provider.example', credential_custody: 'runtime', executable: false },
    endpoint: 'https://runtime.example.test/v1/connections', runtime_auth_token: 'r'.repeat(43), authority_token_sha256: 'sha256:' + createHash('sha256').update('a'.repeat(43)).digest('hex') });
  await writeConfig();
  const input = { installation_id: installation.id, policy_key: 'account', operator_user_id: person,
    limits: { max_records_per_page: 1, max_page_bytes: 65536, max_retained_records: 100, max_retained_bytes: 1048576, min_interval_seconds: 60 },
    expected_app_version_id: version!.id, expected_package_digest: version!.package_digest, expected_grant_snapshot_digest: grant!.snapshot_digest,
    expected_lifecycle_epoch: state.lifecycle_epoch, expected_grant_epoch: state.grant_epoch };
  const { review: admissionReview } = await call('/api/app-owner-connections/admissions/review', ownerWeb.accessToken, input);
  const { admission } = await call('/api/app-owner-connections/admissions/activate', ownerWeb.accessToken, { ...input, expected_review_digest: admissionReview.review_digest, accept_host_policy: true });
  const ownerContext = await call(`/api/app-owner-connections/${installation.id}/context`, ownerWeb.accessToken);
  console.log('resource_request=', JSON.stringify(ownerContext.policies[0].admission.resource_request));
  const resourceInput = { ...ownerContext.policies[0].admission.resource_request, consent_expires_at: new Date(Date.now() + 3600000).toISOString() };
  const { review: resourceReview } = await call('/api/app-owner-connections/resources/review', ownerWeb.accessToken, resourceInput);
  const { binding } = await call('/api/app-owner-connections/resources/activate', ownerWeb.accessToken, { ...resourceInput, expected_review_digest: resourceReview.review_digest, accept_host_policy: true });
  entries[0].runtime_registration_id = binding.registration_id; await writeConfig();
  const actionInput = { ...admission, owner_resource_binding_id: binding.binding_id, action_key: 'send_message' };
  const { review: actionReview } = await call('/api/app-owner-connections/actions/review', ownerWeb.accessToken, actionInput);
  await call('/api/app-owner-connections/actions/activate', ownerWeb.accessToken, { ...actionInput, expected_review_digest: actionReview.review_digest, accept_host_policy: true });
  const { web_session } = await (await import('../src/lib/app-resource-sync-web-authority.js')).resourceSyncWebAuthority('Bearer ' + ownerWeb.accessToken);
  const caller = { org_id: org, user_id: person, sid: web_session.sid, access_expires_at: web_session.expires_at };
  const begin = await call('/api/app-connection-sessions/v2/begin', ownerWeb.accessToken, { installation_id: installation.id, target_key: resourceInput.target_key });
  await call('/api/app-connection-sessions/v2/callback', ownerWeb.accessToken, { session_id: begin.session_id, state: begin.callback_state, outcome: 'authorized', code: 'synthetic-code' });
  // Upgrade the finite initial consent to until_revoked via the real continuation route.
  const contReview = await call('/api/app-connection-sessions/consent-continuation/review', ownerWeb.accessToken, {
    installation_id: installation.id, target_key: resourceInput.target_key,
    source_session_id: begin.session_id, request_id: randomUUID(),
    consent_expires_at: null, consent_lifetime: 'until_revoked',
  });
  const contActivate = await call('/api/app-connection-sessions/consent-continuation/activate', ownerWeb.accessToken, {
    session_id: contReview.session_id, review_digest: contReview.review_digest,
  });
  // update begin session id to the persistent successor
  (begin as any).session_id = contActivate.session_id;

  return {
    app, db, s, d, sql, ownerWeb, org, person, installation: installation.id, binding: { binding_id: binding.binding_id }, resourceInput,
    targetKey: resourceInput.target_key, beginSessionId: begin.session_id,
    and, eq,
    cleanup: async () => { /* noop, handled by t.after in bootstrap for fetch/env */ },
  };
}

function healthOf(targetsBody: any): any {
  return targetsBody?.targets?.[0]?.health ?? null;
}

test('scenario 1: lease lifecycle on connected account', { skip: !safe, timeout: 300000 }, async (t) => {
  const ctx = await bootstrap(t);
  const { app, db, s, d, ownerWeb, installation, targetKey, org } = ctx;
  const { and, eq, sql } = d;
  // background-access
  console.log('S1 targetKey=', JSON.stringify(targetKey), 'installation=', installation);
  const ba1 = await (async () => {
    const r = await app.request(`/api/app-connection-sessions/installations/${installation}/background-access`, { method: 'POST', headers: { authorization: 'Bearer ' + ownerWeb.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ target_key: targetKey }) });
    return { status: r.status, body: await r.json() };
  })();
  console.log('S1 BA1', ba1.status, JSON.stringify(ba1.body));
  assert.equal(ba1.status, 200);
  const t1 = await (async () => {
    const r = await app.request(`/api/app-experiences/${installation}/main/targets`, { headers: { authorization: 'Bearer ' + ownerWeb.accessToken } });
    return await r.json();
  })();
  console.log('S1 HEALTH1', JSON.stringify(healthOf(t1)));
  assert.equal(healthOf(t1)?.background?.state, 'healthy');

  // age lease past grace
  await db.transaction(async (tx: any) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.update(s.appRuntimeSessions).set({ expires_at: new Date(Date.now() - 25 * 60 * 60 * 1000), updated_at: new Date() }).where(and(eq(s.appRuntimeSessions.org_id, org), eq(s.appRuntimeSessions.renewal_lifetime, 'until_revoked')));
  });

  const t2 = await (async () => {
    const r = await app.request(`/api/app-experiences/${installation}/main/targets`, { headers: { authorization: 'Bearer ' + ownerWeb.accessToken } });
    return await r.json();
  })();
  console.log('S1 HEALTH2', JSON.stringify(healthOf(t2)));
  assert.equal(healthOf(t2)?.background?.state, 'ended');
  assert.equal(healthOf(t2)?.background?.reason, 'expired');

  // call background-access again
  const ba2 = await (async () => {
    const r = await app.request(`/api/app-connection-sessions/installations/${installation}/background-access`, { method: 'POST', headers: { authorization: 'Bearer ' + ownerWeb.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ target_key: targetKey }) });
    return { status: r.status, body: await r.json() };
  })();
  console.log('S1 BA2', ba2.status, JSON.stringify(ba2.body));
  assert.equal(ba2.status, 200);
  const t3 = await (async () => {
    const r = await app.request(`/api/app-experiences/${installation}/main/targets`, { headers: { authorization: 'Bearer ' + ownerWeb.accessToken } });
    return await r.json();
  })();
  console.log('S1 HEALTH3', JSON.stringify(healthOf(t3)));
  assert.equal(healthOf(t3)?.background?.state, 'healthy');
});

test('scenario 2: revoked lease on connected account', { skip: !safe, timeout: 300000 }, async (t) => {
  const ctx = await bootstrap(t);
  const { app, db, s, d, ownerWeb, installation, targetKey, org, person, binding } = ctx;
  const { and, eq, sql } = d;
  const ba1 = await (async () => {
    const r = await app.request(`/api/app-connection-sessions/installations/${installation}/background-access`, { method: 'POST', headers: { authorization: 'Bearer ' + ownerWeb.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ target_key: targetKey }) });
    return { status: r.status, body: await r.json() };
  })();
  console.log('S2 BA1', ba1.status, JSON.stringify(ba1.body));
  assert.equal(ba1.status, 200);

  const sessions = await db.select().from(s.appRuntimeSessions).where(and(eq(s.appRuntimeSessions.org_id, org), eq(s.appRuntimeSessions.renewal_lifetime, 'until_revoked')));
  console.log('S2 leases', sessions.length, sessions.map((x:any)=>x.id+':'+x.audience).join(','));

  // revoke action leases via runtime session route
  for (const sess of sessions.filter((x:any)=>x.audience==='app_runtime')) {
    const route = `/api/app-runtime-management/sessions/${sess.id}/revoke`;
    const r = await app.request(route, { method: 'POST', headers: { authorization: 'Bearer ' + ownerWeb.accessToken } });
    const body = await r.json();
    console.log('S2 revoke', route, r.status, JSON.stringify(body));
  }
  // revoke observation leases via registration route (empty body)
  const obsSessions = sessions.filter((x:any)=>x.audience==='app_resource_sync');
  const regIds = [...new Set(obsSessions.map((s:any)=>s.runtime_registration_id))];
  for (const rid of regIds) {
    const route = `/api/app-resource-sync-management/registrations/${rid}/revoke`;
    const r = await app.request(route, { method: 'POST', headers: { authorization: 'Bearer ' + ownerWeb.accessToken } });
    console.log('S2 revoke reg', route, r.status, JSON.stringify(await r.json()));
  }
  const rb2 = await app.request(`/api/app-resource-sync-management/bindings/${binding.binding_id}/revoke`, { method: 'POST', headers: { authorization: 'Bearer ' + ownerWeb.accessToken } });
  console.log('S2 revoke consent binding', rb2.status, JSON.stringify(await rb2.json()));

  const t1 = await (async () => {
    const r = await app.request(`/api/app-experiences/${installation}/main/targets`, { headers: { authorization: 'Bearer ' + ownerWeb.accessToken } });
    return await r.json();
  })();
  console.log('S2 HEALTH after revoke', JSON.stringify(healthOf(t1)));

  // call background-access again
  const ba2 = await (async () => {
    const r = await app.request(`/api/app-connection-sessions/installations/${installation}/background-access`, { method: 'POST', headers: { authorization: 'Bearer ' + ownerWeb.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ target_key: targetKey }) });
    return { status: r.status, body: await r.json() };
  })();
  console.log('S2 BA2', ba2.status, JSON.stringify(ba2.body));
  const t2 = await (async () => {
    const r = await app.request(`/api/app-experiences/${installation}/main/targets`, { headers: { authorization: 'Bearer ' + ownerWeb.accessToken } });
    return await r.json();
  })();
  console.log('S2 HEALTH after BA2', JSON.stringify(healthOf(t2)));
});

test('scenario 3+4: restore after reconnect', { skip: !safe, timeout: 300000 }, async (t) => {
  const ctx = await bootstrap(t);
  const { app, db, s, d, ownerWeb, installation, targetKey, beginSessionId, org } = ctx;
  const { and, eq, sql } = d;

  // background-access first
  const ba = await (async () => {
    const r = await app.request(`/api/app-connection-sessions/installations/${installation}/background-access`, { method: 'POST', headers: { authorization: 'Bearer ' + ownerWeb.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ target_key: targetKey }) });
    return { status: r.status, body: await r.json() };
  })();
  console.log('S3 BA', ba.status, JSON.stringify(ba.body));
  assert.equal(ba.status, 200);

  // disconnect through real route
  const disc = await (async () => {
    const r = await app.request('/api/app-connection-sessions/disconnect', { method: 'POST', headers: { authorization: 'Bearer ' + ownerWeb.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ session_id: beginSessionId }) });
    return { status: r.status, body: await r.json() };
  })();
  console.log('S3 DISCONNECT', disc.status, JSON.stringify(disc.body));

  // connect again
  const begin2 = await (async () => {
    const r = await app.request('/api/app-connection-sessions/v2/begin', { method: 'POST', headers: { authorization: 'Bearer ' + ownerWeb.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ installation_id: installation, target_key: targetKey }) });
    return { status: r.status, body: await r.json() };
  })();
  console.log('S3 BEGIN2', begin2.status, JSON.stringify(begin2.body));
  assert.equal(begin2.status, 200);
  const cb2 = await (async () => {
    const r = await app.request('/api/app-connection-sessions/v2/callback', { method: 'POST', headers: { authorization: 'Bearer ' + ownerWeb.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ session_id: begin2.body.session_id, state: begin2.body.callback_state, outcome: 'authorized', code: 'synthetic-code' }) });
    return { status: r.status, body: await r.json() };
  })();
  console.log('S3 CALLBACK2', cb2.status, JSON.stringify(cb2.body));
  assert.equal(cb2.status, 200);
  const newSessionId = begin2.body.session_id;

  // restore-context
  const rc = await (async () => {
    const r = await app.request(`/api/app-connection-sessions/installations/${installation}/restore-context`, { headers: { authorization: 'Bearer ' + ownerWeb.accessToken } });
    return { status: r.status, body: await r.json() };
  })();
  console.log('S3 RESTORE-CONTEXT', rc.status, 'grants=', rc.body?.grants?.length);
  assert.equal(rc.status, 200);

  // restore/review
  const rv = await (async () => {
    const r = await app.request('/api/app-connection-sessions/restore/review', { method: 'POST', headers: { authorization: 'Bearer ' + ownerWeb.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ installation_id: installation, target_key: targetKey }) });
    return { status: r.status, body: await r.json() };
  })();
  console.log('S3 RESTORE-REVIEW', rv.status, 'grants=', rv.body?.grants?.length);
  assert.equal(rv.status, 200);

  const reviewGrants = rv.body.grants as any[];
  // choose action consent grant + any preselected
  const chosen: string[] = [];
  for (const g of reviewGrants) {
    if (g.restorable && g.preselected) chosen.push(g.grant_id);
  }
  const actionGrant = reviewGrants.find((g:any) => g.kind === 'action_consent');
  if (actionGrant && !chosen.includes(actionGrant.grant_id)) chosen.push(actionGrant.grant_id);
  console.log('S3 grants', JSON.stringify(reviewGrants.map((g:any)=>({kind:g.kind,restorable:g.restorable,preselected:g.preselected,id:g.grant_id}))));
  console.log('S3 chosen', chosen.length);

  const rcAfter = await (async () => {
    const r = await app.request(`/api/app-connection-sessions/installations/${installation}/restore-context`, { headers: { authorization: 'Bearer ' + ownerWeb.accessToken } });
    return { status: r.status, body: await r.json() };
  })();
  console.log('S3 RESTORE-CONTEXT after review', rcAfter.status, 'grants=', JSON.stringify(rcAfter.body?.grants?.map((g:any)=>({kind:g.kind,restorable:g.restorable,preselected:g.preselected,id:g.grant_id}))));
  const envelope = {
    review_id: rv.body.review_id, review_digest: rv.body.review_digest,
    review_expires_at: rv.body.review_expires_at, installation_id: installation, target_key: targetKey,
  };
  const act = await (async () => {
    const r = await app.request('/api/app-connection-sessions/restore/activate', { method: 'POST', headers: { authorization: 'Bearer ' + ownerWeb.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ ...envelope, grant_ids: chosen }) });
    return { status: r.status, body: await r.json() };
  })();
  console.log('S3 RESTORE-ACTIVATE', act.status, JSON.stringify(act.body));

  // assert exactly one current connection and successor marker
  const connRows = await db.select().from(s.appConnectionSessions).where(and(eq(s.appConnectionSessions.org_id, org)));
  const connected = connRows.filter((r:any) => (r.record?.state === 'connected'));
  console.log('S3 connected sessions count', connected.length);
  // successor marker: the new session record has restore.source.session_id
  const successor = connRows.find((r:any) => r.session_id === act.body.session_id);
  console.log('S3 successor restore marker', JSON.stringify(successor?.record?.restore));
  assert.equal(connected.length, 1, 'exactly one current connection');
  assert.ok(successor?.record?.restore?.source?.session_id, 'successor marker present');

  // without calling background-access, record health
  const t1 = await (async () => {
    const r = await app.request(`/api/app-experiences/${installation}/main/targets`, { headers: { authorization: 'Bearer ' + ownerWeb.accessToken } });
    return await r.json();
  })();
  console.log('S3 HEALTH after restore (no BA)', JSON.stringify(healthOf(t1)));

  // call background-access
  const ba2 = await (async () => {
    const r = await app.request(`/api/app-connection-sessions/installations/${installation}/background-access`, { method: 'POST', headers: { authorization: 'Bearer ' + ownerWeb.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ target_key: targetKey }) });
    return { status: r.status, body: await r.json() };
  })();
  console.log('S3 BA after restore', ba2.status, JSON.stringify(ba2.body));
  const t2 = await (async () => {
    const r = await app.request(`/api/app-experiences/${installation}/main/targets`, { headers: { authorization: 'Bearer ' + ownerWeb.accessToken } });
    return await r.json();
  })();
  console.log('S3 HEALTH after BA', JSON.stringify(healthOf(t2)));

  // scenario 4: call restore-context again
  const rc2 = await (async () => {
    const r = await app.request(`/api/app-connection-sessions/installations/${installation}/restore-context`, { headers: { authorization: 'Bearer ' + ownerWeb.accessToken } });
    return { status: r.status, body: await r.json() };
  })();
  console.log('S4 RESTORE-CONTEXT2', rc2.status, 'grants=', rc2.body?.grants?.length);
  assert.equal(rc2.status, 200);
});
