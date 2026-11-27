// A create_document proposal that ends without running (M7 fix round 1, I3):
// rejected, expired or cancelled, its title and Markdown leave the action.
//
// While it waits, a proposal keeps its text, shown only to the person who
// asked (fix round 3: documentTextParamsForViewer; a fallback owner or admin
// reviewer sees "Document draft, N bytes", since nothing can show where the
// text came from). Once it settles any other way than approval, it keeps
// only a neutral summary, the byte counts and its ids, so the action history
// and its wider audience never hold the text.
// settledDocumentDraftParamsSql is the one expression every such status
// change writes (`params = …` in the same UPDATE): the reject route (web and
// personal MCP), the 24-hour approval TTL, the room rule, an employee's
// removal and a plan step whose input changed. It is the SQL form of
// createDocumentInputForStorage (lib/document-audience.ts). In the same
// transaction, each of those (and the approval claim) also sets the draft's
// approval items to DOCUMENT_DRAFT_ITEM_BODY (scrubDocumentDraftItems, fix
// round 3).
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { agentActions, attentionItems } from '@deft/db/schema';
import type { db as Db } from './db.js';

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

/**
 * For `UPDATE attention_items SET body = …`: a draft's approval item says
 * DOCUMENT_DRAFT_ITEM_BODY; any other item keeps its body (fix round 3, I3:
 * the reviewer-loss sweep and every transition to a settled state).
 */
export function draftItemBodySql(): SQL {
  return sql`(CASE WHEN ${attentionItems.kind} = 'approval' AND ${attentionItems.source_type} = 'agent_action'
    AND ${attentionItems.metadata} ->> 'action' = ${DOCUMENT_DRAFT_ACTION}
    THEN ${DOCUMENT_DRAFT_ITEM_BODY}::text ELSE ${attentionItems.body} END)`;
}

/**
 * In the transaction that settles these actions (approved, rejected, expired
 * or cancelled: fix round 3, I3), every approval item of a create_document
 * among them, in any state, says DOCUMENT_DRAFT_ITEM_BODY: an item made
 * before its body was neutral (fix round 2) never outlives the draft with
 * its title. Any other action's items are left as they are.
 */
export async function scrubDocumentDraftItems(executor: Pick<typeof Db, 'update'>, actionIds: readonly string[]): Promise<void> {
  if (actionIds.length === 0) return;
  await executor.update(attentionItems)
    .set({ body: DOCUMENT_DRAFT_ITEM_BODY })
    .where(and(
      eq(attentionItems.source_type, 'agent_action'),
      inArray(attentionItems.source_id, [...actionIds]),
      eq(attentionItems.kind, 'approval'),
      sql`${attentionItems.metadata} ->> 'action' = ${DOCUMENT_DRAFT_ACTION}`,
      sql`${attentionItems.body} IS DISTINCT FROM ${DOCUMENT_DRAFT_ITEM_BODY}`,
    ));
}

/**
 * The actions whose params hold text written for a document: a document
 * draft, and the note and canvas aliases (F15), with their text fields.
 */
const DOCUMENT_TEXT_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  create_document: ['title', 'markdown'],
  create_note: ['title', 'content'],
  write_canvas: ['title', 'content'],
};

/** The id params a neutral draft keeps (each only when id-shaped). */
const DRAFT_ID_KEYS = ['document_id', 'note_id', 'drive_id', 'folder_id', 'parent_document_id', 'source_message_id', 'visibility_space_id'];
const ID_SHAPE = new RegExp(ID_PATTERN);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * An action as `viewerId` may see it (fix round 3). A document draft's text
 * (a create_document's title and Markdown, a create_note's or write_canvas's
 * title and content, pending or settled) is shown only to the person who
 * asked for it (the action's `user_id`, who for a plan step is the plan's
 * creator). Nothing shows where that text came from (Defty may have copied
 * it from a document only they can open), so everyone else, a fallback
 * owner or admin reviewer included, sees "Document draft, N bytes", each
 * text field as its size, and its ids. They can still approve or reject it.
 * A row read without its `user_id` is shown the same way.
 */
export function documentTextParamsForViewer<T extends { action: string; params?: unknown; user_id?: string | null }>(row: T, viewerId: string): T {
  const fields = DOCUMENT_TEXT_ACTIONS[row.action];
  if (!fields || (typeof row.user_id === 'string' && row.user_id === viewerId)) return row;
  const params = isRecord(row.params) ? row.params : {};
  const kept: Record<string, unknown> = {};
  for (const key of DRAFT_ID_KEYS) {
    if (typeof params[key] === 'string' && ID_SHAPE.test(params[key] as string)) kept[key] = params[key];
  }
  if (['private', 'org', 'space'].includes(params.visibility as string)) kept.visibility = params.visibility;
  let bytes = 0;
  for (const field of fields) {
    const value = params[field];
    if (value === undefined || value === null) continue;
    const size = typeof value === 'string' ? Buffer.byteLength(value)
      : isRecord(value) && typeof value.content_bytes === 'number' && Number.isInteger(value.content_bytes) && value.content_bytes >= 0 ? value.content_bytes
      : Buffer.byteLength(JSON.stringify(value));
    bytes += size;
    kept[field] = { content_omitted: true, content_bytes: size };
  }
  return { ...row, params: { summary: `Document draft, ${bytes} bytes`, ...kept } };
}
