import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {EmailNativeFolderService,RegisteredEmailNativeFolderProvider} from '../src/lib/email-native-folders.js';
import {EmailFolderNameSchema,EmailFolderManageValueSchema,EmailFolderManageRequestSchema,type EmailFolderManageValue,type EmailFolderManageJournal} from '../src/lib/email-folder-management-contract.js';
import type {NativeEmailAccount, NativeEmailAdapter as AppConnectionAdapter} from '../src/lib/email-native-adapter-contract.js';
const scope={org_id:'org-manage',owner_user_id:'owner-manage',account_id:'account-manage'},actor={user_id:scope.owner_user_id,web_session_id:'synthetic-session',access_expires_at:4_000_000},cap={scope,resource_binding_id:'binding-manage',authority_version:'authority-manage',expires_at:3_000_000};
const folder=(id:string)=>'label:'+createHash('sha256').update(JSON.stringify({kind:'gmail_label_membership_v1',id})).digest('hex');
const barrier=()=>{let release!:()=>void;const held=new Promise<void>(r=>release=r);return {held,release};};
function fixture(){
 let now=1000,live=true,mode='success',effect=0,name='Projects',hold:ReturnType<typeof barrier>|undefined,entered:ReturnType<typeof barrier>|undefined;
 const values=new Map<string,EmailFolderManageValue>(),history:string[]=[],locked=new Set<string>(),purposes:string[]=[],operations:string[]=[];
 const journal:EmailFolderManageJournal={load:async id=>structuredClone(values.get(id)??null),recent:async()=>[...values.values()].slice(-20).reverse().map(value=>({created_at:'2026-10-08T00:00:00.000Z',value:structuredClone(value)})),
  change:async(id,work)=>{if(locked.has(id))throw Error('Busy');locked.add(id);try{return await work(structuredClone(values.get(id)??null),async value=>{values.set(id,EmailFolderManageValueSchema.parse(structuredClone(value)));history.push(value.state);});}finally{locked.delete(id);}}};
 let account:NativeEmailAccount={account_id:scope.account_id,provider:'gmail',resource_binding_id:cap.resource_binding_id,authority_epoch:1,connection_revision:2,principal_digest:'a'.repeat(64),health:'connected',capabilities:['read','modify'],primary_address:'owner@example.test',display_label:'Synthetic'};
 const adapter:AppConnectionAdapter={handle:async()=>new Response(),nativeEmailAccount:async()=>structuredClone(account),nativeEmailFolders:async input=>({schema_version:'deft.email_native_folders.v1',account_id:scope.account_id,provider:'gmail',items:[{id:'user-private',folder_id:folder('user-private'),label:name,kind:'label',parent_id:null,parent_folder_id:null,canonical_role:null,move_allowed:true,labels_allowed:true,...(input.management?{rename_allowed:true}:{})}],next_cursor:null,has_more:false,observed_at:'2026-10-08T00:00:00.000Z',...(input.management?{management:true}:{})}),
  nativeEmailFolderManage:async input=>{assert.equal(history.at(-1),'started');if(input.kind==='rename'&&input.expected_name!==name)throw Object.assign(Error('Changed'),{code:'EMAIL_NATIVE_FOLDER_TARGET_CHANGED'});if(mode==='reject')throw Object.assign(Error('Rejected'),{code:'EMAIL_NATIVE_FOLDER_PROVIDER_REJECTED'});effect++;entered?.release();await hold?.held;if(mode==='unknown')throw Error('Lost response');name=input.name;return {id:'user-private',folder_id:folder('user-private'),label:name,kind:'label'};}};
 const provider=new RegisteredEmailNativeFolderProvider(async(_scope,_cap,recheck,signal,purpose)=>{purposes.push(purpose);return {adapter,context:{...scope,installation_id:'namespace',resource_binding_id:cap.resource_binding_id,authority_version:cap.authority_version,expires_at:cap.expires_at,recheck,signal}};},()=>now);
 const cipher=new EmailMailboxCrypto({current:()=>({key_id:'manage',key:Buffer.alloc(32,13)}),read:()=>({key_id:'manage',key:Buffer.alloc(32,13)}),keyIds:()=>['manage']});
 const service=new EmailNativeFolderService({current:async(_actor,_scope,operation)=>{operations.push(operation);if(!live)throw Error('Denied');return structuredClone(cap);}},provider,cipher,()=>now,()=>journal);
 return {service,values,history,purposes,operations,adapter,get effect(){return effect;},get name(){return name;},set name(v:string){name=v;},set mode(v:string){mode=v;},set now(v:number){now=v;},set account(v:Partial<NativeEmailAccount>){account={...account,...v};},deny(){live=false;},hold(){hold=barrier();entered=barrier();return {ready:entered.held,release:hold.release};}};
}
test('M24 exact owner management creates/renames after committed started and recovers recent receipts without provider IDs',async()=>{
 const f=fixture(),ordinary=await f.service.list(actor,scope,{cursor:null,limit:20});assert.equal(ordinary.create_allowed,undefined);assert.equal(ordinary.items[0].rename_id,undefined);assert.deepEqual(f.purposes,['folders']);
 const page=await f.service.list(actor,scope,{cursor:null,limit:20,management:true});assert.equal(page.create_allowed,true);const token=page.items[0].rename_id!;assert.ok(token);assert.ok(!JSON.stringify(page).includes('user-private'));
 const created=await f.service.manage(actor,scope,{operation_id:randomUUID(),kind:'create',name:'Résumés'});assert.equal(created.state,'succeeded');assert.deepEqual(f.history,['prepared','started','succeeded']);
 const fresh=await f.service.list(actor,scope,{cursor:null,limit:20,management:true}),id=randomUUID(),renamed=await f.service.manage(actor,scope,{operation_id:id,kind:'rename',rename_id:fresh.items[0].rename_id,name:'Business'});assert.equal(renamed.label,'Business');assert.equal(f.effect,2);
 const recent=await f.service.recent(actor,scope);assert.equal(recent.items.length,2);assert.equal(recent.items[0].proposed_name,'Business');assert.equal(JSON.stringify(recent).includes('user-private'),false);
 const replay=await f.service.manage(actor,scope,{operation_id:id,kind:'rename',rename_id:fresh.items[0].rename_id,name:'Business'});assert.deepEqual(replay,renamed);await f.service.status(actor,scope,id);assert.equal(f.effect,2);
 await assert.rejects(f.service.manage(actor,scope,{operation_id:id,kind:'create',name:'Changed'}),/CONFLICT/);
});
test('M24 names/intents are bounded without truncation; invalid create cannot allocate a journal',async()=>{
 for(const value of ['', ' padded','x'.repeat(129),'a\nname','\ud800','\udc00','a\u0085b'])assert.equal(EmailFolderNameSchema.safeParse(value).success,false,JSON.stringify(value));
 for(const value of ['Business','é'.repeat(128),'😀'.repeat(64)])assert.equal(EmailFolderNameSchema.parse(value),value);
 assert.equal(EmailFolderManageRequestSchema.safeParse({operation_id:randomUUID(),kind:'create',name:'Business',provider_id:'raw'}).success,false);
 const f=fixture();await assert.rejects(f.service.manage(actor,scope,{operation_id:randomUUID(),kind:'create',name:'x'.repeat(129)}));assert.equal(f.values.size,0);assert.equal(f.effect,0);
});
test('M24 raw/Move/foreign/expired nominations and current changed target fail without writes',async()=>{
 const f=fixture(),page=await f.service.list(actor,scope,{cursor:null,limit:20,management:true}),ordinary=await f.service.list(actor,scope,{cursor:null,limit:20});
 for(const token of ['user-private',ordinary.items[0].destination_id])await assert.rejects(f.service.manage(actor,scope,{operation_id:randomUUID(),kind:'rename',rename_id:token,name:'New'}),/RENAME_INVALID/);
 await assert.rejects(f.service.manage(actor,{...scope,account_id:'other'},{operation_id:randomUUID(),kind:'rename',rename_id:page.items[0].rename_id,name:'New'}));
 f.name='Outside rename';const changed=await f.service.manage(actor,scope,{operation_id:randomUUID(),kind:'rename',rename_id:page.items[0].rename_id,name:'New'});assert.equal(changed.state,'failed');assert.equal(changed.code,'target_changed');assert.equal(f.effect,0);
 f.now=2_000_000;await assert.rejects(f.service.manage(actor,scope,{operation_id:randomUUID(),kind:'rename',rename_id:page.items[0].rename_id,name:'New'}),/RENAME_EXPIRED/);assert.equal(f.effect,0);
});
test('M24 rejected effects are distinct from unknown response; started/unknown and restarted service never replay',async()=>{
 for(const mode of ['reject','unknown']){const f=fixture();f.mode=mode;const id=randomUUID(),request={operation_id:id,kind:'create',name:'Business'},result=await f.service.manage(actor,scope,request);assert.equal(result.state,mode==='reject'?'failed':'unknown');const count=f.effect;
  await f.service.manage(actor,scope,request);await f.service.status(actor,scope,id);assert.equal(f.effect,count);const retained=f.values.get(id)!;f.values.set(id,{...retained,state:'started',result:null});const status=await f.service.status(actor,scope,id);assert.equal(status.state,'unknown');await f.service.manage(actor,scope,request);assert.equal(f.effect,count);}
});
test('M24 held authority/setup/principal/abort changes suppress success; durable started remains status-only',async()=>{
 for(const change of ['denied','principal','setup','abort']){const f=fixture(),held=f.hold(),controller=new AbortController(),id=randomUUID(),request={operation_id:id,kind:'create',name:'Business'},running=f.service.manage(actor,scope,request,controller.signal);await held.ready;
  if(change==='denied')f.deny();else if(change==='principal')f.account={principal_digest:'b'.repeat(64)};else if(change==='setup')f.account={connection_revision:3};else controller.abort();held.release();await assert.rejects(running);assert.equal(f.effect,1);assert.equal(f.values.get(id)?.state,'started');}
});
test('M24 supported provider/capability guards reject IMAP and read-only before journal allocation',async()=>{
 for(const input of [{provider:'imap_smtp' as const},{capabilities:['read'] as ('read')[]}]){const f=fixture();f.account=input;await assert.rejects(f.service.manage(actor,scope,{operation_id:randomUUID(),kind:'create',name:'Business'}));assert.equal(f.values.size,0);assert.equal(f.effect,0);}
});
