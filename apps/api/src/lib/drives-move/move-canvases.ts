// The notes move (plan Task F14, spec 5.11): chat canvases.
//
// A canvas with content becomes a document titled with the canvas title, at
// the root of its owner's personal drive, shared with its chat as `edit`:
// every member of a chat could write its canvas (routes/canvas.ts PATCH needs
// only membership), guests in it included. Its owner (consult change) is the
// person who last edited it when they are an active human member who is not
// a guest; otherwise the chat's creator, on the same terms; otherwise the
// workspace's first owner. An empty canvas (no content, or only blank
// paragraphs) is dropped: no document, no map row, counted on every run.
//
// The canvas's TipTap JSON is read leniently (convert-note.ts
// canvasContentToJson): anything outside the document schema becomes
// paragraphs of its text, counted. Its images follow the notes' rule, with the
// last editor or the owner as the uploader. Each canvas moves in its own
// transaction with its map row, under the workspace's move lock.
import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import { canvasContentToJson, finishContent, imageFileIds, MoveError, replaceUnlinkedImages, splitToFit } from './convert-note.js';
import {
  decideFilesInTx, failureMessage, insertDocumentInTx, insertMapRow, insertSharesInTx, isActiveFullHuman, linkFilesInTx, lockOrgInTx,
  mappedTarget, nextRootPosition, outcomeOf, personalDriveInTx, rowsOf, ShareSet, type OrgContext, type TimestampText, type Tx,
} from './placement.js';
import type { MoveReport } from './move-org.js';

type CanvasRow = {
  id: string; space_id: string; title: string; content: unknown; last_edited_by: string | null; last_edited_at: TimestampText | null;
  created_at: TimestampText; updated_at: TimestampText; space_creator: string | null; space_org: string | null;
};

type CanvasOutcome = 'already_moved' | 'empty' | { frozenCreated: boolean; shares: number; missingImages: number; subPages: number; splitBlocks: number };

export async function moveCanvases(ctx: OrgContext, report: MoveReport): Promise<void> {
  const { orgId } = ctx;
  const [moved] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM canvases moved_canvas
    WHERE moved_canvas.org_id = ${orgId}
      AND EXISTS (SELECT 1 FROM note_document_map m WHERE m.org_id = moved_canvas.org_id AND m.source_type = 'canvas' AND m.source_id = moved_canvas.id)`));
  report.skippedAlreadyMoved += Number(moved?.n ?? 0);
  const pending = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM canvases moved_canvas
    WHERE moved_canvas.org_id = ${orgId}
      AND NOT EXISTS (SELECT 1 FROM note_document_map m WHERE m.org_id = moved_canvas.org_id AND m.source_type = 'canvas' AND m.source_id = moved_canvas.id)
    ORDER BY moved_canvas.created_at, moved_canvas.id`));
  for (const { id } of pending) {
    try {
      const outcome = await db.transaction((tx) => moveCanvasInTx(tx, ctx, id));
      if (outcome === 'already_moved') report.skippedAlreadyMoved += 1;
      else if (outcome === 'empty') report.emptyCanvases += 1;
      else {
        report.canvases += 1;
        report.shares += outcome.shares;
        report.missingImages += outcome.missingImages;
        if (outcome.frozenCreated) report.frozenDrives += 1;
        if (outcome.subPages > 0) {
          report.splitNotes += 1;
          report.subPages += outcome.subPages;
          report.splitBlocks += outcome.splitBlocks;
        }
      }
    } catch (error) {
      report.errors.push({ sourceId: id, message: failureMessage(error) });
    }
  }
}

async function moveCanvasInTx(tx: Tx, ctx: OrgContext, canvasId: string): Promise<CanvasOutcome> {
  const { orgId } = ctx;
  await lockOrgInTx(tx, orgId);
  if (await mappedTarget(tx, orgId, 'canvas', canvasId)) return 'already_moved';
  const [canvas] = rowsOf<CanvasRow>(await tx.execute(sql`SELECT moved_canvas.id, moved_canvas.space_id, moved_canvas.title, moved_canvas.content,
      moved_canvas.last_edited_by, moved_canvas.last_edited_at::text AS last_edited_at, moved_canvas.created_at::text AS created_at,
      moved_canvas.updated_at::text AS updated_at, chat.created_by AS space_creator, chat.org_id AS space_org
    FROM canvases moved_canvas LEFT JOIN spaces chat ON chat.id = moved_canvas.space_id AND chat.org_id = moved_canvas.org_id
    WHERE moved_canvas.id = ${canvasId} AND moved_canvas.org_id = ${orgId}
    FOR SHARE OF moved_canvas`));
  if (!canvas) return 'empty';
  const converted = canvasContentToJson(canvas.content);
  if (!converted.json) return 'empty';

  const chatCreator = canvas.space_org === orgId ? canvas.space_creator : null;
  const owner = isActiveFullHuman(ctx, canvas.last_edited_by) ? canvas.last_edited_by
    : isActiveFullHuman(ctx, chatCreator) ? chatCreator : ctx.firstOwnerId;
  if (!owner) throw new MoveError('no_canvas_owner', 'The canvas has no one to own it: no active editor, chat creator or workspace owner');
  const details: Record<string, unknown> = {
    owner_rule: owner === canvas.last_edited_by ? 'last_editor' : owner === chatCreator ? 'chat_creator' : 'first_owner',
    ...(converted.flattenedBlocks > 0 ? { flattened_blocks: converted.flattenedBlocks } : {}),
  };
  const drive = await personalDriveInTx(tx, ctx, owner);

  const allowed = new Map<string, Set<string>>();
  for (const fileId of imageFileIds(converted.json)) allowed.set(fileId, new Set([owner, ...(canvas.last_edited_by ? [canvas.last_edited_by] : [])]));
  const decisions = await decideFilesInTx(tx, orgId, allowed);
  const linked = new Set([...decisions].filter(([, decision]) => decision === 'linked').map(([fileId]) => fileId));
  const shown = replaceUnlinkedImages(converted.json, linked);
  const title = canvas.title.trim() || 'Canvas';
  const { parts, splitBlocks } = splitToFit(finishContent(shown.json, canvasId), title, canvasId);

  const base = {
    orgId, driveId: drive.id, icon: null, isTemplate: false, createdBy: owner, lastEditedBy: canvas.last_edited_by ?? owner,
    lastEditedAt: canvas.last_edited_at ?? canvas.updated_at, createdAt: canvas.created_at, updatedAt: canvas.updated_at,
    deletedAt: null, deletedBy: null,
  };
  const mainId = await insertDocumentInTx(tx, {
    ...base, folderId: null, parentDocumentId: null, title: parts[0]!.title, position: await nextRootPosition(tx, orgId, drive.id, null),
    json: parts[0]!.json,
  });
  // The share first, on the first part: each sub-page then starts with it (F9's sub-page rule, in F5's create).
  const shareSet = new ShareSet();
  if (canvas.space_org === orgId) shareSet.add({ type: 'space', id: canvas.space_id }, 'edit');
  else details.share_skipped = 'space_not_in_workspace';
  const shares = (await insertSharesInTx(tx, orgId, [mainId], shareSet, owner)) * parts.length;
  const docs = [{ id: mainId, fileIds: new Set(imageFileIds(parts[0]!.json)) }];
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index]!;
    const id = await insertDocumentInTx(tx, { ...base, folderId: null, parentDocumentId: mainId, title: part.title, position: index, json: part.json });
    docs.push({ id, fileIds: new Set(imageFileIds(part.json)) });
  }
  await linkFilesInTx(tx, orgId, [...linked].sort(), docs, new Set());
  Object.assign(details, { drive_id: drive.id, parts: docs.map((doc) => doc.id), missing_images: shown.missing, linked_images: linked.size,
    ...(splitBlocks > 0 ? { split_blocks: splitBlocks } : {}) });
  await insertMapRow(tx, {
    orgId, legacyType: 'canvas', sourceId: canvasId, targetType: 'document', targetId: mainId, outcome: outcomeOf(0, shown.missing), details,
  });
  return { frozenCreated: drive.frozenCreated, shares, missingImages: shown.missing, subPages: parts.length - 1, splitBlocks };
}
