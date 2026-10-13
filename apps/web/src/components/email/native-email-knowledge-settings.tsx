'use client';
import {useEffect,useState,type ReactNode} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {parseEmailTransferSpaces} from '@/lib/email-native-context-transfer';
import {parseEmailKnowledgeSettings,type EmailKnowledgePolicy,type EmailKnowledgeSettings} from '@/lib/email-native-connected';
import {useEmailConnectedResource} from './use-email-connected-resource';
import {NativeEmailKnowledgeFolders} from './native-email-knowledge-folders';

const pill='rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
const control='min-h-10 w-full rounded-lg bg-[var(--surface)] px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
const defaults:EmailKnowledgePolicy={enabled:false,destination:{scope:'user',space_id:null},history_days:30,include_bulk:false,excluded_senders:[],excluded_folders:[]};
export function NativeEmailKnowledgeSettings({accountId,sessionScope}:{accountId:string;sessionScope:string}) {
  const resource=useEmailConnectedResource(accountId,sessionScope,'/knowledge-settings',parseEmailKnowledgeSettings);
  const [choice,setChoice]=useState<EmailKnowledgePolicy>(defaults),[spaces,setSpaces]=useState<{id:string;name:string}[]>([]),[spaceNotice,setSpaceNotice]=useState(''),[spaceAttempt,setSpaceAttempt]=useState(0);
  useEffect(()=>{if(resource.value)setChoice(policyOnly(resource.value));},[resource.value]);
  useEffect(()=>{
    if(choice.destination.scope!=='space')return;
    const abort=new AbortController(),anchor=api.getAccessToken();let active=true;
    const current=()=>active&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());
    void api.fetch('/api/spaces',{cache:'no-store',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(8000)])}).then(async response=>{if(!response.ok)throw Error();const rows=parseEmailTransferSpaces(await response.json());if(current()){setSpaces(rows);setSpaceNotice('');}}).catch(()=>{if(current()&&!abort.signal.aborted)setSpaceNotice('Spaces could not be loaded. Reload to choose a destination.');});
    return()=>{active=false;abort.abort();};
  },[choice.destination.scope,sessionScope,spaceAttempt]);
  if(!resource.current)return null;
  return <NativeEmailKnowledgeSettingsView saved={resource.value} choice={choice} spaces={spaces} busy={resource.busy} uncertain={resource.uncertain} notice={resource.notice} spaceNotice={spaceNotice} folderChoices={<NativeEmailKnowledgeFolders accountId={accountId} sessionScope={sessionScope} excluded={choice.excluded_folders} disabled={!resource.value||resource.busy||resource.uncertain} onChange={excluded_folders=>setChoice({...choice,excluded_folders})}/>} onChange={setChoice} onSave={()=>void resource.save({...normalized(choice),expected_revision:resource.value?.revision})} onPause={()=>{if(resource.value)void resource.save({...policyOnly(resource.value),enabled:!resource.value.enabled,expected_revision:resource.value.revision});}} onReload={resource.reload} onReloadSpaces={()=>setSpaceAttempt(value=>value+1)}/>;
}
function normalized(value:EmailKnowledgePolicy):EmailKnowledgePolicy {
  return {...value,excluded_senders:value.excluded_senders.map(item=>item.trim()).filter(Boolean),excluded_folders:value.excluded_folders.map(item=>item.trim()).filter(Boolean)};
}
function policyOnly(value:EmailKnowledgeSettings):EmailKnowledgePolicy {
  return {enabled:value.enabled,destination:value.destination,history_days:value.history_days,include_bulk:value.include_bulk,excluded_senders:value.excluded_senders,excluded_folders:value.excluded_folders};
}
export function NativeEmailKnowledgeSettingsView({saved,choice,spaces,busy,uncertain,notice,spaceNotice,folderChoices,onChange,onSave,onPause,onReload,onReloadSpaces}:{saved:EmailKnowledgeSettings|null;choice:EmailKnowledgePolicy;spaces:{id:string;name:string}[];busy:boolean;uncertain:boolean;notice:string;spaceNotice:string;folderChoices?:ReactNode;onChange:(value:EmailKnowledgePolicy)=>void;onSave:()=>void;onPause:()=>void;onReload:()=>void;onReloadSpaces:()=>void}) {
  const exclusions=normalized(choice),locked=!saved||busy||uncertain,valid=Number.isInteger(choice.history_days)&&choice.history_days>=1&&choice.history_days<=365&&exclusions.excluded_senders.length<=50&&exclusions.excluded_senders.every(sender=>sender.length<=320)&&exclusions.excluded_folders.length<=50&&(choice.destination.scope==='user'||spaces.some(space=>space.id===choice.destination.space_id));
  const dirty=saved&&JSON.stringify(policyOnly(saved))!==JSON.stringify(normalized(choice));
  return <section aria-label="Automatic email knowledge" className="space-y-3 pt-5 text-sm">
    <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium">Automatic Knowledge</h4>{saved&&<span className="rounded-full bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-secondary)]">{saved.enabled?'On':saved.revision===0?'Off':'Paused'}</span>}</div>
    <p className="text-xs leading-5 text-[var(--text-secondary)]">Keep useful decisions, commitments and facts from this account in Knowledge. Enable once; new eligible mail is captured automatically.</p>
    <label className="flex items-center gap-2"><input type="checkbox" checked={choice.enabled} disabled={locked} onChange={event=>onChange({...choice,enabled:event.target.checked})}/>Learn from this account</label>
    <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1"><span className="text-xs">Save to</span><select aria-label="Email Knowledge destination" className={control} disabled={locked} value={choice.destination.scope} onChange={event=>onChange({...choice,destination:event.target.value==='user'?{scope:'user',space_id:null}:{scope:'space',space_id:''}})}><option value="user">Personal Knowledge</option><option value="space">A selected space</option></select></label><label className="space-y-1"><span className="text-xs">Include recent history (days)</span><input type="number" min={1} max={365} aria-label="Email knowledge history days" className={control} value={choice.history_days} disabled={locked} onChange={event=>onChange({...choice,history_days:Number(event.target.value)})}/></label></div>
    {choice.destination.scope==='space'&&<label className="block space-y-1"><span className="text-xs">Space</span><select aria-label="Email Knowledge space" className={control} disabled={locked||!!spaceNotice} value={choice.destination.space_id??''} onChange={event=>onChange({...choice,destination:{scope:'space',space_id:event.target.value}})}><option value="">Choose a space</option>{spaces.map(space=><option key={space.id} value={space.id}>{space.name}</option>)}</select><span className="block text-xs text-[var(--text-secondary)]">Captured knowledge is visible to members of this space.</span>{spaceNotice&&<span className="block text-xs" role="status">{spaceNotice}<button type="button" onClick={onReloadSpaces} className={pill}>Reload spaces</button></span>}</label>}
    <details><summary className="cursor-pointer text-xs text-[var(--text-secondary)]">Capture preferences</summary><div className="space-y-3 pt-3"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={choice.include_bulk} disabled={locked} onChange={event=>onChange({...choice,include_bulk:event.target.checked})}/>Include useful subscribed or bulk mail</label><label className="block space-y-1"><span className="text-xs">Skip senders (one address per line)</span><textarea aria-label="Excluded email senders" rows={2} className={control} disabled={locked} value={choice.excluded_senders.join('\n')} onChange={event=>onChange({...choice,excluded_senders:event.target.value.split('\n')})}/></label>{folderChoices}</div></details>
    <div className="flex flex-wrap items-center gap-2"><button type="button" className={pill+' bg-[var(--accent-light)] text-[var(--primary)]'} disabled={locked||!dirty||!valid} onClick={onSave}>{busy?'Saving…':'Save capture settings'}</button>{saved&&<button type="button" className={pill} disabled={locked} onClick={onPause}>{saved.enabled?'Pause learning':saved.revision===0?'Enable learning':'Resume learning'}</button>}<button type="button" className={pill} disabled={busy} onClick={onReload}>Reload saved settings</button></div>
    {saved&&<p className="text-xs text-[var(--text-secondary)]" role="status">{saved.progress.processed} processed · {saved.progress.captured} captured · {saved.progress.skipped} skipped{saved.progress.last_error_code?' · '+emailCaptureRecovery(saved.progress.last_error_code):''}</p>}
    {notice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{notice}</p>}
  </section>;
}

export function emailCaptureRecovery(code:string):string {
  if(/budget|limit/i.test(code))return 'Capture budget reached. New mail will continue when the budget resets.';
  if(/key|provider|model|llm/i.test(code))return 'Capture needs an AI provider. Configure one in Settings, then reload progress.';
  if(/authority|denied|access|connection/i.test(code))return 'Account access changed. Check the connection in Email settings.';
  return 'Capture is waiting to retry. Reload progress to check again.';
}
