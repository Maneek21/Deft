import {constants as C} from 'node:fs';
import {open,lstat,mkdir,rename,unlink,statfs,rmdir} from 'node:fs/promises';
import {join,isAbsolute,resolve,dirname} from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {validateEmailScope} from '../account-registry.mjs';
import {LOGICAL_MAIL_LIMITS} from '../logical-mail-index.mjs';
import {fail,text} from './contract.mjs';
import {triageJson} from './triage-contract.mjs';

/** Private encrypted metadata/recovery files. A pending acknowledgement is never
 * discarded or replayed automatically. There is no stale lock takeover. */
export async function createSupervisedSyncStateStore({root,scope,account_id,encryption_key,key_id}){
 scope=validateEmailScope(scope);text(account_id,256);text(key_id,64);
 if(process.platform==='win32'||!isAbsolute(root??'')||root!==resolve(root)||root===dirname(root)||!(encryption_key instanceof Uint8Array)||encryption_key.byteLength!==32)fail('EMAIL_SUPERVISED_STATE_INVALID');
 const key=Buffer.from(encryption_key),limit=LOGICAL_MAIL_LIMITS.state_bytes+1048576;
 const aad=kind=>Buffer.from(triageJson({schema_version:'deft.email_supervised_sync_state.v1',scope,account_id,kind,key_id}));
 async function privateRoot(){for(let path=root;;path=dirname(path)){const row=await lstat(path);if(!row.isDirectory()||row.isSymbolicLink()||path===root&&(row.uid!==process.getuid()||(row.mode&0o077)!==0))fail('EMAIL_SUPERVISED_STATE_NOT_PRIVATE');if(dirname(path)===path)break;}if([0x6969,0xff534d42,0x01021997,0x01021994].includes(Number((await statfs(root)).type)))fail('EMAIL_SUPERVISED_STATE_FILESYSTEM_UNSUPPORTED');}
 async function syncDirectory(){const handle=await open(root,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);try{await handle.sync();}finally{await handle.close();}}
 await privateRoot();
 async function read(kind){await privateRoot();let handle,plain;try{handle=await open(join(root,kind+'.json'),C.O_RDONLY|C.O_NOFOLLOW);const row=await handle.stat();if(!row.isFile()||row.uid!==process.getuid()||(row.mode&0o077)!==0||row.nlink!==1||row.size>Math.ceil(limit*4/3)+1024)fail('EMAIL_SUPERVISED_STATE_NOT_PRIVATE');const raw=JSON.parse(await handle.readFile('utf8'));if(raw.schema_version!=='deft.email_supervised_sync_state.v1'||raw.key_id!==key_id||raw.kind!==kind||Object.keys(raw).sort().join(',')!=='ciphertext,iv,key_id,kind,schema_version,tag')fail('EMAIL_SUPERVISED_STATE_CORRUPT');const iv=Buffer.from(raw.iv,'base64url'),tag=Buffer.from(raw.tag,'base64url'),bytes=Buffer.from(raw.ciphertext,'base64url');if(iv.length!==12||tag.length!==16||bytes.length>limit)fail('EMAIL_SUPERVISED_STATE_CORRUPT');const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(kind));cipher.setAuthTag(tag);plain=Buffer.concat([cipher.update(bytes),cipher.final()]);return JSON.parse(plain.toString('utf8'));}catch(error){if(error.code==='ENOENT')return null;if(error.code?.startsWith('EMAIL_SUPERVISED_'))throw error;fail('EMAIL_SUPERVISED_STATE_CORRUPT');}finally{plain?.fill(0);await handle?.close();}}
 async function write(kind,value,{exclusive=false}={}){await privateRoot();const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>limit)fail('EMAIL_SUPERVISED_STATE_LIMIT');let handle;const temporary=join(root,'.pending-'+randomUUID());try{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(kind));const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);const envelope={schema_version:'deft.email_supervised_sync_state.v1',key_id,kind,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),ciphertext:ciphertext.toString('base64url')};
   if(exclusive){handle=await open(join(root,kind+'.json'),C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);}else handle=await open(temporary,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
   await handle.writeFile(JSON.stringify(envelope));await handle.sync();await handle.close();handle=null;if(!exclusive)await rename(temporary,join(root,kind+'.json'));await syncDirectory();
  }finally{bytes.fill(0);await handle?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}}
 let held=false;
 return Object.freeze({
  async withSupervisorLock(callback){if(held)fail('EMAIL_SUPERVISED_STATE_LOCKED');await privateRoot();const lock=join(root,'supervisor.lock');try{await mkdir(lock,{mode:0o700});await syncDirectory();}catch(error){if(error.code==='EEXIST')fail('EMAIL_SUPERVISED_STATE_LOCKED');throw error;}held=true;try{return await callback();}finally{held=false;await rmdir(lock);await syncDirectory();}},
  async hasPending(){return await read('attempt')!==null||await read('recovery')!==null;},
  async load(){return read('index');},
  inventoryPath(){fail('EMAIL_SUPERVISED_IMAP_UNSUPPORTED');},
  async beginAttempt(claim){if(!held)fail('EMAIL_SUPERVISED_STATE_LOCK_REQUIRED');await write('attempt',{claim,acknowledgement:'unconfirmed'},{exclusive:true});},
  async stage(value){if(!held)fail('EMAIL_SUPERVISED_STATE_LOCK_REQUIRED');await write('recovery',value,{exclusive:true});},
  async commit(){if(!held)fail('EMAIL_SUPERVISED_STATE_LOCK_REQUIRED');const pending=await read('recovery');if(!pending?.index_state)fail('EMAIL_SUPERVISED_RECOVERY_REQUIRED');await write('index',pending.index_state);await unlink(join(root,'recovery.json'));await unlink(join(root,'attempt.json'));await syncDirectory();},
 });
}
