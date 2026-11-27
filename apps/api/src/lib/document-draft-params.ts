// A create_document proposal that ends without running (M7 fix round 1, I3):
// rejected, expired or cancelled, its title and Markdown leave the action.
//
// While it waits, a proposal keeps its text for its approval audience (the
// person who asked; owners and admins only when there is no active human
// requester, 13 Nov rule): no document exists yet. Once it settles any other
// way than approval, it keeps only a neutral summary, the byte counts and its
// ids, so the action history and its wider audience never hold the text.
// settledDocumentDraftParamsSql is the one expression every such status
// change writes (`params = …` in the same UPDATE): the reject route (web and
// personal MCP), the 24-hour approval TTL, the room rule, an employee's
// removal and a plan step whose input changed. It is the SQL form of
// createDocumentInputForStorage (lib/document-audience.ts).
import { sql, type SQL } from 'drizzle-orm';
import { agentActions } from '@deft/db/schema';

/** The action whose settled params lose their text. */
export const DOCUMENT_DRAFT_ACTION = 'create_document';

/** What a settled draft says in place of its title. */
export const SETTLED_DOCUMENT_DRAFT_SUMMARY = 'Document draft';

/**
 * What a draft's approval item says (fix round 2, I3): never its title,
 * pending or settled. The approval card shows the draft to its reviewer while
 * it waits; the item (and any push of it) outlives the draft, so it names
 * nothing, and an item that settles is set to this text again.
 */
export const DOCUMENT_DRAFT_ITEM_BODY = 'Document draft';

const ID_PATTERN = '^[A-Za-z0-9_.:-]{1,128}$';

/**
 * For `UPDATE agent_actions SET params = …`: a create_document row's params
 * as `{ summary, title: { content_omitted, content_bytes }, markdown: { … },
 * drive_id?, folder_id?, parent_document_id?, source_message_id? }` (an id
 * only when id-shaped); any other row's params unchanged.
 */
export function settledDocumentDraftParamsSql(): SQL {
  const params = sql`${agentActions.params}`;
  const id = (key: string) => sql`CASE WHEN jsonb_typeof(${params} -> ${key}::text) = 'string'
    AND (${params} ->> ${key}::text) ~ ${ID_PATTERN} THEN ${params} -> ${key}::text END`;
  const text = (key: string) => sql`CASE WHEN ${params} ? ${key}::text THEN jsonb_build_object('content_omitted', true,
    'content_bytes', octet_length(CASE WHEN jsonb_typeof(${params} -> ${key}::text) = 'string'
      THEN ${params} ->> ${key}::text ELSE (${params} -> ${key}::text)::text END)) END`;
  return sql`(CASE WHEN ${agentActions.action} = ${DOCUMENT_DRAFT_ACTION} THEN jsonb_strip_nulls(jsonb_build_object(
    'summary', ${SETTLED_DOCUMENT_DRAFT_SUMMARY}::text,
    'drive_id', ${id('drive_id')}, 'folder_id', ${id('folder_id')}, 'parent_document_id', ${id('parent_document_id')},
    'source_message_id', ${id('source_message_id')},
    'title', ${text('title')}, 'markdown', ${text('markdown')}))
  ELSE ${params} END)`;
}
