import {assertCapturedAppIntegrationPreparedProvenance,type AppIntegrationPreparedProvenance} from './app-integration-prepared-provenance.js';
import {guardOriginalPrepared,linkOriginalPrepared} from './app-integration-tool-prepared.js';
import {assertFutureRecordActionPurposeDeadline} from './app-future-record-action-review.js';
import type {ReviewedFutureRecordActionTicket} from './app-future-record-action-review.js';
import { z } from 'zod';
import {appConnectionUpgradeSourceIsAvailable} from './app-connection-upgrade-fence.js';
import { experienceRunState } from './app-experience-run-presentation.js';
import { experienceAgentPolicy } from './app-experience-human-action-agent-policy.js';
import { and, eq, or, isNull, sql } from 'drizzle-orm';
import { agentActions, appRuns, appRunHumanAuthorizations, appPrivateStateRecords } from '@deft/db/schema';
import { RuntimeObjectSchema, parseRuntimeObjectInput, type PrivateStateDeclaration, type RuntimeObjectContract } from '@deft/app-kit';
import { AppRunError } from './app-run-errors.js';
import type { AppRunRuntime } from './app-run-runtime.js';
import type { AppRunSafeView, AppRunTransaction } from './app-run-repository.js';
import type { ExperienceCaller } from './app-experience-service.js';
import { HumanActionPrepareSchema, HumanActionConfirmSchema, humanActionDigest, type HumanActionDraftReference,
  sealHumanActionTicket, openHumanActionTicket, assertHumanActionTicketDeadline } from './app-experience-human-action-contract.js';
import { AppPrivateStateSecrets, type StoredPrivateSource } from './app-private-state-secrets.js';
import { privateStateValue } from './app-private-state-contract.js';
import { exposureDigest } from './app-experience-exposure-contract.js';
import { samplePrivateAccessClock } from './app-private-access-clock.js';
import { AppPrivateFileCustody, type ActionPayloadBinding, type ActionPayloadReference, type CustodyGuards,
  type PrivateFilePolicy } from './app-private-file-custody.js';
import type { AppConnectionProjection } from './app-connection-contract.js';
import { HumanActionSnapshotRequestSchema, HumanActionSnapshotPreviewSchema } from './app-experience-human-action-contract.js';
import {AppRuntimeActionResourceSnapshotSchema,type AppRuntimeActionResourceSnapshot} from './app-runtime-action-resource-snapshot.js';

export type HumanActionAuthority = Readonly<{
  session: Readonly<{ id: string; app_installation_id: string; app_version_id: string;
    grant_snapshot_id: string; artifact_digest: string; expires_at: Date; resource_target_key?: string; experience_key?: string }>;
  resolveActionResources?: (schema: RuntimeObjectContract, input: Record<string, string | number | boolean>, savedSources?: readonly StoredPrivateSource[]) => Promise<Record<string, readonly HumanActionSourceRecord[]>>;
  draft_declaration?: PrivateStateDeclaration;
  action_payload_declaration?: Readonly<{ state_key: string; max_payload_bytes: number }>;
  draft_policy?: Readonly<{ draft_state_key: string; files?: PrivateFilePolicy; max_payload_bytes?: number }>;
  action_payload_sources?: readonly AppConnectionProjection[];
  runtime_binding_id: string; action_label: string; current_authority_expires_at: Date;
  authorization_identity: Readonly<{ consent_grant_id: string | null; consent_epoch: number | null; exposure_id: string; exposure_epoch: number }>;
}>;
export type HumanActionSourceRecord = Readonly<{ record_id: string; resource_key: string; resource_binding_id: string;
  revision: string; label: string; data: Readonly<Record<string, string | number | boolean>>;
  provider_source?: Readonly<Record<string, unknown>> }>;
export interface HumanActionAuthorityPort {
  withHumanAction<T>(caller: ExperienceCaller, sessionId: string, actionKey: string,
    use: (tx: AppRunTransaction, authority: HumanActionAuthority,
      finalGuard: (tx: AppRunTransaction, additionalFinalCheck?: () => void) => Promise<void>) => Promise<T>, signal?: AbortSignal, draftStateKey?: string, suppliedTransaction?: AppRunTransaction, transactionPurpose?: 'human_action_preparation' | 'human_action_confirmation'): Promise<T>;
}

/** This service is reachable only from authenticated host HTTP, never a Worker operation. */
export interface HumanActionPayloadCapturePort {
  capture(tx: AppRunTransaction, context: Readonly<{ caller: ExperienceCaller; authority: HumanActionAuthority;
    sources?: readonly AppConnectionProjection[]; resolved_resources?: Record<string, readonly HumanActionSourceRecord[]>; binding: ActionPayloadBinding; input: Record<string, string | number | boolean>;
    draft_ref: HumanActionDraftReference; draft_value: Record<string, string | number | boolean>; draft_updated_at: Date; files_policy?: PrivateFilePolicy;
    max_payload_bytes: number; expires_at: Date; bindDeadline: (expiresAt: Date) => void; guards: CustodyGuards }>): Promise<ActionPayloadReference>;
}
type PreparedBatchApprovalCheck=(tx:AppRunTransaction,run:AppRunSafeView,authority:HumanActionAuthority)=>Promise<void>;
type PreparedBatchApprovalView={run:Omit<AppRunSafeView,'state'> & {state:ReturnType<typeof experienceRunState>}};
export class AppExperienceHumanActionService {
  private readonly preparedBatchAuthority=new WeakMap<AppRunTransaction,{identity:string;action_key:string;authority:HumanActionAuthority;final:(tx:AppRunTransaction,check?:()=>void)=>Promise<void>}>();
  async withPreparedResourceBatchAuthority<T>(tx:AppRunTransaction,caller:ExperienceCaller,sessionId:string,actionKey:string,authority:HumanActionAuthority,final:(tx:AppRunTransaction,check?:()=>void)=>Promise<void>,run:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
    if(this.preparedBatchAuthority.has(tx)||authority.session.id!==sessionId||authority.current_authority_expires_at.getTime()<=Date.now())throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    signal?.throwIfAborted();this.preparedBatchAuthority.set(tx,{identity:humanActionDigest({caller,sessionId}),action_key:actionKey,authority,final});
    try{return await run();}finally{this.preparedBatchAuthority.delete(tx);this.preparedBatchApprovals.delete(tx);}
  }

  private readonly preparedBatchApprovals=new WeakMap<AppRunTransaction,Map<string,{identity:string;approve:(check:PreparedBatchApprovalCheck)=>Promise<PreparedBatchApprovalView>}>>();
  constructor(private readonly authority: HumanActionAuthorityPort,
    private readonly runtime: AppRunRuntime, private readonly now = () => new Date(),
    private readonly payloadCapture?: HumanActionPayloadCapturePort,
    private readonly payloadCustody?: Pick<AppPrivateFileCustody, 'loadPayload' | 'resolveDraftFiles'>) {}

  private custody() { return this.payloadCustody ?? new AppPrivateFileCustody(this.runtime.keys); }
  private requirePayload(authority: HumanActionAuthority, draft?: HumanActionDraftReference, ref?: ActionPayloadReference) {
    const policy = authority.action_payload_declaration;
    if (policy ? !draft || draft.draft_state_key !== policy.state_key || !ref : Boolean(ref)) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
  }
  private payloadBinding(caller: ExperienceCaller, authority: HumanActionAuthority, actionKey: string,
    contractDigest: string, draft: HumanActionDraftReference, inputDigest: string): ActionPayloadBinding {
    if (!authority.draft_declaration || authority.draft_declaration.key !== draft.draft_state_key) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    return { org_id: caller.org_id, owner_user_id: caller.user_id, installation_id: authority.session.app_installation_id,
      app_version_id: authority.session.app_version_id, grant_snapshot_id: authority.session.grant_snapshot_id,
      resource_target_key: authority.session.resource_target_key ?? 'primary', state_key: draft.draft_state_key,
      draft_id: draft.draft_id, draft_revision: draft.expected_revision, artifact_digest: authority.session.artifact_digest,
      declaration_digest: exposureDigest(authority.draft_declaration), runtime_binding_id: authority.runtime_binding_id,
      action_key: actionKey, action_contract_digest: contractDigest, input_digest: inputDigest };
  }
  private async payload(tx: AppRunTransaction, binding: ActionPayloadBinding, ref: ActionPayloadReference, authority: HumanActionAuthority) {
    const retained = await this.custody().loadPayload(tx, binding, ref, new Date(await this.currentTime(tx)));
    if (!authority.action_payload_declaration || retained.byte_count > authority.action_payload_declaration.max_payload_bytes) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    const preview = HumanActionSnapshotPreviewSchema.parse(retained.metadata.preview);
    if (humanActionDigest(preview.files) !== humanActionDigest(retained.file_refs)) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    return { retained, preview };
  }
  private async requireNoDroppedFiles(tx: AppRunTransaction, caller: ExperienceCaller, authority: HumanActionAuthority,
    ref: HumanActionDraftReference, draftExpiry: number, signal?: AbortSignal) {
    const declaration = authority.draft_declaration;
    if (authority.action_payload_declaration || !declaration?.files) return;
    const clock = await samplePrivateAccessClock(tx, this.now);
    const expiry = new Date(Math.min(draftExpiry, authority.current_authority_expires_at.getTime(), authority.session.expires_at.getTime()));
    const guard = async () => { signal?.throwIfAborted(); assertHumanActionTicketDeadline(expiry.toISOString(), this.now().getTime(), clock.current().getTime(), 0); };
    const files = await this.custody().resolveDraftFiles(tx, { org_id: caller.org_id, owner_user_id: caller.user_id,
      installation_id: authority.session.app_installation_id, resource_target_key: authority.session.resource_target_key ?? 'primary',
      state_key: ref.draft_state_key, record_id: ref.draft_id, artifact_digest: authority.session.artifact_digest,
      declaration_digest: exposureDigest(declaration) }, declaration, ref.expected_revision,
      { now: clock.current, guard, ...(signal ? { signal } : {}) });
    await guard(); if (files.length) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
  }

  private async draftSnapshot(tx: AppRunTransaction, caller: ExperienceCaller, authority: HumanActionAuthority,
    reference: HumanActionDraftReference, input: Record<string, string | number | boolean>) {
    const declaration = authority.draft_declaration;
    if (!declaration || declaration.key !== reference.draft_state_key) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    const [row] = await tx.select().from(appPrivateStateRecords).where(and(
      eq(appPrivateStateRecords.org_id, caller.org_id), eq(appPrivateStateRecords.owner_user_id, caller.user_id),
      eq(appPrivateStateRecords.installation_id, authority.session.app_installation_id),
      eq(appPrivateStateRecords.state_key, reference.draft_state_key), eq(appPrivateStateRecords.record_id, reference.draft_id),
      eq(appPrivateStateRecords.resource_target_key, authority.session.resource_target_key ?? 'primary'))).limit(1).for('share');
    const declarationDigest = exposureDigest(declaration);
    if (!row || row.deleted_at || row.revision !== reference.expected_revision
      || row.artifact_digest !== authority.session.artifact_digest || row.declaration_digest !== declarationDigest
      || row.expires_at.getTime() <= await this.currentTime(tx)) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    let value: Record<string, string | number | boolean>; let sources: StoredPrivateSource[];
    try {
      const opened = new AppPrivateStateSecrets(this.runtime.keys).openState({
        org_id: caller.org_id, owner_user_id: caller.user_id, installation_id: authority.session.app_installation_id,
        state_key: reference.draft_state_key, record_id: reference.draft_id, revision: row.revision,
        artifact_digest: row.artifact_digest, declaration_digest: declarationDigest,
        ...(row.resource_target_key === 'primary' ? {} : { resource_target_key: row.resource_target_key }),
      }, row.body); value = privateStateValue(declaration,opened.value).value; sources = opened.sources;
    } catch { throw new AppRunError('APP_RUN_AUTHORIZATION_STALE'); }
    // Extra action fields remain governed by the existing exact human contract.
    // A saved field cannot be substituted with another client-proposed value.
    for (const [key, item] of Object.entries(input)) if (Object.hasOwn(value, key) && value[key] !== item) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    return { value, sources, digest: humanActionDigest(value), expires_at: row.expires_at.getTime(), updated_at: row.updated_at };
  }

  /** Read-only recovery of one exact host submission, never an authorization or resend. */
  lookup(caller: ExperienceCaller, sessionId: string, actionKey: string, rawKey: unknown, signal?: AbortSignal) {
    const key = z.string().uuid().parse(rawKey);
    return this.authority.withHumanAction(caller, sessionId, actionKey, async (tx, authority, final) => {
      const capture = await this.capture(tx, caller, authority), binding = capture.binding;
      const candidates = this.runtime.service.retainedIdempotencyCandidates(
        `human:${authority.session.app_installation_id}:${key}`);
      if (candidates.length === 0) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const [found] = await tx.select({ id: appRuns.id, state: appRuns.state,
        release: appRuns.execution_release_kind }).from(appRuns).innerJoin(appRunHumanAuthorizations, and(
          eq(appRunHumanAuthorizations.org_id, appRuns.org_id), eq(appRunHumanAuthorizations.run_id, appRuns.id),
          eq(appRunHumanAuthorizations.owner_user_id, caller.user_id))).where(and(
        eq(appRuns.org_id, caller.org_id), eq(appRuns.initiating_actor_type, 'human'), eq(appRuns.initiating_actor_id, caller.user_id),
        eq(appRuns.execution_actor_type, 'human'), eq(appRuns.execution_actor_id, caller.user_id),
        eq(appRuns.origin_kind, 'app'), eq(appRuns.provider_kind, 'app_runtime'), eq(appRuns.execution_release_kind, 'approved'),
        eq(appRuns.origin_app_installation_id, authority.session.app_installation_id),
        eq(appRuns.origin_app_version_id, authority.session.app_version_id), eq(appRuns.origin_app_grant_snapshot_id, authority.session.grant_snapshot_id),
        eq(appRuns.origin_runtime_binding_id, binding.id), eq(appRuns.provider_instance_id, binding.provider_instance_id),
        eq(appRuns.provider_snapshot_id, binding.provider_snapshot_id), eq(appRuns.operation_name, binding.operation_name),
        isNull(appRuns.parent_run_id),
        or(...candidates.map(candidate => and(eq(appRuns.idempotency_key_version, candidate.key_version),
          eq(appRuns.idempotency_fingerprint, candidate.fingerprint)))))).limit(1);
      await final(tx);
      return { run: found ? { id: found.id, state: experienceRunState(found.state, found.release) } : null };
    }, signal);
  }

  agentPolicy(caller: ExperienceCaller, sessionId: string, actionKey: string, raw?: unknown, signal?: AbortSignal) {
    return experienceAgentPolicy(this.authority, caller, sessionId, actionKey, raw, signal);
  }

  private async currentTime(tx: AppRunTransaction) {
    return (await samplePrivateAccessClock(tx, this.now)).current().getTime();
  }
  private async actionSources(caller:ExperienceCaller,authority:HumanActionAuthority,schema:RuntimeObjectContract,input:Record<string,string|number|boolean>):Promise<AppRuntimeActionResourceSnapshot|null>{
    if(!Object.values(schema.properties).some(field=>field.type==='string'&&field.format==='resource_record_list'))return null;
    if(!authority.resolveActionResources)throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    return AppRuntimeActionResourceSnapshotSchema.parse({schema_version:'deft.app_action_resource_snapshot.v1',org_id:caller.org_id,owner_id:caller.user_id,installation_id:authority.session.app_installation_id,app_version_id:authority.session.app_version_id,grant_snapshot_id:authority.session.grant_snapshot_id,runtime_binding_id:authority.runtime_binding_id,input_digest:humanActionDigest(input),resources:await authority.resolveActionResources(schema,input)});
  }

  private async capture(tx: AppRunTransaction, caller: ExperienceCaller, authority: HumanActionAuthority) {
    const capture = await this.runtime.liveAuthorization.captureReviewedRuntimeInTransaction(tx, {
      org_id: caller.org_id, user_id: caller.user_id, runtime_binding_id: authority.runtime_binding_id,
    });
    if (capture.protocol_version !== '7' || capture.binding.app_installation_id !== authority.session.app_installation_id
      || capture.binding.app_version_id !== authority.session.app_version_id
      || capture.binding.grant_snapshot_id !== authority.session.grant_snapshot_id) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    return capture;
  }

  private authorityDigest(authority: HumanActionAuthority, capture: Awaited<ReturnType<AppExperienceHumanActionService['capture']>>) {
    return humanActionDigest({ session_id: authority.session.id, installation_id: authority.session.app_installation_id,
      app_version_id: authority.session.app_version_id, grant_snapshot_id: authority.session.grant_snapshot_id,
      artifact_digest: authority.session.artifact_digest, binding_id: authority.runtime_binding_id,
      authorization_identity: authority.authorization_identity,
      authorization: capture.authorization_snapshot, contract_digest: capture.action.contract_digest,
      ...(authority.action_payload_declaration ? { action_payload_declaration: authority.action_payload_declaration } : {}),
      provider_snapshot_digest: capture.provider_snapshot_digest, lifecycle_epoch: capture.installation_lifecycle_epoch,
      grant_epoch: capture.installation_grant_epoch });
  }

  context(caller: ExperienceCaller, sessionId: string, actionKey: string, signal?: AbortSignal) {
    return this.authority.withHumanAction(caller, sessionId, actionKey, async (tx, authority, final) => {
      const capture = await this.capture(tx, caller, authority);
      const input_schema = RuntimeObjectSchema.parse(capture.action.input_schema);
      await final(tx);
      return { schema_version: 'deft.experience_human_action_context.v1' as const,
        action_key: actionKey, label: authority.action_label, input_schema,
        ...(authority.draft_policy ? { draft_policy: authority.draft_policy } : {}),
        contract_digest: capture.action.contract_digest, runtime_binding_id: authority.runtime_binding_id,
        app_version_id: authority.session.app_version_id, grant_snapshot_id: authority.session.grant_snapshot_id,
        expires_at: authority.current_authority_expires_at.toISOString() };
    }, signal, undefined, undefined, 'human_action_preparation');
  }

  async snapshot(caller: ExperienceCaller, sessionId: string, actionKey: string, raw: unknown, signal?: AbortSignal) {
    const request = HumanActionSnapshotRequestSchema.parse(raw);
    let afterCommit = () => {};
    const result = await this.authority.withHumanAction(caller, sessionId, actionKey, async (tx, authority, final) => {
      const policy = authority.action_payload_declaration;
      if (!this.payloadCapture || !policy || policy.state_key !== request.draft_ref.draft_state_key) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const capture = await this.capture(tx, caller, authority);
      const input = parseRuntimeObjectInput(RuntimeObjectSchema.parse(capture.action.input_schema), request.input);
      const resourceFields = Object.values(RuntimeObjectSchema.parse(capture.action.input_schema).properties).some(field => field.type === 'string' && field.format === 'resource_record_list');
      if (resourceFields && !authority.resolveActionResources) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const draft = await this.draftSnapshot(tx, caller, authority, request.draft_ref, input), input_digest = humanActionDigest(input);
      const resolved_resources = resourceFields ? await authority.resolveActionResources!(RuntimeObjectSchema.parse(capture.action.input_schema), input, draft.sources) : undefined;
      const clock = await samplePrivateAccessClock(tx, this.now);
      const expires_at = new Date(Math.min(authority.current_authority_expires_at.getTime(), authority.session.expires_at.getTime(), draft.expires_at));
      let boundDeadline = expires_at.getTime();
      const bindDeadline = (deadline: Date) => { if (!Number.isFinite(deadline.getTime())) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE'); boundDeadline = Math.min(boundDeadline, deadline.getTime()); };
      const check = () => { signal?.throwIfAborted(); assertHumanActionTicketDeadline(new Date(boundDeadline).toISOString(), this.now().getTime(), clock.current().getTime(), 0); };
      afterCommit = check;
      await final(tx, check);
      const guards: CustodyGuards = { now: clock.current, guard: async () => { check(); }, ...(signal ? { signal } : {}) };
      const binding = this.payloadBinding(caller, authority, actionKey, capture.action.contract_digest, request.draft_ref, input_digest);
      const snapshot_ref = await this.payloadCapture.capture(tx, { caller, authority, binding, input, ...(resolved_resources ? { resolved_resources } : {}), draft_ref: request.draft_ref,
        draft_value: draft.value, draft_updated_at: draft.updated_at,
        ...(authority.action_payload_sources ? { sources: authority.action_payload_sources } : {}),
        ...(authority.draft_declaration?.files ? { files_policy: authority.draft_declaration.files } : {}),
        max_payload_bytes: policy.max_payload_bytes, expires_at, bindDeadline, guards });
      const { retained, preview } = await this.payload(tx, binding, snapshot_ref, authority);
      const snapshotExpiry = new Date(Math.min(expires_at.getTime(), retained.expires_at.getTime(), ...retained.file_refs.map(file => Date.parse(file.expires_at))));
      bindDeadline(snapshotExpiry); await final(tx, check); check();
      return { schema_version: 'deft.experience_human_action_snapshot.v1' as const, snapshot_ref, draft_ref: request.draft_ref,
        input_digest, expires_at: snapshotExpiry.toISOString(), preview };
    }, signal, request.draft_ref.draft_state_key, undefined, 'human_action_preparation');
    afterCommit(); return result;
  }

  async prepare(caller: ExperienceCaller, sessionId: string, actionKey: string, raw: unknown, signal?: AbortSignal) {
    return this.prepareValue(caller, sessionId, actionKey, raw, signal, null);
  }

  /** Host-only bridge entry after loading the immutable app-owned preview.
   * This argument is never supplied by the HTTP/Worker action endpoints. */
  async prepareReviewedRecord(caller: ExperienceCaller, sessionId: string, actionKey: string, raw: unknown, signal?: AbortSignal) {
    return this.prepareValue(caller, sessionId, actionKey, raw, signal, 'record');
  }

  async prepareReviewedFutureRecord(caller:ExperienceCaller,sessionId:string,actionKey:string,raw:unknown,future:ReviewedFutureRecordActionTicket,signal?:AbortSignal){
    return this.prepareValue(caller,sessionId,actionKey,raw,signal,'record',future);
  }

  async prepareReviewedResource(caller:ExperienceCaller,sessionId:string,actionKey:string,raw:unknown,signal?:AbortSignal){
    return this.prepareValue(caller,sessionId,actionKey,raw,signal,'resource');
  }

  /** Server-only constructor after an exact original delegated preparation read. */
  prepareReviewedIntegration(caller:ExperienceCaller,sessionId:string,actionKey:string,raw:unknown,provenance:AppIntegrationPreparedProvenance,signal?:AbortSignal){
    return this.prepareValue(caller,sessionId,actionKey,raw,signal,provenance.prepared_kind,undefined,provenance);
  }
  private async prepareValue(caller: ExperienceCaller, sessionId: string, actionKey: string, raw: unknown, signal: AbortSignal | undefined, reviewed: 'record'|'resource'|null, future?:ReviewedFutureRecordActionTicket,integration?:AppIntegrationPreparedProvenance) {
    const request = HumanActionPrepareSchema.parse(raw);
    if (request.draft_ref && request.idempotency_key !== request.draft_ref.draft_id) throw new AppRunError('APP_RUN_INPUT_INVALID');
    let afterCommit = () => {};
    const result = await this.authority.withHumanAction(caller, sessionId, actionKey, async (tx, authority, final) => {
      this.requirePayload(authority, request.draft_ref, request.snapshot_ref);
      const capture = await this.capture(tx, caller, authority);
      if(future)await assertFutureRecordActionPurposeDeadline(tx,caller.org_id,caller.user_id,authority.authorization_identity,future.authority.authority_expires_at);

      if(capture.binding.owner_resource_binding_id&&!await appConnectionUpgradeSourceIsAvailable(tx,{org_id:caller.org_id,owner_user_id:caller.user_id,resource_binding_id:capture.binding.owner_resource_binding_id}))throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const input = parseRuntimeObjectInput(RuntimeObjectSchema.parse(capture.action.input_schema), request.input);
      if(integration){
        if(future||request.draft_ref||request.snapshot_ref||reviewed===null||request.idempotency_key!==integration.invocation_id)throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
        assertCapturedAppIntegrationPreparedProvenance(integration,reviewed,actionKey,authority.session.app_installation_id,String(input.account_ref),String(capture.binding.owner_resource_binding_id),this.now().getTime());
        const original=await guardOriginalPrepared(tx,caller,integration,input);
        if(original.action?.action_binding_id!==authority.runtime_binding_id)throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      }
      const recordMarker=Object.hasOwn(capture.action.input_schema.properties,'record_action_version');
      const resourceMarker=Object.hasOwn(capture.action.input_schema.properties,'resource_action_version');
      if(recordMarker&&resourceMarker||(recordMarker?(reviewed!=='record'||input.record_action_version!=='deft.app_prepared_record_action.v1')
        :resourceMarker?(reviewed!=='resource'||input.resource_action_version!=='deft.app_prepared_resource_action.v1'):reviewed!==null))
        throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const draft = request.draft_ref ? await this.draftSnapshot(tx, caller, authority, request.draft_ref, input) : null;
      const actionSources=request.draft_ref?null:await this.actionSources(caller,authority,RuntimeObjectSchema.parse(capture.action.input_schema),input);
      if (request.draft_ref && draft) await this.requireNoDroppedFiles(tx, caller, authority, request.draft_ref, draft.expires_at, signal);
      const input_digest = humanActionDigest(input);
      const payload = request.snapshot_ref && request.draft_ref ? await this.payload(tx,
        this.payloadBinding(caller, authority, actionKey, capture.action.contract_digest, request.draft_ref, input_digest), request.snapshot_ref, authority) : null;
      const clock = await samplePrivateAccessClock(tx, this.now), sampled = clock.current().getTime();
      const expires_at = new Date(Math.min(sampled + 120_000,
        authority.current_authority_expires_at.getTime(), authority.session.expires_at.getTime(), draft?.expires_at ?? Infinity,
        payload?.retained.expires_at.getTime() ?? Infinity,integration?Date.parse(integration.expires_at):Infinity, ...(payload?.retained.file_refs.map(file => Date.parse(file.expires_at)) ?? []))).toISOString();
      const ticket = sealHumanActionTicket(this.runtime.keys, {
        org_id: caller.org_id, user_id: caller.user_id, sid: caller.sid, session_id: sessionId,
        action_key: actionKey, runtime_binding_id: authority.runtime_binding_id,
        authority_digest: this.authorityDigest(authority, capture), input, input_digest,
        idempotency_key: request.idempotency_key, expires_at,
        ...(future?{future_record_action:future}:{}),
        ...(integration?{integration_prepared_action:integration}:{}),
        ...(actionSources?{resources_digest:humanActionDigest(actionSources)}:{}),
        ...(request.draft_ref && draft ? { draft_ref: request.draft_ref, draft_digest: draft.digest } : {}),
        ...(request.snapshot_ref ? { snapshot_ref: request.snapshot_ref } : {}) });
      afterCommit = () => { signal?.throwIfAborted(); assertHumanActionTicketDeadline(expires_at, this.now().getTime(), clock.current().getTime(), 0); };
      await final(tx, afterCommit);
      return { schema_version: 'deft.experience_human_action_ticket.v1' as const, ticket, input_digest, expires_at,
        ...(request.snapshot_ref ? { snapshot_ref: request.snapshot_ref } : {}) };
    }, signal, request.draft_ref?.draft_state_key, undefined, 'human_action_preparation');
    afterCommit(); return result;
  }

  confirm(caller:ExperienceCaller,sessionId:string,raw:unknown,signal?:AbortSignal){return this.confirmValue(caller,sessionId,raw,signal);}
  confirmPreparedIntegration(caller:ExperienceCaller,sessionId:string,raw:unknown,signal?:AbortSignal){
    return this.confirmValue(caller,sessionId,raw,signal,undefined,undefined,undefined,false,undefined,true);
  }

  /** Host-only verified record metadata is retained before approval can queue an effect. */
  confirmPreparedRecordAction(caller:ExperienceCaller,sessionId:string,raw:unknown,beforeRecordApprove:(tx:AppRunTransaction,run:AppRunSafeView)=>Promise<void>,signal?:AbortSignal){
    return this.confirmValue(caller,sessionId,raw,signal,undefined,undefined,undefined,false,beforeRecordApprove);
  }

  confirmReviewedFutureRecord(caller:ExperienceCaller,sessionId:string,raw:unknown,admit:(tx:AppRunTransaction,run:{id:string},future:ReviewedFutureRecordActionTicket)=>Promise<void>,signal?:AbortSignal){
    return this.confirmValue(caller,sessionId,raw,signal,admit);
  }

  /** Server-only composition: membership is registered before approval can queue
   * a child. The caller's aggregate transaction owns atomic acceptance. */
  confirmPreparedResourceBatchChild(caller: ExperienceCaller, sessionId: string, raw: unknown,
    transaction: AppRunTransaction, beforeApprove: (tx: AppRunTransaction, run: AppRunSafeView, authority: HumanActionAuthority) => Promise<void>, signal?: AbortSignal) {
    const request=HumanActionConfirmSchema.parse(raw),entries=this.preparedBatchApprovals.get(transaction),entry=entries?.get(request.ticket);
    if(!entry||entry.identity!==humanActionDigest({caller,sessionId,request}))throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    signal?.throwIfAborted();entries!.delete(request.ticket);return entry.approve(beforeApprove);
  }
  registerPreparedResourceBatchChild(caller: ExperienceCaller, sessionId: string, raw: unknown,
    transaction: AppRunTransaction, beforeApprove: (tx: AppRunTransaction, run: AppRunSafeView, authority: HumanActionAuthority) => Promise<void>, signal?: AbortSignal) {
    return this.confirmValue(caller, sessionId, raw, signal, undefined, transaction, beforeApprove, true);
  }
  private confirmValue(caller: ExperienceCaller, sessionId: string, raw: unknown, signal?: AbortSignal, futureAdmission?:(tx:AppRunTransaction,run:{id:string},future:ReviewedFutureRecordActionTicket)=>Promise<void>,
    transaction?: AppRunTransaction, beforeApprove?: (tx: AppRunTransaction, run: AppRunSafeView, authority: HumanActionAuthority) => Promise<void>, deferApproval=false,beforeRecordApprove?:(tx:AppRunTransaction,run:AppRunSafeView)=>Promise<void>,integration=false) {
    const request = HumanActionConfirmSchema.parse(raw), ticket = openHumanActionTicket(this.runtime.keys, request.ticket);
    if (Boolean(ticket.future_record_action)!==Boolean(futureAdmission))throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    if(Boolean(ticket.integration_prepared_action)!==integration||integration&&(futureAdmission||beforeApprove||beforeRecordApprove||deferApproval||transaction))throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    if (ticket.org_id !== caller.org_id || ticket.user_id !== caller.user_id || ticket.sid !== caller.sid
      || ticket.session_id !== sessionId || ticket.input_digest !== request.expected_input_digest
      || ticket.input_digest !== humanActionDigest(ticket.input) || Date.parse(ticket.expires_at) <= this.now().getTime()
      || ticket.snapshot_ref?.digest !== request.expected_snapshot_digest) {
      throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    }
    const held=transaction?this.preparedBatchAuthority.get(transaction):undefined;
    if(held&&(held.identity!==humanActionDigest({caller,sessionId})||held.action_key!==ticket.action_key||held.authority.runtime_binding_id!==ticket.runtime_binding_id
      ||ticket.future_record_action||ticket.draft_ref||ticket.snapshot_ref||ticket.input.resource_action_version!=='deft.app_prepared_resource_action.v1'||!beforeApprove))throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    const use=async (tx:AppRunTransaction,authority:HumanActionAuthority,final:(tx:AppRunTransaction,check?:()=>void)=>Promise<void>) => {
      this.requirePayload(authority, ticket.draft_ref, ticket.snapshot_ref);
      const capture = await this.capture(tx, caller, authority);
      if(ticket.future_record_action)await assertFutureRecordActionPurposeDeadline(tx,caller.org_id,caller.user_id,authority.authorization_identity,ticket.future_record_action.authority.authority_expires_at);
      if (ticket.runtime_binding_id !== authority.runtime_binding_id
        || ticket.authority_digest !== this.authorityDigest(authority, capture)) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      if(capture.binding.owner_resource_binding_id&&!await appConnectionUpgradeSourceIsAvailable(tx,{org_id:caller.org_id,owner_user_id:caller.user_id,resource_binding_id:capture.binding.owner_resource_binding_id}))throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const actionSources=ticket.draft_ref?null:await this.actionSources(caller,authority,RuntimeObjectSchema.parse(capture.action.input_schema),ticket.input);
      if((actionSources?humanActionDigest(actionSources):undefined)!==ticket.resources_digest)throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      if (ticket.draft_ref) {
        if (ticket.idempotency_key !== ticket.draft_ref.draft_id) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
        const draft = await this.draftSnapshot(tx, caller, authority, ticket.draft_ref, ticket.input);
        if (draft.digest !== ticket.draft_digest) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
        await this.requireNoDroppedFiles(tx, caller, authority, ticket.draft_ref, draft.expires_at, signal);
      }
      if (ticket.snapshot_ref && ticket.draft_ref) await this.payload(tx,
        this.payloadBinding(caller, authority, ticket.action_key, capture.action.contract_digest, ticket.draft_ref, ticket.input_digest), ticket.snapshot_ref, authority);
      const guard = async (executor: AppRunTransaction) => {
        if(ticket.integration_prepared_action){const original=await guardOriginalPrepared(executor,caller,ticket.integration_prepared_action,ticket.input);if(original.action?.action_binding_id!==ticket.runtime_binding_id)throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');}
        const clock = await samplePrivateAccessClock(executor, this.now), sampled = clock.current().getTime();
        if (Date.parse(ticket.expires_at) <= sampled) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
        const ticketStillCurrent = () => {
          assertHumanActionTicketDeadline(ticket.expires_at, this.now().getTime(), clock.current().getTime(), 0);
        };
        await final(executor, ticketStillCurrent);
        ticketStillCurrent();
      };
      const run = await this.runtime.service.submitReviewedRuntime(caller, {
        runtime_binding_id: ticket.runtime_binding_id, input: ticket.input,
        idempotency_key: `human:${authority.session.app_installation_id}:${ticket.idempotency_key}`,
      }, undefined, guard, tx,ticket.future_record_action?new Date(ticket.future_record_action.future_release.execution_window.dispatch_expires_at):undefined);
      if(actionSources)await this.runtime.secretRepository.retainActionResources(tx,{org_id:caller.org_id,run_id:run.id,value:actionSources,expires_at:new Date(Math.min(run.input_expires_at.getTime(),authority.current_authority_expires_at.getTime()))});
      const identity = authority.authorization_identity;
      const legacyExposureId = identity.consent_grant_id ? null : identity.exposure_id;
      const legacyExposureEpoch = identity.consent_grant_id ? null : identity.exposure_epoch;
      await tx.execute(sql`INSERT INTO app_run_human_authorizations
        (org_id,run_id,owner_user_id,consent_grant_id,consent_epoch,exposure_id,exposure_epoch,snapshot_id,snapshot_digest)
        VALUES (${caller.org_id},${run.id},${caller.user_id},${identity.consent_grant_id},${identity.consent_epoch},${legacyExposureId},${legacyExposureEpoch},${ticket.snapshot_ref?.snapshot_id ?? null},${ticket.snapshot_ref?.digest ?? null})
        ON CONFLICT (org_id,run_id) DO NOTHING`);
      const linked=await tx.execute(sql<{owner_user_id:string;consent_grant_id:string|null;consent_epoch:number|null;exposure_id:string|null;exposure_epoch:number|null;snapshot_id:string|null;snapshot_digest:string|null}>`
        SELECT owner_user_id,consent_grant_id,consent_epoch,exposure_id,exposure_epoch,snapshot_id,snapshot_digest FROM app_run_human_authorizations
        WHERE org_id=${caller.org_id} AND run_id=${run.id} FOR SHARE`);
      const link=linked.rows[0];
      if(!link || link.owner_user_id!==caller.user_id || link.consent_grant_id!==identity.consent_grant_id
        || link.consent_epoch!==identity.consent_epoch || link.exposure_id!==legacyExposureId || link.exposure_epoch!==legacyExposureEpoch
        || link.snapshot_id!==(ticket.snapshot_ref?.snapshot_id ?? null) || link.snapshot_digest!==(ticket.snapshot_ref?.digest ?? null)) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      if(beforeRecordApprove){if(ticket.draft_ref||ticket.snapshot_ref||ticket.input.record_action_version!=='deft.app_prepared_record_action.v1')throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');await beforeRecordApprove(tx,run);await guard(tx);}
      if(ticket.integration_prepared_action){await linkOriginalPrepared(tx,caller,run,ticket.integration_prepared_action,ticket.input);await guard(tx);}
      if(beforeApprove){if(ticket.draft_ref||ticket.snapshot_ref||ticket.input.resource_action_version!=='deft.app_prepared_resource_action.v1')throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');await beforeApprove(tx,run,authority);await guard(tx);}
      const [approval] = await tx.select({ id: agentActions.id }).from(agentActions).where(and(
        eq(agentActions.org_id, caller.org_id), eq(agentActions.app_run_id, run.id),
        eq(agentActions.user_id, caller.user_id), eq(agentActions.source, 'app_run'), eq(agentActions.action, 'app_run_invoke'),
      )).limit(1);
      if (!approval) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      if(ticket.future_record_action&&futureAdmission)await futureAdmission(tx,run,ticket.future_record_action);
      const release=async():Promise<PreparedBatchApprovalView>=>{
      const result = await this.runtime.approvalResolver.approveInTransaction(tx, approval.id, caller.user_id, guard);
      if (result.status !== 'approved') throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const released = await this.runtime.repository.lockRun(tx, caller.org_id, run.id);
      if (!released) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      await guard(tx);
      return { run: { ...released, state: experienceRunState(released.state, released.execution_release_kind) } };
      };
      if(deferApproval){
        if(!transaction||!beforeApprove||ticket.future_record_action)throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
        let entries=this.preparedBatchApprovals.get(tx);if(!entries){entries=new Map();this.preparedBatchApprovals.set(tx,entries);}
        if(entries.has(request.ticket))throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
        entries.set(request.ticket,{identity:humanActionDigest({caller,sessionId,request}),approve:async(check)=>{signal?.throwIfAborted();await check(tx,run,authority);await guard(tx);return release();}});
        return {run:{...run,state:experienceRunState(run.state,run.execution_release_kind)}};
      }
      return release();
    };
    return held?use(transaction!,held.authority,held.final):this.authority.withHumanAction(caller,sessionId,ticket.action_key,use,signal,ticket.draft_ref?.draft_state_key,transaction,'human_action_confirmation');
  }
}
