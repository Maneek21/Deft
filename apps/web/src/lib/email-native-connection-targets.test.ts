import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeEmailConnectionTargets,nativeEmailConnectionKey,parseNativeEmailConnectionTargets,type NativeEmailConnectionTarget} from './email-native-connection-targets';
const binding='11111111-1111-4111-8111-111111111111';
const target:NativeEmailConnectionTarget={provider:'gmail',primary_address:'owner@example.com',display_label:'Work',native_email:{account_id:'trusted-account',resource_binding_id:binding,state:'available'}};
const page={targets:[target],has_more:false,unavailable_count:0};
const receipt={account_id:'trusted-account',provider:'gmail',state:'active',authority_revision:1};
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function fixture(fetch:(path:string,init:RequestInit)=>Promise<Response>){let active=true,adopted=0;const client=createNativeEmailConnectionTargets({fetch,current:()=>active,change:()=>{},adopted:()=>adopted++});return {client,end:()=>{active=false;},adopted:()=>adopted};}
test('retained catalog is closed, bounded and exposes only verified account/binding nominations and safe labels',()=>{
 assert.deepEqual(parseNativeEmailConnectionTargets(page),page);
 for(const value of [{...page,credential:'private'},{...page,targets:[target,target]},{...page,targets:Array(51).fill(target)},{...page,unavailable_count:-1},{...page,targets:[{...target,provider:'fake'}]},{...page,targets:[{...target,primary_address:'owner\nother'}]},{...page,targets:[{...target,native_email:{...target.native_email,token:'secret'}}]}])assert.throws(()=>parseNativeEmailConnectionTargets(value));
});
test('explicit adoption reuses existing account endpoint with binding nomination only, then reloads host account catalog callback',async()=>{
 const calls:{path:string;init:RequestInit}[]=[];const f=fixture(async(path,init)=>{calls.push({path,init});return response(init.method==='POST'?receipt:page);});await f.client.load();assert.equal(calls[0]!.path,'/api/email/connection-targets');assert.equal(calls[0]!.init.method,'GET');assert.equal(calls[0]!.init.cache,'no-store');
 await f.client.adopt(target);assert.equal(calls[1]!.path,'/api/email/accounts/trusted-account/adopt');assert.deepEqual(JSON.parse(calls[1]!.init.body as string),{resource_binding_id:binding});assert.equal(f.client.snapshot().targets[0]!.native_email.state,'active');assert.equal(f.adopted(),1);await f.client.adopt(target);assert.equal(calls.length,2);f.client.dispose();
});
test('lost adoption acknowledgment disables further POST until a fresh catalog read proves current setup, without OAuth retry',async()=>{
 let posts=0,reads=0;const f=fixture(async(_path,init)=>{if(init.method==='POST'){posts++;throw Error('lost');}reads++;return response(reads===1?page:{...page,targets:[{...target,native_email:{...target.native_email,state:'active'}}]});});await f.client.load();await f.client.adopt(target);assert.equal(posts,1);assert.deepEqual(f.client.snapshot().uncertain,[nativeEmailConnectionKey(target)]);await f.client.adopt(target);assert.equal(posts,1);assert.match(f.client.snapshot().notice,/Refresh connections/);await f.client.load();assert.equal(f.client.snapshot().targets[0]!.native_email.state,'active');assert.equal(f.client.snapshot().uncertain.length,0);assert.equal(posts,1);f.client.dispose();
});
test('adoption is serialized, refuses caller substitution and publishes no held old-session success',async()=>{
 let resolve!:(response:Response)=>void,posts=0;const f=fixture(async(_path,init)=>{if(init.method==='POST'){posts++;return new Promise(done=>{resolve=done;});}return response(page);});await f.client.load();await f.client.adopt({...target,native_email:{...target.native_email,account_id:'foreign'}});assert.equal(posts,0);
 const held=f.client.adopt(target);await f.client.adopt(target);assert.equal(posts,1);f.end();resolve(response(receipt));await held;assert.equal(f.adopted(),0);f.client.dispose();
});
test('fresh authority denial clears all retained labels/targets and stops later adoption',async()=>{
 let posts=0;const f=fixture(async(_path,init)=>{if(init.method==='POST'){posts++;return response({code:'EMAIL_ACCESS_DENIED'},403);}return response(page);});await f.client.load();await f.client.adopt(target);assert.equal(f.client.snapshot().state,'denied');assert.equal(f.client.snapshot().targets.length,0);assert.equal(f.client.snapshot().busy,false);await f.client.adopt(target);await f.client.load();assert.equal(posts,1);f.client.dispose();
});
test('provider/account/private acknowledgement mismatch and oversized success cannot enable a connection',async()=>{
 for(const ack of [{...receipt,provider:'microsoft'},{...receipt,account_id:'foreign'},{...receipt,private_locator:'hidden'},{...receipt,authority_revision:0}]){const f=fixture(async(_path,init)=>response(init.method==='POST'?ack:page));await f.client.load();await f.client.adopt(target);assert.equal(f.adopted(),0);assert.equal(f.client.snapshot().uncertain.length,1);f.client.dispose();}
 const large=fixture(async(_path,init)=>init.method==='POST'?new Response('x'.repeat(65537)):response(page));await large.client.load();await large.client.adopt(target);assert.equal(large.adopted(),0);assert.equal(large.client.snapshot().uncertain.length,1);large.client.dispose();
});
test('bounded catalog errors and late scope results never reveal another session connection list',async()=>{
 const oversized=fixture(async()=>new Response('x'.repeat(131073)));await oversized.client.load();assert.equal(oversized.client.snapshot().targets.length,0);assert.equal(oversized.client.snapshot().state,'failed');oversized.client.dispose();
 let resolve!:(response:Response)=>void;const held=fixture(()=>new Promise(done=>{resolve=done;}));const load=held.client.load();held.end();resolve(response(page));await load;assert.equal(held.client.snapshot().targets.length,0);held.client.dispose();
 const unavailable=fixture(async()=>response({...page,has_more:true,unavailable_count:2,targets:[{...target,native_email:{...target.native_email,state:'unavailable'}}]}));await unavailable.client.load();await unavailable.client.adopt(target);assert.equal(unavailable.client.snapshot().hasMore,true);assert.equal(unavailable.client.snapshot().unavailableCount,2);assert.equal(unavailable.adopted(),0);unavailable.client.dispose();
});
