import {fork} from 'node:child_process';
import {resolve} from 'node:path';

// Exactly one owned provider process. Settled IPC is confirmed only after exit.
export function runProvider({root,config,accountFile,fixture,legacySchema,mode,signal,deadlineMs=45000}){
 return new Promise((resolveResult,reject)=>{
  if(signal?.aborted){reject(Error('EMAIL_PROVIDER_STOPPED'));return;}
  const child=fork(resolve(root,'mime-provider.mjs'),[],{cwd:root,execArgv:[],windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,DEFT_EMAIL_ACCOUNT_FILE:accountFile,DEFT_EMAIL_LOOPBACK_FIXTURE:String(fixture),DEFT_EMAIL_LEGACY_SCHEMA:String(legacySchema)}});
  let output,error,exited=false;
  const stop=code=>{error=Error(code);if(!exited)child.kill();};
  const abort=()=>stop('EMAIL_PROVIDER_STOPPED_UNCONFIRMED');
  const timer=setTimeout(()=>stop('EMAIL_PROVIDER_DEADLINE_UNCONFIRMED'),deadlineMs);
  signal?.addEventListener('abort',abort,{once:true});
  child.on('message',message=>{
   if(message?.type==='ready'){if(!error)child.send({...config,mode});}
   else if(message?.type==='sync_settled'||message?.type==='effect_settled'){
    if(output){stop('EMAIL_PROVIDER_DUPLICATE_SETTLEMENT');return;}
    output=message;
   }else if(message?.type==='error'){
    // Provider codes are closed safe metadata; never forward arbitrary text.
    stop('EMAIL_PROVIDER_UNCONFIRMED');
   }
  });
  child.once('error',()=>stop('EMAIL_PROVIDER_START_FAILED'));
  child.once('close',code=>{exited=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error)reject(error);else if(code!==0||!output)reject(Error('EMAIL_PROVIDER_EXIT_UNCONFIRMED'));else resolveResult(output);});
 });
}
