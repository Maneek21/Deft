import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {EmailNativeFolderService,RegisteredEmailNativeFolderProvider} from '../src/lib/email-native-folders.js';
import type {AppConnectionAdapter,NativeEmailAccount,NativeEmailFolder} from '../src/lib/app-connection-contract.js';
import type {EmailActor,EmailScope,EmailCapability,EmailAuthority} from '../src/lib/email-mailbox-service.js';
import {EmailNativeTriageService} from '../src/lib/email-native-triage.js';
const scope:EmailScope={org_id:'org-folders',owner_user_id:'owner-folders',account_id:'account-folders'};
const actor:EmailActor={user_id:scope.owner_user_id,web_session_id:'folder-session',access_expires_at:4_000_000};
const cap:EmailCapability={scope,resource_binding_id:'binding-folders',authority_version:'folder-authority',expires_at:3_000_000};
const hash=createHash('sha256').update(JSON.stringify({kind:'gmail_label_membership_v1',id:'private-provider-label'})).digest('hex');
const rows:NativeEmailFolder[]=[{id:'INBOX',folder_id:'inbox',label:'Inbox',kind:'label',parent_id:null,parent_folder_id:null,canonical_role:'inbox',move_allowed:true,labels_allowed:false},
  {id:'private-provider-label',folder_id:'label:'+hash,label:'Project résumé',kind:'label',parent_id:null,parent_folder_id:null,canonical_role:null,move_allowed:true,labels_allowed:true},
  {id:'TRASH',folder_id:'trash',label:'Trash',kind:'label',parent_id:null,parent_folder_id:null,canonical_role:'trash',move_allowed:false,labels_allowed:false}];
function fixture(){
  let time=1000,live=true,readCalls=0,destinationCalls=0,lateChange=false;const purposes:string[]=[],operations:string[]=[];
  let status:NativeEmailAccount={account_id:scope.account_id,provider:'gmail',resource_binding_id:cap.resource_binding_id,authority_epoch:1,connection_revision:2,
    principal_digest:'a'.repeat(64),health:'connected',capabilities:['read','modify'],primary_address:'owner@example.test',display_label:'Folder account'};
  const adapter:AppConnectionAdapter={handle:async()=>new Response(),nativeEmailAccount:async()=>structuredClone(status),
    nativeEmailFolders:async(input)=>{readCalls++;const offset=input.cursor===null?0:Number(input.cursor),items=rows.slice(offset,offset+input.limit),next=offset+items.length<rows.length?String(offset+items.length):null;
      if(lateChange)status={...status,principal_digest:'c'.repeat(64)};return {schema_version:'deft.email_native_folders.v1',account_id:scope.account_id,provider:'gmail',items,next_cursor:next,has_more:next!==null,observed_at:'2026-10-04T00:00:00.000Z'};},
    nativeEmailDestination:async({id})=>{destinationCalls++;if(id!=='private-provider-label'&&id!=='INBOX')throw Error('Deleted destination');return {account_id:scope.account_id,provider:'gmail',id,kind:'label'};}};
  const authority:EmailAuthority={async current(_actor,selected,operation){operations.push(operation);if(!live)throw Error('Revoked');return {...cap,scope:structuredClone(selected)};}};
  const provider=new RegisteredEmailNativeFolderProvider(async(selected,held,recheck,signal,purpose)=>{purposes.push(purpose);return {adapter,context:{...selected,installation_id:'installation-folders',resource_binding_id:held.resource_binding_id,
    authority_version:held.authority_version,expires_at:held.expires_at,recheck,signal}};},()=>time);
  const crypto=new EmailMailboxCrypto({current:()=>({key_id:'folder-test',key:Buffer.alloc(32,44)}),read:(_purpose,key_id)=>key_id==='folder-test'?{key_id,key:Buffer.alloc(32,44)}:null,keyIds:()=>['folder-test']});
  const service=new EmailNativeFolderService(authority,provider,crypto,()=>time),recheck=async()=>{await authority.current(actor,scope,'human_modify');};
  return {service,provider,recheck,adapter,operations,purposes,get counts(){return {readCalls,destinationCalls};},set time(value:number){time=value;},set status(value:Partial<NativeEmailAccount>){status={...status,...value};},
    deny(){live=false;},latePrincipal(){lateChange=true;}};
}
test('public catalog exposes stable cache folder IDs and sealed owner destinations across three pages',async()=>{
  const f=fixture();let cursor:string|null=null;const pages=[];
  for(let i=0;i<3;i++){const page=await f.service.list(actor,scope,{cursor,limit:1});pages.push(page);cursor=page.next_cursor;}
  assert.deepEqual(pages.flatMap(page=>page.items.map(row=>row.folder_id)),['inbox','label:'+hash,'trash']);assert.equal(cursor,null);
  assert.deepEqual(pages.map(page=>page.coverage),['partial','partial','complete']);assert.ok(pages.every(page=>page.exact_total===null&&page.consistency==='weak'));
  const target=pages[1]!.items[0]!.destination_id!;assert.ok(target);assert.equal(pages[2]!.items[0]!.destination_id,null);
  assert.equal(JSON.stringify(pages).includes('private-provider-label'),false);assert.equal(Buffer.from(target,'base64url').toString('utf8').includes('private-provider-label'),false);
  assert.deepEqual(await f.service.resolveDestination(scope,target,cap,f.recheck),{account_id:scope.account_id,provider:'gmail',id:'private-provider-label',kind:'label'});
  assert.deepEqual(f.purposes,['folders','folders','folders','folders','folders','destination','destination']);assert.ok(f.operations.includes('human_modify'));
});
test('destination ciphertext cannot be replaced with raw provider ID, another account token or catalog cursor',async()=>{
  const f=fixture(),page=await f.service.list(actor,scope,{cursor:null,limit:2}),token=page.items[1]!.destination_id!;
  await assert.rejects(f.service.resolveDestination(scope,'private-provider-label',cap,f.recheck));
  await assert.rejects(f.service.resolveDestination({...scope,account_id:'another-account'},token,{...cap,scope:{...scope,account_id:'another-account'}},f.recheck));
  await assert.rejects(f.service.resolveDestination(scope,page.next_cursor!,cap,f.recheck));assert.equal(f.counts.destinationCalls,0);
  const bytes=Buffer.from(token,'base64url'),envelope=JSON.parse(bytes.toString('utf8'));envelope.ciphertext_b64=Buffer.from('tampered').toString('base64');
  await assert.rejects(f.service.resolveDestination(scope,Buffer.from(JSON.stringify(envelope)).toString('base64url'),cap,f.recheck));assert.equal(f.counts.destinationCalls,0);
});
test('principal, reconnect, expiry and revocation invalidate held catalog and destination nominations',async()=>{
  for(const change of [{principal_digest:'b'.repeat(64)},{connection_revision:3},{resource_binding_id:'different-binding'}]){
    const f=fixture(),page=await f.service.list(actor,scope,{cursor:null,limit:2});f.status=change;
    await assert.rejects(f.service.list(actor,scope,{cursor:page.next_cursor,limit:2}));await assert.rejects(f.service.resolveDestination(scope,page.items[1]!.destination_id!,cap,f.recheck));assert.equal(f.counts.destinationCalls,0);
  }
  const expired=fixture(),page=await expired.service.list(actor,scope,{cursor:null,limit:2});expired.time=901001;
  await assert.rejects(expired.service.resolveDestination(scope,page.items[1]!.destination_id!,cap,expired.recheck),/EMAIL_FOLDER_CURSOR_EXPIRED/);
  const revoked=fixture(),held=await revoked.service.list(actor,scope,{cursor:null,limit:2});revoked.deny();
  await assert.rejects(revoked.service.resolveDestination(scope,held.items[1]!.destination_id!,cap,revoked.recheck));assert.equal(revoked.counts.destinationCalls,0);
});
test('late principal change and malformed/foreign account output deny catalog disclosure',async()=>{
  const f=fixture();f.latePrincipal();await assert.rejects(f.service.list(actor,scope,{cursor:null,limit:2}));assert.equal(f.counts.readCalls,1);
  const wrong=fixture(),original=wrong.adapter.nativeEmailFolders!;wrong.adapter.nativeEmailFolders=async(input,context)=>({...await original(input,context),account_id:'foreign'});
  await assert.rejects(wrong.service.list(actor,scope,{cursor:null,limit:2}));
  const nonOwner=fixture();await assert.rejects(nonOwner.service.list({...actor,user_id:'foreign'},scope,{cursor:null,limit:2}));assert.equal(nonOwner.counts.readCalls,0);
});
test('catalog cursors bind page limit and purpose; expired/aborted requests perform no provider catalog read',async()=>{
  const f=fixture(),page=await f.service.list(actor,scope,{cursor:null,limit:1});await assert.rejects(f.service.list(actor,scope,{cursor:page.next_cursor,limit:2}));assert.equal(f.counts.readCalls,1);
  await assert.rejects(f.service.list(actor,scope,{cursor:null,limit:2},AbortSignal.abort()));assert.equal(f.counts.readCalls,1);
  await assert.rejects(f.service.list({...actor,kind:'agent'} as any,scope,{cursor:null,limit:2}));
});
test('a real sealed catalog handle flows through native human Move and resolves only the current account destination',async()=>{
  const f=fixture(),catalog=await f.service.list(actor,scope,{cursor:null,limit:2}),logicalId='mail_'+'d'.repeat(64),handle=catalog.items[1]!.destination_id!;
  assert.ok(handle.length>256,'Encrypted token exceeds ordinary provider-ID bound');let mutations=0;
  const authority:EmailAuthority={async current(_actor,_scope,operation){assert.ok(['human_read','human_modify'].includes(operation));return structuredClone(cap);}};
  const service=new EmailNativeTriageService(authority,{async readMessage(){return {account_id:scope.account_id,logical_message_id:logicalId,revision:'current',received_at:null,
    folders:['inbox'],flags:{seen:false,flagged:false,answered:false},data:{},provider_source:{schema_version:'deft.email_provider_source.v1',account_id:scope.account_id,logical_message_id:logicalId,provider:'gmail',authority_epoch:1,locator:{message_id:'private-message'}}};}},
    {async invoke(_scope,input,_cap,recheck,beforeReserve){assert.equal(input.mode,'apply');if(input.mode!=='apply')throw Error('Unexpected mode');
      assert.deepEqual(input.operation.destination,{account_id:scope.account_id,provider:'gmail',id:'private-provider-label',kind:'label'});await beforeReserve();mutations++;await recheck();
      return {schema_version:'deft.email_native_triage_result.v1',account_id:scope.account_id,operation_id:input.operation_id,operation:'move',items:[{logical_message_id:logicalId,state:'succeeded',undo_supported:true}],undo_available:true,automatic_retry:false};}},
    f.service.resolveDestination,()=>1000);
  const result=await service.apply(actor,scope,{operation_id:'123e4567-e89b-42d3-a456-426614174000',kind:'move',logical_message_ids:[logicalId],destination_id:handle});
  assert.equal(result.operation,'move');assert.equal(mutations,1);assert.equal(f.counts.destinationCalls,1);
  await assert.rejects(service.apply(actor,scope,{operation_id:'123e4567-e89b-42d3-a456-426614174001',kind:'move',logical_message_ids:[logicalId],destination_id:'private-provider-label'}));assert.equal(mutations,1);
});
