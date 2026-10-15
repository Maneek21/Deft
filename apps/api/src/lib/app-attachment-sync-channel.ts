import {z} from 'zod';
import {runtimeRenewalDeadline,runtimeRenewalPersistentPrincipal} from './app-runtime-renewal.js';
import {loadLiveAttachmentSyncAuthority} from './app-attachment-sync-authority.js';
import {AppConnectionSessionRecordSchema} from './app-connection-session-service.js';
import {loadObservationConnection} from './app-resource-observation-authority.js';
import { and, asc,desc, eq, gt, isNotNull, isNull,sql } from 'drizzle-orm';
import { appRunAttempts, appRuns, appRuntimeSessions,appConnectionSessions } from '@deft/db/schema';
import type { createBoundedAppRunDatabase } from './app-run-bounded-db.js';
import { isAppAttachmentBrokerEnabled } from './env.js';
import type { AppRunAttemptRunner } from './app-run-attempt-runner.js';
import { hashAppAttachmentSessionToken } from './app-attachment-policy.js';
import {
  ResourceSyncClaimRequestV3Schema, ResourceSyncHeartbeatRequestV3Schema,
  ResourceSyncResultRequestV3Schema, ResourceSyncStartRequestV3Schema,
} from '@deft/app-kit';

/** Separate channel3 entry point; channel2 credentials and envelopes remain closed. */
export function appAttachmentSyncChannelEnabled(): boolean {
  return isAppAttachmentBrokerEnabled();
}

export class AppAttachmentSyncChannel {
  constructor(private readonly runner: AppRunAttemptRunner,
    private readonly database: ReturnType<typeof createBoundedAppRunDatabase>) {}
  #read<T>(work: (tx: import('./app-run-repository.js').AppRunTransaction) => Promise<T>) {
    return this.database.transaction(work,new AbortController().signal,performance.now()+10_000);
  }

  async renew(value:unknown){
    if(!appAttachmentSyncChannelEnabled())return null;
    const request=z.strictObject({schema_version:z.literal('deft.app_runtime_channel.v3'),audience:z.literal('app_resource_sync'),
      session_id:z.string().uuid(),session_token:z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/u),expected_expires_at:z.iso.datetime()}).parse(value);
    const identity=await this.#session(request.session_id,request.session_token);if(!identity)return null;
    return this.#read(async tx=>{
      const current=await loadLiveAttachmentSyncAuthority(tx,{org_id:identity.org_id,session_id:request.session_id,token_hash:identity.token_hash,clock:()=>new Date()});
      if(!current||current.session.renewal_lifetime!=='until_revoked'||current.session.renewable_until!==null
        ||!current.session.renewal_web_session_id||!current.session.renewal_operator_role||current.binding.consent_lifetime!=='until_revoked')return null;
      if(!await runtimeRenewalPersistentPrincipal(tx,{org_id:identity.org_id,operator_user_id:current.session.operator_user_id,role:current.session.renewal_operator_role}))return null;
      const rows=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,identity.org_id),
        eq(appConnectionSessions.owner_user_id,current.binding.owner_user_id),sql`${appConnectionSessions.record}->'scope'->>'resource_binding_id'=${current.binding.id}`,
        sql`${appConnectionSessions.record}->>'state'='connected'`)).orderBy(desc(appConnectionSessions.created_at)).limit(1);
      if(!rows[0])return null;await loadObservationConnection(tx,current,AppConnectionSessionRecordSchema.parse(rows[0].record).session_id);
      const clock=await tx.execute(sql`SELECT clock_timestamp() AS renewed_at`),now=new Date(clock.rows[0]!.renewed_at as string|Date);
      const next=runtimeRenewalDeadline({now,current_expires_at:current.session.expires_at,expected_expires_at:new Date(request.expected_expires_at),renewable_until:null,principal_expires_at:null,renewal_lifetime:'until_revoked'});
      if(!next)return null;
      await tx.update(appRuntimeSessions).set({expires_at:next,updated_at:now}).where(and(eq(appRuntimeSessions.org_id,identity.org_id),eq(appRuntimeSessions.id,request.session_id),eq(appRuntimeSessions.token_hash,identity.token_hash)));
      if(!await loadLiveAttachmentSyncAuthority(tx,{org_id:identity.org_id,session_id:request.session_id,token_hash:identity.token_hash,clock:()=>new Date()}))throw Error('Resource renewal authority changed');
      return {session_id:request.session_id,expires_at:next.toISOString(),renewable_until:null,renewal_lifetime:'until_revoked' as const};
    });
  }

  async claim(value: unknown) {
    if (!appAttachmentSyncChannelEnabled()) return null;
    const request = ResourceSyncClaimRequestV3Schema.parse(value);
    const identity = await this.#session(request.session_id, request.session_token);
    if (!identity) return null;
    const candidates = await this.#read(db => db.select({
      run_id: appRunAttempts.run_id, attempt_id: appRunAttempts.id,
    }).from(appRunAttempts).innerJoin(appRuns, and(
      eq(appRuns.org_id, appRunAttempts.org_id), eq(appRuns.id, appRunAttempts.run_id),
    )).where(and(
      eq(appRunAttempts.org_id, identity.org_id), eq(appRunAttempts.state, 'pending'),
      eq(appRuns.origin_kind, 'app'), eq(appRuns.provider_kind, 'app_runtime'),
      eq(appRuns.origin_resource_binding_id, identity.resource_binding_id),
      eq(appRuns.review_scope, 'reviewed_resource_sync'),
      isNull(appRuns.origin_runtime_binding_id),
      isNotNull(appRuns.execution_released_at), gt(appRuns.input_expires_at, new Date()),
    )).orderBy(asc(appRunAttempts.created_at)).limit(8));
    for (const candidate of candidates) {
      const claimed = await this.runner.claimResourceSyncAttempt({
        org_id: identity.org_id, run_id: candidate.run_id,
        attempt_id: candidate.attempt_id, session_id: request.session_id,
        token_hash: identity.token_hash,
      });
      if (claimed) return claimed;
    }
    return null;
  }

  async start(value: unknown) {
    if (!appAttachmentSyncChannelEnabled()) return null;
    const request = ResourceSyncStartRequestV3Schema.parse(value);
    const identity = await this.#session(request.session_id, request.session_token);
    if (!identity) return null;
    return this.runner.startResourceSyncAttempt({
      org_id: identity.org_id, run_id: request.run_id, attempt_id: request.attempt_id,
      session_id: request.session_id, token_hash: identity.token_hash,
      claim_token: request.claim_token, sequence: request.sequence,
    });
  }

  async heartbeat(value: unknown) {
    if (!appAttachmentSyncChannelEnabled()) return null;
    const request = ResourceSyncHeartbeatRequestV3Schema.parse(value);
    const identity = await this.#session(request.session_id, request.session_token);
    if (!identity) return null;
    return this.runner.heartbeatResourceSyncAttempt({
      org_id: identity.org_id, run_id: request.run_id, attempt_id: request.attempt_id,
      session_id: request.session_id, token_hash: identity.token_hash,
      claim_token: request.claim_token, sequence: request.sequence,
    });
  }

  async complete(value: unknown) {
    if (!appAttachmentSyncChannelEnabled()) return null;
    const result = ResourceSyncResultRequestV3Schema.parse(value);
    const identity = await this.#session(result.session_id, result.session_token);
    if (!identity) return null;
    return this.runner.completeResourceSyncAttempt({
      org_id: identity.org_id, token_hash: identity.token_hash, result,
    });
  }

  async #session(sessionId: string, token: string): Promise<Readonly<{
    org_id: string; resource_binding_id: string; token_hash: string;
  }> | null> {
    const tokenHash = hashAppAttachmentSessionToken(token);
    const [session] = await this.#read(db => db.select({
      org_id: appRuntimeSessions.org_id,
      resource_binding_id: appRuntimeSessions.resource_binding_id,
      token_hash: appRuntimeSessions.token_hash,
    }).from(appRuntimeSessions).where(and(
      eq(appRuntimeSessions.id, sessionId), eq(appRuntimeSessions.token_hash, tokenHash),
      eq(appRuntimeSessions.audience, 'app_resource_sync'),
      isNull(appRuntimeSessions.runtime_binding_id),
    )).limit(1));
    if (!session?.resource_binding_id) return null;
    return { ...session, resource_binding_id: session.resource_binding_id };
  }
}
