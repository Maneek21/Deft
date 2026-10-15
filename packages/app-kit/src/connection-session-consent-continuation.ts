import { AppConsentLifetimeSchema, AppConsentExpirySchema, appConsentDeadline, appConsentExpiryValid } from './consent-lifetime.js';
import { z } from 'zod';
import { AppConnectionSessionScopeSchema, AppConnectionSessionViewSchema } from './connection-session.js';
import { AppConnectionActionConsentsSchema } from './connection-session-v2.js';
import { AppConnectionReattachSourceSchema, AppConnectionReattachEligibilitySchema,
  canonicalConnectionReattachmentJson } from './connection-session-reattach.js';

const id = z.string().uuid();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const opaque = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
const account = AppConnectionSessionViewSchema.shape.account.unwrap();
const generation = z.number().int().positive().max(2_147_483_646);
export const APP_CONNECTION_CONSENT_CONTINUATION_VERSION = 'deft.app_connection_consent_continuation_runtime.v1' as const;

/** Historical locator/purpose pins are evidence only; never extended authority. */
export const AppConnectionConsentContinuationSourceSchema = AppConnectionReattachSourceSchema.extend({
  action_consents: AppConnectionActionConsentsSchema,
});
export const AppConnectionConsentContinuationStoredReviewSchema = AppConnectionReattachEligibilitySchema.extend({ digest });
export const AppConnectionConsentContinuationReviewRequestSchema = z.strictObject({
  installation_id: id, target_key: AppConnectionSessionScopeSchema.shape.target_key,
  source_session_id: id, request_id: id, consent_expires_at: AppConsentExpirySchema, consent_lifetime: AppConsentLifetimeSchema.optional(),
}).refine(value => appConsentExpiryValid(value.consent_expires_at,value.consent_lifetime) && value.request_id !== value.source_session_id, 'Continuation requires a new identity');
export const AppConnectionConsentContinuationActivateRequestSchema = z.strictObject({ session_id: id, review_digest: digest });
export const AppConnectionConsentContinuationStatusRequestSchema = z.strictObject({ session_id: id });

const envelope = {
  schema_version: z.literal(APP_CONNECTION_CONSENT_CONTINUATION_VERSION), session_id: id,
  scope: AppConnectionSessionScopeSchema, source: AppConnectionConsentContinuationSourceSchema,
  action_consents: AppConnectionActionConsentsSchema, transport_digest: digest,
  review_expires_at: z.iso.datetime(), expires_at: z.iso.datetime(),
};
const variants = [
  z.strictObject({ ...envelope, operation: z.literal('prepare') }),
  z.strictObject({ ...envelope, operation: z.literal('activate'), review: AppConnectionConsentContinuationStoredReviewSchema }),
  z.strictObject({ ...envelope, operation: z.literal('status'), review: AppConnectionConsentContinuationStoredReviewSchema.nullable() }),
] as const;
type Envelope = z.infer<typeof variants[number]>;
function valid(value: Envelope): boolean {
  const source = value.source;
  if (value.session_id === source.session_id
    || Object.keys(value.scope).some(key => !['consent_expires_at','consent_lifetime'].includes(key)
      && value.scope[key as keyof typeof value.scope] !== source.scope[key as keyof typeof source.scope])
    || appConsentDeadline(value.scope.consent_expires_at, value.scope.consent_lifetime) <= appConsentDeadline(source.scope.consent_expires_at, source.scope.consent_lifetime)
    || value.action_consents.length !== source.action_consents.length) return false;
  for (let index = 0; index < value.action_consents.length; index++) {
    const old = source.action_consents[index]!, current = value.action_consents[index]!;
    if (['action_binding_id', 'action_key', 'authority_epoch', 'consent_id'].some(key =>
      old[key as keyof typeof old] !== current[key as keyof typeof current])
      || appConsentDeadline(old.expires_at, old.consent_lifetime) > appConsentDeadline(source.scope.consent_expires_at, source.scope.consent_lifetime)
      || appConsentDeadline(current.expires_at, current.consent_lifetime) > appConsentDeadline(value.scope.consent_expires_at, value.scope.consent_lifetime)
      || appConsentDeadline(current.expires_at, current.consent_lifetime) <= appConsentDeadline(old.expires_at, old.consent_lifetime)) return false;
  }
  if ('review' in value && value.review && value.review.account.account_ref !== source.account_ref) return false;
  // Historical source consent is identity evidence only. Every phase obtains
  // independent fresh owner authority; original consent may already be expired.
  return Date.parse(value.review_expires_at) <= appConsentDeadline(value.scope.consent_expires_at, value.scope.consent_lifetime)
    && Date.parse(value.expires_at) <= appConsentDeadline(value.scope.consent_expires_at, value.scope.consent_lifetime)
    && (value.operation === 'status' || Date.parse(value.expires_at) <= Date.parse(value.review_expires_at)
      && value.action_consents.every(consent => Date.parse(value.expires_at) <= appConsentDeadline(consent.expires_at, consent.consent_lifetime)));
}
export const AppConnectionConsentContinuationRuntimeRequestSchema = z.discriminatedUnion('operation', variants)
  .refine(valid, 'Consent continuation must preserve identities/purposes and extend only bounded deadlines');
export type AppConnectionConsentContinuationRuntimeRequest = Readonly<z.infer<typeof AppConnectionConsentContinuationRuntimeRequestSchema>>;
export const AppConnectionConsentContinuationAuthorityRequestSchema = AppConnectionConsentContinuationRuntimeRequestSchema;
export const AppConnectionConsentContinuationAuthorityResultSchema = z.discriminatedUnion('operation', [
  variants[0].extend({ allowed: z.literal(true) }), variants[1].extend({ allowed: z.literal(true) }),
  variants[2].extend({ allowed: z.literal(true) }),
]).refine(valid, 'Consent continuation authority must retain exact reviewed pins');
export const AppConnectionConsentContinuationRuntimeResultSchema = z.discriminatedUnion('state', [
  AppConnectionReattachEligibilitySchema.extend({ schema_version: z.literal(APP_CONNECTION_CONSENT_CONTINUATION_VERSION),
    session_id: id, state: z.literal('eligible') }),
  z.strictObject({ schema_version: z.literal(APP_CONNECTION_CONSENT_CONTINUATION_VERSION), session_id: id,
    state: z.literal('connected'), account, runtime_session_ref: opaque, custody_generation: generation, receipt_digest: digest }),
  z.strictObject({ schema_version: z.literal(APP_CONNECTION_CONSENT_CONTINUATION_VERSION), session_id: id, state: z.literal('indeterminate') }),
]);
export type AppConnectionConsentContinuationRuntimeResult = Readonly<z.infer<typeof AppConnectionConsentContinuationRuntimeResultSchema>>;
export const AppConnectionConsentContinuationReviewViewSchema = z.strictObject({
  schema_version: z.literal('deft.app_connection_consent_continuation_review.v1'), session_id: id,
  source_session_id: id, source_revision: z.number().int().positive().max(2_147_483_646),
  scope: AppConnectionSessionScopeSchema, action_consents: AppConnectionActionConsentsSchema,
  account, custody_generation: generation, review_digest: digest, expires_at: z.iso.datetime(),
}).refine(value => value.session_id !== value.source_session_id
  && Date.parse(value.expires_at) <= appConsentDeadline(value.scope.consent_expires_at, value.scope.consent_lifetime)
  && value.action_consents.every(consent => Date.parse(value.expires_at) <= appConsentDeadline(consent.expires_at, consent.consent_lifetime)));

/** Pure canonical payloads: consumers hash UTF-8 canonical JSON with SHA256.
 * Operation and short I/O deadline are intentionally not durable identity pins. */
export function appConnectionConsentContinuationPins(raw: unknown) {
  const value = AppConnectionConsentContinuationRuntimeRequestSchema.parse(raw);
  return { session_id: value.session_id, scope: value.scope, source: value.source,
    action_consents: value.action_consents, transport_digest: value.transport_digest,
    review_expires_at: value.review_expires_at };
}
export function appConnectionConsentContinuationReviewValue(raw: unknown, rawEligibility: unknown) {
  const pins = appConnectionConsentContinuationPins(raw);
  const eligibility = AppConnectionReattachEligibilitySchema.parse(rawEligibility);
  if (eligibility.account.account_ref !== pins.source.account_ref) throw Error('Continuation account changed');
  return { schema_version: 'deft.app_connection_consent_continuation_review_pin.v1' as const, ...pins, eligibility };
}
export function appConnectionConsentContinuationReceiptValue(raw: unknown, rawReview: unknown, runtimeSessionRef: string) {
  const request = AppConnectionConsentContinuationRuntimeRequestSchema.parse(raw);
  const pins = appConnectionConsentContinuationPins(request);
  const review = AppConnectionConsentContinuationStoredReviewSchema.parse(rawReview);
  if (request.operation === 'prepare' || !request.review
    || canonicalConnectionReattachmentJson(request.review) !== canonicalConnectionReattachmentJson(review)
    || review.account.account_ref !== pins.source.account_ref || runtimeSessionRef === pins.source.runtime_session_ref)
    throw Error('Continuation account/session identity changed');
  return { schema_version: 'deft.app_connection_consent_continuation_receipt.v1' as const,
    ...pins, review, runtime_session_ref: opaque.parse(runtimeSessionRef) };
}
export const canonicalConnectionConsentContinuationJson = canonicalConnectionReattachmentJson;

/** Checks cross-message pins without granting authority or resolving custody. */
export function validateAppConnectionConsentContinuationResult(rawRequest: unknown, rawResult: unknown) {
  const request = AppConnectionConsentContinuationRuntimeRequestSchema.parse(rawRequest);
  const result = AppConnectionConsentContinuationRuntimeResultSchema.parse(rawResult);
  if (request.session_id !== result.session_id) throw Error('Continuation result identity changed');
  if (result.state === 'indeterminate') return result;
  if (result.account.account_ref !== request.source.account_ref) throw Error('Continuation result account changed');
  const review = 'review' in request ? request.review : null;
  if (result.state === 'eligible') {
    if (request.operation === 'activate' || review && (review.custody_generation !== result.custody_generation
      || review.custody_digest !== result.custody_digest
      || canonicalConnectionReattachmentJson(review.account) !== canonicalConnectionReattachmentJson(result.account)))
      throw Error('Continuation eligibility changed');
  } else if (request.operation === 'prepare' || !review || result.custody_generation !== review.custody_generation
    || result.runtime_session_ref === request.source.runtime_session_ref
    || canonicalConnectionReattachmentJson(result.account) !== canonicalConnectionReattachmentJson(review.account)) {
    throw Error('Continuation must preserve custody and use a new session reference');
  }
  return result;
}
