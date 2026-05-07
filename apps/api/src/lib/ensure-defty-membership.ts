// Idempotent helper: ensures the Defty system agent user exists and has an
// org_members row for the given org. Callable from invite-acceptance,
// signup-finalization, and the @deft mention worker.
//
// Design: there is ONE Defty user row globally (keyed by email) that joins
// every org via org_members. Matches the existing pattern from agent-reply.ts
// where the user is keyed by email='deft-agent@system.local'. Phase 1 of
// agent-chat unification — see docs/superpowers/specs/2026-05-07-agent-chat-unification.md.

import { db } from './db.js';
import { users, orgMembers } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';

export const DEFTY_EMAIL = 'deft-agent@system.local';
export const DEFTY_NAME = 'Deft';

export async function ensureDeftyMembership(orgId: string): Promise<string> {
  // 1. Find or create the Defty user. If it already exists (created by the
  //    legacy ensureAgentUser which didn't set kind/is_agent), patch it so
  //    the canonical fields are always present.
  let [user] = await db.select({ id: users.id, kind: users.kind, is_agent: users.is_agent })
    .from(users)
    .where(eq(users.email, DEFTY_EMAIL))
    .limit(1);

  if (!user) {
    [user] = await db.insert(users).values({
      email: DEFTY_EMAIL,
      name: DEFTY_NAME,
      kind: 'agent',
      is_agent: true,
      email_verified: true,
    }).returning({ id: users.id, kind: users.kind, is_agent: users.is_agent });
  } else if (user.kind !== 'agent' || !user.is_agent) {
    // Patch legacy row created without kind=agent / is_agent=true.
    await db.update(users)
      .set({ kind: 'agent', is_agent: true })
      .where(eq(users.email, DEFTY_EMAIL));
  }

  const userId = user!.id;

  // 2. Ensure org_members row exists for this org.
  const [existing] = await db.select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, userId)))
    .limit(1);

  if (!existing) {
    await db.insert(orgMembers).values({
      org_id: orgId,
      user_id: userId,
      role: 'member',
    });
  }

  return userId;
}
