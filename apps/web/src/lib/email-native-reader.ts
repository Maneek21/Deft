import type {SourceFile,SourcePresentation} from './app-experience-source-view';
import {createExperiencePresentationElement,printExperiencePresentation,type ExperiencePresentationImageState} from './app-experience-safe-document';
import {emailReadingPreferenceRequest} from './email-reading-preferences';
import {createAttachmentZip,attachmentArchiveFilename} from './email-attachment-zip';
import {nativeReceivedSourceLimit,nativeReceivedFileLimit} from './email-native-received-limits';
import {inspectNativeComposeRaster} from '../../../../packages/app-kit/src/native-compose-raster';

const digest=/^[a-f0-9]{64}$/u,logical=/^mail_[a-f0-9]{64}$/u;
const metadataKeys=['account_id','primary_address','verified_sender_identities','reply_from','reply_to','reply_to_list','reply_cc','subject','message_id','references',
  'conversation_id','conversation_coverage_state','conversation_indexed_count','conversation_exact_count','conversation_observed_at','conversation_drained','mailbox_reset_required'];
export class NativeEmailSourceBusyError extends Error{constructor(){super('Message loading is busy. Try again shortly.');}}
/** Only the bounded authenticated503 code is a capacity notice, never denial. */
export async function throwNativeEmailSourceBusy(response:Response,current:()=>boolean,signal?:AbortSignal):Promise<void>{
  if(response.status!==503||!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type')??'')||!response.body)return;
  const reader=response.body.getReader(),bytes=new Uint8Array(1024);let size=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{
    signal?.throwIfAborted();for(;;){const row=await reader.read();if(row.done)break;
      try{if(!current()||signal?.aborted)throw Error('Message access ended.');if(size+row.value.length>bytes.length)return;bytes.set(row.value,size);size+=row.value.length;}finally{row.value.fill(0);}}
    signal?.throwIfAborted();if(!current())throw Error('Message access ended.');
    let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));}catch{return;}
    if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&(value as {code?:unknown}).code==='EMAIL_SOURCE_BUSY')throw new NativeEmailSourceBusyError();
  }finally{signal?.removeEventListener('abort',abort);bytes.fill(0);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export type NativeReplySeedField='reply_from'|'reply_to'|'reply_to_list'|'reply_cc';
export type NativeReaderPresentation={schema_version:'deft.email_presentation.v1';account_id:string;provider:'gmail'|'microsoft'|'imap_smtp';logical_message_id:string;
  source_digest:string;content_trust:'unsanitized';files:SourceFile[];omitted_file_count?:number;reply_seed_unavailable?:NativeReplySeedField[];presentation:Omit<SourcePresentation,'metadata'|'omitted_file_count'>&{metadata:Record<string,string>}};
export type NativeAttachmentPreview={fileRef:string;filename:string;kind:'text'|'image'|'pdf';loading:boolean;error:string;text:string;clipped:boolean;url:string};
export function nativeAttachmentPreviewKind(file:SourceFile):NativeAttachmentPreview['kind']|null{
  if(file.size_bytes>2097152)return null;
  if(file.preview==='text'&&['text/plain','text/csv','application/json'].includes(file.media_type))return 'text';
  if(file.preview==='image'&&['image/png','image/jpeg','image/gif','image/webp'].includes(file.media_type))return 'image';
  if(file.preview==='pdf'&&file.media_type==='application/pdf')return 'pdf';
  return null;
}
export type NativeReaderState={loading:boolean;notice:string;externalStatus:string;embeddedStatus:string;externalBusy:boolean;externalAvailable:boolean;imageLimit:boolean;
  embeddedBusy:boolean;embeddedAvailable:boolean;
  value:NativeReaderPresentation|null;preview:NativeAttachmentPreview|null;sourceAvailable:boolean;archive?:{busy:boolean;notice:string}|null};
export function parseNativeEmailPresentation(value:unknown,accountId:string,messageId:string):NativeReaderPresentation{
  const fail=():never=>{throw Error('Message content was not confirmed.');};
  const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))return fail();return v as Record<string,unknown>;};
  const closed=(row:Record<string,unknown>,keys:string[])=>{if(Object.keys(row).some(k=>!keys.includes(k)))fail();};
  const bounded=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max;
  const row=object(value);closed(row,['schema_version','account_id','provider','logical_message_id','source_digest','content_trust','files','presentation','omitted_file_count','reply_seed_unavailable']);
  if(row.omitted_file_count!==undefined&&(!Number.isInteger(row.omitted_file_count)||Number(row.omitted_file_count)<0||Number(row.omitted_file_count)>256))fail();
  if(row.reply_seed_unavailable!==undefined&&(!Array.isArray(row.reply_seed_unavailable)||row.reply_seed_unavailable.length>4
    ||new Set(row.reply_seed_unavailable).size!==row.reply_seed_unavailable.length||row.reply_seed_unavailable.some(key=>!['reply_from','reply_to','reply_to_list','reply_cc'].includes(key))))fail();
  if(row.schema_version!=='deft.email_presentation.v1'||row.account_id!==accountId||!accountId||accountId.length>256||accountId.trim()!==accountId||/[\u0000-\u001f\u007f]/u.test(accountId)
    ||row.logical_message_id!==messageId||!logical.test(messageId)||typeof row.provider!=='string'||!['gmail','microsoft','imap_smtp'].includes(row.provider)
    ||typeof row.source_digest!=='string'||!digest.test(row.source_digest)||row.content_trust!=='unsanitized')fail();
  const p=object(row.presentation);closed(p,['format','content','plain_text','truncated','images','headers','metadata','rendering_fallback']);
  if(p.rendering_fallback!==undefined&&(p.rendering_fallback!=='plain_text'||p.format!=='plain'||!Array.isArray(p.images)||p.images.length!==0))fail();
  if(typeof p.format!=='string'||!['plain','html'].includes(p.format)||typeof p.truncated!=='boolean')fail();
  for(const key of ['content','plain_text'])if(!bounded(p[key],262144)||new TextEncoder().encode(p[key] as string).length>262144||(p[key] as string).includes('\0'))fail();
  if(!Array.isArray(p.images)||p.images.length>32||!Array.isArray(p.headers)||p.headers.length>6||!Array.isArray(row.files)||row.files.length>32)fail();
  for(const raw of p.images as unknown[]){const image=object(raw);closed(image,['image_ref','kind','index','alt']);
    if(typeof image.image_ref!=='string'||!digest.test(image.image_ref)||typeof image.kind!=='string'||!['cid','remote'].includes(image.kind)
      ||!Number.isInteger(image.index)||Number(image.index)<0||Number(image.index)>31||!bounded(image.alt,200))fail();}
  for(const raw of p.headers as unknown[]){const header=object(raw);closed(header,['label','value']);
    if(typeof header.label!=='string'||!['From','To','Cc','Reply-To','Date','Subject'].includes(header.label)||!bounded(header.value,2048)||/[\r\n\0]/u.test(header.value as string))fail();}
  for(const raw of row.files as unknown[]){const f=object(raw);closed(f,['file_ref','filename','media_type','size_bytes','disposition','preview','content_id']);
    if(typeof f.file_ref!=='string'||!digest.test(f.file_ref)||!bounded(f.filename,200)||!f.filename||/[\u0000-\u001f\u007f/\\]/u.test(f.filename as string)
      ||!bounded(f.media_type,128)||!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(f.media_type as string)
      ||!Number.isSafeInteger(f.size_bytes)||Number(f.size_bytes)<0||Number(f.size_bytes)>nativeReceivedSourceLimit
      ||typeof f.disposition!=='string'||!['inline','attachment'].includes(f.disposition)||typeof f.preview!=='string'||!['text','image','pdf','unsupported'].includes(f.preview)
      ||f.content_id!==undefined&&!bounded(f.content_id,256))fail();}
  const metadata=object(p.metadata);closed(metadata,metadataKeys);if(Object.values(metadata).some(v=>!bounded(v,16384)||new TextEncoder().encode(v as string).length>16384))fail();
  if((row.reply_seed_unavailable as NativeReplySeedField[]|undefined)?.some(key=>metadata[key]!==''))fail();
  const parsed=row as unknown as NativeReaderPresentation;
  if(metadata.account_id!==accountId
    ||new Set(parsed.files.map(f=>f.file_ref)).size!==parsed.files.length||parsed.files.reduce((n,f)=>n+f.size_bytes,0)>nativeReceivedSourceLimit
    ||new Set(parsed.presentation.images.map(i=>i.image_ref)).size!==parsed.presentation.images.length||new Set(parsed.presentation.images.map(i=>i.index)).size!==parsed.presentation.images.length)
    throw Error('Message content was not confirmed.');
  return parsed;
}

/** Native binary responses are tied to the request's account/logical identity
 * and immutable digest. They never become public provider URLs. */
export async function readNativeEmailBinary(response:Response,current:()=>boolean,options:{maxBytes:number;size?:number;mediaType?:string;image?:boolean;signal?:AbortSignal}):Promise<Uint8Array>{
  const type=response.headers.get('content-type')??'';
  const reject=async(message:string):Promise<never>=>{await response.body?.cancel().catch(()=>{});throw Error(message);};
  if(!response.ok||response.headers.get('x-content-type-options')!=='nosniff'||!response.body||!current()
    ||options.image&&!['image/png','image/jpeg','image/gif','image/webp'].includes(type)
    ||options.mediaType!==undefined&&type!==options.mediaType
    ||!options.image&&!response.headers.get('content-disposition')?.startsWith('attachment;'))return reject('Message file could not be loaded.');
  const length=response.headers.has('content-length')?Number(response.headers.get('content-length')):null;
  if(length!==null&&(!Number.isSafeInteger(length)||length<0||length>options.maxBytes||options.size!==undefined&&length!==options.size))return reject('Message file exceeds its limit.');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let count=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};options.signal?.addEventListener('abort',abort,{once:true});
  try{
    options.signal?.throwIfAborted();
    for(;;){const row=await reader.read();if(row.done)break;chunks.push(row.value);count+=row.value.length;
      if(!current()||count>options.maxBytes||length!==null&&count>length)throw Error('Message file could not be loaded.');}
    if(options.signal?.aborted||!current()||length!==null&&count!==length||options.size!==undefined&&count!==options.size||options.image&&count<12)
      throw Error('Message file could not be loaded.');
    const bytes=new Uint8Array(count);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
  }finally{options.signal?.removeEventListener('abort',abort);for(const chunk of chunks)chunk.fill(0);await reader.cancel().catch(()=>{});reader.releaseLock();}
}

type Options={accountId:string;messageId:string;wrap:HTMLElement;current:()=>boolean;fetch:(path:string,init:RequestInit)=>Promise<Response>;
  change:(state:NativeReaderState)=>void;
  render?:typeof createExperiencePresentationElement;print?:typeof printExperiencePresentation;download?:(url:string,filename:string)=>void;};
export function createNativeEmailReader(options:Options){
  const controller=new AbortController(),urls=new Map<string,string>(),imageStates=new Map<string,ExperiencePresentationImageState>(),uniqueImages=new Map<string,string>();
  let active=true,started=false,loadedBytes=0,loadedPixels=0,imageReads=0,body:HTMLElement|null=null;
  const imageWaiters:Array<()=>void>=[];
  let previewRequest:AbortController|null=null,previewUrl:string|null=null,previewGeneration=0;
  let archiveRequest:AbortController|null=null,archiveGeneration=0,archiveBuffers:Uint8Array[]=[];
  let state:NativeReaderState={loading:true,notice:'Loading message…',externalStatus:'',embeddedStatus:'',externalBusy:false,externalAvailable:false,embeddedBusy:false,embeddedAvailable:false,imageLimit:false,value:null,preview:null,sourceAvailable:true};
  const current=()=>active&&!controller.signal.aborted&&options.current();
  const change=(patch:Partial<NativeReaderState>)=>{if(current()){state={...state,...patch};options.change({...state});}};
  const releasePreview=()=>{previewGeneration++;previewRequest?.abort();previewRequest=null;if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=null;};
  const closePreview=()=>{releasePreview();change({preview:null});};
  const releaseArchive=()=>{archiveGeneration++;archiveRequest?.abort();archiveRequest=null;for(const bytes of archiveBuffers)bytes.fill(0);archiveBuffers=[];};
  const cancelArchive=()=>{if(!state.archive?.busy)return;releaseArchive();change({archive:{busy:false,notice:'Attachment ZIP cancelled. No ZIP was saved.'}});};
  const dispose=()=>{active=false;controller.abort();for(const wake of imageWaiters.splice(0))wake();releasePreview();releaseArchive();for(const url of new Set(urls.values()))URL.revokeObjectURL(url);urls.clear();uniqueImages.clear();imageStates.clear();body=null;options.wrap.replaceChildren();state={...state,value:null,preview:null,sourceAvailable:false,archive:null};};
  const denied=()=>{if(current()){options.change({...state,loading:false,value:null,preview:null,sourceAvailable:false,archive:null,notice:'Account access ended. Reconnect the account to continue.',externalAvailable:false});dispose();}};
  const path=`/api/email/accounts/${encodeURIComponent(options.accountId)}/messages/${encodeURIComponent(options.messageId)}`;
  const read=async(suffix:string,init:RequestInit={})=>{
    if(!current())throw Error('Message access ended.');
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15_000),...(init.signal?[init.signal]:[])]),response=await options.fetch(path+suffix,{...init,cache:'no-store',signal});
    if(signal.aborted||!current()){await response.body?.cancel().catch(()=>{});throw Error('Message access ended.');}
    if([401,403].includes(response.status)){denied();throw Error('Message access ended.');}await throwNativeEmailSourceBusy(response,current,signal);return response;
  };
  const render=()=>{if(!current()||!state.value)return;const p=state.value.presentation;
    const next=(options.render??createExperiencePresentationElement)(p,p.images,urls,imageStates);
    if(body)body.replaceWith(next);else options.wrap.replaceChildren(next);body=next;};
  const fetchImages=async(kind:'cid'|'remote')=>{
    if(!current()||!state.value||kind==='remote'&&state.externalBusy||kind==='cid'&&state.embeddedBusy)return;
    change(kind==='remote'?{externalBusy:true}:{embeddedBusy:true});
    const value=state.value,images=value.presentation.images.filter(i=>i.kind===kind&&!urls.has(i.image_ref)&&imageStates.get(i.image_ref)!=='limit');
    const key=kind==='remote'?'externalStatus':'embeddedStatus';let failed=0,unsupported=0,cursor=0,capacityBusy=false;
    if(images.length){change({[key]:kind==='remote'?'Loading external images…':'Loading embedded images…'});for(const i of images)imageStates.set(i.image_ref,'loading');render();}
    const consume=async()=>{for(;;){const image=images[cursor++];if(!image||!current())return;
      // CID and remote choices share the same two in-flight raster reads.
      while(imageReads>=2&&current())await new Promise<void>(resolve=>imageWaiters.push(resolve));
      if(!current())return;imageReads++;
      try{
        const response=await read('/image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_digest:value.source_digest,image_ref:image.image_ref})});
        if(response.ok&&!['image/png','image/jpeg','image/gif','image/webp'].includes(response.headers.get('content-type')??'')){
          unsupported++;imageStates.set(image.image_ref,'unsupported');await response.body?.cancel();continue;}
        const bytes=await readNativeEmailBinary(response,current,{maxBytes:2097152,image:true});
        try{if(!current())return;const type=response.headers.get('content-type')!,info=inspectNativeComposeRaster(bytes,type,'received');
          if(!info){failed++;imageStates.set(image.image_ref,'unavailable');continue;}
          const digestBytes=new Uint8Array(bytes);let digest:ArrayBuffer;
          try{digest=await crypto.subtle.digest('SHA-256',digestBytes);}finally{digestBytes.fill(0);}
          const key=type+':'+Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
          if(!current())return;let url=uniqueImages.get(key);
          if(!url){if(loadedBytes+bytes.length>32*1024*1024||loadedPixels+info.pixels>32_000_000){change({imageLimit:true});imageStates.set(image.image_ref,'limit');continue;}
            url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type}));uniqueImages.set(key,url);loadedBytes+=bytes.length;loadedPixels+=info.pixels;}
          urls.set(image.image_ref,url);imageStates.delete(image.image_ref);render();}
        finally{bytes.fill(0);}
      }catch(error){failed++;capacityBusy ||=error instanceof NativeEmailSourceBusyError;if(current())imageStates.set(image.image_ref,'unavailable');}
      finally{imageReads--;imageWaiters.shift()?.();}
    }};
    await Promise.all([consume(),consume()]);
    if(current()){
      const notices=[state.imageLimit?'Some images exceed this view’s 32 MiB or 32 megapixel limit. Download the original message to view them elsewhere.':'',
        capacityBusy?new NativeEmailSourceBusyError().message:failed?'Some images could not be loaded. Retry to try again.':'',unsupported?'Some image formats are unsupported.':''].filter(Boolean);
      change({[key]:notices.length?notices.join(' '):kind==='remote'&&images.length?'External images loaded for this message.':'',
        ...(kind==='remote'?{externalBusy:false}:{embeddedBusy:false}),externalAvailable:value.presentation.images.some(i=>i.kind==='remote'&&!urls.has(i.image_ref)&&imageStates.get(i.image_ref)!=='limit'),
        embeddedAvailable:value.presentation.images.some(i=>i.kind==='cid'&&!urls.has(i.image_ref)&&imageStates.get(i.image_ref)!=='limit')});render();
    }
  };
  async function load(){
    if(started||!current())return;started=true;
    try{
      const response=await read('/presentation');if(!response.ok)throw Error('Message content is unavailable. Try loading it again.');
      const raw:unknown=await response.json();if(!current())return;
      const value=parseNativeEmailPresentation(raw,options.accountId,options.messageId);
      change({loading:false,value,notice:[value.presentation.rendering_fallback==='plain_text'?'Shown as plain text. Download the original for full formatting.':'',value.presentation.truncated?'Only part of this message is shown. Download the original for the complete message.':''].filter(Boolean).join(' '),
        externalAvailable:value.presentation.images.some(i=>i.kind==='remote'),externalStatus:value.presentation.images.some(i=>i.kind==='remote')
          ?'External images are blocked until you choose to load them. Loading may tell the sender this message was opened.':''});render();
      // A failed preference read retains Ask. Automatic remote fetching requires
      // an explicit saved account choice verified by the authenticated endpoint.
      const preference=emailReadingPreferenceRequest(options.accountId,{fetch:async(path,init)=>{
        const response=await options.fetch(path,{...init,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)])});
        if(current()&&[401,403].includes(response.status))denied();return response;
      },current},undefined,controller.signal).catch(()=>null);
      await fetchImages('cid');const saved=await preference;
      if(current()&&saved?.external_images==='always')await fetchImages('remote');
    }catch(error){if(current())change({loading:false,notice:error instanceof NativeEmailSourceBusyError?error.message:'Message content is unavailable. Try loading it again.'});}
  }
  async function downloadFile(fileRef:string){
    const value=state.value,file=value?.files.find(f=>f.file_ref===fileRef);if(!current()||!value||!file||state.archive?.busy)return;
    if(file.size_bytes>nativeReceivedFileLimit){change({notice:'This file exceeds the 25 MiB attachment download limit. Download the original message to access it.'});return;}
    try{
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)]),response=await read('/file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_digest:value.source_digest,file_ref:file.file_ref}),signal});
      const bytes=await readNativeEmailBinary(response,current,{maxBytes:nativeReceivedFileLimit,size:file.size_bytes,mediaType:file.media_type,signal});
      try{if(!current())return;const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:file.media_type}));
        try{if(options.download)options.download(url,file.filename);else{const a=document.createElement('a');a.href=url;a.download=file.filename;a.click();}}
        finally{URL.revokeObjectURL(url);}}
      finally{bytes.fill(0);}
    }catch(error){if(current())change({notice:error instanceof NativeEmailSourceBusyError?error.message:'This attachment could not be downloaded. Try again.'});}
  }
  async function previewFile(fileRef:string){
    const value=state.value,file=value?.files.find(f=>f.file_ref===fileRef),kind=file&&nativeAttachmentPreviewKind(file);
    if(!current()||!value||!file||!kind||state.archive?.busy)return;
    releasePreview();const generation=previewGeneration,request=new AbortController();previewRequest=request;
    const signal=AbortSignal.any([request.signal,controller.signal,AbortSignal.timeout(15_000)]);
    const owned=()=>current()&&generation===previewGeneration&&!signal.aborted;
    const preview:NativeAttachmentPreview={fileRef,filename:file.filename,kind,loading:true,error:'',text:'',clipped:false,url:''};
    change({preview});
    try{
      const response=await read('/file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_digest:value.source_digest,file_ref:file.file_ref}),signal});
      const bytes=await readNativeEmailBinary(response,owned,{maxBytes:2097152,size:file.size_bytes,mediaType:file.media_type,image:kind==='image',signal});
      try{
        if(!owned())return;
        if(kind==='text'){
          const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))throw Error('Unsupported text');
          change({preview:{...preview,loading:false,text:text.slice(0,262144),clipped:text.length>262144}});
        }else{
          previewUrl=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:file.media_type}));
          change({preview:{...preview,loading:false,url:previewUrl}});
        }
      }finally{bytes.fill(0);}
    }catch(error){if(current()&&generation===previewGeneration)change({preview:{...preview,loading:false,error:error instanceof NativeEmailSourceBusyError?error.message:'This attachment could not be previewed. Retry or download it.'}});}
    finally{if(previewRequest===request)previewRequest=null;}
  }
  const print=()=>{if(!current()||!state.value)return;const p=state.value.presentation;
    (options.print??printExperiencePresentation)(p,p.headers.find(h=>h.label==='Subject')?.value??'Message',p.headers,p.images,urls);};
  async function downloadSource(){
    if(!current()||!state.sourceAvailable||state.archive?.busy)return;
    try{const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)]),response=await read('/source',{signal}),bytes=await readNativeEmailBinary(response,current,{maxBytes:nativeReceivedSourceLimit,mediaType:'message/rfc822',signal});
      try{if(!current())return;const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'message/rfc822'}));
        try{if(options.download)options.download(url,'message.eml');else{const a=document.createElement('a');a.href=url;a.download='message.eml';a.click();}}
        finally{URL.revokeObjectURL(url);}}
      finally{bytes.fill(0);}
    }catch(error){if(current())change({notice:error instanceof NativeEmailSourceBusyError?error.message:'The original message could not be downloaded. This view supports originals up to 35 MiB. Try again.'});}
  }
  async function downloadAttachments(){
    const value=state.value;if(!current()||!value||state.archive?.busy)return;
    const files=value.files.filter(file=>file.disposition==='attachment');if(!files.length)return;
    if(files.reduce((total,file)=>total+file.size_bytes,0)>nativeReceivedFileLimit){change({archive:{busy:false,notice:'These attachments exceed the 25 MiB ZIP limit. Download files individually, or download the original message.'}});return;}
    releaseArchive();closePreview();const generation=archiveGeneration,request=new AbortController();archiveRequest=request;
    const signal=AbortSignal.any([controller.signal,request.signal,AbortSignal.timeout(60_000)]);
    const owned=()=>current()&&generation===archiveGeneration&&!signal.aborted&&state.value===value;
    const entries:Array<{filename:string;bytes:Uint8Array}|undefined>=Array(files.length);let cursor=0,completed=0,failed=0,capacityBusy=false;
    change({archive:{busy:true,notice:`Preparing ${files.length} ${files.length===1?'attachment':'attachments'}…`}});
    const consume=async()=>{while(owned()&&!capacityBusy){
      const index=cursor++,file=files[index];if(!file)return;
      try{
        const fileSignal=AbortSignal.any([signal,AbortSignal.timeout(15_000)]),response=await read('/file',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({source_digest:value.source_digest,file_ref:file.file_ref}),signal:fileSignal});
        const bytes=await readNativeEmailBinary(response,()=>owned()&&!fileSignal.aborted,{maxBytes:nativeReceivedFileLimit,size:file.size_bytes,mediaType:file.media_type,signal:fileSignal});
        if(!owned()){bytes.fill(0);return;}archiveBuffers.push(bytes);entries[index]={filename:file.filename,bytes};
      }catch(error){failed++;capacityBusy ||=error instanceof NativeEmailSourceBusyError;}
      if(owned()){completed++;change({archive:{busy:true,notice:`Preparing attachments: ${completed} of ${files.length} checked…`}});}
    }};
    try{
      await Promise.all([consume(),consume()]);
      if(!owned()){
        if(current()&&generation===archiveGeneration)change({archive:{busy:false,notice:'The ZIP could not be completed. No ZIP was saved. Try again or download attachments individually.'}});
        return;
      }
      if(failed||entries.some(entry=>!entry)){
        change({archive:{busy:false,notice:capacityBusy?`${new NativeEmailSourceBusyError().message} No ZIP was saved.`:`The ZIP is incomplete: ${failed} of ${files.length} attachments could not be downloaded. No ZIP was saved. Try again or download attachments individually.`}});return;
      }
      const bytes=createAttachmentZip(entries as Array<{filename:string;bytes:Uint8Array}>);
      try{
        if(!owned())return;
        const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'application/zip'}));
        try{
          if(!owned())return;
          const name=attachmentArchiveFilename(value.presentation.headers.find(header=>header.label==='Subject')?.value??'');
          if(options.download)options.download(url,name);else{const a=document.createElement('a');a.href=url;a.download=name;a.click();}
          if(owned())change({archive:{busy:false,notice:`ZIP download started for ${files.length} ${value.omitted_file_count?'listed ':''}${files.length===1?'attachment':'attachments'}.`}});
        }finally{URL.revokeObjectURL(url);}
      }finally{bytes.fill(0);}
    }catch{if(owned())change({archive:{busy:false,notice:'The ZIP could not be completed. No ZIP was saved. Try again or download attachments individually.'}});}
    finally{if(generation===archiveGeneration)releaseArchive();}
  }
  return {load,loadExternalImages:()=>fetchImages('remote'),loadEmbeddedImages:()=>fetchImages('cid'),previewFile,closePreview,downloadFile,downloadSource,downloadAttachments,cancelArchive,print,dispose};
}
