import { appConsentDeadline} from './consent-lifetime.js';
import { z } from 'zod';
const accountRef=z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
import { appConnectionSessionViewDeadline, AppConnectionSessionScopeSchema, AppConnectionSessionViewSchema,
  AppConnectionSessionCallbackSchema, AppConnectionSessionBegunSchema } from './connection-session.js';
import { AppConnectionReattachSourceSchema, AppConnectionReattachEligibilitySchema } from './connection-session-reattach.js';
import {canonicalConnectionReattachmentJson} from './connection-session-reattach.js';
import { AppConnectionActionConsentsSchema } from './connection-session-v2.js';

const id = z.string().uuid();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const generation = z.number().int().positive().max(2_147_483_646);
const opaque = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
const account = AppConnectionSessionViewSchema.shape.account.unwrap();
export const AppConnectionCredentialRepairSourceSchema = AppConnectionReattachSourceSchema;
export const AppConnectionCredentialRepairHistoricalAttemptSchema=z.strictObject({run_id:id,attempt_id:id,attempt_digest:digest});
export const AppConnectionCredentialRepairHistoricalAttemptsSchema=z.array(AppConnectionCredentialRepairHistoricalAttemptSchema).max(64).refine(v=>new Set(v.map(a=>a.attempt_id)).size===v.length);
export const AppConnectionCredentialRepairFenceSchema=z.strictObject({reservation_id:id,repair_session_id:id,source_session_id:id,
 source_revision:z.number().int().positive(),account_ref:accountRef,resource_binding_id:id,old_custody_generation:generation,
 planned_custody_generation:generation,identity_digest:digest,fence_digest:digest,
 historical_attempts:AppConnectionCredentialRepairHistoricalAttemptsSchema,publication_continuity_digest:digest
}).refine(v=>v.planned_custody_generation===v.old_custody_generation+1);
export const AppConnectionCredentialRepairStoredReviewSchema = AppConnectionReattachEligibilitySchema.extend({ digest,fence:AppConnectionCredentialRepairFenceSchema });
export const AppConnectionCredentialRepairReceiptSchema = z.strictObject({ custody_generation: generation, receipt_digest: digest });
export const AppConnectionCredentialRepairClosureSchema = z.discriminatedUnion('reason',[
 z.strictObject({reason:z.literal('intent_cancelled'),custody_generation:generation,receipt_digest:digest,intent_fence:AppConnectionCredentialRepairFenceSchema}),
 z.strictObject({ reason: z.enum(['callback_expired','provider_denied','prepared_cancelled','exchange_abandoned']), custody_generation: generation, receipt_digest: digest })]);
export const AppConnectionCredentialRepairSchema = z.strictObject({
  schema_version: z.literal('deft.app_connection_credential_repair.v1'), source: AppConnectionCredentialRepairSourceSchema,
  transport_digest: digest, review_expires_at: z.iso.datetime(),
  historical_attempts:AppConnectionCredentialRepairHistoricalAttemptsSchema,publication_continuity_digest:z.null(),
  begin_consumed: z.boolean(),
  reservation_closed:z.boolean(),
  review: AppConnectionCredentialRepairStoredReviewSchema.nullable(), receipt: AppConnectionCredentialRepairReceiptSchema.nullable(),
  closure: AppConnectionCredentialRepairClosureSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.review && value.review.account.account_ref !== value.source.account_ref)
    ctx.addIssue({ code: 'custom', message: 'Credential repair cannot replace the account' });
  if (value.receipt && (!value.review || value.receipt.custody_generation !== value.review.custody_generation + 1))
    ctx.addIssue({ code: 'custom', message: 'Credential repair must advance the reviewed generation exactly once' });
  if(value.begin_consumed&&!value.review||value.receipt&&!value.begin_consumed)
    ctx.addIssue({code:'custom',message:'Credential repair requires a reviewed consumed Begin before any receipt'});
  if(value.closure?.reason==='intent_cancelled'&&(value.review||value.receipt||value.begin_consumed
    ||value.closure.custody_generation!==value.closure.intent_fence.old_custody_generation
    ||value.closure.intent_fence.source_session_id!==value.source.session_id||value.closure.intent_fence.source_revision!==value.source.session_revision
    ||value.closure.intent_fence.account_ref!==value.source.account_ref))ctx.addIssue({code:'custom',message:'Intent closure requires exact unconsumed reservation'});
  if(value.closure&&value.closure.reason!=='intent_cancelled'&&(!value.review||value.receipt||value.closure.custody_generation!==value.review.custody_generation+(value.closure.reason==='prepared_cancelled'?0:1)
    ||value.closure.reason==='prepared_cancelled'&&value.begin_consumed||value.closure.reason!=='prepared_cancelled'&&!value.begin_consumed))
    ctx.addIssue({code:'custom',message:'Repair closure records only its actual consumed generation'});
  if(value.reservation_closed&&!value.receipt&&!value.closure)ctx.addIssue({code:'custom',message:'Repair release requires durable receipt or closure'});
});
export type AppConnectionCredentialRepair = Readonly<z.infer<typeof AppConnectionCredentialRepairSchema>>;
export const AppConnectionCredentialRepairReviewRequestSchema = z.strictObject({ mode:z.literal('credential_repair'),installation_id: id,
  target_key: AppConnectionSessionScopeSchema.shape.target_key, source_session_id: id, request_id: id });
export const AppConnectionCredentialRepairBeginRequestSchema = z.strictObject({ mode:z.literal('credential_repair'),session_id: id, review_digest: digest });
export const AppConnectionCredentialRepairCallbackRequestSchema = z.discriminatedUnion('outcome',[
 z.strictObject({mode:z.literal('credential_repair'),session_id:id,state:AppConnectionSessionBegunSchema.shape.callback_state,outcome:z.literal('authorized'),code:z.string().min(1).max(4096).regex(/^[^\u0000-\u0020\u007f]+$/u)}),
 z.strictObject({mode:z.literal('credential_repair'),session_id:id,state:AppConnectionSessionBegunSchema.shape.callback_state,outcome:z.literal('denied')})]);
export const AppConnectionCredentialRepairStatusRequestSchema = z.strictObject({ mode:z.literal('credential_repair'),session_id: id,cancel_prepared:z.literal(true).optional(),close_uncertain:z.literal(true).optional() }).refine(v=>!(v.cancel_prepared&&v.close_uncertain));
export const AppConnectionCredentialRepairReviewViewSchema = z.strictObject({
  schema_version: z.literal('deft.app_connection_credential_repair_review.v1'), session_id: id, source_session_id: id,
  source_revision: z.number().int().positive().max(2_147_483_646), scope: AppConnectionSessionScopeSchema,
  account, custody_generation: generation, action_consents: AppConnectionActionConsentsSchema,
  fence:AppConnectionCredentialRepairFenceSchema,
  review_digest: digest, expires_at: z.iso.datetime(),
});
export const AppConnectionCredentialRepairBegunSchema = z.strictObject({ ...AppConnectionSessionBegunSchema.shape,
  schema_version: z.literal('deft.app_connection_credential_repair_session.v1') }).refine(appConnectionSessionViewDeadline);
export const AppConnectionCredentialRepairClosedViewSchema = z.strictObject({ ...AppConnectionSessionViewSchema.shape,
  schema_version: z.literal('deft.app_connection_credential_repair_closed.v1'), state: z.literal('not_connected'), account: z.null(),
  source_session_id: id, source_revision: z.number().int().nonnegative().max(2_147_483_646), account_ref: accountRef,
  review_expires_at: z.iso.datetime(), closure: AppConnectionCredentialRepairClosureSchema,
}).refine(appConnectionSessionViewDeadline);
const envelope = { schema_version: z.literal('deft.app_connection_credential_repair_runtime.v1'), session_id: id,
  scope: AppConnectionSessionScopeSchema, source: AppConnectionCredentialRepairSourceSchema, transport_digest: digest,
  historical_attempts:AppConnectionCredentialRepairHistoricalAttemptsSchema,publication_continuity_digest:z.null(),
  review_expires_at: z.iso.datetime(), expires_at: z.iso.datetime(), action_consents: AppConnectionActionConsentsSchema };
const variants = [
  z.strictObject({ ...envelope, operation: z.literal('prepare') }),
  z.strictObject({ ...envelope, operation: z.literal('begin'), review: AppConnectionCredentialRepairStoredReviewSchema,
    callback_state: AppConnectionSessionBegunSchema.shape.callback_state }),
  z.strictObject({ ...envelope, operation: z.literal('callback'), review: AppConnectionCredentialRepairStoredReviewSchema,
    runtime_session_ref: opaque, callback: z.discriminatedUnion('outcome', [
      z.strictObject({ outcome: z.literal('authorized'), code: z.string().min(1).max(4096).regex(/^[^\u0000-\u0020\u007f]+$/u) }),
      z.strictObject({ outcome: z.literal('denied') })]) }),
  z.strictObject({ ...envelope, operation: z.literal('status'), review: AppConnectionCredentialRepairStoredReviewSchema.nullable(),
    runtime_session_ref: opaque.nullable(),close_prepared:z.literal(true).optional(),close_expired:z.literal(true).optional(),close_uncertain:z.literal(true).optional(),
    acknowledged_receipt:z.strictObject({session_id:id,session_revision:z.number().int().positive(),receipt_digest:digest}).optional(),
    acknowledged_closure:z.strictObject({session_id:id,session_revision:z.number().int().positive(),receipt_digest:digest}).optional() }),
] as const;
const deadline = (value: { operation: string; expires_at: string; review_expires_at: string;
  scope: { consent_expires_at: string | null; consent_lifetime?: 'until_revoked' }; action_consents: z.infer<typeof AppConnectionActionConsentsSchema> }) =>
  Date.parse(value.review_expires_at) <= appConsentDeadline(value.scope.consent_expires_at, value.scope.consent_lifetime)
  && Date.parse(value.expires_at) <= appConsentDeadline(value.scope.consent_expires_at, value.scope.consent_lifetime)
  && (value.operation === 'status' || (value.operation === 'callback' || Date.parse(value.expires_at) <= Date.parse(value.review_expires_at))
    && value.action_consents.every(consent => Date.parse(value.expires_at) <= appConsentDeadline(consent.expires_at, consent.consent_lifetime)));
export const AppConnectionCredentialRepairRuntimeRequestSchema = z.discriminatedUnion('operation', variants).refine(deadline)
 .refine(v=>canonicalConnectionReattachmentJson(v.scope)===canonicalConnectionReattachmentJson(v.source.scope))
 .refine(v=>v.operation!=='status'||[v.close_prepared,v.close_expired,v.close_uncertain,v.acknowledged_receipt,v.acknowledged_closure].filter(Boolean).length<=1);
export type AppConnectionCredentialRepairRuntimeRequest = Readonly<z.infer<typeof AppConnectionCredentialRepairRuntimeRequestSchema>>;
export const AppConnectionCredentialRepairAuthorityRequestSchema = AppConnectionCredentialRepairRuntimeRequestSchema;
export const AppConnectionCredentialRepairAuthorityResultSchema = z.discriminatedUnion('operation', [
  variants[0].extend({ allowed: z.literal(true) }), variants[1].extend({ allowed: z.literal(true) }),
  variants[2].extend({ allowed: z.literal(true) }), variants[3].extend({ allowed: z.literal(true) }),
]).refine(deadline);
export const AppConnectionCredentialRepairRuntimeResultSchema = z.discriminatedUnion('state', [
  AppConnectionReattachEligibilitySchema.extend({ schema_version: z.literal('deft.app_connection_credential_repair_runtime.v1'),
    session_id: id, state: z.literal('eligible'),fence:AppConnectionCredentialRepairFenceSchema }),
  z.strictObject({ schema_version: z.literal('deft.app_connection_credential_repair_runtime.v1'), session_id: id,
    state: z.literal('awaiting_callback'), runtime_session_ref: opaque,
    custody_generation:generation,
    authorization_url: AppConnectionSessionBegunSchema.shape.authorization_url }),
  z.strictObject({ schema_version: z.literal('deft.app_connection_credential_repair_runtime.v1'), session_id: id,
    state: z.literal('connected'), account, runtime_session_ref: opaque, custody_generation: generation, receipt_digest: digest,reservation_closed:z.boolean() }),
  z.strictObject({ schema_version: z.literal('deft.app_connection_credential_repair_runtime.v1'), session_id: id,
    state: z.enum(['expired','denied','cancelled']), closure: AppConnectionCredentialRepairClosureSchema,reservation_closed:z.boolean() }),
  z.strictObject({ schema_version: z.literal('deft.app_connection_credential_repair_runtime.v1'), session_id: id,
    state: z.enum(['not_connected', 'indeterminate']) }),
]);
export type AppConnectionCredentialRepairRuntimeResult = Readonly<z.infer<typeof AppConnectionCredentialRepairRuntimeResultSchema>>;
