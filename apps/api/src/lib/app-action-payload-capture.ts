import { AppError } from './app-errors.js';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import type { HumanActionPayloadCapturePort } from './app-experience-human-action-service.js';
import { AppPrivateFileCustody } from './app-private-file-custody.js';
import { getAppConnectionRegistry, type AppConnectionRegistry } from './app-connection-registry.js';

const unavailable = () => new AppError('Message preparation is unavailable for this account', 'APP_ACTION_UNAVAILABLE', 409);

/** Fixed operator registration plus already locked authority, with no nested
 * authority transaction while the caller owns the draft/quota locks. */
export class AppActionPayloadCapture implements HumanActionPayloadCapturePort {
  private readonly custody: AppPrivateFileCustody;
  constructor(keys: AppRunKeyProvider, private readonly registry: () => Promise<AppConnectionRegistry> = getAppConnectionRegistry) {
    this.custody = new AppPrivateFileCustody(keys);
  }
  async capture(tx: Parameters<HumanActionPayloadCapturePort['capture']>[0],
    context: Parameters<HumanActionPayloadCapturePort['capture']>[1]) {
    const { binding, guards } = context;
    await guards.guard();
    const entry = (await this.registry()).select({ org_id: binding.org_id, owner_user_id: binding.owner_user_id,
      installation_id: binding.installation_id, target_key: binding.resource_target_key });
    const source = context.sources?.find(candidate => Object.entries(entry.pins).every(([key, value]) =>
      candidate[key as keyof typeof candidate] === value));
    if (!source || !entry.adapter.buildActionPayload || source.purpose !== 'connect'
      || source.action_binding_id !== binding.runtime_binding_id || source.action_key !== binding.action_key
      || source.app_version_id !== binding.app_version_id || source.grant_snapshot_id !== binding.grant_snapshot_id) throw unavailable();
    let deadline = Math.min(source.expires_at, context.expires_at.getTime());
    const check = async () => {
      guards.signal?.throwIfAborted(); await guards.guard();
      if (guards.now().getTime() >= deadline) throw unavailable();
    };
    const boundedGuards = { ...guards, guard: check, bindDeadline: (expires: Date) => {
      deadline = Math.min(deadline, expires.getTime()); guards.bindDeadline?.(expires);
    } };
    boundedGuards.bindDeadline(new Date(deadline));
    const declaration = context.authority.draft_declaration;
    if (!declaration) throw unavailable();
    const scope = { org_id: binding.org_id, owner_user_id: binding.owner_user_id, installation_id: binding.installation_id,
      resource_target_key: binding.resource_target_key, state_key: binding.state_key, record_id: binding.draft_id,
      artifact_digest: binding.artifact_digest, declaration_digest: binding.declaration_digest };
    const references = context.files_policy
      ? await this.custody.resolveDraftFiles(tx, scope, declaration, binding.draft_revision, boundedGuards) : [];
    const files: { reference: typeof references[number]; bytes: Buffer }[] = [];
    let payloadBytes: Uint8Array | undefined;
    try {
      for (const reference of references) files.push({ reference,
        bytes: await this.custody.readCurrentDraftFile(tx, scope, declaration, binding.draft_revision, reference.file_id, boundedGuards) });
      await check();
      const built = await entry.adapter.buildActionPayload({ binding, input: context.input, draft_value: context.draft_value,
        draft_updated_at: context.draft_updated_at.toISOString(), files, files_policy: context.files_policy,
        source_records: context.resolved_resources,
        max_payload_bytes: context.max_payload_bytes, expires_at: new Date(deadline).toISOString() },
      { projection: source, recheck: async () => { await check(); return { ...source, expires_at: deadline, checked_at: guards.now().getTime() }; } });
      payloadBytes = built.bytes;
      if (!(payloadBytes instanceof Uint8Array) || payloadBytes.byteLength > context.max_payload_bytes) throw unavailable();
      await check();
      return await this.custody.retainPayload(tx, binding, { metadata: built.metadata, bytes: payloadBytes,
        file_refs: references, expires_at: new Date(deadline) }, boundedGuards);
    } catch (error) {
      if (error instanceof AppError) throw error;
      // A private adapter failure must never expose credentials/provider detail.
      throw unavailable();
    } finally {
      for (const file of files) file.bytes.fill(0);
      payloadBytes?.fill(0);
    }
  }
}
