import type {ExperienceView} from './app-experience-bridge';
import {nativeEmailSetup} from './email-native-enrollment';

/** Only the existing mailbox Refresh button participates. Drafts, Activity,
 * searches and unrelated Experiences keep their normal event handling. */
export function isEmailMailboxRefresh(view:ExperienceView|null,event:unknown):boolean{
  if(!view||view.root.id!=='email'||!event||typeof event!=='object')return false;
  const click=event as Record<string,unknown>;
  if(click.kind!=='click'||click.node_id!=='refresh'
    ||!view.navigation?.some(item=>item.selected&&/^folder_(inbox|sent|archive|spam|trash)$/.test(item.id)))return false;
  const find=(node:ExperienceView['root']):boolean=>node.kind==='button'
    ?node.id==='refresh'&&!node.disabled:node.kind==='stack'&&node.children.some(find);
  return find(view.root);
}

type Status={checkpoint_revision:number;observed_at:string|null;freshness:'fresh'|'stale'|'unknown';coverage:'complete'|'partial';sync_state:'idle'|'queued'|'syncing'|'failed'|'paused'};
function status(value:unknown,accountId:string):Status{
  if(!value||typeof value!=='object')throw Error('Mailbox freshness was not confirmed.');
  const row=value as Record<string,unknown>;
  if(row.account_id!==accountId||!Number.isSafeInteger(row.checkpoint_revision)||Number(row.checkpoint_revision)<0
    ||!['fresh','stale','unknown'].includes(String(row.freshness))||!['complete','partial'].includes(String(row.coverage))
    ||!['idle','queued','syncing','failed','paused'].includes(String(row.sync_state))
    ||row.observed_at!==null&&(typeof row.observed_at!=='string'||!Number.isFinite(Date.parse(row.observed_at))))
    throw Error('Mailbox freshness was not confirmed.');
  // Do not retain native message payloads or forward them to the Worker. Its
  // subsequent normal Browse still applies its reviewed field projection.
  return {checkpoint_revision:row.checkpoint_revision as number,observed_at:row.observed_at as string|null,
    freshness:row.freshness as Status['freshness'],coverage:row.coverage as Status['coverage'],sync_state:row.sync_state as Status['sync_state']};
}
const pause=(signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{
  const aborted=()=>{clearTimeout(timer);reject(signal.reason);};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',aborted);resolve();},5000);
  signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();
});

export function createNativeEmailRefresh(input:{
  installationId:string;targetKey:string;current:()=>boolean;
  fetch:(path:string,init:RequestInit)=>Promise<Response>;
  reload:()=>Promise<boolean>;notice:(message:string)=>void;
  wait?:(signal:AbortSignal)=>Promise<void>;
}){
  let pending:AbortController|null=null,disposed=false;
  const current=(controller:AbortController)=>!disposed&&pending===controller&&!controller.signal.aborted&&input.current();
  async function start(){
    if(disposed||pending||!input.current())return;
    const controller=new AbortController();pending=controller;
    const check=()=>{controller.signal.throwIfAborted();if(!current(controller))throw Error('Mailbox access ended.');};
    const note=(message:string)=>{check();input.notice(message);};
    const read=async(path:string,init:RequestInit)=>{check();const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]);
      const response=await input.fetch(path,{...init,cache:'no-store',signal});signal.throwIfAborted();check();return response;};
    const json=async(response:Response)=>{const value:unknown=await response.json();check();return value;};
    const fallback=async()=>{check();input.notice('');await input.reload();check();};
    try{
      note('Checking mailbox refresh…');
      const connection=await read(`/api/app-owner-connections/${encodeURIComponent(input.installationId)}/connections/${encodeURIComponent(input.targetKey)}/manage`,
        {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      if(!connection.ok){await fallback();return;}
      const account=nativeEmailSetup(await json(connection));
      if(!account){await fallback();return;}
      const path=`/api/email/accounts/${encodeURIComponent(account.account_id)}/messages?limit=1&include_total=false`;
      const baseline=await read(path,{});
      // No enrollment (or the native feature is disabled): no sync has been
      // requested, so the original provider Refresh remains the fallback.
      if([403,404,503].includes(baseline.status)){await fallback();return;}
      if(!baseline.ok)throw Error('Mailbox freshness was not confirmed.');
      const before=status(await json(baseline),account.account_id);
      const response=await read(`/api/email/accounts/${encodeURIComponent(account.account_id)}/refresh`,
        {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      if(response.status!==202)throw Error('Mailbox refresh was not confirmed. Use Refresh to retry.');
      const result=await json(response) as Record<string,unknown>;
      if(!result||typeof result!=='object'||Object.keys(result).sort().join(',')!=='account_id,state'
        ||result.account_id!==account.account_id||!['queued','syncing','needs_attention'].includes(String(result.state)))
        throw Error('Mailbox refresh was not confirmed.');
      if(result.state==='needs_attention'){note('Mailbox sync needs attention. Check Account connection.');return;}
      note(result.state==='queued'?'Mailbox refresh queued…':'Mailbox sync is running…');
      for(let attempt=0;attempt<6;attempt++){
        await (input.wait??pause)(controller.signal);check();
        const response=await read(path,{});if(!response.ok)throw Error('Mailbox freshness was not confirmed. Use Refresh to retry.');
        const after=status(await json(response),account.account_id);
        if(['failed','paused'].includes(after.sync_state)){note('Mailbox sync needs attention. Check Account connection.');return;}
        if(after.checkpoint_revision>before.checkpoint_revision&&after.freshness==='fresh'&&after.coverage==='complete'){
          check();if(await input.reload()){check();note('Mailbox updated.');return;}
        }
      }
      note('Mailbox updates were not confirmed. Use Refresh to check again.');
    }catch(error){if(current(controller))input.notice(error instanceof Error?error.message:'Mailbox refresh was not confirmed.');}
    finally{if(pending===controller)pending=null;}
  }
  return {start,dispose(){disposed=true;pending?.abort();pending=null;}};
}
