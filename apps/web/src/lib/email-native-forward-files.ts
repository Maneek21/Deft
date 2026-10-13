import {readNativeEmailBinary,type NativeReaderPresentation,parseNativeEmailPresentation,throwNativeEmailSourceBusy,NativeEmailSourceBusyError} from './email-native-reader';
import {nativeAttachmentLimit,prepareNativeAttachment} from './email-native-attachments';
import {NativeDraftError,parseNativeDraftContent,emptyNativeDraft,type createNativeDraftWriter} from './email-native-drafts';
import {nativeReceivedSourceLimit,nativeReceivedFileLimit} from './email-native-received-limits';

export type NativeForwardFiles=Pick<NativeReaderPresentation,'account_id'|'logical_message_id'|'source_digest'|'files'>;
export function nativeForwardFiles(value:NativeReaderPresentation):NativeForwardFiles|undefined{
 const source=parseNativeEmailPresentation(value,value.account_id,value.logical_message_id),files=source.files.filter(file=>file.disposition==='attachment');
 return files.length?structuredClone({account_id:source.account_id,logical_message_id:source.logical_message_id,source_digest:source.source_digest,files}):undefined;
}
export type NativeForwardFileState={file_ref:string;filename:string;size_bytes:number;state:'available'|'loading'|'uploading'|'saved'|'failed'|'unconfirmed'|'omitted'|'source_only';notice:string};
export type NativeForwardFilesState={files:NativeForwardFileState[];busy:boolean;blocked:boolean;notice:string};
type Writer=ReturnType<typeof createNativeDraftWriter>;
export function createNativeForwardFiles(options:{origin:NativeForwardFiles;accountId:string;writer:()=>Writer|null;current:()=>boolean;locked:()=>boolean;
 fetch:(path:string,init:RequestInit)=>Promise<Response>;change:(state:NativeForwardFilesState)=>void;saved:()=>void}){
 const origin=structuredClone(options.origin),controller=new AbortController(),ids=new Map<string,ReturnType<typeof crypto.randomUUID>>();let busy=false,active=true,notice='';
 if(origin.account_id!==options.accountId||!/^mail_[a-f0-9]{64}$/u.test(origin.logical_message_id)||!/^[a-f0-9]{64}$/u.test(origin.source_digest)
  ||!origin.files.length||origin.files.length>32||new Set(origin.files.map(f=>f.file_ref)).size!==origin.files.length||origin.files.some(f=>!/^[a-f0-9]{64}$/u.test(f.file_ref)||f.disposition!=='attachment'||!Number.isSafeInteger(f.size_bytes)||f.size_bytes<0||f.size_bytes>nativeReceivedSourceLimit)||origin.files.reduce((n,f)=>n+f.size_bytes,0)>nativeReceivedSourceLimit)throw new NativeDraftError('invalid');
 for(const file of origin.files)parseNativeDraftContent({...emptyNativeDraft(),attachments:[{file_id:'11111111-1111-4111-8111-111111111111',filename:file.filename,media_type:file.media_type,size_bytes:Math.min(file.size_bytes,nativeReceivedFileLimit),sha256:'0'.repeat(64)}]});
 let files:NativeForwardFileState[]=origin.files.map(f=>({file_ref:f.file_ref,filename:f.filename,size_bytes:f.size_bytes,state:f.size_bytes>nativeReceivedFileLimit?'source_only':'available',notice:f.size_bytes>nativeReceivedFileLimit?'This file exceeds the 25 MiB attachment limit. Download the original message to access it; it cannot be included here.':''}));
 const current=()=>active&&!controller.signal.aborted&&options.current();
 const snapshot=():NativeForwardFilesState=>({files:files.map(f=>({...f})),busy,blocked:busy||files.some(f=>['failed','unconfirmed'].includes(f.state)),notice});
 const emit=()=>{if(current())options.change(snapshot());};
 const patch=(ref:string,state:NativeForwardFileState['state'],message='')=>{files=files.map(f=>f.file_ref===ref?{...f,state,notice:message}:f);emit();};
 const valid=(writer:Writer)=>current()&&options.writer()===writer&&!options.locked()&&writer.snapshot().state!=='denied';
 const include=async(refs:string[])=>{
  const writer=options.writer();if(busy||!writer||!valid(writer)||files.some(f=>f.state==='unconfirmed')||!refs.length||new Set(refs).size!==refs.length)return;
  const selected=refs.map(ref=>files.find(f=>f.file_ref===ref));if(selected.some(f=>!f||!['available','failed'].includes(f.state)))return;
  const draft=writer.snapshot().content;
  if(draft.mode!=='forward'||draft.reply_record_id!==origin.logical_message_id)throw new NativeDraftError('invalid');
  if(draft.attachments.length+selected.length>32||draft.attachments.reduce((n,f)=>n+f.size_bytes,0)+selected.reduce((n,f)=>n+f!.size_bytes,0)>nativeAttachmentLimit){notice='Selected originals exceed the draft’s 32-file or 25 MiB limit. Choose fewer files.';emit();return;}
  busy=true;notice='';emit();
  try{
   if(!await writer.save()||!valid(writer)||writer.snapshot().revision<1){for(const f of selected)patch(f!.file_ref,'failed','Save this draft before including the file.');return;}
   for(const chosen of selected){
    if(!valid(writer))return;const file=origin.files.find(f=>f.file_ref===chosen!.file_ref)!;patch(file.file_ref,'loading');
    try{
     const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]);
     const response=await options.fetch(`/api/email/accounts/${encodeURIComponent(origin.account_id)}/messages/${origin.logical_message_id}/file`,{method:'POST',cache:'no-store',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({source_digest:origin.source_digest,file_ref:file.file_ref})});
     if(!valid(writer)||signal.aborted){await response.body?.cancel().catch(()=>{});return;}
     if([401,403].includes(response.status)){await response.body?.cancel().catch(()=>{});writer.deny();return;}
     await throwNativeEmailSourceBusy(response,()=>valid(writer),signal);
     const bytes=await readNativeEmailBinary(response,()=>valid(writer)&&!signal.aborted,{maxBytes:nativeReceivedFileLimit,size:file.size_bytes,mediaType:file.media_type,signal});
     try{
      if(!valid(writer))return;const id=ids.get(file.file_ref)??crypto.randomUUID();ids.set(file.file_ref,id);
      const input=await prepareNativeAttachment(new Blob([new Uint8Array(bytes)],{type:file.media_type}),file.filename,file.media_type,id);
      if(!valid(writer))return;patch(file.file_ref,'uploading');
      if(!await writer.upload(input)){patch(file.file_ref,writer.snapshot().fileMutation?'unconfirmed':'failed','Check the saved draft before continuing.');return;}
      if(!valid(writer))return;patch(file.file_ref,'saved');options.saved();
     }finally{bytes.fill(0);}
    }catch(error){if(!valid(writer))return;if(error instanceof NativeDraftError&&error.kind==='denied'){writer.deny();return;}patch(file.file_ref,'failed',error instanceof NativeEmailSourceBusyError?error.message:'This original file could not be included. Retry or omit it explicitly.');return;}
   }
  }finally{busy=false;emit();}
 };
 return {snapshot,include,sync:()=>{
  const writer=options.writer();if(busy||!writer||!valid(writer))return;const saved=writer.snapshot();if(saved.fileMutation||['error','conflict','denied'].includes(saved.state))return;
  for(const file of files){const found=saved.content.attachments.some(a=>a.file_id===ids.get(file.file_ref));if(file.state==='saved'&&!found)patch(file.file_ref,'omitted');else if(file.state==='unconfirmed'&&found)patch(file.file_ref,'saved');}
 },check:async()=>{
  const writer=options.writer();if(busy||!writer||!valid(writer)||!files.some(f=>f.state==='unconfirmed'))return;
  busy=true;emit();try{if(!await writer.save()||!valid(writer))return;
   for(const f of files.filter(f=>f.state==='unconfirmed')){const id=ids.get(f.file_ref);if(writer.snapshot().content.attachments.some(a=>a.file_id===id)){patch(f.file_ref,'saved');options.saved();}}
  }finally{busy=false;emit();}
 },omit:(ref:string)=>{if(busy||!current()||options.locked())return;const f=files.find(f=>f.file_ref===ref);if(f&&['available','failed'].includes(f.state))patch(ref,'omitted');},dispose:()=>{active=false;controller.abort();files=[];ids.clear();}};
}
