export const DAEMON_LIMITS=Object.freeze({max_pages:100,default_pages:10,max_cycle_ms:14400000,default_cycle_ms:900000,admission_ms:10000});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=code=>{throw Error(code);};
export function validateDaemonConfig(config){
 if(config.legacy_schema===true)fail('EMAIL_DAEMON_CANONICAL_ONLY');
 let admission,channel;try{admission=new URL(config.admission_url);channel=new URL(config.url);}catch{fail('EMAIL_DAEMON_CONFIG_INVALID');}
 if(admission.origin!==channel.origin||admission.username||admission.password||admission.search||admission.hash||!/^\/api\/apps\/blob\/sync\/bindings\/[0-9a-f-]{36}\/sync$/.test(admission.pathname)||!uuid.test(admission.pathname.split('/')[6])||!['http:','https:'].includes(admission.protocol)||(admission.protocol==='http:'&&!(config.loopback_fixture===true&&['127.0.0.1','localhost','[::1]'].includes(admission.hostname))))fail('EMAIL_DAEMON_CONFIG_INVALID');
 if(typeof config.owner_access_token!=='string'||!config.owner_access_token||config.owner_access_token.length>8192)fail('EMAIL_DAEMON_OWNER_TOKEN_REQUIRED');
 const pages=config.max_pages_per_cycle??DAEMON_LIMITS.default_pages,cycle=config.max_cycle_ms??DAEMON_LIMITS.default_cycle_ms;
 if(!Number.isInteger(pages)||pages<1||pages>DAEMON_LIMITS.max_pages||!Number.isInteger(cycle)||cycle<1000||cycle>DAEMON_LIMITS.max_cycle_ms)fail('EMAIL_DAEMON_CONFIG_INVALID');
 return {pages,cycle};
}
export function abortableSleep(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted){reject(Error('EMAIL_DAEMON_STOPPED'));return;}const abort=()=>{clearTimeout(timer);reject(Error('EMAIL_DAEMON_STOPPED'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});});}
export async function admitSync(config,signal,fetchImpl=fetch){
 const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,DAEMON_LIMITS.admission_ms);signal?.addEventListener('abort',abort,{once:true});
 try{
  if(signal?.aborted)fail('EMAIL_DAEMON_STOPPED');
  const response=await fetchImpl(config.admission_url,{method:'POST',headers:{Authorization:`Bearer ${config.owner_access_token}`,'Content-Type':'application/json'},body:'{}',signal:controller.signal,redirect:'error'});
  if(!response.ok)fail('EMAIL_DAEMON_ADMISSION_DENIED');
  // Bound even dishonest/chunked host replies; no raw error/token logging.
  const reader=response.body?.getReader();if(!reader)fail('EMAIL_DAEMON_ADMISSION_INVALID');let size=0,bytes=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();fail('EMAIL_DAEMON_ADMISSION_INVALID');}bytes.push(value);}}finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(bytes).toString('utf8'));
 }catch(error){if(controller.signal.aborted)fail(signal?.aborted?'EMAIL_DAEMON_STOPPED':'EMAIL_DAEMON_ADMISSION_UNCONFIRMED');throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

// One finite serial cycle. Restart after an uncertain page is manual recovery,
// never a daemon retry. Owner JWT/SID and cadence remain host-authorized.
export async function drainSyncCycle(config,{runPage,admit=admitSync,sleep=abortableSleep,clock=Date.now,signal,onProgress}={}){
 const {pages,cycle}=validateDaemonConfig(config),deadline=clock()+cycle,seen=new Set();let settled=0,lastHasMore=null;
 const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const timer=setTimeout(abort,cycle);
 try{
  while(settled<pages){
   if(controller.signal.aborted)fail(signal?.aborted?'EMAIL_DAEMON_STOPPED':'EMAIL_DAEMON_CYCLE_DEADLINE');
   if(clock()>=deadline)return {state:'cycle_bound',pages:settled,has_more:lastHasMore};
   const admission=await admit(config,controller.signal);
   if(admission?.state==='not_due'){
    if(Object.keys(admission).sort().join(',')!=='due_at,state')fail('EMAIL_DAEMON_ADMISSION_INVALID');
    const due=Date.parse(admission.due_at),delay=due-clock();if(!Number.isFinite(due)||delay<=0)fail('EMAIL_DAEMON_DUE_INVALID');
    if(due>=deadline)return {state:'cycle_bound',pages:settled,has_more:lastHasMore,due_at:admission.due_at};
    await onProgress?.({state:'waiting',due_at:admission.due_at,pages:settled});await sleep(delay,controller.signal);continue;
   }
   if(admission?.state==='blocked')fail('EMAIL_DAEMON_MANUAL_RECOVERY_REQUIRED');
   if(!['created','existing'].includes(admission?.state)||!uuid.test(admission.run_id)||seen.has(admission.run_id))fail('EMAIL_DAEMON_RUN_INVALID');
   const expected=admission.state==='created'?'attempt_id,run_id,state':'run_id,state';if(Object.keys(admission).sort().join(',')!==expected||(admission.state==='created'&&!uuid.test(admission.attempt_id)))fail('EMAIL_DAEMON_ADMISSION_INVALID');
   seen.add(admission.run_id);
   const result=await runPage(controller.signal,admission.run_id);
   if(result?.type!=='sync_settled'||result.run_id!==admission.run_id||typeof result.has_more!=='boolean')fail('EMAIL_DAEMON_SETTLEMENT_MISMATCH');
   settled++;lastHasMore=result.has_more;await onProgress?.({state:'sync_settled',run_id:result.run_id,pages:settled,has_more:lastHasMore});
   if(!lastHasMore)return {state:'round_complete',pages:settled,has_more:false};
  }
  return {state:'cycle_bound',pages:settled,has_more:lastHasMore};
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
