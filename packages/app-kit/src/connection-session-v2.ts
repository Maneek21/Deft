import { z } from 'zod';
import { AppConnectionActionConsentSchema, AppConnectionRuntimeRequestSchema,
  AppConnectionRuntimeResultSchema, AppConnectionSessionScopeSchema } from './connection-session.js';

/** Independent reviewed actions. Array order and both identities are canonical;
 * provider capability mapping belongs to the reviewed external runtime. */
export const AppConnectionActionConsentsSchema = z.array(AppConnectionActionConsentSchema).max(8)
  .refine(values => values.every((value, index) => index === 0 || values[index - 1]!.action_key < value.action_key)
    && new Set(values.map(value => value.action_binding_id)).size === values.length
    && values.every(value => value.consent_id === value.action_binding_id),
  'Action consents must have unique identities and sorted action keys');
export type AppConnectionActionConsents = Readonly<z.infer<typeof AppConnectionActionConsentsSchema>>;
const v2 = { schema_version: z.literal('deft.app_connection_runtime.v2'), action_consents: AppConnectionActionConsentsSchema };
const [begin, callback, status, disconnect] = AppConnectionRuntimeRequestSchema.options;
const variants = [begin.omit({ action_consent: true }).extend(v2), callback.omit({ action_consent: true }).extend(v2),
  status.omit({ action_consent: true }).extend(v2), disconnect.omit({ action_consent: true }).extend(v2)] as const;
export const AppConnectionRuntimeV2RequestSchema = z.discriminatedUnion('operation', variants);
export const AppConnectionRuntimeV2ResultSchema = AppConnectionRuntimeResultSchema;
const authority = { schema_version: z.literal('deft.app_connection_runtime_authority.v2'),
  session_id: z.string().uuid(), scope: AppConnectionSessionScopeSchema,
  action_consents: AppConnectionActionConsentsSchema,
  operation: z.enum(['begin', 'callback', 'status', 'disconnect']), expires_at: z.iso.datetime() };
const deadline = (value: { operation: string; expires_at: string; scope: { consent_expires_at: string };
  action_consents: AppConnectionActionConsents }) => Date.parse(value.expires_at) <= Date.parse(value.scope.consent_expires_at)
    && (!['begin', 'callback'].includes(value.operation)
      || value.action_consents.every(consent => Date.parse(value.expires_at) <= Date.parse(consent.expires_at)));
export const AppConnectionRuntimeV2AuthorityRequestSchema = z.strictObject(authority).refine(deadline);
export const AppConnectionRuntimeV2AuthorityResultSchema = z.strictObject({ ...authority, allowed: z.literal(true) }).refine(deadline);
export type AppConnectionRuntimeV2Request = Readonly<z.infer<typeof AppConnectionRuntimeV2RequestSchema>>;
