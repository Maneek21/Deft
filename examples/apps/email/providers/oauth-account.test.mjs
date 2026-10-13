import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createEmailOAuth} from './oauth-account.mjs';
import {createEncryptedEmailCustody} from './custody-encrypted.mjs';
import {oauthAccountKey,sameOAuthBinding} from './oauth-contract.mjs';
import {createOAuthProvider,requestedOAuthScopes,grantedOAuthCapabilities,normalizeOAuthScopes} from './oauth-provider.mjs';

const scope={org_id:'org',owner_id:'owner',installation_id:'installation'},browser='trusted-session-binding';
const copy=value=>structuredClone(value),response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function memoryStore(){
 const rows=new Map(),queues=new Map();
 const store={rows,afterCallback:null,async withLock({key},callback){
  const previous=queues.get(key)??Promise.resolve(),done=defer();queues.set(key,done.promise);await previous;
  try{const result=await callback({async read(){return copy(rows.get(key)??null);},async compareAndSwap({expected_revision,value}){const prior=rows.get(key);if((prior?.revision??null)!==expected_revision)return false;rows.set(key,{revision:(prior?.revision??0)+1,value:copy(value)});return true;}});await store.afterCallback?.({key});return result;}finally{done.resolve();if(queues.get(key)===done.promise)queues.delete(key);}
 }};return store;
}
function fixture(){
 let time=1000000,authorityAllowed=true,authorityExpiry=null,refreshMode=null,exchangeScopes=null,exchangeSubject=null,afterFetch=null;
 const store=memoryStore(),key=Uint8Array.from({length:32},(_,i)=>i+1),bindings=new Map(),calls=[],tokens=new Map();
 const clients={gmail:{client_id:'google-client',client_secret:'google-secret',redirect_uri:'https://deft.example.test/email/callback/gmail',verify_aliases:true},microsoft:{client_id:'microsoft-client',client_secret:'microsoft-secret',redirect_uri:'https://deft.example.test/email/callback/microsoft',tenant:'common'}};
 for(const [account_id,provider] of [['google-a','gmail'],['google-b','gmail'],['graph-a','microsoft'],['graph-b','microsoft']])bindings.set(account_id,{scope,account_id,provider,connection_target:'target-'+account_id,resource_binding_id:'resource-'+account_id,action_binding_id:'action-'+account_id,authority_epoch:1,capabilities:['read','search','thread','send']});
 const now=()=>time;
 const host={async resolveAccount({scope:requested,account_id}){if(JSON.stringify(requested)!==JSON.stringify(scope))throw Error('foreign owner');return copy(bindings.get(account_id));},async assertAuthority({binding}){return {allowed:authorityAllowed&&sameOAuthBinding(binding,bindings.get(binding.account_id)),expires_at:authorityExpiry??time+300000};}};
 const fetch=async(url,init)=>{
  const parsed=new URL(url),form=init.body instanceof URLSearchParams?Object.fromEntries(init.body):null;
  calls.push({url,method:init.method,form,redirect:init.redirect});let result;
  if(parsed.pathname.endsWith('/token')){
   const id=form.grant_type==='authorization_code'?form.code:tokens.get(form.refresh_token)?.account_id;assert.ok(id,'mock token belongs to an account');
   if(form.grant_type==='refresh_token'&&refreshMode){const result=await refreshMode({id,form});if(result)return result;}
   const binding=bindings.get(id),access_token='access-'+id+'-'+calls.length,refresh_token='refresh-'+id+'-'+calls.length,subject=exchangeSubject??id;
   tokens.set(access_token,{account_id:id,subject});tokens.set(refresh_token,{account_id:id,subject});
   const requested=form.scope??'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send';
   result=response({access_token,refresh_token,token_type:'Bearer',expires_in:120,scope:exchangeScopes??requested,id_token:'caller-must-never-decode-this'});
   assert.equal(binding.provider==='gmail'?parsed.origin==='https://oauth2.googleapis.com':parsed.origin==='https://login.microsoftonline.com',true);
  }else if(url==='https://openidconnect.googleapis.com/v1/userinfo'){
   const token=tokens.get(init.headers.Authorization.slice(7));result=response({sub:token.subject,email:token.account_id+'@example.test',email_verified:true,name:token.account_id});
  }else if(parsed.pathname.endsWith('/profile')){
   const token=tokens.get(init.headers.Authorization.slice(7));result=response({emailAddress:token.account_id+'@example.test'});
  }else if(parsed.pathname.endsWith('/sendAs')){
   const token=tokens.get(init.headers.Authorization.slice(7));result=response({sendAs:[{sendAsEmail:'alias-'+token.account_id+'@example.test',verificationStatus:'accepted'},{sendAsEmail:'unverified@example.test',verificationStatus:'pending'}]});
  }else if(parsed.origin==='https://graph.microsoft.com'){
   const token=tokens.get(init.headers.Authorization.slice(7));result=response({id:token.subject,mail:token.account_id+'@example.test',displayName:token.account_id,userPrincipalName:'not-a-mailbox@elsewhere.test',proxyAddresses:['smtp:unchecked@example.test']});
  }else if(url==='https://oauth2.googleapis.com/revoke')result=new Response('',{status:200});
  else assert.fail('Unexpected provider URL '+url);
  if(afterFetch)await afterFetch({url,init,result});return result;
 };
 const custody=createEncryptedEmailCustody({encryption_key:key,key_id:'test-key',store,now}),oauth=createEmailOAuth({clients,host,custody,fetch,now});
 const begin=(id='google-a')=>oauth.begin({scope,account_id:id,browser_binding:browser});
 const complete=async(id='google-a',pending=null)=>{pending??=await begin(id);return oauth.complete({scope,state:new URL(pending.authorization_url).searchParams.get('state'),code:id,browser_binding:browser});};
 const token=(account,operation='read',service=oauth)=>service.getAccessToken({scope,account,account_id:account.account_id,operation,authority_epoch:account.authority_epoch});
 return {store,key,bindings,calls,tokens,custody,oauth,clients,host,fetch,now,begin,complete,token,setTime:value=>{time=value;},advance:ms=>{time+=ms;},deny:()=>{authorityAllowed=false;},expire:()=>{authorityExpiry=time;},setExchangeScopes:value=>{exchangeScopes=value;},setSubject:value=>{exchangeSubject=value;},setAfterFetch:fn=>{afterFetch=fn;},setRefreshMode:fn=>{refreshMode=fn;}};
}
const code=expected=>error=>error?.code===expected;

test('read/send scope compatibility and separate reviewed modify/permanent-delete ceilings',()=>{
 const read='https://www.googleapis.com/auth/gmail.readonly',send='https://www.googleapis.com/auth/gmail.send',modify='https://www.googleapis.com/auth/gmail.modify',full='https://mail.google.com/';
 const binding={provider:'gmail',capabilities:['read','search','thread','send']};
 assert.deepEqual(requestedOAuthScopes(binding),['openid','email',read,send]);
 const triage={...binding,capabilities:[...binding.capabilities,'modify']};
 assert.deepEqual(requestedOAuthScopes(triage),['openid','email',read,send,modify]);
 assert.equal(requestedOAuthScopes(triage).includes(full),false);
 const permanent={...triage,capabilities:[...triage.capabilities,'permanent_delete']};
 assert.ok(requestedOAuthScopes(permanent).includes(full));
 assert.deepEqual(grantedOAuthCapabilities(permanent,normalizeOAuthScopes('gmail',['openid','email',modify])),triage.capabilities);
 assert.deepEqual(grantedOAuthCapabilities(binding,normalizeOAuthScopes('gmail',[full])),binding.capabilities);
 const graph={provider:'microsoft',capabilities:['read','search','thread','modify','permanent_delete','send']};
 assert.ok(requestedOAuthScopes(graph).includes('https://graph.microsoft.com/Mail.ReadWrite'));
 assert.deepEqual(grantedOAuthCapabilities(graph,normalizeOAuthScopes('microsoft',['User.Read','Mail.ReadWrite'])),['read','search','thread','modify','permanent_delete']);
});

test('OAuth begin and callback enforce reviewed modify scope, partial consent and refresh reduction',async()=>{
 const f=fixture(),binding=f.bindings.get('google-a');binding.capabilities.push('modify','permanent_delete');
 const pending=await f.begin(),scopes=new URL(pending.authorization_url).searchParams.get('scope').split(' ');
 assert.ok(scopes.includes('https://www.googleapis.com/auth/gmail.modify'));assert.ok(scopes.includes('https://mail.google.com/'));
 f.setExchangeScopes('openid email https://www.googleapis.com/auth/gmail.modify');
 const account=await f.complete('google-a',pending);assert.deepEqual(account.capabilities,['read','search','thread','send','modify']);
 assert.ok(await f.token(account,'modify'));
 await assert.rejects(f.token(account,'permanent_delete'),code('EMAIL_OAUTH_ACCOUNT_BINDING_DENIED'));
 await assert.rejects(f.token({...account,capabilities:[...account.capabilities,'permanent_delete']},'permanent_delete'),code('EMAIL_OAUTH_SCOPE_REDUCED'));
 f.advance(100000);f.setExchangeScopes('openid email https://www.googleapis.com/auth/gmail.readonly');
 await assert.rejects(f.token(account,'modify'),code('EMAIL_OAUTH_SCOPE_REDUCED'));assert.ok(await f.token(account,'read'));
});

test('cached broader Google token cannot confer unreviewed modification and revocation fences modify',async()=>{
 const old=fixture();old.setExchangeScopes('openid email https://mail.google.com/');const account=await old.complete();
 assert.deepEqual(account.capabilities,['read','search','thread','send']);const count=old.calls.length;
 await assert.rejects(old.token(account,'modify'),code('EMAIL_OAUTH_ACCOUNT_BINDING_DENIED'));assert.equal(old.calls.length,count);
 const f=fixture();f.bindings.get('google-a').capabilities.push('modify');f.setExchangeScopes('openid email https://www.googleapis.com/auth/gmail.modify');const reviewed=await f.complete();
 f.deny();const before=f.calls.length;await assert.rejects(f.token(reviewed,'modify'),code('EMAIL_OAUTH_AUTHORITY_DENIED'));assert.equal(f.calls.length,before);
});

test('fixed provider OAuth URLs, exact redirects and S256 verifier remain server-owned',async()=>{
 const f=fixture(),pending=await f.begin(),url=new URL(pending.authorization_url);
 assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('access_type'),'offline');assert.equal(url.searchParams.get('include_granted_scopes'),'false');assert.equal(url.searchParams.get('redirect_uri'),f.clients.gmail.redirect_uri);assert.equal(url.searchParams.has('client_secret'),false);
 const serialized=JSON.stringify([...f.store.rows.values()]);assert.equal(serialized.includes('verifier'),false);assert.equal(serialized.includes(url.searchParams.get('state')),false);assert.equal(f.calls.length,0);
 const account=await f.complete('google-a',pending),exchange=f.calls[0];assert.equal(exchange.form.code,'google-a');assert.equal(createHash('sha256').update(exchange.form.code_verifier).digest('base64url'),url.searchParams.get('code_challenge'));assert.equal(exchange.form.redirect_uri,f.clients.gmail.redirect_uri);assert.equal(exchange.redirect,'error');assert.equal(account.primary_address,'google-a@example.test');assert.deepEqual(account.verified_sender_identities,['google-a@example.test','alias-google-a@example.test']);assert.equal(JSON.stringify(account).includes('access_token'),false);
 await assert.rejects(f.oauth.begin({scope,account_id:'google-a',browser_binding:browser,provider_url:'https://attacker.test'}),code('EMAIL_OAUTH_INPUT_INVALID'));
});

test('state binds owner/browser and is durably consumed before exchange; callback replay is inert',async()=>{
 const f=fixture(),pending=await f.begin(),state=new URL(pending.authorization_url).searchParams.get('state');
 await assert.rejects(f.oauth.complete({scope:{...scope,owner_id:'other'},state,code:'google-a',browser_binding:browser}),code('EMAIL_OAUTH_STATE_DENIED'));
 await assert.rejects(f.oauth.complete({scope,state,code:'google-a',browser_binding:'other-session'}),code('EMAIL_OAUTH_STATE_DENIED'));assert.equal(f.calls.length,0);
 await f.complete('google-a',pending);const count=f.calls.length;await assert.rejects(f.complete('google-a',pending),code('EMAIL_OAUTH_STATE_REPLAY'));assert.equal(f.calls.length,count);
});

test('expired state and changed current binding reject before provider disclosure',async()=>{
 const expired=fixture(),pending=await expired.begin();expired.advance(600001);await assert.rejects(expired.complete('google-a',pending),code('EMAIL_OAUTH_STATE_EXPIRED'));assert.equal(expired.calls.length,0);
 const changed=fixture(),next=await changed.begin();changed.bindings.get('google-a').authority_epoch++;await assert.rejects(changed.complete('google-a',next),code('EMAIL_OAUTH_STATE_AUTHORITY_CHANGED'));assert.equal(changed.calls.length,0);
});

test('two same-provider Google accounts, reconnect and local revoke have independent encrypted custody',async()=>{
 const f=fixture(),a=await f.complete('google-a'),b=await f.complete('google-b');assert.notEqual(await f.token(a),await f.token(b));
 const serialized=JSON.stringify([...f.store.rows.values()]);for(const sensitive of ['access-google','refresh-google','alias-google-a@example.test','provider_subject'])assert.equal(serialized.includes(sensitive),false);
 f.bindings.get('google-a').authority_epoch++;const reconnect=await f.complete('google-a');assert.equal(reconnect.account_id,a.account_id);assert.equal(reconnect.authority_epoch,2);await assert.rejects(f.token(a),code('EMAIL_OAUTH_ACCOUNT_BINDING_DENIED'));
 const before=f.calls.length;await f.oauth.disconnect({scope,account_id:'google-a'});assert.equal(f.calls.length,before);await assert.rejects(f.token(reconnect),code('EMAIL_OAUTH_REAUTH_REQUIRED'));assert.ok(await f.token(b));assert.equal(f.store.rows.get(oauthAccountKey(f.bindings.get('google-a'))).value.health,'revoked');
});

test('changed provider subject cannot replace a connected or locally revoked account',async()=>{
 const f=fixture();await f.complete();f.setSubject('another-provider-user');await assert.rejects(f.complete(),code('EMAIL_OAUTH_RECONNECT_IDENTITY_CHANGED'));
 await f.oauth.disconnect({scope,account_id:'google-a'});await assert.rejects(f.complete(),code('EMAIL_OAUTH_RECONNECT_IDENTITY_CHANGED'));assert.equal(f.store.rows.get(oauthAccountKey(f.bindings.get('google-a'))).value.health,'revoked');
});

test('local disconnect durably invalidates outstanding callback without changing host epoch',async()=>{
 const f=fixture();await f.complete();const pending=await f.begin(),epoch=f.bindings.get('google-a').authority_epoch;await f.oauth.disconnect({scope,account_id:'google-a'});const count=f.calls.length;
 await assert.rejects(f.complete('google-a',pending),code('EMAIL_OAUTH_SETUP_SUPERSEDED'));assert.equal(f.calls.length,count);assert.equal(f.bindings.get('google-a').authority_epoch,epoch);assert.equal((await f.custody.withAccount(f.bindings.get('google-a'),tx=>tx.read())).health,'revoked');
 await assert.rejects(f.complete('google-a',pending),code('EMAIL_OAUTH_STATE_REPLAY'));const fresh=await f.complete();assert.equal(fresh.health,'connected');assert.ok(await f.token(fresh));
});

test('a newer begin supersedes an older callback before any provider exchange',async()=>{
 const f=fixture(),old=await f.begin(),current=await f.begin();await assert.rejects(f.complete('google-a',old),code('EMAIL_OAUTH_SETUP_SUPERSEDED'));assert.equal(f.calls.length,0);assert.equal((await f.complete('google-a',current)).health,'connected');
});

test('begin under a newer host epoch does not rebind old tokens before verified reconnect',async()=>{
 const f=fixture(),account=await f.complete();f.bindings.get('google-a').authority_epoch=2;const pending=await f.begin(),stored=await f.custody.withAccount(f.bindings.get('google-a'),tx=>tx.read());assert.equal(stored.binding.authority_epoch,1);await assert.rejects(f.token({...account,authority_epoch:2}),code('EMAIL_OAUTH_REAUTH_REQUIRED'));const reconnected=await f.complete('google-a',pending);assert.equal(reconnected.authority_epoch,2);assert.ok(await f.token(reconnected));
});

test('disconnect racing begin state publication prevents that callback from restoring custody',async()=>{
 const f=fixture();await f.complete();const held=defer(),release=defer();let once=true;
 f.store.afterCallback=async({key})=>{if(once&&key.startsWith('email.oauth.account.')){once=false;held.resolve();await release.promise;}};
 const beginning=f.begin();await held.promise;const disconnecting=f.oauth.disconnect({scope,account_id:'google-a'});release.resolve();const pending=await beginning;await disconnecting;const count=f.calls.length;
 await assert.rejects(f.complete('google-a',pending),code('EMAIL_OAUTH_SETUP_SUPERSEDED'));assert.equal(f.calls.length,count);assert.equal((await f.custody.withAccount(f.bindings.get('google-a'),tx=>tx.read())).health,'revoked');
});

test('disconnect queued behind an exchanging callback leaves final custody revoked',async()=>{
 const f=fixture(),account=await f.complete();const pending=await f.begin(),held=defer(),release=defer();let once=true;
 f.setAfterFetch(async({url})=>{if(once&&url==='https://oauth2.googleapis.com/token'){once=false;held.resolve();await release.promise;}});
 const completing=f.complete('google-a',pending);await held.promise;const disconnecting=f.oauth.disconnect({scope,account_id:'google-a'});release.resolve();await completing;await disconnecting;
 assert.equal((await f.custody.withAccount(f.bindings.get('google-a'),tx=>tx.read())).health,'revoked');const count=f.calls.length;await assert.rejects(f.token(account),code('EMAIL_OAUTH_REAUTH_REQUIRED'));assert.equal(f.calls.length,count);
});

test('provider grant revoke also supersedes pending setup while leaving another account independent',async()=>{
 const f=fixture();await f.complete('google-a');const b=await f.complete('google-b'),pending=await f.begin('google-a');await f.oauth.revokeProviderGrant({scope,account_id:'google-a'});const count=f.calls.length;
 await assert.rejects(f.complete('google-a',pending),code('EMAIL_OAUTH_SETUP_SUPERSEDED'));assert.equal(f.calls.length,count);assert.ok(await f.token(b));
});

test('two same-provider Microsoft accounts verify Graph identity and refresh independently',async()=>{
 const f=fixture(),pending=await f.begin('graph-a'),url=new URL(pending.authorization_url);assert.equal(url.origin,'https://login.microsoftonline.com');assert.equal(url.pathname,'/common/oauth2/v2.0/authorize');assert.ok(url.searchParams.get('scope').includes('offline_access'));
 const a=await f.complete('graph-a',pending),b=await f.complete('graph-b');assert.deepEqual(a.verified_sender_identities,['graph-a@example.test']);assert.equal(a.primary_address.includes('elsewhere'),false);assert.notEqual(await f.token(a),await f.token(b));f.advance(100000);await f.token(a);await f.token(b);
 const refreshCalls=f.calls.filter(call=>call.form?.grant_type==='refresh_token');assert.equal(refreshCalls.length,2);assert.ok(refreshCalls.every(call=>call.form.scope.includes('https://graph.microsoft.com/Mail.Read')));await f.oauth.disconnect({scope,account_id:a.account_id});assert.ok(await f.token(b));
});

test('concurrent refresh across two service instances performs one durable provider exchange',async()=>{
 const f=fixture(),a=await f.complete();f.advance(100000);
 const other=createEmailOAuth({clients:f.clients,host:f.host,custody:createEncryptedEmailCustody({encryption_key:f.key,key_id:'test-key',store:f.store,now:f.now}),fetch:f.fetch,now:f.now});
 const result=await Promise.all(Array.from({length:12},(_,i)=>f.token(a,'read',i%2?other:f.oauth)));assert.equal(new Set(result).size,1);assert.equal(f.calls.filter(call=>call.form?.grant_type==='refresh_token').length,1);assert.equal(f.store.rows.get(oauthAccountKey(f.bindings.get('google-a'))).value.health,'connected');
});

test('scope reduction at callback narrows the descriptor and never restores Send from reviewed capability alone',async()=>{
 const f=fixture();f.setExchangeScopes('openid email https://www.googleapis.com/auth/gmail.readonly');const a=await f.complete();assert.deepEqual(a.capabilities,['read','search','thread']);assert.ok(await f.token(a));await assert.rejects(f.token(a,'send'),code('EMAIL_OAUTH_ACCOUNT_BINDING_DENIED'));
 const forged={...a,capabilities:[...a.capabilities,'send']};await assert.rejects(f.token(forged,'send'),code('EMAIL_OAUTH_SCOPE_REDUCED'));
});

test('reduced refresh scopes deny Send and preserve usable read custody',async()=>{
 const f=fixture(),a=await f.complete();f.advance(100000);f.setExchangeScopes('openid email https://www.googleapis.com/auth/gmail.readonly');await assert.rejects(f.token(a,'send'),code('EMAIL_OAUTH_SCOPE_REDUCED'));assert.ok(await f.token(a,'read'));assert.equal(f.calls.filter(call=>call.form?.grant_type==='refresh_token').length,1);
});

test('expired current authority before begin and after held provider I/O prevents URL/token delivery',async()=>{
 const denied=fixture();denied.expire();await assert.rejects(denied.begin(),code('EMAIL_OAUTH_AUTHORITY_DENIED'));assert.equal(denied.store.rows.size,0);
 const held=fixture(),pending=await held.begin();held.setAfterFetch(()=>{held.expire();});await assert.rejects(held.complete('google-a',pending),code('EMAIL_OAUTH_AUTHORITY_DENIED'));const empty=await held.custody.withAccount(held.bindings.get('google-a'),tx=>tx.read());assert.equal(empty.health,'revoked');assert.equal(empty.secret,null);
 const cached=fixture(),a=await cached.complete();cached.deny();await assert.rejects(cached.token(a),code('EMAIL_OAUTH_AUTHORITY_DENIED'));
});

test('captured authority deadline cannot be extended by a later host heartbeat',async()=>{
 const f=fixture();let checks=0;f.host.assertAuthority=async()=>({allowed:true,expires_at:++checks===1?f.now()+5:f.now()+300000});const pending=await f.begin();checks=0;f.setAfterFetch(()=>f.advance(6));await assert.rejects(f.complete('google-a',pending),code('EMAIL_OAUTH_AUTHORITY_DENIED'));
});

test('authority expiry during custody lock release prevents token or completed account delivery',async()=>{
 const f=fixture(),a=await f.complete();f.store.afterCallback=({key})=>{if(key.startsWith('email.oauth.account.'))f.expire();};await assert.rejects(f.token(a),code('EMAIL_OAUTH_AUTHORITY_DENIED'));
 const connect=fixture(),pending=await connect.begin();connect.store.afterCallback=({key})=>{if(key.startsWith('email.oauth.account.'))connect.expire();};await assert.rejects(connect.complete('google-a',pending),code('EMAIL_OAUTH_AUTHORITY_DENIED'));
});

test('ambiguous refresh discards token bytes, requires reconnect and never retries',async()=>{
 const f=fixture(),a=await f.complete();f.advance(100000);f.setRefreshMode(()=>{throw Error('secret refresh response lost');});await assert.rejects(f.token(a),code('EMAIL_OAUTH_PROVIDER_UNAVAILABLE'));const count=f.calls.length;await assert.rejects(f.token(a),code('EMAIL_OAUTH_REAUTH_REQUIRED'));assert.equal(f.calls.length,count);
 const row=await f.custody.withAccount(f.bindings.get('google-a'),tx=>tx.read());assert.equal(row.health,'reauth_required');assert.equal(row.secret.refresh_token,'discarded');assert.equal(row.secret.access_token,'discarded');assert.equal(row.secret.identity.provider_subject,'google-a');
});

test('durable pending refresh after process interruption fails closed without a second provider attempt',async()=>{
 const f=fixture(),a=await f.complete();await f.custody.withAccount(f.bindings.get('google-a'),async tx=>{const row=tx.read();await tx.write({health:'refresh_pending',secret:row.secret});});const count=f.calls.length;await assert.rejects(f.token(a),code('EMAIL_OAUTH_REAUTH_REQUIRED'));assert.equal(f.calls.length,count);
});

test('provider invalid_grant has bounded safe error and prevents refresh replay',async()=>{
 const f=fixture(),a=await f.complete();f.advance(100000);f.setRefreshMode(()=>response({error:'invalid_grant',error_description:'DO NOT EXPOSE secret token'},400));await assert.rejects(f.token(a),error=>error.code==='EMAIL_OAUTH_REAUTH_REQUIRED'&&!String(error).includes('secret'));await assert.rejects(f.token(a),code('EMAIL_OAUTH_REAUTH_REQUIRED'));assert.equal(f.calls.filter(call=>call.form?.grant_type==='refresh_token').length,1);
});

test('identity changes during refresh deny access and stop future refresh attempts',async()=>{
 const f=fixture(),a=await f.complete();f.advance(100000);f.setSubject('changed-subject');await assert.rejects(f.token(a),code('EMAIL_OAUTH_RECONNECT_IDENTITY_CHANGED'));await assert.rejects(f.token(a),code('EMAIL_OAUTH_REAUTH_REQUIRED'));
});

test('host revocation during held refresh prevents stale token delivery',async()=>{
 const f=fixture(),a=await f.complete(),started=defer(),released=defer();f.advance(100000);f.setRefreshMode(async()=>{started.resolve();await released.promise;});const refreshed=f.token(a);await started.promise;f.bindings.get('google-a').authority_epoch++;released.resolve();await assert.rejects(refreshed,code('EMAIL_OAUTH_AUTHORITY_DENIED'));assert.equal(f.store.rows.get(oauthAccountKey(f.bindings.get('google-a'))).value.health,'reauth_required');
 await f.oauth.disconnect({scope,account_id:'google-a'});assert.equal(f.store.rows.get(oauthAccountKey(f.bindings.get('google-a'))).value.health,'revoked');
});

test('exact AAD rejects account/scope/envelope transplantation and malformed ciphertext',async()=>{
 const f=fixture();await f.complete('google-a');await f.complete('google-b');const akey=oauthAccountKey(f.bindings.get('google-a')),bkey=oauthAccountKey(f.bindings.get('google-b')),a=f.store.rows.get(akey),b=f.store.rows.get(bkey);
 b.value.envelope=copy(a.value.envelope);await assert.rejects(f.custody.withAccount(f.bindings.get('google-b'),tx=>tx.read()),code('EMAIL_OAUTH_CUSTODY_INVALID'));
 a.value.binding.scope.owner_id='foreign';await assert.rejects(f.custody.withAccount(f.bindings.get('google-a'),tx=>tx.read()),code('EMAIL_OAUTH_CUSTODY_BINDING_DENIED'));
});

test('AAD authenticates empty setup generations and survives opaque JSON key reordering',async()=>{
 const f=fixture(),pending=await f.begin(),key=oauthAccountKey(f.bindings.get('google-a')),row=f.store.rows.get(key);assert.ok(row.value.envelope);row.value.setup_generation++;await assert.rejects(f.custody.withAccount(f.bindings.get('google-a'),tx=>tx.read()),code('EMAIL_OAUTH_CUSTODY_INVALID'));row.value.setup_generation--;
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reorder(value[key])])):value;for(const [key,value] of f.store.rows)f.store.rows.set(key,reorder(value));assert.equal((await f.complete('google-a',pending)).health,'connected');
});

test('caller descriptor cannot switch target/owner/epoch or nominate an unverified sender',async()=>{
 const f=fixture(),a=await f.complete();for(const changed of [{connection_target:'other'},{authority_epoch:2},{primary_address:'foreign@example.test'},{verified_sender_identities:['foreign@example.test']}])await assert.rejects(f.token({...a,...changed},changed.verified_sender_identities?'send':'read'));
 await assert.rejects(f.oauth.getAccessToken({scope:{...scope,owner_id:'other'},account:a,account_id:a.account_id,operation:'read',authority_epoch:1}),code('EMAIL_OAUTH_AUTHORITY_DENIED'));assert.equal(f.calls.filter(call=>call.form?.grant_type==='refresh_token').length,0);
});

test('unsafe provider responses are bounded and cannot expose credentials or errors',async()=>{
 const f=fixture(),pending=await f.begin();const unsafe=createEmailOAuth({clients:f.clients,host:f.host,custody:f.custody,now:f.now,fetch:async()=>response({padding:'X'.repeat(70000),error_description:'secret'})});await assert.rejects(unsafe.complete({scope,state:new URL(pending.authorization_url).searchParams.get('state'),code:'google-a',browser_binding:browser}),error=>error.code==='EMAIL_OAUTH_PROVIDER_RESPONSE_LIMIT'&&!String(error).includes('secret'));
});

test('Google project revoke is explicit; Microsoft disconnect does not invent a per-token revoke endpoint',async()=>{
 const f=fixture();await f.complete();const result=await f.oauth.revokeProviderGrant({scope,account_id:'google-a'});assert.equal(result.state,'revoked');assert.equal(f.calls.at(-1).url,'https://oauth2.googleapis.com/revoke');assert.equal(f.store.rows.get(oauthAccountKey(f.bindings.get('google-a'))).value.health,'revoked');
 await f.complete('graph-a');const count=f.calls.length;const ms=await f.oauth.revokeProviderGrant({scope,account_id:'graph-a'});assert.equal(ms.state,'user_portal_required');assert.equal(f.calls.length,count);assert.deepEqual(ms.portals,[{audience:'personal',url:'https://account.live.com/consent/Manage'},{audience:'work_or_school',url:'https://myapps.microsoft.com/'}]);assert.equal(f.calls.some(call=>/messages\/send|sendMail/.test(call.url)),false);
});

test('Microsoft revocation routes fixed portals for consumers, organizations, common and tenant UUID',async()=>{
 const f=fixture();for(const [tenant,audiences] of [['consumers',['personal']],['organizations',['work_or_school']],['00000000-0000-4000-8000-000000000001',['work_or_school']],['common',['personal','work_or_school']]]){
  const provider=createOAuthProvider({provider:'microsoft',client:{...f.clients.microsoft,tenant},fetch:async()=>assert.fail('No Microsoft token revoke request')});const result=await provider.revokeProjectGrant({refresh_token:'synthetic',checkAuthority:async()=>{}});assert.deepEqual(result.portals.map(portal=>portal.audience),audiences);assert.ok(result.portals.every(portal=>['https://account.live.com/consent/Manage','https://myapps.microsoft.com/'].includes(portal.url)));
 }
 assert.throws(()=>createOAuthProvider({provider:'microsoft',client:{...f.clients.microsoft,tenant:'https://attacker.test'}}),code('EMAIL_OAUTH_CLIENT_CONFIG_INVALID'));assert.throws(()=>createOAuthProvider({provider:'microsoft',client:{...f.clients.microsoft,portal_url:'https://attacker.test'}}),code('EMAIL_OAUTH_CLIENT_CONFIG_INVALID'));await assert.rejects(f.oauth.revokeProviderGrant({scope,account_id:'graph-a',portal_url:'https://attacker.test'}),code('EMAIL_OAUTH_INPUT_INVALID'));
});

test('no permissive store/client/authority fallback and changed registration require reconnect',async()=>{
 assert.throws(()=>createEncryptedEmailCustody({encryption_key:new Uint8Array(32),key_id:'key',store:{}}),code('EMAIL_OAUTH_CUSTODY_CONFIG_INVALID'));
 const f=fixture(),a=await f.complete();assert.throws(()=>createEmailOAuth({clients:{gmail:{...f.clients.gmail,redirect_uri:'https://user:secret@attacker.test/callback'}},host:f.host,custody:f.custody}),code('EMAIL_OAUTH_CLIENT_CONFIG_INVALID'));
 const changed=createEmailOAuth({clients:{gmail:{...f.clients.gmail,client_id:'new-client'}},host:f.host,custody:f.custody,fetch:f.fetch,now:f.now});await assert.rejects(f.token(a,'read',changed),code('EMAIL_OAUTH_CLIENT_CHANGED'));
 const pending=await changed.begin({scope,account_id:'google-a',browser_binding:browser}),reconnected=await changed.complete({scope,state:new URL(pending.authorization_url).searchParams.get('state'),code:'google-a',browser_binding:browser});assert.ok(await f.token(reconnected,'read',changed));
});
