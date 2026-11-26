// Documents in chat (spec 5.3; plan Task F13): posting a document into a
// chat, the cards a message shows, and the chat's Docs tab.
//
// What a viewer is shown (consult rule C4): a document's title reaches only
// someone who can open it.
// - A message stores the documents it carries as ids only
//   (`metadata.documents = [{ id }]`), so the message, its live event and
//   its notifications never carry a title. The poster must be able to open
//   each one, checked in the message's own transaction.
// - A card is read per viewer, through the access check. One the viewer
//   can't open is null, and so is an id that doesn't exist, is deleted or
//   belongs to another workspace: the cards say nothing about whether a
//   document exists.
// - A drive's name, and a folder's (folders carry no access of their own),
//   show only to someone who can view the drive; otherwise they are null,
//   as in lib/documents.ts's viewerDocumentColumns.
// - The Docs tab needs a seat in the chat. Its linked drive shows only to
//   someone who can open it, and its shared documents only those the viewer
//   can open, each with the viewer's own role, newest share first, 50 a page
//   (a keyset cursor on the share's time and id, so every one is reachable).
//   The route reads its authorization and each page in one read-only,
//   repeatable-read snapshot. `can_link` offers "Link a drive" only when the
//   chat has no link at all, whoever can see it, and the viewer holds full
//   on some drive: a hidden link is never offered, so linking never answers
//   with an error that reveals it.
//
// Every statement here is one statement for all its documents, held to the
// access check (lib/document-access.ts); each has a planning-memory test
// (document-access-planning-db.test.ts).
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { driveMembers, documents, drives, type DocRole } from '@deft/db/documents';
import type { CoreDatabaseTransaction } from './database-transaction.js';
import { db } from './db.js';
import { driveRoleFor, visibleDocumentCondition, visibleDriveCondition, visibleDriveIdSql, type Executor } from './document-access.js';

type Reader = Pick<typeof db, 'select' | 'execute'>;
/** Reads a table query: the pool, a route's snapshot or the message's own transaction. */
type Selector = Pick<CoreDatabaseTransaction, 'select'>;

/** A message carries at most this many documents. */
export const MAX_MESSAGE_DOCUMENTS = 5;

/** POST /api/documents/cards answers at most this many ids at once. */
export const MAX_DOCUMENT_CARDS = 50;

/** The Docs tab lists the shared documents this many a page, newest share first. */
export const SHARED_PAGE_SIZE = 50;

export type DocumentCard = { id: string; title: string; icon: string | null; drive_name: string | null; role: DocRole };

export type SpaceDocuments = {
  linked_drive: { id: string; name: string; role: DocRole } | null;
  /** True when the chat has no link at all and the viewer holds full on some drive. */
  can_link: boolean;
  shared: Array<{ id: string; title: string; home: { drive_name: string | null; folder_name: string | null }; role: DocRole }>;
  /** The cursor of the next page of `shared`, or null on the last page. */
  next_cursor: string | null;
};

/** A position in the shared list: the share's time, to the microsecond, and its id. */
export type SharedCursor = { at: string; id: string };

const CURSOR_PATTERN = /^((\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6})\|([A-Za-z0-9_-]{1,64})$/;

/**
 * A cursor this module issued, or null for anything else (the route answers
 * 400 before any query): the shape, and a date and time that exist (a month
 * of 1 to 12, a day in that month, hours 0 to 23, minutes and seconds 0 to
 * 59), so the timestamp cast in the statement can't fail.
 */
export function parseSharedCursor(value: string): SharedCursor | null {
  const match = CURSOR_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(2, 8).map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC rolls an impossible part over (30 February is 2 March) and reads years below 100 as 19xx: either way a part differs.
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
  return real ? { at: match[1]!, id: match[8]! } : null;
}

const idsParam = (ids: readonly string[]) => sql`${sql.param([...ids])}::text[]`;

/**
 * For a statement over the `documents` table (not aliased) whose rows the
 * viewer can already view: their role on the row, from full down. Each
 * condition is the access check at that role; the first that holds wins.
 */
function viewerRoleSql(userId: string, orgId: string): SQL {
  return sql`CASE WHEN ${visibleDocumentCondition(userId, orgId, 'full')} THEN 'full'
    WHEN ${visibleDocumentCondition(userId, orgId, 'edit')} THEN 'edit'
    WHEN ${visibleDocumentCondition(userId, orgId, 'comment')} THEN 'comment'
    ELSE 'view' END`;
}

/**
 * The statement documentCards runs: for each of `ids` the viewer can open,
 * its title, icon, the viewer's role and its drive's name where they can
 * view the drive. Exported for its planning test.
 */
export function documentCardsQuery(userId: string, orgId: string, ids: readonly string[]): SQL {
  return sql`SELECT ${documents.id} AS id, ${documents.title} AS title, ${documents.icon} AS icon,
      CASE WHEN card_drive_seen.visible THEN card_drive.name END AS drive_name,
      ${viewerRoleSql(userId, orgId)} AS role
    FROM ${documents}
    JOIN drives card_drive ON card_drive.id = ${documents.drive_id} AND card_drive.org_id = ${documents.org_id}
    CROSS JOIN LATERAL (SELECT ${visibleDriveIdSql(userId, orgId, sql`${documents.drive_id}`)} AS visible) card_drive_seen
    WHERE ${documents.id} = ANY(${idsParam(ids)}) AND ${visibleDocumentCondition(userId, orgId)}`;
}

/**
 * The cards for `ids`, keyed by id, as `userId` of `orgId` may see them: a
 * card for each document they can open, null for every other id.
 */
export async function documentCards(userId: string, orgId: string, ids: readonly string[], executor: Executor = db): Promise<Record<string, DocumentCard | null>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return {};
  const rows = (await executor.execute(documentCardsQuery(userId, orgId, unique))).rows as DocumentCard[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return Object.fromEntries(unique.map((id) => {
    const row = byId.get(id);
    return [id, row ? { id: row.id, title: row.title, icon: row.icon, drive_name: row.drive_name, role: row.role } : null];
  }));
}

/**
 * The posting check's statement: which of `ids` the poster can open. Exported
 * for its planning test.
 */
export function postableDocumentsQuery(userId: string, orgId: string, ids: readonly string[], reader: Selector = db) {
  return reader.select({ id: documents.id }).from(documents)
    .where(and(sql`${documents.id} = ANY(${idsParam(ids)})`, visibleDocumentCondition(userId, orgId)));
}

/** True when `userId` can open every one of `ids` in `orgId`. Run it in the message's transaction. */
export async function canPostDocuments(reader: Selector, userId: string, orgId: string, ids: readonly string[]): Promise<boolean> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return true;
  const rows = await postableDocumentsQuery(userId, orgId, unique, reader);
  return new Set(rows.map((row) => row.id)).size === unique.length;
}

/**
 * The statement for a page of the Docs tab's shared documents: those shared
 * with the chat `spaceId` that the viewer can open, newest share first (the
 * share's id breaks a tie), after `cursor` when given, at most `limit`, each
 * with the viewer's role and its home's names where they can view its
 * drive. Each row carries its share's position (`share_at`, `share_id`) for
 * the next cursor. Exported for its planning test.
 */
export function spaceSharedDocumentsQuery(userId: string, orgId: string, spaceId: string, cursor: SharedCursor | null = null,
  limit = SHARED_PAGE_SIZE + 1): SQL {
  const after = cursor ? sql`AND (shared_into.created_at, shared_into.id) < (${cursor.at}::timestamp, ${cursor.id})` : sql``;
  return sql`SELECT ${documents.id} AS id, ${documents.title} AS title,
      CASE WHEN shared_drive_seen.visible THEN shared_drive.name END AS drive_name,
      CASE WHEN shared_drive_seen.visible THEN shared_folder.name END AS folder_name,
      ${viewerRoleSql(userId, orgId)} AS role,
      to_char(shared_into.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS share_at, shared_into.id AS share_id
    FROM document_shares shared_into
    JOIN ${documents} ON ${documents.id} = shared_into.document_id AND ${documents.org_id} = shared_into.org_id
    JOIN drives shared_drive ON shared_drive.id = ${documents.drive_id} AND shared_drive.org_id = ${documents.org_id}
    LEFT JOIN doc_folders shared_folder ON shared_folder.id = ${documents.folder_id} AND shared_folder.org_id = ${documents.org_id}
      AND shared_folder.is_deleted = false
    CROSS JOIN LATERAL (SELECT ${visibleDriveIdSql(userId, orgId, sql`${documents.drive_id}`)} AS visible) shared_drive_seen
    WHERE shared_into.org_id = ${orgId} AND shared_into.principal_type = 'space' AND shared_into.principal_id = ${spaceId}
      ${after}
      AND ${visibleDocumentCondition(userId, orgId)}
    ORDER BY shared_into.created_at DESC, shared_into.id DESC
    LIMIT ${limit}`;
}

/**
 * The check behind `can_link`'s second half: one drive of `orgId` where
 * `userId` holds full. Exported for its planning test.
 */
export function fullDriveQuery(userId: string, orgId: string, reader: Selector = db) {
  return reader.select({ id: drives.id }).from(drives).where(visibleDriveCondition(userId, orgId, 'full')).limit(1);
}

/**
 * A page of the Docs tab of the chat `spaceId` for `userId`, read through
 * `reader` (the route's snapshot, after it checked the seat): the chat's
 * linked drive where they can open it, whether they may link one, and the
 * documents shared into the chat they can open, after `cursor`.
 */
export async function spaceDocuments(reader: Reader, userId: string, orgId: string, spaceId: string,
  cursor: SharedCursor | null = null): Promise<SpaceDocuments> {
  // The chat's link, whatever drive it names and whoever can see it (the link-space route's own check).
  const [link] = await reader.select({ id: drives.id, name: drives.name, is_deleted: drives.is_deleted }).from(driveMembers)
    .innerJoin(drives, and(eq(drives.id, driveMembers.drive_id), eq(drives.org_id, driveMembers.org_id)))
    .where(and(
      eq(driveMembers.org_id, orgId), eq(driveMembers.principal_type, 'space'), eq(driveMembers.principal_id, spaceId),
      eq(driveMembers.is_link, true),
    ))
    .limit(1);
  const linkRole = link && !link.is_deleted ? await driveRoleFor(userId, orgId, link.id, reader) : null;
  const canLink = !link && (await fullDriveQuery(userId, orgId, reader)).length > 0;
  const rows = (await reader.execute(spaceSharedDocumentsQuery(userId, orgId, spaceId, cursor))).rows as Array<{
    id: string; title: string; drive_name: string | null; folder_name: string | null; role: DocRole; share_at: string; share_id: string;
  }>;
  const page = rows.slice(0, SHARED_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    linked_drive: link && linkRole ? { id: link.id, name: link.name, role: linkRole } : null,
    can_link: canLink,
    shared: page.map((row) => ({ id: row.id, title: row.title, home: { drive_name: row.drive_name, folder_name: row.folder_name }, role: row.role })),
    next_cursor: rows.length > SHARED_PAGE_SIZE && last ? `${last.share_at}|${last.share_id}` : null,
  };
}
