import {appConsentDeadline} from '@deft/app-kit/core';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  AppConnectionReattachReviewRequestSchema, AppConnectionReattachActivateRequestSchema,
  AppConnectionReattachStatusRequestSchema, AppConnectionReattachAnyReviewViewSchema,
  AppConnectionReattachAnyRuntimeRequestSchema, AppConnectionReattachAnyRuntimeResultSchema,
  AppConnectionSessionViewSchema, canonicalConnectionReattachmentJson,
  type AppConnectionReattachAnyRuntimeRequest, type AppConnectionReattachAnyRuntimeResult,
} from '@deft/app-kit/core';
import { AppError } from './app-errors.js';
import { AppConnectionSessionRecordSchema, type AppConnectionSessionRecord,
  type AppConnectionSessionLocator, type AppConnectionSessionAuthority, type AppConnectionSessionPorts, type AppConnectionSessionPurpose } from './app-connection-session-service.js';
import type {UnstartedReviewClosure} from './app-connection-review-closure.js';
import type { ExperienceCaller } from './app-experience-service.js';
import { REATTACH_PHASE_MS } from './app-connection-reattachment-deadline.js';

const denied = () => new AppError('Account reattachment access ended', 'APP_ACCESS_DENIED', 403);
const conflict = () => new AppError('Account reattachment changed', 'APP_STATE_CONFLICT', 409);
const sha = (value: unknown) => `sha256:${createHash('sha256').update(canonicalConnectionReattachmentJson(value)).digest('hex')}`;
const locator = (record: AppConnectionSessionRecord) => ({ org_id: record.scope.org_id,
  owner_user_id: record.scope.owner_user_id, session_id: record.session_id });
export type AppConnectionReattachmentPorts = Readonly<Pick<AppConnectionSessionPorts, 'currentAuthority'> & {
  store: AppConnectionSessionPorts['store'] & {createUnstartedReviewClosure?(record:AppConnectionSessionRecord):Promise<boolean>;readUnstartedReviewClosure?(session:AppConnectionSessionLocator):Promise<UnstartedReviewClosure|null>};
  transportDigest(record: AppConnectionSessionRecord): Promise<string>;
  requestRuntime(record: AppConnectionSessionRecord, input: AppConnectionReattachAnyRuntimeRequest, signal: AbortSignal): Promise<unknown>;
  /** Checks current host activity under the existing authority lock order.
   * The runtime additionally owns account-generation CAS and effect fences. */
  assertNoActiveEffects(source: AppConnectionSessionRecord, target: AppConnectionSessionAuthority, sessionId?: string): Promise<void>;
}>;

export function connectionReattachmentReviewDigest(record: AppConnectionSessionRecord,
  eligibility: { account: { account_ref: string; label: string }; custody_generation: number; custody_digest: string }) {
  const data = record.reattachment!;
  return sha({ schema_version: record.action_consents!==undefined?'deft.app_connection_reattach_review_pin.v2':'deft.app_connection_reattach_review_pin.v1', session_id: record.session_id,
    scope: record.scope, source: data.source, transport_digest: data.transport_digest,
    review_expires_at: data.review_expires_at, eligibility,
    ...(record.action_consents!==undefined?{action_consents:record.action_consents}:record.action_consent ? { action_consent: record.action_consent } : {}) });
}
export function connectionReattachmentReceiptDigest(record: AppConnectionSessionRecord,
  reply: Extract<AppConnectionReattachAnyRuntimeResult, { state: 'connected' }>) {
  const data = record.reattachment!;
  return sha({ schema_version: record.action_consents!==undefined?'deft.app_connection_reattach_receipt.v2':'deft.app_connection_reattach_receipt.v1', session_id: record.session_id,
    scope: record.scope, source: data.source, transport_digest: data.transport_digest,
    review_digest: data.review!.digest, account_ref: reply.account.account_ref,
    custody_generation: reply.custody_generation, runtime_session_ref: reply.runtime_session_ref });
}

/** Fresh authority over the same app-owned custody; OAuth setup is never used.
 * Status resolves the exact journal identity, including after review expiry. */
export class AppConnectionReattachmentService {
  private lastClock = 0;
  constructor(private readonly ports: AppConnectionReattachmentPorts, private readonly now = Date.now) {}
  private clock() { this.lastClock = Math.max(this.lastClock, this.now()); return this.lastClock; }
  private async read(caller: ExperienceCaller, sessionId: string) {
    const raw = await this.ports.store.read({ org_id: caller.org_id, owner_user_id: caller.user_id, session_id: sessionId });
    if (!raw) throw denied();
    const record = AppConnectionSessionRecordSchema.parse(raw);
    if (record.scope.org_id !== caller.org_id || record.scope.owner_user_id !== caller.user_id || record.session_id !== sessionId) throw denied();
    return record;
  }
  private async authority(caller: ExperienceCaller, nomination: { installation_id: string; target_key: string },
    purpose: AppConnectionSessionPurpose, expected?: AppConnectionSessionRecord) {
    const authority = await this.ports.currentAuthority(caller, nomination, purpose);
    if (authority.scope.org_id !== caller.org_id || authority.scope.owner_user_id !== caller.user_id
      || authority.scope.installation_id !== nomination.installation_id || authority.scope.target_key !== nomination.target_key
      || !Number.isFinite(authority.expires_at) || !Number.isFinite(caller.access_expires_at)
      || Math.min(authority.expires_at, caller.access_expires_at!, appConsentDeadline(authority.scope.consent_expires_at, authority.scope.consent_lifetime)) <= this.clock()
      || purpose!=='reattach_status'&&authority.action_consents?.some(consent=>appConsentDeadline(consent.expires_at, consent.consent_lifetime)<=this.clock())
      || expected && (!isDeepStrictEqual(expected.scope, authority.scope) || !isDeepStrictEqual(expected.profile, authority.profile)
        || purpose !== 'reattach_status' && (!isDeepStrictEqual(expected.action_consent, authority.action_consent)||!isDeepStrictEqual(expected.action_consents,authority.action_consents)))) throw denied();
    return { ...authority, expires_at: Math.min(authority.expires_at, caller.access_expires_at!) };
  }
  private nomination(record: AppConnectionSessionRecord) { return { installation_id: record.scope.installation_id, target_key: record.scope.target_key }; }
  private async source(caller: ExperienceCaller, record: AppConnectionSessionRecord) {
    if (!record.reattachment) throw conflict();
    const expected = record.reattachment.source, source = await this.read(caller, expected.session_id);
    if (source.state !== 'connected' || source.revision !== expected.session_revision
      || !isDeepStrictEqual(source.scope, expected.scope) || source.runtime_session_ref !== expected.runtime_session_ref
      || source.account?.account_ref !== expected.account_ref) throw denied();
    return source;
  }
  private async write(previous: AppConnectionSessionRecord, change: Partial<AppConnectionSessionRecord>) {
    const next = AppConnectionSessionRecordSchema.parse({ ...previous, ...change, revision: previous.revision + 1,
      updated_at: new Date(this.clock()).toISOString() });
    if (!await this.ports.store.compareAndSet(locator(previous), previous.revision, next)) throw conflict();
    return next;
  }
  private view(record: AppConnectionSessionRecord) {
    const data = record.reattachment!;
    if (record.state === 'reattach_reviewed' && data.review && !record.callback_consumed) return AppConnectionReattachAnyReviewViewSchema.parse({
      schema_version: record.action_consents!==undefined?'deft.app_connection_reattach_review.v2':'deft.app_connection_reattach_review.v1',
      ...(record.action_consents!==undefined?{action_consents:record.action_consents}:{}),session_id: record.session_id,
      source_session_id: data.source.session_id, source_revision: data.source.session_revision,
      scope: record.scope, account: data.review.account, custody_generation: data.review.custody_generation,
      review_digest: data.review.digest, expires_at: data.review_expires_at });
    return AppConnectionSessionViewSchema.parse({ schema_version: 'deft.app_connection_session.v1',
      session_id: record.session_id, state: record.state === 'connected' ? 'connected' : record.state === 'not_connected' ? 'not_connected' : 'indeterminate',
      scope: record.scope, account: record.account, expires_at: record.scope.consent_expires_at });
  }
  private request(record: AppConnectionSessionRecord, operation: 'prepare' | 'activate' | 'status', deadline: number) {
    const data = record.reattachment!;
    return AppConnectionReattachAnyRuntimeRequestSchema.parse({ schema_version: record.action_consents!==undefined?'deft.app_connection_reattach_runtime.v2':'deft.app_connection_reattach_runtime.v1',
      session_id: record.session_id, scope: record.scope, source: data.source, transport_digest: data.transport_digest,
      review_expires_at: data.review_expires_at, expires_at: new Date(deadline).toISOString(), operation,
      ...(record.action_consents!==undefined?{action_consents:record.action_consents}:record.action_consent ? { action_consent: record.action_consent } : {}),
      ...(operation === 'prepare' ? {} : { review: data.review }) });
  }
  private async invoke(caller: ExperienceCaller, record: AppConnectionSessionRecord, operation: 'prepare' | 'activate' | 'status') {
    const purpose = operation === 'prepare' ? 'reattach_review' : operation === 'activate' ? 'reattach_activate' : 'reattach_status';
    const authority = await this.authority(caller, this.nomination(record), purpose, record);
    const data = record.reattachment!;
    let deadline = Math.min(this.clock() + REATTACH_PHASE_MS, authority.expires_at, appConsentDeadline(record.scope.consent_expires_at, record.scope.consent_lifetime),
      operation === 'status' ? Infinity : Math.min(Date.parse(data.review_expires_at),...(record.action_consents??[]).map(consent=>appConsentDeadline(consent.expires_at, consent.consent_lifetime))));
    if (deadline <= this.clock()) throw denied();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectTimeout: ((error: unknown) => void) | undefined;
    const armTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { controller.abort(); rejectTimeout?.(denied()); }, Math.max(1, deadline - this.clock()));
    };
    let committed: AppConnectionSessionRecord | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; armTimeout(); });
      const work = (async () => {
        const source = await this.source(caller, record);
        if (await this.ports.transportDigest(source) !== data.transport_digest
          || await this.ports.transportDigest(record) !== data.transport_digest) throw denied();
        if (operation !== 'status' || !record.callback_consumed) {
          await this.ports.assertNoActiveEffects(source, authority, record.session_id);
        }
        const fresh = await this.authority(caller, this.nomination(record), purpose, record);
        deadline = Math.min(deadline, fresh.expires_at);
        if (deadline <= this.clock()) throw denied();
        armTimeout(); controller.signal.throwIfAborted();
        return this.ports.requestRuntime(record, this.request(record, operation, deadline), controller.signal);
      })();
      const reply = AppConnectionReattachAnyRuntimeResultSchema.parse(await Promise.race([work, timeout]));
      if (reply.schema_version!==(record.action_consents!==undefined?'deft.app_connection_reattach_runtime.v2':'deft.app_connection_reattach_runtime.v1')||reply.session_id !== record.session_id || deadline <= this.clock()) throw denied();
      await this.authority(caller, this.nomination(record), purpose, record);
      await this.source(caller, record);
      if (reply.state === 'eligible') {
        if (operation === 'activate' || record.callback_consumed || data.receipt || reply.account.account_ref !== data.source.account_ref) throw denied();
        await this.ports.assertNoActiveEffects(await this.source(caller, record),
          await this.authority(caller, this.nomination(record), purpose, record), record.session_id);
        const eligibility = { account: reply.account, custody_generation: reply.custody_generation, custody_digest: reply.custody_digest };
        const review = { ...eligibility, digest: connectionReattachmentReviewDigest(record, eligibility) };
        if (data.review && !isDeepStrictEqual(data.review, review)) throw denied();
        committed = await this.write(record, { state: Date.parse(data.review_expires_at) <= this.clock() ? 'not_connected' : 'reattach_reviewed',
          reattachment: { ...data, review } });
      } else if (reply.state === 'connected') {
        if (operation === 'prepare' || !data.review || reply.account.account_ref !== data.source.account_ref
          || !isDeepStrictEqual(reply.account, data.review.account)
          || reply.custody_generation !== data.review.custody_generation + 1
          || reply.receipt_digest !== connectionReattachmentReceiptDigest(record, reply)) throw denied();
        const receipt = { custody_generation: reply.custody_generation, receipt_digest: reply.receipt_digest };
        if (data.receipt && !isDeepStrictEqual(data.receipt, receipt)) throw denied();
        committed = await this.write(record, { state: 'connected', account: reply.account, runtime_session_ref: reply.runtime_session_ref,
          callback_consumed: true, reattachment: { ...data, receipt } });
      } else if (reply.state === 'not_connected') {
        // Only the authenticated v2 original status can carry a durable proof
        // that prepare never reserved a target or began custody activation.
        if (operation !== 'status' || reply.schema_version !== 'deft.app_connection_reattach_runtime.v2'
          || reply.reason !== 'prepare_not_started' || record.callback_consumed || data.review || data.receipt
          || record.account !== null || record.runtime_session_ref !== null
          || Date.parse(data.review_expires_at) > this.clock()) throw denied();
        committed = await this.write(record, { state: 'not_connected' });
      } else committed = await this.write(record, { state: 'indeterminate' });
      await this.authority(caller, this.nomination(committed), purpose, committed);
      if (deadline <= this.clock()) throw denied();
      controller.signal.throwIfAborted();
      return this.view(committed);
    } catch (error) {
      if (!committed) committed = await this.write(record, { state: 'indeterminate' });
      if (error instanceof AppError && error.code === 'APP_ACCESS_DENIED') throw error;
      await this.authority(caller, this.nomination(committed), purpose, committed);
      return this.view({ ...committed, state: 'indeterminate' });
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  async review(caller: ExperienceCaller, raw: unknown) {
    const input = AppConnectionReattachReviewRequestSchema.parse(raw);
    const authority = await this.authority(caller, input, 'reattach_review');
    const source = await this.read(caller, input.source_session_id);
    const old = source.scope, target = authority.scope;
    if (source.state !== 'connected' || !source.account || !source.runtime_session_ref
      || ['org_id', 'owner_user_id', 'installation_id', 'target_key', 'resource_key', 'operator_user_id', 'profile_digest']
        .some(key => old[key as keyof typeof old] !== target[key as keyof typeof target])
      || old.app_version_id === target.app_version_id || old.grant_snapshot_id === target.grant_snapshot_id
      || target.lifecycle_epoch <= old.lifecycle_epoch || target.grant_epoch <= old.grant_epoch
      || !isDeepStrictEqual(source.profile, authority.profile)) throw denied();
    if (!isDeepStrictEqual(source.action_consents?.map(consent=>consent.action_key),authority.action_consents?.map(consent=>consent.action_key)))
      throw new AppError('Review the current action operator setup before reusing this account.', 'APP_REVIEW_REQUIRED', 409,
        {reason:'runtime_action_review_mismatch',phase:'before_dispatch'});
    await this.ports.assertNoActiveEffects(source, authority);
    const now = this.clock(), reviewExpiry = Math.min(now + 300_000, authority.expires_at, appConsentDeadline(target.consent_expires_at, target.consent_lifetime));
    const record = AppConnectionSessionRecordSchema.parse({ session_id: input.request_id, revision: 0, scope: target,
      profile: authority.profile, state: 'starting', callback_state_hash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      callback_consumed: false, callback_expires_at: new Date(reviewExpiry).toISOString(), runtime_session_ref: null,
      account: null, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
      ...(authority.action_consents!==undefined?{action_consents:authority.action_consents}:authority.action_consent ? { action_consent: authority.action_consent } : {}),
      reattachment: { schema_version: 'deft.app_connection_reattachment.v1',
        source: { session_id: source.session_id, session_revision: source.revision, scope: old,
          runtime_session_ref: source.runtime_session_ref, account_ref: source.account.account_ref },
        transport_digest: await this.ports.transportDigest(source), review_expires_at: new Date(reviewExpiry).toISOString(), review: null, receipt: null } });
    if (await this.ports.transportDigest(record) !== record.reattachment!.transport_digest) throw denied();
    if (!await this.ports.store.create(record)) throw conflict();
    return this.invoke(caller, record, 'prepare');
  }
  /** Explicit owner closure reserves an absent request before any provider I/O.
   * Existing records in every state are retained and must use normal status. */
  private closedReviewView(record:AppConnectionSessionRecord){
    return {schema_version:'deft.app_connection_unstarted_review_closed.v1' as const,session_id:record.session_id,scope:record.scope,state:'not_started' as const,provider_dispatched:false as const};
  }
  async closeUnstartedReview(caller: ExperienceCaller, raw: unknown) {
    const input=AppConnectionReattachReviewRequestSchema.omit({source_session_id:true}).parse(raw);
    if(!this.ports.store.createUnstartedReviewClosure||!this.ports.store.readUnstartedReviewClosure)throw conflict();
    const existing=await this.ports.store.read({org_id:caller.org_id,owner_user_id:caller.user_id,session_id:input.request_id});
    if(existing){const closed=AppConnectionSessionRecordSchema.parse(existing);if(closed.scope.installation_id!==input.installation_id||closed.scope.target_key!==input.target_key||!await this.ports.store.readUnstartedReviewClosure(locator(closed)))throw conflict();
      await this.authority(caller,this.nomination(closed),'reattach_status',closed);return this.closedReviewView(closed);}
    const authority=await this.authority(caller,input,'reattach_review');
    const now=new Date(this.clock()).toISOString();
    const record=AppConnectionSessionRecordSchema.parse({session_id:input.request_id,revision:1,scope:authority.scope,profile:authority.profile,
      state:'not_connected',callback_state_hash:createHash('sha256').update(randomBytes(32)).digest('hex'),callback_consumed:false,
      callback_expires_at:now,runtime_session_ref:null,account:null,created_at:now,updated_at:now,
      ...(authority.action_consents!==undefined?{action_consents:authority.action_consents}:authority.action_consent?{action_consent:authority.action_consent}:{})});
    if(!await this.ports.store.createUnstartedReviewClosure(record)){
      const winner=await this.read(caller,input.request_id);if(!await this.ports.store.readUnstartedReviewClosure(locator(winner))||!isDeepStrictEqual(winner.scope,authority.scope))throw conflict();
      await this.authority(caller,this.nomination(winner),'reattach_status',winner);return this.closedReviewView(winner);
    }
    return this.closedReviewView(record);
  }
  async activate(caller: ExperienceCaller, raw: unknown) {
    const input = AppConnectionReattachActivateRequestSchema.parse(raw), record = await this.read(caller, input.session_id);
    if (!record.reattachment?.review || record.state !== 'reattach_reviewed'
      || record.reattachment.review.digest !== input.review_digest || Date.parse(record.reattachment.review_expires_at) <= this.clock()) throw conflict();
    await this.authority(caller, this.nomination(record), 'reattach_activate', record);
    return this.invoke(caller, await this.write(record, { state: 'reattaching', callback_consumed: true }), 'activate');
  }
  async status(caller: ExperienceCaller, raw: unknown) {
    const input = AppConnectionReattachStatusRequestSchema.parse(raw), record = await this.read(caller, input.session_id);
    if(await this.ports.store.readUnstartedReviewClosure?.(locator(record))){await this.authority(caller,this.nomination(record),'reattach_status',record);return this.closedReviewView(record);}
    if (!record.reattachment) throw conflict();
    await this.authority(caller, this.nomination(record), 'reattach_status', record);
    if (record.state === 'connected' || record.state === 'not_connected') return this.view(record);
    if (!['starting', 'reattach_reviewed', 'reattaching', 'reattach_checking', 'indeterminate'].includes(record.state)) throw conflict();
    return this.invoke(caller, await this.write(record, { state: 'reattach_checking' }), 'status');
  }
}
