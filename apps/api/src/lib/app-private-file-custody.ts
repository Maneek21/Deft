import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appPrivateFiles, appActionPayloads, appActionPayloadFiles, appPrivateStateRecords, appVersions } from '@deft/db/schema';
import { canonicalAttachmentJson, PrivateStateDeclarationSchema, type PrivateStateDeclaration } from '@deft/app-kit';
import type { AppRunTransaction } from './app-run-repository.js';
import type { AppRunKeyProvider, AppRunKeyReference } from './app-run-keyrings.js';
import { AppRunKeyVersionUnavailableError } from './app-run-keyrings.js';
import { AppError } from './app-errors.js';
import { AppPrivateStateSecrets, privateStateStoredBytes, type StoredPrivateSource } from './app-private-state-secrets.js';
import { privateStateValue, assertPrivateStateCas } from './app-private-state-contract.js';
import { exposureDigest } from './app-experience-exposure-contract.js';
import { appAttachmentMediaAllowed } from './app-attachment-media.js';
import { ActionPayloadBindingSchema, ActionPayloadReferenceSchema, PrivateFileScopeSchema,
  PrivateFileUploadSchema, PrivateFileReferenceSchema, PRIVATE_FILE_LIMITS,
  type PrivateFileScope, type ActionPayloadBinding, type ActionPayloadReference, type PrivateFileUpload,
  type PrivateFileReference, type PrivateFilesResponse, type CustodyGuards, type RetainedActionPayload } from './app-private-file-contract.js';
export type { PrivateFileScope, ActionPayloadBinding, ActionPayloadReference, PrivateFileUpload,
  PrivateFileReference, PrivateFilePolicy, PrivateFilesResponse, CustodyGuards, RetainedActionPayload } from './app-private-file-contract.js';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const unavailable = () => new AppError('Private file custody unavailable', 'APP_ACTION_UNAVAILABLE', 409);
const conflict = () => new AppError('Private draft changed; reload before continuing', 'APP_STATE_CONFLICT', 409);
const invalid = () => new AppError('Invalid private file custody request', 'APP_ACTION_INVALID', 400);
const EnvelopeSchema = z.strictObject({ schema_version: z.literal('deft.private_file.secret.v1'),
  key_version: z.string().min(1).max(128), nonce_b64: z.string().max(16), auth_tag_b64: z.string().max(24),
  ciphertext_b64: z.string().max(4 * Math.ceil(PRIVATE_FILE_LIMITS.metadata_bytes / 3)) });
type Ciphertext = { ciphertext: Buffer; key_version: string; nonce_b64: string; auth_tag_b64: string };
type FileRow = typeof appPrivateFiles.$inferSelect;
type PayloadRow = typeof appActionPayloads.$inferSelect;
const jsonObject = z.record(z.string(), z.json());

/** Distinct authenticated domains bind host identities, retained reference and bytes. */
export class AppPrivateFileSecrets {
  constructor(private readonly keys: AppRunKeyProvider) {}
  seal(domain: 'file_bytes' | 'file_metadata' | 'payload_bytes' | 'payload_metadata', context: unknown, bytes: Uint8Array): Ciphertext {
    const limit = domain.endsWith('metadata') ? PRIVATE_FILE_LIMITS.metadata_bytes
      : domain === 'file_bytes' ? PRIVATE_FILE_LIMITS.file_bytes : PRIVATE_FILE_LIMITS.payload_bytes;
    if (bytes.byteLength > limit) throw invalid();
    const key = this.keys.current('run_encryption'), nonce = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', key.key, nonce);
      cipher.setAAD(Buffer.from(canonicalAttachmentJson([`deft.private_file.${domain}.aad.v1`, context])));
      return { ciphertext: Buffer.concat([cipher.update(bytes), cipher.final()]), key_version: key.key_id,
        nonce_b64: nonce.toString('base64'), auth_tag_b64: cipher.getAuthTag().toString('base64') };
    } finally { key.key.fill(0); nonce.fill(0); }
  }
  open(domain: 'file_bytes' | 'file_metadata' | 'payload_bytes' | 'payload_metadata', context: unknown, envelope: Ciphertext): Buffer {
    const limit = domain.endsWith('metadata') ? PRIVATE_FILE_LIMITS.metadata_bytes
      : domain === 'file_bytes' ? PRIVATE_FILE_LIMITS.file_bytes : PRIVATE_FILE_LIMITS.payload_bytes;
    if (envelope.ciphertext.length > limit) throw unavailable();
    const key = this.keys.read('run_encryption', envelope.key_version);
    if (!key) throw new AppRunKeyVersionUnavailableError();
    let partial: Buffer | undefined;
    try {
      const nonce = Buffer.from(envelope.nonce_b64, 'base64'), tag = Buffer.from(envelope.auth_tag_b64, 'base64');
      if (nonce.length !== 12 || tag.length !== 16 || nonce.toString('base64') !== envelope.nonce_b64
        || tag.toString('base64') !== envelope.auth_tag_b64) throw unavailable();
      const decipher = createDecipheriv('aes-256-gcm', key.key, nonce);
      decipher.setAAD(Buffer.from(canonicalAttachmentJson([`deft.private_file.${domain}.aad.v1`, context])));
      decipher.setAuthTag(tag); partial = decipher.update(envelope.ciphertext);
      return Buffer.concat([partial, decipher.final()]);
    } finally { key.key.fill(0); partial?.fill(0); }
  }
  sealMetadata(domain: 'file_metadata' | 'payload_metadata', context: unknown, value: unknown) {
    const bytes = Buffer.from(canonicalAttachmentJson(value));
    try {
      const sealed = this.seal(domain, context, bytes);
      try { return { schema_version: 'deft.private_file.secret.v1', key_version: sealed.key_version,
        nonce_b64: sealed.nonce_b64, auth_tag_b64: sealed.auth_tag_b64, ciphertext_b64: sealed.ciphertext.toString('base64') }; }
      finally { sealed.ciphertext.fill(0); }
    } finally { bytes.fill(0); }
  }
  openMetadata(domain: 'file_metadata' | 'payload_metadata', context: unknown, value: unknown): unknown {
    const envelope = EnvelopeSchema.parse(value), encrypted = Buffer.from(envelope.ciphertext_b64, 'base64');
    if (encrypted.toString('base64') !== envelope.ciphertext_b64) { encrypted.fill(0); throw unavailable(); }
    let bytes: Buffer | undefined;
    try { bytes = this.open(domain, context, { ...envelope, ciphertext: encrypted });
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    finally { bytes?.fill(0); encrypted.fill(0); }
  }
}

const scopeWhere = (scope: PrivateFileScope) => and(eq(appPrivateFiles.org_id, scope.org_id), eq(appPrivateFiles.owner_user_id, scope.owner_user_id),
  eq(appPrivateFiles.installation_id, scope.installation_id), eq(appPrivateFiles.resource_target_key, scope.resource_target_key),
  eq(appPrivateFiles.state_key, scope.state_key), eq(appPrivateFiles.record_id, scope.record_id),
  eq(appPrivateFiles.artifact_digest, scope.artifact_digest), eq(appPrivateFiles.declaration_digest, scope.declaration_digest));
const fileContext = (scope: PrivateFileScope, id: string) => ({ ...scope, file_id: id });
const rowScope = (row: FileRow): PrivateFileScope => {
  const { org_id, owner_user_id, installation_id, resource_target_key, state_key, record_id, artifact_digest, declaration_digest } = row;
  return PrivateFileScopeSchema.parse({ org_id, owner_user_id, installation_id, resource_target_key, state_key, record_id, artifact_digest, declaration_digest });
};
const bindingScope = (binding: ActionPayloadBinding): PrivateFileScope => ({ org_id: binding.org_id, owner_user_id: binding.owner_user_id,
  installation_id: binding.installation_id, resource_target_key: binding.resource_target_key, state_key: binding.state_key,
  record_id: binding.draft_id, artifact_digest: binding.artifact_digest, declaration_digest: binding.declaration_digest });
const bindingFromRow = (row: PayloadRow): ActionPayloadBinding => {
  const { org_id, owner_user_id, installation_id, app_version_id, grant_snapshot_id, resource_target_key, state_key,
    draft_id, draft_revision, artifact_digest, declaration_digest, runtime_binding_id, action_key, action_contract_digest, input_digest } = row;
  return ActionPayloadBindingSchema.parse({ org_id, owner_user_id, installation_id, app_version_id, grant_snapshot_id, resource_target_key, state_key,
    draft_id, draft_revision, artifact_digest, declaration_digest, runtime_binding_id, action_key, action_contract_digest, input_digest });
};
const payloadContext = (binding: ActionPayloadBinding, ref: ActionPayloadReference) => ({ ...binding, ...ref });

/** Callers acquire the owner/state advisory lock before all phased authority locks.
 * This deep module grants custody only; it never treats a nominated scope as current authorization. */
export class AppPrivateFileCustody {
  private readonly secrets: AppPrivateFileSecrets;
  private readonly stateSecrets: AppPrivateStateSecrets;
  constructor(keys: AppRunKeyProvider) { this.secrets = new AppPrivateFileSecrets(keys); this.stateSecrets = new AppPrivateStateSecrets(keys); }

  private async check(guards: CustodyGuards, expires?: Date) {
    if (expires) guards.bindDeadline?.(expires);
    guards.signal?.throwIfAborted(); await guards.guard(); guards.signal?.throwIfAborted();
    if (expires && guards.now().getTime() >= expires.getTime()) throw unavailable();
  }
  private async draft(tx: AppRunTransaction, raw: PrivateFileScope, declaration: PrivateStateDeclaration, now: Date, requireFiles = true) {
    const scope = PrivateFileScopeSchema.parse(raw);
    const [row] = await tx.select().from(appPrivateStateRecords).where(and(eq(appPrivateStateRecords.org_id, scope.org_id),
      eq(appPrivateStateRecords.owner_user_id, scope.owner_user_id), eq(appPrivateStateRecords.installation_id, scope.installation_id),
      eq(appPrivateStateRecords.resource_target_key, scope.resource_target_key), eq(appPrivateStateRecords.state_key, scope.state_key),
      eq(appPrivateStateRecords.record_id, scope.record_id))).limit(1).for('update');
    if (!row || row.deleted_at || row.expires_at <= now || row.artifact_digest !== scope.artifact_digest
      || row.declaration_digest !== scope.declaration_digest || declaration.key !== scope.state_key
      || exposureDigest(declaration) !== scope.declaration_digest || (requireFiles && !declaration.files)) throw unavailable();
    return row;
  }
  private async bump(tx: AppRunTransaction, scope: PrivateFileScope, declaration: PrivateStateDeclaration,
    row: typeof appPrivateStateRecords.$inferSelect, now: Date) {
    if (row.revision >= 2147483646) throw conflict();
    const context = { org_id: scope.org_id, owner_user_id: scope.owner_user_id, installation_id: scope.installation_id,
      state_key: scope.state_key, record_id: scope.record_id, artifact_digest: scope.artifact_digest, declaration_digest: scope.declaration_digest,
      revision: row.revision, ...(scope.resource_target_key === 'primary' ? {} : { resource_target_key: scope.resource_target_key }) };
    let value: ReturnType<typeof privateStateValue>; let sources: StoredPrivateSource[];
    try { const opened=this.stateSecrets.openState(context,row.body);value=privateStateValue(declaration,opened.value);sources=opened.sources;
      if (privateStateStoredBytes(value.value,sources)>declaration.max_record_bytes) throw unavailable(); } catch { throw unavailable(); }
    const body = this.stateSecrets.seal({ ...context, revision: row.revision + 1 }, value.value,sources);
    await tx.update(appPrivateStateRecords).set({ revision: row.revision + 1, body, key_version: body.key_version, updated_at: now })
      .where(and(eq(appPrivateStateRecords.org_id, scope.org_id), eq(appPrivateStateRecords.owner_user_id, scope.owner_user_id),
        eq(appPrivateStateRecords.installation_id, scope.installation_id), eq(appPrivateStateRecords.state_key, scope.state_key),
        eq(appPrivateStateRecords.record_id, scope.record_id), eq(appPrivateStateRecords.revision, row.revision)));
    return row.revision + 1;
  }
  private fileMeta(row: FileRow): PrivateFileReference {
    if (!row.metadata_envelope || row.purged_at) throw unavailable();
    try {
      const value = PrivateFileReferenceSchema.parse(this.secrets.openMetadata('file_metadata', fileContext(rowScope(row), row.id), row.metadata_envelope));
      if (value.file_id !== row.id || value.upload_operation_id !== row.upload_operation_id || value.byte_length !== row.byte_length
        || value.digest !== row.content_digest || Date.parse(value.expires_at) !== row.expires_at.getTime()) throw unavailable();
      return value;
    } catch { throw unavailable(); }
  }
  private async attached(tx: AppRunTransaction, scope: PrivateFileScope, now: Date) {
    // Old artifact custody remains visible as a conflict after scalar adoption;
    // filtering it away would silently drop a previously attached file.
    const rows = await tx.select().from(appPrivateFiles).where(and(eq(appPrivateFiles.org_id, scope.org_id),
      eq(appPrivateFiles.owner_user_id, scope.owner_user_id), eq(appPrivateFiles.installation_id, scope.installation_id),
      eq(appPrivateFiles.resource_target_key, scope.resource_target_key), eq(appPrivateFiles.state_key, scope.state_key),
      eq(appPrivateFiles.record_id, scope.record_id), isNull(appPrivateFiles.detached_at)))
      .orderBy(asc(appPrivateFiles.id)).limit(PRIVATE_FILE_LIMITS.files + 1).for('share');
    if (rows.length > PRIVATE_FILE_LIMITS.files || rows.some(row => row.expires_at <= now || row.purged_at
      || row.artifact_digest !== scope.artifact_digest || row.declaration_digest !== scope.declaration_digest)) throw unavailable();
    return rows.map(row => {
      const metadata = this.fileMeta(row);
      let bytes: Buffer | undefined;
      try {
        bytes = this.secrets.open('file_bytes', fileContext(rowScope(row), row.id), this.binary(row));
        if (bytes.length !== metadata.byte_length || hash(bytes) !== metadata.digest) throw unavailable();
        return metadata;
      } catch { throw unavailable(); } finally { bytes?.fill(0); }
    });
  }
  async list(tx: AppRunTransaction, scope: PrivateFileScope, declaration: PrivateStateDeclaration, guards: CustodyGuards): Promise<PrivateFilesResponse> {
    await this.check(guards); const row = await this.draft(tx, scope, declaration, guards.now());
    const files = await this.attached(tx, scope, guards.now());
    await this.check(guards, new Date(Math.min(row.expires_at.getTime(), ...files.map(file => Date.parse(file.expires_at)))));
    return { schema_version: 'deft.private_files.v1', draft: { record_id: scope.record_id, revision: row.revision }, files };
  }
  async upload(tx: AppRunTransaction, scope: PrivateFileScope, declaration: PrivateStateDeclaration, raw: PrivateFileUpload,
    bytes: Uint8Array, guards: CustodyGuards): Promise<PrivateFilesResponse> {
    const request = PrivateFileUploadSchema.parse(raw), policy = declaration.files;
    if (!policy || bytes.byteLength < 1 || bytes.byteLength > policy.max_file_bytes || bytes.byteLength > PRIVATE_FILE_LIMITS.file_bytes
      || !policy.allowed_media_types.includes(request.media_type) || !appAttachmentMediaAllowed(bytes, request.media_type)) throw invalid();
    const owned = Buffer.from(bytes);
    try {
      await this.check(guards); const row = await this.draft(tx, scope, declaration, guards.now());
      const digest = hash(owned);
      const [old] = await tx.select().from(appPrivateFiles).where(and(eq(appPrivateFiles.org_id, scope.org_id),
        eq(appPrivateFiles.owner_user_id, scope.owner_user_id), eq(appPrivateFiles.installation_id, scope.installation_id),
        eq(appPrivateFiles.upload_operation_id, request.upload_operation_id))).limit(1).for('update');
      if (old) {
        if (canonicalAttachmentJson(rowScope(old)) !== canonicalAttachmentJson(scope) || old.detached_at || old.purged_at
          || old.upload_revision !== request.expected_revision || row.revision !== old.upload_revision + 1 || old.content_digest !== digest) throw conflict();
        const metadata = this.fileMeta(old);
        if (metadata.filename !== request.filename || metadata.media_type !== request.media_type || old.byte_length !== owned.length) throw conflict();
        return this.list(tx, scope, declaration, guards);
      }
      assertPrivateStateCas(request.expected_revision, row.revision);
      const files = await this.attached(tx, scope, guards.now());
      if (files.length >= policy.max_files_per_record || files.reduce((sum, item) => sum + item.byte_length, owned.length) > policy.max_total_bytes_per_record) throw conflict();
      const [quota] = await tx.select({ count: sql<number>`count(*) FILTER(WHERE ${appPrivateFiles.purged_at} IS NULL)::int`,
        identifiers: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${appPrivateFiles.byte_length}) FILTER(WHERE ${appPrivateFiles.purged_at} IS NULL),0)::float8` })
        .from(appPrivateFiles).where(and(eq(appPrivateFiles.org_id, scope.org_id), eq(appPrivateFiles.owner_user_id, scope.owner_user_id),
          eq(appPrivateFiles.installation_id, scope.installation_id), eq(appPrivateFiles.state_key, scope.state_key)));
      if ((quota?.count ?? 0) >= PRIVATE_FILE_LIMITS.retained_files || (quota?.identifiers ?? 0) >= 4096
        || (quota?.bytes ?? 0) + owned.length > policy.max_total_bytes_per_record * declaration.max_records) throw conflict();
      const file_id = crypto.randomUUID(), now = guards.now();
      const metadata: PrivateFileReference = { file_id, upload_operation_id: request.upload_operation_id,
        filename: request.filename, media_type: request.media_type, byte_length: owned.length, digest, expires_at: row.expires_at.toISOString() };
      const context = fileContext(scope, file_id), sealed = this.secrets.seal('file_bytes', context, owned);
      try {
        await tx.insert(appPrivateFiles).values({ ...scope, id: file_id, upload_operation_id: request.upload_operation_id,
          upload_revision: row.revision, content_digest: digest, byte_length: owned.length,
          metadata_envelope: this.secrets.sealMetadata('file_metadata', context, metadata), ...sealed,
          created_at: now, updated_at: now, expires_at: row.expires_at });
      } finally { sealed.ciphertext.fill(0); }
      const revision = await this.bump(tx, scope, declaration, row, now);
      await this.check(guards, row.expires_at);
      return { schema_version: 'deft.private_files.v1', draft: { record_id: scope.record_id, revision }, files: [...files, metadata].sort((a,b) => a.file_id.localeCompare(b.file_id)) };
    } finally { owned.fill(0); }
  }
  async remove(tx: AppRunTransaction, scope: PrivateFileScope, declaration: PrivateStateDeclaration,
    request: { expected_revision: number; file_id: string }, guards: CustodyGuards): Promise<PrivateFilesResponse> {
    z.strictObject({ expected_revision: z.number().int().positive().max(2147483646), file_id: z.string().uuid() }).parse(request);
    await this.check(guards); const row = await this.draft(tx, scope, declaration, guards.now());
    assertPrivateStateCas(request.expected_revision, row.revision);
    const [file] = await tx.select().from(appPrivateFiles).where(and(scopeWhere(scope), eq(appPrivateFiles.id, request.file_id))).limit(1).for('update');
    if (!file || file.detached_at) throw conflict();
    await tx.update(appPrivateFiles).set({ detached_at: guards.now(), updated_at: guards.now() }).where(and(scopeWhere(scope), eq(appPrivateFiles.id, file.id)));
    await this.bump(tx, scope, declaration, row, guards.now());
    return this.list(tx, scope, declaration, guards);
  }
  async resolveDraftFiles(tx: AppRunTransaction, scope: PrivateFileScope, declaration: PrivateStateDeclaration,
    revision: number, guards: CustodyGuards): Promise<readonly PrivateFileReference[]> {
    const result = await this.list(tx, scope, declaration, guards);
    assertPrivateStateCas(revision, result.draft.revision); return result.files;
  }
  private async payloadRow(tx: AppRunTransaction, scope: { org_id: string; owner_user_id: string }, ref: ActionPayloadReference) {
    ActionPayloadReferenceSchema.parse(ref);
    const [row] = await tx.select().from(appActionPayloads).where(and(eq(appActionPayloads.org_id, scope.org_id),
      eq(appActionPayloads.owner_user_id, scope.owner_user_id), eq(appActionPayloads.id, ref.snapshot_id), eq(appActionPayloads.snapshot_digest, ref.digest))).limit(1).for('share');
    if (!row) throw unavailable(); return row;
  }
  async locatePayloadBinding(tx: AppRunTransaction, scope: { org_id: string; owner_user_id: string }, ref: ActionPayloadReference): Promise<ActionPayloadBinding> {
    // Nomination only: this deliberately does not decrypt metadata or return bytes.
    return bindingFromRow(await this.payloadRow(tx, scope, ref));
  }
  async loadPayload(tx: AppRunTransaction, rawBinding: ActionPayloadBinding, ref: ActionPayloadReference, now: Date): Promise<RetainedActionPayload> {
    const binding = ActionPayloadBindingSchema.parse(rawBinding), row = await this.payloadRow(tx, binding, ref);
    if (canonicalAttachmentJson(bindingFromRow(row)) !== canonicalAttachmentJson(binding) || row.purged_at || row.expires_at <= now) throw unavailable();
    try {
      const plain = z.strictObject({ metadata: jsonObject, file_refs: z.array(PrivateFileReferenceSchema).max(PRIVATE_FILE_LIMITS.files) })
        .parse(this.secrets.openMetadata('payload_metadata', payloadContext(binding, ref), row.metadata_envelope));
      if (hash(canonicalAttachmentJson({ binding, metadata: plain.metadata, file_refs: plain.file_refs,
        bytes_digest: row.bytes_digest, byte_count: row.byte_length })) !== ref.digest) throw unavailable();
      const links = await tx.select().from(appActionPayloadFiles).where(and(eq(appActionPayloadFiles.org_id, binding.org_id),
        eq(appActionPayloadFiles.owner_user_id, binding.owner_user_id), eq(appActionPayloadFiles.snapshot_id, ref.snapshot_id)))
        .orderBy(asc(appActionPayloadFiles.position));
      if (links.length !== plain.file_refs.length || links.some((link, index) => link.file_id !== plain.file_refs[index]?.file_id)) throw unavailable();
      return { ref, binding, metadata: plain.metadata, file_refs: plain.file_refs, expires_at: row.expires_at,
        byte_count: row.byte_length, bytes_digest: row.bytes_digest };
    } catch { throw unavailable(); }
  }
  async retainPayload(tx: AppRunTransaction, rawBinding: ActionPayloadBinding,
    input: { metadata: Record<string, unknown>; bytes: Uint8Array; file_refs: readonly PrivateFileReference[]; expires_at: Date },
    guards: CustodyGuards): Promise<ActionPayloadReference> {
    const binding = ActionPayloadBindingSchema.parse(rawBinding), scope = bindingScope(binding);
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > PRIVATE_FILE_LIMITS.payload_bytes) throw invalid();
    // Copy module outputs before the first await; no concurrent proposal mutation
    // can substitute metadata, a file manifest or bytes during authority I/O.
    const capturedMetadata = jsonObject.parse(structuredClone(input.metadata));
    const capturedFiles = z.array(PrivateFileReferenceSchema).max(PRIVATE_FILE_LIMITS.files).parse(structuredClone(input.file_refs));
    const capturedExpiry = new Date(input.expires_at.getTime()), owned = Buffer.from(input.bytes);
    try {
      const [version] = await tx.select({ manifest: appVersions.manifest }).from(appVersions).where(and(eq(appVersions.org_id, binding.org_id),
        eq(appVersions.installation_id, binding.installation_id), eq(appVersions.id, binding.app_version_id))).limit(1);
      const manifest = version?.manifest as { private_state?: unknown[] } | undefined;
      const declaration = PrivateStateDeclarationSchema.parse(manifest?.private_state?.find(item => !!item && typeof item === 'object' && 'key' in item && item.key === binding.state_key));
      const policy = declaration.action_payloads?.find(item => item.action_key === binding.action_key);
      if (!policy || owned.length > policy.max_payload_bytes) throw invalid();
      await this.check(guards); const draft = await this.draft(tx, scope, declaration, guards.now(), false);
      assertPrivateStateCas(binding.draft_revision, draft.revision);
      const files = await this.attached(tx, scope, guards.now());
      if (canonicalAttachmentJson(files) !== canonicalAttachmentJson(capturedFiles)) throw conflict();
      const metadata = capturedMetadata, bytes_digest = hash(owned);
      const expires_at = new Date(Math.min(capturedExpiry.getTime(), draft.expires_at.getTime(), ...files.map(file => Date.parse(file.expires_at))));
      if (!Number.isFinite(expires_at.getTime()) || expires_at <= guards.now()) throw unavailable();
      const digest = hash(canonicalAttachmentJson({ binding, metadata, file_refs: files, bytes_digest, byte_count: owned.length }));
      const [existing] = await tx.select({ id: appActionPayloads.id, expires_at: appActionPayloads.expires_at, purged_at: appActionPayloads.purged_at }).from(appActionPayloads)
        .where(and(eq(appActionPayloads.org_id, binding.org_id), eq(appActionPayloads.owner_user_id, binding.owner_user_id),
          eq(appActionPayloads.installation_id, binding.installation_id), eq(appActionPayloads.snapshot_digest, digest))).limit(1);
      if (existing) {
        if (existing.purged_at || existing.expires_at <= guards.now()) throw unavailable();
        await this.check(guards, existing.expires_at); return { snapshot_id: existing.id, digest };
      }
      // Autosave creates new draft revisions. Their unconfirmed older payloads
      // can no longer pass the draft CAS at confirmation, so retire their bodies
      // under the same owner/state lock instead of charging every edit forever.
      // A retained Run pointer keeps its exact old bytes and file links intact.
      await this.check(guards, expires_at);
      await tx.execute(sql`WITH obsolete AS (
        SELECT p.id FROM app_action_payloads p WHERE p.org_id=${binding.org_id} AND p.owner_user_id=${binding.owner_user_id}
          AND p.installation_id=${binding.installation_id} AND p.resource_target_key=${binding.resource_target_key}
          AND p.state_key=${binding.state_key} AND p.draft_id=${binding.draft_id}
          AND p.artifact_digest=${binding.artifact_digest} AND p.declaration_digest=${binding.declaration_digest}
          AND p.draft_revision<${binding.draft_revision} AND p.purged_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM app_run_human_authorizations h WHERE h.org_id=p.org_id
            AND h.owner_user_id=p.owner_user_id AND h.snapshot_id=p.id)
        ORDER BY p.id LIMIT ${PRIVATE_FILE_LIMITS.retained_payloads} FOR UPDATE OF p
      ) UPDATE app_action_payloads p SET ciphertext=NULL,key_version=NULL,nonce_b64=NULL,auth_tag_b64=NULL,
        metadata_envelope=NULL,purged_at=${guards.now()},updated_at=${guards.now()}
        FROM obsolete WHERE p.id=obsolete.id`);
      await this.check(guards, expires_at);
      const [quota] = await tx.select({ count: sql<number>`count(*) FILTER(WHERE ${appActionPayloads.purged_at} IS NULL)::int`,
        identifiers: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${appActionPayloads.byte_length}) FILTER(WHERE ${appActionPayloads.purged_at} IS NULL),0)::float8` }).from(appActionPayloads)
        .where(and(eq(appActionPayloads.org_id, binding.org_id), eq(appActionPayloads.owner_user_id, binding.owner_user_id),
          eq(appActionPayloads.installation_id, binding.installation_id), eq(appActionPayloads.state_key, binding.state_key)));
      if ((quota?.count ?? 0) >= PRIVATE_FILE_LIMITS.retained_payloads || (quota?.identifiers ?? 0) >= 4096
        || (quota?.bytes ?? 0) + owned.length > policy.max_payload_bytes * declaration.max_records) throw conflict();
      const ref = { snapshot_id: crypto.randomUUID(), digest }, context = payloadContext(binding, ref), now = guards.now();
      const sealed = this.secrets.seal('payload_bytes', context, owned);
      try { await tx.insert(appActionPayloads).values({ ...binding, id: ref.snapshot_id, snapshot_digest: digest, bytes_digest,
        byte_length: owned.length, metadata_envelope: this.secrets.sealMetadata('payload_metadata', context, { metadata, file_refs: files }),
        ...sealed, created_at: now, updated_at: now, expires_at }); }
      finally { sealed.ciphertext.fill(0); }
      if (files.length) await tx.insert(appActionPayloadFiles).values(files.map((file, position) => ({ org_id: binding.org_id,
        owner_user_id: binding.owner_user_id, snapshot_id: ref.snapshot_id, file_id: file.file_id, position })));
      await this.check(guards, expires_at); return ref;
    } finally { owned.fill(0); }
  }
  private binary(row: FileRow | PayloadRow): Ciphertext {
    if (!row.ciphertext || !row.key_version || !row.nonce_b64 || !row.auth_tag_b64 || row.purged_at) throw unavailable();
    return { ciphertext: row.ciphertext, key_version: row.key_version, nonce_b64: row.nonce_b64, auth_tag_b64: row.auth_tag_b64 };
  }
  async readPayload(tx: AppRunTransaction, binding: ActionPayloadBinding, ref: ActionPayloadReference, guards: CustodyGuards): Promise<Buffer> {
    await this.check(guards); const metadata = await this.loadPayload(tx, binding, ref, guards.now());
    const row = await this.payloadRow(tx, binding, ref);
    let bytes: Buffer | undefined;
    try {
      bytes = this.secrets.open('payload_bytes', payloadContext(binding, ref), this.binary(row));
      if (bytes.length !== metadata.byte_count || hash(bytes) !== metadata.bytes_digest) throw unavailable();
      await this.check(guards, metadata.expires_at); return bytes;
    } catch (error) { bytes?.fill(0); throw error instanceof AppError ? error : unavailable(); }
  }
  async readDraftFile(tx: AppRunTransaction, binding: ActionPayloadBinding, ref: ActionPayloadReference, fileId: string, guards: CustodyGuards): Promise<Buffer> {
    await this.check(guards); const payload = await this.loadPayload(tx, binding, ref, guards.now());
    const file = payload.file_refs.find(item => item.file_id === fileId);
    if (!file) throw unavailable();
    const [row] = await tx.select().from(appPrivateFiles).where(and(scopeWhere(bindingScope(binding)), eq(appPrivateFiles.id, fileId))).limit(1).for('share');
    if (!row || row.expires_at <= guards.now() || row.purged_at || canonicalAttachmentJson(this.fileMeta(row)) !== canonicalAttachmentJson(file)) throw unavailable();
    let bytes: Buffer | undefined;
    try {
      bytes = this.secrets.open('file_bytes', fileContext(bindingScope(binding), fileId), this.binary(row));
      if (bytes.length !== file.byte_length || hash(bytes) !== file.digest) throw unavailable();
      await this.check(guards, new Date(Math.min(row.expires_at.getTime(), payload.expires_at.getTime()))); return bytes;
    } catch (error) { bytes?.fill(0); throw error instanceof AppError ? error : unavailable(); }
  }
  async readCurrentDraftFile(tx: AppRunTransaction, scope: PrivateFileScope, declaration: PrivateStateDeclaration,
    revision: number, fileId: string, guards: CustodyGuards): Promise<Buffer> {
    const files = await this.resolveDraftFiles(tx, scope, declaration, revision, guards), file = files.find(item => item.file_id === fileId);
    if (!file) throw unavailable();
    const [row] = await tx.select().from(appPrivateFiles).where(and(scopeWhere(scope), eq(appPrivateFiles.id, fileId), isNull(appPrivateFiles.detached_at))).limit(1).for('share');
    if (!row) throw unavailable(); let bytes: Buffer | undefined;
    try { bytes = this.secrets.open('file_bytes', fileContext(scope, fileId), this.binary(row));
      if (hash(bytes) !== file.digest || bytes.length !== file.byte_length) throw unavailable();
      await this.check(guards, row.expires_at); return bytes;
    } catch (error) { bytes?.fill(0); throw error instanceof AppError ? error : unavailable(); }
  }
}

/** Bounded expiry removes bodies, preserving referenced identity tombstones. */
export async function purgeExpiredPrivateAppCustody(tx: AppRunTransaction): Promise<number> {
  const payloads = await tx.execute(sql`WITH expired AS (SELECT id FROM app_action_payloads WHERE purged_at IS NULL AND expires_at<=clock_timestamp()
    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE app_action_payloads p SET ciphertext=NULL,key_version=NULL,nonce_b64=NULL,
    auth_tag_b64=NULL,metadata_envelope=NULL,purged_at=clock_timestamp(),updated_at=clock_timestamp() FROM expired WHERE p.id=expired.id RETURNING p.id`);
  const files = await tx.execute(sql`WITH expired AS (SELECT id FROM app_private_files WHERE purged_at IS NULL AND expires_at<=clock_timestamp()
    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE app_private_files f SET ciphertext=NULL,key_version=NULL,nonce_b64=NULL,
    auth_tag_b64=NULL,metadata_envelope=NULL,purged_at=clock_timestamp(),updated_at=clock_timestamp() FROM expired WHERE f.id=expired.id RETURNING f.id`);
  return payloads.rows.length + files.rows.length;
}
export async function listAppPrivateFileKeyReferences(tx: AppRunTransaction): Promise<readonly AppRunKeyReference[]> {
  const result = await tx.execute(sql<{ key_id: string }>`SELECT DISTINCT key_id FROM (
    SELECT key_version AS key_id FROM app_private_files WHERE ciphertext IS NOT NULL
    UNION ALL SELECT metadata_envelope->>'key_version' FROM app_private_files WHERE metadata_envelope IS NOT NULL
    UNION ALL SELECT key_version FROM app_action_payloads WHERE ciphertext IS NOT NULL
    UNION ALL SELECT metadata_envelope->>'key_version' FROM app_action_payloads WHERE metadata_envelope IS NOT NULL
  ) retained WHERE key_id IS NOT NULL ORDER BY key_id`);
  return result.rows.map(row => ({ purpose: 'run_encryption' as const, key_id: z.string().min(1).max(128).parse(row.key_id) }));
}
