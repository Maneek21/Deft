import { appConsentDeadline} from './consent-lifetime.js';
import { z } from 'zod';
const accountRef=z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
import { appConnectionSessionViewDeadline, AppConnectionSessionScopeSchema, AppConnectionSessionViewSchema,
  AppConnectionSessionCallbackSchema, AppConnectionSessionBegunSchema } from './connection-session.js';
import { AppConnectionReattachSourceSchema, AppConnectionReattachEligibilitySchema } from './connection-session-reattach.js';
import { AppConnectionActionConsentsSchema } from './connection-session-v2.js';

const id = z.string().uuid();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const generation = z.number().int().positive().max(2_147_483_646);
const opaque = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
const account = AppConnectionSessionViewSchema.shape.account.unwrap();
export const AppConnectionUpgradeSourceSchema = AppConnectionReattachSourceSchema;
export const AppConnectionUpgradeStoredReviewSchema = AppConnectionReattachEligibilitySchema.extend({ digest });
export const AppConnectionUpgradeReceiptSchema = z.strictObject({ custody_generation: generation, receipt_digest: digest });
export const AppConnectionUpgradeClosureSchema = z.strictObject({ reason: z.literal('callback_expired'), custody_generation: generation, receipt_digest: digest });
export const AppConnectionUpgradeSchema = z.strictObject({
  schema_version: z.literal('deft.app_connection_upgrade.v1'), source: AppConnectionUpgradeSourceSchema,
  transport_digest: digest, review_expires_at: z.iso.datetime(),
  begin_consumed: z.boolean(),
  review: AppConnectionUpgradeStoredReviewSchema.nullable(), receipt: AppConnectionUpgradeReceiptSchema.nullable(),
  closure: AppConnectionUpgradeClosureSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.review && value.review.account.account_ref !== value.source.account_ref)
    ctx.addIssue({ code: 'custom', message: 'Upgrade cannot replace the account' });
  if (value.receipt && (!value.review || value.receipt.custody_generation !== value.review.custody_generation + 1))
    ctx.addIssue({ code: 'custom', message: 'Upgrade must advance the reviewed generation exactly once' });
  if(value.begin_consumed&&!value.review||value.receipt&&!value.begin_consumed)
    ctx.addIssue({code:'custom',message:'Upgrade requires a reviewed consumed Begin before any receipt'});
  if(value.closure&&(!value.begin_consumed||!value.review||value.receipt||value.closure.custody_generation!==value.review.custody_generation+1))
    ctx.addIssue({code:'custom',message:'Expired upgrade retains exactly the setup generation consumed by Begin'});
});
export type AppConnectionUpgrade = Readonly<z.infer<typeof AppConnectionUpgradeSchema>>;
export const AppConnectionUpgradeReviewRequestSchema = z.strictObject({ installation_id: id,
  target_key: AppConnectionSessionScopeSchema.shape.target_key, source_session_id: id, request_id: id });
export const AppConnectionUpgradeBeginRequestSchema = z.strictObject({ session_id: id, review_digest: digest });
export const AppConnectionUpgradeCallbackRequestSchema = AppConnectionSessionCallbackSchema;
export const AppConnectionUpgradeStatusRequestSchema = z.strictObject({ session_id: id });
export const AppConnectionUpgradeReviewViewSchema = z.strictObject({
  schema_version: z.literal('deft.app_connection_upgrade_review.v1'), session_id: id, source_session_id: id,
  source_revision: z.number().int().positive().max(2_147_483_646), scope: AppConnectionSessionScopeSchema,
  account, custody_generation: generation, action_consents: AppConnectionActionConsentsSchema,
  review_digest: digest, expires_at: z.iso.datetime(),
});
export const AppConnectionUpgradeBegunSchema = z.strictObject({ ...AppConnectionSessionBegunSchema.shape,
  schema_version: z.literal('deft.app_connection_upgrade_session.v1') }).refine(appConnectionSessionViewDeadline);
export const AppConnectionUpgradeClosedViewSchema = z.strictObject({ ...AppConnectionSessionViewSchema.shape,
  schema_version: z.literal('deft.app_connection_upgrade_closed.v1'), state: z.literal('not_connected'), account: z.null(),
  source_session_id: id, source_revision: z.number().int().nonnegative().max(2_147_483_646), account_ref: accountRef,
  review_expires_at: z.iso.datetime(), closure: AppConnectionUpgradeClosureSchema,
}).refine(appConnectionSessionViewDeadline);
const envelope = { schema_version: z.literal('deft.app_connection_upgrade_runtime.v1'), session_id: id,
  scope: AppConnectionSessionScopeSchema, source: AppConnectionUpgradeSourceSchema, transport_digest: digest,
  review_expires_at: z.iso.datetime(), expires_at: z.iso.datetime(), action_consents: AppConnectionActionConsentsSchema };
const variants = [
  z.strictObject({ ...envelope, operation: z.literal('prepare') }),
  z.strictObject({ ...envelope, operation: z.literal('begin'), review: AppConnectionUpgradeStoredReviewSchema,
    callback_state: AppConnectionSessionBegunSchema.shape.callback_state }),
  z.strictObject({ ...envelope, operation: z.literal('callback'), review: AppConnectionUpgradeStoredReviewSchema,
    runtime_session_ref: opaque, callback: z.discriminatedUnion('outcome', [
      z.strictObject({ outcome: z.literal('authorized'), code: z.string().min(1).max(4096).regex(/^[^\u0000-\u0020\u007f]+$/u) }),
      z.strictObject({ outcome: z.literal('denied') })]) }),
  z.strictObject({ ...envelope, operation: z.literal('status'), review: AppConnectionUpgradeStoredReviewSchema.nullable(),
    runtime_session_ref: opaque.nullable(), close_expired: z.literal(true).optional() }),
] as const;
const deadline = (value: { operation: string; expires_at: string; review_expires_at: string;
  scope: { consent_expires_at: string | null; consent_lifetime?: 'until_revoked' }; action_consents: z.infer<typeof AppConnectionActionConsentsSchema> }) =>
  Date.parse(value.review_expires_at) <= appConsentDeadline(value.scope.consent_expires_at, value.scope.consent_lifetime)
  && Date.parse(value.expires_at) <= appConsentDeadline(value.scope.consent_expires_at, value.scope.consent_lifetime)
  && (value.operation === 'status' || Date.parse(value.expires_at) <= Date.parse(value.review_expires_at)
    && value.action_consents.every(consent => Date.parse(value.expires_at) <= appConsentDeadline(consent.expires_at, consent.consent_lifetime)));
export const AppConnectionUpgradeRuntimeRequestSchema = z.discriminatedUnion('operation', variants).refine(deadline);
export type AppConnectionUpgradeRuntimeRequest = Readonly<z.infer<typeof AppConnectionUpgradeRuntimeRequestSchema>>;
export const AppConnectionUpgradeAuthorityRequestSchema = AppConnectionUpgradeRuntimeRequestSchema;
export const AppConnectionUpgradeAuthorityResultSchema = z.discriminatedUnion('operation', [
  variants[0].extend({ allowed: z.literal(true) }), variants[1].extend({ allowed: z.literal(true) }),
  variants[2].extend({ allowed: z.literal(true) }), variants[3].extend({ allowed: z.literal(true) }),
]).refine(deadline);
export const AppConnectionUpgradeRuntimeResultSchema = z.discriminatedUnion('state', [
  AppConnectionReattachEligibilitySchema.extend({ schema_version: z.literal('deft.app_connection_upgrade_runtime.v1'),
    session_id: id, state: z.literal('eligible') }),
  z.strictObject({ schema_version: z.literal('deft.app_connection_upgrade_runtime.v1'), session_id: id,
    state: z.literal('awaiting_callback'), runtime_session_ref: opaque,
    authorization_url: AppConnectionSessionBegunSchema.shape.authorization_url }),
  z.strictObject({ schema_version: z.literal('deft.app_connection_upgrade_runtime.v1'), session_id: id,
    state: z.literal('connected'), account, runtime_session_ref: opaque, custody_generation: generation, receipt_digest: digest }),
  z.strictObject({ schema_version: z.literal('deft.app_connection_upgrade_runtime.v1'), session_id: id,
    state: z.literal('expired'), closure: AppConnectionUpgradeClosureSchema }),
  z.strictObject({ schema_version: z.literal('deft.app_connection_upgrade_runtime.v1'), session_id: id,
    state: z.enum(['not_connected', 'indeterminate']) }),
]);
export type AppConnectionUpgradeRuntimeResult = Readonly<z.infer<typeof AppConnectionUpgradeRuntimeResultSchema>>;
