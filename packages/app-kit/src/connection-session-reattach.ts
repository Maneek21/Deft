import { z } from 'zod';
import { AppConnectionActionConsentsSchema } from './connection-session-v2.js';
import { AppConnectionActionConsentSchema, AppConnectionSessionScopeSchema, AppConnectionSessionViewSchema } from './connection-session.js';

const id = z.string().uuid();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const generation = z.number().int().positive().max(2_147_483_646);
const opaque = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
const account = AppConnectionSessionViewSchema.shape.account.unwrap();

/** A historical locator nominates custody, never its old authority. */
export const AppConnectionReattachSourceSchema = z.strictObject({ session_id: id,
  session_revision: z.number().int().positive().max(2_147_483_646),
  scope: AppConnectionSessionScopeSchema, runtime_session_ref: opaque, account_ref: opaque });
export const AppConnectionReattachEligibilitySchema = z.strictObject({
  account, custody_generation: generation, custody_digest: digest });
export const AppConnectionReattachStoredReviewSchema = AppConnectionReattachEligibilitySchema.extend({ digest });
export const AppConnectionReattachReceiptSchema = z.strictObject({ custody_generation: generation, receipt_digest: digest });
/** Host-only durable metadata. No OAuth secret, callback or old consent is carried. */
export const AppConnectionReattachmentSchema = z.strictObject({
  schema_version: z.literal('deft.app_connection_reattachment.v1'),
  source: AppConnectionReattachSourceSchema, transport_digest: digest, review_expires_at: z.iso.datetime(),
  review: AppConnectionReattachStoredReviewSchema.nullable(), receipt: AppConnectionReattachReceiptSchema.nullable(),
}).superRefine((value, ctx) => {
  if (value.review && value.review.account.account_ref !== value.source.account_ref)
    ctx.addIssue({ code: 'custom', message: 'Reattachment cannot replace the account' });
  if (value.receipt && (!value.review || value.receipt.custody_generation !== value.review.custody_generation + 1))
    ctx.addIssue({ code: 'custom', message: 'Reattachment must advance the reviewed generation exactly once' });
});
export type AppConnectionReattachment = Readonly<z.infer<typeof AppConnectionReattachmentSchema>>;

export const AppConnectionReattachReviewRequestSchema = z.strictObject({ installation_id: id,
  target_key: AppConnectionSessionScopeSchema.shape.target_key, source_session_id: id, request_id: id });
export const AppConnectionReattachActivateRequestSchema = z.strictObject({ session_id: id, review_digest: digest });
export const AppConnectionReattachStatusRequestSchema = z.strictObject({ session_id: id });
export const AppConnectionReattachReviewViewSchema = z.strictObject({
  schema_version: z.literal('deft.app_connection_reattach_review.v1'), session_id: id,
  source_session_id: id, source_revision: z.number().int().positive(), scope: AppConnectionSessionScopeSchema,
  account, custody_generation: generation, review_digest: digest, expires_at: z.iso.datetime(),
});

const envelope = { schema_version: z.literal('deft.app_connection_reattach_runtime.v1'),
  session_id: id, scope: AppConnectionSessionScopeSchema, source: AppConnectionReattachSourceSchema,
  transport_digest: digest, review_expires_at: z.iso.datetime(), expires_at: z.iso.datetime(),
  action_consent: AppConnectionActionConsentSchema.optional() };
const runtimeVariants = [
  z.strictObject({ ...envelope, operation: z.literal('prepare') }),
  z.strictObject({ ...envelope, operation: z.literal('activate'), review: AppConnectionReattachStoredReviewSchema }),
  z.strictObject({ ...envelope, operation: z.literal('status'), review: AppConnectionReattachStoredReviewSchema.nullable() }),
] as const;
const withinDeadline = (value: { operation: 'prepare' | 'activate' | 'status'; expires_at: string; review_expires_at: string; scope: { consent_expires_at: string } }) =>
  Number.isFinite(Date.parse(value.review_expires_at))
  && Date.parse(value.review_expires_at) <= Date.parse(value.scope.consent_expires_at)
  && Date.parse(value.expires_at) <= Date.parse(value.scope.consent_expires_at)
  && (value.operation === 'status' || Date.parse(value.expires_at) <= Date.parse(value.review_expires_at));
export const AppConnectionReattachRuntimeRequestSchema = z.discriminatedUnion('operation', runtimeVariants)
  .refine(withinDeadline, 'Reattachment call exceeds reviewed deadlines');
export type AppConnectionReattachRuntimeRequest = Readonly<z.infer<typeof AppConnectionReattachRuntimeRequestSchema>>;
export const AppConnectionReattachRuntimeResultSchema = z.discriminatedUnion('state', [
  AppConnectionReattachEligibilitySchema.extend({ schema_version: z.literal('deft.app_connection_reattach_runtime.v1'),
    session_id: id, state: z.literal('eligible') }),
  z.strictObject({ schema_version: z.literal('deft.app_connection_reattach_runtime.v1'), session_id: id,
    state: z.literal('connected'), account, runtime_session_ref: opaque,
    custody_generation: generation, receipt_digest: digest }),
  z.strictObject({ schema_version: z.literal('deft.app_connection_reattach_runtime.v1'), session_id: id,
    state: z.literal('indeterminate') }),
]);
export type AppConnectionReattachRuntimeResult = Readonly<z.infer<typeof AppConnectionReattachRuntimeResultSchema>>;
export const AppConnectionReattachAuthorityRequestSchema = AppConnectionReattachRuntimeRequestSchema;
export const AppConnectionReattachAuthorityResultSchema = z.discriminatedUnion('operation', [
  runtimeVariants[0].extend({ allowed: z.literal(true) }), runtimeVariants[1].extend({ allowed: z.literal(true) }),
  runtimeVariants[2].extend({ allowed: z.literal(true) }),
]).refine(withinDeadline, 'Reattachment authority exceeds reviewed deadlines');

/** Sorted-key JSON shared with the independent runtime for review/receipt pins. */
export function canonicalConnectionReattachmentJson(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
    return input;
  }
  return JSON.stringify(canonical(value));
}

/** Explicit v2 audience: independent current action purposes are review pins. */
export const AppConnectionReattachV2ReviewViewSchema=AppConnectionReattachReviewViewSchema.extend({
 schema_version:z.literal('deft.app_connection_reattach_review.v2'),action_consents:AppConnectionActionConsentsSchema});
export const AppConnectionReattachAnyReviewViewSchema=z.union([AppConnectionReattachReviewViewSchema,AppConnectionReattachV2ReviewViewSchema]);
const v2Envelope={schema_version:z.literal('deft.app_connection_reattach_runtime.v2'),action_consents:AppConnectionActionConsentsSchema};
const v2Variants=[runtimeVariants[0].omit({action_consent:true}).extend(v2Envelope),runtimeVariants[1].omit({action_consent:true}).extend(v2Envelope),runtimeVariants[2].omit({action_consent:true}).extend(v2Envelope)] as const;
const v2Deadline=(value:{operation:string;expires_at:string;action_consents:z.infer<typeof AppConnectionActionConsentsSchema>})=>
 value.operation==='status'||value.action_consents.every(consent=>Date.parse(value.expires_at)<=Date.parse(consent.expires_at));
export const AppConnectionReattachV2RuntimeRequestSchema=z.union([v2Variants[0]!,v2Variants[1]!,v2Variants[2]!]).refine(withinDeadline).refine(v2Deadline);
export const AppConnectionReattachV2AuthorityResultSchema=z.union([v2Variants[0]!.extend({allowed:z.literal(true)}),v2Variants[1]!.extend({allowed:z.literal(true)}),v2Variants[2]!.extend({allowed:z.literal(true)})]).refine(withinDeadline).refine(v2Deadline);
export const AppConnectionReattachV2RuntimeResultSchema=z.union([
 AppConnectionReattachRuntimeResultSchema.options[0].extend({schema_version:z.literal('deft.app_connection_reattach_runtime.v2')}),
 AppConnectionReattachRuntimeResultSchema.options[1].extend({schema_version:z.literal('deft.app_connection_reattach_runtime.v2')}),
 AppConnectionReattachRuntimeResultSchema.options[2].extend({schema_version:z.literal('deft.app_connection_reattach_runtime.v2')}),
 // Negative status proof only: the runtime durably fences an expired, unprepared
 // original request. Consumers must never interpret this as permission to replay it.
 z.strictObject({schema_version:z.literal('deft.app_connection_reattach_runtime.v2'),
  session_id:id,state:z.literal('not_connected'),reason:z.literal('prepare_not_started')})]);
export const AppConnectionReattachAnyRuntimeRequestSchema=z.union([AppConnectionReattachRuntimeRequestSchema,AppConnectionReattachV2RuntimeRequestSchema]);
export const AppConnectionReattachAnyRuntimeResultSchema=z.union([AppConnectionReattachRuntimeResultSchema,AppConnectionReattachV2RuntimeResultSchema]);
export const AppConnectionReattachAnyAuthorityResultSchema=z.union([AppConnectionReattachAuthorityResultSchema,AppConnectionReattachV2AuthorityResultSchema]);
export type AppConnectionReattachAnyRuntimeRequest=z.infer<typeof AppConnectionReattachAnyRuntimeRequestSchema>;
export type AppConnectionReattachAnyRuntimeResult=z.infer<typeof AppConnectionReattachAnyRuntimeResultSchema>;
