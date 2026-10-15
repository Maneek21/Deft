import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { APP_CONNECTION_SESSION_PENDING_KEY, appConnectionCallbackUsesGeneric, appConnectionContext, appConnectionSessionTag, createAppConnectionSessionFlow, completeAppConnectionSession } from './app-connection-session-flow';

const owner=randomUUID(),org=randomUUID(),installation=randomUUID(),session=randomUUID(),nonce='s'.repeat(43),expiry=new Date(Date.now()+600_000).toISOString();
const scope={org_id:org,owner_user_id:owner,installation_id:installation,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),package_digest:'sha256:'+'a'.repeat(64),grant_snapshot_digest:'sha256:'+'b'.repeat(64),lifecycle_epoch:1,grant_epoch:1,target_key:'sender',resource_key:'inbox',resource_binding_id:randomUUID(),runtime_registration_id:randomUUID(),operator_user_id:randomUUID(),runtime_epoch:1,profile_digest:'sha256:'+'c'.repeat(64),consent_expires_at:expiry};
const profile={key:'gmail_readonly',label:'Gmail',authorization_origin:'https://accounts.google.com'};
const view={schema_version:'deft.app_connection_session.v1',session_id:session,state:'awaiting_callback',scope,expires_at:expiry,account:null};
const begun={...view,callback_state:nonce,authorization_url:`https://accounts.google.com/o/oauth2/v2/auth?state=${nonce}`};
const connected={...view,state:'connected',account:{account_ref:'owned_handle',label:'Synthetic sender'}};
const identity={installationId:installation,experienceKey:'main',orgId:org,ownerId:owner,sessionTag:'d'.repeat(64)};
const context=(sessionValue:unknown=null)=>({schema_version:'deft.app_connection_context.v1',installation_id:installation,org_id:org,owner_user_id:owner,targets:[{target_key:'sender',profile,scope,runtime_ready:true,session:sessionValue}]});
function storage(){const rows=new Map<string,string>();return {getItem:(k:string)=>rows.get(k)??null,setItem:(k:string,v:string)=>{rows.set(k,v);},removeItem:(k:string)=>{rows.delete(k);}};}
function fixture(options:{begin?:unknown;current?:()=>boolean;status?:unknown}={}){const s=storage(),calls:string[]=[];let stored:unknown=null;const fetch=async(path:string,init:RequestInit)=>{calls.push(`${init.method??'GET'} ${path}`);if(path.endsWith('/context'))return Response.json(context(stored));if(path.endsWith('/begin')){assert.ok(s.getItem(APP_CONNECTION_SESSION_PENDING_KEY));stored=view;return Response.json(options.begin??begun);}if(path.endsWith('/callback')){stored=connected;return Response.json(connected);}if(path.endsWith('/status'))return Response.json(options.status??stored);if(path.endsWith('/disconnect')){stored={...view,state:'disconnected'};return Response.json(stored);}throw Error(path);};return{s,calls,fetch,ports:{storage:s,fetch,identity,current:options.current??(()=>true)}};}

test('actual account settings and callback select public generic flow before legacy dispatch',()=>{
 const settings=readFileSync(new URL('../components/apps/experience-connection-settings.tsx',import.meta.url),'utf8');
 const callback=readFileSync(new URL('../app/(app)/apps/connections/callback/page.tsx',import.meta.url),'utf8');
 assert.match(settings,/GenericConnectionSettings/);assert.match(settings,/createAppConnectionSessionFlow/);
 assert.match(callback,/completeAppConnectionSession\(/);assert.doesNotMatch(callback,/completeDirectEmailConnection|email-connection/);assert.ok(callback.indexOf('completeAppConnectionSession(')<callback.indexOf('const stored = sessionStorage.getItem(APP_CONNECTION_PENDING_KEY)'));
});
test('unknown generic pending permits an independent exact native/legacy callback; own nonce never downgrades',()=>{
 const stored=JSON.stringify({phase:'consumed',state:nonce});
 assert.equal(appConnectionCallbackUsesGeneric('?state=native&code=own',stored,true,false),false);
 assert.equal(appConnectionCallbackUsesGeneric('?state=legacy&code=own',stored,false,true),false);
 assert.equal(appConnectionCallbackUsesGeneric(`?state=${nonce}&code=own`,stored,true,true),true);
 assert.equal(appConnectionCallbackUsesGeneric('?state=foreign&code=own',stored,false,false),true);
 assert.equal(appConnectionCallbackUsesGeneric('?state=foreign&code=own','malformed',false,false),true);
});
test('32 closed metadata targets fit dedicated context budget; oversize context and mutation responses stay bounded',async()=>{
 const targets=Array.from({length:32},(_,i)=>{const target_key='t'.repeat(45)+'_'+String(i).padStart(2,'0'),wideScope={...scope,target_key,resource_key:'r'.repeat(48),lifecycle_epoch:2147483647,grant_epoch:2147483647,runtime_epoch:2147483647};return {target_key,profile:{key:'p'.repeat(48),label:'界'.repeat(200),authorization_origin:'https://'+'a'.repeat(501)+'.co'},scope:wideScope,runtime_ready:true,session:{...connected,session_id:randomUUID(),scope:wideScope,account:{account_ref:'a'.repeat(512),label:'界'.repeat(200)}}};});
 const value={...context(),targets},body=JSON.stringify(value);assert.ok(Buffer.byteLength(body)>131072);assert.ok(Buffer.byteLength(body)<262144);
 const f=fixture(),flow=createAppConnectionSessionFlow({...f.ports,fetch:async()=>new Response(body,{headers:{'Content-Type':'application/json'}})});assert.equal((await flow.load()).targets.length,32);
 const over=createAppConnectionSessionFlow({...f.ports,fetch:async()=>new Response(body+' '.repeat(262144),{headers:{'Content-Type':'application/json'}})});await assert.rejects(over.load());
 const small=createAppConnectionSessionFlow({...f.ports,fetch:async(path,init)=>path.endsWith('/begin')?new Response(JSON.stringify(begun)+' '.repeat(65536),{headers:{'Content-Type':'application/json'}}):f.fetch(path,init)});await small.load();await assert.rejects(small.begin('sender'));
});
test('current admitted context rejects foreign owner/install, duplicate target and incompatible session scope',()=>{
 assert.equal(appConnectionContext(context(),identity).targets.length,1);
 for(const bad of [{...context(),owner_user_id:randomUUID()},{...context(),installation_id:randomUUID()},{...context(),targets:[...context().targets,...context().targets]},context({...view,scope:{...scope,target_key:'recipient'}}),context({...connected,account:null})])assert.throws(()=>appConnectionContext(bad,identity));
});
test('session anchor survives same SID token rollover/auth epoch but denies another owner/SID',async()=>{
 assert.equal(await appConnectionSessionTag(`${org}:${owner}:sid:1`),await appConnectionSessionTag(`${org}:${owner}:sid:2`));
 assert.notEqual(await appConnectionSessionTag(`${org}:${owner}:sid:1`),await appConnectionSessionTag(`${org}:${owner}:other:1`));
 await assert.rejects(appConnectionSessionTag(`${org}:${owner}:legacy:1`));
});
test('Begin saves intent before public POST and only exact current origin, nonce, UUID and ISO expiry can navigate',async()=>{
 const f=fixture(),flow=createAppConnectionSessionFlow(f.ports);await flow.load();assert.equal(await flow.begin('sender'),begun.authorization_url);
 assert.match(f.calls[1],/^POST \/api\/app-connection-sessions\/begin$/);assert.doesNotMatch(f.s.getItem(APP_CONNECTION_SESSION_PENDING_KEY)!,/authorization_url|runtime_session_ref|synthetic-code|accessToken/);
 for(const bad of [{...begun,session_id:'experience-id'},{...begun,expires_at:Date.now()+60000},{...begun,authorization_url:begun.authorization_url+'&state='+nonce},{...begun,authorization_url:'https://evil.test/?state='+nonce},{...begun,scope:{...scope,owner_user_id:randomUUID()}},{...begun,callback_state:'x'.repeat(43)}]){
  const f=fixture({begin:bad}),flow=createAppConnectionSessionFlow(f.ports);await flow.load();await assert.rejects(flow.begin('sender'));assert.equal(f.calls.filter(x=>x.endsWith('/begin')).length,1);await assert.rejects(flow.begin('sender'));assert.equal(f.calls.filter(x=>x.endsWith('/begin')).length,1);
 }
});
test('lost Begin or durable awaiting/unknown status fences new attempts through reload',async()=>{
 const f=fixture();let posts=0;const fetch=async(path:string,init:RequestInit)=>{if(path.endsWith('/begin')){posts++;throw Error('lost');}return f.fetch(path,init);};
 const flow=createAppConnectionSessionFlow({...f.ports,fetch});await flow.load();await assert.rejects(flow.begin('sender'));await assert.rejects(flow.begin('sender'));assert.equal(posts,1);
 const reloaded=createAppConnectionSessionFlow({...f.ports,fetch});await reloaded.load();await assert.rejects(reloaded.begin('sender'));assert.equal(posts,1);
 for(const state of ['awaiting_callback','indeterminate']){const g=fixture();const flow=createAppConnectionSessionFlow({...g.ports,fetch:async(path,init)=>path.endsWith('/context')?Response.json(context({...view,state})):g.fetch(path,init)});await flow.load();await assert.rejects(flow.begin('sender'));assert.equal(g.calls.length,0);}
});
test('acknowledged callback clears only its pending pointer; reload never exchanges code again',async()=>{
 const f=fixture(),flow=createAppConnectionSessionFlow(f.ports);await flow.load();await flow.begin('sender');
 const result=await completeAppConnectionSession({...f.ports,search:`?state=${nonce}&code=synthetic-code`});assert.equal(result.state,'connected');
 await assert.rejects(completeAppConnectionSession({...f.ports,search:''}));assert.equal(f.calls.filter(x=>x.endsWith('/callback')).length,1);assert.equal(f.s.getItem(APP_CONNECTION_SESSION_PENDING_KEY),null);assert.doesNotMatch(f.calls.join('\n'),/app-experiences|\/api\/email/);
});
test('lost callback acknowledgement keeps consumed intent; reload checks exact session without repeating code exchange',async()=>{
 const f=fixture(),flow=createAppConnectionSessionFlow(f.ports);await flow.load();await flow.begin('sender');let exchanges=0;
 const fetch=async(path:string,init:RequestInit)=>{if(path.endsWith('/callback')){exchanges++;await f.fetch(path,init);throw Error('lost callback response');}return f.fetch(path,init);};
 await assert.rejects(completeAppConnectionSession({...f.ports,fetch,search:`?state=${nonce}&code=synthetic-code`}));
 assert.equal(JSON.parse(f.s.getItem(APP_CONNECTION_SESSION_PENDING_KEY)!).phase,'consumed');assert.doesNotMatch(f.s.getItem(APP_CONNECTION_SESSION_PENDING_KEY)!,/synthetic-code/);
 const result=await completeAppConnectionSession({...f.ports,fetch,search:`?state=${nonce}&code=synthetic-code`});assert.equal(result.state,'connected');assert.equal(exchanges,1);assert.equal(f.calls.filter(x=>x.endsWith('/status')).length,1);
});
test('two own targets connect separately after acknowledgement without inheriting nonce/account/session custody',async()=>{
 const s=storage(),rows=new Map<string,unknown>(),begins:unknown[]=[];const recipientScope={...scope,target_key:'recipient',resource_binding_id:randomUUID(),runtime_registration_id:randomUUID()};
 const recipientId=randomUUID(),recipientNonce='r'.repeat(43);
 const fetch=async(path:string,init:RequestInit)=>{
  const targets=[{target_key:'sender',profile,scope,runtime_ready:true,session:rows.get('sender')??null},{target_key:'recipient',profile,scope:recipientScope,runtime_ready:true,session:rows.get('recipient')??null}];
  if(path.endsWith('/context'))return Response.json({...context(),targets});
  const input=JSON.parse(init.body as string);
  if(path.endsWith('/begin')){begins.push(input);const recipient=input.target_key==='recipient',result={...begun,scope:recipient?recipientScope:scope,session_id:recipient?recipientId:session,callback_state:recipient?recipientNonce:nonce,authorization_url:`https://accounts.google.com/o/oauth2/v2/auth?state=${recipient?recipientNonce:nonce}`};const {callback_state:_nonce,authorization_url:_url,...view}=result;rows.set(input.target_key,view);return Response.json(result);}
  if(path.endsWith('/callback')){const recipient=input.session_id===recipientId,result={...connected,scope:recipient?recipientScope:scope,session_id:recipient?recipientId:session,account:{account_ref:recipient?'recipient_handle':'sender_handle',label:recipient?'Synthetic recipient':'Synthetic sender'}};rows.set(recipient?'recipient':'sender',result);return Response.json(result);}throw Error(path);
 };
 const ports={identity,storage:s,fetch,current:()=>true},flow=createAppConnectionSessionFlow(ports);await flow.load();await flow.begin('sender');await completeAppConnectionSession({...ports,search:`?state=${nonce}&code=first-code`});
 await flow.load();await flow.begin('recipient');const pending=JSON.parse(s.getItem(APP_CONNECTION_SESSION_PENDING_KEY)!);assert.equal(pending.connectionSessionId,recipientId);assert.equal(pending.state,recipientNonce);assert.equal(pending.scope.target_key,'recipient');assert.equal(pending.accountRef,null);
 await completeAppConnectionSession({...ports,search:`?state=${recipientNonce}&code=second-code`});assert.deepEqual(begins,[{installation_id:installation,target_key:'sender'},{installation_id:installation,target_key:'recipient'}]);
});
test('admitted dormant runtime never invokes Begin or falls back; scope/expiry drift cannot exchange callback',async()=>{
 const f=fixture();const flow=createAppConnectionSessionFlow({...f.ports,fetch:async(path,init)=>path.endsWith('/context')?Response.json({...context(),targets:[{...context().targets[0],runtime_ready:false}]}):f.fetch(path,init)});await flow.load();await assert.rejects(flow.begin('sender'));assert.equal(f.calls.length,0);
 for(const field of ['scope','expiry']){const g=fixture(),flow=createAppConnectionSessionFlow(g.ports);await flow.load();await flow.begin('sender');const pending=JSON.parse(g.s.getItem(APP_CONNECTION_SESSION_PENDING_KEY)!);if(field==='scope')pending.scope.runtime_epoch++;else pending.expiresAt=new Date(Date.parse(expiry)-1000).toISOString();g.s.setItem(APP_CONNECTION_SESSION_PENDING_KEY,JSON.stringify(pending));await assert.rejects(completeAppConnectionSession({...g.ports,search:`?state=${nonce}&code=synthetic-code`}));assert.equal(g.calls.filter(x=>x.endsWith('/callback')).length,0);}
});
test('storage failure prevents Begin and disposal rejects held context before disclosure',async()=>{
 const f=fixture(),flow=createAppConnectionSessionFlow({...f.ports,storage:{...f.s,setItem:()=>{throw Error('storage blocked');}}});await flow.load();await assert.rejects(flow.begin('sender'));assert.equal(f.calls.filter(x=>x.endsWith('/begin')).length,0);
 let release!:(v:Response)=>void;const held=createAppConnectionSessionFlow({...f.ports,fetch:()=>new Promise<Response>(resolve=>{release=resolve;})});const loading=held.load();await Promise.resolve();held.dispose();release(Response.json(context()));await assert.rejects(loading);
});
test('foreign nonce/owner/session anchor/expired intent cannot dispatch and code never persists',async()=>{
 for(const kind of ['nonce','owner','session','expired']){const f=fixture(),flow=createAppConnectionSessionFlow(f.ports);await flow.load();await flow.begin('sender');
  if(kind==='expired'){const p=JSON.parse(f.s.getItem(APP_CONNECTION_SESSION_PENDING_KEY)!);p.expiresAt=new Date(0).toISOString();f.s.setItem(APP_CONNECTION_SESSION_PENDING_KEY,JSON.stringify(p));}
  await assert.rejects(completeAppConnectionSession({...f.ports,identity:{...identity,...(kind==='owner'?{ownerId:randomUUID()}:kind==='session'?{sessionTag:'e'.repeat(64)}:{})},search:`?state=${kind==='nonce'?'x'.repeat(43):nonce}&code=synthetic-code`}));assert.equal(f.calls.filter(x=>x.endsWith('/callback')).length,0);assert.doesNotMatch(f.s.getItem(APP_CONNECTION_SESSION_PENDING_KEY)!,/synthetic-code/);
 }
});
test('held responses are discarded after scope disposal and account replacement status is denied',async()=>{
 let current=true;const f=fixture({current:()=>current});const flow=createAppConnectionSessionFlow({...f.ports,fetch:async(path,init)=>{const r=await f.fetch(path,init);if(path.endsWith('/begin'))current=false;return r;}});await flow.load();await assert.rejects(flow.begin('sender'));
 const g=fixture({status:{...connected,account:{account_ref:'foreign',label:'Other'}}}),ready=createAppConnectionSessionFlow(g.ports);await ready.load();await ready.begin('sender');await completeAppConnectionSession({...g.ports,search:`?state=${nonce}&code=synthetic-code`});await ready.load();await assert.rejects(ready.check('sender'));assert.equal(g.calls.filter(x=>x.endsWith('/begin')).length,1);
});
test('uncertain status/disconnect retains known account without granting retries or accepting another account',async()=>{
 const known={...connected,state:'indeterminate'};assert.equal(appConnectionContext(context(known),identity).targets[0].session?.account?.account_ref,'owned_handle');
 const f=fixture({status:known}),flow=createAppConnectionSessionFlow({...f.ports,fetch:async(path,init)=>path.endsWith('/context')?Response.json(context(connected)):f.fetch(path,init)});await flow.load();assert.equal((await flow.check('sender')).state,'indeterminate');await assert.rejects(flow.begin('sender'));await assert.rejects(flow.disconnect('sender'));
 const g=fixture({status:{...known,account:{account_ref:'foreign',label:'Other'}}}),blocked=createAppConnectionSessionFlow({...g.ports,fetch:async(path,init)=>path.endsWith('/context')?Response.json(context(connected)):g.fetch(path,init)});await blocked.load();await assert.rejects(blocked.check('sender'));
});
