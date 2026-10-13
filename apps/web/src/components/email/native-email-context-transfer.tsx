'use client';
import {useEffect,useRef,useState} from 'react';
import {AppDialog} from '@/components/overlay-primitives';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import type {NativeMessageTarget} from '@/lib/email-native-message-links';
import {createNativeEmailContextTransfer,emailKnowledgeTypes,parseEmailTransferSpaces,type EmailTransferInput,type EmailTransferReview,type EmailTransferResult} from '@/lib/email-native-context-transfer';

const control='w-full rounded-xl bg-[var(--surface-container-low)] px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-[var(--primary)]';
const button='rounded-full px-4 py-2 text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50';
export function NativeEmailContextTransferAction(props:{target:NativeMessageTarget;sessionScope:string;plainText:string}){
 const [open,setOpen]=useState(false);
 return <><button type="button" aria-label="Save email to Notes, Knowledge or Chat" onClick={()=>setOpen(true)} className="rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)]">Save to Notes, Knowledge or Chat</button>{open&&<NativeEmailContextTransferDialog {...props} onClose={()=>setOpen(false)}/>}</>;
}
export function NativeEmailContextTransferDialog({target,sessionScope,plainText,onClose}:{target:NativeMessageTarget;sessionScope:string;plainText:string;onClose:()=>void}){
 const {account_id:accountId,logical_message_id:logicalId}=target;
 const [kind,setKind]=useState<'note'|'knowledge'|'chat'>('note'),[visibility,setVisibility]=useState<'private'|'org'|'space'>('private'),[space,setSpace]=useState(''),[type,setType]=useState<typeof emailKnowledgeTypes[number]>('fact');
 const [title,setTitle]=useState('Email reference'),[copy,setCopy]=useState(false),[excerpt,setExcerpt]=useState('');
 const [spaces,setSpaces]=useState<{id:string;name:string}[]>([]),[spaceNotice,setSpaceNotice]=useState(''),[spaceAttempt,setSpaceAttempt]=useState(0);
 const [review,setReview]=useState<EmailTransferReview|null>(null),[result,setResult]=useState<EmailTransferResult|null>(null),[uncertain,setUncertain]=useState(false),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState('');
 const source=useRef<HTMLTextAreaElement>(null),controller=useRef<ReturnType<typeof createNativeEmailContextTransfer>|null>(null),live=useRef(false);
 useEffect(()=>{
  live.current=true;const anchor=api.getAccessToken(),current=()=>live.current&&getActiveSessionCacheScope()===sessionScope&&!!anchor&&isSameWebSession(anchor,api.getAccessToken());
  const value=createNativeEmailContextTransfer({target:{account_id:accountId,logical_message_id:logicalId},sessionScope,plainText,current,fetch:(path,init)=>api.fetch(path,init)});controller.current=value;
  const retained=value.retained();if(retained){const input=retained.input;setKind(input.destination.kind);if(input.destination.kind==='note')setVisibility(input.destination.visibility);else if(input.destination.kind==='knowledge')setType(input.destination.type);setSpace(input.destination.space_id??'');setTitle(input.title);setCopy(input.mode==='excerpt');setExcerpt(input.excerpt??'');setReview(retained.review);setResult(retained.result??null);setUncertain(!retained.result);}setReady(true);
  return()=>{live.current=false;value.dispose();if(controller.current===value)controller.current=null;};
 },[accountId,logicalId,sessionScope,plainText]);
 useEffect(()=>{let active=true;const abort=new AbortController(),anchor=api.getAccessToken();
  void api.fetch('/api/spaces',{cache:'no-store',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(8000)])}).then(async response=>{if(!response.ok)throw Error('Spaces could not be loaded.');const rows=parseEmailTransferSpaces(await response.json());if(active&&getActiveSessionCacheScope()===sessionScope&&isSameWebSession(anchor,api.getAccessToken())){setSpaces(rows);setSpaceNotice('');}}).catch(()=>{if(active&&!abort.signal.aborted)setSpaceNotice('Spaces could not be loaded. Private Notes are still available.');});
  return()=>{active=false;abort.abort();};
 },[sessionScope,spaceAttempt]);
 const locked=busy||uncertain||!!result;
 const edit=()=>{controller.current?.invalidate();setReview(null);setError('');};
 const input=():EmailTransferInput=>({title,mode:copy?'excerpt':'source_link',...(copy?{excerpt}:{}),destination:kind==='chat'?{kind,space_id:space}:kind==='knowledge'?{kind,space_id:space,type}:visibility==='space'?{kind,visibility,space_id:space}:{kind,visibility}});
 const makeReview=async()=>{const owned=controller.current;if(busy||!owned)return;const current=()=>live.current&&controller.current===owned&&getActiveSessionCacheScope()===sessionScope;setBusy(true);setError('');try{const value=await owned.review(input());if(current())setReview(value.review);}catch(reason){if(current())setError(reason instanceof Error?reason.message:'The destination could not be reviewed.');}finally{if(current())setBusy(false);}};
 const create=async()=>{const owned=controller.current;if(busy||!owned)return;const current=()=>live.current&&controller.current===owned&&getActiveSessionCacheScope()===sessionScope;setBusy(true);setError('');try{const value=await owned.commit();if(current()){setResult(value);setUncertain(false);}}catch(reason){if(current()){const intent=owned.retained();setUncertain(!!intent&&!intent.result);if(!intent)setReview(null);setError(reason instanceof Error?reason.message:'Creation could not be confirmed.');}}finally{if(current())setBusy(false);}};
 const selectExcerpt=()=>{const value=source.current;if(!value)return;const selected=plainText.slice(value.selectionStart,value.selectionEnd);if(!selected||selected.length>20000){setError('Select up to 20,000 characters from the email.');return;}edit();setExcerpt(selected);};
 const needsSpace=kind!=='note'||visibility==='space';
 const destinationLabel=result?.destination_kind==='chat'?'Chat message':result?.destination_kind==='note'?'Note':'Knowledge entry';
 if(getActiveSessionCacheScope()!==sessionScope)return null;
 return <AppDialog open title="Save email reference" description="Keep a link in Notes, Knowledge or Chat." width={540} onClose={()=>{if(!busy)onClose();}} footer={<div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className={button}>{result?'Done':'Close'}</button>{!result&&(uncertain?<button type="button" disabled={busy||!ready} onClick={()=>void create()} className={button}>{busy?'Checking…':'Check creation'}</button>:review?<button type="button" disabled={busy||!ready} onClick={()=>void create()} className={button+' bg-[var(--accent-light)] text-[var(--primary)]'}>{busy?'Creating…':kind==='chat'?'Share to Chat':kind==='note'?'Create note':'Create knowledge'}</button>:<button type="button" disabled={busy||!ready||!title.trim()||needsSpace&&!space||copy&&!excerpt} onClick={()=>void makeReview()} className={button+' bg-[var(--accent-light)] text-[var(--primary)]'}>{busy?'Reviewing…':'Review destination'}</button>)}</div>}>
  <div className="space-y-4 text-sm">
   {result?<div className="space-y-3"><p role="status">{destinationLabel} created. <a href={result.destination_url} className="text-[var(--primary)] underline">Open {result.destination_kind==='chat'?'Chat':result.destination_kind==='note'?'note':'knowledge'}</a></p><button type="button" onClick={()=>{controller.current?.reset();setResult(null);setReview(null);setUncertain(false);setError('');}} className={button}>Save another reference</button></div>:<>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Save destination">{(['note','knowledge','chat'] as const).map(value=><button key={value} type="button" disabled={locked} aria-pressed={kind===value} onClick={()=>{edit();setKind(value);}} className={button+(kind===value?' bg-[var(--accent-light)] text-[var(--primary)]':'')}>{value==='chat'?'Chat':value==='note'?'Notes':'Knowledge'}</button>)}</div>
    <label className="block space-y-1"><span>Title</span><input value={title} maxLength={512} disabled={locked} onChange={event=>{edit();setTitle(event.target.value);}} className={control}/></label>
    {kind==='note'&&<label className="block space-y-1"><span>Who can see it</span><select value={visibility} disabled={locked} onChange={event=>{edit();setVisibility(event.target.value as typeof visibility);}} className={control}><option value="private">Only me</option><option value="org">Organization members</option><option value="space">A space</option></select></label>}
    {needsSpace&&<label className="block space-y-1"><span>{kind==='chat'?'Chat destination':'Space'}</span><select value={space} disabled={locked} onChange={event=>{edit();setSpace(event.target.value);}} className={control}><option value="">Choose a space</option>{spaces.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
    {kind==='knowledge'&&<label className="block space-y-1"><span>Type</span><select value={type} disabled={locked} onChange={event=>{edit();setType(event.target.value as typeof type);}} className={control}>{emailKnowledgeTypes.map(value=><option key={value} value={value}>{value[0].toUpperCase()+value.slice(1)}</option>)}</select></label>}
    {spaceNotice&&needsSpace&&<p role="status" className="text-xs text-[var(--text-secondary)]">{spaceNotice} <button type="button" disabled={locked} onClick={()=>setSpaceAttempt(value=>value+1)} className="underline">Reload spaces</button></p>}
    <p className="text-xs text-[var(--text-secondary)]">The link opens this email only for people who have email access.</p>
    <label className="flex items-start gap-2"><input type="checkbox" checked={copy} disabled={locked} onChange={event=>{edit();setCopy(event.target.checked);}}/><span>Also copy a selected excerpt</span></label>
    {copy&&<div className="space-y-2"><label className="block space-y-1"><span>Select text from this email</span><textarea ref={source} readOnly disabled={locked} value={plainText} rows={5} className={control}/></label><button type="button" disabled={locked} onClick={selectExcerpt} className={button}>Use selected text</button>{excerpt&&<blockquote className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-[var(--surface-container-low)] p-3">{excerpt}</blockquote>}<p className="text-xs text-[var(--text-secondary)]">Copied text follows the destination’s sharing, search and retention. It may remain after email access ends.</p></div>}
    {review&&<div role="status" className="rounded-xl bg-[var(--surface-container-low)] p-3"><p>{review.audience.label} · {review.audience.member_count} {review.audience.member_count===1?'person':'people'}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{copy?'Source link and selected excerpt':'Source link only'}</p></div>}
    {uncertain&&<p role="status" className="text-xs text-[var(--text-secondary)]">Creation wasn’t confirmed. Keep this tab open and check this request before creating another.</p>}
   </>}
   {error&&<p role="alert" className="text-sm">{error}</p>}
  </div>
 </AppDialog>;
}
