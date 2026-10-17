'use client';
import {useEffect,useRef,useState} from 'react';
import {AppDialog} from '@/components/overlay-primitives';
import {api} from '@/lib/api';
import type {AppResourceActionDialogInput,AppResourceActionReview} from '../../../../../packages/app-kit/src/app-resource-action';
import {createExperienceResourceAction} from '@/lib/app-experience-resource-action';

export type ResourceActionRequest={input:AppResourceActionDialogInput;sessionId:string;targetKey:string;connectionSessionId:string;accountRef:string;
 signal:AbortSignal;current:()=>boolean;ensureAuthority:(signal?:AbortSignal)=>Promise<boolean>;finish:(value:{run:{id:string;state:string};prepared_ref?:{snapshot_id:string;snapshot_digest:string}}|{cancelled:true}|{unknown:true}|undefined)=>void};
async function json(response:Response){
 if(!response.ok||response.headers.get('content-type')?.split(';')[0]!=='application/json'||!response.body){await response.body?.cancel();throw Error('Action unavailable');}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>262144)throw Error('Review limit');chunks.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
 }finally{for(const chunk of chunks)chunk.fill(0);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function ExperienceResourceActionPreview({review}:{review:AppResourceActionReview}){
 return <div className="space-y-4"><p>{review.prepared.preview.count} selected {review.prepared.preview.count===1?'record':'records'}</p>
  <ul className="max-h-80 space-y-3 overflow-y-auto">{review.prepared.preview.items.map(item=><li key={item.record_id} className="rounded-xl bg-[var(--surface-container-low)] p-3">
   <p className="break-words font-medium">{item.label}</p><dl className="mt-2 grid grid-cols-2 gap-3"><div><dt className="text-xs text-[var(--on-surface-variant)]">Before</dt><dd className="break-words">{item.before}</dd></div><div><dt className="text-xs text-[var(--on-surface-variant)]">After</dt><dd className="break-words">{item.after}</dd></div></dl>
  </li>)}</ul></div>;
}
export function ExperienceResourceAction({request,onRun}:{request:ResourceActionRequest;onRun:(run:{id:string;state:string})=>void}){
 const [review,setReview]=useState<AppResourceActionReview|null>(null),[notice,setNotice]=useState('Preparing selected records…'),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false);
 const active=useRef(false),model=useRef<ReturnType<typeof createExperienceResourceAction>|null>(null),controller=useRef<AbortController|null>(null),pending=useRef(false);
 useEffect(()=>{const abort=new AbortController();controller.current=abort;active.current=true;
  const signal=AbortSignal.any([abort.signal,request.signal]),current=()=>active.current&&request.current()&&!signal.aborted&&!document.hidden;
  model.current=createExperienceResourceAction({...request,request:request.input,current,call:async(path,body)=>{
   const callSignal=path.endsWith('/prepare')?AbortSignal.any([signal,AbortSignal.timeout(30000)]):signal;
   if(!current()||!await request.ensureAuthority(callSignal)||!current())throw Error('Action access changed');
   const result=await json(await api.fetch(path,{signal:callSignal,...(body===undefined?{cache:'no-store'}:{method:'POST',body:JSON.stringify(body)})}));
   if(!current()||!await request.ensureAuthority(callSignal)||!current())throw Error('Action access changed');return result;
  }});
  void model.current.load().then(value=>{if(current()){setReview(value);setNotice('');}}).catch(()=>{if(active.current&&!signal.aborted&&!document.hidden)setNotice('This selection cannot be reviewed. Close the review and check your access.');});
  const hidden=()=>{if(document.hidden){abort.abort();request.finish(model.current?.dispatched?{unknown:true}:{cancelled:true});}};
  document.addEventListener('visibilitychange',hidden);return()=>{active.current=false;abort.abort();document.removeEventListener('visibilitychange',hidden);};
 },[request]);
 async function submit(status=false){if(pending.current||!model.current)return;pending.current=true;setBusy(true);
  try{const run=await (status?model.current.status():model.current.confirm());if(active.current&&request.current()&&!request.signal.aborted){onRun(run);request.finish({run,...(review?{prepared_ref:{snapshot_id:review.prepared.snapshot_id,snapshot_digest:review.prepared.snapshot_digest}}:{})});}}
  catch{if(active.current){setUnknown(model.current.dispatched);setNotice(model.current.dispatched?'Action outcome is not confirmed. Check this submission before making another change.':'This review expired or access changed. Close it and review the selection again.');}}
  finally{pending.current=false;if(active.current)setBusy(false);}
 }
 return <AppDialog open title={review?.prepared.preview.title??'Review action'} description="Confirm this exact change to the selected records." onClose={()=>{if(!busy)request.finish(unknown?{unknown:true}:{cancelled:true});}}>
  <div className="space-y-4 text-sm">{notice&&<p role="status">{notice}</p>}{review&&<ExperienceResourceActionPreview review={review}/>}
   <div className="flex flex-wrap gap-2">{unknown?<button type="button" className="deft-pill min-h-11" disabled={busy} onClick={()=>void submit(true)}>Check status</button>
    :<button type="button" className="deft-pill min-h-11" disabled={!review||busy||!request.current()||!!review&&Date.parse(review.expires_at)<=Date.now()} onClick={()=>void submit()}>{busy?'Confirming…':'Confirm action'}</button>}
    <button type="button" className="deft-pill min-h-11 !bg-transparent" disabled={busy} onClick={()=>request.finish(unknown?{unknown:true}:{cancelled:true})}>Close</button>
   </div></div></AppDialog>;
}
