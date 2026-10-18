import {createHash,randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {events,emailOutbox} from '@deft/db/schema';
import {emailCalendarInvitations,emailCalendarInvitationActions} from '../../../../packages/db/src/email-calendar-invitation-schema.js';
import {canonicalCapabilityJson} from '@deft/shared';
import {z} from 'zod';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import type {EmailScope} from './email-mailbox-service.js';
import {EmailInvitationApplySchema,EmailInvitationReceiptSchema,type EmailInvitationApply,type EmailInvitationReceipt} from './email-calendar-invitation-contract.js';
import {compareEmailInvitationVersion,emailCalendarInvitationIdentity,type EmailCalendarInvitation} from './email-calendar-invitation.js';
import {emailInvitationApplyLimitations} from './email-calendar-projection.js';
import {assertEmailInvitationReceiver,projectEmailInvitationAttendees} from './email-calendar-attendee-projection.js';

const schema={events,emailOutbox,emailCalendarInvitations,emailCalendarInvitationActions};
export type EmailInvitationDatabase=Pick<NodePgDatabase<typeof schema>,'transaction'>;
export type EmailInvitationTransaction=Parameters<Parameters<EmailInvitationDatabase['transaction']>[0]>[0];
export type EmailInvitationGuard=(transaction:unknown)=>Promise<void>;
type InvitationRow=typeof emailCalendarInvitations.$inferSelect;
type EventRow=typeof events.$inferSelect;
const digest=(value:unknown)=>createHash('sha256').update(canonicalCapabilityJson(value)).digest('hex');
export const emailInvitationId=(value:EmailCalendarInvitation)=>createHash('sha256').update(emailCalendarInvitationIdentity(value)).digest('hex');
export const emailInvitationModelContext=(scope:EmailScope,id:string,revision:number)=>({...scope,kind:'operation' as const,record_id:'calendar-invitation:'+id,revision});
export const emailInvitationReceiptContext=(scope:EmailScope,id:string)=>({...scope,kind:'operation' as const,record_id:'calendar-invitation-action:'+id,revision:1});
const invitationKey=(scope:EmailScope,id:string)=>and(eq(emailCalendarInvitations.org_id,scope.org_id),eq(emailCalendarInvitations.owner_user_id,scope.owner_user_id),eq(emailCalendarInvitations.account_id,scope.account_id),eq(emailCalendarInvitations.invitation_id,id));
const actionKey=(scope:EmailScope,id:string)=>and(eq(emailCalendarInvitationActions.org_id,scope.org_id),eq(emailCalendarInvitationActions.owner_user_id,scope.owner_user_id),eq(emailCalendarInvitationActions.account_id,scope.account_id),eq(emailCalendarInvitationActions.request_id,id));
const eventKey=(scope:EmailScope,id:string)=>and(eq(events.id,id),eq(events.org_id,scope.org_id),eq(events.user_id,scope.owner_user_id),eq(events.source,'native'),eq(events.event_type,'calendar_event'));
export const emailInvitationEventFingerprint=(row:EventRow)=>digest({id:row.id,org_id:row.org_id,user_id:row.user_id,source:row.source,event_type:row.event_type,title:row.title,body:row.body,
 actor:row.actor,url:row.url,timestamp:row.timestamp.toISOString(),metadata:row.metadata,updated_at:row.updated_at.toISOString()});
const Model=z.strictObject({invitation:z.record(z.string(),z.json()),response:z.enum(['accepted','tentative','declined']).nullable(),receiving_attendee_address:z.string().email().max(320).optional()});
const requestDigest=(logicalId:string,item:EmailCalendarInvitation,input:EmailInvitationApply)=>digest({logical_message_id:logicalId,source_digest:item.source_digest,content_digest:item.content_digest,invitation_id:emailInvitationId(item),
 destination_id:input.destination_id,recreate_deleted:input.recreate_deleted,action:input.action});
/** Scope/version/Calendar effects and a requested Outbox enqueue are one SQL
 * transaction. No provider I/O occurs here. Existing Calendar events stay the
 * sole editable content source; external effects remain the durable Outbox. */
export class EmailCalendarInvitationStore{
 constructor(private readonly database:EmailInvitationDatabase,private readonly cipher:EmailMailboxCrypto,private readonly now=()=>new Date()){}
 private model(scope:EmailScope,row:InvitationRow){
  const value=Model.parse(this.cipher.open(row.model_envelope,emailInvitationModelContext(scope,row.invitation_id,row.revision))),item=value.invitation as unknown as EmailCalendarInvitation;
  if(value.receiving_attendee_address!==undefined){try{if(value.response===null)throw Error('INVALID');assertEmailInvitationReceiver(item,value.receiving_attendee_address);}catch{throw Error('EMAIL_INVITATION_UNAVAILABLE');}}
  if(emailInvitationId(item)!==row.invitation_id||item.content_digest!==row.content_digest||item.source_digest!==row.source_digest||item.sequence!==row.sequence||item.dtstamp!==row.dtstamp.toISOString())throw Error('EMAIL_INVITATION_UNAVAILABLE');return {invitation:item,response:value.response};
 }
 private async receipt(tx:EmailInvitationTransaction,scope:EmailScope,row:typeof emailCalendarInvitationActions.$inferSelect){
  const value=EmailInvitationReceiptSchema.parse(this.cipher.open(row.receipt_envelope,emailInvitationReceiptContext(scope,row.request_id)));
  if(value.account_id!==scope.account_id||value.request_id!==row.request_id||value.invitation_id!==row.invitation_id||value.revision!==row.invitation_revision||value.response.outbox_id!==row.outbox_id)throw Error('EMAIL_INVITATION_UNAVAILABLE');
  if(row.outbox_id){const [outbox]=await tx.select({state:emailOutbox.state}).from(emailOutbox).where(and(eq(emailOutbox.org_id,scope.org_id),eq(emailOutbox.owner_user_id,scope.owner_user_id),eq(emailOutbox.account_id,scope.account_id),eq(emailOutbox.outbox_id,row.outbox_id))).limit(1);
   if(!outbox)throw Error('EMAIL_INVITATION_UNAVAILABLE');value.response.state=outbox.state;}
  return value;
 }
 async readRequest(scope:EmailScope,requestId:string,guard:EmailInvitationGuard,signal?:AbortSignal){z.uuid().parse(requestId);return this.database.transaction(async tx=>{
  await guard(tx);signal?.throwIfAborted();const [row]=await tx.select().from(emailCalendarInvitationActions).where(actionKey(scope,requestId)).limit(1);const value=row?await this.receipt(tx,scope,row):null;await guard(tx);signal?.throwIfAborted();return value;
 });}
 async apply(scope:EmailScope,logicalId:string,invitation:EmailCalendarInvitation,inputRaw:EmailInvitationApply,receivingAddress:string|null,guard:EmailInvitationGuard,
  enqueue?:Readonly<{outbox_id:string;enqueue(tx:EmailInvitationTransaction):Promise<{outbox_id:string;state:'queued'}>}>,signal?:AbortSignal):Promise<EmailInvitationReceipt>{
  const input=EmailInvitationApplySchema.parse(inputRaw),id=emailInvitationId(invitation),payloadDigest=requestDigest(logicalId,invitation,input);
  if(!/^mail_[a-f0-9]{64}$/u.test(logicalId)||invitation.limitations.length||emailInvitationApplyLimitations(invitation).length||input.action.kind==='rsvp'&&invitation.method!=='REQUEST'||input.action.kind==='apply_cancellation'&&invitation.method!=='CANCEL'
   ||input.action.kind==='rsvp'&&input.action.send_response!==!!enqueue)throw Error('EMAIL_INVITATION_INVALID');
  const receiver=input.action.kind==='rsvp'?assertEmailInvitationReceiver(invitation,receivingAddress):null;
  return this.database.transaction(async tx=>{
   // Authority takes canonical owner/account locks first. Serialize writes to
   // this owner's invitation identity before touching linked event/outbox.
   await guard(tx);signal?.throwIfAborted();
   // Serialize the whole scoped series, including its first absent row and
   // replay receipt. This lock never spans source reads or provider I/O.
   const seriesLock=digest({...scope,invitation_id:emailInvitationId({...invitation,recurrence_id:null})});
   await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${seriesLock},0))`);
   const [priorAction]=await tx.select().from(emailCalendarInvitationActions).where(actionKey(scope,input.request_id)).limit(1);
   if(priorAction){if(priorAction.payload_digest!==payloadDigest)throw Error('EMAIL_INVITATION_REQUEST_CONFLICT');const value=await this.receipt(tx,scope,priorAction);await guard(tx);return value;}
   // Master before instance is the shared lock order for exception changes and
   // whole-series cancellation. An old instance cannot resurrect a cancelled
   // current master merely by having a different recurrence identity.
   if(invitation.recurrence_id){const masterId=emailInvitationId({...invitation,recurrence_id:null});
    const [master]=await tx.select().from(emailCalendarInvitations).where(invitationKey(scope,masterId)).limit(1).for('share');
    if(master){const model=this.model(scope,master);if(model.invitation.method==='CANCEL')throw Error('EMAIL_INVITATION_SERIES_CANCELLED');}
   }
   const [prior]=await tx.select().from(emailCalendarInvitations).where(invitationKey(scope,id)).limit(1).for('update');
   let event:EventRow|undefined,revision=1;
   if(prior){const version=compareEmailInvitationVersion(this.model(scope,prior).invitation,invitation);if(version==='older')throw Error('EMAIL_INVITATION_STALE');if(version==='conflict')throw Error('EMAIL_INVITATION_VERSION_CONFLICT');revision=prior.revision+1;
    if(prior.event_id){[event]=await tx.select().from(events).where(eventKey(scope,prior.event_id)).limit(1).for('update');if(!event||emailInvitationEventFingerprint(event)!==prior.event_fingerprint)throw Error('EMAIL_INVITATION_CALENDAR_EDITED');}
    else if(prior.event_fingerprint&&!input.recreate_deleted&&input.action.kind==='rsvp'&&input.action.response!=='declined')throw Error('EMAIL_INVITATION_CALENDAR_DELETED');
   }else if(input.action.kind==='apply_cancellation')throw Error('EMAIL_INVITATION_NOT_IMPORTED');
   if(input.action.kind==='apply_cancellation'&&!invitation.recurrence_id){
    const siblings=await tx.select().from(emailCalendarInvitations).where(and(eq(emailCalendarInvitations.org_id,scope.org_id),eq(emailCalendarInvitations.owner_user_id,scope.owner_user_id),eq(emailCalendarInvitations.account_id,scope.account_id))).orderBy(asc(emailCalendarInvitations.invitation_id)).limit(513).for('share');
    if(siblings.length>512)throw Error('EMAIL_INVITATION_SERIES_LIMIT');
    for(const sibling of siblings){if(sibling.invitation_id===id)continue;const item=this.model(scope,sibling).invitation;
     if(item.uid!==invitation.uid||item.organizer.address!==invitation.organizer.address||!item.recurrence_id||!sibling.event_id)continue;
     const [linked]=await tx.select().from(events).where(eventKey(scope,sibling.event_id)).limit(1).for('share');
     if(!linked||emailInvitationEventFingerprint(linked)!==sibling.event_fingerprint)throw Error('EMAIL_INVITATION_CALENDAR_EDITED');
    }
   }
   const at=this.now();if(!Number.isFinite(at.getTime())||revision>2147483647)throw Error('EMAIL_INVITATION_INVALID');
   let calendarState:EmailInvitationReceipt['calendar']['state'],response:'accepted'|'tentative'|'declined'|null;
   if(input.action.kind==='apply_cancellation'||input.action.response==='declined'){
    calendarState=input.action.kind==='apply_cancellation'?'cancelled':'declined';response=input.action.kind==='rsvp'?input.action.response:null;
    if(event){const metadata=event.metadata as Record<string,unknown>;[event]=await tx.update(events).set({metadata:{...metadata,status:'canceled',email_invitation_response:response,
     ...(input.action.kind==='rsvp'?{attendees:projectEmailInvitationAttendees(invitation,receiver!,input.action.response)}:{})},updated_at:at}).where(eventKey(scope,event.id)).returning();}
   }else{
    calendarState='applied';response=input.action.response;const start=invitation.start,end=invitation.end;
    if(!start||!end)throw Error('EMAIL_INVITATION_TIME_UNSUPPORTED');
    const instant=(time:typeof start)=>time.value_type==='date'?new Date(`${time.value.slice(0,4)}-${time.value.slice(4,6)}-${time.value.slice(6,8)}T00:00:00Z`):new Date(time.instant!);
    const beginning=instant(start),ending=instant(end);if(!Number.isFinite(beginning.getTime())||!Number.isFinite(ending.getTime()))throw Error('EMAIL_INVITATION_TIME_UNSUPPORTED');
    const metadata={start:beginning.toISOString(),end:ending.toISOString(),location:invitation.location||null,attendees:projectEmailInvitationAttendees(invitation,receiver!,input.action.response),
     hangoutLink:null,status:response==='tentative'?'tentative':'confirmed',allDay:start.value_type==='date',email_invitation_response:response,
     // Calendar projections use this bounded model for master/exception ranges.
     email_invitation:{schema_version:'deft.email_calendar_event.v1',account_id:scope.account_id,invitation_id:id,uid:invitation.uid,organizer:invitation.organizer.address,
      start,end,rrule:invitation.rrule,exdates:invitation.exdates,recurrence_id:invitation.recurrence_id,sequence:invitation.sequence,dtstamp:invitation.dtstamp}};
    if(event){[event]=await tx.update(events).set({title:invitation.summary,body:invitation.description||null,timestamp:beginning,metadata,updated_at:at}).where(eventKey(scope,event.id)).returning();}
    else{[event]=await tx.insert(events).values({id:randomUUID(),org_id:scope.org_id,user_id:scope.owner_user_id,source:'native',event_type:'calendar_event',external_id:null,title:invitation.summary,body:invitation.description||null,
     actor:invitation.organizer.address,timestamp:beginning,metadata,created_at:at,updated_at:at}).returning();}
   }
   const fingerprint=event?emailInvitationEventFingerprint(event):prior?.event_fingerprint??null,model={invitation,response,...(receiver?{receiving_attendee_address:receiver}:{})};
   const values={revision,sequence:invitation.sequence,dtstamp:new Date(invitation.dtstamp),content_digest:invitation.content_digest,logical_message_id:logicalId,source_digest:invitation.source_digest,
    model_envelope:this.cipher.seal(model,emailInvitationModelContext(scope,id,revision)),event_id:event?.id??null,event_fingerprint:fingerprint,updated_at:at};
   if(prior)await tx.update(emailCalendarInvitations).set(values).where(invitationKey(scope,id));else await tx.insert(emailCalendarInvitations).values({...scope,invitation_id:id,...values,created_at:at});
   let outboxId:string|null=null;if(enqueue){const result=await enqueue.enqueue(tx);if(result.outbox_id!==enqueue.outbox_id||result.state!=='queued')throw Error('EMAIL_INVITATION_OUTBOX_INVALID');outboxId=result.outbox_id;}
   const receipt=EmailInvitationReceiptSchema.parse({schema_version:'deft.email_invitation_receipt.v1',account_id:scope.account_id,request_id:input.request_id,invitation_id:id,revision,
    calendar:{state:calendarState,event_id:event?.id??null},response:{state:outboxId?'queued':'not_requested',outbox_id:outboxId,delivery_status:'unknown'}});
   await tx.insert(emailCalendarInvitationActions).values({...scope,request_id:input.request_id,invitation_id:id,payload_digest:payloadDigest,invitation_revision:revision,receipt_envelope:this.cipher.seal(receipt,emailInvitationReceiptContext(scope,input.request_id)),outbox_id:outboxId,created_at:at});
   await guard(tx);signal?.throwIfAborted();return receipt;
  });
 }
}
