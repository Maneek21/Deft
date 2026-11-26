// The notes move (plan Task F14): where moved things go, and the rows every
// part of the move writes the same way.
//
// - Every write runs in a transaction that first takes the workspace's
//   advisory lock, pg_advisory_xact_lock(hashtext('drives-move:' || orgId)),
//   and then checks note_document_map, so two movers (the upgrade container
//   and an API start) never move one source twice. If the move is ever run
//   through the job queue instead, its key is
//   `drives-move:<release version>:<orgId>` (consult rule C1).
// - A person's My drive: F4's ensurePersonalDrive for an active human
//   member, guests included. Anyone else who has an org_members row (a
//   deactivated member, an agent user, a system user) gets a personal drive
//   made here with frozen_at set and the owner's `full` row, as
//   ensurePersonalDrive writes it: nobody can open it until the workspace
//   owner hands it on (F6), and its shares give view at most. ensurePersonalDrive
//   refuses them, and the drive triggers need the org_members row, which a
//   deactivated member keeps. Someone with no org_members row in the
//   workspace can't own a drive there: their private notes are an error the
//   operator has to decide on, and the move reports it.
// - Documents are inserted here, not through F5's createDocumentInTx: that
//   needs the author to hold edit on the drive at the time of the move, which
//   no one holds on a frozen drive, an inactive author doesn't hold anywhere
//   and an author holds on Shared notes (default view) only through the
//   share written after the insert, and it can't keep a note's dates or its
//   deleted state. The content is prepared as createDocumentInTx prepares it
//   (the schema check, ensureBlockIds, the encoded Yjs size with the same cap
//   helper; convert-note.ts), with ydoc_state null until the first live load.
// - Versions are inserted here, not through F8's createVersion: that writes
//   through the pool, outside the note's transaction, and takes its title
//   from the document row; a moved version keeps its own. The row is the one
//   createVersion writes: JSON only, size_bytes the JSON's byte length.
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { documents, documentVersions, type NoteMoveOutcome, type NoteMoveSourceType, type NoteMoveTargetType } from '@deft/db/documents';
import { jsonToText } from '@deft/doc-schema';
import { db } from '../db.js';
import { ensurePersonalDrive, ensureSharedNotesDrive, PrincipalCannotHoldAccessError } from '../drives.js';
import { MoveError, type JSONContent } from './convert-note.js';

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray((result as { rows: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

export type Member = { userId: string; role: string; active: boolean; kind: string; name: string };

/** What the move needs to know about a workspace, read once per run. */
export type OrgContext = {
  orgId: string;
  members: Map<string, Member>;
  /** The workspace's first owner: the earliest active human owner, else the earliest owner. */
  firstOwnerId: string | null;
};

export async function loadOrgContext(orgId: string): Promise<OrgContext> {
  const rows = rowsOf<{ user_id: string; role: string; is_active: boolean; kind: string; name: string }>(await db.execute(sql`
    SELECT member.user_id, member.role::text AS role, member.is_active, person.kind::text AS kind, person.name
    FROM org_members member JOIN users person ON person.id = member.user_id
    WHERE member.org_id = ${orgId}
    ORDER BY (member.role = 'owner' AND member.is_active AND person.kind = 'human') DESC, (member.role = 'owner') DESC,
      member.joined_at, member.created_at, member.id`));
  const members = new Map<string, Member>();
  for (const row of rows) {
    members.set(row.user_id, { userId: row.user_id, role: row.role, active: row.is_active, kind: row.kind, name: row.name });
  }
  const first = rows[0];
  return { orgId, members, firstOwnerId: first && first.role === 'owner' ? first.user_id : null };
}

/** An active human member who is not a guest: who may own a canvas. */
export function isActiveFullHuman(ctx: OrgContext, userId: string | null | undefined): userId is string {
  const member = userId ? ctx.members.get(userId) : undefined;
  return Boolean(member && member.active && member.kind === 'human' && ['owner', 'admin', 'member'].includes(member.role));
}

/** The workspace's move lock, held until the transaction ends. */
export async function lockOrgInTx(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('drives-move:' || ${orgId}))`);
}

/** The id a source was moved to, or null. */
export async function mappedTarget(tx: Tx, sourceType: NoteMoveSourceType, sourceId: string): Promise<string | null> {
  const [row] = rowsOf<{ target_id: string }>(await tx.execute(sql`
    SELECT target_id FROM note_document_map WHERE source_type = ${sourceType} AND source_id = ${sourceId}`));
  return row?.target_id ?? null;
}

export async function insertMapRow(tx: Tx, row: {
  orgId: string; sourceType: NoteMoveSourceType; sourceId: string; targetType: NoteMoveTargetType; targetId: string;
  outcome?: NoteMoveOutcome; details: Record<string, unknown>;
}): Promise<void> {
  await tx.execute(sql`INSERT INTO note_document_map (id, org_id, source_type, source_id, target_type, target_id, outcome, details)
    VALUES (${randomUUID()}, ${row.orgId}, ${row.sourceType}, ${row.sourceId}, ${row.targetType}, ${row.targetId},
      ${row.outcome ?? 'ok'}, ${JSON.stringify(row.details)}::jsonb)`);
}

export const outcomeOf = (unsafeDropped: number, missingImages: number): NoteMoveOutcome =>
  unsafeDropped > 0 && missingImages > 0 ? 'unsafe_and_missing' : unsafeDropped > 0 ? 'unsafe_content_dropped' : missingImages > 0 ? 'missing_images' : 'ok';

/**
 * `userId`'s personal drive for moved things (the header): their live My
 * drive when they are an active human member, else their frozen personal
 * drive (the newest one, made here if they have none). `frozenCreated`
 * says this call made one.
 */
export async function personalDriveInTx(tx: Tx, ctx: OrgContext, userId: string): Promise<{ id: string; frozen: boolean; frozenCreated: boolean }> {
  const member = ctx.members.get(userId);
  if (!member) throw new MoveError('owner_not_member', 'The owner is not a member of this workspace, so they have no drive to move into');
  if (member.active && member.kind === 'human') {
    try {
      return { id: (await ensurePersonalDrive(ctx.orgId, userId, tx)).id, frozen: false, frozenCreated: false };
    } catch (error) {
      if (!(error instanceof PrincipalCannotHoldAccessError)) throw error;
    }
  }
  const [existing] = rowsOf<{ id: string }>(await tx.execute(sql`
    SELECT id FROM drives
    WHERE org_id = ${ctx.orgId} AND kind = 'personal' AND owner_user_id = ${userId} AND is_deleted = false AND frozen_at IS NOT NULL
    ORDER BY frozen_at DESC, created_at DESC, id
    LIMIT 1`));
  if (existing) return { id: existing.id, frozen: true, frozenCreated: false };
  const id = randomUUID();
  await tx.execute(sql`INSERT INTO drives (id, org_id, name, kind, owner_user_id, frozen_at, created_by)
    VALUES (${id}, ${ctx.orgId}, 'My drive', 'personal', ${userId}, now() AT TIME ZONE 'UTC', ${userId})`);
  await tx.execute(sql`INSERT INTO drive_members (id, org_id, drive_id, principal_type, principal_id, role, added_by)
    VALUES (${randomUUID()}, ${ctx.orgId}, ${id}, 'user', ${userId}, 'full', ${userId})`);
  return { id, frozen: true, frozenCreated: true };
}

/** The Shared notes drive, made on first use (F4's ensureSharedNotesDrive), created by the first owner. */
export async function sharedNotesDriveInTx(tx: Tx, ctx: OrgContext, authorId: string): Promise<string> {
  return (await ensureSharedNotesDrive(ctx.orgId, ctx.firstOwnerId ?? authorId, tx)).id;
}

/** The author's folder at the root of Shared notes: found by its author (created_by), made on first use. */
export async function authorFolderInTx(tx: Tx, orgId: string, driveId: string, authorId: string): Promise<string> {
  const [existing] = rowsOf<{ id: string }>(await tx.execute(sql`
    SELECT id FROM doc_folders
    WHERE org_id = ${orgId} AND drive_id = ${driveId} AND parent_folder_id IS NULL AND created_by = ${authorId} AND is_deleted = false
    ORDER BY created_at, id LIMIT 1`));
  if (existing) return existing.id;
  const [person] = rowsOf<{ name: string | null }>(await tx.execute(sql`SELECT name FROM users WHERE id = ${authorId}`));
  const id = randomUUID();
  await tx.execute(sql`INSERT INTO doc_folders (id, org_id, drive_id, parent_folder_id, name, position, created_by)
    VALUES (${id}, ${orgId}, ${driveId}, NULL, ${person?.name?.trim() || 'Former member'},
      (SELECT coalesce(max(position), 0) + 1 FROM doc_folders WHERE org_id = ${orgId} AND drive_id = ${driveId}
        AND parent_folder_id IS NULL AND is_deleted = false),
      ${authorId})`);
  return id;
}

/** After the last live document in the same place (F5's rule): a folder, or the drive root. */
export async function nextRootPosition(tx: Tx, orgId: string, driveId: string, folderId: string | null): Promise<number> {
  const [row] = rowsOf<{ next: number }>(await tx.execute(sql`
    SELECT coalesce(max(position), 0) + 1 AS next FROM documents
    WHERE org_id = ${orgId} AND drive_id = ${driveId} AND is_deleted = false AND parent_document_id IS NULL
      AND ${folderId ? sql`folder_id = ${folderId}` : sql`folder_id IS NULL`}`));
  return Number(row?.next ?? 1);
}

/**
 * A `timestamp` as Postgres prints it (`col::text`). The move copies every
 * source time as text and casts it back, so it is kept exactly: pg reads a
 * `timestamp without time zone` into a Date in the process's own time zone,
 * which would shift it on a machine not running in UTC.
 */
export type TimestampText = string;

export type MovedDocument = {
  orgId: string; driveId: string; folderId: string | null; parentDocumentId: string | null; title: string; icon: string | null;
  position: number; json: JSONContent; bytes: number; isTemplate: boolean; createdBy: string; lastEditedBy: string | null;
  lastEditedAt: TimestampText | null; createdAt: TimestampText; updatedAt: TimestampText; deletedAt: TimestampText | null; deletedBy: string | null;
};

/** A moved document: Knowledge off (Owner, 25 Nov), live state built on its first load (ydoc_state null, as F5 creates). */
export async function insertDocumentInTx(tx: Tx, d: MovedDocument): Promise<string> {
  const id = randomUUID();
  await tx.execute(sql`INSERT INTO ${documents} (id, org_id, drive_id, folder_id, parent_document_id, title, icon, position, ydoc_state,
      content_json, content_text, use_in_knowledge, size_bytes, is_template, created_by, last_edited_by, last_edited_at,
      is_deleted, deleted_at, deleted_by, created_at, updated_at)
    VALUES (${id}, ${d.orgId}, ${d.driveId}, ${d.folderId}, ${d.parentDocumentId}, ${d.title}, ${d.icon}, ${d.position}, NULL,
      ${JSON.stringify(d.json)}::jsonb, ${jsonToText(d.json)}, false, ${d.bytes}, ${d.isTemplate}, ${d.createdBy}, ${d.lastEditedBy},
      ${d.lastEditedAt}::timestamp, ${d.deletedAt !== null}, ${d.deletedAt}::timestamp, ${d.deletedBy},
      ${d.createdAt}::timestamp, ${d.updatedAt}::timestamp)`);
  return id;
}

/** A `moved` version, as F8's createVersion writes a row (JSON only, size_bytes the JSON's length), with its own title and time. */
export async function insertMovedVersionInTx(tx: Tx, v: {
  orgId: string; documentId: string; title: string | null; json: JSONContent; createdBy: string | null; createdAt: TimestampText;
  editDetails: Record<string, unknown>;
}): Promise<void> {
  const text = JSON.stringify(v.json);
  await tx.execute(sql`INSERT INTO ${documentVersions} (id, org_id, document_id, kind, name, title, ydoc_state, content_json, size_bytes,
      created_by, agent_user_id, action_id, edit_details, created_at)
    VALUES (${randomUUID()}, ${v.orgId}, ${v.documentId}, 'moved', NULL, ${v.title}, NULL, ${text}::jsonb, ${Buffer.byteLength(text, 'utf8')},
      ${v.createdBy}, NULL, NULL, ${JSON.stringify(v.editDetails)}::jsonb, ${v.createdAt}::timestamp)`);
}

export type Principal = { type: 'user' | 'space'; id: string };
type ShareRole = 'edit' | 'comment' | 'view';
const RANK: Record<ShareRole, number> = { view: 1, comment: 2, edit: 3 };

/** Shares to write, one per principal at the highest role asked for. */
export class ShareSet {
  private readonly roles = new Map<string, { principal: Principal; role: ShareRole }>();
  add(principal: Principal, role: ShareRole): void {
    const key = `${principal.type}:${principal.id}`;
    const held = this.roles.get(key);
    if (!held || RANK[role] > RANK[held.role]) this.roles.set(key, { principal, role });
  }
  get size(): number { return this.roles.size; }
  entries(): Array<{ principal: Principal; role: ShareRole }> {
    return [...this.roles.values()].sort((a, b) => (`${a.principal.type}:${a.principal.id}` < `${b.principal.type}:${b.principal.id}` ? -1 : 1));
  }
}

/** Writes the shares on each document. The principals were checked to belong to the workspace. Returns the rows written. */
export async function insertSharesInTx(tx: Tx, orgId: string, documentIds: string[], shares: ShareSet, sharedBy: string | null): Promise<number> {
  let written = 0;
  for (const documentId of documentIds) {
    for (const { principal, role } of shares.entries()) {
      await tx.execute(sql`INSERT INTO document_shares (id, org_id, document_id, principal_type, principal_id, role, shared_by)
        VALUES (${randomUUID()}, ${orgId}, ${documentId}, ${principal.type}, ${principal.id}, ${role}, ${sharedBy})`);
      written += 1;
    }
  }
  return written;
}

export type FileDecision = 'linked' | 'not_found' | 'uploaded_by_someone_else' | 'on_message_or_task' | 'in_another_document';

/**
 * Which of the files a source's images name it may link (the consult's
 * rule): the file is in the workspace, `allowed` (its author, or the editor
 * of a version the image appears in) uploaded it, it is on no message or task
 * (column or link table), and no other document links it. `files` has no
 * soft delete, so a file that exists is a row that exists. The files are
 * locked FOR UPDATE in id order first, so a message or task that takes one
 * meanwhile waits for this transaction, then is checked in a fresh statement.
 */
export async function decideFilesInTx(tx: Tx, orgId: string, allowed: Map<string, Set<string>>): Promise<Map<string, FileDecision>> {
  const ids = [...allowed.keys()].sort();
  const decisions = new Map<string, FileDecision>(ids.map((id) => [id, 'not_found' as FileDecision]));
  if (ids.length === 0) return decisions;
  await tx.execute(sql`SELECT id FROM files WHERE org_id = ${orgId} AND id = ANY(${sql.param(ids)}::text[]) ORDER BY id FOR UPDATE`);
  const rows = rowsOf<{ id: string; uploaded_by: string; attached: boolean; in_document: boolean }>(await tx.execute(sql`
    SELECT moved_file.id, moved_file.uploaded_by,
      (moved_file.message_id IS NOT NULL OR moved_file.task_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM message_attachments link WHERE link.org_id = moved_file.org_id AND link.file_id = moved_file.id)
        OR EXISTS (SELECT 1 FROM task_attachments link WHERE link.org_id = moved_file.org_id AND link.file_id = moved_file.id)) AS attached,
      EXISTS (SELECT 1 FROM document_attachments link WHERE link.org_id = moved_file.org_id AND link.file_id = moved_file.id) AS in_document
    FROM files moved_file
    WHERE moved_file.org_id = ${orgId} AND moved_file.id = ANY(${sql.param(ids)}::text[])`));
  for (const row of rows) {
    decisions.set(row.id, !allowed.get(row.id)!.has(row.uploaded_by) ? 'uploaded_by_someone_else'
      : row.attached ? 'on_message_or_task' : row.in_document ? 'in_another_document' : 'linked');
  }
  return decisions;
}

/**
 * Links each file to the documents whose content shows it (in_current true),
 * or, when none does (it is only in history), to the first document with
 * in_current false: F8's rule for in_current, set when the rows are made. The
 * files are claimed: their staged expiry is cleared, so the retention sweep
 * keeps them. Returns the rows written.
 */
export async function linkFilesInTx(tx: Tx, orgId: string, fileIds: string[], docs: Array<{ id: string; fileIds: Set<string> }>): Promise<number> {
  let written = 0;
  for (const fileId of fileIds) {
    const showing = docs.filter((doc) => doc.fileIds.has(fileId));
    const targets = showing.length > 0 ? showing.map((doc) => ({ id: doc.id, current: true })) : [{ id: docs[0]!.id, current: false }];
    for (const target of targets) {
      await tx.execute(sql`INSERT INTO document_attachments (id, org_id, document_id, file_id, in_current, added_by)
        SELECT ${randomUUID()}, ${orgId}, ${target.id}, linked_file.id, ${target.current}, linked_file.uploaded_by
        FROM files linked_file WHERE linked_file.org_id = ${orgId} AND linked_file.id = ${fileId}`);
      written += 1;
    }
  }
  if (fileIds.length > 0) {
    await tx.execute(sql`UPDATE files SET staged_expires_at = NULL
      WHERE org_id = ${orgId} AND id = ANY(${sql.param(fileIds)}::text[]) AND staged_expires_at IS NOT NULL`);
  }
  return written;
}

/** A space of this workspace, or false. */
export async function spaceInOrg(tx: Tx, orgId: string, spaceId: string | null): Promise<boolean> {
  if (!spaceId) return false;
  const [row] = rowsOf<{ id: string }>(await tx.execute(sql`SELECT id FROM spaces WHERE id = ${spaceId} AND org_id = ${orgId}`));
  return Boolean(row);
}

/** A failure as the report shows it: the move's own fixed words, or the kind of error, never content. */
export function failureMessage(error: unknown): string {
  if (error instanceof MoveError) return error.message;
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  return code ? `Unexpected database error ${code}` : `Unexpected error (${error instanceof Error ? error.name : typeof error})`;
}
