import { z } from 'zod';
import type { AttachmentPolicy } from '@deft/app-kit/core';

const uuid = z.string().uuid();
const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const taggedDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const PrivateFileDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const PRIVATE_FILE_LIMITS = Object.freeze({ file_bytes: 2097152, payload_bytes: 8388608,
  metadata_bytes: 65536, files: 8, retained_files: 256, retained_payloads: 64, transfer_ms: 10000 });
export const PrivateFileScopeSchema = z.strictObject({ org_id: uuid, owner_user_id: uuid,
  installation_id: uuid, resource_target_key: key, state_key: key, record_id: uuid,
  artifact_digest: taggedDigest, declaration_digest: taggedDigest });
export type PrivateFileScope = z.infer<typeof PrivateFileScopeSchema>;
export const ActionPayloadBindingSchema = z.strictObject({ org_id: uuid, owner_user_id: uuid,
  installation_id: uuid, app_version_id: uuid, grant_snapshot_id: uuid, resource_target_key: key,
  state_key: key, draft_id: uuid, draft_revision: z.number().int().positive().max(2147483646),
  artifact_digest: taggedDigest, declaration_digest: taggedDigest, runtime_binding_id: uuid,
  action_key: key, action_contract_digest: taggedDigest, input_digest: taggedDigest });
export type ActionPayloadBinding = z.infer<typeof ActionPayloadBindingSchema>;
export const ActionPayloadReferenceSchema = z.strictObject({ snapshot_id: uuid, digest: PrivateFileDigestSchema });
export type ActionPayloadReference = z.infer<typeof ActionPayloadReferenceSchema>;
export const PrivateFileUploadSchema = z.strictObject({ expected_revision: z.number().int().positive().max(2147483646),
  upload_operation_id: uuid, filename: z.string().min(1).max(200)
    .refine(value => Buffer.byteLength(value, 'utf8') <= 800 && !/[\\/\u0000-\u001f\u007f-\u009f]/u.test(value)
      && value !== '.' && value !== '..', 'Invalid private file name'),
  media_type: z.enum(['text/plain', 'text/csv', 'application/json', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']) });
export type PrivateFileUpload = z.infer<typeof PrivateFileUploadSchema>;
export type PrivateFilePolicy = Readonly<{ max_file_bytes: number; max_files_per_record: number;
  max_total_bytes_per_record: number; allowed_media_types: readonly AttachmentPolicy['allowed_media_types'][number][] }>;
export const PrivateFileReferenceSchema = z.strictObject({ file_id: uuid, upload_operation_id: uuid,
  filename: PrivateFileUploadSchema.shape.filename, media_type: PrivateFileUploadSchema.shape.media_type,
  byte_length: z.number().int().min(1).max(PRIVATE_FILE_LIMITS.file_bytes), digest: PrivateFileDigestSchema,
  expires_at: z.string().datetime({ offset: true }) });
export type PrivateFileReference = z.infer<typeof PrivateFileReferenceSchema>;
export type PrivateFilesResponse = Readonly<{ schema_version: 'deft.private_files.v1';
  draft: Readonly<{ record_id: string; revision: number }>; files: readonly PrivateFileReference[] }>;
export type CustodyGuards = Readonly<{ now: () => Date; guard: () => Promise<void>; signal?: AbortSignal;
  bindDeadline?: (expires: Date) => void }>;
export type RetainedActionPayload = Readonly<{ ref: ActionPayloadReference; binding: ActionPayloadBinding;
  metadata: Record<string, unknown>; file_refs: readonly PrivateFileReference[]; expires_at: Date;
  byte_count: number; bytes_digest: string }>;
