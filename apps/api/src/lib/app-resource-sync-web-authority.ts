import { and, eq, sql } from 'drizzle-orm';
import { webSessions, orgMembers, users } from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { verifyWebAccess } from './web-sessions.js';
import { humanModuleActor } from './module-service.js';
import { AppError } from './app-errors.js';
import type { ResourceSyncManagementGuard } from './app-resource-sync-management.js';

export class ResourceSyncWebAuthenticationError extends Error {
  readonly code = 'APP_ACCESS_DENIED';
  readonly status = 401;
}

/** Only the exact web-access bearer purpose is accepted; context-injected human,
 * Employee, personal MCP, app developer and Runtime identities confer no authority. */
export async function resourceSyncWebAuthority(authorization: string | undefined,
  expectedSession?: Readonly<{ org_id: string; user_id: string; sid: string }>) {
  const match = /^Bearer ([^\s]+)$/u.exec(authorization ?? '');
  if (!match) throw new ResourceSyncWebAuthenticationError('Web authentication required');
  let user: Awaited<ReturnType<typeof verifyWebAccess>>;
  try { user = await verifyWebAccess(match[1]!); }
  catch { throw new ResourceSyncWebAuthenticationError('Invalid or expired web session'); }
  if (expectedSession && (user.org_id !== expectedSession.org_id
    || user.id !== expectedSession.user_id || user.sid !== expectedSession.sid)) {
    throw new ResourceSyncWebAuthenticationError('Invalid or expired web session');
  }
  const [human] = await db.select({ kind: users.kind }).from(users).where(eq(users.id, user.id));
  if (human?.kind !== 'human') throw new AppError('Private resource sync access denied', 'APP_ACCESS_DENIED', 403);
  const actor = humanModuleActor({ orgId: user.org_id, userId: user.id,
    role: user.role, source: 'rest' });
  const guard: ResourceSyncManagementGuard = async (tx) => {
    // Service locks run member -> App -> registration -> binding -> runtime session.
    // Web session comes last, as in password/membership revocation. Do not take a
    // users lock here: password changes hold users before membership and session.
    await tx.execute(sql`SELECT id FROM org_members WHERE org_id = ${user.org_id}
      AND user_id = ${user.id} FOR SHARE`);
    const [member] = await tx.select({ role: orgMembers.role, active: orgMembers.is_active })
      .from(orgMembers).where(and(eq(orgMembers.org_id, user.org_id), eq(orgMembers.user_id, user.id)));
    if (!member?.active || member.role !== user.role || member.role === 'guest') {
      throw new AppError('Private resource sync access denied', 'APP_ACCESS_DENIED', 403);
    }
    const [session] = await tx.select({ expires_at: webSessions.expires_at,
      revoked_at: webSessions.revoked_at }).from(webSessions).where(and(
      eq(webSessions.id, user.sid), eq(webSessions.user_id, user.id),
      eq(webSessions.org_id, user.org_id))).for('share');
    // Recheck stored identity after any SID wait, without adding the reverse
    // users lock edge against password reset's users -> member -> SID order.
    const [currentHuman] = await tx.select({ kind: users.kind }).from(users).where(eq(users.id, user.id));
    if (currentHuman?.kind !== 'human') throw new AppError('Private resource sync access denied', 'APP_ACCESS_DENIED', 403);
    const now = Date.now();
    if (!session || session.revoked_at || session.expires_at.getTime() <= now || user.exp * 1000 <= now) {
      throw new ResourceSyncWebAuthenticationError('Invalid or expired web session');
    }
  };
  return { actor, guard, web_session: { sid: user.sid, expires_at: user.exp * 1000 } };
}

export function assertResourceSyncManager(actor: ModuleActor) {
  if (actor.kind !== 'human' || !['owner', 'admin'].includes(actor.role)
    || !['rest', 'ui'].includes(actor.source)) {
    throw new AppError('Private resource sync access denied', 'APP_ACCESS_DENIED', 403);
  }
}
