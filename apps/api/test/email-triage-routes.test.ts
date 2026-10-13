import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createEmailTriageRoutes} from '../src/routes/email-triage.js';
import {EmailNativeTriageError} from '../src/lib/email-native-triage.js';
const auth={authorization:'Bearer valid','content-type':'application/json'};
const logical='mail_'+'a'.repeat(64),operation=randomUUID();
function fixture(error?:Error,reconcile?:()=>Promise<unknown>){
 const calls:unknown[][]=[];const result={schema_version:'deft.email_native_triage_result.v1' as const,account_id:'account',operation_id:operation,operation:'mark_read' as const,
  items:[{logical_message_id:logical,state:'succeeded' as const,undo_supported:true}],automatic_retry:false as const,undo_available:true};
 const invoke=(kind:string)=>(async(...args:unknown[])=>{calls.push([kind,...args]);if(error)throw error;return result;});
 const routes=createEmailTriageRoutes({verify:async token=>{if(token!=='valid')throw Error('Invalid');return {id:'owner',org_id:'org',sid:'sid',exp:2_000_000_000};},
  triage:async()=>({apply:invoke('apply'),status:invoke('status'),undo:invoke('undo')}),reconcile,now:()=>1000});
 return {routes,calls,result};
}
test('triage HTTP pins verified owner, SID, account and logical ids; status recovers same operation without reapplying',async()=>{
 const f=fixture(),body={operation_id:operation,kind:'mark_read',logical_message_ids:[logical]};
 const applied=await f.routes.request('/accounts/account/operations',{method:'POST',headers:auth,body:JSON.stringify(body)});
 assert.equal(applied.status,200);assert.deepEqual(await applied.json(),f.result);
 assert.deepEqual(f.calls[0]?.slice(0,4),['apply',{user_id:'owner',web_session_id:'sid',access_expires_at:2_000_000_000_000},{org_id:'org',owner_user_id:'owner',account_id:'account'},body]);
 const status=await f.routes.request(`/accounts/account/operations/${operation}`,{headers:auth});assert.equal(status.status,200);assert.equal(f.calls.at(-1)?.[0],'status');
 assert.equal(status.headers.get('cache-control'),'no-store');
 const undo=randomUUID(),undone=await f.routes.request(`/accounts/account/operations/${operation}/undo`,{method:'POST',headers:auth,body:JSON.stringify({undo_operation_id:undo})});
 assert.equal(undone.status,200);assert.deepEqual(f.calls.at(-1)?.slice(3,5),[operation,undo]);
});
test('no owner/locator/provider/destination authority can be supplied by the caller, and bulk input is bounded',async()=>{
 const f=fixture(),body={operation_id:operation,kind:'star',logical_message_ids:[logical]};
 for(const value of [{...body,owner_user_id:'other'},{...body,provider:'gmail'},{...body,locator:{message_id:'raw'}},{...body,kind:'permanent_delete'},
  {...body,destination_id:'unneeded'},{...body,kind:'move'},{...body,logical_message_ids:[logical,logical]},
  {...body,logical_message_ids:Array.from({length:26},(_,i)=>'mail_'+i.toString(16).padStart(64,'0'))}]){
  assert.equal((await f.routes.request('/accounts/account/operations',{method:'POST',headers:auth,body:JSON.stringify(value)})).status,400);
 }
 assert.equal(f.calls.length,0);
 assert.equal((await f.routes.request('/accounts/account/operations',{method:'POST',headers:auth,body:'x'.repeat(16385)})).status,413);
 assert.equal((await f.routes.request(`/accounts/account/operations/${operation}?owner=other`,{headers:auth})).status,400);
 assert.equal((await f.routes.request(`/accounts/account/operations/${operation}`,{headers:{authorization:'Bearer invalid'}})).status,401);
 assert.equal(f.calls.length,0);
});
test('authority and durable-conflict errors are bounded, while provider secrets never enter response bodies',async()=>{
 for(const [error,status,code] of [[new EmailNativeTriageError('EMAIL_ACCESS_DENIED'),403,'EMAIL_ACCESS_DENIED'],
  [Error('EMAIL_TRIAGE_BUSY'),409,'EMAIL_TRIAGE_BUSY'],[Error('provider token=private'),503,'EMAIL_TRIAGE_UNAVAILABLE']] as const){
  const response=await fixture(error).routes.request(`/accounts/account/operations/${operation}`,{headers:auth});
  assert.equal(response.status,status);assert.deepEqual(await response.json(),{code});
 }
});

test('successful triage and Undo request cache reconciliation without disguising completed effects on queue failure',async()=>{
 let wakes=0;const f=fixture(undefined,async()=>{wakes++;throw Error('cache temporarily offline');});
 const response=await f.routes.request('/accounts/account/operations',{method:'POST',headers:auth,body:JSON.stringify({operation_id:operation,kind:'mark_read',logical_message_ids:[logical]})});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),f.result);assert.equal(wakes,1);
 await f.routes.request(`/accounts/account/operations/${operation}`,{headers:auth});assert.equal(wakes,1);
 const undone=await f.routes.request(`/accounts/account/operations/${operation}/undo`,{method:'POST',headers:auth,body:JSON.stringify({undo_operation_id:randomUUID()})});
 assert.equal(undone.status,200);assert.equal(wakes,2);
});

test('native labels accept sixteen bounded sealed nominations and25 targets while other kinds retain16KiB',async()=>{
 const f=fixture(),base='/accounts/account/operations',body={operation_id:operation,kind:'labels',label_action:'add',destination_ids:Array.from({length:16},(_,i)=>String(i).padStart(8192,'A')),logical_message_ids:Array.from({length:25},(_,i)=>'mail_'+i.toString(16).padStart(64,'0'))};
 const accepted=await f.routes.request(base,{method:'POST',headers:auth,body:JSON.stringify(body)});assert.equal(accepted.status,200);assert.deepEqual(f.calls[0]?.[3],body);
 const old={operation_id:operation,kind:'star',logical_message_ids:[logical]};assert.equal((await f.routes.request(base,{method:'POST',headers:auth,body:JSON.stringify(old)+' '.repeat(16384)})).status,413);
 assert.equal((await f.routes.request(base,{method:'POST',headers:auth,body:JSON.stringify(body)+' '.repeat(160*1024)})).status,413);
 for(const bad of [{...body,label_action:'replace'},{...body,destination_ids:[]},{...body,destination_ids:Array(17).fill('nomination')},{...body,destination_id:'extra'},{...body,kind:'star'},{...body,destination_ids:['dup','dup']}])assert.equal((await f.routes.request(base,{method:'POST',headers:auth,body:JSON.stringify(bad)})).status,bad.kind==='star'?413:400);
 assert.equal(f.calls.length,1);
});

test('M23 recovery wire accepts bounded kinds only, no destinations, and unsupported is400 without account denial',async()=>{
 for(const kind of ['spam','not_spam','restore']){const f=fixture(),body={operation_id:operation,kind,logical_message_ids:[logical]},r=await f.routes.request('/accounts/account/operations',{method:'POST',headers:auth,body:JSON.stringify(body)});assert.equal(r.status,200);assert.deepEqual(f.calls[0]![3],body);
  const before=f.calls.length;for(const extra of [{destination_id:'sealed'},{provider:'gmail'},{label_action:'add',destination_ids:['sealed']}])assert.equal((await f.routes.request('/accounts/account/operations',{method:'POST',headers:auth,body:JSON.stringify({...body,...extra})})).status,400);assert.equal(f.calls.length,before);
  assert.equal((await f.routes.request('/accounts/account/operations',{method:'POST',headers:auth,body:JSON.stringify(body)+' '.repeat(16384)})).status,413);
 }
 const unavailable=fixture(new EmailNativeTriageError('EMAIL_TRIAGE_OPERATION_UNSUPPORTED'));const r=await unavailable.routes.request('/accounts/account/operations',{method:'POST',headers:auth,body:JSON.stringify({operation_id:operation,kind:'spam',logical_message_ids:[logical]})});assert.equal(r.status,400);assert.deepEqual(await r.json(),{code:'EMAIL_TRIAGE_OPERATION_UNSUPPORTED'});
});
