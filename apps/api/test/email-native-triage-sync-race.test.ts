import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {EmailNativeTriageService,emailNativeTriageSourceFingerprint} from '../src/lib/email-native-triage.js';
const logical=(n:number)=>'mail_'+n.toString(16).padStart(64,'0');
const scope={org_id:'synthetic-org',owner_user_id:'synthetic-owner',account_id:'synthetic-account'};
const actor={user_id:scope.owner_user_id,web_session_id:'synthetic-session',access_expires_at:6000};
const cap={scope,resource_binding_id:'synthetic-binding',authority_version:'synthetic-authority',expires_at:5000};
const barrier=()=>{let release!:()=>void;return {promise:new Promise<void>(resolve=>release=resolve),release:()=>release()};};
function fixture(provider='gmail',count=1){
 const entered=barrier(),release=barrier(),rows=new Map<string,any>(),versions=new Map<string,number>();let effects=0,pins=0,live=true;
 const acknowledgements:any[]=[],receipts=new Map<string,any>();let afterFirstEffect:(()=>void)|undefined;
 for(let n=1;n<=count;n++){const locator=provider==='gmail'?{kind:'gmail',message_id:'message-'+n,thread_id:'thread-'+n,label_ids:['INBOX','UNREAD']}:
  provider==='microsoft'?{kind:'microsoft',message_id:'message-'+n,conversation_id:'thread-'+n,folder_id:'inbox',id_type:'immutable'}:{kind:'imap_smtp',mailbox:'INBOX',uidvalidity:'7',uid:n};
  rows.set(logical(n),{account_id:scope.account_id,logical_message_id:logical(n),revision:'metadata-unread',received_at:null,folders:['inbox'],flags:{seen:false,flagged:false,answered:false},data:{subject:'synthetic'},
   provider_source:{schema_version:'deft.email_provider_source.v1',account_id:scope.account_id,provider,authority_epoch:1,logical_message_id:logical(n),conversation_id:'thread-'+n,locator}});versions.set(logical(n),1);
 }
 const authority:any={current:async()=>{if(!live)throw Error('EMAIL_ACCESS_DENIED');return structuredClone(cap);}};
 const store={readMessage:async(_s:any,id:string)=>structuredClone(rows.get(id)??null),
  readAcknowledgementVersions:async(_s:any,ids:readonly string[],guard:(tx:any)=>Promise<void>)=>{await guard({});pins++;return ids.filter(id=>rows.has(id)).map(id=>({logical_message_id:id,storage_revision:versions.get(id)!}));},
  acknowledgeFlags:async(_s:any,updates:readonly any[],guard:(tx:any)=>Promise<void>)=>{await guard({});let acknowledged=0;
   for(const update of updates){acknowledgements.push(update);const row=rows.get(update.logical_message_id);if(row&&update.expected_storage_revision===versions.get(update.logical_message_id)&&update.expected_revision===row.revision&&update.expected_source_digest===emailNativeTriageSourceFingerprint(row)){
    for(const [key,value] of Object.entries(update.flags))if(value!==null)row.flags[key]=value;versions.set(update.logical_message_id,versions.get(update.logical_message_id)!+1);acknowledged++;
   }}return {acknowledged,stale:updates.length-acknowledged};}};
 const providerPort:any={invoke:async(_s:any,input:any,_c:any,recheck:()=>Promise<void>,beforeReserve:()=>Promise<void>)=>{
  const id=input.mode==='undo'?input.undo_operation_id:input.operation_id,prior=receipts.get(id);if(input.mode==='status'||prior)return {...prior,items:prior.items.map(({confirmed_flags:_f,...item}:any)=>item)};
  entered.release();await release.promise;for(let n=1;n<=count;n++){await beforeReserve();effects++;if(n===1)afterFirstEffect?.();}
  await recheck();const result={schema_version:'deft.email_native_triage_result.v1',account_id:scope.account_id,operation_id:id,operation:'mark_read',automatic_retry:false,undo_available:false,
   items:Array.from({length:count},(_,n)=>({logical_message_id:logical(n+1),state:'succeeded',undo_supported:false,confirmed_flags:{seen:true,flagged:false,answered:null}}))};receipts.set(id,result);return result;
 }};
 const service=new EmailNativeTriageService(authority,store,providerPort,undefined,()=>1000);
 return {service,entered,release,rows,versions,acknowledgements,get effects(){return effects;},get pins(){return pins;},revoke(){live=false;},afterFirst(fn:()=>void){afterFirstEffect=fn;},
  change(fn:(row:any)=>void,n=1){const row=rows.get(logical(n));fn(row);versions.set(logical(n),versions.get(logical(n))!+1);},
  request:{operation_id:randomUUID(),kind:'mark_read' as const,logical_message_ids:Array.from({length:count},(_,n)=>logical(n+1))}};
}
async function held(f:ReturnType<typeof fixture>,change:()=>void,extra:any={},owner:any=actor,signal?:AbortSignal){
 const pending=f.service.apply(owner,scope,{...f.request,...extra},signal),settled=pending.then(value=>({value,error:null}),error=>({value:null,error}));
 await f.entered.promise;try{change();}finally{f.release.release();}return settled;
}
for(const provider of ['gmail','microsoft','imap_smtp'])test('human '+provider+' same immutable target survives held mutable sync and ACKs its fresh guarded snapshot',async()=>{
 const f=fixture(provider),result=await held(f,()=>f.change(row=>{row.revision='metadata-read';row.flags.seen=true;if(provider==='gmail')row.provider_source.locator.label_ids=['INBOX'];if(provider==='microsoft')row.provider_source.locator.folder_id='custom-folder';}));
 assert.equal(result.error,null);assert.equal(f.effects,1);assert.equal(f.pins,2);assert.equal(f.acknowledgements[0].expected_storage_revision,2);assert.equal(f.acknowledgements[0].expected_revision,'metadata-read');assert.equal(f.versions.get(logical(1)),3);
 await f.service.apply(actor,scope,f.request);await f.service.status(actor,scope,f.request.operation_id);assert.equal(f.effects,1);assert.equal(f.acknowledgements.length,1,'Replay/status retain no fresh provider state or ACK');
});
test('equal-value/ABA pre-reserve sync pins its actual latest version, while post-reserve churn skips a stale ACK',async()=>{
 const f=fixture(),outcome=await held(f,()=>{f.change(row=>{row.flags.seen=true;});f.change(row=>{row.flags.seen=false;});});assert.equal(outcome.error,null);assert.equal(f.acknowledgements[0].expected_storage_revision,3);assert.equal(f.versions.get(logical(1)),4);
 const late=fixture();late.afterFirst(()=>late.change(row=>{row.flags.seen=false;}));assert.equal((await held(late,()=>{})).error,null);assert.equal(late.acknowledgements[0].expected_storage_revision,1);assert.equal(late.rows.get(logical(1)).flags.seen,false);assert.equal(late.versions.get(logical(1)),2);
});
test('two-item reservations refresh ACK snapshots once; later reservation cannot re-pin an earlier effect through equal-value ABA',async()=>{
 const f=fixture('gmail',2);f.afterFirst(()=>{f.change(row=>{row.flags.seen=true;});f.change(row=>{row.flags.seen=false;});});assert.equal((await held(f,()=>{})).error,null);
 assert.equal(f.effects,2);assert.equal(f.pins,2);assert.deepEqual(f.acknowledgements.map(row=>row.expected_storage_revision),[1,1]);assert.equal(f.rows.get(logical(1)).flags.seen,false);assert.equal(f.rows.get(logical(2)).flags.seen,true);
});
for(const [name,provider,change] of [
 ['message','gmail',(r:any)=>{r.provider_source.locator.message_id='foreign';}],['thread','gmail',(r:any)=>{r.provider_source.locator.thread_id='foreign';}],
 ['account','gmail',(r:any)=>{r.provider_source.account_id='foreign';}],['epoch','gmail',(r:any)=>{r.provider_source.authority_epoch=2;}],
 ['Graph identity','microsoft',(r:any)=>{r.provider_source.locator.message_id='foreign';}],['Graph ID type','microsoft',(r:any)=>{r.provider_source.locator.id_type='rest';}],
 ['IMAP UIDVALIDITY','imap_smtp',(r:any)=>{r.provider_source.locator.uidvalidity='8';}],['IMAP UID','imap_smtp',(r:any)=>{r.provider_source.locator.uid=2;}],
 ['IMAP mailbox','imap_smtp',(r:any)=>{r.provider_source.locator.mailbox='foreign';}],
] as const)test('held '+name+' change stays denied before effect',async()=>{const f=fixture(provider),outcome=await held(f,()=>f.change(change));assert.match(outcome.error?.message??'',/EMAIL_ACCESS_DENIED/);assert.equal(f.effects,0);assert.equal(f.acknowledgements.length,0);});
test('tombstone, revocation and cancellation prevent reservation; strict agent/human supplied review fingerprints remain exact',async()=>{
 for(const kind of ['tombstone','revoked','abort']){const f=fixture(),controller=new AbortController(),outcome=await held(f,()=>{if(kind==='tombstone')f.rows.delete(logical(1));if(kind==='revoked')f.revoke();if(kind==='abort')controller.abort();},{},actor,controller.signal);assert.ok(outcome.error);assert.equal(f.effects,0);}
 for(const agent of [false,true]){const f=fixture(),review={expected_source_digests:{[logical(1)]:emailNativeTriageSourceFingerprint(f.rows.get(logical(1)))}};
  const owner=agent?{user_id:scope.owner_user_id,agent_grant_id:randomUUID(),principal_kind:'defty',principal_id:'synthetic-agent',access_expires_at:6000}:actor;
  const outcome=await held(f,()=>f.change(row=>{row.revision='changed';}),review,owner);assert.match(outcome.error?.message??'',/EMAIL_ACCESS_DENIED/);assert.equal(f.effects,0);
 }
});
