import {open,lstat} from 'node:fs/promises';
import {constants as FS} from 'node:fs';
import {spawn} from 'node:child_process';

/** Kernel lock belongs to the inherited open-file description. Closing the
 * manager fd releases it even after SIGKILL; no PID-based lock theft is needed. */
export async function withEmailOwnerSessionLock(path,work){
 if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('EMAIL_SERVICE_TRUSTED_MANAGER_REQUIRED');
 const handle=await open(path,FS.O_CREAT|FS.O_RDWR|FS.O_NOFOLLOW,0o600);
 try{
  const stat=await handle.stat(),entry=await lstat(path);
  if(!stat.isFile()||entry.isSymbolicLink()||stat.uid!==0||stat.nlink!==1||(stat.mode&0o077)!==0||stat.dev!==entry.dev||stat.ino!==entry.ino)throw Error('EMAIL_SERVICE_OWNER_LOCK_INVALID');
  // -n/-x/FD is supported by util-linux and the bundled Alpine BusyBox flock.
  const deadline=Date.now()+20000;
  for(;;){const code=await new Promise((ok,no)=>{
   const child=spawn('/usr/bin/flock',['-n','-x','3'],{env:{PATH:process.env.PATH},stdio:['ignore','ignore','ignore',handle.fd],signal:AbortSignal.timeout(1000)});
   child.once('error',()=>no(Error('EMAIL_SERVICE_OWNER_LOCK_UNAVAILABLE')));child.once('close',ok);
  });if(code===0)break;if(code!==1)throw Error('EMAIL_SERVICE_OWNER_LOCK_UNAVAILABLE');if(Date.now()>=deadline)throw Error('EMAIL_SERVICE_OWNER_LOCK_TIMEOUT');await new Promise(done=>setTimeout(done,50));}
  const current=await lstat(path);if(current.dev!==stat.dev||current.ino!==stat.ino)throw Error('EMAIL_SERVICE_OWNER_LOCK_INVALID');
  return await work();
 }finally{await handle.close();}
}

/** All managers sharing one owner web session read and rotate the same durable
 * pair under one lock. A lost refresh reply stays latched across restart. */
export function createEmailSharedOwnerSession({lock,read,write,loadPending,savePending,clearPending,validate,rotate,now=Date.now}){
 return Object.freeze({async current(){return lock(async()=>{
  if(await loadPending())throw Error('EMAIL_SERVICE_OWNER_REFRESH_UNKNOWN');
  const prior=await read(),identity=validate(prior,true);
  if(identity.exp*1000>=now()+60000)return prior;
  await savePending({schema_version:'deft.email_owner_refresh.v1',phase:'uncertain'});
  const next=await rotate(prior.refreshToken),renewed=validate(next,false);
  if(renewed.id!==identity.id||renewed.org_id!==identity.org_id||renewed.sid!==identity.sid
   ||next.refreshToken===prior.refreshToken||renewed.exp*1000<now()+60000)throw Error('EMAIL_SERVICE_OWNER_SESSION_INVALID');
  await write(next);await clearPending();return next;
 });}});
}
