'use client';
import {createRecordEventDelivery} from '@/lib/app-experience-record-event-delivery';
import {createRecordBrowserRecovery,type RecordRecoveryState,type RecordSubmissionAttempt} from '@/lib/app-experience-record-browser-recovery';
import type {RecordRecoveryScope} from '@/lib/app-experience-draft-recovery';
import {createInitialRecordChange,type InitialChangePorts} from '@/lib/app-experience-initial-change';
import {ExperienceRecordChanges} from './experience-record-changes';
import type {RecordChangePorts} from '@/lib/app-experience-record-changes';
import {ExperienceRecordOriginalFiles} from './experience-record-original-files';
import {recordCopySource,type FileCopyPorts} from '@/lib/app-experience-file-copy';
import {ExperienceRecordFiles} from './experience-record-files';
import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ChevronDown,ImagePlus,Maximize2,Minimize2} from 'lucide-react';
import {createExperienceRecordWriter,experienceRecordSubmissionEvent,type ExperienceRecordRow,type ExperienceRecordWriterState} from '@/lib/app-experience-record-writer';
import {prepareRecordFormFile,recordFormFiles,recordFormString,validateRecordFormValue,experienceRecordFormMode,type RecordFormFile,type RecordFormIdentity,recordFormFields,recordFormIdentity,recordFormLabels,type RecordFormNode,type RecordFormProfile} from '@/lib/app-experience-record-form';
import {createInlinePreviews,inlineImageExtension} from '@/lib/app-experience-inline-images';
import {plainToRich,richEditorView} from '@/lib/app-experience-rich-mode';
import {richtextImageReference,parseTrustedRichtextHtml} from '../../../../../packages/app-kit/src/safe-rich-text';
import {recordChoiceEdit} from '@/lib/app-experience-record-fields';
import {ExperienceRecordFields} from './experience-record-fields';
import type {DeftExperienceRecordFormV2Node,DeftExperienceRecordFormNode} from '../../../../../packages/app-kit/src/app-data';
import {ExperienceComposeRichEditor,type ComposeImagePort} from './experience-compose-controls-rich-editor';
import {ExperienceComposeMailboxControl,ExperienceFilePicker} from './experience-compose-controls';
import {parseAddressList} from '../../../../../packages/app-kit/src/structured-address';

export type ExperienceRecordFormNode=RecordFormNode;
export type ExperienceRecordFormReference=ExperienceRecordFormNode|DeftExperienceRecordFormV2Node;
export type ExperienceRecordFormPorts={
 resolveSeed?:(node:ExperienceRecordFormNode,signal:AbortSignal)=>Promise<ExperienceRecordFormNode>;
 load:(node:ExperienceRecordFormReference,signal:AbortSignal)=>Promise<{record:ExperienceRecordRow;identities:readonly RecordFormIdentity[];primaryIdentity?:RecordFormIdentity|null}>;
 save:(node:ExperienceRecordFormReference,revision:number,value:Record<string,unknown>,requestId:string,digest:string,signal:AbortSignal)=>Promise<ExperienceRecordRow>;
 saveStatus?:(node:ExperienceRecordFormReference,revision:number,value:Record<string,unknown>,requestId:string,digest:string,signal:AbortSignal)=>Promise<ExperienceRecordRow|null>;
 upload:(node:ExperienceRecordFormNode,row:ExperienceRecordRow,file:RecordFormFile,bytes:File,signal:AbortSignal)=>Promise<ExperienceRecordRow>;
 detach:(node:ExperienceRecordFormNode,row:ExperienceRecordRow,file:RecordFormFile,signal:AbortSignal)=>Promise<ExperienceRecordRow>;
 readFile:(node:ExperienceRecordFormNode,row:ExperienceRecordRow,file:RecordFormFile,signal:AbortSignal)=>Promise<Uint8Array>;
 recoveryScope?:(node:ExperienceRecordFormNode,signal:AbortSignal)=>Promise<RecordRecoveryScope>;
 recoverySnapshot?:(node:ExperienceRecordFormNode,signal:AbortSignal)=>Promise<{scope:RecordRecoveryScope;record:ExperienceRecordRow}>;
 submissionStatus?:(node:ExperienceRecordFormNode,attempt:RecordSubmissionAttempt,scope:RecordRecoveryScope,signal:AbortSignal)=>Promise<boolean>;
 review?:(node:ExperienceRecordFormNode,row:ExperienceRecordRow,signal:AbortSignal,recovery?:{beforeSubmit:(attempt:RecordSubmissionAttempt)=>Promise<void>;confirmed:()=>Promise<void>;restored?:(expected:Pick<ExperienceRecordRow,'record_id'|'revision'|'content_digest'>)=>Promise<unknown>})=>Promise<boolean>;
 deliverSubmitted?:(node:ExperienceRecordFormNode,row:ExperienceRecordRow,signal:AbortSignal)=>Promise<boolean>;
 reopenSubmitted?:()=>void;
}&Partial<FileCopyPorts>&Partial<InitialChangePorts>;
type Context={current:()=>boolean;signal:AbortSignal};
type Event={record_seed?:boolean;expected_seed_record_id?:string;kind:'input';node_id:string;record_id:string;record_revision:number;content_digest:string;record_state:string;valid:boolean;dirty:boolean};
export const recordSurfaceStyles=`
.deft-experience [data-record-surface] button:not([data-record-primary]){background:transparent;color:var(--foreground-secondary,var(--on-surface-variant));border-color:transparent;font-weight:500;box-shadow:none}
.deft-experience [data-record-surface] button:not([data-record-primary]):hover:not(:disabled){background:var(--hover-tint,var(--surface-container-low))}
.deft-experience [data-record-surface] button[aria-pressed="true"]{background:var(--surface-container-high);color:var(--primary)}
.deft-experience [data-record-surface] input:not([type="checkbox"]):not([type="file"]),.deft-experience [data-record-surface] textarea{background:transparent;border-color:transparent}
.deft-experience [data-record-surface] [role="document"] .deft-editor{min-height:0!important;padding:0}
`;
/** Layout is local to this surface; its writing subtree and CAS owner never change. */
export function RecordSurface({label,children}:{label:string;children:import('react').ReactNode}){
 const [expanded,setExpanded]=useState(false),bodyId=useId();
 return <section aria-label={label} data-record-surface="true" className={`relative mx-auto w-full min-w-0 ${expanded?'max-w-none':'max-w-4xl'} rounded-xl bg-[var(--surface)] px-1 py-2 sm:px-3`}>
  <style>{recordSurfaceStyles}</style>
  <button type="button" aria-label={expanded?'Restore record width':'Expand record'} title={expanded?'Restore record width':'Expand record'} aria-expanded={expanded} aria-controls={bodyId}
   className="absolute right-1 top-2 z-10 flex min-h-10 min-w-10 items-center justify-center rounded-full px-2 text-xs focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
   onPointerDown={event=>event.preventDefault()} onClick={()=>setExpanded(value=>!value)}>
   {expanded?<Minimize2 size={16} aria-hidden="true"/>:<Maximize2 size={16} aria-hidden="true"/>}
  </button>
  <div id={bodyId} className="min-w-0 space-y-2 [&>:first-child]:pr-11">{children}</div>
 </section>;
}
const pill='min-h-10 rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50';

function RecordBody({value,files,profile,disabled,presentationOnly=false,onChange,preview,register,validate}:{value:{html:string;plainText:string};files:RecordFormFile[];profile:RecordFormProfile;
 disabled:boolean;presentationOnly?:boolean;onChange:(next:{html:string;plainText:string})=>void;preview:ReturnType<typeof createInlinePreviews>;
 register:(port:ComposeImagePort|null,previous?:ComposeImagePort)=>void;validate:(next:{html:string;plainText:string})=>void}){
 const richtext=profile.richtext!;
 const id=useId(),ref=useRef({files,preview,register,value,disabled,onChange});ref.current={files,preview,register,value,disabled,onChange};
 const extension=useMemo(()=>inlineImageExtension({files:()=>ref.current.files,preview:file=>ref.current.preview.acquire(file)}),[]);
 const rich=useMemo(()=>value.html?richEditorView(value,{inlineAttachments:files}):null,[value.html,value.plainText,files]);
 const [notice,setNotice]=useState('');
 useEffect(()=>{if(rich||presentationOnly)return;let active=true;const port:ComposeImagePort={insert(fileId,alt){
  if(!active||ref.current.disabled||!ref.current.files.some(file=>file.file_id===fileId))return false;
  try{const escape=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
   const pair=plainToRich(ref.current.value.plainText),html=pair.html+'<p><img src="cid:'+richtextImageReference(fileId)+'" alt="'+escape(alt)+'"></p>';
   ref.current.onChange(parseTrustedRichtextHtml(html,{inlineAttachments:ref.current.files}));return true;}catch{return false;}}};
  register(port);return()=>{active=false;register(null,port);};
 },[!!rich,register,presentationOnly]);
 if(rich)return <ExperienceComposeRichEditor label={richtext.label} value={rich} preserveWhitespace hostLinks
  hostImages={{files,extension,register}} maxCharacters={richtext.max_characters} maxPlainCharacters={richtext.max_characters}
  disabled={disabled} presentationOnly={presentationOnly} onChange={onChange} validateValue={validate}/>;
 if(presentationOnly)return <div role="document" aria-label={richtext.label} className="whitespace-pre-wrap break-words py-4 text-[0.9375rem] leading-7">{value.plainText}</div>;
 return <div className="min-w-0 space-y-2 pt-3"><label htmlFor={id} className="sr-only">{richtext.label}</label>
  <textarea id={id} data-compose-writing-control="true" value={value.plainText} disabled={disabled} maxLength={richtext.max_characters}
   onChange={event=>{setNotice('');onChange({html:'',plainText:event.target.value});}}
   className="min-h-[clamp(10rem,30dvh,22rem)] w-full resize-y rounded-lg bg-transparent px-1 py-3 text-[0.9375rem] leading-7 outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-60"/>
  <div className="flex flex-wrap justify-between gap-2 text-xs text-[var(--muted)]"><p role="status">{notice}</p>{value.plainText.length>=richtext.max_characters*.9&&<span>{(richtext.max_characters-value.plainText.length).toLocaleString()} characters left</span>}</div>
  <button type="button" disabled={disabled} className={pill} onClick={()=>{try{onChange(plainToRich(value.plainText));setNotice('');}catch{setNotice('Formatting would exceed the draft limits. Your text is kept.');}}}>Add formatting</button>
 </div>;
}
export function ExperienceRecordPreview({value,node,row,ports,signal,current}:{value:Record<string,unknown>;node:ExperienceRecordFormNode;
 row:ExperienceRecordRow;ports:ExperienceRecordFormPorts;signal:AbortSignal;current:()=>boolean}){
 const preview=useMemo(()=>createInlinePreviews({current:()=>current()&&!signal.aborted,read:(file,readSignal)=>ports.readFile(node,row,file,AbortSignal.any([signal,readSignal])),denied:()=>{}}),[]);
 useEffect(()=>()=>preview.dispose(),[preview]);
 const files=recordFormFiles(value,node.profile),rich=node.profile.richtext;
 validateRecordFormValue(value,node.profile);
 return <div className="space-y-3"><dl className="space-y-3">
  {recordFormFields(node.profile).map(field=><div key={field.field}><dt className="text-xs text-[var(--muted)]">{field.label}</dt><dd className="whitespace-pre-wrap break-words">{field.kind==='verified_identity'?recordFormIdentity(value,field)||'Not recorded':field.kind==='boolean'?(value[field.field]?'On':'Off'):field.kind==='choice'?field.options.find(option=>option.value===value[field.field])?.label:String(value[field.field])||'—'}</dd></div>)}
 </dl>{rich&&<RecordBody value={{html:recordFormString(value,rich.html_field),plainText:recordFormString(value,rich.plain_field)}} files={files} profile={node.profile} disabled presentationOnly onChange={()=>{}} preview={preview} register={()=>{}} validate={()=>{}}/>}
 {files.length>0&&<ExperienceRecordFiles node={node} row={row} ports={ports} signal={signal} current={current}/>}</div>;
}
/** One form owns one CAS writer. Body bytes and file handles never enter author events. */
export function ExperienceRecordForm({node,ports,context,emit,registerWriter}:{node:ExperienceRecordFormNode;ports:ExperienceRecordFormPorts;context:Context;emit:(event:Event)=>unknown;registerWriter?:(save:(()=>Promise<boolean>)|null)=>void}){
 const resolvedSeed=useRef(node);node={...resolvedSeed.current,disabled:node.disabled};
 const recovery=useRef<ReturnType<typeof createRecordBrowserRecovery>|null>(null),recoveryScope=useRef<RecordRecoveryScope|null>(null);
 const [recoveryState,setRecoveryState]=useState<RecordRecoveryState|null>(null);
 const eventPort=useRef(emit);eventPort.current=emit;
 const [state,setState]=useState<ExperienceRecordWriterState|null>(null),[identities,setIdentities]=useState<readonly RecordFormIdentity[]>([]);
 const [primaryIdentity,setPrimaryIdentity]=useState<RecordFormIdentity|null>(null);const [notice,setNotice]=useState('Opening draft...'),[optionalVisibility,setOptionalVisibility]=useState<Record<string,boolean>>({}),[identityOpen,setIdentityOpen]=useState<string|null>(null),[fileBusy,setFileBusy]=useState(false),[copyUnconfirmed,setCopyUnconfirmed]=useState(false),[changeBusy,setChangeBusy]=useState(false),[reviewBusy,setReviewBusy]=useState(false),[submitted,setSubmitted]=useState(false);
 const initialChange=useRef<ReturnType<typeof createInitialRecordChange>|null>(null);const [initialUnknown,setInitialUnknown]=useState(false);
 const writer=useRef<ReturnType<typeof createExperienceRecordWriter>|null>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),imagePort=useRef<ComposeImagePort|null>(null);
 const [imageGeneration,setImageGeneration]=useState(0),pendingImage=useRef<{fileId:string;alt:string}|null>(null),latest=useRef(state);latest.current=state;
 const current=()=>context.current()&&!context.signal.aborted;
 const preview=useMemo(()=>createInlinePreviews({current,read:(file,signal)=>{const row=writer.current?.snapshot.row;if(!row)throw Error('Draft unavailable');return ports.readFile(node,row,file,signal);},denied:()=>setNotice('File access ended.')}),[]);
 useEffect(()=>{let alive=true;let renewal:ReturnType<typeof setInterval>|undefined;void (async()=>{if(node.seed&&ports.resolveSeed){const previous=node.record_id,resolved=await ports.resolveSeed(node,context.signal);if(!alive||!current())throw Error('Seed scope ended');resolvedSeed.current=resolved;node=resolved;if(previous!==resolved.record_id&&await eventPort.current({kind:'input',node_id:node.id,record_id:resolved.record_id,record_revision:0,content_digest:'sha256:'+'0'.repeat(64),record_state:'saved',valid:true,dirty:false,record_seed:true,expected_seed_record_id:previous})!==true)throw Error('Seed delivery unavailable');if(!alive||!current())throw Error('Seed scope ended');}return ports.load(node,context.signal);})().then(async({record,identities,primaryIdentity})=>{
  if(!alive||!current())return;const mode=experienceRecordFormMode(node,record);recordCopySource(node,record);setIdentities(identities);setPrimaryIdentity(primaryIdentity??null);const initialNotice=typeof record.summary?.initial_value_notice==='string'?record.summary.initial_value_notice:'';
  if(mode==='readonly'){setNotice(initialNotice);setState({row:record,value:record.value,dirty:false,state:'saved',notice:'Read-only'});registerWriter?.(()=>Promise.resolve(true));return;}
  if(ports.recoveryScope){setNotice('Checking browser recovery…');const scope=await ports.recoveryScope(node,context.signal);if(!alive||!current())return;recoveryScope.current=scope;
   recovery.current=createRecordBrowserRecovery({scope,allowUnsavedSeed:!!node.seed,maxBytes:node.profile.max_record_bytes,validate:value=>validateRecordFormValue(value,node.profile),validateRestore:(value,row)=>{if(JSON.stringify(recordFormFiles(value,node.profile))!==JSON.stringify(recordFormFiles(row.value,node.profile)))throw Error('Recovery file custody changed');},current,
    prove:async signal=>{const proofSignal=AbortSignal.any([context.signal,signal]);if(ports.recoverySnapshot){const proof=await ports.recoverySnapshot(node,proofSignal);return {scope:proof.scope,row:proof.record};}return {scope:await ports.recoveryScope!(node,proofSignal),row:(await ports.load(node,proofSignal)).record};},change:setRecoveryState});
  }
  writer.current=createExperienceRecordWriter({initial:record,current,signal:context.signal,validate:value=>validateRecordFormValue(value,node.profile),
   read:async()=>(await ports.load(node,context.signal)).record,save:(revision,value,requestId,digest)=>ports.save(node,revision,value,requestId,digest,context.signal),
   ...(ports.saveStatus?{recoverSave:(revision:number,value:Record<string,unknown>,requestId:string,digest:string)=>ports.saveStatus!(node,revision,value,requestId,digest,context.signal)}:{}),
   beforeSave:async attempt=>{if(recovery.current)await recovery.current.beforeSave(attempt,writer.current!.snapshot);},
   change:next=>{if(!current())return;if(['saved','unsaved'].includes(next.state)&&!writer.current?.recoveryAttempt)recovery.current?.saved();recovery.current?.record(next);setState(next);let valid=true;try{validateRecordFormValue(next.value,node.profile);}catch{valid=false;}
    void eventPort.current({kind:'input',node_id:node.id,record_id:node.record_id,record_revision:next.row.revision,content_digest:next.row.revision===0?'sha256:'+'0'.repeat(64):next.row.content_digest,record_state:next.state,valid,dirty:next.dirty});}});
  if(recovery.current){const candidate=await recovery.current.start(record);if(!alive||!current())return;
   if(candidate?.submission?.purpose==='save')writer.current.restoreRecovery(candidate.value.content,candidate.submission.attempt);
   else if(candidate?.submission?.purpose==='send')writer.current.blockRecovery();
   renewal=setInterval(()=>void recovery.current?.renew(),30000);
  }
  const loaded=writer.current.snapshot;setState(loaded);setNotice(initialNotice);
  let loadedValid=true;try{validateRecordFormValue(loaded.value,node.profile);}catch{loadedValid=false;}
  void eventPort.current({kind:'input',node_id:node.id,record_id:loaded.row.record_id,record_revision:loaded.row.revision,content_digest:loaded.row.revision===0?'sha256:'+'0'.repeat(64):loaded.row.content_digest,record_state:loaded.state,valid:loadedValid,dirty:loaded.dirty});
  registerWriter?.(()=>writer.current!.save());
  if(!node.seed&&node.initial_change&&ports.initialSource&&ports.prepareChange&&ports.applyChange&&ports.changeStatus){initialChange.current=createInitialRecordChange({node,writer:()=>writer.current,ports:ports as InitialChangePorts,current,signal:context.signal,
   change:(busy,text,unknown)=>{setChangeBusy(busy);setInitialUnknown(unknown);if(text)setNotice(text);}});void initialChange.current.start();}
 }).catch(()=>{if(alive&&current())setNotice('This saved draft is unavailable. Reopen it to check its current revision.');});
 return()=>{alive=false;clearTimeout(timer.current);clearInterval(renewal);recovery.current?.dispose();registerWriter?.(null);initialChange.current?.dispose();writer.current?.dispose();preview.dispose();};},[]);
 const edit=(next:Record<string,unknown>)=>{if(!current()||!writer.current?.edit(next))return;clearTimeout(timer.current);timer.current=setTimeout(()=>void writer.current?.save(),650);};
 const register=useRef((port:ComposeImagePort|null,previous?:ComposeImagePort)=>{if(!port&&previous&&imagePort.current!==previous)return;imagePort.current=port;if(port&&pendingImage.current)setImageGeneration(value=>value+1);}).current;
 useEffect(()=>{const pending=pendingImage.current;if(!pending||!state||fileBusy||!imagePort.current)return;
  if(imagePort.current.insert(pending.fileId,pending.alt))pendingImage.current=null;
 },[state?.row.revision,fileBusy,imageGeneration]);
 const labels=recordFormLabels(node.profile);
 if(!state)return <p role="status" className="py-4 text-sm text-[var(--muted)]">{notice}</p>;
 if(state.row.status!=='draft')return <RecordSurface label={node.label}>
  <p role="status" className="text-sm">{state.row.status==='submitted'?'Submitted record':'Archived record'} / {labels.readonly}</p>
  <ExperienceRecordPreview value={state.value} node={node} row={state.row} ports={ports} signal={context.signal} current={current}/>{typeof state.row.summary?.future_submission_id==='string'&&ports.review&&<button type="button" className={pill} disabled={reviewBusy||!current()} onClick={async()=>{setReviewBusy(true);try{await ports.review!(node,state.row,context.signal);if(current())ports.reopenSubmitted?.();}finally{if(current())setReviewBusy(false);}}}>{labels.scheduled}</button>}</RecordSurface>;
 if(submitted)return <section aria-label={node.label}><p role="status" className="py-4 text-sm">{labels.submitted}</p>
  {notice&&<p role="status" className="text-sm text-[var(--muted)]">{notice}</p>}
  {notice==='App controls could not be updated. Reopen the app to reconcile its saved state.'&&ports.reopenSubmitted&&<button type="button" className={pill} disabled={!current()} onClick={()=>{if(current())ports.reopenSubmitted?.();}}>Reopen app</button>}</section>;
 const immutable=!!node.disabled;
 const value=state.value,profile=node.profile,files=recordFormFiles(value,profile),disabled=!!node.disabled||!!recoveryState?.candidate||fileBusy||copyUnconfirmed||reviewBusy||changeBusy||state.state==='blocked';
 const fields=recordFormFields(profile),rich=profile.richtext;
 const body=rich?{html:recordFormString(value,rich.html_field),plainText:recordFormString(value,rich.plain_field)}:null;
 const optionalFields=fields.filter(field=>field.kind==='text'&&field.optional);
 const optionalExpanded=(field:string)=>optionalVisibility[field]??Boolean(recordFormString(value,field));
 const valueCount=(field:typeof fields[number])=>{const text=recordFormString(value,field.field);if(field.kind==='text'&&field.format==='mailbox_list'){try{return parseAddressList(text,{maxItems:32,allowEmpty:true}).length;}catch{return null;}}return text?1:0;};
 const changeBody=(next:{html:string;plainText:string})=>{if(rich)edit({...writer.current!.snapshot.value,[rich.html_field]:next.html,[rich.plain_field]:next.plainText});};
 async function upload(selected:readonly File[],inline=false){if(!current()||disabled||selected.length!==1){setNotice('Select one file at a time.');return;}setFileBusy(true);setNotice('');
  try{const file=await prepareRecordFormFile(selected[0],profile,files);if(inline&&!['image/png','image/jpeg','image/gif','image/webp'].includes(file.media_type))throw Error('Choose a PNG, JPEG, GIF or WebP image.');
   const ok=await writer.current!.mutate(async()=>{const row=writer.current!.snapshot.row,next=await ports.upload(node,row,file,selected[0],context.signal);
    const nextFiles=recordFormFiles(next.value,profile),added=nextFiles.filter(item=>!files.some(old=>old.file_id===item.file_id));
    if(added.length!==1||Object.keys(file).some(key=>added[0][key as keyof RecordFormFile]!==file[key as keyof RecordFormFile])||nextFiles.length!==files.length+1
     ||files.some(old=>{const retained=nextFiles.find(item=>item.file_id===old.file_id);return !retained||Object.keys(old).some(key=>retained[key as keyof RecordFormFile]!==old[key as keyof RecordFormFile]);}))throw Error('File upload changed');return next;});
   if(ok&&inline)pendingImage.current={fileId:file.file_id,alt:file.filename};
  }catch(error){if(current())setNotice(error instanceof Error?error.message:'File unavailable.');}finally{if(current())setFileBusy(false);}}
 function insertImage(fileId:string){if(disabled||!current()||!writer.current)return;const file=recordFormFiles(writer.current.snapshot.value,profile).find(file=>file.file_id===fileId&&['image/png','image/jpeg','image/gif','image/webp'].includes(file.media_type));if(!file)return;
  if(imagePort.current?.insert(file.file_id,file.filename)){pendingImage.current=null;setNotice('');}else setNotice('Image could not be inserted. Your file is kept.');}
 async function detach(fileId:string){if(disabled||!current())return;const file=files.find(item=>item.file_id===fileId);if(!file)return;setFileBusy(true);
  try{await writer.current!.mutate(()=>ports.detach(node,writer.current!.snapshot.row,file,context.signal));}finally{if(current())setFileBusy(false);}}
 return <RecordSurface label={node.label}>
  {recoveryState&&(!recoveryState.ready||recoveryState.candidate||recoveryState.submission||recoveryState.notice!=='Browser recovery ready')&&<section aria-label="Browser draft recovery" className="space-y-2 text-xs"><p role="status">{recoveryState.notice}</p>
   {recoveryState.ready&&recoveryState.submission&&current()&&<p aria-label="Submission reference" className="break-all">Submission reference <code>{recoveryState.submission.submissionId}</code></p>}
   {recoveryState.candidate&&!recoveryState.candidate.submission&&<div className="flex gap-2"><button type="button" className={pill} onClick={async()=>{const value=await recovery.current?.restore(writer.current!.snapshot);if(value&&current())writer.current?.restoreRecovery(value);}}>Restore browser draft</button><button type="button" className={pill} onClick={()=>void recovery.current?.keepCurrent()}>Keep current draft</button></div>}
   {recoveryState.submission&&ports.submissionStatus&&<button type="button" className={pill} onClick={async()=>{try{await recovery.current?.renew();const attempt=recovery.current?.snapshot().submission;if(attempt&&current()&&recoveryScope.current&&await ports.submissionStatus!(node,attempt,recoveryScope.current,context.signal)&&current()){await recovery.current?.confirmed();writer.current?.dispose();setSubmitted(true);setNotice('Submission status confirmed. Check Activity for delivery status.');}}catch{if(current())setNotice('Submission status is unavailable. This submission will not be repeated.');}}}>Check original submission</button>}
   {!recoveryState.ready&&<button type="button" className={pill} onClick={()=>void recovery.current?.renew()}>Check browser recovery access</button>}
  </section>}
  {initialUnknown&&<button type="button" className={pill} disabled={!current()||changeBusy} onClick={()=>void initialChange.current?.check()}>Check original saved-content change</button>}
  <div className="flex flex-wrap items-center justify-end gap-2"><div className="flex min-w-0 flex-wrap items-center gap-2">{fields.filter(field=>field.kind==='verified_identity').map(field=>{
   if(field.kind!=='verified_identity')return null;const identity=value[field.field],selected=recordFormIdentity(value,field)||(primaryIdentity?.address??identities[0]?.address??'');
   return <div key={field.field} className="relative min-w-0"><button type="button" className={`${pill} flex max-w-full items-center gap-2 bg-[var(--surface-container-low)]`} disabled={disabled} aria-label={`${field.label} ${selected||'Unavailable'}`} aria-expanded={identityOpen===field.field} onClick={()=>setIdentityOpen(previous=>previous===field.field?null:field.field)}><span className="text-[var(--muted)]">{field.label}</span><span className="max-w-64 truncate">{selected||'Unavailable'}</span><ChevronDown size={14}/></button>
    {identityOpen===field.field&&<div className="absolute left-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] space-y-2 rounded-xl bg-[var(--surface-container-high)] p-3 shadow-xl"><label className="block text-xs">{field.label}<select aria-label={field.label} className="mt-1 w-full rounded-lg bg-[var(--surface-container-low)] px-2 py-2 text-sm" value={selected} disabled={disabled} onChange={event=>{if(!identities.some(item=>item.address===event.target.value))return;edit({...writer.current!.snapshot.value,[field.field]:field.identity_field?{...(identity&&typeof identity==='object'?identity:{}),[field.identity_field]:event.target.value}:event.target.value});setIdentityOpen(null);}}>
     {!identities.some(item=>item.address===selected)&&<option value={selected}>{selected} (unavailable)</option>}{identities.map(item=><option key={item.address} value={item.address}>{item.label||item.address}</option>)}</select></label><button type="button" className={pill} onClick={()=>setIdentityOpen(null)}>Close</button></div>}</div>;
  })}</div><div className="flex items-center gap-1">{optionalFields.map(field=><button key={field.field} type="button" className={pill} disabled={disabled} aria-expanded={optionalExpanded(field.field)} onClick={()=>setOptionalVisibility(previous=>({...previous,[field.field]:!optionalExpanded(field.field)}))}>{field.label}{valueCount(field)?` (${valueCount(field)})`:recordFormString(value,field.field)?' (check)':''}</button>)}</div></div>
  {fields.map(field=>{
   if(field.kind==='verified_identity'||field.kind==='text'&&field.optional&&!optionalExpanded(field.field))return null;
   if(field.kind==='text'&&field.format==='mailbox_list'&&field.presentation==='pills')return <ExperienceComposeMailboxControl key={field.field} label={field.label} value={recordFormString(value,field.field)} disabled={disabled} onChange={text=>edit({...writer.current!.snapshot.value,[field.field]:text})}/>;
   if(field.kind==='boolean')return <label key={field.field} className="flex items-center gap-3 text-sm"><input type="checkbox" aria-label={field.label} checked={value[field.field] as boolean} disabled={disabled} onChange={event=>edit({...writer.current!.snapshot.value,[field.field]:event.target.checked})}/>{field.label}</label>;
   if(field.kind==='choice')return <label key={field.field} className="block text-xs">{field.label}<select aria-label={field.label} value={value[field.field] as string} disabled={disabled} className="mt-1 min-h-11 w-full rounded-lg bg-[var(--surface-container-low)] px-3" onChange={event=>edit(recordChoiceEdit(writer.current!.snapshot.value,field,event.target.value))}>{field.options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
   return <label key={field.field} className="flex items-start gap-3"><span className="w-14 shrink-0 py-3.5 text-xs text-[var(--on-surface-variant)]">{field.label}</span><input aria-label={field.label} value={recordFormString(value,field.field)} disabled={disabled} maxLength={field.max_characters} required={field.required} onChange={event=>edit({...writer.current!.snapshot.value,[field.field]:event.target.value})} className="min-h-11 min-w-0 flex-1 rounded-lg bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"/></label>;
  })}
  {body&&rich&&<RecordBody value={body} files={files} profile={profile} disabled={disabled} onChange={changeBody} preview={preview} register={register} validate={next=>validateRecordFormValue({...writer.current!.snapshot.value,[rich.html_field]:next.html,[rich.plain_field]:next.plainText},profile)}/>}
  {!!node.record_changes?.length&&ports.listChanges&&ports.prepareChange&&ports.applyChange&&ports.changeStatus&&<ExperienceRecordChanges node={node} writer={()=>writer.current} ports={ports as ExperienceRecordFormPorts&RecordChangePorts} signal={context.signal} current={current} disabled={immutable||!!node.disabled||fileBusy||copyUnconfirmed||reviewBusy||state.state==='blocked'} onBusy={setChangeBusy}/> }
  {profile.files&&!!node.source_refs?.length&&ports.listOriginals&&ports.copyOriginal&&ports.copyStatus&&<ExperienceRecordOriginalFiles node={node} writer={()=>writer.current} ports={ports as FileCopyPorts} signal={context.signal} current={current} disabled={disabled||immutable} onBusy={setFileBusy} onUnconfirmed={setCopyUnconfirmed}/>}
  {profile.files&&<ExperienceRecordFiles node={node} row={state.row} ports={ports} signal={context.signal} current={current} disabled={disabled||immutable} onSelectFiles={selected=>void upload(selected)} onRemove={fileId=>void detach(fileId)} onInsertImage={profile.richtext?.inline_images==='host_files'?insertImage:undefined}
   extraActions={profile.richtext?.inline_images==='host_files'&&profile.files.max_files>0?<ExperienceFilePicker label="Insert image" className={`${pill} inline-flex items-center gap-2`} disabled={disabled||immutable} accept="image/png,image/jpeg,image/gif,image/webp" onSelect={selected=>void upload(selected,true)}><ImagePlus size={16} aria-hidden="true"/>Insert image</ExperienceFilePicker>:undefined}/>}
  <div className="flex flex-wrap items-center justify-between gap-2"><p role="status" className="text-xs text-[var(--muted)]">{notice||state.notice||(state.row.revision===0?'Not saved on server':'Saved privately')}</p><div className="flex flex-wrap gap-2">
   {state.state==='blocked'?<>
    {ports.saveStatus&&<button type="button" className={pill} disabled={!current()||fileBusy||copyUnconfirmed||reviewBusy||changeBusy} onClick={async()=>{await recovery.current?.renew();if(current())await writer.current?.reconcileSave();}}>Check saved status</button>}
    <button type="button" className={pill} disabled={fileBusy||copyUnconfirmed||reviewBusy||changeBusy} onClick={()=>{if(!fileBusy&&!copyUnconfirmed&&!reviewBusy&&!changeBusy)void writer.current?.reopen();}}>Reopen saved version</button>
   </>:<button type="button" className={pill} disabled={disabled||state.state==='saving'||!state.dirty&&state.row.revision!==0} onClick={()=>void writer.current?.save(true)}>{labels.save}</button>}
   {node.action_key&&ports.review&&<button data-record-primary="true" type="button" className="min-h-10 rounded-full bg-[var(--primary)] px-5 py-2 text-sm text-[var(--on-primary)] disabled:opacity-50" disabled={disabled||state.state==='saving'||state.row.revision===0} onClick={async()=>{setReviewBusy(true);try{if(await writer.current!.save(true)&&await ports.review!(node,writer.current!.snapshot.row,context.signal,recovery.current?{beforeSubmit:attempt=>recovery.current!.beforeSubmit(attempt,writer.current!.snapshot),confirmed:()=>recovery.current!.confirmed(),restored:expected=>writer.current!.reopen({...expected,preserve_edits:true})}:undefined)&&current()){
     clearTimeout(timer.current);const row=writer.current!.snapshot.row;writer.current!.dispose();preview.dispose();registerWriter?.(()=>Promise.resolve(true));setSubmitted(true);setNotice('Updating app controls...');
     let posted=false;try{posted=ports.deliverSubmitted?await ports.deliverSubmitted(node,row,context.signal):await eventPort.current(experienceRecordSubmissionEvent(node.id,row))===true;}catch{/* Confirmed submission stays immutable even if UI delivery fails. */}
     if(current())setNotice(posted?'':'App controls could not be updated. Reopen the app to reconcile its saved state.');
    }}catch{if(current()){if(recovery.current?.snapshot().submission)writer.current?.blockRecovery();setNotice('The saved record could not be reviewed. Your changes are kept.');}}finally{if(current())setReviewBusy(false);}}}>{labels.review}</button>}
  </div></div>
 </RecordSurface>;
}

/** Ordinary small reference acknowledgements retain the editor and its writer.
 * A changed record/profile gets a fresh lifetime, including fresh object URLs. */
export function createExperienceRecordFormHost(ports:ExperienceRecordFormPorts){
 const retained=new Map<string,{element:HTMLDivElement;root:ReturnType<typeof createRoot>;context:Context;abort:AbortController;generation:number;identity:string;reference:string;acknowledged?:string;emit?:(event:Event)=>unknown;delivery?:ReturnType<typeof createRecordEventDelivery<Event>>;save?:(()=>Promise<boolean>)|null}>();
 return {async flushRecordForms(){const results=await Promise.all([...retained.values()].map(entry=>entry.save?.()??Promise.resolve(false)));return results.every(Boolean);},
  mountRecordForm(node:ExperienceRecordFormReference,wrapper:HTMLElement,emit:(event:Event)=>unknown,context:Context){
  const identity=JSON.stringify([node.store_key,node.record_id,node.profile,'source_refs' in node?node.source_refs??[]:[],'record_changes' in node?node.record_changes??[]:[]]);let entry=retained.get(node.id);
  const reference=JSON.stringify([node.expected_revision,node.content_digest]);
  if(entry&&(entry.identity!==identity||reference!==entry.reference&&reference!==entry.acknowledged)){entry.delivery?.dispose();entry.abort.abort();entry.root.unmount();retained.delete(node.id);entry=undefined;}
  if(!entry){const element=document.createElement('div');entry={element,root:createRoot(element),context,abort:new AbortController(),generation:0,identity,reference};retained.set(node.id,entry);}
  const owned=entry,generation=++owned.generation;owned.context=context;owned.reference=reference;owned.emit=emit;
  const active={signal:owned.abort.signal,current:()=>owned.context.current()&&!owned.context.signal.aborted&&!owned.abort.signal.aborted};
  owned.delivery??=createRecordEventDelivery<Event>({current:active.current,send:event=>owned.emit?.(event),accepted:event=>{if(event.record_id===node.record_id&&Number.isSafeInteger(event.record_revision)&&/^sha256:[a-f0-9]{64}$/u.test(event.content_digest))owned.acknowledged=JSON.stringify([event.record_revision,event.content_digest]);}});
  const emitAcknowledged=owned.delivery.send;
  wrapper.hidden='presentation' in node&&node.presentation==='minimized';
  wrapper.append(owned.element);owned.root.render(node.profile.schema_version==='deft.record_form_profile.v2'?<ExperienceRecordFields node={node as DeftExperienceRecordFormV2Node} ports={ports} emit={emitAcknowledged} context={active} registerWriter={save=>{owned.save=save;}}/>:<ExperienceRecordForm node={node as ExperienceRecordFormNode} ports={ports} emit={emitAcknowledged} context={active} registerWriter={save=>{owned.save=save;}}/>);
  return()=>queueMicrotask(()=>{if(owned.generation!==generation)return;owned.delivery?.dispose();owned.abort.abort();owned.root.unmount();if(retained.get(node.id)===owned)retained.delete(node.id);});
 }};
}
