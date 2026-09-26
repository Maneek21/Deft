import { and, eq, sql } from 'drizzle-orm';
import { users, webSessions } from '@deft/db/schema';
import type { db } from './db.js';
import { verifyWebAccess } from './web-sessions.js';
import { humanModuleActor } from './module-service.js';
import { AppError } from './app-errors.js';
import { appRuntimeChannelEnabled } from './app-runtime-channel.js';
import { isAppNativeCalendarEnabled } from './env.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PublicManagementGuard = (tx: Tx, target?: 'runtime' | 'native', nativeParticipants?: readonly string[]) => Promise<void>;
const denied = () => new AppError('Public endpoint management access denied', 'APP_ACCESS_DENIED', 403);

/** Retain the exact initiating web identity. Service locks member and App first;
 * SID is last, matching logout/password revocation's member -> SID order. */
export async function publicWebAuthority(authorization: string | undefined,
  expected: Readonly<{ id: string; org_id: string; sid: string }>) {
  const token = /^Bearer ([^\s]+)$/.exec(authorization ?? '')?.[1];
  if (!token) throw denied();
  let user: Awaited<ReturnType<typeof verifyWebAccess>>;
  try { user = await verifyWebAccess(token); } catch { throw denied(); }
  if (user.id !== expected.id || user.org_id !== expected.org_id || user.sid !== expected.sid) throw denied();
  const actor = humanModuleActor({ orgId: user.org_id, userId: user.id, role: user.role, source: 'rest' });
  const guard: PublicManagementGuard = async (tx, target = 'runtime', nativeParticipants) => {
    const [session] = await tx.select().from(webSessions).where(and(eq(webSessions.id, user.sid),
      eq(webSessions.org_id, user.org_id), eq(webSessions.user_id, user.id))).limit(1).for('share');
    // Do not acquire a users lock after App/SID: password changes lock users
    // before membership. Read current identity after every SID wait instead.
    const [human] = await tx.select({ kind: users.kind, is_agent: users.is_agent }).from(users).where(eq(users.id, user.id));
    if (target === 'native' && nativeParticipants) {
      const { nativeParticipantsAreHuman } = await import('./app-native-authority.js');
      if (!nativeParticipants.length || !await nativeParticipantsAreHuman(tx, nativeParticipants)) {
        throw new AppError('Public endpoint authority changed', 'APP_STALE', 409);
      }
    }
    const result = await tx.execute(sql`SELECT clock_timestamp() AS now`);
    const now = new Date((result.rows[0] as { now: Date | string }).now).getTime();
    if (!(target === 'native' ? isAppNativeCalendarEnabled() : appRuntimeChannelEnabled())
      || !human || human.kind !== 'human' || human.is_agent
      || !Number.isFinite(now) || !session || session.revoked_at || session.expires_at.getTime() <= now || user.exp * 1000 <= now) throw denied();
  };
  return { actor, guard };
}
