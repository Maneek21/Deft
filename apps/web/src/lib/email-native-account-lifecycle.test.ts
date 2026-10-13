import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeAccountLifecycle,createNativeAccountManagement,parseNativeAccountLifecycle,parseNativeAccountManagement,nativeManagedAccountIdentity,type NativeAccountLifecycle} from './email-native-account-lifecycle';
const original:NativeAccountLifecycle={schema_version:'deft.email_account_lifecycle.v1',account_id:'account/one',provider:'gmail',authority_mode:'legacy',state:'active',revision:0,native_revision:8,credential_revision:3,capabilities:['read','send'],available_capabilities:['read','modify','send'],adoption_available:true,connection_available:true};
const adopted:NativeAccountLifecycle={...original,authority_mode:'standalone',revision:1,native_revision:9,adoption_available:false};
test('empty retained identity falls back only to the exact current account, keeping distinct accounts readable',()=>{
 const managed={...adopted,primary_address:'',display_label:''};const current=[{account_id:adopted.account_id,primary_address:'Ada@example.test',display_label:'Work'},{account_id:'other',primary_address:'other@example.test',display_label:''}];
 assert.equal(nativeManagedAccountIdentity(managed,current).primary_address,'Ada@example.test');assert.equal(nativeManagedAccountIdentity({...managed,account_id:'missing'},current).primary_address,'');assert.equal(nativeManagedAccountIdentity({...managed,primary_address:'retained@example.test'},current).primary_address,'retained@example.test');
});
test('successful pause with uninspected connection acknowledges stop then reads current connection, never rePOSTs',async()=>{
 let gets=0,writes=0;const paused={...adopted,state:'paused' as const,revision:2,native_revision:10};const s=setup(async(_path,init)=>{if(init.method==='PATCH'){writes++;return Response.json({...paused,connection_available:false});}return Response.json(++gets===1?adopted:paused);});await s.client.load();await s.client.apply('pause');assert.equal(writes,1);assert.equal(gets,2);assert.equal(s.client.snapshot().value?.state,'paused');assert.equal(s.client.snapshot().value?.connection_available,true);assert.equal(s.client.snapshot().needsReload,false);s.client.dispose();
});
function setup(fetch:(path:string,init:RequestInit)=>Promise<Response>,current=()=>true){let changes=0,denials=0;const client=createNativeAccountLifecycle({accountId:original.account_id,current,fetch,change:()=>{},changed:()=>{changes++;},denied:()=>{denials++;}});return {client,changes:()=>changes,denials:()=>denials};}
test('strict lifecycle projection pins account, mode revisions, read ownership and excludes private provider custody',()=>{
 assert.deepEqual(parseNativeAccountLifecycle(original,original.account_id),original);
 for(const raw of [{...original,account_id:'foreign'},{...original,revision:1},{...adopted,revision:0},{...original,capabilities:['send']},{...original,capabilities:['read','read']},{...original,credential_revision:0},{...original,provider_locator:'secret'},{...adopted,adoption_available:true}])assert.throws(()=>parseNativeAccountLifecycle(raw,original.account_id));
});
test('owner management projection keeps paused/disconnected/revoked identities available after active catalog removes them',async()=>{
 const accounts=['paused','disconnected','revoked'].map((state,index)=>({account_id:'account'+index,provider:'gmail',authority_mode:'standalone',state,revision:2,native_revision:10,primary_address:`owner${index}@example.com`,display_label:''}));let state:{accounts:unknown[]}|null=null;
 const client=createNativeAccountManagement({current:()=>true,fetch:async(path,init)=>{assert.equal(path,'/api/email/accounts/lifecycle');assert.equal(init.method,'GET');return Response.json({accounts,has_more:true});},change:value=>{state=value;}});
 await client.load();assert.deepEqual((state as unknown as {accounts:unknown[]}).accounts,accounts);assert.equal(parseNativeAccountManagement({accounts,has_more:true}).has_more,true);
 for(const page of [{accounts:[accounts[0],accounts[0]],has_more:false},{accounts,has_more:false,credential:'secret'},{accounts:[{...accounts[0],provider_ref:'secret'}],has_more:false}])assert.throws(()=>parseNativeAccountManagement(page));client.dispose();
});
test('explicit adoption sends both exact CAS revisions and only owner-selected available native capabilities',async()=>{
 const calls:RequestInit[]=[];const s=setup(async(path,init)=>{assert.equal(path,'/api/email/accounts/account%2Fone/lifecycle');calls.push(init);return Response.json(init.method==='GET'?original:adopted);});
 await s.client.load();assert.equal(calls.length,1);await s.client.apply('adopt',['read','send']);assert.deepEqual(JSON.parse(calls[1].body as string),{expected_revision:0,expected_native_revision:8,operation:'adopt',capabilities:['read','send']});assert.equal(s.client.snapshot().value?.authority_mode,'standalone');assert.equal(s.changes(),1);s.client.dispose();
});
test('missing read, unsupported capability and unavailable connection never issue lifecycle writes',async()=>{
 let writes=0;const s=setup(async(_path,init)=>{if(init.method==='PATCH')writes++;return Response.json({...original,available_capabilities:['read','send']});});await s.client.load();await s.client.apply('adopt',['send']);await s.client.apply('adopt',['read','modify']);await s.client.apply('pause');assert.equal(writes,0);s.client.dispose();
 const noConnection=setup(async(_p,init)=>{if(init.method==='PATCH')writes++;return Response.json({...adopted,state:'paused',connection_available:false});});await noConnection.client.load();await noConnection.client.apply('reconnect');assert.equal(writes,0);noConnection.client.dispose();
});
test('lost successful mutation acknowledgement permits GET recovery only before any further owner operation',async()=>{
 let row=adopted,writes=0;const s=setup(async(_path,init)=>{if(init.method==='PATCH'){writes++;row={...row,state:'paused',revision:2,native_revision:10};throw Error('Acknowledgement lost');}return Response.json(row);});
 await s.client.load();await s.client.apply('pause');assert.equal(s.client.snapshot().needsReload,true);await s.client.apply('pause');await s.client.apply('disconnect');assert.equal(writes,1);
 await s.client.load();assert.equal(s.client.snapshot().value?.state,'paused');assert.equal(s.client.snapshot().needsReload,false);assert.equal(s.changes(),1);assert.equal(writes,1);s.client.dispose();
});
test('unexpected acknowledged epoch/provider is not accepted as lifecycle success',async()=>{
 for(const wrong of [{...adopted,state:'paused',revision:2,native_revision:9},{...adopted,state:'paused',revision:2,native_revision:10,provider:'microsoft'}]){
  const s=setup(async(_path,init)=>Response.json(init.method==='GET'?adopted:wrong));await s.client.load();await s.client.apply('pause');assert.equal(s.changes(),0);assert.equal(s.client.snapshot().needsReload,true);assert.equal(s.client.snapshot().value?.state,'active');s.client.dispose();
 }
});
test('revoked accounts are terminal, and a read of paused state invalidates any loaded mailbox',async()=>{
 let writes=0;const s=setup(async(_path,init)=>{if(init.method==='PATCH')writes++;return Response.json({...adopted,state:'revoked'});});await s.client.load();for(const operation of ['adopt','consent','pause','disconnect','reconnect','revoke'] as const)await s.client.apply(operation,['read']);assert.equal(writes,0);assert.equal(s.changes(),1);s.client.dispose();
});
test('late held response after session change is discarded and permission denial clears projected account state',async()=>{
 let release!:(r:Response)=>void,current=true;const s=setup(async()=>new Promise(done=>{release=done;}),()=>current),held=s.client.load();current=false;s.client.dispose();const response=Response.json(adopted);release(response);await held;assert.equal(s.client.snapshot().value,null);assert.equal(s.changes(),0);
 let calls=0;const denied=setup(async()=>++calls===1?Response.json(adopted):new Response('',{status:403}));await denied.client.load();await denied.client.apply('pause');assert.equal(denied.client.snapshot().value,null);assert.equal(denied.denials(),1);denied.client.dispose();
});
test('held owner operation prevents overlapping lifecycle writes',async()=>{
 let release!:(r:Response)=>void,writes=0;const s=setup(async(_path,init)=>{if(init.method==='GET')return Response.json(adopted);writes++;return new Promise(done=>{release=done;});});await s.client.load();const held=s.client.apply('pause');await s.client.apply('disconnect');await s.client.load();assert.equal(writes,1);release(Response.json({...adopted,state:'paused',revision:2,native_revision:10}));await held;assert.equal(s.client.snapshot().busy,false);s.client.dispose();
});
test('management permission denial clears all cached management rows and invalidates loaded mailbox access',async()=>{
 let calls=0,ended=0,state:{accounts:unknown[]}|null=null;const account={account_id:adopted.account_id,provider:adopted.provider,authority_mode:adopted.authority_mode,state:adopted.state,revision:adopted.revision,native_revision:adopted.native_revision,primary_address:'owner@example.com',display_label:''};
 const client=createNativeAccountManagement({current:()=>true,fetch:async()=>++calls===1?Response.json({accounts:[account],has_more:false}):new Response('',{status:403}),change:value=>{state=value;},denied:()=>{ended++;}});await client.load();await client.load();assert.deepEqual((state as unknown as {accounts:unknown[]}).accounts,[]);assert.equal(ended,1);client.dispose();
});
