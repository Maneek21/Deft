import { z } from 'zod';
import { AppRuntimeResourceRefV2Schema } from '@deft/shared';
import { AppRunSecretEnvelopeSchema } from './app-run-secrets.js';
import { HumanAccessSnapshot } from './app-resource-access-contract.js';

export const PRIVATE_DEFTY_LIMITS = Object.freeze({
  prompt_bytes: 16_384, context_bytes: 65_536, history_bytes: 262_144,
  turns: 10, output_bytes: 65_536, review_ms: 300_000, grant_ms: 900_000,
  retained_seals: 4096, active_contexts_per_app: 256,
});
export class PrivateDeftyCapacityError extends Error {
  readonly status = 409;
  readonly code = 'APP_PRIVATE_DEFTY_CONTEXT_CAPACITY';
  constructor(readonly capacity: 'retained_contexts' | 'active_contexts') {
    super(capacity === 'retained_contexts' ? 'Retained private context capacity reached' : 'Active private context capacity reached');
  }
}
export class PrivateDeftyRequestError extends Error {
  readonly status = 409;
  constructor(readonly code: 'APP_PRIVATE_DEFTY_REQUEST_CONFLICT' | 'APP_PRIVATE_DEFTY_REQUEST_PENDING_OR_UNKNOWN' | 'APP_PRIVATE_DEFTY_REQUEST_BUSY') {
    super(code === 'APP_PRIVATE_DEFTY_REQUEST_CONFLICT' ? 'Request identity already belongs to different input'
      : code === 'APP_PRIVATE_DEFTY_REQUEST_BUSY' ? 'Another private request is still pending or unknown'
        : 'Private request is pending or unknown and will not be resent');
  }
}
export const PRIVATE_DEFTY_PLACEHOLDERS = Object.freeze({
  user: '[Private context prompt]', assistant: '[Private context answer]',
});
const uuid = z.string().uuid();
const boundedText = (bytes: number) => z.string().min(1).refine(value =>
  Buffer.byteLength(value, 'utf8') <= bytes && Buffer.from(value).toString('utf8') === value,
  'Text exceeds its UTF-8 bound');
export const PrivateDeftyReviewInput = z.strictObject({
  schema_version: z.literal('deft.app_private_defty_review.v1'),
  space_id: uuid, ref: AppRuntimeResourceRefV2Schema,
  field_keys: z.array(z.string().min(1).max(48)).min(1).max(32)
    .refine(keys => keys.every((key, index) => index === 0 || keys[index - 1]! < key)),
  expires_at: z.string().datetime({ offset: true }),
});
export const PrivateDeftyTurnInput = z.strictObject({
  schema_version: z.literal('deft.app_private_defty_turn.v1'),
  request_id: uuid, prompt: boundedText(PRIVATE_DEFTY_LIMITS.prompt_bytes),
});
export const PrivateDeftyModelDestination = z.strictObject({
  provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
  model: z.string().min(1).max(200),
  endpoint: z.string().url().max(2048),
  credential_key_version: z.string().min(1).max(64),
  credential_fingerprint: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/),
  reasoning_effort: z.enum(['low', 'medium', 'high']).nullable(),
});
export const PrivateDeftyGrantSnapshot = HumanAccessSnapshot.omit({
  schema_version: true, purpose: true, recipient_user_id: true,
  recipient_label: true, operations: true,
}).extend({
  schema_version: z.literal('deft.app_private_defty_snapshot.v1'),
  purpose: z.literal('defty_private_context'),
  space_id: uuid, seal_id: uuid, defty_user_id: uuid,
  owner_membership_authorization_version: z.number().int().positive(),
  defty_membership_authorization_version: z.number().int().positive(),
  model_destination: PrivateDeftyModelDestination,
});
export type PrivateDeftySnapshot = z.infer<typeof PrivateDeftyGrantSnapshot>;
export const PrivateDeftyReviewOutput = z.strictObject({
  snapshot: PrivateDeftyGrantSnapshot,
  selected_data: z.record(z.string().min(1).max(48), z.union([z.string(), z.number().finite(), z.boolean()])),
  custody_notice: z.literal('The reviewed model provider receives your selected fields and private prompts. Revocation stops future requests and cannot recall input already delivered. Private turns cannot use tools or create memory.'),
  review_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  review_token: z.string().min(1).max(16384),
});
export const PrivateDeftySecretContext = z.strictObject({
  org_id: uuid, space_id: uuid, message_id: uuid, owner_user_id: uuid,
  defty_user_id: uuid, seal_id: uuid, grant_id: uuid,
  role: z.enum(['user', 'assistant']),
});
export type PrivateDeftySecretContext = z.infer<typeof PrivateDeftySecretContext>;
export const PrivateDeftyMessageMetadata = z.strictObject({
  schema_version: z.literal('deft.private_defty_message.v1'),
  seal_id: uuid, grant_id: uuid, request_id: uuid,
  role: z.enum(['user', 'assistant']), envelope: AppRunSecretEnvelopeSchema,
});
export const PrivateDeftyPlaintext = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('user'), text: boundedText(PRIVATE_DEFTY_LIMITS.prompt_bytes) }),
  z.strictObject({ role: z.literal('assistant'), text: boundedText(PRIVATE_DEFTY_LIMITS.output_bytes) }),
]);
export type PrivateDeftyPlaintext = z.infer<typeof PrivateDeftyPlaintext>;

// Interactive owner DTO. Generic native/MCP message APIs never use this decoder.
export const PrivateDeftyHistoryOutput = z.strictObject({
  schema_version: z.literal('deft.app_private_defty_history.v1'),
  space_id: uuid, seal_id: uuid,
  grant_state: z.enum(['active', 'ended']),
  turn_requires_reauthorization: z.literal(true),
  messages: z.array(z.strictObject({
    id: uuid, request_id: uuid, role: z.enum(['user', 'assistant']),
    text: boundedText(PRIVATE_DEFTY_LIMITS.output_bytes),
    created_at: z.string().datetime({ offset: true }),
  })).max(PRIVATE_DEFTY_LIMITS.turns * 2),
});
export const PrivateDeftyTurnOutput = z.strictObject({
  schema_version: z.literal('deft.app_private_defty_turn_result.v1'),
  space_id: uuid, request_id: uuid, message_id: uuid,
  text: boundedText(PRIVATE_DEFTY_LIMITS.output_bytes),
  expires_at: z.string().datetime({ offset: true }),
});
