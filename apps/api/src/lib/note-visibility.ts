// Who may see a note. Every surface that returns note rows, titles, content
// or counts reads through `visibleNoteCondition`; do not write a copy.
//
// A note is seen by its author, by the people it is shared with (note_shares),
// and, for a space note, by the members of that space. A note visible to the
// whole workspace (visibility 'org') is seen by its owners, admins and
// members, and by agents, but not by a guest: a guest sees only what they
// were added to. The role is read from org_members for the note's workspace
// (people-visibility-sql.ts), never from a session or token claim.
//
// This module reads no database itself, so the workspace exporter can use it.
import { and, eq, inArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { notes, noteShares, spaceMembers } from '@deft/db/schema';
import { fullWorkspaceViewSql } from './people-visibility-sql.js';

/** The rule, given how to tell that the note is shared with `userId` and that they are in its space. */
function noteRule(userId: string | SQLWrapper, sharedWithUser: SQL, inNoteSpace: SQL): SQL {
  return or(
    eq(notes.user_id, userId),
    and(eq(notes.visibility, 'org'), fullWorkspaceViewSql(userId, notes.org_id)),
    sharedWithUser,
    and(eq(notes.visibility, 'space'), inNoteSpace),
  )!;
}

/**
 * True for a note `userId` may see. Combine with `notes.org_id` and
 * `notes.is_deleted` checks. `userId` may be a column, for a check over
 * several people (defty-audience.ts).
 */
export function visibleNoteCondition(userId: string | SQLWrapper): SQL {
  return noteRule(
    userId,
    sql`exists (
      select 1 from ${noteShares}
      where ${noteShares.note_id} = ${notes.id}
        and ${noteShares.shared_with_user_id} = ${userId}
    )`,
    sql`exists (
      select 1 from ${spaceMembers}
      where ${spaceMembers.space_id} = ${notes.visibility_space_id}
        and ${spaceMembers.user_id} = ${userId}
    )`,
  );
}

/**
 * The same rule, counting only the shares and space memberships of `userId`
 * that the caller's transaction has already locked (by note id and space id),
 * so a grant inserted after those locks is not counted. The note rows and the
 * person's workspace membership must be locked by the caller too.
 */
export function visibleNoteConditionFromLockedGrants(
  userId: string,
  grants: Readonly<{ sharedNoteIds: readonly string[]; memberSpaceIds: readonly string[] }>,
): SQL {
  return noteRule(
    userId,
    grants.sharedNoteIds.length > 0 ? inArray(notes.id, [...grants.sharedNoteIds]) : sql`false`,
    grants.memberSpaceIds.length > 0 ? inArray(notes.visibility_space_id, [...grants.memberSpaceIds]) : sql`false`,
  );
}
