import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {and,asc,eq,gt,sql} from 'drizzle-orm';
import {emailSendOperations,appConnectionSessions} from '@deft/db/schema';
import {canonicalAppDataJson} from '@deft/app-kit/core';
import {db} from './db.js';
import type {ExperienceCaller} from './app-experience-service.js';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';
import type {AppRunTransaction} from './app-run-repository.js';
import {currentAppConnectionReadAuthority} from './app-connection-session-authority.js';
import {NativeAdoptionAdmissionSchema,NativeAdoptionReceiptSchema} from './email-native-adoption-publication.js';
import {assertAdoptionRecoveryReservation,loadAdoptionRecoveryConfig,recoveryDenied} from './adoption-recovery-reservation.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {PostgresEmailMailboxStore} from './email-mailbox-store.js';
import {EmailDraftStore} from './email-draft-store.js';
import {EmailAttachmentStore} from './email-attachment-store.js';
import {EmailAttachmentCrypto} from './email-attachment-crypto.js';
import {EmailOutboxStore} from './email-outbox-store.js';
import {EmailOutboxCrypto} from './email-outbox-crypto.js';
import {EmailSendStore} from './email-send-store.js';
import {AppConnectionSessionRecordSchema} from './app-connection-session-service.js';

const digest=(value:unknown)=>createHash('sha256').update(canonicalAppDataJson(value)).digest('hex');
/** Ordinary owner reads only. No provider, native authority router, Runtime
 * request, scheduling, write or cache-fill port is constructed here. */
export async function nativeAdoptionRecoveryReader(caller:ExperienceCaller,accountId:string,webGuard:WebAuthorityGuard){
 const initial=await loadAdoptionRecoveryConfig(),c=initial.config,s=c.scope,r=c.reservation;
 if(caller.org_id!==s.org_id||caller.user_id!==s.owner_user_id||accountId!==s.account_id)throw recoveryDenied();
 const guard=async(raw:unknown)=>{
  const tx=raw as AppRunTransaction;
  const currentConfig=await loadAdoptionRecoveryConfig();if(currentConfig.digest!==initial.digest)throw recoveryDenied();
  await assertAdoptionRecoveryReservation(c);
  const rows=await tx.execute(sql`SELECT to_jsonb(m) AS marker,d.admission,d.receipt FROM native_email_adoptions m
   JOIN native_email_adoption_destinations d USING(org_id,owner_user_id,account_id)
   WHERE m.org_id=${s.org_id} AND m.owner_user_id=${s.owner_user_id} AND m.account_id=${s.account_id}`);
  if(rows.rows.length!==1)throw recoveryDenied();const row=rows.rows[0]!,m=row.marker as Record<string,unknown>,a=NativeAdoptionAdmissionSchema.parse(row.admission),receipt=NativeAdoptionReceiptSchema.parse(row.receipt),{receipt_digest,...pins}=receipt;
  if(m.state!=='runtime_active'||m.adoption_id!==r.adoption_id||m.snapshot_digest!==r.snapshot_digest||m.runtime_receipt_digest!==r.runtime_receipt_digest
   ||!isDeepStrictEqual(a.scope,s)||a.adoption_id!==r.adoption_id||a.snapshot_digest!==r.snapshot_digest
   ||m.source_principal_digest!==a.source_principal_digest||m.destination_admission_digest!==digest(a)||m.destination_binding_digest!==digest(a.destination_binding)
   ||receipt_digest!==r.runtime_receipt_digest||digest(pins)!==receipt_digest||receipt.admission_digest!==digest(a)
   ||receipt.adoption_id!==a.adoption_id||receipt.snapshot_digest!==a.snapshot_digest||receipt.session_id!==a.session_id
   ||receipt.principal_digest!==a.source_principal_digest||receipt.account.account_ref!==s.account_id
   ||a.destination_scope.org_id!==s.org_id||a.destination_scope.owner_user_id!==s.owner_user_id
   ||a.destination_binding.account_id!==s.account_id||a.destination_binding.resource_binding_id!==a.destination_scope.resource_binding_id
   ||a.destination_binding.connection_target!==a.destination_scope.target_key
   ||!isDeepStrictEqual(a.destination_binding.scope,{org_id:s.org_id,owner_id:s.owner_user_id,installation_id:a.destination_scope.installation_id}))throw recoveryDenied();
  const authority=await currentAppConnectionReadAuthority(caller,{installation_id:a.destination_scope.installation_id,target_key:a.destination_scope.target_key},webGuard,'none',tx);
  if(!isDeepStrictEqual(authority.scope,a.destination_scope)||authority.expires_at<=Date.now()||authority.action_consent||authority.action_consents?.length)throw recoveryDenied();
  const [session]=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,s.org_id),eq(appConnectionSessions.owner_user_id,s.owner_user_id),eq(appConnectionSessions.session_id,a.session_id))).limit(1).for('share');
  if(!session)throw recoveryDenied();const record=AppConnectionSessionRecordSchema.parse(session.record);
  if(record.state!=='connected'||record.session_id!==a.session_id||!isDeepStrictEqual(record.scope,a.destination_scope)
   ||record.runtime_session_ref!==receipt.runtime_session_ref||record.account?.account_ref!==s.account_id)throw recoveryDenied();
  // Keep publication's authority-before-marker lock order. A second selection
  // rejects any marker/destination change during the current authority check.
  const locked=await tx.execute(sql`SELECT to_jsonb(m) AS marker,d.admission,d.receipt FROM native_email_adoptions m
   JOIN native_email_adoption_destinations d USING(org_id,owner_user_id,account_id)
   WHERE m.org_id=${s.org_id} AND m.owner_user_id=${s.owner_user_id} AND m.account_id=${s.account_id} FOR SHARE OF m,d`);
  if(!isDeepStrictEqual(rows.rows,locked.rows))throw recoveryDenied();
  await assertAdoptionRecoveryReservation(c);
 };
 const check=()=>db.transaction(guard);await check();
 const {keys}=await getAppRunRuntime(),crypto=new EmailMailboxCrypto(keys);
 const drafts=new EmailDraftStore(db,crypto),files=new EmailAttachmentStore(db,crypto,new EmailAttachmentCrypto(keys));
 const mailbox=new PostgresEmailMailboxStore(db,crypto),history=new EmailOutboxStore(db,crypto,new EmailOutboxCrypto(keys));
 const sends=new EmailSendStore(db,crypto);
 return {scope:s,check,
  drafts:(cursor:string|null)=>drafts.listSummaries(s,cursor,25,guard),
  draft:(id:string)=>drafts.read(s,id,guard),
  file:(draftId:string,fileId:string)=>files.read(s,draftId,fileId,undefined,guard),
  history:(cursor:string|null)=>history.list(s,25,cursor,guard),
  sendHistory:async(cursor:string|null)=>{await check();const rows=await db.select({operation_id:emailSendOperations.operation_id,draft_id:emailSendOperations.draft_id,draft_revision:emailSendOperations.draft_revision}).from(emailSendOperations).where(and(
   eq(emailSendOperations.org_id,s.org_id),eq(emailSendOperations.owner_user_id,s.owner_user_id),eq(emailSendOperations.account_id,s.account_id),cursor?gt(emailSendOperations.operation_id,cursor):undefined)).orderBy(asc(emailSendOperations.operation_id)).limit(26);
   const items=[];for(const row of rows.slice(0,25)){const value=await sends.status(s,row.draft_id,row.draft_revision,guard);if(!value||value.operation.operation_id!==row.operation_id)throw recoveryDenied();items.push(value);}
   await check();return {items,next_cursor:rows.length>25?rows[24]!.operation_id:null,has_more:rows.length>25};},
  mailbox:async(folder:string,cursor:string|null)=>{await check();const page=await mailbox.readPage(s,{folder,cursor,limit:25});await check();return {...page,items:page.items.map(({provider_source,...item})=>item)};},
  message:async(id:string)=>{await check();const item=await mailbox.readMessage(s,id);await check();if(!item)return null;const {provider_source,...publicItem}=item;return publicItem;}};
}
