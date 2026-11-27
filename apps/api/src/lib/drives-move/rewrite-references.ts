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
// Every read here is of this workspace's rows, except one probe per key: a
// boolean EXISTS across workspaces on that unique key (consult rule C7). It
// reads nothing of the other row, and a conflict report names only this
// workspace's row and the key it would take.
// Each rewritten row is recorded on its note's map row
// (`details.rewritten_refs`), so the post-move check can confirm it names
// that note's document.
// App resource refs of kind `notes` are not rewritten: they are resolved at
// display time through note_document_map (F15). A reference to a note that
// isn't mapped in this workspace is left. Runs in one transaction under the
// workspace's move lock; a second run finds nothing left to change.
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db.js';
import { lockOrgInTx, rowsOf, type Tx } from './placement.js';

/** A rewrite that would repeat another workspace's row: this workspace's row and the key it would take (all this workspace's values). */
export type ReferenceConflict = { table: string; id: string; key: Record<string, string> };
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
 * What to do with a row whose rewritten key is `key`: `elsewhere` says
 * another workspace already holds that key (a conflict); `here` that a row of
 * this workspace does, or a row of this run took it first (a duplicate).
 */
function settle(key: string, here: boolean, elsewhere: boolean, taken: Set<string>): 'conflict' | 'duplicate' | 'rewrite' {
  if (elsewhere) return 'conflict';
  if (here || taken.has(key)) return 'duplicate';
  taken.add(key);
  return 'rewrite';
}

/** One boolean of a query: `SELECT EXISTS (...) AS found`. */
async function exists(tx: Tx, query: SQL): Promise<boolean> {
  const [row] = rowsOf<{ found: boolean }>(await tx.execute(query));
  return row?.found === true;
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
    const here = await exists(tx, sql`SELECT EXISTS (SELECT 1 FROM entity_tags
      WHERE org_id = ${orgId} AND tag_id = ${row.tag_id} AND entity_type = 'document' AND entity_id = ${row.target_id}) AS found`);
    const elsewhere = await exists(tx, sql`
      -- C7: cross-workspace existence probe on a globally unique key; reads nothing else (conflict is reported, not resolved)
      SELECT EXISTS (SELECT 1 FROM entity_tags
      WHERE org_id <> ${orgId} AND tag_id = ${row.tag_id} AND entity_type = 'document' AND entity_id = ${row.target_id}) AS found`);
    const outcome = settle(`${row.tag_id}\u0000${row.target_id}`, here, elsewhere, taken);
    if (outcome === 'conflict') {
      out.conflicts.push({ table: 'entity_tags', id: row.id, key: { tag_id: row.tag_id, entity_type: 'document', entity_id: row.target_id } });
    }
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
  const rewriting = rows.map((row) => row.id);
  const taken = new Set<string>();
  const duplicates: string[] = [];
  for (const row of rows) {
    // This workspace's other rows with the key (the rows being rewritten still hold their old keys, and are left out).
    const here = await exists(tx, sql`SELECT EXISTS (SELECT 1 FROM cross_references
      WHERE org_id = ${orgId} AND source_type = ${row.source_type} AND source_id = ${row.source_id}
        AND target_type = ${row.target_type} AND target_id = ${row.target_id} AND NOT (id = ANY(${sql.param(rewriting)}::text[]))) AS found`);
    const elsewhere = await exists(tx, sql`
      -- C7: cross-workspace existence probe on a globally unique key; reads nothing else (conflict is reported, not resolved)
      SELECT EXISTS (SELECT 1 FROM cross_references
      WHERE org_id <> ${orgId} AND source_type = ${row.source_type} AND source_id = ${row.source_id}
        AND target_type = ${row.target_type} AND target_id = ${row.target_id}) AS found`);
    const outcome = settle(`${row.source_type}\u0000${row.source_id}\u0000${row.target_type}\u0000${row.target_id}`, here, elsewhere, taken);
    if (outcome === 'conflict') {
      out.conflicts.push({ table: 'cross_references', id: row.id, key: {
        source_type: row.source_type, source_id: row.source_id, target_type: row.target_type, target_id: row.target_id,
      } });
    }
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
    const here = await exists(tx, sql`SELECT EXISTS (SELECT 1 FROM team_resources
      WHERE org_id = ${orgId} AND team_id = ${row.team_id} AND resource_type = 'document' AND resource_id = ${row.target_id}) AS found`);
    const elsewhere = await exists(tx, sql`
      -- C7: cross-workspace existence probe on a globally unique key; reads nothing else (conflict is reported, not resolved)
      SELECT EXISTS (SELECT 1 FROM team_resources
      WHERE org_id <> ${orgId} AND team_id = ${row.team_id} AND resource_type = 'document' AND resource_id = ${row.target_id}) AS found`);
    const outcome = settle(`${row.team_id}\u0000${row.target_id}`, here, elsewhere, taken);
    if (outcome === 'conflict') {
      out.conflicts.push({ table: 'team_resources', id: row.id, key: { team_id: row.team_id, resource_type: 'document', resource_id: row.target_id } });
    }
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
