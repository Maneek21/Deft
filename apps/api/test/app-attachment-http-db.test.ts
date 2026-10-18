import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { resolve } from 'node:path';
const target=process.env.DEFT_TEST_DATABASE_URL;
const safe=(()=>{if(!target||target!==process.env.DATABASE_URL)return false;try{const u=new URL(target);return u.hostname==='127.0.0.1'&&u.port==='55435'&&u.username==='gate_g_test'&&/^\/gate_g_20260927_c19_attachment_test(?:_v[0-9]+)?$/u.test(u.pathname)&&!u.search&&!u.hash;}catch{return false;}})();
test('packed protocol7 provider stages bytes then normal channel3 settlement links owner-only download',
 {skip:!safe,timeout:60_000},async t=>{
  process.env.DEFT_APPS_ENABLED='true';process.env.DEFT_APP_RUNS_ENABLED='true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED='true';process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED='true';
  process.env.DEFT_APP_ATTACHMENT_BROKER_ENABLED='true';process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED='false';
  const key=(purpose:string)=>({current:purpose,keys:{[purpose]:createHash('sha256').update(`attachment-http:${purpose}`).digest('base64')}});
  process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',run_encryption:key('attachment-enc'),receipt_signing:key('attachment-sign'),fingerprint:key('attachment-fp')});
  const root=process.env.DEFT_ATTACHMENT_AUTHOR_DIR;
  assert.ok(root&&resolve(root).startsWith('C:\\Users\\Osheen Pradhan\\Documents\\Codex\\'));
  const child=fork(resolve(root!,'provider.mjs'),[],{cwd:root,execArgv:[],stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  const messages:any[]=[];child.on('message',m=>messages.push(m));
  function wait(type:string):Promise<any>{const index=messages.findIndex(m=>m.type===type);if(index>=0)return Promise.resolve(messages.splice(index,1)[0]);
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>finish(new Error(`Provider timeout ${type}`)),15_000);
      function finish(error?:Error,value?:any){clearTimeout(timer);child.off('message',message);child.off('exit',exit);error?reject(error):resolve(value);}
      function message(m:any){if(m.type==='error')finish(new Error(`Provider failed ${m.code}`));else if(m.type===type){messages.splice(messages.indexOf(m),1);finish(undefined,m);}}
      function exit(code:number|null){finish(new Error(`Provider exited ${code}`));}child.on('message',message);child.once('exit',exit);});}
  const [{Hono},{serve},{db,closeDb},s,orm,web,runtime,blob,channel]=await Promise.all([
    import('hono'),import('@hono/node-server'),import('../src/lib/db.js'),import('@deft/db/schema'),import('drizzle-orm'),
    import('../src/lib/web-sessions.js'),import('../src/lib/app-run-runtime.js'),import('../src/routes/app-attachments.js'),
    import('../src/routes/app-attachment-sync-channel.js')]);
  const app=new Hono();app.route('/api/apps/blob',blob.appAttachmentRoutes);app.route('/api/private-resources',blob.appAttachmentOwnerRoutes);app.route('/api/app-resource-sync-channel/v3',channel.appAttachmentSyncChannelRoutes);
  let server!:ReturnType<typeof serve>;
  const base=await new Promise<string>(ready=>{server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0},info=>ready(`http://127.0.0.1:${info.port}`));});
  try{
    await wait('ready');const org=randomUUID(),owner=randomUUID(),operator=randomUUID(),suffix=randomUUID().replaceAll('-','');
    await db.insert(s.orgs).values({id:org,name:'Attachment synthetic org',slug:`attachment-${suffix}`});
    await db.insert(s.users).values([{id:owner,name:'Owner',email:`owner-${suffix}@example.test`},{id:operator,name:'Operator',email:`operator-${suffix}@example.test`}]);
    await db.insert(s.orgMembers).values([{id:randomUUID(),org_id:org,user_id:owner,role:'owner',is_active:true},{id:randomUUID(),org_id:org,user_id:operator,role:'member',is_active:true}]);
    const ownerSession=await web.createWebSession({id:owner,org_id:org,email:`owner-${suffix}@example.test`});
    const operatorSession=await web.createWebSession({id:operator,org_id:org,email:`operator-${suffix}@example.test`});
    async function call(path:string,method='GET',body?:unknown,bearer=ownerSession.accessToken,prefix='/api/apps/blob'){
      const response=await fetch(base+prefix+path,{method,headers:{authorization:`Bearer ${bearer}`,...(body===undefined?{}:{'content-type':'application/json'})},
        ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
      const value=await response.json() as any;
      assert.ok(response.status<400,`HTTP ${path} ${response.status} ${value.code}`);assert.equal(response.headers.get('cache-control'),'no-store');return value;
    }
    async function reviewedBinding(authorSuffix:string){
    child.send({type:'author',suffix:authorSuffix});const authored=await wait('authored');
    const {app:staged}=await call('/stage','POST',authored.package_json);
    const context=await call(`/${staged.id}/context?app_version_id=${staged.version_id}`);
    const {review}=await call(`/${staged.id}/review`,'POST',context.review_request);
    await call(`/${staged.id}/activate`,'POST',{...context.review_request,expected_review_digest:review.review_digest,accept_host_policy:true});
    const {setup}=await call(`/sync/setup?installation_id=${staged.id}&operator_user_id=${operator}`);
    const consent={...setup.descriptors[0].consent_request,attachment_policy:{...setup.descriptors[0].consent_request.attachment_policy,max_attachments_per_run:1}};
    const {review:syncReview}=await call('/sync/reviews/prepare','POST',consent);
    const {binding}=await call('/sync/bindings/activate','POST',{...consent,expected_review_digest:syncReview.review_digest,accept_host_policy:true});
    const {session}=await call(`/sync/bindings/${binding.binding_id}/sessions`,'POST',{},operatorSession.accessToken);
    return {binding,session};
    }
    const {binding,session}=await reviewedBinding(suffix);
    const admitted=await call(`/sync/bindings/${binding.binding_id}/sync`,'POST',{});assert.equal(admitted.state,'created');
    child.send({type:'run',channel_url:base+'/api/app-resource-sync-channel/v3',credential:{session_id:session.session_id,session_token:session.session_token}});
    const settled=await wait('settled');assert.equal(settled.run_id,admitted.run_id);assert.deepEqual(settled.stage_statuses,[200,200,409]);
    const [run]=await db.select().from(s.appRuns).where(orm.and(orm.eq(s.appRuns.org_id,org),orm.eq(s.appRuns.id,settled.run_id)));assert.equal(run?.state,'succeeded');
    const [projection]=await db.select().from(s.appResourceProjections).where(orm.and(orm.eq(s.appResourceProjections.org_id,org),orm.eq(s.appResourceProjections.resource_binding_id,binding.binding_id)));assert.ok(projection);
    const parent=`/bindings/${binding.binding_id}/records/${projection.id}/attachments`;
    const catalog=await call(parent,'GET',undefined,ownerSession.accessToken,'/api/private-resources');assert.equal(catalog.attachments.length,1);assert.equal(catalog.attachments[0].filename,'<literal>☃.csv');
    const response=await fetch(base+'/api/private-resources'+parent+`/${settled.staging_id}/content`,{headers:{authorization:`Bearer ${ownerSession.accessToken}`}});
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(settled.bytes_b64,'base64'));
    const foreign=await fetch(base+'/api/private-resources'+parent+`/${settled.staging_id}/content`,{headers:{authorization:`Bearer ${operatorSession.accessToken}`}});assert.equal(foreign.status,409);
    const receipts=await (await runtime.getAppRunRuntime()).receiptReader.readVerified(org,settled.run_id);assert.ok(receipts.some(r=>r.verified&&r.receipt_kind==='attempt_terminal'));
    const [checkpoint]=await db.select().from(s.appSyncCheckpoints).where(orm.eq(s.appSyncCheckpoints.id,projection.checkpoint_id));assert.equal(checkpoint?.cursor_sequence,1);
    const attachments=await import('../src/lib/app-attachment-runtime.js');const composed=await attachments.getAppAttachmentRuntime();
    assert.strictEqual(composed,await attachments.getAppAttachmentRuntime(),'One process-wide limiter/runtime across route calls');
    const inventory=await import('../src/lib/app-attachment-key-references.js');
    const rings=await import('../src/lib/app-run-keyrings.js');
    const cleanupModule=await import('../src/lib/app-attachment-cleanup.js');
    await t.test('retained binary and encrypted metadata keys cannot retire before confirmed purge',async()=>{
      const refs=await composed.database.transaction(tx=>inventory.listAppAttachmentKeyReferences(tx,org),new AbortController().signal,performance.now()+10_000);
      assert.deepEqual(refs,[{purpose:'fingerprint',key_id:'attachment-fp'},{purpose:'run_encryption',key_id:'attachment-enc'}]);
      rings.assertAppRunReferencedKeysAvailable(composed.keys,refs);
      assert.throws(()=>rings.assertAppRunReferencedKeysAvailable({current:p=>composed.keys.current(p),keyIds:p=>composed.keys.keyIds(p),read:()=>null},refs),rings.AppRunKeyVersionUnavailableError);
    });
    // A fixed host-stage ceiling can retire bytes while this same claim is
    // legitimately heartbeating. Purged history must still consume Run quota.
    await t.test('purged reservation still consumes lifetime Run quota after a legitimate heartbeat',async()=>{
    const {binding:quotaBinding,session:quotaSession}=await reviewedBinding(`${suffix}q`);
    const quotaRun=await call(`/sync/bindings/${quotaBinding.binding_id}/sync`,'POST',{});assert.equal(quotaRun.state,'created');
    child.send({type:'quota',channel_url:base+'/api/app-resource-sync-channel/v3',credential:{session_id:quotaSession.session_id,session_token:quotaSession.session_token}});
    const quota=await wait('quota_ready');assert.equal(quota.run_id,quotaRun.run_id);
    const [reserved]=await db.select().from(s.appAttachmentStages).where(orm.eq(s.appAttachmentStages.id,quota.staging_id));
    const [renewed]=await db.select().from(s.appRunAttempts).where(orm.and(orm.eq(s.appRunAttempts.org_id,org),orm.eq(s.appRunAttempts.run_id,quota.run_id)));
    assert.ok(reserved&&renewed?.lease_expires_at&&reserved.stage_expires_at>renewed.lease_expires_at,'Fixed stage ceiling outlives the short renewable claim lease');
    const earlyCleanup=new cleanupModule.AppAttachmentCleanup(()=>true,()=>new Date(Date.now()+2*3600_000),composed.objects,target!);
    try{assert.ok((await earlyCleanup.run()).purged>=1);
      const [purgedStage]=await db.select().from(s.appAttachmentStages).where(orm.eq(s.appAttachmentStages.id,quota.staging_id));assert.equal(purgedStage?.state,'purged');
    }finally{await earlyCleanup.stop();}
    child.send({type:'quota_continue'});assert.equal((await wait('quota_settled')).denied,true);
    assert.equal((await db.select().from(s.appAttachmentStages).where(orm.eq(s.appAttachmentStages.run_id,quota.run_id))).length,1,'No replacement reservation after purge');
    });
    await t.test('gate withdrawal during real held ciphertext publication leaves no ready or linked authority',async()=>{
      const {binding:withdrawBinding,session:withdrawSession}=await reviewedBinding(`${suffix}w`);
      const withdrawRun=await call(`/sync/bindings/${withdrawBinding.binding_id}/sync`,'POST',{});assert.equal(withdrawRun.state,'created');
      const put=composed.objects.putExclusive.bind(composed.objects);let release!:()=>void,entered!:()=>void;
      const held=new Promise<void>(ready=>{release=ready;});const written=new Promise<void>(ready=>{entered=ready;});
      composed.objects.putExclusive=async(...args)=>{await put(...args);entered();await held;};
      try{
        child.send({type:'withdraw',channel_url:base+'/api/app-resource-sync-channel/v3',credential:{session_id:withdrawSession.session_id,session_token:withdrawSession.session_token}});
        await written;
        const [unready]=await db.select().from(s.appAttachmentStages).where(orm.eq(s.appAttachmentStages.run_id,withdrawRun.run_id));
        const [attempt]=await db.select().from(s.appRunAttempts).where(orm.eq(s.appRunAttempts.run_id,withdrawRun.run_id));
        assert.ok(unready&&attempt?.claim_token);assert.equal(unready.state,'uploading');
        // Even complete quarantined bytes cannot become parent/download
        // authority before ready publication; partial writes have less state.
        const premature=await fetch(base+'/api/app-resource-sync-channel/v3/result',{method:'POST',headers:{
          authorization:`AppRuntime ${withdrawSession.session_token}`,'content-type':'application/json'},body:JSON.stringify({
          schema_version:'deft.app_runtime_channel.v3',audience:'app_resource_sync',session_id:withdrawSession.session_id,
          run_id:withdrawRun.run_id,attempt_id:attempt.id,claim_token:attempt.claim_token,sequence:attempt.runtime_sequence,
          status:'returned',provider_succeeded:true,page:{schema_version:'deft.app_sync_page.v2',upserts:[{id:'synthetic-message-1',
            revision:'1',data:{subject:'Unready parent'},attachments:[{attachment_key:'part-1',staging_id:unready.id}]}],
            tombstones:[],next_cursor:'premature',has_more:false}})});
        assert.equal(premature.status,409,'Uploading ciphertext cannot acquire linked parent authority');
        assert.equal((await db.select().from(s.appResourceProjections).where(orm.eq(s.appResourceProjections.resource_binding_id,withdrawBinding.binding_id))).length,0);
        process.env.DEFT_APP_ATTACHMENT_BROKER_ENABLED='false';release();
        const denied=await wait('stage_denied');assert.equal(denied.run_id,withdrawRun.run_id);assert.equal(denied.http_status,409);
        const rows=await db.select().from(s.appAttachmentStages).where(orm.eq(s.appAttachmentStages.run_id,withdrawRun.run_id));assert.equal(rows.length,1);assert.equal(rows[0]?.state,'uploading');
        assert.equal(rows[0]?.object_id,null);assert.equal(rows[0]?.binary_key_version,null);
        assert.equal((await db.select().from(s.appResourceProjections).where(orm.eq(s.appResourceProjections.resource_binding_id,withdrawBinding.binding_id))).length,0);
      }finally{process.env.DEFT_APP_ATTACHMENT_BROKER_ENABLED='true';release?.();composed.objects.putExclusive=put;}
    });
    await t.test('purge before delayed ciphertext publication cannot leave an object after reservation retirement',async()=>{
      const {binding:purgeBinding,session:purgeSession}=await reviewedBinding(`${suffix}late`);
      const admitted=await call(`/sync/bindings/${purgeBinding.binding_id}/sync`,'POST',{});assert.equal(admitted.state,'created');
      const put=composed.objects.putExclusive.bind(composed.objects);let release!:()=>void,entered!:(id:string)=>void;
      const held=new Promise<void>(ready=>{release=ready;});const entering=new Promise<string>(ready=>{entered=ready;});
      let putSignal:AbortSignal|undefined;
      composed.objects.putExclusive=async(id,bytes,signal)=>{putSignal=signal;entered(id);await held;await put(id,bytes,signal);};
      let cleanup:InstanceType<typeof cleanupModule.AppAttachmentCleanup>|undefined;
      try{
        child.send({type:'withdraw',channel_url:base+'/api/app-resource-sync-channel/v3',credential:{session_id:purgeSession.session_id,session_token:purgeSession.session_token}});
        const stageId=await entering;
        await assert.rejects(composed.objects.get(stageId,new AbortController().signal),'Publication has not created an object');
        const [reserved]=await db.select().from(s.appAttachmentStages).where(orm.eq(s.appAttachmentStages.id,stageId));
        assert.ok(reserved);assert.equal(reserved.state,'uploading');
        // An explicitly advanced local cleanup clock exercises expiry while
        // the real store publication remains held inside its live I/O budget.
        cleanup=new cleanupModule.AppAttachmentCleanup(()=>true,()=>new Date(reserved.stage_expires_at.getTime()+1),composed.objects,target!);
        let purged=false;
        for(let pass=0;pass<10&&!purged;pass++){
          await cleanup.run();
          const [row]=await db.select().from(s.appAttachmentStages).where(orm.eq(s.appAttachmentStages.id,stageId));purged=row?.state==='purged';
        }
        assert.ok(purged,'Bounded keyset cleanup reached the reserved uploading stage');
        const [before]=await db.select().from(s.appAttachmentStages).where(orm.eq(s.appAttachmentStages.id,stageId));
        assert.equal(before?.metadata_envelope,null);
        const [capacity]=await db.select().from(s.appSyncCheckpoints).where(orm.eq(s.appSyncCheckpoints.resource_binding_id,purgeBinding.binding_id));
        assert.equal(capacity?.retained_bytes,0,'Purge had confirmed absence and released declared byte capacity');
        assert.equal(putSignal?.aborted,false,'Publication resumes with a live signal, not transfer cancellation');release();
        const denied=await wait('stage_denied');assert.equal(denied.run_id,admitted.run_id);assert.equal(denied.http_status,409);
        assert.equal((await composed.objects.get(stageId,new AbortController().signal)).length,0,'Rejected delayed publication retains only the permanent zero-byte namespace fence');
        await assert.rejects(put(stageId,Buffer.from('late replacement'),new AbortController().signal),'Fresh publication cannot reclaim a purged identity');
        assert.equal((await db.select().from(s.appResourceProjections).where(orm.eq(s.appResourceProjections.resource_binding_id,purgeBinding.binding_id))).length,0);
      }finally{release?.();composed.objects.putExclusive=put;await cleanup?.stop();}
    });
    await t.test('operator human flag withdrawal during final real SID lock wait prevents content delivery',async()=>{
      const {default:pg}=await import('pg');const blocker=new pg.Client({connectionString:target});const observer=new pg.Client({connectionString:target});
      await blocker.connect();await observer.connect();
      const [sid]=await db.select({id:s.webSessions.id}).from(s.webSessions).where(orm.and(orm.eq(s.webSessions.org_id,org),orm.eq(s.webSessions.user_id,owner)));
      assert.ok(sid);const {rows:[pid]}=await blocker.query('SELECT pg_backend_pid() AS id');
      const get=composed.objects.get.bind(composed.objects);let entered!:()=>void,release!:()=>void;
      const read=new Promise<void>(ready=>{entered=ready;});const held=new Promise<void>(ready=>{release=ready;});
      composed.objects.get=async(...args)=>{const bytes=await get(...args);entered();await held;return bytes;};
      let pending:Promise<Response>|undefined;
      try{
        pending=fetch(base+'/api/private-resources'+parent+`/${settled.staging_id}/content`,{headers:{authorization:`Bearer ${ownerSession.accessToken}`}});
        await read;await blocker.query('BEGIN');await blocker.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE',[sid.id]);release();
        let waited=false;for(let n=0;n<40;n++){
          const {rows:[state]}=await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid.id]);
          if(state.n>0){waited=true;break;}await new Promise(ready=>setTimeout(ready,5));
        }
        assert.ok(waited,'Observed actual post-I/O SID SHARE wait');
        await db.update(s.users).set({is_agent:true}).where(orm.eq(s.users.id,operator));await blocker.query('ROLLBACK');
        const denied=await pending;assert.equal(denied.status,409);assert.equal((await denied.json() as any).code,'APP_STALE');assert.equal(denied.headers.get('cache-control'),'no-store');
      }finally{release?.();await blocker.query('ROLLBACK');await pending?.catch(()=>{});composed.objects.get=get;
        await db.update(s.users).set({is_agent:false}).where(orm.eq(s.users.id,operator));await blocker.end();await observer.end();}
    });
    await t.test('wrong staged parent rolls back projection cursor output and receipt before explicit corrected settlement',async()=>{
      const {binding:linkBinding,session:linkSession}=await reviewedBinding(`${suffix}p`);
      const admitted=await call(`/sync/bindings/${linkBinding.binding_id}/sync`,'POST',{});assert.equal(admitted.state,'created');
      child.send({type:'invalid_link',channel_url:base+'/api/app-resource-sync-channel/v3',credential:{session_id:linkSession.session_id,session_token:linkSession.session_token}});
      const denied=await wait('link_denied');assert.equal(denied.run_id,admitted.run_id);
      assert.equal((await db.select().from(s.appResourceProjections).where(orm.eq(s.appResourceProjections.resource_binding_id,linkBinding.binding_id))).length,0);
      const [cp]=await db.select().from(s.appSyncCheckpoints).where(orm.eq(s.appSyncCheckpoints.resource_binding_id,linkBinding.binding_id));assert.equal(cp?.cursor_sequence,0);
      const [run]=await db.select().from(s.appRuns).where(orm.eq(s.appRuns.id,denied.run_id));assert.equal(run?.state,'running');
      assert.equal((await db.select().from(s.appRunSecretPayloads).where(orm.and(orm.eq(s.appRunSecretPayloads.org_id,org),orm.eq(s.appRunSecretPayloads.run_id,denied.run_id),orm.eq(s.appRunSecretPayloads.payload_kind,'output')))).length,0);
      const [stage]=await db.select().from(s.appAttachmentStages).where(orm.eq(s.appAttachmentStages.id,denied.staging_id));assert.equal(stage?.state,'ready');assert.equal(stage?.projection_id,null);
      const receipts=await (await runtime.getAppRunRuntime()).receiptReader.readVerified(org,denied.run_id);assert.ok(!receipts.some(row=>row.receipt_kind==='attempt_terminal'));
      child.send({type:'link_correct'});assert.equal((await wait('link_settled')).run_id,admitted.run_id);
      const [linked]=await db.select().from(s.appAttachmentStages).where(orm.eq(s.appAttachmentStages.id,denied.staging_id));assert.equal(linked?.state,'linked');
    });
    const get=composed.objects.get.bind(composed.objects);let release!:()=>void,entered!:()=>void;
    const ready=new Promise<void>(r=>{entered=r;});const held=new Promise<void>(r=>{release=r;});
    composed.objects.get=async(...args)=>{const bytes=await get(...args);entered();await held;return bytes;};
    await t.test('consent withdrawal during actual held ciphertext read prevents plaintext delivery',async()=>{
    const pending=fetch(base+'/api/private-resources'+parent+`/${settled.staging_id}/content`,{headers:{authorization:`Bearer ${ownerSession.accessToken}`}});
    try{await ready;await call(`/sync/bindings/${binding.binding_id}/revoke`,'POST',{});release();
      const denied=await pending;assert.equal(denied.status,409);assert.equal(denied.headers.get('cache-control'),'no-store');
      const denial=await denied.json() as any;assert.equal(denial.code,'APP_STALE');assert.ok(!JSON.stringify(denial).includes('subject,value'));
    }finally{release?.();composed.objects.get=get;}
    });
    await t.test('failed physical deletion retains encrypted metadata and capacity until confirmed purge',async()=>{
    const cleanup=new cleanupModule.AppAttachmentCleanup(()=>true,()=>new Date(Date.now()+2*86400_000),composed.objects,target!);
    const remove=composed.objects.delete.bind(composed.objects);
    const fs=await import('node:fs/promises');
    let openedWriter:Awaited<ReturnType<typeof fs.open>>|undefined;
    try{
      if(process.platform==='win32')openedWriter=await fs.open(resolve('uploads','app-attachments',settled.staging_id),'r+');
      else composed.objects.delete=async id=>{if(id===settled.staging_id)throw new Error('Controlled unavailable storage');await remove(id);};
      assert.ok((await cleanup.run()).failed>=1);
      const [retired]=await db.select().from(s.appAttachmentStages).where(orm.eq(s.appAttachmentStages.id,settled.staging_id));
      assert.equal(retired?.state,'retired');assert.ok(retired?.metadata_envelope);assert.equal(retired?.object_id,settled.staging_id);
      const [charged]=await db.select().from(s.appSyncCheckpoints).where(orm.eq(s.appSyncCheckpoints.id,projection.checkpoint_id));
      assert.equal(charged?.retained_bytes,projection.provider_id_bytes+projection.body_bytes+Buffer.from(settled.bytes_b64,'base64').length);
      const chargedRefs=await composed.database.transaction(tx=>inventory.listAppAttachmentKeyReferences(tx,org),new AbortController().signal,performance.now()+10_000);
      assert.ok(chargedRefs.some(ref=>ref.purpose==='run_encryption'),'Failed physical replacement retains required ciphertext keys');
      await openedWriter?.close();openedWriter=undefined;
      composed.objects.delete=remove;
      const purged=await cleanup.run();assert.ok(purged.purged>=1);
      const [stageRow]=await db.select().from(s.appAttachmentStages).where(orm.eq(s.appAttachmentStages.id,settled.staging_id));
      assert.equal(stageRow?.state,'purged');assert.equal(stageRow?.metadata_envelope,null);assert.equal(stageRow?.object_id,null);
      const [retained]=await db.select().from(s.appSyncCheckpoints).where(orm.eq(s.appSyncCheckpoints.id,projection.checkpoint_id));
      assert.equal(retained?.retained_bytes,projection.provider_id_bytes+projection.body_bytes,'Binary counter released exactly after confirmed purge');
      assert.ok((await db.select().from(s.appAttachmentStages).where(orm.eq(s.appAttachmentStages.run_id,settled.run_id))).length>=1,'Purged lifetime reservation identity retained');
      const refs=await composed.database.transaction(tx=>inventory.listAppAttachmentKeyReferences(tx,org),new AbortController().signal,performance.now()+10_000);assert.deepEqual(refs,[]);
    }finally{await openedWriter?.close();composed.objects.delete=remove;await cleanup.stop();}
    });
  }finally{
    child.kill();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    await runtime.shutdownAppRunRuntime();await closeDb();
  }
 });
