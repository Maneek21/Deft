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
// - Documents are created through F5's system entry point
//   (documents.ts systemCreateDocumentInTx): createDocumentInTx's preparation
//   and row, without a person's role check (nobody holds edit on a frozen
//   drive, an inactive author holds nothing, and an author holds edit on
//   Shared notes only through the share written after the insert), keeping
//   the source's times and deleted state. A sub-page starts with its parent's
//   shares (F9's rule), so the move writes a note's shares on its first part
//   before it makes the sub-pages.
// - Versions are written by F8's version primitive in the source's
//   transaction (document-versions.ts createVersionInTx), with the old
//   version's own title and time. A version is kept as it was, even over the
//   live size cap: it can be viewed; restoring one over the cap is refused
//   with 413 TOO_LARGE by the writer (writeDocument).
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { type NoteMoveOutcome, type NoteMoveSourceType, type NoteMoveTargetType } from '@deft/db/documents';
import { db } from '../db.js';
import { createVersionInTx } from '../document-versions.js';
import { DocumentRefusal, systemCreateDocumentInTx, type TimestampText } from '../documents.js';
import { ensurePersonalDrive, ensureSharedNotesDrive, PrincipalCannotHoldAccessError } from '../drives.js';
import { LocalFileStore, localFileStore, type FileStore } from '../file-store.js';
import { canvasHasContent, MoveError, type JSONContent } from './convert-note.js';

export type { TimestampText };

// ---------------------------------------------------------------------------
// File storage: where the move and its check look for a linked image's bytes.

let moveStore: FileStore = localFileStore;

/** The file store the move and the post-move check read: the uploads store (localFileStore) unless a test replaces it. */
export function moveFileStore(): FileStore {
  return moveStore;
}

/** Test seam: the store the move reads, or null for the uploads store. */
export function _setMoveFileStoreForTest(store: FileStore | null): void {
  moveStore = store ?? localFileStore;
}

/**
 * True when the storage root answers and holds something (O-F2): for the
 * local store, its uploads folder exists and has an entry; for any other
 * store (an object store), one of this workspace's files resolves. Asked only
 * when a file's bytes are missing, to tell a lost file from a missing or
 * misconfigured mount.
 */
export async function storageRootReachable(tx: Tx, orgId: string): Promise<boolean> {
  const store = moveFileStore();
  if (store instanceof LocalFileStore) {
    try {
      return (await readdir(store.rootDir)).length > 0;
    } catch {
      return false;
    }
  }
  const keys = rowsOf<{ storage_key: string }>(await tx.execute(sql`SELECT storage_key FROM files
    WHERE org_id = ${orgId} ORDER BY created_at DESC, id LIMIT 20`)).map((row) => row.storage_key);
  for (const key of keys) {
    try {
      if (await store.stat(key)) return true;
    } catch {
      // Unreadable: not an answer.
    }
  }
  return false;
}

/** The bytes of a stored file are there (the store answers for the key). */
export async function bytesExist(storageKey: string): Promise<boolean> {
  try {
    return (await moveFileStore().stat(storageKey)) !== null;
  } catch {
    return false;
  }
}

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
  /**
   * The workspace's first owner: the earliest-joined active human owner, never an
   * inactive or agent owner (their drive would be frozen). Null when there is none.
   */
  firstOwnerId: string | null;
  /**
   * The workspace gets a Shared notes drive: it has a live note visible to the whole
   * workspace, or a public chat's canvas with content (O-F10: deleted workspace notes
   * alone don't make one).
   */
  sharedNotesWanted: boolean;
  /** Which note holds each file several notes name (move-notes.ts currentContentHolders, O-F7); filled before notes move. */
  currentHolders: Map<string, string>;
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
  const first = rows.find((row) => row.role === 'owner' && row.is_active && row.kind === 'human');
  return { orgId, members, firstOwnerId: first?.user_id ?? null, sharedNotesWanted: await sharedNotesWanted(orgId), currentHolders: new Map() };
}

/** OrgContext.sharedNotesWanted: a live workspace note, or a public chat's canvas with content (read a page at a time). */
async function sharedNotesWanted(orgId: string): Promise<boolean> {
  const [live] = rowsOf<{ found: boolean }>(await db.execute(sql`SELECT EXISTS (SELECT 1 FROM notes
    WHERE org_id = ${orgId} AND visibility = 'org' AND is_deleted = false) AS found`));
  if (live?.found) return true;
  for (let after = ''; ;) {
    const page = rowsOf<{ id: string; content: unknown }>(await db.execute(sql`SELECT public_canvas.id, public_canvas.content
      FROM canvases public_canvas JOIN spaces chat ON chat.id = public_canvas.space_id AND chat.org_id = public_canvas.org_id
      WHERE public_canvas.org_id = ${orgId} AND chat.type = 'public' AND public_canvas.content IS NOT NULL AND public_canvas.id > ${after}
      ORDER BY public_canvas.id LIMIT 100`));
    if (page.some((canvas) => canvasHasContent(canvas.content))) return true;
    if (page.length < 100) return false;
    after = page[page.length - 1]!.id;
  }
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

/**
 * The id a source of `orgId` was moved to, or null. The map's source key is
 * unique across workspaces, so when this workspace has no row the key is
 * probed once more without the workspace, for existence only: a row there
 * means the move can't place the source, and it is refused rather than left
 * to fail on the key. The probe reads nothing of that row.
 */
export async function mappedTarget(tx: Tx, orgId: string, legacyType: NoteMoveSourceType, sourceId: string): Promise<string | null> {
  const [row] = rowsOf<{ target_id: string }>(await tx.execute(sql`
    SELECT target_id FROM note_document_map WHERE org_id = ${orgId} AND source_type = ${legacyType} AND source_id = ${sourceId}`));
  if (row) return row.target_id;
  const [taken] = rowsOf<{ taken: boolean }>(await tx.execute(sql`
    -- C7: cross-workspace existence probe on a globally unique key; reads nothing else (conflict is reported, not resolved)
    SELECT EXISTS (SELECT 1 FROM note_document_map WHERE org_id <> ${orgId} AND source_type = ${legacyType} AND source_id = ${sourceId}) AS taken`));
  if (taken?.taken) throw new MoveError('mapped_in_another_workspace', 'This source is already mapped in another workspace');
  return null;
}

export async function insertMapRow(tx: Tx, row: {
  orgId: string; legacyType: NoteMoveSourceType; sourceId: string; targetType: NoteMoveTargetType; targetId: string;
  outcome?: NoteMoveOutcome; details: Record<string, unknown>;
}): Promise<void> {
  await tx.execute(sql`INSERT INTO note_document_map (id, org_id, source_type, source_id, target_type, target_id, outcome, details)
    VALUES (${randomUUID()}, ${row.orgId}, ${row.legacyType}, ${row.sourceId}, ${row.targetType}, ${row.targetId},
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

/**
 * The agents who could read workspace notes on master and can hold access
 * now (O-F3): users of kind `agent` with an active owner, admin or member
 * row in the workspace and their own active, undeleted employee there (the
 * access check's actor rule). Open drives give agents nothing, so these keep
 * reading Shared notes through a `view` member row each.
 */
export const ELIGIBLE_AGENTS_SQL = (orgId: string) => sql`SELECT member.user_id FROM org_members member
  JOIN users person ON person.id = member.user_id
  JOIN agent_employees employee ON employee.id = person.agent_employee_id AND employee.org_id = member.org_id
    AND employee.user_id = member.user_id
  WHERE member.org_id = ${orgId} AND member.is_active = true AND member.role IN ('owner', 'admin', 'member')
    AND person.kind = 'agent' AND employee.is_active = true AND employee.is_deleted = false`;

/**
 * The Shared notes drive, made on first use (F4's ensureSharedNotesDrive),
 * created by the first owner, with every eligible agent as a `view` member
 * (ELIGIBLE_AGENTS_SQL; agents who join later follow the open-drive rule).
 * `agentsAdded` counts the member rows this call wrote.
 */
export async function sharedNotesDriveInTx(tx: Tx, ctx: OrgContext, authorId: string): Promise<{ id: string; agentsAdded: number }> {
  const { id } = await ensureSharedNotesDrive(ctx.orgId, ctx.firstOwnerId ?? authorId, tx);
  const added = rowsOf<{ id: string }>(await tx.execute(sql`INSERT INTO drive_members (id, org_id, drive_id, principal_type, principal_id, role)
    SELECT gen_random_uuid()::text, ${ctx.orgId}, ${id}, 'user', eligible.user_id, 'view' FROM (${ELIGIBLE_AGENTS_SQL(ctx.orgId)}) eligible
    ON CONFLICT (drive_id, principal_type, principal_id) DO NOTHING
    RETURNING id`));
  return { id, agentsAdded: added.length };
}

/** The "Chat canvases" folder at the root of Shared notes, where public chats' canvases go (O-F4): made by the move (no author). */
export async function chatCanvasesFolderInTx(tx: Tx, orgId: string, driveId: string): Promise<string> {
  const [existing] = rowsOf<{ id: string }>(await tx.execute(sql`
    SELECT id FROM doc_folders
    WHERE org_id = ${orgId} AND drive_id = ${driveId} AND parent_folder_id IS NULL AND created_by IS NULL AND name = 'Chat canvases'
      AND is_deleted = false
    ORDER BY created_at, id LIMIT 1`));
  if (existing) return existing.id;
  const id = randomUUID();
  await tx.execute(sql`INSERT INTO doc_folders (id, org_id, drive_id, parent_folder_id, name, position, created_by)
    VALUES (${id}, ${orgId}, ${driveId}, NULL, 'Chat canvases',
      (SELECT coalesce(max(position), 0) + 1 FROM doc_folders WHERE org_id = ${orgId} AND drive_id = ${driveId}
        AND parent_folder_id IS NULL AND is_deleted = false),
      NULL)`);
  return id;
}

/** The author's folder at the root of Shared notes: found by its author (created_by), made on first use. */
export async function authorFolderInTx(tx: Tx, orgId: string, driveId: string, authorId: string): Promise<string> {
  const [existing] = rowsOf<{ id: string }>(await tx.execute(sql`
    SELECT id FROM doc_folders
    WHERE org_id = ${orgId} AND drive_id = ${driveId} AND parent_folder_id IS NULL AND created_by = ${authorId} AND is_deleted = false
    ORDER BY created_at, id LIMIT 1`));
  if (existing) return existing.id;
  // users has no org_id: the name is read only for an author of this workspace (a member, or the author of one of its notes).
  const [person] = rowsOf<{ name: string | null }>(await tx.execute(sql`SELECT person.name FROM users person
    WHERE person.id = ${authorId}
      AND (EXISTS (SELECT 1 FROM org_members member WHERE member.org_id = ${orgId} AND member.user_id = person.id)
        OR EXISTS (SELECT 1 FROM notes authored WHERE authored.org_id = ${orgId} AND authored.user_id = person.id))`));
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

export type MovedDocument = {
  orgId: string; driveId: string; folderId: string | null; parentDocumentId: string | null; title: string; icon: string | null;
  position: number; json: JSONContent; isTemplate: boolean; createdBy: string; lastEditedBy: string | null;
  lastEditedAt: TimestampText | null; createdAt: TimestampText; updatedAt: TimestampText; deletedAt: TimestampText | null; deletedBy: string | null;
};

/**
 * A moved document, through F5's system entry point (the header): Knowledge
 * off (Owner, 25 Nov), live state built on its first load, the source's
 * times kept as Postgres text (a Date would be read in the process's time zone).
 */
export async function insertDocumentInTx(tx: Tx, d: MovedDocument): Promise<string> {
  const row = await systemCreateDocumentInTx(tx, {
    orgId: d.orgId, driveId: d.driveId, folderId: d.folderId, parentDocumentId: d.parentDocumentId, title: d.title, icon: d.icon,
    json: d.json, isTemplate: d.isTemplate, useInKnowledge: false, position: d.position, createdBy: d.createdBy,
    lastEditedBy: d.lastEditedBy, lastEditedAt: d.lastEditedAt, createdAt: d.createdAt, updatedAt: d.updatedAt,
    deletedAt: d.deletedAt, deletedBy: d.deletedBy,
  });
  return row.id;
}

/**
 * Old versions keep their order, so the history lists them as they were
 * (S-F6): within a document, in version order, each stored time is its own
 * time or 1 microsecond after the time stored before it, whichever is later
 * (t'ᵢ = max(tᵢ, t'ᵢ₋₁ + 1 µs)). A history already in order keeps its times.
 * Worked out in SQL, so microseconds are kept exactly.
 */
export class VersionTimes {
  private last: TimestampText | null = null;
  /** The time to store for the next version (in version order), as Postgres text. */
  async next(tx: Tx, createdAt: TimestampText): Promise<TimestampText> {
    if (this.last === null) {
      this.last = createdAt;
      return createdAt;
    }
    const [row] = rowsOf<{ at: string }>(await tx.execute(sql`
      SELECT greatest(${createdAt}::timestamp, ${this.last}::timestamp + interval '1 microsecond')::text AS at`));
    this.last = row!.at;
    return row!.at;
  }
}

/** A `moved` version, through F8's version primitive in the source's transaction, with its own title, at the time VersionTimes gave it. */
export async function insertMovedVersionInTx(tx: Tx, v: {
  orgId: string; documentId: string; title: string | null; json: JSONContent; createdBy: string | null; createdAt: TimestampText;
  editDetails: Record<string, unknown>;
}): Promise<void> {
  await createVersionInTx(tx, {
    orgId: v.orgId, documentId: v.documentId, kind: 'moved', title: v.title, json: v.json, createdBy: v.createdBy,
    editDetails: v.editDetails, createdAt: sql`${v.createdAt}::timestamp`,
  });
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

export type FileRefusal = 'not_found' | 'uploaded_by_someone_else' | 'on_message_or_task' | 'in_another_document'
  | 'held_by_another_note' | 'bytes_missing';

/** What the move knows about one file a source's images name: who uploaded it, and why no document may take it, if so. */
export type FileFacts = { uploadedBy: string | null; refusal: FileRefusal | null };

/**
 * The files a source's images name, as the consult's rule needs them, apart
 * from who may have uploaded them (that is per snapshot: imageAllowed). A
 * file is refused when it isn't in the workspace (`files` has no soft delete:
 * a file that exists is a row that exists), is on a message or task (column
 * or link table), is already in another document, is held by another note
 * that shows it in its live content (`heldElsewhere`, O-F7), or its bytes are
 * gone (O-F2). The files are locked FOR UPDATE in id order first, so a
 * message or task that takes one meanwhile waits for this transaction, then
 * is checked in a fresh statement.
 *
 * Missing bytes: when the storage root answers and holds something
 * (storageRootReachable), only that file is lost: it is refused
 * (`bytes_missing`) and becomes a placeholder. When the root doesn't answer,
 * or is empty (a missing or misconfigured mount), this throws: the source is
 * refused without being mapped, so a run after the mount is fixed decides
 * again.
 */
export async function fileFactsInTx(tx: Tx, orgId: string, fileIds: Iterable<string>, heldElsewhere: (fileId: string) => boolean):
  Promise<Map<string, FileFacts>> {
  const ids = [...new Set(fileIds)].sort();
  const facts = new Map<string, FileFacts>(ids.map((id) => [id, { uploadedBy: null, refusal: 'not_found' as FileRefusal }]));
  if (ids.length === 0) return facts;
  await tx.execute(sql`SELECT id FROM files WHERE org_id = ${orgId} AND id = ANY(${sql.param(ids)}::text[]) ORDER BY id FOR UPDATE`);
  const rows = rowsOf<{ id: string; uploaded_by: string; storage_key: string; attached: boolean; in_document: boolean }>(await tx.execute(sql`
    SELECT moved_file.id, moved_file.uploaded_by, moved_file.storage_key,
      (moved_file.message_id IS NOT NULL OR moved_file.task_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM message_attachments link WHERE link.org_id = moved_file.org_id AND link.file_id = moved_file.id)
        OR EXISTS (SELECT 1 FROM task_attachments link WHERE link.org_id = moved_file.org_id AND link.file_id = moved_file.id)) AS attached,
      EXISTS (SELECT 1 FROM document_attachments link WHERE link.org_id = moved_file.org_id AND link.file_id = moved_file.id) AS in_document
    FROM files moved_file
    WHERE moved_file.org_id = ${orgId} AND moved_file.id = ANY(${sql.param(ids)}::text[])`));
  let rootReachable: boolean | null = null;
  for (const row of rows) {
    let refusal: FileRefusal | null = row.attached ? 'on_message_or_task' : row.in_document ? 'in_another_document'
      : heldElsewhere(row.id) ? 'held_by_another_note' : null;
    if (refusal === null && !(await bytesExist(row.storage_key))) {
      rootReachable ??= await storageRootReachable(tx, orgId);
      if (!rootReachable) {
        throw new MoveError('storage_unreachable', 'The file storage is unreachable or empty: fix the uploads mount, then run the move again');
      }
      refusal = 'bytes_missing';
    }
    facts.set(row.id, { uploadedBy: row.uploaded_by, refusal });
  }
  return facts;
}

/** True when a snapshot whose images `allowed` may have uploaded can show this file: no refusal, and one of them uploaded it. */
export function imageAllowed(facts: Map<string, FileFacts>, fileId: string, allowed: ReadonlySet<string>): boolean {
  const fact = facts.get(fileId);
  return Boolean(fact && fact.refusal === null && fact.uploadedBy !== null && allowed.has(fact.uploadedBy));
}

/**
 * Links each file to every document whose content shows it (in_current
 * true). The first document holds the history: a file in its history, or
 * in no content at all, is also linked to it with in_current false, unless
 * its own content shows it. That is F8's rule for in_current, set when the
 * rows are made, so the history can show every image it holds, wherever the
 * current content placed it. The files are claimed: their staged expiry is
 * cleared, so the retention sweep keeps them. Returns the rows written.
 */
export async function linkFilesInTx(tx: Tx, orgId: string, fileIds: string[], docs: Array<{ id: string; fileIds: Set<string> }>,
  historyFileIds: ReadonlySet<string>): Promise<number> {
  let written = 0;
  const main = docs[0]!;
  for (const fileId of fileIds) {
    const targets = docs.filter((doc) => doc.fileIds.has(fileId)).map((doc) => ({ id: doc.id, current: true }));
    if (!main.fileIds.has(fileId) && (historyFileIds.has(fileId) || targets.length === 0)) targets.push({ id: main.id, current: false });
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
  if (error instanceof DocumentRefusal) return `Refused by document creation: ${error.code}`;
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  return code ? `Unexpected database error ${code}` : `Unexpected error (${error instanceof Error ? error.name : typeof error})`;
}
