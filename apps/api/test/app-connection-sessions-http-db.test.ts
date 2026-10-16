import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDeftAppPackage } from '@deft/app-kit';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';

function disposableDatabase() {
  const target = process.env.DEFT_E2_TEST_DATABASE_URL;
  if (!target || target !== process.env.DATABASE_URL) return false;
  try { const url = new URL(target); return ['postgres:', 'postgresql:'].includes(url.protocol)
    && url.hostname === '127.0.0.1' && url.port === '33954' && url.username === 'e2_connection_test'
    && url.pathname === '/e2_connection_test' && !url.search && !url.hash; } catch { return false; }
}

test('public production routes bind reviewed profile, real owner admission/PG sessions and runtime introspection',
  { skip: !disposableDatabase(), timeout: 120000 }, async t => {
    Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
      DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true',
      DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
      DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true', DEFT_APP_OWNER_CONNECTIONS_ENABLED: 'true' });
    const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update('synthetic-e2-' + id).digest('base64') } });
    process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
      run_encryption: ring('enc'), receipt_signing: ring('sign'), fingerprint: ring('fingerprint') });
    const [{ Hono }, { db, closeDb }, s, { and, eq }, web, owner, blob, connections, runtime, attachments] = await Promise.all([
      import('hono'), import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('../src/lib/web-sessions.js'),
      import('../src/routes/app-owner-connections.js'), import('../src/routes/app-attachments.js'), import('../src/routes/app-connection-sessions.js'),
      import('../src/lib/app-run-runtime.js'), import('../src/lib/app-attachment-runtime.js')]);
    const app = new Hono(); app.route('/api/apps/blob', blob.appAttachmentRoutes);
    app.route('/api/app-owner-connections', owner.appOwnerConnectionRoutes);
    app.route('/api/app-connection-sessions', connections.appConnectionSessionRoutes);
    const directory = await mkdtemp(join(tmpdir(), 'deft-e2-session-test-'));
    const configPath = join(directory, 'reviewed-http.json'), previousConfig = process.env.DEFT_APP_CONNECTION_HTTP_CONFIG;
    const realFetch = globalThis.fetch;
    t.after(async () => { globalThis.fetch = realFetch;
      if (previousConfig === undefined) delete process.env.DEFT_APP_CONNECTION_HTTP_CONFIG; else process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = previousConfig;
      await rm(directory, { recursive: true, force: true });
      await attachments.shutdownAppAttachmentRuntime(); await runtime.shutdownAppRunRuntime(); await closeDb(); });
    process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = configPath;
    const org = randomUUID(), people = { owner: randomUUID(), member: randomUUID(), other: randomUUID() };
    await db.insert(s.orgs).values({ id: org, name: 'Synthetic E2 HTTP', slug: 'e2-http-' + org });
    const tokens: Record<string, string> = {};
    for (const [role, id] of Object.entries(people)) {
      const email = 'e2-http-' + id + '@example.test';
      await db.insert(s.users).values({ id, name: role, email, kind: 'human', is_agent: false });
      await db.insert(s.orgMembers).values({ id: randomUUID(), org_id: org, user_id: id, role: role === 'owner' ? 'owner' : 'member', is_active: true });
      tokens[role] = (await web.createWebSession({ id, org_id: org, email })).accessToken;
    }
    const request = async (path: string, value?: unknown, token = tokens.owner!, method = value === undefined ? 'GET' : 'POST') => {
      const response = await app.request(path, { method, headers: { authorization: 'Bearer ' + token,
        ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      return { status: response.status, body: await response.json() as any, headers: response.headers };
    };
    const call = async (...args: Parameters<typeof request>) => {
      const response = await request(...args); assert.ok(response.status >= 200 && response.status < 300,
        `${args[0]} HTTP${response.status} ${response.body.code ?? ''}`); return response.body;
    };
    const fixture = JSON.parse((await runtimeSecurityPackage()).json);
    fixture.manifest.id = 'community.example.e2session.a' + org.replaceAll('-', '');
    fixture.manifest.owner_connections = [{ key: 'mailbox', resource_key: 'inbox', action_keys: ['send_message'],
      max_consent_seconds: 86400, provider_profile_key: 'google_mail', runtime_requirement_key: 'sync_provider' }];
    const packed = (await buildDeftAppPackage({ manifest: fixture.manifest, artifacts: fixture.artifacts })).json;
    const { app: installed } = await call('/api/apps/blob/composition/stage', JSON.parse(packed));
    const installContext = await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);
    const { review: installReview } = await call(`/api/apps/blob/composition/${installed.id}/review`, installContext.review_request);
    await call(`/api/apps/blob/composition/${installed.id}/activate`, { ...installContext.review_request,
      expected_review_digest: installReview.review_digest, accept_host_policy: true });
    const [installation] = await db.select().from(s.appInstallations).where(eq(s.appInstallations.id, installed.id));
    const [version] = await db.select().from(s.appVersions).where(eq(s.appVersions.id, installation!.active_version_id!));
    const [grant] = await db.select().from(s.appGrantSnapshots).where(eq(s.appGrantSnapshots.id, installation!.active_grant_snapshot_id!));
    const profile = { schema_version: 'deft.app_connection_profile.v1', key: 'google_mail', provider_id: 'google_mail',
      operator_user_id: people.owner, runtime_requirement_key: 'sync_provider', resource_key: 'inbox', action_keys: ['send_message'],
      authorization_origin: 'https://accounts.google.com', credential_custody: 'runtime', executable: false };
    const authorityToken = 'a'.repeat(43), runtimeToken = 'b'.repeat(43);
    let entry = { org_id: org, installation_id: installed.id, runtime_registration_id: randomUUID(), runtime_epoch: 1, profile,
      endpoint: 'https://synthetic-runtime.example.test/v1/connections', runtime_auth_token: runtimeToken,
      authority_token_sha256: 'sha256:' + createHash('sha256').update(authorityToken).digest('hex') };
    const writeConfig = async () => writeFile(configPath, JSON.stringify({ schema_version: 'deft.app_connection_http_registrations.v1', entries: [entry] }), { mode: 0o600 });
    await writeConfig();
    const admissionInput = { installation_id: installed.id, policy_key: 'mailbox', operator_user_id: people.owner,
      limits: { max_records_per_page: 1, max_page_bytes: 65536, max_retained_records: 100, max_retained_bytes: 1048576, min_interval_seconds: 60 },
      expected_app_version_id: version!.id, expected_package_digest: version!.package_digest, expected_grant_snapshot_digest: grant!.snapshot_digest,
      expected_lifecycle_epoch: installation!.lifecycle_epoch, expected_grant_epoch: installation!.grant_epoch };
    const { review: admissionReview } = await call('/api/app-owner-connections/admissions/review', admissionInput);
    assert.deepEqual(admissionReview.snapshot.connection_profile, profile);
    assert.equal((await request('/api/app-owner-connections/admissions/review', admissionInput, tokens.member)).status, 403);
    const { admission } = await call('/api/app-owner-connections/admissions/activate', { ...admissionInput,
      expected_review_digest: admissionReview.review_digest, accept_host_policy: true });
    const context = await call(`/api/app-owner-connections/${installed.id}/context`, undefined, tokens.member);
    const resourceInput = context.policies[0].admission.resource_request;
    const { review: resourceReview } = await call('/api/app-owner-connections/resources/review', resourceInput, tokens.member);
    const { binding } = await call('/api/app-owner-connections/resources/activate', { ...resourceInput,
      expected_review_digest: resourceReview.review_digest, accept_host_policy: true }, tokens.member);
    entry = { ...entry, runtime_registration_id: binding.registration_id }; await writeConfig();
    // Count real admission queries in this exact held authority transaction.
    const { currentAppConnectionReadAuthority, retainedWebGuard } = await import('../src/lib/app-connection-session-authority.js');
    const claims = await web.verifyWebAccess(tokens.member!);
    const caller = { org_id: org, user_id: people.member!, sid: claims.sid, access_expires_at: claims.exp! * 1000 };
    let admissionQueries = 0;
    const readAuthority = (beforeFreshRegistry?: () => void) => db.transaction(async tx => {
      let humanQueries = 0;
      const counted = new Proxy(tx, { get(target, property, receiver) {
        if (property !== 'select') { const value = Reflect.get(target, property, receiver); return typeof value === 'function' ? value.bind(target) : value; }
        return (...args: Parameters<typeof tx.select>) => {
          const query = tx.select(...args);
          return new Proxy(query, { get(builder, key, queryReceiver) {
            if (key === 'from') return (table: Parameters<typeof query.from>[0]) => {
              if (table === s.appOwnerConnectionAdmissions) admissionQueries++;
              if (table === s.users && ++humanQueries === 2) beforeFreshRegistry?.();
              return query.from(table);
            };
            const value = Reflect.get(builder, key, queryReceiver); return typeof value === 'function' ? value.bind(builder) : value;
          } });
        };
      } });
      return currentAppConnectionReadAuthority(caller, { installation_id: installed.id, target_key: resourceInput.target_key }, retainedWebGuard(caller), 'none', counted);
    });
    const authority = await readAuthority();
    assert.equal(authority.scope.resource_binding_id, binding.binding_id);
    assert.equal(admissionQueries, 1, 'one owner admission query per held authority transaction');
    // Change deployment bytes after the binding reader's locked admission
    // check but before the connection reader loads its fresh registry.
    for (const changed of [{ ...entry, endpoint: 'https://replacement-runtime.example.test/v1/connections' },
      { ...entry, profile: { ...profile, authorization_origin: 'https://replacement-provider.example.test' } }]) {
      await assert.rejects(readAuthority(() => writeFileSync(configPath, JSON.stringify({
        schema_version: 'deft.app_connection_http_registrations.v1', entries: [changed] }), { mode: 0o600 })),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'APP_ACCESS_DENIED');
      await writeConfig();
    }
    await db.update(s.orgMembers).set({ is_active: false }).where(and(eq(s.orgMembers.org_id, org), eq(s.orgMembers.user_id, people.member!)));
    await assert.rejects(readAuthority());
    await db.update(s.orgMembers).set({ is_active: true }).where(and(eq(s.orgMembers.org_id, org), eq(s.orgMembers.user_id, people.member!)));
    await db.update(s.webSessions).set({ revoked_at: new Date() }).where(eq(s.webSessions.id, caller.sid));
    await assert.rejects(readAuthority());
    await db.update(s.webSessions).set({ revoked_at: null }).where(eq(s.webSessions.id, caller.sid));
    let providerCalls = 0, introspectionChecks = 0;
    globalThis.fetch = (async (url, options) => {
      assert.equal(url, entry.endpoint); assert.equal(options?.redirect, 'error');
      assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer ' + runtimeToken);
      const input = JSON.parse(String(options?.body));
      const authority = { schema_version: 'deft.app_connection_runtime_authority.v1', session_id: input.session_id,
        scope: input.scope, operation: input.operation, expires_at: input.expires_at };
      const current = await request('/api/app-connection-sessions/runtime/authority', authority, authorityToken);
      assert.equal(current.status, 200); assert.equal(current.body.allowed, true);
      assert.deepEqual(current.body.scope, input.scope); introspectionChecks++;
      assert.equal((await request('/api/app-connection-sessions/runtime/authority', authority, tokens.member)).status, 403);
      assert.equal((await request('/api/app-connection-sessions/runtime/authority', { ...authority, operation: input.operation === 'status' ? 'begin' : 'status' }, authorityToken)).status, 403);
      providerCalls++;
      return Response.json(input.operation === 'begin' ? { state: 'awaiting_callback', runtime_session_ref: 'opaque_session',
        authorization_url: 'https://accounts.google.com/auth?state=' + input.callback_state }
        : input.operation === 'disconnect' ? { state: 'disconnected' }
          : { state: 'connected', account: { account_ref: 'opaque_account', label: 'Synthetic mailbox' } });
    }) as typeof fetch;
    const base = '/api/app-connection-sessions', nomination = { installation_id: installed.id, target_key: resourceInput.target_key };
    assert.equal((await request(base + '/begin', { ...nomination, owner_user_id: people.owner }, tokens.member)).status, 400);
    assert.equal((await request(base + '/begin', nomination, tokens.other)).status, 403);
    const begun = await call(base + '/begin', nomination, tokens.member);
    assert.equal(begun.state, 'awaiting_callback'); assert.equal(providerCalls, 1);
    const callback = { session_id: begun.session_id, state: begun.callback_state, outcome: 'authorized', code: 'synthetic-code' };
    assert.equal((await request(base + '/callback', { ...callback, state: 'x'.repeat(43) }, tokens.member)).status, 409);
    assert.equal((await request(base + '/callback', callback, tokens.other)).status, 403);
    const connected = await call(base + '/callback', callback, tokens.member); assert.equal(connected.state, 'connected');
    assert.equal((await request(base + '/callback', callback, tokens.member)).status, 409); assert.equal(providerCalls, 2);
    assert.equal((await call(base + '/status', { session_id: begun.session_id }, tokens.member)).state, 'connected');
    const reviewedEndpoint = entry.endpoint;
    entry = { ...entry, endpoint: 'https://replacement-runtime.example.test/v1/connections' }; await writeConfig();
    assert.equal((await request(base + '/status', { session_id: begun.session_id }, tokens.member)).status, 403); assert.equal(providerCalls, 3);
    entry = { ...entry, endpoint: reviewedEndpoint }; await writeConfig();
    entry = { ...entry, runtime_auth_token: 'z'.repeat(43) }; await writeConfig();
    assert.equal((await request(base + '/status', { session_id: begun.session_id }, tokens.member)).status, 403); assert.equal(providerCalls, 3);
    entry = { ...entry, runtime_auth_token: runtimeToken }; await writeConfig();
    entry = { ...entry, runtime_epoch: 2 }; await writeConfig();
    assert.equal((await request(base + '/status', { session_id: begun.session_id }, tokens.member)).status, 503); assert.equal(providerCalls, 3);
    entry = { ...entry, runtime_epoch: 1 }; await writeConfig();
    assert.equal((await call(base + '/disconnect', { session_id: begun.session_id }, tokens.member)).state, 'disconnected');
    assert.equal(providerCalls, 4); assert.equal(introspectionChecks, 4);
    const disconnected = await request(base + '/status', { session_id: begun.session_id }, tokens.member);
    assert.equal(disconnected.headers.get('cache-control'), 'no-store'); assert.equal(providerCalls, 4);
    const [stored] = await db.select().from(s.appConnectionSessions).where(and(eq(s.appConnectionSessions.org_id, org), eq(s.appConnectionSessions.session_id, begun.session_id)));
    assert.equal(JSON.stringify(stored!.record).includes('synthetic-code'), false);
    assert.equal(JSON.stringify(stored!.record).includes(begun.callback_state), false);
    await call('/api/app-owner-connections/admissions/' + admission.admission_id + '/revoke', {});
    assert.equal((await request(base + '/status', { session_id: begun.session_id }, tokens.member)).status, 403);
    assert.equal(providerCalls, 4);
  });
