import {nativeMessageUrl,type NativeMessageTarget} from './email-native-message-links';

export type NativeInvitationTime={value:string;value_type:'date'|'date_time';time_zone:string|null;instant:string|null};
export type NativeInvitation={invitation_id:string;part_ref:string;method:'REQUEST'|'REPLY'|'CANCEL';sequence:number;dtstamp:string;summary:string;description:string;location:string;organizer:{address:string;name:string};organizer_trust:'unverified_mail_data';receiving_attendee:string|null;start:NativeInvitationTime|null;end:NativeInvitationTime|null;recurrence_id:NativeInvitationTime|null;recurring:boolean;limitations:string[];rsvp_available:boolean;preview_token:string|null};
export type NativeInvitationPreview={schema_version:'deft.email_invitation_preview.v1';account_id:string;logical_message_id:string;source_digest:string;destination:{id:'deft_personal';label:'Deft personal calendar';visibility:'owner_in_current_organization';external_notifications:false};status:'available'|'unsupported';reason?:string;parts:{part_ref:string;status:'parsed'|'unsupported'|'malformed';reason?:string}[];invitations:NativeInvitation[]};
export type NativeInvitationReceipt={schema_version:'deft.email_invitation_receipt.v1';account_id:string;request_id:string;invitation_id:string;revision:number;calendar:{state:'applied'|'cancelled'|'declined';event_id:string|null};response:{state:'not_requested'|'queued'|'paused'|'submitting'|'accepted'|'uncertain'|'cancelled';outbox_id:string|null;delivery_status:'unknown'}};
export type NativeInvitationChoice={kind:'rsvp';response:'accepted'|'tentative'|'declined';send_response:boolean}|{kind:'apply_cancellation'};
type Pointer={request_id:string;invitation_id:string};
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const memory=new Map<string,Pointer>();
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!v.includes('\0');
const id=(v:unknown):v is string=>text(v,256)&&!!v&&v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const fail=():never=>{throw Error('Invitation details could not be confirmed.');};
const object=(v:unknown,keys:string[]):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(key=>!keys.includes(key)))return fail();return v as Record<string,unknown>;};
const instant=(v:unknown):v is string=>text(v,32)&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(v)&&Number.isFinite(Date.parse(v));
function parseTime(raw:unknown):NativeInvitationTime|null{
 if(raw===null)return null;const row=object(raw,['value','value_type','time_zone','instant']);
 if(!text(row.value,32)||!['date','date_time'].includes(String(row.value_type))||row.time_zone!==null&&!text(row.time_zone,128))return fail();
 const dateOnly=row.value_type==='date';if(!(dateOnly?/^\d{8}$/u:/^\d{8}T\d{6}Z?$/u).test(row.value)||dateOnly&&(row.instant!==null||row.time_zone!==null)||!dateOnly&&!instant(row.instant))return fail();
 const y=Number(row.value.slice(0,4)),m=Number(row.value.slice(4,6)),d=Number(row.value.slice(6,8)),civil=new Date(Date.UTC(y,m-1,d));
 if(y<100||civil.getUTCFullYear()!==y||civil.getUTCMonth()!==m-1||civil.getUTCDate()!==d)return fail();
 if(!dateOnly&&(Number(row.value.slice(9,11))>23||Number(row.value.slice(11,13))>59||Number(row.value.slice(13,15))>59||row.value.endsWith('Z')&&row.time_zone!==null||!row.value.endsWith('Z')&&!row.time_zone))return fail();
 if(row.time_zone){try{new Intl.DateTimeFormat('en',{timeZone:row.time_zone as string}).format(new Date(0));}catch{return fail();}}
 return row as unknown as NativeInvitationTime;
}
export function formatNativeInvitationTime(time:NativeInvitationTime|null):string{
 if(!time)return 'Not provided';parseTime(time);const value=time.value,day=`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
 return time.value_type==='date'?`${day} · all day`:`${day} ${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)} · ${time.time_zone??'UTC'}`;
}
export function nativeInvitationCalendarUrl(invitation:NativeInvitation):string{
 if(!invitation.start)return '/calendar';parseTime(invitation.start);const value=invitation.start.value;return '/calendar?date='+`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
}
export function nativeInvitationLimitation(reason:string):string{
 if(reason==='INVITATION_IDENTITY_CONFLICT')return 'This email contains conflicting versions of the invitation. Check the original message.';
 const known:Record<string,string>={FLOATING_TIME_UNSUPPORTED:'The invitation has no supported time zone.',TIME_ZONE_UNSUPPORTED:'This invitation’s time zone is not supported.',calendar_end_required:'The invitation has no end time.',calendar_duration_unsupported:'This invitation’s duration is not supported.',calendar_recurrence_density_unsupported:'This recurrence is too frequent for Calendar.',calendar_recurrence_origin_unsupported:'This recurrence starts before the supported Calendar range.',organizer_delegation:'Delegated organizer invitations are not supported.',attendee_delegation_or_group:'Group or delegated attendee responses are not supported.',RECURRENCE_RANGE_UNSUPPORTED:'This recurrence change is not supported.'};
 return known[reason]??'This invitation detail is not supported here.';
}
export function nativeInvitationReceiptStatus(receipt:NativeInvitationReceipt):{calendar:string;response:string}{
 const calendar={applied:'Updated in Deft Calendar.',cancelled:'Cancelled in Deft Calendar.',declined:'Declined in Deft Calendar.'}[receipt.calendar.state];
 const response={not_requested:'No response was sent.',queued:'Response queued.',paused:'Response paused. Check sending status in Email Outbox.',submitting:'Sending response…',accepted:'Response accepted by the provider. Delivery is not confirmed.',uncertain:'Response status is uncertain. Check status; do not send again.',cancelled:'Response cancelled.'}[receipt.response.state];return {calendar,response};
}
export function parseNativeInvitationPreview(raw:unknown,target:NativeMessageTarget,sourceDigest:string):NativeInvitationPreview{
 const row=object(raw,['schema_version','account_id','logical_message_id','source_digest','destination','status','reason','parts','invitations']);
 if(row.schema_version!=='deft.email_invitation_preview.v1'||row.account_id!==target.account_id||row.logical_message_id!==target.logical_message_id||row.source_digest!==sourceDigest||!digest(sourceDigest)||!['available','unsupported'].includes(String(row.status))||row.reason!==undefined&&!text(row.reason,128)||!Array.isArray(row.parts)||row.parts.length>8||!Array.isArray(row.invitations)||row.invitations.length>32)return fail();
 const destination=object(row.destination,['id','label','visibility','external_notifications']);if(destination.id!=='deft_personal'||destination.label!=='Deft personal calendar'||destination.visibility!=='owner_in_current_organization'||destination.external_notifications!==false)return fail();
 const parts=new Map<string,string>();for(const rawPart of row.parts){const part=object(rawPart,['part_ref','status','reason']);if(!digest(part.part_ref)||parts.has(part.part_ref)||!['parsed','unsupported','malformed'].includes(String(part.status))||part.reason!==undefined&&!text(part.reason,128))return fail();parts.set(part.part_ref,String(part.status));}
 const seen=new Set<string>();for(const rawInvitation of row.invitations){
  const value=object(rawInvitation,['invitation_id','part_ref','method','sequence','dtstamp','summary','description','location','organizer','organizer_trust','receiving_attendee','start','end','recurrence_id','recurring','limitations','rsvp_available','preview_token']);
  const organizer=object(value.organizer,['address','name']);
  if(!digest(value.invitation_id)||seen.has(value.invitation_id)||!digest(value.part_ref)||parts.get(value.part_ref)!=='parsed'||!['REQUEST','REPLY','CANCEL'].includes(String(value.method))||!Number.isSafeInteger(value.sequence)||Number(value.sequence)<0||!instant(value.dtstamp)||!text(value.summary,500)||!text(value.description,5000)||!text(value.location,500)||!text(organizer.address,320)||!organizer.address||!text(organizer.name,512)||value.organizer_trust!=='unverified_mail_data'||value.receiving_attendee!==null&&!text(value.receiving_attendee,320)||typeof value.recurring!=='boolean'||typeof value.rsvp_available!=='boolean'||!Array.isArray(value.limitations)||value.limitations.length>32||value.limitations.some(item=>!text(item,128))||value.preview_token!==null&&(!text(value.preview_token,8192)||!value.preview_token||!/^[A-Za-z0-9_-]+$/u.test(value.preview_token)))return fail();
  const start=parseTime(value.start),end=parseTime(value.end);parseTime(value.recurrence_id);
  if(value.rsvp_available&&(value.method!=='REQUEST'||!value.receiving_attendee||!value.preview_token||!start||!end||value.limitations.length)||value.method==='REPLY'&&value.preview_token!==null||value.limitations.length&&value.preview_token!==null)return fail();seen.add(value.invitation_id);
 }
 return row as unknown as NativeInvitationPreview;
}
export function parseNativeInvitationReceipt(raw:unknown,accountId:string,requestId:string,invitationId:string):NativeInvitationReceipt{
 const row=object(raw,['schema_version','account_id','request_id','invitation_id','revision','calendar','response']),calendar=object(row.calendar,['state','event_id']),response=object(row.response,['state','outbox_id','delivery_status']);
 if(row.schema_version!=='deft.email_invitation_receipt.v1'||row.account_id!==accountId||row.request_id!==requestId||!uuid(requestId)||row.invitation_id!==invitationId||!digest(invitationId)||!Number.isSafeInteger(row.revision)||Number(row.revision)<1||!['applied','cancelled','declined'].includes(String(calendar.state))||calendar.event_id!==null&&!id(calendar.event_id)||!['not_requested','queued','paused','submitting','accepted','uncertain','cancelled'].includes(String(response.state))||response.outbox_id!==null&&!id(response.outbox_id)||response.delivery_status!=='unknown')return fail();return row as unknown as NativeInvitationReceipt;
}
export class NativeInvitationError extends Error{
 constructor(readonly code:string,readonly status:number){super(code==='EMAIL_INVITATION_CALENDAR_DELETED'?'This event was deleted in Calendar. Choose explicitly whether to recreate it.':code==='EMAIL_INVITATION_CALENDAR_EDITED'?'This event was edited in Calendar. Open Calendar to review it.':code==='EMAIL_INVITATION_NOT_IMPORTED'?'This event has not been added to this Calendar.':code==='EMAIL_INVITATION_SEND_UNAVAILABLE'||code==='EMAIL_SEND_SENDER_UNAVAILABLE'?'This account cannot send the response right now. Refresh the preview to choose Calendar only.':status===401||status===403?'Access changed. Refresh the preview or check Email settings.':status===409?'The invitation or Calendar changed. Refresh the preview.':status===422?'This invitation action is not supported.':'The action could not be confirmed. Check status before trying anything else.');}
}
/** Store only an exact request pointer, never ICS, text, addresses or tokens.
 * A restored/lost action is GET-only. The same source's pointer is kept even
 * when GET returns null; absence during a held commit is not proof of failure. */
export function createNativeEmailInvitation(options:{target:NativeMessageTarget;sourceDigest:string;sessionScope:string;current:()=>boolean;fetch:(path:string,init:RequestInit)=>Promise<Response>;storage?:StoragePort;uuid?:()=>string}){
 nativeMessageUrl(options.target);if(!digest(options.sourceDigest))return fail();let active=true,busy=false,preview:NativeInvitationPreview|null=null;const master=new AbortController();
 const current=()=>active&&options.current(),base='/api/email/accounts/'+encodeURIComponent(options.target.account_id),prefix='deft.email.invitation-intent.v1:'+JSON.stringify([options.sessionScope,options.target.account_id,options.target.logical_message_id,options.sourceDigest])+':';
 const key=(invitationId:string)=>prefix+invitationId;
 const pointer=(invitationId:string):Pointer|null=>{if(!current())return null;const cached=memory.get(key(invitationId));if(cached)return cached;try{const saved=options.storage?.getItem(key(invitationId));if(!saved||saved.length>512)return null;const value=object(JSON.parse(saved),['request_id','invitation_id']);if(!uuid(value.request_id)||value.invitation_id!==invitationId)return null;const result=value as Pointer;memory.set(key(invitationId),result);return result;}catch{return null;}};
 const clear=(invitationId:string)=>{memory.delete(key(invitationId));try{options.storage?.removeItem(key(invitationId));}catch{/* Memory still records confirmed rejection. */}};
 const request=async(path:string,init:RequestInit={},timeout=8000)=>{
  if(!current())throw Error('Email access changed.');const signal=AbortSignal.any([master.signal,AbortSignal.timeout(timeout)]),response=await options.fetch(path,{...init,cache:'no-store',signal});signal.throwIfAborted();if(!current())throw Error('Email access changed.');const textValue=await response.text();signal.throwIfAborted();if(!current()||new TextEncoder().encode(textValue).length>256*1024)throw Error('Invitation details could not be confirmed.');const value:unknown=JSON.parse(textValue);if(!response.ok){const error=object(value,['code','error']);throw new NativeInvitationError(typeof error.code==='string'?error.code:'EMAIL_INVITATION_UNAVAILABLE',response.status);}return value;
 };
 return {
  load:async()=>{const value=parseNativeInvitationPreview(await request(base+'/messages/'+options.target.logical_message_id+'/invitations'),options.target,options.sourceDigest);if(!current())throw Error('Email access changed.');preview=value;return value;},
  pending:(invitationId:string)=>pointer(invitationId),
  apply:async(invitationId:string,action:NativeInvitationChoice,recreateDeleted=false)=>{
   if(!current()||busy||!['rsvp','apply_cancellation'].includes(action.kind))throw Error('Invitation action is unavailable.');const item=preview?.invitations.find(value=>value.invitation_id===invitationId);if(!item||!item.preview_token||item.limitations.length||(action.kind==='rsvp'?!item.rsvp_available:item.method!=='CANCEL'))throw Error('This invitation action is not supported.');
   if(action.kind==='rsvp'&&(!['accepted','tentative','declined'].includes(action.response)||typeof action.send_response!=='boolean')||typeof recreateDeleted!=='boolean')throw Error('This invitation action is not supported.');
   if(pointer(invitationId))throw Error('Check the existing action before choosing another.');const requestId=(options.uuid??(()=>crypto.randomUUID()))();if(!uuid(requestId))throw Error('The action could not start.');const held={request_id:requestId,invitation_id:invitationId};memory.set(key(invitationId),held);let persisted=false;try{options.storage?.setItem(key(invitationId),JSON.stringify(held));persisted=!!options.storage;}catch{/* Online actions still work; preserve pointer in tab memory. */}busy=true;
   const choice:NativeInvitationChoice=action.kind==='rsvp'?{kind:'rsvp',response:action.response,send_response:action.send_response}:{kind:'apply_cancellation'};
   try{const raw=await request(base+'/invitations/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:requestId,preview_token:item.preview_token,destination_id:'deft_personal',recreate_deleted:recreateDeleted,action:choice})},15000);return {receipt:parseNativeInvitationReceipt(raw,options.target.account_id,requestId,invitationId),persisted};}
   catch(error){if(error instanceof NativeInvitationError&&[400,401,403,409,413,422].includes(error.status))clear(invitationId);throw error;}finally{busy=false;}
  },
  read:async(invitationId:string)=>{const held=pointer(invitationId);if(!held)throw Error('No invitation action is waiting.');const raw=object(await request(base+'/invitations/requests/'+held.request_id),['receipt']);return raw.receipt===null?null:parseNativeInvitationReceipt(raw.receipt,options.target.account_id,held.request_id,invitationId);},
  dispose:()=>{active=false;master.abort();preview=null;},
 };
}
