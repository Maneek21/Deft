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
const actionProof=true;
const reattachedProof=process.env.DEFT_E3_OBSERVATION_REATTACHED==='true';
const sendFocused=true;
const persistentProof=process.env.DEFT_E3_PERSISTENT_CONSENT==='true';
function externalRuntimeAvailable() {
  const hostRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  return !!runtimeRoot && isAbsolute(runtimeRoot) && !resolve(runtimeRoot).startsWith(hostRoot)
    && ['server.mjs', 'test-support.mjs', 'contract.mjs'].every(file => existsSync(join(runtimeRoot, file)));
}

// Real host routes/PG and actual child runtime. Only provider fetches and TLS routing are synthetic.
test(persistentProof?'explicit persistent account, data and observation grants use public HTTP and bounded renewable channels in isolated PostgreSQL':'reviewed observation uses public owner consent and the retained v3 Run channel in isolated PostgreSQL',
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
    app.route('/api/app-resource-observations',(await import('../src/routes/app-resource-observations.js')).appResourceObservationRoutes);
    app.route('/api/app-resource-sync-channel/v3',(await import('../src/routes/app-attachment-sync-channel.js')).appAttachmentSyncChannelRoutes);
    if(persistentProof)app.route('/api/app-resource-sync-management',(await import('../src/routes/app-resource-sync-management.js')).appResourceSyncManagementRoutes);
    const directory = await mkdtemp(join(tmpdir(), 'deft-e2-session-test-'));
    const observationChannelPath=join(directory,'observation-channel.json');
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
    const {EMAIL_METADATA_DESCRIPTOR}=await import(pathToFileURL(join(runtimeRoot!,'vendor/metadata-resource.mjs')).href);
    fixture.manifest.sync_descriptors=[structuredClone({...EMAIL_METADATA_DESCRIPTOR,key:'inbox'})];
    if(persistentProof)for(const [field,maxLength]of Object.entries({source_record_id:36,source_content_digest:71,source_observed_at:64})){
      fixture.manifest.sync_descriptors[0].record_schema.properties[field]={type:'string',maxLength};fixture.manifest.sync_descriptors[0].record_schema.required.push(field);
    }
    fixture.manifest.id = 'community.example.e2data.a' + org.replaceAll('-', '');
    fixture.manifest.owner_connections = [{ key: 'mailbox', resource_key: 'inbox', action_keys: ['send_message'],
      ...(persistentProof?{allow_until_revoked:true}:{}),max_consent_seconds: 86400, provider_profile_key: 'google_mail', runtime_requirement_key: 'sync_provider' }];
    fixture.manifest.record_stores=[{schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'inbox',runtime_requirement_key:'sync_provider',
      max_record_bytes:491520,max_files:32,max_file_bytes:26214400,max_total_file_bytes:26214400,
      resource_content:{max_presentation_bytes:262144,max_source_bytes:36700160,max_file_bytes:26214400,max_image_bytes:2097152},
      ...(persistentProof?{source_projection:{sync_descriptor_key:'inbox',record_id_field:'source_record_id',content_digest_field:'source_content_digest',observed_at_field:'source_observed_at',projection_identity_field:'logical_message_id',navigation_entry_key:'main'}}:{})}];
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
    let entry = { ...(persistentProof?{connection_protocol:'v2' as const}:{}),org_id: org, installation_id: installed.id, runtime_registration_id: randomUUID(), runtime_epoch: 1, profile,
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
    let { binding } = await call('/api/app-owner-connections/resources/activate', { ...resourceInput,
      expected_review_digest: resourceReview.review_digest, accept_host_policy: true }, tokens.member);
    entry = { ...entry, runtime_registration_id: binding.registration_id }; await writeConfig();
    const secondContext = await call(`/api/app-owner-connections/${installed.id}/context`, undefined, tokens.other);
    const secondResourceInput = secondContext.policies[0].admission.resource_request;
    const {review: secondResourceReview} = await call('/api/app-owner-connections/resources/review', secondResourceInput, tokens.other);
    let {binding: secondBinding} = await call('/api/app-owner-connections/resources/activate', {...secondResourceInput,
      expected_review_digest: secondResourceReview.review_digest, accept_host_policy: true}, tokens.other);
    assert.notEqual(secondBinding.registration_id, binding.registration_id);
    assert.notEqual(secondBinding.binding_id, binding.binding_id);
    secondEntry = {...entry, runtime_registration_id: secondBinding.registration_id}; await writeConfig();
    // Genuine DB epoch/profile setup metadata is available before enrollment;
    // it cannot grant Begin or perform external I/O.
    if(!persistentProof){const enrolledEntry=entry;entry={...entry,runtime_registration_id:randomUUID()};await writeConfig();
    const bootstrap=await call(`/api/app-connection-sessions/installations/${installed.id}/context`,undefined,tokens.member);
    assert.equal(bootstrap.targets[0].scope.runtime_registration_id,binding.registration_id);assert.equal(bootstrap.targets[0].scope.runtime_epoch,1);
    assert.equal(bootstrap.targets[0].runtime_ready,false);assert.equal(bootstrap.targets[0].session,null);
    entry=enrolledEntry;await writeConfig();}
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
      const authorityRequest = ['/api/app-connection-sessions/runtime/authority','/api/app-connection-sessions/runtime/reattach-authority'].includes(path);
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
      authority_url: `http://127.0.0.1:${hostPort}/api/app-connection-sessions/runtime/authority`,
      ...(persistentProof?{authority_v2_url:`http://127.0.0.1:${hostPort}/api/app-connection-sessions/runtime/authority-v2`,consent_continuation_authority_url:`http://127.0.0.1:${hostPort}/api/app-connection-sessions/runtime/consent-continuation-authority`}:{}), reattach_authority_url: `http://127.0.0.1:${hostPort}/api/app-connection-sessions/runtime/reattach-authority`, data_authority_url: `http://127.0.0.1:${hostPort}/api/app-data/runtime/authority`, gmail_client_file: clientPath,
      registrations: [{...(persistentProof?{connection_protocol:'v2'}:{}),org_id: org, runtime_registration_id: binding.registration_id, operator_user_id: people.owner,
        runtime_epoch: entry.runtime_epoch, profile_digest: connectionProfileDigest(profile as any),
        target_key: resourceInput.target_key, resource_key: 'inbox'},
        {...(persistentProof?{connection_protocol:'v2'}:{}),org_id: org, runtime_registration_id: secondBinding.registration_id, operator_user_id: people.owner,
          runtime_epoch: secondEntry.runtime_epoch, profile_digest: connectionProfileDigest(profile as any),
          target_key: secondResourceInput.target_key, resource_key: 'inbox'}]}), {mode: 0o600});
    async function bootRuntime() {
      const childEnvironment: NodeJS.ProcessEnv = {DEFT_E2_RUNTIME_ROOT: runtimeRoot!, EMAIL_RUNTIME_CONFIG_FILE: runtimeConfigPath, DEFT_E3_OBSERVATION_CHANNEL_FILE:observationChannelPath};
      if(actionProof)childEnvironment.EMAIL_RUNTIME_MANUAL_SEND='true';
      // Independent runtime receives its synthetic operator file and OS paths;
      // host database credentials, keyrings and inherited provider secrets stay out.
      for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'TMPDIR']) {
        if (process.env[key] !== undefined) childEnvironment[key] = process.env[key];
      }
      child = fork(fileURLToPath(new URL('./fixtures/app-resource-observation-runtime-process.mjs', import.meta.url)), [], {
        execArgv: [], env: childEnvironment,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
      // Synthetic child output only; never capture runtime/operator configuration.
      let startupError = ''; child.stderr!.on('data', chunk => {startupError += String(chunk).slice(0, 2000);});
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(Error('Synthetic runtime startup timeout')), 10000);
        child!.on('message', (raw: any) => {
          if (raw.event === 'provider_request') providerRequests.push(raw.url);
          if(raw.event==='observation_diagnostic')console.log('# synthetic observation '+JSON.stringify({phase:raw.phase,code:raw.code}));
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
      if(input?.schema_version==='deft.app_connection_reattach_runtime.v1'&&input.operation==='activate'){
        moves++;
        if(dropActivation){dropActivation=false;await response.arrayBuffer();throw Error('Synthetic lost activation response');}
      }
      return response;
    }) as typeof fetch;
    const base='/api/app-connection-sessions',contextPath=`${base}/installations/${installed.id}/context`;
    const peopleScopes=[{token:tokens.member!,user:people.member,target:resourceInput.target_key,code:'fixture-first-account-send',label:'first@example.test'},
      {token:tokens.other!,user:people.other,target:secondResourceInput.target_key,code:'fixture-second-account',label:'second@example.test'}];
    let currentSessions:any[]=[];
    for(const person of peopleScopes){
      const begin=await call(base+(persistentProof?'/v2':'')+'/begin',{installation_id:installed.id,target_key:person.target},person.token);
      assert.equal(begin.state,'awaiting_callback','synthetic OAuth begins with a finite request');
      const connected=await call(base+(persistentProof?'/v2':'')+'/callback',{session_id:begin.session_id,state:begin.callback_state,outcome:'authorized',code:person.code},person.token);
      assert.equal(connected.state,'connected');assert.equal(connected.account.label,person.label);currentSessions.push(connected);
    }
    if(reattachedProof){
      // Genuine public same-app upgrade and fresh reviewed custody move. No
      // prior opt-in, action channel or OAuth exchange is carried forward.
      const priorSessions=structuredClone(currentSessions),providerBefore=providerRequests.length;
      const [before]=await db.select().from(s.appInstallations).where(eq(s.appInstallations.id,installed.id));
      fixture.manifest.version='99.0.1';const nextPackage=(await buildDeftAppPackage({manifest:fixture.manifest,artifacts:fixture.artifacts})).json;
      const upgradeBase=`/api/apps/blob/composition/${installed.id}/upgrade`;
      const staged=await call(upgradeBase+'/stage',{schema_version:'deft.app_attachment_upgrade_stage.v1',package_json:nextPackage,expected_lifecycle_epoch:before!.lifecycle_epoch});
      const nextContext=await call(upgradeBase+`/context?app_version_id=${staged.app_version_id}`),reviewed=await call(upgradeBase+'/review',nextContext.review_request);
      assert.equal(Object.values(reviewed.review.blockers.old_work).some(count=>Number(count)>0),false);
      await call(upgradeBase+'/activate',{...nextContext.review_request,expected_review_digest:reviewed.review.review_digest,accept_host_policy:true});
      const [next]=await db.select().from(s.appInstallations).where(eq(s.appInstallations.id,installed.id));
      const [nextVersion]=await db.select().from(s.appVersions).where(eq(s.appVersions.id,next!.active_version_id!));
      const [nextGrant]=await db.select().from(s.appGrantSnapshots).where(eq(s.appGrantSnapshots.id,next!.active_grant_snapshot_id!));
      const input={...admissionInput,expected_app_version_id:nextVersion!.id,expected_package_digest:nextVersion!.package_digest,expected_grant_snapshot_digest:nextGrant!.snapshot_digest,expected_lifecycle_epoch:next!.lifecycle_epoch,expected_grant_epoch:next!.grant_epoch};
      const admission=await call('/api/app-owner-connections/admissions/review',input);
      await call('/api/app-owner-connections/admissions/activate',{...input,expected_review_digest:admission.review.review_digest,accept_host_policy:true});
      const priorEntries=[entry,secondEntry!],nextBindings:any[]=[];
      for(const person of peopleScopes){const context=await call(`/api/app-owner-connections/${installed.id}/context`,undefined,person.token),resource=context.policies[0].admission.resource_request;
        const review=await call('/api/app-owner-connections/resources/review',resource,person.token);
        nextBindings.push((await call('/api/app-owner-connections/resources/activate',{...resource,expected_review_digest:review.review.review_digest,accept_host_policy:true},person.token)).binding);}
      binding=nextBindings[0];secondBinding=nextBindings[1];entry={...entry,runtime_registration_id:binding.registration_id};secondEntry={...secondEntry!,runtime_registration_id:secondBinding.registration_id};
      await writeFile(configPath,JSON.stringify({schema_version:'deft.app_connection_http_registrations.v1',entries:[...priorEntries,entry,secondEntry]}),{mode:0o600});
      const configuration=JSON.parse(await readFile(runtimeConfigPath,'utf8'));
      for(const [index,person] of peopleScopes.entries())configuration.registrations.push({org_id:org,runtime_registration_id:nextBindings[index].registration_id,operator_user_id:people.owner,runtime_epoch:1,profile_digest:connectionProfileDigest(profile as any),target_key:person.target,resource_key:'inbox'});
      await stopRuntime();await writeFile(runtimeConfigPath,JSON.stringify(configuration),{mode:0o600});await bootRuntime();
      currentSessions=[];
      for(const [index,person] of peopleScopes.entries()){
        const reviewed=await call(base+'/reattach/review',{installation_id:installed.id,target_key:person.target,source_session_id:priorSessions[index].session_id,request_id:randomUUID()},person.token);
        const connected=await call(base+'/reattach/activate',{session_id:reviewed.session_id,review_digest:reviewed.review_digest},person.token);
        assert.equal(connected.state,'connected');assert.equal(connected.account.account_ref,priorSessions[index].account.account_ref);currentSessions.push(connected);
      }
      assert.equal(moves,2);assert.equal(providerRequests.length,providerBefore,'reattachment carries custody without repeating OAuth/provider reads');
    }
    if(persistentProof){
      const beforeProvider=providerRequests.length,old=currentSessions[0];let observedRunId:string|undefined;
      const {currentExperienceResourceConsent}=await import('../src/lib/app-experience-service.js'),{sql}=await import('drizzle-orm');
      const consentClock=new Date();
      for(const [mode,expiry,expected]of [
        ['until_revoked',null,true],[null,new Date(consentClock.getTime()+60000),true],
        [null,null,false],[null,new Date(consentClock.getTime()-1),false],
        ['until_revoked',new Date(consentClock.getTime()+60000),false],['unexpected',null,false],
      ]as const){
        const selected=await db.execute(sql`WITH app_resource_bindings(consent_lifetime,consent_expires_at) AS (VALUES(${mode}::text,${expiry?.toISOString()??null}::timestamptz))
          SELECT 1 AS admitted FROM app_resource_bindings WHERE ${currentExperienceResourceConsent(consentClock)}`);
        assert.equal(selected.rows.length,expected?1:0,'actual PostgreSQL selector denies implicit null, mixed modes and expired grants');
      }
      assert.notEqual(resourceInput.target_key,'primary');
      const experienceBase=`/api/app-experiences/${installed.id}/main`,experienceInput={resource_target_key:resourceInput.target_key};
      const finiteExperience=await call(experienceBase+'/sessions',experienceInput,tokens.member);
      assert.equal(finiteExperience.resource_target_key,resourceInput.target_key,'finite non-primary target remains available');
      assert.ok((await call(experienceBase+'/targets',undefined,tokens.member)).targets.some((row:{key:string})=>row.key===resourceInput.target_key));
      const input={installation_id:installed.id,target_key:resourceInput.target_key,source_session_id:old.session_id,
        request_id:randomUUID(),consent_expires_at:null,consent_lifetime:'until_revoked'};
      assert.equal((await request(base+'/consent-continuation/review',{...input,consent_lifetime:undefined},tokens.member)).status,400);
      assert.equal((await request(base+'/consent-continuation/review',{...input,consent_expires_at:new Date(Date.now()+86400000).toISOString()},tokens.member)).status,400);
      assert.equal((await request(base+'/consent-continuation/review',input,tokens.other)).status,403);
      const review=await call(base+'/consent-continuation/review',input,tokens.member);
      assert.equal(review.scope.consent_expires_at,null);assert.equal(review.scope.consent_lifetime,'until_revoked');
      assert.ok(Date.parse(review.expires_at)>Date.now()&&Date.parse(review.expires_at)<=Date.now()+120000);
      assert.equal((await request(base+'/consent-continuation/activate',{session_id:review.session_id,review_digest:'sha256:'+'0'.repeat(64)},tokens.member)).status,403);
      const connected=await call(base+'/consent-continuation/activate',{session_id:review.session_id,review_digest:review.review_digest},tokens.member);
      assert.equal(connected.state,'connected');assert.equal(connected.expires_at,null);
      assert.equal(connected.account.account_ref,old.account.account_ref);assert.equal(connected.scope.consent_lifetime,'until_revoked');
      currentSessions[0]=connected;
      const persistentExperience=await call(experienceBase+'/sessions',experienceInput,tokens.member);
      assert.equal(persistentExperience.resource_target_key,resourceInput.target_key,'explicit persistent non-primary target can create an Experience');
      assert.ok((await call(experienceBase+'/targets',undefined,tokens.member)).targets.some((row:{key:string})=>row.key===resourceInput.target_key));
      assert.equal((await request(experienceBase+'/sessions',experienceInput,tokens.owner)).status,403,'operator cannot select another owner resource');
      assert.equal((await request(experienceBase+'/sessions',{resource_target_key:'missing_target'},tokens.other)).status,403,'another owner cannot select a target they do not own');
      await t.test('persistent Experience acquires reviews accepts and reads under the same current resource',async()=>{
        const path='/api/app-experiences/sessions/'+persistentExperience.pin.session_id;
        assert.equal((await call(path+'/access/acquire',{},tokens.member)).grant_status,'review_required');
        const disclosure=await call(path+'/access/review',{},tokens.member);
        assert.equal(disclosure.snapshot.resources[0].consent_expires_at,null);assert.equal(disclosure.snapshot.resources[0].consent_lifetime,'until_revoked');
        assert.equal((await call(path+'/access/accept',{review_token:disclosure.review_token,review_digest:disclosure.review_digest,accept_exposure:true},tokens.member)).grant_status,'active');
        assert.equal((await call(path+'/access/acquire',{},tokens.member)).grant_status,'active');
        const listed=await call(path+'/resources/inbox',{schema_version:'deft.experience_resource_request.v1',operation:'list_summary',limit:1},tokens.member);
        assert.deepEqual(listed.output.items,[]);
      });
      const dataBase=`/api/app-data/connections/${connected.session_id}/consent`;
      assert.equal((await request(dataBase+'/review',{store_key:'drafts',expires_at:null},tokens.member)).status,400);
      const dataReview=await call(dataBase+'/review',{store_key:'drafts',expires_at:null,consent_lifetime:'until_revoked'},tokens.member);
      assert.equal(dataReview.snapshot.expires_at,null);assert.equal(dataReview.snapshot.consent_lifetime,'until_revoked');
      assert.ok(Date.parse(dataReview.snapshot.review_expires_at)>Date.now()&&Date.parse(dataReview.snapshot.review_expires_at)<=Date.now()+300000);
      const dataGrant=await call(dataBase+'/activate',{store_key:'drafts',consent_id:dataReview.snapshot.consent_id,
        expires_at:null,consent_lifetime:'until_revoked',expected_review_digest:dataReview.review_digest,accept_host_policy:true},tokens.member);
      assert.equal(dataGrant.expires_at,null);assert.equal(dataGrant.consent_lifetime,'until_revoked');
      const observationBase='/api/app-resource-observations/consent',obsInput={connection_session_id:connected.session_id,
        request_id:randomUUID(),interval_seconds:60,expires_at:null,consent_lifetime:'until_revoked'};
      assert.equal((await request(observationBase+'/review',{...obsInput,consent_lifetime:undefined},tokens.member)).status,400);
      const observation=await call(observationBase+'/review',obsInput,tokens.member);
      assert.deepEqual(await call(observationBase+'/review',obsInput,tokens.member),observation,'lost persistent review ACK retains its original finite review deadline');
      assert.equal(observation.expires_at,null);assert.equal(observation.consent_lifetime,'until_revoked');
      assert.ok(Date.parse(observation.review_expires_at)>Date.now()&&Date.parse(observation.review_expires_at)<=Date.now()+300000);
      await call(observationBase+'/activate',{consent_id:observation.consent_id,review_digest:observation.review_digest},tokens.member);
      await t.test('actual durable scanner selects persistent observation and admits one new read Run',async()=>{
        process.env.DEFT_APP_RESOURCE_SYNC_SCHEDULER_ENABLED='true';
        const scanner=await import('../src/lib/app-resource-sync-scanner.js'),queues=await import('../src/lib/queues.js');
        await queues.cleanupStaleJobs();await scanner.ensureAppResourceSyncScan(0);
        await db.update(s.jobQueue).set({run_at:new Date()}).where(and(eq(s.jobQueue.name,scanner.APP_RESOURCE_SYNC_SCAN_JOB),eq(s.jobQueue.status,'pending')));
        const job=await queues.dequeueJob(queues.QUEUE_NAMES.SCHEDULED_JOBS,{jobName:scanner.APP_RESOURCE_SYNC_SCAN_JOB,leaseMs:60000});assert.ok(job);
        // Isolate this synthetic target within the existing durable scan cursor,
        // without changing any resource cursor, consent, Run or historical row.
        const hex=(BigInt('0x'+binding.binding_id.replaceAll('-',''))-1n).toString(16).padStart(32,'0');
        const predecessor=hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,'$1-$2-$3-$4-$5');
        await db.update(s.jobQueue).set({data:{after_binding_id:predecessor}}).where(eq(s.jobQueue.id,job.id));
        const abort=new AbortController(),attachment=await attachments.getAppAttachmentRuntime();let admittedId:string|undefined;
        const scanned=await scanner.scanAppResourceSyncBindings({...job,signal:abort.signal},{admitDue:async()=>({state:'blocked',reason:'cursor_requires_recovery'})},{async admitObservation(target,limits){
          if(target.resource_binding_id!==binding.binding_id)return{state:'blocked',reason:'cursor_requires_recovery'};
          const result=await attachment.admission.admitObservation(target,limits);if(result.state==='created')admittedId=observedRunId=result.run_id;
          abort.abort();return result;
        }});
        assert.equal(await queues.completeJob(job.id,job.lockToken!),true);assert.equal(scanned.created,1);assert.ok(admittedId);
        const obs=await import('../../../packages/db/src/resource-observation-schema.js');
        const links=await db.select().from(obs.appResourceObservationRuns).where(eq(obs.appResourceObservationRuns.run_id,admittedId));
        assert.equal(links.length,1);assert.equal(links[0]!.consent_id,observation.consent_id);
      });
      const issued=(await call(`/api/apps/blob/sync/bindings/${binding.binding_id}/sessions`,
        {technical_renewal:{renewal_lifetime:'until_revoked',requested_until:null}},tokens.owner)).session;
      assert.equal(issued.renewable_until,null);assert.equal(issued.renewal_lifetime,'until_revoked');
      assert.ok(Date.parse(issued.expires_at)>Date.now()&&Date.parse(issued.expires_at)<=Date.now()+900000);
      const {createDeftResourceSyncClientV3}=await import('@deft/app-kit');
      const client=createDeftResourceSyncClientV3({channel_url:`http://127.0.0.1:${hostPort}/api/app-resource-sync-channel/v3`,
        credential:{session_id:issued.session_id,session_token:issued.session_token},fetch:realFetch});
      await t.test('persistent V3 assignments and own session metadata retain explicit mode',async()=>{
        const assignments=await call('/api/apps/blob/sync/operator/assignments',undefined,tokens.owner);
        const assigned=assignments.assignments.find((row:{binding_id:string})=>row.binding_id===binding.binding_id);assert.ok(assigned);
        assert.equal(assigned.consent_expires_at,null);assert.equal(assigned.consent_lifetime,'until_revoked');
        const sessions=await call(`/api/apps/blob/sync/bindings/${binding.binding_id}/sessions?session_id=${issued.session_id}`,undefined,tokens.owner);
        assert.equal(sessions.sessions.length,1);assert.equal(sessions.sessions[0].session_id,issued.session_id);
        assert.equal(sessions.sessions[0].expires_at,issued.expires_at);
        const legacy=await call('/api/app-resource-sync-management/operator/assignments',undefined,tokens.owner);
        assert.ok(!legacy.assignments.some((row:{binding_id:string})=>row.binding_id===binding.binding_id),'legacy V2 cannot list the V3 binding');
      });
      await t.test('persistent observation claim start heartbeat result and materialized read retain authority',async()=>{
        assert.ok(observedRunId);const claim=await client.claim();assert.ok(claim);assert.equal(claim.run_id,observedRunId);
        const started=await client.start(claim);await client.heartbeat(claim);
        await db.transaction(async tx=>{
          const {loadLiveAttachmentSyncAuthority}=await import('../src/lib/app-attachment-sync-authority.js'),{assertAttachmentStageFinalAuthority}=await import('../src/lib/app-attachment-sync-run.js');
          const [session]=await tx.select().from(s.appRuntimeSessions).where(eq(s.appRuntimeSessions.id,issued.session_id));assert.ok(session);
          const authority=await loadLiveAttachmentSyncAuthority(tx,{org_id:org,session_id:issued.session_id,token_hash:session.token_hash,clock:()=>new Date()});
          const [run]=await tx.select().from(s.appRuns).where(eq(s.appRuns.id,claim.run_id)),[attempt]=await tx.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.id,claim.attempt_id));assert.ok(run);assert.ok(attempt);
          await assertAttachmentStageFinalAuthority(tx,{run,attempt,authority},()=>new Date());
        });
        const {createResourceObservationClient}=await import('@deft/app-kit');
        const observationClient=createResourceObservationClient({channel_url:`http://127.0.0.1:${hostPort}/api/app-resource-observations/runtime`,credential:{session_id:issued.session_id,session_token:issued.session_token},fetch:realFetch});
        assert.equal((await observationClient.authorize(claim)).snapshot.consent_lifetime,'until_revoked');
        const metadata=Object.fromEntries(Object.entries(EMAIL_METADATA_DESCRIPTOR.record_schema.properties).map(([key,value])=>[key,(value as {type:string}).type==='boolean'?false:'']));
        const sourceId=randomUUID(),sourceDigest='sha256:'+'4'.repeat(64);
        Object.assign(metadata,{metadata_version:'deft.email_message_metadata.v1',account_id:connected.account.account_ref,logical_message_id:'synthetic-persistent-message',conversation_id:'synthetic-persistent-conversation',provider:'gmail',label:'Synthetic persistent source',subject:'Synthetic persistent source',body_status:'lazy',files_status:'none',source_record_id:sourceId,source_content_digest:sourceDigest,source_observed_at:new Date().toISOString()});
        await client.result(claim,started,{status:'returned',provider_succeeded:true,page:{schema_version:'deft.app_sync_page.v2',upserts:[{id:'synthetic-persistent-message',revision:'1',data:metadata,attachments:[]}],tombstones:[],next_cursor:null,has_more:false}});
        const [settled]=await db.select().from(s.appRuns).where(eq(s.appRuns.id,observedRunId));assert.equal(settled!.state,'succeeded');
        const projections=await db.select().from(s.appResourceProjections).where(eq(s.appResourceProjections.resource_binding_id,binding.binding_id));assert.equal(projections.length,1);
        const path='/api/app-experiences/sessions/'+persistentExperience.pin.session_id;
        const listed=await call(path+'/resources/inbox',{schema_version:'deft.experience_resource_request.v1',operation:'list_summary',limit:1},tokens.member);
        assert.equal(listed.output.items.length,1);
        const read=await call(path+'/resources/inbox',{schema_version:'deft.experience_resource_request.v1',operation:'read_one',record_id:listed.output.items[0].record_id},tokens.member);
        assert.equal(read.output.item.data.subject,'Synthetic persistent source');
        const {createAppIntegrationPublicationReader}=await import('../src/lib/app-integration-source-publication.js');
        const publication=createAppIntegrationPublicationReader({keys:(await attachments.getAppAttachmentRuntime()).keys,transaction:callback=>db.transaction(callback)});
        const caller={org_id:org,user_id:people.member,kind:'human' as const,principal_id:people.member};
        const source=await publication.resolveProjectionIdentity(caller,{installation_id:installed.id,store_key:'drafts',account_ref:connected.account.account_ref,resource_key:'inbox'},binding.binding_id,'synthetic-persistent-message');
        const published=await publication(caller,source);assert.equal(published.target.ref.record_id,sourceId);assert.equal(published.target.ref.content_digest,sourceDigest);
      });
      // Revoke the issuing browser SID, not the durable permission or transport.
      const principal=await web.verifyWebAccess(tokens.owner!);
      await db.update(s.webSessions).set({revoked_at:new Date()}).where(eq(s.webSessions.id,principal.sid));
      const renewed=await client.renew({expected_expires_at:issued.expires_at});
      assert.equal(renewed.session_id,issued.session_id);assert.equal(renewed.renewable_until,null);
      assert.equal(renewed.renewal_lifetime,'until_revoked');assert.ok(Date.parse(renewed.expires_at)<=Date.now()+900000);
      assert.deepEqual(await client.renew({expected_expires_at:issued.expires_at}),renewed,'lost renewal ACK keeps the current finite lease');
      await db.update(s.orgMembers).set({is_active:false}).where(and(eq(s.orgMembers.org_id,org),eq(s.orgMembers.user_id,people.owner)));
      await assert.rejects(client.renew({expected_expires_at:renewed.expires_at}),'current operator membership is required independently of original SID');
      await call(dataBase+'/revoke',{consent_id:dataGrant.consent_id},tokens.member);
      assert.equal((await call(observationBase+'/revoke',{consent_id:observation.consent_id},tokens.member)).state,'revoked');
      assert.equal((await call(observationBase+'/status',{consent_id:observation.consent_id},tokens.member)).state,'unavailable','operator membership loss keeps the revoked grant unavailable');
      await call(`/api/apps/blob/sync/bindings/${binding.binding_id}/revoke`,{},tokens.member);
      assert.equal((await request(experienceBase+'/sessions',experienceInput,tokens.member)).status,403,'revoked persistent binding remains denied');
      assert.ok(!(await call(experienceBase+'/targets',undefined,tokens.member)).targets.some((row:{key:string})=>row.key===resourceInput.target_key));
      assert.equal(providerRequests.length,beforeProvider,'permission continuation and renewal have no provider I/O');
      console.log('# persistent public HTTP proof '+JSON.stringify({account_continuation:true,same_account:true,data_grant:true,
        observation_grant:true,explicit_null_only:true,finite_review_deadlines:true,v3_same_credential_renewal:true,
        original_browser_revoked:true,current_member_required:true,revocation:true,experience_finite_and_persistent_nonprimary:true,
        experience_foreign_and_revoked_denied:true,experience_null_mode_negatives:true,provider_calls:0}));
      return;
    }
    const observationBase='/api/app-resource-observations/consent',observationContext=`/api/app-resource-observations/installations/${installed.id}/context`;
    const beforeConsent=await call(observationContext,undefined,tokens.member);assert.equal(beforeConsent.targets.length,1);assert.equal(beforeConsent.targets[0].consent,null);assert.equal(beforeConsent.targets[0].attachment_mode,'unsupported');
    assert.equal(beforeConsent.targets[0].connection_session_id,currentSessions[0].session_id);assert.equal(beforeConsent.targets[0].account.label,'first@example.test');
    assert.equal((await call(observationContext,undefined,tokens.owner)).targets.length,0,'operator cannot enumerate owner accounts');
    const attachment=await attachments.getAppAttachmentRuntime();
    const nomination={org_id:org,resource_binding_id:binding.binding_id};
    await assert.rejects(attachment.admission.admitObservation(nomination));
    const reviewInput={connection_session_id:currentSessions[0].session_id,request_id:randomUUID(),interval_seconds:60,
      expires_at:new Date(Date.now()+86400000).toISOString()};
    assert.equal((await request(observationBase+'/review',reviewInput,tokens.other)).status,403);
    const review=await call(observationBase+'/review',reviewInput,tokens.member);
    assert.equal(review.account.account_ref,currentSessions[0].account.account_ref);assert.equal(review.expected_custody_generation,reattachedProof?2:null);
    assert.equal(review.expires_at,currentSessions[0].scope.consent_expires_at);
    assert.deepEqual(await call(observationBase+'/review',reviewInput,tokens.member),review,'lost review acknowledgement resolves exact immutable request');
    assert.equal((await request(observationBase+'/activate',{consent_id:review.consent_id,review_digest:'sha256:'+'f'.repeat(64)},tokens.member)).status,409);
    const active=await call(observationBase+'/activate',{consent_id:review.consent_id,review_digest:review.review_digest},tokens.member);
    assert.equal(active.state,'active');assert.equal(review.attachment_mode,'unsupported');
    assert.deepEqual((await call(observationContext,undefined,tokens.member)).targets[0].consent,{consent_id:review.consent_id,state:'active'});
    await call(base+'/status',{session_id:currentSessions[0].session_id},tokens.member);
    assert.equal((await call(observationBase+'/status',{consent_id:review.consent_id},tokens.member)).state,'active','ordinary status revision does not revoke immutable custody identity');
    const oldEntry=entry;entry={...entry,runtime_epoch:2};await writeConfig();
    assert.equal((await call(observationBase+'/status',{consent_id:review.consent_id},tokens.member)).state,'unavailable');
    await assert.rejects(attachment.admission.admitObservation(nomination),'changed current registration cannot admit observation');
    entry=oldEntry;await writeConfig();
    const obsTables=await import('../../../packages/db/src/resource-observation-schema.js');
    const before=(await db.select().from(obsTables.appResourceObservationConsents)).length;
    const body=JSON.stringify({...reviewInput,request_id:randomUUID()});
    const stream=new ReadableStream({pull(controller){process.env.DEFT_APP_OWNER_CONNECTIONS_ENABLED='false';controller.enqueue(new TextEncoder().encode(body));controller.close();}});
    try{const response=await app.request(observationBase+'/review',{method:'POST',headers:{authorization:'Bearer '+tokens.member,'content-type':'application/json'},body:stream,duplex:'half'} as RequestInit);
      assert.equal(response.status,503);}finally{process.env.DEFT_APP_OWNER_CONNECTIONS_ENABLED='true';}
    assert.equal((await db.select().from(obsTables.appResourceObservationConsents)).length,before,'kill switch after body cannot commit a consent');
    process.env.DEFT_APP_RESOURCE_SYNC_SCHEDULER_ENABLED='true';
    const scanner=await import('../src/lib/app-resource-sync-scanner.js'),queues=await import('../src/lib/queues.js');
    await queues.cleanupStaleJobs();
    await scanner.ensureAppResourceSyncScan(0);
    // Prior isolated fixture crashes can leave a scanner queue lease. The
    // existing maintenance API requeues it with its normal five-second backoff.
    await new Promise(done=>setTimeout(done,5100));
    const job=await queues.dequeueJob(queues.QUEUE_NAMES.SCHEDULED_JOBS,{jobName:scanner.APP_RESOURCE_SYNC_SCAN_JOB,leaseMs:60000});assert.ok(job);
    const {AppResourceSyncAdmissionService}=await import('../src/lib/app-resource-sync-admission.js');
    const {AppRunSecretService}=await import('../src/lib/app-run-secrets.js'),{AppRunSecretRepository}=await import('../src/lib/app-run-secret-repository.js'),{AppResourceSyncSecretService}=await import('../src/lib/app-resource-sync-secrets.js');
    const secrets=new AppRunSecretService(attachment.keys);
    let admissionLag=121000;
    const earlierAdmission=new AppResourceSyncAdmissionService(attachment.repository,new AppRunSecretRepository(secrets),secrets,new AppResourceSyncSecretService(attachment.keys),attachment.runner,()=>new Date(Date.now()-admissionLag),()=>true,'attachment_v3');
    const scanned=await scanner.scanAppResourceSyncBindings({id:job.id,lockToken:job.lockToken!},(await runtime.getAppRunRuntime()).resourceSyncAdmission,earlierAdmission);
    assert.equal(scanned.created,1);assert.ok(scanned.rejected>=0);assert.equal(await queues.completeJob(job.id,job.lockToken!),true);
    const links=await db.select().from(obsTables.appResourceObservationRuns).where(eq(obsTables.appResourceObservationRuns.consent_id,review.consent_id));assert.equal(links.length,1);
    assert.equal(links[0]!.consent_digest,review.review_digest);
    const issued=(await call(`/api/apps/blob/sync/bindings/${binding.binding_id}/sessions`,{},tokens.owner)).session;
    const {createDeftResourceSyncClientV3}=await import('@deft/app-kit');
    const {createResourceObservationClient}=await import('../../../packages/app-kit/src/resource-observation.js');
    const sdk=createDeftResourceSyncClientV3({channel_url:`http://127.0.0.1:${hostPort}/api/app-resource-sync-channel/v3`,credential:{session_id:issued.session_id,session_token:issued.session_token},fetch:realFetch});
    const observationSdk=createResourceObservationClient({channel_url:`http://127.0.0.1:${hostPort}/api/app-resource-observations/runtime`,credential:{session_id:issued.session_id,session_token:issued.session_token},fetch:realFetch});
    const claim=await sdk.claim();assert.ok(claim);assert.equal(claim.run_id,links[0]!.run_id);
    const started=await sdk.start(claim);assert.equal(started.resource_binding_id,binding.binding_id);
    const allowed=await observationSdk.authorize(claim);assert.equal(allowed.snapshot.connection.account_ref,currentSessions[0].account.account_ref);
    assert.equal(allowed.snapshot.connection.expected_custody_generation,reattachedProof?2:null);
    assert.equal(allowed.snapshot.connection.receipt_digest===null,!reattachedProof);assert.equal(allowed.consent_digest,review.review_digest);
    await assert.rejects(sdk.stageAttachment(claim,{parent_resource_id:'mail_synthetic',parent_revision:'1',attachment_key:'synthetic',filename:'synthetic.txt',declared_media_type:'text/plain'},new Uint8Array([1])),'metadata observation cannot stage files');
    const rejectedFiles=await realFetch(`http://127.0.0.1:${hostPort}/api/app-resource-sync-channel/v3/result`,{method:'POST',headers:{authorization:'AppRuntime '+issued.session_token,'content-type':'application/json'},body:JSON.stringify({schema_version:'deft.app_runtime_channel.v3',audience:'app_resource_sync',session_id:issued.session_id,run_id:claim.run_id,attempt_id:claim.attempt_id,claim_token:claim.claim_token,sequence:claim.sequence,status:'returned',provider_succeeded:true,page:{schema_version:'deft.app_sync_page.v2',upserts:[{id:'mail_synthetic',revision:'1',data:{subject:'Synthetic'},attachments:[{attachment_key:'synthetic',staging_id:randomUUID()}]}],tombstones:[],next_cursor:null,has_more:false}})});
    assert.equal(rejectedFiles.status,403,'nonempty observation file results are denied at the public endpoint');
    assert.equal((await db.select().from(s.appResourceProjections).where(eq(s.appResourceProjections.resource_binding_id,binding.binding_id))).length,0);
    await sdk.result(claim,started,{status:'indeterminate'});
    const [unknown]=await db.select().from(s.appRuns).where(eq(s.appRuns.id,claim.run_id));assert.equal(unknown!.state,'unknown_outcome');
    const oldAttempts=await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.run_id,claim.run_id));assert.equal(oldAttempts.length,1);assert.equal(oldAttempts[0]!.state,'unknown_outcome');
    await assert.rejects(sdk.heartbeat(claim));
    // A fresh reviewed read Run, through the existing recovery fingerprint,
    // does not replay or alter the terminal predecessor.
    await assert.rejects(attachment.admission.resumeObservation({...nomination,previous_run_id:claim.run_id},{owner_user_id:people.member,guard:async()=>{}}),'manual recovery cannot shed the observation policy pin');
    admissionLag=61000;
    const sameConsent=await earlierAdmission.admitObservation(nomination);assert.equal(sameConsent.state,'created');
    const nextClaim=await sdk.claim();assert.ok(nextClaim);assert.equal(nextClaim.run_id,sameConsent.run_id);
    const nextStarted=await sdk.start(nextClaim);await sdk.result(nextClaim,nextStarted,{status:'indeterminate'});
    const priorRecovery=await db.select().from(s.appRuns).where(eq(s.appRuns.id,nextClaim.run_id));
    const priorRecoveryAttempts=await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.run_id,nextClaim.run_id));
    const checkpointBeforeRenewal=await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.resource_binding_id,binding.binding_id));
    await call(observationBase+'/revoke',{consent_id:review.consent_id},tokens.member);
    const recoveryReview=await call(observationBase+'/review',{...reviewInput,request_id:randomUUID()},tokens.member);
    await call(observationBase+'/activate',{consent_id:recoveryReview.consent_id,review_digest:recoveryReview.review_digest},tokens.member);
    await assert.rejects(observationSdk.authorize(nextClaim),'new consent cannot authorize the old unknown attempt');
    const recovery=await attachment.admission.admitObservation(nomination);assert.equal(recovery.state,'created','new current consent admits a NEW read without reviving the revoked predecessor');
    assert.notEqual(recovery.run_id,nextClaim.run_id);
    const [recoveryLink]=await db.select().from(obsTables.appResourceObservationRuns).where(eq(obsTables.appResourceObservationRuns.run_id,recovery.run_id!));
    assert.equal(recoveryLink!.consent_id,recoveryReview.consent_id);assert.equal(recoveryLink!.consent_digest,recoveryReview.review_digest);
    assert.deepEqual(await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.resource_binding_id,binding.binding_id)),checkpointBeforeRenewal,'admission cannot reset or advance the checkpoint');
    assert.deepEqual(await db.select().from(s.appRuns).where(eq(s.appRuns.id,nextClaim.run_id)),priorRecovery,'revoked predecessor remains byte-identical');
    assert.deepEqual(await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.run_id,nextClaim.run_id)),priorRecoveryAttempts,'revoked predecessor attempts are never replayed');
    assert.equal((await attachment.admission.admitObservation(nomination)).state,'existing','one active successor only');
    await assert.rejects(sdk.result(claim,started,{status:'returned',provider_succeeded:true,page:{schema_version:'deft.app_sync_page.v2',upserts:[],tombstones:[],next_cursor:null,has_more:false}}),'stale predecessor cannot publish a late page');
    await writeFile(observationChannelPath,JSON.stringify({channel_url:`http://127.0.0.1:${hostPort}/api/app-resource-sync-channel/v3`,observation_authority_url:`http://127.0.0.1:${hostPort}/api/app-resource-observations/runtime`,credential:{session_id:issued.session_id,session_token:issued.session_token},registration:{org_id:org,runtime_registration_id:binding.registration_id,operator_user_id:people.owner,runtime_epoch:entry.runtime_epoch,profile_digest:connectionProfileDigest(profile as any),target_key:resourceInput.target_key,resource_key:'inbox'}}),{mode:0o600});
    const externalObservation=()=>new Promise<any>((done,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic external observation timeout')),45000);
      const receive=(raw:any)=>{if(raw.event==='observation_result'){clearTimeout(timer);child!.off('message',receive);done(raw);}};child!.on('message',receive);child!.send('run-observation');});
    const firstResult=await externalObservation();assert.equal(firstResult.status,'returned',JSON.stringify(firstResult));assert.equal(firstResult.provider_succeeded,true);assert.equal(firstResult.upserts,1);
    const [completed]=await db.select().from(s.appRuns).where(eq(s.appRuns.id,recovery.run_id!));assert.equal(completed!.state,'succeeded');
    const [checkpoint]=await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.resource_binding_id,binding.binding_id));assert.equal(checkpoint!.cursor_sequence,1);
    assert.equal((await db.select().from(s.appResourceProjections).where(eq(s.appResourceProjections.resource_binding_id,binding.binding_id))).length,1);
    const [settledAttempt]=await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.run_id,recovery.run_id!));
    const output=await new AppRunSecretRepository(secrets).readOutput(org,recovery.run_id!,settledAttempt!.id) as any;
    assert.equal(output.output.upserts[0].data.body_status,'lazy');assert.ok(['none','lazy','unknown'].includes(output.output.upserts[0].data.files_status));assert.deepEqual(output.output.upserts[0].attachments,[]);
    const retained=await db.select().from(s.appRuns).where(eq(s.appRuns.id,claim.run_id));assert.deepEqual(retained,[unknown],'unknown predecessor retained byte-exact');
    assert.deepEqual(await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.run_id,claim.run_id)),oldAttempts,'prior unknown attempt never replayed');
    const providerCount=providerRequests.length;assert.equal((await externalObservation()).status,'no_claim');assert.equal(providerRequests.length,providerCount);
    await stopRuntime();await bootRuntime();assert.equal((await externalObservation()).status,'no_claim');assert.equal(providerRequests.length,providerCount,'restart cannot repeat a completed or unknown provider read');
    const notDue=await attachment.admission.admitObservation(nomination);assert.equal(notDue.state,'not_due','current bounded interval is retained');
    await call(observationBase+'/revoke',{consent_id:recoveryReview.consent_id},tokens.member);
    assert.equal((await call(observationBase+'/status',{consent_id:review.consent_id},tokens.member)).state,'revoked');
    assert.equal((await call(observationContext,undefined,tokens.member)).targets[0].consent.state,'revoked');
    await assert.rejects(attachment.admission.admitObservation(nomination),'opt-out cannot create another Run');
    await assert.rejects(observationSdk.authorize(claim));await assert.rejects(sdk.heartbeat(claim));
    // The exact unknown read remains closable through the normal reviewed
    // human route after opt-out. No consent/custody/attempt evidence is erased.
    const closurePath='/api/apps/blob/sync/unknown-runs';
    const missing=await request(closurePath+'/review',{run_id:claim.run_id},tokens.other);
    assert.equal(missing.status,403,'foreign owner cannot close another account read');
    const leaseWait=Math.max(0,oldAttempts[0]!.lease_expires_at!.getTime()-Date.now()+50);
    assert.ok(leaseWait<=60000,'synthetic closure lease wait remains bounded');
    if(leaseWait)await new Promise(done=>setTimeout(done,leaseWait));
    const {review:closureReview}=await call(closurePath+'/review',{run_id:claim.run_id},tokens.member);
    assert.equal(closureReview.basis,'operator_closes_unknown_sync');assert.equal(closureReview.no_retry,true);
    assert.equal(closureReview.observation.consent_id,review.consent_id);assert.equal(closureReview.observation.consent_digest,review.review_digest);
    assert.equal(closureReview.observation.connection_session_id,currentSessions[0].session_id);
    assert.equal(closureReview.observation.account_ref,currentSessions[0].account.account_ref);
    assert.equal(closureReview.observation.expected_custody_generation,reattachedProof?2:null);
    assert.equal((await request(closurePath+'/activate',{run_id:claim.run_id,expected_review_digest:'sha256:'+'0'.repeat(64),accept_host_policy:true},tokens.member)).status,409);
    const beforeClosureProvider=providerRequests.length,oldLink=await db.select().from(obsTables.appResourceObservationRuns).where(eq(obsTables.appResourceObservationRuns.run_id,claim.run_id));
    const {closure}=await call(closurePath+'/activate',{run_id:claim.run_id,expected_review_digest:closureReview.review_digest,accept_host_policy:true},tokens.member);
    assert.equal(closure.state,'failed');assert.equal(closure.provider_outcome,'unknown');assert.equal(closure.no_retry,true);
    assert.deepEqual((await call(closurePath+'/activate',{run_id:claim.run_id,expected_review_digest:closureReview.review_digest,accept_host_policy:true},tokens.member)).closure,closure,'lost closure acknowledgement resolves original signed receipt');
    assert.equal(providerRequests.length,beforeClosureProvider,'human closure has no provider I/O');
    assert.deepEqual(await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.run_id,claim.run_id)),oldAttempts);
    assert.deepEqual(await db.select().from(obsTables.appResourceObservationRuns).where(eq(obsTables.appResourceObservationRuns.run_id,claim.run_id)),oldLink);
    const [closedRead]=await db.select().from(s.appRuns).where(eq(s.appRuns.id,claim.run_id));
    assert.equal(closedRead!.state,'failed');assert.equal(closedRead!.unknown_outcome_at!.toISOString(),unknown!.unknown_outcome_at!.toISOString());
    assert.deepEqual(closedRead!.authorization_snapshot,unknown!.authorization_snapshot);
    assert.equal((await call(observationBase+'/status',{consent_id:review.consent_id},tokens.member)).state,'revoked');
    // Reproduce the live human-continuation gap through ordinary owner HTTP
    // and the real retained v3/observation channels. The test runtime supplies
    // a synthetic partial baseline; no provider request is needed for this
    // authority check, and the original unknown/closure history stays intact.
    const nextReview=await call(observationBase+'/review',{...reviewInput,request_id:randomUUID()},tokens.member);
    await call(observationBase+'/activate',{consent_id:nextReview.consent_id,review_digest:nextReview.review_digest},tokens.member);
    const providerBeforeContinuation=providerRequests.length;
    const firstAdmission=await attachment.admission.admitObservation(nomination);
    if(firstAdmission.state==='not_due'){
      const wait=Date.parse(firstAdmission.due_at)-Date.now()+50;assert.ok(wait>=0&&wait<=61000);
      if(wait)await new Promise(done=>setTimeout(done,wait));
    }
    const baseline=firstAdmission.state==='not_due'?await attachment.admission.admitObservation(nomination):firstAdmission;
    assert.equal(baseline.state,'created');const baselineClaim=await sdk.claim();assert.ok(baselineClaim);
    const baselineStarted=await sdk.start(baselineClaim);await observationSdk.authorize(baselineClaim);
    await sdk.result(baselineClaim,baselineStarted,{status:'returned',provider_succeeded:true,page:{schema_version:'deft.app_sync_page.v2',upserts:[],tombstones:[],next_cursor:'synthetic-baseline-page-2',has_more:true}});
    const continued=await call(`/api/apps/blob/sync/bindings/${binding.binding_id}/sync`,{continue:true},tokens.member);
    assert.equal(continued.state,'created');const continuedClaim=await sdk.claim();assert.ok(continuedClaim);assert.equal(continuedClaim.run_id,continued.run_id);
    const continuedStarted=await sdk.start(continuedClaim),continuedAuthority=await observationSdk.authorize(continuedClaim);
    assert.equal(continuedAuthority.consent_digest,nextReview.review_digest);
    const [continuedLink]=await db.select().from(obsTables.appResourceObservationRuns).where(eq(obsTables.appResourceObservationRuns.run_id,continued.run_id));
    assert.equal(continuedLink!.consent_id,nextReview.consent_id);assert.equal(continuedLink!.consent_digest,nextReview.review_digest);
    await sdk.result(continuedClaim,continuedStarted,{status:'returned',provider_succeeded:true,page:{schema_version:'deft.app_sync_page.v2',upserts:[],tombstones:[],next_cursor:'synthetic-baseline-page-3',has_more:true}});
    await call(observationBase+'/revoke',{consent_id:nextReview.consent_id},tokens.member);
    const runsBeforeDenied=(await db.select({id:s.appRuns.id}).from(s.appRuns)).length;
    assert.equal((await request(`/api/apps/blob/sync/bindings/${binding.binding_id}/sync`,{continue:true},tokens.member)).status,403);
    assert.equal((await db.select({id:s.appRuns.id}).from(s.appRuns)).length,runsBeforeDenied,'revoked observation cannot downgrade to a manual continuation');
    assert.equal(providerRequests.length,providerBeforeContinuation,'continuation authority proof has no provider invocation');
    console.log('# observation host proof '+JSON.stringify({accounts:2,reattached:reattachedProof,custody_generation:reattachedProof?2:null,reviewed_consents:3,scheduled_runs:5,revoked_consent_recovery:true,human_continuation_pin:true,revoked_continuation_denied:true,unknown_predecessor_preserved:true,external_v3_success:true,metadata_only:true,restart_provider_replay:0,provider_send_requests:0}));
  });
