import bcrypt from 'bcryptjs';
import { and, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { notifications, orgMembers, users, webSessions } from '@deft/db/schema';
import { twoStepChallenges, userTwoStep, userTwoStepRecoveryCodes } from '@deft/db/two-step';
import { db } from './db.js';
import { decrypt, encrypt } from './encryption.js';
import { isHostedMode } from './hosted-mode.js';
import { emitWebSessionRevocations } from './web-sessions.js';
import { notificationChannelForType } from './notification-policy.js';
import { syncNotificationToAttention } from './attention.js';
import {
  buildOtpauthUrl,
  generateRecoveryCodes,
  generateTwoStepSecret,
  generateTwoStepToken,
  hashRecoveryCode,
  hashTwoStepToken,
  isRecoveryResetToken,
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
type AccountNoticeRow = typeof notifications.$inferSelect;
/** Notices written inside a transaction run by twoStepTransaction. */
const noticesIn = new WeakMap<object, AccountNoticeRow[]>();

/**
 * db.transaction for every path that checks a code. A notice written by
 * checkSecondStep or enrolment commits with the change it reports, so it is
 * never lost and never sent for a rolled-back attempt. After the commit, the
 * sessions the transaction ended (a result's `revoked`) are cut off first,
 * then the notices are copied into the attention feed, best effort, like
 * every other notification, so an ended session never receives them.
 */
async function twoStepTransaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  const written: AccountNoticeRow[] = [];
  const result = await db.transaction(async (tx) => {
    noticesIn.set(tx, written);
    return run(tx);
  });
  const revoked = (result as { revoked?: unknown } | null)?.revoked;
  if (Array.isArray(revoked)) emitWebSessionRevocations(revoked as string[]);
  for (const notice of written) {
    await syncNotificationToAttention(notice).catch(() => console.warn('[two-step] notice attention copy failed'));
  }
  return result;
}

/** At most one lock notice per account in this time. */
export const LOCK_NOTICE_INTERVAL_MS = 24 * 60 * 60_000;

type AccountNotice = { kind: string; title: string; body: string; onceWithinMs?: number };

/**
 * Wrong codes locked the account (check 15.8). Every wrong code that meets a
 * lock asks for it, and it is written unless one was written in the last
 * day, so someone guessing cannot flood the person, and a notice whose write
 * failed is written on the next wrong code.
 */
const LOCK_NOTICE: AccountNotice = {
  kind: 'two_step_locked',
  title: 'Wrong sign-in codes on your account',
  body: 'Several wrong two-step or recovery codes were entered for your account, so codes are refused for a while. '
    + 'If this was not you, change your password.',
  onceWithinMs: LOCK_NOTICE_INTERVAL_MS,
};

/** A recovery code was spent (check 15.1). Each needs a valid unused code,
 * so there are never more than the person has codes. */
const RECOVERY_CODE_USED_NOTICE: AccountNotice = {
  kind: 'two_step_recovery_code_used',
  title: 'A recovery code was used on your account',
  body: 'A recovery code was used on your account, and every other session was signed out. '
    + 'Until a new authenticator is set up, your current one still works. '
    + 'If this was not you, change your password and replace your recovery codes.',
};

/** The second step was set up again after a recovery-code sign-in (check 15.1). */
const RECOVERY_RESET_NOTICE: AccountNotice = {
  kind: 'two_step_reset',
  title: 'Two-step verification was reset',
  body: 'A recovery code was used to sign in to your account, and two-step verification was set up again on a new authenticator. '
    + 'The old authenticator and the old recovery codes no longer work, and every other session was signed out.',
};

/**
 * Takes the account row before any two-step row, the order enrolment
 * confirmation and membership changes take them in. A lock notice's
 * foreign key needs the account row, so without this a code check holding
 * the two-step row could deadlock with enrolment confirmation.
 */
async function lockAccountRow(tx: Tx, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('key share');
}

/**
 * Tells the account holder, in each workspace they belong to, about a change
 * to their second step. A notice says nothing about the attempt (no address,
 * time, count or which code was tried), and it is shown only to the account
 * holder, never in a response to the caller. Delivered whatever the person's
 * notification preferences. Written in a savepoint: if writing it fails, the
 * code check and its answer are unchanged. The caller holds the account row
 * (see lockAccountRow).
 */
async function writeTwoStepNotice(tx: Tx, userId: string, now: Date, notice: AccountNotice): Promise<void> {
  try {
    const rows = await tx.transaction(async (savepoint) => {
      if (notice.onceWithinMs !== undefined) {
        const [recent] = await savepoint.select({ id: notifications.id }).from(notifications).where(and(
          eq(notifications.user_id, userId),
          sql`${notifications.metadata}->>'kind' = ${notice.kind}`,
          sql`${notifications.created_at} > ${new Date(now.getTime() - notice.onceWithinMs)}`,
        )).limit(1);
        if (recent) return [];
      }
      const memberships = await savepoint.select({ org_id: orgMembers.org_id }).from(orgMembers)
        .where(and(eq(orgMembers.user_id, userId), eq(orgMembers.is_active, true)));
      if (memberships.length === 0) return [];
      return savepoint.insert(notifications).values(memberships.map(({ org_id }) => ({
        org_id,
        user_id: userId,
        type: 'system' as const,
        title: notice.title,
        body: notice.body,
        link: '/settings/profile',
        metadata: {
          kind: notice.kind,
          delivery_policy: { status: 'delivered', reason: 'allowed', channel: notificationChannelForType('system'), evaluated_at: now.toISOString() },
        },
      }))).returning();
    });
    noticesIn.get(tx)?.push(...rows);
  } catch {
    if (notice === LOCK_NOTICE) console.warn('[two-step] lock notice failed');
    else console.warn('[two-step] account notice failed');
  }
}

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
        await writeTwoStepNotice(tx, userId, now, RECOVERY_CODE_USED_NOTICE);
        return { ok: true, method: 'recovery_code' };
      }
    }
  }

  const failedAttempts = row.failed_attempts + 1;
  const delay = twoStepLockDelayMs(failedAttempts);
  await tx.update(userTwoStep)
    .set({ failed_attempts: failedAttempts, locked_until: delay > 0 ? new Date(now.getTime() + delay) : null })
    .where(eq(userTwoStep.user_id, userId));
  // A wrong code that meets a lock: the person is told (at most once a day).
  if (delay > 0) await writeTwoStepNotice(tx, userId, now, LOCK_NOTICE);
  return { ok: false, reason: 'invalid' };
}

async function replaceRecoveryCodes(tx: Tx, userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await tx.delete(userTwoStepRecoveryCodes).where(eq(userTwoStepRecoveryCodes.user_id, userId));
  await tx.insert(userTwoStepRecoveryCodes).values(codes.map((code) => ({ user_id: userId, code_hash: hashRecoveryCode(code)! })));
  return codes;
}

async function revokeAllSessions(tx: Tx, userId: string, keepSessionId: string | null = null): Promise<string[]> {
  const sessions = await tx.update(webSessions)
    .set({ revoked_at: new Date() })
    .where(and(eq(webSessions.user_id, userId), isNull(webSessions.revoked_at), keepSessionId ? ne(webSessions.id, keepSessionId) : undefined))
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
export async function twoStepIsMandatoryFor(userId: string, reader: Pick<Tx, 'select'> = db): Promise<boolean> {
  if (!isHostedMode()) return false;
  const [privileged] = await reader.select({ id: orgMembers.id }).from(orgMembers)
    .where(and(eq(orgMembers.user_id, userId), eq(orgMembers.is_active, true), inArray(orgMembers.role, ['owner', 'admin'])))
    .limit(1);
  return Boolean(privileged);
}

export type EnrolmentStart =
  | { ok: true; secret: string; otpauth_url: string }
  | { ok: false; check: Exclude<SecondStepCheck, { ok: true }> | { ok: false; reason: 'proof_required' } | { ok: false; reason: 'password_required' } }
  | { ok: false; reason: 'authority_lost' };

/** Rolls back the enrolment start's row insert when the password is refused. */
class PasswordRequired extends Error {}

/** What the caller offers to start enrolment. */
export type EnrolmentProof = SecondStepProof & {
  /** The account password, typed again now. */
  currentPassword?: string | undefined;
  /** The caller holds an enrol-only token, earned with the password a moment ago. */
  passwordProven?: boolean;
  /** The caller's enrol-only token, when a recovery-code sign-in earned it:
   * that sign-in already proved the second step (and ended every other
   * session), so it stands in for a current code. Checked again here. */
  recoveryResetToken?: string | undefined;
};

/**
 * Starts (or restarts) enrolment: stores a new pending secret and returns it
 * once. The proof required is decided here, from the state read under the
 * row lock (never from an earlier read by the caller):
 *   - already enrolled: a current code or a recovery code (replacing the
 *     authenticator), or the live enrol-only token a recovery-code sign-in
 *     earned (check 15.1: that sign-in may only set up a new authenticator);
 *   - not enrolled: the password, typed now or proven by an enrol-only token.
 * A stolen access token alone must not be enough to put someone else's
 * authenticator on an account, whichever way a concurrent turn-off lands.
 */
export async function startTwoStepEnrolment(user: { id: string; email: string; sid: string | null }, proof: EnrolmentProof = {}, now = new Date()): Promise<EnrolmentStart> {
  const result = await twoStepTransaction(async (tx) => {
    // The token before the two-step row: the order confirmation takes them in.
    if (proof.recoveryResetToken !== undefined) {
      const reset = await lockLiveChallenge(tx, proof.recoveryResetToken, 'enrol', now);
      if (reset?.user_id !== user.id || !reset.recovery_reset) return { ok: false as const, reason: 'authority_lost' as const };
    }
    await lockAccountRow(tx, user.id);
    await tx.insert(userTwoStep).values({ user_id: user.id }).onConflictDoNothing();
    const [row] = await tx.select({ confirmed_at: userTwoStep.confirmed_at }).from(userTwoStep).where(eq(userTwoStep.user_id, user.id)).for('update');
    let revoked: string[] = [];
    if (!row?.confirmed_at && !proof.passwordProven) {
      const [account] = await tx.select({ password_hash: users.password_hash }).from(users).where(eq(users.id, user.id)).limit(1);
      if (!proof.currentPassword || !account?.password_hash || !(await bcrypt.compare(proof.currentPassword, account.password_hash))) {
        throw new PasswordRequired();
      }
    }
    if (row?.confirmed_at && proof.recoveryResetToken === undefined) {
      if (!proof.code && !proof.recoveryCode) return { ok: false as const, check: { ok: false as const, reason: 'proof_required' as const } };
      const check = await checkSecondStep(tx, user.id, proof, { secret: 'confirmed', allowRecoveryCode: true, now });
      if (!check.ok) return { ok: false as const, check };
      // Using a recovery code ends every other session, even if the
      // replacement is never confirmed. The caller's own session continues.
      if (check.method === 'recovery_code') revoked = await revokeAllSessions(tx, user.id, user.sid);
    }
    const secret = generateTwoStepSecret();
    await tx.update(userTwoStep)
      .set({ pending_secret_encrypted: encrypt(secret), pending_created_at: now })
      .where(eq(userTwoStep.user_id, user.id));
    return { ok: true as const, secret, otpauth_url: buildOtpauthUrl({ secret, account: user.email, issuer: ISSUER }), revoked };
  }).catch((err: unknown) => {
    if (err instanceof PasswordRequired) return { ok: false as const, check: { ok: false as const, reason: 'password_required' as const } };
    throw err;
  });
  if (!result.ok) return result;
  return { ok: true, secret: result.secret, otpauth_url: result.otpauth_url };
}

export type EnrolmentConfirm =
  | { ok: true; recoveryCodes: string[]; credentials: VerifiedCredentials; keptSession: boolean }
  | { ok: false; check: Exclude<SecondStepCheck, { ok: true }> }
  | { ok: false; reason: 'authority_lost' };

/** What a session issued right after a second step is bound to: it is
 * refused if the password or the authenticator changed in between. */
export type VerifiedCredentials = { passwordVersion: number; confirmedAt: Date };
/** How the caller of an enrolment call is signed in. */
export type EnrolAuthority = { sid: string } | { challengeToken: string };

/**
 * Confirms enrolment with a code from the new authenticator. In one
 * transaction it activates the secret, replaces the recovery codes, ends
 * every existing session and kills every outstanding challenge, so no session
 * issued without a code survives. The caller then issues a fresh session.
 * Finishing the setup a recovery-code sign-in asked for also tells the account
 * holder the second step was reset (check 15.1).
 */
export async function confirmTwoStepEnrolment(userId: string, code: string, authority: EnrolAuthority, now = new Date()): Promise<EnrolmentConfirm> {
  const result = await twoStepTransaction(async (tx) => {
    let afterRecoveryCode = false;
    // Same row session creation and password changes lock: enrolment,
    // issuance and a password reset are serialized.
    const [user] = await tx.select({ id: users.id, password_version: users.password_version }).from(users).where(eq(users.id, userId)).for('update');
    if (!user) return { ok: false as const, check: { ok: false as const, reason: 'not_enrolled' as const } };
    // The caller was authenticated before this lock: check they still are.
    if ('sid' in authority) {
      const [session] = await tx.select({ revoked_at: webSessions.revoked_at, expires_at: webSessions.expires_at }).from(webSessions)
        .where(and(eq(webSessions.id, authority.sid), eq(webSessions.user_id, userId))).limit(1);
      if (!session || session.revoked_at || session.expires_at.getTime() <= now.getTime()) return { ok: false as const, reason: 'authority_lost' as const };
    } else {
      const challenge = await lockLiveChallenge(tx, authority.challengeToken, 'enrol', now);
      if (challenge?.user_id !== userId) return { ok: false as const, reason: 'authority_lost' as const };
      afterRecoveryCode = challenge.recovery_reset;
    }
    const check = await checkSecondStep(tx, userId, { code }, { secret: 'pending', allowRecoveryCode: false, now });
    if (!check.ok) return { ok: false as const, check };
    const [confirmed] = await tx.update(userTwoStep).set({
      secret_encrypted: sql`${userTwoStep.pending_secret_encrypted}`,
      pending_secret_encrypted: null,
      pending_created_at: null,
      confirmed_at: sql`clock_timestamp()`,
      last_used_step: check.step ?? 0,
      failed_attempts: 0,
      locked_until: null,
    }).where(eq(userTwoStep.user_id, userId)).returning({ confirmed_at: userTwoStep.confirmed_at });
    const recoveryCodes = await replaceRecoveryCodes(tx, userId);
    // Every other session ends. The caller's own session, which has just
    // shown a code (and the password, or the current second step), continues
    // as a session issued now: other tabs using it see no sign-out while this
    // tab shows the recovery codes. An enrol-only caller has no session; the
    // route issues one.
    const keptSid = 'sid' in authority ? authority.sid : null;
    const revoked = await revokeAllSessions(tx, userId, keptSid);
    if (keptSid) await tx.update(webSessions).set({ created_at: sql`clock_timestamp()` }).where(eq(webSessions.id, keptSid));
    await tx.update(twoStepChallenges).set({ consumed_at: now })
      .where(and(eq(twoStepChallenges.user_id, userId), isNull(twoStepChallenges.consumed_at)));
    if (afterRecoveryCode) await writeTwoStepNotice(tx, userId, now, RECOVERY_RESET_NOTICE);
    const credentials = { passwordVersion: user.password_version, confirmedAt: confirmed!.confirmed_at! };
    return { ok: true as const, recoveryCodes, revoked, credentials, keptSession: keptSid !== null };
  });
  if (!result.ok) return result;
  return { ok: true, recoveryCodes: result.recoveryCodes, credentials: result.credentials, keptSession: result.keptSession };
}

export type CodeGatedResult<T> = ({ ok: true } & T) | { ok: false; check: Exclude<SecondStepCheck, { ok: true }> };

/** New recovery codes; the old ones stop working. Needs a current code. */
export async function regenerateRecoveryCodes(userId: string, code: string, now = new Date()): Promise<CodeGatedResult<{ recoveryCodes: string[] }>> {
  return twoStepTransaction(async (tx) => {
    await lockAccountRow(tx, userId);
    const check = await checkSecondStep(tx, userId, { code }, { secret: 'confirmed', allowRecoveryCode: false, now });
    if (!check.ok) return { ok: false as const, check };
    return { ok: true as const, recoveryCodes: await replaceRecoveryCodes(tx, userId) };
  });
}

/** Turns two-step verification off. Needs a current code. Refused for owners
 * and admins in hosted mode (twoStepIsMandatoryFor), checked under the row
 * lock a promotion to admin also takes (routes/members.ts). */
export async function disableTwoStep(userId: string, code: string, now = new Date()): Promise<CodeGatedResult<object> | { ok: false; mandatory: true }> {
  return twoStepTransaction(async (tx) => {
    await lockAccountRow(tx, userId);
    await tx.select({ user_id: userTwoStep.user_id }).from(userTwoStep).where(eq(userTwoStep.user_id, userId)).for('update');
    if (await twoStepIsMandatoryFor(userId, tx)) return { ok: false as const, mandatory: true as const };
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

type ChallengeInput = { userId: string; orgId: string; kind: 'verify' | 'enrol'; passwordVersion: number };

async function insertTwoStepChallenge(executor: Pick<Tx, 'insert'>, input: ChallengeInput, now: Date, purpose: 'challenge' | 'recovery_reset' = 'challenge'): Promise<TwoStepChallenge> {
  const token = generateTwoStepToken(purpose);
  const expiresAt = new Date(now.getTime() + (input.kind === 'verify' ? VERIFY_CHALLENGE_TTL_MS : ENROL_CHALLENGE_TTL_MS));
  await executor.insert(twoStepChallenges).values({
    user_id: input.userId, org_id: input.orgId, kind: input.kind,
    token_hash: hashTwoStepToken(token), password_version: input.passwordVersion, expires_at: expiresAt,
  });
  return { token, expires_at: expiresAt.toISOString() };
}

/** Issues the single-purpose token a correct password earns instead of a session. */
export async function createTwoStepChallenge(input: ChallengeInput, now = new Date()): Promise<TwoStepChallenge> {
  return insertTwoStepChallenge(db, input, now);
}

type LiveChallenge = {
  id: string; user_id: string; org_id: string; email: string; failed_attempts: number; password_version: number;
  /** An enrol-only token earned with a recovery code (two-step.ts generateTwoStepToken). */
  recovery_reset: boolean;
};

/** The challenge, locked, if it is live: right kind, unused, unexpired, the
 * password unchanged since it was issued, and the membership still active. */
async function lockLiveChallenge(tx: Tx, token: string, kind: 'verify' | 'enrol', now: Date): Promise<LiveChallenge | null> {
  const tokenHash = hashTwoStepToken(token);
  const [owner] = await tx.select({ user_id: twoStepChallenges.user_id }).from(twoStepChallenges).where(eq(twoStepChallenges.token_hash, tokenHash)).limit(1);
  if (!owner) return null;
  // The account row first, then the challenge: the order enrolment
  // confirmation takes them in, so the two cannot deadlock.
  const [user] = await tx.select({ email: users.email, password_version: users.password_version }).from(users).where(eq(users.id, owner.user_id)).for('share');
  const [challenge] = await tx.select().from(twoStepChallenges).where(eq(twoStepChallenges.token_hash, tokenHash)).for('update');
  if (!challenge || challenge.kind !== kind || challenge.consumed_at || challenge.expires_at.getTime() <= now.getTime()) return null;
  if (!user?.email || user.password_version !== challenge.password_version) return null;
  const [membership] = await tx.select({ id: orgMembers.id }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, challenge.org_id), eq(orgMembers.user_id, challenge.user_id), eq(orgMembers.is_active, true))).limit(1);
  if (!membership) return null;
  return {
    id: challenge.id, user_id: challenge.user_id, org_id: challenge.org_id, email: user.email,
    failed_attempts: challenge.failed_attempts, password_version: challenge.password_version,
    // The stored hash covers the prefix, so the token that matched it is the one issued.
    recovery_reset: challenge.kind === 'enrol' && isRecoveryResetToken(token),
  };
}

export type ChallengeIdentity = { id: string; email: string; org_id: string };
export type ChallengeExchange =
  | { ok: true; identity: ChallengeIdentity; method: 'code'; credentials: VerifiedCredentials }
  | { ok: true; identity: ChallengeIdentity; method: 'recovery_code'; resetChallenge: TwoStepChallenge }
  | { ok: false; reason: 'challenge_invalid' | 'invalid' | 'challenge_dead' }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number };

/**
 * Checks a login challenge plus a code (or recovery code). On success the
 * challenge is used up. After CHALLENGE_MAX_FAILURES wrong codes the
 * challenge is dead and a new login is needed. After a code the caller
 * creates the session.
 *
 * A recovery code gives no session (check 15.1). It ends every session the
 * person has and earns only an enrol-only token that may set up a new
 * authenticator; confirming that replaces the old one and the recovery codes.
 * Until then nothing else changes: the old authenticator and the unused
 * recovery codes still sign in, under the same attempt limits.
 */
export async function exchangeVerifyChallenge(token: string, proof: SecondStepProof, now = new Date()): Promise<ChallengeExchange> {
  const result = await twoStepTransaction(async (tx) => {
    const challenge = await lockLiveChallenge(tx, token, 'verify', now);
    if (!challenge) return { ok: false as const, reason: 'challenge_invalid' as const };
    const check = await checkSecondStep(tx, challenge.user_id, proof, { secret: 'confirmed', allowRecoveryCode: true, now });
    if (check.ok) {
      await tx.update(twoStepChallenges).set({ consumed_at: now }).where(eq(twoStepChallenges.id, challenge.id));
      const identity = { id: challenge.user_id, email: challenge.email, org_id: challenge.org_id };
      if (check.method === 'recovery_code') {
        const revoked = await revokeAllSessions(tx, challenge.user_id);
        const resetChallenge = await insertTwoStepChallenge(tx, {
          userId: challenge.user_id, orgId: challenge.org_id, kind: 'enrol', passwordVersion: challenge.password_version,
        }, now, 'recovery_reset');
        return { ok: true as const, identity, method: check.method, revoked, resetChallenge };
      }
      const [row] = await tx.select({ confirmed_at: userTwoStep.confirmed_at }).from(userTwoStep).where(eq(userTwoStep.user_id, challenge.user_id)).limit(1);
      const credentials = { passwordVersion: challenge.password_version, confirmedAt: row!.confirmed_at! };
      return { ok: true as const, identity, method: check.method, revoked: [] as string[], credentials };
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
    if (result.method === 'recovery_code') return { ok: true, identity: result.identity, method: result.method, resetChallenge: result.resetChallenge };
    return { ok: true, identity: result.identity, method: result.method, credentials: result.credentials };
  }
  return result;
}

/** Who an enrol-only token belongs to, or null. It is not used up here: the
 * person needs it for both enrolment calls. Confirming enrolment kills it. */
export async function resolveEnrolChallenge(token: string, now = new Date()): Promise<(ChallengeIdentity & { recovery_reset: boolean }) | null> {
  return db.transaction(async (tx) => {
    const challenge = await lockLiveChallenge(tx, token, 'enrol', now);
    return challenge ? { id: challenge.user_id, email: challenge.email, org_id: challenge.org_id, recovery_reset: challenge.recovery_reset } : null;
  });
}
