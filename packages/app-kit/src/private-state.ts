import { z } from 'zod';
import { RuntimeObjectSchema } from './runtime-authoring.js';
import { AttachmentMediaTypeSchema } from './resource-sync-attachments.js';

export const PRIVATE_STATE_LIMITS = Object.freeze({ record_bytes: 16384, records: 32, total_bytes: 131072, retention_days: 30 });
export const PRIVATE_STATE_FILE_LIMITS = Object.freeze({ file_bytes: 2_097_152, files_per_record: 8,
  total_bytes_per_record: 8_388_608, payload_bytes: 8_388_608 });
/** Reviewed custody limits; these do not add files to the scalar state schema. */
export const PrivateStateFilesPolicySchema = z.strictObject({
  max_file_bytes: z.number().int().min(1).max(PRIVATE_STATE_FILE_LIMITS.file_bytes),
  max_files_per_record: z.number().int().min(1).max(PRIVATE_STATE_FILE_LIMITS.files_per_record),
  max_total_bytes_per_record: z.number().int().min(1).max(PRIVATE_STATE_FILE_LIMITS.total_bytes_per_record),
  allowed_media_types: z.array(AttachmentMediaTypeSchema).min(1).max(8)
    .refine(types => new Set(types).size === types.length, 'Media types must be unique'),
}).refine(value => value.max_file_bytes <= value.max_total_bytes_per_record, 'File quota exceeds draft quota');
export const PrivateStateActionPayloadSchema = z.strictObject({
  action_key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
    .refine(value => !['constructor', 'prototype', '__proto__'].includes(value) && !/^(deft|core|system)(_|$)/.test(value)),
  max_payload_bytes: z.number().int().min(1).max(PRIVATE_STATE_FILE_LIMITS.payload_bytes),
});
export const PrivateStateDeclarationSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), label: z.string().min(1).max(128),
  schema: RuntimeObjectSchema,
  max_record_bytes: z.number().int().min(1).max(PRIVATE_STATE_LIMITS.record_bytes),
  max_records: z.number().int().min(1).max(PRIVATE_STATE_LIMITS.records),
  max_total_bytes: z.number().int().min(1).max(PRIVATE_STATE_LIMITS.total_bytes),
  retention_days: z.number().int().min(1).max(PRIVATE_STATE_LIMITS.retention_days),
  files: PrivateStateFilesPolicySchema.optional(),
  action_payloads: z.array(PrivateStateActionPayloadSchema).min(1).max(16)
    .refine(rows => rows.every((row, index) => !index || rows[index - 1]!.action_key < row.action_key),
      'Payload action keys must be unique and sorted').optional(),
}).refine(value => value.max_record_bytes <= value.max_total_bytes, 'Record quota exceeds total quota');
export const PrivateStateDeclarationsSchema = z.array(PrivateStateDeclarationSchema).min(1).max(16)
  .refine(rows => rows.every((row, index) => !index || rows[index - 1]!.key < row.key), 'State keys must be unique and sorted');
export type PrivateStateDeclaration = z.infer<typeof PrivateStateDeclarationSchema>;
export type PrivateStateFilesPolicy = z.infer<typeof PrivateStateFilesPolicySchema>;
export type PrivateStateActionPayload = z.infer<typeof PrivateStateActionPayloadSchema>;
