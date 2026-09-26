import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AttachmentStageHeaderSchema,canonicalAttachmentJson } from '@deft/app-kit';
import { appAttachmentStages,appResourceProjections,appSyncCheckpoints } from '@deft/db/schema';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import type { AppRunTransaction } from './app-run-repository.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';
import { loadLiveAttachmentSyncBindingAuthority } from './app-attachment-sync-authority.js';
import { attachmentFinalAuthorityIsCurrent,attachmentStale,assertAttachmentBrokerEnabled } from './app-attachment-authority.js';
import { AppAttachmentSecretService } from './app-attachment-secrets.js';
import { AppResourceSyncSecretService } from './app-resource-sync-secrets.js';
import { attachmentStageContext, type AppAttachmentCustodyService } from './app-attachment-custody.js';
import type { AppAttachmentObjectStore } from './app-attachment-object-store.js';
import type { createBoundedAppRunDatabase } from './app-run-bounded-db.js';
type Subject={org_id:string;user_id:string;guard:WebAuthorityGuard};
type Target={binding_id:string;projection_id:string;attachment_id?:string};

/** A stage/ref alone is never permission. Every delivery rechecks the current
 * owner, exact live parent body/generation and selected consent after all I/O. */
export class AppAttachmentOwnerService {
  readonly #secrets:AppAttachmentSecretService;
  readonly #sync:AppResourceSyncSecretService;
  constructor(private readonly database:ReturnType<typeof createBoundedAppRunDatabase>,keys:AppRunKeyProvider,
    private readonly objects:AppAttachmentObjectStore,private readonly custody:AppAttachmentCustodyService) {
    this.#secrets=new AppAttachmentSecretService(keys);this.#sync=new AppResourceSyncSecretService(keys);
  }
  async #load(tx:AppRunTransaction,subject:Subject,target:Target,signal?:AbortSignal) {
    const authority=await loadLiveAttachmentSyncBindingAuthority(tx,{org_id:subject.org_id,
      resource_binding_id:target.binding_id,clock:()=>new Date()});
    if(!authority||authority.binding.owner_user_id!==subject.user_id)throw attachmentStale();
    const [checkpoint]=await tx.select().from(appSyncCheckpoints).where(and(eq(appSyncCheckpoints.org_id,subject.org_id),
      eq(appSyncCheckpoints.resource_binding_id,target.binding_id))).limit(1).for('share');
    if(!checkpoint)throw attachmentStale();
    const [parent]=await tx.select().from(appResourceProjections).where(and(eq(appResourceProjections.org_id,subject.org_id),
      eq(appResourceProjections.id,target.projection_id),eq(appResourceProjections.resource_binding_id,target.binding_id),
      eq(appResourceProjections.checkpoint_id,checkpoint.id),eq(appResourceProjections.generation,checkpoint.generation),
      eq(appResourceProjections.state,'live'))).limit(1).for('share');
    if(!parent)throw attachmentStale();
    const body=z.strictObject({revision:z.string(),data:z.record(z.string(),z.union([z.string(),z.number(),z.boolean()]))}).parse(this.#sync.openJson({
      schema_version:parent.body_envelope_version,algorithm:parent.body_algorithm,key_version:parent.body_key_version,
      nonce_b64:parent.body_nonce_b64,ciphertext_b64:parent.body_ciphertext_b64,auth_tag_b64:parent.body_auth_tag_b64},
    {org_id:subject.org_id,resource_binding_id:target.binding_id,checkpoint_id:checkpoint.id,payload_kind:'projection',
      generation:checkpoint.generation,projection_id:parent.id,slot:'record'}));
    const rows=await tx.select().from(appAttachmentStages).where(and(eq(appAttachmentStages.org_id,subject.org_id),
      eq(appAttachmentStages.resource_binding_id,target.binding_id),eq(appAttachmentStages.checkpoint_id,checkpoint.id),
      eq(appAttachmentStages.generation,checkpoint.generation),eq(appAttachmentStages.projection_id,parent.id),
      inArray(appAttachmentStages.state,['linked','linked_blocked']),
      ...(target.attachment_id?[eq(appAttachmentStages.id,target.attachment_id)]:[]))).limit(9).for('share');
    if(rows.length>8||(target.attachment_id&&rows.length!==1))throw attachmentStale();
    const selected=rows.map(row=>{
      if(!row.linked_expires_at||row.linked_expires_at<=new Date())throw attachmentStale();
      const scope={org_id:subject.org_id,resource_binding_id:target.binding_id,checkpoint_id:checkpoint.id};
      if(this.#secrets.fingerprint('parent_body',Buffer.from(canonicalAttachmentJson(body)),scope,row.fingerprint_key_version).fingerprint!==row.parent_body_hmac)throw attachmentStale();
      const header=AttachmentStageHeaderSchema.parse(this.#secrets.openMetadataJson(row.metadata_envelope,attachmentStageContext(row)));
      return {row,metadata:{attachment_id:row.id,filename:header.filename,media_type:header.declared_media_type,
        size_bytes:row.declared_size_bytes,state:row.state==='linked'?'available' as const:'blocked' as const}};
    });
    if(!await attachmentFinalAuthorityIsCurrent(tx,[authority.binding.owner_user_id,authority.registration.operator_user_id],
      {guard:subject.guard,signal,expires_at:[authority.binding.consent_expires_at!,...rows.map(row=>row.linked_expires_at!)]}))throw attachmentStale();
    return selected;
  }
  async list(subject:Subject,target:Target,signal:AbortSignal) {
    assertAttachmentBrokerEnabled();
    const entries=await this.database.transaction(tx=>this.#load(tx,subject,target,signal),signal,performance.now()+10_000);
    return {schema_version:'deft.app_attachment_catalog.v1',attachments:entries.map(entry=>entry.metadata)};
  }
  async content(subject:Subject,target:Target,externalSignal:AbortSignal) {
    assertAttachmentBrokerEnabled();
    return this.custody.transfer(async(signal,deadline)=>{
      const [first]=await this.database.transaction(tx=>this.#load(tx,subject,target,signal),signal,deadline);
      if(!first||first.row.state!=='linked'||!first.row.object_id||!first.row.binary_key_version
        ||!first.row.binary_nonce_b64||!first.row.binary_auth_tag_b64)throw attachmentStale();
      const cipher=await this.objects.get(first.row.object_id,signal);let bytes:Buffer|undefined;
      try {
        bytes=this.#secrets.openBinary({ciphertext:cipher,key_version:first.row.binary_key_version,
          nonce_b64:first.row.binary_nonce_b64,auth_tag_b64:first.row.binary_auth_tag_b64},attachmentStageContext(first.row));
        if(bytes.length!==first.row.declared_size_bytes||this.#secrets.fingerprint('content',bytes,
          {org_id:subject.org_id,resource_binding_id:target.binding_id,checkpoint_id:first.row.checkpoint_id},
          first.row.fingerprint_key_version).fingerprint!==first.row.content_hmac)throw attachmentStale();
        const [last]=await this.database.transaction(tx=>this.#load(tx,subject,target,signal),signal,deadline);
        if(!last||canonicalAttachmentJson([last.row.id,last.row.generation,last.row.state,last.row.object_id,last.row.binary_key_version,last.row.binary_nonce_b64,last.row.binary_auth_tag_b64,last.row.content_hmac,last.row.parent_body_hmac,last.row.metadata_envelope,last.row.linked_expires_at?.toISOString()])!==canonicalAttachmentJson([first.row.id,first.row.generation,first.row.state,first.row.object_id,first.row.binary_key_version,first.row.binary_nonce_b64,first.row.binary_auth_tag_b64,first.row.content_hmac,first.row.parent_body_hmac,first.row.metadata_envelope,first.row.linked_expires_at?.toISOString()]))throw attachmentStale();
        signal.throwIfAborted();const delivered=Buffer.from(bytes);
        return {...last.metadata,bytes:delivered};
      }finally{cipher.fill(0);bytes?.fill(0);}
    },externalSignal);
  }
}
