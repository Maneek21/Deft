import { z } from 'zod';
import { RuntimeObjectSchema } from './runtime-authoring.js';

export const PRIVATE_STATE_LIMITS = Object.freeze({ record_bytes: 16384, records: 32, total_bytes: 131072, retention_days: 30 });
export const PrivateStateDeclarationSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), label: z.string().min(1).max(128),
  schema: RuntimeObjectSchema,
  max_record_bytes: z.number().int().min(1).max(PRIVATE_STATE_LIMITS.record_bytes),
  max_records: z.number().int().min(1).max(PRIVATE_STATE_LIMITS.records),
  max_total_bytes: z.number().int().min(1).max(PRIVATE_STATE_LIMITS.total_bytes),
  retention_days: z.number().int().min(1).max(PRIVATE_STATE_LIMITS.retention_days),
}).refine(value => value.max_record_bytes <= value.max_total_bytes, 'Record quota exceeds total quota');
export const PrivateStateDeclarationsSchema = z.array(PrivateStateDeclarationSchema).min(1).max(16)
  .refine(rows => rows.every((row, index) => !index || rows[index - 1]!.key < row.key), 'State keys must be unique and sorted');
export type PrivateStateDeclaration = z.infer<typeof PrivateStateDeclarationSchema>;
