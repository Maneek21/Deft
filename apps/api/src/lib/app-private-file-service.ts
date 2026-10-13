import { z } from 'zod';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import type { ExperienceCaller } from './app-experience-service.js';
import { AppExperienceExposureService } from './app-experience-exposure.js';
import { exposureDigest } from './app-experience-exposure-contract.js';
import { AppPrivateFileCustody } from './app-private-file-custody.js';
import { PrivateFileUploadSchema, type PrivateFilesResponse } from './app-private-file-contract.js';
import { samplePrivateAccessClock } from './app-private-access-clock.js';
import { AppError } from './app-errors.js';

const uuid = z.string().uuid();
const removal = z.strictObject({ expected_revision: z.number().int().positive().max(2147483646) });

/** Native human file custody; Worker content cannot acquire upload authority. */
export class AppPrivateFileService {
  private readonly custody: AppPrivateFileCustody;
  constructor(keys: AppRunKeyProvider, private readonly exposure = new AppExperienceExposureService(keys),
    private readonly now: () => Date = () => new Date()) { this.custody = new AppPrivateFileCustody(keys); }

  async request(caller: ExperienceCaller, sessionId: string, stateKey: string, recordId: string,
    operation: { kind: 'list' } | { kind: 'upload'; input: unknown; bytes: Uint8Array }
      | { kind: 'remove'; fileId: string; input: unknown }, signal?: AbortSignal) {
    uuid.parse(recordId);
    const upload = operation.kind === 'upload' ? PrivateFileUploadSchema.parse(operation.input) : undefined;
    const remove = operation.kind === 'remove' ? { ...removal.parse(operation.input), file_id: uuid.parse(operation.fileId) } : undefined;
    let deliveryCheck: (() => void) | undefined;
    const result = await this.exposure.withPrivateState(caller, sessionId, stateKey, async (tx, authority) => {
      if (!authority.declaration.files) throw new AppError('Private files are unavailable', 'APP_ACTION_UNAVAILABLE', 409);
      const clock = await samplePrivateAccessClock(tx, this.now);
      let deadline = Math.min(authority.session.expires_at.getTime(), authority.exposure.expires_at.getTime(), caller.access_expires_at ?? 0);
      const check = () => {
        signal?.throwIfAborted();
        if (clock.current().getTime() >= deadline) throw new AppError('Private files expired', 'APP_ACTION_UNAVAILABLE', 409);
      };
      deliveryCheck = check;
      const guard = async () => { check(); };
      authority.onFinalCheck(async () => {
        const finalClock = await samplePrivateAccessClock(tx, this.now);
        if (finalClock.current().getTime() >= deadline) throw new AppError('Private files expired', 'APP_ACTION_UNAVAILABLE', 409);
        check();
      });
      authority.onDeliveryCheck(check);
      const scope = { org_id: caller.org_id, owner_user_id: caller.user_id, installation_id: authority.installation_id,
        resource_target_key: authority.session.resource_target_key, state_key: stateKey, record_id: recordId,
        artifact_digest: authority.artifact_digest, declaration_digest: exposureDigest(authority.declaration) };
      const guards = { now: clock.current, guard, signal,
        bindDeadline: (expires: Date) => { deadline = Math.min(deadline, expires.getTime()); } };
      let output: PrivateFilesResponse;
      if (upload && operation.kind === 'upload') output = await this.custody.upload(tx, scope, authority.declaration, upload, operation.bytes, guards);
      else if (remove) output = await this.custody.remove(tx, scope, authority.declaration, remove, guards);
      else output = await this.custody.list(tx, scope, authority.declaration, guards);
      for (const file of output.files) deadline = Math.min(deadline, Date.parse(file.expires_at));
      check();
      return output;
    }, signal);
    // COMMIT acknowledgement can arrive after a deadline; never disclose then.
    deliveryCheck?.();
    return result.output;
  }
}
