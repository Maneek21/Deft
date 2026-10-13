import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {createEmailFileCustodyStore} from './custody-file-store.mjs';
import {createEncryptedEmailCustody} from './custody-encrypted.mjs';
import {createEmailOAuth} from './oauth-account.mjs';
import {oauthAccountKey,oauthDigest} from './oauth-contract.mjs';

const posix={skip:process.platform==='win32'},scope={org_id:'org',owner_id:'owner',installation_id:'installation'};
const binding={scope,account_id:'account',provider:'gmail',connection_target:'reviewed-target',resource_binding_id:'resource',action_binding_id:'action',authority_epoch:1,capabilities:['read','send']};
const secret={access_token:'synthetic-access-secret',refresh_token:'synthetic-refresh-secret',expires_at:Date.now()+60000,scopes:['openid','email','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'],client_fingerprint:'f'.repeat(64),identity:{provider_subject:'stable-subject',primary_address:'owner@example.test',verified_sender_identities:['owner@example.test'],display_label:'Owner'}};
const key=Uint8Array.from({length:32},(_,i)=>i+1),accountKey=oauthAccountKey(binding),code=expected=>error=>error.code===expected;
const emptyEnvelope={key_id:'opaque-fixture',iv:Buffer.alloc(12).toString('base64url'),tag:Buffer.alloc(16).toString('base64url'),ciphertext:Buffer.from('opaque-fixture').toString('base64url')};
const fileStoreUrl=new URL('./custody-file-store.mjs',import.meta.url).href,custodyUrl=new URL('./custody-encrypted.mjs',import.meta.url).href;
async function sandbox(t){
 const path=await mkdtemp(join(tmpdir(),'deft-email-custody-test-'));await chmod(path,0o700);
 t.after(async()=>{const target=resolve(path);if(!target.startsWith(resolve(tmpdir())+sep)||!basename(target).startsWith('deft-email-custody-test-'))throw Error('unsafe test cleanup path');await rm(target,{recursive:true,force:true});});
 return {path,root:join(path,'custody')};
}
async function child(t,directory,source){
 const script=join(directory,'child-'+Math.random().toString(16).slice(2)+'.mjs');await writeFile(script,source,{mode:0o600});const process=fork(script,[],{stdio:['ignore','pipe','pipe','ipc']});let errorOutput='';process.stderr.on('data',value=>{errorOutput+=value.toString().slice(0,1000);});process.stdout.resume();
 t.after(()=>{if(process.exitCode===null&&process.signalCode===null)process.kill('SIGKILL');});
 const messagePromise=new Promise((resolve,reject)=>{process.once('message',resolve);process.once('error',reject);process.once('exit',status=>{if(status!==null)reject(Error('child exited '+status+' '+errorOutput));});});
 const exit=new Promise((resolve,reject)=>{process.once('error',reject);process.once('exit',(status,signal)=>resolve({status,signal,errorOutput}));});return {process,message:()=>messagePromise,exit};
}

test('Windows local file custody refuses unsupported durability explicitly',async()=>{
 if(process.platform==='win32')await assert.rejects(createEmailFileCustodyStore({root:join(tmpdir(),'unused')}),code('EMAIL_OAUTH_FILE_STORE_PLATFORM_UNSUPPORTED'));
 else assert.equal(typeof process.getuid,'function');
});

test('real filesystem persists encrypted account and one-use state across store instances',posix,async t=>{
 const {root}=await sandbox(t),store=await createEmailFileCustodyStore({root}),custody=createEncryptedEmailCustody({encryption_key:key,key_id:'fixture-key',store});
 await custody.withAccount(binding,tx=>tx.write({health:'connected',secret}));await custody.storeState({state:'random-state',binding,browser_binding:'trusted-browser',expires_at:Date.now()+60000,secret:{verifier:'synthetic-verifier',scopes:['openid','email']}});
 const raw=(await Promise.all((await readdir(join(root,'records'))).map(name=>readFile(join(root,'records',name),'utf8')))).join('\n');for(const sensitive of ['synthetic-access-secret','synthetic-refresh-secret','synthetic-verifier','owner@example.test'])assert.equal(raw.includes(sensitive),false);
 const restarted=createEncryptedEmailCustody({encryption_key:key,key_id:'fixture-key',store:await createEmailFileCustodyStore({root})});assert.equal((await restarted.withAccount(binding,tx=>tx.read())).secret.refresh_token,secret.refresh_token);assert.equal((await restarted.takeState({scope,state:'random-state',browser_binding:'trusted-browser'})).secret.verifier,'synthetic-verifier');
 const third=createEncryptedEmailCustody({encryption_key:key,key_id:'fixture-key',store:await createEmailFileCustodyStore({root})});await assert.rejects(third.takeState({scope,state:'random-state',browser_binding:'trusted-browser'}),code('EMAIL_OAUTH_STATE_REPLAY'));
 const tombstone=JSON.parse(await readFile(join(root,'records','state.'+oauthDigest('random-state')+'.json'),'utf8'));assert.equal(tombstone.revision,2);assert.equal(tombstone.value,null);assert.deepEqual(await readdir(join(root,'locks')),[]);
});

test('real concurrent processes serialize CAS revisions without replacing each other',posix,async t=>{
 const {path,root}=await sandbox(t);await createEmailFileCustodyStore({root});
 const source=`import {createEmailFileCustodyStore} from ${JSON.stringify(fileStoreUrl)};\nconst store=await createEmailFileCustodyStore({root:${JSON.stringify(root)}});\nfor(let i=0;i<4;i++)await store.withLock({key:${JSON.stringify(accountKey)}},async tx=>{const row=await tx.read();if(!await tx.compareAndSwap({expected_revision:row?.revision??null,value:${JSON.stringify({schema_version:'deft.email_oauth_tokens.v1',binding,health:'revoked',setup_generation:1,envelope:emptyEnvelope})}}))throw Error('CAS lost');});\nprocess.send('done');`;
 const children=await Promise.all(Array.from({length:5},()=>child(t,path,source)));for(const worker of children){assert.equal(await worker.message(),'done');const exited=await worker.exit;assert.equal(exited.status,0,exited.errorOutput);}
 const row=await (await createEmailFileCustodyStore({root})).withLock({key:accountKey},tx=>tx.read());assert.equal(row.revision,20);assert.deepEqual(await readdir(join(root,'locks')),[]);assert.equal((await readdir(join(root,'records'))).filter(name=>name.endsWith('.tmp')).length,0);
});

test('setup generation survives durable reopen and rejects pre-disconnect/older-begin callbacks',posix,async t=>{
 const {root}=await sandbox(t);let exchanges=0;
 const options={clients:{gmail:{client_id:'fixture',client_secret:'fixture-secret',redirect_uri:'https://deft.example.test/callback'}},host:{resolveAccount:async()=>binding,assertAuthority:async()=>({allowed:true,expires_at:Date.now()+60000})},fetch:async url=>new Response(JSON.stringify(url==='https://oauth2.googleapis.com/token'?(exchanges++,{access_token:'fixture-access',refresh_token:'fixture-refresh',token_type:'Bearer',expires_in:120,scope:secret.scopes.join(' ')}):url==='https://openidconnect.googleapis.com/v1/userinfo'?{sub:'stable-subject',email:'owner@example.test',email_verified:true}:{emailAddress:'owner@example.test'}))};
 const factory=async()=>createEmailOAuth({...options,custody:createEncryptedEmailCustody({encryption_key:key,key_id:'fixture-key',store:await createEmailFileCustodyStore({root})})}),begin=oauth=>oauth.begin({scope,account_id:binding.account_id,browser_binding:'trusted-browser'}),complete=(oauth,pending)=>oauth.complete({scope,state:new URL(pending.authorization_url).searchParams.get('state'),code:'synthetic-code',browser_binding:'trusted-browser'});
 const first=await factory();await complete(first,await begin(first));const pending=await begin(first);await first.disconnect({scope,account_id:binding.account_id});const count=exchanges,reopened=await factory();await assert.rejects(complete(reopened,pending),code('EMAIL_OAUTH_SETUP_SUPERSEDED'));assert.equal(exchanges,count);assert.equal(binding.authority_epoch,1);
 const row=JSON.parse(await readFile(join(root,'records',accountKey.slice('email.oauth.'.length)+'.json'),'utf8'));assert.equal(row.value.health,'revoked');assert.equal(row.value.setup_generation,3);
 const old=await begin(reopened),current=await begin(reopened),again=await factory();await assert.rejects(complete(again,old),code('EMAIL_OAUTH_SETUP_SUPERSEDED'));assert.equal(exchanges,count);assert.equal((await complete(again,current)).health,'connected');assert.equal(exchanges,count+1);
});

test('real CAS rejects a stale revision and preserves the last committed row',posix,async t=>{
 const {root}=await sandbox(t),store=await createEmailFileCustodyStore({root}),value={schema_version:'deft.email_oauth_tokens.v1',binding,health:'revoked',setup_generation:1,envelope:emptyEnvelope};
 await store.withLock({key:accountKey},async tx=>{assert.equal(await tx.compareAndSwap({expected_revision:null,value}),true);assert.equal(await tx.compareAndSwap({expected_revision:null,value}),false);assert.equal((await tx.read()).revision,1);assert.deepEqual((await tx.read()).value,value);});
});

test('killed process leaves durable refresh_pending and orphan lock; no takeover or refresh replay',posix,async t=>{
 const {path,root}=await sandbox(t);await createEmailFileCustodyStore({root});
 const source=`import {createEmailFileCustodyStore} from ${JSON.stringify(fileStoreUrl)};\nimport {createEncryptedEmailCustody} from ${JSON.stringify(custodyUrl)};\nconst custody=createEncryptedEmailCustody({encryption_key:Uint8Array.from(${JSON.stringify([...key])}),key_id:'fixture-key',store:await createEmailFileCustodyStore({root:${JSON.stringify(root)}})});\nawait custody.withAccount(${JSON.stringify(binding)},async tx=>{await tx.write({health:'refresh_pending',secret:${JSON.stringify(secret)}});process.send('pending-durable');await new Promise(()=>{setInterval(()=>{},1000);});});`;
 const worker=await child(t,path,source);assert.equal(await worker.message(),'pending-durable');worker.process.kill('SIGKILL');assert.equal((await worker.exit).signal,'SIGKILL');
 const persisted=JSON.parse(await readFile(join(root,'records',accountKey.slice('email.oauth.'.length)+'.json'),'utf8'));assert.equal(persisted.value.health,'refresh_pending');
 const store=await createEmailFileCustodyStore({root,max_wait_ms:0,now:()=>Date.now()+300000});await assert.rejects(store.withLock({key:accountKey},tx=>tx.read()),code('EMAIL_OAUTH_FILE_STORE_STALE_LOCK'));assert.equal((await readdir(join(root,'locks'))).length,1);
 // Explicit operator recovery is safe only after the owning process is proved
 // terminated. Removing this test's exact orphan does not clear its pending row.
 const orphan=resolve(join(root,'locks',accountKey.slice('email.oauth.'.length)+'.lock'));assert.ok(orphan.startsWith(resolve(root)+sep));await rm(orphan,{recursive:true});
 const custody=createEncryptedEmailCustody({encryption_key:key,key_id:'fixture-key',store:await createEmailFileCustodyStore({root})}),oauth=createEmailOAuth({clients:{gmail:{client_id:'fixture',client_secret:'fixture-secret',redirect_uri:'https://deft.example.test/callback'}},host:{resolveAccount:async()=>binding,assertAuthority:async()=>({allowed:true,expires_at:Date.now()+60000})},custody,fetch:async()=>assert.fail('Crash recovery must not refresh')});
 const account={...binding,display_label:'Owner',primary_address:'owner@example.test',verified_sender_identities:['owner@example.test'],health:'connected'};delete account.scope;
 await assert.rejects(oauth.getAccessToken({scope,account,account_id:account.account_id,operation:'read',authority_epoch:1}),code('EMAIL_OAUTH_REAUTH_REQUIRED'));
});

test('expired holder is fenced, keeps its stale lock, and cannot use an escaped transaction',posix,async t=>{
 const {root}=await sandbox(t);let time=1000000,escaped;const store=await createEmailFileCustodyStore({root,lock_ttl_ms:1000,now:()=>time,max_wait_ms:0});
 await assert.rejects(store.withLock({key:accountKey},async tx=>{escaped=tx;await tx.compareAndSwap({expected_revision:null,value:{schema_version:'deft.email_oauth_tokens.v1',binding,health:'revoked',setup_generation:1,envelope:emptyEnvelope}});time+=1001;await tx.read();}),code('EMAIL_OAUTH_FILE_STORE_FENCE_LOST'));
 await assert.rejects(escaped.read(),code('EMAIL_OAUTH_FILE_STORE_FENCE_LOST'));await assert.rejects(store.withLock({key:accountKey},tx=>tx.read()),code('EMAIL_OAUTH_FILE_STORE_STALE_LOCK'));assert.equal((await readdir(join(root,'locks'))).length,1);
});

test('private root, safe hashed keys and ciphertext-only payload are enforced',posix,async t=>{
 const {path,root}=await sandbox(t);await assert.rejects(createEmailFileCustodyStore({root:'relative'}),code('EMAIL_OAUTH_FILE_STORE_CONFIG_INVALID'));
 await chmod(path,0o755);await assert.rejects(createEmailFileCustodyStore({root:path}),code('EMAIL_OAUTH_FILE_STORE_ROOT_NOT_PRIVATE'));await chmod(path,0o700);const store=await createEmailFileCustodyStore({root});
 await assert.rejects(store.withLock({key:'../../escape'},()=>{}),code('EMAIL_OAUTH_FILE_STORE_KEY_INVALID'));
 await assert.rejects(store.withLock({key:accountKey},tx=>tx.compareAndSwap({expected_revision:null,value:{schema_version:'deft.email_oauth_tokens.v1',binding,health:'connected',access_token:'plaintext',envelope:null}})),code('EMAIL_OAUTH_FILE_STORE_PAYLOAD_INVALID'));assert.deepEqual(await readdir(join(root,'records')),[]);
 const link=join(path,'symlink-root');await symlink(root,link);await assert.rejects(createEmailFileCustodyStore({root:link}),code('EMAIL_OAUTH_FILE_STORE_PATH_INVALID'));
});

test('record symlinks and corrupted rows cannot replace current encrypted custody',posix,async t=>{
 const {path,root}=await sandbox(t),store=await createEmailFileCustodyStore({root}),record=join(root,'records',accountKey.slice('email.oauth.'.length)+'.json'),outside=join(path,'outside.json');await writeFile(outside,'{}',{mode:0o600});await symlink(outside,record);
 await assert.rejects(store.withLock({key:accountKey},tx=>tx.read()),code('EMAIL_OAUTH_FILE_STORE_FILE_INVALID'));await unlinkSafe(record);await writeFile(record,'{broken',{mode:0o600});await assert.rejects(store.withLock({key:accountKey},tx=>tx.read()),code('EMAIL_OAUTH_FILE_STORE_FILE_INVALID'));assert.deepEqual(await readdir(join(root,'locks')),[]);
});

async function unlinkSafe(path){await rm(path,{force:false});}
