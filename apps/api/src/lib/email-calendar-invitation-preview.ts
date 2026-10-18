import {createHash} from 'node:crypto';
import {z} from 'zod';
import {NativeEmailCalendarPartsSchema} from './email-native-adapter-contract.js';
import type {EmailActor,EmailAuthority,EmailCapability,EmailScope} from './email-mailbox-service.js';
import type {EmailMessageContentService} from './email-message-content.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailInvitationDestination,EmailInvitationPreviewTokenSchema} from './email-calendar-invitation-contract.js';
import {emailCalendarInvitationIdentity,parseEmailCalendarInvitations,selectEmailInvitationAttendee,type EmailCalendarInvitation} from './email-calendar-invitation.js';
import {emailInvitationApplyLimitations} from './email-calendar-projection.js';

const Id=z.string().min(1).max(256).refine(v=>v===v.trim()&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
const Scope=z.strictObject({org_id:Id,owner_user_id:Id,account_id:Id}),Actor=z.strictObject({user_id:Id,web_session_id:Id,access_expires_at:z.number().finite()});
const Logical=z.string().regex(/^mail_[a-f0-9]{64}$/u),Digest=z.string().regex(/^[a-f0-9]{64}$/u);
const Time=z.strictObject({value:z.string().max(32),value_type:z.enum(['date','date_time']),time_zone:z.string().max(128).nullable(),instant:z.string().max(32).nullable()});
export const EmailInvitationPreviewSchema=z.strictObject({schema_version:z.literal('deft.email_invitation_preview.v1'),account_id:Id,logical_message_id:Logical,source_digest:Digest,
 destination:z.strictObject({id:z.literal('deft_personal'),label:z.literal('Deft personal calendar'),visibility:z.literal('owner_in_current_organization'),external_notifications:z.literal(false)}),
 status:z.enum(['available','unsupported']),reason:z.string().max(128).optional(),
 parts:z.array(z.strictObject({part_ref:Digest,status:z.enum(['parsed','unsupported','malformed']),reason:z.string().max(128).optional()})).max(8),
 invitations:z.array(z.strictObject({invitation_id:Digest,part_ref:Digest,method:z.enum(['REQUEST','REPLY','CANCEL']),sequence:z.number().int().nonnegative(),dtstamp:z.iso.datetime(),
  summary:z.string().max(500),description:z.string().max(5000),location:z.string().max(500),organizer:z.strictObject({address:z.string().max(320),name:z.string().max(512)}),
  organizer_trust:z.literal('unverified_mail_data'),receiving_attendee:z.string().max(320).nullable(),start:Time.nullable(),end:Time.nullable(),recurrence_id:Time.nullable(),
  recurring:z.boolean(),limitations:z.array(z.string().max(128)).max(32),rsvp_available:z.boolean(),preview_token:z.string().max(8192).nullable()})).max(32)});
export type EmailInvitationPreview=Readonly<z.infer<typeof EmailInvitationPreviewSchema>>;
export class EmailInvitationPreviewError extends Error{
 constructor(readonly code:'EMAIL_INVITATION_ACCESS_DENIED'|'EMAIL_INVITATION_PREVIEW_STALE'|'EMAIL_INVITATION_UNSUPPORTED'){super(code);this.name='EmailInvitationPreviewError';}
}
function fail(code:EmailInvitationPreviewError['code']):never{throw new EmailInvitationPreviewError(code);}
const invitationId=(item:EmailCalendarInvitation)=>createHash('sha256').update(emailCalendarInvitationIdentity(item)).digest('hex');
/** Pure preview of the current authenticated message source. A sealed token is
 * only a nomination: apply must re-read the source and current authority. */
export class EmailInvitationPreviewService{
 constructor(private readonly authority:EmailAuthority,private readonly content:Pick<EmailMessageContentService,'readCalendarParts'>,private readonly cipher:EmailMailboxCrypto,private readonly now=Date.now){}
 private async current(actor:EmailActor,scope:EmailScope,expected?:EmailCapability,signal?:AbortSignal){
  signal?.throwIfAborted();if(actor.user_id!==scope.owner_user_id||actor.access_expires_at<=this.now())fail('EMAIL_INVITATION_ACCESS_DENIED');
  let cap:EmailCapability;try{cap=await this.authority.current(actor,scope,'human_read',undefined,signal);}catch(error){if(signal?.aborted)throw error;if(error instanceof Error&&error.message==='EMAIL_ACCESS_DENIED')fail('EMAIL_INVITATION_ACCESS_DENIED');throw error;}
  signal?.throwIfAborted();if(!Scope.safeParse(cap.scope).success||Object.keys(scope).some(k=>scope[k as keyof EmailScope]!==cap.scope[k as keyof EmailScope])
   ||!Id.safeParse(cap.authority_version).success||!Id.safeParse(cap.resource_binding_id).success||!Number.isFinite(cap.expires_at)||cap.expires_at<=this.now()
   ||expected&&(expected.authority_version!==cap.authority_version||expected.resource_binding_id!==cap.resource_binding_id))fail('EMAIL_INVITATION_ACCESS_DENIED');return cap;
 }
 private context(scope:EmailScope){return {...scope,kind:'checkpoint' as const,record_id:'calendar-invitation-preview.v1',revision:1};}
 private seal(value:z.infer<typeof EmailInvitationPreviewTokenSchema>,scope:EmailScope){return Buffer.from(JSON.stringify(this.cipher.seal(value,this.context(scope)))).toString('base64url');}
 private async source(actor:EmailActor,scope:EmailScope,logicalId:string,cap:EmailCapability,signal?:AbortSignal){
  const value=NativeEmailCalendarPartsSchema.parse(await this.content.readCalendarParts(actor,scope,logicalId,signal));await this.current(actor,scope,cap,signal);
  if(value.account_id!==scope.account_id||value.logical_message_id!==logicalId)fail('EMAIL_INVITATION_ACCESS_DENIED');return value;
 }
 async preview(actorRaw:EmailActor,scopeRaw:EmailScope,logicalRaw:string,signal?:AbortSignal):Promise<EmailInvitationPreview>{
  const actor=Actor.parse(actorRaw),scope=Scope.parse(scopeRaw),logicalId=Logical.parse(logicalRaw),cap=await this.current(actor,scope,undefined,signal),source=await this.source(actor,scope,logicalId,cap,signal);
  if(source.status==='unsupported')return EmailInvitationPreviewSchema.parse({schema_version:'deft.email_invitation_preview.v1',account_id:scope.account_id,logical_message_id:logicalId,source_digest:source.source_digest,destination:EmailInvitationDestination,status:'unsupported',reason:source.reason,parts:[],invitations:[]});
  const parts:EmailInvitationPreview['parts']=[],invitations:EmailInvitationPreview['invitations']=[],identities=new Map<string,string>();
  for(const part of source.parts){
   const parsed=parseEmailCalendarInvitations({...part,source_digest:source.source_digest});parts.push({part_ref:part.part_ref,status:parsed.status,...('reason'in parsed?{reason:parsed.reason}:{})});
   if(parsed.status!=='parsed')continue;
   for(const item of parsed.items){
    const id=invitationId(item),previous=identities.get(id);
    if(previous!==undefined){if(previous===item.content_digest)continue;
     await this.current(actor,scope,cap,signal);return EmailInvitationPreviewSchema.parse({schema_version:'deft.email_invitation_preview.v1',account_id:scope.account_id,logical_message_id:logicalId,source_digest:source.source_digest,destination:EmailInvitationDestination,status:'unsupported',reason:'INVITATION_IDENTITY_CONFLICT',parts,invitations:[]});}
    identities.set(id,item.content_digest);
    if(invitations.length===32){await this.current(actor,scope,cap,signal);return EmailInvitationPreviewSchema.parse({schema_version:'deft.email_invitation_preview.v1',account_id:scope.account_id,logical_message_id:logicalId,source_digest:source.source_digest,destination:EmailInvitationDestination,status:'unsupported',reason:'INVITATION_LIMIT',parts,invitations:[]});}
    const projectionLimitations=emailInvitationApplyLimitations(item),attendee=projectionLimitations.length?null:selectEmailInvitationAttendee(item,[source.receiving_identity.primary_address]);
    const eligible=!!attendee||item.method==='CANCEL'&&!item.limitations.length;
    const preview_token=eligible?this.seal({schema_version:'deft.email_invitation_preview_token.v1',...scope,web_session_id:actor.web_session_id,logical_message_id:logicalId,
     source_digest:source.source_digest,part_ref:part.part_ref,invitation_id:id,content_digest:item.content_digest,authority_version:cap.authority_version,expires_at:Math.min(this.now()+300000,cap.expires_at,actor.access_expires_at)},scope):null;
    invitations.push({invitation_id:id,part_ref:part.part_ref,method:item.method,sequence:item.sequence,dtstamp:item.dtstamp,summary:item.summary,description:item.description,location:item.location,organizer:item.organizer,
     organizer_trust:'unverified_mail_data',receiving_attendee:attendee?.address??null,start:item.start,end:item.end,recurrence_id:item.recurrence_id,recurring:!!item.rrule,limitations:[...item.limitations,...projectionLimitations],rsvp_available:!!attendee,preview_token});
   }
  }
  await this.current(actor,scope,cap,signal);
  return EmailInvitationPreviewSchema.parse({schema_version:'deft.email_invitation_preview.v1',account_id:scope.account_id,logical_message_id:logicalId,source_digest:source.source_digest,destination:EmailInvitationDestination,status:'available',parts,invitations});
 }
 /** Host-only resolution for deliberate apply; never accepts caller ICS/UID or
  * provider locators. Tokens are checked against fresh source bytes and SID. */
 async resolve(actorRaw:EmailActor,scopeRaw:EmailScope,rawToken:string,signal?:AbortSignal){
  const actor=Actor.parse(actorRaw),scope=Scope.parse(scopeRaw);z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/u).parse(rawToken);
  const cap=await this.current(actor,scope,undefined,signal);let token:z.infer<typeof EmailInvitationPreviewTokenSchema>;
  try{const bytes=Buffer.from(rawToken,'base64url');try{token=EmailInvitationPreviewTokenSchema.parse(this.cipher.open(JSON.parse(bytes.toString('utf8')),this.context(scope)));}finally{bytes.fill(0);}}catch{fail('EMAIL_INVITATION_PREVIEW_STALE');}
  if(token.org_id!==scope.org_id||token.owner_user_id!==scope.owner_user_id||token.account_id!==scope.account_id||token.web_session_id!==actor.web_session_id||token.authority_version!==cap.authority_version||token.expires_at<=this.now()||token.expires_at>this.now()+300000)fail('EMAIL_INVITATION_PREVIEW_STALE');
  const source=await this.source(actor,scope,token.logical_message_id,cap,signal),part=source.parts.find(row=>row.part_ref===token.part_ref);
  if(source.status!=='available'||source.source_digest!==token.source_digest||!part)fail('EMAIL_INVITATION_PREVIEW_STALE');
  const parsed=parseEmailCalendarInvitations({...part,source_digest:source.source_digest});if(parsed.status!=='parsed')fail('EMAIL_INVITATION_PREVIEW_STALE');
  const invitation=parsed.items.find(item=>invitationId(item)===token.invitation_id&&item.content_digest===token.content_digest);if(!invitation||invitation.limitations.length||emailInvitationApplyLimitations(invitation).length)fail('EMAIL_INVITATION_PREVIEW_STALE');
  // A token nominates one scoped MIME part, but another current part must not
  // offer a conflicting version of that same semantic invitation identity.
  for(const other of source.parts){if(other.part_ref===part.part_ref)continue;const candidate=parseEmailCalendarInvitations({...other,source_digest:source.source_digest});
   if(candidate.status==='parsed'&&candidate.items.some(item=>invitationId(item)===token.invitation_id&&item.content_digest!==token.content_digest))fail('EMAIL_INVITATION_PREVIEW_STALE');}
  const attendee=selectEmailInvitationAttendee(invitation,[source.receiving_identity.primary_address]);if(invitation.method==='REQUEST'&&!attendee||invitation.method==='REPLY')fail('EMAIL_INVITATION_UNSUPPORTED');
  await this.current(actor,scope,cap,signal);return {actor,scope,capability:cap,token,invitation,receiving_identity:source.receiving_identity,attendee};
 }
}
