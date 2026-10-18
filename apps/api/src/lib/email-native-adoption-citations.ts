import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {canonicalAppDataJson} from '@deft/app-kit';
import {db} from './db.js';
import {getAppIntegrationCaptureRuntime} from './app-integration-capture-service.js';
import type {AppIntegrationSourceCaller} from './app-integration-source.js';
import {NativeAdoptionAdmissionSchema,NativeAdoptionReceiptSchema} from './email-native-adoption-publication.js';
import {loadAdoptionRecoveryConfig} from './adoption-recovery-reservation.js';
import {nativeAdoptionRecoveryReader} from './email-native-adoption-recovery.js';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';
const SourceId=z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
const Source=z.object({id:SourceId,org_id:z.string(),owner_user_id:z.string(),account_id:z.string(),logical_message_id:z.string().regex(/^mail_[a-f0-9]{64}$/u),message_revision:z.string(),content_digest:z.string(),source_digest:z.string()});
const Marker=z.object({state:z.literal('runtime_active'),adoption_id:z.string(),source_principal_digest:z.string(),snapshot_digest:z.string(),destination_binding_digest:z.string(),destination_admission_digest:z.string(),runtime_receipt_digest:z.string()});
const Row=z.object({source:Source,marker:Marker,destination:z.object({admission:NativeAdoptionAdmissionSchema,receipt:NativeAdoptionReceiptSchema})});
const denied=()=>new Error('EMAIL_ADOPTED_SOURCE_UNAVAILABLE');
const digest=(value:unknown)=>createHash('sha256').update(canonicalAppDataJson(value)).digest('hex');
export async function loadNativeAdoptionCitation(caller:AppIntegrationSourceCaller,source_id:string){
 const rows=await db.execute(sql`SELECT jsonb_build_object('id',s.id,'org_id',s.org_id,'owner_user_id',s.owner_user_id,'account_id',s.account_id,'logical_message_id',s.logical_message_id,'message_revision',s.message_revision,'content_digest',s.content_digest,'source_digest',s.source_digest) AS source,
  to_jsonb(m) AS marker,jsonb_build_object('admission',d.admission,'receipt',d.receipt) AS destination
  FROM email_knowledge_sources s JOIN native_email_adoptions m USING(org_id,owner_user_id,account_id)
  JOIN native_email_adoption_destinations d USING(org_id,owner_user_id,account_id)
  WHERE s.org_id=${caller.org_id} AND s.owner_user_id=${caller.user_id} AND s.id=${SourceId.parse(source_id)}`);
 if(rows.rows.length!==1)throw denied();return Row.parse(rows.rows[0]);
}
/** Original native citations remain immutable locators. The actual E4 gateway
 * independently authorizes the current imported account/publication twice.
 * No old consent, grant, source digest or native URL supplies read authority. */
export async function openNativeAdoptionCitation(caller:AppIntegrationSourceCaller,source_id:string,recoveryGuard?:WebAuthorityGuard){
 if(caller.kind!=='human')throw denied();const before=await loadNativeAdoptionCitation(caller,source_id),s=before.source,m=before.marker,a=before.destination.admission,r=before.destination.receipt;
 const {receipt_digest,...receiptPins}=r;
 if(s.id!==source_id||s.org_id!==caller.org_id||s.owner_user_id!==caller.user_id||a.scope.org_id!==s.org_id||a.scope.owner_user_id!==s.owner_user_id||a.scope.account_id!==s.account_id
  ||a.destination_scope.org_id!==s.org_id||a.destination_scope.owner_user_id!==s.owner_user_id||a.destination_binding.account_id!==s.account_id
  ||m.adoption_id!==a.adoption_id||m.source_principal_digest!==a.source_principal_digest||m.snapshot_digest!==a.snapshot_digest
  ||m.destination_admission_digest!==digest(a)||m.destination_binding_digest!==digest(a.destination_binding)||m.runtime_receipt_digest!==receipt_digest
  ||digest(receiptPins)!==receipt_digest||r.admission_digest!==digest(a)||r.adoption_id!==a.adoption_id||r.snapshot_digest!==a.snapshot_digest
  ||r.session_id!==a.session_id||r.principal_digest!==a.source_principal_digest||r.account.account_ref!==s.account_id)throw denied();
 if(process.env.DEFT_ADOPTION_RECOVERY_READ_CONFIG){
  const recovery=await loadAdoptionRecoveryConfig();
  if(isDeepStrictEqual(recovery.config.scope,{org_id:s.org_id,owner_user_id:s.owner_user_id,account_id:s.account_id})){
   if(!recoveryGuard||!caller.principal_id)throw denied();
   const reader=await nativeAdoptionRecoveryReader({org_id:caller.org_id,user_id:caller.user_id,sid:caller.principal_id,access_expires_at:caller.access_expires_at},s.account_id,recoveryGuard);
   const message=await reader.message(s.logical_message_id);if(!message||message.revision!==s.message_revision)throw denied();
   await reader.check();if(!isDeepStrictEqual(before,await loadNativeAdoptionCitation(caller,source_id)))throw denied();
   return '/apps/recovery/native-email/'+encodeURIComponent(s.account_id)+'?message='+encodeURIComponent(s.logical_message_id);
  }
 }
 const capture=await getAppIntegrationCaptureRuntime(),account={installation_id:a.destination_scope.installation_id,account_ref:s.account_id,store_key:'drafts'};
 const snapshot=await capture.resolveOpaque(caller,account,s.logical_message_id,'read'),target=snapshot.publication.target;
 if(target.installation_id!==account.installation_id||target.account_ref!==account.account_ref||target.store_key!==account.store_key||target.resource_binding_id!==a.destination_scope.resource_binding_id)throw denied();
 const href=await capture.openIdentity(caller,{...account,ref:target.ref});
 if(!href.startsWith('/apps/')||/[\\\u0000-\u001f\u007f]/u.test(href)||!isDeepStrictEqual(before,await loadNativeAdoptionCitation(caller,source_id)))throw denied();
 return href;
}
