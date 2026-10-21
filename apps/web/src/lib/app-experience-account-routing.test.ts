import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceAccountRouting,type AccountChild} from './app-experience-account-routing';
import {createExperienceBridge,type ExperiencePort} from './app-experience-bridge';
import {createExperienceDataClient,appDataInputDigest} from './app-experience-data-client';
import {createDeftExperienceSdk} from '../../../../packages/app-kit/src/experience-core';
import {AppDataRequestSchema} from '../../../../packages/app-kit/src/app-data';

const signal=()=>new AbortController().signal;
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};};
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(){
 let current=true,keys=['sender','recipient','third'],validate=async(_child:AccountChild<{generation:number}>)=>true,generation=0;
 const calls:string[]=[],retired:AccountChild<{generation:number}>[]=[];
 const routing=createExperienceAccountRouting({current:()=>current,catalog:async()=>{calls.push('catalog');return keys.map(key=>({key,label:key}));},
  open:async key=>{calls.push('open:'+key);return {targetKey:key,accountRef:'account:'+key,label:key,value:{generation:++generation}};},
  validate:async child=>{calls.push('validate:'+child.targetKey);return validate(child);},retire:child=>{retired.push(child);}});
 return {routing,calls,retired,setCurrent:(value:boolean)=>{current=value;},setKeys:(value:string[])=>{keys=value;},setValidate:(value:typeof validate)=>{validate=value;}};
}

test('cold and warm targeted lists validate exactly at dispatch and disclosure for each account',async()=>{
 const f=fixture();let active=0,peak=0;
 for(let round=0;round<2;round++){
  f.calls.length=0;
  const results=await Promise.all(['sender','recipient'].map(key=>f.routing.listTarget(key,signal(),async owner=>{
   assert.equal(owner.accountRef,'account:'+key);active++;peak=Math.max(peak,active);await turn();active--;return key;
  })));
  assert.deepEqual(results.map(item=>item.result),['sender','recipient']);
  for(const key of ['sender','recipient'])assert.equal(f.calls.filter(call=>call==='validate:'+key).length,2);
  assert.equal(f.calls.filter(call=>call.startsWith('open:')).length,round===0?2:0);
 }
 assert.equal(peak,2);
});

test('revocation before dispatch prevents work; revocation at disclosure discards data and references',async()=>{
 for(const denyAt of [1,2]){
  const f=fixture();let checks=0,work=0,retains=0;
  f.setValidate(async()=>++checks!==denyAt);
  await assert.rejects(async()=>{const reply=await f.routing.listTarget('sender',signal(),async()=>{work++;return 'private';});retains++;f.routing.retain(reply.owner,[{resource_key:'inbox',record_id:'one',content_digest:'digest'}]);});
  assert.equal(work,denyAt===1?0:1);assert.equal(retains,0);assert.equal(f.retired.length,1);
  assert.throws(()=>f.routing.reference('inbox','one'));
 }
});

test('forgotten child replaced with same target and account cannot disclose an old result',async()=>{
 const f=fixture(),started=deferred<void>(),release=deferred<void>();let old:AccountChild<{generation:number}>|undefined;
 const pending=f.routing.listTarget('sender',signal(),async owner=>{old=owner;started.resolve();await release.promise;return 'old';});
 await started.promise;f.routing.forget('sender');const replacement=await f.routing.child('sender',signal());
 assert.equal(replacement.accountRef,old!.accountRef);assert.notEqual(replacement,old);release.resolve();
 await assert.rejects(pending,/Account visibility ended/);assert.equal((await f.routing.child('sender',signal())),replacement);
});

test('abort during awaited pre-dispatch validation cannot release work',async()=>{
 const f=fixture(),controller=new AbortController(),entered=deferred<void>(),release=deferred<boolean>();let calls=0;
 f.setValidate(async()=>{entered.resolve();return release.promise;});
 const pending=f.routing.listTarget('sender',controller.signal,async()=>{calls++;});
 await entered.promise;controller.abort();release.resolve(true);await assert.rejects(pending);assert.equal(calls,0);
});

test('queued lists recheck abort and fresh catalog after their slot opens',async()=>{
 for(const reason of ['abort','catalog'] as const){
  const f=fixture(),controller=new AbortController(),release=deferred<void>(),both=deferred<void>();let started=0,third=0;
  await Promise.all(['sender','recipient','third'].map(key=>f.routing.child(key,signal())));
  const holders=['sender','recipient'].map(key=>f.routing.listTarget(key,signal(),async()=>{if(++started===2)both.resolve();await release.promise;}));
  await both.promise;
  const queued=f.routing.listTarget('third',controller.signal,async()=>{third++;});const rejected=assert.rejects(queued);
  await turn();if(reason==='abort')controller.abort();else f.setKeys(['sender','recipient']);
  release.resolve();await Promise.all(holders);await rejected;assert.equal(third,0);
 }
});

test('scope, binding and abort changes during work or final validation prevent disclosure',async()=>{
 for(const reason of ['scope','binding','abort','final_abort'] as const){
  const f=fixture(),controller=new AbortController();let checks=0;
  f.setValidate(async()=>{if(++checks===2&&reason==='final_abort')controller.abort();return true;});
  await assert.rejects(f.routing.listTarget('sender',controller.signal,async owner=>{
   if(reason==='scope')f.setCurrent(false);
   if(reason==='binding')(owner as {accountRef:string}).accountRef='replacement-account';
   if(reason==='abort')controller.abort();return 'protected';
  }));
 }
});

test('unknown or forged target nomination cannot open or dispatch a child',async()=>{
 const f=fixture();let calls=0;
 for(const key of ['foreign',{targetKey:'sender',accountRef:'account:sender'}])await assert.rejects(f.routing.listTarget(key as string,signal(),async()=>{calls++;}));
 assert.equal(calls,0);assert.equal(f.calls.some(call=>call.startsWith('open:')),false);
});

test('actual SDK, bridge, routing and data client dispatch two nominated mailbox reads with fresh exact account selections',async()=>{
 const installation='11111111-1111-4111-8111-111111111111',consent='22222222-2222-4222-8222-222222222222';
 const sessions={sender:'33333333-3333-4333-8333-333333333333',recipient:'44444444-4444-4444-8444-444444444444'};
 const counts={sender:{resolve:0,request:0},recipient:{resolve:0,request:0}},hash='sha256:'+'a'.repeat(64);
 const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
 const clients=Object.fromEntries(Object.entries(sessions).map(([key,sessionId])=>[key,createExperienceDataClient({installationId:installation,targetKey:key,accountRef:()=>key,current:()=>true,fetch:async(path,options)=>{
  const count=counts[key as keyof typeof counts];
  if(path.endsWith('/resolve')){count.resolve++;assert.equal(JSON.parse(String(options.body)).target_key,key);return json({schema_version:'deft.app_data_context.v1',installation_id:installation,targets:[{target_key:key,session_id:sessionId,resource_key:'inbox',account:{account_ref:key,label:key},identities:[],stores:[{declaration:{schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'inbox',runtime_requirement_key:'sync_provider',max_record_bytes:491520,max_files:32,max_file_bytes:26214400,max_total_file_bytes:26214400},consent:{consent_id:consent,consent_digest:hash,expires_at:new Date(Date.now()+60000).toISOString()}}]}]});}
  count.request++;assert.equal(path,`/api/app-data/connections/${sessionId}/requests`);const request=AppDataRequestSchema.parse(JSON.parse(String(options.body)));
  assert.deepEqual(request.input,{store_key:'drafts',resource_key:'inbox',cursor:null,limit:10,query:'in:inbox'});
  return json({schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed',items:[],next_cursor:null});
 }})]));
 const routing=createExperienceAccountRouting({current:()=>true,catalog:async()=>Object.keys(sessions).map(key=>({key,label:key})),open:async key=>{const value=clients[key];const target=await value.select('drafts',signal());return {targetKey:key,accountRef:target.account.account_ref,label:key,value};},validate:async(child,active)=>{const target=await child.value.select('drafts',active);return child.accountRef===target.account.account_ref;},retire:()=>{}});
 const deliver=(port:ExperiencePort,value:unknown)=>(port.onmessage as ((event:MessageEvent)=>void)|null)?.({data:value} as MessageEvent);
 const host:ExperiencePort={onmessage:null,postMessage:value=>deliver(worker,value),close:()=>{}};
 const worker:ExperiencePort={onmessage:null,postMessage:value=>deliver(host,value),close:()=>{}};
 const pin={org_id:'org_a',user_id:'user_a',app_installation_id:installation,app_version_id:'version_a',grant_snapshot_id:'grant_a',lifecycle_epoch:1,grant_epoch:1,session_id:'session_12345678',session_epoch:1};
 const bridge=createExperienceBridge({port:host,pin,resourceKeys:['inbox'],storeKeys:['drafts'],actionKeys:[],broker:{isLive:()=>true,appData:async(_pin,key,raw,active)=>{
  const {target_key,...intent}=raw as {target_key:string;operation:string;input:Record<string,unknown>};
  const request=AppDataRequestSchema.parse({schema_version:'deft.app_data_request.v1',request_id:crypto.randomUUID(),...intent});
  return (await routing.listTarget(target_key,active,owner=>owner.value.request(key,request.operation,request.input,active,request.request_id))).result;
 }},onView:()=>{}});
 const sdk=createDeftExperienceSdk(worker,pin.session_id);
 try{
  const replies=await Promise.all(Object.keys(sessions).map(key=>sdk.listDataResources('drafts','inbox',null,'in:inbox',key)));
  assert.equal(replies.length,2);assert.deepEqual(counts,{sender:{resolve:4,request:1},recipient:{resolve:4,request:1}});
  await assert.rejects(sdk.listDataResources('drafts','inbox',null,'in:inbox','foreign'));
  assert.equal(counts.sender.request+counts.recipient.request,2);
 }finally{sdk.close();bridge.revoke();routing.close();}
});

test('readonly source operation keeps exact child identity with only dispatch and disclosure validations',async()=>{
 const f=fixture(),active=signal(),owner=await f.routing.child('sender',active);f.calls.length=0;let work=0;
 assert.equal(await f.routing.read(owner,active,async()=>{work++;return 'current source';}),'current source');assert.equal(f.calls.filter(call=>call==='validate:sender').length,2);assert.equal(work,1);
 await assert.rejects(f.routing.read({...owner},active,async()=>{work++;return 'forged';}),/Source account changed/);assert.equal(work,1);
 f.routing.forget('sender');await f.routing.child('sender',active);await assert.rejects(f.routing.read(owner,active,async()=>{work++;return 'stale';}),/Source account changed/);assert.equal(work,1);
 f.routing.close();
});
test('readonly source revocation at either boundary discards data without retaining it',async()=>{
 for(const denyAt of [1,2]){const f=fixture(),active=signal(),owner=await f.routing.child('sender',active);let checks=0,work=0;f.setValidate(async()=>++checks!==denyAt);
 await assert.rejects(f.routing.read(owner,active,async()=>{work++;return 'protected';}),/Account visibility ended/);assert.equal(work,denyAt===1?0:1);f.routing.close();}
});


test('operation-local selected read reuses only dispatch selection and always validates disclosure afresh',async()=>{
 for(const denied of ['none','entry','final']as const){
  const selected={account:'sender'},seen:unknown[]=[],active=signal();let reads=0,retired=0,checks=0;
  const routing=createExperienceAccountRouting<object,typeof selected>({current:()=>true,catalog:async()=>[{key:'sender',label:'sender'}],open:async()=>({targetKey:'sender',accountRef:'account:sender',label:'sender',value:{}}),validate:async(_owner,_signal,selection)=>{seen.push(selection);return ++checks!==(denied==='entry'?2:denied==='final'?3:-1);},retire:()=>{retired++;}});
  const owner=await routing.child('sender',active);seen.length=0;
  const read=routing.readSelected(owner,active,selected,async()=>{reads++;return 'private';});
  if(denied==='none'){assert.equal(await read,'private');assert.deepEqual(seen,[selected,undefined]);assert.equal(reads,1);assert.equal(retired,0);}
  else{await assert.rejects(read,/Account visibility ended/);assert.equal(reads,denied==='entry'?0:1);assert.equal(retired,1);}
  routing.close();
 }
});
test('retained source identity cannot survive digest changes retirement or replacement with the same account',async()=>{
 const f=fixture(),active=signal(),owner=await f.routing.child('sender',active),ref={resource_key:'inbox',record_id:'one',content_digest:'digest'};
 f.routing.retain(owner,[ref]);assert.equal(f.routing.retainedOwner(ref),owner);assert.equal(f.routing.retainedOwner({...ref,content_digest:'changed'}),undefined);
 f.routing.forget('sender');assert.equal(f.routing.retainedOwner(ref),undefined);const next=await f.routing.child('sender',active);assert.notEqual(next,owner);assert.equal(f.routing.retainedOwner(ref),undefined);
 f.routing.retain(next,[ref]);f.setCurrent(false);assert.equal(f.routing.retainedOwner(ref),undefined);f.routing.close();assert.equal(f.routing.retainedOwner(ref),undefined);
});
