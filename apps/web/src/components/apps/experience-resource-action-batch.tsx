 'use client';
import {useEffect,useRef,useState} from 'react';
import {AppDialog} from '@/components/overlay-primitives';
import {api} from '@/lib/api';
import type {AppResourceActionBatchDialog,AppResourceActionBatchReview} from '../../../../../packages/app-kit/src/app-resource-action-batch';
import {createExperienceResourceActionBatch,type ResourceBatchSubmission} from '@/lib/app-experience-resource-action-batch';
import {ExperienceResourceActionPreview} from './experience-resource-action';
export type ResourceActionBatchRequest={input:AppResourceActionBatchDialog;sessionId:string;targetKey:string;connectionSessionId:string;accountRef:string;
 signal:AbortSignal;current:()=>boolean;ensureAuthority:(signal?:AbortSignal)=>Promise<boolean>;finish:(value:(ResourceBatchSubmission&{prepared_refs:{snapshot_id:string;snapshot_digest:string}[]})|{cancelled:true}|{unknown:true}|undefined)=>void};
async function json(response:Response){
 if(!response.ok||response.headers.get('content-type')?.split(';')[0]!=='application/json'||!response.body){await response.body?.cancel();throw Error('Action unavailable');}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>524288)throw Error('Review limit');chunks.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
 }finally{for(const chunk of chunks)chunk.fill(0);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function ExperienceResourceActionBatchPreview({review}:{review:AppResourceActionBatchReview}){
 return <><p>{review.children.reduce((total,child)=>total+child.prepared.preview.count,0)} selected records in {review.children.length} groups</p>{review.children.map((child,ordinal)=><section key={child.prepared.snapshot_id} aria-label={`Selected group ${ordinal+1}`}><h3 className="font-medium">Group {ordinal+1}: {child.prepared.preview.title}</h3><ExperienceResourceActionPreview review={child}/></section>)}</>;
}
export function ExperienceResourceActionBatch({request}:{request:ResourceActionBatchRequest}){
 const [review,setReview]=useState<AppResourceActionBatchReview|null>(null),[notice,setNotice]=useState('Preparing selected records…'),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false);
 const active=useRef(false),model=useRef<ReturnType<typeof createExperienceResourceActionBatch>|null>(null),pending=useRef(false);
 useEffect(()=>{const abort=new AbortController();active.current=true;
  const signal=AbortSignal.any([abort.signal,request.signal]),current=()=>active.current&&request.current()&&!signal.aborted&&!document.hidden;
  model.current=createExperienceResourceActionBatch({...request,request:request.input,current,call:async(path,body)=>{
   if(!current()||!await request.ensureAuthority(signal)||!current())throw Error('Action access changed');
   const result=await json(await api.fetch(path,{signal,...(body===undefined?{cache:'no-store'}:{method:'POST',body:JSON.stringify(body)})}));
   if(!current()||!await request.ensureAuthority(signal)||!current())throw Error('Action access changed');return result;
  }});
  void model.current.load().then(value=>{if(current()){setReview(value);setNotice('');}}).catch(()=>{if(current())setNotice('This selection cannot be reviewed. Close the review and check your access.');});
  const hidden=()=>{if(document.hidden){abort.abort();request.finish(model.current?.dispatched?{unknown:true}:{cancelled:true});}};
  document.addEventListener('visibilitychange',hidden);return()=>{active.current=false;abort.abort();document.removeEventListener('visibilitychange',hidden);};
 },[request]);
 async function submit(status=false){if(pending.current||!model.current||!review)return;pending.current=true;setBusy(true);
  try{const result=await(status?model.current.status():model.current.confirm());if(active.current&&request.current()&&!request.signal.aborted)request.finish({...result,prepared_refs:review.children.map(child=>({snapshot_id:child.prepared.snapshot_id,snapshot_digest:child.prepared.snapshot_digest}))});}
  catch{if(active.current){setUnknown(model.current.dispatched);setNotice(model.current.dispatched?'Action outcome is not confirmed. Check this original submission before making another change.':'This review expired or access changed. Close it and review the selection again.');}}
  finally{pending.current=false;if(active.current)setBusy(false);}
 }
 return <AppDialog open title="Review selected records" description="Confirm this exact selection once. Groups run in order; an unknown outcome stops later groups." onClose={()=>{if(!busy)request.finish(unknown?{unknown:true}:{cancelled:true});}}>
  <div className="space-y-4 text-sm">{notice&&<p role="status">{notice}</p>}{review&&<ExperienceResourceActionBatchPreview review={review}/>}
   <div className="flex flex-wrap gap-2">{unknown?<button type="button" className="deft-pill min-h-11" disabled={busy} onClick={()=>void submit(true)}>Check status</button>
    :<button type="button" className="deft-pill min-h-11" disabled={!review||busy||!request.current()||!!review&&Date.parse(review.expires_at)<=Date.now()} onClick={()=>void submit()}>{busy?'Confirming…':'Confirm selected records'}</button>}
    <button type="button" className="deft-pill min-h-11 !bg-transparent" disabled={busy} onClick={()=>request.finish(unknown?{unknown:true}:{cancelled:true})}>Close</button>
   </div></div></AppDialog>;
}
