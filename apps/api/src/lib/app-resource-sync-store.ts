import { SyncDescriptorV2Schema, SyncRequestV2Schema, parseSyncPageV2, digestResourceSyncDescriptorV2,
  canonicalAttachmentJson, type SyncPageV2 } from '@deft/app-kit';
import { retainedAttachmentMetadataCapacity } from './app-attachment-capacity.js';
import type { AppAttachmentPageLinker, AttachmentAppliedParent } from './app-attachment-page-linker.js';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  appResourceBindings, appResourceProjections, appRunAttempts, appRuns,
  appSyncCheckpoints, appSyncIntents,
} from '@deft/db/schema';
import {
  canonicalSyncPageJson, digestResourceSyncDescriptor, parseSyncDescriptor,
  parseSyncPage, parseSyncRequest,
} from '@deft/app-kit/experimental/resource-sync';
import type { AppRunTransaction } from './app-run-repository.js';
import type { AppRunSecretRepository } from './app-run-secret-repository.js';
import { AppResourceSyncSecretService } from './app-resource-sync-secrets.js';
import type { AppRunSecretEnvelope } from './app-run-secrets.js';

/** This primitive is deliberately not connected to either Runtime channel.
 * Its caller must first lock the Run and verify live authority, session,
 * claim, lease and exact-result replay, then retain this transaction through
 * output settlement and receipt writing. A thrown error rolls back the page. */
export class AppResourceSyncStore {
  constructor(
    private readonly secrets: AppResourceSyncSecretService,
    private readonly runInputs: AppRunSecretRepository,
    private readonly attachmentMode?: { linker: AppAttachmentPageLinker },
  ) {}

  async applyPageInTransaction(tx: AppRunTransaction, input: Readonly<{
    org_id: string; run_id: string; attempt_id: string; page: unknown;
    clock: () => Date;
  }>): Promise<Readonly<{
    page_digest: string; applied_sequence: number; upserts: number;
    tombstones: number; has_more: boolean;
  }>> {
    // Preserve the existing Run -> authority -> attempt -> checkpoint order.
    // The caller owns the authority locks; repeating the Run/attempt locks is
    // safe and makes direct test calls use the same locked ancestry.
    await tx.execute(sql`SELECT id FROM app_runs WHERE org_id = ${input.org_id}
      AND id = ${input.run_id} FOR UPDATE`);
    const [run] = await tx.select().from(appRuns).where(and(
      eq(appRuns.org_id, input.org_id), eq(appRuns.id, input.run_id),
    )).limit(1);
    if (!run || run.origin_kind !== 'app' || run.provider_kind !== 'app_runtime'
      || run.initiating_actor_type !== 'system' || run.execution_actor_type !== 'system'
      || !run.origin_resource_binding_id
      || run.initiating_actor_id !== run.origin_resource_binding_id
      || run.execution_actor_id !== run.origin_resource_binding_id
      || run.state !== 'running' || !run.execution_released_at
      || run.cancel_requested_at) {
      throw new Error('APP_RESOURCE_SYNC_RUN_NOT_RELEASED');
    }
    await tx.execute(sql`SELECT id FROM app_run_attempts WHERE org_id = ${input.org_id}
      AND id = ${input.attempt_id} FOR UPDATE`);
    const [attempt] = await tx.select().from(appRunAttempts).where(and(
      eq(appRunAttempts.org_id, input.org_id), eq(appRunAttempts.id, input.attempt_id),
      eq(appRunAttempts.run_id, run.id),
    )).limit(1);
    if (!attempt || attempt.resource_binding_id !== run.origin_resource_binding_id
      || attempt.state !== 'provider_call_started'
      || !attempt.lease_expires_at || attempt.provider_call_finished_at
      || attempt.runtime_result_hmac) {
      throw new Error('APP_RESOURCE_SYNC_ATTEMPT_NOT_CURRENT');
    }
    const [intent] = await tx.select().from(appSyncIntents).where(and(
      eq(appSyncIntents.org_id, input.org_id), eq(appSyncIntents.run_id, run.id),
    )).limit(1);
    if (!intent || intent.resource_binding_id !== run.origin_resource_binding_id
      || intent.app_installation_id !== run.origin_app_installation_id
      || intent.app_version_id !== run.origin_app_version_id
      || intent.grant_snapshot_id !== run.origin_app_grant_snapshot_id
      || intent.provider_snapshot_id !== run.provider_snapshot_id) {
      throw new Error('APP_RESOURCE_SYNC_INTENT_MISMATCH');
    }
    const [binding] = await tx.select().from(appResourceBindings).where(and(
      eq(appResourceBindings.org_id, input.org_id), eq(appResourceBindings.id, intent.resource_binding_id),
    )).limit(1);
    if (!binding || binding.state !== 'active' || !binding.consent_expires_at
      || binding.owner_user_id !== intent.owner_user_id
      || binding.app_installation_id !== intent.app_installation_id
      || binding.app_version_id !== intent.app_version_id
      || binding.grant_snapshot_id !== intent.grant_snapshot_id
      || binding.provider_snapshot_id !== intent.provider_snapshot_id
      || binding.descriptor_digest !== intent.descriptor_digest
      || binding.operation_name !== run.operation_name
      || binding.provider_instance_id !== run.provider_instance_id
      || binding.risk_class !== run.risk_class
      || binding.review_requirement !== run.review_requirement
      || binding.review_scope !== run.review_scope
      || binding.retry_class !== run.retry_class
      || binding.retention_class !== run.retention_class) {
      throw new Error('APP_RESOURCE_SYNC_BINDING_MISMATCH');
    }
    const descriptor = this.attachmentMode ? SyncDescriptorV2Schema.parse(binding.reviewed_descriptor) : parseSyncDescriptor(binding.reviewed_descriptor);
    if (binding.registration_contract_version !== (this.attachmentMode ? 'deft.app_runtime_channel.v3' : 'deft.app_runtime_channel.v2')) throw new Error('APP_RESOURCE_SYNC_BINDING_MISMATCH');
    if (descriptor.key !== binding.resource_key
      || descriptor.resource_type !== binding.resource_family
      || await (this.attachmentMode ? digestResourceSyncDescriptorV2(SyncDescriptorV2Schema.parse(descriptor))
        : digestResourceSyncDescriptor(parseSyncDescriptor(descriptor))) !== binding.descriptor_digest) {
      throw new Error('APP_RESOURCE_SYNC_DESCRIPTOR_MISMATCH');
    }
    await tx.execute(sql`SELECT id FROM app_sync_checkpoints WHERE org_id = ${input.org_id}
      AND id = ${intent.checkpoint_id} AND resource_binding_id = ${intent.resource_binding_id}
      FOR UPDATE`);
    const [checkpoint] = await tx.select().from(appSyncCheckpoints).where(and(
      eq(appSyncCheckpoints.org_id, input.org_id), eq(appSyncCheckpoints.id, intent.checkpoint_id),
      eq(appSyncCheckpoints.resource_binding_id, intent.resource_binding_id),
    )).limit(1);
    if (!checkpoint || checkpoint.state !== 'active'
      || checkpoint.generation !== intent.generation
      || checkpoint.cursor_sequence !== intent.expected_cursor_sequence
      || checkpoint.cursor_hmac_key_version !== intent.expected_cursor_hmac_key_version
      || checkpoint.cursor_hmac !== intent.expected_cursor_hmac) {
      throw new Error('APP_RESOURCE_SYNC_START_CURSOR_STALE');
    }
    // A checkpoint lock may have waited past a lease or consent deadline.
    // Read the host clock only after the final lock, before releasing input or
    // writing provider records; the caller also checks live authority here.
    const checkedAt = input.clock();
    if (!Number.isFinite(checkedAt.getTime())) throw new TypeError('Invalid settlement time');
    if (run.input_expires_at <= checkedAt || attempt.lease_expires_at <= checkedAt
      || binding.consent_expires_at <= checkedAt) {
      throw new Error('APP_RESOURCE_SYNC_SETTLEMENT_EXPIRED');
    }
    const currentCursorContext = { org_id: input.org_id,
      resource_binding_id: intent.resource_binding_id, checkpoint_id: checkpoint.id,
      payload_kind: 'cursor' as const, generation: checkpoint.generation,
      cursor_sequence: checkpoint.cursor_sequence };
    const cursorValue = checkpoint.cursor_state === 'empty' ? null : this.secrets.openJson({
      schema_version: checkpoint.cursor_envelope_version,
      algorithm: checkpoint.cursor_algorithm, key_version: checkpoint.cursor_key_version,
      nonce_b64: checkpoint.cursor_nonce_b64,
      ciphertext_b64: checkpoint.cursor_ciphertext_b64,
      auth_tag_b64: checkpoint.cursor_auth_tag_b64,
    }, currentCursorContext);
    if (cursorValue !== null && typeof cursorValue !== 'string') {
      throw new Error('APP_RESOURCE_SYNC_CURSOR_INVALID');
    }
    const verifiedCursor = this.secrets.cursorFingerprint(cursorValue, currentCursorContext,
      checkpoint.cursor_hmac_key_version);
    if (verifiedCursor.fingerprint !== checkpoint.cursor_hmac) {
      throw new Error('APP_RESOURCE_SYNC_CURSOR_HMAC_MISMATCH');
    }
    const exactInput = await this.runInputs.readInput(input.org_id, run.id, tx);
    const startingRequest = this.attachmentMode ? SyncRequestV2Schema.parse(exactInput) : parseSyncRequest(exactInput);
    if (startingRequest.cursor !== cursorValue
      || startingRequest.max_items > binding.max_records_per_page) {
      throw new Error('APP_RESOURCE_SYNC_RUN_INPUT_MISMATCH');
    }
    const page = this.attachmentMode ? parseSyncPageV2(descriptor,startingRequest,input.page) : parseSyncPage(descriptor,startingRequest,input.page);
    const pageJson = this.attachmentMode ? canonicalAttachmentJson(page) : canonicalSyncPageJson(page);
    if (Buffer.byteLength(pageJson, 'utf8') > binding.max_page_bytes) {
      throw new Error('APP_RESOURCE_SYNC_PAGE_TOO_LARGE');
    }
    const pageDigest = `sha256:${createHash('sha256').update(pageJson).digest('hex')}`;
    const nextSequence = checkpoint.cursor_sequence + 1;
    const locatorContext = { org_id: input.org_id,
      resource_binding_id: intent.resource_binding_id, checkpoint_id: checkpoint.id };
    // The inventory is under the checkpoint lock. A lost historical locator
    // key must fail even when a new ID appears to have no matching row.
    const retainedVersions = await tx.selectDistinct({
      key_version: appResourceProjections.resource_id_hmac_key_version,
    }).from(appResourceProjections).where(and(
      eq(appResourceProjections.org_id, input.org_id),
      eq(appResourceProjections.checkpoint_id, checkpoint.id),
    ));
    const requiredKeys = retainedVersions.map((row) => row.key_version);
    this.secrets.assertLocatorKeyVersionsAvailable(requiredKeys);
    const checkpointId = checkpoint.id;
    const checkpointGeneration = checkpoint.generation;
    async function candidatesFor(resourceId: string, secrets: AppResourceSyncSecretService) {
      const fingerprints = secrets.locatorCandidates(resourceId, locatorContext, requiredKeys);
      const matches = await tx.select().from(appResourceProjections).where(and(
        eq(appResourceProjections.org_id, input.org_id),
        eq(appResourceProjections.checkpoint_id, checkpointId),
        inArray(appResourceProjections.resource_id_hmac_key_version,
          fingerprints.map((item) => item.key_version)),
        inArray(appResourceProjections.resource_id_hmac,
          fingerprints.map((item) => item.fingerprint)),
      ));
      const exact = matches.filter((row) => fingerprints.some((fingerprint) =>
        row.resource_id_hmac_key_version === fingerprint.key_version
        && row.resource_id_hmac === fingerprint.fingerprint));
      if (exact.length > 1) throw new Error('APP_RESOURCE_SYNC_AMBIGUOUS_LOCATOR');
      const row = exact[0];
      if (row) {
        const oldProviderId = secrets.openJson({
          schema_version: row.provider_id_envelope_version,
          algorithm: row.provider_id_algorithm,
          key_version: row.provider_id_key_version,
          nonce_b64: row.provider_id_nonce_b64,
          ciphertext_b64: row.provider_id_ciphertext_b64,
          auth_tag_b64: row.provider_id_auth_tag_b64,
        }, { ...locatorContext, payload_kind: 'projection',
          generation: row.generation, projection_id: row.id, slot: 'provider_id' });
        if (oldProviderId !== resourceId || row.generation !== checkpointGeneration) {
          throw new Error('APP_RESOURCE_SYNC_LOCATOR_IDENTITY_MISMATCH');
        }
      }
      return row ?? null;
    }
    const parents: AttachmentAppliedParent[] = [];
    const writeProjection = async (item: { id: string; revision: string;
      data?: Record<string, string | number | boolean> }, state: 'live' | 'tombstone') => {
      const prior = await candidatesFor(item.id, this.secrets);
      const projectionId = prior?.id ?? randomUUID();
      const context = { ...locatorContext, payload_kind: 'projection' as const,
        generation: checkpoint.generation, projection_id: projectionId };
      const bodyEnvelope = state === 'live'
        ? this.secrets.sealJson({ revision: item.revision, data: item.data },
          { ...context, slot: 'record' }) : null;
      const candidateIdEnvelope = this.secrets.sealJson(item.id,
        { ...context, slot: 'provider_id' });
      const idEnvelope = !prior || candidateIdEnvelope.key_version !== prior.provider_id_key_version
        ? candidateIdEnvelope : null;
      if (prior && idEnvelope) {
        // Only after decrypting and matching the old provider ID above may a
        // page rewrap the retained identity to the current AES version.
        await tx.execute(sql`SET LOCAL deft.app_resource_sync_rekey = 'on'`);
      }
      const idColumns = idEnvelope ? {
        provider_id_envelope_version: idEnvelope.schema_version,
        provider_id_algorithm: idEnvelope.algorithm,
        provider_id_key_version: idEnvelope.key_version,
        provider_id_nonce_b64: idEnvelope.nonce_b64,
        provider_id_ciphertext_b64: idEnvelope.ciphertext_b64,
        provider_id_auth_tag_b64: idEnvelope.auth_tag_b64,
        provider_id_bytes: ciphertextBytes(idEnvelope),
      } : {};
      const bodyColumns = bodyEnvelope ? {
        body_envelope_version: bodyEnvelope.schema_version,
        body_algorithm: bodyEnvelope.algorithm,
        body_key_version: bodyEnvelope.key_version,
        body_nonce_b64: bodyEnvelope.nonce_b64,
        body_ciphertext_b64: bodyEnvelope.ciphertext_b64,
        body_auth_tag_b64: bodyEnvelope.auth_tag_b64,
        body_bytes: ciphertextBytes(bodyEnvelope),
      } : { body_envelope_version: null, body_algorithm: null, body_key_version: null,
        body_nonce_b64: null, body_ciphertext_b64: null, body_auth_tag_b64: null,
        body_bytes: 0 };
      if (prior) {
        await tx.update(appResourceProjections).set({ ...idColumns, ...bodyColumns,
          state, applied_sequence: nextSequence, last_seen_at: checkedAt,
          source_updated_at: null, fresh_until: null,
          tombstoned_at: state === 'tombstone' ? checkedAt : null,
          updated_at: checkedAt,
        }).where(and(eq(appResourceProjections.org_id, input.org_id),
          eq(appResourceProjections.id, prior.id)));
        if (idEnvelope) await tx.execute(sql`SET LOCAL deft.app_resource_sync_rekey = 'off'`);
      } else {
        const locator = this.secrets.locator(item.id, locatorContext);
        await tx.insert(appResourceProjections).values({
          id: projectionId, org_id: input.org_id,
          resource_binding_id: intent.resource_binding_id, checkpoint_id: checkpoint.id,
          generation: checkpoint.generation,
          resource_id_hmac_key_version: locator.key_version,
          resource_id_hmac: locator.fingerprint,
          ...idColumns, ...bodyColumns, state, applied_sequence: nextSequence,
          first_seen_at: checkedAt, last_seen_at: checkedAt,
          tombstoned_at: state === 'tombstone' ? checkedAt : null,
          fresh_until: null,
        } as typeof appResourceProjections.$inferInsert);
      }
      parents.push({ projection_id:projectionId,id:item.id,revision:item.revision,state,...(item.data ? {data:item.data} : {}) });
    };
    // Tombstones first let a replacement page reclaim body bytes before
    // upserts are capacity-accounted by database triggers.
    for (const item of page.tombstones) await writeProjection(item, 'tombstone');
    for (const item of page.upserts) await writeProjection(item, 'live');
    if (this.attachmentMode) await this.attachmentMode.linker.link(tx, { org_id:input.org_id,run_id:run.id,attempt_id:attempt.id,
      checkpoint_id:checkpoint.id,generation:checkpoint.generation,binding,page:page as SyncPageV2,parents,clock:input.clock });
    const [accounted] = await tx.select({ count: appSyncCheckpoints.retained_record_count,
      bytes: appSyncCheckpoints.retained_bytes }).from(appSyncCheckpoints).where(and(
      eq(appSyncCheckpoints.org_id, input.org_id), eq(appSyncCheckpoints.id, checkpoint.id),
    )).limit(1);
    if (!accounted || accounted.count > binding.max_retained_records
      || accounted.bytes > binding.max_retained_bytes) {
      throw new Error('APP_RESOURCE_SYNC_CAPACITY_EXCEEDED');
    }
    const nextCursorContext = { ...currentCursorContext, cursor_sequence: nextSequence };
    const nextCursorHmac = this.secrets.cursorFingerprint(page.next_cursor, nextCursorContext);
    const nextCursorEnvelope = page.next_cursor === null ? null
      : this.secrets.sealJson(page.next_cursor, nextCursorContext);
    if(this.attachmentMode){const retained=await retainedAttachmentMetadataCapacity(tx,{org_id:input.org_id,resource_binding_id:binding.id,checkpoint_id:checkpoint.id});
      if(accounted.bytes+(nextCursorEnvelope?ciphertextBytes(nextCursorEnvelope):0)+retained.bytes>binding.max_retained_bytes)
        throw new Error('APP_ATTACHMENT_COMBINED_CAPACITY_EXCEEDED');}
    const [applied] = await tx.update(appSyncCheckpoints).set({
      cursor_sequence: nextSequence,
      cursor_hmac_key_version: nextCursorHmac.key_version,
      cursor_hmac: nextCursorHmac.fingerprint,
      cursor_state: nextCursorEnvelope ? 'value' : 'empty',
      cursor_envelope_version: nextCursorEnvelope?.schema_version ?? null,
      cursor_algorithm: nextCursorEnvelope?.algorithm ?? null,
      cursor_key_version: nextCursorEnvelope?.key_version ?? null,
      cursor_nonce_b64: nextCursorEnvelope?.nonce_b64 ?? null,
      cursor_ciphertext_b64: nextCursorEnvelope?.ciphertext_b64 ?? null,
      cursor_auth_tag_b64: nextCursorEnvelope?.auth_tag_b64 ?? null,
      cursor_bytes: nextCursorEnvelope ? ciphertextBytes(nextCursorEnvelope) : 0,
      last_applied_run_id: run.id, last_applied_page_digest: pageDigest,
      last_applied_at: checkedAt, last_checked_at: checkedAt,
      fresh_until: null, updated_at: checkedAt,
    }).where(and(eq(appSyncCheckpoints.org_id, input.org_id),
      eq(appSyncCheckpoints.id, checkpoint.id),
      eq(appSyncCheckpoints.generation, intent.generation),
      eq(appSyncCheckpoints.cursor_sequence, intent.expected_cursor_sequence),
    )).returning({ id: appSyncCheckpoints.id });
    if (!applied) throw new Error('APP_RESOURCE_SYNC_CURSOR_CAS_FAILED');
    // A bounded page can still outlive its lease while writing many rows.
    // The caller performs its own final settlement check after this helper;
    // this last local check rolls back the entire page if time ran out here.
    const completedAt = input.clock();
    if (!Number.isFinite(completedAt.getTime())) throw new TypeError('Invalid settlement time');
    if (run.input_expires_at <= completedAt || attempt.lease_expires_at <= completedAt
      || binding.consent_expires_at <= completedAt) {
      throw new Error('APP_RESOURCE_SYNC_SETTLEMENT_EXPIRED');
    }
    return Object.freeze({ page_digest: pageDigest, applied_sequence: nextSequence,
      upserts: page.upserts.length, tombstones: page.tombstones.length,
      has_more: page.has_more });
  }
}

function ciphertextBytes(envelope: AppRunSecretEnvelope): number {
  return Buffer.byteLength(envelope.ciphertext_b64, 'base64');
}
