import {removeNativeComposeInlineFiles,nativeComposeInlineFileIds} from '../../../../packages/app-kit/src/safe-compose-html';
import {reconcileNativeSignatureEdit,validNativeSignatureRegionShape,type NativeManagedSignature} from './email-native-signature-region';
type Attachment={file_id:string;filename:string;media_type:string;size_bytes:number;sha256:string};
export type NativeDraftContent={mode:'compose'|'reply'|'reply_all'|'forward';to:string;cc:string;bcc:string;subject:string;body:string;body_html:string;reply_record_id:string;attachments:Attachment[];from_identity?:{address:string};managed_signature?:NativeManagedSignature};
export type NativeDraft={draft_id:string;revision:number;content_revision?:number;status:'draft'|'submitted'|'archived';content:NativeDraftContent;origin:{kind:'human'|'agent';created_by_user_id:string;originating_run_id:string|null};last_edited_by_user_id:string;created_at:string;updated_at:string};
const validId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const validDraftId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const closed=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function parseNativeDraftContent(value:unknown):NativeDraftContent{
 const invalid=()=>{throw new NativeDraftError('invalid');};
 if(!closed(value,['mode','to','cc','bcc','subject','body','body_html','reply_record_id','attachments',...(value&&typeof value==='object'&&Object.hasOwn(value,'from_identity')?['from_identity']:[]),...(value&&typeof value==='object'&&Object.hasOwn(value,'managed_signature')?['managed_signature']:[])]))return invalid();
 if(!['compose','reply','reply_all','forward'].includes(String(value.mode)))return invalid();
 for(const key of ['to','cc','bcc','subject']){const text=value[key];if(typeof text!=='string'||text.length>(key==='subject'?998:16384)||key!=='subject'&&new TextEncoder().encode(text).length>16384||/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text))return invalid();}
 if(typeof value.body!=='string'||value.body.length>262144||/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value.body)||typeof value.body_html!=='string'||value.body_html.length>262144)return invalid();
 if(typeof value.reply_record_id!=='string'||value.reply_record_id!==''&&!/^mail_[a-f0-9]{64}$/u.test(value.reply_record_id)||!Array.isArray(value.attachments)||value.attachments.length>32)return invalid();
 if(Object.hasOwn(value,'from_identity')&&(!closed(value.from_identity,['address'])||typeof value.from_identity.address!=='string'||value.from_identity.address.length>320||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.from_identity.address)))return invalid();
 if(Object.hasOwn(value,'managed_signature')&&!validNativeSignatureRegionShape(value.managed_signature))return invalid();
 let total=0;for(const file of value.attachments){if(!closed(file,['file_id','filename','media_type','size_bytes','sha256'])||!validId(file.file_id)||typeof file.filename!=='string'||!file.filename.length||file.filename.length>255||/[\/\\\u0000-\u001f\u007f]/u.test(file.filename)||typeof file.media_type!=='string'||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/u.test(file.media_type)||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(file.sha256)||typeof file.size_bytes!=='number'||!Number.isSafeInteger(file.size_bytes)||file.size_bytes<0||file.size_bytes>25*1024*1024)return invalid();total+=file.size_bytes;}
 if(total>25*1024*1024||new TextEncoder().encode(JSON.stringify(value)).byteLength>480*1024)return invalid();
 const content=value as unknown as NativeDraftContent;
 return {mode:content.mode,to:content.to,cc:content.cc,bcc:content.bcc,subject:content.subject,body:content.body,body_html:content.body_html,reply_record_id:content.reply_record_id,
  attachments:content.attachments.map(file=>({file_id:file.file_id,filename:file.filename,media_type:file.media_type,size_bytes:file.size_bytes,sha256:file.sha256})),...(content.from_identity?{from_identity:{...content.from_identity}}:{}),...(content.managed_signature?{managed_signature:structuredClone(content.managed_signature)}:{})};
}
function parseRow(value:unknown):NativeDraft{
 const keys=['draft_id','revision','status','content','origin','last_edited_by_user_id','created_at','updated_at'];
 if(!closed(value,keys)&&!closed(value,[...keys,'content_revision']))throw new NativeDraftError('unavailable');
 if(!validDraftId(value.draft_id)||typeof value.revision!=='number'||!Number.isSafeInteger(value.revision)||value.revision<1||value.revision>2147483646||!['draft','submitted','archived'].includes(String(value.status))||!closed(value.origin,['kind','created_by_user_id','originating_run_id'])||!['human','agent'].includes(String(value.origin.kind))||!validId(value.origin.created_by_user_id)||!(value.origin.originating_run_id===null||validId(value.origin.originating_run_id))||!validId(value.last_edited_by_user_id)||typeof value.created_at!=='string'||!Number.isFinite(Date.parse(value.created_at))||typeof value.updated_at!=='string'||!Number.isFinite(Date.parse(value.updated_at)))throw new NativeDraftError('unavailable');
 if(Object.hasOwn(value,'content_revision')&&(typeof value.content_revision!=='number'||!Number.isSafeInteger(value.content_revision)||value.content_revision<1||value.content_revision>value.revision||value.status==='draft'&&value.content_revision!==value.revision||value.status==='submitted'&&value.content_revision>=value.revision))throw new NativeDraftError('unavailable');
 return {...structuredClone(value),content:parseNativeDraftContent(value.content)} as NativeDraft;
}
/** Text-only copies keep formatting while replacing owned image references. */
export function nativeDraftTextCopy(content:NativeDraftContent):NativeDraftContent{
 const next=structuredClone(content);if(/<img\b/iu.test(next.body_html)){const pair=removeNativeComposeInlineFiles(next.body_html,next.attachments.map(file=>file.file_id),{inlineAttachments:next.attachments});next.body_html=pair.html;next.body=pair.plainText;}next.attachments=[];return parseNativeDraftContent(reconcileNativeSignatureEdit(next,content));
}
export const emptyNativeDraft=():NativeDraftContent=>({mode:'compose',to:'',cc:'',bcc:'',subject:'',body:'',body_html:'',reply_record_id:'',attachments:[]});
export class NativeDraftError extends Error {constructor(readonly kind:'conflict'|'denied'|'missing'|'invalid'|'unavailable'){super(kind==='conflict'?'This draft changed elsewhere. Your edits are kept here.':kind==='denied'?'Draft access changed. Reconnect this account in Email settings.':kind==='invalid'?'This draft exceeds its limits or contains unsupported characters.':kind==='missing'?'This draft is no longer available.':'Saving could not be confirmed. Your edits are kept here.');}}
type Fetch=(path:string,options:RequestInit)=>Promise<Response>;
async function readJson(response:Response,maxBytes:number,signal:AbortSignal):Promise<unknown>{
 if(!response.body)throw new NativeDraftError('unavailable');const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 try{for(;;){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;size+=next.value.byteLength;if(size>maxBytes)throw new NativeDraftError('unavailable');text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
 catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
export function createNativeDraftApi(fetch:Fetch,current:()=>boolean){
 const controller=new AbortController();
 const request=async(account:string,draft:string|null,method='GET',body?:unknown):Promise<unknown>=>{
  if(!validId(account)||draft!==null&&!validDraftId(draft))throw new NativeDraftError('invalid');if(!current())throw new NativeDraftError('denied');controller.signal.throwIfAborted();
  const path=`/api/email/accounts/${encodeURIComponent(account)}/drafts${draft?'/'+draft:''}${method==='ARCHIVE'?'/archive':''}`;
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]);
  const response=await fetch(path,{method:method==='ARCHIVE'?'POST':method,signal,...(body===undefined?{}:{body:JSON.stringify(body)})});
  signal.throwIfAborted();if(!current())throw new NativeDraftError('denied');
  if(!response.ok)throw new NativeDraftError([401,403].includes(response.status)?'denied':response.status===409?'conflict':response.status===404?'missing':[400,413].includes(response.status)?'invalid':'unavailable');
  const value=await readJson(response,draft===null?8*1024*1024:512*1024,signal);signal.throwIfAborted();if(!current())throw new NativeDraftError('denied');return value;
 };
 const parse=(value:unknown,expected?:string)=>{const row=parseRow(value);if(expected&&row.draft_id!==expected)throw new NativeDraftError('unavailable');return row;};
 return {list:async(account:string)=>{const value=await request(account,null);if(!closed(value,['items'])||!Array.isArray(value.items)||value.items.length>200)throw new NativeDraftError('unavailable');return value.items.map(parseRow);},
  read:async(account:string,draft:string)=>parse(await request(account,draft),draft),
  save:async(account:string,draft:string,revision:number,content:NativeDraftContent)=>{if(!Number.isSafeInteger(revision)||revision<0||revision>2147483646)throw new NativeDraftError('invalid');return parse(await request(account,draft,'PUT',{expected_revision:revision,content:parseNativeDraftContent(content)}),draft);},
  archive:async(account:string,draft:string,revision:number)=>{if(!Number.isSafeInteger(revision)||revision<1||revision>2147483646)throw new NativeDraftError('invalid');const row=parse(await request(account,draft,'ARCHIVE',{expected_revision:revision}),draft);if(row.status!=='archived')throw new NativeDraftError('unavailable');return row;},
  dispose:()=>controller.abort()};
}
export type NativeDraftApi=ReturnType<typeof createNativeDraftApi>;
export type NativeDraftSaveState={content:NativeDraftContent;revision:number;dirty:boolean;state:'idle'|'saving'|'saved'|'conflict'|'error'|'denied';notice:string;fileMutation?:{kind:'upload'|'detach';fileId:string;filename:string;uncertain:boolean}};

/** Serialize autosaves. An uncertain response is reconciled by reading the
 * same account/UUID before another CAS write; conflicts never overwrite. */
export function createNativeDraftWriter(options:{api:Pick<NativeDraftApi,'read'|'save'>;files?:Pick<NativeAttachmentApi,'upload'|'detach'>;accountId:string;draftId:string;initial?:NativeDraft;initialContent?:NativeDraftContent;current:()=>boolean;change:(state:NativeDraftSaveState)=>void}){
 const fingerprint=(value:NativeDraftContent)=>JSON.stringify(value,(_key,part)=>part&&typeof part==='object'&&!Array.isArray(part)?Object.fromEntries(Object.entries(part).sort(([a],[b])=>a.localeCompare(b))):part);
 let content=structuredClone(options.initial?.content??options.initialContent??emptyNativeDraft()),revision=options.initial?.revision??0;
 let savedContent=structuredClone(options.initial?.content??emptyNativeDraft()),saved=fingerprint(savedContent),dirty=fingerprint(content)!==saved,state:NativeDraftSaveState['state']='idle',notice='',active=true,inflight:Promise<boolean>|null=null;
 let uncertain:{content:NativeDraftContent;revision:number}|null=null;
 type FileMutation={kind:'upload'|'detach';file:NativeAttachment;input?:PreparedNativeAttachment;baseline:NativeDraftContent;revision:number;uncertain:boolean};
 let fileMutation:FileMutation|null=null;
 const current=()=>active&&options.current();
 const fileState=()=>fileMutation?{kind:fileMutation.kind,fileId:fileMutation.file.file_id,filename:fileMutation.file.filename,uncertain:fileMutation.uncertain}:undefined;
 const emit=()=>{if(current())options.change({content:structuredClone(content),revision,dirty,state,notice,fileMutation:fileState()});};
 const acknowledge=(row:NativeDraft,attempt:NativeDraftContent,expected:number)=>{
  if(row.status!=='draft'||row.revision!==expected+1||fingerprint(row.content)!==fingerprint(attempt))throw new NativeDraftError('conflict');
  revision=row.revision;savedContent=structuredClone(row.content);saved=fingerprint(savedContent);dirty=fingerprint(content)!==saved;uncertain=null;
 };
 const changedAttachments=(mutation:FileMutation)=>mutation.kind==='upload'?[...mutation.baseline.attachments,mutation.file]:mutation.baseline.attachments.filter(file=>file.file_id!==mutation.file.file_id);
 const acknowledgeFile=(mutation:FileMutation,nextRevision:number)=>{
  if(nextRevision!==mutation.revision+1)throw new NativeDraftError('conflict');
  const attachments=changedAttachments(mutation);revision=nextRevision;savedContent={...mutation.baseline,attachments};saved=fingerprint(savedContent);
  // Only attachment references come from the acknowledgement. Keep text typed
  // while the upload was held and save it using the newly advanced revision.
  content={...content,attachments:structuredClone(attachments)};dirty=fingerprint(content)!==saved;fileMutation=null;
 };
 const performFile=async()=>{
  const mutation=fileMutation;if(!mutation||!options.files)return;
  if(mutation.uncertain){const row=await options.api.read(options.accountId,options.draftId);if(!current())return;
   const nextContent={...mutation.baseline,attachments:changedAttachments(mutation)};
   if(row.status==='draft'&&row.revision===mutation.revision+1&&fingerprint(row.content)===fingerprint(nextContent)){acknowledgeFile(mutation,row.revision);return;}
   if(row.status!=='draft'||row.revision!==mutation.revision||fingerprint(row.content)!==fingerprint(mutation.baseline))throw new NativeDraftError('conflict');
  }
  state='saving';notice=mutation.kind==='upload'?`Uploading ${mutation.file.filename}…`:`Removing ${mutation.file.filename}…`;emit();mutation.uncertain=true;
  const result=mutation.kind==='upload'?await options.files.upload(options.accountId,options.draftId,mutation.revision,mutation.input!):await options.files.detach(options.accountId,options.draftId,mutation.revision,mutation.file.file_id);
  if(!current())return;acknowledgeFile(mutation,result.revision);
 };
 const perform=async():Promise<boolean>=>{
  try{
   if(state==='conflict'||state==='denied')return false;
   if(fileMutation){await performFile();if(!current())return false;}
   if(uncertain){const attempt=uncertain;let row:NativeDraft|null=null;
    try{row=await options.api.read(options.accountId,options.draftId);}catch(error){if(!(error instanceof NativeDraftError&&error.kind==='missing'&&attempt.revision===0))throw error;}
    if(!current())return false;
    if(row&&row.revision===attempt.revision+1){acknowledge(row,attempt.content,attempt.revision);}
    else if(row&&(row.revision!==attempt.revision||row.status!=='draft'))throw new NativeDraftError('conflict');
    else uncertain=null;
   }
   if(revision>0&&!dirty){state='saved';notice='Saved';emit();return true;}
   do{
    if(!current())return false;const attempt=structuredClone(content),expected=revision;
    parseNativeDraftContent(attempt);state='saving';notice='Saving…';emit();uncertain={content:attempt,revision:expected};
    const row=await options.api.save(options.accountId,options.draftId,expected,attempt);if(!current())return false;
    acknowledge(row,attempt,expected);
   }while(dirty);
   state='saved';notice='Saved';emit();return true;
  }catch(error){if(!current())return false;
   const kind=error instanceof NativeDraftError?error.kind:'unavailable';
   if(['conflict','denied','invalid','missing'].includes(kind)){uncertain=null;fileMutation=null;}
   state=kind==='conflict'?'conflict':kind==='denied'?'denied':'error';notice=new NativeDraftError(kind).message;
   if(state==='denied'){content=emptyNativeDraft();savedContent=emptyNativeDraft();dirty=false;}emit();if(state==='denied')active=false;return false;
  }
 };
 const run=(operation:()=>Promise<boolean>)=>{const previous=inflight;const task=(async()=>{if(previous)await previous;if(!current())return false;return operation();})();inflight=task;const clear=()=>{if(inflight===task)inflight=null;};void task.then(clear,clear);return task;};
 const blockReferencedDetach=(fileId:string)=>{if(!/<img\b/iu.test(content.body_html))return false;try{if(!nativeComposeInlineFileIds(content.body_html,{inlineAttachments:content.attachments}).includes(fileId))return false;}catch{/* Invalid retained image markup cannot authorize a file removal. */}notice='Remove this image from the message before removing its file.';emit();return true;};
 return {edit(next:NativeDraftContent){if(!current()||state==='denied')return;content=reconcileNativeSignatureEdit({...structuredClone(next),attachments:structuredClone(content.attachments)},content);dirty=fingerprint(content)!==saved;if(state!=='conflict'&&state!=='saving'){state='idle';notice=dirty?'Unsaved changes':'';}emit();},
  save(closeIfUntouchedEmpty=false){if(inflight)return inflight;if(closeIfUntouchedEmpty&&revision===0&&!dirty&&!uncertain&&!fileMutation&&state==='idle'&&fingerprint(content)===fingerprint(emptyNativeDraft()))return Promise.resolve(true);if(!dirty&&revision>0&&!uncertain&&!fileMutation&&state!=='conflict'&&state!=='denied')return Promise.resolve(true);return run(perform);},
  upload(input:PreparedNativeAttachment){return run(async()=>{
   if(!options.files||!await perform())return false;
   try{parseNativeDraftContent({...content,attachments:[...content.attachments,input.file]});if(content.attachments.some(file=>file.file_id===input.file.file_id))throw new NativeDraftError('conflict');
    fileMutation={kind:'upload',file:structuredClone(input.file),input,baseline:structuredClone(savedContent),revision,uncertain:false};return await perform();
   }catch{state='error';notice='This file exceeds the draft attachment limits or is unsupported.';emit();return false;}
  });},
  detach(fileId:string){return run(async()=>{if(blockReferencedDetach(fileId))return false;if(!options.files||!await perform())return false;if(blockReferencedDetach(fileId))return false;const file=content.attachments.find(value=>value.file_id===fileId);if(!file)return false;
   fileMutation={kind:'detach',file:structuredClone(file),baseline:structuredClone(savedContent),revision,uncertain:false};return perform();});},
  deny(){if(!current())return;content=emptyNativeDraft();savedContent=emptyNativeDraft();uncertain=null;fileMutation=null;dirty=false;state='denied';notice=new NativeDraftError('denied').message;emit();active=false;},
  dispose(){active=false;content=emptyNativeDraft();savedContent=emptyNativeDraft();uncertain=null;fileMutation=null;},snapshot:()=>({content:structuredClone(content),revision,dirty,state,notice,fileMutation:fileState()})};
}
import type {NativeAttachmentApi,NativeAttachment,PreparedNativeAttachment} from './email-native-attachments';
