'use client';
import {MoreHorizontal} from 'lucide-react';
import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {createNativeEmailReader,nativeAttachmentPreviewKind,type NativeReaderState,type NativeReplySeedField} from '@/lib/email-native-reader';
import {parseNativeMailboxList,formatNativeMailboxList,type MailboxAddress} from '../../../../../packages/app-kit/src/mailbox-list';
import {nativeReceivedFileLimit} from '@/lib/email-native-received-limits';
import {NativeEmailReplyActions} from './native-email-reply-actions';
import type {NativeReplyCompose} from '@/lib/email-native-reply';
import {createNativeReplyCompose} from '@/lib/email-native-reply';
import {nativeEmailShortcut,dismissNativeReaderMenu} from '@/lib/email-native-keyboard';
import {NativeEmailContextTransferAction} from './native-email-context-transfer';
import {NativeEmailCalendarInvitationAction} from './native-email-calendar-invitation';
import {NativeEmailRelatedKnowledge} from './native-email-related-knowledge';
import {NativeEmailAskDefty} from './native-email-ask-defty';
import {formatFullDate,formatEventTime,getUserTimezone} from '@/lib/time';

export function NativeEmailHeaderDate({value}:{value:string}){
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,19)!==value.slice(0,19))return <>{value}</>;
 const label=`${formatFullDate(value)}, ${formatEventTime(value)}`,zone=getUserTimezone();
 return <time dateTime={value} title={`${value} · ${zone}`} aria-label={`${label} in ${zone}. Original timestamp ${value}`}>{label}</time>;
}

export function NativeEmailHeaderSummary({headers,metadata,replySeedUnavailable=[]}:{headers:Array<{label:string;value:string}>;metadata?:Record<string,string>;replySeedUnavailable?:NativeReplySeedField[]}){
 const fields={From:'reply_from',To:'reply_to_list',Cc:'reply_cc','Reply-To':'reply_to'} as const,unavailable=new Set(replySeedUnavailable);
 const detail=(header:{label:string;value:string})=>{
  const key=fields[header.label as keyof typeof fields];let mailboxes:readonly MailboxAddress[]|null=null,complete:string|null=null;
  if(key&&!unavailable.has(key)&&metadata?.[key]?.trim()){try{const parsed=parseNativeMailboxList(metadata[key]);complete=formatNativeMailboxList(parsed);mailboxes=parsed;}catch{/* Short legacy display remains available; capped display cannot prove completeness. */}}
  return {...header,value:complete??header.value,mailboxes,incomplete:!!key&&(unavailable.has(key)||!mailboxes&&header.value.length>=2048)};
 };
 const details=headers.filter(h=>h.label!=='Subject').map(detail);
 for(const [label,key] of Object.entries(fields))if(unavailable.has(key)&&!details.some(h=>h.label===label))details.push(detail({label,value:''}));
 const clip=(value:string,max:number)=>{if(value.length<=max)return value;let text=value.slice(0,max-1);if(/[\ud800-\udbff]$/u.test(text))text=text.slice(0,-1);return text+'…';};
 const compact=(header:ReturnType<typeof detail>)=>header.incomplete?(header.label==='From'?'Sender information incomplete':'Recipient list incomplete'):header.mailboxes&&header.mailboxes.length>1?`${clip(header.mailboxes[0].displayName||header.mailboxes[0].address,80)} +${header.mailboxes.length-1} more`:clip(header.value,120);
 const from=details.find(h=>h.label==='From'),to=details.find(h=>h.label==='To'),sender=from?compact(from)||'Unknown sender':'Unknown sender',recipient=to?compact(to):'';
 const date=headers.find(h=>h.label==='Date')?.value;
 return <div className="min-w-0 space-y-1">
   <p className="truncate text-sm font-medium" title={sender}>{sender}</p>
   <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
     {recipient&&<p className="min-w-0 max-w-full truncate" title={`To: ${recipient}`}>To: {recipient}</p>}
     {date&&<span><NativeEmailHeaderDate value={date}/></span>}
     <details className="min-w-0 basis-full">
       <summary className="w-fit cursor-pointer rounded-md text-xs hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--primary)]">Message details</summary>
       <dl className="mt-2 grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-[var(--surface-container-low)] p-3 text-sm">
         {details.map((h,i)=><div key={`${h.label}/${i}`} className="contents">
           <dt className="text-[var(--text-secondary)]">{h.label}</dt><dd className="min-w-0 whitespace-pre-wrap break-words text-[var(--text-primary)] [overflow-wrap:anywhere]">{h.label==='Date'?<NativeEmailHeaderDate value={h.value}/>:h.value}{h.incomplete&&<p className="mt-1 text-xs text-[var(--text-secondary)]">This address header is incomplete. Download the original message for complete details.</p>}</dd>
         </div>)}
       </dl>
     </details>
   </div>
 </div>;
}

/** Mount exclusively in the native mailbox host, never alongside a legacy
 * Experience source controller. sessionScope is useAuth.sessionCacheScope. */
type ReaderProps={
  accountId:string;logicalMessageId:string;sessionScope:string;revision?:string;actions?:ReactNode;moreActions?:ReactNode;toolbar?:ReactNode;onCompose?:(selection:NativeReplyCompose)=>void;
};
export function NativeEmailReader(props:ReaderProps){
  const [retry,setRetry]=useState(0);
  return <NativeEmailReaderSurface key={JSON.stringify([props.accountId,props.logicalMessageId,props.sessionScope,props.revision,retry])}
    {...props} onRetry={()=>setRetry(n=>n+1)}/>;
}
function NativeEmailReaderSurface({accountId,logicalMessageId,sessionScope,revision,actions,moreActions,toolbar,onCompose,onRetry}:ReaderProps&{onRetry:()=>void}){
  const wrap=useRef<HTMLDivElement>(null),reader=useRef<ReturnType<typeof createNativeEmailReader>|null>(null);
  const [state,setState]=useState<NativeReaderState|null>(null);
  const [downloading,setDownloading]=useState<string|null>(null);
  const previewPanel=useRef<HTMLDivElement>(null),previewButtons=useRef(new Map<string,HTMLButtonElement>());
  useEffect(()=>{if(state?.preview)previewPanel.current?.focus();},[state?.preview?.fileRef]);
  const closePreview=()=>{const ref=state?.preview?.fileRef;reader.current?.closePreview();if(ref)previewButtons.current.get(ref)?.focus();};
  useEffect(()=>{const value=state?.value;if(!value||!onCompose)return;const handler=(event:KeyboardEvent)=>{
    if(sessionScope!==getActiveSessionCacheScope()||nativeEmailShortcut(event,{dialog:!!document.querySelector('[aria-modal="true"]'),menu:!!document.querySelector('[data-email-reader-menu][open]')})!=='reply')return;
    if(value.account_id!==accountId||value.logical_message_id!==logicalMessageId)return;
    try{const seed=createNativeReplyCompose(value,'reply');event.preventDefault();onCompose(seed);}catch{/* Unsupported recipient seeds stay unavailable just like the Reply button. */}
  };window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);},[state?.value,onCompose,sessionScope,accountId,logicalMessageId]);
  useLayoutEffect(()=>{
    const anchor=api.getAccessToken();if(!wrap.current||!anchor||sessionScope!==getActiveSessionCacheScope())return;
    const value=createNativeEmailReader({accountId,messageId:logicalMessageId,wrap:wrap.current,
      current:()=>sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken()),
      fetch:(path,options)=>api.fetch(path,options),change:setState});reader.current=value;
    void value.load();
    const checkSession=()=>{if(sessionScope!==getActiveSessionCacheScope()||!isSameWebSession(anchor,api.getAccessToken())){
      value.dispose();setState(null);}};
    addEventListener('storage',checkSession);
    return()=>{removeEventListener('storage',checkSession);value.dispose();if(reader.current===value)reader.current=null;};
  },[accountId,logicalMessageId,sessionScope,revision]);
  const download=async(ref:string)=>{if(downloading||state?.archive?.busy||!reader.current)return;const value=reader.current;setDownloading(ref);
    try{await value.downloadFile(ref);}finally{if(reader.current===value)setDownloading(null);}};
  const downloadOriginal=async()=>{if(downloading||state?.archive?.busy||!reader.current)return;const value=reader.current;setDownloading('@source');
    try{await value.downloadSource();}finally{if(reader.current===value)setDownloading(null);}};
  const title=state?.value?.presentation.headers.find(h=>h.label==='Subject')?.value||'Message';
  const zipUnavailable=(state?.value?.files.filter(file=>file.disposition==='attachment').reduce((total,file)=>total+file.size_bytes,0)??0)>nativeReceivedFileLimit;
  return <article aria-label="Email message" className="min-w-0 space-y-4 px-5 py-4">
    {state?.value&&<header className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3"><h2 className="min-w-0 break-words text-lg font-medium [overflow-wrap:anywhere]">{title}</h2>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">{actions}<details data-email-reader-menu className="relative" onKeyDown={event=>dismissNativeReaderMenu(event,!!document.querySelector('[aria-modal="true"]'))}><summary title="More reader options" aria-label="More reader options" className="cursor-pointer list-none rounded-full px-3 py-2 text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)]"><MoreHorizontal size={18} aria-hidden="true"/></summary><div className="absolute right-0 z-10 flex min-w-48 flex-col rounded-xl bg-[var(--surface-container-low)] p-2 shadow-lg">{moreActions}<button type="button" aria-label="Print message" onClick={()=>reader.current?.print()} className="rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)]">Print</button>
          <button type="button" aria-label="Download original message" disabled={!!downloading||state?.archive?.busy} onClick={()=>void downloadOriginal()} className="rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50">{downloading==='@source'?'Downloading…':'Download original'}</button><NativeEmailCalendarInvitationAction key={JSON.stringify([sessionScope,accountId,logicalMessageId,state.value.source_digest])} target={{account_id:accountId,logical_message_id:logicalMessageId}} sourceDigest={state.value.source_digest} sessionScope={sessionScope}/><NativeEmailContextTransferAction key={JSON.stringify([sessionScope,accountId,logicalMessageId])} target={{account_id:accountId,logical_message_id:logicalMessageId}} sessionScope={sessionScope} plainText={state.value.presentation.plain_text}/></div></details></div></div>
      <NativeEmailHeaderSummary headers={state.value.presentation.headers} metadata={state.value.presentation.metadata} replySeedUnavailable={state.value.reply_seed_unavailable}/>
      {toolbar}
    </header>}
    {(!state||state.loading)&&<p role="status" className="text-sm text-[var(--text-secondary)]">Loading message…</p>}
    {state?.notice&&<p role="status" className="text-sm text-[var(--text-secondary)]">{state.notice}</p>}
    {state&&!state.loading&&!state.value&&<button type="button" onClick={onRetry} className="rounded-lg px-3 py-2 text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)]">Load message again</button>}
    {state&&!state.loading&&!state.value&&state.sourceAvailable&&<button type="button" disabled={!!downloading||state?.archive?.busy} onClick={()=>void downloadOriginal()} className="rounded-full px-3 py-2 text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50">{downloading==='@source'?'Downloading…':'Download original'}</button>}
    {state&&!state.loading&&!state.value&&state.sourceAvailable&&<p className="text-xs text-[var(--text-secondary)]">Original-message downloads are available up to 35 MiB.</p>}
    {(state?.externalStatus||state?.embeddedStatus)&&<div role="group" aria-label="Message images" className="space-y-2 text-xs text-[var(--text-secondary)]">
      {state.externalStatus&&<p role="status" aria-live="polite">{state.externalStatus}</p>}
      {state.externalAvailable&&<button type="button" disabled={state.externalBusy} aria-busy={state.externalBusy}
        onClick={()=>void reader.current?.loadExternalImages()} className="rounded-lg px-3 py-2 text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50">{state.externalBusy?'Loading images…':state.externalStatus.startsWith('Some')?'Retry external images':'Load external images'}</button>}
      {state.embeddedStatus&&<p role="status" aria-live="polite">{state.embeddedStatus}</p>}
      {state.embeddedAvailable&&!state.embeddedBusy&&<button type="button" onClick={()=>void reader.current?.loadEmbeddedImages()}
        className="rounded-lg px-3 py-2 text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)]">Retry embedded images</button>}
      {state.imageLimit&&state.sourceAvailable&&<button type="button" disabled={!!downloading||state.archive?.busy} onClick={()=>void downloadOriginal()}
        className="rounded-full px-3 py-2 text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50">Download original</button>}
    </div>}
    <div ref={wrap} className="native-email-document min-w-0"/>
    {state?.value&&(state.value.files.some(f=>f.disposition==='attachment'||f.size_bytes>nativeReceivedFileLimit)||(state.value.omitted_file_count??0)>0)&&<section aria-label="Attachments" className="space-y-2">
      {(state.value.omitted_file_count??0)>0&&<div className="space-y-1"><p className="text-sm text-[var(--text-secondary)]">{state.value.omitted_file_count} additional {state.value.omitted_file_count===1?'file is':'files are'} not listed. Download the original to access every file.</p>
        <button type="button" disabled={!!downloading||state?.archive?.busy} onClick={()=>void downloadOriginal()} className="rounded-full px-3 py-1 text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50">{downloading==='@source'?'Downloading…':'Download original'}</button></div>}
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">Attachments</h3>
        {state.value.files.some(f=>f.disposition==='attachment')&&<button type="button" disabled={!!downloading||state.archive?.busy||zipUnavailable} onClick={()=>void reader.current?.downloadAttachments()}
          className="rounded-full px-3 py-1 text-xs hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50">{(state.value.omitted_file_count??0)>0?'Download listed attachments (.zip)':'Download all attachments (.zip)'}</button>}
      </div>
      {zipUnavailable&&<p className="text-xs text-[var(--text-secondary)]">These attachments exceed the 25 MiB ZIP limit. Download files individually, or download the original message.</p>}
      {state.archive&&<div className="flex flex-wrap items-center gap-2"><p role="status" className="text-xs text-[var(--text-secondary)]">{state.archive.notice}</p>
        {state.archive.busy&&<button type="button" onClick={()=>reader.current?.cancelArchive()} className="rounded-full px-3 py-1 text-xs hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)]">Cancel ZIP</button>}
      </div>}
      <div className="flex flex-wrap gap-2">
        {state.value.files.filter(f=>f.disposition==='attachment'||f.size_bytes>nativeReceivedFileLimit).map(f=><div key={f.file_ref} className="min-w-0 max-w-full rounded-xl bg-[var(--surface-container-low)] px-3 py-2 text-sm">
          <p className="break-words [overflow-wrap:anywhere]">{f.filename}</p><div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-[var(--text-secondary)]">{Math.ceil(f.size_bytes/1024)} KB</span>
            {nativeAttachmentPreviewKind(f)&&<button type="button" ref={node=>{if(node)previewButtons.current.set(f.file_ref,node);else previewButtons.current.delete(f.file_ref);}}
              disabled={state.archive?.busy} aria-label={`Preview ${f.filename}`} aria-expanded={state.preview?.fileRef===f.file_ref} onClick={()=>void reader.current?.previewFile(f.file_ref)}
              className="rounded-full px-2 py-1 hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50">Preview</button>}
            {f.size_bytes>nativeReceivedFileLimit?<><span className="text-[var(--text-secondary)]">Over the 25 MiB attachment limit; available in the original.</span><button type="button" disabled={!!downloading||state.archive?.busy} aria-label={`Download original message for ${f.filename}`} onClick={()=>void downloadOriginal()}
              className="rounded-full px-2 py-1 hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50">{downloading==='@source'?'Downloading…':'Download original'}</button></>:<button type="button" disabled={!!downloading||state.archive?.busy} aria-label={`Download ${f.filename}`} onClick={()=>void download(f.file_ref)}
              className="rounded-full px-2 py-1 hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50">{downloading===f.file_ref?'Downloading…':'Download'}</button>}
          </div>
        </div>)}
      </div>
      {state.preview&&<div ref={previewPanel} tabIndex={-1} role="region" aria-label={`Attachment preview: ${state.preview.filename}`} className="min-w-0 space-y-3 rounded-xl bg-[var(--surface-container-low)] p-3 focus-visible:ring-2 focus-visible:ring-[var(--primary)]">
        <div className="flex items-start justify-between gap-3"><h4 className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">{state.preview.filename}</h4>
          <button type="button" aria-label="Close attachment preview" onClick={closePreview} className="shrink-0 rounded-full px-3 py-1 text-xs hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)]">Close</button></div>
        {state.preview.loading?<p role="status" className="text-sm text-[var(--text-secondary)]">Loading attachment preview…</p>:state.preview.error?<>
          <p role="status" className="text-sm text-[var(--text-secondary)]">{state.preview.error}</p><button type="button" onClick={()=>void reader.current?.previewFile(state.preview!.fileRef)} className="rounded-full px-3 py-1 text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)]">Retry preview</button>
        </>:state.preview.kind==='text'?<>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{state.preview.text}</pre>
          {state.preview.clipped&&<p className="text-xs text-[var(--text-secondary)]">Only part of this attachment is shown. Download it for the complete text.</p>}
        </>:state.preview.kind==='image'?<img src={state.preview.url} alt={`Preview of ${state.preview.filename}`} className="max-h-[32rem] max-w-full rounded-lg object-contain"/>:<>
          <p className="text-sm text-[var(--text-secondary)]">The PDF is ready. Open it in your browser’s PDF viewer, or download it if the viewer is unavailable.</p>
          <a href={state.preview.url} target="_blank" rel="noopener noreferrer" className="inline-block rounded-full px-3 py-1 text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)]">Open PDF preview</a>
        </>}
        <button type="button" disabled={!!downloading||state?.archive?.busy} onClick={()=>void download(state.preview!.fileRef)} className="rounded-full px-3 py-1 text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50">{downloading===state.preview.fileRef?'Downloading…':'Download attachment'}</button>
      </div>}
    </section>}
    {state?.value&&<div className="flex flex-wrap items-start gap-x-3 gap-y-2 pt-3">
      {onCompose&&<NativeEmailReplyActions value={state.value} onCompose={onCompose}/>}
      <NativeEmailAskDefty key={JSON.stringify([sessionScope,accountId,logicalMessageId])} accountId={accountId} logicalMessageId={logicalMessageId} sessionScope={sessionScope}/>
    </div>}
    {state?.value&&<NativeEmailRelatedKnowledge key={JSON.stringify([sessionScope,accountId,logicalMessageId])} accountId={accountId} logicalMessageId={logicalMessageId} sessionScope={sessionScope}/>}
  </article>;
}
