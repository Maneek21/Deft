'use client';
import {useEffect,useRef,useState} from 'react';
import {parseExperienceMailtoFragment,type ExperienceMailtoSuggestion} from '../../lib/app-experience-mailto';
import type {createRecordIntake} from '../../lib/app-experience-record-intake';
type Intake=ReturnType<typeof createRecordIntake>;
type Preview={account:string;intake:Intake};
export function ExperienceRecordIntake({prepare}:{prepare:(suggestion:ExperienceMailtoSuggestion)=>Promise<Preview>}){
 const [suggestion,setSuggestion]=useState<ExperienceMailtoSuggestion|null>(null),[preview,setPreview]=useState<Preview|null>(null),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[attempted,setAttempted]=useState(false),[created,setCreated]=useState(false),[retry,setRetry]=useState(0);
 const mounted=useRef(false),generation=useRef(0),busyRef=useRef(false),attemptedRef=useRef(false);
 useEffect(()=>{mounted.current=true;const consume=()=>{const hash=location.hash;if(!hash.startsWith('#compose='))return;
  // Remove untrusted link bytes before parsing, account reads or any asynchronous work.
  history.replaceState(history.state,'',location.pathname+location.search);
  if(attemptedRef.current){setStatus('Your previous draft creation is kept. Finish checking it before opening another email link.');return;}
  generation.current++;setPreview(null);setSuggestion(null);setCreated(false);setStatus('');
  try{const next=parseExperienceMailtoFragment(hash);if(next)setSuggestion(next);}catch{setStatus('This email link could not be opened.');}
 };consume();window.addEventListener('hashchange',consume);return()=>{mounted.current=false;generation.current++;window.removeEventListener('hashchange',consume);};},[]);
 useEffect(()=>{if(!suggestion||attemptedRef.current)return;let cancelled=false;const scope=++generation.current,current=()=>mounted.current&&!cancelled&&generation.current===scope;
  setPreview(null);setBusy(true);busyRef.current=true;setStatus('Loading your current account…');
  void prepare(suggestion).then(value=>{if(!current())return;setPreview(value);setStatus('Review the email link, then create a draft.');}).catch(()=>{if(current())setStatus('Account preview is unavailable. Check your current account access.');}).finally(()=>{if(current()){busyRef.current=false;setBusy(false);}});
  return()=>{cancelled=true;};
 },[prepare,suggestion,retry]);
 const act=async(action:(current:()=>boolean)=>Promise<void>)=>{if(busyRef.current)return;const scope=generation.current,current=()=>mounted.current&&generation.current===scope;busyRef.current=true;setBusy(true);
  try{await action(current);}catch{if(current())setStatus('Creation is not confirmed. Check its original status before continuing.');}finally{if(current()){busyRef.current=false;setBusy(false);}}
 };
 const close=()=>{generation.current++;attemptedRef.current=false;setAttempted(false);setSuggestion(null);setPreview(null);setStatus('');};
 return <>{!suggestion&&status&&<p role="status" className="px-5 py-2 text-sm">{status}</p>}{suggestion&&<section aria-label="Email link preview" className="mx-5 my-3 rounded-xl px-4 py-3" style={{background:'var(--surface-container-low)',color:'var(--on-surface)'}}>
 <h2 className="text-sm font-semibold">Email link preview</h2><p className="mt-1 text-sm">Account: {preview?.account??'Loading current account…'}</p>
 <dl className="mt-3 space-y-2 text-sm">{(['to','cc','bcc','subject','plain'] as const).map(field=><div key={field} className="grid grid-cols-[4.5rem_1fr] gap-3"><dt style={{color:'var(--on-surface-variant)'}}>{field==='plain'?'Message':field==='subject'?'Subject':field==='to'?'To':field==='cc'?'Cc':'Bcc'}</dt><dd className="whitespace-pre-wrap break-words">{suggestion[field]||'Empty'}</dd></div>)}</dl>
 {suggestion.ignored_fields.length>0&&<p className="mt-2 text-xs" style={{color:'var(--on-surface-variant)'}}>Ignored fields: {suggestion.ignored_fields.join(', ')}</p>}
 {status&&<p role="status" className="mt-3 text-sm">{status}</p>}<div className="mt-3 flex flex-wrap gap-2">
 {!preview&&!busy&&<button className="deft-pill" onClick={()=>setRetry(value=>value+1)}>Retry account preview</button>}
 {preview&&!attempted&&<button className="deft-pill" disabled={busy} onClick={()=>void act(async current=>{attemptedRef.current=true;setAttempted(true);await preview.intake.create();if(!current())return;setCreated(true);setStatus('Draft created in Drafts.');const opened=await preview.intake.open();if(!current())return;if(!opened)setStatus('Draft created in Drafts. Open Drafts to continue.');})}>Create draft</button>}
 {preview&&attempted&&!created&&<button className="deft-pill" disabled={busy} onClick={()=>void act(async current=>{const receipt=await preview.intake.check();if(!current())return;if(!receipt){setStatus('Original creation remains unconfirmed. No additional draft was created.');return;}setCreated(true);setStatus('Draft created in Drafts.');const opened=await preview.intake.open();if(!current())return;if(!opened)setStatus('Draft created in Drafts. Open Drafts to continue.');})}>Check original creation status</button>}
 <button className="deft-pill" disabled={busy} onClick={close}>Close preview</button></div></section>}</>;
}
export function ExperienceMailtoRegistration(){const [status,setStatus]=useState('');return <div className="p-3 text-sm"><button className="deft-pill" onClick={()=>{try{if(!navigator.registerProtocolHandler)throw Error();navigator.registerProtocolHandler('mailto',location.origin+location.pathname+'#compose=%s');setStatus('Browser registration requested. Confirm in your browser settings.');}catch{setStatus('This browser cannot register email links here.');}}}>Use this app for email links</button>{status&&<p role="status">{status}</p>}</div>;}
