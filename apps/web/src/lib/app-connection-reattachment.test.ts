import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { ExistingAccountResult } from './app-connection-reattachment';
import { APP_CONNECTION_SESSION_PENDING_KEY, appConnectionContext, createAppConnectionSessionFlow } from './app-connection-session-flow';

const owner=randomUUID(),org=randomUUID(),installation=randomUUID(),source=randomUUID();
const now=Date.now(),expiry=new Date(now+600000).toISOString(),digest='sha256:'+'a'.repeat(64);
const scope={org_id:org,owner_user_id:owner,installation_id:installation,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),package_digest:digest,grant_snapshot_digest:digest,lifecycle_epoch:2,grant_epoch:2,target_key:'sender',resource_key:'inbox',resource_binding_id:randomUUID(),runtime_registration_id:randomUUID(),operator_user_id:randomUUID(),runtime_epoch:1,profile_digest:digest,consent_expires_at:expiry};
const identity={installationId:installation,experienceKey:'main',orgId:org,ownerId:owner,sessionTag:'d'.repeat(64)},account={account_ref:'owned_account',label:'Synthetic sender'};
const candidate={source_session_id:source,source_revision:4,account};
const profile={key:'gmail_readonly',label:'Gmail',authorization_origin:'https://accounts.google.com'};
const target={target_key:'sender',profile,scope,runtime_ready:true,session:null,reattachment:{candidate,pending:null}};
const resultState=(v:ExistingAccountResult)=>'state' in v?v.state:assert.fail('Expected session receipt');
const context=(t:unknown=target)=>({schema_version:'deft.app_connection_context.v1',installation_id:installation,org_id:org,owner_user_id:owner,targets:[t]});
function fixture(v2=false){
 const values=new Map<string,string>(),storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};
 const calls:{path:string;body:any}[]=[];let active=true,clock=now,currentTarget:any=structuredClone(target),review:any=null;
 if(v2)currentTarget.upgrade={candidate:null,pending:null};
 let answer:(path:string,body:any)=>unknown=()=>undefined;
 const fetch=async(path:string,init:RequestInit)=>{
  if(path.endsWith('/upgrade-context'))return Response.json({...context(currentTarget),schema_version:'deft.app_connection_upgrade_context.v1'});
  if(path.endsWith('/context'))return Response.json(v2?{...context(),targets:[]}:context(currentTarget));
  const body=JSON.parse(init.body as string);calls.push({path,body});const changed=answer(path,body);if(changed instanceof Response)return changed;if(changed!==undefined)return Response.json(changed);
  if(path.endsWith('/reattach/review')){review={schema_version:v2?'deft.app_connection_reattach_review.v2':'deft.app_connection_reattach_review.v1',...(v2?{action_consents:[]}: {}),session_id:body.request_id,source_session_id:source,source_revision:4,scope,account,custody_generation:1,review_digest:digest,expires_at:new Date(now+300000).toISOString()};currentTarget={...currentTarget,session:{schema_version:'deft.app_connection_session.v1',session_id:review.session_id,state:'indeterminate',scope,account:null,expires_at:expiry},reattachment:{candidate:null,pending:{session_id:review.session_id,state:'reattach_reviewed',activation_started:false,review}}};return Response.json(review);}
  if(path.endsWith('/reattach/activate')){return Response.json({schema_version:'deft.app_connection_session.v1',session_id:review.session_id,state:'connected',scope,account,expires_at:expiry});}
  if(path.endsWith('/reattach/status'))return Response.json(review);
  throw Error(path);
 };
 const ports={identity,storage,fetch,includeUpgrades:v2,current:()=>active,now:()=>clock};
 return{ports,calls,values,flow:createAppConnectionSessionFlow(ports),setActive:(v:boolean)=>{active=v;},setClock:(v:number)=>{clock=v;},setAnswer:(v:typeof answer)=>{answer=v;},setTarget:(v:any)=>{currentTarget=v;},getReview:()=>review,getTarget:()=>currentTarget};
}

test('current candidate context admits only closed own target metadata and exact pending review',()=>{
 assert.equal(appConnectionContext(context(),identity).targets[0].reattachment?.candidate?.account.label,account.label);
 for(const reattachment of [{candidate:{...candidate,source_session_id:'bad'},pending:null},{candidate,pending:{session_id:randomUUID(),state:'indeterminate',activation_started:false,review:null}},{candidate:{...candidate,account:{...account,token:'secret'}},pending:null}])assert.throws(()=>appConnectionContext(context({...target,reattachment}),identity));
});
test('review and activate use public exact nomination once with metadata intent recorded before dispatch',async()=>{
 const f=fixture();await f.flow.load();const reviewed=await f.flow.reviewExisting('sender');assert.equal(reviewed.schema_version,'deft.app_connection_reattach_review.v1');
 assert.deepEqual(f.calls[0].body,{installation_id:installation,target_key:'sender',source_session_id:source,request_id:reviewed.session_id});
 assert.equal(resultState(await f.flow.activateExisting('sender')),'connected');await assert.rejects(f.flow.activateExisting('sender'));assert.equal(f.calls.filter(c=>c.path.endsWith('/activate')).length,1);
 assert.doesNotMatch([...f.values.values()].join(''),/session_token|runtime_session_ref|authorization_url|custody_generation/);
});
test('lost review acknowledgement recovers exact request via status, never repeats review or OAuth',async()=>{
 const f=fixture();await f.flow.load();f.setAnswer((path)=>{if(path.endsWith('/review'))throw Error('lost');});await assert.rejects(f.flow.reviewExisting('sender'));await assert.rejects(f.flow.reviewExisting('sender'));
 const id=f.calls[0].body.request_id;f.setAnswer((path)=>path.endsWith('/status')?{schema_version:'deft.app_connection_reattach_review.v1',session_id:id,source_session_id:source,source_revision:4,scope,account,custody_generation:1,review_digest:digest,expires_at:new Date(now+300000).toISOString()}:undefined);
 const reloaded=createAppConnectionSessionFlow(f.ports);await reloaded.load();assert.equal((await reloaded.checkExisting('sender')).session_id,id);assert.equal(f.calls.filter(c=>c.path.endsWith('/review')).length,1);await assert.rejects(reloaded.begin('sender'));await assert.rejects(reloaded.check('sender'));await assert.rejects(reloaded.disconnect('sender'));assert.equal(f.calls.filter(c=>c.path.endsWith('/status')&&!c.path.includes('/reattach/')).length,0);
});
test('lost activation stays status-only across remount and rejects renewed eligible review',async()=>{
 const f=fixture();await f.flow.load();await f.flow.reviewExisting('sender');f.setAnswer(path=>{if(path.endsWith('/activate'))throw Error('lost');});await assert.rejects(f.flow.activateExisting('sender'));
 const reloaded=createAppConnectionSessionFlow(f.ports);await reloaded.load();await assert.rejects(reloaded.activateExisting('sender'));await assert.rejects(reloaded.checkExisting('sender'));assert.equal(f.calls.filter(c=>c.path.endsWith('/activate')).length,1);
 f.setAnswer(path=>path.endsWith('/status')?{schema_version:'deft.app_connection_session.v1',session_id:f.getReview().session_id,state:'connected',scope,account,expires_at:expiry}:undefined);assert.equal(resultState(await reloaded.checkExisting('sender')),'connected');
});
test('foreign scope/account/source or stale response cannot expose a review or activate',async()=>{
 for(const change of [{scope:{...scope,owner_user_id:randomUUID()}},{account:{...account,account_ref:'foreign'}},{source_session_id:randomUUID()},{source_revision:5}]){
  const f=fixture();await f.flow.load();f.setAnswer((path,body)=>path.endsWith('/review')?{schema_version:'deft.app_connection_reattach_review.v1',session_id:body.request_id,source_session_id:source,source_revision:4,scope,account,custody_generation:1,review_digest:digest,expires_at:new Date(now+300000).toISOString(),...change}:undefined);await assert.rejects(f.flow.reviewExisting('sender'));await assert.rejects(f.flow.activateExisting('sender'));assert.equal(f.calls.length,1);
 }
 const f=fixture();await f.flow.load();f.setActive(false);await assert.rejects(f.flow.reviewExisting('sender'));assert.equal(f.calls.length,0);
});
test('expired unactivated review resolves status before fresh nomination; ambiguous activation never reopens',async()=>{
 const f=fixture();await f.flow.load();const reviewed=await f.flow.reviewExisting('sender');f.setClock(now+300001);await assert.rejects(f.flow.activateExisting('sender'));
 f.setAnswer(path=>path.endsWith('/status')?{schema_version:'deft.app_connection_session.v1',session_id:reviewed.session_id,state:'not_connected',scope,account:null,expires_at:expiry}:undefined);assert.equal(resultState(await f.flow.checkExisting('sender')),'not_connected');
 f.setTarget({...target,session:{schema_version:'deft.app_connection_session.v1',session_id:reviewed.session_id,state:'not_connected',scope,account:null,expires_at:expiry}});await f.flow.load();assert.ok(await f.flow.reviewExisting('sender'));assert.equal(f.calls.filter(c=>c.path.endsWith('/review')).length,2);
});
test('host activation_started fence survives another browser',async()=>{
 const f=fixture();await f.flow.load();await f.flow.reviewExisting('sender');const other=fixture();other.setTarget({...f.getTarget(),reattachment:{candidate:null,pending:{...f.getTarget().reattachment.pending,activation_started:true,review:null}}});await other.flow.load();await assert.rejects(other.flow.activateExisting('sender'));await assert.rejects(other.flow.begin('sender'));assert.equal(other.calls.length,0);
});

test('held reuse responses after disposal/visibility/session change or fresh catalog replacement are discarded',async()=>{
 for(const boundary of ['dispose','current','catalog']){
  const f=fixture();await f.flow.load();let release!:(value:Response)=>void;
  const original=f.ports.fetch;
  f.ports.fetch=async(path,init)=>path.endsWith('/reattach/review')?new Promise<Response>(resolve=>{release=resolve;}):original(path,init);
  const flow=createAppConnectionSessionFlow(f.ports);await flow.load();const operation=flow.reviewExisting('sender');await Promise.resolve();
  const values=[...f.values.values()],id=JSON.parse(values[0]).session_id;
  if(boundary==='dispose')flow.dispose();else if(boundary==='current')f.setActive(false);else {f.setTarget({...target,scope:{...scope,grant_epoch:3}});await flow.load();}
  release(Response.json({schema_version:'deft.app_connection_reattach_review.v1',session_id:id,source_session_id:source,source_revision:4,scope,account,custody_generation:1,review_digest:digest,expires_at:new Date(now+300000).toISOString()}));
  await assert.rejects(operation);assert.equal(JSON.parse([...f.values.values()][0]).phase,'reviewing');
 }
});
test('storage failure fences review and activation before any remote mutation',async()=>{
 const f=fixture(),blocked=createAppConnectionSessionFlow({...f.ports,storage:{...f.ports.storage,setItem:()=>{throw Error('denied');}}});await blocked.load();await assert.rejects(blocked.reviewExisting('sender'));assert.equal(f.calls.length,0);
 await f.flow.load();await f.flow.reviewExisting('sender');const reloaded=createAppConnectionSessionFlow({...f.ports,storage:{...f.ports.storage,setItem:()=>{throw Error('denied');}}});await reloaded.load();await assert.rejects(reloaded.activateExisting('sender'));assert.equal(f.calls.filter(c=>c.path.endsWith('/activate')).length,0);
});
test('same owner independent targets cannot inherit source account or reuse session across catalogs',async()=>{
 const f=fixture();await f.flow.load();const value=await f.flow.reviewExisting('sender');
 const recipient={...target,target_key:'recipient',scope:{...scope,target_key:'recipient'},reattachment:{candidate:{...candidate,source_session_id:randomUUID(),account:{account_ref:'recipient_account',label:'Synthetic recipient'}},pending:null}};
 f.setTarget(recipient);await f.flow.load();await assert.rejects(f.flow.activateExisting('sender'));await assert.rejects(f.flow.checkExisting('recipient'));assert.equal(f.calls.length,1);
 assert.ok('account' in value);assert.equal(value.account?.account_ref,'owned_account');
});

test('fresh no-candidate context still permits ordinary OAuth independently of reuse',async()=>{
 const f=fixture();f.setTarget({...target,reattachment:{candidate:null,pending:null}});await f.flow.load();
 const nonce='s'.repeat(43),session=randomUUID();f.setAnswer(path=>path.endsWith('/begin')?{schema_version:'deft.app_connection_session.v1',session_id:session,state:'awaiting_callback',scope,expires_at:expiry,account:null,callback_state:nonce,authorization_url:`https://accounts.google.com/o/oauth2/v2/auth?state=${nonce}`}:undefined);
 assert.match(await f.flow.begin('sender'),/^https:\/\/accounts.google.com\//);assert.equal(f.calls.filter(c=>c.path.endsWith('/begin')).length,1);
});
test('candidate or request replacement in status cannot substitute a foreign account',async()=>{
 const f=fixture();await f.flow.load();const reviewed=await f.flow.reviewExisting('sender');
 for(const change of [{session_id:randomUUID()},{account:{account_ref:'other_owned_target',label:'Other account'}},{scope:{...scope,target_key:'recipient'}}]){
  f.setAnswer(path=>path.endsWith('/status')?{schema_version:'deft.app_connection_session.v1',session_id:reviewed.session_id,state:'connected',scope,account,expires_at:expiry,...change}:undefined);await assert.rejects(f.flow.checkExisting('sender'));
 }
 assert.equal(f.calls.filter(c=>c.path.endsWith('/activate')).length,0);
});

test('host nomination admits exact expired unconsumed OAuth pointer, but never a consumed/foreign/live one',async()=>{
 const past=new Date(now-1000).toISOString(),oauthId=randomUUID(),expired={schema_version:'deft.app_connection_session.v1',session_id:oauthId,state:'awaiting_callback',scope,account:null,expires_at:past};
 for(const phase of ['awaiting_callback','consumed']){
  const f=fixture();f.setTarget({...target,session:expired});f.ports.storage.setItem(APP_CONNECTION_SESSION_PENDING_KEY,JSON.stringify({...identity,schema_version:'deft.app_connection_pending.v1',targetKey:'sender',phase,connectionSessionId:oauthId,scope,state:'s'.repeat(43),expiresAt:past,accountRef:null}));await f.flow.load();
  if(phase==='awaiting_callback'){assert.ok(await f.flow.reviewExisting('sender'));assert.equal(f.ports.storage.getItem(APP_CONNECTION_SESSION_PENDING_KEY),null);}
  else{await assert.rejects(f.flow.reviewExisting('sender'));assert.equal(f.calls.length,0);}
 }
 assert.throws(()=>appConnectionContext(context({...target,session:{...expired,expires_at:expiry}}),identity));
 assert.throws(()=>appConnectionContext(context({...target,session:{...expired,account}}),identity));
});

test('completed old-version intent stays historical and cannot block or authorize a new reviewed scope',async()=>{
 const f=fixture();await f.flow.load();await f.flow.reviewExisting('sender');await f.flow.activateExisting('sender');
 const nextScope={...scope,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),grant_epoch:3,lifecycle_epoch:3,resource_binding_id:randomUUID(),runtime_registration_id:randomUUID()},nextSource=randomUUID();
 f.setTarget({...target,scope:nextScope,reattachment:{candidate:{...candidate,source_session_id:nextSource},pending:null}});await f.flow.load();assert.equal(f.flow.existingPending('sender'),false);
 f.setAnswer((path,body)=>path.endsWith('/review')?{schema_version:'deft.app_connection_reattach_review.v1',session_id:body.request_id,source_session_id:nextSource,source_revision:4,scope:nextScope,account,custody_generation:2,review_digest:digest,expires_at:new Date(now+300000).toISOString()}:undefined);
 const next=await f.flow.reviewExisting('sender');assert.equal(next.scope.app_version_id,nextScope.app_version_id);assert.equal(f.values.size,2);assert.notEqual(f.calls[0].body.request_id,f.calls[2].body.request_id);
});

test('v2 reuse survives lost activation ACK and reload using original session ID without OAuth',async()=>{
 const f=fixture(true);await f.flow.load();const reviewed=await f.flow.reviewExisting('sender');assert.equal(reviewed.schema_version,'deft.app_connection_reattach_review.v2');
 f.setAnswer(path=>{if(path.endsWith('/activate'))throw Error('lost');});await assert.rejects(f.flow.activateExisting('sender'));
 const connected={schema_version:'deft.app_connection_session.v1',session_id:reviewed.session_id,state:'connected',scope,account,expires_at:expiry};
 f.setTarget({...f.getTarget(),session:connected,reattachment:{candidate:null,pending:null}});
 const reload=createAppConnectionSessionFlow(f.ports);await reload.load();assert.equal(reload.existingPending('sender'),true);
 await assert.rejects(reload.activateExisting('sender'));await assert.rejects(reload.begin('sender'));
 f.setAnswer(path=>path.endsWith('/reattach/status')?connected:undefined);assert.equal(resultState(await reload.checkExisting('sender')),'connected');
 assert.equal(f.calls.filter(c=>c.path.endsWith('/activate')).length,1);assert.equal(f.calls.filter(c=>c.path.endsWith('/review')).length,1);
 assert.equal(f.calls.at(-1)!.body.session_id,reviewed.session_id);assert.equal(reload.existingPending('sender'),false);
});
test('v2 target rejects a v1 review relabel and ordinary v1 target rejects v2 purposes',async()=>{
 for(const v2 of [false,true]){const f=fixture(v2);await f.flow.load();f.setAnswer((path,body)=>path.endsWith('/review')?{
  schema_version:v2?'deft.app_connection_reattach_review.v1':'deft.app_connection_reattach_review.v2',...(!v2?{action_consents:[]}:{}),session_id:body.request_id,source_session_id:source,source_revision:4,scope,account,custody_generation:1,review_digest:digest,expires_at:new Date(now+300000).toISOString()}:undefined);
 await assert.rejects(f.flow.reviewExisting('sender'));assert.equal(f.calls.length,1);}
});

test('ordinary typed action review mismatch closes only its newly undispatched review intent',async()=>{
 const f=fixture();await f.flow.load();f.setAnswer(()=>Response.json({code:'APP_REVIEW_REQUIRED',reason:'runtime_action_review_mismatch',phase:'before_dispatch'},{status:409}));
 await assert.rejects(f.flow.reviewExisting('sender'),/current action operator setup/);assert.equal(f.flow.existingPending('sender'),false);assert.equal(f.calls.length,1);assert.equal(f.calls[0].path.endsWith('/reattach/review'),true);
});
test('ordinary generic review conflict remains unresolved without typed pre-dispatch evidence',async()=>{
 const f=fixture();await f.flow.load();f.setAnswer(()=>Response.json({code:'APP_REVIEW_REQUIRED'},{status:409}));
 await assert.rejects(f.flow.reviewExisting('sender'));assert.equal(f.flow.existingPending('sender'),true);assert.equal(f.calls.length,1);
});

test('ordinary explicit close validates the same unstarted review receipt without replaying setup',async()=>{
 const f=fixture();await f.flow.load();f.setAnswer(()=>Response.json({code:'APP_ACCESS_DENIED'},{status:403}));await assert.rejects(f.flow.reviewExisting('sender'));assert.equal(f.flow.canCloseUnstartedExistingReview('sender'),true);
 f.setAnswer((path,body)=>{assert.ok(path.endsWith('/reattach/close-unstarted'));return Response.json({schema_version:'deft.app_connection_unstarted_review_closed.v1',session_id:body.request_id,scope,state:'not_started',provider_dispatched:false});});
 await f.flow.closeUnstartedExistingReview('sender');assert.equal(f.flow.existingPending('sender'),false);assert.equal(f.calls.length,2);assert.equal(f.calls.some(call=>call.path.endsWith('/activate')),false);
});
test('ordinary reviewed durable request cannot use unstarted closure',async()=>{
 const f=fixture();await f.flow.load();await f.flow.reviewExisting('sender');assert.equal(f.flow.canCloseUnstartedExistingReview('sender'),false);await assert.rejects(f.flow.closeUnstartedExistingReview('sender'));assert.equal(f.calls.length,1);assert.equal(f.flow.existingPending('sender'),true);
});

test('ordinary status readback of exact closure receipt resolves an unstarted local review',async()=>{
 const f=fixture();await f.flow.load();f.setAnswer(()=>Response.json({code:'APP_ACCESS_DENIED'},{status:403}));await assert.rejects(f.flow.reviewExisting('sender'));
 const requestId=f.calls[0].body.request_id;f.setAnswer(path=>{assert.ok(path.endsWith('/reattach/status'));return {schema_version:'deft.app_connection_unstarted_review_closed.v1',session_id:requestId,scope,state:'not_started',provider_dispatched:false};});
 const receipt=await f.flow.checkExisting('sender');assert.equal(receipt.schema_version,'deft.app_connection_unstarted_review_closed.v1');assert.equal(f.flow.existingPending('sender'),false);assert.equal(f.calls.length,2);
});
