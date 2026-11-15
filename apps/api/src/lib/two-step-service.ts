import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { orgMembers, users, webSessions } from '@deft/db/schema';
import { twoStepChallenges, userTwoStep, userTwoStepRecoveryCodes } from '@deft/db/two-step';
import { db } from './db.js';
import { decrypt, encrypt } from './encryption.js';
import { isHostedMode } from './hosted-mode.js';
import { emitWebSessionRevocations } from './web-sessions.js';
import {
  buildOtpauthUrl,
  generateRecoveryCodes,
  generateTwoStepSecret,
  generateTwoStepToken,
  hashRecoveryCode,
  hashTwoStepToken,
  matchTwoStepCode,
} from './two-step.js';

/**
 * Storage and rules for two-step verification: enrolment, code checks with
 * replay protection and per-account attempt limits, recovery codes, and the
 * short-lived challenges issued after a correct password.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Wrong codes a single challenge survives before it is dead. */
export const CHALLENGE_MAX_FAILURES = 5;
/** Consecutive wrong codes an account may make before a delay starts. */
export const ACCOUNT_FREE_FAILURES = 5;
export const VERIFY_CHALLENGE_TTL_MS = 10 * 60_000;
export const ENROL_CHALLENGE_TTL_MS = 30 * 60_000;
export const PENDING_SECRET_TTL_MS = 60 * 60_000;
const ISSUER = 'Deft';

/**
 * The delay after the Nth consecutive wrong code on an account: none for the
 * first few, then 30 seconds doubling up to one hour. It is keyed on the
 * account, never on a network address.
 */
export function twoStepLockDelayMs(failedAttempts: number): number {
  if (failedAttempts < ACCOUNT_FREE_FAILURES) return 0;
  return Math.min(30_000 * 2 ** Math.min(failedAttempts - ACCOUNT_FREE_FAILURES, 20), 60 * 60_000);
}

export type SecondStepProof = { code?: string | undefined; recoveryCode?: string | undefined };
export type SecondStepCheck =
  | { ok: true; method: 'code' | 'recovery_code' }
  | { ok: false; reason: 'not_enrolled' | 'invalid' }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number };

type CheckOptions = { secret: 'confirmed' | 'pending'; allowRecoveryCode: boolean; now: Date };

/**
 * Checks one code against the account inside the caller's transaction. Holds
 * the account's row lock, so two requests cannot use the same code, and
 * counts a wrong code against the account whatever route it arrived by.
 */
async function checkSecondStep(tx: Tx, userId: string, proof: SecondStepProof, options: CheckOptions): Promise<SecondStepCheck & { step?: number }> {
  const [row] = await tx.select().from(userTwoStep).where(eq(userTwoStep.user_id, userId)).for('update');
  if (!row) return { ok: false, reason: 'not_enrolled' };
  const now = options.now;
  if (row.locked_until && row.locked_until.getTime() > now.getTime()) {
    return { ok: false, reason: 'locked', retryAfterSeconds: Math.ceil((row.locked_until.getTime() - now.getTime()) / 1000) };
  }
  let secretEncrypted: string | null = null;
  if (options.secret === 'confirmed') {
    secretEncrypted = row.confirmed_at ? row.secret_encrypted : null;
  } else if (row.pending_created_at && now.getTime() - row.pending_created_at.getTime() <= PENDING_SECRET_TTL_MS) {
    secretEncrypted = row.pending_secret_encrypted;
  }
  if (!secretEncrypted) return { ok: false, reason: 'not_enrolled' };

  if (proof.code) {
    const step = matchTwoStepCode(decrypt(secretEncrypted), proof.code, now.getTime());
    // A code is accepted once: its step must be newer than the last accepted
    // step of the confirmed secret. A pending secret has accepted nothing yet.
    if (step !== null && (options.secret === 'pending' || step > row.last_used_step)) {
      await tx.update(userTwoStep)
        .set({ failed_attempts: 0, locked_until: null, ...(options.secret === 'confirmed' ? { last_used_step: step } : {}) })
        .where(eq(userTwoStep.user_id, userId));
      return { ok: true, method: 'code', step };
    }
  } else if (options.allowRecoveryCode && proof.recoveryCode) {
    const codeHash = hashRecoveryCode(proof.recoveryCode);
    if (codeHash) {
      // Single use: only the request that flips used_at wins.
      const used = await tx.update(userTwoStepRecoveryCodes)
        .set({ used_at: now })
        .where(and(eq(userTwoStepRecoveryCodes.user_id, userId), eq(userTwoStepRecoveryCodes.code_hash, codeHash), isNull(userTwoStepRecoveryCodes.used_at)))
        .returning({ id: userTwoStepRecoveryCodes.id });
      if (used.length === 1) {
        await tx.update(userTwoStep).set({ failed_attempts: 0, locked_until: null }).where(eq(userTwoStep.user_id, userId));
        return { ok: true, method: 'recovery_code' };
      }
    }
  }

  const failedAttempts = row.failed_attempts + 1;
  const delay = twoStepLockDelayMs(failedAttempts);
  await tx.update(userTwoStep)
    .set({ failed_attempts: failedAttempts, locked_until: delay > 0 ? new Date(now.getTime() + delay) : null })
    .where(eq(userTwoStep.user_id, userId));
  return { ok: false, reason: 'invalid' };
}

async function replaceRecoveryCodes(tx: Tx, userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await tx.delete(userTwoStepRecoveryCodes).where(eq(userTwoStepRecoveryCodes.user_id, userId));
  await tx.insert(userTwoStepRecoveryCodes).values(codes.map((code) => ({ user_id: userId, code_hash: hashRecoveryCode(code)! })));
  return codes;
}

async function revokeAllSessions(tx: Tx, userId: string): Promise<string[]> {
  const sessions = await tx.update(webSessions)
    .set({ revoked_at: new Date() })
    .where(and(eq(webSessions.user_id, userId), isNull(webSessions.revoked_at)))
    .returning({ id: webSessions.id });
  return sessions.map((session) => session.id);
}

export async function getTwoStepStatus(userId: string) {
  const [row] = await db.select({ confirmed_at: userTwoStep.confirmed_at }).from(userTwoStep).where(eq(userTwoStep.user_id, userId)).limit(1);
  const enabled = Boolean(row?.confirmed_at);
  const [remaining] = enabled
    ? await db.select({ value: count() }).from(userTwoStepRecoveryCodes)
      .where(and(eq(userTwoStepRecoveryCodes.user_id, userId), isNull(userTwoStepRecoveryCodes.used_at)))
    : [{ value: 0 }];
  return { enabled, confirmed_at: row?.confirmed_at ?? null, recovery_codes_remaining: remaining?.value ?? 0 };
}

/** True when this person may not turn two-step verification off. */
export async function twoStepIsMandatoryFor(userId: string): Promise<boolean> {
  if (!isHostedMode()) return false;
  const [privileged] = await db.select({ id: orgMembers.id }).from(orgMembers)
    .where(and(eq(orgMembers.user_id, userId), eq(orgMembers.is_active, true), inArray(orgMembers.role, ['owner', 'admin'])))
    .limit(1);
  return Boolean(privileged);
}

export type EnrolmentStart =
  | { ok: true; secret: string; otpauth_url: string }
  | { ok: false; check: Exclude<SecondStepCheck, { ok: true }> | { ok: false; reason: 'proof_required' } };

/**
 * Starts (or restarts) enrolment: stores a new pending secret and returns it
 * once. A person who is already enrolled must prove the current second step
 * (a code or a recovery code) to replace their authenticator.
 */
export async function startTwoStepEnrolment(user: { id: string; email: string }, proof: SecondStepProof = {}, now = new Date()): Promise<EnrolmentStart> {
  return db.transaction(async (tx) => {
    await tx.insert(userTwoStep).values({ user_id: user.id }).onConflictDoNothing();
    const [row] = await tx.select({ confirmed_at: userTwoStep.confirmed_at }).from(userTwoStep).where(eq(userTwoStep.user_id, user.id)).for('update');
    if (row?.confirmed_at) {
      if (!proof.code && !proof.recoveryCode) return { ok: false as const, check: { ok: false as const, reason: 'proof_required' as const } };
      const check = await checkSecondStep(tx, user.id, proof, { secret: 'confirmed', allowRecoveryCode: true, now });
      if (!check.ok) return { ok: false as const, check };
    }
    const secret = generateTwoStepSecret();
    await tx.update(userTwoStep)
      .set({ pending_secret_encrypted: encrypt(secret), pending_created_at: now })
      .where(eq(userTwoStep.user_id, user.id));
    return { ok: true as const, secret, otpauth_url: buildOtpauthUrl({ secret, account: user.email, issuer: ISSUER }) };
  });
}

export type EnrolmentConfirm =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; check: Exclude<SecondStepCheck, { ok: true }> };

/**
 * Confirms enrolment with a code from the new authenticator. In one
 * transaction it activates the secret, replaces the recovery codes, ends
 * every existing session and kills every outstanding challenge, so no session
 * issued without a code survives. The caller then issues a fresh session.
 */
export async function confirmTwoStepEnrolment(userId: string, code: string, now = new Date()): Promise<EnrolmentConfirm> {
  const result = await db.transaction(async (tx) => {
    // Same row session creation locks: enrolment and issuance are serialized.
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    if (!user) return { ok: false as const, check: { ok: false as const, reason: 'not_enrolled' as const } };
    const check = await checkSecondStep(tx, userId, { code }, { secret: 'pending', allowRecoveryCode: false, now });
    if (!check.ok) return { ok: false as const, check };
    await tx.update(userTwoStep).set({
      secret_encrypted: sql`${userTwoStep.pending_secret_encrypted}`,
      pending_secret_encrypted: null,
      pending_created_at: null,
      confirmed_at: sql`clock_timestamp()`,
      last_used_step: check.step ?? 0,
      failed_attempts: 0,
      locked_until: null,
    }).where(eq(userTwoStep.user_id, userId));
    const recoveryCodes = await replaceRecoveryCodes(tx, userId);
    const revoked = await revokeAllSessions(tx, userId);
    await tx.update(twoStepChallenges).set({ consumed_at: now })
      .where(and(eq(twoStepChallenges.user_id, userId), isNull(twoStepChallenges.consumed_at)));
    return { ok: true as const, recoveryCodes, revoked };
  });
  if (!result.ok) return result;
  emitWebSessionRevocations(result.revoked);
  return { ok: true, recoveryCodes: result.recoveryCodes };
}

export type CodeGatedResult<T> = ({ ok: true } & T) | { ok: false; check: Exclude<SecondStepCheck, { ok: true }> };

/** New recovery codes; the old ones stop working. Needs a current code. */
export async function regenerateRecoveryCodes(userId: string, code: string, now = new Date()): Promise<CodeGatedResult<{ recoveryCodes: string[] }>> {
  return db.transaction(async (tx) => {
    const check = await checkSecondStep(tx, userId, { code }, { secret: 'confirmed', allowRecoveryCode: false, now });
    if (!check.ok) return { ok: false as const, check };
    return { ok: true as const, recoveryCodes: await replaceRecoveryCodes(tx, userId) };
  });
}

/** Turns two-step verification off. Needs a current code. The caller refuses
 * this for owners and admins in hosted mode (twoStepIsMandatoryFor). */
export async function disableTwoStep(userId: string, code: string, now = new Date()): Promise<CodeGatedResult<object>> {
  return db.transaction(async (tx) => {
    const check = await checkSecondStep(tx, userId, { code }, { secret: 'confirmed', allowRecoveryCode: false, now });
    if (!check.ok) return { ok: false as const, check };
    await tx.update(userTwoStep).set({
      secret_encrypted: null, confirmed_at: null, pending_secret_encrypted: null, pending_created_at: null,
      last_used_step: 0, failed_attempts: 0, locked_until: null,
    }).where(eq(userTwoStep.user_id, userId));
    await tx.delete(userTwoStepRecoveryCodes).where(eq(userTwoStepRecoveryCodes.user_id, userId));
    return { ok: true as const };
  });
}

// ── Challenges ───────────────────────────────────────────────────────────────

export type TwoStepChallenge = { token: string; expires_at: string };

/** Issues the single-purpose token a correct password earns instead of a session. */
export async function createTwoStepChallenge(input: { userId: string; orgId: string; kind: 'verify' | 'enrol'; passwordVersion: number }, now = new Date()): Promise<TwoStepChallenge> {
  const token = generateTwoStepToken();
  const expiresAt = new Date(now.getTime() + (input.kind === 'verify' ? VERIFY_CHALLENGE_TTL_MS : ENROL_CHALLENGE_TTL_MS));
  await db.insert(twoStepChallenges).values({
    user_id: input.userId, org_id: input.orgId, kind: input.kind,
    token_hash: hashTwoStepToken(token), password_version: input.passwordVersion, expires_at: expiresAt,
  });
  return { token, expires_at: expiresAt.toISOString() };
}

type LiveChallenge = { id: string; user_id: string; org_id: string; email: string; failed_attempts: number };

/** The challenge, locked, if it is live: right kind, unused, unexpired, the
 * password unchanged since it was issued, and the membership still active. */
async function lockLiveChallenge(tx: Tx, token: string, kind: 'verify' | 'enrol', now: Date): Promise<LiveChallenge | null> {
  const [challenge] = await tx.select().from(twoStepChallenges).where(eq(twoStepChallenges.token_hash, hashTwoStepToken(token))).for('update');
  if (!challenge || challenge.kind !== kind || challenge.consumed_at || challenge.expires_at.getTime() <= now.getTime()) return null;
  const [user] = await tx.select({ email: users.email, password_version: users.password_version }).from(users).where(eq(users.id, challenge.user_id)).limit(1);
  if (!user?.email || user.password_version !== challenge.password_version) return null;
  const [membership] = await tx.select({ id: orgMembers.id }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, challenge.org_id), eq(orgMembers.user_id, challenge.user_id), eq(orgMembers.is_active, true))).limit(1);
  if (!membership) return null;
  return { id: challenge.id, user_id: challenge.user_id, org_id: challenge.org_id, email: user.email, failed_attempts: challenge.failed_attempts };
}

export type ChallengeIdentity = { id: string; email: string; org_id: string };
export type ChallengeExchange =
  | { ok: true; identity: ChallengeIdentity; method: 'code' | 'recovery_code' }
  | { ok: false; reason: 'challenge_invalid' | 'invalid' | 'challenge_dead' }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number };

/**
 * Checks a login challenge plus a code (or recovery code). On success the
 * challenge is used up; a recovery code also ends every session the person
 * has. After CHALLENGE_MAX_FAILURES wrong codes the challenge is dead and a
 * new login is needed. The caller creates the session.
 */
export async function exchangeVerifyChallenge(token: string, proof: SecondStepProof, now = new Date()): Promise<ChallengeExchange> {
  const result = await db.transaction(async (tx) => {
    const challenge = await lockLiveChallenge(tx, token, 'verify', now);
    if (!challenge) return { ok: false as const, reason: 'challenge_invalid' as const };
    const check = await checkSecondStep(tx, challenge.user_id, proof, { secret: 'confirmed', allowRecoveryCode: true, now });
    if (check.ok) {
      await tx.update(twoStepChallenges).set({ consumed_at: now }).where(eq(twoStepChallenges.id, challenge.id));
      const revoked = check.method === 'recovery_code' ? await revokeAllSessions(tx, challenge.user_id) : [];
      return { ok: true as const, identity: { id: challenge.user_id, email: challenge.email, org_id: challenge.org_id }, method: check.method, revoked };
    }
    if (check.reason === 'locked') return check;
    if (check.reason === 'not_enrolled') {
      await tx.update(twoStepChallenges).set({ consumed_at: now }).where(eq(twoStepChallenges.id, challenge.id));
      return { ok: false as const, reason: 'challenge_invalid' as const };
    }
    const failures = challenge.failed_attempts + 1;
    const dead = failures >= CHALLENGE_MAX_FAILURES;
    await tx.update(twoStepChallenges)
      .set({ failed_attempts: failures, ...(dead ? { consumed_at: now } : {}) })
      .where(eq(twoStepChallenges.id, challenge.id));
    return { ok: false as const, reason: dead ? 'challenge_dead' as const : 'invalid' as const };
  });
  if (result.ok) {
    emitWebSessionRevocations(result.revoked);
    return { ok: true, identity: result.identity, method: result.method };
  }
  return result;
}

/** Who an enrol-only token belongs to, or null. It is not used up here: the
 * person needs it for both enrolment calls. Confirming enrolment kills it. */
export async function resolveEnrolChallenge(token: string, now = new Date()): Promise<ChallengeIdentity | null> {
  return db.transaction(async (tx) => {
    const challenge = await lockLiveChallenge(tx, token, 'enrol', now);
    return challenge ? { id: challenge.user_id, email: challenge.email, org_id: challenge.org_id } : null;
  });
}
