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
import { buildDeftAppPackage,prepareDeftExperienceArtifact,frameAppData,parseAppDataFrame,APP_DATA_FRAME_MEDIA_TYPE,AppConnectionUpgradeContextSchema } from '@deft/app-kit';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';

function disposableDatabase() {
  const target = process.env.DEFT_E2_TEST_DATABASE_URL;
  if (!target || target !== process.env.DATABASE_URL) return false;
  try { const url = new URL(target); return ['postgres:', 'postgresql:'].includes(url.protocol)
    && url.hostname === '127.0.0.1' && url.port === '33954' && url.username === 'e2_connection_test'
    && url.pathname === '/e3_upgrade_process_20261010' && !url.search && !url.hash; } catch { return false; }
}

const runtimeRoot = process.env.DEFT_E2_RUNTIME_ROOT;
const actionProof=true;
const sendFocused=true;
const organizeProof=process.env.DEFT_E3_ORGANIZE_PROOF==='true';
const organizeItems=Number(process.env.DEFT_E3_ORGANIZE_ITEMS??1);
assert.ok([1,25].includes(organizeItems));
function externalRuntimeAvailable() {
  const hostRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  return !!runtimeRoot && isAbsolute(runtimeRoot) && !resolve(runtimeRoot).startsWith(hostRoot)
    && ['server.mjs', 'test-support.mjs', 'contract.mjs'].every(file => existsSync(join(runtimeRoot, file)));
}

// Real host routes/PG and actual child runtime. Only provider fetches and TLS routing are synthetic.
test('stable OAuth upgrade uses isolated real PostgreSQL/public HTTP and external runtime across two generations',
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
    assert.equal((await db.execute((await import('drizzle-orm')).sql`SELECT current_database() AS name`)).rows[0]?.name,'e3_upgrade_process_20261010');
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
    let profile = { schema_version: 'deft.app_connection_profile.v1', key: 'google_mail', provider_id: 'google_mail',
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
      // No action channel is issued or consumed in this test.
    }

    // Actual public authority URL consumed over HTTP by the external process.
    const { serve } = await import('@hono/node-server');
    hostServer = serve({fetch: async (request, ...args) => {
      const path = new URL(request.url).pathname;
      const authorityRequest = ['/api/app-connection-sessions/runtime/authority','/api/app-connection-sessions/runtime/reattach-authority','/api/app-connection-sessions/runtime/authority-v2','/api/app-connection-sessions/runtime/upgrade-authority'].includes(path);
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
      authority_url: `http://127.0.0.1:${hostPort}/api/app-connection-sessions/runtime/authority`, authority_v2_url: `http://127.0.0.1:${hostPort}/api/app-connection-sessions/runtime/authority-v2`, upgrade_authority_url: `http://127.0.0.1:${hostPort}/api/app-connection-sessions/runtime/upgrade-authority`, data_authority_url: `http://127.0.0.1:${hostPort}/api/app-data/runtime/authority`, gmail_client_file: clientPath,
      registrations: [{org_id: org, runtime_registration_id: binding.registration_id, operator_user_id: people.owner,
        runtime_epoch: entry.runtime_epoch, profile_digest: connectionProfileDigest(profile as any),
        target_key: resourceInput.target_key, resource_key: 'inbox'},
        {org_id: org, runtime_registration_id: secondBinding.registration_id, operator_user_id: people.owner,
          runtime_epoch: secondEntry.runtime_epoch, profile_digest: connectionProfileDigest(profile as any),
          target_key: secondResourceInput.target_key, resource_key: 'inbox'}]}), {mode: 0o600});
    async function bootRuntime() {
      const childEnvironment: NodeJS.ProcessEnv = {DEFT_E2_RUNTIME_ROOT: runtimeRoot!, EMAIL_RUNTIME_CONFIG_FILE: runtimeConfigPath};
      if(actionProof)childEnvironment.EMAIL_RUNTIME_MANUAL_SEND='true';
      if(organizeProof)childEnvironment.DEFT_E3_ORGANIZE_ITEMS=String(organizeItems);
      // Independent runtime receives its synthetic operator file and OS paths;
      // host database credentials, keyrings and inherited provider secrets stay out.
      for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'TMPDIR']) {
        if (process.env[key] !== undefined) childEnvironment[key] = process.env[key];
      }
      child = fork(fileURLToPath(new URL(organizeProof?'./fixtures/app-resource-action-runtime-process.mjs':'./fixtures/app-connection-runtime-process.mjs', import.meta.url)), [], {
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

    let dropCallback=false, moves=0;
    globalThis.fetch=(async(url,options)=>{
      const endpoint=new URL(String(url));assert.equal(endpoint.origin,'https://synthetic-runtime.example.test');
      assert.equal(options?.redirect,'error');assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+runtimeToken);
      const input=new Headers(options?.headers).get('content-type')==='application/json'?JSON.parse(String(options?.body)):null;
      const response=await realFetch(`http://127.0.0.1:${runtimePort}${endpoint.pathname}`,options);
      if(!response.ok){const failed=await response.clone().json() as any;
        const code=typeof failed.code==='string'&&/^EMAIL_[A-Z0-9_]+$/.test(failed.code)?failed.code:'unavailable';
        console.log('# synthetic runtime '+JSON.stringify({operation:input?.operation,status:response.status,code}));}
      if(input?.schema_version==='deft.app_connection_upgrade_runtime.v1'&&input.operation==='callback'){
        moves++;
        if(dropCallback){dropCallback=false;await response.arrayBuffer();throw Error('Synthetic lost activation response');}
      }
      return response;
    }) as typeof fetch;
    const base='/api/app-connection-sessions',contextPath=`${base}/installations/${installed.id}/context`;
    const peopleScopes=[{token:tokens.member!,user:people.member,target:resourceInput.target_key,code:'fixture-first-account-send',label:'first@example.test'},
      {token:tokens.other!,user:people.other,target:secondResourceInput.target_key,code:'fixture-second-account',label:'second@example.test'}];
    let currentSessions:any[]=[];
    for(const person of peopleScopes){
      const begin=await call(base+'/begin',{installation_id:installed.id,target_key:person.target},person.token);
      const connected=await call(base+'/callback',{session_id:begin.session_id,state:begin.callback_state,outcome:'authorized',code:person.code},person.token);
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

    const member=peopleScopes[0]!,sourceAccount=accounts[0];
    async function dataGrant(session:any){
      const path=`/api/app-data/connections/${session.session_id}/consent`;
      const reviewed=await call(path+'/review',{store_key:'drafts',expires_at:new Date(Date.now()+86400000).toISOString()},member.token);
      await call(path+'/activate',{store_key:'drafts',consent_id:reviewed.snapshot.consent_id,expected_review_digest:reviewed.review_digest,
        expires_at:reviewed.snapshot.expires_at,accept_host_policy:true},member.token);
    }
    async function data(session:any,operation:string,input:any){return call(`/api/app-data/connections/${session.session_id}/requests`,{
      schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation,input},member.token);}
    await dataGrant(currentSessions[0]);
    const draftId=randomUUID(),nativeValue={mode:'compose',to:'recipient@example.test',cc:'',bcc:'',subject:'Synthetic stable custody',
      body:'Preserved native draft',body_html:'',reply_record_id:'',attachments:[]};
    let originalDraft=(await data(currentSessions[0],'record_create',{store_key:'drafts',record_id:draftId,value:nativeValue})).record;
    assert.deepEqual(originalDraft.value,nativeValue);
    const ownedBytes=new TextEncoder().encode('Synthetic binary retained across custody generations'),ownedFile=randomUUID();
    const ownedDigest='sha256:'+createHash('sha256').update(ownedBytes).digest('hex');
    const upload={schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'file_upload',input:{store_key:'drafts',
      record_id:draftId,expected_revision:originalDraft.revision,expected_content_digest:originalDraft.content_digest,file_id:ownedFile,
      filename:'preserved.txt',media_type:'text/plain',size_bytes:ownedBytes.length,sha256:ownedDigest}};
    const uploaded=await app.request(`/api/app-data/connections/${currentSessions[0].session_id}/binary`,{method:'POST',
      headers:{authorization:'Bearer '+member.token,'content-type':APP_DATA_FRAME_MEDIA_TYPE},body:frameAppData(upload,ownedBytes) as BodyInit});
    assert.equal(uploaded.status,200);originalDraft=(await uploaded.json() as any).record;
    assert.equal(originalDraft.files.length,1);assert.equal(originalDraft.files[0].sha256,ownedDigest);
    let newBindings:any[]=[],currentActionBindings:any[]=[actionBinding];
    async function upgrade(turn:number){
      const [before]=await db.select().from(s.appInstallations).where(eq(s.appInstallations.id,installed.id));
      fixture.manifest.version=`99.1.${turn}`;
      profile={...profile,key:'google_mail_independent',action_keys:['organize_messages','send_message']};
      fixture.manifest.owner_connections[0]={...fixture.manifest.owner_connections[0],provider_profile_key:profile.key,action_keys:profile.action_keys};
      if(!fixture.manifest.private_capabilities.some((item:any)=>item.key==='organize_messages')){
        fixture.manifest.private_capabilities.push({...structuredClone(fixture.manifest.private_capabilities.find((item:any)=>item.key==='archive_message')),key:'organize_messages'});
        fixture.manifest.runtime_actions.push({...structuredClone(fixture.manifest.runtime_actions.find((item:any)=>item.key==='archive_message')),
          key:'organize_messages',capability_key:'organize_messages'});
      }
      if(organizeProof){
        const properties:Record<string,unknown>={};
        for(const field of ['snapshot_id','account_ref','connection_session_id','data_consent_id'])properties[field]={type:'string',minLength:36,maxLength:36};
        for(const field of ['source_manifest_digest','plan_digest','data_consent_digest','prepared_digest'])properties[field]={type:'string',minLength:71,maxLength:71};
        properties.operation_key={type:'string',maxLength:48};properties.resource_action_version={type:'string',maxLength:64};properties.resource_store_key={type:'string',maxLength:48};
        properties.item_count={type:'number',minimum:1,maximum:25};properties.connection_revision={type:'number',minimum:1,maximum:2147483646};
        const capability=fixture.manifest.private_capabilities.find((item:any)=>item.key==='organize_messages');
        capability.input_schema={type:'object',properties,required:Object.keys(properties),additionalProperties:false};
        const output={operation_id:{type:'string',maxLength:128},operation_key:{type:'string',maxLength:48},item_count:{type:'number',minimum:1,maximum:25},succeeded_count:{type:'number',minimum:0,maximum:25},failed_count:{type:'number',minimum:0,maximum:25},items_json:{type:'string',maxLength:2048},automatic_retry:{type:'boolean'}};
        capability.output_schema={type:'object',properties:output,required:Object.keys(output),additionalProperties:false};
        const declared=await prepareDeftExperienceArtifact('experiences/main.json',{schema_version:'deft.experience_bundle.v3',worker_source:'self.onmessage=()=>{};',entry_view:'main',resource_keys:['inbox'],action_keys:['organize_messages','send_message'],state_keys:[],record_store_keys:['drafts']});
        fixture.artifacts=[declared];fixture.manifest.experiences[0].artifact_digest=declared.digest;
      }
      const candidateEntry={...entry,runtime_registration_id:randomUUID(),profile,connection_protocol:'v2' as const};
      await writeFile(configPath,JSON.stringify({schema_version:'deft.app_connection_http_registrations.v1',entries:[...reviewedEntries,candidateEntry]}),{mode:0o600});
      const nextPackage=(await buildDeftAppPackage({manifest:fixture.manifest,artifacts:fixture.artifacts})).json;
      const upgradeBase=`/api/apps/blob/composition/${installed.id}/upgrade`;
      const staged=await call(upgradeBase+'/stage',{schema_version:'deft.app_attachment_upgrade_stage.v1',package_json:nextPackage,expected_lifecycle_epoch:before!.lifecycle_epoch});
      const nextContext=await call(upgradeBase+`/context?app_version_id=${staged.app_version_id}`);
      const reviewed=await call(upgradeBase+'/review',nextContext.review_request);
      assert.equal(Object.values(reviewed.review.blockers.old_work).some(count=>Number(count)>0),false);
      await call(upgradeBase+'/activate',{...nextContext.review_request,expected_review_digest:reviewed.review.review_digest,accept_host_policy:true});
      const [next]=await db.select().from(s.appInstallations).where(eq(s.appInstallations.id,installed.id));
      const [nextVersion]=await db.select().from(s.appVersions).where(eq(s.appVersions.id,next!.active_version_id!));
      const [nextGrant]=await db.select().from(s.appGrantSnapshots).where(eq(s.appGrantSnapshots.id,next!.active_grant_snapshot_id!));
      const input={...admissionInput,expected_app_version_id:nextVersion!.id,expected_package_digest:nextVersion!.package_digest,
        expected_grant_snapshot_digest:nextGrant!.snapshot_digest,expected_lifecycle_epoch:next!.lifecycle_epoch,expected_grant_epoch:next!.grant_epoch};
      const reviewedAdmission=await call('/api/app-owner-connections/admissions/review',input);
      const activeAdmission=(await call('/api/app-owner-connections/admissions/activate',{...input,expected_review_digest:reviewedAdmission.review.review_digest,accept_host_policy:true})).admission;
      newBindings=[];
      for(const person of peopleScopes){
        const ownerContext=await call(`/api/app-owner-connections/${installed.id}/context`,undefined,person.token);
        const resource=ownerContext.policies[0].admission.resource_request;assert.equal(resource.target_key,person.target);
        const reviewedResource=await call('/api/app-owner-connections/resources/review',resource,person.token);
        const active=await call('/api/app-owner-connections/resources/activate',{...resource,expected_review_digest:reviewedResource.review.review_digest,accept_host_policy:true},person.token);
        newBindings.push(active.binding);
        reviewedEntries.push({...candidateEntry,runtime_registration_id:active.binding.registration_id} as any);
      }
      currentActionBindings=[];
      for(const action of profile.action_keys){
        const input={...activeAdmission,owner_resource_binding_id:newBindings[0].binding_id,action_key:action};
        const reviewed=await call('/api/app-owner-connections/actions/review',input,member.token);
        currentActionBindings.push((await call('/api/app-owner-connections/actions/activate',{...input,expected_review_digest:reviewed.review.review_digest,accept_host_policy:true},member.token)).binding);
      }
      // Explicit bootstrap fixture removes exact operational enrollment while
      // retaining the same reviewed profiles/transport for metadata discovery.
      await writeFile(configPath,JSON.stringify({schema_version:'deft.app_connection_http_registrations.v1',entries:
        [...reviewedEntries,candidateEntry].map(item=>({...item,runtime_registration_id:randomUUID()}))}),{mode:0o600});
      const context=AppConnectionUpgradeContextSchema.parse(await call(base+`/installations/${installed.id}/upgrade-context`,undefined,member.token));
      assert.equal(context.targets.length,1);assert.equal(context.targets[0]!.target_key,member.target);
      assert.equal(context.targets[0]!.runtime_ready,false,'current DB profile metadata is usable before exact runtime enrollment');
      assert.equal(context.targets[0]!.session,null);assert.equal(context.targets[0]!.upgrade.candidate!.source_session_id,current.session_id);
      assert.equal(context.targets[0]!.upgrade.candidate!.account.account_ref,sourceAccount);
      assert.equal((await call(base+`/installations/${installed.id}/context`,undefined,member.token)).targets.length,0,'v1 context never nominates v2');
      const foreign=AppConnectionUpgradeContextSchema.parse(await call(base+`/installations/${installed.id}/upgrade-context`,undefined,peopleScopes[1]!.token));
      assert.equal(foreign.owner_user_id,people.other);assert.equal(foreign.targets.length,1);
      assert.equal(foreign.targets[0]!.scope.owner_user_id,people.other);
      assert.equal(foreign.targets[0]!.upgrade.candidate!.account.account_ref,accounts[1]);
      assert.notEqual(foreign.targets[0]!.upgrade.candidate!.source_session_id,current.session_id,'same target label never shares another owner session');
      await writeFile(configPath,JSON.stringify({schema_version:'deft.app_connection_http_registrations.v1',entries:reviewedEntries}),{mode:0o600});
      const configuration=JSON.parse(await readFile(runtimeConfigPath,'utf8'));
      for(const [index,person] of peopleScopes.entries())configuration.registrations.push({org_id:org,runtime_registration_id:newBindings[index].registration_id,
        operator_user_id:people.owner,runtime_epoch:1,profile_digest:connectionProfileDigest(profile as any),target_key:person.target,resource_key:'inbox',connection_protocol:'v2'});
      await stopRuntime();await writeFile(runtimeConfigPath,JSON.stringify(configuration),{mode:0o600});await bootRuntime();
    }
    let current=currentSessions[0];
    for(let turn=1;turn<=(organizeItems===25?1:2);turn++){
      const source=structuredClone(current),sourceSend=currentActionBindings.find(binding=>binding.action_key==='send_message')??currentActionBindings[0];await upgrade(turn);
      const nomination={installation_id:installed.id,target_key:member.target,source_session_id:source.session_id,request_id:randomUUID()};
      assert.equal((await request(base+'/upgrade/review',nomination,peopleScopes[1]!.token)).status,403);
      const targetSend=currentActionBindings.find(binding=>binding.action_key==='send_message');assert.ok(targetSend);
      for(const [bindingId,kind] of [[source.scope.resource_binding_id,'resource'],[sourceSend.binding_id,'action'],
        [newBindings[0].binding_id,'resource'],[targetSend.binding_id,'action']] as const){
        for(const state of ['pending','unknown_outcome'] as const){
          const id=await effectFixture(bindingId,kind,state),before=moves;
          const blocked=await request(base+'/upgrade/review',{...nomination,request_id:randomUUID()},member.token);
          assert.equal(blocked.status,403,`${state} source and target effects fence review`);assert.equal(moves,before);
          await closeFixture(id,state);
        }
      }
      const wrongProtocol=await request(base+'/begin',{installation_id:installed.id,target_key:member.target},member.token);
      assert.equal(wrongProtocol.status,503);assert.equal(wrongProtocol.body.code,'APP_CONNECTION_PROFILE_UNAVAILABLE');
      const reviewed=await call(base+'/upgrade/review',nomination,member.token);
      assert.equal(reviewed.account.account_ref,sourceAccount);assert.equal(reviewed.custody_generation,turn);
      assert.deepEqual(reviewed.action_consents.map((grant:any)=>grant.action_key),['organize_messages','send_message']);
      assert.equal(new Set(reviewed.action_consents.map((grant:any)=>grant.action_binding_id)).size,2);
      const reviewedContext=AppConnectionUpgradeContextSchema.parse(await call(base+`/installations/${installed.id}/upgrade-context`,undefined,member.token));
      assert.equal(reviewedContext.targets[0]!.runtime_ready,true);assert.equal(reviewedContext.targets[0]!.upgrade.candidate,null);
      assert.equal(reviewedContext.targets[0]!.upgrade.pending!.review!.review_digest,reviewed.review_digest);
      const begun=await call(base+'/upgrade/begin',{session_id:reviewed.session_id,review_digest:reviewed.review_digest},member.token);
      assert.equal(begun.schema_version,'deft.app_connection_upgrade_session.v1');
      const pendingContext=AppConnectionUpgradeContextSchema.parse(await call(base+`/installations/${installed.id}/upgrade-context`,undefined,member.token));
      assert.equal(pendingContext.targets[0]!.upgrade.pending!.begin_consumed,true);assert.equal(pendingContext.targets[0]!.upgrade.pending!.review,null);
      assert.equal(pendingContext.targets[0]!.upgrade.candidate,null);
      for(const secret of ['callback_state','authorization_url','runtime_session_ref'])assert.equal(JSON.stringify(pendingContext).includes('"'+secret+'"'),false);
      assert.equal((await request(base+'/upgrade/begin',{session_id:reviewed.session_id,review_digest:reviewed.review_digest},member.token)).status,409);
      const exchangesBefore=providerRequests.filter(url=>url==='https://oauth2.googleapis.com/token').length;
      dropCallback=turn===1;
      current=await call(base+'/upgrade/callback',{session_id:reviewed.session_id,state:begun.callback_state,outcome:'authorized',code:'fixture-first-account-both'},member.token);
      if(current.state==='indeterminate'){
        await stopRuntime();await bootRuntime();current=await call(base+'/upgrade/status',{session_id:reviewed.session_id},member.token);
      }
      assert.equal(current.state,'connected');assert.equal(current.account.account_ref,sourceAccount);
      const connectedContext=AppConnectionUpgradeContextSchema.parse(await call(base+`/installations/${installed.id}/upgrade-context`,undefined,member.token));
      assert.equal(connectedContext.targets[0]!.session!.session_id,current.session_id);assert.equal(connectedContext.targets[0]!.session!.account!.account_ref,sourceAccount);
      assert.equal(connectedContext.targets[0]!.upgrade.pending,null);
      assert.equal((await request(base+'/upgrade/callback',{session_id:reviewed.session_id,state:begun.callback_state,outcome:'authorized',code:'fixture-first-account-both'},member.token)).status,409);
      assert.equal(providerRequests.filter(url=>url==='https://oauth2.googleapis.com/token').length,exchangesBefore+1);
      const [row]=await db.select().from(s.appConnectionSessions).where(eq(s.appConnectionSessions.session_id,current.session_id));
      assert.equal((row!.record as any).upgrade.receipt.custody_generation,turn+1);
      assert.equal((await request(base+'/status',{session_id:source.session_id},member.token)).status,403);
      await dataGrant(current);
      const preserved=(await data(current,'record_read',{store_key:'drafts',record_id:draftId})).record;
      assert.deepEqual(preserved.value,originalDraft.value);assert.equal(preserved.content_digest,originalDraft.content_digest);
      assert.deepEqual(preserved.files,originalDraft.files);assert.equal(preserved.revision,originalDraft.revision);
      const file=preserved.files[0],readFile=await app.request(`/api/app-data/connections/${current.session_id}/requests`,{method:'POST',
        headers:{authorization:'Bearer '+member.token,'content-type':'application/json'},body:JSON.stringify({schema_version:'deft.app_data_request.v1',
          request_id:randomUUID(),operation:'file_read',input:{store_key:'drafts',record_id:draftId,file_id:ownedFile,upload_revision:file.upload_revision,sha256:ownedDigest}})});
      assert.equal(readFile.status,200);assert.deepEqual(parseAppDataFrame(new Uint8Array(await readFile.arrayBuffer())).bytes,ownedBytes);
      console.log('# stable OAuth upgrade generation '+(turn+1)+'; independent grants and draft bytes preserved');
    }
    assert.equal(moves,organizeItems===25?1:2);assert.equal(providerRequests.filter(url=>url==='https://oauth2.googleapis.com/token').length,organizeItems===25?3:4);
    for(const [index,source] of initialSessions.entries()){
      const [row]=await db.select().from(s.appConnectionSessions).where(eq(s.appConnectionSessions.session_id,source.session_id));
      assert.equal((row!.record as any).state,'connected');assert.equal((row!.record as any).account.account_ref,accounts[index]);
    }
    if(organizeProof){
      const binding=currentActionBindings.find(item=>item.action_key==='organize_messages');assert.ok(binding);
      const issued=(await call(`/api/apps/blob/composition/runtime/bindings/${binding.binding_id}/sessions`,{})).session;
      const [registration]=await db.select().from(s.appRuntimeRegistrations).where(eq(s.appRuntimeRegistrations.id,binding.registration_id));
      const channelPath=join(directory,'organize-channel.json');
      await writeFile(channelPath,JSON.stringify({channel_url:`http://127.0.0.1:${hostPort}/api/app-runtime/channel`,credential:{session_id:issued.session_id,session_token:issued.session_token},registration:{org_id:org,runtime_registration_id:binding.registration_id,runtime_epoch:registration!.runtime_epoch}}),{mode:0o600});
      const configuration=JSON.parse(await readFile(runtimeConfigPath,'utf8'));configuration.runtime_channel_files=[channelPath];
      await stopRuntime();await writeFile(runtimeConfigPath,JSON.stringify(configuration),{mode:0o600});await bootRuntime();
      const page=await data(current,'resource_list',{store_key:'drafts',resource_key:'inbox',query:'in:inbox',cursor:null,limit:organizeItems});
      assert.equal(page.items.length,organizeItems);const source=page.items[0];
      const opened=await call(`/api/app-experiences/${installed.id}/main/sessions`,{resource_target_key:member.target},member.token),experienceId=opened.pin.session_id;
      const access=await call(`/api/app-experiences/sessions/${experienceId}/access/review`,{},member.token);
      await call(`/api/app-experiences/sessions/${experienceId}/access/accept`,{review_token:access.review_token,review_digest:access.review_digest,accept_exposure:true},member.token);
      const broker=`/api/app-data/experiences/${experienceId}/targets/${member.target}/resource-actions`;
      const nomination={connection_session_id:current.session_id,store_key:'drafts',resource_key:'inbox',operation_key:'archive',sources:page.items.map((row:any)=>({resource_key:'inbox',record_id:row.record_id,content_digest:row.content_digest})),idempotency_key:randomUUID()};
      assert.equal((await request(broker+'/organize_messages/prepare',nomination,peopleScopes[1]!.token)).status,403);
      const review=await call(broker+'/organize_messages/prepare',nomination,member.token);
      assert.equal(review.prepared.item_count,organizeItems);assert.equal(review.prepared.preview.items[0].record_id,source.record_id);assert.equal(Object.keys(review.input).length,13);
      const {authorizeReleasedAppDataAction}=await import('../src/lib/app-data-authority.js');
      const [liveInstall]=await db.select().from(s.appInstallations).where(eq(s.appInstallations.id,installed.id));
      const authorized={org_id:org,owner_id:people.member,installation_id:installed.id,app_version_id:liveInstall!.active_version_id!,grant_snapshot_id:liveInstall!.active_grant_snapshot_id!,runtime_registration_id:binding.registration_id,runtime_binding_id:binding.binding_id,operation_name:'organize_messages',input:review.input};
      assert.equal(await authorizeReleasedAppDataAction(authorized),true);
      for(const changed of [{prepared_digest:'sha256:'+'0'.repeat(64)},{item_count:organizeItems===25?24:2},{source_manifest_digest:'sha256:'+'0'.repeat(64)},{connection_revision:review.input.connection_revision+1}])assert.equal(await authorizeReleasedAppDataAction({...authorized,input:{...review.input,...changed}}),false);
      const confirmation={ticket:review.ticket,expected_input_digest:review.input_digest};
      assert.equal((await request(broker+'/confirm',confirmation,peopleScopes[1]!.token)).status,403);
      const queued=await call(broker+'/confirm',confirmation,member.token),replayed=await call(broker+'/confirm',confirmation,member.token);assert.equal(queued.run.id,replayed.run.id);
      const runOnce=(revokeConsent?:string)=>new Promise<any>((done,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic Organize process deadline')),40000);const listen=async(message:any)=>{if(message.event==='organize_phase'&&revokeConsent){try{await call(`/api/app-data/connections/${current.session_id}/consent/revoke`,{consent_id:revokeConsent},member.token);child!.send('resume-organize');}catch(error){clearTimeout(timer);child!.off('message',listen);reject(error);}}if(message.event==='organize_result'){clearTimeout(timer);child!.off('message',listen);done(message);}};child!.on('message',listen);child!.send('run-organize');});
      const executed=await runOnce();assert.equal(executed.error,undefined);assert.equal(executed.result.status,'returned');assert.equal(executed.result.provider_succeeded,true);
      assert.equal(executed.result.output.succeeded_count,organizeItems);assert.deepEqual(JSON.parse(executed.result.output.items_json),page.items.map((row:any)=>({record_id:row.record_id,state:'succeeded'})));
      const effects=()=>providerRequests.filter(url=>/\/messages\/[^/]+\/modify$/u.test(new URL(url).pathname)).length;assert.equal(effects(),organizeItems);
      const [run]=await db.select().from(s.appRuns).where(eq(s.appRuns.id,queued.run.id));assert.equal(run!.state,'succeeded');
      const attempts=await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.run_id,queued.run.id));assert.equal(attempts.length,1);
      await stopRuntime();await bootRuntime();assert.equal((await runOnce()).result,null);assert.equal(effects(),organizeItems,'restart never replays the completed provider effect');
      const retained=(await data(current,'record_read',{store_key:'drafts',record_id:draftId})).record;assert.equal(retained.content_digest,originalDraft.content_digest);assert.deepEqual(retained.files,originalDraft.files);
      if(organizeItems===25){
        const control=(name:string)=>new Promise<void>((done,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic control deadline')),5000);const listen=(message:any)=>{if(message.event==='fixture_control'&&message.state===name){clearTimeout(timer);child!.off('message',listen);done();}};child!.on('message',listen);child!.send(name);});
        const fresh=await data(current,'resource_list',{store_key:'drafts',resource_key:'inbox',query:'in:inbox',cursor:null,limit:25});
        const nominate=(operation:string,rows:any[])=>({...nomination,operation_key:operation,sources:rows.map(row=>({resource_key:'inbox',record_id:row.record_id,content_digest:row.content_digest})),idempotency_key:randomUUID()});
        await control('known-reject');
        const partial=await call(broker+'/organize_messages/prepare',nominate('mark_read',fresh.items.slice(0,3)),member.token);
        await call(broker+'/confirm',{ticket:partial.ticket,expected_input_digest:partial.input_digest},member.token);
        const rejected=await runOnce();assert.equal(rejected.result.status,'returned');assert.equal(rejected.result.output.succeeded_count,2);assert.equal(rejected.result.output.failed_count,1);assert.equal(effects(),28);
        const again=await data(current,'resource_list',{store_key:'drafts',resource_key:'inbox',query:'in:inbox',cursor:null,limit:25});
        const withdrawn=await call(broker+'/organize_messages/prepare',nominate('star',again.items.slice(0,1)),member.token);
        const held=await call(broker+'/confirm',{ticket:withdrawn.ticket,expected_input_digest:withdrawn.input_digest},member.token);
        await control('hold-dispatch');const denied=await runOnce(withdrawn.input.data_consent_id);
        assert.ok(denied.error||denied.result?.status==='indeterminate'||denied.result?.status==='not_attempted');assert.equal(effects(),28,'revocation after durable reservation denies every provider write');
        const [unknown]=await db.select().from(s.appRuns).where(eq(s.appRuns.id,held.run.id));assert.notEqual(unknown!.state,'succeeded');
        const unknownAttempts=await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.run_id,held.run.id));assert.equal(unknownAttempts.length,1);
        console.log('# actual bulk Organize fault proof '+JSON.stringify({items:25,successful_writes:25,known_partial:3,known_refusal:1,revoked_after_reservation_provider_calls:0,automatic_retry:false}));
      }
      console.log('# actual public Organize proof '+JSON.stringify({prepared_pins:13,item_count:organizeItems,provider_modify_calls:effects(),provider_send_calls:0,attempts:1,confirmed_run_replay:true,restart_effect_replay:0}));
    }
    console.log('# stable OAuth public HTTP proof '+JSON.stringify({generations:3,upgrades:2,lost_callback_recovery:1,
      callback_calls:moves,oauth_exchanges:4,independent_actions:2,provider_effects:0}));
  });
