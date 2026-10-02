import { z } from 'zod';
import { PrivateStateDeclarationSchema, type PrivateStateDeclaration } from '@deft/app-kit';
import { parseRuntimeObjectInput } from '@deft/app-kit';
import { AppError } from './app-errors.js';

const identity = z.string().uuid();
const revision = z.number().int().min(0).max(2147483646);
export const PrivateStateRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list') }),
  z.strictObject({ operation: z.literal('read'), record_id: identity }),
  z.strictObject({ operation: z.literal('put'), record_id: identity, expected_revision: revision, value: z.unknown() }),
  z.strictObject({ operation: z.literal('delete'), record_id: identity, expected_revision: revision }),
]);
export const PrivateStateContextSchema = z.strictObject({ org_id: identity, owner_user_id: identity,
  installation_id: identity, artifact_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  declaration_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), state_key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  record_id: identity, revision: z.number().int().positive().max(2147483647) });
export type PrivateStateContext = z.infer<typeof PrivateStateContextSchema>;
export function privateStateValue(declaration: PrivateStateDeclaration, value: unknown) {
  const checked = PrivateStateDeclarationSchema.parse(declaration);
  const parsed = parseRuntimeObjectInput(checked.schema, value);
  const bytes = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
  if (bytes > checked.max_record_bytes) throw new AppError('Private state exceeds its reviewed record quota', 'APP_ACTION_INVALID', 413);
  return { value: parsed, bytes };
}
export function assertPrivateStateCas(expected: number, current: number | undefined) {
  if (expected !== (current ?? 0)) throw new AppError('Private state changed; reload before saving', 'APP_STATE_CONFLICT', 409);
}
export function assertPrivateStateQuota(records: number, bytes: number, declaration: PrivateStateDeclaration) {
  if (records > declaration.max_records || bytes > declaration.max_total_bytes) throw new AppError('Private state quota reached', 'APP_STATE_CONFLICT', 409);
}
