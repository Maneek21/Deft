'use client';
import {useEffect,useRef,useState} from 'react';
import {AppDialog} from '@/components/overlay-primitives';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import type {NativeMessageTarget} from '@/lib/email-native-message-links';
import {createNativeEmailInvitation,formatNativeInvitationTime,nativeInvitationCalendarUrl,nativeInvitationLimitation,nativeInvitationReceiptStatus,NativeInvitationError,type NativeInvitation,type NativeInvitationChoice,type NativeInvitationPreview,type NativeInvitationReceipt} from '@/lib/email-native-calendar-invitation';

const pill='rounded-full px-3 py-2 text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50';
type Props={target:NativeMessageTarget;sourceDigest:string;sessionScope:string};
export function NativeEmailCalendarInvitationAction(props:Props){
 const [open,setOpen]=useState(false);
 return <><button type="button" aria-label="Check calendar invitation" onClick={()=>setOpen(true)} className="rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)]">Calendar invitation</button>{open&&<NativeEmailCalendarInvitationDialog {...props} onClose={()=>setOpen(false)}/>}</>;
}
export function NativeEmailInvitationCard({invitation,sendResponse,recreateDeleted,allowRecreate,receipt,pending,disabled,actionsDisabled=false,onSendChange,onRecreateChange,onAction,onCheck}:{invitation:NativeInvitation;sendResponse:boolean;recreateDeleted:boolean;allowRecreate:boolean;receipt:NativeInvitationReceipt|null;pending:boolean;disabled:boolean;actionsDisabled?:boolean;onSendChange:(value:boolean)=>void;onRecreateChange:(value:boolean)=>void;onAction:(action:NativeInvitationChoice)=>void;onCheck:()=>void}){
 const status=receipt?nativeInvitationReceiptStatus(receipt):null,eligible=!!invitation.preview_token&&!invitation.limitations.length;
 return <section aria-label={invitation.summary||'Calendar invitation'} className="space-y-3 rounded-xl bg-[var(--surface-container-low)] p-4">
  <h3 className="break-words text-base font-medium">{invitation.summary||'Untitled invitation'}</h3>
  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
   <dt className="text-[var(--text-secondary)]">Organizer</dt><dd className="min-w-0 break-words">{invitation.organizer.name&&<span>{invitation.organizer.name} · </span>}{invitation.organizer.address}</dd>
   {invitation.receiving_attendee&&<><dt className="text-[var(--text-secondary)]">For</dt><dd className="min-w-0 break-words">{invitation.receiving_attendee}</dd></>}
   <dt className="text-[var(--text-secondary)]">Starts</dt><dd>{formatNativeInvitationTime(invitation.start)}</dd>
   <dt className="text-[var(--text-secondary)]">Ends</dt><dd>{formatNativeInvitationTime(invitation.end)}{invitation.end?.value_type==='date'&&' (exclusive)'}</dd>
   {invitation.recurrence_id&&<><dt className="text-[var(--text-secondary)]">Occurrence</dt><dd>{formatNativeInvitationTime(invitation.recurrence_id)}</dd></>}
   {invitation.location&&<><dt className="text-[var(--text-secondary)]">Where</dt><dd className="min-w-0 whitespace-pre-wrap break-words">{invitation.location}</dd></>}
  </dl>
  {invitation.recurring&&<p className="text-xs text-[var(--text-secondary)]">Recurring event</p>}
  {invitation.description&&<details><summary className="cursor-pointer text-sm">Details</summary><p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">{invitation.description}</p></details>}
  {status?<div role="status" className="space-y-1 text-sm"><p>{status.calendar}</p><p>{status.response}</p></div>:pending?<p role="status" className="text-sm">This action is not yet confirmed. Keep this tab open and check status; do not send another response.</p>:<>
   {invitation.limitations.length>0&&<div role="status" className="space-y-1 text-xs text-[var(--text-secondary)]">{[...new Set(invitation.limitations)].map(reason=><p key={reason}>{nativeInvitationLimitation(reason)}</p>)}</div>}
   {invitation.method==='REPLY'&&<p className="text-xs text-[var(--text-secondary)]">This is an invitation response. No Calendar action is available here.</p>}
   {invitation.method==='REQUEST'&&!invitation.rsvp_available&&!invitation.limitations.length&&<p className="text-xs text-[var(--text-secondary)]">This account is not a supported attendee for this invitation.</p>}
   {invitation.method==='REQUEST'&&eligible&&invitation.rsvp_available&&<>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={sendResponse} disabled={disabled||actionsDisabled} onChange={event=>onSendChange(event.target.checked)}/><span>Send response to organizer</span></label>
    {allowRecreate&&<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={recreateDeleted} disabled={disabled||actionsDisabled} onChange={event=>onRecreateChange(event.target.checked)}/><span>Recreate the event deleted from Calendar</span></label>}
    <div className="flex flex-wrap gap-1">{(['accepted','tentative','declined'] as const).map(response=>{const name={accepted:'Accept',tentative:'Tentative',declined:'Decline'}[response];return <button type="button" key={response} disabled={disabled||actionsDisabled} onClick={()=>onAction({kind:'rsvp',response,send_response:sendResponse})} className={pill+(response==='accepted'?' bg-[var(--accent-light)] text-[var(--primary)]':'')}>{name}{sendResponse?' & send response':' in Calendar'}</button>;})}</div>
   </>}
   {invitation.method==='CANCEL'&&eligible&&<><p className="text-sm">The organizer sent a cancellation.</p><button type="button" disabled={disabled||actionsDisabled} onClick={()=>onAction({kind:'apply_cancellation'})} className={pill}>Apply cancellation in Calendar</button></>}
  </>}
  {(pending||receipt&&receipt.response.state!=='not_requested')&&<button type="button" disabled={disabled} onClick={onCheck} className={pill}>Check response status</button>}
  {receipt&&<a href={nativeInvitationCalendarUrl(invitation)} className="inline-block rounded-full px-3 py-2 text-sm text-[var(--primary)] underline">Open Calendar</a>}
 </section>;
}
export function NativeEmailCalendarInvitationDialog({target,sourceDigest,sessionScope,onClose}:Props&{onClose:()=>void}){
 const {account_id:accountId,logical_message_id:logicalId}=target;
 const [preview,setPreview]=useState<NativeInvitationPreview|null>(null),[loading,setLoading]=useState(true),[reload,setReload]=useState(0),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState('');
 const [receipts,setReceipts]=useState<Record<string,NativeInvitationReceipt>>({}),[pending,setPending]=useState<Set<string>>(new Set()),[send,setSend]=useState<Record<string,boolean>>({}),[recreate,setRecreate]=useState<Record<string,boolean>>({}),[allowRecreate,setAllowRecreate]=useState<Set<string>>(new Set());
 const controller=useRef<ReturnType<typeof createNativeEmailInvitation>|null>(null);
 useEffect(()=>{let active=true;const anchor=api.getAccessToken(),current=()=>active&&getActiveSessionCacheScope()===sessionScope&&!!anchor&&isSameWebSession(anchor,api.getAccessToken());let storage:Storage|undefined;try{storage=sessionStorage;}catch{/* Tab-memory status recovery remains available. */}
  const value=createNativeEmailInvitation({target:{account_id:accountId,logical_message_id:logicalId},sourceDigest,sessionScope,current,storage,fetch:(path,init)=>api.fetch(path,init)});controller.current=value;
  void value.load().then(async result=>{if(!current())return;setPreview(result);const pointers=result.invitations.filter(item=>value.pending(item.invitation_id));setPending(new Set(pointers.map(item=>item.invitation_id)));setLoading(false);
   await Promise.allSettled(pointers.slice(0,2).map(async item=>{try{const receipt=await value.read(item.invitation_id);if(current()&&receipt)setReceipts(previous=>({...previous,[item.invitation_id]:receipt}));}catch(reason){if(current()&&reason instanceof NativeInvitationError&&[401,403].includes(reason.status)){setPreview(null);setReceipts({});setError('Email access changed.');}}}));
  }).catch(reason=>{if(current()){setPreview(null);setError(reason instanceof NativeInvitationError&&!([401,403].includes(reason.status))?'Invitation preview is unavailable. Try Refresh preview.':reason instanceof Error?reason.message:'Invitation could not be loaded.');}}).finally(()=>{if(current())setLoading(false);});
  return()=>{active=false;value.dispose();if(controller.current===value)controller.current=null;};
 },[accountId,logicalId,sourceDigest,sessionScope,reload]);
 const act=async(item:NativeInvitation,choice:NativeInvitationChoice)=>{const owned=controller.current;if(!owned||busy)return;const current=()=>controller.current===owned&&getActiveSessionCacheScope()===sessionScope;setBusy(item.invitation_id);setError('');
  try{const result=await owned.apply(item.invitation_id,choice,recreate[item.invitation_id]??false);if(current()){setReceipts(previous=>({...previous,[item.invitation_id]:result.receipt}));setPending(previous=>new Set(previous).add(item.invitation_id));}}
  catch(reason){if(current()){if(owned.pending(item.invitation_id))setPending(previous=>new Set(previous).add(item.invitation_id));if(reason instanceof NativeInvitationError&&reason.code==='EMAIL_INVITATION_CALENDAR_DELETED')setAllowRecreate(previous=>new Set(previous).add(item.invitation_id));setError(reason instanceof Error?reason.message:'The action could not be confirmed. Check status.');}}
  finally{if(current())setBusy(null);}
 };
 const check=async(item:NativeInvitation)=>{const owned=controller.current;if(!owned||busy)return;const current=()=>controller.current===owned&&getActiveSessionCacheScope()===sessionScope;setBusy(item.invitation_id);setError('');try{const receipt=await owned.read(item.invitation_id);if(current()){if(receipt)setReceipts(previous=>({...previous,[item.invitation_id]:receipt}));else setError('No result is confirmed yet. Keep this request and check again.');}}catch(reason){if(current()){if(reason instanceof NativeInvitationError&&[401,403].includes(reason.status)){setPreview(null);setReceipts({});}setError(reason instanceof Error?reason.message:'Response status could not be checked.');}}finally{if(current())setBusy(null);}};
 if(getActiveSessionCacheScope()!==sessionScope)return null;
 const unresolved=[...pending].some(id=>!receipts[id]);
 return <AppDialog open title="Calendar invitation" description="Review the invitation before responding." width={580} onClose={()=>{if(!busy)onClose();}} footer={<div className="flex justify-end gap-2"><button type="button" disabled={!!busy||loading} onClick={()=>{setLoading(true);setError('');setReload(value=>value+1);}} className={pill}>Refresh preview</button><button type="button" disabled={!!busy} onClick={onClose} className={pill}>Close</button></div>}>
  <div className="space-y-4">{loading&&<p role="status" className="text-sm">Loading invitation…</p>}{error&&<p role="alert" className="text-sm">{error}</p>}
   {preview&&<><p className="text-xs text-[var(--text-secondary)]">Calendar changes are saved to your Deft personal calendar. Organizer details come from this email.</p>
    {preview.status==='unsupported'&&<p role="status" className="text-sm">{nativeInvitationLimitation(preview.reason??'unsupported')}</p>}
    {preview.status==='available'&&!preview.invitations.length&&<p role="status" className="text-sm">{preview.parts.length?'This invitation could not be read safely.':'No calendar invitation was found in this message.'}</p>}
    {preview.parts.filter(part=>part.status!=='parsed').map(part=><p key={part.part_ref} role="status" className="text-xs text-[var(--text-secondary)]">{nativeInvitationLimitation(part.reason??'unsupported')}</p>)}
    {preview.invitations.map(item=><NativeEmailInvitationCard key={item.invitation_id} invitation={item} sendResponse={send[item.invitation_id]??true} recreateDeleted={recreate[item.invitation_id]??false} allowRecreate={allowRecreate.has(item.invitation_id)} receipt={receipts[item.invitation_id]??null} pending={pending.has(item.invitation_id)&&!receipts[item.invitation_id]} disabled={loading||!!busy} actionsDisabled={unresolved} onSendChange={value=>setSend(previous=>({...previous,[item.invitation_id]:value}))} onRecreateChange={value=>setRecreate(previous=>({...previous,[item.invitation_id]:value}))} onAction={choice=>{if(!unresolved)void act(item,choice);}} onCheck={()=>void check(item)}/>)}
   </>}
  </div>
 </AppDialog>;
}
