// The notes move (plan Task F14, spec 5.11): note folders and notes.
//
// Each source moves in its own transaction, under the workspace's move lock
// (placement.ts), together with its note_document_map row: a source already
// mapped is skipped, and a failure rolls back everything for that source and
// is reported, so a later run picks it up. The notes tables are only read.
//
// Folders: each note_folders row becomes a doc_folders row in its owner's
// personal drive, parents first, keeping name and order (sort_order is the
// position). A folder deleted in Notes is a deleted folder. A live folder
// whose parent was deleted sits at the root, as deleting a folder in Notes
// left it (routes/daily-notes.ts); so does one whose parent is someone
// else's, or loops back to itself.
//
// Notes (the brief's table):
// - visibility 'org': the Shared notes drive, in a folder named after the
//   author, with an `edit` share for the author. Open drives exclude guests
//   (spec 5.2): the report counts the guests potentially affected. A deleted
//   one sits at the root of Shared notes, in the trash; when no live note
//   makes Shared notes, it goes to its author's drive instead, unless the
//   author has no membership row (no drive of their own: Shared notes all
//   the same, consult C3);
// - visibility 'space': the author's personal drive with a `view` share to
//   the chat. With no chat, or a chat of another workspace, the note is
//   private and reported (`made_private`);
// - otherwise the author's personal drive, in the folder its note folder
//   became (a live note in a deleted folder sits at the root);
// - note_shares: `edit` gives an edit share, anything else view. A person
//   with no org_members row in the workspace can't hold a share: skipped and
//   recorded;
// - versions: `moved` versions in version order, with their own time, title
//   and editor (created_by = edited_by), through F8's version primitive. Old
//   versions sharing one time are stored 1 microsecond apart per tie, in
//   version order, so the history lists them in order. A version over the
//   live size cap is kept whole: it can be viewed; restoring it is refused
//   with 413 TOO_LARGE. The history is read, converted and written one
//   version at a time, so a long history is never all in memory;
// - is_template stays a template; is_pinned is a favourite for the author;
//   is_deleted is a deleted document (deleted_at = updated_at);
// - Knowledge is off on every moved document.
// A template follows the same visibility as any note, so a workspace
// template stays usable by the workspace (in Shared notes).
//
// Images (placement.ts decideFilesInTx): the files a note's current content,
// its versions and its note_files rows name. A file is linked when the note's
// author uploaded it (for a version's image, that version's editor too), it
// is in the workspace, on no message or task and in no other document. Every
// other image becomes "Image not available" and is counted; content dropped
// as unsafe is counted too (current content and versions apart). A linked
// file note_files names that no converted content shows is still linked (as
// history: in_current false) and reported as `unplaced_images`.
//
// A note whose content is over the live size cap is split (convert-note.ts
// splitToFit): the first part is the note's document, the rest its sub-pages
// in order, each with the note's shares, in the same place and state. The
// first part holds the history: every image its history shows is linked to
// it (in_current false unless its own content shows it), wherever the
// current content placed that image.
import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import { noteFileIds } from '../note-file-claims.js';
import { finishContent, imageFileIds, MoveError, noteHtmlToJson, replaceUnlinkedImages, splitToFit } from './convert-note.js';
import {
  authorFolderInTx, failureMessage, fileFactsInTx, imageAllowed, insertDocumentInTx, insertMapRow, insertMovedVersionInTx, insertSharesInTx,
  linkFilesInTx, lockOrgInTx, mappedTarget, nextRootPosition, outcomeOf, personalDriveInTx, rowsOf, ShareSet, sharedNotesDriveInTx,
  spaceInOrg, VersionTimes, type FileRefusal, type OrgContext, type TimestampText, type Tx,
} from './placement.js';
import type { MoveReport } from './move-org.js';

/**
 * Which note holds each file when several name it (O-F7): the earliest-created
 * live note whose current content shows the file and whose author uploaded it.
 * It takes the file whatever order the notes move in; a note that names the
 * file only in its history, its note_files rows or while deleted, or a later
 * live note, gets "Image not available" (the "no other document link" rule
 * stays). Read with master's own image reader (note-file-claims.ts), one
 * note's content at a time; only ids are kept.
 */
export async function currentContentHolders(orgId: string): Promise<Map<string, string>> {
  const candidates = new Map<string, Array<{ noteId: string; author: string }>>();
  const ids = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM notes
    WHERE org_id = ${orgId} AND is_deleted = false AND strpos(lower(coalesce(content, '')), '<img') > 0
    ORDER BY created_at, id`)).map((row) => row.id);
  for (const id of ids) {
    const [note] = rowsOf<{ user_id: string; content: string | null }>(await db.execute(sql`SELECT user_id, content FROM notes
      WHERE id = ${id} AND org_id = ${orgId}`));
    if (!note) continue;
    for (const fileId of noteFileIds(note.content)) {
      candidates.set(fileId, [...(candidates.get(fileId) ?? []), { noteId: id, author: note.user_id }]);
    }
  }
  const holders = new Map<string, string>();
  const fileIds = [...candidates.keys()];
  for (let start = 0; start < fileIds.length; start += 500) {
    const uploaders = rowsOf<{ id: string; uploaded_by: string }>(await db.execute(sql`SELECT id, uploaded_by FROM files
      WHERE org_id = ${orgId} AND id = ANY(${sql.param(fileIds.slice(start, start + 500))}::text[])`));
    for (const file of uploaders) {
      const holder = candidates.get(file.id)!.find((candidate) => candidate.author === file.uploaded_by);
      if (holder) holders.set(file.id, holder.noteId);
    }
  }
  return holders;
}

type FolderRow = {
  id: string; user_id: string; name: string; parent_folder_id: string | null; sort_order: number; is_deleted: boolean;
  icon: string | null; created_at: TimestampText; updated_at: TimestampText;
};

/** Sources of the workspace already in note_document_map, for the report. */
async function alreadyMoved(orgId: string, table: 'notes' | 'note_folders' | 'canvases', legacyType: string): Promise<number> {
  const [row] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} moved_source
    WHERE moved_source.org_id = ${orgId}
      AND EXISTS (SELECT 1 FROM note_document_map m WHERE m.org_id = ${orgId} AND m.source_type = ${legacyType} AND m.source_id = moved_source.id)`));
  return Number(row?.n ?? 0);
}

/** The folder's parent as the move places it: null for a root, a missing or someone else's parent, a loop, or (for a live folder) a deleted parent. */
function effectiveParent(folder: FolderRow, byId: Map<string, FolderRow>): string | null {
  const parent = folder.parent_folder_id ? byId.get(folder.parent_folder_id) : undefined;
  if (!parent || parent.user_id !== folder.user_id) return null;
  if (!folder.is_deleted && parent.is_deleted) return null;
  const seen = new Set<string>([folder.id]);
  for (let at: FolderRow | undefined = parent; at; at = at.parent_folder_id ? byId.get(at.parent_folder_id) : undefined) {
    if (seen.has(at.id)) return null;
    seen.add(at.id);
  }
  return parent.id;
}

export async function moveNoteFolders(ctx: OrgContext, report: MoveReport): Promise<void> {
  const { orgId } = ctx;
  report.skippedAlreadyMoved += await alreadyMoved(orgId, 'note_folders', 'note_folder');
  const folders = rowsOf<FolderRow & { mapped: boolean }>(await db.execute(sql`SELECT id, user_id, name, parent_folder_id, sort_order,
      is_deleted, icon, created_at::text AS created_at, updated_at::text AS updated_at,
      EXISTS (SELECT 1 FROM note_document_map m WHERE m.org_id = note_folders.org_id AND m.source_type = 'note_folder' AND m.source_id = note_folders.id) AS mapped
    FROM note_folders WHERE org_id = ${orgId} ORDER BY created_at, id`));
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const parentOf = new Map(folders.map((folder) => [folder.id, effectiveParent(folder, byId)]));
  const depth = (id: string): number => {
    let n = 0;
    for (let at = parentOf.get(id); at; at = parentOf.get(at)) n += 1;
    return n;
  };
  // Every folder places its children; only those not yet moved are moved (the moved ones are counted above).
  const ordered = folders.filter((folder) => !folder.mapped).sort((a, b) => depth(a.id) - depth(b.id));
  for (const folder of ordered) {
    try {
      const outcome = await db.transaction(async (tx) => {
        await lockOrgInTx(tx, orgId);
        if (await mappedTarget(tx, orgId, 'note_folder', folder.id)) return 'already_moved' as const;
        const drive = await personalDriveInTx(tx, ctx, folder.user_id);
        const parentId = parentOf.get(folder.id) ?? null;
        let parentDocFolder: string | null = null;
        if (parentId) {
          parentDocFolder = await mappedTarget(tx, orgId, 'note_folder', parentId);
          if (!parentDocFolder) throw new MoveError('parent_folder_not_moved', 'The parent folder has not moved yet');
        }
        const [created] = rowsOf<{ id: string }>(await tx.execute(sql`INSERT INTO doc_folders (id, org_id, drive_id, parent_folder_id, name,
            position, created_by, is_deleted, deleted_at, created_at, updated_at)
          VALUES (gen_random_uuid()::text, ${orgId}, ${drive.id}, ${parentDocFolder}, ${folder.name}, ${folder.sort_order}, ${folder.user_id},
            ${folder.is_deleted}, ${folder.is_deleted ? folder.updated_at : null}::timestamp, ${folder.created_at}::timestamp,
            ${folder.updated_at}::timestamp)
          RETURNING id`));
        await insertMapRow(tx, {
          orgId, legacyType: 'note_folder', sourceId: folder.id, targetType: 'doc_folder', targetId: created!.id,
          details: {
            drive_id: drive.id, ...(folder.icon ? { icon: folder.icon } : {}),
            ...(folder.parent_folder_id && !parentId ? { moved_to_root: true } : {}),
          },
        });
        return { frozenCreated: drive.frozenCreated };
      });
      if (outcome === 'already_moved') {
        report.skippedAlreadyMoved += 1;
      } else {
        report.folders += 1;
        if (outcome.frozenCreated) report.frozenDrives += 1;
      }
    } catch (error) {
      report.errors.push({ sourceId: folder.id, message: failureMessage(error) });
    }
  }
}

type NoteRow = {
  id: string; org_id: string; user_id: string; folder_id: string | null; title: string; content: string | null; icon: string | null;
  is_pinned: boolean; is_template: boolean; is_deleted: boolean; visibility: string; visibility_space_id: string | null;
  created_at: TimestampText; updated_at: TimestampText;
};
type VersionRow = { id: string; version: number; title: string; edited_by: string | null; created_at: TimestampText };

/** One old version's HTML, read on its own so the history is never all in memory at once (note_versions has no org_id: the note's is checked). */
async function versionContent(tx: Tx, orgId: string, noteId: string, versionId: string): Promise<string | null> {
  const [row] = rowsOf<{ content: string | null }>(await tx.execute(sql`SELECT history_row.content
    FROM note_versions history_row JOIN notes history_note ON history_note.id = history_row.note_id
    WHERE history_row.id = ${versionId} AND history_row.note_id = ${noteId} AND history_note.org_id = ${orgId}`));
  return row?.content ?? null;
}

export async function moveNotes(ctx: OrgContext, report: MoveReport): Promise<void> {
  const { orgId } = ctx;
  report.skippedAlreadyMoved += await alreadyMoved(orgId, 'notes', 'note');
  const pending = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM notes moved_note
    WHERE moved_note.org_id = ${orgId}
      AND NOT EXISTS (SELECT 1 FROM note_document_map m WHERE m.org_id = moved_note.org_id AND m.source_type = 'note' AND m.source_id = moved_note.id)
    ORDER BY moved_note.created_at, moved_note.id`));
  if (pending.length > 0) ctx.currentHolders = await currentContentHolders(orgId);
  for (const { id } of pending) {
    try {
      const counts = await db.transaction((tx) => moveNoteInTx(tx, ctx, id));
      // Counted only after the commit: a failure rolls back and adds nothing.
      if (counts === 'already_moved') report.skippedAlreadyMoved += 1;
      else if (counts) addCounts(report, counts);
    } catch (error) {
      report.errors.push({ sourceId: id, message: failureMessage(error) });
    }
  }
}

/** The counts a note adds to the report, applied once its transaction commits. */
type NoteCounts = Partial<Record<'notes' | 'versions' | 'shares' | 'favourites' | 'unsafeDropped' | 'missingImages' | 'versionUnsafeDropped'
  | 'versionMissingImages' | 'splitNotes' | 'subPages' | 'splitBlocks' | 'spaceNotesMadePrivate' | 'frozenDrives' | 'unplacedImages'
  | 'missingImageBytes' | 'agentsKeptOnSharedNotes' | 'workspaceNotes', number>>;

function addCounts(report: MoveReport, counts: NoteCounts): void {
  for (const [key, value] of Object.entries(counts) as Array<[keyof NoteCounts, number]>) {
    if (key === 'workspaceNotes') report.guestsPotentiallyAffected.workspaceNotes += value;
    else report[key] += value;
  }
}

async function moveNoteInTx(tx: Tx, ctx: OrgContext, noteId: string): Promise<NoteCounts | 'already_moved' | null> {
  const { orgId } = ctx;
  await lockOrgInTx(tx, orgId);
  if (await mappedTarget(tx, orgId, 'note', noteId)) return 'already_moved';
  const [note] = rowsOf<NoteRow>(await tx.execute(sql`SELECT id, org_id, user_id, folder_id, title, content, icon, is_pinned, is_template,
      is_deleted, visibility, visibility_space_id, created_at::text AS created_at, updated_at::text AS updated_at
    FROM notes WHERE id = ${noteId} AND org_id = ${orgId} FOR SHARE`));
  if (!note) return null;
  // The history: its rows without their content, which is read one version at a time below.
  const versions = rowsOf<VersionRow>(await tx.execute(sql`SELECT history_row.id, history_row.version, history_row.title,
      history_row.edited_by, history_row.created_at::text AS created_at
    FROM note_versions history_row JOIN notes history_note ON history_note.id = history_row.note_id
    WHERE history_row.note_id = ${noteId} AND history_note.org_id = ${orgId}
    ORDER BY history_row.version, history_row.created_at, history_row.id`));
  const shares = rowsOf<{ user_id: string; permission: string }>(await tx.execute(sql`SELECT share.shared_with_user_id AS user_id, share.permission
    FROM note_shares share JOIN notes shared_note ON shared_note.id = share.note_id
    WHERE share.note_id = ${noteId} AND shared_note.org_id = ${orgId}
    ORDER BY share.created_at, share.id`));
  const noteFiles = rowsOf<{ file_id: string }>(await tx.execute(sql`SELECT file_id FROM note_files
    WHERE note_id = ${noteId} AND org_id = ${orgId} ORDER BY file_id`)).map((row) => row.file_id);

  const counts: NoteCounts = {};
  const add = (key: keyof NoteCounts, n = 1) => { counts[key] = (counts[key] ?? 0) + n; };
  const details: Record<string, unknown> = {};
  const author = note.user_id;
  const authorIsMember = ctx.members.has(author);

  // Where it goes, and the shares that keep its readers.
  const shareSet = new ShareSet();
  let driveId: string;
  let folderId: string | null = null;
  if (note.visibility === 'org') {
    // A deleted one whose author has no membership row (so no drive of their own) goes to Shared notes as well (C3).
    if (!note.is_deleted || ctx.sharedNotesWanted || !authorIsMember) {
      const shared = await sharedNotesDriveInTx(tx, ctx, author);
      add('agentsKeptOnSharedNotes', shared.agentsAdded);
      driveId = shared.id;
      // A live note goes in its author's folder; a deleted one at the root, in the trash (O-F10).
      if (!note.is_deleted) folderId = await authorFolderInTx(tx, orgId, driveId, author);
      details.shared_notes = true;
      if (note.is_deleted && !ctx.sharedNotesWanted) details.deleted_workspace_note = 'shared_notes_author_not_member';
    } else {
      // Only deleted workspace notes: no Shared notes drive is made for them; the author's drive holds them, in the trash.
      const drive = await personalDriveInTx(tx, ctx, author);
      if (drive.frozenCreated) add('frozenDrives');
      driveId = drive.id;
      details.deleted_workspace_note = 'personal_drive';
    }
    if (authorIsMember) shareSet.add({ type: 'user', id: author }, 'edit');
    else details.author_share_skipped = 'not_a_member';
    if (!note.is_deleted) add('workspaceNotes');
  } else {
    const drive = await personalDriveInTx(tx, ctx, author);
    if (drive.frozenCreated) add('frozenDrives');
    driveId = drive.id;
    if (drive.frozen) details.frozen_drive = true;
    if (note.folder_id) folderId = await noteFolderInTx(tx, orgId, note, driveId, details);
    if (note.visibility === 'space') {
      if (await spaceInOrg(tx, orgId, note.visibility_space_id)) {
        shareSet.add({ type: 'space', id: note.visibility_space_id! }, 'view');
      } else {
        details.made_private = note.visibility_space_id ? 'space_not_in_workspace' : 'no_space';
        add('spaceNotesMadePrivate');
      }
    }
  }
  const skippedShares: string[] = [];
  for (const share of shares) {
    if (ctx.members.has(share.user_id)) shareSet.add({ type: 'user', id: share.user_id }, share.permission === 'edit' ? 'edit' : 'view');
    else skippedShares.push(share.user_id);
  }
  if (skippedShares.length > 0) details.skipped_shares = skippedShares;

  // The images: every file the current content, note_files and each old version name is looked up once
  // (fileFactsInTx). Each snapshot then shows only the images its own writer uploaded (S-F1): the current
  // content and note_files its author's, each old version its editor's (the author's when no editor is
  // recorded), never one snapshot's uploader for another. The history is read and converted one version
  // at a time and let go (memory stays one version deep); its images are kept as ids only.
  const current = noteHtmlToJson(note.content);
  const candidates = new Set<string>([...imageFileIds(current.json), ...noteFiles]);
  for (const version of versions) {
    for (const fileId of imageFileIds(noteHtmlToJson(await versionContent(tx, orgId, noteId, version.id)).json)) candidates.add(fileId);
  }
  const facts = await fileFactsInTx(tx, orgId, candidates, (fileId) => {
    const holder = ctx.currentHolders.get(fileId);
    return holder !== undefined && holder !== noteId;
  }, { acceptMissingImages: ctx.acceptMissingImages });
  const authorUploads = new Set([author]);
  const currentShows = new Set(imageFileIds(current.json).filter((fileId) => imageAllowed(facts, fileId, authorUploads)));
  const linked = new Set([...currentShows, ...noteFiles.filter((fileId) => imageAllowed(facts, fileId, authorUploads))]);

  const shown = replaceUnlinkedImages(current.json, currentShows);
  const { parts, splitBlocks } = splitToFit(finishContent(shown.json, noteId), note.title, noteId);

  // The document, and its sub-pages when it had to be split.
  const deletedAt = note.is_deleted ? note.updated_at : null;
  const base = {
    orgId, driveId, icon: note.icon, isTemplate: note.is_template, createdBy: author, lastEditedBy: author,
    lastEditedAt: note.updated_at, createdAt: note.created_at, updatedAt: note.updated_at, deletedAt, deletedBy: note.is_deleted ? author : null,
  };
  const mainId = await insertDocumentInTx(tx, {
    ...base, folderId, parentDocumentId: null, title: parts[0]!.title, position: await nextRootPosition(tx, orgId, driveId, folderId),
    json: parts[0]!.json,
  });
  // The shares first, on the first part: each sub-page then starts with them (F9's sub-page rule, in F5's create).
  const firstShares = await insertSharesInTx(tx, orgId, [mainId], shareSet, author);
  add('shares', firstShares * parts.length);
  const docs: Array<{ id: string; fileIds: Set<string> }> = [{ id: mainId, fileIds: new Set(imageFileIds(parts[0]!.json)) }];
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index]!;
    const id = await insertDocumentInTx(tx, {
      ...base, folderId: null, parentDocumentId: mainId, title: part.title, position: index, json: part.json,
    });
    docs.push({ id, fileIds: new Set(imageFileIds(part.json)) });
  }
  if (parts.length > 1) {
    add('splitNotes');
    add('subPages', parts.length - 1);
    add('splitBlocks', splitBlocks);
  }

  // The history, one version at a time, on the first part. A version is kept whole, even over the live
  // size cap: it can be viewed. Restoring one over the cap is refused with 413 TOO_LARGE (writeDocument),
  // and restoring any moved version of a split note with 409 SPLIT_HISTORY (document-versions.ts, S-F2).
  // Times are strictly increasing in version order (VersionTimes).
  const times = new VersionTimes();
  const historyFileIds = new Set<string>();
  for (const version of versions) {
    const converted = noteHtmlToJson(await versionContent(tx, orgId, noteId, version.id));
    const editorUploads = new Set([version.edited_by ?? author]);
    const versionShows = new Set(imageFileIds(converted.json).filter((fileId) => imageAllowed(facts, fileId, editorUploads)));
    const replaced = replaceUnlinkedImages(converted.json, versionShows);
    const json = finishContent(replaced.json, noteId);
    for (const fileId of versionShows) {
      historyFileIds.add(fileId);
      linked.add(fileId);
    }
    add('versionUnsafeDropped', converted.unsafeDropped);
    add('versionMissingImages', replaced.missing);
    await insertMovedVersionInTx(tx, {
      orgId, documentId: mainId, title: version.title, json, createdBy: version.edited_by,
      createdAt: await times.next(tx, version.created_at), editDetails: { note_version: version.version },
    });
  }
  add('versions', versions.length);
  const refused = [...facts].filter(([fileId]) => !linked.has(fileId))
    .map(([fileId, fact]) => [fileId, fact.refusal ?? 'uploaded_by_someone_else'] as [string, FileRefusal]);
  if (refused.length > 0) details.image_refusals = Object.fromEntries(refused);
  const lostBytes = refused.filter(([, refusal]) => refusal === 'bytes_missing').length;
  if (lostBytes > 0) add('missingImageBytes', lostBytes);
  const linkedIds = [...linked].sort();
  await linkFilesInTx(tx, orgId, linkedIds, docs, historyFileIds);
  const shownAnywhere = new Set([...docs.flatMap((doc) => [...doc.fileIds]), ...historyFileIds]);
  const unplaced = linkedIds.filter((fileId) => !shownAnywhere.has(fileId));
  if (unplaced.length > 0) {
    details.unplaced_images = unplaced;
    add('unplacedImages', unplaced.length);
  }
  if (note.is_pinned) {
    if (authorIsMember) {
      await tx.execute(sql`INSERT INTO doc_favorites (id, org_id, user_id, target_type, target_id)
        VALUES (gen_random_uuid()::text, ${orgId}, ${author}, 'document', ${mainId})
        ON CONFLICT (user_id, target_type, target_id) DO NOTHING`);
      add('favourites');
    } else {
      details.favourite_skipped = 'not_a_member';
    }
  }

  add('notes');
  add('unsafeDropped', current.unsafeDropped);
  add('missingImages', shown.missing);
  Object.assign(details, {
    drive_id: driveId, parts: docs.map((doc) => doc.id), unsafe_dropped: current.unsafeDropped, missing_images: shown.missing,
    version_unsafe_dropped: counts.versionUnsafeDropped ?? 0, version_missing_images: counts.versionMissingImages ?? 0,
    versions: versions.length, linked_images: linkedIds.length, ...(splitBlocks > 0 ? { split_blocks: splitBlocks } : {}),
  });
  await insertMapRow(tx, {
    orgId, legacyType: 'note', sourceId: noteId, targetType: 'document', targetId: mainId,
    outcome: outcomeOf(current.unsafeDropped, shown.missing), details,
  });
  return counts;
}

/** The note folder's doc folder, when the note goes where it was: its author's folder, moved, in this drive (a live note never into a deleted one). */
async function noteFolderInTx(tx: Tx, orgId: string, note: NoteRow, driveId: string, details: Record<string, unknown>): Promise<string | null> {
  const [folder] = rowsOf<{ user_id: string; is_deleted: boolean }>(await tx.execute(sql`SELECT user_id, is_deleted FROM note_folders
    WHERE id = ${note.folder_id} AND org_id = ${orgId}`));
  if (!folder || folder.user_id !== note.user_id || (folder.is_deleted && !note.is_deleted)) {
    details.moved_to_root = folder ? (folder.is_deleted ? 'folder_deleted' : 'folder_not_the_authors') : 'folder_missing';
    return null;
  }
  const target = await mappedTarget(tx, orgId, 'note_folder', note.folder_id!);
  if (!target) throw new MoveError('folder_not_moved', 'The note’s folder has not moved yet');
  const [docFolder] = rowsOf<{ drive_id: string }>(await tx.execute(sql`SELECT drive_id FROM doc_folders WHERE id = ${target} AND org_id = ${orgId}`));
  if (docFolder?.drive_id !== driveId) {
    details.moved_to_root = 'folder_in_another_drive';
    return null;
  }
  return target;
}

