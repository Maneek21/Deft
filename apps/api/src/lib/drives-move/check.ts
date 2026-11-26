// The notes move (plan Task F14): the check run straight after the move
// (spec 5.11, "keeping that window short"), before anyone is told the
// workspace is ready. It reconciles everything (consult change):
// - every note, note folder and non-empty canvas has a map row, and the
//   document or folder it names exists in the same workspace;
// - each note's shares are on its document and on every sub-page: its
//   note_shares (edit stays edit), its chat for a space note, the author's
//   edit share for a workspace note; a canvas's chat with edit;
// - each note's version count matches its moved versions;
// - no reference still names a moved note, and every reference that names a
//   document names one that exists;
// - every image a moved document links exists, row and bytes (the upgrade
//   container mounts the uploads volume read-only for this).
// Then it opens a sample (20 by default) of moved documents, every part:
// the live state they will load (ydoc_state, or the state built from
// content_json before the first load) reads back as exactly content_json, the
// size is within the cap, Knowledge is off, every image in the content is
// linked and present, and a note's history is all there. The sample runs
// whatever the counts say. `ok` is true only when nothing is wrong.
// Messages carry ids and counts, never content.
import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { jsonToYDoc, yDocToJson } from '@deft/doc-schema';
import { db } from '../db.js';
import { localFileStore } from '../file-store.js';
import { canvasHasContent, fitsSizeCap, imageFileIds, measureContent, type JSONContent } from './convert-note.js';
import { rowsOf } from './placement.js';

export type PostMoveCheck = { orgId: string; ok: boolean; notesExpected: number; documentsMapped: number; mismatches: string[];
  sampleOpened: number; sampleFailed: string[] };

/** The documents a map row's details name (`parts`: the document and its sub-pages), else its target. */
const PARTS = sql.raw(`jsonb_array_elements_text(coalesce(m.details->'parts', jsonb_build_array(m.target_id))) part(document_id)`);

export async function postMoveCheck(orgId: string, sampleSize = 20): Promise<PostMoveCheck> {
  const mismatches: string[] = [];
  let notesExpected = 0;
  let documentsMapped = 0;

  // Every source has its map row, naming something that exists in this workspace.
  const sources: Array<{ table: string; type: string; target: 'document' | 'doc_folder' }> = [
    { table: 'notes', type: 'note', target: 'document' },
    { table: 'note_folders', type: 'note_folder', target: 'doc_folder' },
    { table: 'canvases', type: 'canvas', target: 'document' },
  ];
  for (const source of sources) {
    const rows = rowsOf<{ id: string; mapped: boolean; target_ok: boolean; content?: unknown }>(await db.execute(sql`
      SELECT src.id, m.id IS NOT NULL AS mapped,
        (m.org_id = src.org_id AND m.target_type = ${source.target} AND EXISTS (SELECT 1 FROM ${sql.raw(source.target === 'document' ? 'documents' : 'doc_folders')} target
          WHERE target.id = m.target_id AND target.org_id = src.org_id)) AS target_ok
        ${source.table === 'canvases' ? sql`, src.content` : sql``}
      FROM ${sql.raw(source.table)} src
      LEFT JOIN note_document_map m ON m.source_type = ${source.type} AND m.source_id = src.id
      WHERE src.org_id = ${orgId}`));
    for (const row of rows) {
      if (source.table === 'canvases' && !row.mapped && !canvasHasContent(row.content)) continue;
      notesExpected += 1;
      if (!row.mapped) mismatches.push(`${source.type} ${row.id} has no map row`);
      else if (!row.target_ok) mismatches.push(`${source.type} ${row.id}: its ${source.target} is missing`);
      else documentsMapped += 1;
    }
  }

  // Shares: what each note or canvas gave its readers is on every part.
  const missingShares = rowsOf<{ source_id: string; document_id: string; principal: string }>(await db.execute(sql`
    WITH expected AS (
      SELECT n.id AS source_id, 'user' AS principal_type, share.shared_with_user_id AS principal_id,
        CASE WHEN share.permission = 'edit' THEN 'edit' ELSE 'view' END AS role
      FROM notes n JOIN note_shares share ON share.note_id = n.id
      JOIN org_members member ON member.org_id = n.org_id AND member.user_id = share.shared_with_user_id
      WHERE n.org_id = ${orgId}
      UNION ALL
      SELECT n.id, 'space', n.visibility_space_id, 'view' FROM notes n JOIN spaces chat ON chat.id = n.visibility_space_id AND chat.org_id = n.org_id
      WHERE n.org_id = ${orgId} AND n.visibility = 'space'
      UNION ALL
      SELECT n.id, 'user', n.user_id, 'edit' FROM notes n JOIN org_members member ON member.org_id = n.org_id AND member.user_id = n.user_id
      WHERE n.org_id = ${orgId} AND n.visibility = 'org'
      UNION ALL
      SELECT c.id, 'space', c.space_id, 'edit' FROM canvases c JOIN spaces chat ON chat.id = c.space_id AND chat.org_id = c.org_id
      WHERE c.org_id = ${orgId}
    )
    SELECT expected.source_id, part.document_id, expected.principal_type || ' ' || expected.principal_id AS principal
    FROM expected
    JOIN note_document_map m ON m.source_id = expected.source_id AND m.source_type IN ('note', 'canvas') AND m.org_id = ${orgId}
    CROSS JOIN LATERAL ${PARTS}
    WHERE NOT EXISTS (SELECT 1 FROM document_shares granted
      WHERE granted.org_id = m.org_id AND granted.document_id = part.document_id AND granted.principal_type = expected.principal_type
        AND granted.principal_id = expected.principal_id AND (expected.role <> 'edit' OR granted.role = 'edit'))
    ORDER BY 1, 2, 3`));
  for (const row of missingShares) mismatches.push(`source ${row.source_id}: document ${row.document_id} lacks the share for ${row.principal}`);

  // Versions.
  const versionGaps = rowsOf<{ id: string; expected: number; moved: number }>(await db.execute(sql`
    SELECT n.id, (SELECT count(*)::int FROM note_versions v WHERE v.note_id = n.id) AS expected,
      (SELECT count(*)::int FROM document_versions dv WHERE dv.org_id = n.org_id AND dv.document_id = m.target_id AND dv.kind = 'moved') AS moved
    FROM notes n JOIN note_document_map m ON m.source_type = 'note' AND m.source_id = n.id
    WHERE n.org_id = ${orgId}`)).filter((row) => row.expected !== row.moved);
  for (const row of versionGaps) mismatches.push(`note ${row.id}: ${row.expected} versions, ${row.moved} moved`);

  // References.
  const references = rowsOf<{ what: string; n: number }>(await db.execute(sql`
    SELECT 'entity tags still naming moved notes' AS what, count(*)::int AS n FROM entity_tags ref
      JOIN note_document_map m ON m.org_id = ref.org_id AND m.source_type = 'note' AND m.source_id = ref.entity_id
      WHERE ref.org_id = ${orgId} AND ref.entity_type IN ('note', 'daily_note')
    UNION ALL
    SELECT 'cross references still naming moved notes', count(*)::int FROM cross_references ref
      JOIN note_document_map m ON m.org_id = ref.org_id AND m.source_type = 'note'
        AND ((ref.source_type = 'note' AND m.source_id = ref.source_id) OR (ref.target_type = 'note' AND m.source_id = ref.target_id))
      WHERE ref.org_id = ${orgId}
    UNION ALL
    SELECT 'team links still naming moved notes', count(*)::int FROM team_resources ref
      JOIN note_document_map m ON m.org_id = ref.org_id AND m.source_type = 'note' AND m.source_id = ref.resource_id
      WHERE ref.org_id = ${orgId} AND ref.resource_type = 'note'
    UNION ALL
    SELECT 'attention items still naming moved notes', count(*)::int FROM attention_items ref
      JOIN note_document_map m ON m.org_id = ref.org_id AND m.source_type = 'note' AND m.source_id = ref.source_id
      WHERE ref.org_id = ${orgId} AND ref.source_type = 'note'
    UNION ALL
    SELECT 'entity tags naming a missing document', count(*)::int FROM entity_tags ref
      WHERE ref.org_id = ${orgId} AND ref.entity_type = 'document'
        AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = ref.entity_id AND d.org_id = ref.org_id)
    UNION ALL
    SELECT 'cross references naming a missing document', count(*)::int FROM cross_references ref
      WHERE ref.org_id = ${orgId}
        AND ((ref.source_type = 'document' AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = ref.source_id AND d.org_id = ref.org_id))
          OR (ref.target_type = 'document' AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = ref.target_id AND d.org_id = ref.org_id)))
    UNION ALL
    SELECT 'team links naming a missing document', count(*)::int FROM team_resources ref
      WHERE ref.org_id = ${orgId} AND ref.resource_type = 'document'
        AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = ref.resource_id AND d.org_id = ref.org_id)
    UNION ALL
    SELECT 'attention items naming a missing document', count(*)::int FROM attention_items ref
      WHERE ref.org_id = ${orgId} AND ref.source_type = 'document'
        AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = ref.source_id AND d.org_id = ref.org_id)`));
  for (const row of references) if (row.n > 0) mismatches.push(`${row.n} ${row.what}`);

  // Every linked image exists, row and bytes.
  const links = rowsOf<{ file_id: string; storage_key: string | null }>(await db.execute(sql`
    SELECT DISTINCT link.file_id, linked_file.storage_key
    FROM note_document_map m CROSS JOIN LATERAL ${PARTS}
    JOIN document_attachments link ON link.org_id = m.org_id AND link.document_id = part.document_id
    LEFT JOIN files linked_file ON linked_file.org_id = link.org_id AND linked_file.id = link.file_id
    WHERE m.org_id = ${orgId} AND m.target_type = 'document'
    ORDER BY link.file_id`));
  const presentFiles = new Set<string>();
  for (const link of links) {
    if (!link.storage_key) mismatches.push(`image ${link.file_id}: its file is missing`);
    else if (!(await bytesExist(link.storage_key))) mismatches.push(`image ${link.file_id}: its bytes are missing`);
    else presentFiles.add(link.file_id);
  }

  // The sample.
  const sample = rowsOf<{ source_type: string; source_id: string; target_id: string; details: { parts?: string[] } | null }>(await db.execute(sql`
    SELECT m.source_type, m.source_id, m.target_id, m.details FROM note_document_map m
    WHERE m.org_id = ${orgId} AND m.target_type = 'document'
    ORDER BY random() LIMIT ${Math.max(0, Math.floor(sampleSize))}`));
  const sampleFailed: string[] = [];
  let sampleOpened = 0;
  for (const entry of sample) {
    const failure = await openSample(orgId, entry, presentFiles);
    if (failure) sampleFailed.push(failure);
    else sampleOpened += 1;
  }
  return { orgId, ok: mismatches.length === 0 && sampleFailed.length === 0, notesExpected, documentsMapped, mismatches, sampleOpened, sampleFailed };
}

async function bytesExist(storageKey: string): Promise<boolean> {
  try {
    return (await localFileStore.stat(storageKey)) !== null;
  } catch {
    return false;
  }
}

/** One sampled source opened as a person would: null when every part is right, else what isn't. */
async function openSample(orgId: string, entry: { source_type: string; source_id: string; target_id: string; details: { parts?: string[] } | null },
  presentFiles: Set<string>): Promise<string | null> {
  const parts = Array.isArray(entry.details?.parts) && entry.details!.parts.length > 0 ? entry.details!.parts : [entry.target_id];
  for (const documentId of parts) {
    const [doc] = rowsOf<{ content_json: JSONContent; ydoc_state: Buffer | null; use_in_knowledge: boolean | null }>(await db.execute(sql`
      SELECT content_json, ydoc_state, use_in_knowledge FROM documents WHERE id = ${documentId} AND org_id = ${orgId}`));
    if (!doc) return `${entry.source_type} ${entry.source_id}: document ${documentId} is missing`;
    if (doc.use_in_knowledge !== false) return `${entry.source_type} ${entry.source_id}: document ${documentId} has Knowledge on`;
    const ydoc = doc.ydoc_state ? new Y.Doc() : jsonToYDoc(doc.content_json);
    try {
      if (doc.ydoc_state) Y.applyUpdate(ydoc, new Uint8Array(doc.ydoc_state));
      if (!isDeepStrictEqual(yDocToJson(ydoc), doc.content_json)) {
        return `${entry.source_type} ${entry.source_id}: document ${documentId} does not open as its stored content`;
      }
    } catch {
      return `${entry.source_type} ${entry.source_id}: document ${documentId} does not open`;
    } finally {
      ydoc.destroy();
    }
    if (!fitsSizeCap(measureContent(doc.content_json).bound)) return `${entry.source_type} ${entry.source_id}: document ${documentId} is over the size cap`;
    const fileIds = imageFileIds(doc.content_json);
    if (fileIds.length > 0) {
      const current = new Set(rowsOf<{ file_id: string }>(await db.execute(sql`SELECT file_id FROM document_attachments
        WHERE org_id = ${orgId} AND document_id = ${documentId} AND in_current = true`)).map((row) => row.file_id));
      const unlinked = fileIds.find((fileId) => !current.has(fileId) || !presentFiles.has(fileId));
      if (unlinked) return `${entry.source_type} ${entry.source_id}: image ${unlinked} in document ${documentId} can't be shown`;
    }
  }
  if (entry.source_type === 'note') {
    const [counts] = rowsOf<{ expected: number; moved: number }>(await db.execute(sql`
      SELECT (SELECT count(*)::int FROM note_versions WHERE note_id = ${entry.source_id}) AS expected,
        (SELECT count(*)::int FROM document_versions WHERE org_id = ${orgId} AND document_id = ${entry.target_id} AND kind = 'moved') AS moved`));
    if (counts && counts.expected !== counts.moved) return `note ${entry.source_id}: its history is incomplete`;
  }
  return null;
}
