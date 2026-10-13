'use client';
import {useEffect,useRef,useState} from 'react';
import {createRecordChanges,type RecordChangeState,type RecordChangePorts} from '@/lib/app-experience-record-changes';
import type {createExperienceRecordWriter} from '@/lib/app-experience-record-writer';
import {ExperienceRecordPreview,type ExperienceRecordFormNode,type ExperienceRecordFormPorts} from './experience-record-form';
export function ExperienceRecordChanges(props:{node:ExperienceRecordFormNode;writer:()=>ReturnType<typeof createExperienceRecordWriter>|null;ports:ExperienceRecordFormPorts&RecordChangePorts;
 signal:AbortSignal;current:()=>boolean;disabled:boolean;onBusy:(busy:boolean)=>void}){
 const [state,setState]=useState<RecordChangeState>({phase:'idle',choices:[],prepared:null,notice:''}),ref=useRef<ReturnType<typeof createRecordChanges>|null>(null),latest=useRef(props);latest.current=props;
 useEffect(()=>{let active=true;const abort=new AbortController(),signal=AbortSignal.any([abort.signal,props.signal]);
  const control=createRecordChanges({node:props.node,writer:()=>latest.current.writer(),ports:props.ports,current:()=>active&&latest.current.current(),locked:()=>latest.current.disabled,signal,
   change:next=>{if(active&&!signal.aborted){setState(next);latest.current.onBusy(next.phase!=='idle');}}});ref.current=control;
  return()=>{active=false;abort.abort();control.dispose();if(ref.current===control)ref.current=null;};
 },[props.node.record_id,props.node.store_key,props.ports,props.signal]);
 const preparing=['loading','preparing','applying'].includes(state.phase),snapshot=props.writer()?.snapshot;
 return <section aria-label="Saved content" className="space-y-3">
  <div className="flex flex-wrap gap-2">{props.node.record_changes?.map(control=><button key={control.operation_key} type="button" className="min-h-10 rounded-full px-3 text-xs" disabled={props.disabled||state.phase!=='idle'} onClick={()=>void ref.current?.choose(control)}>{control.label}</button>)}</div>
  {state.phase==='choosing'&&<div className="space-y-2 rounded-xl bg-[var(--surface-container-low)] p-3"><h3 className="text-sm">Choose saved content</h3>
   {state.choices.map(choice=><button key={choice.record_id} type="button" className="block min-h-10 w-full rounded-lg px-3 text-left text-sm hover:bg-[var(--surface-container-high)]" onClick={()=>void ref.current?.prepare(choice)}>{choice.label}</button>)}
   {state.next_cursor&&<button type="button" className="min-h-10 rounded-full px-3 text-xs" onClick={()=>void ref.current?.nextPage()}>More saved content</button>}<button type="button" className="min-h-10 rounded-full px-3 text-xs" onClick={()=>ref.current?.close()}>Close</button></div>}
  {!!state.parameterFields?.length&&<section aria-label="Template parameters" className="space-y-3 rounded-xl bg-[var(--surface-container-low)] p-4">
   <h3 className="text-sm font-medium">Template values</h3><p className="text-xs text-[var(--muted)]">Enter values, then update the preview. Unentered values remain visible placeholders.</p>
   {state.parameterFields.map(field=><label key={field.key} className="block space-y-1 text-xs">{field.label}<textarea aria-label={field.label} maxLength={field.max_characters} rows={2}
    value={state.parameters?.[field.key]??''} disabled={!props.current()||preparing||state.phase==='unconfirmed'}
    className="block w-full rounded-lg bg-[var(--surface)] px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
    onChange={event=>ref.current?.editParameter(field.key,event.target.value)}/></label>)}
   {state.phase==='parameters'&&<div className="flex flex-wrap gap-2"><button type="button" className="min-h-10 rounded-full px-3 text-xs" onClick={()=>ref.current?.close()}>Cancel</button>
    <button type="button" className="min-h-10 rounded-full px-4 text-xs" disabled={!props.current()} onClick={()=>void ref.current?.updatePreview()}>Update preview</button></div>}
  </section>}
  {state.prepared&&snapshot&&['review','applying','unconfirmed'].includes(state.phase)&&<section role="dialog" aria-modal="false" aria-label={state.prepared.preview.title} className="space-y-3 rounded-xl bg-[var(--surface-container-low)] p-4">
   <h3 className="text-sm font-medium">{state.prepared.preview.title}</h3>{state.prepared.preview.description&&<p className="text-xs text-[var(--muted)]">{state.prepared.preview.description}</p>}
   {state.prepared.preview.warnings.map((warning,index)=><p key={index} className="text-xs">{warning}</p>)}
   <ExperienceRecordPreview value={state.prepared.value} node={props.node} row={snapshot.row} ports={props.ports} signal={props.signal} current={props.current}/>
   <div className="flex gap-2"><button type="button" className="min-h-10 rounded-full px-3 text-xs" disabled={preparing||state.phase==='unconfirmed'} onClick={()=>ref.current?.close()}>Cancel</button>
    {state.phase==='review'&&<button type="button" className="min-h-10 rounded-full px-4 text-xs" disabled={!props.current()||Date.parse(state.prepared.expires_at)<=Date.now()} onClick={()=>void ref.current?.apply()}>Apply to saved draft</button>}
    {state.phase==='unconfirmed'&&<button type="button" className="min-h-10 rounded-full px-4 text-xs" disabled={!props.current()} onClick={()=>void ref.current?.check()}>Check status</button>}</div>
  </section>}{state.notice&&<p role="status" className="text-xs text-[var(--muted)]">{state.notice}</p>}
 </section>;
}
