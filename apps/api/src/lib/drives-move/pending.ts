// The notes move (plan Task F14): which workspaces still have something to
// move. A workspace needs the move while any of its notes, note folders or
// non-empty canvases has no note_document_map row, or a reference to a moved
// note still names the note (rewrite-references.ts). The API start moves
// those before it listens (startup.ts); while paused, the drive list says the
// notes move when the workspace resumes (GET /api/drives notes_move_pending).
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db.js';
import { canvasHasContent } from './convert-note.js';
import { rowsOf } from './placement.js';

/** The conditions on the workspace row `pending_org` that mean the move isn't finished, apart from canvases. */
const unfinished = sql`(
  EXISTS (SELECT 1 FROM notes pending_note WHERE pending_note.org_id = pending_org.id
    AND NOT EXISTS (SELECT 1 FROM note_document_map m WHERE m.source_type = 'note' AND m.source_id = pending_note.id))
  OR EXISTS (SELECT 1 FROM note_folders pending_folder WHERE pending_folder.org_id = pending_org.id
    AND NOT EXISTS (SELECT 1 FROM note_document_map m WHERE m.source_type = 'note_folder' AND m.source_id = pending_folder.id))
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

/** The workspaces (all, or those of `orgIds`) with something still to move, in a stable order. */
export async function orgsNeedingMove(orgIds?: readonly string[]): Promise<string[]> {
  const only: SQL = orgIds ? sql`pending_org.id = ANY(${sql.param([...orgIds])}::text[])` : sql`true`;
  const found = new Set(rowsOf<{ id: string }>(await db.execute(sql`SELECT pending_org.id FROM orgs pending_org
    WHERE ${only} AND ${unfinished}`)).map((row) => row.id));
  // A canvas counts only when it has content, which is decided in code (convert-note.ts).
  const canvases = rowsOf<{ org_id: string; content: unknown }>(await db.execute(sql`SELECT pending_canvas.org_id, pending_canvas.content
    FROM canvases pending_canvas JOIN orgs pending_org ON pending_org.id = pending_canvas.org_id
    WHERE ${only} AND pending_canvas.content IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM note_document_map m WHERE m.source_type = 'canvas' AND m.source_id = pending_canvas.id)`));
  for (const canvas of canvases) if (!found.has(canvas.org_id) && canvasHasContent(canvas.content)) found.add(canvas.org_id);
  return [...found].sort();
}

/** True while `orgId` still has notes or canvases to move. */
export async function orgNeedsMove(orgId: string): Promise<boolean> {
  return (await orgsNeedingMove([orgId])).length > 0;
}
