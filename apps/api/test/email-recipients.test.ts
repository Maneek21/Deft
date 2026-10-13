import assert from 'node:assert/strict';
import test from 'node:test';
import {createEmailRecipientRoutes} from '../src/routes/email-recipients.js';
import {EmailRecipientError} from '../src/lib/email-recipient-assistance.js';
test('recipient HTTP derives scope from authenticated session and nomination path, with no-store',async()=>{
 let calls=0;const app=createEmailRecipientRoutes({now:()=>1000,verify:async()=>({id:'owner',org_id:'org',sid:'sid',exp:10}),service:async()=>({query:async(actor,scope,input)=>{calls++;assert.deepEqual(actor,{user_id:'owner',web_session_id:'sid',access_expires_at:10000});assert.deepEqual(scope,{org_id:'org',owner_user_id:'owner',account_id:'account'});assert.deepEqual(input,{query:'Ada',limit:10});return {account_id:'account',query:'Ada',items:[],sources:{contacts:'not_installed',recent:'available'},has_more:false};}})});
 const request=(body:unknown,auth=true)=>app.request('/accounts/account/recipients/query',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer token'}:{})},body:JSON.stringify(body)});
 const okay=await request({query:' Ada '});assert.equal(okay.status,200);assert.equal(okay.headers.get('Cache-Control'),'no-store');assert.equal(calls,1);
 assert.equal((await request({query:'a',owner_user_id:'other'})).status,400);assert.equal((await request({query:'a'},false)).status,401);assert.equal(calls,1);
});
test('recipient HTTP expiry and fresh authority rejection do not leak source details',async()=>{
 const app=createEmailRecipientRoutes({now:()=>1000,verify:async()=>({id:'owner',org_id:'org',sid:'sid',exp:10}),service:async()=>({query:async()=>{throw new EmailRecipientError('EMAIL_RECIPIENT_ACCESS_DENIED');}})});
 const response=await app.request('/accounts/account/recipients/query',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer token'},body:'{"query":"a"}'});assert.equal(response.status,403);assert.deepEqual(await response.json(),{code:'EMAIL_RECIPIENT_ACCESS_DENIED'});
});
