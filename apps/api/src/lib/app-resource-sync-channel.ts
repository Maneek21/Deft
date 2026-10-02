import { and, asc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { appRunAttempts, appRuns, appRuntimeSessions } from '@deft/db/schema';
import { db } from './db.js';
import { isAppResourceSyncChannelEnabled } from './env.js';
import type { AppRunAttemptRunner } from './app-run-attempt-runner.js';
import { hashAppResourceSyncToken } from './app-resource-sync-policy.js';
import {
  AppResourceSyncClaimRequestSchema, AppResourceSyncHeartbeatRequestSchema,
  AppResourceSyncResultRequestSchema, AppResourceSyncStartRequestSchema,
} from './app-resource-sync-contract.js';

/** Independent v2 rollout: a v1 action session cannot address this channel. */
export function appResourceSyncChannelEnabled(): boolean {
  return isAppResourceSyncChannelEnabled();
}

export class AppResourceSyncChannel {
  constructor(private readonly runner: AppRunAttemptRunner) {}

  async claim(value: unknown) {
    if (!appResourceSyncChannelEnabled()) return null;
    const request = AppResourceSyncClaimRequestSchema.parse(value);
    const identity = await this.#session(request.session_id, request.session_token);
    if (!identity) return null;
    const candidates = await db.select({
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
    )).orderBy(asc(appRunAttempts.created_at)).limit(8);
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
    if (!appResourceSyncChannelEnabled()) return null;
    const request = AppResourceSyncStartRequestSchema.parse(value);
    const identity = await this.#session(request.session_id, request.session_token);
    if (!identity) return null;
    return this.runner.startResourceSyncAttempt({
      org_id: identity.org_id, run_id: request.run_id, attempt_id: request.attempt_id,
      session_id: request.session_id, token_hash: identity.token_hash,
      claim_token: request.claim_token, sequence: request.sequence,
    });
  }

  async heartbeat(value: unknown) {
    if (!appResourceSyncChannelEnabled()) return null;
    const request = AppResourceSyncHeartbeatRequestSchema.parse(value);
    const identity = await this.#session(request.session_id, request.session_token);
    if (!identity) return null;
    return this.runner.heartbeatResourceSyncAttempt({
      org_id: identity.org_id, run_id: request.run_id, attempt_id: request.attempt_id,
      session_id: request.session_id, token_hash: identity.token_hash,
      claim_token: request.claim_token, sequence: request.sequence,
    });
  }

  async complete(value: unknown) {
    if (!appResourceSyncChannelEnabled()) return null;
    const result = AppResourceSyncResultRequestSchema.parse(value);
    const identity = await this.#session(result.session_id, result.session_token);
    if (!identity) return null;
    return this.runner.completeResourceSyncAttempt({
      org_id: identity.org_id, token_hash: identity.token_hash, result,
    });
  }

  async #session(sessionId: string, token: string): Promise<Readonly<{
    org_id: string; resource_binding_id: string; token_hash: string;
  }> | null> {
    const tokenHash = hashAppResourceSyncToken(token);
    const [session] = await db.select({
      org_id: appRuntimeSessions.org_id,
      resource_binding_id: appRuntimeSessions.resource_binding_id,
      token_hash: appRuntimeSessions.token_hash,
    }).from(appRuntimeSessions).where(and(
      eq(appRuntimeSessions.id, sessionId), eq(appRuntimeSessions.token_hash, tokenHash),
      eq(appRuntimeSessions.audience, 'app_resource_sync'),
      isNull(appRuntimeSessions.runtime_binding_id),
    )).limit(1);
    if (!session?.resource_binding_id) return null;
    return { ...session, resource_binding_id: session.resource_binding_id };
  }
}
