import { z } from 'zod';
import type { ActionPayloadBinding, PrivateFileReference, PrivateFilePolicy } from './app-private-file-contract.js';
import type { ResourceContentPolicy } from '@deft/app-kit';
import type { HumanActionSourceRecord } from './app-experience-human-action-service.js';
import {EmailMessageRecordSchema} from './email-mailbox-service.js';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
export const AppConnectionPinsSchema = z.strictObject({
  org_id: z.string().uuid(), owner_user_id: z.string().uuid(), installation_id: z.string().uuid(),
  app_version_id: z.string().uuid(), grant_snapshot_id: z.string().uuid(), target_key: key,
  resource_key: key, resource_binding_id: z.string().uuid(),
  action_key: key.nullable(), action_binding_id: z.string().uuid().nullable(),
}).refine(value => Boolean(value.action_key) === Boolean(value.action_binding_id));
export type AppConnectionPins = z.infer<typeof AppConnectionPinsSchema>;
export const AppConnectionPurposeSchema = z.enum(['connect', 'status', 'disconnect', 'read_document', 'read_source', 'triage_options', 'browse_resource']);
export type AppConnectionPurpose = z.infer<typeof AppConnectionPurposeSchema>;
export type AppConnectionProjection = Readonly<AppConnectionPins & {
  // Cleanup carries immutable custody nominations, never live action admission.
  purpose: AppConnectionPurpose;
  web_session_id: string; experience_session_id: string; runtime_registration_id: string;
  descriptor_digest: string; allowed_operations: readonly ('list_summary' | 'read_one' | 'search')[];
  content_policy?: ResourceContentPolicy;
  /** Current reviewed actions anchored to this exact owner resource; absent means none. */
  reviewed_action_keys?: readonly string[];
  lifecycle_epoch: number; grant_epoch: number; runtime_epoch: number; expires_at: number; checked_at: number;
}>;

export const AppConnectionCallbackSchema = z.strictObject({
  state: z.string().min(16).max(1024), code: z.string().min(1).max(4096).optional(),
  error: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/).optional(),
}).refine(value => Boolean(value.code) !== Boolean(value.error));
export const AppConnectionManageSchema = z.strictObject({ operation: z.enum(['status', 'disconnect']).optional() });
export type AppConnectionContext = Readonly<{
  projection: AppConnectionProjection;
  recheck: () => Promise<AppConnectionProjection>;
  signal?: AbortSignal;
  /** Trusted current descriptor fields; never nominated by Worker input. */
  search_fields?: readonly string[];
}>;
/** Host-only native Email context. It is not an Experience projection and must
 * never be synthesized from browser-supplied account/provider credentials. */
export type NativeEmailConnectionContext = Readonly<{
  org_id: string; owner_user_id: string; account_id: string; installation_id: string;
  resource_binding_id: string; authority_version: string; expires_at: number;
  recheck: () => Promise<void>; signal?: AbortSignal;
  /** Host-selected owner-native consent; never a browser grant. */
  owner_capabilities?:readonly ('read'|'modify'|'send')[];
  /** Metadata-only lifecycle inspection; ordinary content/effects reject it. */
  lifecycle_inspect?:true;
  provider_state?: import('./email-mailbox-service.js').EmailProviderStateReader;
  imap_aliases?: import('./email-imap-alias-contract.js').EmailImapAliasPort;
  /** Trusted native human mutation ports, only provisioned for triage. */
  triage_journal?:NativeEmailTriageJournal;
  triage_before_reserve?:()=>Promise<void>;
  /** Verifies the already reserved immutable native draft send operation. */
  send_before_reserve?:(input:Readonly<{operation_id:string;account_id:string;authority_epoch:number;mime_digest:string}>)=>Promise<boolean>;
  send_prepare_before_effect?:(input:Readonly<{operation_id:string;account_id:string;authority_epoch:number;mime_digest:string}>)=>Promise<boolean>;
  send_upload_journal?:import('./email-graph-send-contract.js').EmailGraphSendJournal;
  sent_copy_journal?:import('./email-sent-copy-contract.js').EmailSentCopyJournal;
  sent_copy_before_append?:(input:Readonly<{operation_id:string;account_id:string;authority_epoch:number;mime_digest:string}>)=>Promise<boolean>;
  /** Host verifies a preexisting durable opt-in draft mirror reservation. */
  draft_sync_before_effect?:(input:NativeEmailDraftSyncEffect)=>Promise<boolean>;
  draft_sync_journal?:import('./email-draft-sync-contract.js').NativeEmailDraftSyncJournal;
}>;
export type NativeEmailAccount = Readonly<{
  account_id: string; provider: 'gmail' | 'microsoft' | 'imap_smtp';
  resource_binding_id: string; authority_epoch: number; connection_revision: number;
  principal_digest: string;
  /** Reviewed host implementation revision, separate from credential identity. */
  implementation_digest?: string;
  health: string; capabilities: readonly string[];
  primary_address: string; display_label: string;
}>;
export type NativeEmailSource=Readonly<{schema_version:'deft.email_source.v1';account_id:string;
  provider:'gmail'|'microsoft'|'imap_smtp';source_kind:'provider_original';media_type:'message/rfc822';
  byte_length:number;digest:string;mime_bytes:Uint8Array}>;
const NativeEmailId=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
export const NativeEmailDigestSchema=z.string().regex(/^[a-f0-9]{64}$/u);
const NativeEmailIdentity={account_id:NativeEmailId,provider:z.enum(['gmail','microsoft','imap_smtp']),logical_message_id:z.string().regex(/^mail_[a-f0-9]{64}$/u),source_digest:NativeEmailDigestSchema};
export type NativeEmailDraftSyncEffect=Readonly<{operation_id:string;operation:'create'|'update'|'delete';account_id:string;authority_epoch:number;provider_draft_ref:string|null;baseline_digest:string|null;desired_digest:string|null}>;
export const NativeEmailDraftSyncRequestSchema=z.strictObject({operation:z.enum(['inspect','create','update','delete']),operation_id:z.string().uuid(),provider_draft_ref:NativeEmailId.optional(),baseline_digest:NativeEmailDigestSchema.optional(),provider_version:NativeEmailId.optional(),
 desired:z.strictObject({mime_bytes:z.custom<Uint8Array>(value=>value instanceof Uint8Array&&value.byteLength>=1&&value.byteLength<=36700160),mime_digest:NativeEmailDigestSchema}).optional()}).superRefine((value,ctx)=>{
 const needed=value.operation!=='create',mutation=value.operation==='update'||value.operation==='delete',mime=value.operation==='create'||value.operation==='update';
 if(needed!==Boolean(value.provider_draft_ref)||mutation!==Boolean(value.baseline_digest)||mutation!==Boolean(value.provider_version)||mime!==Boolean(value.desired))ctx.addIssue({code:'custom',message:'Invalid draft mirror operation fields'});
});
export type NativeEmailDraftSyncRequest=z.infer<typeof NativeEmailDraftSyncRequestSchema>;
export const NativeEmailDraftSyncResultSchema=z.strictObject({schema_version:z.literal('deft.email_draft_sync_result.v1'),account_id:NativeEmailId,provider:z.enum(['gmail','microsoft']),operation_id:z.string().uuid(),outcome:z.enum(['present','created','updated','deleted','missing','conflict','unsupported','unknown']),provider_draft_ref:NativeEmailId.optional(),baseline_digest:NativeEmailDigestSchema.optional(),provider_version:NativeEmailId.optional(),limitations:z.array(z.string().min(1).max(256)).max(10),mime_bytes:z.custom<Uint8Array>(value=>value instanceof Uint8Array&&value.byteLength>=1&&value.byteLength<=36700160).optional()}).superRefine((value,ctx)=>{
 const content=['present','created','updated'].includes(value.outcome);if(content!==Boolean(value.mime_bytes)||content&&(!value.provider_draft_ref||!value.baseline_digest||!value.provider_version))ctx.addIssue({code:'custom',message:'Invalid draft mirror result fields'});
});
export type NativeEmailDraftSyncResult=z.infer<typeof NativeEmailDraftSyncResultSchema>;
const NativeEmailText=z.string().max(262144).refine(value=>Buffer.byteLength(value,'utf8')<=262144);
const NativeEmailMetadataText=z.string().max(16384).refine(value=>Buffer.byteLength(value,'utf8')<=16384);
const NativeEmailMetadata=z.strictObject({account_id:NativeEmailId,primary_address:z.string().max(320),
  verified_sender_identities:NativeEmailMetadataText.refine(value=>{try{const addresses:unknown=JSON.parse(value);return Array.isArray(addresses)&&addresses.length<=32&&addresses.every(address=>typeof address==='string'&&address.length<=320&&!/[\r\n\0]/u.test(address));}catch{return false;}}),
  reply_from:NativeEmailMetadataText,reply_to:NativeEmailMetadataText,reply_to_list:NativeEmailMetadataText,reply_cc:NativeEmailMetadataText,
  subject:NativeEmailMetadataText,message_id:NativeEmailMetadataText,references:NativeEmailMetadataText,conversation_id:NativeEmailId,
  conversation_coverage_state:z.literal('unknown'),conversation_indexed_count:z.literal('0'),conversation_exact_count:z.literal(''),
  conversation_observed_at:z.literal(''),conversation_drained:z.literal('false'),mailbox_reset_required:z.literal('false')});
export const NativeEmailIncomingLimits=Object.freeze({source_bytes:35*1024*1024,inventory_bytes:35*1024*1024,file_bytes:25*1024*1024});
const NativeEmailFileMetadata=z.strictObject({file_ref:NativeEmailDigestSchema,filename:z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f/\\]+$/u),
  media_type:z.string().max(128).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u),size_bytes:z.number().int().min(0).max(NativeEmailIncomingLimits.inventory_bytes),
  disposition:z.enum(['inline','attachment']),preview:z.enum(['image','text','pdf','unsupported']),content_id:z.string().min(1).max(256).optional()});
/** JSON-only MIME presentation. Content is UNSANITIZED and must enter the
 * existing document renderer's sanitization boundary before HTML rendering. */
export const NativeEmailPresentationSchema=z.strictObject({schema_version:z.literal('deft.email_presentation.v1'),...NativeEmailIdentity,
  content_trust:z.literal('unsanitized'),files:z.array(NativeEmailFileMetadata).max(32),omitted_file_count:z.number().int().min(0).max(256).optional(),
  reply_seed_unavailable:z.array(z.enum(['reply_from','reply_to','reply_to_list','reply_cc'])).max(4).refine(value=>new Set(value).size===value.length).optional(),presentation:z.strictObject({
    format:z.enum(['plain','html']),content:NativeEmailText,plain_text:NativeEmailText,truncated:z.boolean(),rendering_fallback:z.literal('plain_text').optional(),
    images:z.array(z.strictObject({image_ref:NativeEmailDigestSchema,kind:z.enum(['cid','remote']),index:z.number().int().min(0).max(31),alt:z.string().max(200)})).max(32),
    headers:z.array(z.strictObject({label:z.enum(['From','To','Cc','Reply-To','Date','Subject']),value:z.string().max(2048)})).max(6),metadata:NativeEmailMetadata}).refine(value=>value.rendering_fallback===undefined||value.format==='plain'&&value.images.length===0)}).refine(value=>
    (value.reply_seed_unavailable??[]).every(key=>value.presentation.metadata[key]==='')).refine(value=>
    value.files.reduce((total,file)=>total+file.size_bytes,0)<=NativeEmailIncomingLimits.inventory_bytes);
const NativeEmailBytes=z.custom<Uint8Array>(value=>value instanceof Uint8Array);
export const NativeEmailFileSchema=z.strictObject({schema_version:z.literal('deft.email_file.v1'),...NativeEmailIdentity,
  file_ref:NativeEmailDigestSchema,filename:NativeEmailFileMetadata.shape.filename,media_type:NativeEmailFileMetadata.shape.media_type,
  byte_length:z.number().int().min(0).max(NativeEmailIncomingLimits.file_bytes),bytes:NativeEmailBytes}).refine(value=>value.bytes.byteLength===value.byte_length);
export const NativeEmailImageSchema=z.strictObject({schema_version:z.literal('deft.email_image.v1'),...NativeEmailIdentity,
  image_ref:NativeEmailDigestSchema,media_type:z.enum(['image/png','image/jpeg','image/gif','image/webp']),
  byte_length:z.number().int().min(12).max(2097152),bytes:NativeEmailBytes}).refine(value=>value.bytes.byteLength===value.byte_length);
export type NativeEmailPresentation=Readonly<z.infer<typeof NativeEmailPresentationSchema>>;
export type NativeEmailFile=Readonly<z.infer<typeof NativeEmailFileSchema>>;
export type NativeEmailImage=Readonly<z.infer<typeof NativeEmailImageSchema>>;
/** Host-only bounded invitation parts from the exact authenticated RFC822
 * source. Parsed ICS remains untrusted data and confers no Calendar/send grant. */
export const NativeEmailCalendarPartsSchema=z.strictObject({schema_version:z.literal('deft.email_calendar_parts.v1'),...NativeEmailIdentity,
 receiving_identity:z.strictObject({primary_address:z.string().max(320),display_label:z.string().max(512)}),status:z.enum(['available','unsupported']),
 parts:z.array(z.strictObject({part_ref:NativeEmailDigestSchema,ics_text:NativeEmailText,media_type_method:z.string().regex(/^[A-Z-]{1,32}$/u).optional()})).max(8),
 reason:z.enum(['CALENDAR_PART_LIMIT','CALENDAR_TEXT_LIMIT','CALENDAR_CHARSET_UNSUPPORTED','CALENDAR_TEXT_INVALID']).optional()})
 .superRefine((value,ctx)=>{if(value.parts.reduce((n,part)=>n+Buffer.byteLength(part.ics_text,'utf8'),0)>262144||(value.status==='unsupported'?(value.parts.length!==0||!value.reason):value.reason!==undefined))ctx.addIssue({code:'custom',message:'Invalid bounded calendar parts'});});
export type NativeEmailCalendarParts=Readonly<z.infer<typeof NativeEmailCalendarPartsSchema>>;
export const NativeEmailSearchRequestSchema=z.strictObject({query:z.string().min(1).max(2048),cursor:z.string().min(1).max(8192).nullable(),limit:z.number().int().min(1).max(100)});
export type NativeEmailSearchRequest=Readonly<z.infer<typeof NativeEmailSearchRequestSchema>>;
export const NativeEmailSearchPageSchema=z.strictObject({schema_version:z.literal('deft.email_search_page.v1'),status:z.enum(['supported','unsupported']),
  account_id:NativeEmailId,provider:z.enum(['gmail','microsoft','imap_smtp']),original_query:z.string().min(1).max(2048),
  items:z.array(EmailMessageRecordSchema).max(100),next_cursor:z.string().min(1).max(8192).nullable(),has_more:z.boolean(),observed_at:z.iso.datetime(),
  failure_count:z.number().int().min(0).max(100),query_complete:z.boolean(),provider_result_cap:z.union([z.literal(1000),z.null()]),
  limitations:z.array(z.string().min(1).max(256)).max(32),unsupported:z.array(z.strictObject({index:z.number().int().min(0).max(31).nullable(),
    field:z.string().max(128).nullable(),reason:z.string().min(1).max(256)})).max(32)
}).refine(value=>value.has_more===(value.next_cursor!==null)
  &&(value.provider==='microsoft'?value.provider_result_cap===1000&&!value.query_complete:value.provider_result_cap===null)
  &&(!value.query_complete||!value.has_more&&value.failure_count===0)
  &&(value.status==='unsupported'?value.items.length===0&&!value.has_more&&!value.query_complete&&value.failure_count===0&&value.unsupported.length>0:value.unsupported.length===0)
  &&Buffer.byteLength(JSON.stringify(value))<=1048576);
export type NativeEmailSearchPage=Readonly<z.infer<typeof NativeEmailSearchPageSchema>>;
export type NativeEmailProviderScope=Readonly<{org_id:string;owner_id:string;installation_id:string}>;
export type NativeEmailTriageKind='mark_read'|'mark_unread'|'star'|'unstar'|'archive'|'trash'|'move'|'labels'|'spam'|'not_spam'|'restore';
export type NativeEmailTriageDestination=Readonly<{account_id:string;provider:'gmail'|'microsoft'|'imap_smtp';id:string;kind:'folder'|'label'}>;
export type NativeEmailTriagePlan=Readonly<{schema_version:'deft.email_triage_plan.v1';operation_id:string;
  binding:Readonly<{scope:NativeEmailProviderScope;account:Readonly<Record<string,unknown>>;action_binding_id:string;operations:readonly string[]}>;
  operation:Readonly<Record<string,unknown>>;items:readonly Readonly<{logical_id:string;before:Readonly<Record<string,unknown>>|null;restore_before?:Readonly<Record<string,unknown>>;error_code?:string}>[];
  created_at:number;expires_at:number;digest:string;undo_of?:string}>;
export type NativeEmailTriageValue={plan:NativeEmailTriagePlan;items:{logical_id:string;state:'prepared'|'started'|'succeeded'|'failed'|'unknown';
  after?:Readonly<Record<string,unknown>>|null;code?:string;undo_supported?:boolean}[]};
/** Each write must commit durably before returning, under an exclusive fenced
 * operation lease. Never hold one SQL transaction across provider I/O. */
export interface NativeEmailTriageJournal{
  create(plan:NativeEmailTriagePlan):Promise<NativeEmailTriageValue>;
  load(scope:NativeEmailProviderScope,operation_id:string):Promise<NativeEmailTriageValue|null>;
  change<T>(scope:NativeEmailProviderScope,operation_id:string,callback:(value:NativeEmailTriageValue|null,write:(value:NativeEmailTriageValue)=>Promise<void>)=>Promise<T>|T):Promise<T>;
}
export type NativeEmailTriageOperation=Readonly<
  {kind:Exclude<NativeEmailTriageKind,'labels'>;destination?:NativeEmailTriageDestination;label_action?:never;destinations?:never}
  |{kind:'labels';label_action:'add'|'remove';destinations:readonly NativeEmailTriageDestination[];destination?:never}>;
export type NativeEmailTriageRequest=Readonly<
  {mode:'apply';operation_id:string;operation:NativeEmailTriageOperation;sources:readonly Readonly<Record<string,unknown>>[]}
  |{mode:'status';operation_id:string}|{mode:'undo';operation_id:string;undo_operation_id:string}>;
export type NativeEmailTriageResult=Readonly<{schema_version:'deft.email_native_triage_result.v1';account_id:string;operation_id:string;operation:NativeEmailTriageKind;
  items:readonly Readonly<{logical_message_id:string;state:'prepared'|'succeeded'|'failed'|'unknown';code?:string;undo_supported:boolean;
    confirmed_flags?:Readonly<{seen:boolean|null;flagged:boolean|null;answered:boolean|null}>;confirmed_folders?:readonly string[]}>[];
  undo_available:boolean;automatic_retry:false}>;
export const NativeEmailTriageResultSchema=z.strictObject({schema_version:z.literal('deft.email_native_triage_result.v1'),account_id:NativeEmailId,
  operation_id:z.string().uuid(),operation:z.enum(['mark_read','mark_unread','star','unstar','archive','trash','move','labels','spam','not_spam','restore']),
  items:z.array(z.strictObject({logical_message_id:z.string().regex(/^mail_[a-f0-9]{64}$/u),state:z.enum(['prepared','succeeded','failed','unknown']),
    code:z.string().regex(/^[A-Z0-9_]{1,100}$/u).optional(),undo_supported:z.boolean(),confirmed_flags:z.strictObject({
      seen:z.boolean().nullable(),flagged:z.boolean().nullable(),answered:z.boolean().nullable()}).optional(),
    confirmed_folders:z.array(z.string().regex(/^(?:inbox|sent|spam|trash|drafts|starred|archive|label:[a-f0-9]{64})$/u)).min(1).max(100).refine(ids=>new Set(ids).size===ids.length).optional()})).min(1).max(25),undo_available:z.boolean(),automatic_retry:z.literal(false)
}).refine(value=>new Set(value.items.map(item=>item.logical_message_id)).size===value.items.length
  &&value.undo_available===value.items.some(item=>item.undo_supported)&&value.items.every(item=>(!item.undo_supported||item.state==='succeeded')&&(!item.confirmed_folders||item.state==='succeeded')));
export const NativeEmailFolderSchema=z.strictObject({id:NativeEmailId,label:z.string().min(1).max(512).regex(/^[^\r\n\0]+$/u),kind:z.enum(['label','folder']),
  parent_id:NativeEmailId.nullable(),parent_folder_id:NativeEmailId.nullable(),canonical_role:z.enum(['inbox','sent','spam','trash','drafts','starred','archive']).nullable(),
  folder_id:z.string().regex(/^(?:inbox|sent|spam|trash|drafts|starred|archive|label:[a-f0-9]{64}|folder:[a-f0-9]{64})$/u),move_allowed:z.boolean(),labels_allowed:z.boolean(),rename_allowed:z.boolean().optional()});
export const NativeEmailFolderPageSchema=z.strictObject({schema_version:z.literal('deft.email_native_folders.v1'),account_id:NativeEmailId,provider:z.enum(['gmail','microsoft']),
  items:z.array(NativeEmailFolderSchema).max(100),next_cursor:z.string().min(1).max(90000).nullable(),has_more:z.boolean(),observed_at:z.iso.datetime(),management:z.literal(true).optional()})
  .refine(value=>value.has_more===(value.next_cursor!==null)&&new Set(value.items.map(row=>row.id)).size===value.items.length);
export type NativeEmailFolder=Readonly<z.infer<typeof NativeEmailFolderSchema>>;
export type NativeEmailFolderPage=Readonly<z.infer<typeof NativeEmailFolderPageSchema>>;
export const NativeEmailDestinationSchema=z.strictObject({account_id:NativeEmailId,provider:z.enum(['gmail','microsoft','imap_smtp']),id:NativeEmailId,kind:z.enum(['label','folder'])});
/** SMTP envelope is bound by the trusted serializer to the sealed snapshot. It
 * retains Bcc recipients omitted from SMTP MIME and never comes from browser input. */
export type NativeEmailSendEnvelope=Readonly<{from:string;to:readonly string[]}>;
export type NativeEmailSendRequest=Readonly<{operation_id:string;mime_bytes:Uint8Array;mime_digest:string;from_address:string;thread_id?:string;envelope?:NativeEmailSendEnvelope}>;
export const NativeEmailPrepareSendResultSchema=z.strictObject({schema_version:z.literal('deft.email_prepare_send_result.v1'),account_id:NativeEmailId,provider:z.literal('microsoft'),operation_id:z.string().uuid(),mime_digest:NativeEmailDigestSchema,
 state:z.enum(['ready','pending','unknown','conflict']),limitations:z.array(z.string().min(1).max(128)).max(16),retry_after_ms:z.number().int().min(1000).max(30000).optional()});
export type NativeEmailPrepareSendResult=Readonly<z.infer<typeof NativeEmailPrepareSendResultSchema>>;
export const NativeEmailSendResultSchema=z.strictObject({schema_version:z.literal('deft.email_send_result.v1'),account_id:NativeEmailId,provider:z.enum(['gmail','microsoft','imap_smtp']),
  operation_id:z.string().uuid(),provider_message_id:NativeEmailId.nullable(),transport_outcome:z.literal('provider_accepted'),sent_copy_outcome:z.literal('pending'),delivery_status:z.literal('unknown')})
  .refine(value=>value.provider==='gmail'?value.provider_message_id!==null:value.provider_message_id===null);
export type NativeEmailSendResult=Readonly<z.infer<typeof NativeEmailSendResultSchema>>;
export const NativeEmailSendIdentitySchema=z.strictObject({account_id:NativeEmailId,provider:z.enum(['gmail','microsoft','imap_smtp']),resource_binding_id:NativeEmailId,authority_epoch:z.number().int().positive(),
  implementation_digest:NativeEmailDigestSchema.optional(),
  connection_revision:z.number().int().positive(),principal_digest:NativeEmailDigestSchema,health:z.literal('connected'),capabilities:z.array(z.string().min(1).max(64)).max(6),
  primary_address:z.string().email().max(320),display_label:NativeEmailId,org_id:NativeEmailId,owner_user_id:NativeEmailId,installation_id:NativeEmailId,
  connection_target:NativeEmailId,action_binding_id:NativeEmailId,verified_sender_identities:z.array(z.string().email().max(320)).min(1).max(32)})
  .refine(value=>value.capabilities.includes('send')&&new Set(value.verified_sender_identities).size===value.verified_sender_identities.length);
export type NativeEmailSendIdentity=Readonly<z.infer<typeof NativeEmailSendIdentitySchema>>;
/** Deployment-owned native IMAP bundle bootstrap. The injected closure selects
 * the exact registry pins; this port is never present in browser configuration.
 * Concrete IMAP/SMTP constructors are supplied by the shipped adapter bundle. */
export type NativeEmailImapHost=Readonly<{
  sentCopyMode?(context:NativeEmailConnectionContext,expected:NativeEmailAccount):Promise<'server_managed'|'append'>;
  current(context:NativeEmailConnectionContext,purpose?:'read'|'modify'|'send'):Promise<import('./email-imap-host.js').EmailImapHostAccount>;
  withAuthorizedClient<T>(context:NativeEmailConnectionContext,expected:NativeEmailAccount,
    work:(client:import('./email-imap-host.js').EmailImapFlowClient)=>Promise<T>,purpose?:'read'|'modify'):Promise<T>;
  withAuthorizedSmtp<T>(context:NativeEmailConnectionContext,expected:NativeEmailAccount,
    work:(transport:import('./email-smtp-host.js').EmailSmtpTransport)=>Promise<T>):Promise<T>;
}>;
export type NativeEmailImapHostFactory=(constructors:Readonly<{
  ImapFlow:import('./email-imap-host.js').EmailImapFlowConstructor;
  createTransport:(options:Record<string,unknown>)=>import('./email-smtp-host.js').EmailSmtpTransport&Readonly<{verify?:()=>Promise<boolean>}>;
}>)=>Promise<NativeEmailImapHost>;
export type NativeEmailSnapshotReference=Readonly<{account_id:string;draft_id:string;expected_revision:number}>;
/** Pure server-only serializer; callers supply current verified draft content. */
export type NativeEmailDraftMime=(value:Readonly<Record<string,unknown>>,reference:NativeEmailSnapshotReference)=>Promise<Readonly<{mime_bytes:Uint8Array;mime_digest:string}>>;
export type NativeEmailSnapshotProof=Readonly<{snapshot_id:string;sealed_contract:string;payload:Readonly<Record<string,unknown>>;payload_digest:string;mime_digest:string}>;
export type NativeEmailSnapshot=NativeEmailSnapshotProof&Readonly<{envelope:Readonly<{from:string;to:readonly string[]}>;mime_bytes:Uint8Array;body_bytes:Uint8Array;
  body_html_bytes?:Uint8Array;file_bytes:readonly Uint8Array[]}>;
export type NativeEmailSnapshotReservation=Readonly<{operation_id:string;snapshot_id:string;snapshot_digest:string;mime_digest:string;scope:NativeEmailProviderScope;
  account_id:string;authority_epoch:number;draft_id:string;draft_revision:number}>;
/** Serializer callbacks are supplied only by the trusted current-account host.
 * The registered bundle selects native limits; no browser chooses a profile. */
export type NativeEmailSnapshotFactoryPorts=Readonly<{
  resolve(reference:NativeEmailSnapshotReference):Promise<Readonly<Record<string,unknown>>>;
  seal(input:Readonly<{payload:Readonly<Record<string,unknown>>;payload_digest:string;mime_bytes:Uint8Array;body_bytes:Uint8Array;
    body_html_bytes?:Uint8Array;file_bytes:readonly Uint8Array[]}>):Promise<Readonly<{snapshot_id:string;sealed_contract:string}>>;
  verify(input:NativeEmailSnapshotProof):Promise<boolean>;
  reserve(input:NativeEmailSnapshotReservation):Promise<'reserved'|'replay'|'unknown'>;
}>;
export type NativeEmailSnapshotFactory=(ports:NativeEmailSnapshotFactoryPorts)=>Readonly<{
  prepare(reference:NativeEmailSnapshotReference):Promise<NativeEmailSnapshot>;
  bind(snapshot:NativeEmailSnapshot,operation:Readonly<{operation_id:string;expected_digest:string}>):Promise<Readonly<Record<string,unknown>>&Readonly<{mime_bytes?:Uint8Array;replay?:boolean}>>;
}>;
export const NativeEmailConversationPageSchema=z.strictObject({schema_version:z.literal('deft.email_conversation_page.v1'),account_id:NativeEmailId,provider:z.enum(['gmail','microsoft','imap_smtp']),
  anchor_logical_message_id:z.string().regex(/^mail_[a-f0-9]{64}$/u),items:z.array(EmailMessageRecordSchema).max(100),next_cursor:z.string().min(1).max(8192).nullable(),
  has_more:z.boolean(),observed_at:z.iso.datetime(),failure_count:z.number().int().min(0).max(10000),complete:z.boolean(),
  thread_basis:z.literal('message_headers').optional(),limitations:z.array(z.string().min(1).max(128)).max(32).optional()})
  .refine(value=>value.has_more===(value.next_cursor!==null)&&(!value.complete||!value.has_more&&value.failure_count===0)&&new Set(value.items.map(item=>item.logical_message_id)).size===value.items.length
   &&(value.provider==='imap_smtp'?value.thread_basis==='message_headers'&&!value.complete&&Boolean(value.limitations?.length):value.thread_basis===undefined));
export type NativeEmailConversationPage=Readonly<z.infer<typeof NativeEmailConversationPageSchema>>;
export interface AppConnectionAdapter {
  handle(request: Request, context: AppConnectionContext): Promise<Response>;
  /** Server-only native cache bridge; existing OAuth custody remains private. */
  nativeEmailAccount?(context: NativeEmailConnectionContext): Promise<NativeEmailAccount>;
  /** Host-only retained reconnect; no client secrets or mutable browser routing. */
  nativeEmailConnectionProfile?(context: NativeEmailConnectionContext): Promise<import('./email-native-connection-retained.js').RetainedNativeEmailConnectionProfile>;
  nativeEmailPage?(input: Readonly<{cursor:string|null;limit:number}>, context: NativeEmailConnectionContext):
    Promise<import('./email-mailbox-service.js').EmailProviderPage>;
  nativeEmailSource?(input:Readonly<{source:Readonly<Record<string,unknown>>}>,context:NativeEmailConnectionContext):Promise<NativeEmailSource>;
  nativeEmailPresentation?(input:Readonly<{source:Readonly<Record<string,unknown>>}>,context:NativeEmailConnectionContext):Promise<NativeEmailPresentation>;
  nativeEmailCalendarParts?(input:Readonly<{source:Readonly<Record<string,unknown>>}>,context:NativeEmailConnectionContext):Promise<NativeEmailCalendarParts>;
  nativeEmailFile?(input:Readonly<{source:Readonly<Record<string,unknown>>;source_digest:string;file_ref:string}>,context:NativeEmailConnectionContext):Promise<NativeEmailFile>;
  nativeEmailImage?(input:Readonly<{source:Readonly<Record<string,unknown>>;source_digest:string;image_ref:string}>,context:NativeEmailConnectionContext):Promise<NativeEmailImage>;
  nativeEmailSearch?(input:NativeEmailSearchRequest,context:NativeEmailConnectionContext):Promise<NativeEmailSearchPage>;
  nativeEmailTriage?(input:NativeEmailTriageRequest,context:NativeEmailConnectionContext):Promise<NativeEmailTriageResult>;
  nativeEmailFolders?(input:Readonly<{cursor:string|null;limit:number;management?:true}>,context:NativeEmailConnectionContext):Promise<NativeEmailFolderPage>;
  nativeEmailFolderManage?(input:import('./email-folder-management-contract.js').EmailFolderManageProviderRequest,context:NativeEmailConnectionContext):Promise<import('./email-folder-management-contract.js').EmailFolderManaged>;
  nativeEmailDestination?(input:Readonly<{id:string}>,context:NativeEmailConnectionContext):Promise<NativeEmailTriageDestination>;
  nativeEmailSendIdentity?(context:NativeEmailConnectionContext):Promise<NativeEmailSendIdentity>;
  nativeEmailSend?(input:NativeEmailSendRequest,context:NativeEmailConnectionContext):Promise<NativeEmailSendResult>;
  nativeEmailPrepareSend?(input:NativeEmailSendRequest,context:NativeEmailConnectionContext):Promise<NativeEmailPrepareSendResult>;
  nativeEmailSentCopy?(input:import('./email-sent-copy-contract.js').NativeEmailSentCopyRequest,context:NativeEmailConnectionContext):Promise<import('./email-sent-copy-contract.js').NativeEmailSentCopyResult>;
  nativeEmailSentCopySettings?(context:NativeEmailConnectionContext):Promise<import('./email-sent-copy-contract.js').EmailSentCopySettings>;
  nativeEmailSnapshotFactory?:NativeEmailSnapshotFactory;
  nativeEmailDraftMime?:NativeEmailDraftMime;
  nativeEmailDraftSync?(input:NativeEmailDraftSyncRequest,context:NativeEmailConnectionContext):Promise<NativeEmailDraftSyncResult>;
  nativeEmailConversation?(input:Readonly<{source:Readonly<Record<string,unknown>>;cursor:string|null;limit:number}>,context:NativeEmailConnectionContext):Promise<NativeEmailConversationPage>;
  /** Provider locators are private adapter output; the host discloses scoped UUID handles. */
  browseResource?(input: Readonly<{ operation: 'list' | 'search' | 'conversation'; folder: string;
    query: string;filters?:Readonly<Record<string,string|boolean>>; cursor: string | null; source: Readonly<Record<string, unknown>> | null; limit: number }>,
    context: AppConnectionContext): Promise<Readonly<{ schema_version: string; items: readonly Readonly<{
      revision: string; label: string; data: Readonly<Record<string, string | number | boolean>>;
      provider_source: Readonly<Record<string, unknown>> }>[]; next_cursor: string | null;
      complete: boolean; observed_at: string; count: Readonly<{ returned: number; exact_total: null }>; failure_count: number }>>;
  /** Exact retained record nominated by the host, never a browser provider ID. */
  readResource?(input: Readonly<{ operation: 'read_document'; record: Readonly<{
    record_id: string; revision: string; label: string; data: Readonly<Record<string, string | number | boolean>>;
    provider_source?: Readonly<Record<string, unknown>> }>; }>,
    context: AppConnectionContext): Promise<Readonly<{ format: 'plain' | 'html'; content: string; truncated: boolean; plain_text?: string;
      metadata?: Readonly<Record<string, string | number | boolean>> }>>;
  readSource?(input: Readonly<{record: Readonly<{record_id:string;revision:string;label:string;data:Readonly<Record<string,string|number|boolean>>;provider_source?:Readonly<Record<string,unknown>>}>}>,context:AppConnectionContext):Promise<Readonly<{bytes:Uint8Array;media_type:'message/rfc822';filename:'message.eml'}>>;
  /** Source-derived hosted inspection. Opaque part selectors confer no authority. */
  readSourceFiles?(input: Readonly<{record:Readonly<{record_id:string;revision:string;label:string;data:Readonly<Record<string,string|number|boolean>>;provider_source?:Readonly<Record<string,unknown>>}>;file_ref?:string;image_ref?:string;presentation?:true}>,context:AppConnectionContext):Promise<unknown>;
  readTriageOptions?(input: Readonly<{record:Readonly<{record_id:string;revision:string;label:string;data:Readonly<Record<string,string|number|boolean>>;provider_source?:Readonly<Record<string,unknown>>}>}>,context:AppConnectionContext):Promise<unknown>;
  /** Server-only builder selected by deployment pins, never Worker input. */
  buildActionPayload?(input: Readonly<{
    binding: ActionPayloadBinding; input: Readonly<Record<string, string | number | boolean>>;
    draft_value: Readonly<Record<string, string | number | boolean>>;
    draft_updated_at: string;
    files: readonly Readonly<{ reference: PrivateFileReference; bytes: Uint8Array }>[];
    files_policy?: PrivateFilePolicy; max_payload_bytes: number; expires_at: string;
    source_records?: Readonly<Record<string, readonly HumanActionSourceRecord[]>>;
  }>, context: AppConnectionContext): Promise<Readonly<{ metadata: Record<string, unknown>; bytes: Uint8Array }>>;
}
