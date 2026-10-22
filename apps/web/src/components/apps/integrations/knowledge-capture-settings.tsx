'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {api} from '@/lib/api';
import {boundedConfirmationJson} from '@/lib/app-experience-action-confirmation';
import {AppIntegrationCapturePolicyInputSchema,type AppIntegrationCapturePolicyInput,type AppIntegrationSourceIdentity} from '../../../../../../packages/app-kit/src/app-integration-source';
type Choice={id:string;name:string};
type Settings={policy:AppIntegrationCapturePolicyInput;progress:{processed:number;captured:number;skipped:number;failed:number}};
function parseSettings(raw:unknown):Settings{
 const row=raw as Record<string,unknown>;
 const policy=AppIntegrationCapturePolicyInputSchema.parse({enabled:row.enabled,destination:row.destination,history_days:row.history_days,include_bulk:row.include_bulk,excluded_senders:row.excluded_senders,excluded_folders:row.excluded_folders,expected_revision:row.revision});
 const progress=row.progress as Settings['progress'];if(!progress||['processed','captured','skipped','failed'].some(key=>!Number.isSafeInteger(progress[key as keyof typeof progress])||progress[key as keyof typeof progress]<0))throw Error();
 return {policy,progress};
}
/** Independent human opt-in. The exact displayed source nominates the account;
 * the service reconstructs current source and destination authority per write. */
export function KnowledgeCaptureSettings({source,spaces,current,signal}:{source:AppIntegrationSourceIdentity;spaces:readonly Choice[];current:()=>boolean;signal:AbortSignal}){
 const [settings,setSettings]=useState<Settings>(),[policy,setPolicy]=useState<AppIntegrationCapturePolicyInput>(),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[providerReady,setProviderReady]=useState<boolean>(),[problemsOpen,setProblemsOpen]=useState(false);
 const request=async(name:'settings'|'write',value:unknown)=>{signal.throwIfAborted();if(!current())throw Error();const raw=await boundedConfirmationJson(await api.fetch('/api/app-integrations/knowledge/'+name,{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}));signal.throwIfAborted();if(!current())throw Error();return raw;};
 const load=async()=>{const [raw,config]=await Promise.all([request('settings',{source}),api.fetch('/api/org/ai-config',{signal}).then(boundedConfirmationJson)]);if(!current()||signal.aborted)return;const value=parseSettings(raw);setSettings(value);setPolicy(value.policy);setProviderReady(typeof config==='object'&&config!==null&&'has_provider'in config&&config.has_provider===true);setUncertain(false);};
 useEffect(()=>{let active=true;void load().catch(()=>{if(active&&current()&&!signal.aborted)setNotice('Knowledge settings are unavailable.');});return()=>{active=false;};},[source,current,signal]);
 const save=async()=>{if(!policy||busy||uncertain||!current())return;setBusy(true);setNotice('');try{await request('write',{source,policy:AppIntegrationCapturePolicyInputSchema.parse(policy)});await load();if(current())setNotice('Knowledge settings saved.');}catch{if(current()){setUncertain(true);setNotice('Settings could not be confirmed. Check settings before saving again.');}}finally{if(current())setBusy(false);}};
 const refresh=async()=>{if(busy||!current())return;setBusy(true);setNotice('');try{await load();}catch{if(current())setNotice('Knowledge settings are unavailable.');}finally{if(current())setBusy(false);}};
 const disabled=busy||uncertain||!policy||!current();
 return <section className="space-y-4 text-sm" aria-label="Automatic Knowledge settings" aria-busy={busy||!settings&&!notice}>
  <div className="flex items-center justify-between gap-3"><h3 className="font-medium">Automatic Knowledge</h3>{settings&&<span className="text-xs text-[var(--muted)]">{providerReady===false?'Setup needed':settings.policy.enabled?'Enabled':'Off'}</span>}</div>
  <p className="text-sm leading-6 text-[var(--muted)]">Save useful decisions, commitments and reusable information from this account, with a link to the original message.</p>
  {!settings&&!notice&&<p role="status" className="text-xs text-[var(--muted)]">Loading capture settings…</p>}
  {providerReady===false&&<p role="status" className="text-sm leading-6 text-[var(--muted)]">Automatic capture needs a workspace AI provider. <Link href="/settings/ai" className="text-[var(--accent)] underline underline-offset-4">Configure AI</Link>, then check settings here. You can still save a message to Knowledge manually.</p>}
  <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={policy?.enabled??false} disabled={disabled} onChange={event=>setPolicy(value=>value?{...value,enabled:event.target.checked}:value)}/>Capture automatically</label>
  {policy&&<>
   <label className="block text-xs">Destination<select className="mt-1 block min-h-11 max-w-full rounded-lg bg-[var(--surface)] px-3 text-sm" value={policy.destination.space_id??''} disabled={disabled} onChange={event=>setPolicy(value=>value?{...value,destination:event.target.value?{scope:'space',space_id:event.target.value}:{scope:'user',space_id:null}}:value)}><option value="">Private Knowledge</option>{spaces.map(space=><option key={space.id} value={space.id}>{space.name}</option>)}</select></label>
   <details className="text-xs text-[var(--muted)]"><summary className="flex min-h-11 cursor-pointer items-center">Capture preferences</summary><div className="space-y-3 pt-2">
   <label className="flex min-h-11 items-center gap-2 text-xs">Include the past<input className="w-20 rounded-lg bg-[var(--surface-container-low)] px-3 py-2" type="number" min={1} max={365} value={policy.history_days} disabled={disabled} onChange={event=>setPolicy(value=>value?{...value,history_days:Number(event.target.value)}:value)}/>days</label>
   <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={policy.include_bulk} disabled={disabled} onChange={event=>setPolicy(value=>value?{...value,include_bulk:event.target.checked}:value)}/>Include bulk messages</label>
   <label className="block text-xs">Excluded senders, one per line<textarea className="mt-1 block min-h-20 w-full rounded-lg bg-[var(--surface)] p-3" maxLength={16050} disabled={disabled} value={policy.excluded_senders.join('\n')} onChange={event=>setPolicy(value=>value?{...value,excluded_senders:event.target.value.split('\n').filter(Boolean)}:value)}/></label>
   <label className="block text-xs">Excluded folders, one per line<textarea className="mt-1 block min-h-20 w-full rounded-lg bg-[var(--surface)] p-3" maxLength={12850} disabled={disabled} value={policy.excluded_folders.join('\n')} onChange={event=>setPolicy(value=>value?{...value,excluded_folders:event.target.value.split('\n').filter(Boolean)}:value)}/></label>
   </div></details>
   <p className="text-xs leading-5 text-[var(--muted)]">Uses synchronized message text. Attachment contents are not included. Capture continues in the background after you save.</p>
   <button type="button" className="deft-pill min-h-11" disabled={disabled||policy.enabled&&providerReady!==true||!AppIntegrationCapturePolicyInputSchema.safeParse(policy).success} onClick={()=>void save()}>{busy?'Saving…':'Save Knowledge settings'}</button>
  </>}
  {settings&&<p role="status" className="text-xs leading-5 text-[var(--muted)]">{settings.progress.processed?`${settings.progress.captured} captured · ${settings.progress.skipped} skipped${settings.progress.failed?` · ${settings.progress.failed} could not be saved`:''}`:providerReady===false?'Capture will wait until AI is configured.':settings.policy.enabled?'Waiting for eligible messages.':'Turn on capture and save to start.'}</p>}
  {!!settings?.progress.failed&&<div className="space-y-2">
   <button type="button" className="deft-pill min-h-11" aria-expanded={problemsOpen} onClick={()=>setProblemsOpen(value=>!value)}>Review capture problems ({settings.progress.failed})</button>
   {problemsOpen&&<section className="space-y-2 rounded-xl bg-[var(--surface-container-low)] p-3" aria-label="Capture problems"><h4 className="font-medium">Items could not be saved to Knowledge</h4><p className="text-xs leading-5">Check account access and the selected Knowledge destination, then check capture status. You can also save an item to Knowledge manually from its source.</p><Link href="/settings/apps/private-resources" className="inline-flex min-h-11 items-center underline">Review account access</Link><p className="text-xs">Destination: {settings.policy.destination.scope==='user'?'Private Knowledge':spaces.find(row=>row.id===settings.policy.destination.space_id)?.name??'Selected space'}</p></section>}
  </div>}
  <button type="button" className="deft-pill min-h-11" disabled={busy||!current()} onClick={()=>void refresh()}>Check capture status</button>
  {notice&&<p role="status" className="text-xs text-[var(--muted)]">{notice}</p>}
 </section>;
}
