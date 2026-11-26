// The notes move (plan Task F14, spec 5.11): chat canvases.
//
// A canvas with content becomes a document titled with the canvas title,
// shared with its chat as `edit`: every member of a chat could write its
// canvas (routes/canvas.ts PATCH needs only membership), guests in it
// included. Where it goes keeps who could read it (consult O-F4):
// - a public chat's canvas could be read by every member who isn't a guest,
//   joined or not (canReadSpace): it goes into the Shared notes drive (every
//   member gets its default view; guests don't, as canReadSpace gave them
//   nothing), in a folder named "Chat canvases";
// - any other chat's canvas (private, a DM, a group DM) could be read only
//   by its members: it goes into its owner's My drive.
// Its owner (consult O-F5), for a private chat the person whose drive holds
// it, is someone with current access to the chat: an active human member who
// isn't a guest and has a seat in it. In order: the person who last edited
// it, if eligible; the chat's creator, if eligible; the earliest-joined
// eligible member; else the workspace's earliest active human owner (never
// an inactive or agent owner, whose drive would be frozen), as the approved
// design says, counted in canvasesPlacedWithWorkspaceOwner. With no active
// human owner either, the canvas goes into the frozen personal drive of its
// last editor, else of the chat's creator (whoever has a membership row),
// made as for an inactive author, counted in canvasesInFrozenDrives: the
// chat's edit share gives view until the workspace owner hands the drive on
// (F6), accepted for this edge so one canvas never holds a workspace back.
// Only a canvas with neither person at all is dropped and counted as an
// empty canvas is, its content kept whole in the move's report
// (unplaceableCanvases; pending.ts canvasPlaceableSql is the same rule).
// For a public chat's canvas the owner is only who it is credited to.
//
// An empty canvas (no content, a document keeping no block, or only blank
// paragraphs) is dropped: no document, no map row, counted on every run.
// The canvas's TipTap JSON is read leniently (convert-note.ts
// canvasContentToJson): anything outside the document schema becomes
// paragraphs of its text, counted. An image links only when the canvas's
// last editor uploaded it (consult O-F6): nobody else wrote the content, and
// any chat member could have written a file id into it. Every other image
// becomes "Image not available", counted. Each canvas moves in its own
// transaction with its map row, under the workspace's move lock.
import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import { canvasContentToJson, finishContent, imageFileIds, replaceUnlinkedImages, splitToFit } from './convert-note.js';
import {
  chatCanvasesFolderInTx, failureMessage, fileFactsInTx, frozenPersonalDriveInTx, imageAllowed, insertDocumentInTx, insertMapRow, insertSharesInTx, isActiveFullHuman,
  linkFilesInTx, lockOrgInTx, mappedTarget, nextRootPosition, outcomeOf, personalDriveInTx, rowsOf, ShareSet, sharedNotesDriveInTx,
  type FileRefusal, type OrgContext, type TimestampText, type Tx,
} from './placement.js';
import type { MoveReport } from './move-org.js';

type CanvasRow = {
  id: string; space_id: string; title: string; content: unknown; last_edited_by: string | null; last_edited_at: TimestampText | null;
  created_at: TimestampText; updated_at: TimestampText; space_creator: string | null; space_org: string | null; space_type: string | null;
};

/** A canvas nobody can own at all, kept whole in the move's report. */
export type DroppedCanvas = { canvasId: string; spaceId: string; title: string; content: unknown };

type CanvasOutcome = 'already_moved' | 'empty' | { unplaceable: DroppedCanvas } | {
  frozenCreated: boolean; shares: number; missingImages: number; subPages: number; splitBlocks: number; agentsAdded: number;
  placedWithWorkspaceOwner: boolean; inFrozenDrive: boolean;
};

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
      else if ('unplaceable' in outcome) {
        // Nobody can own it: dropped and counted as an empty canvas is, its content kept in the report.
        report.emptyCanvases += 1;
        report.unplaceableCanvases.push(outcome.unplaceable);
      } else {
        report.canvases += 1;
        report.shares += outcome.shares;
        report.missingImages += outcome.missingImages;
        report.agentsKeptOnSharedNotes += outcome.agentsAdded;
        if (outcome.frozenCreated) report.frozenDrives += 1;
        if (outcome.placedWithWorkspaceOwner) report.canvasesPlacedWithWorkspaceOwner += 1;
        if (outcome.inFrozenDrive) report.canvasesInFrozenDrives += 1;
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

/** The members of the chat who could own its canvas (eligible, with a seat), earliest-joined first. */
async function eligibleSeats(tx: Tx, ctx: OrgContext, spaceId: string): Promise<string[]> {
  const seats = rowsOf<{ user_id: string }>(await tx.execute(sql`SELECT seat.user_id FROM space_members seat
    JOIN spaces chat ON chat.id = seat.space_id AND chat.org_id = ${ctx.orgId}
    WHERE seat.space_id = ${spaceId}
    ORDER BY seat.joined_at, seat.id`)).map((row) => row.user_id);
  return seats.filter((userId) => isActiveFullHuman(ctx, userId));
}

async function moveCanvasInTx(tx: Tx, ctx: OrgContext, canvasId: string): Promise<CanvasOutcome> {
  const { orgId } = ctx;
  await lockOrgInTx(tx, orgId);
  if (await mappedTarget(tx, orgId, 'canvas', canvasId)) return 'already_moved';
  const [canvas] = rowsOf<CanvasRow>(await tx.execute(sql`SELECT moved_canvas.id, moved_canvas.space_id, moved_canvas.title, moved_canvas.content,
      moved_canvas.last_edited_by, moved_canvas.last_edited_at::text AS last_edited_at, moved_canvas.created_at::text AS created_at,
      moved_canvas.updated_at::text AS updated_at, chat.created_by AS space_creator, chat.org_id AS space_org, chat.type::text AS space_type
    FROM canvases moved_canvas LEFT JOIN spaces chat ON chat.id = moved_canvas.space_id AND chat.org_id = moved_canvas.org_id
    WHERE moved_canvas.id = ${canvasId} AND moved_canvas.org_id = ${orgId}
    FOR SHARE OF moved_canvas`));
  if (!canvas) return 'empty';
  const converted = canvasContentToJson(canvas.content);
  if (!converted.json) return 'empty';

  // The owner: current access to the chat first (O-F5).
  const chatInWorkspace = canvas.space_org === orgId;
  const chatCreator = chatInWorkspace ? canvas.space_creator : null;
  const seats = chatInWorkspace ? await eligibleSeats(tx, ctx, canvas.space_id) : [];
  const seated = (userId: string | null) => userId !== null && seats.includes(userId);
  let owner: string | null;
  let ownerRule: string;
  if (seated(canvas.last_edited_by)) { owner = canvas.last_edited_by; ownerRule = 'last_editor'; }
  else if (seated(chatCreator)) { owner = chatCreator; ownerRule = 'chat_creator'; }
  else if (seats.length > 0) { owner = seats[0]!; ownerRule = 'earliest_member'; }
  else if (ctx.firstOwnerId) { owner = ctx.firstOwnerId; ownerRule = 'first_owner'; }
  // Nobody eligible: the frozen personal drive of the last editor, else of the chat's creator, if they have a
  // membership row (its owner trigger needs one). The chat's edit share is capped at view until an owner hands the
  // drive on (F6); accepted for this edge, so a workspace is never held back by one canvas.
  else if (canvas.last_edited_by && ctx.members.has(canvas.last_edited_by)) { owner = canvas.last_edited_by; ownerRule = 'frozen_last_editor'; }
  else if (chatCreator && ctx.members.has(chatCreator)) { owner = chatCreator; ownerRule = 'frozen_chat_creator'; }
  else {
    // Nobody at all: dropped and counted as an empty canvas is, its content kept in the move's report (canvasPlaceableSql).
    return { unplaceable: { canvasId, spaceId: canvas.space_id, title: canvas.title, content: canvas.content } };
  }
  if (!owner) return { unplaceable: { canvasId, spaceId: canvas.space_id, title: canvas.title, content: canvas.content } };
  const isPublic = chatInWorkspace && canvas.space_type === 'public';
  const frozenFallback = ownerRule.startsWith('frozen_');
  const details: Record<string, unknown> = {
    owner_id: owner, owner_rule: ownerRule, placement: isPublic ? 'shared_notes' : 'owner_drive',
    ...(converted.flattenedBlocks > 0 ? { flattened_blocks: converted.flattenedBlocks } : {}),
  };

  // Where it goes, keeping who could read it (O-F4).
  let driveId: string;
  let folderId: string | null = null;
  let frozenCreated = false;
  let agentsAdded = 0;
  if (isPublic) {
    const shared = await sharedNotesDriveInTx(tx, ctx, owner);
    driveId = shared.id;
    agentsAdded = shared.agentsAdded;
    folderId = await chatCanvasesFolderInTx(tx, orgId, driveId);
  } else {
    const drive = frozenFallback ? await frozenPersonalDriveInTx(tx, ctx, owner) : await personalDriveInTx(tx, ctx, owner);
    driveId = drive.id;
    frozenCreated = drive.frozenCreated;
  }

  // Images: only the last editor's uploads (O-F6).
  const facts = await fileFactsInTx(tx, orgId, imageFileIds(converted.json), () => false);
  const editorUploads = new Set(canvas.last_edited_by ? [canvas.last_edited_by] : []);
  const shows = new Set(imageFileIds(converted.json).filter((fileId) => imageAllowed(facts, fileId, editorUploads)));
  const shown = replaceUnlinkedImages(converted.json, shows);
  const refused = [...facts].filter(([fileId]) => !shows.has(fileId))
    .map(([fileId, fact]) => [fileId, fact.refusal ?? 'uploaded_by_someone_else'] as [string, FileRefusal]);
  if (refused.length > 0) details.image_refusals = Object.fromEntries(refused);
  const title = canvas.title.trim() || 'Canvas';
  const { parts, splitBlocks } = splitToFit(finishContent(shown.json, canvasId), title, canvasId);

  const base = {
    orgId, driveId, icon: null, isTemplate: false, createdBy: owner, lastEditedBy: canvas.last_edited_by ?? owner,
    lastEditedAt: canvas.last_edited_at ?? canvas.updated_at, createdAt: canvas.created_at, updatedAt: canvas.updated_at,
    deletedAt: null, deletedBy: null,
  };
  const mainId = await insertDocumentInTx(tx, {
    ...base, folderId, parentDocumentId: null, title: parts[0]!.title, position: await nextRootPosition(tx, orgId, driveId, folderId),
    json: parts[0]!.json,
  });
  // The share first, on the first part: each sub-page then starts with it (F9's sub-page rule, in F5's create).
  const shareSet = new ShareSet();
  if (chatInWorkspace) shareSet.add({ type: 'space', id: canvas.space_id }, 'edit');
  else details.share_skipped = 'space_not_in_workspace';
  const shares = (await insertSharesInTx(tx, orgId, [mainId], shareSet, owner)) * parts.length;
  const docs = [{ id: mainId, fileIds: new Set(imageFileIds(parts[0]!.json)) }];
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index]!;
    const id = await insertDocumentInTx(tx, { ...base, folderId: null, parentDocumentId: mainId, title: part.title, position: index, json: part.json });
    docs.push({ id, fileIds: new Set(imageFileIds(part.json)) });
  }
  await linkFilesInTx(tx, orgId, [...shows].sort(), docs, new Set());
  Object.assign(details, { drive_id: driveId, parts: docs.map((doc) => doc.id), missing_images: shown.missing, linked_images: shows.size,
    ...(splitBlocks > 0 ? { split_blocks: splitBlocks } : {}) });
  await insertMapRow(tx, {
    orgId, legacyType: 'canvas', sourceId: canvasId, targetType: 'document', targetId: mainId, outcome: outcomeOf(0, shown.missing), details,
  });
  return {
    frozenCreated, shares, missingImages: shown.missing, subPages: parts.length - 1, splitBlocks, agentsAdded,
    placedWithWorkspaceOwner: !isPublic && ownerRule === 'first_owner', inFrozenDrive: !isPublic && frozenFallback,
  };
}
