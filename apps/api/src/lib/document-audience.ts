// Defty's document tools in a shared conversation: the shared-chat rule
// (spec 5.7; plan Task M3, with the 25 Nov consult's changes; consult rule C4).
//
// Defty reads documents with the access of the person who asked
// (lib/document-access.ts; lib/agent-document-tools.ts). What it reads can
// end up in its reply, and a reply in a chat is read by everyone there. So:
//
// - The audience of a conversation is every member of its chat who could
//   hold document access: an active human member of the workspace, or an
//   agent user whose own employee is active (canHoldDocumentAccessSql, the
//   access check's actor rule). Defty's own user never counts, nor does a
//   member who left, a paused employee or a system user. The asker counts.
// - A conversation is shared when that audience has anyone but the asker. A
//   DM with only the asker and Defty is private. No conversation (a run with
//   no chat) is private: the answer goes back to the asker alone. A
//   conversation id that is no chat of the workspace is shared with nobody
//   known, so everything is withheld (fail closed).
// - In a shared conversation, every document tool result is held to the
//   audience before the model sees it (holdDocumentToolResponse): a document
//   not everyone there can open, and a drive not everyone there can see,
//   comes back as `{ id, withheld: true }` and nothing else (no title,
//   snippet, Markdown or drive name), and a shown document's drive is named
//   only when everyone there can see that drive. The tools held are the three
//   document tools and the old note and canvas tools, which read documents
//   since F15. Every edit reply (M7) is held the same way.
// - The audience is checked again when the reply is written (fix round 1):
//   each tool reports what it showed the model (`shown`), and the reply
//   transaction re-checks those against the chat's audience as it is then
//   (documentsNoLongerShown), under the reply guard. If someone joined, an
//   employee resumed, or a grant was removed so that not everyone can open
//   something the model read, the generated reply isn't posted: the room gets
//   AUDIENCE_CHANGED_REPLY instead, which carries no document content, and
//   nothing is regenerated (workers/handlers/agent-reply.ts).
// - After the reply, the asker is told privately, in their own DM with
//   Defty, which documents were left out (sendWithheldDocumentNotice): once
//   per reply, all of them in one message, named only as the asker can see
//   them then. The notice is a job enqueued in the reply's own transaction
//   (enqueueWithheldDocumentNotice), so a reply that fails, is cancelled or
//   loses its lease sends none.
// - Only answer text carries over to later turns: history replays messages'
//   text and durable action results, never a read's result, which a run
//   never stores but as references. An earlier answer already in the room
//   may be re-used (owner, 25 Nov).
// - What a run keeps (consult rule C4): a document tool call's input and
//   result are stored as references only, `{ document_id, block_ids,
//   withheld }`, never Markdown, snippets or titles
//   (documentToolCallForStorage), and a document citation keeps no title
//   (citationForStorage). Run details name a document only to a viewer who
//   can open it now (lib/agent-message-run-details.ts).
//
// People who join a chat later can read Defty's earlier answers there, the
// same as a person's message quoting a document (owner, 25 Nov).
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { documents, drives } from '@deft/db/documents';
import { messages, spaces, users } from '@deft/db/schema';
import { db } from './db.js';
import {
  canHoldDocumentAccessSql, visibleDocumentCondition, visibleDocumentIdSql, visibleDriveCondition, visibleDriveIdSql,
} from './document-access.js';
import { ensureDeftyDm, ensureDeftyMembership, DEFTY_NAME } from './ensure-defty-membership.js';

export type DocumentAudience = {
  /** True when the audience has anyone but the asker. */
  shared: boolean;
  /** The conversation's chat, or null (no conversation, or none in this workspace). */
  spaceId: string | null;
  /** The chat's members who could hold document access, the asker included; sorted. */
  audienceUserIds: string[];
};

/** A document or a drive a tool's result names. */
export type DocumentRef = { type: 'document' | 'drive'; id: string };
/** Something a tool left out of a shared conversation's result. */
export type WithheldRef = DocumentRef;

/** What the room gets instead of a reply when who can see something the model read changed before it was written. */
export const AUDIENCE_CHANGED_REPLY = 'I couldn\'t answer here because who can see this changed. Please ask again.';

/** The reply's audience can no longer open (or see) `refs`, which the model read: the reply must not be written. */
export class DocumentAudienceChangedError extends Error {
  constructor(readonly refs: DocumentRef[]) {
    super('The conversation\'s audience changed since the documents were read');
    this.name = 'DocumentAudienceChangedError';
  }
}

/** The tools whose results are documents and drives, held to a shared conversation's audience. */
export const AUDIENCE_HELD_TOOLS: ReadonlySet<string> = new Set([
  'search_documents', 'read_document', 'list_drive', 'search_notes', 'read_note', 'read_canvas',
]);

type Executor = Pick<typeof db, 'execute'>;
type Citation = { type: string; id: string; title?: string; url?: string };

const isRecord = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const withheldItem = (id: string) => ({ id, withheld: true as const });

/**
 * The statement documentAudienceForConversation runs: the chat `spaceId` of
 * `orgId` (one row with a null user when it has nobody who counts), and each
 * member who could hold document access. Exported for its planning test.
 */
export function documentAudienceQuery(orgId: string, spaceId: string): SQL {
  return sql`SELECT audience_chat.id AS space_id, audience_seat.user_id
    FROM spaces audience_chat
    LEFT JOIN space_members audience_seat ON audience_seat.space_id = audience_chat.id
      AND ${canHoldDocumentAccessSql(sql.raw('audience_seat.user_id'), orgId)}
    WHERE audience_chat.id = ${spaceId} AND audience_chat.org_id = ${orgId}
    ORDER BY audience_seat.user_id`;
}

/**
 * Who reads Defty's answer in the conversation `conversationId` (a chat of
 * `orgId`) asked by `askerId`, and whether that is anyone but the asker (the
 * header).
 */
export async function documentAudienceForConversation(
  orgId: string, conversationId: string | null, askerId: string, executor: Executor = db,
): Promise<DocumentAudience> {
  if (!conversationId) return { shared: false, spaceId: null, audienceUserIds: [askerId] };
  const rows = (await executor.execute(documentAudienceQuery(orgId, conversationId))).rows as Array<{ space_id: string; user_id: string | null }>;
  if (rows.length === 0) return { shared: true, spaceId: null, audienceUserIds: [] };
  const audienceUserIds = [...new Set(rows.flatMap((row) => (row.user_id ? [row.user_id] : [])))].sort();
  return { shared: audienceUserIds.some((id) => id !== askerId), spaceId: rows[0]!.space_id, audienceUserIds };
}

/** The statement documentsOpenableByAll runs. Exported for its planning test. */
export function documentsOpenableByAllQuery(orgId: string, documentIds: readonly string[], audienceUserIds: readonly string[]): SQL {
  return sql`SELECT audience_doc.id FROM documents audience_doc
    WHERE audience_doc.org_id = ${orgId} AND audience_doc.id = ANY(${sql.param([...documentIds])}::text[])
      AND audience_doc.is_deleted = false
      AND NOT EXISTS (SELECT 1 FROM unnest(${sql.param([...audienceUserIds])}::text[]) audience_member(user_id)
        WHERE NOT ${visibleDocumentIdSql(sql.raw('audience_member.user_id'), orgId, sql.raw('audience_doc.id'))})`;
}

/**
 * Which of `documentIds` (documents of `orgId`) every one of
 * `audienceUserIds` can open now, through the one access check. One
 * statement for all of them. An empty audience proves nothing, so no
 * document is returned for it.
 */
export async function documentsOpenableByAll(
  orgId: string, documentIds: string[], audienceUserIds: string[], executor: Executor = db,
): Promise<Set<string>> {
  const ids = [...new Set(documentIds)];
  const audience = [...new Set(audienceUserIds)];
  if (ids.length === 0 || audience.length === 0) return new Set();
  const rows = (await executor.execute(documentsOpenableByAllQuery(orgId, ids, audience))).rows as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/** The statement drivesVisibleToAll runs. Exported for its planning test. */
export function drivesVisibleToAllQuery(orgId: string, driveIds: readonly string[], audienceUserIds: readonly string[]): SQL {
  return sql`SELECT audience_drive.id FROM drives audience_drive
    WHERE audience_drive.org_id = ${orgId} AND audience_drive.id = ANY(${sql.param([...driveIds])}::text[])
      AND audience_drive.is_deleted = false
      AND NOT EXISTS (SELECT 1 FROM unnest(${sql.param([...audienceUserIds])}::text[]) audience_member(user_id)
        WHERE NOT ${visibleDriveIdSql(sql.raw('audience_member.user_id'), orgId, sql.raw('audience_drive.id'))})`;
}

/** Which of `driveIds` every one of `audienceUserIds` can see now, as documentsOpenableByAll. */
export async function drivesVisibleToAll(
  orgId: string, driveIds: string[], audienceUserIds: string[], executor: Executor = db,
): Promise<Set<string>> {
  const ids = [...new Set(driveIds)];
  const audience = [...new Set(audienceUserIds)];
  if (ids.length === 0 || audience.length === 0) return new Set();
  const rows = (await executor.execute(drivesVisibleToAllQuery(orgId, ids, audience))).rows as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

// ---------------------------------------------------------------------------
// Holding a tool's result to the audience.

const ids = (values: unknown[]): string[] => values.flatMap((value) => (isRecord(value) && typeof value.id === 'string' ? [value.id] : []));

/** The documents and drives a document tool's result names, by the tool's own shape. */
function referencesOf(toolName: string, result: Record<string, any>): { documentIds: string[]; driveIds: string[] } {
  switch (toolName) {
    case 'read_document':
      return { documentIds: typeof result.id === 'string' ? [result.id] : [], driveIds: isRecord(result.drive) ? ids([result.drive]) : [] };
    case 'read_note':
      return { documentIds: typeof result.id === 'string' ? [result.id] : [], driveIds: [] };
    case 'read_canvas':
      return { documentIds: isRecord(result.canvas) ? ids([result.canvas]) : [], driveIds: [] };
    case 'search_documents': {
      const rows: unknown[] = Array.isArray(result.documents) ? result.documents : [];
      return {
        documentIds: ids(rows),
        driveIds: rows.flatMap((row) => (isRecord(row) && typeof row.drive_id === 'string' ? [row.drive_id] : [])),
      };
    }
    case 'search_notes':
      return { documentIds: ids(Array.isArray(result.notes) ? result.notes : []), driveIds: [] };
    case 'list_drive':
      return {
        documentIds: ids(Array.isArray(result.documents) ? result.documents : []),
        driveIds: [...ids(Array.isArray(result.drives) ? result.drives : []), ...(isRecord(result.drive) ? ids([result.drive]) : [])],
      };
    default:
      return { documentIds: [], driveIds: [] };
  }
}

const rowsOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * What a document tool's result (as the model is given it) shows of the
 * documents and drives it names: each document whose title or content is in
 * it, and each drive it names. Withheld items show nothing.
 */
function shownRefs(toolName: string, result: unknown): DocumentRef[] {
  if (!AUDIENCE_HELD_TOOLS.has(toolName) || !isRecord(result) || 'error' in result || result.withheld === true) return [];
  const shown = new Map<string, DocumentRef>();
  const document = (row: unknown) => {
    if (isRecord(row) && typeof row.id === 'string' && row.withheld !== true) shown.set(`document:${row.id}`, { type: 'document', id: row.id });
  };
  const drive = (id: unknown) => {
    if (typeof id === 'string') shown.set(`drive:${id}`, { type: 'drive', id });
  };
  switch (toolName) {
    case 'read_document':
      document(result);
      if (isRecord(result.drive)) drive(result.drive.id);
      break;
    case 'read_note':
      document(result);
      break;
    case 'read_canvas':
      if (isRecord(result.canvas)) document(result.canvas);
      break;
    case 'search_documents':
      for (const row of rowsOf(result.documents)) {
        document(row);
        if (isRecord(row) && row.withheld !== true && typeof row.drive_name === 'string') drive(row.drive_id);
      }
      break;
    case 'search_notes':
      rowsOf(result.notes).forEach(document);
      break;
    case 'list_drive':
      if (isRecord(result.drive)) {
        drive(result.drive.id);
        rowsOf(result.documents).forEach(document);
      } else {
        for (const row of rowsOf(result.drives)) if (isRecord(row) && row.withheld !== true) drive(row.id);
      }
      break;
  }
  return [...shown.values()];
}

/**
 * Which of `shown` (what the model read during a run in the chat `spaceId`)
 * the chat's audience as it is now can't all open, or see: the reply's
 * check at write time (the header). Run in the reply's transaction
 * (`executor`), under its guard. Empty when everything may still be shown.
 */
export async function documentsNoLongerShown(
  orgId: string, spaceId: string, askerId: string, shown: readonly DocumentRef[], executor: Executor = db,
): Promise<DocumentRef[]> {
  if (shown.length === 0) return [];
  const audience = await documentAudienceForConversation(orgId, spaceId, askerId, executor);
  const documentIds = shown.filter((ref) => ref.type === 'document').map((ref) => ref.id);
  const driveIds = shown.filter((ref) => ref.type === 'drive').map((ref) => ref.id);
  // One statement at a time: a transaction runs on one connection.
  const openable = await documentsOpenableByAll(orgId, documentIds, audience.audienceUserIds, executor);
  const visible = await drivesVisibleToAll(orgId, driveIds, audience.audienceUserIds, executor);
  return shown.filter((ref) => (ref.type === 'document' ? !openable.has(ref.id) : !visible.has(ref.id)));
}

/**
 * A document tool's response (`{ result, citations }`, as executeToolCall
 * returns it) held to the audience of `conversationId` (the header): in a
 * shared conversation, what not everyone there can open is replaced by
 * `{ id, withheld: true }`, its citation dropped, and listed in `withheld`.
 * A private conversation, an error result, or a tool that isn't held gets
 * the response back as it is, with nothing withheld. `shown` lists what the
 * result given back shows (shownRefs), for the reply's check at write time.
 */
export async function holdDocumentToolResponse<T extends { result: any; citations: Citation[] }>(input: {
  orgId: string; askerId: string; conversationId?: string | null; toolName: string; response: T;
}): Promise<T & { withheld: WithheldRef[]; shown: DocumentRef[] }> {
  const { response, toolName } = input;
  const unchanged = { ...response, withheld: [] as WithheldRef[], shown: shownRefs(toolName, response.result) };
  const result = response.result;
  if (!AUDIENCE_HELD_TOOLS.has(toolName) || !isRecord(result) || 'error' in result || result.withheld === true) return unchanged;
  const refs = referencesOf(toolName, result);
  if (refs.documentIds.length === 0 && refs.driveIds.length === 0) return unchanged;
  const audience = await documentAudienceForConversation(input.orgId, input.conversationId ?? null, input.askerId);
  if (!audience.shared) return unchanged;
  const [openable, visibleDrives] = await Promise.all([
    documentsOpenableByAll(input.orgId, refs.documentIds, audience.audienceUserIds),
    drivesVisibleToAll(input.orgId, refs.driveIds, audience.audienceUserIds),
  ]);

  const withheld: WithheldRef[] = [];
  const holdDocument = (id: string) => {
    if (!withheld.some((ref) => ref.type === 'document' && ref.id === id)) withheld.push({ type: 'document', id });
    return withheldItem(id);
  };
  const holdDrive = (id: string) => {
    if (!withheld.some((ref) => ref.type === 'drive' && ref.id === id)) withheld.push({ type: 'drive', id });
    return withheldItem(id);
  };
  const documentRows = (rows: unknown[], shape?: (row: Record<string, any>) => Record<string, any>) => rows.map((row) => {
    if (!isRecord(row) || typeof row.id !== 'string') return row;
    if (!openable.has(row.id)) return holdDocument(row.id);
    return shape ? shape(row) : row;
  });

  let held: unknown = result;
  switch (toolName) {
    case 'read_document':
      held = !openable.has(result.id) ? holdDocument(result.id)
        : isRecord(result.drive) && !visibleDrives.has(result.drive.id) ? { ...result, drive: null } : result;
      break;
    case 'read_note':
      held = openable.has(result.id) ? result : holdDocument(result.id);
      break;
    case 'read_canvas':
      held = openable.has(result.canvas.id) ? result : holdDocument(result.canvas.id);
      break;
    case 'search_documents':
      held = {
        ...result,
        documents: documentRows(result.documents, (row) => (typeof row.drive_id === 'string' && !visibleDrives.has(row.drive_id)
          ? { ...row, drive_name: null } : row)),
      };
      break;
    case 'search_notes':
      held = { ...result, notes: documentRows(result.notes) };
      break;
    case 'list_drive':
      if (isRecord(result.drive) && typeof result.drive.id === 'string') {
        held = visibleDrives.has(result.drive.id)
          ? { ...result, documents: documentRows(Array.isArray(result.documents) ? result.documents : []) }
          : holdDrive(result.drive.id);
      } else if (Array.isArray(result.drives)) {
        held = {
          ...result,
          drives: result.drives.map((drive: unknown) => (isRecord(drive) && typeof drive.id === 'string' && !visibleDrives.has(drive.id)
            ? holdDrive(drive.id) : drive)),
        };
      }
      break;
  }
  const withheldDocuments = new Set(withheld.filter((ref) => ref.type === 'document').map((ref) => ref.id));
  return {
    ...response,
    result: held,
    citations: response.citations.filter((citation) => !(citation.type === 'document' && withheldDocuments.has(citation.id))),
    withheld,
    shown: shownRefs(toolName, held),
  } as T & { withheld: WithheldRef[]; shown: DocumentRef[] };
}

// ---------------------------------------------------------------------------
// What a run stores (consult rule C4).

/** The tools whose calls documentToolCallForStorage keeps as references. */
const DOCUMENT_READ_TOOLS: ReadonlySet<string> = AUDIENCE_HELD_TOOLS;

const stringField = (record: Record<string, any>, key: string) => (typeof record[key] === 'string' ? { [key]: record[key] } : {});

/** The `<!-- block:<id> -->` ids of read_document's Markdown, as its result lists them. */
function blockIdsOf(result: Record<string, any>): string[] {
  return Array.isArray(result.block_ids) ? result.block_ids.filter((id: unknown): id is string => typeof id === 'string') : [];
}

/** A row of a held result as a reference: the document, and whether it was withheld. */
function documentReference(row: unknown): unknown {
  if (!isRecord(row) || typeof row.id !== 'string') return null;
  return { document_id: row.id, withheld: row.withheld === true };
}

function driveReference(row: unknown): unknown {
  if (!isRecord(row) || typeof row.id !== 'string') return null;
  return { drive_id: row.id, withheld: row.withheld === true };
}

/** A tool's result as the run keeps it: references only. An error is kept as it is (it holds no content). */
function resultForStorage(toolName: string, result: unknown): unknown {
  if (!isRecord(result)) return result;
  if ('error' in result) return { ...stringField(result, 'error'), ...stringField(result, 'code') };
  switch (toolName) {
    case 'read_document':
      return result.withheld === true
        ? { document_id: result.id, withheld: true }
        : { document_id: result.id, block_ids: blockIdsOf(result), withheld: false };
    case 'read_note':
      return { document_id: result.id, withheld: result.withheld === true };
    case 'read_canvas':
      return result.withheld === true ? { document_id: result.id, withheld: true }
        : isRecord(result.canvas) ? { document_id: result.canvas.id, withheld: false } : { document_id: null, withheld: false };
    case 'search_documents':
      return { documents: (Array.isArray(result.documents) ? result.documents : []).map(documentReference) };
    case 'search_notes':
      return { documents: (Array.isArray(result.notes) ? result.notes : []).map(documentReference) };
    case 'list_drive':
      if (result.withheld === true) return { drive_id: result.id, withheld: true };
      if (Array.isArray(result.drives)) return { drives: result.drives.map(driveReference) };
      return {
        drive_id: isRecord(result.drive) ? result.drive.id : null,
        ...(isRecord(result.folder) ? { folder_id: result.folder.id } : {}),
        documents: (Array.isArray(result.documents) ? result.documents : []).map(documentReference),
      };
    default:
      return result;
  }
}

/** A tool's input as the run keeps it: its ids, never a search's words. */
function inputForStorage(toolName: string, input: unknown): unknown {
  if (!isRecord(input)) return input;
  switch (toolName) {
    case 'read_document':
      return stringField(input, 'document_id');
    case 'read_note':
      return stringField(input, 'note_id');
    case 'list_drive':
      return { ...stringField(input, 'drive_id'), ...stringField(input, 'folder_id') };
    case 'search_documents':
    case 'search_notes': {
      if (input.query_omitted === true) return input;
      const query = typeof input.query === 'string' ? input.query : '';
      const { query: _query, ...rest } = input;
      return { ...rest, query_omitted: true, query_bytes: Buffer.byteLength(query) };
    }
    default:
      return input;
  }
}

/**
 * A document read tool's call as a run records it (rule C4, at write time,
 * the read-side counterpart of F15's toolInputWithContentOmitted): the input
 * keeps its ids and leaves out a search's words; the result keeps
 * `{ document_id, block_ids, withheld }` for a read, a list of
 * `{ document_id, withheld }` for a search or a drive listing, and
 * `{ drive_id, withheld }` for each listed drive. Any other tool is returned
 * as it is.
 */
export function documentToolCallForStorage(toolName: string, input: unknown, result: unknown): { input: unknown; result: unknown } {
  if (!DOCUMENT_READ_TOOLS.has(toolName)) return { input, result };
  return { input: inputForStorage(toolName, input), result: resultForStorage(toolName, result) };
}

/**
 * A citation as a run records it: a document's keeps its id and link, never
 * its title, which the run-details projection adds back for a viewer who can
 * open it then (agent-message-run-details.ts). Any other citation is
 * returned as it is.
 */
export function citationForStorage<T>(citation: T): T {
  if (!isRecord(citation) || citation.type !== 'document' || typeof citation.id !== 'string') return citation;
  return { type: 'document', id: citation.id, url: typeof citation.url === 'string' ? citation.url : `/d/${citation.id}` } as T;
}

// ---------------------------------------------------------------------------
// The private notice.

/** "a", "a and b", "a, b and c". */
function listOf(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** The notice's text: one message for everything left out of one reply. */
export function withheldNoticeText(labels: string[], chatName: string): string {
  return labels.length === 1
    ? `I didn't quote ${labels[0]} in #${chatName} because not everyone there can open it.`
    : `I didn't quote ${listOf(labels)} in #${chatName} because not everyone there can open them.`;
}

/**
 * Tells the asker, in their own DM with Defty and as Defty, which documents
 * and drives were left out of a reply in the shared chat `spaceId`
 * (the header). Each is named as the asker can see it now: one they can no
 * longer open is left out of the notice too, and with nothing left no
 * notice is sent. `replyKey` names the reply (the chat and the message it
 * answers): a notice already sent for it isn't sent again, so a redelivered
 * run doesn't repeat it. The message's metadata keeps references only.
 * Returns the notice's id, or null when none was sent.
 */
export async function sendWithheldDocumentNotice(input: {
  orgId: string; askerId: string; spaceId: string; withheld: readonly WithheldRef[]; replyKey: string;
}): Promise<string | null> {
  const { orgId, askerId, spaceId } = input;
  const unique = [...new Map(input.withheld.map((ref) => [`${ref.type}:${ref.id}`, ref])).values()];
  const documentIds = unique.filter((ref) => ref.type === 'document').map((ref) => ref.id);
  const driveIds = unique.filter((ref) => ref.type === 'drive').map((ref) => ref.id);
  if (unique.length === 0) return null;
  const [chat] = await db.select({ name: spaces.name }).from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, orgId))).limit(1);
  if (!chat) return null;
  const [titles, driveNames] = await Promise.all([
    documentIds.length === 0 ? [] : db.select({ id: documents.id, title: documents.title }).from(documents)
      .where(and(inArray(documents.id, documentIds), visibleDocumentCondition(askerId, orgId))),
    driveIds.length === 0 ? [] : db.select({ id: drives.id, name: drives.name }).from(drives)
      .where(and(inArray(drives.id, driveIds), visibleDriveCondition(askerId, orgId))),
  ]);
  const titleOf = new Map(titles.map((row) => [row.id, row.title.trim() || 'Untitled']));
  const driveOf = new Map(driveNames.map((row) => [row.id, row.name]));
  const shown = unique.filter((ref) => (ref.type === 'document' ? titleOf.has(ref.id) : driveOf.has(ref.id)));
  if (shown.length === 0) return null;
  const labels = shown.map((ref) => (ref.type === 'document' ? titleOf.get(ref.id)! : `the ${driveOf.get(ref.id)!} drive`));

  const dmId = await ensureDeftyDm(orgId, askerId);
  if (!dmId || dmId === spaceId) return null;
  const deftyId = await ensureDeftyMembership(orgId);
  const noticeKey = `documents_withheld:${input.replyKey}`;
  const notice = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`defty-notice:${orgId}:${dmId}:${noticeKey}`}, 0))`);
    const [existing] = await tx.select({ id: messages.id }).from(messages).where(and(
      eq(messages.org_id, orgId), eq(messages.space_id, dmId), eq(messages.user_id, deftyId),
      sql`${messages.metadata}->>'defty_notice_key' = ${noticeKey}`,
    )).limit(1);
    if (existing) return null;
    const [inserted] = await tx.insert(messages).values({
      org_id: orgId,
      space_id: dmId,
      user_id: deftyId,
      content: withheldNoticeText(labels, chat.name),
      metadata: {
        defty_notice: 'documents_withheld',
        defty_notice_key: noticeKey,
        source_space_id: spaceId,
        withheld: shown.map((ref) => (ref.type === 'document' ? { document_id: ref.id } : { drive_id: ref.id })),
      } as never,
    }).returning();
    return inserted ?? null;
  });
  if (!notice) return null;
  try {
    // Loaded here: the tool path (agent-context.ts) imports this module and needs neither.
    const [{ getIO }, { emitMessageToSpaceViewers }] = await Promise.all([import('../socket.js'), import('./agent-message-run-details.js')]);
    const io = getIO();
    if (io) {
      const [defty] = await db.select({ name: users.name, avatar_url: users.avatar_url }).from(users).where(eq(users.id, deftyId)).limit(1);
      await emitMessageToSpaceViewers(io, {
        orgId, spaceId: dmId, event: 'message:new',
        message: { ...notice, user_name: defty?.name ?? DEFTY_NAME, user_avatar: defty?.avatar_url ?? null, reactions: [], reply_count: 0, latest_reply_at: null },
      });
    }
  } catch {
    console.warn('[document-audience] The notice was saved but its broadcast failed');
  }
  return notice.id;
}

/** The job that sends the notice once the reply is written (workers/handlers/defty-document-notice.ts). */
export const DOCUMENT_NOTICE_JOB = 'defty-document-notice';
/** The most items one notice names. */
const MAX_NOTICE_ITEMS = 50;

export type DocumentNoticeJobData = { orgId: string; askerId: string; spaceId: string; withheld: DocumentRef[]; replyKey: string };

/**
 * Queues the asker's notice in the reply's own transaction (`executor`), so
 * it is sent only once the reply is written: a reply that rolls back (it
 * failed, was cancelled, or lost its lease) queues nothing. The job's data
 * is references only. One job per reply (`replyKey`, the chat and the
 * message it answers): that reply is written once, so the key is never used
 * for a second run (consult rule C1).
 */
export async function enqueueWithheldDocumentNotice(executor: Executor, notice: DocumentNoticeJobData): Promise<void> {
  const withheld = [...new Map(notice.withheld.map((ref) => [`${ref.type}:${ref.id}`, { type: ref.type, id: ref.id }])).values()]
    .slice(0, MAX_NOTICE_ITEMS);
  if (withheld.length === 0) return;
  const { enqueue, QUEUE_NAMES } = await import('./queues.js');
  await enqueue(QUEUE_NAMES.AGENT_JOBS, DOCUMENT_NOTICE_JOB, { ...notice, withheld }, {
    executor, orgId: notice.orgId, dedupeKey: `${DOCUMENT_NOTICE_JOB}:${notice.orgId}:${notice.replyKey}`,
  });
}

/** A notice job's data, checked: null when it isn't one. */
export function documentNoticeJobData(data: unknown): DocumentNoticeJobData | null {
  if (!isRecord(data)) return null;
  const { orgId, askerId, spaceId, replyKey } = data;
  if (![orgId, askerId, spaceId, replyKey].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 600)) return null;
  const withheld = rowsOf(data.withheld).flatMap((ref): DocumentRef[] => (isRecord(ref) && (ref.type === 'document' || ref.type === 'drive')
    && typeof ref.id === 'string' && ref.id.length > 0 && ref.id.length <= 255 ? [{ type: ref.type, id: ref.id }] : [])).slice(0, MAX_NOTICE_ITEMS);
  return { orgId, askerId, spaceId, replyKey, withheld };
}
