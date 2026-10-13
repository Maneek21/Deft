'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {createNativeSignatureSettings,emptyNativeSignatureState,type NativeSignatureEntry,type NativeSignatureState} from '@/lib/email-native-signatures';
import {ExperienceComposeRichEditor} from '@/components/apps/experience-compose-controls-rich-editor';

const button='rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
const placements={new:'New messages',reply:'Replies',both:'New messages and replies',none:'Do not insert automatically'};
const normalize=(address:string)=>address.trim().toLocaleLowerCase('en-US');
export function NativeSignaturePreferencesView({state,primaryAddress,onSelect,onEdit,onSave,onReload,onCheck}:{state:NativeSignatureState;primaryAddress:string;onSelect:(address:string)=>void;onEdit:(entry:NativeSignatureEntry)=>void;onSave:()=>void;onReload:()=>void;onCheck:()=>void}){
 const id=useId(),entry=state.entry,disabled=state.busy||state.uncertain||state.conflict||state.status!=='ready';
 const retained=state.saved?.preferences.identities.filter(item=>!entry||normalize(item.address)!==normalize(entry.address))??[];
 const additional=state.saved?.identity_availability.available?.filter(item=>normalize(item.address)!==normalize(entry?.address??primaryAddress)&&!retained.some(saved=>normalize(saved.address)===normalize(item.address)))??[];
 return <div className="space-y-3 rounded-xl bg-[var(--surface-container-low)] p-3">
  {!!state.saved?.identity_availability.available?.length&&<label className="block space-y-1 text-xs"><span>Sender address</span><select aria-label="Signature sender address" value={state.saved.identity_availability.available.find(item=>normalize(item.address)===normalize(entry?.address??''))?.address??''} disabled={disabled||state.dirty} onChange={event=>onSelect(event.target.value)} className="w-full rounded-lg bg-[var(--surface)] px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">{!entry&&<option value="" disabled>Choose a verified sender</option>}{state.saved.identity_availability.available.map(item=><option key={item.identity_key} value={item.address}>{item.address}</option>)}</select></label>}
  {entry?<><p className="text-xs text-[var(--text-secondary)]">Signature for <span className="font-medium">{entry.address}</span></p>
   <ExperienceComposeRichEditor nativeLinks label="Signature text" value={{html:entry.html,plainText:entry.plain}} maxCharacters={16384} maxPlainCharacters={2048} disabled={disabled} onChange={value=>onEdit({...entry,plain:value.plainText,html:value.html})}/>
   <label htmlFor={id+'-placement'} className="block space-y-1 text-xs"><span>Insertion preference</span><select id={id+'-placement'} aria-label="Signature insertion preference" value={entry.placement} disabled={disabled} onChange={event=>onEdit({...entry,placement:event.target.value as NativeSignatureEntry['placement']})} className="w-full rounded-lg bg-[var(--surface)] px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">{Object.entries(placements).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   <p className="text-xs leading-5 text-[var(--muted)]">Matching signatures are added to new untouched drafts. Existing drafts stay unchanged. You can insert a saved signature from More in Compose.</p>
  </>:state.status==='ready'&&<p className="text-xs leading-5 text-[var(--text-secondary)]">The primary sender address could not be verified. Choose a verified sender above, or reconnect this account. Saved signatures are kept.</p>}
  {retained.map(item=>{const current=state.saved!.identity_availability.saved.find(value=>normalize(value.address)===normalize(item.address))?.current;return <div key={item.address} className="space-y-1 rounded-lg px-2 py-2 text-xs"><p className="font-medium">{item.address}</p><p className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">{item.plain||'No signature text saved.'}</p><p className="text-[var(--muted)]">{placements[item.placement]} · {current?'Saved for another sender address.':'This sender is currently unavailable. Its saved signature is kept.'}</p></div>;})}
  {additional.map(item=><p key={item.identity_key} className="text-xs text-[var(--muted)]">{item.address} · No signature saved for this sender.</p>)}
  <div className="flex flex-wrap gap-1"><button type="button" className={`${button} bg-[var(--accent-light)] text-[var(--primary)]`} disabled={disabled||!entry||!state.dirty} onClick={onSave}>{state.busy?'Working…':'Save signature preferences'}</button><button type="button" className={button} disabled={state.busy||state.status==='denied'} onClick={onReload}>{state.dirty||state.uncertain||state.conflict?'Reload and discard signature edits':'Reload saved signatures'}</button>{state.uncertain&&<button type="button" className={button} disabled={state.busy} onClick={onCheck}>Check saved signature</button>}</div>
  {state.notice&&<p role="status" className="text-xs leading-5 text-[var(--text-secondary)]">{state.notice}</p>}
 </div>;
}
function NativeSignatureManager({accountId,primaryAddress,sessionScope}:{accountId:string;primaryAddress:string;sessionScope:string}){
 const scope=JSON.stringify([accountId,primaryAddress,sessionScope]),[snapshot,setSnapshot]=useState<{scope:string;value:NativeSignatureState}|null>(null),client=useRef<ReturnType<typeof createNativeSignatureSettings>|null>(null);
 useEffect(()=>{const anchor=api.getAccessToken();let active=true;const current=()=>active&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());
  const owned=createNativeSignatureSettings({accountId,primaryAddress,fetch:(path,options)=>api.fetch(path,options),current,change:value=>{if(current())setSnapshot({scope,value});}});client.current=owned;void owned.load();
  return()=>{active=false;owned.dispose();if(client.current===owned)client.current=null;};
 },[accountId,primaryAddress,sessionScope,scope]);
 return <NativeSignaturePreferencesView primaryAddress={primaryAddress} state={snapshot?.scope===scope?snapshot.value:emptyNativeSignatureState()} onSelect={address=>client.current?.select(address)} onEdit={entry=>client.current?.edit(entry)} onSave={()=>void client.current?.save()} onReload={()=>void client.current?.load(true)} onCheck={()=>void client.current?.check()}/>;
}
export function NativeEmailSignatures({accountId,primaryAddress,sessionScope}:{accountId:string;primaryAddress:string;sessionScope:string}){
 const [open,setOpen]=useState(false);
 return <section className="space-y-3 pt-5"><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-medium">Signatures</h4><button type="button" className={button} aria-expanded={open} onClick={()=>setOpen(true)} disabled={open}>{open?'Signature preferences':'Manage signatures'}</button></div>
  <p className="text-xs leading-5 text-[var(--text-secondary)]">Save signature text and an insertion preference for each verified sender address.</p>
  {open&&<NativeSignatureManager key={JSON.stringify([accountId,primaryAddress,sessionScope])} accountId={accountId} primaryAddress={primaryAddress} sessionScope={sessionScope}/>}
 </section>;
}
