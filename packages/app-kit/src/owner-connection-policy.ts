import { z } from 'zod';

export const OWNER_CONNECTION_POLICY_LIMITS = Object.freeze({
  policies: 16, actions_per_policy: 16, consent_seconds: 90 * 24 * 60 * 60,
});
const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
  .refine(value => !['constructor', 'prototype', '__proto__'].includes(value));

/** Requested owner setup ceiling only. The host separately admits an operator,
 * eligible human owner, current deployment and exact resource/action bindings. */
export const OwnerConnectionPolicyDeclarationSchema = z.strictObject({
  key,
  resource_key: key,
  action_keys: z.array(key).max(OWNER_CONNECTION_POLICY_LIMITS.actions_per_policy)
    .refine(keys => keys.every((value, index) => !index || keys[index - 1]! < value),
      'Owner connection action keys must be unique and sorted'),
  max_consent_seconds: z.number().int().min(1).max(OWNER_CONNECTION_POLICY_LIMITS.consent_seconds),
  /** Requested profile only; the host separately admits its immutable operator
   * and runtime registration. Legacy owner policies omit both fields. */
  provider_profile_key: key.optional(),
  runtime_requirement_key: key.optional(),
}).refine(value => (value.provider_profile_key === undefined) === (value.runtime_requirement_key === undefined),
  'Connection provider profile and runtime requirement must be declared together');
export const OwnerConnectionPolicyDeclarationsSchema = z.array(OwnerConnectionPolicyDeclarationSchema)
  .min(1).max(OWNER_CONNECTION_POLICY_LIMITS.policies)
  .refine(rows => rows.every((value, index) => !index || rows[index - 1]!.key < value.key),
    'Owner connection policy keys must be unique and sorted');
export type OwnerConnectionPolicyDeclaration = z.infer<typeof OwnerConnectionPolicyDeclarationSchema>;
