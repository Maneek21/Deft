import type {NativeDraftSaveState} from './email-native-drafts';
export type NativeSendResult={operation_id:string;draft_id:string;draft_revision:number;state:'reserved'|'accepted'|'unknown'};
export type NativeSendState={state:'idle'|'checking'|'flushing'|'sending'|'reserved'|'accepted'|'unknown'|'blocked'|'denied';locked:boolean;busy:boolean;revision:number|null;notice:string};
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const revision=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=1&&v<=2147483646;
const closed=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(key=>Object.hasOwn(v,key));
export function parseNativeSendResult(value:unknown,draftId:string,draftRevision:number):NativeSendResult{
 if(!uuid(draftId)||!revision(draftRevision)||!closed(value,['operation_id','draft_id','draft_revision','state'])||!uuid(value.operation_id)||value.draft_id!==draftId||value.draft_revision!==draftRevision||typeof value.state!=='string'||!['reserved','accepted','unknown'].includes(value.state))throw Error('The send outcome could not be confirmed.');
 return {...value} as NativeSendResult;
}
async function readJson(response:Response,signal:AbortSignal){
 if(!response.body)throw Error();const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';
 const aborted=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();
 try{for(;;){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;bytes+=next.value.byteLength;if(bytes>8192)throw Error();text+=decoder.decode(next.value,{stream:true});}return JSON.parse(text+decoder.decode()) as unknown;}
 finally{signal.removeEventListener('abort',aborted);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
const blockedNotices:Record<string,string>={
 EMAIL_SEND_INVALID:'Review the recipients and message. This draft could not be sent.',
 EMAIL_SEND_NOT_FOUND:'This draft is no longer available. Open Drafts to check its current state.',
 EMAIL_SEND_ATTACHMENT_UNAVAILABLE:'An attachment could not be verified. This draft was not sent; check its saved files.',
 EMAIL_SEND_REPLY_UNAVAILABLE:'The original message is no longer available for this reply. This draft was not sent.',
 EMAIL_SEND_LIMIT_EXCEEDED:'This message exceeds the sending provider’s limits. Nothing was sent; reduce its size or attachments.',
 EMAIL_SEND_SENDER_UNAVAILABLE:'The sending address is unavailable. Reconnect this account in Email settings before sending.'
};
/** One deliberate send uses the exact saved revision. Any ambiguous response
 * permanently switches this controller to status-only recovery; no POST retry. */
export function createNativeEmailSend(options:{accountId:string;draftId:string;current:()=>boolean;fetch:(path:string,init:RequestInit)=>Promise<Response>;
 writer:()=>{save:()=>Promise<boolean>;snapshot:()=>NativeDraftSaveState}|null;change:(state:NativeSendState)=>void;denied:()=>void;accepted:()=>void}){
 if(!id(options.accountId)||!uuid(options.draftId))throw Error('This draft cannot be sent.');
 const controller=new AbortController();let active=true,acceptedPublished=false,needsRecovery=false,operationId:string|null=null;
 let value:NativeSendState={state:'idle',locked:false,busy:false,revision:null,notice:''};
 const current=()=>active&&!controller.signal.aborted&&options.current(),publish=()=>{if(current())options.change({...value});};
 const set=(state:NativeSendState['state'],notice:string,busy=false,locked=!['idle','blocked'].includes(state))=>{value={...value,state,notice,busy,locked};publish();};
 const unknown=()=>set('unknown','Sending is unconfirmed. Check status before sending another copy.');
 const apply=(result:NativeSendResult)=>{
  if(operationId&&operationId!==result.operation_id)throw Error();operationId=result.operation_id;
  if(acceptedPublished&&result.state!=='accepted')throw Error();
  set(result.state,result.state==='accepted'?'Accepted by the sending provider. Delivery is not yet confirmed; Sent may take a moment to update.':result.state==='reserved'?'Sending is pending. Check status; do not send another copy.':'Sending is unconfirmed. Check status before sending another copy.');
  if(result.state==='accepted'&&!acceptedPublished){acceptedPublished=true;try{options.accepted();}catch{/* A cache/UI wake failure cannot turn provider acceptance into an invitation to resend. */}}
 };
 const denied=()=>{set('denied','Account access changed. Reconnect in Email settings; the send outcome may be unconfirmed.');options.denied();};
 const request=async(method:'POST'|'GET',draftRevision:number)=>{
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(45000)]);
  const base=`/api/email/accounts/${encodeURIComponent(options.accountId)}/drafts/${options.draftId}/send`;
  const response=await options.fetch(method==='GET'?`${base}/${draftRevision}`:base,{method,signal,cache:'no-store',headers:{'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify({expected_revision:draftRevision})}:{})});
  if(!current()){await response.body?.cancel().catch(()=>{});return null;}signal.throwIfAborted();
  if([401,403].includes(response.status)){await response.body?.cancel().catch(()=>{});denied();return null;}
  const raw=await readJson(response,signal);if(!current())return null;
  if(!response.ok){if(method==='POST'&&[400,404,422].includes(response.status)&&closed(raw,['code'])&&typeof raw.code==='string'&&blockedNotices[raw.code])set('blocked',blockedNotices[raw.code]);else unknown();return null;}
  return {raw};
 };
 return {async send(){
   if(!current()||value.busy||value.locked)return;set('flushing','Saving the message before sending…',true);
   try{const writer=options.writer();if(!writer||!await writer.save()){if(current())set('blocked','The draft has not been saved. Resolve its save status before sending.');return;}
    if(!current())return;const saved=writer.snapshot();
    if(saved.dirty||saved.fileMutation||!revision(saved.revision)||['conflict','error','denied','saving'].includes(saved.state)){set('blocked','The draft has not been saved. Resolve its save status before sending.');return;}
    value.revision=saved.revision;needsRecovery=true;set('sending','Sending…',true);const response=await request('POST',saved.revision);
    if(response&&current())apply(parseNativeSendResult(response.raw,options.draftId,saved.revision));
   }catch{if(current()){if(value.state==='flushing')set('blocked','The draft could not be saved. Your edits remain here.');else unknown();}}
  },async inspect(draftRevision:number,submitted=false){
   if(!current()||value.busy||!revision(draftRevision))return;
   // An existing send identity can only be checked at its original revision.
   if(value.revision!==null&&value.locked&&value.revision!==draftRevision)return;
   needsRecovery=needsRecovery||submitted;const recovery=needsRecovery||operationId!==null;value.revision=draftRevision;set('checking','Checking send status…',true);
   try{const response=await request('GET',draftRevision);if(!response||!current())return;
    if(!closed(response.raw,['operation']))throw Error();
    if(response.raw.operation===null){if(recovery)unknown();else{value.revision=null;set('idle','',false,false);}return;}
    apply(parseNativeSendResult(response.raw.operation,options.draftId,draftRevision));
   }catch{if(current())unknown();}
  },check(){return this.inspect(value.revision??0,needsRecovery);},snapshot:()=>({...value}),dispose(){active=false;controller.abort();operationId=null;}};
}
