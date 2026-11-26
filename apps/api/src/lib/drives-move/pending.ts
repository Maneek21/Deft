// The notes move (plan Task F14): which workspaces still have the move to
// finish. Light: the drive list route reads it.
//
// - A workspace's move is finished when drives_move_runs holds an ok row for
//   it and DRIVES_MOVE_RELEASE: its move completed and the post-move check
//   passed (runs.ts). The API listens only when every workspace has one
//   (startup.ts), and a workspace that has one is never moved or checked
//   again, so later edits can't fail a start.
// - A workspace has something to move while any of its notes, note folders
//   or non-empty canvases has no note_document_map row of its own, or a
//   reference to a moved note still names the note. While a start is paused,
//   the drive list says the notes move when the workspace resumes
//   (notesMovePending, GET /api/drives notes_move_pending).
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db.js';
import { canvasHasContent } from './convert-note.js';

/** The move's release: drives_move_runs rows are kept per workspace and this. */
export const DRIVES_MOVE_RELEASE = '0.3.0-preview.155';

/** Canvases read per page when deciding which have content. */
const CANVAS_PAGE = 100;

function rowsOf<T>(result: unknown): T[] {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

/** The conditions on the workspace row `pending_org` that mean something is left to move, apart from canvases. */
const unfinished = sql`(
  EXISTS (SELECT 1 FROM notes pending_note WHERE pending_note.org_id = pending_org.id
    AND NOT EXISTS (SELECT 1 FROM note_document_map m WHERE m.org_id = pending_note.org_id AND m.source_type = 'note' AND m.source_id = pending_note.id))
  OR EXISTS (SELECT 1 FROM note_folders pending_folder WHERE pending_folder.org_id = pending_org.id
    AND NOT EXISTS (SELECT 1 FROM note_document_map m WHERE m.org_id = pending_folder.org_id AND m.source_type = 'note_folder'
      AND m.source_id = pending_folder.id))
  OR EXISTS (SELECT 1 FROM entity_tags pending_tag JOIN note_document_map m ON m.org_id = pending_tag.org_id
      AND m.source_type = 'note' AND m.source_id = pending_tag.entity_id
    WHERE pending_tag.org_id = pending_org.id AND pending_tag.entity_type IN ('note', 'daily_note'))
  OR EXISTS (SELECT 1 FROM cross_references pending_ref JOIN note_document_map m ON m.org_id = pending_ref.org_id
      AND m.source_type = 'note' AND ((pending_ref.source_type = 'note' AND m.source_id = pending_ref.source_id)
        OR (pending_ref.target_type = 'note' AND m.source_id = pending_ref.target_id))
    WHERE pending_ref.org_id = pending_org.id)
  OR EXISTS (SELECT 1 FROM team_resources pending_link JOIN note_document_map m ON m.org_id = pending_link.org_id
      AND m.source_type = 'note' AND m.source_id = pending_link.resource_id
    WHERE pending_link.org_id = pending_org.id AND pending_link.resource_type = 'note')
  OR EXISTS (SELECT 1 FROM attention_items pending_item JOIN note_document_map m ON m.org_id = pending_item.org_id
      AND m.source_type = 'note' AND m.source_id = pending_item.source_id
    WHERE pending_item.org_id = pending_org.id AND pending_item.source_type = 'note')
)`;

/**
 * True for the canvas row `alias` when the move can place it: someone can own
 * it, as move-canvases.ts chooses (an eligible member of its chat, the
 * workspace's active human owner, or, for the frozen fallback, its last
 * editor or its chat's creator with any membership row). A canvas with
 * content that nobody can own at all is dropped and counted, with its
 * content kept in the move's report, so it never holds a workspace back.
 */
export const canvasPlaceableSql = (alias: string): SQL => {
  const c = sql.raw(alias);
  return sql`(EXISTS (SELECT 1 FROM org_members placeable_owner JOIN users placeable_person ON placeable_person.id = placeable_owner.user_id
      WHERE placeable_owner.org_id = ${c}.org_id AND placeable_owner.role = 'owner' AND placeable_owner.is_active = true
        AND placeable_person.kind = 'human')
    OR EXISTS (SELECT 1 FROM org_members placeable_editor WHERE placeable_editor.org_id = ${c}.org_id AND placeable_editor.user_id = ${c}.last_edited_by)
    OR EXISTS (SELECT 1 FROM spaces placeable_chat JOIN org_members placeable_creator ON placeable_creator.org_id = placeable_chat.org_id
        AND placeable_creator.user_id = placeable_chat.created_by
      WHERE placeable_chat.id = ${c}.space_id AND placeable_chat.org_id = ${c}.org_id)
    OR EXISTS (SELECT 1 FROM space_members placeable_seat
      JOIN spaces placeable_seat_chat ON placeable_seat_chat.id = placeable_seat.space_id AND placeable_seat_chat.org_id = ${c}.org_id
      JOIN org_members placeable_member ON placeable_member.org_id = ${c}.org_id AND placeable_member.user_id = placeable_seat.user_id
        AND placeable_member.is_active = true AND placeable_member.role IN ('owner', 'admin', 'member')
      JOIN users placeable_seat_person ON placeable_seat_person.id = placeable_seat.user_id AND placeable_seat_person.kind = 'human'
      WHERE placeable_seat.space_id = ${c}.space_id))`;
};

const onlyOrgs = (orgIds?: readonly string[]): SQL => (orgIds ? sql`pending_org.id = ANY(${sql.param([...orgIds])}::text[])` : sql`true`);

/** True while the workspace `orgId` has something still to move (one workspace only, consult O-F8). */
export async function orgNeedsMove(orgId: string): Promise<boolean> {
  const [found] = rowsOf<{ found: boolean }>(await db.execute(sql`SELECT EXISTS (SELECT 1 FROM orgs pending_org
    WHERE pending_org.id = ${orgId} AND ${unfinished}) AS found`));
  if (found?.found) return true;
  // A canvas counts only when it has content, which is decided in code (convert-note.ts): read a page at a time.
  for (let after = ''; ;) {
    const page = rowsOf<{ id: string; content: unknown }>(await db.execute(sql`
      SELECT pending_canvas.id, pending_canvas.content FROM canvases pending_canvas
      WHERE pending_canvas.org_id = ${orgId} AND pending_canvas.id > ${after} AND pending_canvas.content IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM note_document_map m WHERE m.org_id = pending_canvas.org_id AND m.source_type = 'canvas'
          AND m.source_id = pending_canvas.id)
        AND ${canvasPlaceableSql('pending_canvas')}
      ORDER BY pending_canvas.id
      LIMIT ${CANVAS_PAGE}`));
    if (page.some((canvas) => canvasHasContent(canvas.content))) return true;
    if (page.length < CANVAS_PAGE) return false;
    after = page[page.length - 1]!.id;
  }
}

/**
 * The workspaces (all, or those of `orgIds`) without an ok move run for this
 * release, in a stable order. The one read here that lists every workspace:
 * the API start and the script move each of them in turn.
 */
export async function orgsWithoutFinishedMove(orgIds?: readonly string[]): Promise<string[]> {
  return rowsOf<{ id: string }>(await db.execute(sql`SELECT pending_org.id FROM orgs pending_org
    WHERE ${onlyOrgs(orgIds)}
      AND NOT EXISTS (SELECT 1 FROM drives_move_runs run WHERE run.org_id = pending_org.id
        AND run.release_version = ${DRIVES_MOVE_RELEASE} AND run.check_ok AND run.completed_at IS NOT NULL)
    ORDER BY pending_org.id`)).map((row) => row.id);
}

/** For a paused start's drive list: the workspace's move hasn't finished and it has notes or canvases waiting. */
export async function notesMovePending(orgId: string): Promise<boolean> {
  return (await orgsWithoutFinishedMove([orgId])).length > 0 && await orgNeedsMove(orgId);
}
