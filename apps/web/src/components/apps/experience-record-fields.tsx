'use client';
import {useEffect,useRef,useState} from 'react';
import type {DeftExperienceRecordFormV2Node} from '../../../../../packages/app-kit/src/app-data';
import {createExperienceRecordWriter,type ExperienceRecordWriterState} from '@/lib/app-experience-record-writer';
import {recordFieldsMode,validateRecordFields,recordChoiceValue,recordChoiceEdit} from '@/lib/app-experience-record-fields';
import type {ExperienceRecordFormPorts} from './experience-record-form';
import {ExperienceRepeatedRecordFields} from './experience-repeated-record-fields';
import {ExperienceComposeRichEditor} from './experience-compose-controls-rich-editor';

type Event={kind:'input';node_id:string;record_id:string;record_revision:number;content_digest:string;record_state:string;valid:boolean;dirty:boolean};
const pill='min-h-10 rounded-full px-4 py-2 text-sm hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50';
/** Typed settings values are edited only inside this host-owned CAS lifetime. */
export function ExperienceRecordFields({node,ports,context,emit,registerWriter}:{node:DeftExperienceRecordFormV2Node;ports:ExperienceRecordFormPorts;
 context:{current:()=>boolean;signal:AbortSignal};emit:(event:Event)=>unknown;registerWriter?:(save:(()=>Promise<boolean>)|null)=>void}){
 const latest=useRef({node,context,emit});latest.current={node,context,emit};
 const [state,setState]=useState<ExperienceRecordWriterState|null>(null),[readonly,setReadonly]=useState(false),[notice,setNotice]=useState('Opening saved settings…');
 const writer=useRef<ReturnType<typeof createExperienceRecordWriter>|null>(null),alive=useRef(true);
 const current=()=>alive.current&&latest.current.context.current()&&!latest.current.context.signal.aborted;
 const writable=()=>current()&&!latest.current.node.disabled;
 useEffect(()=>{alive.current=true;const abort=new AbortController(),signal=AbortSignal.any([context.signal,abort.signal]);
  void ports.load(node,signal).then(({record,identities})=>{
   if(!current()||signal.aborted)return;const mode=recordFieldsMode(node,record,identities);
   setReadonly(mode.readonly);setNotice(mode.unavailable?'This saved identity is currently unavailable. Settings are read-only.':'');
   if(mode.readonly){setState({row:record,value:record.value,dirty:false,state:'saved',notice:'Read-only'});registerWriter?.(()=>Promise.resolve(true));return;}
   const validate=(value:Record<string,unknown>)=>validateRecordFields(value,node.profile,record.value);
   writer.current=createExperienceRecordWriter({initial:record,current:writable,signal,validate,
    read:async()=>{const result=await ports.load(latest.current.node,signal);const fresh=recordFieldsMode({...latest.current.node,expected_revision:result.record.revision,content_digest:result.record.content_digest},result.record,result.identities);if(fresh.readonly)throw Error('Settings are read-only');return result.record;},
    save:(revision,value,requestId,digest)=>ports.save(latest.current.node,revision,value,requestId,digest,signal),
    ...(ports.saveStatus?{recoverSave:(revision:number,value:Record<string,unknown>,requestId:string,digest:string)=>ports.saveStatus!(latest.current.node,revision,value,requestId,digest,signal)}:{}),
    change:next=>{if(!writable())return;setState(next);let valid=true;try{validate(next.value);}catch{valid=false;}
     void latest.current.emit({kind:'input',node_id:node.id,record_id:node.record_id,record_revision:next.row.revision,content_digest:next.row.content_digest,record_state:next.state,valid,dirty:next.dirty});}});
   setState(writer.current.snapshot);registerWriter?.(()=>writer.current!.save());
  }).catch(()=>{if(current()&&!signal.aborted)setNotice('These saved settings are unavailable. Reopen them to check their current version.');});
  return()=>{alive.current=false;abort.abort();writer.current?.dispose();registerWriter?.(null);};
 },[]);
 if(!state)return <p role="status" className="py-4 text-sm text-[var(--muted)]">{notice}</p>;
 const disabled=readonly||!!node.disabled||state.state==='saving'||state.state==='blocked'||!current(),value=state.value,rich=node.profile.richtext;
 const edit=(field:string,next:unknown)=>{if(disabled||!writable())return;writer.current?.edit({...writer.current.snapshot.value,[field]:next});};
 return <section aria-label={node.label} data-record-fields="true" className="mx-auto w-full max-w-3xl space-y-5 rounded-xl bg-[var(--surface)] px-5 py-5 sm:px-8">
  <style>{`.deft-experience [data-record-fields] button:not([data-record-primary]){background:transparent;color:var(--foreground-secondary,var(--on-surface-variant));border-color:transparent;box-shadow:none}.deft-experience [data-record-fields] button:not([data-record-primary]):hover:not(:disabled){background:var(--hover-tint)}`}</style>
  <h2 className="text-base font-medium">{node.label}</h2>
  <div className="space-y-4">{node.profile.fields.map(field=>{
   const saved=field.kind==='choice'?recordChoiceValue(value,field):value[field.field];
   if(readonly||field.kind==='verified_identity')return <dl key={field.field}><dt className="text-xs text-[var(--muted)]">{field.label}</dt><dd className="whitespace-pre-wrap break-words text-sm">{field.kind==='boolean'?(saved?'On':'Off'):field.kind==='choice'?field.options.find(option=>option.value===saved)!.label:String(saved)||'—'}</dd></dl>;
   if(field.kind==='boolean')return <label key={field.field} className="flex items-center gap-3 text-sm"><input type="checkbox" aria-label={field.label} checked={saved as boolean} disabled={disabled} onChange={event=>edit(field.field,event.target.checked)}/>{field.label}</label>;
   if(field.kind==='choice')return <label key={field.field} className="block text-xs text-[var(--muted)]">{field.label}<select aria-label={field.label} value={saved as string} disabled={disabled} className="mt-1 block min-h-11 w-full rounded-lg bg-[var(--surface-container-low)] px-3 text-sm text-[var(--foreground)]" onChange={event=>{if(!disabled&&writable())writer.current?.edit(recordChoiceEdit(writer.current.snapshot.value,field,event.target.value));}}>{field.options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
   return <label key={field.field} className="block text-xs text-[var(--muted)]">{field.label}<input aria-label={field.label} value={saved as string} maxLength={field.max_characters} required={field.required} disabled={disabled} className="mt-1 block min-h-11 w-full rounded-lg bg-[var(--surface-container-low)] px-3 text-sm text-[var(--foreground)]" onChange={event=>edit(field.field,event.target.value)}/></label>;
  })}</div>
  {node.profile.repeated_fields&&<ExperienceRepeatedRecordFields groups={node.profile.repeated_fields} value={value} disabled={disabled} readonly={readonly} onChange={next=>{if(!disabled&&writable())writer.current?.edit(next);}}/>}
  {rich&&<ExperienceComposeRichEditor label={rich.label} value={{html:value[rich.html_field] as string,plainText:value[rich.plain_field] as string}}
   maxCharacters={rich.max_html_characters} maxPlainCharacters={rich.max_plain_characters} preserveWhitespace hostLinks disabled={disabled} presentationOnly={readonly}
   validateValue={pair=>validateRecordFields({...value,[rich.html_field]:pair.html,[rich.plain_field]:pair.plainText},node.profile,state.row.value)}
   onChange={pair=>{if(!disabled&&writable())writer.current?.edit({...writer.current.snapshot.value,[rich.html_field]:pair.html,[rich.plain_field]:pair.plainText});}}/>}
  <div className="flex flex-wrap items-center justify-between gap-3"><p role="status" className="text-xs text-[var(--muted)]">{notice||state.notice||(readonly?'Read-only':'Saved privately')}</p>
   {!readonly&&<div className="flex flex-wrap gap-2">{state.state==='blocked'?<>
    {ports.saveStatus&&<button type="button" className={pill} disabled={!writable()} onClick={()=>void writer.current?.reconcileSave()}>Check saved status</button>}
    <button type="button" className={pill} disabled={!writable()} onClick={()=>void writer.current?.reopen()}>Reopen saved version</button>
   </>:<button type="button" data-record-primary="true" className={`${pill} bg-[var(--primary)] text-[var(--on-primary)]`} disabled={disabled||!state.dirty} onClick={()=>void writer.current?.save()}>Save settings</button>}</div>}
  </div>
 </section>;
}
