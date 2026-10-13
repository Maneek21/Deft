import {NativeDraftError,emptyNativeDraft,parseNativeDraftContent,type NativeDraftContent} from './email-native-drafts';
import {readNativeEmailBinary} from './email-native-reader';
export type NativeAttachment=NativeDraftContent['attachments'][number];
export type PreparedNativeAttachment={blob:Blob;file:NativeAttachment};
export const nativeAttachmentLimit=25*1024*1024;
const uuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const digest=async(bytes:ArrayBuffer)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
export async function prepareNativeAttachment(blob:Blob,filename:string,mediaType:string,fileId=crypto.randomUUID()):Promise<PreparedNativeAttachment>{
 if(!uuid(fileId)||blob.size>nativeAttachmentLimit)throw new NativeDraftError('invalid');
 const media_type=/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/u.test(mediaType)?mediaType:'application/octet-stream';
 parseNativeDraftContent({...emptyNativeDraft(),attachments:[{file_id:fileId,filename,media_type,size_bytes:blob.size,sha256:'0'.repeat(64)}]});
 const bytes=await blob.arrayBuffer();try{return {blob,file:{file_id:fileId,filename,media_type,size_bytes:blob.size,sha256:await digest(bytes)}};}finally{new Uint8Array(bytes).fill(0);}
}
const sameFile=(a:NativeAttachment,b:NativeAttachment)=>a.file_id===b.file_id&&a.filename===b.filename&&a.media_type===b.media_type&&a.size_bytes===b.size_bytes&&a.sha256===b.sha256;
export function createNativeAttachmentApi(options:{fetch:(path:string,init:RequestInit)=>Promise<Response>;current:()=>boolean;download?:(url:string,name:string)=>void}){
 const controller=new AbortController();const current=()=>!controller.signal.aborted&&options.current();
 const request=async(account:string,draft:string,file:string,init:RequestInit={}):Promise<Response>=>{
  if(!account||account.length>256||account.trim()!==account||/[\u0000-\u001f\u007f-\u009f]/u.test(account)||!uuid(draft)||!uuid(file))throw new NativeDraftError('invalid');
  if(!current())throw new NativeDraftError('denied');const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(60000),...(init.signal?[init.signal]:[])]);
  const response=await options.fetch(`/api/email/accounts/${encodeURIComponent(account)}/drafts/${draft}/files/${file}${init.method==='POST'?'/detach':''}`,{...init,cache:'no-store',signal});
  if(signal.aborted){await response.body?.cancel().catch(()=>{});signal.throwIfAborted();}if(!current()){await response.body?.cancel().catch(()=>{});throw new NativeDraftError('denied');}
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new NativeDraftError([401,403].includes(response.status)?'denied':response.status===409?'conflict':response.status===404?'missing':[400,413].includes(response.status)?'invalid':'unavailable');}return response;
 };
 const revision=(value:unknown,expected:number)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value!==expected+1)throw new NativeDraftError('conflict');return value;};
 const json=async(response:Response)=>{
  if(!response.body)throw new NativeDraftError('unavailable');const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
  try{for(;;){const next=await reader.read();if(!current())throw new NativeDraftError('denied');if(next.done)break;bytes+=next.value.byteLength;if(bytes>4096)throw new NativeDraftError('unavailable');text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();return JSON.parse(text) as Record<string,unknown>;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 };
 return {upload:async(account:string,draft:string,expected:number,input:PreparedNativeAttachment)=>{
   if(input.blob.size!==input.file.size_bytes||!Number.isSafeInteger(expected)||expected<1||expected>2147483645)throw new NativeDraftError('invalid');
   parseNativeDraftContent({...emptyNativeDraft(),attachments:[input.file]});
   const value=await json(await request(account,draft,input.file.file_id,{method:'PUT',headers:{'Content-Type':input.file.media_type,'X-Email-Filename':encodeURIComponent(input.file.filename),'X-Email-Draft-Revision':String(expected)},body:input.blob}));
   if(!value||Object.keys(value).length!==2||!Object.hasOwn(value,'file')||!Object.hasOwn(value,'revision'))throw new NativeDraftError('unavailable');
   const file=parseNativeDraftContent({...emptyNativeDraft(),attachments:[value.file]}).attachments[0];if(!sameFile(file,input.file))throw new NativeDraftError('conflict');return {revision:revision(value.revision,expected),file};
  },detach:async(account:string,draft:string,expected:number,file:string)=>{
   if(!Number.isSafeInteger(expected)||expected<1||expected>2147483645)throw new NativeDraftError('invalid');const value=await json(await request(account,draft,file,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_revision:expected})}));
   if(!value||Object.keys(value).length!==1||!Object.hasOwn(value,'revision'))throw new NativeDraftError('unavailable');return {revision:revision(value.revision,expected)};
  },preview:async(account:string,draft:string,file:NativeAttachment,signal:AbortSignal)=>{
   parseNativeDraftContent({...emptyNativeDraft(),attachments:[file]});if(file.size_bytes>8*1024*1024||!['image/png','image/jpeg','image/gif','image/webp'].includes(file.media_type))throw new NativeDraftError('invalid');
   const ownedSignal=AbortSignal.any([controller.signal,signal]),owned=()=>current()&&!ownedSignal.aborted;const response=await request(account,draft,file.file_id,{signal:ownedSignal}),bytes=await readNativeEmailBinary(response,owned,{maxBytes:8*1024*1024,size:file.size_bytes,mediaType:file.media_type,signal:ownedSignal});
   try{if(await digest(bytes.buffer as ArrayBuffer)!==file.sha256||!owned())throw new NativeDraftError('unavailable');return bytes;}catch(error){bytes.fill(0);throw error;}
  },download:async(account:string,draft:string,file:NativeAttachment)=>{
   parseNativeDraftContent({...emptyNativeDraft(),attachments:[file]});const response=await request(account,draft,file.file_id),bytes=await readNativeEmailBinary(response,current,{maxBytes:nativeAttachmentLimit,size:file.size_bytes,mediaType:file.media_type});
   try{if(await digest(bytes.buffer as ArrayBuffer)!==file.sha256||!current())throw new NativeDraftError('unavailable');const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:file.media_type}));
    try{if(options.download)options.download(url,file.filename);else{const link=document.createElement('a');link.href=url;link.download=file.filename;link.click();}}finally{URL.revokeObjectURL(url);}}
   finally{bytes.fill(0);}
  },dispose:()=>controller.abort()};
}
export type NativeAttachmentApi=ReturnType<typeof createNativeAttachmentApi>;
