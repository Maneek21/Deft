import { createWebSession, rotateWebSession } from './web-sessions.js';
import { SecondStepRequiredError } from './two-step-policy.js';
import {
  createTwoStepChallenge,
  exchangeVerifyChallenge,
  type ChallengeExchange,
  type SecondStepProof,
  type TwoStepChallenge,
} from './two-step-service.js';

/**
 * The one function every route uses to hand out a session: login, signup,
 * accepting an invite, token refresh, and the two calls that finish a second
 * step. The policy itself is enforced inside createWebSession and
 * rotateWebSession (two-step-policy.ts); this function turns a refusal into
 * the right short-lived challenge so no route decides it for itself.
 */
type Identity = { id: string; email: string; org_id: string };

export type SessionRequest =
  /** A correct password (login), or a password just set (invite). */
  | { via: 'login' | 'invite'; identity: Identity; expectedPasswordHash: string }
  /** The first account of a new workspace. */
  | { via: 'signup'; identity: Identity }
  | { via: 'refresh'; refreshToken: string }
  /** A login challenge plus an authenticator code or a recovery code. */
  | { via: 'challenge'; challengeToken: string; proof: SecondStepProof }
  /** Enrolment was confirmed with a code a moment ago. */
  | { via: 'enrolment'; identity: Identity };

export type IssuedSession =
  | { status: 'session'; accessToken: string; refreshToken: string }
  /** Has two-step verification: exchange this challenge plus a code. */
  | { status: 'code_required'; challenge: TwoStepChallenge }
  /** Hosted owner or admin without it: this token can only enrol. */
  | { status: 'enrolment_required'; challenge: TwoStepChallenge }
  | { status: 'refused'; exchange: Exclude<ChallengeExchange, { ok: true }> };

async function createOrChallenge(identity: Identity, expectedPasswordHash?: string): Promise<GrantedOrChallenged> {
  try {
    return { status: 'session', ...(await createWebSession(identity, expectedPasswordHash)) };
  } catch (error) {
    if (!(error instanceof SecondStepRequiredError) || error.passwordVersion === null) throw error;
    const challenge = await createTwoStepChallenge({
      userId: identity.id,
      orgId: identity.org_id,
      kind: error.requirement === 'code' ? 'verify' : 'enrol',
      passwordVersion: error.passwordVersion,
    });
    return { status: error.requirement === 'code' ? 'code_required' : 'enrolment_required', challenge };
  }
}

export type GrantedOrChallenged = Exclude<IssuedSession, { status: 'refused' }>;

export async function issueSession(request: Exclude<SessionRequest, { via: 'challenge' }>): Promise<GrantedOrChallenged>;
export async function issueSession(request: SessionRequest): Promise<IssuedSession>;
export async function issueSession(request: SessionRequest): Promise<IssuedSession> {
  switch (request.via) {
    case 'login':
    case 'invite':
      return createOrChallenge(request.identity, request.expectedPasswordHash);
    case 'signup':
      return createOrChallenge(request.identity);
    case 'refresh':
      // Throws when the session is gone or no longer satisfies the policy.
      return { status: 'session', ...(await rotateWebSession(request.refreshToken)) };
    case 'challenge': {
      const exchange = await exchangeVerifyChallenge(request.challengeToken, request.proof);
      if (!exchange.ok) return { status: 'refused', exchange };
      return { status: 'session', ...(await createWebSession(exchange.identity, undefined, { secondStep: 'verified' })) };
    }
    case 'enrolment':
      return { status: 'session', ...(await createWebSession(request.identity, undefined, { secondStep: 'verified' })) };
  }
}

/** The part of a login-style response that carries the outcome. */
export function issuedSessionBody(issued: GrantedOrChallenged) {
  if (issued.status === 'session') return { accessToken: issued.accessToken, refreshToken: issued.refreshToken };
  return { two_step: { status: issued.status, token: issued.challenge.token, expires_at: issued.challenge.expires_at } };
}
