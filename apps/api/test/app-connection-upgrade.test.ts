import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AppConnectionUpgradeService,connectionUpgradeReceiptDigest,connectionUpgradeClosureDigest,type AppConnectionUpgradePorts} from '../src/lib/app-connection-upgrade-service.js';
import type {AppConnectionSessionRecord} from '../src/lib/app-connection-session-service.js';
const digest=(c:string)=>'sha256:'+c.repeat(64);
function fixture(){
 let now=Date.parse('2026-10-10T01:00:00Z');
 const caller={org_id:randomUUID(),user_id:randomUUID(),sid:randomUUID(),access_expires_at:now+900000};
 const operator=randomUUID(),scope={org_id:caller.org_id,owner_user_id:caller.user_id,installation_id:randomUUID(),app_version_id:randomUUID(),
  grant_snapshot_id:randomUUID(),package_digest:digest('a'),grant_snapshot_digest:digest('b'),lifecycle_epoch:1,grant_epoch:1,target_key:'primary',
  resource_key:'inbox',resource_binding_id:randomUUID(),runtime_registration_id:randomUUID(),operator_user_id:operator,runtime_epoch:1,
  profile_digest:digest('c'),consent_expires_at:new Date(now+3600000).toISOString()};
 const profile={schema_version:'deft.app_connection_profile.v1' as const,key:'fixture',provider_id:'fixture',operator_user_id:operator,
  runtime_requirement_key:'fixture',resource_key:'inbox',action_keys:['organize_messages','send_message'],authorization_origin:'https://provider.example',credential_custody:'runtime' as const,executable:false as const};
 const source:AppConnectionSessionRecord={session_id:randomUUID(),revision:2,scope,profile,state:'connected',callback_state_hash:'a'.repeat(64),
  callback_consumed:true,callback_expires_at:new Date(now-1).toISOString(),runtime_session_ref:'source_ref',account:{account_ref:randomUUID(),label:'fixture@example.test'},
  created_at:new Date(now-10000).toISOString(),updated_at:new Date(now-1000).toISOString()};
 const actions=profile.action_keys.map((key,index)=>{const id=randomUUID();return {action_binding_id:id,action_key:key,authority_epoch:index+1,
  consent_id:id,consent_digest:digest('d'),expires_at:new Date(now+3600000).toISOString()};});
 const current={scope,profile,action_consents:actions,expires_at:now+900000};
 const records=new Map<string,AppConnectionSessionRecord>([[source.session_id,structuredClone(source)]]),calls:string[]=[];
 let mode='normal',blocked=false,completed:unknown;
 const ports:AppConnectionUpgradePorts={currentAuthority:async()=>current,transportDigest:async()=>digest('f'),
  assertNoActiveEffects:async()=>{if(blocked)throw Error('effect fence');},
  store:{create:async row=>{if(records.has(row.session_id))return false;records.set(row.session_id,structuredClone(row));return true;},
   read:async locator=>{const row=records.get(locator.session_id);return row&&row.scope.org_id===locator.org_id&&row.scope.owner_user_id===locator.owner_user_id?structuredClone(row):null;},
   compareAndSet:async(locator,revision,row)=>{if(records.get(locator.session_id)?.revision!==revision)return false;records.set(row.session_id,structuredClone(row));return true;}},
  requestRuntime:async(record,input)=>{calls.push(input.operation);
   const eligible={schema_version:input.schema_version,session_id:record.session_id,state:'eligible',account:source.account,custody_generation:2,custody_digest:digest('a')};
   if(input.operation==='prepare'){completed=eligible;if(mode==='lost-prepare')throw Error('lost');return eligible;}
   if(input.operation==='status')return completed??{schema_version:input.schema_version,session_id:record.session_id,state:'indeterminate'};
   if(input.operation==='begin'){if(mode==='lost-begin'){completed={schema_version:input.schema_version,session_id:record.session_id,state:'indeterminate'};throw Error('lost');}
    return {schema_version:input.schema_version,session_id:record.session_id,state:'awaiting_callback',runtime_session_ref:'upgrade_ref',authorization_url:'https://provider.example/authorize'};}
   assert.equal(record.callback_consumed,true);assert.equal(record.upgrade!.begin_consumed,true);
   const reply={schema_version:input.schema_version,session_id:record.session_id,state:'connected' as const,account:source.account!,runtime_session_ref:'upgrade_ref',custody_generation:3,receipt_digest:''};
   reply.receipt_digest=connectionUpgradeReceiptDigest(record,reply);completed=structuredClone(reply);
   if(mode==='lost-callback')throw Error('lost');if(mode==='foreign')reply.account={account_ref:randomUUID(),label:'foreign@example.test'};return reply;
  }};
 const service=new AppConnectionUpgradeService(ports,()=>now),input={installation_id:scope.installation_id,target_key:'primary',source_session_id:source.session_id,request_id:randomUUID()};
 return {caller,current,source,records,calls,ports,service,input,mode:(v:string)=>{mode=v;},block:()=>{blocked=true;},
  advance:(ms:number)=>{now+=ms;caller.access_expires_at=now+900000;current.expires_at=caller.access_expires_at;},now:()=>now};
}
test('stable upgrade independently seals two actions, retains history and consumes callback exactly once',async()=>{
 const f=fixture(),old=structuredClone(f.source),review=await f.service.review(f.caller,f.input);assert.ok('review_digest' in review);
 const begun=await f.service.begin(f.caller,{session_id:review.session_id,review_digest:review.review_digest});assert.ok('callback_state' in begun);
 await assert.rejects(f.service.begin(f.caller,{session_id:review.session_id,review_digest:review.review_digest}));
 const connected=await f.service.callback(f.caller,{session_id:review.session_id,state:begun.callback_state,outcome:'authorized',code:'synthetic'});
 assert.equal('state' in connected&&connected.state,'connected');assert.equal(connected.account!.account_ref,f.source.account!.account_ref);
 assert.deepEqual(f.records.get(f.source.session_id),old);assert.equal(f.records.get(review.session_id)!.upgrade!.receipt!.custody_generation,3);
 await assert.rejects(f.service.callback(f.caller,{session_id:review.session_id,state:begun.callback_state,outcome:'authorized',code:'synthetic'}));
 assert.deepEqual(f.calls,['prepare','begin','callback']);
 const published=f.records.get(review.session_id)!;
 f.records.set(review.session_id,{...published,state:'indeterminate'});
 const managed=await f.service.status(f.caller,{session_id:review.session_id});
 assert.equal('state'in managed&&managed.state,'indeterminate');assert.deepEqual(f.calls,['prepare','begin','callback']);
});
test('lost consumed callback resolves journal after review expiry and action revocation under fresh read authority, no exchange replay',async()=>{
 const f=fixture(),review=await f.service.review(f.caller,f.input);assert.ok('review_digest'in review);
 const begun=await f.service.begin(f.caller,{session_id:review.session_id,review_digest:review.review_digest});assert.ok('callback_state'in begun);
 f.mode('lost-callback');await f.service.callback(f.caller,{session_id:review.session_id,state:begun.callback_state,outcome:'authorized',code:'synthetic'});
 f.advance(301000);f.current.action_consents=[];
 const result=await new AppConnectionUpgradeService(f.ports,f.now).status(f.caller,{session_id:review.session_id});
 assert.equal('state'in result&&result.state,'connected');assert.deepEqual(f.calls,['prepare','begin','callback','status']);
});
test('lost Begin remains fenced; an eligible reply can never restore activation',async()=>{
 const f=fixture(),review=await f.service.review(f.caller,f.input);assert.ok('review_digest'in review);f.mode('lost-begin');
 const result=await f.service.begin(f.caller,{session_id:review.session_id,review_digest:review.review_digest});assert.equal('state'in result&&result.state,'indeterminate');
 await f.service.status(f.caller,{session_id:review.session_id});await assert.rejects(f.service.begin(f.caller,{session_id:review.session_id,review_digest:review.review_digest}));
 assert.equal(f.calls.filter(op=>op==='begin').length,1);assert.equal(f.records.get(review.session_id)!.upgrade!.begin_consumed,true);
});
test('expired unconsumed review resolves to not_connected, never consumes Begin',async()=>{
 const f=fixture();f.mode('lost-prepare');const result=await f.service.review(f.caller,f.input);f.advance(301000);
 const status=await f.service.status(f.caller,{session_id:result.session_id});assert.equal('state'in status&&status.state,'not_connected');
 assert.equal(f.records.get(result.session_id)!.upgrade!.begin_consumed,false);assert.deepEqual(f.calls,['prepare','status']);
});
test('pending effects and foreign principal deny before new account publication',async()=>{
 const f=fixture();f.block();await assert.rejects(f.service.review(f.caller,f.input));assert.deepEqual(f.calls,[]);assert.equal(f.records.size,1);
 const other=fixture(),review=await other.service.review(other.caller,other.input);assert.ok('review_digest'in review);
 const begun=await other.service.begin(other.caller,{session_id:review.session_id,review_digest:review.review_digest});assert.ok('callback_state'in begun);
 other.mode('foreign');await assert.rejects(other.service.callback(other.caller,{session_id:review.session_id,state:begun.callback_state,outcome:'authorized',code:'synthetic'}));
 assert.equal(other.records.get(review.session_id)!.account,null);
});
test('independent grant revocation denies new OAuth IO and current Read expiry denies recovery',async()=>{
 const f=fixture(),review=await f.service.review(f.caller,f.input);assert.ok('review_digest'in review);
 f.current.action_consents=f.current.action_consents.filter(action=>action.action_key!=='organize_messages');
 await assert.rejects(f.service.begin(f.caller,{session_id:review.session_id,review_digest:review.review_digest}));
 assert.deepEqual(f.calls,['prepare']);assert.equal(f.records.get(review.session_id)!.upgrade!.begin_consumed,false);
 const g=fixture(),prepared=await g.service.review(g.caller,g.input);assert.ok('review_digest'in prepared);
 g.caller.access_expires_at=g.now()-1;
 await assert.rejects(g.service.status(g.caller,{session_id:prepared.session_id}));assert.deepEqual(g.calls,['prepare']);
});

test('verified expired status survives a lost ACK, preserves source and consumes no callback',async()=>{
 const f=fixture(),review=await f.service.review(f.caller,f.input);assert.ok('review_digest'in review);
 const begun=await f.service.begin(f.caller,{session_id:review.session_id,review_digest:review.review_digest});assert.ok('callback_state'in begun);f.advance(301000);
 const original=structuredClone(f.source);let calls=0;
 const service=new AppConnectionUpgradeService({...f.ports,requestRuntime:async(record,input)=>{
  assert.equal(input.operation,'status');assert.ok('close_expired'in input&&input.close_expired);calls++;
  if(calls===1)throw Error('lost closure ACK');
  return {schema_version:input.schema_version,session_id:record.session_id,state:'expired',closure:{reason:'callback_expired',custody_generation:3,receipt_digest:connectionUpgradeClosureDigest(record)}};
 }},f.now);
 assert.equal((await service.status(f.caller,{session_id:review.session_id})).schema_version,'deft.app_connection_session.v1');
 const closed=await service.status(f.caller,{session_id:review.session_id});assert.equal(closed.schema_version,'deft.app_connection_upgrade_closed.v1');
 assert.deepEqual(await new AppConnectionUpgradeService(f.ports,f.now).status(f.caller,{session_id:review.session_id}),closed);assert.equal(calls,2);
 assert.equal(f.records.get(review.session_id)!.callback_consumed,false);assert.deepEqual(f.records.get(f.source.session_id),original);
 await assert.rejects(service.begin(f.caller,{session_id:review.session_id,review_digest:review.review_digest}));
 await assert.rejects(service.callback(f.caller,{session_id:review.session_id,state:begun.callback_state,outcome:'authorized',code:'never-exchanged'}));
});

test('expired closure rejects consumed callback, wrong proof, plain not_connected and active effects',async()=>{
 for(const kind of ['callback','digest','generation','plain','effect','authority'] as const){
  const f=fixture(),review=await f.service.review(f.caller,f.input);assert.ok('review_digest'in review);
  await f.service.begin(f.caller,{session_id:review.session_id,review_digest:review.review_digest});f.advance(301000);
  const prior=f.records.get(review.session_id)!;if(kind==='callback')f.records.set(prior.session_id,{...prior,callback_consumed:true,state:'indeterminate'});
  if(kind==='effect')f.block();if(kind==='authority')f.caller.access_expires_at=f.now()-1;let io=0;
  const service=new AppConnectionUpgradeService({...f.ports,requestRuntime:async(record,input)=>{io++;
   if(kind==='callback')assert.equal('close_expired'in input,false);
   return kind==='plain'?{schema_version:input.schema_version,session_id:record.session_id,state:'not_connected'}:
    {schema_version:input.schema_version,session_id:record.session_id,state:'expired',closure:{reason:'callback_expired',custody_generation:kind==='generation'?4:3,receipt_digest:kind==='digest'?digest('b'):connectionUpgradeClosureDigest(record)}};
  }},f.now);
  await service.status(f.caller,{session_id:review.session_id}).catch(()=>{});
  assert.notEqual(f.records.get(prior.session_id)!.state,'not_connected');assert.equal(f.records.get(prior.session_id)!.upgrade!.closure,undefined);
  if(kind==='effect'||kind==='authority')assert.equal(io,0);
 }
});
