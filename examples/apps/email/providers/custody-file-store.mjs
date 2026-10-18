import {constants as C} from 'node:fs';
import {lstat,mkdir,open,rename,rmdir,unlink,statfs} from 'node:fs/promises';
import {isAbsolute,join,parse,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {EmailOAuthError,oauthAccountKey,oauthFail,oauthObject,oauthText,validateOAuthBinding} from './oauth-contract.mjs';

const MAX_ROW_BYTES=131072,MAX_ENVELOPE_BYTES=87388;
const wait=ms=>new Promise(done=>setTimeout(done,ms));
const safeKey=key=>{if(typeof key!=='string'||!/^email\.(?:oauth\.(account|state)|send\.operation|triage\.operation)\.[a-f0-9]{64}$/.test(key))oauthFail('EMAIL_OAUTH_FILE_STORE_KEY_INVALID');return key.startsWith('email.oauth.')?key.slice('email.oauth.'.length):key.slice('email.'.length);};
function validateEnvelope(value){
 oauthObject(value,['key_id','iv','tag','ciphertext'],'EMAIL_OAUTH_FILE_STORE_PAYLOAD_INVALID');
 if(!oauthText(value.key_id,64)||!oauthText(value.ciphertext,MAX_ENVELOPE_BYTES)||!/^[A-Za-z0-9_-]+$/.test(value.ciphertext)||typeof value.iv!=='string'||!/^[A-Za-z0-9_-]{16}$/.test(value.iv)||typeof value.tag!=='string'||!/^[A-Za-z0-9_-]{22}$/.test(value.tag))oauthFail('EMAIL_OAUTH_FILE_STORE_PAYLOAD_INVALID');
}
function validatePayload(key,value){
 if(key.startsWith('email.triage.operation.')){
  oauthObject(value,['schema_version','operation_digest','envelope'],'EMAIL_OAUTH_FILE_STORE_PAYLOAD_INVALID');
  if(value.schema_version!=='deft.email_triage_operation.v1'||value.operation_digest!==key.slice('email.triage.operation.'.length))oauthFail('EMAIL_OAUTH_FILE_STORE_PAYLOAD_INVALID');
  validateEnvelope(value.envelope);return;
 }
 if(key.startsWith('email.send.operation.')){
  oauthObject(value,['schema_version','operation_digest','envelope'],'EMAIL_OAUTH_FILE_STORE_PAYLOAD_INVALID');
  if(value.schema_version!=='deft.email_send_operation.v1'||value.operation_digest!==key.slice('email.send.operation.'.length))oauthFail('EMAIL_OAUTH_FILE_STORE_PAYLOAD_INVALID');
  validateEnvelope(value.envelope);return;
 }
 if(value===null){if(!key.startsWith('email.oauth.state.'))oauthFail('EMAIL_OAUTH_FILE_STORE_PAYLOAD_INVALID');return;}
 const state=key.startsWith('email.oauth.state.');oauthObject(value,state?['schema_version','state_digest','binding','browser_digest','expires_at','envelope']:['schema_version','binding','health','setup_generation','envelope'],'EMAIL_OAUTH_FILE_STORE_PAYLOAD_INVALID');
 const binding=validateOAuthBinding(value.binding);
 if(state){if(value.schema_version!=='deft.email_oauth_state.v1'||value.state_digest!==key.slice('email.oauth.state.'.length)||!/^[a-f0-9]{64}$/.test(value.browser_digest??'')||!Number.isSafeInteger(value.expires_at)||value.expires_at<1)oauthFail('EMAIL_OAUTH_FILE_STORE_PAYLOAD_INVALID');}
 else if(value.schema_version!=='deft.email_oauth_tokens.v1'||oauthAccountKey(binding)!==key||!Number.isSafeInteger(value.setup_generation)||value.setup_generation<1||!['connected','refresh_pending','reauth_required','revoked'].includes(value.health))oauthFail('EMAIL_OAUTH_FILE_STORE_PAYLOAD_INVALID');
 validateEnvelope(value.envelope);
}

/**
 * Concrete POSIX EmailCustodyStore. Each successful CAS has fsynced its file and
 * directory before acknowledgement. Fenced directory locks are never stolen,
 * including after expiry or process death. An orphan requires operator recovery.
 * The root must be on a local persistent filesystem and owned by the service UID.
 * Windows/DrvFS/network/tmpfs durability is deliberately unsupported.
 */
export async function createEmailFileCustodyStore({root,ownerUid=null,lock_ttl_ms=120000,max_wait_ms=15000,now=Date.now}){
 if(process.platform==='win32'||typeof process.getuid!=='function')oauthFail('EMAIL_OAUTH_FILE_STORE_PLATFORM_UNSUPPORTED');
 if(typeof root!=='string'||!isAbsolute(root)||root!==resolve(root)||root===parse(root).root||root.includes('\0')||!Number.isSafeInteger(lock_ttl_ms)||lock_ttl_ms<1000||lock_ttl_ms>300000||!Number.isSafeInteger(max_wait_ms)||max_wait_ms<0||max_wait_ms>30000||typeof now!=='function')oauthFail('EMAIL_OAUTH_FILE_STORE_CONFIG_INVALID');
 const processUid=process.getuid();
 // Only the trusted root host may nominate an explicit storage owner. Browser
 // authority never supplies this option; children retain the exact own-UID rule.
 if(ownerUid!==null&&(processUid!==0||!Number.isSafeInteger(ownerUid)||ownerUid<0||ownerUid>4294967294))oauthFail('EMAIL_OAUTH_FILE_STORE_CONFIG_INVALID');
 const uid=ownerUid??processUid,records=join(root,'records'),locks=join(root,'locks');
 async function privateDirectory(path){const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o077)!==0)oauthFail('EMAIL_OAUTH_FILE_STORE_ROOT_NOT_PRIVATE');}
 async function ancestry(){let current=root;for(;;){const stat=await lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())oauthFail('EMAIL_OAUTH_FILE_STORE_PATH_INVALID');const parent=parse(current).dir;if(parent===current)break;current=parent;}}
 async function syncDirectory(path){const handle=await open(path,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);try{await handle.sync();}finally{await handle.close();}}
 async function ownNewDirectory(path){if(uid===processUid)return;const handle=await open(path,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);try{const stat=await handle.stat();if(!stat.isDirectory()||stat.uid!==processUid||(stat.mode&0o077)!==0)oauthFail('EMAIL_OAUTH_FILE_STORE_ROOT_NOT_PRIVATE');await handle.chown(uid,stat.gid);await handle.sync();}finally{await handle.close();}}
 async function ensureDirectory(path){try{await mkdir(path,{mode:0o700});await ownNewDirectory(path);await syncDirectory(parse(path).dir);}catch(error){if(error.code!=='EEXIST')throw error;}await privateDirectory(path);}
 try{
  // Only the nominated final directory may be created; parents must already
  // exist and contain no symlink components.
  await ancestry().catch(async error=>{if(error.code!=='ENOENT')throw error;let parent=parse(root).dir;for(;;){const stat=await lstat(parent);if(!stat.isDirectory()||stat.isSymbolicLink())oauthFail('EMAIL_OAUTH_FILE_STORE_PATH_INVALID');const next=parse(parent).dir;if(next===parent)break;parent=next;}});
  await ensureDirectory(root);await ancestry();
  if(process.platform==='linux'){
   const {type}=await statfs(root);if([0x6969,0xff534d42,0x01021997,0x01021994].includes(Number(type)))oauthFail('EMAIL_OAUTH_FILE_STORE_FILESYSTEM_UNSUPPORTED');
  }
  await ensureDirectory(records);await ensureDirectory(locks);
 }catch(error){if(error instanceof EmailOAuthError)throw error;oauthFail('EMAIL_OAUTH_FILE_STORE_UNAVAILABLE');}
 async function pathsPrivate(){await ancestry();await privateDirectory(root);await privateDirectory(records);await privateDirectory(locks);}
 async function readFile(path,max,{allowRemoved=false}={}){
  let handle;try{handle=await open(path,C.O_RDONLY|C.O_NOFOLLOW);const stat=await handle.stat();if(allowRemoved&&stat.nlink===0)return null;if(!stat.isFile()||stat.uid!==uid||(stat.mode&0o077)!==0||stat.nlink!==1||stat.size>max)oauthFail('EMAIL_OAUTH_FILE_STORE_FILE_INVALID');const bytes=Buffer.alloc(max+1);let size=0;for(;;){const read=await handle.read(bytes,size,bytes.length-size);if(read.bytesRead===0)break;size+=read.bytesRead;if(size>max)oauthFail('EMAIL_OAUTH_FILE_STORE_FILE_INVALID');}return JSON.parse(bytes.subarray(0,size).toString('utf8'));}catch(error){if(error.code==='ENOENT')return null;if(error instanceof EmailOAuthError)throw error;oauthFail('EMAIL_OAUTH_FILE_STORE_FILE_INVALID');}finally{await handle?.close();}
 }
 async function readRow(key){const row=await readFile(join(records,safeKey(key)+'.json'),MAX_ROW_BYTES);if(row===null)return null;oauthObject(row,['revision','value'],'EMAIL_OAUTH_FILE_STORE_FILE_INVALID');if(!Number.isSafeInteger(row.revision)||row.revision<1||!Object.hasOwn(row,'value'))oauthFail('EMAIL_OAUTH_FILE_STORE_FILE_INVALID');validatePayload(key,row.value);return row;}
 async function writeNew(path,value){const handle=await open(path,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);try{if(uid!==processUid){const stat=await handle.stat();if(stat.uid!==processUid||stat.nlink!==1)oauthFail('EMAIL_OAUTH_FILE_STORE_FILE_INVALID');await handle.chown(uid,stat.gid);}await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}}
 return Object.freeze({
  async withLock({key},callback){
   const name=safeKey(key);if(typeof callback!=='function')oauthFail('EMAIL_OAUTH_FILE_STORE_CONFIG_INVALID');const lockPath=join(locks,name+'.lock'),ownerPath=join(lockPath,'owner.json'),nonce=randomBytes(32).toString('hex'),start=performance.now();let acquired=false,active=true;
   async function publishedLockDirectory(graceMs){
    const started=performance.now();
    for(;;){
     const stat=await lstat(lockPath);
     if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)oauthFail('EMAIL_OAUTH_FILE_STORE_ROOT_NOT_PRIVATE');
     if(stat.uid===uid){await privateDirectory(lockPath);return;}
     // A privileged host may create mode-700 directories and chown them to the
     // retained service UID. During that short publication window only, a
     // contender waits for the exact final owner; it never enters or takes the
     // lock. Old, untrusted, or incorrectly-permissioned directories still fail.
     const age=Date.now()-stat.mtimeMs;
     if(processUid!==0||uid===processUid||stat.uid!==processUid||age<0||age>1000||performance.now()-started>=graceMs)
      oauthFail('EMAIL_OAUTH_FILE_STORE_ROOT_NOT_PRIVATE');
     await wait(5);
    }
   }
   async function owner(allowPublicationGrace=false){
    if(allowPublicationGrace){const remaining=Math.max(0,max_wait_ms-(performance.now()-start));await publishedLockDirectory(Math.min(1000,remaining));}
    else await privateDirectory(lockPath);
    const value=await readFile(ownerPath,2048,{allowRemoved:true});if(value===null)return null;oauthObject(value,['schema_version','nonce','pid','expires_at'],'EMAIL_OAUTH_FILE_STORE_STALE_LOCK');if(value.schema_version!=='deft.email_oauth_lock.v1'||!/^[a-f0-9]{64}$/.test(value.nonce??'')||!Number.isSafeInteger(value.pid)||value.pid<1||!Number.isSafeInteger(value.expires_at))oauthFail('EMAIL_OAUTH_FILE_STORE_STALE_LOCK');return value;
   }
   async function fence(){if(!active)oauthFail('EMAIL_OAUTH_FILE_STORE_FENCE_LOST');await pathsPrivate();const value=await owner();if(value?.nonce!==nonce||value.expires_at<=now())oauthFail('EMAIL_OAUTH_FILE_STORE_FENCE_LOST');}
   try{
    for(;;){
     await pathsPrivate();
     try{await mkdir(lockPath,{mode:0o700});acquired=true;await ownNewDirectory(lockPath);const pendingOwner=join(lockPath,nonce+'.tmp');await writeNew(pendingOwner,{schema_version:'deft.email_oauth_lock.v1',nonce,pid:process.pid,expires_at:now()+lock_ttl_ms});await rename(pendingOwner,ownerPath);await syncDirectory(lockPath);await syncDirectory(locks);break;}
     catch(error){
      if(acquired||error.code!=='EEXIST')throw error;
      let current;try{current=await owner(true);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      // A creator can briefly own the directory before its owner file is
      // durable. This grace never deletes or takes over that directory.
      let missingStale=false;if(!current){try{missingStale=Date.now()-(await lstat(lockPath)).mtimeMs>=1000;}catch(error){if(error.code==='ENOENT')continue;throw error;}}
      if(current&&current.expires_at<=now()||missingStale)oauthFail('EMAIL_OAUTH_FILE_STORE_STALE_LOCK');
      if(performance.now()-start>=max_wait_ms)oauthFail('EMAIL_OAUTH_FILE_STORE_LOCK_BUSY');await wait(20);
     }
    }
    await fence();
    const tx=Object.freeze({
     async read(){await fence();const row=await readRow(key);await fence();return row;},
     async compareAndSwap({expected_revision,value}){
      if(expected_revision!==null&&(!Number.isSafeInteger(expected_revision)||expected_revision<1||expected_revision>=Number.MAX_SAFE_INTEGER))oauthFail('EMAIL_OAUTH_FILE_STORE_CONFIG_INVALID');value=structuredClone(value);validatePayload(key,value);const bytes=Buffer.from(JSON.stringify({revision:(expected_revision??0)+1,value}));if(bytes.length>MAX_ROW_BYTES)oauthFail('EMAIL_OAUTH_FILE_STORE_PAYLOAD_LIMIT');
      await fence();const prior=await readRow(key);if((prior?.revision??null)!==expected_revision)return false;
      const temporary=join(records,name+'.'+nonce+'.'+randomBytes(8).toString('hex')+'.tmp');let written=false;
      try{await writeNew(temporary,{revision:(expected_revision??0)+1,value});written=true;await fence();await rename(temporary,join(records,name+'.json'));written=false;await syncDirectory(records);await fence();return true;}finally{if(written)await unlink(temporary).catch(()=>{});}
     }
    });return await callback(tx);
   }catch(error){if(error instanceof EmailOAuthError)throw error;oauthFail('EMAIL_OAUTH_FILE_STORE_UNAVAILABLE');}
   finally{
    if(acquired){
     // A stale holder neither removes a successor's lock nor releases its own
     // expired lock. Failed durability/ownership checks leave an operator gate.
     try{await fence();await unlink(ownerPath);await rmdir(lockPath);await syncDirectory(locks);}catch{active=false;oauthFail('EMAIL_OAUTH_FILE_STORE_FENCE_LOST');}
    }active=false;
   }
  }
 });
}
