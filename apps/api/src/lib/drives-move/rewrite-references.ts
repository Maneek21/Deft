// The notes move (plan Task F14, spec 5.11): references to moved notes point
// at their documents. For the notes of `orgId` already in note_document_map
// (a note's document is its first part), within the same workspace:
// - entity_tags of type `note` or `daily_note` become `document`. A row that
//   would repeat another (the same tag on the same note as both types, or a
//   `document` row already there) is deleted first, so the unique key holds;
// - cross_references with a `note` source or target become `document`; an
//   edge that would repeat another is deleted, keeping the oldest;
// - team_resources of type `note` become `document`, a repeat deleted;
// - attention_items with source_type `note` become `document`.
// App resource refs of kind `notes` are not rewritten: they are resolved at
// display time through note_document_map (F15). A reference to a note that
// isn't mapped (another workspace's, or one that no longer exists) is left.
// Runs in one transaction under the workspace's move lock; a second run finds
// nothing left to change.
import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import { lockOrgInTx, rowsOf, type Tx } from './placement.js';

export type ReferenceRewrite = { crossReferences: number; entityTags: number; teamResources: number; attentionItems: number; duplicatesRemoved: number };

export const emptyReferenceRewrite = (): ReferenceRewrite => ({ crossReferences: 0, entityTags: 0, teamResources: 0, attentionItems: 0, duplicatesRemoved: 0 });

export async function rewriteReferences(orgId: string): Promise<ReferenceRewrite> {
  return db.transaction(async (tx) => {
    await lockOrgInTx(tx, orgId);
    const out = emptyReferenceRewrite();
    await rewriteEntityTags(tx, orgId, out);
    await rewriteCrossReferences(tx, orgId, out);
    await rewriteTeamResources(tx, orgId, out);
    const attention = rowsOf<{ id: string }>(await tx.execute(sql`UPDATE attention_items item
      SET source_type = 'document', source_id = m.target_id, updated_at = now()
      FROM note_document_map m
      WHERE item.org_id = ${orgId} AND item.source_type = 'note'
        AND m.org_id = item.org_id AND m.source_type = 'note' AND m.source_id = item.source_id
      RETURNING item.id`));
    out.attentionItems = attention.length;
    return out;
  });
}

async function rewriteEntityTags(tx: Tx, orgId: string, out: ReferenceRewrite): Promise<void> {
  const removed = rowsOf<{ id: string }>(await tx.execute(sql`DELETE FROM entity_tags tagged
    USING note_document_map m
    WHERE tagged.org_id = ${orgId} AND tagged.entity_type IN ('note', 'daily_note')
      AND m.org_id = tagged.org_id AND m.source_type = 'note' AND m.source_id = tagged.entity_id
      AND (EXISTS (SELECT 1 FROM entity_tags present
            WHERE present.tag_id = tagged.tag_id AND present.entity_type = 'document' AND present.entity_id = m.target_id)
        OR EXISTS (SELECT 1 FROM entity_tags twin
            WHERE twin.org_id = tagged.org_id AND twin.tag_id = tagged.tag_id AND twin.entity_type IN ('note', 'daily_note')
              AND twin.entity_id = tagged.entity_id AND (twin.entity_type::text, twin.id) < (tagged.entity_type::text, tagged.id)))
    RETURNING tagged.id`));
  out.duplicatesRemoved += removed.length;
  const updated = rowsOf<{ id: string }>(await tx.execute(sql`UPDATE entity_tags tagged
    SET entity_type = 'document', entity_id = m.target_id, updated_at = now()
    FROM note_document_map m
    WHERE tagged.org_id = ${orgId} AND tagged.entity_type IN ('note', 'daily_note')
      AND m.org_id = tagged.org_id AND m.source_type = 'note' AND m.source_id = tagged.entity_id
    RETURNING tagged.id`));
  out.entityTags = updated.length;
}

async function rewriteCrossReferences(tx: Tx, orgId: string, out: ReferenceRewrite): Promise<void> {
  const rows = rowsOf<{ id: string; source_type: string; source_id: string; target_type: string; target_id: string }>(await tx.execute(sql`
    SELECT edge.id,
      CASE WHEN source_map.target_id IS NOT NULL THEN 'document' ELSE edge.source_type END AS source_type,
      coalesce(source_map.target_id, edge.source_id) AS source_id,
      CASE WHEN target_map.target_id IS NOT NULL THEN 'document' ELSE edge.target_type END AS target_type,
      coalesce(target_map.target_id, edge.target_id) AS target_id
    FROM cross_references edge
    LEFT JOIN note_document_map source_map ON edge.source_type = 'note' AND source_map.org_id = edge.org_id
      AND source_map.source_type = 'note' AND source_map.source_id = edge.source_id
    LEFT JOIN note_document_map target_map ON edge.target_type = 'note' AND target_map.org_id = edge.org_id
      AND target_map.source_type = 'note' AND target_map.source_id = edge.target_id
    WHERE edge.org_id = ${orgId} AND (source_map.target_id IS NOT NULL OR target_map.target_id IS NOT NULL)
    ORDER BY edge.created_at, edge.id
    FOR UPDATE OF edge`));
  const rewriting = new Set(rows.map((row) => row.id));
  const kept = new Set<string>();
  const duplicates: string[] = [];
  const updates: typeof rows = [];
  for (const row of rows) {
    const key = `${row.source_type}\u0000${row.source_id}\u0000${row.target_type}\u0000${row.target_id}`;
    const others = rowsOf<{ id: string }>(await tx.execute(sql`SELECT id FROM cross_references
      WHERE source_type = ${row.source_type} AND source_id = ${row.source_id} AND target_type = ${row.target_type} AND target_id = ${row.target_id}`));
    if (kept.has(key) || others.some((other) => !rewriting.has(other.id))) duplicates.push(row.id);
    else {
      kept.add(key);
      updates.push(row);
    }
  }
  if (duplicates.length > 0) {
    await tx.execute(sql`DELETE FROM cross_references WHERE id = ANY(${sql.param(duplicates)}::text[])`);
    out.duplicatesRemoved += duplicates.length;
  }
  for (const row of updates) {
    await tx.execute(sql`UPDATE cross_references SET source_type = ${row.source_type}, source_id = ${row.source_id},
      target_type = ${row.target_type}, target_id = ${row.target_id}, updated_at = now() WHERE id = ${row.id}`);
  }
  out.crossReferences = updates.length;
}

async function rewriteTeamResources(tx: Tx, orgId: string, out: ReferenceRewrite): Promise<void> {
  const removed = rowsOf<{ id: string }>(await tx.execute(sql`DELETE FROM team_resources link
    USING note_document_map m
    WHERE link.org_id = ${orgId} AND link.resource_type = 'note'
      AND m.org_id = link.org_id AND m.source_type = 'note' AND m.source_id = link.resource_id
      AND EXISTS (SELECT 1 FROM team_resources present
        WHERE present.team_id = link.team_id AND present.resource_type = 'document' AND present.resource_id = m.target_id)
    RETURNING link.id`));
  out.duplicatesRemoved += removed.length;
  const updated = rowsOf<{ id: string }>(await tx.execute(sql`UPDATE team_resources link
    SET resource_type = 'document', resource_id = m.target_id
    FROM note_document_map m
    WHERE link.org_id = ${orgId} AND link.resource_type = 'note'
      AND m.org_id = link.org_id AND m.source_type = 'note' AND m.source_id = link.resource_id
    RETURNING link.id`));
  out.teamResources = updated.length;
}
