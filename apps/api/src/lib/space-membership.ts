import { db } from './db.js';
import { messages, orgMembers, spaceMembers, spaces, users } from '@deft/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import type { CoreDatabaseTransaction } from './database-transaction.js';

/**
 * True when `userId` may find and join the public spaces of `orgId`: an active
 * member of that org with role owner, admin or member, and a human user.
 * Guests and agent users are added to spaces by a member instead. The role is
 * read from the database, not from the session.
 */
export async function canSelfJoinPublicSpaces(
  userId: string,
  orgId: string,
  tx?: CoreDatabaseTransaction,
): Promise<boolean> {
  const query = (tx ?? db).select({ id: orgMembers.id })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.user_id))
    .where(and(
      eq(orgMembers.org_id, orgId),
      eq(orgMembers.user_id, userId),
      eq(orgMembers.is_active, true),
      inArray(orgMembers.role, ['owner', 'admin', 'member']),
      eq(users.kind, 'human'),
    ))
    .limit(1);
  // Inside a join transaction the user and membership rows are share-locked
  // until commit, in the same order (users, then org_members) that member
  // removal locks them, so the two cannot deadlock.
  if (tx) await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('share');
  const [row] = tx ? await query.for('share', { of: orgMembers }) : await query;
  return !!row;
}

/**
 * True when `userId` is a member of `spaceId` AND that space belongs to
 * `orgId` (the caller's active org). One user can be an active member of
 * several orgs; without the org binding a session for org A passed this check
 * for an org-B space the user belongs to. A space outside the active org is
 * indistinguishable from a space the user is not a member of.
 */
export async function requireSpaceMembership(spaceId: string, userId: string, orgId: string): Promise<boolean> {
  const [member] = await db.select({ id: spaceMembers.id })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.space_id))
    .where(and(
      eq(spaceMembers.space_id, spaceId),
      eq(spaceMembers.user_id, userId),
      eq(spaces.org_id, orgId),
    ))
    .limit(1);
  return !!member;
}

/**
 * Loads the given messages for a caller: each must belong to `orgId`, not be
 * deleted, and sit in a space the caller passes `requireSpaceMembership` for.
 * Ids that are missing or not readable by the caller are simply absent from
 * the result, so callers answer both cases the same way.
 */
export async function loadMessagesForMember(
  messageIds: readonly string[],
  userId: string,
  orgId: string,
): Promise<Map<string, { id: string; space_id: string }>> {
  const result = new Map<string, { id: string; space_id: string }>();
  const ids = [...new Set(messageIds)];
  if (ids.length === 0) return result;
  const rows = await db.select({ id: messages.id, space_id: messages.space_id })
    .from(messages)
    .where(and(inArray(messages.id, ids), eq(messages.org_id, orgId), eq(messages.is_deleted, false)));
  const readableSpaces = new Set<string>();
  for (const spaceId of new Set(rows.map((row) => row.space_id))) {
    if (await requireSpaceMembership(spaceId, userId, orgId)) readableSpaces.add(spaceId);
  }
  for (const row of rows) {
    if (readableSpaces.has(row.space_id)) result.set(row.id, row);
  }
  return result;
}

/** Single-message form of `loadMessagesForMember`; null when missing or not readable. */
export async function loadMessageForMember(messageId: string, userId: string, orgId: string) {
  return (await loadMessagesForMember([messageId], userId, orgId)).get(messageId) ?? null;
}
