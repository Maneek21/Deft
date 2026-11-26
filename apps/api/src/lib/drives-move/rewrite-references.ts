// The notes move (plan Task F14, spec 5.11): references to moved notes point
// at their documents. For the notes of `orgId` in note_document_map (a
// note's document is its first part), and only rows of `orgId` (consult rule
// C7):
// - entity_tags of type `note` or `daily_note` become `document`;
// - cross_references with a `note` source or target become `document`;
// - team_resources of type `note` become `document`;
// - attention_items with source_type `note` become `document`.
// The first three have a unique key across workspaces. A row whose rewrite
// would repeat a row of the same workspace (the same tag on a note as both
// types, or an edge already there) is a duplicate and is deleted, the oldest
// kept. A row whose rewrite would repeat a row of another workspace is a
// conflict: it is left as it is and reported as an error, so the move doesn't
// finish and an operator decides; nothing of the other workspace is touched.
// Each rewritten row is recorded on its note's map row
// (`details.rewritten_refs`), so the post-move check can confirm it names
// that note's document.
// App resource refs of kind `notes` are not rewritten: they are resolved at
// display time through note_document_map (F15). A reference to a note that
// isn't mapped in this workspace is left. Runs in one transaction under the
// workspace's move lock; a second run finds nothing left to change.
import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import { lockOrgInTx, rowsOf, type Tx } from './placement.js';

export type ReferenceConflict = { table: string; id: string };
export type ReferenceRewrite = {
  crossReferences: number; entityTags: number; teamResources: number; attentionItems: number; duplicatesRemoved: number;
  conflicts: ReferenceConflict[];
};

export const emptyReferenceRewrite = (): ReferenceRewrite => ({
  crossReferences: 0, entityTags: 0, teamResources: 0, attentionItems: 0, duplicatesRemoved: 0, conflicts: [],
});

/** One rewritten row, recorded on its note's map row. `side` names the cross reference end that was the note. */
export type RewrittenRef = { table: 'entity_tags' | 'cross_references' | 'team_resources' | 'attention_items'; id: string; side?: 'source' | 'target' };

class Ledger {
  readonly byNote = new Map<string, RewrittenRef[]>();
  add(noteId: string, ref: RewrittenRef): void {
    this.byNote.set(noteId, [...(this.byNote.get(noteId) ?? []), ref]);
  }
}

export async function rewriteReferences(orgId: string): Promise<ReferenceRewrite> {
  return db.transaction(async (tx) => {
    await lockOrgInTx(tx, orgId);
    const out = emptyReferenceRewrite();
    const ledger = new Ledger();
    await rewriteEntityTags(tx, orgId, out, ledger);
    await rewriteCrossReferences(tx, orgId, out, ledger);
    await rewriteTeamResources(tx, orgId, out, ledger);
    const attention = rowsOf<{ id: string; note_id: string }>(await tx.execute(sql`UPDATE attention_items item
      SET source_type = 'document', source_id = m.target_id, updated_at = now()
      FROM note_document_map m
      WHERE item.org_id = ${orgId} AND item.source_type = 'note'
        AND m.org_id = item.org_id AND m.source_type = 'note' AND m.source_id = item.source_id
      RETURNING item.id, m.source_id AS note_id`));
    for (const row of attention) ledger.add(row.note_id, { table: 'attention_items', id: row.id });
    out.attentionItems = attention.length;
    for (const [noteId, refs] of ledger.byNote) {
      await tx.execute(sql`UPDATE note_document_map
        SET details = jsonb_set(coalesce(details, '{}'::jsonb), '{rewritten_refs}',
          coalesce(details->'rewritten_refs', '[]'::jsonb) || ${JSON.stringify(refs)}::jsonb)
        WHERE org_id = ${orgId} AND source_type = 'note' AND source_id = ${noteId}`);
    }
    return out;
  });
}

/**
 * What to do with a row whose rewritten key is `key`: `others` are the rows
 * already holding that key (with their workspace). Another workspace's row is
 * a conflict; one of this workspace, or a row of this run that took the key
 * first, makes it a duplicate.
 */
function settle(orgId: string, key: string, others: Array<{ org_id: string }>, taken: Set<string>): 'conflict' | 'duplicate' | 'rewrite' {
  if (others.some((other) => other.org_id !== orgId)) return 'conflict';
  if (others.length > 0 || taken.has(key)) return 'duplicate';
  taken.add(key);
  return 'rewrite';
}

async function deleteRows(tx: Tx, table: 'entity_tags' | 'cross_references' | 'team_resources', orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id = ${orgId} AND id = ANY(${sql.param(ids)}::text[])`);
}

async function rewriteEntityTags(tx: Tx, orgId: string, out: ReferenceRewrite, ledger: Ledger): Promise<void> {
  const rows = rowsOf<{ id: string; tag_id: string; note_id: string; target_id: string }>(await tx.execute(sql`
    SELECT tagged.id, tagged.tag_id, tagged.entity_id AS note_id, m.target_id
    FROM entity_tags tagged
    JOIN note_document_map m ON m.org_id = tagged.org_id AND m.source_type = 'note' AND m.source_id = tagged.entity_id
    WHERE tagged.org_id = ${orgId} AND tagged.entity_type IN ('note', 'daily_note')
    ORDER BY tagged.created_at, tagged.id
    FOR UPDATE OF tagged`));
  const taken = new Set<string>();
  const duplicates: string[] = [];
  for (const row of rows) {
    const others = rowsOf<{ org_id: string }>(await tx.execute(sql`SELECT org_id FROM entity_tags
      WHERE tag_id = ${row.tag_id} AND entity_type = 'document' AND entity_id = ${row.target_id}`));
    const outcome = settle(orgId, `${row.tag_id}\u0000${row.target_id}`, others, taken);
    if (outcome === 'conflict') out.conflicts.push({ table: 'entity_tags', id: row.id });
    else if (outcome === 'duplicate') duplicates.push(row.id);
    else {
      await tx.execute(sql`UPDATE entity_tags SET entity_type = 'document', entity_id = ${row.target_id}, updated_at = now()
        WHERE org_id = ${orgId} AND id = ${row.id}`);
      ledger.add(row.note_id, { table: 'entity_tags', id: row.id });
      out.entityTags += 1;
    }
  }
  await deleteRows(tx, 'entity_tags', orgId, duplicates);
  out.duplicatesRemoved += duplicates.length;
}

async function rewriteCrossReferences(tx: Tx, orgId: string, out: ReferenceRewrite, ledger: Ledger): Promise<void> {
  const rows = rowsOf<{
    id: string; source_type: string; source_id: string; target_type: string; target_id: string;
    source_note: string | null; target_note: string | null;
  }>(await tx.execute(sql`
    SELECT edge.id,
      CASE WHEN source_map.target_id IS NOT NULL THEN 'document' ELSE edge.source_type END AS source_type,
      coalesce(source_map.target_id, edge.source_id) AS source_id,
      CASE WHEN target_map.target_id IS NOT NULL THEN 'document' ELSE edge.target_type END AS target_type,
      coalesce(target_map.target_id, edge.target_id) AS target_id,
      source_map.source_id AS source_note, target_map.source_id AS target_note
    FROM cross_references edge
    LEFT JOIN note_document_map source_map ON edge.source_type = 'note' AND source_map.org_id = edge.org_id
      AND source_map.source_type = 'note' AND source_map.source_id = edge.source_id
    LEFT JOIN note_document_map target_map ON edge.target_type = 'note' AND target_map.org_id = edge.org_id
      AND target_map.source_type = 'note' AND target_map.source_id = edge.target_id
    WHERE edge.org_id = ${orgId} AND (source_map.target_id IS NOT NULL OR target_map.target_id IS NOT NULL)
    ORDER BY edge.created_at, edge.id
    FOR UPDATE OF edge`));
  const rewriting = new Set(rows.map((row) => row.id));
  const taken = new Set<string>();
  const duplicates: string[] = [];
  for (const row of rows) {
    const others = rowsOf<{ id: string; org_id: string }>(await tx.execute(sql`SELECT id, org_id FROM cross_references
      WHERE source_type = ${row.source_type} AND source_id = ${row.source_id} AND target_type = ${row.target_type} AND target_id = ${row.target_id}`))
      .filter((other) => !rewriting.has(other.id));
    const outcome = settle(orgId, `${row.source_type}\u0000${row.source_id}\u0000${row.target_type}\u0000${row.target_id}`, others, taken);
    if (outcome === 'conflict') out.conflicts.push({ table: 'cross_references', id: row.id });
    else if (outcome === 'duplicate') duplicates.push(row.id);
    else {
      await tx.execute(sql`UPDATE cross_references SET source_type = ${row.source_type}, source_id = ${row.source_id},
        target_type = ${row.target_type}, target_id = ${row.target_id}, updated_at = now()
        WHERE org_id = ${orgId} AND id = ${row.id}`);
      if (row.source_note) ledger.add(row.source_note, { table: 'cross_references', id: row.id, side: 'source' });
      if (row.target_note) ledger.add(row.target_note, { table: 'cross_references', id: row.id, side: 'target' });
      out.crossReferences += 1;
    }
  }
  await deleteRows(tx, 'cross_references', orgId, duplicates);
  out.duplicatesRemoved += duplicates.length;
}

async function rewriteTeamResources(tx: Tx, orgId: string, out: ReferenceRewrite, ledger: Ledger): Promise<void> {
  const rows = rowsOf<{ id: string; team_id: string; note_id: string; target_id: string }>(await tx.execute(sql`
    SELECT link.id, link.team_id, link.resource_id AS note_id, m.target_id
    FROM team_resources link
    JOIN note_document_map m ON m.org_id = link.org_id AND m.source_type = 'note' AND m.source_id = link.resource_id
    WHERE link.org_id = ${orgId} AND link.resource_type = 'note'
    ORDER BY link.created_at, link.id
    FOR UPDATE OF link`));
  const taken = new Set<string>();
  const duplicates: string[] = [];
  for (const row of rows) {
    const others = rowsOf<{ org_id: string }>(await tx.execute(sql`SELECT org_id FROM team_resources
      WHERE team_id = ${row.team_id} AND resource_type = 'document' AND resource_id = ${row.target_id}`));
    const outcome = settle(orgId, `${row.team_id}\u0000${row.target_id}`, others, taken);
    if (outcome === 'conflict') out.conflicts.push({ table: 'team_resources', id: row.id });
    else if (outcome === 'duplicate') duplicates.push(row.id);
    else {
      await tx.execute(sql`UPDATE team_resources SET resource_type = 'document', resource_id = ${row.target_id}
        WHERE org_id = ${orgId} AND id = ${row.id}`);
      ledger.add(row.note_id, { table: 'team_resources', id: row.id });
      out.teamResources += 1;
    }
  }
  await deleteRows(tx, 'team_resources', orgId, duplicates);
  out.duplicatesRemoved += duplicates.length;
}
