import test from 'node:test';
import assert from 'node:assert/strict';
import {emailProviderDraftSettingRequest,parseEmailProviderDraftSetting,EmailProviderDraftSettingError} from './email-provider-draft-settings';
const value={account_id:'a',enabled:false,revision:1,supported:true};
test('choice uses exact account path and explicit owner CAS, preserving default off',async()=>{
 const calls:{path:string;init:RequestInit}[]=[];const options={current:()=>true,fetch:async(path:string,init:RequestInit)=>{calls.push({path,init});return Response.json(init.method==='GET'?value:{...value,enabled:true,revision:2});}};
 assert.deepEqual(await emailProviderDraftSettingRequest('a',options),value);assert.deepEqual(await emailProviderDraftSettingRequest('a',options,{enabled:true,expected_revision:1}),{...value,enabled:true,revision:2});
 assert.ok(calls.every(call=>call.path==='/api/email/accounts/a/provider-draft-sync'));assert.deepEqual(JSON.parse(String(calls[1].init.body)),{enabled:true,expected_revision:1});assert.equal(calls[1].init.method,'PATCH');assert.equal(calls[1].init.cache,'no-store');
});
test('closed setting rejects foreign scope, locator injection, wrong enabled ack and revision jumps',async()=>{
 for(const raw of [{...value,account_id:'other'},{...value,provider_locator:'private'},{...value,revision:0},{...value,supported:'yes'}])assert.throws(()=>parseEmailProviderDraftSetting(raw,'a'));
 for(const ack of [{...value,revision:2},{...value,enabled:true,revision:4},{...value,enabled:true,revision:2,supported:false}])await assert.rejects(emailProviderDraftSettingRequest('a',{current:()=>true,fetch:async()=>Response.json(ack)},{enabled:true,expected_revision:1}));
});
test('lost patch response never retries; conflict and permission changes are distinct',async()=>{
 let calls=0;await assert.rejects(emailProviderDraftSettingRequest('a',{current:()=>true,fetch:async()=>{calls++;throw Error('lost');}},{enabled:true,expected_revision:1}));assert.equal(calls,1);
 for(const [status,kind] of [[409,'conflict'],[403,'denied'],[422,'unsupported']] as const)await assert.rejects(emailProviderDraftSettingRequest('a',{current:()=>true,fetch:async()=>new Response(null,{status})},{enabled:true,expected_revision:1}),(error:unknown)=>error instanceof EmailProviderDraftSettingError&&error.kind===kind);
});
test('held response cannot restore another session/account setting and response budget is bounded',async()=>{
 let current=true,release!:(response:Response)=>void;const pending=emailProviderDraftSettingRequest('a',{current:()=>current,fetch:()=>new Promise(resolve=>{release=resolve;})});current=false;release(Response.json(value));await assert.rejects(pending,(error:unknown)=>error instanceof EmailProviderDraftSettingError&&error.kind==='denied');
 await assert.rejects(emailProviderDraftSettingRequest('a',{current:()=>true,fetch:async()=>new Response('x'.repeat(8193))}));
});
