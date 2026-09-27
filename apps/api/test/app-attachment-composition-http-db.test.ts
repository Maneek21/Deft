import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
const target=process.env.DEFT_TEST_DATABASE_URL;
const safe=(()=>{try{if(!target||target!==process.env.DATABASE_URL)return false;const u=new URL(target);
  return u.hostname==='127.0.0.1'&&u.port==='55435'&&u.username==='gate_g_test'&&!u.password
    &&/^\/gate_g_20260927_c22_email7_test(?:_v[0-9]+)?$/u.test(u.pathname)&&!u.search&&!u.hash;}catch{return false;}})();
test('packed Email7 composition retains separately reviewed sync, scalar and Runtime authority',
  {skip:!safe,timeout:90_000},async t=>{
  Object.assign(process.env,{DEFT_APPS_ENABLED:'true',DEFT_APP_RUNS_ENABLED:'true',DEFT_APP_RUN_APP_ORIGIN_ENABLED:'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED:'true',DEFT_APP_ATTACHMENT_BROKER_ENABLED:'true',
    DEFT_APP_RUNTIME_CHANNEL_ENABLED:'true',DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED:'true',DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED:'true',
    DEFT_APP_PRIVATE_SHARING_ENABLED:'true',DEFT_APP_PRIVATE_MCP_ENABLED:'true'});
  const key=(purpose:string)=>({current:purpose,keys:{[purpose]:createHash('sha256').update(`email7:${purpose}`).digest('base64')}});
  process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',
    run_encryption:key('email7-enc'),receipt_signing:key('email7-sign'),fingerprint:key('email7-fp')});
  const root=process.env.DEFT_EMAIL7_AUTHOR_DIR;
  assert.ok(root&&resolve(root).startsWith('C:\\Users\\Osheen Pradhan\\Documents\\Codex\\'));
  const child=fork(resolve(root!,'provider.mjs'),[],{cwd:root,execArgv:[],stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  const messages:any[]=[];child.on('message',m=>messages.push(m));
  const wait=(type:string):Promise<any>=>{const i=messages.findIndex(m=>m.type===type);if(i>=0)return Promise.resolve(messages.splice(i,1)[0]);
    return new Promise((done,reject)=>{const timer=setTimeout(()=>finish(new Error(`Provider timeout ${type}`)),15_000);
      function finish(error?:Error,value?:any){clearTimeout(timer);child.off('message',message);child.off('exit',exit);error?reject(error):done(value);}
      function message(m:any){if(m.type==='error')finish(new Error(`Provider failed ${m.code} at ${m.phase} HTTP ${m.status??'none'}`));else if(m.type===type)finish(undefined,m);}
      function exit(code:number|null){finish(new Error(`Provider exited ${code}`));}child.on('message',message);child.once('exit',exit);});};
  const [{app},{serve},{db,closeDb},s,orm,web,runtimeModule]=await Promise.all([import('../src/index.js'),import('@hono/node-server'),
    import('../src/lib/db.js'),import('@deft/db/schema'),import('drizzle-orm'),import('../src/lib/web-sessions.js'),import('../src/lib/app-run-runtime.js')]);
  let server!:ReturnType<typeof serve>;
  const base=await new Promise<string>(ready=>{server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0},info=>ready(`http://127.0.0.1:${info.port}`));});
  try{
    await wait('ready');const org=randomUUID(),owner=randomUUID(),operator=randomUUID(),suffix=randomUUID();
    await db.insert(s.orgs).values({id:org,name:'Email7 synthetic composition',slug:`email7-${suffix}`});
    await db.insert(s.users).values([{id:owner,name:'Owner',email:`owner-${suffix}@example.test`},{id:operator,name:'Operator',email:`operator-${suffix}@example.test`}]);
    await db.insert(s.orgMembers).values([{id:randomUUID(),org_id:org,user_id:owner,role:'owner',is_active:true},
      {id:randomUUID(),org_id:org,user_id:operator,role:'member',is_active:true}]);
    let ownerSession=await web.createWebSession({id:owner,org_id:org,email:`owner-${suffix}@example.test`});
    const ownerSid=(await web.verifyWebAccess(ownerSession.accessToken)).sid;
    const operatorSession=await web.createWebSession({id:operator,org_id:org,email:`operator-${suffix}@example.test`});
    async function response(path:string,method='GET',body?:unknown,bearer=ownerSession.accessToken){
      const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${bearer}`,...(body===undefined?{}:{'content-type':'application/json'})},
        ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
      return {status:r.status,headers:r.headers,value:await r.json() as any};
    }
    async function call(path:string,method='GET',body?:unknown,bearer=ownerSession.accessToken){const r=await response(path,method,body,bearer);
      assert.ok(r.status<400,`${path} HTTP ${r.status} ${r.value.code}`);return r.value;}
    const blob='/api/apps/blob';child.send({type:'author'});const authored=await wait('authored');
    const {app:staged}=await call(blob+'/composition/stage','POST',authored.package_json);
    const context=await call(`${blob}/composition/${staged.id}/context?app_version_id=${staged.version_id}`);
    assert.equal(context.schema_version,'deft.app_blob_review_context.v2');
    const {review}=await call(`${blob}/composition/${staged.id}/review`,'POST',context.review_request);
    const {app:activation}=await call(`${blob}/composition/${staged.id}/activate`,'POST',
      {...context.review_request,expected_review_digest:review.review_digest,accept_host_policy:true});
    const grants=(await call(`/api/apps/${staged.id}/grants`)).grants;
    const grant=grants.snapshots.find((row:any)=>row.id===activation.grant_snapshot_id);assert.ok(grant);
    const version=grants.versions.find((row:any)=>row.id===staged.version_id);assert.ok(version);
    const [storedGrant]=await db.select().from(s.appGrantSnapshots).where(orm.and(orm.eq(s.appGrantSnapshots.org_id,org),
      orm.eq(s.appGrantSnapshots.id,grant.id)));assert.ok(storedGrant);
    assert.equal(storedGrant.canonical_snapshot.schema,'deft.app_blob_grant.v2');
    assert.equal((storedGrant.canonical_snapshot.runtime_actions as unknown[]).length,3);
    const {setup}=await call(`${blob}/sync/setup?installation_id=${staged.id}&operator_user_id=${operator}`);
    const consent=setup.descriptors[0].consent_request;
    const {review:syncReview}=await call(blob+'/sync/reviews/prepare','POST',consent);
    const {binding:syncBinding}=await call(blob+'/sync/bindings/activate','POST',{...consent,expected_review_digest:syncReview.review_digest,accept_host_policy:true});
    const {session:syncSession}=await call(`${blob}/sync/bindings/${syncBinding.binding_id}/sessions`,'POST',{},operatorSession.accessToken);
    const sync=await call(`${blob}/sync/bindings/${syncBinding.binding_id}/sync`,'POST',{});assert.equal(sync.state,'created');
    child.send({type:'sync',channel_url:base+'/api/app-resource-sync-channel/v3',
      credential:{session_id:syncSession.session_id,session_token:syncSession.session_token}});
    const synced=await wait('synced');assert.equal(synced.run_id,sync.run_id);
    const [projection]=await db.select().from(s.appResourceProjections).where(orm.and(orm.eq(s.appResourceProjections.org_id,org),
      orm.eq(s.appResourceProjections.resource_binding_id,syncBinding.binding_id)));assert.ok(projection);
    const runtime=await runtimeModule.getAppRunRuntime();
    const bindingRequest={installation_id:staged.id,action_key:'send_message',operator_user_id:operator,
      expected_app_version_id:staged.version_id,expected_package_digest:version.package_digest,
      expected_grant_snapshot_digest:grant.snapshot_digest,expected_lifecycle_epoch:grants.installation.lifecycle_epoch,
      expected_grant_epoch:grants.installation.grant_epoch};
    const {review:bindingReview}=await call(blob+'/composition/runtime/reviews/prepare','POST',bindingRequest);
    const {binding:runtimeBinding}=await call(blob+'/composition/runtime/bindings/activate','POST',
      {...bindingRequest,expected_review_digest:bindingReview.review_digest,accept_host_policy:true});
    const {session:runtimeSession}=await call(`${blob}/composition/runtime/bindings/${runtimeBinding.binding_id}/sessions`,'POST',{},operatorSession.accessToken);
    const invoke={runtime_binding_id:runtimeBinding.binding_id,idempotency_key:`email7:${suffix}`,
      input:{to:'recipient@example.test',subject:'Synthetic send',body:'Private compose body',message_id:'synthetic-composition-send@example.test'}};
    let run:any;
    await t.test('separately consented parent catalog, bytes and Experience search remain readable with action plane disabled',async()=>{
      process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED='false';
      try {
      const parents=await call(`/api/private-resources/bindings/${syncBinding.binding_id}/attachment-parents?limit=1`);
      assert.equal(parents.items.length,1);assert.equal(parents.items[0].projection_id,projection.id);assert.equal(parents.next_cursor,null);
      const parent=await call(`/api/private-resources/bindings/${syncBinding.binding_id}/attachment-parents/${projection.id}`);
      assert.equal(parent.data.subject,'Saved hostile <script>literal</script> Email');assert.equal(parent.attachments.attachments.length,1);
      const bytes=await fetch(`${base}/api/private-resources/bindings/${syncBinding.binding_id}/records/${projection.id}/attachments/${synced.staging_id}/content`,
        {headers:{authorization:`Bearer ${ownerSession.accessToken}`}});
      assert.equal(bytes.status,200);assert.deepEqual(Buffer.from(await bytes.arrayBuffer()),Buffer.from(synced.bytes_b64,'base64'));
      const experience=await call(`/api/app-experiences/${staged.id}/main/sessions`,'POST',{});
      const path=`/api/app-experiences/sessions/${experience.pin.session_id}`;
      const exposureReview=await call(path+'/exposure/review','POST',{});
      const accepted=await call(path+'/exposure/accept','POST',{review_token:exposureReview.review_token,
        review_digest:exposureReview.review_digest,accept_exposure:true});assert.ok(accepted.exposure_id);
      const {output:page}=await call(path+'/resources/inbox','POST',{schema_version:'deft.experience_resource_request.v2',
        operation:'search',query:'hostile',field_keys:['subject']});
      assert.equal(page.items.length,1);assert.equal(page.items[0].label,parent.data.subject);
      assert.ok((await response(blob+'/composition/runtime/invoke','POST',invoke)).status>=400);
      } finally { process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED='true'; }
    });
    const {ref}=await call(`/api/private-resources/bindings/${syncBinding.binding_id}/attachment-parents/${projection.id}`);
    const personal=await (await import('../src/lib/mcp-token.js')).issuePersonalMcpToken({orgId:org,userId:owner,
      name:'Email7 selected scalar fixture',scopes:['read:app-private-resources'],createdBy:owner});
    const mcpRead=(id:string)=>call('/api/mcp/v1','POST',{jsonrpc:'2.0',id:1,method:'tools/call',
      params:{name:'app_private_resource_read',arguments:{schema_version:'deft.app_private_mcp_read.v1',grant_id:id}}},personal.raw);
    let humanGrant:string,mcpGrant:string;
    await t.test('Email7 scalar human and MCP grants require independent consent and never deliver attachment metadata or bytes',async()=>{
      process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED='false';
      try {
        const common={ref,operations:['read'],field_keys:['subject'],expires_at:new Date(Date.now()+600000).toISOString()};
        const humanReview=await call('/api/app-resource-access/reviews','POST',{...common,
          schema_version:'deft.app_resource_access_review.v1',destination:{kind:'human',user_id:operator}});
        assert.equal(humanReview.snapshot.descriptor_digest,setup.descriptors[0].descriptor_digest);
        ({grant_id:humanGrant}=await call('/api/app-resource-access/grants','POST',
          {review_token:humanReview.review_token,review_digest:humanReview.review_digest,accept_access:true}));
        const human=await call(`/api/app-resource-access/grants/${humanGrant}/resource`,'GET',undefined,operatorSession.accessToken);
        assert.deepEqual(human.data,{subject:'Saved hostile <script>literal</script> Email'});
        assert.ok((await mcpRead(humanGrant)).result.isError,'Human consent cannot authorize MCP');
        const mcpReview=await call('/api/app-private-mcp/reviews','POST',{...common,
          schema_version:'deft.app_private_mcp_review.v1',destination:{kind:'personal_mcp',token_id:personal.tokenId}});
        assert.equal(mcpReview.snapshot.descriptor_digest,setup.descriptors[0].descriptor_digest);
        ({grant_id:mcpGrant}=await call('/api/app-private-mcp/grants','POST',
          {review_token:mcpReview.review_token,review_digest:mcpReview.review_digest,accept_access:true}));
        const result=(await mcpRead(mcpGrant)).result;assert.notEqual(result.isError,true);
        const record=JSON.parse(result.content[0].text);assert.deepEqual(record.data,human.data);
        for(const value of [human,record]) { const encoded=JSON.stringify(value);
          assert.ok(!encoded.includes(synced.staging_id)&&!encoded.includes('text/csv')&&!encoded.includes('bytes_b64'));
          assert.equal(Object.hasOwn(value,'attachments'),false);
        }
        assert.ok((await response(`/api/private-resources/bindings/${syncBinding.binding_id}/records/${projection.id}/attachments`,
          'GET',undefined,operatorSession.accessToken)).status>=400,'Scalar recipient cannot acquire custody catalog');
      } finally { process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED='true'; }
    });
    assert.ok(humanGrant!&&mcpGrant!,'Separate grants prepared before final-wait checks');
    await t.test('actual human SID and MCP token waits deny Email7 scalar delivery after attachment gate withdrawal',async()=>{
      const operatorSid=(await web.verifyWebAccess(operatorSession.accessToken)).sid;
      for(const mode of ['human','mcp'] as const) {
        const lock=new pg.Client({connectionString:target});await lock.connect();
        try {
          await lock.query('BEGIN');
          if(mode==='human')await lock.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE',[operatorSid]);
          else await lock.query('SELECT id FROM mcp_tokens WHERE id=$1 FOR UPDATE',[personal.tokenId]);
          const pending=mode==='human'?response(`/api/app-resource-access/grants/${humanGrant!}/resource`,'GET',undefined,operatorSession.accessToken):mcpRead(mcpGrant!);
          const pid=(await lock.query('SELECT pg_backend_pid() AS id')).rows[0].id;
          const until=performance.now()+5000;let observed=false;
          while(performance.now()<until){if((await lock.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].n>0){observed=true;break;}
            await new Promise(done=>setTimeout(done,20));}assert.ok(observed,`Actual ${mode} credential lock wait`);
          process.env.DEFT_APP_ATTACHMENT_BROKER_ENABLED='false';await lock.query('COMMIT');
          const denied=await pending;
          if(mode==='human')assert.ok(denied.status>=400);else assert.equal(denied.result.isError,true);
          assert.ok(!JSON.stringify(denied).includes('Saved hostile'));
        } finally {process.env.DEFT_APP_ATTACHMENT_BROKER_ENABLED='true';await lock.query('ROLLBACK').catch(()=>{});await lock.end();}
      }
    });
    await t.test('guarded invocation and normal Inbox exact-input review reject the legacy unguarded path',async()=>{
      assert.ok((await response('/api/app-runtime-actions/invoke','POST',invoke)).status>=400);
      ({run}=await call(blob+'/composition/runtime/invoke','POST',invoke));assert.equal(run.state,'pending_approval');
      assert.equal((await call(blob+'/composition/runtime/invoke','POST',invoke)).run.id,run.id);
      const reviewed=(await call(`/api/app-runtime-actions/${run.id}/review`)).review;assert.deepEqual(reviewed.input,invoke.input);
      assert.ok((await response(`/api/app-runtime-actions/${run.id}/review`,'GET',undefined,operatorSession.accessToken)).status>=400);
      const [approval]=await db.select().from(s.agentActions).where(orm.and(orm.eq(s.agentActions.org_id,org),orm.eq(s.agentActions.app_run_id,run.id)));assert.ok(approval);
      await assert.rejects(runtime.approvalResolver.approve(approval.id,owner),(error:any)=>error.code==='APP_RUN_ACCESS_DENIED');
    });
    assert.ok(run,'Run admission must pass before dependent lifecycle checks');
    await t.test('actual held final SID expiry denies private review and new invocation without partial admission',async()=>{
      const lock=new pg.Client({connectionString:target});await lock.connect();
      try{await lock.query('BEGIN');await lock.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE',[ownerSid]);
        const pending=response(`/api/app-runtime-actions/${run.id}/review`);
        const pid=(await lock.query('SELECT pg_backend_pid() AS id')).rows[0].id;
        const until=performance.now()+5000;let observed=false;
        while(performance.now()<until){if((await lock.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].n>0){observed=true;break;}
          await new Promise(done=>setTimeout(done,20));}assert.ok(observed,'Actual review SID lock wait');
        await lock.query("UPDATE web_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[ownerSid]);await lock.query('COMMIT');
        assert.ok((await pending).status>=400);
        const rejected=await response(blob+'/composition/runtime/invoke','POST',{...invoke,idempotency_key:invoke.idempotency_key+':expired'});assert.ok(rejected.status>=400);
        assert.equal((await db.select().from(s.appRuns).where(orm.and(orm.eq(s.appRuns.org_id,org),orm.eq(s.appRuns.origin_runtime_binding_id,runtimeBinding.binding_id)))).length,1);
      }finally{await lock.query('ROLLBACK').catch(()=>{});await lock.end();
        ownerSession=await web.createWebSession({id:owner,org_id:org,email:`owner-${suffix}@example.test`});}
    });
    await t.test('normal owner approval, packed Runtime consumption and guarded retained output preserve one Run and verified receipt',async()=>{
      const [approval]=await db.select().from(s.agentActions).where(orm.and(orm.eq(s.agentActions.org_id,org),orm.eq(s.agentActions.app_run_id,run.id)));
      await call(`/api/agent/actions/${approval!.id}/approve`,'POST',{});
      child.send({type:'runtime',channel_url:base+'/api/app-runtime/channel',
        credential:{session_id:runtimeSession.session_id,session_token:runtimeSession.session_token}});
      assert.equal((await wait('runtime_settled')).run_id,run.id);
      const result=await call(`/api/app-runs/${run.id}/result`);assert.equal(result.run.state,'succeeded');
      assert.ok(JSON.stringify(result.value).includes('synthetic_committed'));
      await assert.rejects(runtime.service.result(org,run.id,{actor_type:'human',user_id:owner},null),
        (error:any)=>error.code==='APP_RUN_ACCESS_DENIED');
      assert.ok((await runtime.receiptReader.readVerified(org,run.id)).some(row=>row.verified&&row.receipt_kind==='attempt_terminal'));
    });
    if(process.env.DEFT_EMAIL7_PRESERVE_PRIVATE_FIXTURE==='true') {
      // Reusable synthetic fixture only, outside the repository. Never include
      // this credential artifact in evidence logs/screenshots or source hashes.
      writeFileSync(resolve(root!,'../fixture-private.json'),JSON.stringify({org_id:org,owner_user_id:owner,operator_user_id:operator,
        owner:ownerSession,operator:operatorSession,installation_id:staged.id,app_version_id:staged.version_id,
        sync_binding_id:syncBinding.binding_id,sync_credential:{session_id:syncSession.session_id,session_token:syncSession.session_token},
        runtime_binding_id:runtimeBinding.binding_id,runtime_credential:{session_id:runtimeSession.session_id,session_token:runtimeSession.session_token},
        runtime_review_pins:bindingRequest,parent_ref:ref,synthetic_run_id:run.id}),{mode:0o600});
    }
    await t.test('held exact Runtime input read cannot release Email7 private input after action gate withdrawal',async()=>{
      const {run:late}=await call(blob+'/composition/runtime/invoke','POST',{...invoke,idempotency_key:invoke.idempotency_key+':late-input'});
      const [approval]=await db.select().from(s.agentActions).where(orm.and(orm.eq(s.agentActions.org_id,org),orm.eq(s.agentActions.app_run_id,late.id)));
      await call(`/api/agent/actions/${approval!.id}/approve`,'POST',{});
      const channel=async(operation:string,body:unknown)=>{
        const r=await fetch(base+'/api/app-runtime/channel/'+operation,{method:'POST',headers:{
          authorization:`AppRuntime ${runtimeSession.session_token}`,'content-type':'application/json'},body:JSON.stringify(body)});
        return {status:r.status,value:await r.json() as any};
      };
      const identity={schema_version:'deft.app_runtime_channel.v1',session_id:runtimeSession.session_id};
      const {claim}=(await channel('claim',{...identity,max_claims:1})).value;assert.equal(claim.run_id,late.id);
      let reached!:()=>void,release!:()=>void;
      const entered=new Promise<void>(done=>{reached=done;}),held=new Promise<void>(done=>{release=done;});
      const original=runtime.secretRepository.readInput.bind(runtime.secretRepository);
      runtime.secretRepository.readInput=async(...args:Parameters<typeof original>)=>{
        const exact=await original(...args);
        if(args[0]===org&&args[1]===late.id){reached();await held;}return exact;
      };
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        const pending=channel('start',{...identity,run_id:claim.run_id,attempt_id:claim.attempt_id,
          claim_token:claim.claim_token,sequence:claim.sequence});
        await Promise.race([entered,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Exact input read not reached')),5000);})]);
        if(timer)clearTimeout(timer);
        process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED='false';release();
        const denied=await pending;assert.ok(denied.status>=400,'No input delivered after actual awaited secret read');
        assert.ok(!JSON.stringify(denied.value).includes('Private compose body'));
        const [attempt]=await db.select().from(s.appRunAttempts).where(orm.and(orm.eq(s.appRunAttempts.org_id,org),orm.eq(s.appRunAttempts.id,claim.attempt_id)));
        assert.equal(attempt!.state,'provider_call_started','Started dispatch remains honestly retained; no fabricated cancellation');
      } finally {if(timer)clearTimeout(timer);release();runtime.secretRepository.readInput=original;
        process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED='true';}
    });
  }finally{child.kill();await new Promise<void>(done=>server.close(()=>done()));await runtimeModule.shutdownAppRunRuntime();await closeDb();}
});
