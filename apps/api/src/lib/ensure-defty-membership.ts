// Idempotent helper: ensures the Defty system agent user exists and has an
// org_members row for the given org. Callable from invite-acceptance,
// signup-finalization, and the @deft mention worker.
//
// Design: there is ONE Defty user row globally (keyed by email) that joins
// every org via org_members. Matches the existing pattern from agent-reply.ts
// where the user is keyed by email='deft-agent@system.local'. Phase 1 of
// agent-chat unification — see docs/superpowers/specs/2026-05-07-agent-chat-unification.md.

import { db } from './db.js';
import { users, orgMembers, spaces, spaceMembers } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';

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

/**
 * Ensure a 1:1 DM space exists between `userId` and Defty in `orgId`.
 * Idempotent — calling twice returns the same space id.
 *
 * Materializes Defty's DM eagerly at signup / invite-accept time so every
 * user sees the conversation in their sidebar without having to click
 * "Ask Defty" first. The DM is a normal `spaces` row with `type='dm'`
 * and exactly two `space_members` rows (user + Defty), matching the
 * dedup contract used by `POST /api/spaces`.
 */
export async function ensureDeftyDm(orgId: string, userId: string): Promise<string> {
  // Guarantee Defty membership in this org before we wire the DM, even if
  // the caller forgot. ensureDeftyMembership is idempotent.
  const deftyUserId = await ensureDeftyMembership(orgId);

  // Theoretically impossible — Defty doesn't sign up — but bail safely.
  if (userId === deftyUserId) {
    return '';
  }

  // Look up an existing 1:1 DM whose member set is exactly {userId, deftyUserId}.
  // Mirrors the dedup logic in apps/api/src/routes/spaces.ts.
  const candidateSpaces = await db.select({ space_id: spaceMembers.space_id })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.space_id))
    .where(and(
      eq(spaces.type, 'dm'),
      eq(spaces.org_id, orgId),
      eq(spaceMembers.user_id, userId),
    ));

  for (const cand of candidateSpaces) {
    const memberRows = await db.select({ user_id: spaceMembers.user_id })
      .from(spaceMembers)
      .where(eq(spaceMembers.space_id, cand.space_id));
    if (memberRows.length !== 2) continue;
    const memberSet = new Set(memberRows.map((m) => m.user_id));
    if (memberSet.has(userId) && memberSet.has(deftyUserId)) {
      return cand.space_id;
    }
  }

  // Look up the user's display name for the DM label. Fall back to 'Defty'.
  const [u] = await db.select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const userName = u?.name && u.name.trim().length > 0 ? u.name : null;
  const dmName = userName ? `${userName}, ${DEFTY_NAME}` : DEFTY_NAME;

  try {
    const [space] = await db.insert(spaces).values({
      org_id: orgId,
      name: dmName,
      type: 'dm',
      created_by: userId,
    }).returning({ id: spaces.id });

    if (!space) {
      throw new Error('insert spaces returned no row');
    }

    await db.insert(spaceMembers).values([
      { space_id: space.id, user_id: userId },
      { space_id: space.id, user_id: deftyUserId },
    ]).onConflictDoNothing();

    return space.id;
  } catch (err) {
    // On race (unique index conflict or partial insert), re-run the lookup.
    const retryCandidates = await db.select({ space_id: spaceMembers.space_id })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.space_id))
      .where(and(
        eq(spaces.type, 'dm'),
        eq(spaces.org_id, orgId),
        eq(spaceMembers.user_id, userId),
      ));

    for (const cand of retryCandidates) {
      const memberRows = await db.select({ user_id: spaceMembers.user_id })
        .from(spaceMembers)
        .where(eq(spaceMembers.space_id, cand.space_id));
      if (memberRows.length !== 2) continue;
      const memberSet = new Set(memberRows.map((m) => m.user_id));
      if (memberSet.has(userId) && memberSet.has(deftyUserId)) {
        return cand.space_id;
      }
    }
    throw err;
  }
}
