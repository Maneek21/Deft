import {SyncDescriptorV2Schema,digestResourceSyncDescriptorV2} from '@deft/app-kit/core';
import type {appResourceBindings} from '@deft/db/schema';
import {attachmentSyncConsentReview} from './app-attachment-sync-consent.js';
import {digestAppGrantValue} from './app-grant-service.js';
import {createAsyncAppAuthorityContentCache} from './app-authority-content-cache.js';

type ReviewInput=Parameters<typeof attachmentSyncConsentReview>[0];
type Binding=Pick<typeof appResourceBindings.$inferSelect,'owner_user_id'|'reviewed_descriptor'|'attachment_policy'|
 'attachment_consent_digest'|'target_key'|'consent_expires_at'|'consent_lifetime'|'max_records_per_page'|'max_page_bytes'|
 'max_retained_records'|'max_retained_bytes'|'min_interval_seconds'>;
const validatedContent=createAsyncAppAuthorityContentCache<true>();
const invalidContent=Symbol('invalid-binding-content');

/** Pure descriptor and consent-byte reconstruction only. Every caller must
 * still reread/lock the current binding and enforce owner, state, membership,
 * epochs, revocation, finite deadlines and the fresh final boundary. A cached
 * true value supplies no authority and never contains a transaction or proof. */
export async function validAttachmentSyncBindingContent(input:{org_id:string;operator_user_id:string;
 binding:Binding;reviewed:ReviewInput['reviewed'];owner_connection_admission?:ReviewInput['owner_connection_admission']}){
 const {binding,reviewed}=input;
 const limits={max_records_per_page:binding.max_records_per_page,max_page_bytes:binding.max_page_bytes,
  max_retained_records:binding.max_retained_records,max_retained_bytes:binding.max_retained_bytes,
  min_interval_seconds:binding.min_interval_seconds};
 const evidence={org_id:input.org_id,owner_user_id:binding.owner_user_id,operator_user_id:input.operator_user_id,
  installation:{id:reviewed.installation.id,lifecycle_epoch:reviewed.installation.lifecycle_epoch,grant_epoch:reviewed.installation.grant_epoch},
  version:{id:reviewed.version.id,package_digest:reviewed.version.package_digest},
  grant:{id:reviewed.grant.id,snapshot_digest:reviewed.grant.snapshot_digest},
  descriptor:reviewed.descriptor,descriptor_digest:reviewed.descriptor_digest,reviewed_descriptor:binding.reviewed_descriptor,
  attachment_policy:binding.attachment_policy,attachment_consent_digest:binding.attachment_consent_digest,target_key:binding.target_key,
  consent_expires_at:binding.consent_expires_at?.toISOString()??null,consent_lifetime:binding.consent_lifetime??null,
  limits,owner_connection_admission:input.owner_connection_admission??null};
 try{
  return await validatedContent({org_id:input.org_id,app_version_id:reviewed.version.id},evidence,async()=>{
   const descriptor=SyncDescriptorV2Schema.parse(binding.reviewed_descriptor);
   if(await digestResourceSyncDescriptorV2(descriptor)!==reviewed.descriptor_digest)throw invalidContent;
   const consent=attachmentSyncConsentReview({org_id:input.org_id,owner_user_id:binding.owner_user_id,
    operator_user_id:input.operator_user_id,reviewed,consent_expires_at:binding.consent_expires_at,
    ...(binding.consent_lifetime?{consent_lifetime:binding.consent_lifetime}:{}),limits,
    attachment_policy:binding.attachment_policy,
    ...(input.owner_connection_admission?{owner_connection_admission:input.owner_connection_admission}:{})});
   if(binding.attachment_consent_digest!==digestAppGrantValue({...consent,
    ...(binding.target_key==='primary'?{}:{target_key:binding.target_key})}))throw invalidContent;
   return true;
  });
 }catch{return false;}
}
