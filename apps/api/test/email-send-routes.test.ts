import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createEmailSendRoutes} from '../src/routes/email-send.js';
import {EmailNativeSendError} from '../src/lib/email-native-send-service.js';
const draft=randomUUID(),operation=randomUUID(),path=`/accounts/account/drafts/${draft}/send`,auth={authorization:'Bearer valid','content-type':'application/json'};
function fixture(error?:EmailNativeSendError,reconcile?:()=>Promise<unknown>){const calls:unknown[][]=[];
 const result={operation_id:operation,draft_id:draft,draft_revision:2,state:'accepted' as const};
 const invoke=(name:string)=>async(...args:unknown[])=>{calls.push([name,...args]);if(error)throw error;return result;};
 const routes=createEmailSendRoutes({verify:async token=>{if(token!=='valid')throw Error();return {id:'owner',org_id:'org',sid:'sid',exp:2_000_000_000};},
  send:async()=>({send:invoke('send'),status:invoke('status')}),reconcile,now:()=>1000});return {routes,calls,result};}
test('Send HTTP accepts only exact saved revision and session account; status does not send again',async()=>{
 const f=fixture(),sent=await f.routes.request(path,{method:'POST',headers:auth,body:JSON.stringify({expected_revision:2})});
 assert.equal(sent.status,200);assert.deepEqual(await sent.json(),f.result);
 assert.deepEqual(f.calls[0]?.slice(0,5),['send',{user_id:'owner',web_session_id:'sid',access_expires_at:2_000_000_000_000},{org_id:'org',owner_user_id:'owner',account_id:'account'},draft,2]);
 const read=await f.routes.request(path+'/2',{headers:auth});assert.equal(read.status,200);assert.deepEqual(await read.json(),{operation:f.result});assert.equal(f.calls.at(-1)?.[0],'status');
 assert.equal(read.headers.get('cache-control'),'no-store');
});
test('Send endpoint cannot accept inline recipients, bytes, sender, identities or arbitrary operation IDs',async()=>{
 const f=fixture();for(const extra of [{to:'outside@example.test'},{mime_bytes:'spoof'},{from_address:'other@example.test'},{operation_id:randomUUID()},{owner_user_id:'other'}]){
  assert.equal((await f.routes.request(path,{method:'POST',headers:auth,body:JSON.stringify({expected_revision:2,...extra})})).status,400);
 }assert.equal(f.calls.length,0);
 assert.equal((await f.routes.request(path,{method:'POST',headers:{...auth,authorization:'Bearer invalid'},body:'{}'})).status,401);
});
test('size failure is explicit before sending; uncertain result directs caller to durable status',async()=>{
 for(const [code,status] of [['EMAIL_SEND_LIMIT_EXCEEDED',422],['EMAIL_SEND_UNKNOWN',409],['EMAIL_SEND_ACCESS_DENIED',403]] as const){
  const response=await fixture(new EmailNativeSendError(code)).routes.request(path,{method:'POST',headers:auth,body:JSON.stringify({expected_revision:2})});
  assert.equal(response.status,status);assert.deepEqual(await response.json(),{code});
 }
});

test('accepted Send remains accepted if cache reconciliation fails; status is side-effect free',async()=>{
 let wakes=0;const f=fixture(undefined,async()=>{wakes++;throw Error('cache temporarily offline');});
 const response=await f.routes.request(path,{method:'POST',headers:auth,body:JSON.stringify({expected_revision:2})});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),f.result);assert.equal(wakes,1);
 await f.routes.request(path+'/2',{headers:auth});assert.equal(wakes,1);
});
