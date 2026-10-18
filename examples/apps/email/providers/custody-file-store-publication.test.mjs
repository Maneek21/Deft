import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,writeFile,readdir,lstat,rm,mkdir,chown,unlink,rmdir,utimes,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createEmailFileCustodyStore} from './custody-file-store.mjs';

const rootLinux=process.platform==='linux'&&process.getuid?.()===0,uid=65534,gid=65534;
async function tempRoot(t,prefix){
 const parent=await mkdtemp(join(tmpdir(),prefix));await chmod(parent,0o755);
 t.after(()=>rm(parent,{recursive:true,force:true}));return parent;
}

test('root-owned lock directory publication waits for trusted chown and retries release ENOENT',{skip:!rootLinux},async t=>{
 const parent=await tempRoot(t,'deft-lock-publication-'),root=join(parent,'custody');
 const store=await createEmailFileCustodyStore({root,ownerUid:uid}),key='email.oauth.account.'+'b'.repeat(64);
 // Model the exact interval between root mkdir(0700) and root chown(serviceUid).
 const lock=join(root,'locks','account.'+'b'.repeat(64)+'.lock');await mkdir(lock,{mode:0o700});
 const ownerPath=join(lock,'owner.json');await writeFile(ownerPath,JSON.stringify({schema_version:'deft.email_oauth_lock.v1',nonce:'a'.repeat(64),pid:process.pid,expires_at:Date.now()+5000}),{mode:0o600});await chown(ownerPath,uid,gid);
 let acquired=false;const pending=store.withLock({key},async()=>{acquired=true;return'acquired';});
 await new Promise(resolve=>setTimeout(resolve,40));assert.equal((await lstat(lock)).uid,0);assert.equal(acquired,false);
 await chown(lock,uid,gid);await new Promise(resolve=>setTimeout(resolve,40));
 // A releasing holder may remove the owner and directory between contender stats.
 await unlink(ownerPath);await rmdir(lock);
 assert.equal(await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('bounded publication wait failed')),1500))]),'acquired');
 assert.equal(acquired,true);assert.deepEqual(await readdir(join(root,'locks')),[]);
});

test('publication grace rejects stale, unsafe, symlinked and zero-wait lock directories',{skip:!rootLinux},async t=>{
 const parent=await tempRoot(t,'deft-lock-reject-'),root=join(parent,'custody'),store=await createEmailFileCustodyStore({root,ownerUid:uid,max_wait_ms:0});
 const key='email.oauth.account.'+'c'.repeat(64),lock=join(root,'locks','account.'+'c'.repeat(64)+'.lock');
 await mkdir(lock,{mode:0o755});let began=performance.now();await assert.rejects(store.withLock({key},()=>{}),e=>e.code==='EMAIL_OAUTH_FILE_STORE_ROOT_NOT_PRIVATE');
 assert.ok(performance.now()-began<250,'zero configured wait must not become an ownership grace');await rmdir(lock);
 await mkdir(lock,{mode:0o700});await utimes(lock,new Date(Date.now()-2000),new Date(Date.now()-2000));
 await assert.rejects(store.withLock({key},()=>{}),e=>e.code==='EMAIL_OAUTH_FILE_STORE_ROOT_NOT_PRIVATE');await rmdir(lock);
 const target=join(parent,'target');await mkdir(target,{mode:0o700});await symlink(target,lock);
 await assert.rejects(store.withLock({key},()=>{}),e=>e.code==='EMAIL_OAUTH_FILE_STORE_ROOT_NOT_PRIVATE');
});
