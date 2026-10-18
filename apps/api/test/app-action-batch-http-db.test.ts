import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';
const safe=securityTestDatabaseIsSafe();

test('bounded Runtime batches atomically freeze and approve exact inputs under current owner consent', { skip: !safe, timeout: 90000 }, async t => {
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
    DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`private-state-test:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1', run_encryption: ring('private-enc'), receipt_signing: ring('private-sign'), fingerprint: ring('private-fp') });
  const [{ app }, { db, closeDb }, s, orm, web, runtime] = await Promise.all([import('../src/index.js'), import('../src/lib/db.js'),
    import('@deft/db/schema'), import('drizzle-orm'), import('../src/lib/web-sessions.js'), import('../src/lib/app-run-runtime.js')]);
  t.after(async () => { await runtime.shutdownAppRunRuntime(); await closeDb(); });
  const org = randomUUID(), owner = randomUUID(), member = randomUUID(), suffix = randomUUID();
  await db.insert(s.orgs).values({ id: org, name: 'Restored Run fixture', slug: `restored-run-${suffix}` });
  await db.insert(s.users).values([{ id: owner, name: 'Owner', email: `run-owner-${suffix}@example.test` }, { id: member, name: 'Member', email: `run-member-${suffix}@example.test` }]);
  await db.insert(s.orgMembers).values([{ id: randomUUID(), org_id: org, user_id: owner, role: 'owner', is_active: true }, { id: randomUUID(), org_id: org, user_id: member, role: 'member', is_active: true }]);
  const first = await web.createWebSession({ id: owner, org_id: org, email: `run-owner-${suffix}@example.test` });
  const second = await web.createWebSession({ id: owner, org_id: org, email: `run-owner-${suffix}@example.test` });
  const outsider = await web.createWebSession({ id: member, org_id: org, email: `run-member-${suffix}@example.test` });
  const request = (path: string, method = 'GET', body?: unknown, token = first.accessToken) => app.request('http://localhost' + path, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const call = async (path: string, method = 'GET', body?: unknown, token = first.accessToken) => {
    const response = await request(path, method, body, token); const result = await response.json() as any;
    assert.ok(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(result)}`); return result;
  };
  const packed = (await runtimeSecurityPackage()).json;
  const parsed = JSON.parse(packed);
  const { app: installed } = await call('/api/apps/blob/composition/stage', 'POST', packed);
  const context = await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);
  const { review } = await call(`/api/apps/blob/composition/${installed.id}/review`, 'POST', context.review_request);
  await call(`/api/apps/blob/composition/${installed.id}/activate`, 'POST', { ...context.review_request, expected_review_digest: review.review_digest, accept_host_policy: true });
  const setup = await call(`/api/apps/blob/composition/${installed.id}/runtime/context?app_version_id=${installed.version_id}`);
  const bindingRequest = setup.actions.find((action: any) => action.key === 'send_message').review_request;
  const { review: bindingReview } = await call('/api/apps/blob/composition/runtime/reviews/prepare', 'POST', bindingRequest);
  const { binding } = await call('/api/apps/blob/composition/runtime/bindings/activate', 'POST', { ...bindingRequest, expected_review_digest: bindingReview.review_digest, accept_host_policy: true });
  const experienceKey = parsed.manifest.experiences[0].key;
  const create = (token = first.accessToken) => call(`/api/app-experiences/${installed.id}/${experienceKey}/sessions`, 'POST', {}, token);
  const { setup: syncSetup } = await call('/api/apps/blob/sync/setup?installation_id='+installed.id+'&operator_user_id='+owner);
  const syncBindings: string[] = [];
  for (const descriptor of syncSetup.descriptors) {
    const consent=descriptor.consent_request;
    const {review:r}=await call('/api/apps/blob/sync/reviews/prepare','POST',consent);
    const activated = await call('/api/apps/blob/sync/bindings/activate','POST',{...consent,expected_review_digest:r.review_digest,accept_host_policy:true}); syncBindings.push(activated.binding.binding_id);
  }
  const rt=await runtime.getAppRunRuntime();
  const syncPath='/api/apps/blob/sync/bindings/'+syncBindings[0];
  const initialSync=await call(syncPath+'/sync','POST',{});
  const [checkpointBefore]=await db.select().from(s.appSyncCheckpoints).where(orm.eq(s.appSyncCheckpoints.resource_binding_id,syncBindings[0]!));
  const syncRuntime=await (await import('../src/lib/app-attachment-runtime.js')).getAppAttachmentRuntime();
  await rt.repository.transaction(async tx=>{
    const run=await rt.repository.lockRun(tx,org,initialSync.run_id);assert.ok(run);
    await tx.update(s.appRunAttempts).set({state:'cancelled',updated_at:new Date()}).where(orm.eq(s.appRunAttempts.id,initialSync.attempt_id));
    await rt.repository.transition(tx,{run,state:'cancelled',now:new Date()});
  });
  assert.deepEqual(await call(syncPath+'/sync','POST',{}),{state:'blocked',reason:'cursor_requires_recovery'});
  const recoveryBody={previous_run_id:initialSync.run_id};
  const foreignSession=await web.createWebSession({id:member,org_id:org,email:`member-${suffix}@example.test`});
  assert.ok((await request(syncPath+'/resume-observation','POST',recoveryBody,foreignSession.accessToken)).status>=400);
  // Cadence is host-owned; advance fixture time through a narrow test clock.
  const admission=syncRuntime.admission as any;const originalClock=admission.clock;
  admission.clock=()=>new Date(Date.now()+301_000);
  try {
    const recovered=await call(syncPath+'/resume-observation','POST',recoveryBody);assert.equal(recovered.state,'created');assert.notEqual(recovered.run_id,initialSync.run_id);
    const concurrent=await Promise.all([call(syncPath+'/resume-observation','POST',recoveryBody),call(syncPath+'/resume-observation','POST',recoveryBody)]);assert.ok(concurrent.every(r=>r.run_id===recovered.run_id));
    const replay=await call(syncPath+'/resume-observation','POST',recoveryBody);assert.equal(replay.run_id,recovered.run_id);
    assert.equal((await call(syncPath+'/sync','POST',{})).run_id,recovered.run_id);
    const [checkpointAfter]=await db.select().from(s.appSyncCheckpoints).where(orm.eq(s.appSyncCheckpoints.id,checkpointBefore.id));assert.deepEqual(checkpointAfter,checkpointBefore);
    await rt.repository.transaction(async tx=>{const run=await rt.repository.lockRun(tx,org,recovered.run_id);assert.ok(run);await tx.update(s.appRunAttempts).set({state:'cancelled',updated_at:new Date()}).where(orm.eq(s.appRunAttempts.id,recovered.attempt_id));await rt.repository.transition(tx,{run,state:'cancelled',now:new Date()});});
    assert.equal((await call(syncPath+'/resume-observation','POST',recoveryBody)).run_id,recovered.run_id,'terminal replacement replay cannot chain another Run');
    const {parseEnvironmentAppRunKeyrings}=await import('../src/lib/app-run-keyrings.js');
    const {AppRunSecretService}=await import('../src/lib/app-run-secrets.js');
    const rotatedEnvironment=JSON.parse(process.env.DEFT_APP_RUN_KEYRINGS!);
    rotatedEnvironment.fingerprint.current='private-fp-rotated';rotatedEnvironment.fingerprint.keys['private-fp-rotated']=createHash('sha256').update('rotation-recovery').digest('base64');
    const rotatedKeys=parseEnvironmentAppRunKeyrings(JSON.stringify(rotatedEnvironment));const originalSecrets=admission.runSecrets;
    admission.runSecrets=new AppRunSecretService(rotatedKeys);
    try{assert.equal((await call(syncPath+'/resume-observation','POST',recoveryBody)).run_id,recovered.run_id,'retained old fingerprint key finds replacement after rotation');}
    finally{admission.runSecrets=originalSecrets;rotatedKeys.destroy();}

  } finally {admission.clock=originalClock;}
  const current=await create(), sid=current.pin.session_id, base='/api/app-experiences/sessions/'+sid;
  const {review_token,review_digest}=await call(base+'/access/review','POST',{});
  await call(base+'/access/accept','POST',{review_token,review_digest,accept_exposure:true});
  const action=base+'/human-actions/send_message';
  const policyPath=base+'/agent-policies/send_message';
  assert.deepEqual(await call(policyPath),{mode:'deny',revision:0});
  assert.deepEqual(await call(policyPath,'PUT',{mode:'require_approval',expected_revision:0}),{mode:'require_approval',revision:1});
  assert.equal((await request(policyPath,'PUT',{mode:'deny',expected_revision:0})).status,409);
  assert.ok((await request(policyPath,'PUT',{mode:'autonomous',expected_revision:1})).status>=400);
  assert.ok((await request(policyPath,'PUT',{mode:'deny',expected_revision:1},outsider.accessToken)).status>=400);
  const {getAppActionBatchService}=await import('../src/lib/app-action-batch-service.js');
  const {listRuntimeActions,getRuntimeAction}=await import('../src/lib/app-runtime-action-discovery.js');
  const service=await getAppActionBatchService(),caller={org_id:org,user_id:owner,source:'defty' as const};
  const actor={kind:'human' as const,org_id:org,actor_id:owner,role:'owner' as const,source:'ui' as const,scopes:[]};
  const discovered=await getRuntimeAction(actor,{runtime_binding_id:binding.binding_id});assert.equal(discovered.agent_policy,'require_approval');assert.equal(discovered.action_key,'send_message');assert.ok(discovered.input_schema);
  await assert.rejects(getRuntimeAction({...actor,actor_id:member},{runtime_binding_id:binding.binding_id}));
  await assert.rejects(getRuntimeAction({...actor,org_id:randomUUID()},{runtime_binding_id:binding.binding_id}));
  await assert.rejects(listRuntimeActions({...actor,source:'mcp',scopes:[]}));
  const page=await listRuntimeActions(actor,{limit:1});assert.ok(page.actions.length<=1);
  const input={to:'recipient@example.test',subject:'Batch exact input',body:'PRIVATE-BATCH-ACTION',message_id:'<batch-probe@example.test>'};
  const proposal={runtime_binding_id:binding.binding_id,idempotency_key:randomUUID(),title:'Two reviewed emails',items:[{key:'first',label:'First recipient',input},{key:'second',label:'Second recipient',input:{...input,to:'second@example.test',message_id:'<batch-second@example.test>'}}]};
  const proposed=await service.propose(caller,proposal);assert.equal(proposed.batch.item_count,2);assert.equal(proposed.batch.state,'pending_approval');assert.equal(JSON.stringify(proposed).includes(input.body),false);
  assert.deepEqual(await service.propose(caller,proposal),proposed);
  await assert.rejects(service.propose(caller,{...proposal,items:[{...proposal.items[0],input:{...input,body:'changed'}}]}),/idempotency/i);
  await assert.rejects(service.get({...caller,user_id:member},proposed.batch.id));
  await assert.rejects(service.get({...caller,org_id:randomUUID()},proposed.batch.id));
  const reviewPath='/api/app-action-batches/'+proposed.batch.id;
  const reviewed=await call(reviewPath+'/review','POST',{});assert.equal(reviewed.items[0].input.body,input.body);
  assert.equal((await request(reviewPath+'/approve','POST','{broken')).status,400);
  assert.equal((await request(reviewPath+'/approve','POST','x'.repeat(131_073))).status,413);
  assert.ok((await request(reviewPath+'/approve','POST',{ticket:reviewed.ticket,expected_digest:reviewed.digest},second.accessToken)).status>=400);
  assert.ok((await request(reviewPath+'/approve','POST',{ticket:reviewed.ticket,expected_digest:'sha256:'+'0'.repeat(64)})).status>=400);
  const cancelled=await service.propose(caller,{...proposal,idempotency_key:randomUUID()});await service.cancel(caller,cancelled.batch.id);
  assert.ok((await request('/api/app-action-batches/'+cancelled.batch.id+'/review','POST',{})).status>=400);
  // A failed second item rolls back the first release and batch state.
  await db.update(s.agentActions).set({approval_status:'rejected'}).where(orm.and(orm.eq(s.agentActions.org_id,org),orm.eq(s.agentActions.app_run_id,proposed.items[1]!.run_id)));
  assert.ok((await request(reviewPath+'/approve','POST',{ticket:reviewed.ticket,expected_digest:reviewed.digest})).status>=400);
  const rolled=await service.get(caller,proposed.batch.id);assert.equal(rolled.batch.state,'pending_approval');assert.equal(rolled.items[0]!.state,'pending_approval');
  const good=await service.propose(caller,{...proposal,idempotency_key:randomUUID()});const goodPath='/api/app-action-batches/'+good.batch.id;
  const ticket=await call(goodPath+'/review','POST',{});
  const {openHumanActionTicket,sealHumanActionTicket}=await import('../src/lib/app-experience-human-action-contract.js'),keys=(await runtime.getAppRunRuntime()).keys;
  const expired=sealHumanActionTicket(keys,{...openHumanActionTicket(keys,ticket.ticket),expires_at:new Date(Date.now()-1000).toISOString()});
  assert.ok((await request(goodPath+'/approve','POST',{ticket:expired,expected_digest:ticket.digest})).status>=400);
  const approved=await call(goodPath+'/approve','POST',{ticket:ticket.ticket,expected_digest:ticket.digest});assert.equal(approved.batch.state,'approved');
  for(const item of approved.items) {const receipts=await db.select().from(s.appRunReceipts).where(orm.and(orm.eq(s.appRunReceipts.org_id,org),orm.eq(s.appRunReceipts.run_id,item.run_id)));assert.equal(receipts.filter(r=>r.receipt_kind==='approval').length,1);}
  const repeat=await call(goodPath+'/approve','POST',{ticket:ticket.ticket,expected_digest:ticket.digest});assert.deepEqual(repeat,approved);
  const {actionBatchReleaseIsCurrent}=await import('../src/lib/app-action-batch-live.js');
  assert.equal(await rt.repository.transaction(async tx=>actionBatchReleaseIsCurrent(tx,(await rt.repository.lockRun(tx,org,good.items[0]!.run_id))!)),true);
  await service.cancel(caller,good.batch.id);
  assert.equal(await rt.repository.transaction(async tx=>actionBatchReleaseIsCurrent(tx,(await rt.repository.lockRun(tx,org,good.items[0]!.run_id))!)),false);
  const tokenId=randomUUID();await db.insert(s.mcpTokens).values({id:tokenId,org_id:org,user_id:owner,principal_kind:'human',name:'Batch fixture',token_hash:randomUUID(),token_prefix:'test',scopes:['read:apps','invoke:apps','read:app-runs'],created_by:owner});
  const mcpCaller={...caller,source:'personal_mcp' as const,token_id:tokenId,token_kind:'mcp' as const};
  const mcpBatch=await service.propose(mcpCaller,{...proposal,idempotency_key:randomUUID()}),mcpPath='/api/app-action-batches/'+mcpBatch.batch.id;
  const mcpReview=await call(mcpPath+'/review','POST',{});
  await db.update(s.mcpTokens).set({revoked_at:new Date()}).where(orm.eq(s.mcpTokens.id,tokenId));
  assert.ok((await request(mcpPath+'/approve','POST',{ticket:mcpReview.ticket,expected_digest:mcpReview.digest})).status>=400);
  const deniedToken=randomUUID();await db.insert(s.mcpTokens).values({id:deniedToken,org_id:org,user_id:owner,principal_kind:'human',name:'No invoke scope',token_hash:randomUUID(),token_prefix:'test',scopes:['read:apps'],created_by:owner});
  await assert.rejects(service.propose({...mcpCaller,token_id:deniedToken,scopes:['read:apps','invoke:apps']},{...proposal,idempotency_key:randomUUID()}));
  // Tools cannot choose an owner: native employees are resolved from the row.
  const employee=randomUUID();await db.insert(s.agentEmployees).values({id:employee,org_id:org,user_id:owner,name:'Batch employee',slug:'batch-'+employee,role:'custom',created_by:owner,system_prompt:'Test',max_daily_actions:10});
  const {executeToolCall}=await import('../src/lib/agent-context.js');
  const native=await executeToolCall('app_action_batch_propose',{...proposal,idempotency_key:randomUUID(),items:[proposal.items[0]]},org,owner,undefined,employee);
  const nativeResult=native.result as typeof proposed;assert.ok(nativeResult.batch?.id,JSON.stringify(native));
  const forged=await executeToolCall('app_action_batch_propose',{...proposal,idempotency_key:randomUUID(),owner_user_id:member},org,owner,undefined,employee);assert.ok((forged.result as any).error);
  const nativePath='/api/app-action-batches/'+nativeResult.batch.id,nativeReview=await call(nativePath+'/review','POST',{});
  await call(nativePath+'/approve','POST',{ticket:nativeReview.ticket,expected_digest:nativeReview.digest});
  const {session:operatorSession}=await call('/api/apps/blob/composition/runtime/bindings/'+binding.binding_id+'/sessions','POST',{});
  const claim=await rt.runtimeChannel.claim({schema_version:'deft.app_runtime_channel.v1',session_id:operatorSession.session_id,session_token:operatorSession.session_token,max_claims:1});
  assert.equal(claim?.run_id,nativeResult.items[0]!.run_id);
  const nativeCancel=await executeToolCall('app_action_batch_cancel',{batch_id:nativeResult.batch.id},org,owner,undefined,employee);assert.equal((nativeCancel.result as typeof proposed).batch.state,'cancelled');
  assert.equal(await rt.runtimeChannel.start({schema_version:'deft.app_runtime_channel.v1',session_id:operatorSession.session_id,session_token:operatorSession.session_token,run_id:claim!.run_id,attempt_id:claim!.attempt_id,claim_token:claim!.claim_token,sequence:claim!.sequence}),null,'cancel after claim fences provider start and plaintext input');
  const [cancelledAttempt]=await db.select().from(s.appRunAttempts).where(orm.eq(s.appRunAttempts.id,claim!.attempt_id));assert.equal(cancelledAttempt.provider_call_started_at,null);
  const employeeBatch=await service.propose({...caller,user_id:member,employee_id:employee},{...proposal,idempotency_key:randomUUID()});
  const employeeReview=await call('/api/app-action-batches/'+employeeBatch.batch.id+'/review','POST',{});
  await db.update(s.agentEmployees).set({unhealthy:true}).where(orm.eq(s.agentEmployees.id,employee));
  assert.ok((await request('/api/app-action-batches/'+employeeBatch.batch.id+'/approve','POST',{ticket:employeeReview.ticket,expected_digest:employeeReview.digest})).status>=400);
  const revoked=await service.propose(caller,{...proposal,idempotency_key:randomUUID()});const revokePath='/api/app-action-batches/'+revoked.batch.id;
  const revokedTicket=await call(revokePath+'/review','POST',{});
  const oldPolicy=await service.propose(caller,{...proposal,idempotency_key:randomUUID()}),oldPolicyPath='/api/app-action-batches/'+oldPolicy.batch.id;
  const oldPolicyReview=await call(oldPolicyPath+'/review','POST',{});await call(oldPolicyPath+'/approve','POST',{ticket:oldPolicyReview.ticket,expected_digest:oldPolicyReview.digest});
  await call(policyPath,'PUT',{mode:'deny',expected_revision:1});
  assert.ok((await request(revokePath+'/approve','POST',{ticket:revokedTicket.ticket,expected_digest:revokedTicket.digest})).status>=400);
  await assert.rejects(service.propose(caller,{...proposal,idempotency_key:randomUUID()}));
  const visibleDenied=await getRuntimeAction(actor,{runtime_binding_id:binding.binding_id});assert.equal(visibleDenied.agent_policy,'deny');
  await call(policyPath,'PUT',{mode:'require_approval',expected_revision:2});
  assert.equal(await rt.repository.transaction(async tx=>actionBatchReleaseIsCurrent(tx,(await rt.repository.lockRun(tx,org,oldPolicy.items[0]!.run_id))!)),false,'deny then regrant never revives an old batch');
  assert.ok((await request(revokePath+'/review','POST',{})).status>=400,'fresh review cannot revive a batch under a changed policy revision');
  const consentBatch=await service.propose(caller,{...proposal,idempotency_key:randomUUID()}),consentPath='/api/app-action-batches/'+consentBatch.batch.id;
  const revokedWeb=await web.createWebSession({id:owner,org_id:org,email:`run-owner-${suffix}@example.test`}),revokedWebIdentity=await web.verifyWebAccess(revokedWeb.accessToken);
  const revokedWebReview=await call(consentPath+'/review','POST',{},revokedWeb.accessToken);
  await db.update(s.webSessions).set({revoked_at:new Date()}).where(orm.eq(s.webSessions.id,revokedWebIdentity.sid));
  assert.equal((await request(consentPath+'/approve','POST',{ticket:revokedWebReview.ticket,expected_digest:revokedWebReview.digest},revokedWeb.accessToken)).status,401);
  const consentReview=await call(consentPath+'/review','POST',{});
  await db.execute(orm.sql`UPDATE app_experience_consent_grants SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE org_id=${org} AND owner_user_id=${owner} AND revoked_at IS NULL`);
  assert.ok((await request(consentPath+'/approve','POST',{ticket:consentReview.ticket,expected_digest:consentReview.digest})).status>=400);
  // Database updates cannot swap a reviewed item, title or batch membership.
  await assert.rejects(db.execute(orm.sql`UPDATE app_action_batches SET title='changed' WHERE org_id=${org} AND id=${consentBatch.batch.id}`));
  await assert.rejects(db.execute(orm.sql`UPDATE app_action_batch_items SET label='changed' WHERE org_id=${org} AND batch_id=${consentBatch.batch.id}`));
});
