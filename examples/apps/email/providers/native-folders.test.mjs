import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createNativeEmailFoldersBridge} from './native-folders.mjs';
import {createAppConnectionAdapter} from './connection-http.mjs';
import {createEncryptedEmailCustody} from './custody-encrypted.mjs';
import {createOAuthProvider} from './oauth-provider.mjs';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const hash=id=>createHash('sha256').update(JSON.stringify({kind:'gmail_label_membership_v1',id})).digest('hex');
async function fixture(provider='gmail',modify=true){
 const scope={org_id:'org-folders',owner_id:'owner-folders',installation_id:'installation-folders'},binding={scope,account_id:'folder-account',provider,
  connection_target:'trusted-folder-target',resource_binding_id:'folder-binding',action_binding_id:modify?'real-modify-binding':null,authority_epoch:1,capabilities:modify?['read','modify']:['read']};
 const rows=new Map(),custody=createEncryptedEmailCustody({encryption_key:new Uint8Array(32).fill(38),key_id:'folder-test',store:{async withLock({key},work){return work({async read(){return structuredClone(rows.get(key)??null);},async compareAndSwap({expected_revision,value}){const old=rows.get(key);if((old?.revision??null)!==expected_revision)return false;rows.set(key,{revision:(old?.revision??0)+1,value:structuredClone(value)});return true;}});}}});
 const client={client_id:'synthetic-folder-client',client_secret:'synthetic-folder-secret',redirect_uri:'https://fixture.invalid/email/connections/callback',...(provider==='microsoft'?{tenant:'common'}:{})};
 let handler=()=>json({labels:[{id:'INBOX',name:'Inbox',type:'system'},{id:'UNREAD',name:'Unread',type:'system'},{id:'CATEGORY_SOCIAL',name:'Social',type:'system'},{id:'custom-private',name:'Résumé',type:'user'}]}),live=true;const calls=[];
 const fetch=async(url,init)=>{calls.push({url,init});assert.ok(['GET','POST','PATCH'].includes(init.method));assert.equal(init.redirect,'error');return handler(url,init);};
 await custody.withAccount(binding,async tx=>tx.write({health:'connected',secret:{access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_at:Date.now()+3600000,
  scopes:provider==='gmail'?['openid','email','https://www.googleapis.com/auth/gmail.readonly',...(modify?['https://www.googleapis.com/auth/gmail.modify']:[])]:['offline_access','User.Read',modify?'Mail.ReadWrite':'Mail.Read'],
  client_fingerprint:createOAuthProvider({provider,client,fetch}).client_fingerprint,identity:{provider_subject:'verified-folder-principal',primary_address:'owner@example.test',display_label:'Folders',verified_sender_identities:[]}}}));
 const {scope:ignored,...options}=binding;const adapter=await createAppConnectionAdapter({options:{...options,origin:'https://fixture.invalid',clients:{[provider]:client}},custody,fetch,
  host:{resolveContext:async()=>assert.fail('No Experience projection'),assertCurrent:async()=>assert.fail('No Experience review')}});
 const context={org_id:scope.org_id,owner_user_id:scope.owner_id,installation_id:scope.installation_id,account_id:binding.account_id,
  resource_binding_id:binding.resource_binding_id,authority_version:'current-folders',expires_at:Date.now()+60000,recheck:async()=>{if(!live)throw Error('Revoked');}};
 return {adapter,context,calls,set handler(fn){handler=fn;},deny(){live=false;},async revoke(){await custody.withAccount(binding,async tx=>{const row=tx.read();await tx.write({health:'revoked',secret:{...row.secret,access_token:'discarded',refresh_token:'discarded',expires_at:0},advance_setup:true});});}};
}
test('registered Gmail catalog uses canonical/opaque cache membership IDs and current modify lookup',async()=>{
 const f=await fixture(),first=await f.adapter.nativeEmailFolders({cursor:null,limit:1},f.context);
 assert.deepEqual(first.items.map(row=>[row.folder_id,row.label]),[['inbox','Inbox']]);assert.equal(first.has_more,true);
 const second=await f.adapter.nativeEmailFolders({cursor:first.next_cursor,limit:1},f.context);
 assert.equal(second.items[0].folder_id,'label:'+hash('custom-private'));assert.equal(second.items[0].move_allowed,true);assert.equal(second.items[0].labels_allowed,true);assert.equal(second.has_more,false);
 f.handler=()=>json({id:'custom-private',name:'Résumé',type:'user'});
 assert.deepEqual(await f.adapter.nativeEmailDestination({id:'custom-private'},f.context),{account_id:'folder-account',provider:'gmail',id:'custom-private',kind:'label'});
 const noModify=await fixture('gmail',false);await assert.rejects(noModify.adapter.nativeEmailDestination({id:'custom-private'},noModify.context));assert.equal(noModify.calls.length,0);
});
test('Gmail catalog mutation resets paging and reserved/system destinations never become Move',async()=>{
 const f=await fixture(),first=await f.adapter.nativeEmailFolders({cursor:null,limit:1},f.context);
 f.handler=()=>json({labels:[{id:'INBOX',name:'Inbox',type:'system'},{id:'new',name:'New',type:'user'}]});
 await assert.rejects(f.adapter.nativeEmailFolders({cursor:first.next_cursor,limit:1},f.context),/EMAIL_NATIVE_FOLDER_CATALOG_CHANGED/);
 f.handler=()=>json({id:'TRASH',name:'Trash',type:'system'});await assert.rejects(f.adapter.nativeEmailDestination({id:'TRASH'},f.context),/EMAIL_NATIVE_FOLDER_DESTINATION_DENIED/);
 f.handler=()=>json({id:'another',name:'Another',type:'user'});await assert.rejects(f.adapter.nativeEmailDestination({id:'custom-private'},f.context));
});
test('registered Graph catalog traverses nested hidden folders with bounded pages and canonical current IDs',async()=>{
 const f=await fixture('microsoft'),seen=[];
 f.handler=(href)=>{const url=new URL(href),path=url.pathname;seen.push(path);
  if(/^\/v1\.0\/me\/mailFolders\/(inbox|sentitems|junkemail|deleteditems|drafts|archive)$/u.test(path))return json({id:path.split('/').at(-1)+'-id'});
  if(path==='/v1.0/me/mailFolders'){assert.equal(url.searchParams.get('includeHiddenFolders'),'true');return json({value:[{id:'inbox-id',displayName:'Inbox',parentFolderId:'root',childFolderCount:1,isHidden:false}],
   '@odata.nextLink':'https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=next'});}
  if(path==='/v1.0/me/mailFolders/inbox-id/childFolders')return json({value:[{id:'hidden-child',displayName:'Hidden',parentFolderId:'inbox-id',childFolderCount:0,isHidden:true}]});
  throw Error('Unexpected Graph path');};
 const first=await f.adapter.nativeEmailFolders({cursor:null,limit:1},f.context);assert.equal(first.items[0].folder_id,'inbox');assert.equal(first.has_more,true);
 const second=await f.adapter.nativeEmailFolders({cursor:first.next_cursor,limit:1},f.context);assert.equal(second.items[0].parent_folder_id,'inbox');assert.equal(second.items[0].move_allowed,false);
 f.handler=href=>{assert.equal(new URL(href).searchParams.get('$skiptoken'),'next');return json({value:[{id:'custom',displayName:'Projects',parentFolderId:'root',childFolderCount:0,isHidden:false}]});};
 const third=await f.adapter.nativeEmailFolders({cursor:second.next_cursor,limit:1},f.context);assert.equal(third.has_more,false);
 const expected=createHash('sha256').update(JSON.stringify({kind:'microsoft_folder_membership_v1',id:'custom'})).digest('hex');assert.equal(third.items[0].folder_id,'folder:'+expected);
 assert.equal(seen.filter(path=>path.endsWith('/childFolders')).length,1);
 f.handler=()=>json({id:'custom',displayName:'Projects',parentFolderId:'root',childFolderCount:0,isHidden:false});
 assert.deepEqual(await f.adapter.nativeEmailDestination({id:'custom'},f.context),{account_id:'folder-account',provider:'microsoft',id:'custom',kind:'folder'});
});
test('folder next links cannot escape owner mailbox or make requests after late revocation',async()=>{
 const f=await fixture('microsoft');let entered;const ready=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{f.release=resolve;});
 f.handler=async href=>{if(new URL(href).pathname==='/v1.0/me/mailFolders'){entered();await held;return json({value:[],'@odata.nextLink':'https://graph.microsoft.com/v1.0/users/other/mailFolders'});}return json({id:'system-'+new URL(href).pathname.split('/').at(-1)});};
 const reading=f.adapter.nativeEmailFolders({cursor:null,limit:20},f.context);await ready;await f.revoke();f.release();await assert.rejects(reading);assert.equal(f.calls.length,7);
 const bad=await fixture('microsoft');bad.handler=href=>new URL(href).pathname==='/v1.0/me/mailFolders'?json({value:[],'@odata.nextLink':'https://attacker.invalid/folders'}):json({id:'system-'+new URL(href).pathname.split('/').at(-1)});
 await assert.rejects(bad.adapter.nativeEmailFolders({cursor:null,limit:20},bad.context),/EMAIL_PROVIDER_CURSOR_INVALID/);assert.equal(bad.calls.length,7);
});
test('warm Graph catalog reuses encrypted canonical mapping and accepts only same-parent OData links',async()=>{
 const f=await fixture('microsoft'),context={...f.context,provider_state:{read:async()=>({value:{system_folders:{'inbox-id':'inbox'}}}),stale:async()=>[]}};
 f.handler=href=>{
  const path=new URL(href).pathname;if(path==='/v1.0/me/mailFolders')return json({value:[{id:'inbox-id',displayName:'Inbox',parentFolderId:'root',childFolderCount:2,isHidden:false}]});
  if(path==='/v1.0/me/mailFolders/inbox-id/childFolders')return json({value:[{id:'a',displayName:'A',parentFolderId:'inbox-id',childFolderCount:0,isHidden:false}],
   '@odata.nextLink':"https://graph.microsoft.com/v1.0/me/mailFolders('inbox-id')/childFolders?$skiptoken=next"});
  assert.equal(path,"/v1.0/me/mailFolders('inbox-id')/childFolders");return json({value:[{id:'b',displayName:'B',parentFolderId:'inbox-id',childFolderCount:0,isHidden:false}]});
 };
 const first=await f.adapter.nativeEmailFolders({cursor:null,limit:1},context),second=await f.adapter.nativeEmailFolders({cursor:first.next_cursor,limit:1},context),third=await f.adapter.nativeEmailFolders({cursor:second.next_cursor,limit:1},context);
 assert.deepEqual([first,second,third].flatMap(page=>page.items.map(row=>row.id)),['inbox-id','a','b']);assert.equal(third.has_more,false);assert.equal(f.calls.length,3);
});
test('catalog HTTP fanout and cursor are explicitly bounded; malformed input and cancellation stop before HTTP',async()=>{
 const account={account_id:'synthetic',provider:'microsoft',health:'connected',authority_epoch:1,primary_address:'owner@example.test',display_label:'Folders',capabilities:['read'],verified_sender_identities:[],connection_target:'target',resource_binding_id:'binding',action_binding_id:null};let calls=0;
 const bridge=createNativeEmailFoldersBridge({runtime:async()=>({account,scope:{org_id:'o',owner_id:'u',installation_id:'i'},principal_digest:'a'.repeat(64),connection_revision:1,
  check:async()=>{},adapterOptions:{account,getAccessToken:async()=> 'synthetic',assertAuthority:async()=>true,fetch:async href=>{calls++;return new URL(href).pathname==='/v1.0/me/mailFolders'?json({value:[], '@odata.nextLink':'https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken='+calls}):json({id:'special-'+calls});}}})});
 const page=await bridge.nativeEmailFolders({cursor:null,limit:100},{});assert.equal(calls,10);assert.equal(page.items.length,0);assert.equal(page.has_more,true);
 const f=await fixture();await assert.rejects(f.adapter.nativeEmailFolders({cursor:null,limit:0},f.context));await assert.rejects(f.adapter.nativeEmailFolders({cursor:null,limit:10},{...f.context,signal:AbortSignal.abort()}));assert.equal(f.calls.length,0);
});

test('M24 registered Gmail management nominates only user labels and validates create/rename under fresh modify custody',async()=>{
 const f=await fixture(),ordinary=await f.adapter.nativeEmailFolders({cursor:null,limit:20},f.context);assert.equal(ordinary.management,undefined);assert.ok(ordinary.items.every(row=>!Object.hasOwn(row,'rename_allowed')));
 const management=await f.adapter.nativeEmailFolders({cursor:null,limit:20,management:true},f.context);assert.equal(management.management,true);assert.deepEqual(management.items.map(row=>[row.id,row.rename_allowed]),[['INBOX',false],['custom-private',true]]);
 f.handler=(url,init)=>{const path=new URL(url).pathname;if(init.method==='GET')return json({id:'custom-private',name:'Résumé',type:'user'});assert.ok(['POST','PATCH'].includes(init.method));assert.equal(init.headers['Content-Type'],'application/json');const body=JSON.parse(init.body);assert.deepEqual(Object.keys(body),['name']);return json({id:'custom-private',name:body.name,type:'user'});};
 const created=await f.adapter.nativeEmailFolderManage({kind:'create',name:'Business'},f.context);assert.equal(created.label,'Business');
 const renamed=await f.adapter.nativeEmailFolderManage({kind:'rename',id:'custom-private',expected_name:'Résumé',name:'Renamed'},f.context);assert.equal(renamed.label,'Renamed');assert.equal(f.calls.filter(row=>row.init.method!=='GET').length,2);
 f.handler=()=>json({id:'INBOX',name:'Inbox',type:'system'});await assert.rejects(f.adapter.nativeEmailFolderManage({kind:'rename',id:'INBOX',expected_name:'Inbox',name:'Unsafe'},f.context),/TARGET_CHANGED/);assert.equal(f.calls.filter(row=>row.init.method!=='GET').length,2);
});
test('M24 Graph protected17 lookups are opt-in, reject unknown/incomplete eligibility and preserve ordinary catalogue costs',async()=>{
 const f=await fixture('microsoft');const row={id:'custom',displayName:'Projects',parentFolderId:'root',childFolderCount:0,isHidden:false};
 f.handler=url=>new URL(url).pathname==='/v1.0/me/mailFolders'?json({value:[row]}):json({id:new URL(url).pathname.split('/').at(-1)+'-system'});
 const ordinary=await f.adapter.nativeEmailFolders({cursor:null,limit:20},f.context);assert.equal(f.calls.length,7);assert.equal(ordinary.items[0].rename_allowed,undefined);
 const before=f.calls.length,management=await f.adapter.nativeEmailFolders({cursor:null,limit:20,management:true},f.context);assert.equal(f.calls.length-before,18);assert.equal(management.items[0].rename_allowed,true);
 f.handler=url=>new URL(url).pathname==='/v1.0/me/mailFolders'?json({value:[{...row,id:'outbox-system'}]}):json({id:new URL(url).pathname.split('/').at(-1)+'-system'});assert.equal((await f.adapter.nativeEmailFolders({cursor:null,limit:20,management:true},f.context)).items[0].rename_allowed,false);
 f.handler=url=>new URL(url).pathname==='/v1.0/me/mailFolders'?json({value:[row]}):new URL(url).pathname.endsWith('/clutter')?json({},503):json({id:new URL(url).pathname.split('/').at(-1)+'-system'});assert.equal((await f.adapter.nativeEmailFolders({cursor:null,limit:20,management:true},f.context)).items[0].rename_allowed,false);
 assert.equal(f.calls.filter(row=>row.init.method!=='GET').length,0);
});
test('M24 Graph create/rename writes only exact current ordinary target; hidden/search/system and name races never write',async()=>{
 const f=await fixture('microsoft'),ordinary={id:'custom',displayName:'Projects',parentFolderId:'root',childFolderCount:0,isHidden:false};let target=ordinary;
 f.handler=(url,init)=>{const path=new URL(url).pathname;if(init.method==='POST'){assert.equal(path,'/v1.0/me/mailFolders');assert.deepEqual(JSON.parse(init.body),{displayName:'Business',isHidden:false});return json({...ordinary,displayName:'Business'},201);}if(init.method==='PATCH'){assert.equal(path,'/v1.0/me/mailFolders/custom');assert.deepEqual(JSON.parse(init.body),{displayName:'Renamed'});return json({...ordinary,displayName:'Renamed'});}return json(path.endsWith('/custom')||path.endsWith('/outbox-system')?target:{id:path.split('/').at(-1)+'-system'});};
 await f.adapter.nativeEmailFolderManage({kind:'create',name:'Business'},f.context);await f.adapter.nativeEmailFolderManage({kind:'rename',id:'custom',expected_name:'Projects',name:'Renamed'},f.context);const writes=f.calls.filter(row=>row.init.method!=='GET').length;assert.equal(writes,2);
 for(const changed of [{displayName:'Outside change'},{isHidden:true},{'@odata.type':'#microsoft.graph.mailSearchFolder'}]){target={...ordinary,...changed};await assert.rejects(f.adapter.nativeEmailFolderManage({kind:'rename',id:'custom',expected_name:'Projects',name:'Unsafe'},f.context),/TARGET_CHANGED/);}
 target={...ordinary,id:'outbox-system'};await assert.rejects(f.adapter.nativeEmailFolderManage({kind:'rename',id:'outbox-system',expected_name:'Projects',name:'Unsafe'},f.context),/TARGET_CHANGED/);assert.equal(f.calls.filter(row=>row.init.method!=='GET').length,writes);
});
test('M24 create lost/rejected responses differ, scope abort/revocation and invalid Unicode cannot emit another effect',async()=>{
 const f=await fixture();f.handler=()=>json({},400);await assert.rejects(f.adapter.nativeEmailFolderManage({kind:'create',name:'Business'},f.context),/PROVIDER_REJECTED/);
 f.handler=()=>json({},503);await assert.rejects(f.adapter.nativeEmailFolderManage({kind:'create',name:'Business'},f.context),/OUTCOME_UNKNOWN/);const writes=f.calls.length;
 for(const name of [' padded','x'.repeat(129),'bad\u0000name','\ud800'])await assert.rejects(f.adapter.nativeEmailFolderManage({kind:'create',name},f.context));assert.equal(f.calls.length,writes);
 await assert.rejects(f.adapter.nativeEmailFolderManage({kind:'create',name:'Business'},{...f.context,signal:AbortSignal.abort()}));assert.equal(f.calls.length,writes);
 f.deny();await assert.rejects(f.adapter.nativeEmailFolderManage({kind:'create',name:'Business'},f.context));assert.equal(f.calls.length,writes);
 const read=await fixture('gmail',false);await assert.rejects(read.adapter.nativeEmailFolderManage({kind:'create',name:'Business'},read.context));assert.equal(read.calls.length,0);
});

// Gmail mutation responses may omit resource type; catalogue/pre-rename remain strict.
test('M24 mutation-only Gmail response parser accepts omitted type for create and already verified user rename',async()=>{
 const f=await fixture();f.handler=(_url,init)=>init.method==='GET'?json({id:'custom-private',name:'Before',type:'user'}):json({id:'custom-private',name:JSON.parse(init.body).name});
 const created=await f.adapter.nativeEmailFolderManage({kind:'create',name:'Business'},f.context);assert.deepEqual(created,{id:'custom-private',label:'Business',kind:'label',folder_id:'label:'+hash('custom-private')});
 assert.equal(f.calls.filter(row=>row.init.method!=='GET').length,1);
});
test('M24 mutation-only Gmail rename accepts omitted type after a strict current user pre-read',async()=>{
 const f=await fixture();f.handler=(_url,init)=>init.method==='GET'?json({id:'custom-private',name:'Before',type:'user'}):json({id:'custom-private',name:JSON.parse(init.body).name});
 const renamed=await f.adapter.nativeEmailFolderManage({kind:'rename',id:'custom-private',expected_name:'Before',name:'Renamed'},f.context);assert.equal(renamed.label,'Renamed');assert.equal(f.calls.filter(row=>row.init.method!=='GET').length,1);
});
test('M24 mutation response still rejects system type, wrong names and malformed or mismatched IDs after one effect',async()=>{
 for(const response of [{id:'custom-private',name:'Business',type:'system'},{id:'custom-private',name:'Other'},{name:'Business'},{id:'',name:'Business'},{id:'custom-private',name:'Business',type:null},{id:'custom-private',name:'Business',type:'unexpected'}]){
  const f=await fixture();f.handler=()=>json(response);await assert.rejects(f.adapter.nativeEmailFolderManage({kind:'create',name:'Business'},f.context),/EMAIL_NATIVE_FOLDER_OUTCOME_UNKNOWN/);assert.equal(f.calls.filter(row=>row.init.method!=='GET').length,1);
 }
 const rename=await fixture();rename.handler=(_url,init)=>init.method==='GET'?json({id:'custom-private',name:'Before',type:'user'}):json({id:'different',name:'Renamed'});
 await assert.rejects(rename.adapter.nativeEmailFolderManage({kind:'rename',id:'custom-private',expected_name:'Before',name:'Renamed'},rename.context),/EMAIL_NATIVE_FOLDER_OUTCOME_UNKNOWN/);assert.equal(rename.calls.filter(row=>row.init.method!=='GET').length,1);
});
test('M24 missing Gmail type is never accepted in catalogue, destination or pre-rename authority',async()=>{
 for(const action of ['catalogue','destination','rename']){const f=await fixture();f.handler=()=>json(action==='catalogue'?{labels:[{id:'custom-private',name:'Before'}]}:{id:'custom-private',name:'Before'});
  await assert.rejects(action==='catalogue'?f.adapter.nativeEmailFolders({cursor:null,limit:20,management:true},f.context):action==='destination'?f.adapter.nativeEmailDestination({id:'custom-private'},f.context):f.adapter.nativeEmailFolderManage({kind:'rename',id:'custom-private',expected_name:'Before',name:'Renamed'},f.context),/EMAIL_PROVIDER_RESPONSE_INVALID/);assert.equal(f.calls.filter(row=>row.init.method!=='GET').length,0);
 }
});
