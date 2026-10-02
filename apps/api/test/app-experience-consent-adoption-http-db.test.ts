import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';
const safe=securityTestDatabaseIsSafe();

test('durable consent requires fresh version review before explicit encrypted draft adoption', { skip: !safe, timeout: 90000 }, async t => {
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
  const open = async (token = session.accessToken) => {
    const created = await call(`/${staged.id}/main/sessions`, {}, token); assert.equal(created.status, 200);
    const path = `/sessions/${created.body.pin.session_id}`;
    const state = (body: unknown, bearer = token) => call(path + '/state/drafts', body, bearer);
    assert.ok((await state({ operation: 'list' })).status >= 400);
    const exposed = await call(path + '/access/review', {}, token); assert.equal(exposed.status, 200);
    assert.equal(exposed.body.snapshot.schema_version, 'deft.experience_resource_exposure.v3');
    assert.equal(exposed.body.snapshot.private_state[0].max_records, 2);
    const accepted = await call(path + '/access/accept', { review_token: exposed.body.review_token, review_digest: exposed.body.review_digest, accept_exposure: true }, token); assert.equal(accepted.status, 200);
    return { path, state, id: created.body.pin.session_id };
  };
  const first = await open(), id = randomUUID();
  assert.equal((await first.state({ operation: 'put', record_id: id, expected_revision: 0, value: { body: 'PRIVATE-DRAFT-DO-NOT-INDEX' } })).status, 200);
  const [before] = await db.select().from(s.appPrivateStateRecords).where(eq(s.appPrivateStateRecords.record_id,id));
  const secondId = randomUUID();
  assert.equal((await first.state({operation:'put',record_id:secondId,expected_revision:0,value:{body:'SECOND-PRIVATE-DRAFT'}})).status,200);
  const [secondBefore] = await db.select().from(s.appPrivateStateRecords).where(eq(s.appPrivateStateRecords.record_id,secondId));
  const upgrade = await import('../src/lib/app-runtime-upgrade.js');
  const { resourceSyncWebAuthority } = await import('../src/lib/app-resource-sync-web-authority.js');
  const { guard } = await resourceSyncWebAuthority(`Bearer ${session.accessToken}`);
  const nextArtifact = await kit.prepareDeftExperienceArtifact('experiences/state.json', { schema_version:'deft.experience_bundle.v3',worker_source:'self.onmessage=()=>{ };',entry_view:'main',resource_keys:[],action_keys:[],state_keys:['drafts'] });
  const nextPackage = await kit.buildDeftAppPackage({ manifest:{...manifest,version:'1.1.0',experiences:[{...manifest.experiences[0],artifact_digest:nextArtifact.digest}]},artifacts:[nextArtifact] });
  const [installation] = await db.select().from(s.appInstallations).where(eq(s.appInstallations.id,staged.id));
  const target = await upgrade.stageAttachmentAppUpgrade(actor,staged.id,{schema_version:'deft.app_attachment_upgrade_stage.v1',package_json:nextPackage.json,expected_lifecycle_epoch:installation.lifecycle_epoch},{guard});
  const nextContext = await upgrade.getAttachmentUpgradeContext(actor,staged.id,target.app_version_id,{guard});
  assert.ok(nextContext.review_request);
  const nextReview = await upgrade.prepareAttachmentUpgrade(actor,staged.id,nextContext.review_request,{guard});
  await upgrade.activateAttachmentUpgrade(actor,staged.id,{...nextContext.review_request,expected_review_digest:nextReview.review_digest,accept_host_policy:true},{guard});
  assert.ok((await first.state({operation:'read',record_id:id})).status>=400);
  const createdNext=await call(`/${staged.id}/main/sessions`,{});assert.equal(createdNext.status,200);
  assert.equal((await call(`/sessions/${createdNext.body.pin.session_id}/access/acquire`,{})).body.grant_status,'review_required');
  const next = await open();
  assert.deepEqual((await next.state({operation:'list'})).body.output.items,[]);
  assert.equal((await next.state({operation:'read',record_id:id})).status,409);
  const adoption = (operation:string,body:unknown,token=session.accessToken)=>call(next.path+'/state/drafts/adoption/'+operation,body,token);
  const available = await adoption('context',{});
  assert.equal(available.status,200,JSON.stringify(available.body));
  assert.equal(available.body.output.groups.length,1);
  assert.equal(JSON.stringify(available.body).includes('PRIVATE-DRAFT-DO-NOT-INDEX'),false);
  const preparedAdoption = await adoption('review',{source_artifact_digest:artifact.digest});
  assert.equal(preparedAdoption.status,200,JSON.stringify(preparedAdoption.body));
  const input={source_artifact_digest:artifact.digest,review_token:preparedAdoption.body.output.review_token,accept_owner_adoption:true};
  assert.ok((await adoption('activate',input,otherSession.accessToken)).status>=400);
  assert.equal((await adoption('activate',{...input,review_token:input.review_token+'x'})).status,409);
  await db.update(s.appPrivateStateRecords).set({revision:2}).where(eq(s.appPrivateStateRecords.record_id,id));
  assert.equal((await adoption('activate',input)).status,409);
  await db.update(s.appPrivateStateRecords).set({revision:1}).where(eq(s.appPrivateStateRecords.record_id,id));
  await db.update(s.appPrivateStateRecords).set({body:{...secondBefore.body as object,ciphertext:'INVALID'}}).where(eq(s.appPrivateStateRecords.record_id,secondId));
  assert.equal((await adoption('activate',input)).status,409);
  const [rolledBack]=await db.select().from(s.appPrivateStateRecords).where(eq(s.appPrivateStateRecords.record_id,id));
  assert.equal(rolledBack.artifact_digest,before.artifact_digest);
  assert.equal(rolledBack.revision,before.revision);
  await db.update(s.appPrivateStateRecords).set({body:secondBefore.body}).where(eq(s.appPrivateStateRecords.record_id,secondId));
  const accepted=await adoption('activate',input);
  assert.equal(accepted.status,200,JSON.stringify(accepted.body));
  assert.equal(accepted.body.output.adopted_count,2);
  assert.equal((await next.state({operation:'read',record_id:id})).body.output.item.value.body,'PRIVATE-DRAFT-DO-NOT-INDEX');
  const [after]=await db.select().from(s.appPrivateStateRecords).where(eq(s.appPrivateStateRecords.record_id,id));
  assert.equal(after.revision,before.revision+1);
  assert.equal(after.created_at.getTime(),before.created_at.getTime());
  assert.equal(after.expires_at.getTime(),before.expires_at.getTime());
  assert.equal(after.artifact_digest,nextArtifact.digest);
  assert.notDeepEqual(after.body,before.body);
  assert.equal((await adoption('activate',input)).status,409);
  assert.deepEqual((await adoption('context',{})).body.output.groups,[]);
});
