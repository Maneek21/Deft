'use client';
import {useEffect,useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {createNativeTemplateApi,insertNativeTemplate,nativeTemplatePlaceholders,parseNativeTemplateContent,renderNativeTemplate,NativeTemplateError,type NativeEmailTemplate,type NativeTemplateContent,type NativeTemplateText} from '@/lib/email-native-templates';
import type {NativeDraftContent} from '@/lib/email-native-drafts';
import {NATIVE_COMPOSE_BODY_LIMITS} from '../../../../../packages/app-kit/src/safe-compose-html';
import {ExperienceComposeRichEditor} from '@/components/apps/experience-compose-controls-rich-editor';

const button='rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
const input='w-full rounded-lg bg-[var(--surface-container-low)] px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';
const empty=():NativeTemplateContent=>({title:'',subject:'',body:'',body_html:''});
function useTemplateCollection(accountId:string,sessionScope:string){
 const [rows,setRows]=useState<NativeEmailTemplate[]>([]),[cursor,setCursor]=useState<string|null>(null),[loading,setLoading]=useState(true),[notice,setNotice]=useState(''),[reload,setReload]=useState(0),[loadedScope,setLoadedScope]=useState('');
 const client=useRef<ReturnType<typeof createNativeTemplateApi>|null>(null),currentRef=useRef<()=>boolean>(()=>false),loadLock=useRef(false),denyRef=useRef<()=>void>(()=>{});
 const scope=JSON.stringify([accountId,sessionScope]);
 useEffect(()=>{
  const anchor=api.getAccessToken();let active=true,denied=false;
  const current=()=>active&&!denied&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());
  const owned=createNativeTemplateApi({fetch:(path,options)=>api.fetch(path,options),current});client.current=owned;currentRef.current=current;loadLock.current=false;
  denyRef.current=()=>{if(!current())return;denied=true;owned.dispose();setRows([]);setCursor(null);setLoading(false);setNotice('Template access changed. Reconnect this account in Email settings.');};
  setLoadedScope(scope);setRows([]);setCursor(null);setLoading(true);setNotice('');
  void owned.list(accountId).then(page=>{if(current()){setRows(page.items);setCursor(page.next_cursor);}}).catch(error=>{if(current()){if(error instanceof NativeTemplateError&&error.kind==='denied')denyRef.current();else setNotice(error instanceof Error?error.message:'Templates could not be loaded.');}}).finally(()=>{if(current())setLoading(false);});
  return()=>{active=false;owned.dispose();if(client.current===owned)client.current=null;};
 },[accountId,sessionScope,scope,reload]);
 const more=async()=>{
  const owned=client.current,current=currentRef.current;if(!owned||!current()||loading||loadLock.current||!cursor)return;
  if(rows.length>=100){setNotice('Only 100 templates can be loaded in this view. Additional templates have not been loaded.');return;}
  loadLock.current=true;setLoading(true);
  try{const page=await owned.list(accountId,cursor);if(current()){setRows(values=>{const map=new Map(values.map(row=>[row.template_id,row]));for(const row of page.items){const previous=map.get(row.template_id);if(!previous||row.revision>=previous.revision)map.set(row.template_id,row);}return [...map.values()];});setCursor(page.next_cursor===cursor?null:page.next_cursor);}}
  catch(error){if(current()){if(error instanceof NativeTemplateError&&error.kind==='denied')denyRef.current();else{setCursor(null);setNotice(error instanceof Error?error.message:'This page could not be loaded. Reload templates.');}}}
  finally{if(current()){loadLock.current=false;setLoading(false);}}
 };
 return {rows:loadedScope===scope?rows:[],cursor:loadedScope===scope?cursor:null,loading:loadedScope!==scope||loading,notice,setNotice,client,current:()=>currentRef.current(),deny:()=>denyRef.current(),more,reload:()=>setReload(value=>value+1),update:(row:NativeEmailTemplate)=>setRows(values=>row.status==='archived'?values.filter(value=>value.template_id!==row.template_id):[...values.filter(value=>value.template_id!==row.template_id),row])};
}
export function NativeTemplateEditorFields({content,disabled,onChange}:{content:NativeTemplateContent;disabled:boolean;onChange:(content:NativeTemplateContent)=>void}){
 return <div className="space-y-3">
  <label className="block space-y-1 text-xs"><span>Template name</span><input aria-label="Template name" className={input} value={content.title} disabled={disabled} maxLength={120} onChange={event=>onChange({...content,title:event.target.value})}/></label>
  <label className="block space-y-1 text-xs"><span>Subject</span><input aria-label="Template subject" className={input} value={content.subject} disabled={disabled} maxLength={998} onChange={event=>onChange({...content,subject:event.target.value})}/></label>
  <ExperienceComposeRichEditor nativeLinks label="Template message" value={{html:content.body_html,plainText:content.body}} maxCharacters={NATIVE_COMPOSE_BODY_LIMITS.maxCharacters} maxPlainCharacters={NATIVE_COMPOSE_BODY_LIMITS.maxPlainCharacters} disabled={disabled} onChange={value=>onChange({...content,body:value.plainText,body_html:value.html})}/>
  <p className="text-xs leading-5 text-[var(--muted)]">Use {'{{name}}'} for text you fill in when inserting. Placeholders cannot change links. Templates contain only a subject and message text.</p>
 </div>;
}
export function NativeEmailTemplates({accountId,sessionScope}:{accountId:string;sessionScope:string}){
 const [open,setOpen]=useState(false);
 return <section className="space-y-3 pt-5"><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-medium">Templates</h4><button type="button" className={button} aria-expanded={open} onClick={()=>setOpen(value=>!value)} disabled={open}>{open?'Templates for this account':'Manage templates'}</button></div>
  <p className="text-xs leading-5 text-[var(--text-secondary)]">Save reusable message text for this account. Insert it from More in Compose and review before sending.</p>
  {open&&<NativeTemplateManager key={JSON.stringify([accountId,sessionScope])} accountId={accountId} sessionScope={sessionScope} onClose={()=>setOpen(false)}/>}
 </section>;
}
function NativeTemplateManager({accountId,sessionScope,onClose}:{accountId:string;sessionScope:string;onClose:()=>void}){
 const collection=useTemplateCollection(accountId,sessionScope),[editing,setEditing]=useState<{id:string;revision:number|null;original:NativeTemplateContent}|null>(null),[content,setContent]=useState(empty),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[archivePrompt,setArchivePrompt]=useState(false);
 const lock=useRef(false),attempt=useRef<{kind:'save'|'archive';id:string;revision:number|null;content:NativeTemplateContent}|null>(null);
 const dirty=!!editing&&JSON.stringify(content)!==JSON.stringify(editing.original);
 const publish=(row:NativeEmailTemplate)=>{collection.update(row);setEditing({id:row.template_id,revision:row.revision,original:row.content});setContent(row.content);setUncertain(false);attempt.current=null;};
 const start=async(row?:NativeEmailTemplate)=>{
  const owned=collection.client.current;if(!owned||lock.current||!collection.current()||dirty||uncertain)return;
  if(!row){setEditing({id:crypto.randomUUID(),revision:null,original:empty()});setContent(empty());collection.setNotice('');return;}
  lock.current=true;setBusy(true);try{const fresh=await owned.read(accountId,row.template_id);if(collection.current())publish(fresh);}catch(error){if(collection.current()){if(error instanceof NativeTemplateError&&error.kind==='denied'){setEditing(null);setContent(empty());collection.deny();lock.current=false;setBusy(false);}else collection.setNotice(error instanceof Error?error.message:'Template could not be opened.');}}finally{if(collection.current()){lock.current=false;setBusy(false);}}
 };
 const mutate=async(kind:'save'|'archive')=>{
  const owned=collection.client.current;if(!owned||!editing||lock.current||uncertain||!collection.current()||kind==='save'&&editing.revision!==null&&!dirty)return;
  let valid:NativeTemplateContent;try{valid=parseNativeTemplateContent(content);}catch(error){collection.setNotice(error instanceof Error?error.message:'Check this template.');return;}
  const currentAttempt={kind,id:editing.id,revision:editing.revision,content:valid};attempt.current=currentAttempt;lock.current=true;setBusy(true);setArchivePrompt(false);collection.setNotice(kind==='archive'?'Archiving template…':'Saving template…');
  try{const next=kind==='save'?await owned.save(accountId,editing.id,editing.revision,valid):await owned.archive({template_id:editing.id,account_id:accountId,revision:editing.revision!,status:'active',content:valid,created_at:'',updated_at:''});
   if(collection.current()){if(kind==='archive'){collection.update(next);setEditing(null);setContent(empty());attempt.current=null;}else publish(next);collection.setNotice(kind==='archive'?'Template archived.':'Template saved.');}}
  catch(error){if(collection.current()){
   if(error instanceof NativeTemplateError&&error.kind==='denied'){setEditing(null);setContent(empty());collection.deny();onClose();}
   else if(error instanceof NativeTemplateError&&error.kind==='invalid'){attempt.current=null;}
   else setUncertain(true);
   collection.setNotice(error instanceof Error?error.message:'This change could not be confirmed. Check its saved version.');}}
  finally{if(collection.current()){lock.current=false;setBusy(false);}}
 };
 const check=async()=>{
  const owned=collection.client.current,held=attempt.current;if(!owned||!held||lock.current||!collection.current())return;lock.current=true;setBusy(true);
  try{const row=await owned.read(accountId,held.id);if(collection.current()){
   if(held.kind==='save'&&JSON.stringify(row.content)===JSON.stringify(held.content)&&row.revision===(held.revision===null?1:held.revision+1)){publish(row);collection.setNotice('Saved template confirmed.');}
   else collection.setNotice('The saved template differs from this change. Your edits remain here. Reload and discard these edits to use the saved version.');}}
  catch(error){if(collection.current()){
   if(error instanceof NativeTemplateError&&error.kind==='missing'&&held.kind==='archive'){setEditing(null);setContent(empty());setUncertain(false);attempt.current=null;collection.reload();collection.setNotice('The template is no longer active.');}
   else if(error instanceof NativeTemplateError&&error.kind==='denied'){setEditing(null);setContent(empty());collection.deny();onClose();}else collection.setNotice(error instanceof Error?error.message:'The saved template could not be confirmed.');}}
  finally{if(collection.current()){lock.current=false;setBusy(false);}}
 };
 const discard=()=>{setEditing(null);setContent(empty());setUncertain(false);attempt.current=null;setArchivePrompt(false);collection.reload();};
 return <div className="space-y-3 rounded-xl bg-[var(--surface-container-low)] p-3">
  <div className="flex flex-wrap gap-1"><button type="button" className={button} disabled={busy||dirty||uncertain} onClick={()=>void start()}>New template</button><button type="button" className={button} disabled={busy||dirty||uncertain} onClick={()=>collection.reload()}>Reload templates</button><button type="button" className={button} disabled={busy||dirty||uncertain} onClick={onClose}>Close templates</button></div>
  {collection.rows.map(row=><button key={row.template_id} type="button" className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50" disabled={busy||dirty||uncertain} onClick={()=>void start(row)}>{row.content.title}</button>)}
  {collection.loading&&<p role="status" className="text-xs text-[var(--muted)]">Loading templates…</p>}{!collection.loading&&!collection.rows.length&&<p className="text-xs text-[var(--muted)]">No templates have been loaded for this account.</p>}
  {collection.cursor&&<button type="button" className={button} disabled={busy||dirty||uncertain||collection.loading||collection.rows.length>=100} onClick={()=>void collection.more()}>More templates</button>}
  {collection.cursor&&collection.rows.length>=100&&<p className="text-xs text-[var(--muted)]">100 templates are loaded. Additional templates have not been loaded.</p>}
  {editing&&<div className="space-y-3"><NativeTemplateEditorFields content={content} disabled={busy||uncertain} onChange={setContent}/>
   <div className="flex flex-wrap gap-1"><button type="button" className={`${button} bg-[var(--accent-light)] text-[var(--primary)]`} disabled={busy||uncertain||!content.title.trim()||editing.revision!==null&&!dirty} onClick={()=>void mutate('save')}>Save template</button>
    {editing.revision!==null&&<button type="button" className={button} disabled={busy||dirty||uncertain} onClick={()=>setArchivePrompt(true)}>Archive template</button>}
    <button type="button" className={button} disabled={busy} onClick={discard}>{dirty||uncertain?'Reload templates and discard these edits':'Close editor'}</button>
    {uncertain&&<button type="button" className={button} disabled={busy} onClick={()=>void check()}>Check saved template</button>}</div>
   {archivePrompt&&<div className="space-y-2"><p className="text-xs">Archive this template? It will no longer appear for insertion. Existing drafts are kept.</p><button className={button} disabled={busy} onClick={()=>void mutate('archive')}>Confirm archive</button><button className={button} onClick={()=>setArchivePrompt(false)}>Keep template</button></div>}
  </div>}
  {collection.notice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{collection.notice}</p>}
 </div>;
}
export function NativeTemplateInsertionReview({current,text,mode,onMode,onInsert,disabled}:{current:NativeDraftContent;text:NativeTemplateText;mode:'append'|'replace';onMode:(mode:'append'|'replace')=>void;onInsert:()=>void;disabled:boolean}){
 let preview:NativeDraftContent|null=null,error='';try{preview=insertNativeTemplate(current,text,mode);}catch(value){error=value instanceof Error?value.message:'This template cannot be inserted.';}
 const existing=!!(current.subject||current.body||current.body_html);
 return <div className="space-y-3">{existing&&<div className="flex flex-wrap gap-2"><label className="flex items-center gap-2 text-xs"><input type="radio" name="template-insertion-mode" checked={mode==='append'} onChange={()=>onMode('append')}/>Append and keep current subject</label><label className="flex items-center gap-2 text-xs"><input type="radio" name="template-insertion-mode" checked={mode==='replace'} onChange={()=>onMode('replace')}/>Replace subject and body</label></div>}
  {mode==='replace'&&existing&&<p className="text-xs text-[var(--text-secondary)]">Replacing removes the current subject and message text, including any signature typed into it. Review the preview first.</p>}
  {preview&&<div aria-label="Template insertion preview" className="max-h-64 space-y-2 overflow-auto rounded-lg bg-[var(--surface-container-low)] p-3 text-sm"><p className="font-medium">{preview.subject||'(No subject)'}</p><p className="whitespace-pre-wrap break-words">{preview.body}</p></div>}
  {error&&<p role="status" className="text-xs text-[var(--text-secondary)]">{error}</p>}
  <p className="text-xs text-[var(--muted)]">From, recipients, reply context and attachments stay with your draft.</p>
  <button type="button" className={`${button} bg-[var(--accent-light)] text-[var(--primary)]`} disabled={disabled||!preview} onClick={onInsert}>{mode==='replace'&&existing?'Replace with reviewed template':'Insert template'}</button>
 </div>;
}
export function NativeEmailTemplatePicker({accountId,sessionScope,current,disabled,onInsert,onClose}:{accountId:string;sessionScope:string;current:NativeDraftContent;disabled:boolean;onInsert:(text:NativeTemplateText,mode:'append'|'replace')=>void;onClose:()=>void}){
 const collection=useTemplateCollection(accountId,sessionScope),[selected,setSelected]=useState<NativeEmailTemplate|null>(null),[values,setValues]=useState<Record<string,string>>({}),[mode,setMode]=useState<'append'|'replace'>('append'),[busy,setBusy]=useState(false),lock=useRef(false);
 const choose=async(row:NativeEmailTemplate)=>{const owned=collection.client.current;if(!owned||lock.current||!collection.current())return;lock.current=true;setBusy(true);
  try{const fresh=await owned.read(accountId,row.template_id);if(collection.current()){setSelected(fresh);setValues({});setMode('append');collection.setNotice('');}}
  catch(error){if(collection.current()){setSelected(null);setValues({});if(error instanceof NativeTemplateError&&error.kind==='denied'){collection.deny();lock.current=false;setBusy(false);}else collection.setNotice(error instanceof Error?error.message:'Template could not be opened.');}}
  finally{if(collection.current()){lock.current=false;setBusy(false);}}
 };
 let rendered:ReturnType<typeof renderNativeTemplate>|null=null,renderError='';if(selected){try{rendered=renderNativeTemplate(selected.content,values);}catch(error){renderError=error instanceof Error?error.message:'Check the placeholder values.';}}
 return <section aria-label="Insert email template" className="space-y-3 rounded-xl bg-[var(--surface-container-low)] p-4"><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">Insert template</h3><button type="button" className={button} onClick={onClose}>Close</button></div>
  {!selected?<><p className="text-xs text-[var(--muted)]">Templates for the current sending account. Manage them in Email settings.</p>{collection.rows.map(row=><button key={row.template_id} type="button" className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50" disabled={disabled||busy} onClick={()=>void choose(row)}>{row.content.title}</button>)}
   {collection.loading&&<p role="status" className="text-xs">Loading templates…</p>}{!collection.loading&&!collection.rows.length&&<p className="text-xs text-[var(--muted)]">No templates have been loaded for this account.</p>}{collection.cursor&&<button className={button} disabled={busy||collection.loading||collection.rows.length>=100} onClick={()=>void collection.more()}>More templates</button>}{collection.cursor&&collection.rows.length>=100&&<p className="text-xs text-[var(--muted)]">100 templates are loaded. Additional templates have not been loaded.</p>}</>:<>
   <div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">{selected.content.title}</p><button className={button} onClick={()=>setSelected(null)}>Choose another template</button></div>
   {nativeTemplatePlaceholders(selected.content).map(name=><label key={name} className="block space-y-1 text-xs"><span>{'{{'+name+'}}'}</span><input aria-label={'Value for '+name} className={input} maxLength={8192} value={values[name]??''} disabled={disabled||busy} onChange={event=>setValues(previous=>({...previous,[name]:event.target.value}))}/></label>)}
   {renderError&&<p role="status" className="text-xs text-[var(--text-secondary)]">{renderError}</p>}
   {rendered&&<><NativeTemplateInsertionReview current={current} text={rendered} mode={mode} onMode={setMode} disabled={disabled||busy||rendered.unresolved_placeholders.length>0} onInsert={()=>{if(collection.current()&&!disabled&&rendered&&!rendered.unresolved_placeholders.length)onInsert(rendered,mode);}}/>
    {rendered.unresolved_placeholders.length>0&&<p role="status" className="text-xs text-[var(--text-secondary)]">Fill in {rendered.unresolved_placeholders.map(name=>'{{'+name+'}}').join(', ')} before inserting.</p>}</>}
  </>}{collection.notice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{collection.notice}</p>}
 </section>;
}
