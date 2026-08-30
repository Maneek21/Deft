import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { appDeveloperPairings, auditLog, orgMembers } from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { APP_DEVELOPER_PAIRING_ENABLED } from './env.js';

const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
const SESSION_LIFETIME_MS = 15 * 60 * 1000;
const TOKEN_PREFIX = 'deft_app_dev_';

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function manager(actor: ModuleActor): asserts actor is Extract<ModuleActor, { kind: 'human' }> {
  if (actor.kind !== 'human' || (actor.role !== 'owner' && actor.role !== 'admin')) {
    throw new AppError('Only workspace owners and admins can create developer pairings', 'APP_ACCESS_DENIED', 403);
  }
  if (!APP_DEVELOPER_PAIRING_ENABLED) {
    throw new AppError('App developer pairing is disabled', 'APP_FEATURE_DISABLED', 503);
  }
}

export async function createAppDeveloperPairing(actor: ModuleActor) {
  manager(actor);
  const code = randomBytes(9).toString('base64url').toUpperCase();
  const expiresAt = new Date(Date.now() + PAIRING_LIFETIME_MS);
  const row = await db.transaction(async (tx) => {
    const [membership] = await tx.select().from(orgMembers).where(and(
      eq(orgMembers.org_id, actor.org_id),
      eq(orgMembers.user_id, actor.actor_id),
      eq(orgMembers.is_active, true),
    )).limit(1).for('update');
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      throw new AppError('Only active workspace owners and admins can create developer pairings', 'APP_ACCESS_DENIED', 403);
    }
    const [pairing] = await tx.insert(appDeveloperPairings).values({
      org_id: actor.org_id,
      code_hash: digest(code),
      created_by_user_id: actor.actor_id,
      expires_at: expiresAt,
    }).returning();
    if (!pairing) throw new Error('Pairing insert returned no row');
    await tx.insert(auditLog).values({
      org_id: actor.org_id,
      actor_type: actor.kind,
      actor_id: actor.actor_id,
      action: 'app.developer_pairing.create',
      entity_type: 'app_developer_pairing',
      entity_id: pairing.id,
      after_state: { expires_at: expiresAt.toISOString(), audience: 'app-developer' },
      metadata: { source: actor.source },
    });
    return pairing;
  });
  return { pairing_id: row.id, code, expires_at: expiresAt.toISOString(), audience: 'app-developer' as const };
}

export async function exchangeAppDeveloperPairing(codeValue: string) {
  if (!APP_DEVELOPER_PAIRING_ENABLED) throw new AppError('App developer pairing is disabled', 'APP_FEATURE_DISABLED', 503);
  const code = codeValue.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{12}$/.test(code)) throw new AppError('Pairing code is invalid', 'APP_ACCESS_DENIED', 403);
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const now = new Date();
  const sessionExpiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
  const pairing = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(appDeveloperPairings).where(and(
      eq(appDeveloperPairings.code_hash, digest(code)),
      isNull(appDeveloperPairings.consumed_at),
      isNull(appDeveloperPairings.revoked_at),
      gt(appDeveloperPairings.expires_at, now),
    )).limit(1).for('update');
    if (!row) throw new AppError('Pairing code is invalid, expired, or already used', 'APP_ACCESS_DENIED', 403);
    const [updated] = await tx.update(appDeveloperPairings).set({
      consumed_at: now,
      session_token_hash: digest(token),
      session_expires_at: sessionExpiresAt,
    }).where(and(eq(appDeveloperPairings.id, row.id), isNull(appDeveloperPairings.consumed_at))).returning();
    if (!updated) throw new AppError('Pairing code was already used', 'APP_ACCESS_DENIED', 403);
    await tx.insert(auditLog).values({
      org_id: updated.org_id,
      actor_type: 'app_developer',
      actor_id: updated.id,
      action: 'app.developer_pairing.exchange',
      entity_type: 'app_developer_pairing',
      entity_id: updated.id,
      after_state: { audience: 'app-developer', expires_at: sessionExpiresAt.toISOString() },
    });
    return updated;
  });
  return { token, expires_at: sessionExpiresAt.toISOString(), audience: 'app-developer' as const, pairing_id: pairing.id };
}

export async function claimAppDeveloperSession(token: string): Promise<Extract<ModuleActor, { kind: 'human' }>> {
  if (!APP_DEVELOPER_PAIRING_ENABLED || !token.startsWith(TOKEN_PREFIX)) {
    throw new AppError('Developer session is invalid', 'APP_ACCESS_DENIED', 403);
  }
  const now = new Date();
  return db.transaction(async (tx) => {
    const [pairing] = await tx.select().from(appDeveloperPairings).where(and(
      eq(appDeveloperPairings.session_token_hash, digest(token)),
      isNull(appDeveloperPairings.revoked_at),
      isNull(appDeveloperPairings.install_used_at),
      gt(appDeveloperPairings.session_expires_at, now),
    )).limit(1).for('update');
    if (!pairing) throw new AppError('Developer session is invalid, expired, revoked, or already used', 'APP_ACCESS_DENIED', 403);
    const [membership] = await tx.select().from(orgMembers).where(and(
      eq(orgMembers.org_id, pairing.org_id),
      eq(orgMembers.user_id, pairing.created_by_user_id),
      eq(orgMembers.is_active, true),
    )).limit(1).for('update');
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      throw new AppError('The pairing owner is no longer an active manager', 'APP_ACCESS_DENIED', 403);
    }
    const [claimed] = await tx.update(appDeveloperPairings).set({ install_used_at: now }).where(and(
      eq(appDeveloperPairings.id, pairing.id), isNull(appDeveloperPairings.install_used_at),
    )).returning();
    if (!claimed) throw new AppError('Developer session was already used', 'APP_ACCESS_DENIED', 403);
    await tx.insert(auditLog).values({
      org_id: pairing.org_id,
      actor_type: 'app_developer',
      actor_id: pairing.id,
      action: 'app.developer_session.claim',
      entity_type: 'app_developer_pairing',
      entity_id: pairing.id,
      after_state: { audience: 'app-developer', single_use: true },
    });
    return {
      kind: 'human',
      org_id: pairing.org_id,
      actor_id: pairing.created_by_user_id,
      role: membership.role as 'owner' | 'admin',
      source: 'rest',
      scopes: [],
    };
  });
}

export async function revokeAppDeveloperPairing(actor: ModuleActor, pairingId: string): Promise<void> {
  manager(actor);
  const [revoked] = await db.update(appDeveloperPairings).set({ revoked_at: new Date() }).where(and(
    eq(appDeveloperPairings.id, pairingId), eq(appDeveloperPairings.org_id, actor.org_id), isNull(appDeveloperPairings.revoked_at),
  )).returning({ id: appDeveloperPairings.id });
  if (!revoked) throw new AppError('Developer pairing not found', 'APP_NOT_FOUND', 404);
}
