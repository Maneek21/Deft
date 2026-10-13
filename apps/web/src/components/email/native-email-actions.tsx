'use client';
import {Archive,ArchiveRestore,FolderInput,Mail,MailOpen,MoreHorizontal,ShieldCheck,ShieldX,Star,Tags,Trash2} from 'lucide-react';
import type {NativeEmailMessage} from '@/lib/email-native-search';
import type {NativeTriageKind} from '@/lib/email-native-triage';
const icon='rounded-full p-2 hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40';
export function nativeEmailModificationNotice(accounts:readonly {account_id:string;capabilities?:readonly string[]}[],messages:readonly Pick<NativeEmailMessage,'account_id'>[]):string|undefined{
 return messages.some(message=>!accounts.find(account=>account.account_id===message.account_id)?.capabilities?.includes('modify'))?'Reconnect the selected account in Email settings to enable message actions.':undefined;
}
type RecoveryAccount={account_id:string;provider:string;capabilities?:readonly string[]};
export function nativeEmailRecoveryActions(accounts:readonly RecoveryAccount[],messages:readonly NativeEmailMessage[]):NativeTriageKind[]{
 if(!messages.length||messages.some(message=>{const account=accounts.find(row=>row.account_id===message.account_id);return !account||!['gmail','microsoft'].includes(account.provider)||!account.capabilities?.includes('modify');}))return [];
 if(messages.every(message=>message.folders.includes('trash')))return ['restore'];
 if(messages.every(message=>message.folders.includes('spam')&&!message.folders.includes('trash')))return ['not_spam'];
 return messages.every(message=>!message.folders.includes('spam')&&!message.folders.includes('trash'))?['spam']:[];
}
type Props={accounts?:readonly RecoveryAccount[];messages:readonly NativeEmailMessage[];busy:boolean;unavailableReason?:string;onAction:(kind:NativeTriageKind)=>void;onMove:()=>void;onLabels?:()=>void};
export function NativeEmailSecondaryActions({accounts=[],messages,busy,unavailableReason,onAction,onMove,onLabels}:Props){
 const disabled=busy||!!unavailableReason||!messages.length,multiple=new Set(messages.map(row=>row.account_id)).size>1;
 const recovery=nativeEmailRecoveryActions(accounts,messages)[0],allTrash=messages.length>0&&messages.every(message=>message.folders.includes('trash'));
 const recoveryName=recovery==='spam'?'Move to Spam':recovery==='not_spam'?'Not spam — move to Inbox':'Restore from Trash';
 const restoreHint=messages.every(message=>accounts.find(account=>account.account_id===message.account_id)?.provider==='microsoft')?'Move messages from Trash to Inbox.':'Remove messages from Trash. Gmail may restore them outside Inbox.';
 return <>{onLabels&&<button type="button" aria-label="Change Gmail labels" disabled={disabled||multiple} onClick={event=>{if(disabled||multiple)return;event.currentTarget.closest('details')?.removeAttribute('open');onLabels();}} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-[var(--hover-tint)] disabled:opacity-40"><Tags size={15} aria-hidden="true"/>Labels…</button>}<button type="button" aria-label="Move message to folder" disabled={disabled||multiple} onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');onMove();}} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-[var(--hover-tint)] disabled:opacity-40"><FolderInput size={15} aria-hidden="true"/>Move to…</button>
  {recovery&&<button type="button" aria-label={recoveryName} title={unavailableReason??(recovery==='restore'?restoreHint:recoveryName)} disabled={disabled} onClick={event=>{if(disabled||!nativeEmailRecoveryActions(accounts,messages).includes(recovery))return;event.currentTarget.closest('details')?.removeAttribute('open');onAction(recovery);}} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-[var(--hover-tint)] disabled:opacity-40">{recovery==='spam'?<ShieldX size={15} aria-hidden="true"/>:recovery==='not_spam'?<ShieldCheck size={15} aria-hidden="true"/>:<ArchiveRestore size={15} aria-hidden="true"/>}{recovery==='not_spam'?'Not spam':recoveryName}</button>}
  {!allTrash&&<button type="button" aria-label="Move message to Trash" disabled={disabled} onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');onAction('trash');}} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-[var(--hover-tint)] disabled:opacity-40"><Trash2 size={15} aria-hidden="true"/>Move to Trash</button>}
  {unavailableReason?<p className="px-3 py-2 text-xs text-[var(--muted)]">{unavailableReason}</p>:multiple&&<p className="px-3 py-2 text-xs text-[var(--muted)]">Choose messages from one account to move.</p>}</>;
}
export function NativeEmailActions({accounts,messages,busy,unavailableReason,onAction,onMove,onLabels,primaryOnly=false}:Props&{primaryOnly?:boolean}){
 const seen=messages.length>0&&messages.every(row=>row.flags.seen),starred=messages.length>0&&messages.every(row=>row.flags.flagged);
 const disabled=busy||!!unavailableReason||!messages.length;
 return <div role="group" aria-label={messages.length>1?'Selected message actions':'Message actions'} className="flex shrink-0 items-center justify-end gap-1">
  <button type="button" aria-label={seen?'Mark unread':'Mark read'} title={unavailableReason??(seen?'Mark unread':'Mark read')} disabled={disabled} onClick={()=>onAction(seen?'mark_unread':'mark_read')} className={icon}>{seen?<Mail size={17}/>:<MailOpen size={17}/>}</button>
  <button type="button" aria-label={starred?'Remove star':'Star'} title={unavailableReason??(starred?'Remove star':'Star')} disabled={disabled} aria-pressed={starred} onClick={()=>onAction(starred?'unstar':'star')} className={`${icon} ${starred?'text-[var(--primary)]':''}`}><Star size={17} fill={starred?'currentColor':'none'}/></button>
  <button type="button" aria-label="Archive" title={unavailableReason??'Archive'} disabled={disabled} onClick={()=>onAction('archive')} className={icon}><Archive size={17}/></button>
  {!primaryOnly&&<details className="relative"><summary aria-label="More message actions" title="More message actions" className={`${icon} list-none cursor-pointer [&::-webkit-details-marker]:hidden`}><MoreHorizontal size={17}/></summary>
   <div className="absolute right-0 z-20 mt-1 min-w-48 rounded-xl bg-[var(--surface-container-low)] p-2 shadow-lg" role="group" aria-label="More actions">
    <NativeEmailSecondaryActions accounts={accounts} messages={messages} busy={busy} unavailableReason={unavailableReason} onAction={onAction} onMove={onMove} onLabels={onLabels}/>
   </div>
  </details>}
 </div>;
}
