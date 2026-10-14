import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {EmailNativeTriageService,RegisteredEmailNativeTriageProvider,emailNativeTriageSourceFingerprint} from '../src/lib/email-native-triage.js';
import type {NativeEmailAccount, NativeEmailTriageResult, NativeEmailAdapter as AppConnectionAdapter} from '../src/lib/email-native-adapter-contract.js';
import type {EmailActor,EmailScope,EmailCapability,EmailMessageRecord} from '../src/lib/email-mailbox-service.js';
import type {EmailMailboxFlagAcknowledgement} from '../src/lib/email-mailbox-store.js';
const scope:EmailScope={org_id:'org-triage',owner_user_id:'owner-triage',account_id:'account-triage'};
const actor:EmailActor={user_id:scope.owner_user_id,web_session_id:'session-triage',access_expires_at:6000};
const capability:EmailCapability={scope,resource_binding_id:'binding-triage',authority_version:'authority-modify',expires_at:5000};
const logicalId='mail_'+'b'.repeat(64);
const record=():EmailMessageRecord=>({account_id:scope.account_id,logical_message_id:logicalId,revision:'old-revision',received_at:null,folders:['inbox'],
  flags:{seen:false,flagged:false,answered:false},data:{},provider_source:{schema_version:'deft.email_provider_source.v1',account_id:scope.account_id,provider:'gmail',
    authority_epoch:1,logical_message_id:logicalId,conversation_id:'conversation',locator:{message_id:'private-message'}}});
const status:NativeEmailAccount={account_id:scope.account_id,provider:'gmail',resource_binding_id:capability.resource_binding_id,authority_epoch:2,
  principal_digest:'a'.repeat(64),connection_revision:3,health:'connected',capabilities:['read','modify'],primary_address:'owner@example.test',display_label:'Triage'};
function fixture(options:{denyModify?:boolean;cacheChange?:boolean;lateAuthority?:boolean;lateStatus?:Partial<NativeEmailAccount>;wrongResult?:boolean;confirmedFlags?:boolean;confirmedFolders?:string[];resultState?:'succeeded'|'unknown';labelDestination?:Record<string,unknown>;lateLabelAuthority?:boolean;provider?:NativeEmailAccount['provider']}={}){
  let stores=0,writes=0,live=true,accountReads=0,invocations=0,checkpointPins=0;const calls:string[]=[],receipts=new Map<string,NativeEmailTriageResult>(),acknowledged:unknown[]=[];
  const journal={create:async()=>{throw Error('not used by fixture');},load:async()=>null,change:async()=>{throw Error('not used by fixture');}};
  const adapter:AppConnectionAdapter={handle:async()=>new Response(),nativeEmailAccount:async context=>{
    assert.equal(context.triage_journal,undefined,'Read context never receives journal');accountReads++;const currentStatus={...status,provider:options.provider??status.provider};return accountReads>1&&options.lateStatus?{...currentStatus,...options.lateStatus}:currentStatus;
  },nativeEmailTriage:async(input,context)=>{
    invocations++;if(input.mode==='status'){const original=receipts.get(input.operation_id);if(!original)throw Error('Missing operation');return original;}
    const id=input.mode==='undo'?input.undo_operation_id:input.operation_id,prior=receipts.get(id);if(prior)return prior;
    if(input.mode==='apply'){assert.equal(input.sources[0]!.authority_epoch,2);assert.equal(input.sources[0]!.logical_message_id,logicalId);}
    await context.triage_before_reserve!();writes++;if(options.lateAuthority)live=false;
    const state=options.resultState??'succeeded';
    const result:NativeEmailTriageResult={schema_version:'deft.email_native_triage_result.v1',account_id:options.wrongResult?'foreign':scope.account_id,
      operation_id:id,operation:input.mode==='apply'?input.operation.kind:'star',items:[{logical_message_id:logicalId,state,undo_supported:input.mode==='apply'&&state==='succeeded',
        ...(options.confirmedFlags&&state==='succeeded'?{confirmed_flags:{seen:true,flagged:false,answered:null}}:{}),...(options.confirmedFolders&&state==='succeeded'?{confirmed_folders:options.confirmedFolders}:{})}],
      automatic_retry:false,undo_available:input.mode==='apply'&&state==='succeeded'};receipts.set(id,result);return result;
  }};
  const resolver=async(s:EmailScope,cap:EmailCapability,_recheck:()=>Promise<void>,signal:AbortSignal|undefined,purpose:string)=>{
    assert.equal(purpose,'triage');assert.deepEqual(s,scope);assert.deepEqual(cap,capability);
    return {adapter,context:{...scope,installation_id:'installation-triage',resource_binding_id:capability.resource_binding_id,authority_version:capability.authority_version,
      expires_at:4000,recheck:async()=>{},signal,triage_journal:journal as any}};
  };
  const provider=new RegisteredEmailNativeTriageProvider(resolver,()=>1000);
  const authority={async current(_actor:EmailActor,_scope:EmailScope,operation:string){calls.push(operation);if(operation!=='human_modify'||options.denyModify||!live)throw Error('Denied mutation');return structuredClone(capability);}};
  const store={...(options.confirmedFolders?{async readAcknowledgementRevision(_scope:EmailScope,guard:(transaction:unknown)=>Promise<void>):Promise<number|null>{if(checkpointPins++===0)assert.equal(stores,0,'Initial checkpoint pin precedes initial message review');await guard({});return 7;}}:{}),async readMessage(){stores++;const value=record();value.provider_source={...value.provider_source,provider:options.provider??'gmail'};if(options.cacheChange&&stores>1)value.provider_source={...value.provider_source,locator:{message_id:'changed-source'}};return value;},
    async acknowledgeFlags(_scope:EmailScope,updates:readonly EmailMailboxFlagAcknowledgement[],guard:(transaction:unknown)=>Promise<void>){await guard({});acknowledged.push(...updates);return {acknowledged:updates.length,stale:0};}};
  const service=new EmailNativeTriageService(authority as any,store,provider,async(s,handle)=>{assert.deepEqual(s,scope);assert.ok(handle==='opaque-owner-folder'||/^opaque-label-[0-9]+$/u.test(handle)||handle==='opaque-owner-alias');if(options.lateLabelAuthority)live=false;return {account_id:scope.account_id,provider:'gmail',id:handle.startsWith('opaque-label-')?'private-label-'+handle.slice(13):'private-label',kind:'label',...options.labelDestination} as any;},()=>1000);
  return {service,provider,adapter,store,get counts(){return {stores,writes,invocations};},get calls(){return calls;},get acknowledged(){return acknowledged;}};
}
const input=()=>({operation_id:randomUUID(),kind:'star' as const,logical_message_ids:[logicalId]});

test('M38 fresh successful human folder proof survives conservative cache skip; replay/status and agent output stay closed',async()=>{
 const settings={confirmedFlags:true,confirmedFolders:['trash']},f=fixture(settings),request={...input(),kind:'trash' as const};
 f.store.acknowledgeFlags=async(_scope,updates,guard)=>{await guard({});return {acknowledged:0,stale:updates.length};};
 const fresh=await f.service.apply(actor,scope,request);assert.deepEqual(fresh.items[0]!.confirmed_folders,['trash']);assert.equal(Object.hasOwn(fresh.items[0]!,'confirmed_flags'),false);
 const replay=await f.service.apply(actor,scope,request),retained=await f.service.status(actor,scope,request.operation_id);assert.equal(Object.hasOwn(replay.items[0]!,'confirmed_folders'),false);assert.equal(Object.hasOwn(retained.items[0]!,'confirmed_folders'),false);assert.equal(f.counts.writes,1);
 settings.confirmedFolders=['inbox'];const undone=await f.service.undo(actor,scope,request.operation_id,randomUUID());assert.deepEqual(undone.items[0]!.confirmed_folders,['inbox'],'actual newly effected Undo proof, not retained apply after-state');assert.equal(f.counts.writes,2);
 const unknown=fixture({confirmedFolders:['trash'],resultState:'unknown'});assert.equal(Object.hasOwn((await unknown.service.apply(actor,scope,request)).items[0]!,'confirmed_folders'),false);
 const delegated=fixture({confirmedFolders:['trash']});const agent={user_id:actor.user_id,agent_grant_id:randomUUID(),principal_kind:'defty' as const,principal_id:'agent',access_expires_at:actor.access_expires_at};assert.equal(Object.hasOwn((await delegated.service.apply(agent,scope,request)).items[0]!,'confirmed_folders'),false);
 const late=fixture({confirmedFolders:['trash'],lateAuthority:true});await assert.rejects(late.service.apply(actor,scope,request));
});

test('M32 composed service prefers scoped target versions before reads and sends private row pin for fresh apply/Undo',async()=>{
 const f=fixture({confirmedFlags:true,confirmedFolders:['spam']}),store=f.store as typeof f.store&{readAcknowledgementVersions?: (scope:EmailScope,ids:readonly string[],guard:(tx:unknown)=>Promise<void>,signal?:AbortSignal)=>Promise<{logical_message_id:string;storage_revision:number}[]>};
 let pins=0;store.readAcknowledgementRevision=async()=>{throw Error('Legacy account pin must not be used');};store.readAcknowledgementVersions=async(s,ids,guard)=>{assert.deepEqual(s,scope);assert.deepEqual(ids,[logicalId]);if(pins===0)assert.equal(f.counts.stores,0);await guard({});pins++;return [{logical_message_id:logicalId,storage_revision:pins<=2?7:8}];};
 const operation=input();await f.service.apply(actor,scope,{...operation,kind:'spam'});const first=f.acknowledged[0] as EmailMailboxFlagAcknowledgement;
 assert.equal(first.expected_storage_revision,7);assert.equal(first.expected_checkpoint_revision,undefined);assert.deepEqual(first.folders,['spam']);
 await f.service.undo(actor,scope,operation.operation_id,randomUUID());assert.equal((f.acknowledged[1] as EmailMailboxFlagAcknowledgement).expected_storage_revision,8);assert.equal(pins,4);
 await f.service.status(actor,scope,operation.operation_id);assert.equal(pins,4);assert.equal(f.acknowledged.length,2);
});
test('M32 foreign/duplicate/invalid pins and held cancellation prevent provider effects; missing target pin cannot ACK',async()=>{
 for(const rows of [[{logical_message_id:'mail_'+'c'.repeat(64),storage_revision:7}],[{logical_message_id:logicalId,storage_revision:0}],[{logical_message_id:logicalId,storage_revision:7},{logical_message_id:logicalId,storage_revision:7}]]){const f=fixture({confirmedFlags:true});(f.store as any).readAcknowledgementVersions=async(_s:unknown,_ids:unknown,guard:(tx:unknown)=>Promise<void>)=>{await guard({});return rows;};await assert.rejects(f.service.apply(actor,scope,input()));assert.equal(f.counts.writes,0);}
 const missing=fixture({confirmedFlags:true,confirmedFolders:['spam']});(missing.store as any).readAcknowledgementVersions=async()=>[];await missing.service.apply(actor,scope,input());assert.equal(missing.counts.writes,1);assert.equal(missing.acknowledged.length,0);
 const abort=fixture({confirmedFlags:true}),controller=new AbortController();(abort.store as any).readAcknowledgementVersions=async(_s:unknown,_ids:unknown,guard:(tx:unknown)=>Promise<void>)=>{await guard({});controller.abort();return [{logical_message_id:logicalId,storage_revision:7}];};await assert.rejects(abort.service.apply(actor,scope,input(),controller.signal));assert.equal(abort.counts.writes,0);
});
test('native API triage uses distinct human_modify, cache fingerprint fence, exact receipt and idempotent replay',async()=>{
  const f=fixture(),request=input(),result=await f.service.apply(actor,scope,request);assert.equal(result.items[0]!.logical_message_id,logicalId);assert.equal(result.automatic_retry,false);
  assert.ok(f.calls.length>=5&&f.calls.every(call=>call==='human_modify'));assert.equal(f.counts.writes,1);
  assert.deepEqual(await f.service.apply(actor,scope,request),result);assert.equal(f.counts.writes,1);
  assert.deepEqual(await f.service.status(actor,scope,request.operation_id),result);
  const undone=await f.service.undo(actor,scope,request.operation_id,randomUUID());assert.equal(undone.undo_available,false);assert.equal(f.counts.writes,2);
});
test('only provider-confirmed terminal flags acknowledge exact reviewed cache and remain internal',async()=>{
  const f=fixture({confirmedFlags:true}),request=input();
  const result=await f.service.apply(actor,scope,{...request,kind:'mark_read'});
  assert.equal(f.acknowledged.length,1);
  assert.deepEqual(f.acknowledged[0],{logical_message_id:logicalId,expected_revision:'old-revision',expected_source_digest:emailNativeTriageSourceFingerprint(record()),
    flags:{seen:true,flagged:false,answered:null}});
  assert.equal(Object.hasOwn(result.items[0]!,'confirmed_flags'),false);
  const unknown=fixture({confirmedFlags:true,resultState:'unknown'});await unknown.service.apply(actor,scope,{...input(),kind:'mark_read'});
  assert.equal(unknown.acknowledged.length,0);
});

test('M38 succeeded Gmail membership acknowledgement keeps exact cache fences and exposes only fresh human folders',async()=>{
 const folders=['spam','label:'+'c'.repeat(64)],f=fixture({confirmedFlags:true,confirmedFolders:folders}),request={...input(),kind:'spam' as const};const result=await f.service.apply(actor,scope,request);
 assert.deepEqual(f.acknowledged[0],{logical_message_id:logicalId,expected_revision:'old-revision',expected_source_digest:emailNativeTriageSourceFingerprint(record()),flags:{seen:true,flagged:false,answered:null},folders,expected_checkpoint_revision:7});
 assert.deepEqual(result.items[0]!.confirmed_folders,folders);assert.equal(Object.hasOwn(result.items[0]!,'confirmed_flags'),false);
 await f.service.status(actor,scope,request.operation_id);assert.equal(f.acknowledged.length,1,'Status never reapplies an old membership set');
 const graph=fixture({provider:'microsoft',confirmedFolders:folders});await assert.rejects(graph.service.apply(actor,scope,{...input(),kind:'spam'}));assert.equal(graph.acknowledged.length,0);
});
test('M25 missing or invalid checkpoint cannot publish memberships; cancellation during guarded pin prevents provider I/O',async()=>{
 const missing=fixture({confirmedFolders:['spam']});missing.store.readAcknowledgementRevision=async()=>null;
 assert.equal((await missing.service.apply(actor,scope,{...input(),kind:'spam'})).items[0]!.state,'succeeded');assert.equal(missing.acknowledged.length,0);
 const invalid=fixture({confirmedFolders:['spam']});invalid.store.readAcknowledgementRevision=async()=>-1;await assert.rejects(invalid.service.apply(actor,scope,input()));assert.equal(invalid.counts.writes,0);
 const controller=new AbortController(),held=fixture({confirmedFolders:['spam']});held.store.readAcknowledgementRevision=async(_scope,guard)=>{await guard({});controller.abort();return 7;};
 await assert.rejects(held.service.apply(actor,scope,input(),controller.signal));assert.equal(held.counts.invocations,0);assert.equal(held.acknowledged.length,0);
});
test('native API missing human_modify, non-owner/agent-shaped actor, malformed operation and changed source deny before mutation',async()=>{
  const denied=fixture({denyModify:true});await assert.rejects(denied.service.apply(actor,scope,input()));assert.deepEqual(denied.counts,{stores:0,writes:0,invocations:0});
  const f=fixture();await assert.rejects(f.service.apply({...actor,user_id:'foreign'},scope,input()));await assert.rejects(f.service.apply({...actor,kind:'agent'} as any,scope,input()));
  await assert.rejects(f.service.apply(actor,scope,{...input(),kind:'permanent_delete'} as any));assert.equal(f.counts.invocations,0);
  const changed=fixture({cacheChange:true});await assert.rejects(changed.service.apply(actor,scope,input()));assert.equal(changed.counts.writes,0);assert.equal(changed.counts.invocations,1);
});
test('native move uses only a trusted same-account opaque destination resolver',async()=>{
  const f=fixture();let destination:any;const original=f.adapter.nativeEmailTriage!;f.adapter.nativeEmailTriage=async(input,context)=>{if(input.mode==='apply')destination=input.operation.destination;return original(input,context);};
  await f.service.apply(actor,scope,{...input(),kind:'move',destination_id:'opaque-owner-folder'});assert.deepEqual(destination,{account_id:scope.account_id,provider:'gmail',id:'private-label',kind:'label'});
  await assert.rejects(f.service.apply(actor,scope,{...input(),destination_id:'opaque-owner-folder'}));
});
test('late mutation authority/principal loss and foreign receipt fail closed after effect without another automatic invocation',async()=>{
  for(const options of [{lateAuthority:true},{lateStatus:{principal_digest:'f'.repeat(64)}},{wrongResult:true}]){
    const f=fixture(options);await assert.rejects(f.service.apply(actor,scope,input()));assert.equal(f.counts.writes,1);assert.equal(f.counts.invocations,1);
  }
});
test('triage replay with an expired or mismatched account capability and aborted actor never reaches provider',async()=>{
  const f=fixture(),aborted=AbortSignal.abort();await assert.rejects(f.service.apply(actor,scope,input(),aborted));assert.equal(f.counts.invocations,0);
  await assert.rejects(f.provider.invoke(scope,{mode:'status',operation_id:randomUUID()},{...capability,scope:{...scope,account_id:'other'}},async()=>{},async()=>{}));assert.equal(f.counts.invocations,0);
});

test('native labels resolves sixteen scoped nominations to trusted Gmail destinations and preserves selected intent',async()=>{
 for(const label_action of ['add','remove'] as const){const f=fixture();let actual:any;const original=f.adapter.nativeEmailTriage!;f.adapter.nativeEmailTriage=async(request,context)=>{if(request.mode==='apply')actual=request.operation;return original(request,context);};
 const result=await f.service.apply(actor,scope,{operation_id:randomUUID(),kind:'labels',label_action,destination_ids:Array.from({length:16},(_,i)=>'opaque-label-'+i),logical_message_ids:[logicalId]} as any);
 assert.equal(result.operation,'labels');assert.equal(f.counts.writes,1);assert.equal(actual.label_action,label_action);assert.equal(actual.destinations.length,16);assert.deepEqual(actual.destinations[15],{account_id:scope.account_id,provider:'gmail',id:'private-label-15',kind:'label'});assert.ok(f.calls.every(value=>value==='human_modify'));}
});
test('native labels reject wrong fields, cardinality and raw/resolved duplicate nominations before invocation',async()=>{
 const valid={operation_id:randomUUID(),kind:'labels',label_action:'add',destination_ids:['opaque-owner-folder'],logical_message_ids:[logicalId]},f=fixture();
 for(const bad of [{...valid,label_action:'replace'},{...valid,destination_ids:[]},{...valid,destination_ids:Array.from({length:17},(_,i)=>'opaque-label-'+i)},{...valid,destination_ids:['opaque-owner-folder','opaque-owner-folder']},{...valid,destination_id:'opaque-owner-folder'},{...valid,kind:'star'},{...valid,destination_ids:['private-provider-id']}])await assert.rejects(f.service.apply(actor,scope,bad as any));
 await assert.rejects(f.service.apply(actor,scope,{...valid,destination_ids:['opaque-owner-folder','opaque-owner-alias']} as any));assert.equal(f.counts.invocations,0);assert.equal(f.counts.writes,0);
});
test('native labels fresh foreign/provider/destination/authority and source checks prevent effects',async()=>{
 const valid={operation_id:randomUUID(),kind:'labels',label_action:'remove',destination_ids:['opaque-owner-folder'],logical_message_ids:[logicalId]};
 for(const labelDestination of [{account_id:'foreign'},{provider:'microsoft'},{kind:'folder'}]){const f=fixture({labelDestination});await assert.rejects(f.service.apply(actor,scope,valid as any));assert.equal(f.counts.invocations,0);}
 const denied=fixture({lateLabelAuthority:true});await assert.rejects(denied.service.apply(actor,scope,valid as any));assert.equal(denied.counts.writes,0);
 const changed=fixture({cacheChange:true});await assert.rejects(changed.service.apply(actor,scope,valid as any));assert.equal(changed.counts.writes,0);
});

test('M23 recovery operations retain current human_modify/source fences and explicit unsupported IMAP without writes',async()=>{
 for(const provider of ['gmail','microsoft'] as const)for(const kind of ['spam','not_spam','restore'] as const){const f=fixture({provider}),request={...input(),kind},result=await f.service.apply(actor,scope,request);assert.equal(result.operation,kind);assert.equal(result.items[0]!.state,'succeeded');assert.equal(f.counts.writes,1);assert.ok(f.calls.every(value=>value==='human_modify'));}
 for(const kind of ['spam','not_spam','restore'] as const){const unsupported=fixture({provider:'imap_smtp'});await assert.rejects(unsupported.service.apply(actor,scope,{...input(),kind}),/EMAIL_TRIAGE_OPERATION_UNSUPPORTED/);assert.equal(unsupported.counts.writes,0);assert.equal(unsupported.counts.invocations,0);
  const changed=fixture({cacheChange:true});await assert.rejects(changed.service.apply(actor,scope,{...input(),kind}));assert.equal(changed.counts.writes,0);const revoked=fixture({lateAuthority:true});await assert.rejects(revoked.service.apply(actor,scope,{...input(),kind}));assert.equal(revoked.counts.writes,1);
 }
});
