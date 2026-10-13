import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {oauthAccountKey} from './oauth-contract.mjs';

const posix=process.platform!=='win32';
if(process.env.DEFT_M14_REQUIRE_POSIX==='1'&&!posix)throw Error('M14_POSIX_PROOF_REQUIRED');
const options={skip:!posix,timeout:30000},barrier=()=>{let release;const promise=new Promise(done=>{release=done;});return {promise,release};},delay=ms=>new Promise(done=>setTimeout(done,ms));
const binding={scope:{org_id:'synthetic-org',owner_id:'synthetic-owner',installation_id:'synthetic-installation'},account_id:'synthetic-account',provider:'gmail',connection_target:'synthetic-target',resource_binding_id:'synthetic-resource',action_binding_id:null,authority_epoch:1,capabilities:['read']};
const accountKey=oauthAccountKey(binding),name=accountKey.slice('email.oauth.'.length),value={schema_version:'deft.email_oauth_tokens.v1',binding,health:'revoked',setup_generation:1,envelope:{key_id:'synthetic',iv:Buffer.alloc(12).toString('base64url'),tag:Buffer.alloc(16).toString('base64url'),ciphertext:Buffer.from('synthetic-ciphertext').toString('base64url')}};
const handles=new WeakMap(),original={open:fs.open,rename:fs.rename,unlink:fs.unlink,rmdir:fs.rmdir};
let observedRoot=null,events=[],hook=null,prototype,originalSync;
const role=path=>path===join(observedRoot,'locks')?'locks-parent':path===join(observedRoot,'records')?'records-parent':path.startsWith(join(observedRoot,'records')+sep)?'record-file':path.endsWith('.lock')?'lock-directory':path.includes('.lock'+sep)?'owner-file':'other';
if(posix){
 fs.open=async(...args)=>{const handle=await original.open(...args);handles.set(handle,String(args[0]));return handle;};
 for(const operation of ['rename','unlink','rmdir'])fs[operation]=async(...args)=>{const path=String(args[0]);if(observedRoot&&path.startsWith(observedRoot+sep))events.push({event:operation,path});return original[operation](...args);};
 syncBuiltinESMExports();
 const probeRoot=await fs.mkdtemp(join(tmpdir(),'deft-email-m14-probe-')),probe=await fs.open(join(probeRoot,'probe'),'wx',0o600);prototype=Object.getPrototypeOf(probe);originalSync=prototype.sync;
 prototype.sync=async function(){const path=handles.get(this);if(!observedRoot||!path?.startsWith(observedRoot+sep))return originalSync.call(this);const phase=role(path);events.push({event:'sync-enter',phase,path});await hook?.({phase,path});await originalSync.call(this);events.push({event:'sync-done',phase,path});};
 await probe.close();await fs.rm(probeRoot,{recursive:true});
}
const {createEmailFileCustodyStore}=await import('./custody-file-store.mjs');
test.after(()=>{if(prototype)prototype.sync=originalSync;Object.assign(fs,original);syncBuiltinESMExports();});
async function sandbox(t){const parent=await fs.mkdtemp(join(tmpdir(),'deft-email-m14-durability-'));await fs.chmod(parent,0o700);const root=join(parent,'custody'),store=await createEmailFileCustodyStore({root});t.after(async()=>{observedRoot=null;hook=null;if(!resolve(parent).startsWith(resolve(tmpdir())+sep)||!basename(parent).startsWith('deft-email-m14-durability-'))throw Error('UNSAFE_FIXTURE_CLEANUP');await fs.rm(parent,{recursive:true,force:true});});return {parent,root,store,lockPath:join(root,'locks',name+'.lock'),ownerPath:join(root,'locks',name+'.lock','owner.json')};}
function observe(root,nextHook=null){observedRoot=root;events=[];hook=nextHook;}
async function exists(path){try{await fs.lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
const rejection=code=>error=>error.code===code;

test('successful read lock retains complete publication and durable removal with exactly four syncs',options,async t=>{
 const f=await sandbox(t);observe(f.root);await f.store.withLock({key:accountKey},async tx=>{events.push({event:'callback-enter'});assert.equal(await tx.read(),null);events.push({event:'callback-exit'});return 'read';});
 const phases=events.filter(row=>row.event==='sync-done').map(row=>row.phase);console.log(JSON.stringify({event:'m14_core_syncs',kind:'read',phases}));assert.deepEqual(phases,['owner-file','lock-directory','locks-parent','locks-parent']);
 const entered=events.findIndex(row=>row.event==='callback-enter'),exited=events.findIndex(row=>row.event==='callback-exit'),publication=events.findIndex(row=>row.event==='sync-done'&&row.phase==='locks-parent');assert.ok(publication<entered);assert.ok(events.findIndex(row=>row.event==='rmdir')>exited);assert.deepEqual(await fs.readdir(join(f.root,'locks')),[]);
});

test('publication parent and release parent remain awaited callback/result barriers',options,async t=>{
 const f=await sandbox(t),published=barrier(),allowPublication=barrier(),removed=barrier(),allowRemoval=barrier();let callback=false,settled=false;
 observe(f.root,async({phase})=>{if(phase!=='locks-parent')return;if(await exists(f.ownerPath)){published.release();await allowPublication.promise;}else if(!await exists(f.lockPath)){removed.release();await allowRemoval.promise;}});
 const pending=f.store.withLock({key:accountKey},()=>{callback=true;return 'verified-result';});pending.then(()=>{settled=true;},()=>{settled=true;});
 t.after(()=>{allowPublication.release();allowRemoval.release();});await published.promise;assert.equal(callback,false);assert.equal(settled,false);allowPublication.release();await removed.promise;assert.equal(callback,true);assert.equal(settled,false);allowRemoval.release();assert.equal(await pending,'verified-result');
});

for(const phase of ['owner-file','lock-directory','locks-parent'])test('retained '+phase+' publication sync failure prevents callback entry',options,async t=>{
 const f=await sandbox(t);let callback=false,injected=false;
 observe(f.root,async row=>{if(!injected&&row.phase===phase&&(phase!=='locks-parent'||await exists(f.ownerPath))){injected=true;throw Object.assign(Error('synthetic fsync failure'),{code:'EIO'});}});
 await assert.rejects(f.store.withLock({key:accountKey},()=>{callback=true;}),error=>['EMAIL_OAUTH_FILE_STORE_UNAVAILABLE','EMAIL_OAUTH_FILE_STORE_FENCE_LOST'].includes(error.code));assert.equal(injected,true);assert.equal(callback,false);assert.deepEqual(await fs.readdir(join(f.root,'records')),[]);
});

test('retained release parent sync failure withholds successful callback output',options,async t=>{
 const f=await sandbox(t);let callback=false,injected=false;
 observe(f.root,async({phase})=>{if(phase==='locks-parent'&&!await exists(f.lockPath)){injected=true;throw Object.assign(Error('synthetic release fsync failure'),{code:'EIO'});}});
 await assert.rejects(f.store.withLock({key:accountKey},()=>{callback=true;return 'must-not-escape';}),rejection('EMAIL_OAUTH_FILE_STORE_FENCE_LOST'));assert.equal(callback,true);assert.equal(injected,true);
});

test('protected CAS file and records parent sync still precede CAS acknowledgement',options,async t=>{
 const f=await sandbox(t);observe(f.root);await f.store.withLock({key:accountKey},async tx=>{assert.equal(await tx.compareAndSwap({expected_revision:null,value}),true);events.push({event:'cas-ack'});assert.equal(await tx.compareAndSwap({expected_revision:null,value}),false);assert.equal((await tx.read()).revision,1);});
 const phases=events.filter(row=>row.event==='sync-done').map(row=>row.phase);console.log(JSON.stringify({event:'m14_core_syncs',kind:'cas',phases}));assert.deepEqual(phases,['owner-file','lock-directory','locks-parent','record-file','records-parent','locks-parent']);const ack=events.findIndex(row=>row.event==='cas-ack');assert.ok(events.findIndex(row=>row.event==='sync-done'&&row.phase==='record-file')<ack);assert.ok(events.findIndex(row=>row.event==='sync-done'&&row.phase==='records-parent')<ack);
});

for(const phase of ['record-file','records-parent'])test('protected '+phase+' failure never acknowledges a CAS',options,async t=>{
 const f=await sandbox(t);let acknowledged=false,injected=false;observe(f.root,async row=>{if(row.phase===phase&&!injected){injected=true;throw Object.assign(Error('synthetic protected-state fsync failure'),{code:'EIO'});}});
 await assert.rejects(f.store.withLock({key:accountKey},async tx=>{await tx.compareAndSwap({expected_revision:null,value});acknowledged=true;}),rejection('EMAIL_OAUTH_FILE_STORE_UNAVAILABLE'));assert.equal(injected,true);assert.equal(acknowledged,false);hook=null;
 const persisted=await f.store.withLock({key:accountKey},tx=>tx.read());if(phase==='record-file')assert.equal(persisted,null);else assert.equal(persisted.revision,1,'rename may be visible even though durable acknowledgement failed');
});

for(const first of ['read','write'])test('actual second process '+(first==='read'?'write':'read')+' cannot enter while '+first+' holder is active',options,async t=>{
 const f=await sandbox(t),entered=barrier(),release=barrier();observe(f.root);const firstPending=f.store.withLock({key:accountKey},async tx=>{if(first==='write')await tx.compareAndSwap({expected_revision:null,value});else await tx.read();entered.release();await release.promise;});await entered.promise;
 const script=join(f.parent,'contender.mjs'),moduleUrl=new URL('./custody-file-store.mjs',import.meta.url).href;await fs.writeFile(script,`import {createEmailFileCustodyStore} from ${JSON.stringify(moduleUrl)};const store=await createEmailFileCustodyStore({root:${JSON.stringify(f.root)}});process.send('attempt');await store.withLock({key:${JSON.stringify(accountKey)}},async tx=>{process.send('entered');const row=await tx.read();${first==='read'?`if(!await tx.compareAndSwap({expected_revision:row?.revision??null,value:${JSON.stringify(value)}}))throw Error('CAS failed');`:"if(row?.revision!==1)throw Error('committed writer not observed');"}});process.send('done',()=>process.exit(0));`,{mode:0o600});
 const child=fork(script,[],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});let stderr='',didEnter=false;child.stderr.on('data',chunk=>{stderr+=chunk.toString().slice(0,1000);});const attempt=barrier(),done=barrier();child.on('message',message=>{if(message==='attempt')attempt.release();if(message==='entered')didEnter=true;if(message==='done')done.release();});const exited=new Promise((ok,no)=>{child.once('error',no);child.once('exit',(code,signal)=>ok({code,signal}));});t.after(()=>{release.release();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});await attempt.promise;await delay(100);assert.equal(didEnter,false);release.release();await firstPending;await done.promise;assert.deepEqual(await exited,{code:0,signal:null},stderr);assert.equal(didEnter,true);assert.deepEqual(await fs.readdir(join(f.root,'locks')),[]);
});
