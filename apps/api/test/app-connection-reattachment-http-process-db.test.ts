import assert from 'node:assert/strict';
import test from 'node:test';
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
    && url.pathname === '/e3_reattach_process_20261010' && !url.search && !url.hash; } catch { return false; }
}

const runtimeRoot = process.env.DEFT_E2_RUNTIME_ROOT;
const v2=process.env.DEFT_E3_REATTACH_V2==='true';
const actionProof=true;
const sendFocused=true;
function externalRuntimeAvailable() {
  const hostRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  return !!runtimeRoot && isAbsolute(runtimeRoot) && !resolve(runtimeRoot).startsWith(hostRoot)
    && ['server.mjs', 'test-support.mjs', 'contract.mjs'].every(file => existsSync(join(runtimeRoot, file)));
}

// Real host routes/PG and actual child runtime. Only provider fetches and TLS routing are synthetic.
test('fresh reattachment uses isolated real PostgreSQL/public HTTP and external runtime across two upgrades',
  { skip: !disposableDatabase() || !externalRuntimeAvailable(), timeout: 600000 }, async t => {
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
    assert.equal((await db.execute((await import('drizzle-orm')).sql`SELECT current_database() AS name`)).rows[0]?.name,'e3_reattach_process_20261010');
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
      await attachments.shutdownAppAttachmentRuntime(); await runtime.shutdownAppRunRuntime(); await closeDb(); });
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
    let entry = { ...(v2?{connection_protocol:'v2' as const}:{}),org_id: org, installation_id: installed.id, runtime_registration_id: randomUUID(), runtime_epoch: 1, profile,
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
    const bootstrap=await call(`/api/app-connection-sessions/installations/${installed.id}/${v2?'upgrade-context':'context'}`,undefined,tokens.member);
    assert.equal(bootstrap.targets[0].scope.runtime_registration_id,binding.registration_id);assert.equal(bootstrap.targets[0].scope.runtime_epoch,1);
    assert.equal(bootstrap.targets[0].runtime_ready,false);assert.equal(bootstrap.targets[0].session,null);
    entry=enrolledEntry;await writeConfig();
    let actionBinding:any,actionRuntimeSession:any;
    if(actionProof){const actionInput={...admission,owner_resource_binding_id:binding.binding_id,action_key:'send_message'};
      const review=await call('/api/app-owner-connections/actions/review',actionInput,tokens.member);
      actionBinding=(await call('/api/app-owner-connections/actions/activate',{...actionInput,expected_review_digest:review.review.review_digest,accept_host_policy:true},tokens.member)).binding;
      // No action channel is issued or consumed in this test.
    }

    // Actual public authority URL consumed over HTTP by the external process.
    const { serve } = await import('@hono/node-server');
    hostServer = serve({fetch: async (request, ...args) => {
      const path = new URL(request.url).pathname;
      const authorityRequest = ['/api/app-connection-sessions/runtime/authority-v2','/api/app-connection-sessions/runtime/authority','/api/app-connection-sessions/runtime/reattach-authority'].includes(path);
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
      authority_url: `http://127.0.0.1:${hostPort}/api/app-connection-sessions/runtime/authority`,...(v2?{authority_v2_url:`http://127.0.0.1:${hostPort}/api/app-connection-sessions/runtime/authority-v2`}:{}), reattach_authority_url: `http://127.0.0.1:${hostPort}/api/app-connection-sessions/runtime/reattach-authority`, data_authority_url: `http://127.0.0.1:${hostPort}/api/app-data/runtime/authority`, gmail_client_file: clientPath,
      registrations: [{...(v2?{connection_protocol:'v2'}:{}),org_id: org, runtime_registration_id: binding.registration_id, operator_user_id: people.owner,
        runtime_epoch: entry.runtime_epoch, profile_digest: connectionProfileDigest(profile as any),
        target_key: resourceInput.target_key, resource_key: 'inbox'},
        {...(v2?{connection_protocol:'v2'}:{}),org_id: org, runtime_registration_id: secondBinding.registration_id, operator_user_id: people.owner,
          runtime_epoch: secondEntry.runtime_epoch, profile_digest: connectionProfileDigest(profile as any),
          target_key: secondResourceInput.target_key, resource_key: 'inbox'}]}), {mode: 0o600});
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

    let dropActivation=false, moves=0;
    globalThis.fetch=(async(url,options)=>{
      const endpoint=new URL(String(url));assert.equal(endpoint.origin,'https://synthetic-runtime.example.test');
      assert.equal(options?.redirect,'error');assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+runtimeToken);
      const input=new Headers(options?.headers).get('content-type')==='application/json'?JSON.parse(String(options?.body)):null;
      const response=await realFetch(`http://127.0.0.1:${runtimePort}${endpoint.pathname}`,options);
      if(input?.schema_version===(v2?'deft.app_connection_reattach_runtime.v2':'deft.app_connection_reattach_runtime.v1')&&input.operation==='activate'){
        moves++;
        if(dropActivation){dropActivation=false;await response.arrayBuffer();throw Error('Synthetic lost activation response');}
      }
      return response;
    }) as typeof fetch;
    const base='/api/app-connection-sessions',contextPath=`${base}/installations/${installed.id}/${v2?'upgrade-context':'context'}`;
    const peopleScopes=[{token:tokens.member!,user:people.member,target:resourceInput.target_key,code:'fixture-first-account-send',label:'first@example.test'},
      {token:tokens.other!,user:people.other,target:secondResourceInput.target_key,code:'fixture-second-account',label:'second@example.test'}];
    let currentSessions:any[]=[];
    for(const person of peopleScopes){
      const begin=await call(base+(v2?'/v2/begin':'/begin'),{installation_id:installed.id,target_key:person.target},person.token);
      const connected=await call(base+(v2?'/v2/callback':'/callback'),{session_id:begin.session_id,state:begin.callback_state,outcome:'authorized',code:person.code},person.token);
      assert.equal(connected.state,'connected');assert.equal(connected.account.label,person.label);currentSessions.push(connected);
    }
    const accounts=currentSessions.map(session=>session.account.account_ref),initialSessions=structuredClone(currentSessions);
    assert.notEqual(accounts[0],accounts[1]);assert.equal(providerRequests.filter(url=>url==='https://oauth2.googleapis.com/token').length,2);
    const reviewedEntries=[entry,secondEntry!];
    // Synthetic effect states use genuine public-reviewed source/target binding
    // identities and the real DB constraints. No channel/provider effect exists.
    async function effectFixture(bindingId:string,kind:'action'|'resource',state:'pending'|'unknown_outcome'){
      const table=kind==='action'?s.appRuntimeBindings:s.appResourceBindings;
      const [bindingRow]=await db.select().from(table).where(eq(table.id,bindingId));assert.ok(bindingRow);
      const id=randomUUID(),created=new Date(),expiry=new Date(Date.now()+3600000);
      await db.insert(s.appRuns).values({id,org_id:org,contract_version:'deft.app_run.v1',origin_kind:'app',
        initiating_actor_type:kind==='action'?'human':'system',initiating_actor_id:kind==='action'?people.member:bindingId,
        execution_actor_type:kind==='action'?'human':'system',execution_actor_id:kind==='action'?people.member:bindingId,
        provider_kind:'app_runtime',provider_instance_id:bindingRow!.provider_instance_id,
        operation_name:bindingRow!.operation_name,provider_snapshot_id:bindingRow!.provider_snapshot_id,
        origin_app_installation_id:installed.id,origin_app_version_id:bindingRow!.app_version_id,
        origin_app_grant_snapshot_id:bindingRow!.grant_snapshot_id,
        ...(kind==='action'?{origin_runtime_binding_id:bindingId}:{origin_resource_binding_id:bindingId}),
        state,risk_class:bindingRow!.risk_class,review_requirement:bindingRow!.review_requirement,
        review_scope:kind==='action'?'per_invocation':'reviewed_resource_sync',
        retry_class:bindingRow!.retry_class,retention_class:'standard',idempotency_key_version:'fingerprint',
        idempotency_fingerprint:'hmac-sha256:'+createHash('sha256').update(id+'idempotency').digest('hex'),
        input_fingerprint_key_version:'fingerprint',input_fingerprint:'hmac-sha256:'+createHash('sha256').update(id+'input').digest('hex'),
        authorization_snapshot:{synthetic:true},safe_preview:{synthetic:true},root_run_id:id,input_expires_at:expiry,
        result_expires_at:expiry,idempotency_expires_at:expiry,attempt_limit:1,
        ...(kind==='resource'?{execution_release_kind:'policy_satisfied',execution_released_at:created}:{}),
        ...(state==='unknown_outcome'?{unknown_outcome_at:created}:{})});
      return id;
    }
    async function closeFixture(id:string,state:'pending'|'unknown_outcome'){
      await db.update(s.appRuns).set({state:state==='pending'?'cancelled':'failed',terminal_at:new Date(),
        ...(state==='unknown_outcome'?{reconciled_at:new Date()}:{cancelled_at:new Date()})}).where(eq(s.appRuns.id,id));
    }
    async function upgrade(turn:number){
      const [before]=await db.select().from(s.appInstallations).where(eq(s.appInstallations.id,installed.id));
      fixture.manifest.version=`99.0.${turn}`;
      const nextPackage=(await buildDeftAppPackage({manifest:fixture.manifest,artifacts:fixture.artifacts})).json;
      const upgradeBase=`/api/apps/blob/composition/${installed.id}/upgrade`;
      const staged=await call(upgradeBase+'/stage',{schema_version:'deft.app_attachment_upgrade_stage.v1',package_json:nextPackage,expected_lifecycle_epoch:before!.lifecycle_epoch});
      const nextContext=await call(upgradeBase+`/context?app_version_id=${staged.app_version_id}`);
      assert.ok(nextContext.review_request);
      const reviewed=await call(upgradeBase+'/review',nextContext.review_request);
      assert.equal(Object.values(reviewed.review.blockers.old_work).some(count=>Number(count)>0),false);
      await call(upgradeBase+'/activate',{...nextContext.review_request,expected_review_digest:reviewed.review.review_digest,accept_host_policy:true});
      const [next]=await db.select().from(s.appInstallations).where(eq(s.appInstallations.id,installed.id));
      const [nextVersion]=await db.select().from(s.appVersions).where(eq(s.appVersions.id,next!.active_version_id!));
      const [nextGrant]=await db.select().from(s.appGrantSnapshots).where(eq(s.appGrantSnapshots.id,next!.active_grant_snapshot_id!));
      const input={...admissionInput,expected_app_version_id:nextVersion!.id,expected_package_digest:nextVersion!.package_digest,
        expected_grant_snapshot_digest:nextGrant!.snapshot_digest,expected_lifecycle_epoch:next!.lifecycle_epoch,expected_grant_epoch:next!.grant_epoch};
      const reviewedAdmission=await call('/api/app-owner-connections/admissions/review',input);
      const {admission:nextAdmission}=await call('/api/app-owner-connections/admissions/activate',{...input,expected_review_digest:reviewedAdmission.review.review_digest,accept_host_policy:true});
      const newBindings:any[]=[];
      for(const person of peopleScopes){
        const ownerContext=await call(`/api/app-owner-connections/${installed.id}/context`,undefined,person.token);
        const resource=ownerContext.policies[0].admission.resource_request;assert.equal(resource.target_key,person.target);
        const reviewedResource=await call('/api/app-owner-connections/resources/review',resource,person.token);
        const active=await call('/api/app-owner-connections/resources/activate',{...resource,expected_review_digest:reviewedResource.review.review_digest,accept_host_policy:true},person.token);
        if(v2&&person.user===people.member){const actionInput={...nextAdmission,owner_resource_binding_id:active.binding.binding_id,action_key:'send_message'};
         const review=await call('/api/app-owner-connections/actions/review',actionInput,person.token);
         await call('/api/app-owner-connections/actions/activate',{...actionInput,expected_review_digest:review.review.review_digest,accept_host_policy:true},person.token);}
        newBindings.push(active.binding);reviewedEntries.push({...entry,runtime_registration_id:active.binding.registration_id});
      }
      await writeFile(configPath,JSON.stringify({schema_version:'deft.app_connection_http_registrations.v1',entries:reviewedEntries}),{mode:0o600});
      const configuration=JSON.parse(await readFile(runtimeConfigPath,'utf8'));
      for(const [index,person] of peopleScopes.entries())configuration.registrations.push({...(v2?{connection_protocol:'v2'}:{}),org_id:org,runtime_registration_id:newBindings[index].registration_id,
        operator_user_id:people.owner,runtime_epoch:1,profile_digest:connectionProfileDigest(profile as any),target_key:person.target,resource_key:'inbox'});
      await stopRuntime();await writeFile(runtimeConfigPath,JSON.stringify(configuration),{mode:0o600});await bootRuntime();
      return newBindings;
    }
    for(let turn=1;turn<=2;turn++){
      const historical=structuredClone(currentSessions);
      const newBindings=await upgrade(turn);
      if(process.env.DEFT_E3_REATTACH_EXPIRY==='true'){
        const person=peopleScopes[0]!,jwt=(await import('jsonwebtoken')).default;
        const {exp:previousExp,iat:previousIat,...claims}=jwt.decode(person.token) as Record<string,unknown>;
        const shortToken=jwt.sign({...claims,jti:randomUUID()},process.env.JWT_SECRET!,{algorithm:'HS256',expiresIn:8});
        const nominate={installation_id:installed.id,target_key:person.target,source_session_id:historical[0].session_id,request_id:randomUUID()};
        const reviewed=await call(base+'/reattach/review',nominate,shortToken);
        assert.equal(moves,0);assert.equal(reviewed.schema_version,v2?'deft.app_connection_reattach_review.v2':'deft.app_connection_reattach_review.v1');
        assert.ok(Date.parse(reviewed.expires_at)<=Date.now()+8000);
        await new Promise(done=>setTimeout(done,Math.max(1,Date.parse(reviewed.expires_at)-Date.now()+100)));
        assert.equal((await request(base+'/reattach/status',{session_id:reviewed.session_id},shortToken)).status,401);
        const expired=await call(base+'/reattach/status',{session_id:reviewed.session_id},person.token);
        assert.equal(expired.state,'not_connected');assert.equal(moves,0);
        assert.equal((await request(base+'/reattach/activate',{session_id:reviewed.session_id,review_digest:reviewed.review_digest},person.token)).status,409);
        const replacement=await call(base+'/reattach/review',{...nominate,request_id:randomUUID()},person.token);
        assert.equal(replacement.schema_version,v2?'deft.app_connection_reattach_review.v2':'deft.app_connection_reattach_review.v1');assert.notEqual(replacement.session_id,reviewed.session_id);
        assert.equal(moves,0);assert.equal(providerRequests.filter(url=>url==='https://oauth2.googleapis.com/token').length,2);
        console.log('# E3 expired review recovered under renewed JWT; fresh review admitted; no activation/OAuth replay');
        return;
      }
      const replacements:any[]=[];
      for(const [index,person] of peopleScopes.entries()){
        const old=historical[index],before=providerRequests.length;
        assert.equal((await request(base+'/status',{session_id:old.session_id},person.token)).status,403);
        const context=await call(contextPath,undefined,person.token);
        assert.equal(context.targets[0].session,null);assert.equal(context.targets[0].reattachment.candidate.source_session_id,old.session_id);
        assert.equal(providerRequests.length,before);
        const nominate={installation_id:installed.id,target_key:person.target,source_session_id:old.session_id,request_id:randomUUID()};
        assert.equal((await request(base+'/reattach/review',nominate,peopleScopes[1-index]!.token)).status,403);
        if(index===0){
          for(const [bindingId,kind] of [[turn===1?actionBinding.binding_id:old.scope.resource_binding_id,turn===1?'action':'resource'],
            [newBindings[index].binding_id,'resource']] as const){
            for(const state of ['pending','unknown_outcome'] as const){
              const id=await effectFixture(bindingId,kind,state),callsBefore=moves;
              const denied=await request(base+'/reattach/review',{...nominate,request_id:randomUUID()},person.token);
              assert.equal(denied.status,403,`${kind} ${state} source/target effect fences review`);assert.equal(moves,callsBefore);
              await closeFixture(id,state);
              const [closed]=await db.select().from(s.appRuns).where(eq(s.appRuns.id,id));
              assert.equal(closed!.state,state==='pending'?'cancelled':'failed');
            }
          }
        }
        const reviewed=await call(base+'/reattach/review',nominate,person.token);
        assert.equal(reviewed.schema_version,v2?'deft.app_connection_reattach_review.v2':'deft.app_connection_reattach_review.v1');assert.equal(reviewed.account.account_ref,accounts[index]);
        assert.equal((await request(base+'/callback',{session_id:reviewed.session_id,state:'a'.repeat(43),outcome:'denied'},person.token)).status,409);
        const pending=await call(contextPath,undefined,person.token);
        assert.equal(pending.targets[0].reattachment.pending.session_id,nominate.request_id);
        assert.equal(pending.targets[0].reattachment.pending.activation_started,false);
        const duplicate=await request(base+'/reattach/review',{...nominate,request_id:randomUUID()},person.token);
        assert.equal(duplicate.status,403,'current pending target cannot acquire a second custody move');
        dropActivation=turn===1&&index===0;
        const activated=await call(base+'/reattach/activate',{session_id:reviewed.session_id,review_digest:reviewed.review_digest},person.token);
        let connected=activated;
        if(activated.state==='indeterminate'){
          const unknown=await call(contextPath,undefined,person.token);assert.equal(unknown.targets[0].reattachment.pending.activation_started,true);
          assert.equal(unknown.targets[0].reattachment.pending.review,null);
          await stopRuntime();await bootRuntime();
          connected=await call(base+'/reattach/status',{session_id:reviewed.session_id},person.token);
        }
        assert.equal(connected.state,'connected');assert.equal(connected.account.account_ref,accounts[index]);
        assert.equal((await request(base+'/reattach/activate',{session_id:reviewed.session_id,review_digest:reviewed.review_digest},person.token)).status,409);
        assert.deepEqual((await call(base+'/reattach/status',{session_id:reviewed.session_id},person.token)),connected);
        assert.equal(providerRequests.length,before,'reattachment never exchanges OAuth or fetches mail');
        replacements.push(connected);
      }
      currentSessions=replacements;
    }
    assert.equal(moves,4);assert.equal(providerRequests.filter(url=>url==='https://oauth2.googleapis.com/token').length,2);
    // A final guard-only upgrade leaves the attempted nomination uncertain.
    // It must remain fenced; do not reset/retry it merely to finish connected.
    const guardedBindings=await upgrade(3),person=peopleScopes[0]!,source=currentSessions[0],guardReview=await call(base+'/reattach/review',{
      installation_id:installed.id,target_key:person.target,source_session_id:source.session_id,request_id:randomUUID()},person.token);
    const pendingId=await effectFixture(guardedBindings[0].binding_id,'resource','pending');
    const blocked=await request(base+'/reattach/activate',{session_id:guardReview.session_id,review_digest:guardReview.review_digest},person.token);
    assert.equal(blocked.status,403);assert.equal(blocked.body.code,'APP_ACCESS_DENIED');assert.equal(moves,4);
    await closeFixture(pendingId,'pending');
    assert.equal((await request(base+'/reattach/activate',{session_id:guardReview.session_id,review_digest:guardReview.review_digest},person.token)).status,409);
    assert.equal((await request(base+(v2?'/v2/begin':'/begin'),{installation_id:installed.id,target_key:person.target},person.token)).status,409,
      'consumed activation uncertainty never releases the same admitted scope');
    const unknown=await call(contextPath,undefined,person.token);
    assert.equal(unknown.targets[0].reattachment.pending.activation_started,true);assert.equal(unknown.targets[0].reattachment.pending.review,null);
    for(const [index,session] of initialSessions.entries()){
      const [stored]=await db.select().from(s.appConnectionSessions).where(eq(s.appConnectionSessions.session_id,session.session_id));
      assert.equal((stored!.record as any).account.account_ref,accounts[index]);assert.equal((stored!.record as any).state,'connected');
    }
    assert.equal((await call(contextPath,undefined,tokens.owner)).targets.length,0);
    console.log('# E3 synthetic reattachment '+JSON.stringify({upgrades:2,guard_only_upgrade:1,accounts:2,activation_calls:moves,oauth_exchanges:2,provider_requests:providerRequests.length}));
  });

test('isolated PostgreSQL serializes ordinary Begin and reattachment admission; expiry never releases consumed uncertainty',
  {skip:!disposableDatabase(),timeout:60000},async t=>{
    const [{default:pg},{drizzle},schema,{PostgresAppConnectionSessionStore},{AppConnectionSessionRecordSchema}]=await Promise.all([
      import('pg'),import('drizzle-orm/node-postgres'),import('@deft/db/schema'),import('../src/lib/app-connection-session-store.js'),
      import('../src/lib/app-connection-session-service.js')]);
    const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});t.after(()=>pool.end());
    const database=drizzle(pool,{schema}),org=randomUUID(),owner=randomUUID(),sid=randomUUID(),installation=randomUUID(),operator=randomUUID();
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'e3_reattach_process_20261010');
    await database.insert(schema.orgs).values({id:org,name:'E3 synthetic admission CAS',slug:'e3-cas-'+org});
    await database.insert(schema.users).values({id:owner,email:'e3-cas-'+owner+'@example.test',name:'Synthetic owner',kind:'human',is_agent:false});
    await database.insert(schema.orgMembers).values({id:randomUUID(),org_id:org,user_id:owner,role:'owner',is_active:true});
    await database.insert(schema.webSessions).values({id:sid,org_id:org,user_id:owner,refresh_token_hash:'synthetic',expires_at:new Date(Date.now()+3600000)});
    const caller={org_id:org,user_id:owner,sid,access_expires_at:Date.now()+3600000};
    const a=new PostgresAppConnectionSessionStore(database,caller),b=new PostgresAppConnectionSessionStore(database,caller);
    const now=new Date().toISOString(),expiry=new Date(Date.now()+300000).toISOString(),hash='sha256:'+'a'.repeat(64);
    const profile={schema_version:'deft.app_connection_profile.v1',key:'fixture',provider_id:'fixture',operator_user_id:operator,
      runtime_requirement_key:'fixture',resource_key:'inbox',action_keys:[],authorization_origin:'https://provider.example',credential_custody:'runtime',executable:false};
    const scope={org_id:org,owner_user_id:owner,installation_id:installation,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),
      package_digest:hash,grant_snapshot_digest:hash,lifecycle_epoch:2,grant_epoch:2,target_key:'race',resource_key:'inbox',resource_binding_id:randomUUID(),
      runtime_registration_id:randomUUID(),operator_user_id:operator,runtime_epoch:1,profile_digest:hash,consent_expires_at:expiry};
    const ordinary=AppConnectionSessionRecordSchema.parse({session_id:randomUUID(),revision:0,scope,profile,state:'starting',
      callback_state_hash:'b'.repeat(64),callback_consumed:false,callback_expires_at:expiry,runtime_session_ref:null,account:null,created_at:now,updated_at:now});
    const reattach=AppConnectionSessionRecordSchema.parse({...ordinary,session_id:randomUUID(),reattachment:{schema_version:'deft.app_connection_reattachment.v1',
      source:{session_id:randomUUID(),session_revision:2,scope:{...scope,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),lifecycle_epoch:1,grant_epoch:1},
        runtime_session_ref:'historical_ref',account_ref:'stable_account'},transport_digest:hash,review_expires_at:expiry,review:null,receipt:null}});
    const winners=await Promise.all([a.create(ordinary),b.create(reattach)]);assert.deepEqual(winners.sort(),[false,true]);
    assert.equal(await a.create({...ordinary,session_id:randomUUID(),scope:{...scope,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),grant_epoch:3,lifecycle_epoch:3}}),true,
      'different admitted version/grant remains independently reconnectable');
    const expired={...ordinary,session_id:randomUUID(),scope:{...scope,target_key:'expired'},callback_expires_at:new Date(Date.now()-1).toISOString()};
    assert.equal(await a.create(expired),true);assert.equal(await b.create({...expired,session_id:randomUUID(),callback_expires_at:expiry}),true);
    const consumed={...ordinary,session_id:randomUUID(),scope:{...scope,target_key:'consumed'},callback_expires_at:new Date(Date.now()-1).toISOString()};
    assert.equal(await a.create(consumed),true);
    assert.equal(await a.compareAndSet({org_id:org,owner_user_id:owner,session_id:consumed.session_id},0,
      {...consumed,revision:1,state:'indeterminate',callback_consumed:true}),true);
    assert.equal(await b.create({...consumed,session_id:randomUUID(),callback_expires_at:expiry}),false);
  });
