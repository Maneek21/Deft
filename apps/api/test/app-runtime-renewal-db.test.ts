import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const safeDatabase = databaseUrl && databaseUrl === process.env.DATABASE_URL
  && databaseUrl === 'postgresql://gate_g_test@127.0.0.1:55439/deft_runtime_renewal_test';

test('opt-in renewal preserves active attempts and enforces current authority and immutable PostgreSQL bounds', {
  skip: !safeDatabase,
}, async () => {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
  process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
  const key = (purpose: string) => createHash('sha256')
    .update(`runtime-channel-v3:${purpose}`).digest('base64');
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({
    schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: 'runtime-channel-enc-v1',
      keys: { 'runtime-channel-enc-v1': key('encryption') } },
    receipt_signing: { current: 'runtime-channel-sig-v1',
      keys: { 'runtime-channel-sig-v1': key('signing') } },
    fingerprint: { current: 'runtime-channel-fp-v1',
      keys: { 'runtime-channel-fp-v1': key('fingerprint') } },
  });
  const [{ db, closeDb }, schema, kit, appService, appReview, management,
    moduleService, actionsModule, runtimeModule, keyFixture, secretModule,
    keyringModule, runnerModule, providerModule, receiptModule] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('@deft/app-kit'),
    import('../src/lib/app-service.js'), import('../src/lib/app-runtime-review.js'),
    import('../src/lib/app-runtime-management.js'), import('../src/lib/module-service.js'),
    import('../src/lib/app-runtime-action-service.js'), import('../src/lib/app-run-runtime.js'),
    import('./fixtures/app-run-test-keyrings.js'), import('../src/lib/app-run-secrets.js'),
    import('../src/lib/app-run-keyrings.js'), import('../src/lib/app-run-attempt-runner.js'),
    import('../src/lib/app-run-provider-executor.js'), import('../src/lib/app-run-receipts.js'),
  ]);
  const { and, eq, sql } = await import('drizzle-orm');
  const ring = await keyFixture.databaseCompleteAppRunTestKeyringFixture('runtime-channel-v3');
  const combined = JSON.parse(ring.environment);
  const own = JSON.parse(process.env.DEFT_APP_RUN_KEYRINGS!);
  for (const purpose of ['run_encryption', 'receipt_signing', 'fingerprint']) {
    combined[purpose].current = own[purpose].current;
    Object.assign(combined[purpose].keys, own[purpose].keys);
  }
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify(combined);
  ring.keys.destroy();
  let runtime: Awaited<ReturnType<typeof runtimeModule.getAppRunRuntime>> | undefined;
  try {
    const suffix = randomUUID();
    const orgId = randomUUID();
    const userId = randomUUID();
    await db.insert(schema.orgs).values({ id: orgId, name: 'Runtime channel v3',
      slug: `runtime-channel-${suffix}` });
    await db.insert(schema.users).values({ id: userId,
      email: `runtime-channel-${suffix}@example.test`, name: 'Runtime owner' });
    const [member] = await db.insert(schema.orgMembers).values({ id: randomUUID(),
      org_id: orgId, user_id: userId, role: 'owner', is_active: true }).returning();
    assert.ok(member);
    const owner = moduleService.humanModuleActor({ orgId, userId, role: 'owner', source: 'ui' });
    const packageJson = (await kit.buildDeftAppPackage({ manifest: {
      schema_version: '3', id: `community.example.runtime.app${suffix.replace(/-/g, '')}`,
      version: '1.0.0', name: 'Runtime channel', license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '3' }, modules: [], navigation: [],
      runtime_requirements: [{ key: 'provider', protocol_version: 'deft.app_runtime_channel.v1' }],
      private_capabilities: [{ key: 'deliver', version: '1',
        input_schema: { type: 'object', properties: { item_id: { type: 'string', maxLength: 120 } },
          required: ['item_id'], additionalProperties: false },
        output_schema: { type: 'object', properties: { receipt_id: { type: 'string', maxLength: 120 } },
          required: ['receipt_id'], additionalProperties: false } }],
      runtime_actions: [{ key: 'deliver', label: 'Deliver', capability_key: 'deliver',
        runtime_requirement_key: 'provider' }],
    }, artifacts: [] })).json;
    const staged = await appService.stageAppPackage(owner, packageJson);
    const [version] = await db.select().from(schema.appVersions).where(and(
      eq(schema.appVersions.org_id, orgId), eq(schema.appVersions.id, staged.version_id)));
    assert.ok(version?.requested_grant_snapshot_id);
    const [requested] = await db.select().from(schema.appGrantSnapshots).where(and(
      eq(schema.appGrantSnapshots.org_id, orgId),
      eq(schema.appGrantSnapshots.id, version.requested_grant_snapshot_id)));
    assert.ok(requested);
    const appReviewInput = { app_version_id: version.id,
      expected_package_digest: version.package_digest,
      expected_requested_snapshot_digest: requested.snapshot_digest,
      expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch };
    const appReviewValue = await appReview.prepareRuntimeAppReview(owner, staged.id, appReviewInput);
    const active = await appReview.activateRuntimeApp(owner, staged.id, { ...appReviewInput,
      expected_review_digest: appReviewValue.review_digest, accept_host_policy: true });
    const [grant] = await db.select().from(schema.appGrantSnapshots).where(and(
      eq(schema.appGrantSnapshots.org_id, orgId), eq(schema.appGrantSnapshots.id, active.grant_snapshot_id)));
    assert.ok(grant);
    const bindInput = { installation_id: staged.id, action_key: 'deliver',
      operator_user_id: userId, expected_app_version_id: version.id,
      expected_package_digest: version.package_digest,
      expected_grant_snapshot_digest: grant.snapshot_digest,
      expected_lifecycle_epoch: active.installation.lifecycle_epoch,
      expected_grant_epoch: active.installation.grant_epoch };
    const bindingReview = await management.prepareRuntimeBindingReview(owner, bindInput);
    const binding = await management.activateRuntimeBinding(owner, { ...bindInput,
      expected_review_digest: bindingReview.review_digest, accept_host_policy: true });

    const authority=await import('../src/lib/app-runtime-authority.js');
    const web=await import('../src/lib/web-sessions.js');
    const browser=await web.createWebSession({id:userId,org_id:orgId,email:`runtime-channel-${suffix}@example.test`});
    const {guard,web_session}=await (await import('../src/lib/app-resource-sync-web-authority.js')).resourceSyncWebAuthority(`Bearer ${browser.accessToken}`);
    const requestedUntil=new Date(Date.now()+3_600_000);
    const session=await authority.issueAppRuntimeSession({org_id:orgId,runtime_binding_id:binding.binding_id,operator_user_id:userId,
      now:new Date(Date.now()-600_000),guard,technical_renewal:{requested_until:requestedUntil,sid:web_session.sid,role:'owner'}});
    assert.ok(session?.renewable_until);assert.equal(session.renewable_until.toISOString(),requestedUntil.toISOString());
    const legacy=await management.issueRuntimeOperatorSession(owner,binding.binding_id);
    assert.equal(legacy.renewable_until,undefined);
    const query=()=>db.select().from(schema.appRuntimeSessions).where(eq(schema.appRuntimeSessions.id,session.session_id));
    const [before]=await query();assert.ok(before);assert.equal(before.renewal_web_session_id,web_session.sid);
    runtime=await runtimeModule.getAppRunRuntime();
    const actions=new actionsModule.AppRuntimeActionService(runtime.service);
    const run=await actions.invoke({org_id:orgId,user_id:userId},{runtime_binding_id:binding.binding_id,idempotency_key:`renew:${suffix}`,input:{item_id:'one'}});
    const [approval]=await db.select().from(schema.agentActions).where(eq(schema.agentActions.app_run_id,run.id));assert.ok(approval);
    assert.equal((await runtime.approvalResolver.approve(approval.id,userId)).status,'approved');
    const channel=runtime.runtimeChannel;
    const claim=await channel.claim({schema_version:'deft.app_runtime_channel.v1',session_id:session.session_id,session_token:session.session_token,max_claims:1});assert.ok(claim);
    const request={schema_version:'deft.app_runtime_channel.v1',session_id:session.session_id,session_token:session.session_token,run_id:claim.run_id,attempt_id:claim.attempt_id,claim_token:claim.claim_token,sequence:claim.sequence};
    assert.ok(await channel.start(request));
    const [attemptBefore]=await db.select().from(schema.appRunAttempts).where(eq(schema.appRunAttempts.id,claim.attempt_id));
    const {Hono}=await import('hono');const {appRuntimeChannelRoutes}=await import('../src/routes/app-runtime-channel.js');
    const app=new Hono().route('/channel',appRuntimeChannelRoutes);
    async function renewHttp(credential=session,extra:Record<string,unknown>={},headers:Record<string,string>={}){
      const r=await app.request('/channel/renew',{method:'POST',headers:{authorization:`AppRuntime ${credential.session_token}`,'content-type':'application/json',...headers},body:JSON.stringify({schema_version:'deft.app_runtime_channel.v1',session_id:credential.session_id,expected_expires_at:session.expires_at.toISOString(),...extra})});
      return {status:r.status,body:await r.json() as any};
    }
    const clockSkew=await authority.renewAppRuntimeSession({session_id:session.session_id,session_token:session.session_token,expected_expires_at:session.expires_at.toISOString()},()=>new Date(Date.now()+60_000));
    assert.ok(clockSkew,'API clock ahead by one minute must not increase the database fifteen-minute cap or cause a renewal failure');
    const renewed=await renewHttp();assert.equal(renewed.status,200);assert.equal(renewed.body.renewed.session_id,session.session_id);assert.ok(new Date(renewed.body.renewed.expires_at)>session.expires_at);
    assert.equal(renewed.body.renewed.renewable_until,requestedUntil.toISOString());
    const [after]=await query();assert.ok(after);
    for(const key of ['id','token_hash','session_epoch','runtime_epoch','lifecycle_epoch','grant_epoch','runtime_binding_id','renewable_until','renewal_web_session_id','renewal_operator_role'] as const)assert.deepEqual(after[key],before[key],key);
    const [attemptAfter]=await db.select().from(schema.appRunAttempts).where(eq(schema.appRunAttempts.id,claim.attempt_id));assert.deepEqual(attemptAfter,attemptBefore);
    assert.deepEqual((await renewHttp()).body,renewed.body,'lost ACK/startup stale expectation returns current expiry without extending again');
    assert.equal(await channel.heartbeat(request),true,'same active attempt remains usable after technical renewal');
    assert.equal((await renewHttp(legacy)).status,403);assert.equal((await renewHttp({...session,session_token:'x'.repeat(43)})).status,403);
    assert.equal((await renewHttp(session,{unknown:true})).status,400);assert.equal((await renewHttp(session,{}, {cookie:'session=forbidden'})).status,403);
    assert.equal((await renewHttp(session,{session_token:'x'.repeat(43)})).status,400);
    assert.equal((await renewHttp(session,{expected_expires_at:new Date(Date.now()+3_600_000).toISOString()})).status,403,'future expectation cannot nominate an extension');
    const forbidden=[sql`UPDATE app_runtime_sessions SET renewable_until=renewable_until+interval '1 minute' WHERE id=${session.session_id}`,
      sql`UPDATE app_runtime_sessions SET renewal_web_session_id='foreign' WHERE id=${session.session_id}`,
      sql`UPDATE app_runtime_sessions SET expires_at=expires_at-interval '1 second' WHERE id=${session.session_id}`,
      sql`UPDATE app_runtime_sessions SET expires_at=now()+interval '16 minutes' WHERE id=${session.session_id}`,
      sql`UPDATE app_runtime_sessions SET expires_at=expires_at+interval '1 second' WHERE id=${legacy.session_id}`,
      sql`UPDATE app_runtime_sessions SET renewable_until=now()+interval '1 hour',renewal_web_session_id=${web_session.sid},renewal_operator_role='owner' WHERE id=${legacy.session_id}`];
    for(const statement of forbidden)await assert.rejects(db.execute(statement));
    await db.update(schema.orgMembers).set({role:'admin'}).where(eq(schema.orgMembers.id,member.id));
    assert.equal((await renewHttp()).status,403);assert.equal(await channel.heartbeat(request),false,'dispatch checks original role too');
    await db.update(schema.orgMembers).set({role:'owner'}).where(eq(schema.orgMembers.id,member.id));
    assert.equal((await renewHttp()).status,200);
    assert.equal(await authority.renewAppRuntimeSession({session_id:session.session_id,session_token:session.session_token,expected_expires_at:after.expires_at.toISOString()},()=>new Date(after.expires_at.getTime()+1)),null,'expired session never resurrects');
    await db.update(schema.webSessions).set({revoked_at:new Date()}).where(eq(schema.webSessions.id,web_session.sid));
    assert.equal((await renewHttp()).status,403);assert.equal(await channel.heartbeat(request),false,'SID revocation denies active dispatch');
    const [final]=await query();assert.equal(final.expires_at.toISOString(),after.expires_at.toISOString());
  } finally {await runtimeModule.shutdownAppRunRuntime();await closeDb();}
});
