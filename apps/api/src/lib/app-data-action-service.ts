import {retainPreparedRecordActionReceipt} from './app-prepared-record-action-receipt.js';
import {AppFutureRecordActionControls} from './app-future-record-action-controls.js';
import {AppFutureExecutionWindowSchema} from '@deft/app-kit';
import {captureFutureRecordActionReview} from './app-future-record-action-review.js';
import {admitFutureRecordAction} from './app-future-record-action-service.js';
import type {ReviewedFutureRecordActionTicket} from './app-future-record-action-review.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { appRuntimeBindings, appVersions } from '@deft/db/schema';
import { AppDataService } from './app-data-service.js';
import { appDataDenied, type CurrentAppDataAuthority } from './app-data-authority.js';
import { AppExperienceHumanActionService, type HumanActionAuthorityPort } from './app-experience-human-action-service.js';
import { HumanActionConfirmSchema, humanActionDigest, openHumanActionTicket } from './app-experience-human-action-contract.js';
import { verifiedExperienceBundle } from './app-experience-service.js';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import {verifiedPreparedRecordAction} from './app-data-prepared-effect.js';

const id = z.string().uuid(), key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const RecordActionPrepareSchema = z.strictObject({ connection_session_id: id, store_key: key,
  record_id: id, expected_revision: z.number().int().min(1).max(2147483646),
  content_digest: digest, idempotency_key: id,execution_window:AppFutureExecutionWindowSchema.optional() });
const recordFields = ['record_action_version', 'record_store_key', 'connection_session_id',
  'connection_revision', 'data_consent_id', 'data_consent_digest', 'prepared_digest'] as const;

/** Full preview stays in the trusted host UI. Only sealed references and
 * digests enter the existing reviewed App Run, never an independent effect. */
export class AppDataActionService {
  constructor(protected readonly data: AppDataService, protected readonly human: AppExperienceHumanActionService,
    protected readonly authority: HumanActionAuthorityPort, protected readonly keys: AppRunKeyProvider) {}

  protected async assertTarget(sessionId: string, target: string, action: string, current: CurrentAppDataAuthority, signal?: AbortSignal, prepared?:unknown) {
    const caller = this.data.caller;
    await this.authority.withHumanAction(caller, sessionId, action, async (tx, authority, final) => {
      const session = authority.session;
      if (session.app_installation_id !== current.scope.installation_id || session.app_version_id !== current.scope.app_version_id
        || session.grant_snapshot_id !== current.scope.grant_snapshot_id || session.resource_target_key !== target
        || current.scope.target_key !== target || current.scope.owner_user_id !== caller.user_id) throw appDataDenied();
      const [binding] = await tx.select().from(appRuntimeBindings).where(and(eq(appRuntimeBindings.org_id, caller.org_id),
        eq(appRuntimeBindings.id, authority.runtime_binding_id))).limit(1).for('share');
      if (!binding || binding.owner_resource_binding_id !== current.scope.resource_binding_id
        || binding.action_key !== action || binding.reviewed_by_user_id !== caller.user_id) throw appDataDenied();
      if(prepared)verifiedPreparedRecordAction(prepared,authority.runtime_binding_id,current.store);
      const [version] = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, caller.org_id),
        eq(appVersions.id, session.app_version_id))).limit(1);
      if (!version || !session.experience_key) throw appDataDenied();
      const { bundle } = await verifiedExperienceBundle(version, session.experience_key);
      if (bundle.schema_version!=='deft.experience_bundle.v3'&&bundle.schema_version!=='deft.experience_bundle.v4' || !bundle.record_store_keys?.includes(current.store.key)) throw appDataDenied();
      await final(tx);
    }, signal);
  }

  async prepare(sessionId: string, target: string, action: string, raw: unknown, signal?: AbortSignal) {
    const request = RecordActionPrepareSchema.parse(raw);
    const before = await this.data.current(request.connection_session_id, request.store_key);
    await this.assertTarget(sessionId, target, action, before, signal);
    signal?.throwIfAborted();
    const { prepared: rawPrepared, authority } = await this.data.prepare(request.connection_session_id, {
      store_key: request.store_key, record_id: request.record_id, expected_revision: request.expected_revision,
      expected_content_digest: request.content_digest, action_key: action,...(request.execution_window?{execution_window:request.execution_window}:{}) });
    const prepared = verifiedPreparedRecordAction(rawPrepared,undefined,authority.store);
    if(Boolean(prepared.future_release)!==Boolean(request.execution_window))throw appDataDenied();
    if (prepared.record_content_digest!==undefined&&prepared.record_content_digest!==request.content_digest)throw appDataDenied();
    if (!authority.consent || prepared.action_key !== action || prepared.record_id !== request.record_id
      || prepared.revision !== request.expected_revision || recordFields.some(field => Object.hasOwn(prepared.input, field))) throw appDataDenied();
    await this.assertTarget(sessionId, target, action, authority, signal,prepared);
    const input = { ...prepared.input, record_action_version: prepared.schema_version, record_store_key: request.store_key,
      connection_session_id: authority.connection.session_id, connection_revision: authority.connection.session_revision,
      data_consent_id: authority.consent.consent_id, data_consent_digest: authority.consent.consent_digest,
      prepared_digest: prepared.snapshot_digest };
    let future:ReviewedFutureRecordActionTicket|undefined;
    if(prepared.future_release)future=await this.authority.withHumanAction(this.data.caller,sessionId,action,async(tx,human,final)=>{
      const captured=await captureFutureRecordActionReview(tx,authority,prepared,request.idempotency_key,human.session.id,human.authorization_identity);await final(tx);return captured;
    },signal);
    const ticket=future?await this.human.prepareReviewedFutureRecord(this.data.caller,sessionId,action,{input,idempotency_key:request.idempotency_key},future,signal)
      :await this.human.prepareReviewedRecord(this.data.caller,sessionId,action,{input,idempotency_key:request.idempotency_key},signal);
    const expires_at = new Date(Math.min(Date.parse(ticket.expires_at), Date.parse(prepared.expires_at), authority.expires_at)).toISOString();
    if (Date.parse(expires_at) <= Date.now()) throw appDataDenied();
    return { schema_version: 'deft.app_record_action_review.v1' as const, prepared, input,
      ticket: ticket.ticket, input_digest: ticket.input_digest, expires_at };
  }

  futureStatus(sessionId:string,target:string,raw:unknown){return new AppFutureRecordActionControls(this.data).read(sessionId,target,raw);}
  futureReconcile(sessionId:string,target:string,request:string,phase:'commit'|'restore',signal?:AbortSignal){return new AppFutureRecordActionControls(this.data).local(sessionId,target,request,phase,signal);}
  futureCancel(sessionId:string,target:string,raw:unknown,signal?:AbortSignal){return new AppFutureRecordActionControls(this.data).cancel(sessionId,target,raw,signal);}

  async confirm(sessionId: string, target: string, raw: unknown, signal?: AbortSignal) {
    const request = HumanActionConfirmSchema.parse(raw), ticket = openHumanActionTicket(this.keys, request.ticket);
    const caller = this.data.caller;
    if (ticket.org_id !== caller.org_id || ticket.user_id !== caller.user_id || ticket.sid !== caller.sid
      || ticket.session_id !== sessionId || ticket.input_digest !== request.expected_input_digest
      || ticket.input_digest !== humanActionDigest(ticket.input) || Date.parse(ticket.expires_at) <= Date.now()) throw appDataDenied();
    const input = ticket.input;
    if (input.record_action_version !== 'deft.app_prepared_record_action.v1') throw appDataDenied();
    const connection = id.parse(input.connection_session_id), store = key.parse(input.record_store_key);
    const { prepared: rawPrepared, authority } = await this.data.readPrepared(connection, { store_key: store,
      snapshot_id: id.parse(input.snapshot_id), snapshot_digest: digest.parse(input.prepared_digest) });
    const prepared = verifiedPreparedRecordAction(rawPrepared,undefined,authority.store);
    if (prepared.action_key !== ticket.action_key || prepared.snapshot_digest !== input.prepared_digest
      || authority.connection.session_revision !== input.connection_revision
      || authority.consent?.consent_id !== input.data_consent_id || authority.consent?.consent_digest !== input.data_consent_digest
      || Object.keys(prepared.input).some(field => input[field] !== prepared.input[field])
      || Object.keys(input).some(field => !recordFields.includes(field as typeof recordFields[number]) && !Object.hasOwn(prepared.input, field))) throw appDataDenied();
    await this.assertTarget(sessionId, target, ticket.action_key, authority, signal,prepared);
    signal?.throwIfAborted();
    if(prepared.future_release){
      if(!ticket.future_record_action||ticket.future_record_action.prepared_digest!==prepared.snapshot_digest)throw appDataDenied();
      const confirmed=await this.human.confirmReviewedFutureRecord(caller,sessionId,request,async(tx,run,future)=>{
        await admitFutureRecordAction(tx,caller,run,future,prepared,input,new Date());
        await retainPreparedRecordActionReceipt(tx,caller,run.id,authority,prepared);
      },signal);
      const future_release=await new AppFutureRecordActionControls(this.data).local(sessionId,target,ticket.future_record_action.release_id,'commit',signal);
      return {...confirmed,future_release};
    }
    if(ticket.future_record_action)throw appDataDenied();
    return this.human.confirmPreparedRecordAction(caller,sessionId,request,(tx,run)=>retainPreparedRecordActionReceipt(tx,caller,run.id,authority,prepared),signal);
  }
}
