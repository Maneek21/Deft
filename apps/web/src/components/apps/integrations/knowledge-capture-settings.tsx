'use client';
import {useEffect,useState} from 'react';
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
 const [settings,setSettings]=useState<Settings>(),[policy,setPolicy]=useState<AppIntegrationCapturePolicyInput>(),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false);
 const request=async(name:'settings'|'write',value:unknown)=>{signal.throwIfAborted();if(!current())throw Error();const raw=await boundedConfirmationJson(await api.fetch('/api/app-integrations/knowledge/'+name,{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}));signal.throwIfAborted();if(!current())throw Error();return raw;};
 const load=async()=>{const value=parseSettings(await request('settings',{source}));setSettings(value);setPolicy(value.policy);setUncertain(false);};
 useEffect(()=>{let active=true;void load().catch(()=>{if(active&&current()&&!signal.aborted)setNotice('Knowledge settings are unavailable.');});return()=>{active=false;};},[source,current,signal]);
 const save=async()=>{if(!policy||busy||uncertain||!current())return;setBusy(true);setNotice('');try{await request('write',{source,policy:AppIntegrationCapturePolicyInputSchema.parse(policy)});await load();if(current())setNotice('Knowledge settings saved.');}catch{if(current()){setUncertain(true);setNotice('Settings could not be confirmed. Check settings before saving again.');}}finally{if(current())setBusy(false);}};
 const refresh=async()=>{if(busy||!current())return;setBusy(true);setNotice('');try{await load();}catch{if(current())setNotice('Knowledge settings are unavailable.');}finally{if(current())setBusy(false);}};
 const disabled=busy||uncertain||!policy||!current();
 return <section className="space-y-3 rounded-xl bg-[var(--surface-container-low)] p-4 text-sm" aria-label="Automatic Knowledge settings">
  <h3 className="font-medium">Automatic Knowledge</h3>
  <p className="text-xs text-[var(--muted)]">Starts off. When enabled, eligible observed message bodies may create or update Knowledge. Attachments are not processed; coverage may be partial.</p>
  <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={policy?.enabled??false} disabled={disabled} onChange={event=>setPolicy(value=>value?{...value,enabled:event.target.checked}:value)}/>Capture Knowledge from this account</label>
  {policy&&<>
   <label className="block text-xs">Destination<select className="mt-1 block min-h-11 max-w-full rounded-lg bg-[var(--surface)] px-3 text-sm" value={policy.destination.space_id??''} disabled={disabled} onChange={event=>setPolicy(value=>value?{...value,destination:event.target.value?{scope:'space',space_id:event.target.value}:{scope:'user',space_id:null}}:value)}><option value="">Private Knowledge</option>{spaces.map(space=><option key={space.id} value={space.id}>{space.name}</option>)}</select></label>
   <label className="flex min-h-11 items-center gap-2 text-xs">History window<input className="w-20 rounded-lg bg-[var(--surface)] px-3 py-2" type="number" min={1} max={365} value={policy.history_days} disabled={disabled} onChange={event=>setPolicy(value=>value?{...value,history_days:Number(event.target.value)}:value)}/>days</label>
   <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={policy.include_bulk} disabled={disabled} onChange={event=>setPolicy(value=>value?{...value,include_bulk:event.target.checked}:value)}/>Include bulk messages</label>
   <label className="block text-xs">Excluded senders, one per line<textarea className="mt-1 block min-h-20 w-full rounded-lg bg-[var(--surface)] p-3" maxLength={16050} disabled={disabled} value={policy.excluded_senders.join('\n')} onChange={event=>setPolicy(value=>value?{...value,excluded_senders:event.target.value.split('\n').filter(Boolean)}:value)}/></label>
   <label className="block text-xs">Excluded folders, one per line<textarea className="mt-1 block min-h-20 w-full rounded-lg bg-[var(--surface)] p-3" maxLength={12850} disabled={disabled} value={policy.excluded_folders.join('\n')} onChange={event=>setPolicy(value=>value?{...value,excluded_folders:event.target.value.split('\n').filter(Boolean)}:value)}/></label>
   <button type="button" className="deft-pill min-h-11" disabled={disabled} onClick={()=>void save()}>Save Knowledge settings</button>
  </>}
  {settings&&<p className="text-xs text-[var(--muted)]">{settings.progress.processed} processed · {settings.progress.captured} captured · {settings.progress.skipped} skipped · {settings.progress.failed} failed</p>}
  <button type="button" className="deft-pill min-h-11" disabled={busy||!current()} onClick={()=>void refresh()}>Check settings</button>
  {notice&&<p role="status" className="text-xs text-[var(--muted)]">{notice}</p>}
 </section>;
}
