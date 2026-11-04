import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildDeftAppPackage } from '@deft/app-kit';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';

const safe = (() => {
  const target = process.env.DEFT_TEST_DATABASE_URL;
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.search && !url.hash;
  } catch { return false; }
})();

test('account catalog carries owner-scoped background health and connection status', { skip: !safe, timeout: 120_000 }, async t => {
  assert.ok(safe, 'Set matching DATABASE_URL and DEFT_TEST_DATABASE_URL to the guarded disposable database');
  Object.assign(process.env, {
    DEFT_APPS_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
    DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true',
    DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_OWNER_CONNECTIONS_ENABLED: 'true',
    DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true', DEFT_PUBLIC_URL: 'https://host.example',
  });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update('targets-health:' + id).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: ring('enc'), receipt_signing: ring('sign'), fingerprint: ring('fp') });
  const directory = await mkdtemp(join(tmpdir(), 'deft-targets-health-')), configPath = join(directory, 'transport.json');
  const previousConfig = process.env.DEFT_APP_CONNECTION_HTTP_CONFIG, realFetch = globalThis.fetch;
  process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = configPath;
  const [{ Hono }, { db, closeDb }, s, d, kit, web, { authMiddleware }, { appRoutes }, owner, connectionRoutes, background] = await Promise.all([
    import('hono'), import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('@deft/app-kit'),
    import('../src/lib/web-sessions.js'), import('../src/middleware/auth.js'), import('../src/routes/apps.js'), import('../src/routes/app-owner-connections.js'),
    import('../src/routes/app-connection-sessions.js'), import('../src/lib/app-runtime-background-access.js'),
  ]);
  const complete = await (await import('./fixtures/app-run-test-keyrings.js')).databaseCompleteAppRunTestKeyringFixture('targets-health');
  process.env.DEFT_APP_RUN_KEYRINGS = complete.environment; complete.keys.destroy();
  const { and, eq } = d;
  const app = new Hono(); app.use('/api/apps/*', authMiddleware); app.route('/api/apps', appRoutes);
  app.route('/api/app-owner-connections', owner.appOwnerConnectionRoutes); app.route('/api/app-connection-sessions', connectionRoutes.appConnectionSessionRoutes);
  app.route('/api/app-experiences', (await import('../src/routes/app-experiences.js')).appExperienceRoutes);
  t.after(async () => { globalThis.fetch = realFetch; process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = previousConfig; await closeDb(); await rm(directory, { recursive: true, force: true }); });
  const entries: any[] = [];
  const writeConfig = () => writeFile(configPath, JSON.stringify({ schema_version: 'deft.app_connection_http_registrations.v1', entries }), { mode: 0o600 });
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname !== 'runtime.example.test') return realFetch(input, init);
    const body = JSON.parse(String(init?.body));
    const account = { account_ref: 'account_' + body.scope.owner_user_id.replaceAll('-', ''), label: 'Synthetic account' };
    if (body.schema_version === 'deft.app_connection_runtime.v2') {
      if (body.operation === 'begin') return new Response(JSON.stringify({ state: 'awaiting_callback', runtime_session_ref: randomUUID(), authorization_url: 'https://provider.example/authorize' }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ state: 'connected', account }), { headers: { 'content-type': 'application/json' } });
    }
    if (body.schema_version === background.CHANNEL_INSTALL_SCHEMA) {
      return new Response(JSON.stringify({ schema_version: 'deft.app_runtime_channel_install_result.v1', installed: body.channels.map((item: any) => ({ kind: item.kind, runtime_registration_id: item.channel.registration.runtime_registration_id, session_id: item.channel.credential.session_id, expires_at: item.channel.technical_renewal.expires_at })) }), { headers: { 'content-type': 'application/json' } });
    }
    throw Error('unexpected provider operation');
  }) as typeof fetch;
  const call = async (path: string, token: string, value?: unknown, method?: string) => {
    const response = await app.request(path, { method: method ?? (value === undefined ? 'GET' : 'POST'), headers: { authorization: 'Bearer ' + token,
      ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const body = await response.json() as any; assert.ok(response.ok, path + ': ' + response.status + ' ' + JSON.stringify(body)); return body;
  };
  const org = randomUUID(), person = randomUUID(), admin = randomUUID();
  await db.insert(s.orgs).values({ id: org, name: 'Targets health', slug: 'th-' + org });
  await db.insert(s.users).values([person, admin].map(id => ({ id, name: 'Synthetic owner', email: id + '@example.test' })));
  await db.insert(s.orgMembers).values([{ org_id: org, user_id: person, role: 'owner', is_active: true }, { org_id: org, user_id: admin, role: 'admin', is_active: true }]);
  const ownerWeb = await web.createWebSession({ id: person, org_id: org, email: person + '@example.test' });
  const pack = JSON.parse((await runtimeSecurityPackage()).json); pack.manifest.id = 'community.example.health.a' + org.replaceAll('-', '');
  pack.manifest.record_stores = [{ schema_version: 'deft.app_record_store.v1', key: 'mail', resource_key: 'inbox', runtime_requirement_key: 'sync_provider',
    max_record_bytes: 1024, max_files: 0, max_file_bytes: 1024, max_total_file_bytes: 1024 }];
  pack.manifest.owner_connections = [{ key: 'account', resource_key: 'inbox', action_keys: ['send_message'], max_consent_seconds: 86400 * 90,
    allow_until_revoked: true, provider_profile_key: 'test_provider', runtime_requirement_key: 'sync_provider' }];
  const artifact = await kit.prepareDeftExperienceArtifact('experiences/main.json', { schema_version: 'deft.experience_bundle.v3',
    worker_source: 'self.onmessage=()=>{};', entry_view: 'main', resource_keys: ['inbox'],
    action_keys: ['archive_message', 'reply_message', 'send_message'], state_keys: ['drafts', 'requests'], record_store_keys: ['mail'] });
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
  const [runtimeBinding] = await db.select().from(s.appRuntimeBindings).where(and(eq(s.appRuntimeBindings.org_id, org), eq(s.appRuntimeBindings.owner_resource_binding_id, binding.binding_id)));
  const [registration] = await db.select().from(s.appRuntimeRegistrations).where(eq(s.appRuntimeRegistrations.id, runtimeBinding!.runtime_registration_id));
  const installationState = (await db.select().from(s.appInstallations).where(eq(s.appInstallations.id, installation.id)))[0]!;
  // Seed the `until_revoked` background lease directly; the read-side health path
  // only inspects the runtime-session row, so full operator issuance is not needed.
  await db.transaction(async tx => {
    await tx.execute(d.sql`SET LOCAL session_replication_role = replica`);
    const now = Date.now();
    await tx.execute(d.sql`INSERT INTO app_runtime_sessions (id, org_id, runtime_registration_id, runtime_binding_id, resource_binding_id, operator_user_id, token_hash, audience, session_epoch, runtime_epoch, lifecycle_epoch, grant_epoch, next_sequence, expires_at, renewable_until, renewal_lifetime, renewal_web_session_id, renewal_operator_role, revoked_at, created_at, updated_at)
      VALUES (${randomUUID()}, ${org}, ${registration!.id}, ${runtimeBinding!.id}, NULL, ${person}, ${'sha256:' + createHash('sha256').update(randomUUID()).digest('hex')}, 'app_runtime', 0, ${registration!.runtime_epoch}, ${installationState.lifecycle_epoch}, ${installationState.grant_epoch}, 1, ${new Date(now + 3600000)}, NULL, 'until_revoked', ${caller.sid}, 'owner', NULL, ${new Date(now - 60000)}, ${new Date(now - 60000)})`);
  });

  const targets = await call(`/api/app-experiences/${installation.id}/main/targets`, ownerWeb.accessToken);
  assert.equal(targets.schema_version, 'deft.experience_targets.v1');
  assert.equal(targets.targets.length, 1);
  const target = targets.targets[0];
  assert.equal(target.key, resourceInput.target_key);
  assert.equal(target.health.connection, 'connected');
  assert.equal(target.health.background.state, 'healthy');
  assert.ok(Number.isFinite(Date.parse(target.health.background.since)));
  assert.ok(['live', 'lapsed', 'expired', 'revoked'].includes(target.health.background.reason));
});
