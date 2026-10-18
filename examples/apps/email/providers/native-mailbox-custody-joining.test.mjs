import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {resolve,join,dirname,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const here=fileURLToPath(import.meta.url),source=resolve(process.env.DEFT_M5_SOURCE_ROOT??(here.endsWith('native-mailbox-custody-joining.test.mjs')?resolve(dirname(here),'../../../..'):process.cwd()));
const baseline=process.env.DEFT_M5_EXPECT_BASELINE==='1';
const posix=process.platform!=='win32';
if(process.env.DEFT_M5_REQUIRE_POSIX==='1'&&!posix)throw Error('M5_POSIX_PROOF_REQUIRED');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const barrier=()=>{let release;const promise=new Promise(r=>{release=r;});return {promise,release};};
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const stats={syncs:0,fileSyncs:0,directorySyncs:0,syncMs:0,locks:0,authorityLocks:0,tokenLocks:0,otherLocks:0,lockWaitMs:0,lockMs:0,sql:0,provider:0,tokenRefresh:0};
const zero=()=>Object.keys(stats).forEach(k=>{stats[k]=0;});
const handlePaths=new WeakMap();
const originalOpen=fs.open.bind(fs);
fs.open=async(...args)=>{const handle=await originalOpen(...args);handlePaths.set(handle,String(args[0]));return handle;};
syncBuiltinESMExports();
const probeRoot=await fs.mkdtemp(join(tmpdir(),'deft-email-m5-instrument-'));
const probe=await fs.open(join(probeRoot,'probe'),'wx',0o600),prototype=Object.getPrototypeOf(probe),originalSync=prototype.sync;
prototype.sync=async function(){const at=performance.now(),path=handlePaths.get(this);stats.syncs++;if(path?.endsWith('.tmp')||path?.endsWith('owner.json'))stats.fileSyncs++;else stats.directorySyncs++;
 try{return await originalSync.call(this);}finally{stats.syncMs+=performance.now()-at;}};
await probe.sync();assert.equal(stats.syncs,1,'FileHandle.sync instrumentation must observe actual syscall wrapper');await probe.close();if(!probeRoot.startsWith(resolve(tmpdir())+sep)||!probeRoot.split(sep).at(-1).startsWith('deft-email-m5-instrument-'))throw Error('UNSAFE_FIXTURE_CLEANUP');await fs.rm(probeRoot,{recursive:true});
const module=async name=>import(pathToFileURL(join(source,'examples/apps/email',name)).href);
const [{createAppConnectionAdapter},{createEncryptedEmailCustody},{createOAuthProvider},fileModule]=await Promise.all([
 module('providers/connection-http.mjs'),module('providers/custody-encrypted.mjs'),module('providers/oauth-provider.mjs'),posix?module('providers/custody-file-store.mjs'):Promise.resolve(null)]);
const cleanup=[];
test.after(async()=>{prototype.sync=originalSync;fs.open=originalOpen;syncBuiltinESMExports();for(const root of cleanup){if(!root.startsWith(resolve(tmpdir())+sep)||!root.split(sep).at(-1).startsWith('deft-email-m5-'))throw Error('UNSAFE_FIXTURE_CLEANUP');await fs.rm(root,{recursive:true,force:true});}});

async function fixture(accountId='synthetic-account'){
 const scope={org_id:'synthetic-org',owner_id:'synthetic-owner',installation_id:'synthetic-installation'},binding={scope,account_id:accountId,provider:'gmail',connection_target:'synthetic-target',resource_binding_id:'synthetic-binding',action_binding_id:null,authority_epoch:1,capabilities:['read']};
 let underlying;
 if(posix){const root=await fs.mkdtemp(join(tmpdir(),'deft-email-m5-custody-'));cleanup.push(root);underlying=await fileModule.createEmailFileCustodyStore({root});}
 else{const rows=new Map(),queues=new Map();underlying={async withLock({key},callback){const prior=queues.get(key)??Promise.resolve();let release;const held=new Promise(r=>{release=r;});queues.set(key,held);await prior;try{return await callback({read:async()=>structuredClone(rows.get(key)??null),compareAndSwap:async({expected_revision,value})=>{const row=rows.get(key);if((row?.revision??null)!==expected_revision)return false;rows.set(key,{revision:(row?.revision??0)+1,value:structuredClone(value)});return true;}});}finally{release();if(queues.get(key)===held)queues.delete(key);}}};}
 const store={async withLock(input,callback){stats.locks++;const stack=new Error().stack??'';stats[stack.includes('oauth-account.mjs')?'tokenLocks':stack.includes('native-mailbox.mjs')?'authorityLocks':'otherLocks']++;const started=performance.now();try{return await underlying.withLock(input,async tx=>{stats.lockWaitMs+=performance.now()-started;return callback(tx);});}finally{stats.lockMs+=performance.now()-started;}}};
 const custody=createEncryptedEmailCustody({encryption_key:new Uint8Array(32).fill(48),key_id:'m5-fixture-key',store});
 const client={client_id:'synthetic-client',client_secret:'synthetic-client-secret',redirect_uri:'https://fixture.invalid/apps/connections/callback'};
 const state={hits:0,allowed:true,hold:null,afterResponse:null,metadata:0,expired:false};
 const fetch=async(href,init)=>{
  stats.provider++;const url=new URL(href);await delay(20);
  if(url.origin==='https://oauth2.googleapis.com'){assert.equal(init.method,'POST');stats.tokenRefresh++;return json({access_token:'synthetic-renewed',token_type:'Bearer',expires_in:3600,scope:'openid email https://www.googleapis.com/auth/gmail.readonly'});}
  assert.equal(init.method,'GET');
  if(url.origin==='https://openidconnect.googleapis.com')return json({sub:'synthetic-principal',email:'owner@example.test',email_verified:true});
  if(url.pathname.endsWith('/profile'))return json({emailAddress:'owner@example.test'});
  if(url.pathname.endsWith('/messages'))return json({messages:Array.from({length:state.hits},(_,i)=>({id:'synthetic-'+i}))});
  state.metadata++;if(state.hold)await state.hold();
  if(state.afterResponse)await state.afterResponse();
  return json({id:url.pathname.split('/').at(-1),threadId:'synthetic-thread',labelIds:['INBOX'],internalDate:'1760000000000',payload:{headers:[{name:'Subject',value:'Synthetic subject'}]}});
 };
 const fingerprint=createOAuthProvider({provider:'gmail',client,fetch,now:Date.now}).client_fingerprint;
 await custody.withAccount(binding,async tx=>tx.write({health:'connected',secret:{access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_at:Date.now()+3600000,scopes:['openid','email','https://www.googleapis.com/auth/gmail.readonly'],client_fingerprint:fingerprint,identity:{provider_subject:'synthetic-principal',primary_address:'owner@example.test',display_label:'Fixture',verified_sender_identities:['owner@example.test']}}}));
 const {scope:_scope,...options}=binding;
 const adapter=await createAppConnectionAdapter({options:{...options,origin:'https://fixture.invalid',clients:{gmail:client}},custody,fetch,host:{resolveContext:async()=>assert.fail('No Experience'),assertCurrent:async()=>assert.fail('No Experience')}});
 const context={org_id:scope.org_id,owner_user_id:scope.owner_id,installation_id:scope.installation_id,account_id:accountId,resource_binding_id:binding.resource_binding_id,authority_version:'synthetic-current',expires_at:Date.now()+120000,recheck:async()=>{stats.sql++;await delay(5);if(!state.allowed)throw Error('Synthetic owner revoked');}};
 const change=async kind=>custody.withAccount(binding,async tx=>{const row=tx.read();await tx.write({health:kind==='revoke'?'revoked':'connected',advance_setup:kind!=='expire',secret:{...row.secret,...(kind==='revoke'?{access_token:'discarded',refresh_token:'discarded',expires_at:0}:{}),...(kind==='expire'?{expires_at:Date.now()-1000}:{}),...(kind==='principal'?{identity:{...row.secret.identity,provider_subject:'another-synthetic-principal'}}:{})}});});
 return {state,adapter,context,custody,binding,change,read:(contextOverride={})=>adapter.nativeEmailSearch({query:'subject:synthetic',cursor:null,limit:Math.max(1,state.hits)},{...context,...contextOverride})};
}

for(const hits of [0,19,50])test('actual custody phase '+hits+' hits',async()=>{
 const f=await fixture();f.state.hits=hits;zero();const at=performance.now();const value=await f.read();const report={hits,elapsed_ms:Math.round(performance.now()-at),store:posix?'actual_posix_filesystem':'windows_memory_behavior_only',source_sha256:createHash('sha256').update(await fs.readFile(join(source,'examples/apps/email/providers/native-mailbox.mjs'))).digest('hex'),...stats};
 console.log(JSON.stringify({event:'m5_search_custody_phases',...report}));assert.equal(value.items.length,hits);assert.equal(value.query_complete,true);assert.equal(stats.provider,hits+1);
 if(posix){assert.equal(stats.syncs,stats.locks*4);assert.equal(stats.fileSyncs,stats.locks);assert.equal(stats.directorySyncs,stats.locks*3);}
 const old=hits===0?10:hits===19?71:170;
 if(baseline){assert.equal(stats.locks,8+3*hits+2*stats.tokenLocks,'Only overlapping pending token acquisitions are shared in the baseline');assert.equal(stats.otherLocks,0);}else if(hits===0)assert.equal(stats.locks,old);else assert.ok(stats.locks<old,'Pending read joining must reduce real custody lock count');
});
for(const kind of ['revoke','principal','setup','owner','abort'])test('held metadata late '+kind+' never returns a search page',async()=>{
 const f=await fixture(),entered=barrier(),held=barrier(),controller=new AbortController();f.state.hits=19;f.state.hold=async()=>{entered.release();await held.promise;};
 const pending=f.read({signal:controller.signal});const rejection=assert.rejects(pending);await entered.promise;
 if(kind==='owner')f.state.allowed=false;else if(kind==='abort')controller.abort();else await f.change(kind);held.release();await rejection;
 f.state.hold=null;if(kind==='abort'){const next=await f.read();assert.equal(next.items.length,19,'Canceled request cannot contaminate a later runtime');}
});
test('parallel requests never share their settled account authority and wrong scope never reads provider',async()=>{
 const f=await fixture();zero();const values=await Promise.all([f.read(),f.read()]);assert.equal(values.length,2);assert.equal(stats.locks,20,'Zero-result runtimes retain independent10-lock boundaries');
 const calls=stats.provider;await assert.rejects(f.read({account_id:'foreign-account'}));assert.equal(stats.provider,calls);
 const other=await fixture('other-synthetic-account');const page=await other.read();assert.equal(page.account_id,'other-synthetic-account');
});
test('token refresh contention retains one fenced durable renewal and independent final reads',async()=>{
 const f=await fixture();await f.change('expire');zero();const values=await Promise.all([f.read(),f.read()]);assert.equal(values.length,2);assert.equal(stats.tokenRefresh,1);assert.equal(values.every(row=>row.query_complete),true);
});
test('custody changed after last provider response is denied at fresh final output boundary',async()=>{
 const f=await fixture();f.state.hits=1;let once=false;f.state.afterResponse=async()=>{if(!once){once=true;await f.change('setup');}};await assert.rejects(f.read());assert.equal(once,true);
});
test('expired owner deadline rejects before provider and remains independent of earlier success',async()=>{
 const f=await fixture();await f.read();const calls=stats.provider;await assert.rejects(f.read({expires_at:Date.now()-1}));assert.equal(stats.provider,calls);
});
