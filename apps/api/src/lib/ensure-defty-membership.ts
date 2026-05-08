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
import { eq } from 'drizzle-orm';

export const DEFTY_EMAIL = 'deft-agent@system.local';
export const DEFTY_NAME = 'Defty';

export async function ensureDeftyMembership(orgId: string): Promise<string> {
  // 1. Find or create the Defty user. If it already exists (created by the
  //    legacy ensureAgentUser which didn't set kind/is_agent), patch it so
  //    the canonical fields are always present (and the display name stays
  //    in sync with DEFTY_NAME — earlier rows shipped with name='Deft').
  let [user] = await db.select({ id: users.id, name: users.name, kind: users.kind, is_agent: users.is_agent })
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
    }).returning({ id: users.id, name: users.name, kind: users.kind, is_agent: users.is_agent });
  } else if (user.kind !== 'agent' || !user.is_agent || user.name !== DEFTY_NAME) {
    // Patch legacy row (missing kind/is_agent, or name='Deft' from before rename).
    await db.update(users)
      .set({ kind: 'agent', is_agent: true, name: DEFTY_NAME })
      .where(eq(users.email, DEFTY_EMAIL));
  }

  const userId = user!.id;

  // 2. Ensure org_members row exists for this org. Use onConflictDoNothing
  // to handle concurrent invocations cleanly (signup + invite acceptance
  // can race on the unique (org_id, user_id) index).
  await db.insert(orgMembers).values({
    org_id: orgId,
    user_id: userId,
    role: 'member',
  }).onConflictDoNothing();

  return userId;
}
