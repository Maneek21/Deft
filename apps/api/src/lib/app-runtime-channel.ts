import { and, asc, eq, gt, isNotNull } from 'drizzle-orm';
import { appRunAttempts, appRuns, appRuntimeSessions } from '@deft/db/schema';
import { db } from './db.js';
import { isAppRuntimeChannelEnabled } from './env.js';
import type { AppRunAttemptRunner } from './app-run-attempt-runner.js';
import { hashAppRuntimeToken, issueAppRuntimeSession } from './app-runtime-authority.js';
import {
  AppRuntimeClaimRequestSchema, AppRuntimeHeartbeatRequestSchema,
  AppRuntimeStartRequestSchema, parseAppRuntimeResult,
} from './app-runtime-contract.js';

/** Deliberately separate from employee/public App audiences. No route or App
 * Kit v0-v2 submission can activate it merely by installation. */
export function appRuntimeChannelEnabled(): boolean {
  return isAppRuntimeChannelEnabled();
}

export class AppRuntimeChannel {
  constructor(private readonly runner: AppRunAttemptRunner) {}

  /** Host-only issuance after the caller authenticates an operator user.
   * Registration/binding review remains a separate privileged workflow. */
  async issueSession(input: Parameters<typeof issueAppRuntimeSession>[0]) {
    if (!appRuntimeChannelEnabled()) return null;
    return issueAppRuntimeSession(input);
  }

  async claim(value: unknown) {
    if (!appRuntimeChannelEnabled()) return null;
    const request = AppRuntimeClaimRequestSchema.parse(value);
    const identity = await this.#session(request.session_id, request.session_token);
    if (!identity) return null;
    const candidates = await db.select({
      run_id: appRunAttempts.run_id, attempt_id: appRunAttempts.id,
    }).from(appRunAttempts).innerJoin(appRuns, and(
      eq(appRuns.org_id, appRunAttempts.org_id), eq(appRuns.id, appRunAttempts.run_id),
    )).where(and(
      eq(appRunAttempts.org_id, identity.org_id),
      eq(appRunAttempts.state, 'pending'),
      eq(appRuns.origin_kind, 'app'), eq(appRuns.provider_kind, 'app_runtime'),
      eq(appRuns.origin_runtime_binding_id, identity.runtime_binding_id),
      isNotNull(appRuns.execution_released_at), gt(appRuns.input_expires_at, new Date()),
    )).orderBy(asc(appRunAttempts.created_at)).limit(8);
    for (const candidate of candidates) {
      const claimed = await this.runner.claimRuntimeAttempt({
        org_id: identity.org_id, run_id: candidate.run_id,
        attempt_id: candidate.attempt_id, session_id: request.session_id,
        token_hash: identity.token_hash,
      });
      if (claimed) return claimed;
    }
    return null;
  }

  async start(value: unknown) {
    if (!appRuntimeChannelEnabled()) return null;
    const request = AppRuntimeStartRequestSchema.parse(value);
    const identity = await this.#session(request.session_id, request.session_token);
    if (!identity) return null;
    return this.runner.startRuntimeAttempt({
      org_id: identity.org_id, run_id: request.run_id, attempt_id: request.attempt_id,
      session_id: request.session_id, token_hash: identity.token_hash,
      claim_token: request.claim_token, sequence: request.sequence,
    });
  }

  async heartbeat(value: unknown): Promise<boolean> {
    if (!appRuntimeChannelEnabled()) return false;
    const request = AppRuntimeHeartbeatRequestSchema.parse(value);
    const identity = await this.#session(request.session_id, request.session_token);
    if (!identity) return false;
    return this.runner.heartbeatRuntimeAttempt({
      org_id: identity.org_id, run_id: request.run_id, attempt_id: request.attempt_id,
      session_id: request.session_id, token_hash: identity.token_hash,
      claim_token: request.claim_token, sequence: request.sequence,
    });
  }

  async complete(value: unknown) {
    if (!appRuntimeChannelEnabled()) return null;
    const result = parseAppRuntimeResult(value);
    const identity = await this.#session(result.session_id, result.session_token);
    if (!identity) return null;
    return this.runner.completeRuntimeAttempt({
      org_id: identity.org_id, token_hash: identity.token_hash, result,
    });
  }

  async #session(sessionId: string, token: string): Promise<Readonly<{
    org_id: string; runtime_binding_id: string; token_hash: string;
  }> | null> {
    const tokenHash = hashAppRuntimeToken(token);
    const [session] = await db.select({
      org_id: appRuntimeSessions.org_id,
      runtime_binding_id: appRuntimeSessions.runtime_binding_id,
      token_hash: appRuntimeSessions.token_hash,
    }).from(appRuntimeSessions).where(and(
      eq(appRuntimeSessions.id, sessionId), eq(appRuntimeSessions.token_hash, tokenHash),
    )).limit(1);
    return session ?? null;
  }
}
