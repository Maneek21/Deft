import {nativeComposeInlineFileIds,parseNativeSafeComposeHtml} from '../../../../packages/app-kit/src/safe-compose-html';
import {parseNativeDraftContent,type NativeDraftContent,type NativeDraftSaveState} from './email-native-drafts';
import type {NativeOfflineDraftSnapshot,NativeOfflineDraftScope} from './email-native-offline-drafts';

type Journal={read:()=>Promise<NativeOfflineDraftSnapshot|null>;put:(input:{expectedLocalRevision:number;baseServerRevision:number;content:NativeDraftContent;dirty:boolean;sendOutcome:'none'})=>Promise<NativeOfflineDraftSnapshot>};
export type NativeDraftRecoveryState={checking:boolean;candidate:NativeOfflineDraftSnapshot|null;status:'checking'|'ready'|'saved'|'paused'|'unavailable';notice:string};
const fingerprint=(content:NativeDraftContent)=>JSON.stringify(parseNativeDraftContent(content));
/** Local storage never supplies account authority or a Send receipt. A fresh
 * account check establishes a short session lease; expired leases stop writes,
 * without discarding the live editor's text. */
export function createNativeDraftRecovery(options:{scope:NativeOfflineDraftScope;current:()=>boolean;prove:(signal:AbortSignal)=>Promise<void>;open:(authorize:()=>boolean)=>Promise<Journal>;change:(state:NativeDraftRecoveryState)=>void;now?:()=>number;deadlineMs?:number;leaseMs?:number}){
 const now=options.now??Date.now;let active=true,leaseUntil=0,journal:Journal|null=null,localRevision=0,pending:NativeDraftSaveState|null=null,running:Promise<void>|null=null,renewing:Promise<void>|null=null;
 let state:NativeDraftRecoveryState={checking:true,candidate:null,status:'checking',notice:'Checking browser recovery…'},blocked=true;
 const current=()=>active&&options.current(),authorized=()=>current()&&now()<leaseUntil;
 const emit=()=>{if(current())options.change({...state,candidate:state.candidate?structuredClone(state.candidate):null});};
 const unavailable=()=>{journal=null;blocked=false;state={checking:false,candidate:null,status:'unavailable',notice:'Browser recovery is unavailable. You can keep editing and save to Email.'};emit();};
 const flush=():Promise<void>=>{
  if(running)return running;
  const task=(async()=>{while(pending&&journal&&!blocked&&current()){
   if(!authorized()){state={...state,status:'paused',notice:'Browser recovery paused. Your current text is kept.'};emit();return;}
   const next=pending;pending=null;
   try{const saved=await journal.put({expectedLocalRevision:localRevision,baseServerRevision:next.revision,content:next.content,dirty:next.dirty,sendOutcome:'none'});
    if(!current())return;localRevision=saved.localRevision;if(!authorized()){state={...state,status:'paused',notice:'Browser recovery paused. Your current text is kept.'};emit();return;}state={...state,status:'saved',notice:next.dirty?'Saved in this browser · not yet saved to Email':'Saved to Email and this browser'};emit();
   }catch{if(current())unavailable();return;}
  }})();running=task;void task.finally(()=>{if(running===task)running=null;if(pending&&journal&&!blocked&&authorized())void flush();});return task;
 };
 const prove=async()=>{const controller=new AbortController(),deadline=options.deadlineMs??8000;let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([options.prove(controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Recovery check timed out'));},deadline);})]);
   controller.signal.throwIfAborted();if(!current())throw Error('Account changed');leaseUntil=now()+(options.leaseMs??5*60*1000);
  }finally{if(timer)clearTimeout(timer);controller.abort();}
 };
 const recovery={
  async start(server:NativeDraftSaveState):Promise<void>{let timer:ReturnType<typeof setTimeout>|undefined;let timedOut=false;const retry=state.status!=='checking';blocked=true;state={checking:true,candidate:null,status:'checking',notice:'Checking browser recovery…'};if(retry)emit();try{
    const result=await Promise.race([(async()=>{await prove();if(timedOut||!authorized())throw Error('Account changed');const opened=await options.open(()=>!timedOut&&authorized());if(timedOut||!authorized())throw Error('Account changed');return {opened,local:await opened.read()};})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;leaseUntil=0;reject(Error('Storage timed out'));},options.deadlineMs??8000);})]);
    if(timedOut||!authorized())return;const {opened,local}=result;journal=opened;localRevision=local?.localRevision??0;
    const candidate=local&&(local.sendOutcome==='unknown'||local.dirty&&fingerprint(local.content)!==fingerprint(server.content))?local:null;
    blocked=!!candidate;state={checking:false,candidate,status:'ready',notice:candidate?'A browser draft is available. Your current message is kept.':'Browser recovery ready'};emit();if(!blocked&&pending)await flush();
   }catch{if(current())unavailable();}finally{if(timer)clearTimeout(timer);}},
  record(next:NativeDraftSaveState){if(!current()||next.state==='denied'||next.revision===0&&!next.dirty)return;pending=structuredClone(next);if(!blocked&&journal)void flush();},
  restore(server:NativeDraftSaveState):NativeDraftContent|null{
   const candidate=state.candidate;if(!authorized()||!candidate||candidate.sendOutcome!=='none'||candidate.baseServerRevision!==server.revision||server.dirty)return null;
   const content=parseNativeDraftContent(candidate.content);try{if(/<img\b/iu.test(content.body_html)){const refs=nativeComposeInlineFileIds(content.body_html,{inlineAttachments:content.attachments});if(refs.some(id=>JSON.stringify(content.attachments.find(file=>file.file_id===id))!==JSON.stringify(server.content.attachments.find(file=>file.file_id===id))))throw Error();if(parseNativeSafeComposeHtml(content.body_html,{inlineAttachments:server.content.attachments}).plainText!==content.body)throw Error();}}catch{state={...state,notice:'This browser draft references files that could not be confirmed in the saved draft. Your current message and recovery copy are kept.'};emit();return null;}blocked=false;state={...state,candidate:null,status:'ready',notice:'Browser draft restored. Review it before saving to Email.'};emit();return content;
  },
  keepCurrent(){if(!current())return;pending=null;journal=null;blocked=false;state={checking:false,candidate:null,status:'paused',notice:'Your current draft is kept. The browser recovery copy is unchanged.'};emit();},
  revalidate(force=true,server?:NativeDraftSaveState):Promise<void>{if(renewing)return renewing;if(!current())return Promise.resolve();
   if(!journal){if(state.status!=='unavailable'||!server)return Promise.resolve();const task=recovery.start(server);renewing=task;void task.finally(()=>{if(renewing===task)renewing=null;});return task;}
   if(!force&&leaseUntil-now()>60000)return Promise.resolve();
   const task=(async()=>{try{await prove();if(authorized()&&pending&&!blocked)await flush();}catch{if(current()){leaseUntil=0;state={...state,status:'paused',notice:'Browser recovery paused. Your current text is kept.'};emit();}}})();renewing=task;void task.finally(()=>{if(renewing===task)renewing=null;});return task;
  },
  snapshot:()=>({...state,candidate:state.candidate?structuredClone(state.candidate):null}),
  settled:async()=>{if(running)await running;},
  dispose(){active=false;leaseUntil=0;pending=null;journal=null;state={checking:false,candidate:null,status:'paused',notice:''};}
 };
 return recovery;
}
