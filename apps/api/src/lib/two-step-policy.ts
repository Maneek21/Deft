import { eq } from 'drizzle-orm';
import { userTwoStep } from '@deft/db/two-step';
import type { db } from './db.js';
import { isHostedMode } from './hosted-mode.js';

/**
 * The one rule for what a person must show before they may hold a normal
 * session. Session creation, token refresh and (in hosted mode) every request
 * check ask this function; nothing else decides it.
 *
 * - `code`: the person has two-step verification, so a session needs an
 *   authenticator code or a recovery code.
 * - `enrolment`: hosted mode, owner or admin, not enrolled. They may hold
 *   only the restricted enrol-only challenge until they set it up.
 * - `none`: no second step. Self-hosted installs require it of nobody.
 */
export type SecondStepRequirement = 'none' | 'code' | 'enrolment';
export type SecondStepPolicy = { requirement: SecondStepRequirement; confirmedAt: Date | null };

type Database = typeof db;
export type TwoStepReader = Pick<Database, 'select'> | Pick<Parameters<Parameters<Database['transaction']>[0]>[0], 'select'>;

export class SecondStepRequiredError extends Error {
  readonly code: 'TWO_STEP_REQUIRED' | 'TWO_STEP_ENROLMENT_REQUIRED';
  readonly status = 403;
  constructor(
    public readonly requirement: Exclude<SecondStepRequirement, 'none'>,
    public readonly passwordVersion: number | null = null,
  ) {
    super(requirement === 'code' ? 'Two-step verification is required' : 'Two-step verification must be set up first');
    this.code = requirement === 'code' ? 'TWO_STEP_REQUIRED' : 'TWO_STEP_ENROLMENT_REQUIRED';
  }
}

export function roleMustHaveSecondStep(role: string | null | undefined): boolean {
  return isHostedMode() && (role === 'owner' || role === 'admin');
}

export async function secondStepPolicy(reader: TwoStepReader, userId: string, role: string | null | undefined): Promise<SecondStepPolicy> {
  const [row] = await (reader as Pick<Database, 'select'>)
    .select({ confirmed_at: userTwoStep.confirmed_at })
    .from(userTwoStep)
    .where(eq(userTwoStep.user_id, userId))
    .limit(1);
  const confirmedAt = row?.confirmed_at ?? null;
  if (confirmedAt) return { requirement: 'code', confirmedAt };
  return { requirement: roleMustHaveSecondStep(role) ? 'enrolment' : 'none', confirmedAt: null };
}

/**
 * Whether an existing session still satisfies the policy. Enrolment revokes
 * every earlier session, so a session older than the enrolment was never
 * issued against a code and is refused.
 */
export function sessionMeetsSecondStep(policy: SecondStepPolicy, sessionCreatedAt: Date): boolean {
  if (policy.requirement === 'none') return true;
  if (policy.requirement === 'enrolment') return false;
  return policy.confirmedAt !== null && sessionCreatedAt.getTime() >= policy.confirmedAt.getTime();
}
