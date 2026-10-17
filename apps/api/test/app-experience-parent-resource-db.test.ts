import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildDeftAppPackage } from '@deft/app-kit';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
const target=process.env.DEFT_TEST_DATABASE_URL;
const safe=process.env.DEFT_TEST_ISOLATED_PARENT_RESOURCE==='true' && target===process.env.DATABASE_URL && !!target
 && new URL(target).hostname==='deft-email-stage1-exact-restore-db-20261001'
 && new URL(target).pathname==='/gate_g_20261001_parent_resource_fresh';

test('DB-backed parent resolution fences exact retained UUID, caller, epoch and revoked binding',
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
  const app = new Hono();
  app.route('/api/apps/blob', blobRoutes.appAttachmentRoutes);
  app.route('/api/app-experiences', experienceRoutes.appExperienceRoutes);
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
  fixture.manifest.id = `community.example.custody.a${randomUUID().replaceAll('-', '')}`;
  fixture.manifest.resource_content=[{resource_key:'inbox',document:{max_characters:64}}];
  fixture.manifest.private_capabilities.find((cap:any)=>cap.key==='send_message').input_schema=parentSchema;
  const declaration = fixture.manifest.private_state.find((state: any) => state.key === 'drafts');
  declaration.max_records = 2;
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
  const [{AppResourceSyncSecretService},{and}]=await Promise.all([import('../src/lib/app-resource-sync-secrets.js'),import('drizzle-orm')]);
  const retain=async(resource:any,tombstone=false)=>{
  const [checkpoint]=await db.select().from(s.appSyncCheckpoints).where(and(eq(s.appSyncCheckpoints.org_id,org),eq(s.appSyncCheckpoints.resource_binding_id,resource.binding_id)));
  assert.ok(checkpoint);const id=randomUUID(),secrets=new AppResourceSyncSecretService(rt.keys),now=new Date();
  const context={org_id:org,resource_binding_id:resource.binding_id,checkpoint_id:checkpoint.id,generation:checkpoint.generation,payload_kind:'projection' as const,projection_id:id};
  const locator=secrets.locator('synthetic-parent-'+id,{org_id:org,resource_binding_id:resource.binding_id,checkpoint_id:checkpoint.id});
  const provider=secrets.sealJson('synthetic-parent-'+id,{...context,slot:'provider_id'}),body=secrets.sealJson({revision:'exact-synthetic-revision',data:{subject:'Synthetic parent',body:'Synthetic original body'}},{...context,slot:'record'});
  await db.insert(s.appResourceProjections).values({id,org_id:org,resource_binding_id:resource.binding_id,checkpoint_id:checkpoint.id,generation:checkpoint.generation,
    resource_id_hmac_key_version:locator.key_version,resource_id_hmac:locator.fingerprint,
    provider_id_envelope_version:provider.schema_version,provider_id_algorithm:provider.algorithm,provider_id_key_version:provider.key_version,
    provider_id_nonce_b64:provider.nonce_b64,provider_id_ciphertext_b64:provider.ciphertext_b64,provider_id_auth_tag_b64:provider.auth_tag_b64,provider_id_bytes:Buffer.from(provider.ciphertext_b64,'base64').length,
    body_envelope_version:tombstone?null:body.schema_version,body_algorithm:tombstone?null:body.algorithm,body_key_version:tombstone?null:body.key_version,body_nonce_b64:tombstone?null:body.nonce_b64,body_ciphertext_b64:tombstone?null:body.ciphertext_b64,body_auth_tag_b64:tombstone?null:body.auth_tag_b64,body_bytes:tombstone?0:Buffer.from(body.ciphertext_b64,'base64').length,
    state:tombstone?'tombstone':'live',tombstoned_at:tombstone?now:null,applied_sequence:1,first_seen_at:now,last_seen_at:now,fresh_until:new Date(now.getTime()+3600000)});
  return id;
  };
  const id=await retain(resource);
  const resolve=(caller=host,recordId=id)=>authority.withHumanAction(caller,opened.pin.session_id,'send_message',async(_tx,a)=>{
    assert.ok(a.resolveActionResources);return a.resolveActionResources(parentSchema as never,{parent_record_id:recordId});
  });
  const result=await resolve();assert.equal(result.parent_record_id.length,1);assert.equal(result.parent_record_id[0].record_id,id);
  assert.equal(result.parent_record_id[0].resource_binding_id,resource.binding_id);assert.equal(result.parent_record_id[0].revision,'exact-synthetic-revision');
  await t.test('foreign-org/owner/session and unknown UUID are denied',async()=>{
    for(const wrong of [{...host,org_id:randomUUID()},{...host,user_id:other},{...host,sid:randomUUID()}])await assert.rejects(resolve(wrong));
    await assert.rejects(resolve(host,randomUUID()));
  });
  await t.test('legal tombstoned retained UUID cannot nominate a parent',async()=>{
    const tombstone=await retain(resource,true);await assert.rejects(resolve(host,tombstone));
    assert.equal((await resolve()).parent_record_id[0].record_id,id);
  });
  await t.test('revoked source binding denies current action authority',async()=>{
    await db.update(s.appResourceBindings).set({state:'revoked'}).where(and(eq(s.appResourceBindings.org_id,org),eq(s.appResourceBindings.id,resource.binding_id)));
    await assert.rejects(resolve());
  });
  await t.test('generic document read uses real authority and withholds bytes after mid-I/O revocation',async()=>{
    const fresh=await bootstrap(),freshId=await retain(fresh.resource);
    const [{AppConnectionRegistry},{AppExperienceResourceContentService}]=await Promise.all([import('../src/lib/app-connection-registry.js'),import('../src/lib/app-experience-resource-content.js')]);
    const pins={org_id:org,owner_user_id:owner,installation_id:fresh.installed.id,app_version_id:fresh.storedSession.app_version_id,
      grant_snapshot_id:fresh.storedSession.grant_snapshot_id,target_key:'personal',resource_key:'inbox',resource_binding_id:fresh.resource.binding_id,action_key:null,action_binding_id:null};
    let calls=0,revoke=false;
    const registry=new AppConnectionRegistry([{pins,adapter:{handle:async()=>new Response(null,{status:404}),readResource:async(input)=>{
      calls++;assert.equal(input.record.record_id,freshId);assert.equal(input.record.revision,'exact-synthetic-revision');
      if(revoke)await db.update(s.appResourceBindings).set({state:'revoked'}).where(and(eq(s.appResourceBindings.org_id,org),eq(s.appResourceBindings.id,fresh.resource.binding_id)));
      return {format:'plain' as const,content:'Synthetic trusted original body',truncated:false};
    }}}]);
    const content=new AppExperienceResourceContentService(authority,async()=>registry);
    const request={operation:'read_document',record_id:freshId};
    const result=await content.read(host,fresh.opened.pin.session_id,'inbox',request);
    assert.equal(result.document.content,'Synthetic trusted original body');assert.equal(calls,1);
    revoke=true;await assert.rejects(content.read(host,fresh.opened.pin.session_id,'inbox',request),error=>
      error instanceof Error && !error.message.includes('Synthetic trusted original body'));
    assert.equal(calls,2,'adapter ran but post-provider real DB authority withheld document');
  });
  await t.test('supported lifecycle change increments epoch and invalidates exact parent session',async()=>{
    const fresh=await bootstrap(),freshId=await retain(fresh.resource);
    const read=()=>authority.withHumanAction(host,fresh.opened.pin.session_id,'send_message',async(_tx,a)=>a.resolveActionResources!(parentSchema as never,{parent_record_id:freshId}));
    assert.equal((await read()).parent_record_id[0].record_id,freshId);
    const [{disableAppInstallation},{humanModuleActor}]=await Promise.all([import('../src/lib/app-service.js'),import('../src/lib/module-service.js')]);
    const [before]=await db.select().from(s.appInstallations).where(and(eq(s.appInstallations.org_id,org),eq(s.appInstallations.id,fresh.installed.id)));
    await disableAppInstallation(humanModuleActor({orgId:org,userId:owner,role:'owner',source:'rest'}),fresh.installed.id,before.lifecycle_epoch);
    const [after]=await db.select().from(s.appInstallations).where(eq(s.appInstallations.id,fresh.installed.id));
    assert.equal(after.lifecycle_epoch,before.lifecycle_epoch+1);await assert.rejects(read());
  });
  assert.equal((await db.select().from(s.appRuns).where(eq(s.appRuns.org_id,org))).length,0,'reader resolution never creates outgoing Runs');
});
