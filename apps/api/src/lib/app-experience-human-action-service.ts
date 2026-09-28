import { z } from 'zod';
import { experienceRunState } from './app-experience-run-presentation.js';
import { experienceAgentPolicy } from './app-experience-human-action-agent-policy.js';
import { and, eq, or, isNull, sql } from 'drizzle-orm';
import { agentActions, appRuns, appRunHumanAuthorizations } from '@deft/db/schema';
import { RuntimeObjectSchema, parseRuntimeObjectInput } from '@deft/app-kit';
import { AppRunError } from './app-run-errors.js';
import type { AppRunRuntime } from './app-run-runtime.js';
import type { AppRunTransaction } from './app-run-repository.js';
import type { ExperienceCaller } from './app-experience-service.js';
import { HumanActionPrepareSchema, HumanActionConfirmSchema, humanActionDigest,
  sealHumanActionTicket, openHumanActionTicket, assertHumanActionTicketDeadline } from './app-experience-human-action-contract.js';

export type HumanActionAuthority = Readonly<{
  session: Readonly<{ id: string; app_installation_id: string; app_version_id: string;
    grant_snapshot_id: string; artifact_digest: string; expires_at: Date }>;
  runtime_binding_id: string; action_label: string; current_authority_expires_at: Date;
  authorization_identity: Readonly<{ consent_grant_id: string | null; consent_epoch: number | null; exposure_id: string; exposure_epoch: number }>;
}>;
export interface HumanActionAuthorityPort {
  withHumanAction<T>(caller: ExperienceCaller, sessionId: string, actionKey: string,
    use: (tx: AppRunTransaction, authority: HumanActionAuthority,
      finalGuard: (tx: AppRunTransaction, additionalFinalCheck?: () => void) => Promise<void>) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** This service is reachable only from authenticated host HTTP, never a Worker operation. */
export class AppExperienceHumanActionService {
  constructor(private readonly authority: HumanActionAuthorityPort,
    private readonly runtime: AppRunRuntime, private readonly now = () => new Date()) {}

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
    const sampled=await tx.execute(sql<{now:Date}>`SELECT clock_timestamp() AS now`);
    return Math.max(this.now().getTime(), new Date(sampled.rows[0]!.now as Date).getTime());
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
        contract_digest: capture.action.contract_digest, runtime_binding_id: authority.runtime_binding_id,
        app_version_id: authority.session.app_version_id, grant_snapshot_id: authority.session.grant_snapshot_id,
        expires_at: authority.current_authority_expires_at.toISOString() };
    }, signal);
  }

  prepare(caller: ExperienceCaller, sessionId: string, actionKey: string, raw: unknown, signal?: AbortSignal) {
    const request = HumanActionPrepareSchema.parse(raw);
    return this.authority.withHumanAction(caller, sessionId, actionKey, async (tx, authority, final) => {
      const capture = await this.capture(tx, caller, authority);
      const input = parseRuntimeObjectInput(RuntimeObjectSchema.parse(capture.action.input_schema), request.input);
      const input_digest = humanActionDigest(input);
      const expires_at = new Date(Math.min(await this.currentTime(tx) + 120_000,
        authority.current_authority_expires_at.getTime(), authority.session.expires_at.getTime())).toISOString();
      const ticket = sealHumanActionTicket(this.runtime.keys, {
        org_id: caller.org_id, user_id: caller.user_id, sid: caller.sid, session_id: sessionId,
        action_key: actionKey, runtime_binding_id: authority.runtime_binding_id,
        authority_digest: this.authorityDigest(authority, capture), input, input_digest,
        idempotency_key: request.idempotency_key, expires_at });
      await final(tx);
      return { schema_version: 'deft.experience_human_action_ticket.v1' as const, ticket, input_digest, expires_at };
    }, signal);
  }

  confirm(caller: ExperienceCaller, sessionId: string, raw: unknown, signal?: AbortSignal) {
    const request = HumanActionConfirmSchema.parse(raw), ticket = openHumanActionTicket(this.runtime.keys, request.ticket);
    if (ticket.org_id !== caller.org_id || ticket.user_id !== caller.user_id || ticket.sid !== caller.sid
      || ticket.session_id !== sessionId || ticket.input_digest !== request.expected_input_digest
      || ticket.input_digest !== humanActionDigest(ticket.input) || Date.parse(ticket.expires_at) <= this.now().getTime()) {
      throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    }
    return this.authority.withHumanAction(caller, sessionId, ticket.action_key, async (tx, authority, final) => {
      const capture = await this.capture(tx, caller, authority);
      if (ticket.runtime_binding_id !== authority.runtime_binding_id
        || ticket.authority_digest !== this.authorityDigest(authority, capture)) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const guard = async (executor: AppRunTransaction) => {
        const sampled = await this.currentTime(executor), started = performance.now();
        if (Date.parse(ticket.expires_at) <= sampled) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
        const ticketStillCurrent = () => {
          assertHumanActionTicketDeadline(ticket.expires_at, this.now().getTime(), sampled, performance.now() - started);
        };
        await final(executor, ticketStillCurrent);
        ticketStillCurrent();
      };
      const run = await this.runtime.service.submitReviewedRuntime(caller, {
        runtime_binding_id: ticket.runtime_binding_id, input: ticket.input,
        idempotency_key: `human:${authority.session.app_installation_id}:${ticket.idempotency_key}`,
      }, undefined, guard, tx);
      const identity = authority.authorization_identity;
      const legacyExposureId = identity.consent_grant_id ? null : identity.exposure_id;
      const legacyExposureEpoch = identity.consent_grant_id ? null : identity.exposure_epoch;
      await tx.execute(sql`INSERT INTO app_run_human_authorizations
        (org_id,run_id,owner_user_id,consent_grant_id,consent_epoch,exposure_id,exposure_epoch)
        VALUES (${caller.org_id},${run.id},${caller.user_id},${identity.consent_grant_id},${identity.consent_epoch},${legacyExposureId},${legacyExposureEpoch})
        ON CONFLICT (org_id,run_id) DO NOTHING`);
      const linked=await tx.execute(sql<{owner_user_id:string;consent_grant_id:string|null;consent_epoch:number|null;exposure_id:string|null;exposure_epoch:number|null}>`
        SELECT owner_user_id,consent_grant_id,consent_epoch,exposure_id,exposure_epoch FROM app_run_human_authorizations
        WHERE org_id=${caller.org_id} AND run_id=${run.id} FOR SHARE`);
      const link=linked.rows[0];
      if(!link || link.owner_user_id!==caller.user_id || link.consent_grant_id!==identity.consent_grant_id
        || link.consent_epoch!==identity.consent_epoch || link.exposure_id!==legacyExposureId || link.exposure_epoch!==legacyExposureEpoch) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const [approval] = await tx.select({ id: agentActions.id }).from(agentActions).where(and(
        eq(agentActions.org_id, caller.org_id), eq(agentActions.app_run_id, run.id),
        eq(agentActions.user_id, caller.user_id), eq(agentActions.source, 'app_run'), eq(agentActions.action, 'app_run_invoke'),
      )).limit(1);
      if (!approval) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const result = await this.runtime.approvalResolver.approveInTransaction(tx, approval.id, caller.user_id, guard);
      if (result.status !== 'approved') throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const released = await this.runtime.repository.lockRun(tx, caller.org_id, run.id);
      if (!released) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      await guard(tx);
      return { run: { ...released, state: experienceRunState(released.state, released.execution_release_kind) } };
    }, signal);
  }
}
