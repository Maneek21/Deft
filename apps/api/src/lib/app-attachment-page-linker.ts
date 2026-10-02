import { and, eq, inArray } from 'drizzle-orm';
import { appAttachmentStages, appSyncCheckpoints } from '@deft/db/schema';
import { AttachmentStageHeaderSchema, canonicalAttachmentJson, type SyncPageV2 } from '@deft/app-kit';
import type { AppRunTransaction } from './app-run-repository.js';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import { AppAttachmentSecretService } from './app-attachment-secrets.js';
import { attachmentStageContext } from './app-attachment-custody.js';
import { attachmentStale } from './app-attachment-authority.js';
import { parseAttachmentConsentPolicy } from './app-attachment-policy.js';
import { retainedAttachmentMetadataCapacity } from './app-attachment-capacity.js';
import type { appResourceBindings } from '@deft/db/schema';

export type AttachmentAppliedParent = { projection_id: string; id: string; revision: string;
  state: 'live' | 'tombstone'; data?: Record<string,string|number|boolean> };
/** Called only by channel3's normal store inside the same Run/result/receipt
 * transaction. The store has resolved host projection IDs under checkpoint
 * UPDATE; a stage ID or provider locator never creates independent authority. */
export class AppAttachmentPageLinker {
  readonly #secrets: AppAttachmentSecretService;
  constructor(keys: AppRunKeyProvider) { this.#secrets = new AppAttachmentSecretService(keys); }
  async link(tx: AppRunTransaction, input: { org_id: string; run_id: string; attempt_id: string;
    checkpoint_id: string; generation: number; binding: typeof appResourceBindings.$inferSelect;
    page: SyncPageV2; parents: readonly AttachmentAppliedParent[]; clock: () => Date }) {
    const scope = { org_id:input.org_id,resource_binding_id:input.binding.id,checkpoint_id:input.checkpoint_id };
    const policy = parseAttachmentConsentPolicy(input.binding.reviewed_descriptor.attachments,input.binding.attachment_policy);
    const now = input.clock();
    if (!Number.isFinite(now.getTime())) throw attachmentStale();
    for (const parent of input.parents) {
      await tx.update(appAttachmentStages).set({ state:'retired',retired_at:now,updated_at:now })
        .where(and(eq(appAttachmentStages.org_id,input.org_id),eq(appAttachmentStages.resource_binding_id,input.binding.id),
          eq(appAttachmentStages.checkpoint_id,input.checkpoint_id),eq(appAttachmentStages.generation,input.generation),
          eq(appAttachmentStages.projection_id,parent.projection_id),inArray(appAttachmentStages.state,['linked','linked_blocked'])));
      if (parent.state === 'tombstone') continue;
      const upsert = input.page.upserts.find(item => item.id === parent.id);
      if (!upsert || upsert.revision !== parent.revision || upsert.attachments.length > policy.max_attachments_per_record) throw attachmentStale();
      for (const ref of upsert.attachments) {
        const [stage] = await tx.select().from(appAttachmentStages).where(and(eq(appAttachmentStages.org_id,input.org_id),
          eq(appAttachmentStages.id,ref.staging_id),eq(appAttachmentStages.resource_binding_id,input.binding.id),
          eq(appAttachmentStages.checkpoint_id,input.checkpoint_id),eq(appAttachmentStages.generation,input.generation),
          eq(appAttachmentStages.run_id,input.run_id),eq(appAttachmentStages.attempt_id,input.attempt_id))).limit(1).for('update');
        if (!stage || !['ready','blocked'].includes(stage.state) || stage.stage_expires_at <= input.clock()) throw attachmentStale();
        const fingerprint = (domain:'parent_locator'|'parent_revision'|'attachment_key'|'parent_body',value:string) =>
          this.#secrets.fingerprint(domain,Buffer.from(value),scope,stage.fingerprint_key_version).fingerprint;
        if (stage.parent_locator_hmac !== fingerprint('parent_locator',parent.id)
          || stage.parent_revision_hmac !== fingerprint('parent_revision',parent.revision)
          || stage.attachment_key_hmac !== fingerprint('attachment_key',ref.attachment_key)) throw attachmentStale();
        const metadata = AttachmentStageHeaderSchema.parse(this.#secrets.openMetadataJson(stage.metadata_envelope,attachmentStageContext(stage)));
        if (metadata.parent_resource_id !== parent.id || metadata.parent_revision !== parent.revision
          || metadata.attachment_key !== ref.attachment_key || metadata.run_id !== input.run_id
          || metadata.attempt_id !== input.attempt_id || metadata.declared_size_bytes !== stage.declared_size_bytes
          || stage.declared_size_bytes > policy.max_attachment_bytes || !policy.allowed_media_types.includes(metadata.declared_media_type)) throw attachmentStale();
        const acceptedAt = input.clock(), linkedExpiry = new Date(acceptedAt.getTime()+policy.retention_days*86400000);
        const [linked] = await tx.update(appAttachmentStages).set({ state:stage.state === 'ready' ? 'linked' : 'linked_blocked',
          projection_id:parent.projection_id,parent_body_hmac:fingerprint('parent_body',canonicalAttachmentJson({revision:parent.revision,data:parent.data})),
          accepted_at:acceptedAt,linked_expires_at:linkedExpiry,updated_at:acceptedAt })
          .where(and(eq(appAttachmentStages.org_id,input.org_id),eq(appAttachmentStages.id,stage.id),eq(appAttachmentStages.state,stage.state))).returning({id:appAttachmentStages.id});
        if (!linked) throw attachmentStale();
      }
    }
    const metadata = await retainedAttachmentMetadataCapacity(tx,scope);
    const [checkpoint] = await tx.select({ bytes:appSyncCheckpoints.retained_bytes,cursor:appSyncCheckpoints.cursor_bytes })
      .from(appSyncCheckpoints).where(and(eq(appSyncCheckpoints.org_id,input.org_id),eq(appSyncCheckpoints.id,input.checkpoint_id),eq(appSyncCheckpoints.resource_binding_id,input.binding.id))).limit(1);
    if (!checkpoint || checkpoint.bytes+checkpoint.cursor+metadata.bytes > input.binding.max_retained_bytes) throw attachmentStale();
  }
}
