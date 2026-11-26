// The notes move (plan Task F14): the check run straight after the move
// (spec 5.11, "keeping that window short"), before the workspace is served
// (runs.ts records it; the API listens only once it passed). It reconciles
// everything, across the whole workspace:
// - every note, note folder and non-empty canvas has a map row of its own
//   workspace, and the document or folder it names exists there;
// - every part a map row records exists: the first is the mapped document,
//   each later one a sub-page of it in the same drive;
// - shares, exactly: each part holds the shares its source gave and no
//   other, at exactly that role (a note's note_shares, edit staying edit;
//   its chat as view for a space note; the author's edit for a workspace
//   note; a canvas's chat as edit; one per person or chat, the highest);
// - each note's version count matches its moved versions;
// - references: none still names a moved note; every reference the move
//   rewrote (recorded on its note's map row) names that note's document; and
//   every reference that names a document names one that exists;
// - images: every image in a part's content is linked to that part as
//   current, every image in a moved version is linked to that version's
//   document, and every linked file exists, row and bytes (the upgrade
//   container mounts the uploads volume read-only for this).
// Then it opens a sample (20 by default) of moved documents, every part:
// the live state they will load (ydoc_state, or the state built from
// content_json before the first load) reads back as exactly content_json, it
// is within the size cap, and Knowledge is off; for a note, each moved
// version is opened too (it is a valid document and reads back as itself),
// one at a time. The sample runs whatever the counts say. `ok` is true only
// when nothing is wrong. Messages carry ids and counts, never content.
import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { getDocumentSchema, jsonToYDoc, yDocToJson } from '@deft/doc-schema';
import { db } from '../db.js';
import { localFileStore } from '../file-store.js';
import { canvasHasContent, fitsSizeCap, measureContent, type JSONContent } from './convert-note.js';
import { rowsOf } from './placement.js';

export type PostMoveCheck = { orgId: string; ok: boolean; notesExpected: number; documentsMapped: number; mismatches: string[];
  sampleOpened: number; sampleFailed: string[] };

/** The documents a map row's details name (`parts`: the document and its sub-pages), else its target. */
const PARTS = sql.raw(`jsonb_array_elements_text(coalesce(m.details->'parts', jsonb_build_array(m.target_id))) WITH ORDINALITY part(document_id, ordinal)`);
/** The Deft files an image names in a document's JSON, as text. */
const IMAGE_FILE_IDS = `jsonb_path_query(%s, 'lax $.** ? (@.type == "image").attrs.fileId') AS image(file_id)`;
const imageFileIdsOf = (column: string) => sql.raw(IMAGE_FILE_IDS.replace('%s', column));
const CANVAS_PAGE = 100;

export async function postMoveCheck(orgId: string, sampleSize = 20): Promise<PostMoveCheck> {
  const mismatches: string[] = [];
  let notesExpected = 0;
  let documentsMapped = 0;

  // Every source has its map row, naming something that exists in this workspace.
  const sources: Array<{ table: 'notes' | 'note_folders'; type: string; target: 'documents' | 'doc_folders'; targetType: string }> = [
    { table: 'notes', type: 'note', target: 'documents', targetType: 'document' },
    { table: 'note_folders', type: 'note_folder', target: 'doc_folders', targetType: 'doc_folder' },
  ];
  const mapped = (table: string, type: string, target: string, targetType: string) => sql`
    SELECT src.id, m.id IS NOT NULL AS mapped,
      (m.org_id = src.org_id AND m.target_type = ${targetType} AND EXISTS (SELECT 1 FROM ${sql.raw(target)} target
        WHERE target.id = m.target_id AND target.org_id = src.org_id)) AS target_ok
    FROM ${sql.raw(table)} src
    LEFT JOIN note_document_map m ON m.source_type = ${type} AND m.source_id = src.id`;
  const tally = (type: string, row: { id: string; mapped: boolean; target_ok: boolean }) => {
    notesExpected += 1;
    if (!row.mapped) mismatches.push(`${type} ${row.id} has no map row`);
    else if (!row.target_ok) mismatches.push(`${type} ${row.id}: its target is missing or in another workspace`);
    else documentsMapped += 1;
  };
  for (const source of sources) {
    const rows = rowsOf<{ id: string; mapped: boolean; target_ok: boolean }>(await db.execute(sql`${mapped(source.table, source.type, source.target,
      source.targetType)} WHERE src.org_id = ${orgId}`));
    for (const row of rows) tally(source.type, row);
  }
  // Canvases a page at a time: whether one has content is decided in code.
  for (let after = ''; ;) {
    const page = rowsOf<{ id: string; mapped: boolean; target_ok: boolean; content: unknown }>(await db.execute(sql`
      SELECT page.*, (SELECT content FROM canvases WHERE id = page.id) AS content FROM (
        ${mapped('canvases', 'canvas', 'documents', 'document')} WHERE src.org_id = ${orgId} AND src.id > ${after}
        ORDER BY src.id LIMIT ${CANVAS_PAGE}) page`));
    for (const row of page) if (row.mapped || canvasHasContent(row.content)) tally('canvas', row);
    if (page.length < CANVAS_PAGE) break;
    after = page[page.length - 1]!.id;
  }

  // Every recorded part exists, in place.
  const parts = rowsOf<{ source_type: string; source_id: string; document_id: string; ordinal: number; present: boolean; placed: boolean }>(
    await db.execute(sql`SELECT m.source_type, m.source_id, part.document_id, part.ordinal::int AS ordinal,
        moved_doc.id IS NOT NULL AS present,
        (CASE WHEN part.ordinal = 1 THEN part.document_id = m.target_id
          ELSE moved_doc.parent_document_id = m.target_id AND moved_doc.drive_id = main_doc.drive_id END) AS placed
      FROM note_document_map m CROSS JOIN LATERAL ${PARTS}
      LEFT JOIN documents moved_doc ON moved_doc.id = part.document_id AND moved_doc.org_id = m.org_id
      LEFT JOIN documents main_doc ON main_doc.id = m.target_id AND main_doc.org_id = m.org_id
      WHERE m.org_id = ${orgId} AND m.target_type = 'document'`));
  for (const row of parts) {
    if (!row.present) mismatches.push(`${row.source_type} ${row.source_id}: part ${row.ordinal} (document ${row.document_id}) is missing`);
    else if (!row.placed) mismatches.push(`${row.source_type} ${row.source_id}: part ${row.ordinal} (document ${row.document_id}) is not in place`);
  }

  // Shares, exactly: what each source gave, on every part, and nothing else.
  const shareGaps = rowsOf<{ source_id: string; document_id: string; principal: string; want: number | null; have: number | null }>(await db.execute(sql`
    WITH expected_grant AS (
      SELECT n.id AS source_id, 'user' AS principal_type, share.shared_with_user_id AS principal_id,
        CASE WHEN share.permission = 'edit' THEN 3 ELSE 1 END AS rank
      FROM notes n JOIN note_shares share ON share.note_id = n.id
      JOIN org_members member ON member.org_id = n.org_id AND member.user_id = share.shared_with_user_id
      WHERE n.org_id = ${orgId}
      UNION ALL
      SELECT n.id, 'space', n.visibility_space_id, 1 FROM notes n JOIN spaces chat ON chat.id = n.visibility_space_id AND chat.org_id = n.org_id
      WHERE n.org_id = ${orgId} AND n.visibility = 'space'
      UNION ALL
      SELECT n.id, 'user', n.user_id, 3 FROM notes n JOIN org_members member ON member.org_id = n.org_id AND member.user_id = n.user_id
      WHERE n.org_id = ${orgId} AND n.visibility = 'org'
      UNION ALL
      SELECT c.id, 'space', c.space_id, 3 FROM canvases c JOIN spaces chat ON chat.id = c.space_id AND chat.org_id = c.org_id
      WHERE c.org_id = ${orgId}
    ), expected AS (
      SELECT source_id, principal_type, principal_id, max(rank) AS rank FROM expected_grant GROUP BY 1, 2, 3
    ), moved_part AS (
      SELECT m.source_id, part.document_id FROM note_document_map m CROSS JOIN LATERAL ${PARTS}
      WHERE m.org_id = ${orgId} AND m.source_type IN ('note', 'canvas') AND m.target_type = 'document'
    ), want AS (
      SELECT moved_part.source_id, moved_part.document_id, expected.principal_type, expected.principal_id, expected.rank
      FROM moved_part JOIN expected ON expected.source_id = moved_part.source_id
    ), have AS (
      SELECT moved_part.source_id, moved_part.document_id, granted.principal_type, granted.principal_id,
        CASE granted.role WHEN 'edit' THEN 3 WHEN 'comment' THEN 2 WHEN 'view' THEN 1 ELSE 0 END AS rank
      FROM moved_part JOIN document_shares granted ON granted.org_id = ${orgId} AND granted.document_id = moved_part.document_id
    )
    SELECT coalesce(want.source_id, have.source_id) AS source_id, coalesce(want.document_id, have.document_id) AS document_id,
      coalesce(want.principal_type, have.principal_type) || ' ' || coalesce(want.principal_id, have.principal_id) AS principal,
      want.rank AS want, have.rank AS have
    FROM want FULL OUTER JOIN have ON have.document_id = want.document_id AND have.principal_type = want.principal_type
      AND have.principal_id = want.principal_id
    WHERE want.rank IS DISTINCT FROM have.rank
    ORDER BY 1, 2, 3`));
  for (const row of shareGaps) {
    const what = row.want === null ? 'has an extra share for' : row.have === null ? 'lacks the share for' : 'has the wrong role for';
    mismatches.push(`source ${row.source_id}: document ${row.document_id} ${what} ${row.principal}`);
  }

  // Versions.
  const versionGaps = rowsOf<{ id: string; expected: number; moved: number }>(await db.execute(sql`
    SELECT n.id, (SELECT count(*)::int FROM note_versions v WHERE v.note_id = n.id) AS expected,
      (SELECT count(*)::int FROM document_versions dv WHERE dv.org_id = n.org_id AND dv.document_id = m.target_id AND dv.kind = 'moved') AS moved
    FROM notes n JOIN note_document_map m ON m.org_id = n.org_id AND m.source_type = 'note' AND m.source_id = n.id
    WHERE n.org_id = ${orgId}`)).filter((row) => row.expected !== row.moved);
  for (const row of versionGaps) mismatches.push(`note ${row.id}: ${row.expected} versions, ${row.moved} moved`);

  // References: nothing left naming a moved note; each rewritten row names its note's document; no document reference dangles.
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
  const rewritten = rowsOf<{ note_id: string; ref_table: string; ref_id: string }>(await db.execute(sql`
    SELECT m.source_id AS note_id, ref->>'table' AS ref_table, ref->>'id' AS ref_id
    FROM note_document_map m CROSS JOIN LATERAL jsonb_array_elements(coalesce(m.details->'rewritten_refs', '[]'::jsonb)) ref
    WHERE m.org_id = ${orgId} AND m.source_type = 'note'
      AND NOT (CASE ref->>'table'
        WHEN 'entity_tags' THEN EXISTS (SELECT 1 FROM entity_tags row_now WHERE row_now.id = ref->>'id' AND row_now.org_id = m.org_id
          AND row_now.entity_type = 'document' AND row_now.entity_id = m.target_id)
        WHEN 'cross_references' THEN EXISTS (SELECT 1 FROM cross_references row_now WHERE row_now.id = ref->>'id' AND row_now.org_id = m.org_id
          AND CASE WHEN ref->>'side' = 'source' THEN row_now.source_type = 'document' AND row_now.source_id = m.target_id
            ELSE row_now.target_type = 'document' AND row_now.target_id = m.target_id END)
        WHEN 'team_resources' THEN EXISTS (SELECT 1 FROM team_resources row_now WHERE row_now.id = ref->>'id' AND row_now.org_id = m.org_id
          AND row_now.resource_type = 'document' AND row_now.resource_id = m.target_id)
        WHEN 'attention_items' THEN EXISTS (SELECT 1 FROM attention_items row_now WHERE row_now.id = ref->>'id' AND row_now.org_id = m.org_id
          AND row_now.source_type = 'document' AND row_now.source_id = m.target_id)
        ELSE false END)
    ORDER BY 1, 2, 3`));
  for (const row of rewritten) mismatches.push(`${row.ref_table} row ${row.ref_id} no longer names the document of note ${row.note_id}`);

  // Images: in each part's content (linked as current), in each moved version (linked to its document), and every linked file present.
  const unlinkedCurrent = rowsOf<{ document_id: string; file_id: string }>(await db.execute(sql`
    SELECT DISTINCT part.document_id, image.file_id #>> '{}' AS file_id
    FROM note_document_map m CROSS JOIN LATERAL ${PARTS}
    JOIN documents moved_doc ON moved_doc.id = part.document_id AND moved_doc.org_id = m.org_id
    CROSS JOIN LATERAL ${imageFileIdsOf('moved_doc.content_json')}
    WHERE m.org_id = ${orgId} AND m.target_type = 'document' AND jsonb_typeof(image.file_id) = 'string'
      AND NOT EXISTS (SELECT 1 FROM document_attachments link WHERE link.org_id = m.org_id AND link.document_id = part.document_id
        AND link.file_id = image.file_id #>> '{}' AND link.in_current)
    ORDER BY 1, 2`));
  for (const row of unlinkedCurrent) mismatches.push(`image ${row.file_id}: not linked to document ${row.document_id}, which shows it`);
  const unlinkedHistory = rowsOf<{ document_id: string; file_id: string }>(await db.execute(sql`
    SELECT DISTINCT moved_version.document_id, image.file_id #>> '{}' AS file_id
    FROM note_document_map m
    JOIN document_versions moved_version ON moved_version.org_id = m.org_id AND moved_version.document_id = m.target_id
      AND moved_version.kind = 'moved'
    CROSS JOIN LATERAL ${imageFileIdsOf('moved_version.content_json')}
    WHERE m.org_id = ${orgId} AND m.source_type = 'note' AND jsonb_typeof(image.file_id) = 'string'
      AND NOT EXISTS (SELECT 1 FROM document_attachments link WHERE link.org_id = m.org_id AND link.document_id = moved_version.document_id
        AND link.file_id = image.file_id #>> '{}')
    ORDER BY 1, 2`));
  for (const row of unlinkedHistory) mismatches.push(`image ${row.file_id}: in the history of document ${row.document_id} but not linked to it`);
  const links = rowsOf<{ file_id: string; storage_key: string | null }>(await db.execute(sql`
    SELECT DISTINCT link.file_id, linked_file.storage_key
    FROM note_document_map m CROSS JOIN LATERAL ${PARTS}
    JOIN document_attachments link ON link.org_id = m.org_id AND link.document_id = part.document_id
    LEFT JOIN files linked_file ON linked_file.org_id = link.org_id AND linked_file.id = link.file_id
    WHERE m.org_id = ${orgId} AND m.target_type = 'document'
    ORDER BY link.file_id`));
  for (const link of links) {
    if (!link.storage_key) mismatches.push(`image ${link.file_id}: its file is missing`);
    else if (!(await bytesExist(link.storage_key))) mismatches.push(`image ${link.file_id}: its bytes are missing`);
  }

  // The sample.
  const sample = rowsOf<{ source_type: string; source_id: string; target_id: string; details: { parts?: string[] } | null }>(await db.execute(sql`
    SELECT m.source_type, m.source_id, m.target_id, m.details FROM note_document_map m
    WHERE m.org_id = ${orgId} AND m.target_type = 'document'
    ORDER BY random() LIMIT ${Math.max(0, Math.floor(sampleSize))}`));
  const sampleFailed: string[] = [];
  let sampleOpened = 0;
  for (const entry of sample) {
    const failure = await openSample(orgId, entry);
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

/** True when `json` is a valid document that reads back from its Yjs state as exactly itself. */
function opensAsItself(json: JSONContent, state: Buffer | null = null): boolean {
  const ydoc = state ? new Y.Doc() : null;
  let built: Y.Doc | null = null;
  try {
    getDocumentSchema().nodeFromJSON(json).check();
    if (ydoc && state) Y.applyUpdate(ydoc, new Uint8Array(state));
    else built = jsonToYDoc(json);
    return isDeepStrictEqual(yDocToJson((ydoc ?? built)!), json);
  } catch {
    return false;
  } finally {
    ydoc?.destroy();
    built?.destroy();
  }
}

/** One sampled source opened as a person would, its history too: null when every part is right, else what isn't. */
async function openSample(orgId: string, entry: { source_type: string; source_id: string; target_id: string; details: { parts?: string[] } | null }):
  Promise<string | null> {
  const parts = Array.isArray(entry.details?.parts) && entry.details!.parts.length > 0 ? entry.details!.parts : [entry.target_id];
  for (const documentId of parts) {
    const [doc] = rowsOf<{ content_json: JSONContent; ydoc_state: Buffer | null; use_in_knowledge: boolean | null }>(await db.execute(sql`
      SELECT content_json, ydoc_state, use_in_knowledge FROM documents WHERE id = ${documentId} AND org_id = ${orgId}`));
    if (!doc) return `${entry.source_type} ${entry.source_id}: document ${documentId} is missing`;
    if (doc.use_in_knowledge !== false) return `${entry.source_type} ${entry.source_id}: document ${documentId} has Knowledge on`;
    if (!opensAsItself(doc.content_json, doc.ydoc_state)) {
      return `${entry.source_type} ${entry.source_id}: document ${documentId} does not open as its stored content`;
    }
    if (!fitsSizeCap(measureContent(doc.content_json).bound)) return `${entry.source_type} ${entry.source_id}: document ${documentId} is over the size cap`;
  }
  if (entry.source_type === 'note') {
    const versionIds = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM document_versions
      WHERE org_id = ${orgId} AND document_id = ${entry.target_id} AND kind = 'moved' ORDER BY created_at, id`));
    for (const { id } of versionIds) {
      const [version] = rowsOf<{ content_json: JSONContent }>(await db.execute(sql`SELECT content_json FROM document_versions WHERE id = ${id}`));
      if (!version || !opensAsItself(version.content_json)) return `note ${entry.source_id}: moved version ${id} does not open`;
    }
  }
  return null;
}
