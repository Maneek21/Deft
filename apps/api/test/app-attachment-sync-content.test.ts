import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {parseAttachmentAppManifest,digestResourceSyncDescriptorV2} from '@deft/app-kit/core';
import {attachmentSyncConsentReview} from '../src/lib/app-attachment-sync-consent.js';
import {digestAppGrantValue} from '../src/lib/app-grant-service.js';
import {validAttachmentSyncBindingContent} from '../src/lib/app-attachment-sync-content.js';

async function fixture(){
 const hash='sha256:'+'a'.repeat(64),descriptor=parseAttachmentAppManifest(JSON.parse(readFileSync(new URL('./fixtures/runtime-security-manifest.json',import.meta.url),'utf8'))).sync_descriptors[0]!;
 const reviewed={installation:{id:randomUUID(),lifecycle_epoch:2,grant_epoch:3},version:{id:randomUUID(),package_digest:hash},
  grant:{id:randomUUID(),snapshot_digest:hash},descriptor,descriptor_digest:await digestResourceSyncDescriptorV2(descriptor)};
 const input={org_id:randomUUID(),operator_user_id:randomUUID(),reviewed,binding:{owner_user_id:randomUUID(),
  target_key:'primary',reviewed_descriptor:structuredClone(descriptor),attachment_policy:descriptor.attachments,
  attachment_consent_digest:'',consent_expires_at:new Date(Date.now()+60_000),consent_lifetime:null,
  max_records_per_page:25,max_page_bytes:65536,max_retained_records:1000,max_retained_bytes:1048576,min_interval_seconds:300}};
 input.binding.attachment_consent_digest=digestAppGrantValue(attachmentSyncConsentReview({org_id:input.org_id,
  operator_user_id:input.operator_user_id,owner_user_id:input.binding.owner_user_id,reviewed:reviewed as never,
  consent_expires_at:input.binding.consent_expires_at,limits:input.binding,attachment_policy:input.binding.attachment_policy}));
 return input;
}
const valid=(input:Awaited<ReturnType<typeof fixture>>)=>validAttachmentSyncBindingContent(input as never);

test('warm binding content proofs bind every content, organization, version, grant and epoch input',async()=>{
 const changes=[(x:any)=>{x.org_id=randomUUID();},(x:any)=>{x.operator_user_id=randomUUID();},
  (x:any)=>{x.binding.owner_user_id=randomUUID();},(x:any)=>{x.reviewed.installation.id=randomUUID();},
  (x:any)=>{x.reviewed.installation.lifecycle_epoch++;},(x:any)=>{x.reviewed.installation.grant_epoch++;},
  (x:any)=>{x.reviewed.version.id=randomUUID();},(x:any)=>{x.reviewed.version.package_digest='sha256:'+'b'.repeat(64);},
  (x:any)=>{x.reviewed.grant.id=randomUUID();},(x:any)=>{x.reviewed.grant.snapshot_digest='sha256:'+'b'.repeat(64);},
  (x:any)=>{x.binding.target_key='other';},(x:any)=>{x.binding.max_page_bytes++;},
  (x:any)=>{x.binding.consent_expires_at=new Date(Date.now()+120_000);},
  (x:any)=>{x.binding.attachment_consent_digest='sha256:'+'b'.repeat(64);},
  (x:any)=>{x.binding.reviewed_descriptor={...x.binding.reviewed_descriptor,unknown_inserted_field:true};},
  (x:any)=>{x.binding.attachment_policy={...x.binding.attachment_policy,unknown_inserted_field:true};},
  (x:any)=>{x.owner_connection_admission={admission_id:randomUUID(),admission_digest:'sha256:'+'b'.repeat(64)};}];
 for(const change of changes){const input=await fixture();assert.equal(await valid(input),true);assert.equal(await valid(input),true);
  change(input);assert.equal(await valid(input),false,'changed fresh evidence cannot reuse a warm reconstruction');}
});

test('failed content never seeds a proof and later corrected exact content is independently valid',async()=>{
 const input=await fixture(),original=input.binding.attachment_consent_digest;
 input.binding.attachment_consent_digest='sha256:'+'b'.repeat(64);assert.equal(await valid(input),false);
 input.binding.attachment_consent_digest=original;assert.equal(await valid(input),true);
 input.binding.max_records_per_page++;assert.equal(await valid(input),false);
});
