import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmailImapSetupRoutes} from '../src/routes/email-imap-setup.js';
const profile={host:'imap.example.test',port:993,transport:'implicit_tls',username:'owner@example.test',password:'synthetic-secret',identity:{primary_address:'owner@example.test',display_label:'Account'}};
const body={resource_binding_id:'10000000-0000-4000-8000-000000000001',expected_revision:0,profile};
const request=(data:unknown=body)=>({method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify(data)});
test('IMAP setup HTTP pins authenticated owner and returns no credentials with no-store',async()=>{
 let calls=0;const route=createEmailImapSetupRoutes({verify:async()=>({id:'owner',org_id:'org',sid:'sid',exp:Date.now()/1000+600}),setup:async(actor,org,input)=>{
  calls++;assert.equal(actor.user_id,'owner');assert.equal(org,'org');assert.equal(input.account_id,'mail');assert.equal(input.profile.password,'synthetic-secret');
  return {account_id:'mail',provider:'imap_smtp',state:'active',authority_revision:1};
 }});
 const result=await route.request('/accounts/mail/imap-setup',request());assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');assert.equal((await result.text()).includes('secret'),false);assert.equal(calls,1);
 const invalid=await route.request('/accounts/mail/imap-setup',request({...body,profile:{...profile,verified_at:new Date().toISOString()}}));assert.equal(invalid.status,400);assert.equal(calls,1);
 assert.equal((await route.request('/accounts/mail/imap-setup?password=x',request())).status,400);
 assert.equal((await route.request('/accounts/mail/imap-setup',{method:'POST'})).status,401);
});
test('IMAP setup HTTP redacts provider failure details',async()=>{
 const route=createEmailImapSetupRoutes({verify:async()=>({id:'owner',org_id:'org',sid:'sid',exp:Date.now()/1000+600}),setup:async()=>{throw Error('auth failed synthetic-secret');}});
 const result=await route.request('/accounts/mail/imap-setup',request());assert.equal(result.status,422);assert.deepEqual(await result.json(),{code:'EMAIL_IMAP_SETUP_FAILED'});
});
