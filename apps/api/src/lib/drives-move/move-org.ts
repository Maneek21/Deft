// The notes move (plan Task F14, spec 5.11): one workspace's notes, note
// folders and chat canvases into drives and documents, once.
//
// Where it runs (consult change): in the upgrade container right after
// `db:upgrade` (`pnpm drives:move`, scripts/drives-move.ts), and inline when
// the API starts, before it listens, unless the start is paused
// (startup.ts). There is no background job: the app never serves a
// half-moved workspace.
//
// moveOrg makes sure the Workspace drive exists, then moves folders (parents
// first), notes and canvases, each source in its own transaction under the
// workspace's advisory lock, pg_advisory_xact_lock(hashtext('drives-move:' ||
// orgId)), with its note_document_map row (move-notes.ts, move-canvases.ts),
// and last rewrites the references to moved notes (rewrite-references.ts).
// A source already mapped is skipped, so running it again changes nothing and
// a run that stopped part way resumes. A source that fails is rolled back and
// listed in `errors`; the rest go on. The notes and canvas tables are only
// read.
//
// The report counts what this run did. Deliberate change, reported:
// guests lose the notes that were visible to the whole workspace, because
// open drives exclude guests (spec 5.2): `guestsLoseWorkspaceNotes` gives
// the active guests and the workspace notes moved.
import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import { ensureWorkspaceDrive } from '../drives.js';
import { moveCanvases } from './move-canvases.js';
import { moveNoteFolders, moveNotes } from './move-notes.js';
import { failureMessage, loadOrgContext, lockOrgInTx, rowsOf } from './placement.js';
import { emptyReferenceRewrite, rewriteReferences, type ReferenceRewrite } from './rewrite-references.js';

export type MoveReport = {
  orgId: string; notes: number; folders: number; canvases: number; versions: number; shares: number;
  favourites: number; unsafeDropped: number; missingImages: number; skippedAlreadyMoved: number; errors: Array<{ sourceId: string; message: string }>;
  /** Canvases with no content: dropped, no document (counted on every run). */
  emptyCanvases: number;
  /** Notes and canvases split into a page and sub-pages, the sub-pages made, and the single blocks that had to be split themselves. */
  splitNotes: number; subPages: number; splitBlocks: number;
  /** In versions, apart from the current content. */
  versionUnsafeDropped: number; versionMissingImages: number;
  /** Linked files note_files named that no converted content shows (linked as history). */
  unplacedImages: number;
  /** Space notes with no chat of this workspace: they became private. */
  spaceNotesMadePrivate: number;
  /** Personal drives made frozen, for deactivated, agent and system authors. */
  frozenDrives: number;
  guestsLoseWorkspaceNotes: { guests: number; notes: number };
  references: ReferenceRewrite;
};

export function emptyMoveReport(orgId: string): MoveReport {
  return {
    orgId, notes: 0, folders: 0, canvases: 0, versions: 0, shares: 0, favourites: 0, unsafeDropped: 0, missingImages: 0,
    skippedAlreadyMoved: 0, errors: [], emptyCanvases: 0, splitNotes: 0, subPages: 0, splitBlocks: 0, versionUnsafeDropped: 0,
    versionMissingImages: 0, unplacedImages: 0, spaceNotesMadePrivate: 0, frozenDrives: 0, guestsLoseWorkspaceNotes: { guests: 0, notes: 0 },
    references: emptyReferenceRewrite(),
  };
}

export async function moveOrg(orgId: string): Promise<MoveReport> {
  const report = emptyMoveReport(orgId);
  await db.transaction(async (tx) => {
    await lockOrgInTx(tx, orgId);
    await ensureWorkspaceDrive(orgId, tx);
  });
  const ctx = await loadOrgContext(orgId);
  await moveNoteFolders(ctx, report);
  await moveNotes(ctx, report);
  await moveCanvases(ctx, report);
  try {
    report.references = await rewriteReferences(orgId);
  } catch (error) {
    report.errors.push({ sourceId: orgId, message: `References could not be rewritten: ${failureMessage(error)}` });
  }
  if (report.guestsLoseWorkspaceNotes.notes > 0) {
    const [guests] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM org_members
      WHERE org_id = ${orgId} AND role = 'guest' AND is_active = true`));
    report.guestsLoseWorkspaceNotes.guests = Number(guests?.n ?? 0);
  }
  return report;
}
