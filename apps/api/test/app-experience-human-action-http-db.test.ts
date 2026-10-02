import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';
const safe=securityTestDatabaseIsSafe();

test('trusted host Send atomically releases exact human input with receipts and idempotency', { skip: !safe, timeout: 90000 }, async t => {
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
  for (const descriptor of syncSetup.descriptors) {
    const consent=descriptor.consent_request;
    const {review:r}=await call('/api/apps/blob/sync/reviews/prepare','POST',consent);
    await call('/api/apps/blob/sync/bindings/activate','POST',{...consent,expected_review_digest:r.review_digest,accept_host_policy:true});
  }
  const current=await create(), sid=current.pin.session_id, base='/api/app-experiences/sessions/'+sid;
  const {review_token,review_digest}=await call(base+'/exposure/review','POST',{});
  await call(base+'/exposure/accept','POST',{review_token,review_digest,accept_exposure:true});
  const action=base+'/human-actions/send_message';
  const policyPath=base+'/agent-policies/send_message';
  assert.deepEqual(await call(policyPath),{mode:'deny',revision:0});
  assert.deepEqual(await call(policyPath,'PUT',{mode:'require_approval',expected_revision:0}),{mode:'require_approval',revision:1});
  assert.equal((await request(policyPath,'PUT',{mode:'deny',expected_revision:0})).status,409);
  assert.ok((await request(policyPath,'PUT',{mode:'autonomous',expected_revision:1})).status>=400);
  assert.ok((await request(policyPath,'PUT',{mode:'deny',expected_revision:1},outsider.accessToken)).status>=400);
  const contextResult=await call(action+'/context');assert.equal(contextResult.action_key,'send_message');
  const input={to:'recipient@example.test',subject:'Host exact Send',body:'PRIVATE-HUMAN-ACTION',message_id:'<host-probe@example.test>'};
  assert.ok((await request(action+'/prepare','POST',{input:{...input,attachments:['undeclared-blob']},idempotency_key:randomUUID()})).status>=400);
  const key=randomUUID();
  const ticket=await call(action+'/prepare','POST',{input,idempotency_key:key});
  assert.equal(JSON.stringify(ticket).includes(input.body),false);
  assert.equal((await db.select().from(s.appRuns).where(orm.eq(s.appRuns.org_id,org))).length,0);
  const confirm={ticket:ticket.ticket,expected_input_digest:ticket.input_digest};
  assert.ok((await request(base+'/human-actions/confirm','POST',{...confirm,input:{...input,body:'SUBSTITUTE'}})).status>=400);
  assert.ok((await request(base+'/human-actions/confirm','POST',confirm,second.accessToken)).status>=400);
  assert.ok((await request(base+'/human-actions/confirm','POST',confirm,outsider.accessToken)).status>=400);
  const auth=await web.verifyWebAccess(first.accessToken);const host={org_id:auth.org_id,user_id:auth.id,sid:auth.sid,access_expires_at:auth.exp*1000};
  const {AppExperienceExposureService}=await import('../src/lib/app-experience-exposure.js');
  const {AppExperienceHumanActionService}=await import('../src/lib/app-experience-human-action-service.js');
  const rt=await runtime.getAppRunRuntime();const authority=new AppExperienceExposureService(rt.keys);
  for(const failAt of [1,2]){let finals=0;
    const injected={withHumanAction:async(c:any,id:string,key:string,use:any,signal?:AbortSignal)=>authority.withHumanAction(c,id,key,(tx,a,final)=>use(tx,a,async()=>{await final();if(++finals===failAt)throw Error('INJECTED_FINAL_FAILURE')}),signal)};
    await assert.rejects(new AppExperienceHumanActionService(injected,rt).confirm(host,sid,confirm),/INJECTED_FINAL_FAILURE/);
    assert.equal((await db.select().from(s.appRuns).where(orm.eq(s.appRuns.org_id,org))).length,0);
    assert.equal((await db.select().from(s.agentActions).where(orm.eq(s.agentActions.org_id,org))).length,0);
  }
  const parallel=process.env.DEFT_HUMAN_ACTION_LOOKUP_PROFILE === 'true'
    ? [await request(base+'/human-actions/confirm','POST',confirm)]
    : await Promise.all([request(base+'/human-actions/confirm','POST',confirm),request(base+'/human-actions/confirm','POST',confirm)]);
  assert(parallel.some(response=>response.ok));
  const one=await parallel.find(response=>response.ok)!.json() as any;
  const two=await call(base+'/human-actions/confirm','POST',confirm);
  // Bounded lock contention may reject one concurrent request; retained replay still resolves one Run.
  assert.equal(one.run.id,two.run.id);assert.equal(one.run.execution_release_kind,'approved');
  assert.ok(one.run.execution_released_at);assert.equal(one.run.state,'pending');
  const restoredStatus=await call(base+'/runs/'+one.run.id);assert.equal(restoredStatus.run.state,'pending');
  const reviewTarget=await call(base+'/runs/'+one.run.id+'/review-target');assert.equal(reviewTarget.run_state,'pending');assert.equal(reviewTarget.approval_id,null);
  const queued=await db.select().from(s.appRunAttempts).where(orm.eq(s.appRunAttempts.run_id,one.run.id));
  assert.equal(queued.length,1,'approved exact Run owns one queued attempt');
  assert.equal(queued[0].state,'pending');assert.equal(queued[0].provider_call_started_at,null);
  const runs=await db.select().from(s.appRuns).where(orm.eq(s.appRuns.org_id,org));assert.equal(runs.length,1);
  assert.equal(runs[0].initiating_actor_type,'human');assert.equal(runs[0].initiating_actor_id,owner);
  const approvals=await db.select().from(s.agentActions).where(orm.eq(s.agentActions.app_run_id,one.run.id));
  assert.equal(approvals.filter(row=>row.approval_status==='pending').length,0);assert.equal(approvals.length,1);assert.equal(approvals[0].approval_status,'approved');assert.equal(approvals[0].approved_by_user_id,owner);
  const receiptRows=await db.select().from(s.appRunReceipts).where(orm.eq(s.appRunReceipts.run_id,one.run.id));
  assert.equal(receiptRows.filter(row=>row.receipt_kind==='approval').length,1);
  const replay=await call(base+'/human-actions/confirm','POST',confirm);assert.equal(replay.run.id,one.run.id);
  const lookupPath=action+'/submissions/'+key;
  assert.deepEqual(await call(lookupPath),{run:{id:one.run.id,state:'pending'}});
  assert.deepEqual(await call(action+'/submissions/'+randomUUID()),{run:null});
  assert.ok((await request(lookupPath,'GET',undefined,outsider.accessToken)).status>=400);
  assert.ok((await request(base+'/human-actions/reply_message/submissions/'+key)).status>=400);
  const freshOwnerSession=await create(second.accessToken),freshBase='/api/app-experiences/sessions/'+freshOwnerSession.pin.session_id;
  const freshReview=await call(freshBase+'/exposure/review','POST',{},second.accessToken);
  await call(freshBase+'/exposure/accept','POST',{review_token:freshReview.review_token,review_digest:freshReview.review_digest,accept_exposure:true},second.accessToken);
  assert.deepEqual(await call(freshBase+'/human-actions/send_message/submissions/'+key,'GET',undefined,second.accessToken),{run:{id:one.run.id,state:'pending'}});
  await assert.rejects(new AppExperienceHumanActionService(authority,rt).lookup({...host,org_id:randomUUID()},sid,'send_message',key));
  assert.equal((await db.select().from(s.appRuns).where(orm.eq(s.appRuns.org_id,org))).length,1,'lookup never creates another Run');
  assert.equal((await db.select().from(s.agentActions).where(orm.eq(s.agentActions.app_run_id,one.run.id))).length,1,'lookup never releases or approves again');
  assert.equal((await db.select().from(s.appRunAttempts).where(orm.eq(s.appRunAttempts.run_id,one.run.id)))[0].provider_call_started_at,null);

  const changed=await call(action+'/prepare','POST',{input:{...input,body:'CHANGED'},idempotency_key:key});
  assert.equal((await request(base+'/human-actions/confirm','POST',{ticket:changed.ticket,expected_input_digest:changed.input_digest})).status,409);
  const revoked=await call(action+'/prepare','POST',{input,idempotency_key:randomUUID()});
  await call(base+'/exposure','DELETE');
  assert.ok((await request(base+'/human-actions/confirm','POST',{ticket:revoked.ticket,expected_input_digest:revoked.input_digest})).status>=400);
  assert.equal((await db.select().from(s.appRuns).where(orm.eq(s.appRuns.org_id,org))).length,1);
  const {session:operatorSession}=await call('/api/apps/blob/composition/runtime/bindings/'+binding.binding_id+'/sessions','POST',{});
  const claimRequest={schema_version:'deft.app_runtime_channel.v1',session_id:operatorSession.session_id,session_token:operatorSession.session_token,max_claims:1};
  assert.equal(await rt.runtimeChannel.claim(claimRequest),null,'legacy exposure withdrawal fences queued input release');
  assert.equal((await db.select().from(s.attentionItems).where(orm.and(orm.eq(s.attentionItems.org_id,org),orm.eq(s.attentionItems.source_type,'agent_action')))).length,0);
  const durable=await create(), durableBase='/api/app-experiences/sessions/'+durable.pin.session_id;
  const access=await call(durableBase+'/access/review','POST',{});
  await call(durableBase+'/access/accept','POST',{review_token:access.review_token,review_digest:access.review_digest,accept_exposure:true});
  const durableTicket=await call(durableBase+'/human-actions/send_message/prepare','POST',{input,idempotency_key:randomUUID()});
  const durableRun=await call(durableBase+'/human-actions/confirm','POST',{ticket:durableTicket.ticket,expected_input_digest:durableTicket.input_digest});
  assert.equal(durableRun.run.execution_release_kind,'approved');
  const positiveHumanClaim=await rt.runtimeChannel.claim(claimRequest);
  assert.equal(positiveHumanClaim?.run_id,durableRun.run.id,'live approved human Run can be claimed');
  assert.ok(positiveHumanClaim?.claim_token);

  const {humanActionReleaseIsCurrent}=await import('../src/lib/app-experience-human-action-live.js');
  let releaseLock!:()=>void, admitted!:()=>void, contenderDone=false;
  const ready=new Promise<void>(resolve=>{admitted=resolve}), hold=new Promise<void>(resolve=>{releaseLock=resolve});
  const decision=db.transaction(async tx=>{assert.equal(await humanActionReleaseIsCurrent(tx,durableRun.run),true);admitted();await hold;});
  await ready;
  const contender=db.transaction(async tx=>{await tx.execute(orm.sql`SELECT g.id FROM app_experience_consent_grants g JOIN app_run_human_authorizations h ON h.org_id=g.org_id AND h.consent_grant_id=g.id WHERE h.org_id=${org} AND h.run_id=${durableRun.run.id} FOR UPDATE OF g`);contenderDone=true;});
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(contenderDone,false,'revoke mutation waits for admitted grant decision');
  releaseLock();await Promise.all([decision,contender]);assert.equal(contenderDone,true);
  await call(durableBase+'/access','DELETE');
  assert.equal(await rt.runtimeChannel.claim(claimRequest),null,'persistent grant withdrawal fences queued input release');
  assert.equal(await rt.runtimeChannel.start({schema_version:'deft.app_runtime_channel.v1',session_id:operatorSession.session_id,session_token:operatorSession.session_token,run_id:positiveHumanClaim!.run_id,attempt_id:positiveHumanClaim!.attempt_id,claim_token:positiveHumanClaim!.claim_token,sequence:positiveHumanClaim!.sequence}),null,'withdrawal after metadata claim fences provider start and plaintext input');
  const attempts=await db.select().from(s.appRunAttempts).where(orm.eq(s.appRunAttempts.org_id,org));
  assert(attempts.every(row=>row.provider_call_started_at===null));
  const agentSession=await create();const agentBase='/api/app-experiences/sessions/'+agentSession.pin.session_id;
  const agentExposure=await call(agentBase+'/exposure/review','POST',{});
  await call(agentBase+'/exposure/accept','POST',{review_token:agentExposure.review_token,review_digest:agentExposure.review_digest,accept_exposure:true});
  const agentPolicyPath=agentBase+'/agent-policies/send_message';
  // Actual hosted executor supplies employee identity; the model controls only closed request data.
  const employee=randomUUID();
  await db.insert(s.agentEmployees).values({id:employee,org_id:org,user_id:owner,name:'Scoped agent',slug:'agent-'+employee,role:'custom',created_by:owner,system_prompt:'Test',max_daily_actions:2});
  const {executeToolCall}=await import('../src/lib/agent-context.js');
  const params={runtime_binding_id:binding.binding_id,idempotency_key:'k'.repeat(80),input};
  await call(agentPolicyPath,'PUT',{mode:'deny',expected_revision:1});
  const denied=await executeToolCall('app_runtime_action_request',params,org,owner,undefined,employee);
  assert.ok(denied.result.error,'default denied agent intake');
  await call(agentPolicyPath,'PUT',{mode:'require_approval',expected_revision:2});
  const forged=await executeToolCall('app_runtime_action_request',{...params,agent_employee_id:member},org,owner,undefined,employee);
  assert.ok(forged.result.error);
  const requested=await executeToolCall('app_runtime_action_request',params,org,owner,undefined,employee);
  assert.equal(requested.result.state,'pending_approval',JSON.stringify(requested.result));
  const agentRunId=requested.result.run_id;
  const [agentRun]=await db.select().from(s.appRuns).where(orm.eq(s.appRuns.id,agentRunId));
  assert.equal(agentRun.initiating_actor_type,'agent_employee');assert.equal(agentRun.initiating_actor_id,employee);
  assert.equal(agentRun.execution_actor_type,'human');assert.equal(agentRun.execution_actor_id,owner);
  const replayAgent=await executeToolCall('app_runtime_action_request',params,org,owner,undefined,employee);
  assert.equal(replayAgent.result.run_id,agentRunId);
  const guard=async(tx:any)=>{await web.verifyWebAccess(first.accessToken);};
  const reviewed=await rt.service.reviewRuntimeInput({org_id:org,user_id:owner},agentRunId,guard);
  assert.deepEqual(reviewed.input,input);
  await assert.rejects(rt.service.reviewRuntimeInput({org_id:org,user_id:member},agentRunId,guard));
  const [agentApproval]=await db.select().from(s.agentActions).where(orm.eq(s.agentActions.app_run_id,agentRunId));
  assert.equal((await rt.approvalResolver.approve(agentApproval.id,member,guard)).status,'error');
  const approved=await rt.approvalResolver.approve(agentApproval.id,owner,guard);
  assert.equal(approved.status,'approved',JSON.stringify(approved));
  const [charged]=await db.select().from(s.agentEmployees).where(orm.eq(s.agentEmployees.id,employee));
  assert.equal(charged.daily_action_count,1);
  await rt.approvalResolver.approve(agentApproval.id,owner,guard);
  assert.equal((await db.select().from(s.agentEmployees).where(orm.eq(s.agentEmployees.id,employee)))[0].daily_action_count,1);
  await call(agentPolicyPath,'PUT',{mode:'deny',expected_revision:3});
  assert.equal(await rt.runtimeChannel.claim(claimRequest),null,'policy withdrawal fences approved agent release');
  await call(agentPolicyPath,'PUT',{mode:'require_approval',expected_revision:4});
  const secondAgent=await executeToolCall('app_runtime_action_request',{...params,idempotency_key:randomUUID()},org,owner,undefined,employee);
  assert.equal(secondAgent.result.state,'pending_approval');
  const [secondApproval]=await db.select().from(s.agentActions).where(orm.eq(s.agentActions.app_run_id,secondAgent.result.run_id));
  assert.equal((await rt.approvalResolver.approve(secondApproval.id,owner,guard)).status,'approved');
  await db.update(s.agentEmployees).set({unhealthy:true}).where(orm.eq(s.agentEmployees.id,employee));
  assert.equal(await rt.runtimeChannel.claim(claimRequest),null,'employee health withdrawal fences approved agent release');
  const agentReceipts=await db.select().from(s.appRunReceipts).where(orm.eq(s.appRunReceipts.run_id,agentRunId));
  assert.equal(agentReceipts.filter(row=>row.receipt_kind==='approval').length,1);

});
