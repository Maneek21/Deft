import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDeftAppPackage } from '@deft/app-kit';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';

function disposableDatabase() {
  const target = process.env.DEFT_E2_TEST_DATABASE_URL;
  if (!target || target !== process.env.DATABASE_URL) return false;
  try { const url = new URL(target); return ['postgres:', 'postgresql:'].includes(url.protocol)
    && url.hostname === '127.0.0.1' && url.port === '33954' && url.username === 'e2_connection_test'
    && url.pathname === '/e2_connection_test' && !url.search && !url.hash; } catch { return false; }
}

const runtimeRoot = process.env.DEFT_E2_RUNTIME_ROOT;
function externalRuntimeAvailable() {
  const hostRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  return !!runtimeRoot && isAbsolute(runtimeRoot) && !resolve(runtimeRoot).startsWith(hostRoot)
    && ['server.mjs', 'test-support.mjs', 'contract.mjs'].every(file => existsSync(join(runtimeRoot, file)));
}

// Real host routes/PG and actual child runtime. Only provider fetches and TLS routing are synthetic.
test('two owner registrations share one read-only Email runtime with scope isolation across restart',
  { skip: !disposableDatabase() || !externalRuntimeAvailable(), timeout: 180000 }, async t => {
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
    let child: ChildProcess | null = null;
    let hostServer: import('node:http').Server | undefined;
    const providerRequests: string[] = []; let introspections = 0, runtimePort = 0;
    async function stopRuntime() { const previous = child; child = null; if (!previous) return; const exited = new Promise<void>(done => previous.once('exit', () => done())); previous.send('shutdown'); await exited; }
    t.after(async () => { globalThis.fetch = realFetch;
      await stopRuntime(); if (hostServer) await new Promise<void>((done, reject) => hostServer!.close(error => error ? reject(error) : done()));
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
    let secondEntry: typeof entry | undefined;
    const writeConfig = async () => writeFile(configPath, JSON.stringify({ schema_version: 'deft.app_connection_http_registrations.v1',
      entries: secondEntry ? [entry, secondEntry] : [entry] }), { mode: 0o600 });
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
    const secondContext = await call(`/api/app-owner-connections/${installed.id}/context`, undefined, tokens.other);
    const secondResourceInput = secondContext.policies[0].admission.resource_request;
    const {review: secondResourceReview} = await call('/api/app-owner-connections/resources/review', secondResourceInput, tokens.other);
    const {binding: secondBinding} = await call('/api/app-owner-connections/resources/activate', {...secondResourceInput,
      expected_review_digest: secondResourceReview.review_digest, accept_host_policy: true}, tokens.other);
    assert.notEqual(secondBinding.registration_id, binding.registration_id);
    assert.notEqual(secondBinding.binding_id, binding.binding_id);
    secondEntry = {...entry, runtime_registration_id: secondBinding.registration_id}; await writeConfig();

    // Actual public authority URL consumed over HTTP by the external process.
    const { serve } = await import('@hono/node-server');
    hostServer = serve({fetch: async (request, ...args) => {
      const authorityRequest = new URL(request.url).pathname === '/api/app-connection-sessions/runtime/authority';
      if (authorityRequest) introspections++;
      const started = Date.now(), response = await app.fetch(request, ...args);
      if (authorityRequest) {const body = await response.clone().json() as any;
        t.diagnostic(`authority HTTP${response.status} ${body.code ?? 'allowed'} ${Date.now() - started}ms`);}
      return response;
    }, hostname: '127.0.0.1', port: 0}) as import('node:http').Server;
    if (!hostServer.listening) await new Promise<void>(done => hostServer!.once('listening', done));
    const hostPort = (hostServer.address() as import('node:net').AddressInfo).port;
    const runtimeConfigPath = join(directory, 'runtime.json'), clientPath = join(directory, 'google.json'), storeRoot = resolve(directory, 'runtime-state');
    const {connectionProfileDigest} = await import('../src/lib/app-connection-session-registry.js');
    await writeFile(clientPath, JSON.stringify({client_id: 'fixture-only-client', client_secret: 'fixture-only-client-secret',
      redirect_uri: 'https://host.example/apps/connections/callback'}), {mode: 0o600});
    await writeFile(runtimeConfigPath, JSON.stringify({listen_port: 0, store_root: storeRoot, key_id: 'fixture-key-v1',
      encryption_key_hex: randomBytes(32).toString('hex'), runtime_auth_token: runtimeToken, authority_token: authorityToken,
      authority_url: `http://127.0.0.1:${hostPort}/api/app-connection-sessions/runtime/authority`, gmail_client_file: clientPath,
      registrations: [{org_id: org, runtime_registration_id: binding.registration_id, operator_user_id: people.owner,
        runtime_epoch: entry.runtime_epoch, profile_digest: connectionProfileDigest(profile as any),
        target_key: resourceInput.target_key, resource_key: 'inbox'},
        {org_id: org, runtime_registration_id: secondBinding.registration_id, operator_user_id: people.owner,
          runtime_epoch: secondEntry.runtime_epoch, profile_digest: connectionProfileDigest(profile as any),
          target_key: secondResourceInput.target_key, resource_key: 'inbox'}]}), {mode: 0o600});
    async function bootRuntime() {
      const childEnvironment: NodeJS.ProcessEnv = {DEFT_E2_RUNTIME_ROOT: runtimeRoot!, EMAIL_RUNTIME_CONFIG_FILE: runtimeConfigPath};
      // Independent runtime receives its synthetic operator file and OS paths;
      // host database credentials, keyrings and inherited provider secrets stay out.
      for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'TMPDIR']) {
        if (process.env[key] !== undefined) childEnvironment[key] = process.env[key];
      }
      child = fork(fileURLToPath(new URL('./fixtures/app-connection-runtime-process.mjs', import.meta.url)), [], {
        execArgv: [], env: childEnvironment,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
      // Synthetic child output only; never capture runtime/operator configuration.
      let startupError = ''; child.stderr!.on('data', chunk => {startupError += String(chunk).slice(0, 2000);});
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(Error('Synthetic runtime startup timeout')), 10000);
        child!.on('message', (raw: any) => {
          if (raw.event === 'provider_request') providerRequests.push(raw.url);
          if (Number.isInteger(raw.port)) {runtimePort = raw.port; clearTimeout(timer); done();}
        });
        child!.once('exit', code => {clearTimeout(timer); reject(Error(`Synthetic runtime exit ${code}: ${startupError}`));});
        child!.once('error', reject);
      });
    }
    await bootRuntime();

    let transportCalls = 0, firstSessionId: string | undefined, secondAccountRef: string | undefined;
    let crossSessionDenied = false, unknownRegistrationDenied = false, crossAccountDenied = false;
    const runtimePost = (input: any) => realFetch(`http://127.0.0.1:${runtimePort}/v1/connections`, {
      method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + runtimeToken},
      body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(10000)});
    globalThis.fetch = (async (url, options) => {
      assert.equal(url, entry.endpoint); assert.equal(options?.redirect, 'error');
      assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer ' + runtimeToken);
      const input = JSON.parse(String(options?.body));
      assert.ok([binding.registration_id, secondBinding.registration_id].includes(input.scope.runtime_registration_id));
      assert.equal(input.scope.owner_user_id, input.scope.runtime_registration_id === binding.registration_id ? people.member : people.other);
      transportCalls++;
      // Attack the actual dispatcher while the genuine operation's host record
      // is inflight. These negatives therefore cannot pass only because status
      // was already settled or the host had no valid operation to authorize.
      if (input.operation === 'begin' && input.scope.owner_user_id === people.other && !crossSessionDenied) {
        const providersBefore = providerRequests.length, checksBefore = introspections;
        const wrongSession = await runtimePost({...input, session_id: firstSessionId});
        assert.equal(wrongSession.status, 503); // runtime withholds a denied host introspection outcome
        assert.equal((await wrongSession.json()).error, 'EMAIL_RUNTIME_UNAVAILABLE');
        assert.equal(introspections, checksBefore + 1); assert.equal(providerRequests.length, providersBefore);
        crossSessionDenied = true;
        const unknown = await runtimePost({...input, scope: {...input.scope, runtime_registration_id: randomUUID()}});
        assert.equal(unknown.status, 403); assert.equal((await unknown.json()).error, 'EMAIL_RUNTIME_REGISTRATION_DENIED');
        assert.equal(introspections, checksBefore + 1, 'unknown registrations stop before authority IO');
        assert.equal(providerRequests.length, providersBefore); unknownRegistrationDenied = true;
      }
      if (input.operation === 'status' && input.scope.owner_user_id === people.member && secondAccountRef && !crossAccountDenied) {
        const providersBefore = providerRequests.length;
        const wrongAccount = await runtimePost({...input, expected_account_ref: secondAccountRef});
        assert.equal(wrongAccount.status, 403); assert.equal((await wrongAccount.json()).error, 'EMAIL_RUNTIME_ACCOUNT_DENIED');
        assert.equal(providerRequests.length, providersBefore); crossAccountDenied = true;
      }
      // Explicit fixture rewrite only. Production still requires reviewed HTTPS.
      const started = Date.now();
      try {
        const response = await realFetch(`http://127.0.0.1:${runtimePort}/v1/connections`, options);
        const body = await response.clone().json() as any;
        t.diagnostic(`runtime ${input.operation} HTTP${response.status} ${body.state ?? body.error} ${Date.now() - started}ms providerCalls=${providerRequests.length}`);
        return response;
      } catch (error) {
        t.diagnostic(`runtime ${input.operation} transport ended ${(error as Error).name} ${Date.now() - started}ms providerCalls=${providerRequests.length}`);
        throw error;
      }
    }) as typeof fetch;
    const base = '/api/app-connection-sessions';
    const owners = [{token: tokens.member, userId: people.member, resource: resourceInput, registrationId: binding.registration_id,
      code: 'fixture-first-account', label: 'first@example.test'},
      {token: tokens.other, userId: people.other, resource: secondResourceInput, registrationId: secondBinding.registration_id,
        code: 'fixture-second-account', label: 'second@example.test'}];
    const sessions: {owner: typeof owners[number]; begun: any; connected: any}[] = [];
    for (const currentOwner of owners) {
      const begun = await call(base + '/begin', {installation_id: installed.id, target_key: currentOwner.resource.target_key}, currentOwner.token);
      assert.equal(begun.state, 'awaiting_callback'); assert.equal(providerRequests.length, sessions.length * 3);
      assert.equal(begun.scope.owner_user_id, currentOwner.userId); assert.equal(begun.scope.runtime_registration_id, currentOwner.registrationId);
      const authorization = new URL(begun.authorization_url);
      assert.equal(authorization.origin, 'https://accounts.google.com');
      assert.deepEqual(authorization.searchParams.get('scope')!.split(' ').sort(),
        ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'].sort());
      assert.equal(authorization.searchParams.get('state'), begun.callback_state);
      const callback = {session_id: begun.session_id, state: begun.callback_state, outcome: 'authorized', code: currentOwner.code};
      if (sessions.length === 1) {
        assert.equal((await request(base + '/callback', {...callback, state: sessions[0]!.begun.callback_state}, currentOwner.token)).status, 409);
        assert.equal((await request(base + '/callback', callback, tokens.member)).status, 403);
        assert.equal(providerRequests.length, 3);
      }
      const connected = await call(base + '/callback', callback, currentOwner.token);
      assert.equal(connected.state, 'connected'); assert.equal(connected.account.label, currentOwner.label);
      assert.equal((await request(base + '/callback', callback, currentOwner.token)).status, 409);
      sessions.push({owner: currentOwner, begun, connected});
      if (sessions.length === 1) firstSessionId = begun.session_id; else secondAccountRef = connected.account.account_ref;
    }
    assert.notEqual(sessions[0]!.begun.session_id, sessions[1]!.begun.session_id);
    assert.notEqual(sessions[0]!.connected.account.account_ref, sessions[1]!.connected.account.account_ref);
    const providerSequence = ['https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo',
      'https://gmail.googleapis.com/gmail/v1/users/me/profile'];
    assert.deepEqual(providerRequests, [...providerSequence, ...providerSequence]);
    for (const [index, session] of sessions.entries()) {
      const foreign = sessions[1 - index]!;
      assert.equal((await request(base + '/status', {session_id: session.begun.session_id}, foreign.owner.token)).status, 403);
      assert.deepEqual((await call(base + '/status', {session_id: session.begun.session_id}, session.owner.token)).account, session.connected.account);
    }
    assert.ok(crossSessionDenied && unknownRegistrationDenied && crossAccountDenied);
    const journalFiles = (await readdir(storeRoot)).filter(file => file.endsWith('.json'));
    assert.ok(journalFiles.length >= 6, 'one writer persisted encrypted independent sessions and custody rows');
    for (const file of journalFiles) {
      const raw = await readFile(join(storeRoot, file), 'utf8');
      const row = JSON.parse(raw); assert.ok(row.ciphertext); assert.ok(row.revision >= 1);
      for (const session of sessions) assert.equal(raw.includes(session.owner.code), false);
      assert.equal(raw.includes('fixture-only-access-'), false); assert.equal(raw.includes('fixture-only-refresh-'), false);
    }
    await stopRuntime(); await bootRuntime();
    for (const session of sessions) {
      assert.deepEqual((await call(base + '/status', {session_id: session.begun.session_id}, session.owner.token)).account, session.connected.account);
    }
    assert.equal(providerRequests.length, 6, 'restart/status did not replay either OAuth exchange');
    // Disconnecting one account cannot disturb the second owner's current
    // account/result in the same writer or registration dispatcher.
    for (const [index, session] of sessions.entries()) {
      assert.equal((await call(base + '/disconnect', {session_id: session.begun.session_id}, session.owner.token)).state, 'disconnected');
      assert.equal((await call(base + '/status', {session_id: session.begun.session_id}, session.owner.token)).state, 'disconnected');
      if (index === 0) assert.deepEqual((await call(base + '/status', {session_id: sessions[1]!.begun.session_id}, sessions[1]!.owner.token)).account,
        sessions[1]!.connected.account);
      const [stored] = await db.select().from(s.appConnectionSessions).where(and(eq(s.appConnectionSessions.org_id, org),
        eq(s.appConnectionSessions.session_id, session.begun.session_id)));
      assert.equal((stored!.record as any).state, 'disconnected'); assert.equal((stored!.record as any).callback_consumed, true);
      assert.equal(JSON.stringify(stored!.record).includes(session.owner.code), false);
      assert.equal(JSON.stringify(stored!.record).includes(session.begun.callback_state), false);
    }
    assert.equal(providerRequests.length, 6); assert.equal(transportCalls, 11);
    assert.ok(introspections >= 24, 'both registrations use current public host authority around IO/disclosure');
    await call('/api/app-owner-connections/admissions/' + admission.admission_id + '/revoke', {});
    for (const session of sessions) assert.equal((await request(base + '/status', {session_id: session.begun.session_id}, session.owner.token)).status, 403);
    assert.equal(transportCalls, 11);
  });
