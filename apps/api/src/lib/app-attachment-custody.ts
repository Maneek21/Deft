import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { AttachmentStageHeaderSchema, AttachmentStagedReplySchema, canonicalAttachmentJson,
  RESOURCE_ATTACHMENT_LIMITS, type AttachmentStageHeader } from '@deft/app-kit';
import { appAttachmentStages, appRuntimeSessions } from '@deft/db/schema';
import type { AppRunTransaction } from './app-run-repository.js';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import type { createBoundedAppRunDatabase } from './app-run-bounded-db.js';
import type { AppAttachmentObjectStore } from './app-attachment-object-store.js';
import { AppAttachmentSecretService, type AppAttachmentSecretContext } from './app-attachment-secrets.js';
import { assertAttachmentBrokerEnabled, attachmentStale } from './app-attachment-authority.js';
import { APP_ATTACHMENT_RETAINED_STAGE_LIMIT, appAttachmentStageExpiresAt, hashAppAttachmentSessionToken, parseAttachmentConsentPolicy } from './app-attachment-policy.js';
import { appAttachmentMediaAllowed } from './app-attachment-media.js';
import { loadAttachmentStageAuthority, assertAttachmentStageFinalAuthority } from './app-attachment-sync-run.js';
import { retainedAttachmentMetadataCapacity } from './app-attachment-capacity.js';
import { AppError } from './app-errors.js';
import { AppAttachmentTransferLimiter } from './app-attachment-transfer.js';

type Stage = typeof appAttachmentStages.$inferSelect;
type Database = ReturnType<typeof createBoundedAppRunDatabase>;
const conflict = () => new AppError('Attachment stage unavailable or changed', 'APP_STATE_CONFLICT', 409);
const scopeFor = (s: Stage) => ({ org_id: s.org_id, resource_binding_id: s.resource_binding_id, checkpoint_id: s.checkpoint_id });
export const attachmentStageContext = (s: Stage): AppAttachmentSecretContext => ({ ...scopeFor(s), staging_id: s.id,
  generation: s.generation, run_id: s.run_id, attempt_id: s.attempt_id, fingerprint_key_version: s.fingerprint_key_version,
  claim_token:s.claim_token,reservation_sequence:s.reservation_sequence,
  parent_locator_hmac: s.parent_locator_hmac, parent_revision_hmac: s.parent_revision_hmac, attachment_key_hmac: s.attachment_key_hmac });

/** A process-local transfer ceiling, not a cluster-wide scheduling claim.
 * Each exact Run also serializes durable count/byte reservation under its
 * checkpoint. Ready rows never gain authority until normal page settlement. */
export class AppAttachmentCustodyService {
  readonly #secrets: AppAttachmentSecretService;
  readonly #transfers = new AppAttachmentTransferLimiter();
  constructor(private readonly database: Database, keys: AppRunKeyProvider,
    private readonly objects: AppAttachmentObjectStore, private readonly clock: () => Date = () => new Date()) {
    assertAttachmentBrokerEnabled(); this.#secrets = new AppAttachmentSecretService(keys);
  }
  async stage(raw: unknown, token: string, readBytes: (signal: AbortSignal) => Promise<Buffer>, externalSignal?: AbortSignal, deadline?:number) {
    assertAttachmentBrokerEnabled();
    const header = AttachmentStageHeaderSchema.parse(raw);
    return this.#transfers.run((signal,deadline) => this.#stageTransfer(header,token,readBytes,signal,deadline),externalSignal,deadline);
  }
  /** Host-owned content delivery shares the same process transfer ceiling. */
  transfer<T>(work: (signal: AbortSignal,deadline:number)=>Promise<T>, signal?:AbortSignal) {
    assertAttachmentBrokerEnabled(); return this.#transfers.run(work,signal);
  }
  async #stageTransfer(header: AttachmentStageHeader, token: string,
    readBytes: (signal: AbortSignal) => Promise<Buffer>, signal: AbortSignal, deadline: number) {
    const tokenHash = hashAppAttachmentSessionToken(token);
    const identity = await this.database.transaction(async tx => {
      const [row] = await tx.select({ org_id: appRuntimeSessions.org_id }).from(appRuntimeSessions)
        .where(and(eq(appRuntimeSessions.id,header.session_id),eq(appRuntimeSessions.token_hash,tokenHash),
          eq(appRuntimeSessions.audience,'app_resource_sync'),sql`${appRuntimeSessions.runtime_binding_id} IS NULL`,
          sql`${appRuntimeSessions.resource_binding_id} IS NOT NULL`)).limit(1);
      return row;
    },signal,deadline);
    if (!identity) throw attachmentStale();
    let bytes: Buffer | undefined;
    try {
      const reserved = await this.database.transaction(tx => this.#reserve(tx,identity.org_id,tokenHash,header,signal),signal,deadline);
      signal.throwIfAborted();
      bytes = await readBytes(signal); signal.throwIfAborted();
      if (bytes.length !== header.declared_size_bytes) throw new TypeError('Attachment declared length mismatch');
      const content = this.#secrets.fingerprint('content', bytes, scopeFor(reserved.row),reserved.row.fingerprint_key_version).fingerprint;
      if (reserved.replay) {
        if (reserved.row.content_hmac !== content) throw conflict();
        await this.database.transaction(async tx => {
          const current = await loadAttachmentStageAuthority(tx,{ org_id: identity.org_id,token_hash:tokenHash,header,clock:this.clock });
          const [row] = await tx.select().from(appAttachmentStages).where(and(eq(appAttachmentStages.org_id,identity.org_id),eq(appAttachmentStages.id,reserved.row.id))).limit(1).for('update');
          if (!row || !['ready','blocked'].includes(row.state) || row.content_hmac !== content) throw conflict();
          await assertAttachmentStageFinalAuthority(tx,current,this.clock,signal,[row.stage_expires_at]);
        },signal,deadline);
        return this.#reply(reserved.row);
      }
      const allowed = appAttachmentMediaAllowed(bytes,header.declared_media_type);
      const encrypted = allowed ? this.#secrets.sealBinary(bytes,attachmentStageContext(reserved.row)) : null;
      try {
        // The reserved stage ID is also the opaque local object locator. An
        // uncertain put leaves uploading unavailable; no new identity/retry.
        if (encrypted) {
          const put = this.objects.putExclusive(reserved.row.id,encrypted.ciphertext,signal);
          try {
            await put; signal.throwIfAborted();
            const stored = await this.objects.get(reserved.row.id,signal);
            try {
              const verified = this.#secrets.openBinary({ ...encrypted,ciphertext:stored },attachmentStageContext(reserved.row));
              try {
                if (verified.length !== header.declared_size_bytes
                  || this.#secrets.fingerprint('content',verified,scopeFor(reserved.row),reserved.row.fingerprint_key_version).fingerprint !== content) throw conflict();
              } finally { verified.fill(0); }
            } finally { stored.fill(0); }
          } finally {
            // Even a late exclusive publication after abort remains inaccessible
            // and is removed only after that underlying put has actually settled.
            if (signal.aborted) await this.objects.delete(reserved.row.id).catch(() => {});
          }
        }
        signal.throwIfAborted();
        return await this.database.transaction(async tx => {
          const current = await loadAttachmentStageAuthority(tx,{ org_id:identity.org_id,token_hash:tokenHash,header,clock:this.clock });
          const [row] = await tx.select().from(appAttachmentStages).where(and(eq(appAttachmentStages.org_id,identity.org_id),eq(appAttachmentStages.id,reserved.row.id))).limit(1).for('update');
          if (!row || row.state !== 'uploading' || row.stage_expires_at <= this.clock()
            || canonicalAttachmentJson(this.#secrets.openMetadataJson(row.metadata_envelope,attachmentStageContext(row))) !== canonicalAttachmentJson(header)) throw conflict();
          const [ready] = await tx.update(appAttachmentStages).set({ state: allowed ? 'ready' : 'blocked', content_hmac:content,
            object_id: encrypted ? row.id : null, binary_key_version:encrypted?.key_version ?? null,
            binary_nonce_b64:encrypted?.nonce_b64 ?? null,binary_auth_tag_b64:encrypted?.auth_tag_b64 ?? null,updated_at:this.clock() })
            .where(and(eq(appAttachmentStages.org_id,identity.org_id),eq(appAttachmentStages.id,row.id),eq(appAttachmentStages.state,'uploading'))).returning();
          if (!ready) throw conflict();
          await assertAttachmentStageFinalAuthority(tx,current,this.clock,signal,[ready.stage_expires_at]);
          return this.#reply(ready);
        },signal,deadline);
      } finally { encrypted?.ciphertext.fill(0); }
    } finally {
      bytes?.fill(0);
    }
  }
  #reply(row: Stage) {
    return AttachmentStagedReplySchema.parse({ schema_version:'deft.app_sync_attachment_staged.v1',
      staging_id:row.id,state:row.state === 'ready' ? 'ready' : 'blocked',size_bytes:row.declared_size_bytes });
  }
  async #reserve(tx: AppRunTransaction,orgId:string,tokenHash:string,header:AttachmentStageHeader,signal:AbortSignal) {
    const current = await loadAttachmentStageAuthority(tx,{ org_id:orgId,token_hash:tokenHash,header,clock:this.clock });
    const { checkpoint,intent,authority,run } = current;
    const policy = parseAttachmentConsentPolicy(authority.descriptor.attachments,authority.binding.attachment_policy);
    if (header.declared_size_bytes > policy.max_attachment_bytes || !policy.allowed_media_types.includes(header.declared_media_type)) throw conflict();
    const scope = { org_id:orgId,resource_binding_id:authority.binding.id,checkpoint_id:checkpoint.id };
    // This retained intent key makes duplicate identity stable through keyring
    // rotation; a valid heartbeat never changes the attempt sequence or key.
    const version = intent.expected_cursor_hmac_key_version;
    const fingerprint = (domain:'parent_locator'|'parent_revision'|'attachment_key',value:string) =>
      this.#secrets.fingerprint(domain,Buffer.from(value),scope,version).fingerprint;
    const parent = fingerprint('parent_locator',header.parent_resource_id), revision = fingerprint('parent_revision',header.parent_revision),
      key = fingerprint('attachment_key',header.attachment_key);
    const [prior] = await tx.select().from(appAttachmentStages).where(and(eq(appAttachmentStages.org_id,orgId),
      eq(appAttachmentStages.run_id,run.id),eq(appAttachmentStages.attempt_id,current.attempt.id),
      eq(appAttachmentStages.checkpoint_id,checkpoint.id),eq(appAttachmentStages.generation,checkpoint.generation),
      eq(appAttachmentStages.fingerprint_key_version,version),eq(appAttachmentStages.parent_locator_hmac,parent),
      eq(appAttachmentStages.parent_revision_hmac,revision),eq(appAttachmentStages.attachment_key_hmac,key))).limit(1).for('update');
    if (prior) {
      if (!['ready','blocked'].includes(prior.state) || prior.stage_expires_at <= this.clock()
        || canonicalAttachmentJson(this.#secrets.openMetadataJson(prior.metadata_envelope,attachmentStageContext(prior))) !== canonicalAttachmentJson(header)) throw conflict();
      await assertAttachmentStageFinalAuthority(tx,current,this.clock,signal,[prior.stage_expires_at]);
      return { row:prior,replay:true };
    }
    const count = await tx.select({ n:sql<number>`count(*)::integer`,bytes:sql<number>`coalesce(sum(${appAttachmentStages.declared_size_bytes}),0)::integer` })
      .from(appAttachmentStages).where(and(eq(appAttachmentStages.org_id,orgId),eq(appAttachmentStages.run_id,run.id)));
    if (!count[0] || count[0].n >= policy.max_attachments_per_run
      || count[0].bytes + header.declared_size_bytes > policy.max_attachment_bytes_per_run) throw conflict();
    const now = this.clock(), id = randomUUID();
    const context: AppAttachmentSecretContext = { ...scope,staging_id:id,generation:checkpoint.generation,run_id:run.id,
      attempt_id:current.attempt.id,claim_token:header.claim_token,reservation_sequence:header.sequence,
      fingerprint_key_version:version,parent_locator_hmac:parent,parent_revision_hmac:revision,attachment_key_hmac:key };
    const metadata = this.#secrets.sealMetadataJson(header,context);
    // Metadata is additionally budgeted under the same checkpoint lock. This
    // prevents empty binary stages from bypassing the retained capacity limit.
    const metadataBytes = Buffer.byteLength(String(metadata.ciphertext_b64),'base64');
    const retained = await retainedAttachmentMetadataCapacity(tx,scope);
    if (retained.count >= APP_ATTACHMENT_RETAINED_STAGE_LIMIT
      || checkpoint.retained_bytes + checkpoint.cursor_bytes + retained.bytes
      + header.declared_size_bytes + metadataBytes > authority.binding.max_retained_bytes) throw conflict();
    const {staging_id:_stagingId,...databaseContext}=context;
    const [row] = await tx.insert(appAttachmentStages).values({ ...databaseContext,id,
      claim_token:header.claim_token,reservation_sequence:header.sequence,declared_size_bytes:header.declared_size_bytes,
      metadata_envelope:metadata,stage_expires_at:appAttachmentStageExpiresAt(now,run.input_expires_at,run.result_expires_at),created_at:now,updated_at:now }).returning();
    if (!row) throw conflict();
    await assertAttachmentStageFinalAuthority(tx,current,this.clock,signal,[row.stage_expires_at]);
    return { row,replay:false };
  }
}
