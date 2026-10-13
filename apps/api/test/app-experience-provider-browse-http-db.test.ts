import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildDeftAppPackage } from '@deft/app-kit';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
const target=process.env.DEFT_TEST_DATABASE_URL;
const safe=process.env.DEFT_TEST_ISOLATED_PROVIDER_BROWSE==='true' && target===process.env.DATABASE_URL && !!target
 && new URL(target).hostname==='deft-x02-browse-db-05eaf198'
 && new URL(target).pathname==='/deft_test';

test('HTTP/DB provider browse crosses1000 without projection writes and resolves exact current transient sources',
  { skip: !safe, timeout: 180000 }, async t => {
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
    DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true',
    DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`private-state-test:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: ring('private-enc'), receipt_signing: ring('private-sign'), fingerprint: ring('private-fp') });
  const [{db,closeDb},s,{eq},web,runtime,{Hono},{serve},experienceRoutes,blobRoutes,{AppExperienceExposureService}]=await Promise.all([
    import('../src/lib/db.js'),import('@deft/db/schema'),import('drizzle-orm'),import('../src/lib/web-sessions.js'),import('../src/lib/app-run-runtime.js'),
    import('hono'),import('@hono/node-server'),import('../src/routes/app-experiences.js'),import('../src/routes/app-attachments.js'),import('../src/lib/app-experience-exposure.js')]);
  const {AppConnectionRegistry}=await import('../src/lib/app-connection-registry.js');
  const registry=new AppConnectionRegistry([]);let entries:ConstructorParameters<typeof AppConnectionRegistry>[0]=[];
  registry.select=input=>new AppConnectionRegistry(entries).select(input);
  const app = new Hono();
  app.route('/api/apps/blob', blobRoutes.appAttachmentRoutes);
  app.route('/api/app-experiences', experienceRoutes.createAppExperienceRoutes(undefined,{connectionRegistry:registry}));
  let server!: ReturnType<typeof serve>;
  const base = await new Promise<string>(resolve => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
    address => resolve(`http://127.0.0.1:${address.port}`)); });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve()));
    await (await import('../src/lib/app-attachment-runtime.js')).shutdownAppAttachmentRuntime(); await runtime.shutdownAppRunRuntime(); await closeDb(); });
  const org = randomUUID(), owner = randomUUID(), other = randomUUID(), suffix = randomUUID();
  await db.insert(s.orgs).values({ id: org, name: 'Private file HTTP fixture', slug: `custody-http-${suffix}` });
  await db.insert(s.users).values([{ id: owner, name: 'Owner', email: `custody-owner-${suffix}@example.test` },
    { id: other, name: 'Other', email: `custody-other-${suffix}@example.test` }]);
  await db.insert(s.orgMembers).values([{ id: randomUUID(), org_id: org, user_id: owner, role: 'owner', is_active: true },
    { id: randomUUID(), org_id: org, user_id: other, role: 'admin', is_active: true }]);
  const session = await web.createWebSession({ id: owner, org_id: org, email: `custody-owner-${suffix}@example.test` });
  const otherSession = await web.createWebSession({ id: other, org_id: org, email: `custody-other-${suffix}@example.test` });
  const request = async (path: string, method = 'GET', body?: unknown, token = session.accessToken, scheme = 'Bearer') => {
    const response = await fetch(base + path, { method, headers: { authorization: `${scheme} ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (path: string, method = 'GET', body?: unknown, token = session.accessToken, scheme = 'Bearer') => {
    const result = await request(path, method, body, token, scheme);
    assert.ok(result.status < 300, `${path}: HTTP ${result.status} ${JSON.stringify(result.body)}`); return result.body;
  };
  const parentSchema={type:'object',properties:{parent_record_id:{type:'string',format:'resource_record_list',maxLength:36,maxItems:1,minLength:1,resourceKey:'inbox',readOnly:true}},required:['parent_record_id'],additionalProperties:false};
  const bootstrap=async()=>{
  const fixture = JSON.parse((await runtimeSecurityPackage()).json);
  const {prepareDeftExperienceArtifact}=await import('@deft/app-kit');
  const browseArtifact=await prepareDeftExperienceArtifact('experiences/main.json',{schema_version:'deft.experience_bundle.v3',worker_source:'self.onmessage=()=>{};',entry_view:'main',resource_keys:['inbox'],search_resource_keys:['inbox'],action_keys:['send_message'],state_keys:['drafts','requests']});
  fixture.artifacts=[browseArtifact];fixture.manifest.experiences[0].artifact_digest=browseArtifact.digest;
  fixture.manifest.id = `community.example.custody.a${randomUUID().replaceAll('-', '')}`;
  fixture.manifest.resource_content=[{resource_key:'inbox',document:{max_characters:64}}];
  fixture.manifest.private_capabilities.find((cap:any)=>cap.key==='send_message').input_schema=parentSchema;
  const declaration = fixture.manifest.private_state.find((state: any) => state.key === 'drafts');
  declaration.max_records = 2;declaration.max_record_bytes=1024;
  declaration.schema.properties.reply_record_id={type:'string',maxLength:36};
  declaration.files = { max_file_bytes: 2097152, max_files_per_record: 1, max_total_bytes_per_record: 2097152, allowed_media_types: ['application/pdf'] };
  declaration.action_payloads = [{ action_key: 'send_message', max_payload_bytes: 4194304 }];
  const packed = (await buildDeftAppPackage({ manifest: fixture.manifest, artifacts: fixture.artifacts })).json;
  const { app: installed } = await call('/api/apps/blob/composition/stage', 'POST', packed);
  const installContext = await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);
  const { review: installReview } = await call(`/api/apps/blob/composition/${installed.id}/review`, 'POST', installContext.review_request);
  await call(`/api/apps/blob/composition/${installed.id}/activate`, 'POST', { ...installContext.review_request,
    expected_review_digest: installReview.review_digest, accept_host_policy: true });
  const { setup } = await call(`/api/apps/blob/sync/setup?installation_id=${installed.id}&operator_user_id=${owner}`);
  const resourceInput = { ...setup.descriptors.find((descriptor: any) => descriptor.resource_key === 'inbox').consent_request, target_key: 'personal' };
  const { review: resourceReview } = await call('/api/apps/blob/sync/reviews/prepare', 'POST', resourceInput);
  const { binding: resource } = await call('/api/apps/blob/sync/bindings/activate', 'POST', { ...resourceInput,
    expected_review_digest: resourceReview.review_digest, accept_host_policy: true });
  const { actions } = await call(`/api/apps/blob/composition/${installed.id}/runtime/context?app_version_id=${installed.version_id}`);
  const actionInput = { ...actions.find((action: any) => action.key === 'send_message').review_request,
    owner_resource_binding_id: resource.binding_id };
  const { review: actionReview } = await call('/api/apps/blob/composition/runtime/reviews/prepare', 'POST', actionInput);
  const { binding: action } = await call('/api/apps/blob/composition/runtime/bindings/activate', 'POST', { ...actionInput,
    expected_review_digest: actionReview.review_digest, accept_host_policy: true });
  const opened = await call(`/api/app-experiences/${installed.id}/main/sessions`, 'POST', { resource_target_key: 'personal' });
  const path = `/api/app-experiences/sessions/${opened.pin.session_id}`;
  const access = await call(path + '/access/review', 'POST', {});
  await call(path + '/access/accept', 'POST', { review_token: access.review_token, review_digest: access.review_digest, accept_exposure: true });
  const [storedSession] = await db.select().from(s.appExperienceSessions).where(eq(s.appExperienceSessions.id, opened.pin.session_id));
  assert.ok(storedSession);return {installed,resource,action,opened,storedSession};
  };
  const {installed,resource,action,opened,storedSession}=await bootstrap();
  const rt=await runtime.getAppRunRuntime(),authority=new AppExperienceExposureService(rt.keys);
  const auth=await web.verifyWebAccess(session.accessToken);const host={org_id:auth.org_id,user_id:auth.id,sid:auth.sid,access_expires_at:auth.exp*1000};

  const path='/api/app-experiences/sessions/'+opened.pin.session_id;
  const [binding]=await db.select().from(s.appResourceBindings).where(eq(s.appResourceBindings.id,resource.binding_id));
  const {and}=await import('drizzle-orm');
  const checkpointBefore=(await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.resource_binding_id,resource.binding_id)))[0];
  let providerCalls=0,contentCalls=0,held:()=>Promise<void>=async()=>{};
  const pins={org_id:org,owner_user_id:owner,installation_id:installed.id,app_version_id:storedSession.app_version_id,
    grant_snapshot_id:storedSession.grant_snapshot_id,target_key:'personal',resource_key:'inbox',resource_binding_id:resource.binding_id,
    action_key:'send_message',action_binding_id:action.binding_id};
  entries=[{pins,adapter:{handle:async()=>new Response(null,{status:404}),browseResource:async(input,context)=>{
    await context.recheck();providerCalls++;await held();context.signal?.throwIfAborted();
    const start=input.cursor===null?0:Number(input.cursor.replace('PRIVATE-CURSOR-',''));
    const size=Math.min(input.limit,1025-start);
    const items=Array.from({length:size},(_,i)=>({revision:'revision-'+(start+i),label:'Message '+(start+i),
      data:{subject:'Message '+(start+i),body:'lazy'},provider_source:{locator:{message_id:'PRIVATE-PROVIDER-'+(start+i)}}}));
    await context.recheck();return {schema_version:'deft.app_provider_browse_page.v1',items,next_cursor:start+size<1025?'PRIVATE-CURSOR-'+(start+size):null,
      complete:start+size===1025,observed_at:new Date().toISOString(),count:{returned:size,exact_total:null},failure_count:0};
  },readResource:async(input,context)=>{contentCalls++;await context.recheck();assert.ok(input.record.provider_source);await held();await context.recheck();
    return {format:'plain',content:'Owned provider body beyond retained cache',truncated:false};}}}];
  const browse={operation:'browse',kind:'list',folder:'all'};let cursor:string|undefined,total=0,last='',first='';
  do{
    const page=(await call(path+'/resources/inbox/browse','POST',{...browse,...cursor?{cursor}:{}})).output;
    assert.equal(JSON.stringify(page).includes('PRIVATE-PROVIDER'),false);assert.equal(JSON.stringify(page).includes('PRIVATE-CURSOR'),false);
    if(!first)first=page.items[0].record_id;last=page.items.at(-1).record_id;total+=page.items.length;cursor=page.next_cursor??undefined;
  }while(cursor);
  assert.equal(total,1025);assert.equal(providerCalls,Math.ceil(1025/Math.min(10,binding.max_records_per_page)));
  assert.deepEqual((await db.select().from(s.appSyncCheckpoints).where(eq(s.appSyncCheckpoints.id,checkpointBefore.id)))[0],checkpointBefore);
  assert.equal((await db.select().from(s.appResourceProjections).where(eq(s.appResourceProjections.resource_binding_id,resource.binding_id))).length,0);
  const detail=await call(path+'/resources/inbox','POST',{schema_version:'deft.experience_resource_request.v1',operation:'read_one',record_id:last});
  assert.equal(detail.output.item.data.subject,'Message 1024');assert.equal(JSON.stringify(detail).includes('PRIVATE-PROVIDER'),false);
  const document=await call(path+'/resources/inbox/content','POST',{operation:'read_document',record_id:last});
  assert.equal(document.output.content,'Owned provider body beyond retained cache');
  const resolve=(id=last)=>authority.withHumanAction(host,opened.pin.session_id,'send_message',async(_tx,a)=>a.resolveActionResources!(parentSchema as never,{parent_record_id:id}));
  const parent=(await resolve()).parent_record_id[0];assert.equal(parent.record_id,last);assert.ok(parent.provider_source);
  assert.equal(parent.resource_binding_id,resource.binding_id);await assert.rejects(resolve(first));await assert.rejects(resolve(randomUUID()));
  assert.equal((await request(path+'/resources/inbox/browse','POST',browse,otherSession.accessToken)).status,404);
  const callsBefore=providerCalls;const bad=(await request(path+'/resources/inbox/browse','POST',{...browse,cursor:last}));
  assert.equal(bad.status,404);assert.equal(providerCalls,callsBefore);
  const search=(await call(path+'/resources/inbox/browse','POST',{operation:'browse',kind:'search',folder:'all',query:'needle'})).output;
  assert.equal((await request(path+'/resources/inbox/browse','POST',{operation:'browse',kind:'search',folder:'all',query:'changed',cursor:search.next_cursor})).status,404);
  const sourceRefs=[{field:'reply_record_id',action_key:'send_message',input_field:'parent_record_id',record_id:last}];
  const draftId=randomUUID(),draftValue={mode:'reply_all',to:'owner@example.test',subject:'Saved reply',body:'Exact saved reply',reply_record_id:last};
  const savedDraft=(await call(path+'/state/drafts','POST',{operation:'put',record_id:draftId,expected_revision:0,value:draftValue,source_refs:sourceRefs})).output.item;
  const pdf=Buffer.from('%PDF-1.7\nsynthetic-owned-pdf\nstartxref\n9\n%%EOF\n');
  const uploaded=await fetch(base+path+'/state/drafts/'+draftId+'/files?expected_revision='+savedDraft.revision+'&upload_operation_id='+randomUUID()+'&filename=owned.pdf',
    {method:'POST',headers:{authorization:'Bearer '+session.accessToken,'content-type':'application/pdf'},body:pdf});
  const uploadedBody=await uploaded.json() as any;assert.equal(uploaded.status,200,JSON.stringify(uploadedBody));
  assert.equal(uploadedBody.draft.revision,savedDraft.revision+1);savedDraft.revision=uploadedBody.draft.revision;
  const [draftRow]=await db.select().from(s.appPrivateStateRecords).where(and(eq(s.appPrivateStateRecords.org_id,org),eq(s.appPrivateStateRecords.record_id,draftId)));
  assert.ok(draftRow.byte_length>Buffer.byteLength(JSON.stringify(draftValue)));assert.equal(JSON.stringify(draftRow.body).includes('PRIVATE-PROVIDER'),false);
  assert.equal((draftRow.body as any).schema_version,'deft.private_state.secret.v2');
  const failSave=(refs:unknown,value=draftValue)=>request(path+'/state/drafts','POST',{operation:'put',record_id:randomUUID(),expected_revision:0,value,source_refs:refs});
  assert.equal((await failSave([{...sourceRefs[0],input_field:'body'}])).status,404);
  assert.equal((await failSave([{...sourceRefs[0],field:'subject'}])).status,404);
  assert.equal((await failSave([{...sourceRefs[0],record_id:randomUUID()}])).status,404);
  assert.equal((await failSave([{...sourceRefs[0],provider_source:{}}])).status,400);
  assert.equal((await failSave(sourceRefs,{...draftValue,body:'x'.repeat(700)})).status,413);
  const next=await call(`/api/app-experiences/${installed.id}/main/sessions`,'POST',{resource_target_key:'personal'});
  const nextPath='/api/app-experiences/sessions/'+next.pin.session_id;
  const nextReview=await call(nextPath+'/access/review','POST',{});
  await call(nextPath+'/access/accept','POST',{review_token:nextReview.review_token,review_digest:nextReview.review_digest,accept_exposure:true});
  const {experienceProviderHandles}=await import('../src/lib/app-experience-provider-handles.js');experienceProviderHandles.clear();
  const contentBefore=contentCalls;
  assert.equal((await request(nextPath+'/resources/inbox/content','POST',{operation:'read_document',record_id:last})).status,409);assert.equal(contentCalls,contentBefore);
  const reopened=(await call(nextPath+'/state/drafts','POST',{operation:'read',record_id:draftId})).output.item;
  assert.deepEqual(reopened.value,draftValue);assert.equal(JSON.stringify(reopened).includes('PRIVATE-PROVIDER'),false);
  assert.equal((await call(nextPath+'/resources/inbox/content','POST',{operation:'read_document',record_id:last})).output.content,'Owned provider body beyond retained cache');
  const updated=(await call(nextPath+'/state/drafts','POST',{operation:'put',record_id:draftId,expected_revision:savedDraft.revision,value:{...draftValue,body:'Edited saved reply'}})).output.item;
  const [updatedRow]=await db.select().from(s.appPrivateStateRecords).where(and(eq(s.appPrivateStateRecords.org_id,org),eq(s.appPrivateStateRecords.record_id,draftId)));
  const {AppPrivateStateSecrets}=await import('../src/lib/app-private-state-secrets.js');
  const secret=new AppPrivateStateSecrets(rt.keys).openState({org_id:org,owner_user_id:owner,installation_id:installed.id,state_key:'drafts',record_id:draftId,
    resource_target_key:'personal',artifact_digest:updatedRow.artifact_digest,declaration_digest:updatedRow.declaration_digest,revision:updated.revision},updatedRow.body);
  assert.equal(secret.sources.length,1);
  const fileList=await call(nextPath+'/state/drafts/'+draftId+'/files');assert.equal(fileList.files.length,1);experienceProviderHandles.clear();
  const durableParent=await authority.withHumanAction(host,next.pin.session_id,'send_message',async(_tx,a)=>
    a.resolveActionResources!(parentSchema as never,{parent_record_id:last},secret.sources),undefined,'drafts');
  assert.equal(durableParent.parent_record_id[0].record_id,last);assert.ok(durableParent.parent_record_id[0].provider_source);
  await assert.rejects(authority.withHumanAction(host,next.pin.session_id,'send_message',async(_tx,a)=>a.resolveActionResources!(parentSchema as never,{parent_record_id:randomUUID()},secret.sources)));
  const {AppExperienceHumanActionService}=await import('../src/lib/app-experience-human-action-service.js');let snapshotCaptures=0;
  const snapshotService=new AppExperienceHumanActionService(authority,rt,()=>new Date(),{capture:async(_tx,context)=>{
    snapshotCaptures++;assert.equal(context.draft_ref.expected_revision,updated.revision);
    assert.equal(context.draft_value.reply_record_id,last);assert.equal(context.resolved_resources?.parent_record_id[0].record_id,last);
    assert.ok(context.resolved_resources?.parent_record_id[0].provider_source);assert.ok(context.files_policy?.allowed_media_types.includes('application/pdf'));
    throw Error('EXPECTED_READONLY_CAPTURE_BOUNDARY');
  }});
  const snapshotRequest={input:{parent_record_id:last},draft_ref:{draft_state_key:'drafts',draft_id:draftId,expected_revision:updated.revision}};
  await assert.rejects(snapshotService.snapshot(host,next.pin.session_id,'send_message',snapshotRequest),/EXPECTED_READONLY_CAPTURE_BOUNDARY/);
  assert.equal(snapshotCaptures,1);
  await assert.rejects(snapshotService.snapshot(host,next.pin.session_id,'send_message',{...snapshotRequest,input:{parent_record_id:randomUUID()}}));
  assert.equal(snapshotCaptures,1);
  const expiredId=randomUUID();await call(nextPath+'/state/drafts','POST',{operation:'put',record_id:expiredId,expected_revision:0,
    value:{mode:'compose',to:'',subject:'',body:'',reply_record_id:''}});
  await db.update(s.appPrivateStateRecords).set({expires_at:new Date(Date.now()-1)}).where(and(eq(s.appPrivateStateRecords.org_id,org),eq(s.appPrivateStateRecords.record_id,expiredId)));
  assert.equal((await request(nextPath+'/state/drafts','POST',{operation:'read',record_id:expiredId})).status,404);
  await assert.rejects(authority.withHumanAction(host,next.pin.session_id,'send_message',async(_tx,a)=>a.resolveActionResources!(parentSchema as never,
    {parent_record_id:last},secret.sources.map(item=>({...item,scope:'sha256:'+'9'.repeat(64)})))));
  let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(ready=>{release=ready}),started=new Promise<void>(ready=>{entered=ready});
  held=async()=>{entered();await blocked};const reading=request(path+'/resources/inbox/browse','POST',browse);
  await started;await db.update(s.appResourceBindings).set({state:'revoked'}).where(and(eq(s.appResourceBindings.org_id,org),eq(s.appResourceBindings.id,resource.binding_id)));
  release();assert.equal((await reading).status,404);await assert.rejects(resolve(last));
  assert.equal((await request(nextPath+'/state/drafts','POST',{operation:'read',record_id:draftId})).status,404);
  assert.equal((await db.select().from(s.appRuns).where(eq(s.appRuns.org_id,org))).length,0);
});
