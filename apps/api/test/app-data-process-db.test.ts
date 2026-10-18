import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {pathToFileURL} from 'node:url';
import { buildDeftAppPackage,prepareDeftExperienceArtifact } from '@deft/app-kit';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';

function disposableDatabase() {
  const target = process.env.DEFT_E2_TEST_DATABASE_URL;
  if (!target || target !== process.env.DATABASE_URL) return false;
  try { const url = new URL(target); return ['postgres:', 'postgresql:'].includes(url.protocol)
    && url.hostname === '127.0.0.1' && url.port === '33954' && url.username === 'e2_connection_test'
    && url.pathname === '/e2_connection_test' && !url.search && !url.hash; } catch { return false; }
}

const runtimeRoot = process.env.DEFT_E2_RUNTIME_ROOT;
const actionProof=process.env.DEFT_E2_RECORD_ACTION_PROOF==='true';
const sendFocused=actionProof&&process.env.DEFT_E2_SEND_FOCUSED==='true';
function externalRuntimeAvailable() {
  const hostRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  return !!runtimeRoot && isAbsolute(runtimeRoot) && !resolve(runtimeRoot).startsWith(hostRoot)
    && ['server.mjs', 'test-support.mjs', 'contract.mjs'].every(file => existsSync(join(runtimeRoot, file)));
}

let closeFixtureDatabase: (() => Promise<void>) | undefined;
after(async()=>{await closeFixtureDatabase?.();});

// Real host routes/PG and actual child runtime. Only provider fetches and TLS routing are synthetic.
async function runDataProcessFixture(t:TestContext,contextOnly=false) {
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
    closeFixtureDatabase=closeDb;
    const app = new Hono(); app.route('/api/apps/blob', blob.appAttachmentRoutes);
    app.route('/api/app-owner-connections', owner.appOwnerConnectionRoutes);
    app.route('/api/app-connection-sessions', connections.appConnectionSessionRoutes);
    app.route('/api/app-data',(await import('../src/routes/app-data.js')).appDataRoutes);
    if(actionProof){app.route('/api/app-data',(await import('../src/routes/app-data-actions.js')).appDataActionRoutes);
      app.route('/api/app-experiences',(await import('../src/routes/app-experiences.js')).appExperienceRoutes);
      app.route('/api/app-runtime/channel',(await import('../src/routes/app-runtime-channel.js')).appRuntimeChannelRoutes);}
    const directory = await mkdtemp(join(tmpdir(), 'deft-e2-session-test-'));
    const configPath = join(directory, 'reviewed-http.json'), previousConfig = process.env.DEFT_APP_CONNECTION_HTTP_CONFIG;
    const realFetch = globalThis.fetch;
    let child: ChildProcess | null = null;
    let hostServer: import('node:http').Server | undefined;
    const providerRequests: string[] = []; let introspections = 0, runtimePort = 0;
    const dataAuthorityTimes:number[]=[],dataAuthorityStatuses:Record<string,number>={};
    async function stopRuntime() {
      const previous = child; child = null;
      if (!previous || previous.exitCode !== null || previous.signalCode !== null) return;
      const exited = new Promise<void>(done => previous.once('exit', () => done()));
      if (previous.connected) previous.send('shutdown'); else previous.kill();
      const timer = setTimeout(() => previous.kill('SIGKILL'), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    t.after(async () => {
      let peak=0,start=0;for(let end=0;end<dataAuthorityTimes.length;end++){while(dataAuthorityTimes[end]!-dataAuthorityTimes[start]!>=60000)start++;peak=Math.max(peak,end-start+1);}
      console.log('# synthetic data authority summary '+JSON.stringify({requests:dataAuthorityTimes.length,peak_rolling_minute:peak,statuses:dataAuthorityStatuses,provider_requests:providerRequests.length}));
      globalThis.fetch = realFetch;
      await stopRuntime(); if (hostServer) await new Promise<void>((done, reject) => hostServer!.close(error => error ? reject(error) : done()));
      if (previousConfig === undefined) delete process.env.DEFT_APP_CONNECTION_HTTP_CONFIG; else process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = previousConfig;
      await rm(directory, { recursive: true, force: true });
      await attachments.shutdownAppAttachmentRuntime(); await runtime.shutdownAppRunRuntime(); });
    process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = configPath;
    const org = randomUUID(), people = { owner: randomUUID(), member: randomUUID(), other: randomUUID() };
    await db.insert(s.orgs).values({ id: org, name: 'Synthetic E2 HTTP', slug: 'e2-http-' + org });
    const tokens: Record<string, string> = {},refreshTokens:Record<string,string>={};
    for (const [role, id] of Object.entries(people)) {
      const email = 'e2-http-' + id + '@example.test';
      await db.insert(s.users).values({ id, name: role, email, kind: 'human', is_agent: false });
      await db.insert(s.orgMembers).values({ id: randomUUID(), org_id: org, user_id: id, role: role === 'owner' ? 'owner' : 'member', is_active: true });
      const pair=await web.createWebSession({ id, org_id: org, email });tokens[role]=pair.accessToken;refreshTokens[role]=pair.refreshToken;
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
    fixture.manifest.id = 'community.example.e2data.a' + org.replaceAll('-', '');
    fixture.manifest.owner_connections = [{ key: 'mailbox', resource_key: 'inbox', action_keys: ['send_message'],
      max_consent_seconds: 86400, provider_profile_key: 'google_mail', runtime_requirement_key: 'sync_provider' }];
    fixture.manifest.record_stores=[{schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'inbox',runtime_requirement_key:'sync_provider',
      max_record_bytes:491520,max_files:32,max_file_bytes:26214400,max_total_file_bytes:26214400,
      resource_content:{max_presentation_bytes:262144,max_source_bytes:36700160,max_file_bytes:26214400,max_image_bytes:2097152}}];
    // Only the separate context proof needs eleven stores. The full CAS/files proof keeps its original one-store fixture.
    if(contextOnly){
      fixture.manifest.record_stores.push(...Array.from({length:10},(_,index)=>({...fixture.manifest.record_stores[0],key:'context_store_'+index})));
      fixture.manifest.record_stores.sort((a,b)=>a.key.localeCompare(b.key));
    }
    const experience=await prepareDeftExperienceArtifact('experiences/main.json',{schema_version:'deft.experience_bundle.v3',worker_source:'self.onmessage=()=>{};',entry_view:'main',
      resource_keys:['inbox'],action_keys:['send_message'],state_keys:[],record_store_keys:['drafts']});
    delete fixture.manifest.private_state;fixture.artifacts=[experience];fixture.manifest.experiences=[{key:'main',label:'Synthetic full native records',artifact_path:experience.path,
      artifact_digest:experience.digest,bridge_version:'deft.experience_bridge.v1',renderer_version:'deft.trusted_renderer.v2',capabilities:['record_form.v1','record_document.v1']}];
    if(actionProof){const properties:Record<string,unknown>={};
      for(const field of ['snapshot_id','account_ref','draft_id','connection_session_id','data_consent_id'])properties[field]={type:'string',minLength:36,maxLength:36};
      for(const field of ['draft_revision','content_revision','connection_revision'])properties[field]={type:'number',minimum:1,maximum:2147483646};
      for(const field of ['content_digest','file_manifest_digest','mime_digest','payload_digest','data_consent_digest','prepared_digest'])properties[field]={type:'string',minLength:71,maxLength:71};
      properties.source_digest={type:'string',maxLength:71};properties.record_action_version={type:'string',maxLength:64};properties.record_store_key={type:'string',maxLength:48};
      fixture.manifest.private_capabilities.find((capability:any)=>capability.key==='send_message').input_schema={type:'object',properties,required:Object.keys(properties),additionalProperties:false};
      fixture.manifest.private_capabilities.find((capability:any)=>capability.key==='send_message').output_schema={type:'object',properties:{
        operation_id:{type:'string',maxLength:120},primary_outcome:{type:'string',maxLength:40},
        effect_outcome:{type:'string',maxLength:40},inspection_available:{type:'boolean'}},
        required:['operation_id','primary_outcome','effect_outcome','inspection_available'],additionalProperties:false};
    }
    let packed:string;
    try{packed=(await buildDeftAppPackage({ manifest: fixture.manifest, artifacts: fixture.artifacts })).json;}
    catch(error){const issues=(error as {issues?:{path:unknown[];message:string}[]}).issues;
      if(issues)console.log('# synthetic package validation '+JSON.stringify(issues.slice(0,12).map(issue=>({path:issue.path,message:issue.message.slice(0,200)}))));
      throw error;}
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
    // Genuine DB epoch/profile setup metadata is available before enrollment;
    // it cannot grant Begin or perform external I/O.
    const enrolledEntry=entry;entry={...entry,runtime_registration_id:randomUUID()};await writeConfig();
    const bootstrap=await call(`/api/app-connection-sessions/installations/${installed.id}/context`,undefined,tokens.member);
    assert.equal(bootstrap.targets[0].scope.runtime_registration_id,binding.registration_id);assert.equal(bootstrap.targets[0].scope.runtime_epoch,1);
    assert.equal(bootstrap.targets[0].runtime_ready,false);assert.equal(bootstrap.targets[0].session,null);
    entry=enrolledEntry;await writeConfig();
    let actionBinding:any,actionRuntimeSession:any;
    if(actionProof){const actionInput={...admission,owner_resource_binding_id:binding.binding_id,action_key:'send_message'};
      const review=await call('/api/app-owner-connections/actions/review',actionInput,tokens.member);
      actionBinding=(await call('/api/app-owner-connections/actions/activate',{...actionInput,expected_review_digest:review.review.review_digest,accept_host_policy:true},tokens.member)).binding;
      actionRuntimeSession=(await call(`/api/apps/blob/composition/runtime/bindings/${actionBinding.binding_id}/sessions`,{})).session;
    }

    // Actual public authority URL consumed over HTTP by the external process.
    const { serve } = await import('@hono/node-server');
    hostServer = serve({fetch: async (request, ...args) => {
      const path = new URL(request.url).pathname;
      const authorityRequest = path === '/api/app-connection-sessions/runtime/authority';
      const dataAuthorityRequest = path === '/api/app-data/runtime/authority';
      if (authorityRequest) introspections++;
      if (dataAuthorityRequest) dataAuthorityTimes.push(Date.now());
      const started = Date.now(), response = await app.fetch(request, ...args);
      if(path.startsWith('/api/app-runtime/channel/')){
        const body=await response.clone().json() as any;
        const code=typeof body.code==='string'&&/^APP_[A-Z0-9_]+$/.test(body.code)?body.code:'none';
        console.log(`# synthetic channel ${path.slice(path.lastIndexOf('/')+1)} HTTP${response.status} code=${code} ${Date.now()-started}ms`);
      }
      if (dataAuthorityRequest) dataAuthorityStatuses[response.status]=(dataAuthorityStatuses[response.status]??0)+1;
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
      authority_url: `http://127.0.0.1:${hostPort}/api/app-connection-sessions/runtime/authority`, data_authority_url: `http://127.0.0.1:${hostPort}/api/app-data/runtime/authority`, gmail_client_file: clientPath,
      registrations: [{org_id: org, runtime_registration_id: binding.registration_id, operator_user_id: people.owner,
        runtime_epoch: entry.runtime_epoch, profile_digest: connectionProfileDigest(profile as any),
        target_key: resourceInput.target_key, resource_key: 'inbox'},
        {org_id: org, runtime_registration_id: secondBinding.registration_id, operator_user_id: people.owner,
          runtime_epoch: secondEntry.runtime_epoch, profile_digest: connectionProfileDigest(profile as any),
          target_key: secondResourceInput.target_key, resource_key: 'inbox'}]}), {mode: 0o600});
    if(actionProof){const channelPath=join(directory,'reviewed-action-channel.json');
      const [actionRegistration]=await db.select().from(s.appRuntimeRegistrations).where(eq(s.appRuntimeRegistrations.id,actionBinding.registration_id));
      await writeFile(channelPath,JSON.stringify({channel_url:`http://127.0.0.1:${hostPort}/api/app-runtime/channel`,credential:{session_id:actionRuntimeSession.session_id,session_token:actionRuntimeSession.session_token},
        registration:{org_id:org,runtime_registration_id:actionBinding.registration_id,runtime_epoch:actionRegistration!.runtime_epoch}}),{mode:0o600});
      const config=JSON.parse(await readFile(runtimeConfigPath,'utf8'));config.runtime_channel_files=[channelPath];await writeFile(runtimeConfigPath,JSON.stringify(config),{mode:0o600});
    }
    async function bootRuntime() {
      const childEnvironment: NodeJS.ProcessEnv = {DEFT_E2_RUNTIME_ROOT: runtimeRoot!, EMAIL_RUNTIME_CONFIG_FILE: runtimeConfigPath};
      if(actionProof)childEnvironment.EMAIL_RUNTIME_MANUAL_SEND='true';
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
          if(raw.event==='send_diagnostic'){
            const phase=['claim','start','authorize','execute','provider','result','completed'].includes(raw.phase)?raw.phase:'unknown';
            const code=typeof raw.code==='string'&&/^(?:EMAIL_[A-Z0-9_]+|APP_RUNTIME_[A-Z0-9_]+|SYNTHETIC_SEND_[A-Z0-9_]+)$/.test(raw.code)?raw.code:'none';
            console.log('# synthetic Send '+JSON.stringify({phase,code,elapsed_ms:Number.isFinite(raw.elapsed_ms)?raw.elapsed_ms:null,authorize_calls:Number.isInteger(raw.authorize_calls)?raw.authorize_calls:null}));
          }
          if (Number.isInteger(raw.port)) {runtimePort = raw.port; clearTimeout(timer); done();}
        });
        child!.once('exit', code => {clearTimeout(timer); reject(Error(`Synthetic runtime exit ${code}: ${startupError}`));});
        child!.once('error', reject);
      });
    }
    console.log('# synthetic setup complete; starting external runtime');
    await bootRuntime();

    let transportCalls = 0, firstSessionId: string | undefined, secondAccountRef: string | undefined;
    let crossSessionDenied = false, unknownRegistrationDenied = false, crossAccountDenied = false;
    const runtimePost = (input: any) => realFetch(`http://127.0.0.1:${runtimePort}/v1/connections`, {
      method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + runtimeToken},
      body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(10000)});
    let dataCalls=0,dropNextSave=false;
    globalThis.fetch = (async (url, options) => {
      if(new URL(String(url)).pathname==='/v1/data'){
        assert.equal(new URL(String(url)).origin,'https://synthetic-runtime.example.test');
        assert.equal(options?.redirect,'error');assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+runtimeToken);
        dataCalls++;const response=await realFetch(`http://127.0.0.1:${runtimePort}/v1/data`,options);
        if(dropNextSave&&new Headers(options?.headers).get('content-type')==='application/json'&&JSON.parse(String(options?.body)).operation==='record_save'){
          dropNextSave=false;await response.arrayBuffer();throw Error('Synthetic response loss after durable runtime commit');
        }
        return response;
      }
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
      code: actionProof?'fixture-first-account-send':'fixture-first-account', label: 'first@example.test'},
      {token: tokens.other, userId: people.other, resource: secondResourceInput, registrationId: secondBinding.registration_id,
        code: 'fixture-second-account', label: 'second@example.test'}];
    const sessions: {owner: typeof owners[number]; begun: any; connected: any}[] = [];
    for (const currentOwner of owners) {
      const contextPath=`/api/app-connection-sessions/installations/${installed.id}/context`,beforeContext=providerRequests.length;
      const initial=await call(contextPath,undefined,currentOwner.token);
      assert.equal(initial.schema_version,'deft.app_connection_context.v1');assert.equal(initial.owner_user_id,currentOwner.userId);
      assert.equal(initial.targets.length,1);assert.equal(initial.targets[0].target_key,currentOwner.resource.target_key);
      assert.equal(initial.targets[0].session,null);assert.equal(initial.targets[0].profile.key,profile.key);
      assert.equal(providerRequests.length,beforeContext,'context projects admission without provider IO');
      const begun = await call(base + '/begin', {installation_id: installed.id, target_key: currentOwner.resource.target_key}, currentOwner.token);
      assert.equal(begun.state, 'awaiting_callback'); assert.equal(providerRequests.length, sessions.length * 3);
      assert.equal(begun.scope.owner_user_id, currentOwner.userId); assert.equal(begun.scope.runtime_registration_id, currentOwner.registrationId);
      const recovered=await call(contextPath,undefined,currentOwner.token);
      assert.equal(recovered.targets[0].session.session_id,begun.session_id);assert.equal(recovered.targets[0].session.state,'awaiting_callback');
      assert.equal(Object.hasOwn(recovered.targets[0].session,'callback_state'),false);assert.equal(Object.hasOwn(recovered.targets[0].session,'authorization_url'),false);
      assert.equal(providerRequests.length,sessions.length*3,'awaiting recovery never retries Begin');
      const authorization = new URL(begun.authorization_url);
      assert.equal(authorization.origin, 'https://accounts.google.com');
      assert.deepEqual(authorization.searchParams.get('scope')!.split(' ').sort(),
        ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly',...(actionProof&&sessions.length===0?['https://www.googleapis.com/auth/gmail.send']:[])].sort());
      assert.equal(authorization.searchParams.get('state'), begun.callback_state);
      const callback = {session_id: begun.session_id, state: begun.callback_state, outcome: 'authorized', code: currentOwner.code};
      if (sessions.length === 1) {
        assert.equal((await request(base + '/callback', {...callback, state: sessions[0]!.begun.callback_state}, currentOwner.token)).status, 409);
        assert.equal((await request(base + '/callback', callback, tokens.member)).status, 403);
        assert.equal(providerRequests.length, 3);
      }
      const connected = await call(base + '/callback', callback, currentOwner.token);
      assert.equal(connected.state, 'connected'); assert.equal(connected.account.label, currentOwner.label);
      const contextCount=providerRequests.length,currentContext=await call(contextPath,undefined,currentOwner.token);
      assert.equal(currentContext.targets[0].runtime_ready,true);assert.deepEqual(currentContext.targets[0].session,connected);
      assert.equal(providerRequests.length,contextCount,'connected context never calls provider/runtime');
      assert.equal((await request(base + '/callback', callback, currentOwner.token)).status, 409);
      sessions.push({owner: currentOwner, begun, connected});
      if (sessions.length === 1) firstSessionId = begun.session_id; else secondAccountRef = connected.account.account_ref;
    }
    assert.notEqual(sessions[0]!.begun.session_id, sessions[1]!.begun.session_id);
    assert.notEqual(sessions[0]!.connected.account.account_ref, sessions[1]!.connected.account.account_ref);
    const contextPath=`/api/app-connection-sessions/installations/${installed.id}/context`,countBeforeContext=providerRequests.length;
    assert.equal((await call(contextPath,undefined,tokens.owner)).targets.length,0,'another human cannot enumerate either account');
    assert.equal(providerRequests.length,countBeforeContext);
    const providerSequence = ['https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo',
      'https://gmail.googleapis.com/gmail/v1/users/me/profile'];
    assert.deepEqual(providerRequests, [...providerSequence, ...providerSequence]);
    for (const [index, session] of sessions.entries()) {
      const foreign = sessions[1 - index]!;
      assert.equal((await request(base + '/status', {session_id: session.begun.session_id}, foreign.owner.token)).status, 403);
      assert.deepEqual((await call(base + '/status', {session_id: session.begun.session_id}, session.owner.token)).account, session.connected.account);
    }
    assert.ok(crossSessionDenied && unknownRegistrationDenied && crossAccountDenied);
    if(contextOnly){
    await t.test('eleven-store context shares only within-disclosure connection work and rechecks real current authority',async()=>{
      const {resourceSyncWebAuthority}=await import('../src/lib/app-resource-sync-web-authority.js');
      const {currentAppDataContext}=await import('../src/lib/app-data-authority.js');
      const {withAppDataDiagnostic}=await import('../src/lib/app-data-diagnostics.js');
      const auth=await resourceSyncWebAuthority('Bearer '+sessions[0]!.owner.token);
      const caller={org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at};
      let observed:any;
      const collected=await withAppDataDiagnostic('context',()=>currentAppDataContext(caller,sessions[0]!.begun.session_id,auth.guard,{includeIdentities:false},async()=>{throw Error('No identity IO for scoped context');}),undefined,event=>{observed=event;});
      assert.equal(collected.authorities.length,11);assert.equal(observed.timings.connection_authority.calls,2);assert.equal(observed.timings.consent_read.calls,1);
      assert.ok(collected.authorities.every(item=>item.consent===null));
      const path=`/api/app-data/installations/${installed.id}/context?target_key=${sessions[0]!.owner.resource.target_key}`;
      assert.equal((await call(path,undefined,sessions[0]!.owner.token)).targets[0].stores.length,11);
      assert.equal((await call(path,undefined,tokens.owner)).targets.length,0,'another owner cannot enumerate private context');
      const selected=await call(`/api/app-data/installations/${installed.id}/resolve`,{schema_version:'deft.app_data_resolve.v1',target_key:sessions[0]!.owner.resource.target_key,store_key:'drafts'},sessions[0]!.owner.token);
      assert.deepEqual(selected.targets[0].stores.map((item:any)=>item.declaration.key),['drafts']);
    });
    return;
    }
    const dataBase='/api/app-data',records=new Map<string,any>();
    const data=async(session:typeof sessions[number],operation:string,input:unknown,requestId=randomUUID())=>
      call(`${dataBase}/connections/${session.begun.session_id}/requests`,{schema_version:'deft.app_data_request.v1',request_id:requestId,operation,input},session.owner.token);
    const {frameAppData,APP_DATA_FRAME_MEDIA_TYPE,parseAppDataFrame}=await import('@deft/app-kit');
    console.log('# synthetic OAuth accounts connected; starting app-owned records');
    for(const session of sessions){
      const recordId=randomUUID(),empty={mode:'compose',to:'recipient@example.test',cc:'',bcc:'',subject:'Synthetic draft',body:'',body_html:'',reply_record_id:'',attachments:[]};
      const denied=await request(`${dataBase}/connections/${session.begun.session_id}/requests`,{schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'record_create',input:{store_key:'drafts',record_id:recordId,value:empty}},session.owner.token);
      assert.equal(denied.status,403,`local draft custody requires explicit human data consent (code=${denied.body.code??'unknown'},record_bytes=${Buffer.byteLength(JSON.stringify(empty))})`);
      const expiry=new Date(Date.now()+86400000).toISOString();
      const review=await call(`${dataBase}/connections/${session.begun.session_id}/consent/review`,{store_key:'drafts',expires_at:expiry},session.owner.token);
      assert.ok(Date.parse(review.snapshot.expires_at)>Date.now()+900000,'durable reviewed consent outlives a15-minute access token');
      assert.ok(Date.parse(review.snapshot.expires_at)<=Date.parse(session.begun.scope.consent_expires_at),'resource consent ceiling clamps human request');
      const grant=await call(`${dataBase}/connections/${session.begun.session_id}/consent/activate`,{store_key:'drafts',expires_at:review.snapshot.expires_at,consent_id:review.snapshot.consent_id,expected_review_digest:review.review_digest,accept_host_policy:true},session.owner.token);
      assert.equal(grant.consent_id,review.snapshot.consent_id);
      let row=(await data(session,'record_create',{store_key:'drafts',record_id:recordId,value:empty})).record;
      assert.ok(row);assert.equal(row.record_id,recordId);assert.equal(row.files.length,0);
      const role=session.owner.userId===people.member?'member':'other',renewed=await web.rotateWebSession(refreshTokens[role]!);refreshTokens[role]=renewed.refreshToken;
      session.owner.token=renewed.accessToken;
      const {default:jwt}=await import('jsonwebtoken'),{env}=await import('../src/lib/env.js'),claims=jwt.decode(renewed.accessToken) as {sid:string};
      const expired=jwt.sign({id:session.owner.userId,org_id:org,email:'e2-http-'+session.owner.userId+'@example.test',sid:claims.sid,jti:randomUUID(),purpose:'web-access'},env.JWT_SECRET,{algorithm:'HS256',expiresIn:-1});
      const beforeExpired=dataCalls;
      assert.equal((await request(`${dataBase}/connections/${session.begun.session_id}/requests`,{schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'record_read',input:{store_key:'drafts',record_id:recordId}},expired)).status,401);
      assert.equal(dataCalls,beforeExpired,'expired access token cannot reuse durable consent for external IO');
      assert.equal((await data(session,'record_read',{store_key:'drafts',record_id:recordId})).record.record_id,recordId,'same durable consent works after public JWT renewal');
      const [retainedConsent]=await db.select().from(s.appDataConsents).where(eq(s.appDataConsents.consent_id,grant.consent_id));
      assert.equal(retainedConsent!.state,'active');assert.equal(retainedConsent!.expires_at.toISOString(),review.snapshot.expires_at);
      const body='x'.repeat(sendFocused?128:240000),value={...empty,body,body_html:`<p>${body}</p>`};
      row=(await data(session,'record_save',{store_key:'drafts',record_id:recordId,expected_revision:row.revision,expected_content_digest:row.content_digest,value})).record;
      assert.equal(row.value.body.length,sendFocused?128:240000);
      if(!sendFocused)assert.ok(Buffer.byteLength(JSON.stringify(row.value))>470000,'native draft exceeds every legacy inline/state budget');
      const stale=await data(session,'record_save',{store_key:'drafts',record_id:recordId,expected_revision:1,expected_content_digest:row.content_digest,value});
      assert.equal(stale.outcome,'conflict');
      records.set(session.begun.session_id,row);
      const foreign=sessions.find(item=>item!==session)!;
      const before=dataCalls;
      assert.equal((await request(`${dataBase}/connections/${session.begun.session_id}/requests`,{schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'record_read',input:{store_key:'drafts',record_id:recordId}},foreign.owner.token)).status,403);
      assert.equal(dataCalls,before,'foreign owner fails before external runtime IO');
    }
    const first=sessions[0]!,second=sessions[1]!;let firstRow=records.get(first.begun.session_id);
    const dataFixture=await import(pathToFileURL(join(runtimeRoot!,'test-support.mjs')).href),resourceRows=new Map<string,any>();
    const readDataBinary=async(session:typeof sessions[number],operation:string,input:unknown)=>{
      const response=await app.request(`${dataBase}/connections/${session.begun.session_id}/requests`,{method:'POST',headers:{authorization:'Bearer '+session.owner.token,'content-type':'application/json'},
        body:JSON.stringify({schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation,input})});
      assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),APP_DATA_FRAME_MEDIA_TYPE);
      return parseAppDataFrame(new Uint8Array(await response.arrayBuffer()));
    };
    if(!sendFocused){for(const session of sessions){
      const selector={store_key:'drafts',resource_key:'inbox'},refreshed=await data(session,'resource_refresh',selector);
      assert.equal(refreshed.outcome,'completed');assert.equal(refreshed.freshness.provider_observed,true);assert.ok(refreshed.freshness.observed_at);
      const listed=await data(session,'resource_list',{...selector,cursor:null,limit:10});assert.equal(listed.items.length,1);
      const resource=listed.items[0];assert.match(resource.record_id,/^[a-f0-9-]{36}$/);resourceRows.set(session.begun.session_id,resource);
      const source={...selector,record_id:resource.record_id,content_digest:resource.content_digest};
      const presented=await data(session,'resource_read_presentation',source);assert.ok(presented.presentation.content.includes('Native'));
      assert.ok(presented.presentation.headers.some((header:any)=>header.label==='Subject'));
      const expected=dataFixture.dataFixtureMessage(session.owner.label),raw=await readDataBinary(session,'resource_read_source',source);
      assert.deepEqual(Buffer.from(raw.bytes),expected.mime,'source is actual runtime-owned provider EML, not author preview');
      const catalog=await data(session,'resource_list_files',source),received=catalog.files.find((file:any)=>file.filename==='received.txt');assert.ok(received);
      const fileBytes=await readDataBinary(session,'resource_read_file',{...source,file_ref:received.file_ref});assert.deepEqual(Buffer.from(fileBytes.bytes),expected.attachment);
      const inline=presented.presentation.images.find((image:any)=>image.kind==='cid');assert.ok(inline);
      const imageBytes=await readDataBinary(session,'resource_read_image',{...source,image_ref:inline.image_ref,external_images:'blocked'});assert.deepEqual(Buffer.from(imageBytes.bytes),expected.png);
      const remote=presented.presentation.images.find((image:any)=>image.kind==='remote');assert.ok(remote);
      const remoteImageUrl='https://public.example.test/image.png';assert.ok(expected.mime.includes(remoteImageUrl));
      const remoteRequests=()=>providerRequests.filter(url=>url===remoteImageUrl).length,beforeRemote=remoteRequests();
      const blocked=await request(`${dataBase}/connections/${session.begun.session_id}/requests`,{schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'resource_read_image',input:{...source,image_ref:remote.image_ref,external_images:'blocked'}},session.owner.token);
      assert.ok(blocked.status!==200||(blocked.body.outcome!=='completed'),'blocked remote image cannot fetch');assert.equal(remoteRequests(),beforeRemote,'exact remote image URL receives no provider request while blocked');
    }
    const foreignResource=resourceRows.get(first.begun.session_id);
    assert.equal((await data(second,'resource_read_presentation',{store_key:'drafts',resource_key:'inbox',record_id:foreignResource.record_id,content_digest:foreignResource.content_digest})).outcome,'not_found');
    assert.equal((await data(second,'record_read',{store_key:'drafts',record_id:firstRow.record_id})).outcome,'not_found','same endpoint has separate account draft custody');
    const replyIntent={mode:'reply_all',to:'',cc:'',bcc:'',subject:'',body:'',body_html:'',reply_record_id:'',attachments:[]};
    const sourceRef={resource_key:'inbox',record_id:foreignResource.record_id,content_digest:foreignResource.content_digest};
    const reply=(await data(first,'record_create',{store_key:'drafts',record_id:randomUUID(),value:replyIntent,source_refs:[sourceRef]})).record;
    assert.equal(reply.value.to,'sender@example.test');assert.equal(reply.value.cc,'peer@example.test');assert.equal(reply.value.bcc,'');
    assert.match(reply.value.body,/> Native/);assert.match(reply.summary.notice,/Original attachments are not included/);
    const foreignReply=await request(`${dataBase}/connections/${second.begun.session_id}/requests`,{schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'record_create',
      input:{store_key:'drafts',record_id:randomUUID(),value:replyIntent,source_refs:[sourceRef]}},second.owner.token);
    assert.ok(foreignReply.status!==200||foreignReply.body.outcome!=='completed','foreign-account resource UUID cannot derive a reply');
    assert.equal((await data(first,'record_archive',{store_key:'drafts',record_id:reply.record_id,expected_revision:reply.revision,expected_content_digest:reply.content_digest})).record.status,'archived');
    }
    const fileCount=sendFocused?2:32;
    console.log(`# synthetic records verified; starting ${fileCount}-file ${sendFocused?'focused Send':'capacity'} proof`);
    for(let index=0;index<fileCount;index++){
      if(index%8===0)console.log(`# synthetic file-budget upload ${index+1}/${fileCount}`);
      const bytes=new Uint8Array(!sendFocused&&index===0?26214400-31:1).fill(index+1),fileId=randomUUID();
      const input={store_key:'drafts',record_id:firstRow.record_id,expected_revision:firstRow.revision,expected_content_digest:firstRow.content_digest,
        file_id:fileId,filename:`synthetic-${index}.bin`,media_type:'application/octet-stream',size_bytes:bytes.length,sha256:'sha256:'+createHash('sha256').update(bytes).digest('hex')};
      const response=await app.request(`${dataBase}/connections/${first.begun.session_id}/binary`,{method:'POST',headers:{authorization:'Bearer '+first.owner.token,'content-type':APP_DATA_FRAME_MEDIA_TYPE},
        body:frameAppData({schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'file_upload',input},bytes) as BodyInit});
      assert.equal(response.status,200,`file ${index} upload`);const result=await response.json() as any;assert.equal(result.outcome,'completed');firstRow=result.record;
      bytes.fill(0);
    }
    assert.equal(firstRow.files.length,fileCount);assert.equal(firstRow.files.reduce((sum:number,file:any)=>sum+file.size_bytes,0),sendFocused?2:26214400);
    if(!sendFocused){
    const extraBytes=new Uint8Array([0]),extraInput={store_key:'drafts',record_id:firstRow.record_id,expected_revision:firstRow.revision,expected_content_digest:firstRow.content_digest,
      file_id:randomUUID(),filename:'over-limit.bin',media_type:'application/octet-stream',size_bytes:1,sha256:'sha256:'+createHash('sha256').update(extraBytes).digest('hex')};
    const overFiles=await app.request(`${dataBase}/connections/${first.begun.session_id}/binary`,{method:'POST',headers:{authorization:'Bearer '+first.owner.token,'content-type':APP_DATA_FRAME_MEDIA_TYPE},
      body:frameAppData({schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'file_upload',input:extraInput},extraBytes) as BodyInit});
    const overResult=await overFiles.json() as any;assert.ok(overFiles.status!==200||overResult.outcome!=='completed','33rd file cannot exceed native aggregate quota');
    assert.equal((await data(first,'record_read',{store_key:'drafts',record_id:firstRow.record_id})).record.files.length,32);
    }
    const file=firstRow.files[fileCount-1],fileRead={store_key:'drafts',record_id:firstRow.record_id,file_id:file.file_id,upload_revision:file.upload_revision,sha256:file.sha256};
    const downloaded=await app.request(`${dataBase}/connections/${first.begun.session_id}/requests`,{method:'POST',headers:{authorization:'Bearer '+first.owner.token,'content-type':'application/json'},
      body:JSON.stringify({schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'file_read',input:fileRead})});
    assert.equal(downloaded.status,200);assert.equal(downloaded.headers.get('content-type'),APP_DATA_FRAME_MEDIA_TYPE);
    const downloadedFrame=parseAppDataFrame(new Uint8Array(await downloaded.arrayBuffer()));assert.equal(downloadedFrame.bytes.length,1);assert.equal(downloadedFrame.bytes[0],fileCount);
    firstRow=(await data(first,'file_detach',{...fileRead,expected_revision:firstRow.revision,expected_content_digest:firstRow.content_digest})).record;
    assert.equal(firstRow.files.length,fileCount-1);
    const detachedRead=await request(`${dataBase}/connections/${first.begun.session_id}/requests`,{schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'file_read',input:fileRead},first.owner.token);
    assert.ok(detachedRead.status!==200||detachedRead.body.outcome!=='completed','detached custody reference cannot disclose bytes');
    const lostId=randomUUID(),lostInput={store_key:'drafts',record_id:firstRow.record_id,expected_revision:firstRow.revision,expected_content_digest:firstRow.content_digest,value:{...firstRow.value,subject:'Persisted despite lost response'}};
    dropNextSave=true;const lost=await request(`${dataBase}/connections/${first.begun.session_id}/requests`,{schema_version:'deft.app_data_request.v1',request_id:lostId,operation:'record_save',input:lostInput},first.owner.token);
    assert.equal(lost.status,503);
    const durableStatus=await data(first,'request_status',{store_key:'drafts',request_id:lostId});assert.equal(durableStatus.request_status.state,'completed');
    assert.equal((await request(`${dataBase}/connections/${first.begun.session_id}/requests`,{schema_version:'deft.app_data_request.v1',request_id:lostId,operation:'record_save',input:lostInput},first.owner.token)).status,409,'same request UUID cannot blindly replay after loss');
    firstRow=(await data(first,'record_read',{store_key:'drafts',record_id:firstRow.record_id})).record;assert.equal(firstRow.value.subject,'Persisted despite lost response');
    records.set(first.begun.session_id,firstRow);
    if(actionProof){
      // The native 35MiB MIME ceiling also applies after base64 and rich/plain
      // encoding. Keep the independently verified25MiB custody ceiling, then
      // use a valid packet with the same near480KiB body for provider dispatch.
      if(!sendFocused){const large=firstRow.files.find((file:any)=>file.size_bytes>1);assert.ok(large);
      firstRow=(await data(first,'file_detach',{store_key:'drafts',record_id:firstRow.record_id,file_id:large.file_id,upload_revision:large.upload_revision,sha256:large.sha256,
        expected_revision:firstRow.revision,expected_content_digest:firstRow.content_digest})).record;}
      records.set(first.begun.session_id,firstRow);
      const opened=await call(`/api/app-experiences/${installed.id}/main/sessions`,{resource_target_key:first.owner.resource.target_key},first.owner.token),experienceId=opened.pin.session_id;
      const access=await call(`/api/app-experiences/sessions/${experienceId}/access/review`,{},first.owner.token);
      await call(`/api/app-experiences/sessions/${experienceId}/access/accept`,{review_token:access.review_token,review_digest:access.review_digest,accept_exposure:true},first.owner.token);
      const broker=`${dataBase}/experiences/${experienceId}/targets/${first.owner.resource.target_key}/actions`,idempotency=randomUUID();
      const sendReview=await call(`${broker}/send_message/prepare`,{connection_session_id:first.begun.session_id,store_key:'drafts',record_id:firstRow.record_id,
        expected_revision:firstRow.revision,content_digest:firstRow.content_digest,idempotency_key:idempotency},first.owner.token);
      assert.equal(sendReview.prepared.record_id,firstRow.record_id);assert.equal(sendReview.prepared.revision,firstRow.revision);assert.equal(Object.keys(sendReview.input).length,17);
      const {authorizeReleasedAppDataAction}=await import('../src/lib/app-data-authority.js');
      const nomination={org_id:org,owner_id:first.owner.userId,installation_id:installed.id,app_version_id:version!.id,grant_snapshot_id:grant!.id,
        runtime_registration_id:actionBinding.registration_id,runtime_binding_id:actionBinding.binding_id,operation_name:'send_message',input:sendReview.input};
      assert.equal(await authorizeReleasedAppDataAction(nomination),true,'real durable prepared journal proves scopeddata authority independently of action registration');
      for(const changed of [{prepared_digest:'sha256:'+'0'.repeat(64)},{data_consent_digest:'sha256:'+'0'.repeat(64)},{connection_revision:sendReview.input.connection_revision+1},{mime_digest:'sha256:'+'0'.repeat(64)}])
        assert.equal(await authorizeReleasedAppDataAction({...nomination,input:{...nomination.input,...changed}}),false,'changed released scalar pin cannot reuse data proof');
      assert.equal(await authorizeReleasedAppDataAction({...nomination,owner_id:second.owner.userId}),false);
      const confirmation={ticket:sendReview.ticket,expected_input_digest:sendReview.input_digest};
      assert.equal((await request(`${broker}/confirm`,confirmation,second.owner.token)).status,403);
      const queued=await call(`${broker}/confirm`,confirmation,first.owner.token),replayed=await call(`${broker}/confirm`,confirmation,first.owner.token);
      assert.equal(queued.run.id,replayed.run.id,'trusted human confirm replays one exact existing Run');
      console.log(`# synthetic trusted confirmation ready; prepared_remaining_ms=${Date.parse(sendReview.prepared.expires_at)-Date.now()}`);
      const sent=await new Promise<any>((done,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic Send process timeout')),40000);
        const listen=(message:any)=>{if(message.event==='send_result'){clearTimeout(timer);child!.off('message',listen);done(message);}};child!.on('message',listen);child!.send('run-send');});
      assert.equal(sent.error,undefined);assert.equal(sent.result.status,'returned');assert.equal(sent.result.provider_succeeded,true);
      assert.equal(providerRequests.filter(url=>new URL(url).pathname.endsWith('/messages/send')).length,1,'only the immutable reviewed provider packet is dispatched once');
      const sentRow=(await data(first,'record_read',{store_key:'drafts',record_id:firstRow.record_id})).record;
      assert.equal(sentRow.status,'submitted');assert.equal(sentRow.summary.send_state,'accepted');records.set(first.begun.session_id,sentRow);
      const [run]=await db.select().from(s.appRuns).where(eq(s.appRuns.id,queued.run.id));assert.equal(run!.state,'succeeded');
      const consentId=sendReview.input.data_consent_id;await call(`${dataBase}/connections/${first.begun.session_id}/consent/revoke`,{consent_id:consentId},first.owner.token);
      assert.equal(await authorizeReleasedAppDataAction(nomination),false,'current explicit data consent revocation fences retained release');
      const review=await call(`${dataBase}/connections/${first.begun.session_id}/consent/review`,{store_key:'drafts',expires_at:new Date(Date.now()+300000).toISOString()},first.owner.token);
      await call(`${dataBase}/connections/${first.begun.session_id}/consent/activate`,{store_key:'drafts',expires_at:review.snapshot.expires_at,consent_id:review.snapshot.consent_id,expected_review_digest:review.review_digest,accept_host_policy:true},first.owner.token);
    }
    const journalFiles = (await readdir(storeRoot)).filter(file => file.endsWith('.json'));
    assert.ok(journalFiles.length >= 6, 'one writer persisted encrypted independent sessions and custody rows');
    for (const file of journalFiles) {
      const raw = await readFile(join(storeRoot, file), 'utf8');
      const row = JSON.parse(raw); assert.ok(row.ciphertext); assert.ok(row.revision >= 1);
      for (const session of sessions) assert.equal(raw.includes(session.owner.code), false);
      assert.equal(raw.includes('fixture-only-access-'), false); assert.equal(raw.includes('fixture-only-refresh-'), false);
    }
    await stopRuntime(); await bootRuntime();
    for(const session of sessions){const previous=records.get(session.begun.session_id),reopened=await data(session,'record_read',{store_key:'drafts',record_id:previous.record_id});
      assert.deepEqual(reopened.record,previous,'restart preserves app-owned CAS record and file revision/digest catalog');}
    for (const session of sessions) {
      assert.deepEqual((await call(base + '/status', {session_id: session.begun.session_id}, session.owner.token)).account, session.connected.account);
    }
    assert.equal(providerRequests.filter(url=>url==='https://oauth2.googleapis.com/token').length,2,'restart/status did not replay either OAuth exchange');
    if(!sendFocused)for(const session of sessions){const prior=resourceRows.get(session.begun.session_id),refresh=await data(session,'resource_refresh',{store_key:'drafts',resource_key:'inbox'});
      assert.equal(refresh.outcome,'completed');assert.equal(refresh.freshness.provider_observed,true);
      const list=await data(session,'resource_list',{store_key:'drafts',resource_key:'inbox',cursor:null,limit:10});assert.equal(list.items[0].record_id,prior.record_id,'runtime resource UUID locator survives refresh and restart');}
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
    assert.equal(providerRequests.filter(url=>url==='https://oauth2.googleapis.com/token').length,2); assert.equal(transportCalls, 11);
    assert.ok(introspections >= 24, 'both registrations use current public host authority around IO/disclosure');
    await call('/api/app-owner-connections/admissions/' + admission.admission_id + '/revoke', {});
    for(const session of sessions)assert.equal((await call(contextPath,undefined,session.owner.token)).targets.length,0,'revoked admission removes current context');
    for (const session of sessions) assert.equal((await request(base + '/status', {session_id: session.begun.session_id}, session.owner.token)).status, 403);
    assert.equal(transportCalls, 11);
  }

test('app-owned data uses real host PG and external runtime CAS, files and durable reconciliation across restart',
  { skip: !disposableDatabase() || !externalRuntimeAvailable(), timeout: 600000 }, async t => runDataProcessFixture(t));
test('eleven-store context uses real host PG with two fresh authority captures',
  { skip: !disposableDatabase() || !externalRuntimeAvailable(), timeout: 120000 }, async t => runDataProcessFixture(t,true));
