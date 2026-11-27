// The rule notes had (spec 5.12; plan Task F15), kept for the two questions
// it still answers and nothing else:
// - whether someone could see a note before the move (GET
//   /api/documents/by-legacy, lib/legacy-notes.ts couldSeeLegacySource), so
//   an old link still finds its document;
// - which notes that never moved a member's workspace export holds
//   (lib/workspace-export/datasets-knowledge.ts). After the move there are
//   none: a moved note is exported only as its document.
// Every reader of notes reads documents and their access check
// (lib/document-access.ts); never use this to decide what someone may open.
//
// A note was seen by its author, by the people it was shared with
// (note_shares), by the members of its space for a space note, and, for a
// note visible to the whole workspace, by its owners, admins, members and
// agents, never a guest (people-visibility-sql.ts). This module reads no
// database, so the workspace export can use it.
import { sql, type SQL } from 'drizzle-orm';
import { notes, noteShares, spaceMembers } from '@deft/db/schema';
import { fullWorkspaceViewSql } from './people-visibility-sql.js';

/** For a query over `notes` (not aliased): true for a note `userId` could see under the rule notes had. */
export function legacyNoteVisibleSql(userId: string): SQL {
  return sql`(${notes.user_id} = ${userId}
    OR (${notes.visibility} = 'org' AND ${fullWorkspaceViewSql(userId, notes.org_id)})
    OR EXISTS (SELECT 1 FROM ${noteShares} WHERE ${noteShares.note_id} = ${notes.id} AND ${noteShares.shared_with_user_id} = ${userId})
    OR (${notes.visibility} = 'space' AND EXISTS (SELECT 1 FROM ${spaceMembers}
      WHERE ${spaceMembers.space_id} = ${notes.visibility_space_id} AND ${spaceMembers.user_id} = ${userId})))`;
}
