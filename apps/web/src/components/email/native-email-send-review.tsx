'use client';
import {useEffect,useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {parseEmailSendReview,type EmailSendReview,type EmailSendReviewTarget} from '@/lib/email-native-send-review';
import {parseNativeSafeComposeHtml as parseSafeComposeHtml} from '../../../../../packages/app-kit/src/safe-compose-html';

export type EmailSendReviewIdentity=EmailSendReviewTarget&{scope:string;expiresAt:number};
export function NativeEmailSendReview({target,scope,busy,onReviewed}:{target:EmailSendReviewTarget;scope:string|null;busy:boolean;onReviewed:(value:EmailSendReviewIdentity|null)=>void}) {
  const [captured,setCaptured]=useState<{value:EmailSendReview;identity:EmailSendReviewIdentity}|null>(null),[loading,setLoading]=useState(false),[notice,setNotice]=useState('');
  const owner=useRef<AbortController|null>(null),identity=JSON.stringify(target),epoch=useRef(0),validUntil=useRef(0);
  useEffect(()=>{
    const clear=()=>{epoch.current++;owner.current?.abort();validUntil.current=0;setCaptured(null);setLoading(false);setNotice('');onReviewed(null);};
    clear();
    const hidden=()=>{if(document.visibilityState!=='visible')clear();};
    const timer=setInterval(()=>{if(validUntil.current&&Date.now()>=validUntil.current)clear();},500);
    addEventListener('pagehide',clear);addEventListener('storage',clear);document.addEventListener('visibilitychange',hidden);
    return()=>{epoch.current++;owner.current?.abort();onReviewed(null);clearInterval(timer);removeEventListener('pagehide',clear);removeEventListener('storage',clear);document.removeEventListener('visibilitychange',hidden);};
  },[identity,scope,onReviewed]);
  const load=async()=>{
    if(!scope||busy||loading||scope!==getActiveSessionCacheScope()||document.visibilityState!=='visible')return;
    const ticket=++epoch.current,controller=new AbortController(),anchor=api.getAccessToken();owner.current?.abort();owner.current=controller;
    const current=()=>ticket===epoch.current&&!controller.signal.aborted&&scope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken())&&document.visibilityState==='visible';
    setCaptured(null);onReviewed(null);setLoading(true);setNotice('');
    try {
      const response=await api.fetch('/api/email/send-reviews/'+encodeURIComponent(target.actionId),{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])});
      if(!response.ok)throw Error(response.status===409?'This email draft changed. Request a new send review.':'Email review is unavailable or account access changed.');
      const text=await response.text();if(new TextEncoder().encode(text).length>512*1024)throw Error('Email review is unavailable.');
      const value=parseEmailSendReview(JSON.parse(text),target);
      if(current()){const reviewed={...target,scope,expiresAt:Date.now()+60000};validUntil.current=reviewed.expiresAt;setCaptured({value,identity:reviewed});onReviewed(reviewed);}
    } catch(error){if(current())setNotice(error instanceof Error?error.message:'Email review is unavailable.');}
    finally {if(current())setLoading(false);}
  };
  const review=captured?.identity.scope===scope&&scope===getActiveSessionCacheScope()&&JSON.stringify({...captured.value,content:undefined})===JSON.stringify({...target,content:undefined})&&Date.now()<captured.identity.expiresAt?captured.value:null;
  return <NativeEmailSendReviewView review={review} busy={busy||loading} available={!!scope} notice={notice} onLoad={()=>void load()}/>;
}
export function NativeEmailSendReviewView({review,busy,available,notice,onLoad}:{review:EmailSendReview|null;busy:boolean;available:boolean;notice:string;onLoad:()=>void}) {
  const content=review?.content;
  const html=content?.body_html?parseSafeComposeHtml(content.body_html):null;
  if(html&&html.plainText!==content?.body)throw Error('Formatting and plain text must match.');
  return <section aria-label="Exact email send review" className="mt-3 space-y-3 rounded-xl bg-[var(--surface-container-low)] p-3 text-sm">
    <p className="font-medium">Review email before sending</p>
    {content?<><dl className="space-y-2 break-words [overflow-wrap:anywhere]">{([['From',content.from_identity?.address],['To',content.to],['Cc',content.cc],['Bcc',content.bcc],['Subject',content.subject]] as const).map(([label,value])=><div key={label}><dt className="text-xs text-[var(--text-secondary)]">{label}</dt><dd className="whitespace-pre-wrap">{value||'None'}</dd></div>)}</dl><div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]" aria-label="Email body">{html?<div dangerouslySetInnerHTML={{__html:html.html}}/>:content.body}</div><div className="text-xs"><p className="text-[var(--text-secondary)]">Attachments</p>{content.attachments.length?content.attachments.map(file=><p key={file.file_id}>{file.filename} · {Math.ceil(file.size_bytes/1024)} KB</p>):<p>None</p>}</div><a className="inline-block rounded-full px-3 py-2 text-xs text-[var(--primary)] hover:bg-[var(--hover-tint)]" href={'/email?account='+encodeURIComponent(review!.accountId)+'&draft='+encodeURIComponent(review!.draftId)}>Open saved draft</a></>:<p className="text-xs text-[var(--text-secondary)]">Open the exact sender, recipients, body and attachments before approving.</p>}
    <button type="button" disabled={busy||!available} onClick={onLoad} className="rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50">{busy?'Loading review…':review?'Refresh email review':'Review exact email'}</button>
    {notice&&<p role="alert" className="text-xs text-[var(--text-secondary)]">{notice}</p>}
  </section>;
}
