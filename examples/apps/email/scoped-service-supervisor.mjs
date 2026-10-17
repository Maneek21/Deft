import {createHash,randomUUID} from 'node:crypto';
import {open,readFile,lstat,rename,unlink} from 'node:fs/promises';
import {resolve,dirname,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {constants as FS} from 'node:fs';
import {createEmailSharedOwnerSession,withEmailOwnerSessionLock} from './scoped-service-owner-session.mjs';

const VERSION='deft.email_scoped_supervisor.v1';
const fields=['id','registration_id','installation_id','app_version_id','grant_snapshot_id','action_key','runtime_epoch','operator_user_id'];
const fail=code=>{throw Error(code);};
const copy=value=>structuredClone(value);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Trusted technical session expiry bounds the child wall budget. Heartbeats
 * still validate and renew each current Run lease at every authority boundary. */
export function emailScopedChildDeadline({operation_name,lease_expires_at,session_expires_at},now=Date.now()){
 const session=Date.parse(session_expires_at),lease=Date.parse(lease_expires_at);
 if(!['send_message','triage_message','permanent_delete_message'].includes(operation_name)
  ||typeof session_expires_at!=='string'||!Number.isFinite(session)||new Date(session).toISOString()!==session_expires_at
  ||!Number.isFinite(lease)||lease<=now||session<lease||session<=now)fail('EMAIL_SERVICE_SESSION_INVALID');
 return Math.min(session,now+(operation_name==='send_message'?60000:300000));
}
function pins(value){
 if(!value||Object.keys(value).sort().join(',')!==[...fields].sort().join(',')||!['send_message','triage_message','permanent_delete_message'].includes(value.action_key)
  ||!Number.isSafeInteger(value.runtime_epoch)||value.runtime_epoch<1
  ||fields.filter(key=>!['runtime_epoch','action_key'].includes(key)).some(key=>typeof value[key]!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(value[key])))fail('EMAIL_SERVICE_PINS_INVALID');
 return Object.fromEntries(fields.map(key=>[key,value[key]]));
}
/** Manager-only control plane. A claim is durably latched before a provider
 * child starts; uncertainty pauses this exact binding across process restart.
 * The existing Send journal remains the sole provider-effect reservation. */
export async function createEmailScopedSupervisor({binding,org_id=null,store,inspect,issueSession,createClient,runChild,now=Date.now}){
 binding=pins(binding);const identity=digest(binding);
 if(['load','save'].some(key=>typeof store?.[key]!=='function')||[inspect,issueSession,createClient,runChild,now].some(value=>typeof value!=='function'))fail('EMAIL_SERVICE_PORTS_INVALID');
 // Triage needs its full 300s wall budget plus the SDK's 15s claim request
 // bound and 5s for local dispatch. Send preserves its existing 60s reuse rule.
 const minimumSessionMs=binding.action_key==='send_message'?60000:320000;
 let state=await store.load(),credential=null,busy=false;
 if(state===null)state={schema_version:VERSION,identity,phase:'idle',inflight:null,last_run_id:null,code:null};
 if(state?.schema_version!==VERSION||state.identity!==identity||!['idle','claimed','paused'].includes(state.phase)
  ||(state.phase==='claimed'&&!state.inflight)||(state.phase==='idle'&&state.inflight))fail('EMAIL_SERVICE_STATE_INVALID');
 if(state.inflight){state.phase='paused';state.code='EMAIL_SERVICE_INTERRUPTED_UNKNOWN';}
 await store.save(copy(state));
 const status=()=>({schema_version:VERSION,binding_id:binding.id,phase:state.phase,inflight:copy(state.inflight),last_run_id:state.last_run_id,code:state.code,automatic_retry:false});
 const pause=async code=>{state.phase='paused';state.code=code;await store.save(copy(state));return status();};
 return Object.freeze({status,async step(){
  if(busy)fail('EMAIL_SERVICE_CONCURRENT_STEP');if(state.phase==='paused')return status();busy=true;
  try{
   const current=await inspect(binding.id);
   if(current?.binding?.state!=='active'||current.binding.registration_state!=='active'
    ||fields.some(key=>current.binding[key]!==binding[key]))return await pause('EMAIL_SERVICE_REVIEW_CHANGED');
   if(!credential||Date.parse(credential.expires_at)<=now()+minimumSessionMs){
    credential=await issueSession(binding.id);
    if(!credential||Object.keys(credential).sort().join(',')!=='expires_at,session_id,session_token'
     ||!/^[-A-Za-z0-9_]{1,128}$/.test(credential.session_id??'')||!/^[A-Za-z0-9_-]{32,512}$/.test(credential.session_token??'')
     ||typeof credential.expires_at!=='string'||!Number.isFinite(Date.parse(credential.expires_at))
     ||new Date(Date.parse(credential.expires_at)).toISOString()!==credential.expires_at||Date.parse(credential.expires_at)<=now()+minimumSessionMs)return await pause('EMAIL_SERVICE_SESSION_INVALID');
   }
   const sdk=createClient({session_id:credential.session_id,session_token:credential.session_token});
   const claim=await sdk.claim();if(!claim)return status();
   if(claim.operation_name!==binding.action_key||!/^[-A-Za-z0-9_]{1,128}$/.test(claim.run_id??'')
    ||!/^[-A-Za-z0-9_]{1,128}$/.test(claim.attempt_id??'')||claim.audience!=='app_runtime'
    ||claim.runtime_binding_id!==binding.id||claim.runtime_registration_id!==binding.registration_id||claim.runtime_epoch!==binding.runtime_epoch
    ||claim.app_installation_id!==binding.installation_id||claim.app_version_id!==binding.app_version_id||claim.grant_snapshot_id!==binding.grant_snapshot_id
    ||claim.session_id!==credential.session_id||org_id!==null&&claim.org_id!==org_id
    ||['lifecycle_epoch','grant_epoch','session_epoch'].some(key=>!Number.isSafeInteger(claim[key])||claim[key]<0)
    ||!Number.isFinite(Date.parse(claim.lease_expires_at))||Date.parse(claim.lease_expires_at)<=now()
    ||Date.parse(claim.lease_expires_at)>Date.parse(credential.expires_at))return await pause('EMAIL_SERVICE_CLAIM_INVALID');
   state.phase='claimed';state.inflight={run_id:claim.run_id,attempt_id:claim.attempt_id};await store.save(copy(state));
   let result;try{result=await runChild({claim:copy(claim),credential:{session_id:credential.session_id,session_token:credential.session_token},session_expires_at:credential.expires_at});}
   catch{return await pause('EMAIL_SERVICE_CHILD_UNKNOWN');}
   if(result?.run_id!==claim.run_id||!['provider_accepted','triage_settled'].includes(result.state)||result.automatic_retry!==false)return await pause('EMAIL_SERVICE_OUTCOME_UNKNOWN');
   state.phase='idle';state.last_run_id=claim.run_id;state.inflight=null;state.code=null;await store.save(copy(state));return status();
  }catch(error){
   if(state.inflight)return await pause('EMAIL_SERVICE_CHILD_UNKNOWN');
   if([401,403,404,409].includes(error?.status))return await pause('EMAIL_SERVICE_AUTHORITY_DENIED');
   throw error;
  }finally{busy=false;}
 }});
}

async function privateFile(path,uid,max=65536){
 if(!isAbsolute(path??''))fail('EMAIL_SERVICE_PRIVATE_PATH_REQUIRED');
 const moduleRoot=dirname(fileURLToPath(import.meta.url)),absolute=resolve(path);
 if(absolute===moduleRoot||absolute.startsWith(moduleRoot+sep))fail('EMAIL_SERVICE_PRIVATE_PATH_REQUIRED');
 const handle=await open(path,FS.O_RDONLY|FS.O_NOFOLLOW);try{const stat=await handle.stat(),entry=await lstat(path);
  if(!stat.isFile()||entry.isSymbolicLink()||stat.nlink!==1||stat.uid!==uid||(stat.mode&0o077)!==0||stat.size>max)fail('EMAIL_SERVICE_PRIVATE_FILE_INVALID');
  for(let directory=dirname(path);;directory=dirname(directory)){const stat=await lstat(directory);if(stat.isSymbolicLink())fail('EMAIL_SERVICE_PRIVATE_PATH_REQUIRED');
   if(await lstat(resolve(directory,'.git')).then(()=>true,()=>false))fail('EMAIL_SERVICE_PRIVATE_PATH_REQUIRED');if(dirname(directory)===directory)break;}
  return JSON.parse(await handle.readFile('utf8'));
 }finally{await handle.close();}
}
async function durable(path,value){
 const temporary=path+'.pending-'+randomUUID(),handle=await open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
 await rename(temporary,path);const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
}
function ownerClaims(value,config,now,allowExpired=false){
 let claim;try{claim=JSON.parse(Buffer.from(value.accessToken.split('.')[1],'base64url').toString());}catch{fail('EMAIL_SERVICE_OWNER_SESSION_INVALID');}
 let refresh;try{refresh=JSON.parse(Buffer.from(value.refreshToken.split('.')[1],'base64url').toString());}catch{fail('EMAIL_SERVICE_OWNER_SESSION_INVALID');}
 if(claim.purpose!=='web-access'||claim.id!==config.binding.operator_user_id||claim.org_id!==config.org_id
  ||typeof claim.sid!=='string'||!claim.sid||refresh.purpose!=='web-refresh'||refresh.sid!==claim.sid||refresh.id!==claim.id||refresh.org_id!==claim.org_id
  ||!Number.isFinite(refresh.exp)||refresh.exp*1000<=now()
  ||!Number.isFinite(claim.exp)||!allowExpired&&claim.exp*1000<=now()||typeof value.refreshToken!=='string'||!value.refreshToken||value.refreshToken.length>8192)fail('EMAIL_SERVICE_OWNER_SESSION_INVALID');return claim;
}
export async function runEmailScopedSupervisorCli(args){
 if(args.length!==1||process.platform!=='linux'||process.getuid?.()!==0)fail('EMAIL_SERVICE_TRUSTED_MANAGER_REQUIRED');
 const config=await privateFile(args[0],0);
 if(config.schema_version!==VERSION||Object.keys(config).sort().join(',')!=='api,binding,login_file,org_id,poll_ms,schema_version,state_dir,worker_gid,worker_template_file,worker_uid')fail('EMAIL_SERVICE_CONFIG_INVALID');
 config.binding=pins(config.binding);const api=new URL(config.api);
 if(api.protocol!=='https:'||api.origin!==config.api||!/^[-A-Za-z0-9_]{1,128}$/.test(config.org_id??'')
  ||!Number.isInteger(config.worker_uid)||config.worker_uid<1||!Number.isInteger(config.worker_gid)||config.worker_gid<1
  ||!Number.isInteger(config.poll_ms)||config.poll_ms<1000||config.poll_ms>60000||!isAbsolute(config.state_dir??''))fail('EMAIL_SERVICE_CONFIG_INVALID');
 const directory=await lstat(config.state_dir);
 if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==0||(directory.mode&0o077)!==0)fail('EMAIL_SERVICE_MANAGER_NOT_PRIVATE');
 const template=await privateFile(config.worker_template_file,0);
 const triage=config.binding.action_key!=='send_message';
 const templateFields=['schema_version',...(triage?['binding','oauth_binding','resource_key','index_root','index_encryption_key_hex','index_key_id']:['account_binding']),
  'clients','custody_root','encryption_key_hex','key_id','journal_root','journal_encryption_key_hex','journal_key_id'];
 const selected=triage?template.binding:template.account_binding;
 if(Object.keys(template).sort().join(',')!==templateFields.sort().join(',')||template.schema_version!==(triage?'deft.email_triage_service.v1':'deft.email_outgoing_service.v1')
  ||selected?.action_binding_id!==config.binding.id||selected?.scope?.org_id!==config.org_id
  ||selected?.scope?.installation_id!==config.binding.installation_id||selected?.scope?.owner_id!==config.binding.operator_user_id)fail('EMAIL_SERVICE_WORKER_TEMPLATE_INVALID');
 const statePath=resolve(config.state_dir,'state.json'),statusPath=resolve(config.state_dir,'status.json');
 // Hold one OS process per manager state directory. An interrupted manager leaves
 // its durable inflight latch; a dead manager lock may be reclaimed on restart.
 const lockPath=resolve(config.state_dir,'manager.lock');let lock;
 try{lock=await open(lockPath,'wx',0o600);}catch(error){if(error.code!=='EEXIST')throw error;
  const prior=await privateFile(lockPath,0,2048);if(!Number.isInteger(prior.pid)||prior.pid<1)fail('EMAIL_SERVICE_LOCK_INVALID');
  try{process.kill(prior.pid,0);fail('EMAIL_SERVICE_MANAGER_RUNNING');}catch(error){if(error.code!=='ESRCH')throw error;}
  await unlink(lockPath);lock=await open(lockPath,'wx',0o600);
 }
 await lock.writeFile(JSON.stringify({pid:process.pid}));await lock.sync();
 let owner=await privateFile(config.login_file,0);
 ownerClaims(owner,config,Date.now,true);
 const request=async(path,body,authenticated=true)=>{
  const response=await fetch(config.api+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),
   headers:{'content-type':'application/json',...(authenticated?{authorization:'Bearer '+owner.accessToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok){const error=Error('EMAIL_SERVICE_HOST_DENIED');error.status=response.status;throw error;}
  const content=await response.text();if(Buffer.byteLength(content)>65536)fail('EMAIL_SERVICE_HOST_RESPONSE_LIMIT');return JSON.parse(content);
 };
 const refreshPath=config.login_file+'.refresh-state.json';
 const sharedOwner=createEmailSharedOwnerSession({
  lock:work=>withEmailOwnerSessionLock(config.login_file+'.scoped.lock',work),read:()=>privateFile(config.login_file,0),
  write:value=>durable(config.login_file,value),validate:(value,expired)=>ownerClaims(value,config,Date.now,expired),
  rotate:refreshToken=>request('/api/auth/refresh',{refreshToken},false),
  loadPending:async()=>{try{return await privateFile(refreshPath,0,2048);}catch(error){if(error.code==='ENOENT')return null;throw error;}},
  savePending:value=>durable(refreshPath,value),clearPending:async()=>{await unlink(refreshPath);const directory=await open(dirname(refreshPath),'r');try{await directory.sync();}finally{await directory.close();}}
 });
 const refresh=async()=>{try{owner=await sharedOwner.current();}catch(error){error.status=401;throw error;}};
 const {createAppRuntimeClient}=await import('@deft/app-kit');
 const supervisor=await createEmailScopedSupervisor({binding:config.binding,org_id:config.org_id,
  store:{load:async()=>{try{return await privateFile(statePath,0);}catch(error){if(error.code==='ENOENT')return null;throw error;}},save:value=>durable(statePath,value)},
  inspect:async id=>{await refresh();return request('/api/apps/runtime/bindings/'+encodeURIComponent(id));},
  issueSession:async id=>{await refresh();return (await request('/api/apps/blob/composition/runtime/bindings/'+encodeURIComponent(id)+'/sessions',{})).session;},
  createClient:credential=>createAppRuntimeClient({channel_url:config.api+'/api/app-runtime/channel',credential,action_payload_version:'deft.app_action_payload.v1'}),
  runChild:({credential,claim,session_expires_at})=>new Promise((ok,no)=>{
   const deadline=emailScopedChildDeadline({...claim,session_expires_at});
   const child=fork(fileURLToPath(new URL('./scoped-service-child.mjs',import.meta.url)),[],{uid:config.worker_uid,gid:config.worker_gid,
    env:{PATH:process.env.PATH},execArgv:[],stdio:['ignore','ignore','ignore','ipc']});let result;
   const timer=setTimeout(()=>{child.kill('SIGKILL');},Math.max(1,deadline-Date.now()));
   child.on('message',message=>{if(message?.type==='ready')child.send({template,credential,claim,session_expires_at,channel_url:config.api+'/api/app-runtime/channel'});
    else if(message?.type==='settled')result=message.result;});child.once('error',no);child.once('close',code=>{clearTimeout(timer);if(code===0&&result)ok(result);else no(Error('EMAIL_SERVICE_CHILD_UNKNOWN'));});
  })});
 let stopping=false;process.once('SIGTERM',()=>{stopping=true;});process.once('SIGINT',()=>{stopping=true;});
 try{while(!stopping){try{await supervisor.step();}catch(error){if([401,403,404,409].includes(error?.status))throw error;}
   await durable(statusPath,{...supervisor.status(),pid:process.pid,at:new Date().toISOString(),owner_bearer_in_child:false});
   if(supervisor.status().phase==='paused')break;await new Promise(ok=>setTimeout(ok,config.poll_ms));}
  return supervisor.status();
 }finally{await lock.close();await unlink(lockPath);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await runEmailScopedSupervisorCli(process.argv.slice(2))));}
 catch{console.error(JSON.stringify({state:'stopped',code:'EMAIL_SERVICE_STOPPED',automatic_retry:false}));process.exitCode=1;}
}
