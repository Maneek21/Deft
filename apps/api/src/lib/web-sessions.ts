import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { webSessions, users, revokedTokens, orgMembers } from '@deft/db/schema';
import { db } from './db.js';
import { env } from './env.js';
import { OrgMembershipError, requireActiveOrgMembership } from './org-membership.js';

const claimsSchema = z.object({
  id: z.string().min(1).max(256), email: z.string(), org_id: z.string().min(1).max(256),
  sid: z.string().uuid(), jti: z.string().uuid(),
  purpose: z.enum(['web-access', 'web-refresh']), exp: z.number(),
});
type Identity = { id: string; email: string; org_id: string };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export const webSessionEvents = new EventEmitter();
export class WebCredentialsChangedError extends Error {}

export function emitWebSessionRevocations(sessionIds: readonly string[]) {
  for (const sessionId of sessionIds) webSessionEvents.emit('revoked', sessionId);
}

function claims(token: string, purpose: 'web-access' | 'web-refresh') {
  const value = claimsSchema.parse(jwt.verify(token, purpose === 'web-access' ? env.JWT_SECRET : env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] }));
  if (value.purpose !== purpose) throw new Error('Invalid token purpose');
  return value;
}

function tokens(identity: Identity, sid: string, expiresAt: Date) {
  const remaining = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  if (remaining <= 0) throw new Error('Session expired');
  return {
    accessToken: jwt.sign({ ...identity, sid, jti: randomUUID(), purpose: 'web-access' }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: Math.min(900, remaining) }),
    refreshToken: jwt.sign({ ...identity, sid, jti: randomUUID(), purpose: 'web-refresh' }, env.JWT_REFRESH_SECRET, { algorithm: 'HS256', expiresIn: remaining }),
  };
}

export async function createWebSession(identity: Identity, expectedPasswordHash?: string) {
  const sid = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 86400_000);
  const pair = tokens(identity, sid, expiresAt);
  await db.transaction(async (tx) => {
    // Serialize issuance with password reset/change so an old-password login
    // cannot create a family after that change has revoked earlier families.
    const [user] = await tx.select().from(users).where(eq(users.id, identity.id)).for('share');
    if (!user || (expectedPasswordHash !== undefined && user.password_hash !== expectedPasswordHash)) throw new WebCredentialsChangedError('Credentials changed; sign in again');
    const [membership] = await tx.select({ id: orgMembers.id }).from(orgMembers).where(and(eq(orgMembers.org_id, identity.org_id), eq(orgMembers.user_id, identity.id), eq(orgMembers.is_active, true))).for('share');
    if (!membership) throw new OrgMembershipError('User is not an active member of this organization');
    await tx.insert(webSessions).values({ id: sid, user_id: identity.id, org_id: identity.org_id, refresh_token_hash: hash(pair.refreshToken), expires_at: expiresAt });
  });
  return pair;
}

export async function verifyWebAccess(token: string) {
  const payload = claims(token, 'web-access');
  const [session] = await db.select().from(webSessions).where(and(eq(webSessions.id, payload.sid), eq(webSessions.user_id, payload.id), eq(webSessions.org_id, payload.org_id))).limit(1);
  if (!session || session.revoked_at || session.expires_at.getTime() <= Date.now()) throw new Error('Session unavailable');
  const membership = await requireActiveOrgMembership(payload.org_id, payload.id);
  return { ...payload, role: membership.role };
}

export async function rotateWebSession(token: string) {
  const payload = claims(token, 'web-refresh');
  const result = await db.transaction(async (tx) => {
    const [session] = await tx.select().from(webSessions).where(and(eq(webSessions.id, payload.sid), eq(webSessions.user_id, payload.id), eq(webSessions.org_id, payload.org_id))).for('update');
    if (!session || session.revoked_at || session.expires_at.getTime() <= Date.now()) return null;
    if (session.refresh_token_hash !== hash(token)) {
      // Return rather than throw so revocation commits before the denial.
      await tx.update(webSessions).set({ revoked_at: new Date() }).where(eq(webSessions.id, session.id));
      return null;
    }
    await requireActiveOrgMembership(payload.org_id, payload.id);
    const pair = tokens({ id: payload.id, email: payload.email, org_id: payload.org_id }, session.id, session.expires_at);
    await tx.update(webSessions).set({ refresh_token_hash: hash(pair.refreshToken) }).where(eq(webSessions.id, session.id));
    return pair;
  });
  if (!result) {
    webSessionEvents.emit('revoked', payload.sid);
    throw new Error('Session revoked or refresh reused');
  }
  return result;
}

export async function revokeWebSession(token: string) {
  const payload = claims(token, 'web-refresh');
  await db.update(webSessions).set({ revoked_at: new Date() }).where(and(eq(webSessions.id, payload.sid), eq(webSessions.user_id, payload.id), eq(webSessions.org_id, payload.org_id), isNull(webSessions.revoked_at)));
  webSessionEvents.emit('revoked', payload.sid);
}

type PasswordChangeAuthority = { expectedPasswordHash: string } | { resetToken: string; passwordVersion: number; orgId: string };
export async function changeWebPassword(userId: string, passwordHash: string, authority: PasswordChangeAuthority) {
  const sessions = await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!user) throw new WebCredentialsChangedError('Credentials changed');
    if ('resetToken' in authority) {
      if (user.password_version !== authority.passwordVersion) throw new WebCredentialsChangedError('Reset link superseded');
      const [membership] = await tx.select({ id: orgMembers.id }).from(orgMembers).where(and(eq(orgMembers.org_id, authority.orgId), eq(orgMembers.user_id, userId), eq(orgMembers.is_active, true))).for('share');
      if (!membership) throw new OrgMembershipError('Reset membership is no longer active');
      const inserted = await tx.insert(revokedTokens).values({ token_hash: hash(authority.resetToken), user_id: userId }).onConflictDoNothing().returning({ id: revokedTokens.id });
      if (!inserted.length) throw new Error('Reset token already used');
    } else if (user.password_hash !== authority.expectedPasswordHash) {
      throw new WebCredentialsChangedError('Credentials changed');
    }
    await tx.update(users).set({ password_hash: passwordHash, password_version: user.password_version + 1 }).where(eq(users.id, userId));
    return tx.update(webSessions).set({ revoked_at: new Date() }).where(and(eq(webSessions.user_id, userId), isNull(webSessions.revoked_at))).returning({ id: webSessions.id });
  });
  emitWebSessionRevocations(sessions.map(session => session.id));
}

export async function revokeMemberWebSessions(orgId: string, userId: string) {
  const sessions = await db.update(webSessions).set({ revoked_at: new Date() }).where(and(eq(webSessions.org_id, orgId), eq(webSessions.user_id, userId), isNull(webSessions.revoked_at))).returning({ id: webSessions.id });
  emitWebSessionRevocations(sessions.map(session => session.id));
}
