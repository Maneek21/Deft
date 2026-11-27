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
//
// Fix round 5 (the controller's rule): draft text is a pending create_document's
// title and Markdown, a plan literal, and a create_note's or write_canvas's
// title and content. It reaches only the requester (the action's user_id),
// through documentTextParamsForViewer. Message metadata never keeps it
// (draftTextOmittedFromMetadata: the run keeps each text as its size; the card
// reads the action). Once the draft is a document, an action's result,
// after_state and receipt name it by document_id only
// (draftOutcomeReferences, draftToolInputForStorage), and its approval items
// say DOCUMENT_DRAFT_ITEM_BODY once it settles, and on read to anyone but the
// requester (lib/attention.ts, withReaderDraftItemBodies).
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { agentActions, attentionItems } from '@deft/db/schema';
import type { db as Db } from './db.js';
import { createDocumentInputForStorage, omittedText, storableRef } from './document-audience.js';

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
 * The actions whose params hold text written for a document: a document
 * draft, and the note and canvas aliases (F15), with their text fields.
 */
const DOCUMENT_TEXT_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  create_document: ['title', 'markdown'],
  create_note: ['title', 'content'],
  write_canvas: ['title', 'content'],
};

/** The draft tools (fix round 5): create_document, create_note and write_canvas. */
export const DRAFT_TEXT_ACTIONS: readonly string[] = Object.freeze(Object.keys(DOCUMENT_TEXT_ACTIONS));

/** True for an action whose params hold draft text (fix round 5). */
export function isDraftTextAction(action: unknown): boolean {
  return typeof action === 'string' && Object.hasOwn(DOCUMENT_TEXT_ACTIONS, action);
}

/**
 * For `UPDATE attention_items SET body = …`: a draft's approval item says
 * DOCUMENT_DRAFT_ITEM_BODY; any other item keeps its body (fix round 3, I3:
 * the reviewer-loss sweep and every transition to a settled state). Every
 * draft tool since fix round 5: a note's or canvas's too.
 */
export function draftItemBodySql(): SQL {
  return sql`(CASE WHEN ${attentionItems.kind} = 'approval' AND ${attentionItems.source_type} = 'agent_action'
    AND ${attentionItems.metadata} ->> 'action' IN (${sql.join(DRAFT_TEXT_ACTIONS.map((action) => sql`${action}`), sql`, `)})
    THEN ${DOCUMENT_DRAFT_ITEM_BODY}::text ELSE ${attentionItems.body} END)`;
}

/**
 * In the transaction that settles these actions (approved, rejected, expired
 * or cancelled: fix round 3, I3), every approval item of a draft tool among
 * them (create_document, and since fix round 5 create_note and write_canvas),
 * in any state, says DOCUMENT_DRAFT_ITEM_BODY: an item made before its body
 * was neutral never outlives the draft with its title. Any other action's
 * items are left as they are.
 */
export async function scrubDocumentDraftItems(executor: Pick<typeof Db, 'update'>, actionIds: readonly string[]): Promise<void> {
  if (actionIds.length === 0) return;
  await executor.update(attentionItems)
    .set({ body: DOCUMENT_DRAFT_ITEM_BODY })
    .where(and(
      eq(attentionItems.source_type, 'agent_action'),
      inArray(attentionItems.source_id, [...actionIds]),
      eq(attentionItems.kind, 'approval'),
      sql`${attentionItems.metadata} ->> 'action' IN (${sql.join(DRAFT_TEXT_ACTIONS.map((action) => sql`${action}`), sql`, `)})`,
      sql`${attentionItems.body} IS DISTINCT FROM ${DOCUMENT_DRAFT_ITEM_BODY}`,
    ));
}

/** The id params a neutral draft keeps (each only when id-shaped). */
const DRAFT_ID_KEYS = ['document_id', 'note_id', 'drive_id', 'folder_id', 'parent_document_id', 'source_message_id', 'visibility_space_id'];
const ID_SHAPE = new RegExp(ID_PATTERN);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True when `viewerId` may not see the text this action's params hold for a
 * document (fix round 4): a document draft, or a note or canvas alias, whose
 * requester (its `user_id`) is someone else, or a row read without its
 * `user_id`. Surfaces that show such text in their own words (an approval
 * item's body) use this; params go through documentTextParamsForViewer.
 */
export function documentTextHiddenFrom(row: { action: string; user_id?: string | null }, viewerId: string): boolean {
  return Object.hasOwn(DOCUMENT_TEXT_ACTIONS, row.action) && !(typeof row.user_id === 'string' && row.user_id === viewerId);
}

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
 *
 * Fix round 5: whoever reads it, a draft tool's `result`, `after_state` and
 * `before_state` are shown as references (draftOutcomeReferences), and once
 * it has run (`executed_at`) its params are too (draftToolInputForStorage):
 * it is a document then, named by its id, whose title each viewer reads
 * through their own access to it.
 */
export function documentTextParamsForViewer<T extends { action: string; params?: unknown; user_id?: string | null }>(row: T, viewerId: string): T {
  if (!isDraftTextAction(row.action)) return row;
  const outcomes: Record<string, unknown> = {};
  for (const key of ['result', 'after_state', 'before_state'] as const) {
    if (Object.hasOwn(row, key)) outcomes[key] = draftOutcomeReferences(row.action, (row as unknown as Record<string, unknown>)[key]);
  }
  const executed = (row as unknown as { executed_at?: unknown }).executed_at;
  if (executed !== undefined && executed !== null && Object.hasOwn(row, 'params')) {
    const documentId = outcomeDocumentId(Object.hasOwn(row, 'result') ? (row as unknown as Record<string, unknown>).result : null);
    return { ...row, ...outcomes, params: draftToolInputForStorage(row.action, row.params, documentId) };
  }
  if (!Object.hasOwn(row, 'params') || !documentTextHiddenFrom(row, viewerId)) return { ...row, ...outcomes };
  const fields = DOCUMENT_TEXT_ACTIONS[row.action]!;
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
  return { ...row, ...outcomes, params: { summary: `Document draft, ${bytes} bytes`, ...kept } };
}

const DOCUMENT_URL = /^\/d\/[A-Za-z0-9_.:-]{1,128}$/;

/** The document a draft tool's result names, when it names one. */
function outcomeDocumentId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return storableRef(value.document_id) ?? storableRef(value.canvas_document_id) ?? storableRef(value.note_id);
}

/**
 * A draft tool's input (or params) as a message, a run, a receipt or a
 * settled action keeps it (fix round 5): its ids, where it was to go, and
 * each text field as `{ document_id, content_omitted, content_bytes }`.
 * Rebuilt from an allowlist every time (fix round 1, I1), so a marker the
 * model sent carries nothing through. `documentId` names the document once
 * it exists. Any other action's input is returned as it is.
 *  - create_document: createDocumentInputForStorage (lib/document-audience.ts);
 *  - create_note: visibility, visibility_space_id, title and content sizes;
 *  - write_canvas: the room it names (space_name, resolved_space_id), title
 *    and content sizes.
 */
export function draftToolInputForStorage(action: string, input: unknown, documentId: string | null = null): unknown {
  if (!isDraftTextAction(action)) return input;
  if (action === DOCUMENT_DRAFT_ACTION) return createDocumentInputForStorage(input, documentId);
  const record = isRecord(input) ? input : {};
  const id = documentId ?? storableRef(record.document_id);
  const ref = (key: string) => (storableRef(record[key]) === null ? {} : { [key]: record[key] as string });
  const size = (key: string) => (record[key] === undefined || record[key] === null ? {} : { [key]: omittedText(record[key], id) });
  return {
    ...(id ? { document_id: id } : {}),
    ...(action === 'create_note'
      ? { ...(['private', 'org', 'space'].includes(record.visibility as string) ? { visibility: record.visibility } : {}), ...ref('visibility_space_id') }
      : { ...(typeof record.space_name === 'string' ? { space_name: record.space_name.slice(0, 200) } : {}), ...ref('resolved_space_id') }),
    ...ref('source_message_id'),
    ...size('title'),
    ...size('content'),
  };
}

/**
 * A draft tool's result, after_state or before_state as it is stored and
 * shown (fix round 5): references only, `{ document_id, note_id,
 * canvas_document_id, space_id, url, visibility, revision }` as each applies.
 * Any other action's value, and a value that isn't an object, is returned as
 * it is.
 */
export function draftOutcomeReferences(action: string, value: unknown): unknown {
  if (!isDraftTextAction(action) || !isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of ['document_id', 'note_id', 'canvas_document_id', 'space_id']) {
    const ref = storableRef(value[key]);
    if (ref) out[key] = ref;
  }
  if (typeof value.url === 'string' && DOCUMENT_URL.test(value.url)) out.url = value.url;
  if (['private', 'org', 'space'].includes(value.visibility as string)) out.visibility = value.visibility;
  if (typeof value.revision === 'number' && Number.isInteger(value.revision)) out.revision = value.revision;
  return out;
}

/**
 * A receipt as it is shown (fix round 5): a draft tool's receipt names the
 * document and the sizes, never a title or text, whenever it was signed.
 * The signature still covers what was stored (`verified` is computed from
 * the stored row before this projection); signing never authorizes showing.
 */
export function receiptForViewer<T extends { action_name?: unknown; action_params_json?: unknown; result_json?: unknown }>(receipt: T): T {
  if (!isDraftTextAction(receipt.action_name)) return receipt;
  const action = receipt.action_name as string;
  const result = draftOutcomeReferences(action, receipt.result_json ?? null);
  return {
    ...receipt,
    action_params_json: draftToolInputForStorage(action, receipt.action_params_json, outcomeDocumentId(result)),
    result_json: result,
  };
}

// ---------------------------------------------------------------------------
// Message metadata (fix round 5): a run's record of a draft tool's call holds
// each text as its size, wherever it is (the tool call's input, its result,
// the tool_calls list, the action graph, a clarification draft). The person
// who asked sees their draft on its card, which reads the action.

/** The tool name of a tool_calls entry or graph node, when it is a draft tool. */
function draftToolName(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) if (isDraftTextAction(value[key])) return value[key] as string;
  return null;
}

/** A draft tool's tool_result content, rebuilt to its status, ids and error. */
function draftToolResultContent(action: string, content: unknown): unknown {
  if (typeof content !== 'string') return content;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return content; }
  if (!isRecord(parsed)) return content;
  const kept: Record<string, unknown> = { ...(draftOutcomeReferences(action, parsed) as Record<string, unknown>) };
  if (typeof parsed.withheld === 'boolean') kept.withheld = parsed.withheld;
  for (const key of ['status', 'action_id', 'approval_tier', 'code', 'error', 'message']) {
    if (typeof parsed[key] === 'string') kept[key] = parsed[key];
  }
  return JSON.stringify(kept);
}

/** True for a tool_result content that is a create_note result (it alone has both `note_id` and `document_id`). */
function createNoteResult(content: unknown): boolean {
  if (typeof content !== 'string' || !content.includes('note_id')) return false;
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) && typeof parsed.note_id === 'string' && typeof parsed.document_id === 'string';
  } catch {
    return false;
  }
}

/** The hidden note a declined draft left for the model before fix round 5 named it. */
const LEGACY_REJECTED_DRAFT_TEXT = /^The user rejected the (create note|write canvas|create document) "[\s\S]*?" action\./;
const REJECTED_DRAFT_LABEL: Record<string, string> = {
  'create note': 'Defty\'s note draft', 'write canvas': 'Defty\'s canvas draft', 'create document': 'Defty\'s document draft',
};

function paramsWithoutDraftText(entry: unknown, ...nameKeys: string[]): unknown {
  if (!isRecord(entry)) return entry;
  const name = draftToolName(entry, ...nameKeys);
  if (!name) return entry;
  return {
    ...entry,
    ...(Object.hasOwn(entry, 'params') ? { params: draftToolInputForStorage(name, entry.params) } : {}),
    ...(Object.hasOwn(entry, 'input') ? { input: draftToolInputForStorage(name, entry.input) } : {}),
  };
}

/**
 * Message metadata without draft text (fix round 5): stored this way
 * (sanitizeAgentReplyActionMetadata) and projected this way for every reader
 * (projectAgentMessageMetadata), so a reply stored before is shown the same.
 * Every other key is kept as it is.
 */
export function draftTextOmittedFromMetadata<T>(metadata: T): T {
  if (!isRecord(metadata)) return metadata;
  const out: Record<string, unknown> = { ...metadata };
  if (Array.isArray(metadata.agent_blocks)) {
    const draftCalls = new Map<string, string>();
    for (const block of metadata.agent_blocks) {
      if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string' && isDraftTextAction(block.name)) draftCalls.set(block.id, block.name as string);
    }
    const rejection = Object.hasOwn(metadata, 'approval_rejection_result_for_action_id');
    out.agent_blocks = metadata.agent_blocks.map((block: unknown) => {
      if (!isRecord(block)) return block;
      if (block.type === 'tool_use' && isDraftTextAction(block.name)) return { ...block, input: draftToolInputForStorage(block.name as string, block.input) };
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        // Its call is in this message, or it is the hidden result an approval
        // stored for an approved create_note (routes/agent.ts), whose result
        // named the note's title before this round: `{ note_id, document_id, … }`.
        const action = draftCalls.get(block.tool_use_id) ?? (createNoteResult(block.content) ? 'create_note' : null);
        if (action) return { ...block, content: draftToolResultContent(action, block.content) };
      }
      if (rejection && block.type === 'text' && typeof block.text === 'string') {
        const legacy = LEGACY_REJECTED_DRAFT_TEXT.exec(block.text);
        if (legacy) return { ...block, text: `The user rejected the ${REJECTED_DRAFT_LABEL[legacy[1]!]} action.${block.text.slice(legacy[0].length)}` };
      }
      return block;
    });
  }
  if (Array.isArray(metadata.tool_calls)) out.tool_calls = metadata.tool_calls.map((call: unknown) => paramsWithoutDraftText(call, 'tool', 'name'));
  if (Array.isArray(metadata.pending_actions)) out.pending_actions = metadata.pending_actions.map((entry: unknown) => paramsWithoutDraftText(entry, 'action'));
  if (isRecord(metadata.action_graph) && Array.isArray(metadata.action_graph.actions)) {
    out.action_graph = { ...metadata.action_graph, actions: metadata.action_graph.actions.map((node: unknown) => paramsWithoutDraftText(node, 'tool', 'action')) };
  }
  if (isRecord(metadata.defty_pending)) {
    const pending = metadata.defty_pending;
    const actions = (list: unknown) => (Array.isArray(list) ? list.map((entry: unknown) => paramsWithoutDraftText(entry, 'action', 'tool')) : list);
    if (Array.isArray(pending.draft)) out.defty_pending = { ...pending, draft: actions(pending.draft) };
    else if (isRecord(pending.draft)) {
      const draft: Record<string, unknown> = { ...pending.draft };
      for (const key of ['actions', 'pendingActions']) if (Array.isArray(draft[key])) draft[key] = actions(draft[key]);
      out.defty_pending = { ...pending, draft };
    }
  }
  return out as unknown as T;
}
