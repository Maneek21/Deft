import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEmailTriageService} from './triage-service.mjs';
import {createEmailTriageJournal} from './providers/triage-journal.mjs';
import {createGmailTriageAdapter} from './providers/triage-gmail.mjs';
import {createMicrosoftTriageAdapter} from './providers/triage-microsoft.mjs';
import {createImapTriageAdapter} from './providers/triage-imap.mjs';
import {createEmailFileCustodyStore} from './providers/custody-file-store.mjs';
import {TRIAGE_OPERATIONS,TRIAGE_LIMITS} from './providers/triage-contract.mjs';

const scope={org_id:'org-one',owner_id:'owner-one',installation_id:'installation-one'};
const account=provider=>({account_id:'account-'+provider,provider,display_label:provider,primary_address:'sender@example.test',verified_sender_identities:['sender@example.test'],capabilities:['read','send'],connection_target:'personal',resource_binding_id:'resource-one',action_binding_id:'send-binding',authority_epoch:1,health:'connected'});
function memoryStore(){const rows=new Map(),locks=new Map();return {rows,async withLock({key},fn){const previous=locks.get(key)??Promise.resolve(),next=previous.catch(()=>{}).then(()=>fn({async read(){return structuredClone(rows.get(key)??null);},async compareAndSwap({expected_revision,value}){const prior=rows.get(key);if((prior?.revision??null)!==expected_revision)return false;rows.set(key,{revision:(expected_revision??0)+1,value:structuredClone(value)});return true;}}));locks.set(key,next);return next;}};}
function httpFixture(provider,{store=memoryStore()}={}){
 const binding={scope,account:account(provider),action_binding_id:'triage-binding',operations:[...TRIAGE_OPERATIONS]},calls=[],messages=new Map();let allowed=true,confirmed=false,granted=provider==='gmail'?['https://www.googleapis.com/auth/gmail.modify']:['Mail.ReadWrite'];
 for(const id of ['a','b','c'])messages.set(id,provider==='gmail'?{id,labelIds:['INBOX','UNREAD'],threadId:'thread-'+id}:{id,parentFolderId:'inbox-id',isRead:false,flag:{flagStatus:'notFlagged'},categories:[],etag:1});
 const locator=id=>provider==='gmail'?{kind:'gmail',message_id:id,thread_id:'thread-'+id,label_ids:[...(messages.get(id)?.labelIds??[])]}:{kind:'microsoft',message_id:id,id_type:'immutable',conversation_id:'thread-'+id,folder_id:messages.get(id)?.parentFolderId??'inbox-id'};
 let writeError=null,afterWrite=null;
 const data=row=>provider==='gmail'?structuredClone(row):{...structuredClone(row),'@odata.etag':'W/"'+row.etag+'"'};
 const fetch=async(url,options)=>{const path=new URL(url).pathname,method=options.method;calls.push({path,method,headers:options.headers,body:options.body?JSON.parse(options.body):null});
  if(path.endsWith('/labels'))return Response.json({labels:[{id:'Label_1',type:'user'}]});
  const id=/\/messages\/([^/]+)/.exec(path)?.[1],row=messages.get(id);if(!row)return Response.json({}, {status:404});
  if(method==='GET')return Response.json(data(row));
  if(writeError){if(writeError==='network')throw Error('response lost');return Response.json({}, {status:writeError});}
  if(provider==='gmail'){
   if(method==='DELETE'){messages.delete(id);afterWrite?.();return Response.json({});}
   if(path.endsWith('/trash'))row.labelIds=[...row.labelIds.filter(label=>label!=='INBOX'),'TRASH'];
   else if(path.endsWith('/untrash'))row.labelIds=row.labelIds.filter(label=>label!=='TRASH');
   else {const body=JSON.parse(options.body);row.labelIds=[...new Set([...row.labelIds.filter(label=>!body.removeLabelIds.includes(label)),...body.addLabelIds])];}
   afterWrite?.();return Response.json(data(row));
  }
  if(options.headers['If-Match']!=='W/"'+row.etag+'"')return Response.json({}, {status:412});
  if(path.endsWith('/permanentDelete')){messages.delete(id);afterWrite?.();return new Response(null,{status:204});}
  if(path.endsWith('/move')){const destination=JSON.parse(options.body).destinationId;row.parentFolderId=['archive','deleteditems','junkemail','inbox'].includes(destination)?destination+'-id':destination;row.etag++;afterWrite?.();return Response.json(data(row),{status:201});}
  Object.assign(row,JSON.parse(options.body));row.etag++;afterWrite?.();return Response.json(data(row));
 };
 const options={binding,fetch,assertAuthority:async()=>allowed,getAccessToken:async()=>({token:'synthetic-token',granted_scopes:granted})};
 const journal=createEmailTriageJournal({store,encryption_key:Buffer.alloc(32,7),key_id:'triage-test'});
 const adapter=provider==='gmail'?createGmailTriageAdapter(options):createMicrosoftTriageAdapter(options);
 const makeService=()=>createEmailTriageService({journal,resolveAuthority:async({review_digest})=>{if(!allowed)throw Error('revoked');return {binding,actor:{kind:'human',user_id:scope.owner_id},expires_at:Date.now()+600000,...(confirmed?{destructive_confirmation:{accepted:true,review_digest}}:{})};},resolveMessage:async({logical_id})=>({scope,account_id:binding.account.account_id,locator:locator(logical_id)}),adapterFor:async()=>adapter});
 return {binding,calls,messages,locator,adapter,journal,store,service:makeService(),makeService,setAllowed:value=>allowed=value,setConfirmed:value=>confirmed=value,setGranted:value=>granted=value,setWriteError:value=>writeError=value,setAfterWrite:value=>afterWrite=value};
}
async function run(fixture,operation,logical_ids=['a']){const plan=await fixture.service.prepare({scope,account_id:fixture.binding.account.account_id,operation_id:randomUUID(),operation,logical_ids});const result=await fixture.service.execute({scope,operation_id:plan.operation_id,expected_digest:plan.digest});return {plan,result};}

for(const provider of ['gmail','microsoft'])test(provider+' read/unread, flag, archive, trash/restore, spam and label/category methods are exact',async()=>{
 const f=httpFixture(provider);
 for(const kind of ['mark_read','mark_unread','flag','unflag','archive','trash','restore','spam','not_spam']){
  const {result}=await run(f,{kind});assert.equal(result.items[0].state,'succeeded',kind);assert.equal(result.items[0].undo_supported,true);
 }
 const {result}=await run(f,{kind:'labels',add_labels:[provider==='gmail'?'Label_1':'Important'],remove_labels:[]});assert.equal(result.items[0].state,'succeeded');
 const writes=f.calls.filter(call=>call.method!=='GET');assert.equal(writes.length,10);assert.ok(writes.every(call=>call.headers.Authorization==='Bearer synthetic-token'));
 if(provider==='gmail'){assert.deepEqual(writes[0].body,{addLabelIds:[],removeLabelIds:['UNREAD']});assert.ok(writes.every(call=>call.path.startsWith('/gmail/v1/users/me/')));}
 else {assert.ok(writes.every(call=>call.headers.Prefer==='IdType="ImmutableId"'));assert.equal(writes.find(call=>call.path.endsWith('/move')).body.destinationId,'archive');assert.deepEqual(writes[0].body,{isRead:true});}
});

test('actual provider scopes intersect reviewed triage operations; read/Send and gmail.modify cannot delete',async()=>{
 const f=httpFixture('gmail');f.setGranted(['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']);await assert.rejects(()=>run(f,{kind:'archive'}),/EMAIL_TRIAGE_PROVIDER_SCOPE_DENIED/);assert.equal(f.calls.length,0);
 f.setGranted(['https://www.googleapis.com/auth/gmail.modify']);f.setConfirmed(true);await assert.rejects(()=>run(f,{kind:'permanent_delete'}),/EMAIL_TRIAGE_PROVIDER_SCOPE_DENIED/);assert.ok(f.messages.has('a'));assert.equal(f.calls.filter(call=>call.method==='DELETE').length,0);
 const denied=httpFixture('microsoft');denied.binding.operations=['flag'];await assert.rejects(()=>run(denied,{kind:'archive'}),/EMAIL_TRIAGE_AUTHORITY_STALE/);assert.equal(denied.calls.length,0);
});

test('permanent deletion requires exact host destructive confirmation, no undo, and uses supported provider endpoint',async()=>{
 for(const provider of ['gmail','microsoft']){const f=httpFixture(provider);if(provider==='gmail')f.setGranted(['https://mail.google.com/']);const plan=await f.service.prepare({scope,account_id:f.binding.account.account_id,operation_id:randomUUID(),operation:{kind:'permanent_delete'},logical_ids:['a']});await assert.rejects(()=>f.service.execute({scope,operation_id:plan.operation_id,expected_digest:plan.digest}),/CONFIRMATION_REQUIRED/);assert.ok(f.messages.has('a'));
  f.setConfirmed(true);if(provider==='gmail')f.setGranted(['https://mail.google.com/']);const result=await f.service.execute({scope,operation_id:plan.operation_id,expected_digest:plan.digest});assert.equal(result.items[0].state,'succeeded');assert.equal(result.items[0].undo_supported,false);assert.ok(!f.messages.has('a'));await assert.rejects(()=>f.service.prepareUndo({scope,operation_id:plan.operation_id,expected_digest:plan.digest,undo_operation_id:randomUUID()}),/UNDO_UNSUPPORTED/);
 }
});

test('bulk has per-item rejection/unknown/success and restart never repeats a started provider effect',async()=>{
 const f=httpFixture('gmail');let attempt=0;f.setAfterWrite(()=>{attempt++;if(attempt===1)f.setWriteError('network');});
 const {plan,result}=await run(f,{kind:'flag'},['a','b','c']);assert.deepEqual(result.items.map(item=>item.state),['succeeded','unknown','unknown']);const count=f.calls.filter(call=>call.method==='POST').length;
 f.setWriteError(null);f.service=f.makeService();const replay=await f.service.execute({scope,operation_id:plan.operation_id,expected_digest:plan.digest});assert.deepEqual(replay.items.map(item=>item.state),['succeeded','unknown','unknown']);assert.equal(f.calls.filter(call=>call.method==='POST').length,count);
 const rejected=httpFixture('microsoft');rejected.setWriteError(403);const failed=await run(rejected,{kind:'flag'},['a','b']);assert.deepEqual(failed.result.items.map(item=>item.state),['failed','failed']);
});

for(const provider of ['gmail','microsoft'])test(provider+' safe undo restores exact state; an intervening provider change refuses before write',async()=>{
 const f=httpFixture(provider),{plan}=await run(f,{kind:'archive'}),undo=await f.service.prepareUndo({scope,operation_id:plan.operation_id,expected_digest:plan.digest,undo_operation_id:randomUUID()});
 const result=await f.service.execute({scope,operation_id:undo.operation_id,expected_digest:undo.digest});assert.equal(result.items[0].state,'succeeded');assert.equal(result.items[0].undo_supported,false);
 if(provider==='gmail')assert.ok(f.messages.get('a').labelIds.includes('INBOX'));else assert.equal(f.messages.get('a').parentFolderId,'inbox-id');
 const second=await run(f,{kind:'flag'}),stale=await f.service.prepareUndo({scope,operation_id:second.plan.operation_id,expected_digest:second.plan.digest,undo_operation_id:randomUUID()});if(provider==='gmail')f.messages.get('a').labelIds.push('UNRELATED');else f.messages.get('a').etag++;
 const writes=f.calls.filter(call=>call.method!=='GET').length;const refused=await f.service.execute({scope,operation_id:stale.operation_id,expected_digest:stale.digest});assert.equal(refused.items[0].state,'failed');assert.equal(f.calls.filter(call=>call.method!=='GET').length,writes);
});

test('wrong owner/account/ref and post-effect revocation fail closed without resend',async()=>{
 const f=httpFixture('gmail');await assert.rejects(()=>f.service.prepare({scope:{...scope,owner_id:'other'},account_id:f.binding.account.account_id,operation_id:randomUUID(),operation:{kind:'flag'},logical_ids:['a']}),/AUTHORITY_STALE/);assert.equal(f.calls.length,0);
 const {plan}=await run(f,{kind:'flag'});await assert.rejects(()=>f.service.execute({scope,operation_id:plan.operation_id,expected_digest:'0'.repeat(64)}),/PLAN_DENIED/);
 const revoke=httpFixture('gmail');revoke.setAfterWrite(()=>revoke.setAllowed(false));const prepared=await revoke.service.prepare({scope,account_id:revoke.binding.account.account_id,operation_id:randomUUID(),operation:{kind:'flag'},logical_ids:['a']});await assert.rejects(()=>revoke.service.execute({scope,operation_id:prepared.operation_id,expected_digest:prepared.digest}));const retained=await revoke.journal.load(scope,prepared.operation_id);assert.equal(retained.items[0].state,'unknown');assert.equal(revoke.calls.filter(call=>call.method==='POST').length,1);
});

function imapFixture(){
 const binding={scope,account:account('imap_smtp'),action_binding_id:'triage-binding',operations:[...TRIAGE_OPERATIONS]},rows=new Map([['INBOX',{uid:1,flags:new Set(),modseq:1n}]]),calls=[],caps=new Map([['MOVE',true],['UIDPLUS',true],['CONDSTORE',true]]);
 const client={secureConnection:true,capabilities:caps,mailbox:null,async getMailboxLock(path){this.path=path;this.mailbox={uidValidity:path==='INBOX'?100:200,permanentFlags:new Set(['\\*','\\Seen','\\Flagged'])};return {release(){}};},async fetchOne(uid){const row=rows.get(this.path);return row?.uid===uid?{...row,flags:new Set(row.flags)}:false;},async messageFlagsSet(uid,flags,options){calls.push({kind:'flags',uid,flags,options});const row=rows.get(this.path);if(row.modseq!==options.unchangedSince)return false;row.flags=new Set(flags);row.modseq++;return true;},async messageMove(uid,destination,options){calls.push({kind:'move',uid,destination,options});const row=rows.get(this.path);rows.delete(this.path);rows.set(destination,{...row,uid:destination==='INBOX'?1:2});return {uidValidity:BigInt(destination==='INBOX'?100:200),uidMap:new Map([[uid,destination==='INBOX'?1:2]])};},async messageDelete(uid,options){calls.push({kind:'delete',uid,options});rows.delete(this.path);return true;},async list(){return [{path:'INBOX'},{path:'Archive'},{path:'Trash'},{path:'Spam'}];},async logout(){}};
 const adapter=createImapTriageAdapter({binding,connect:async()=>client,assertAuthority:async()=>true,declaration:{flags:true,keywords:['Important'],move:true,uid_expunge:true,folders:{inbox:'INBOX',archive:'Archive',trash:'Trash',spam:'Spam'}}});return {binding,adapter,rows,calls,caps,locator:{kind:'imap_smtp',mailbox:'INBOX',uidvalidity:'100',uid:1}};
}
test('declared IMAP conditional flags, exact UIDVALIDITY, special folders and UID mapping undo',async()=>{
 const f=imapFixture();let reservations=0;const reserve=async()=>{reservations++;};let before=await f.adapter.readState(f.locator,'mark_read'),changed=await f.adapter.apply({before,operation:{kind:'mark_read'},reserve});assert.deepEqual(changed.after.flags,['\\Seen']);assert.equal(f.calls[0].options.unchangedSince,1n);
 const moved=await f.adapter.apply({before:changed.after,operation:{kind:'archive'},reserve});assert.equal(moved.after.locator.mailbox,'Archive');assert.equal(moved.after.locator.uid,2);
 const restored=await f.adapter.undo({before:changed.after,after:moved.after,operation:{kind:'archive'},reserve});assert.equal(restored.after.locator.mailbox,'INBOX');assert.equal(reservations,3);
 await assert.rejects(()=>f.adapter.readState({...f.locator,uidvalidity:'999'},'flag'),/LOCATOR_STALE/);f.caps.delete('UIDPLUS');await assert.rejects(()=>f.adapter.apply({before:restored.after,operation:{kind:'permanent_delete'},reserve}),/OPERATION_UNSUPPORTED/);assert.equal(f.calls.filter(call=>call.kind==='delete').length,0);
});

test('Gmail destinations are labels, category system IDs cannot be smuggled, move retains unrelated labels',async()=>{
 const f=httpFixture('gmail'),destinations=await f.service.destinations({scope,account_id:f.binding.account.account_id});assert.equal(destinations.special_folders.archive,null);assert.deepEqual(destinations.destinations,[{id:'Label_1',kind:'label'}]);
 f.messages.get('a').labelIds.push('Other');const moved=await run(f,{kind:'move',destination:'Label_1'});assert.equal(moved.result.items[0].state,'succeeded');assert.deepEqual(f.messages.get('a').labelIds.sort(),['Label_1','Other','UNREAD']);
 const denied=await run(f,{kind:'labels',add_labels:['TRASH'],remove_labels:[]});assert.equal(denied.result.items[0].state,'failed');assert.equal(denied.result.items[0].code,'EMAIL_TRIAGE_LABEL_DENIED');
});

test('declared IMAP keyword, trash/restore, spam, and UID-only delete avoid unsupported fallback',async()=>{
 const f=imapFixture(),reserve=async()=>{},destinations=await f.adapter.listDestinations();assert.equal(destinations.special_folders.trash,'Trash');let before=await f.adapter.readState(f.locator,'labels');const keyword=await f.adapter.apply({before,operation:{kind:'labels',add_labels:['Important'],remove_labels:[]},reserve});assert.deepEqual(keyword.after.flags,['Important']);
 const trashed=await f.adapter.apply({before:keyword.after,operation:{kind:'trash'},reserve});assert.equal(trashed.after.locator.mailbox,'Trash');const restored=await f.adapter.apply({before:trashed.after,operation:{kind:'restore'},reserve});assert.equal(restored.after.locator.mailbox,'INBOX');const spammed=await f.adapter.apply({before:restored.after,operation:{kind:'spam'},reserve});assert.equal(spammed.after.locator.mailbox,'Spam');const deleted=await f.adapter.apply({before:spammed.after,operation:{kind:'permanent_delete'},reserve});assert.equal(deleted.undo_supported,false);assert.deepEqual(f.calls.at(-1),{kind:'delete',uid:2,options:{uid:true}});
 const denied=imapFixture();denied.caps.delete('CONDSTORE');const deniedBefore=await denied.adapter.readState(denied.locator,'flag');await assert.rejects(()=>denied.adapter.apply({before:deniedBefore,operation:{kind:'flag'},reserve}),/CONDITIONAL_FLAGS_UNSUPPORTED/);assert.equal(denied.calls.length,0);
});

test('simultaneous execution and prepared/started crash recovery use one durable item reservation',async()=>{
 const f=httpFixture('gmail'),plan=await f.service.prepare({scope,account_id:f.binding.account.account_id,operation_id:randomUUID(),operation:{kind:'flag'},logical_ids:['a','b']});
 // Simulate a process death after its durable pre-I/O marker. No provider effect
 // can be inferred, and a later process must leave that item unknown.
 await f.journal.change(scope,plan.operation_id,async(value,write)=>{value.items[0].state='started';await write(value);});
 const results=await Promise.all([f.service.execute({scope,operation_id:plan.operation_id,expected_digest:plan.digest}),f.makeService().execute({scope,operation_id:plan.operation_id,expected_digest:plan.digest})]);assert.ok(results.every(result=>result.items[0].state==='unknown'));assert.equal(f.calls.filter(call=>call.method==='POST').length,1);assert.equal(results.at(-1).items[1].state,'succeeded');
});

test('encrypted durable POSIX triage journal survives reopening and cross-purpose key isolation',{skip:process.platform==='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'deft-triage-journal-'));try{const store=await createEmailFileCustodyStore({root}),f=httpFixture('gmail',{store}),{plan}=await run(f,{kind:'archive'});const reopened=createEmailTriageJournal({store:await createEmailFileCustodyStore({root}),encryption_key:Buffer.alloc(32,7),key_id:'triage-test'});assert.equal((await reopened.load(scope,plan.operation_id)).items[0].state,'succeeded');const wrong=createEmailTriageJournal({store,encryption_key:Buffer.alloc(32,8),key_id:'triage-test'});await assert.rejects(()=>wrong.load(scope,plan.operation_id),/JOURNAL_UNAVAILABLE/);}finally{await rm(root,{recursive:true,force:true});}
});


test('fresh Undo receives its own current authority deadline after original execution expiry',async()=>{
 const f=httpFixture('gmail');let tick=Date.now(),deadline=tick+1000,currentBinding=f.binding;
 const service=createEmailTriageService({journal:f.journal,now:()=>tick,
  resolveAuthority:async()=>({binding:currentBinding,actor:{kind:'human',user_id:scope.owner_id},expires_at:deadline}),
  resolveMessage:async({logical_id})=>({scope,account_id:f.binding.account.account_id,locator:f.locator(logical_id)}),adapterFor:async()=>f.adapter});
 const prepare=()=>service.prepare({scope,account_id:f.binding.account.account_id,operation_id:randomUUID(),operation:{kind:'archive'},logical_ids:['a']});
 const execute=plan=>service.execute({scope,operation_id:plan.operation_id,expected_digest:plan.digest});
 const original=await prepare();assert.equal((await execute(original)).items[0].state,'succeeded');
 const retained=structuredClone((await f.journal.load(scope,original.operation_id)).plan);
 tick=original.expires_at+1;deadline=tick+10000;
 const writes=f.calls.filter(call=>call.method!=='GET').length;
 await assert.rejects(()=>execute(original),/EMAIL_TRIAGE_PLAN_EXPIRED/);
 assert.equal(f.calls.filter(call=>call.method!=='GET').length,writes,'expired original execution is never renewed');
 const undoInput={scope,operation_id:original.operation_id,expected_digest:original.digest,undo_operation_id:randomUUID()};
 deadline=tick-1;await assert.rejects(()=>service.prepareUndo(undoInput),/EMAIL_TRIAGE_AUTHORITY_STALE/);
 deadline=tick+10000;currentBinding={...f.binding,action_binding_id:'changed-binding'};
 await assert.rejects(()=>service.prepareUndo(undoInput),/EMAIL_TRIAGE_AUTHORITY_STALE/);
 currentBinding=f.binding;
 const undo=await service.prepareUndo(undoInput);
 assert.equal(undo.expires_at,Math.min(deadline,tick+TRIAGE_LIMITS.ttl_ms));assert.ok(undo.expires_at>original.expires_at);
 assert.equal(undo.undo_of,original.digest);assert.deepEqual(undo.items.map(item=>item.logical_id),['a']);
 assert.deepEqual((await f.journal.load(scope,original.operation_id)).plan,retained,'original immutable plan and expired deadline remain unchanged');
 assert.equal((await execute(undo)).items[0].state,'succeeded');assert.ok(f.messages.get('a').labelIds.includes('INBOX'));
 const settledWrites=f.calls.filter(call=>call.method!=='GET').length;
 assert.equal((await execute(undo)).items[0].state,'succeeded');assert.equal(f.calls.filter(call=>call.method!=='GET').length,settledWrites,'new Undo replay cannot repeat a settled write');
 await assert.rejects(()=>execute(original),/EMAIL_TRIAGE_PLAN_EXPIRED/);
 deadline=tick+1000;const second=await prepare();await execute(second);tick=second.expires_at+1;deadline=tick+10000;
 const conflicted=await service.prepareUndo({scope,operation_id:second.operation_id,expected_digest:second.digest,undo_operation_id:randomUUID()});
 f.messages.get('a').labelIds.push('UNRELATED');const conflictWrites=f.calls.filter(call=>call.method!=='GET').length;
 const result=await execute(conflicted);assert.equal(result.items[0].state,'failed');assert.equal(result.items[0].code,'EMAIL_TRIAGE_CONFLICT');
 assert.equal(f.calls.filter(call=>call.method!=='GET').length,conflictWrites,'fresh authority still requires unchanged provider precondition');
});
