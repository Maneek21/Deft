import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';
const safe=securityTestDatabaseIsSafe();

test('durable Experience consent renews exact leases, survives login and revokes all tabs', { skip: !safe, timeout: 90000 }, async t => {
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true',
    DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`private-state-test:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1', run_encryption: ring('private-enc'), receipt_signing: ring('private-sign'), fingerprint: ring('private-fp') });
  const [{ db, closeDb }, s, { and, eq, sql }, kit, apps, review, modules, web, runtime, { Hono }, { serve }, routes] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('@deft/app-kit'), import('../src/lib/app-service.js'),
    import('../src/lib/app-attachment-review.js'), import('../src/lib/module-service.js'), import('../src/lib/web-sessions.js'),
    import('../src/lib/app-run-runtime.js'), import('hono'), import('@hono/node-server'), import('../src/routes/app-experiences.js') ]);
  const org = randomUUID(), owner = randomUUID(), other = randomUUID(), suffix = randomUUID();
  await db.insert(s.orgs).values({ id: org, name: 'Private state fixture', slug: `private-state-${suffix}` });
  await db.insert(s.users).values([{ id: owner, name: 'Owner', email: `owner-${suffix}@example.test` }, { id: other, name: 'Other', email: `other-${suffix}@example.test` }]);
  await db.insert(s.orgMembers).values([{ id: randomUUID(), org_id: org, user_id: owner, role: 'owner', is_active: true }, { id: randomUUID(), org_id: org, user_id: other, role: 'member', is_active: true }]);
  const actor = modules.humanModuleActor({ orgId: org, userId: owner, role: 'owner', source: 'rest' });
  const declaration = { key: 'drafts', label: 'Private drafts', schema: { type: 'object', properties: { body: { type: 'string', maxLength: 4096 } }, required: ['body'], additionalProperties: false }, max_record_bytes: 16384, max_records: 2, max_total_bytes: 20000, retention_days: 30 };
  const artifact = await kit.prepareDeftExperienceArtifact('experiences/state.json', { schema_version: 'deft.experience_bundle.v3', worker_source: 'self.onmessage=()=>{};', entry_view: 'main', resource_keys: [], action_keys: [], state_keys: ['drafts'] });
  const manifest = { schema_version: '7', id: `community.example.private-state.a${suffix.replaceAll('-', '')}`, version: '1.0.0', name: 'Private state fixture', license: 'AGPL-3.0-only', compatibility: { app_protocol: '7' }, modules: [], navigation: [],
    runtime_requirements: [{ key: 'sync', protocol_version: 'deft.app_runtime_channel.v3' }], private_capabilities: [], runtime_actions: [], native_actions: [], public_actions: [], private_state: [declaration],
    sync_descriptors: [{ schema_version: 'deft.app_sync_descriptor.v2', key: 'inbox', runtime_requirement_key: 'sync', resource_type: 'private_record', requested_visibility: 'user_private', label_field: 'body', record_schema: { type: 'object', properties: { body: { type: 'string', maxLength: 200 } }, required: ['body'], additionalProperties: false }, attachments: { allowed_media_types: ['text/csv'], max_attachment_bytes: 1024, max_attachment_bytes_per_run: 1024, max_attachments_per_record: 1, max_attachments_per_run: 1, retention_days: 1 } }],
    experiences: [{ key: 'main', label: 'Private state', artifact_path: artifact.path, artifact_digest: artifact.digest, bridge_version: 'deft.experience_bridge.v1', renderer_version: 'deft.trusted_renderer.v1' }] };
  const pkg = await kit.buildDeftAppPackage({ manifest, artifacts: [artifact] });
  const staged = await apps.stageAppPackage(actor, pkg.json, { attachmentStage: true, attachmentComposition: true });
  const context = await review.getAttachmentAppReviewContext(actor, staged.id, staged.version_id, { composition: true });
  assert.ok(context.review_request);
  const prepared = await review.prepareAttachmentAppReview(actor, staged.id, context.review_request, { composition: true });
  assert.deepEqual(prepared.authority.private_state, [declaration]);
  await review.activateAttachmentApp(actor, staged.id, { ...context.review_request, expected_review_digest: prepared.review_digest, accept_host_policy: true }, { composition: true });
  const session = await web.createWebSession({ id: owner, org_id: org, email: `owner-${suffix}@example.test` });
  const otherSession = await web.createWebSession({ id: other, org_id: org, email: `other-${suffix}@example.test` });
  const nextSession = await web.createWebSession({ id: owner, org_id: org, email: `owner-${suffix}@example.test` });
  const app = new Hono(); app.route('/api/app-experiences', routes.appExperienceRoutes);
  let server!: ReturnType<typeof serve>;
  const base = await new Promise<string>(resolve => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, address => resolve(`http://127.0.0.1:${address.port}/api/app-experiences`)); });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await runtime.shutdownAppRunRuntime(); await closeDb(); });
  const call = async (path: string, body?: unknown, token = session.accessToken, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const create = async (token = session.accessToken) => {
    const created = await call(`/${staged.id}/main/sessions`, {}, token); assert.equal(created.status, 200);
    const path = `/sessions/${created.body.pin.session_id}`;
    return { id: created.body.pin.session_id as string, path, token, created: created.body,
      state: (body: unknown) => call(path + '/state/drafts', body, token) };
  };
  const accept = async (current: Awaited<ReturnType<typeof create>>) => {
    const review = await call(current.path + '/access/review', {}, current.token); assert.equal(review.status, 200);
    assert.equal(review.body.persistent, true);
    const result = await call(current.path + '/access/accept', { review_token: review.body.review_token,
      review_digest: review.body.review_digest, accept_exposure: true }, current.token);
    assert.equal(result.status, 200); assert.equal(result.body.grant_status, 'active');
    return { review: review.body, access: result.body };
  };
  const first = await create();
  assert.equal((await call(first.path + '/access/acquire', {})).body.grant_status, 'review_required');
  const accepted = await accept(first), grantId = accepted.access.grant.id;
  const record = randomUUID();
  assert.equal((await first.state({ operation: 'put', record_id: record, expected_revision: 0, value: { body: 'DURABLE-PRIVATE-DRAFT' } })).status, 200);
  const [grant] = await db.select().from(s.appExperienceConsentGrants).where(eq(s.appExperienceConsentGrants.id, grantId));
  assert.ok(grant); for (const key of ['web_session_id','experience_session_id','prepared_at','review_expires_at','web_access_expires_at','expires_at']) assert.equal(key in grant.snapshot, false);
  assert.equal(JSON.stringify(grant.snapshot).includes(session.accessToken), false);
  const { experienceConsentScope, experienceConsentDigest } = await import('../src/lib/app-experience-consent-contract.js');
  const scope = experienceConsentScope(accepted.review.snapshot);
  const rotatedScope = experienceConsentScope({ ...accepted.review.snapshot, web_session_id: randomUUID(), experience_session_id: randomUUID(),
    prepared_at: new Date(Date.now() + 1000).toISOString(), expires_at: new Date(Date.now() + 800000).toISOString(), web_access_expires_at: new Date(Date.now() + 800000).toISOString() });
  assert.equal(experienceConsentDigest(scope), experienceConsentDigest(rotatedScope));
  assert.equal('owner_label' in scope, false);
  assert.equal(experienceConsentDigest(scope), experienceConsentDigest(experienceConsentScope({ ...accepted.review.snapshot, owner_label: 'Renamed owner' })));
  await db.update(s.users).set({ name: 'Renamed owner' }).where(eq(s.users.id, owner));
  const renamedAccess = await call(first.path + '/access/acquire', {});
  assert.equal(renamedAccess.status, 200); assert.equal(renamedAccess.body.grant.id, grantId);
  assert.notEqual(experienceConsentDigest(scope), experienceConsentDigest({ ...scope, artifact_digest: `sha256:${'f'.repeat(64)}` }));
  const second = await create(nextSession.accessToken);
  const acquired = await call(second.path + '/access/acquire', {}, second.token);
  assert.equal(acquired.status, 200); assert.equal(acquired.body.grant.id, grantId);
  assert.equal((await second.state({ operation: 'read', record_id: record })).body.output.item.value.body, 'DURABLE-PRIVATE-DRAFT');
  assert.ok((await call(first.path + '/access/acquire', {}, nextSession.accessToken)).status >= 400);
  assert.ok((await call(first.path + '/refresh', {}, otherSession.accessToken)).status >= 400);
  // Original technical lease has elapsed; current normal same-SID credentials
  // and persisted exact consent may renew it without another review.
  const oldExpiry = new Date(Date.now() - 1000);
  await db.update(s.appExperienceSessions).set({ created_at: new Date(Date.now() - 900000), expires_at: oldExpiry }).where(eq(s.appExperienceSessions.id, first.id));
  assert.ok((await first.state({ operation: 'read', record_id: record })).status >= 400);
  // Opening a second tab must not prune a grant-backed idle lease that is
  // eligible to resume under this still-current Web SID.
  await create();
  assert.equal((await db.select().from(s.appExperienceSessions).where(eq(s.appExperienceSessions.id, first.id))).length,1);
  const rotated = await web.rotateWebSession(session.refreshToken);
  const beforeAuth = await web.verifyWebAccess(session.accessToken), afterAuth = await web.verifyWebAccess(rotated.accessToken);
  assert.equal(beforeAuth.sid, afterAuth.sid);
  const refreshed = await call(first.path + '/refresh', {}, rotated.accessToken);
  assert.equal(refreshed.status, 200); assert.equal(refreshed.body.grant.id, grantId);
  assert.equal(refreshed.body.exposure.exposure_id, accepted.access.exposure.exposure_id);
  assert.equal(refreshed.body.exposure.review_digest, accepted.access.exposure.review_digest);
  assert.ok(Date.parse(refreshed.body.session_expires_at) > oldExpiry.getTime());
  assert.equal((await call(first.path + '/state/drafts', { operation: 'read', record_id: record }, rotated.accessToken)).body.output.item.value.body, 'DURABLE-PRIVATE-DRAFT');
  const cas = await Promise.all([call(first.path + '/state/drafts', { operation: 'put', record_id: record, expected_revision: 1, value: { body: 'FIRST' } }, rotated.accessToken),
    second.state({ operation: 'put', record_id: record, expected_revision: 1, value: { body: 'SECOND' } })]);
  assert.deepEqual(cas.map(item => item.status).sort(), [200,409]);
  // Old legacy exposure remains short lived and is never implicitly promoted.
  const legacy = await create();
  const legacyReview = await call(legacy.path + '/exposure/review', {}); assert.equal(legacyReview.status, 200);
  assert.equal((await call(legacy.path + '/exposure/accept', { review_token: legacyReview.body.review_token,
    review_digest: legacyReview.body.review_digest, accept_exposure: true })).status, 200);
  await db.update(s.appExperienceSessions).set({ created_at: new Date(Date.now() - 900000), expires_at: oldExpiry }).where(eq(s.appExperienceSessions.id, legacy.id));
  assert.ok((await call(legacy.path + '/refresh', {})).status >= 400);
  const oldTokenSession = await create();
  const oldToken = await call(oldTokenSession.path + '/access/review', {}); assert.equal(oldToken.status,200);
  const revoked = await call(first.path + '/access', undefined, rotated.accessToken, 'DELETE'); assert.equal(revoked.status, 200);
  assert.ok((await second.state({ operation: 'read', record_id: record })).status >= 400);
  assert.ok((await call(second.path + '/refresh', {}, second.token)).status >= 400);
  const afterRevocation = await create();
  assert.equal((await call(afterRevocation.path + '/access/acquire', {})).body.grant_status, 'review_required');
  assert.ok((await call(oldTokenSession.path + '/access/accept', { review_token: oldToken.body.review_token,
    review_digest: oldToken.body.review_digest, accept_exposure: true })).status >= 400);
  const newAccepted = await accept(afterRevocation); assert.notEqual(newAccepted.access.grant.id, grantId);
  assert.equal((await afterRevocation.state({ operation: 'read', record_id: record })).status,200);
  // Legacy withdrawal endpoint also withdraws explicitly persistent permission.
  assert.equal((await call(afterRevocation.path + '/exposure', undefined, session.accessToken, 'DELETE')).status,200);
  const [newGrant] = await db.select().from(s.appExperienceConsentGrants).where(eq(s.appExperienceConsentGrants.id,newAccepted.access.grant.id));
  assert.ok(newGrant.revoked_at); assert.equal(newGrant.epoch,1);
  await assert.rejects(db.update(s.appExperienceConsentGrants).set({ revoked_at:null }).where(eq(s.appExperienceConsentGrants.id,newGrant.id)));
  await assert.rejects(db.update(s.appExperienceConsentGrants).set({ scope_digest:`sha256:${'a'.repeat(64)}` }).where(eq(s.appExperienceConsentGrants.id,newGrant.id)));
  await assert.rejects(db.update(s.appExperienceSessions).set({ expires_at:new Date(Date.now()+1000000) }).where(eq(s.appExperienceSessions.id,afterRevocation.id)));
  assert.equal((await db.select().from(s.appRuntimeAgentPolicies).where(eq(s.appRuntimeAgentPolicies.org_id,org))).length,0);
  // Real encrypted sync records exercise both cursor purposes. Renewing the
  // same durable permission may continue a still-valid cursor, never its TTL.
  const runRuntime = await runtime.getAppRunRuntime();
  const { createReviewedResourceSyncFixture } = await import('./fixtures/resource-sync-v5.js');
  const resourceArtifact = await kit.prepareDeftExperienceArtifact('experiences/main.json', {
    schema_version:'deft.experience_bundle.v2', search_resource_keys:['inbox'], worker_source:'self.onmessage=()=>{};',
    entry_view:'main',resource_keys:['inbox'],action_keys:[] });
  const owned = await createReviewedResourceSyncFixture({keys:runRuntime.keys,clock:()=>new Date(),experience_artifact:resourceArtifact});
  const [resourceOwner] = await db.select().from(s.users).where(eq(s.users.id,owned.owner_user_id));
  const credentials = await web.createWebSession({id:owned.owner_user_id,email:resourceOwner.email,org_id:owned.org_id});
  const admitted = await runRuntime.resourceSyncAdmission.admitDue({org_id:owned.org_id,resource_binding_id:owned.binding_id});
  assert.equal(admitted.state,'created');
  const operator = await owned.management.issueOperatorSession(owned.operator_actor,owned.binding_id);
  const identity = {schema_version:'deft.app_runtime_channel.v2' as const,audience:'app_resource_sync' as const,
    session_id:operator.session_id,session_token:operator.session_token};
  const claim = await runRuntime.resourceSyncChannel.claim({...identity,max_claims:1});assert.ok(claim);
  const attempt = {...identity,run_id:claim.run_id,attempt_id:claim.attempt_id,claim_token:claim.claim_token,sequence:claim.sequence};
  assert.ok(await runRuntime.resourceSyncChannel.start(attempt));
  assert.ok(await runRuntime.resourceSyncChannel.complete({...attempt,status:'returned',provider_succeeded:true,page:{
    schema_version:'deft.app_sync_page.v1',upserts:Array.from({length:31},(_,i)=>({id:`cursor-${i}`,revision:'1',data:{subject:`Saved ${i}`}})),
    tombstones:[],next_cursor:null,has_more:false }}));
  const opened=await call(`/${owned.installation_id}/main/sessions`,{},credentials.accessToken);assert.equal(opened.status,200);
  const resourceSessionId=opened.body.pin.session_id,resourcePath=`/sessions/${resourceSessionId}`;
  const resourceReview=await call(resourcePath+'/access/review',{},credentials.accessToken);assert.equal(resourceReview.status,200);
  assert.equal((await call(resourcePath+'/access/accept',{review_token:resourceReview.body.review_token,
    review_digest:resourceReview.body.review_digest,accept_exposure:true},credentials.accessToken)).status,200);
  const shortDeadline=new Date(Date.now()+60000);
  await db.update(s.appExperienceSessions).set({expires_at:shortDeadline}).where(eq(s.appExperienceSessions.id,resourceSessionId));
  const listRequest={schema_version:'deft.experience_resource_request.v1',operation:'list_summary',limit:1};
  const searchRequest={schema_version:'deft.experience_resource_request.v2',operation:'search',query:'Saved',field_keys:['subject']};
  const resourceCall=(body:unknown)=>call(resourcePath+'/resources/inbox',body,credentials.accessToken);
  const listFirst=await resourceCall(listRequest),searchFirst=await resourceCall(searchRequest);
  assert.equal(listFirst.status,200);assert.equal(searchFirst.status,200);
  const listCursor=listFirst.body.output.next_cursor,searchCursor=searchFirst.body.output.next_cursor;assert.ok(listCursor);assert.ok(searchCursor);
  const renewed=await call(resourcePath+'/refresh',{},credentials.accessToken);assert.equal(renewed.status,200);
  assert.ok(Date.parse(renewed.body.session_expires_at)>shortDeadline.getTime());
  const listNext=await resourceCall({...listRequest,cursor:listCursor}),searchNext=await resourceCall({...searchRequest,cursor:searchCursor});
  assert.equal(listNext.status,200);assert.equal(searchNext.status,200);
  assert.notEqual(listNext.body.output.items[0].record_id,listFirst.body.output.items[0].record_id);
  const {openExposureToken}=await import('../src/lib/app-experience-exposure-contract.js');
  assert.equal((openExposureToken(runRuntime.keys,'cursor',listNext.body.output.next_cursor) as {expires_at:string}).expires_at,shortDeadline.toISOString());
  assert.equal((openExposureToken(runRuntime.keys,'search_cursor',searchNext.body.output.next_cursor) as {expires_at:string}).expires_at,shortDeadline.toISOString());
  const {AppExperienceExposureService}=await import('../src/lib/app-experience-exposure.js');
  const expiredCursorService=new AppExperienceExposureService(runRuntime.keys,undefined,()=>new Date(shortDeadline.getTime()+1));
  const resourceAuth=await web.verifyWebAccess(credentials.accessToken);
  const resourceCaller={org_id:resourceAuth.org_id,user_id:resourceAuth.id,sid:resourceAuth.sid,access_expires_at:resourceAuth.exp*1000};
  await assert.rejects(expiredCursorService.read(resourceCaller,resourceSessionId,'inbox',{...listRequest,cursor:listCursor}),/unavailable/);
  await assert.rejects(expiredCursorService.read(resourceCaller,resourceSessionId,'inbox',{...searchRequest,cursor:searchCursor}),/unavailable/);
  // The real final SID/human queries may consume the remaining cursor TTL.
  // Advance only the injected clock after those awaited authority reads.
  for (const request of [{...listRequest,cursor:listCursor},{...searchRequest,cursor:searchCursor}]) {
    let boundaryNow = new Date();
    const boundaryService = new AppExperienceExposureService(runRuntime.keys,undefined,()=>boundaryNow);
    const seam = boundaryService as unknown as { final: (...args: unknown[]) => Promise<void> };
    const originalFinal = seam.final.bind(boundaryService);
    let finalCalls = 0;
    seam.final = async (...args) => { await originalFinal(...args); if (++finalCalls === 2) boundaryNow = new Date(shortDeadline.getTime()+1); };
    await assert.rejects(boundaryService.read(resourceCaller,resourceSessionId,'inbox',request),/unavailable/);
  }
});
