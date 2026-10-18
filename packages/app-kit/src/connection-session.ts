import { AppConsentLifetimeSchema, AppConsentExpirySchema, appConsentDeadline, appConsentExpiryValid } from './consent-lifetime.js';
import { z } from 'zod';

const id = z.string().uuid();
const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u)
  .refine(value => !['constructor', 'prototype', '__proto__'].includes(value));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const epoch = z.number().int().nonnegative().max(2_147_483_647);
const text = z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f<>]+$/u);
const opaque = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const actions = z.array(key).max(16).refine(values =>
  values.every((value, index) => index === 0 || values[index - 1]! < value), 'Actions must be unique and sorted');
/** An explicit current owner-reviewed action grant. Its absence means that
 * OAuth setup may request only the reviewed read capability. */
export const AppConnectionActionConsentSchema = z.strictObject({ action_binding_id: id, action_key: key,
  authority_epoch: epoch, consent_id: id, consent_digest: digest, expires_at: AppConsentExpirySchema, consent_lifetime: AppConsentLifetimeSchema.optional() })
  .refine(v => appConsentExpiryValid(v.expires_at, v.consent_lifetime),{abort:true});
export type AppConnectionActionConsent = Readonly<z.infer<typeof AppConnectionActionConsentSchema>>;

/** Portable author request only. A host separately admits the provider profile,
 * operator, current deployment, owner consent and exact bindings. */
export const RequestedConnectionDeclarationSchema = z.strictObject({
  key, resource_key: key, action_keys: actions, provider_profile_key: key, runtime_requirement_key: key,
});
export type RequestedConnectionDeclaration = Readonly<z.infer<typeof RequestedConnectionDeclarationSchema>>;

/** Deployment-reviewed data only. This cannot nominate executable modules or
 * OAuth credentials. The operator runs the credential-holding runtime outside
 * the host API process; this declaration does not itself grant any authority. */
export const AppConnectionProfileSchema = z.strictObject({
  schema_version: z.literal('deft.app_connection_profile.v1'), key,
  provider_id: key, operator_user_id: id, runtime_requirement_key: key,
  resource_key: key, action_keys: actions,
  authorization_origin: z.string().max(512).refine(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value
      && !url.username && !url.password; } catch { return false; }
  }, 'Authorization origin must be an HTTPS origin'),
  credential_custody: z.literal('runtime'), executable: z.literal(false),
});
export type AppConnectionProfile = Readonly<z.infer<typeof AppConnectionProfileSchema>>;
export function canonicalAppConnectionProfileJson(value: unknown): string {
  const profile = AppConnectionProfileSchema.parse(value);
  return JSON.stringify(Object.fromEntries(Object.entries(profile).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}

/** Current existing installation, grant, owner-resource consent and admitted
 * runtime pins. Connection state is never a substitute for these authorities. */
export const AppConnectionSessionScopeSchema = z.strictObject({
  org_id: id, owner_user_id: id, installation_id: id, app_version_id: id, grant_snapshot_id: id,
  package_digest: digest, grant_snapshot_digest: digest, lifecycle_epoch: epoch, grant_epoch: epoch,
  target_key: key, resource_key: key, resource_binding_id: id,
  runtime_registration_id: id, operator_user_id: id, runtime_epoch: epoch,
  profile_digest: digest, consent_expires_at: AppConsentExpirySchema, consent_lifetime: AppConsentLifetimeSchema.optional(),
}).refine(v => appConsentExpiryValid(v.consent_expires_at, v.consent_lifetime),{abort:true});
export type AppConnectionSessionScope = Readonly<z.infer<typeof AppConnectionSessionScopeSchema>>;
export const AppConnectionSessionBeginSchema = z.strictObject({ installation_id: id, target_key: key });
export const AppConnectionSessionCallbackSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ session_id: id, state: token, outcome: z.literal('authorized'), code: z.string().min(1).max(4096)
    .regex(/^[^\u0000-\u0020\u007f]+$/u) }),
  z.strictObject({ session_id: id, state: token, outcome: z.literal('denied') }),
]);
export const AppConnectionSessionManageSchema = z.strictObject({ session_id: id });
/** Nominates only this session's reviewed resource. Scheduling and receipts are
 * supplied by the existing resource-sync path, with its own idempotency key. */
export const AppConnectionSessionRefreshSchema = z.strictObject({ session_id: id, request_id: id });
export const AppConnectionSessionRefreshResultSchema = z.strictObject({
  schema_version: z.literal('deft.app_connection_refresh.v1'), session_id: id,
  resource_binding_id: id, run_id: id, state: z.enum(['queued', 'running', 'completed', 'failed', 'indeterminate']),
});

const account = z.strictObject({ account_ref: opaque, label: text });
const runtimeRequest = { schema_version: z.literal('deft.app_connection_runtime.v1'), session_id: id,
  scope: AppConnectionSessionScopeSchema, expires_at: z.iso.datetime(), action_consent: AppConnectionActionConsentSchema.optional() };
/** Server/runtime transport requests contain no web cookies or host bearer.
 * Account handles are opaque runtime references, never provider credentials.
 * The registered runtime must revalidate these exact pins before provider IO. */
export const AppConnectionRuntimeRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...runtimeRequest, operation: z.literal('begin'), callback_state: token }),
  z.strictObject({ ...runtimeRequest, operation: z.literal('callback'), runtime_session_ref: opaque,
    callback: z.discriminatedUnion('outcome', [z.strictObject({ outcome: z.literal('authorized'), code: z.string().min(1).max(4096).regex(/^[^\u0000-\u0020\u007f]+$/u) }),
      z.strictObject({ outcome: z.literal('denied') })]) }),
  z.strictObject({ ...runtimeRequest, operation: z.literal('status'), runtime_session_ref: opaque, expected_account_ref: opaque.nullable() }),
  z.strictObject({ ...runtimeRequest, operation: z.literal('disconnect'), runtime_session_ref: opaque, expected_account_ref: opaque.nullable() }),
]);
export type AppConnectionRuntimeRequest = Readonly<z.infer<typeof AppConnectionRuntimeRequestSchema>>;

/** Runtime-only online authority check. This is not an owner/browser API and
 * never authorizes execution, resource content or a new provider scope. The
 * host checks the durable session's in-flight operation, current web session,
 * reviewed installation and registered operator before answering. */
export const AppConnectionRuntimeAuthorityRequestSchema = z.strictObject({
  schema_version: z.literal('deft.app_connection_runtime_authority.v1'),
  session_id: id, scope: AppConnectionSessionScopeSchema,
  action_consent: AppConnectionActionConsentSchema.optional(),
  operation: z.enum(['begin', 'callback', 'status', 'disconnect']),
  expires_at: z.iso.datetime(),
}).refine(value => Date.parse(value.expires_at) <= appConsentDeadline(value.scope.consent_expires_at, value.scope.consent_lifetime),
  'Runtime authority cannot outlive reviewed consent');
export type AppConnectionRuntimeAuthorityRequest = Readonly<z.infer<typeof AppConnectionRuntimeAuthorityRequestSchema>>;
export const AppConnectionRuntimeAuthorityResultSchema = z.strictObject({
  schema_version: z.literal('deft.app_connection_runtime_authority.v1'),
  allowed: z.literal(true), session_id: id, scope: AppConnectionSessionScopeSchema,
  action_consent: AppConnectionActionConsentSchema.optional(),
  operation: z.enum(['begin', 'callback', 'status', 'disconnect']),
  expires_at: z.iso.datetime(),
}).refine(value => Date.parse(value.expires_at) <= appConsentDeadline(value.scope.consent_expires_at, value.scope.consent_lifetime),
  'Runtime authority cannot outlive reviewed consent');
export type AppConnectionRuntimeAuthorityResult = Readonly<z.infer<typeof AppConnectionRuntimeAuthorityResultSchema>>;
const authorizationUrl = z.string().max(8192).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && ![...url.searchParams.keys()].some(key => /^(access_token|refresh_token|client_secret|id_token)$/iu.test(key)); }
  catch { return false; }
});
export const AppConnectionRuntimeResultSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('awaiting_callback'), runtime_session_ref: opaque, authorization_url: authorizationUrl }),
  z.strictObject({ state: z.literal('connected'), account }),
  z.strictObject({ state: z.literal('not_connected') }),
  z.strictObject({ state: z.literal('disconnected') }),
  z.strictObject({ state: z.literal('indeterminate') }),
]);
export type AppConnectionRuntimeResult = Readonly<z.infer<typeof AppConnectionRuntimeResultSchema>>;

export const appConnectionSessionViewDeadline = (v: {expires_at:string|null;scope:AppConnectionSessionScope}) =>
  v.expires_at===null?v.scope.consent_lifetime==='until_revoked':Date.parse(v.expires_at)<=appConsentDeadline(v.scope.consent_expires_at,v.scope.consent_lifetime);
export const AppConnectionSessionViewSchema = z.strictObject({
  schema_version: z.literal('deft.app_connection_session.v1'), session_id: id,
  state: z.enum(['awaiting_callback', 'connected', 'not_connected', 'disconnected', 'indeterminate']),
  scope: AppConnectionSessionScopeSchema, expires_at: AppConsentExpirySchema, account: account.nullable(),
}).refine(appConnectionSessionViewDeadline);
export type AppConnectionSessionView = Readonly<z.infer<typeof AppConnectionSessionViewSchema>>;
export const AppConnectionSessionBegunSchema = AppConnectionSessionViewSchema.safeExtend({
  state: z.literal('awaiting_callback'), expires_at:z.iso.datetime(), callback_state: token, authorization_url: authorizationUrl,
}).strict();
export type AppConnectionSessionBegun = Readonly<z.infer<typeof AppConnectionSessionBegunSchema>>;

/** Connection sessions establish account custody only. Resource pages still
 * use the existing sync protocol and effects still use App Runtime claims,
 * exact reviewed action bindings, payload snapshots and retained receipts. */
export type AppConnectionRegisteredRuntime = Readonly<{
  identity: Readonly<{ runtime_registration_id: string; operator_user_id: string; runtime_epoch: number }>;
  request(input: AppConnectionRuntimeRequest, signal: AbortSignal): Promise<unknown>;
}>;
