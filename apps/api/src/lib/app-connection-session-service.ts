import {appConsentDeadline} from '@deft/app-kit';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  AppConnectionProfileSchema, AppConnectionSessionScopeSchema, AppConnectionSessionBeginSchema,
  AppConnectionSessionCallbackSchema, AppConnectionSessionManageSchema, AppConnectionRuntimeRequestSchema,
  AppConnectionRuntimeResultSchema, AppConnectionSessionViewSchema, AppConnectionSessionBegunSchema,
  AppConnectionSessionRefreshSchema, AppConnectionSessionRefreshResultSchema, canonicalAppConnectionProfileJson,
  AppConnectionActionConsentSchema, type AppConnectionActionConsent,
  AppConnectionReattachmentSchema,
  AppConnectionActionConsentsSchema, AppConnectionUpgradeSchema, AppConnectionRuntimeV2RequestSchema,
  AppConnectionCredentialRepairSchema,
  type AppConnectionActionConsents, type AppConnectionRuntimeV2Request,
  type AppConnectionProfile, type AppConnectionSessionScope, type AppConnectionSessionView,
  type AppConnectionSessionBegun, type AppConnectionRegisteredRuntime, type AppConnectionRuntimeRequest,
} from '@deft/app-kit';
import { AppError } from './app-errors.js';
import type { ExperienceCaller } from './app-experience-service.js';

const SESSION_MS = 10 * 60_000;
const IO_MS = 30_000;
const account = AppConnectionSessionViewSchema.shape.account;
export const AppConnectionSessionRecordSchema = z.strictObject({
  session_id: z.string().uuid(), revision: z.number().int().nonnegative().max(2_147_483_647),
  scope: AppConnectionSessionScopeSchema, profile: AppConnectionProfileSchema,
  state: z.enum(['starting', 'awaiting_callback', 'connecting', 'checking', 'disconnecting', 'connected', 'not_connected', 'disconnected', 'indeterminate',
    'reattach_reviewed', 'reattaching', 'reattach_checking','upgrade_reviewed','upgrade_starting','upgrade_checking','repair_reviewed','repair_starting','repair_checking']),
  callback_state_hash: z.string().regex(/^[a-f0-9]{64}$/u), callback_consumed: z.boolean(),
  callback_expires_at: z.iso.datetime(), runtime_session_ref: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u).nullable(),
  account, created_at: z.iso.datetime(), updated_at: z.iso.datetime(),
  action_consent: AppConnectionActionConsentSchema.optional(),
  reattachment: AppConnectionReattachmentSchema.optional(),
  action_consents: AppConnectionActionConsentsSchema.optional(), upgrade: AppConnectionUpgradeSchema.optional(),
  credential_repair:AppConnectionCredentialRepairSchema.optional(),
}).superRefine((value,ctx)=>{
  if(value.credential_repair&&value.state==='connected'&&(!value.runtime_session_ref||!value.account||!value.credential_repair.receipt
    ||!isDeepStrictEqual(value.account,value.credential_repair.review?.account)))
    ctx.addIssue({code:'custom',message:'Connected repair must retain its sealed account and receipt'});
  if(value.credential_repair&&(!value.action_consents||value.upgrade||value.reattachment||value.action_consent))
    ctx.addIssue({code:'custom',message:'Credential repair requires its own exact authority protocol'});
  if(value.credential_repair&&(!isDeepStrictEqual(value.scope,value.credential_repair.source.scope)
    ||Date.parse(value.credential_repair.review_expires_at)>appConsentDeadline(value.scope.consent_expires_at, value.scope.consent_lifetime)))
    ctx.addIssue({code:'custom',message:'Credential repair cannot change or renew authority'});
  if(value.action_consent&&value.action_consents!==undefined||value.upgrade&&(!value.action_consents||value.reattachment))
    ctx.addIssue({code:'custom',message:'Connection protocols cannot mix authority formats'});
  if(value.upgrade&&Date.parse(value.upgrade.review_expires_at)>appConsentDeadline(value.scope.consent_expires_at, value.scope.consent_lifetime))
    ctx.addIssue({code:'custom',message:'Upgrade review exceeds current consent'});
  if(value.upgrade?.closure&&(value.callback_consumed||value.account!==null||value.state!=='not_connected'))
    ctx.addIssue({code:'custom',message:'Expired upgrade closure cannot admit a callback or account'});
  if(value.action_consents?.some(consent=>consent.consent_id!==consent.action_binding_id
    ||appConsentDeadline(consent.expires_at, consent.consent_lifetime)>appConsentDeadline(value.scope.consent_expires_at, value.scope.consent_lifetime)))
    ctx.addIssue({code:'custom',message:'Independent action consent exceeds its binding'});
});
const recordSchema = AppConnectionSessionRecordSchema;
export type AppConnectionSessionRecord = Readonly<z.infer<typeof recordSchema>>;
export type AppConnectionSessionLocator = Readonly<{ org_id: string; owner_user_id: string; session_id: string }>;
export type AppConnectionSessionPurpose = 'begin' | 'callback' | 'status' | 'disconnect' | 'refresh'
  | 'reattach_review' | 'reattach_activate' | 'reattach_status'|'upgrade_review'|'upgrade_begin'|'upgrade_callback'|'upgrade_status';
export type AppConnectionSessionAuthority = Readonly<{
  scope: AppConnectionSessionScope; profile: AppConnectionProfile;
  action_consent?: AppConnectionActionConsent;
  action_consents?: AppConnectionActionConsents;
  /** Deadline of the currently verified human web/experience authority. */
  expires_at: number;
}>;
export type AppConnectionSessionPorts = Readonly<{
  /** Must use the existing installation/grant, owner resource consent and
   * admitted runtime authority; no account handle is caller nominated. */
  currentAuthority(caller: ExperienceCaller, nomination: z.infer<typeof AppConnectionSessionBeginSchema>,
    purpose: AppConnectionSessionPurpose): Promise<AppConnectionSessionAuthority>;
  /** Resolves only an already admitted out-of-process runtime transport. This
   * service never imports app modules or creates credential-holding adapters. */
  registeredRuntime(scope: AppConnectionSessionScope, profile: AppConnectionProfile): Promise<AppConnectionRegisteredRuntime>;
  registeredRuntimeV2?(scope:AppConnectionSessionScope,profile:AppConnectionProfile):Promise<Readonly<{
    identity:AppConnectionRegisteredRuntime['identity'];request(input:AppConnectionRuntimeV2Request,signal:AbortSignal):Promise<unknown>}>>;
  sessionAvailable?(record:AppConnectionSessionRecord):Promise<boolean>;
  store: Readonly<{
    /** Persist before acknowledging. Stores must be durable across restarts,
     * enforce unique session IDs, and scope every read/CAS by org AND owner. */
    create(record: AppConnectionSessionRecord): Promise<boolean>;
    read(locator: AppConnectionSessionLocator): Promise<AppConnectionSessionRecord | null>;
    /** Atomic cross-process CAS; commit before returning true. Persisting the
     * connecting/disconnecting state precedes provider IO. A crashed or unknown
     * attempt is never automatically retried by this service. */
    compareAndSet(locator: AppConnectionSessionLocator, expectedRevision: number, next: AppConnectionSessionRecord): Promise<boolean>;
  }>;
  /** Optional bridge to the existing resource-sync scheduler and receipts.
   * It must bind idempotency to request_id/scope and atomically verify this
   * connected session revision/account at admission. The worker must recheck
   * that current custody before provider IO; scheduling is not a new grant. */
  refreshResource?(input: Readonly<{ session_id: string; session_revision: number; scope: AppConnectionSessionScope; account_ref: string; request_id: string }>):
    Promise<z.infer<typeof AppConnectionSessionRefreshResultSchema>>;
}>;
const denied = () => new AppError('Account connection access ended', 'APP_ACCESS_DENIED', 403);
const conflict = () => new AppError('Account connection state changed', 'APP_STATE_CONFLICT', 409);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const profileDigest = (value: AppConnectionProfile) => `sha256:${hash(canonicalAppConnectionProfileJson(value))}`;
const locator = (record: AppConnectionSessionRecord): AppConnectionSessionLocator => ({
  org_id: record.scope.org_id, owner_user_id: record.scope.owner_user_id, session_id: record.session_id,
});

/** E1 core only: production durable store, authority composition and HTTP/runtime
 * transports must be explicitly supplied. No default in-memory store, dynamic
 * adapter loader, OAuth credentials, automatic retry or new action-effect path. */
export class AppConnectionSessionService {
  private lastClock = 0;
  constructor(private readonly ports: AppConnectionSessionPorts, private readonly now = () => Date.now()) {}
  private clock() { this.lastClock = Math.max(this.lastClock, this.now()); return this.lastClock; }
  private async authority(caller: ExperienceCaller, nomination: z.infer<typeof AppConnectionSessionBeginSchema>,
    purpose: AppConnectionSessionPurpose, expected?: AppConnectionSessionRecord) {
    const raw = await this.ports.currentAuthority(caller, nomination, purpose);
    const current = { scope: AppConnectionSessionScopeSchema.parse(raw.scope), profile: AppConnectionProfileSchema.parse(raw.profile),
      ...(raw.action_consent ? { action_consent: AppConnectionActionConsentSchema.parse(raw.action_consent) } : {}),
      ...(raw.action_consents?{action_consents:AppConnectionActionConsentsSchema.parse(raw.action_consents)}:{}),
      expires_at: Math.min(z.number().finite().parse(raw.expires_at), caller.access_expires_at === undefined
        ? Infinity : z.number().finite().parse(caller.access_expires_at)) };
    const scope = current.scope;
    if (scope.org_id !== caller.org_id || scope.owner_user_id !== caller.user_id
      || scope.installation_id !== nomination.installation_id || scope.target_key !== nomination.target_key
      || scope.operator_user_id !== current.profile.operator_user_id || scope.resource_key !== current.profile.resource_key
      || scope.profile_digest !== profileDigest(current.profile)
      || current.expires_at <= this.clock() || appConsentDeadline(scope.consent_expires_at, scope.consent_lifetime) <= this.clock()
      || (caller.access_expires_at !== undefined && caller.access_expires_at <= this.clock())
      || expected && (!isDeepStrictEqual(expected.scope, scope) || !isDeepStrictEqual(expected.profile, current.profile))
      || (purpose === 'begin' || purpose === 'callback') && (current.action_consent && appConsentDeadline(current.action_consent.expires_at,current.action_consent.consent_lifetime) <= this.clock()
        || current.action_consents?.some(consent=>appConsentDeadline(consent.expires_at, consent.consent_lifetime)<=this.clock())
        || expected && (!isDeepStrictEqual(expected.action_consent, current.action_consent)
          || !isDeepStrictEqual(expected.action_consents,current.action_consents)))) throw denied();
    return current;
  }
  private async read(caller: ExperienceCaller, sessionId: string) {
    const stored = await this.ports.store.read({ org_id: caller.org_id, owner_user_id: caller.user_id, session_id: sessionId });
    if (!stored) throw denied();
    const record = recordSchema.parse(stored);
    if (record.session_id !== sessionId || record.scope.org_id !== caller.org_id || record.scope.owner_user_id !== caller.user_id) throw denied();
    return record;
  }
  private nomination(record: AppConnectionSessionRecord) {
    return { installation_id: record.scope.installation_id, target_key: record.scope.target_key };
  }
  private checkDeadline(authority: AppConnectionSessionAuthority, record: AppConnectionSessionRecord) {
    if (Math.min(authority.expires_at, appConsentDeadline(record.scope.consent_expires_at, record.scope.consent_lifetime)) <= this.clock()
      || ['starting', 'awaiting_callback', 'connecting'].includes(record.state)
      && Date.parse(record.callback_expires_at) <= this.clock()) throw denied();
  }
  private async write(previous: AppConnectionSessionRecord, change: Partial<AppConnectionSessionRecord>) {
    const next = recordSchema.parse({ ...previous, ...change, revision: previous.revision + 1, updated_at: new Date(this.clock()).toISOString() });
    if (!await this.ports.store.compareAndSet(locator(previous), previous.revision, next)) throw conflict();
    return next;
  }
  private view(record: AppConnectionSessionRecord): AppConnectionSessionView {
    const publicState = ['starting', 'connecting', 'checking', 'disconnecting', 'reattach_reviewed', 'reattaching', 'reattach_checking','upgrade_reviewed','upgrade_starting','upgrade_checking'].includes(record.state) ? 'indeterminate' : record.state;
    return AppConnectionSessionViewSchema.parse({ schema_version: 'deft.app_connection_session.v1', session_id: record.session_id,
      state: publicState, scope: record.scope, account: record.account,
      expires_at: ['starting', 'awaiting_callback', 'connecting'].includes(record.state) ? record.callback_expires_at : record.scope.consent_expires_at });
  }
  private async invoke(caller: ExperienceCaller, record: AppConnectionSessionRecord, purpose: AppConnectionSessionPurpose,
    authority: AppConnectionSessionAuthority, request: AppConnectionRuntimeRequest) {
    const controller = new AbortController();
    const remaining = Math.min(IO_MS, authority.expires_at - this.clock(), appConsentDeadline(record.scope.consent_expires_at, record.scope.consent_lifetime) - this.clock(),
      ['starting', 'connecting'].includes(record.state) ? Date.parse(record.callback_expires_at) - this.clock() : IO_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let committed: AppConnectionSessionRecord | undefined;
    let ioDeadline = this.clock() + remaining;
    try {
      this.checkDeadline(authority, record);
      // One bounded call includes registration resolution. A hung transport may
      // retain the signal, but its late result is never persisted or disclosed.
      let rejectDeadline: (reason: Error) => void = () => {};
      const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
      const armDeadline = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { controller.abort(); rejectDeadline(new Error('Connection runtime deadline')); }, Math.max(1, ioDeadline - this.clock()));
      };
      armDeadline();
      const work = (async () => {
        const runtime = record.action_consents!==undefined
          ?await this.ports.registeredRuntimeV2?.(record.scope,record.profile):await this.ports.registeredRuntime(record.scope, record.profile);
        if(!runtime)throw denied();
        controller.signal.throwIfAborted();
        if (runtime.identity.runtime_registration_id !== record.scope.runtime_registration_id
          || runtime.identity.operator_user_id !== record.scope.operator_user_id || runtime.identity.runtime_epoch !== record.scope.runtime_epoch) throw denied();
        const current = await this.authority(caller, this.nomination(record), purpose, record);
        ioDeadline = Math.min(ioDeadline, current.expires_at);
        this.checkDeadline(authority, record); this.checkDeadline(current, record); controller.signal.throwIfAborted();
        armDeadline();
        const expires_at=new Date(Math.min(Date.parse(request.expires_at),authority.expires_at,current.expires_at,
          ...(['begin','callback'].includes(purpose)?record.action_consents?.map(consent=>appConsentDeadline(consent.expires_at, consent.consent_lifetime))??[]:[]))).toISOString();
        if(record.action_consents!==undefined){const {action_consent,...base}=request;void action_consent;
          return (runtime as Awaited<ReturnType<NonNullable<AppConnectionSessionPorts['registeredRuntimeV2']>>>).request(
            AppConnectionRuntimeV2RequestSchema.parse({...base,schema_version:'deft.app_connection_runtime.v2',action_consents:record.action_consents,expires_at}),controller.signal);}
        return (runtime as AppConnectionRegisteredRuntime).request(AppConnectionRuntimeRequestSchema.parse({...request,expires_at}),controller.signal);
      })();
      const reply = AppConnectionRuntimeResultSchema.parse(await Promise.race([work, deadline]));
      await this.authority(caller, this.nomination(record), purpose, record);
      this.checkDeadline(authority, record);
      if (this.clock() >= ioDeadline) throw denied();
      if (reply.state === 'awaiting_callback' && (purpose !== 'begin'
        || new URL(reply.authorization_url).origin !== record.profile.authorization_origin)) throw new Error('Invalid runtime connection response');
      if (purpose === 'begin' && reply.state !== 'awaiting_callback' || purpose === 'callback' && !['connected', 'not_connected', 'indeterminate'].includes(reply.state)
        || purpose === 'status' && !['connected', 'not_connected', 'disconnected', 'indeterminate'].includes(reply.state)
        || purpose === 'disconnect' && !['disconnected', 'indeterminate'].includes(reply.state)) throw new Error('Invalid connection transition');
      if (reply.state === 'connected' && record.account && reply.account.account_ref !== record.account.account_ref) throw new Error('Account changed');
      if (reply.state === 'connected' && purpose === 'status' && !record.account
        || reply.state === 'connected' && request.operation === 'callback' && request.callback.outcome === 'denied') throw new Error('Account was not established');
      committed = await this.write(record, { state: reply.state,
        account: reply.state === 'connected' ? reply.account : null,
        ...(reply.state === 'awaiting_callback' ? { runtime_session_ref: reply.runtime_session_ref } : {}) });
      await this.authority(caller, this.nomination(committed), purpose, committed);
      this.checkDeadline(authority, record);
      if (this.clock() >= ioDeadline) throw denied();
      controller.signal.throwIfAborted();
      return { record: committed, reply };
    } catch (error) {
      // A successful durable write advanced the revision. Its delivery guard
      // must never attempt another CAS against the obsolete previous record.
      if (!committed) committed = await this.write(record, { state: 'indeterminate' });
      // Withhold any outcome after scope loss. Unknown provider outcome retains
      // an indeterminate record rather than becoming an executable retry.
      if (error instanceof AppError && error.code === 'APP_ACCESS_DENIED') throw error;
      await this.authority(caller, this.nomination(committed), purpose, committed);
      this.checkDeadline(authority, record);
      return { record: { ...record, state: 'indeterminate' as const }, reply: { state: 'indeterminate' as const } };
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  async begin(caller: ExperienceCaller, raw: unknown): Promise<AppConnectionSessionBegun | AppConnectionSessionView> {
    const nomination = AppConnectionSessionBeginSchema.parse(raw);
    const authority = await this.authority(caller, nomination, 'begin');
    const state = randomBytes(32).toString('base64url'), now = this.clock();
    const record = recordSchema.parse({ session_id: randomUUID(), revision: 0, scope: authority.scope, profile: authority.profile,
      ...(authority.action_consent ? { action_consent: authority.action_consent } : {}),
      ...(authority.action_consents?{action_consents:authority.action_consents}:{}),
      state: 'starting', callback_state_hash: hash(state), callback_consumed: false,
      callback_expires_at: new Date(Math.min(now + SESSION_MS, authority.expires_at, appConsentDeadline(authority.scope.consent_expires_at, authority.scope.consent_lifetime))).toISOString(),
      runtime_session_ref: null, account: null, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() });
    if (!await this.ports.store.create(record)) throw conflict();
    const result = await this.invoke(caller, record, 'begin', authority, { schema_version: 'deft.app_connection_runtime.v1',
      operation: 'begin', session_id: record.session_id, scope: record.scope, expires_at: record.callback_expires_at, callback_state: state,
      ...(record.action_consent ? { action_consent: record.action_consent } : {}) });
    if (result.reply.state !== 'awaiting_callback') return this.view(result.record);
    return AppConnectionSessionBegunSchema.parse({ ...this.view(result.record), state: 'awaiting_callback', callback_state: state,
      authorization_url: result.reply.authorization_url });
  }
  async callback(caller: ExperienceCaller, raw: unknown): Promise<AppConnectionSessionView> {
    const input = AppConnectionSessionCallbackSchema.parse(raw), stored = await this.read(caller, input.session_id);
    if (stored.reattachment||stored.upgrade||stored.credential_repair) throw conflict();
    const authority = await this.authority(caller, this.nomination(stored), 'callback', stored);
    this.checkDeadline(authority, stored);
    if (stored.state !== 'awaiting_callback' || stored.callback_consumed || !stored.runtime_session_ref
      || !timingSafeEqual(Buffer.from(stored.callback_state_hash, 'hex'), Buffer.from(hash(input.state), 'hex'))) throw conflict();
    const record = await this.write(stored, { state: 'connecting', callback_consumed: true });
    const result = await this.invoke(caller, record, 'callback', authority, { schema_version: 'deft.app_connection_runtime.v1', operation: 'callback',
      session_id: record.session_id, scope: record.scope, expires_at: record.callback_expires_at,
      runtime_session_ref: stored.runtime_session_ref,
      ...(record.action_consent ? { action_consent: record.action_consent } : {}),
      callback: input.outcome === 'authorized' ? { outcome: 'authorized', code: input.code } : { outcome: 'denied' } });
    return this.view(result.record);
  }
  private async manage(caller: ExperienceCaller, raw: unknown, purpose: 'status' | 'disconnect') {
    const input = AppConnectionSessionManageSchema.parse(raw), stored = await this.read(caller, input.session_id);
    if(this.ports.sessionAvailable&&!await this.ports.sessionAvailable(stored))throw denied();
    const authority = await this.authority(caller, this.nomination(stored), purpose, stored);
    this.checkDeadline(authority, stored);
    // Pending upgrades resolve only through their dedicated read-only journal.
    if (stored.upgrade && !stored.upgrade.receipt) return this.view(stored);
    // Crashed/in-flight effects are unknown. This service never replays them.
    if (['starting', 'connecting', 'checking', 'disconnecting', 'indeterminate'].includes(stored.state) || stored.state === 'disconnected'
      || purpose === 'status' && stored.state === 'awaiting_callback') return this.view(stored);
    if (!stored.runtime_session_ref) throw conflict();
    const record = await this.write(stored, { state: purpose === 'status' ? 'checking' : 'disconnecting',
      ...(purpose === 'disconnect' ? { callback_consumed: true } : {}) });
    const result = await this.invoke(caller, record, purpose, authority, { schema_version: 'deft.app_connection_runtime.v1', operation: purpose,
      session_id: record.session_id, scope: record.scope, expires_at: new Date(authority.expires_at).toISOString(),
      runtime_session_ref: stored.runtime_session_ref, expected_account_ref: stored.account?.account_ref ?? null });
    return this.view(result.record);
  }
  status(caller: ExperienceCaller, raw: unknown) { return this.manage(caller, raw, 'status'); }
  disconnect(caller: ExperienceCaller, raw: unknown) { return this.manage(caller, raw, 'disconnect'); }
  async refresh(caller: ExperienceCaller, raw: unknown) {
    const input = AppConnectionSessionRefreshSchema.parse(raw), record = await this.read(caller, input.session_id);
    if(this.ports.sessionAvailable&&!await this.ports.sessionAvailable(record))throw denied();
    const authority = await this.authority(caller, this.nomination(record), 'refresh', record);
    this.checkDeadline(authority, record);
    if (!this.ports.refreshResource || record.state !== 'connected' || !record.account) throw conflict();
    const result = AppConnectionSessionRefreshResultSchema.parse(await this.ports.refreshResource({ session_id: record.session_id,
      session_revision: record.revision, scope: record.scope,
      account_ref: record.account.account_ref, request_id: input.request_id }));
    const current = await this.read(caller, record.session_id);
    if (current.revision !== record.revision || current.state !== 'connected' || current.account?.account_ref !== record.account.account_ref
      || !isDeepStrictEqual(current.scope, record.scope) || !isDeepStrictEqual(current.profile, record.profile)) throw denied();
    await this.authority(caller, this.nomination(current), 'refresh', current);
    this.checkDeadline(authority, record);
    if (result.session_id !== record.session_id || result.resource_binding_id !== record.scope.resource_binding_id) throw denied();
    return result;
  }
}
