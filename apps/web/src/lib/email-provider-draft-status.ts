export type ProviderDraftState='not_synced'|'queued'|'syncing'|'synced'|'conflict'|'unknown'|'unsupported'|'delete_pending'|'deleted'|'paused';
export type ProviderDraftStatus={account_id:string;draft_id:string;enabled:boolean;draft_revision:number|null;state:ProviderDraftState;generation:number|null;desired_revision:number|null;synced_revision:number|null;updated_at:string|null;recovery_available:boolean;recovery_pending:boolean};
export class ProviderDraftStatusError extends Error {constructor(readonly kind:'denied'|'conflict'|'unavailable'){super(kind==='denied'?'Account access changed. Reconnect in Email settings.':kind==='conflict'?'This draft changed. Check its latest sync status.':'Provider draft status could not be confirmed. Check status before taking another action.');}}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>0&&value<=2147483647;
export function parseProviderDraftStatus(raw:unknown,accountId:string,draftId:string):ProviderDraftStatus{
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='account_id,desired_revision,draft_id,draft_revision,enabled,generation,recovery_available,recovery_pending,state,synced_revision,updated_at')throw new ProviderDraftStatusError('unavailable');
 const value=raw as Record<string,unknown>;
 if(value.account_id!==accountId||value.draft_id!==draftId||typeof value.enabled!=='boolean'||value.draft_revision!==null&&!positive(value.draft_revision)||typeof value.state!=='string'||!['not_synced','queued','syncing','synced','conflict','unknown','unsupported','delete_pending','deleted','paused'].includes(value.state)||typeof value.recovery_available!=='boolean'
  ||typeof value.recovery_pending!=='boolean'||![value.generation,value.desired_revision,value.synced_revision].every(item=>item===null||positive(item))||value.updated_at!==null&&(typeof value.updated_at!=='string'||!/^\d{4}-\d\d-\d\dT/u.test(value.updated_at)||!Number.isFinite(Date.parse(value.updated_at))))throw new ProviderDraftStatusError('unavailable');
 if(value.state==='not_synced'&&(value.generation!==null||value.desired_revision!==null||value.synced_revision!==null||value.updated_at!==null)||value.state!=='not_synced'&&(value.generation===null||value.desired_revision===null||value.updated_at===null)
  ||value.recovery_available&&(!value.enabled||value.state!=='unknown'||value.generation===null||value.desired_revision!==value.draft_revision))throw new ProviderDraftStatusError('unavailable');
 return value as ProviderDraftStatus;
}
async function json(response:Response,signal:AbortSignal){
 if(!response.body)throw Error();const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';
 const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 try{for(;;){signal.throwIfAborted();const item=await reader.read();signal.throwIfAborted();if(item.done)break;bytes+=item.value.byteLength;if(bytes>8192)throw Error();text+=decoder.decode(item.value,{stream:true});}return JSON.parse(text+decoder.decode()) as unknown;}
 finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export type ProviderDraftStatusView={value:ProviderDraftStatus|null;busy:boolean;notice:string;recoveryPending:boolean};
export function createProviderDraftStatus(options:{accountId:string;draftId:string;current:()=>boolean;fetch:(path:string,init:RequestInit)=>Promise<Response>;change:(view:ProviderDraftStatusView)=>void;denied?:()=>void}){
 if(!options.accountId||options.accountId.length>256||!uuid.test(options.draftId))throw new ProviderDraftStatusError('unavailable');
 const base='/api/email/accounts/'+encodeURIComponent(options.accountId)+'/drafts/'+encodeURIComponent(options.draftId)+'/provider-sync';
 let active=true,pending:AbortController|null=null,value:ProviderDraftStatus|null=null,notice='',attemptedGeneration:number|null=null;
 const current=()=>active&&options.current();
 const snapshot=():ProviderDraftStatusView=>({value,busy:pending!==null,notice,recoveryPending:!!value?.recovery_pending||attemptedGeneration!==null&&value?.generation===attemptedGeneration});
 const emit=()=>{if(current())options.change(snapshot());};
 async function request(recover:boolean){
  if(!current()||pending)return;
  if(recover&&(!value?.recovery_available||value.recovery_pending||value.generation===null||value.generation===attemptedGeneration))return;
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]);pending=controller;
  const nomination=recover?{expected_revision:value!.draft_revision,expected_generation:value!.generation}:undefined;
  if(recover)attemptedGeneration=value!.generation;notice=recover?'Requesting provider draft reconciliation…':'';emit();
  try{
   const response=await options.fetch(base+(recover?'/recover':''),{method:recover?'POST':'GET',cache:'no-store',signal,headers:{'Content-Type':'application/json'},...(nomination?{body:JSON.stringify(nomination)}:{})});
   if(!current()){await response.body?.cancel().catch(()=>{});return;}signal.throwIfAborted();
   if(!response.ok){await response.body?.cancel().catch(()=>{});throw new ProviderDraftStatusError([401,403].includes(response.status)?'denied':response.status===409?'conflict':'unavailable');}
   const body=await json(response,signal);if(!current())return;signal.throwIfAborted();
   if(recover){const ack=body as Record<string,unknown>;if(response.status!==202||!ack||typeof ack!=='object'||Array.isArray(ack)||Object.keys(ack).sort().join(',')!=='account_id,draft_id,state'||ack.account_id!==options.accountId||ack.draft_id!==options.draftId||ack.state!=='queued')throw new ProviderDraftStatusError('unavailable');
    notice='Reconciliation requested. Check status in a moment; the provider outcome is not confirmed yet.';
   }else{value=parseProviderDraftStatus(body,options.accountId,options.draftId);notice='';}
  }catch(error){if(current()){const failure=error instanceof ProviderDraftStatusError?error:new ProviderDraftStatusError('unavailable');notice=failure.message;if(failure.kind==='denied'){value=null;options.denied?.();}}}
  finally{if(pending===controller)pending=null;emit();}
 }
 return {snapshot,check:()=>request(false),reconcile:()=>request(true),dispose:()=>{active=false;pending?.abort();pending=null;value=null;}};
}
export function providerDraftStatusText(value:ProviderDraftStatus){
 if(!value.enabled)return 'Provider draft syncing is off. Your Deft draft is kept.';
 if(value.recovery_pending)return 'Provider draft reconciliation is queued or in progress. Its outcome is not confirmed yet.';
 switch(value.state){
  case 'not_synced':return 'This draft has not synced to your provider yet.';
  case 'queued':return 'Waiting to sync to your provider.';
  case 'syncing':return 'Provider draft syncing is in progress.';
  case 'synced':return value.synced_revision===value.draft_revision?'Saved to your provider drafts.':'Your latest edits have not synced to the provider yet.';
  case 'conflict':return 'The provider draft changed. Your Deft copy is kept; it will not overwrite that change.';
  case 'unknown':return 'The provider draft outcome is uncertain. Your Deft copy is kept; another copy will not be created automatically.';
  case 'unsupported':return 'This provider cannot sync this draft. You can keep working in Deft.';
  case 'paused':return 'Provider draft syncing is paused. Your Deft draft is kept.';
  case 'delete_pending':return 'Removal from provider drafts is waiting for confirmation.';
  case 'deleted':return 'The provider draft was removed. Your Deft copy is kept.';
 }
}
