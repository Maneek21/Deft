// The notes move at API startup (plan Task F14, consult change): server.ts
// awaits moveNotesBeforeListen before it calls serve(), so the API never
// serves a workspace whose move hasn't finished and passed its check.
// - While the start is paused (DEFT_PAUSED_START, rule C6) nothing is moved:
//   a paused install writes nothing at startup. The drive list says the notes
//   move when the workspace resumes (GET /api/drives notes_move_pending).
// - Otherwise every workspace without an ok run for this release
//   (pending.ts orgsWithoutFinishedMove) is moved and checked (runs.ts
//   runOrgMove), which records its run (the report in drives_move_runs). If
//   any move fails or any check isn't ok, a fixed line with its counts is
//   logged (never the report's messages or mismatch lines; `pnpm drives:move`
//   prints the full report) and this throws: the API does not listen. When
//   a source failed because the file storage was unreachable or empty, a
//   second fixed line names `pnpm drives:move --accept-missing-images` for
//   uploads that are truly gone. The start itself never accepts missing
//   images: only the script's switch does (consult C6).
// - A workspace with an ok run is never moved or checked again, so an edit
//   made after the move (a share removed, a page deleted) can't fail a
//   later start. Notes written after the move are F15's to stop.
// The upgrade container normally runs the move first (`pnpm drives:move`
// after `db:upgrade`), so a start usually finds every workspace done.
import { logNumber } from '../log-metadata.js';
import { isPausedStart } from '../paused-start.js';
import { orgsWithoutFinishedMove } from './pending.js';
import { STORAGE_UNREACHABLE_MESSAGE } from './placement.js';
import { runOrgMove } from './runs.js';

export type StartupMove = { skipped: 'paused' | null; movedOrgs: number };

/** What to look at: every workspace by default (`orgIds` is for tests). */
export async function moveNotesBeforeListen(options: { orgIds?: readonly string[] } = {}): Promise<StartupMove> {
  if (isPausedStart()) {
    console.warn('[startup] Paused: notes and canvases move into drives when the workspace resumes');
    return { skipped: 'paused', movedOrgs: 0 };
  }
  const orgIds = await withRetries(() => orgsWithoutFinishedMove(options.orgIds));
  if (orgIds.length === 0) return { skipped: null, movedOrgs: 0 };
  console.log(`[startup] Moving notes and canvases into drives for ${logNumber(orgIds.length)} workspace(s) before listening`);
  let failed = 0;
  for (const orgId of orgIds) {
    const run = await runOrgMove(orgId);
    if (run.ok) continue;
    failed += 1;
    // Counts only: the report carries error messages and mismatch lines. `pnpm drives:move` prints it whole.
    console.error(`[startup] The notes move or its post-move check failed for a workspace: ${logNumber(run.move?.errors.length ?? 0)} source(s) `
      + `failed to move, ${logNumber(run.check?.mismatches.length ?? 0)} mismatch(es), ${logNumber(run.check?.sampleFailed.length ?? 0)} `
      + 'sample failure(s). Run pnpm drives:move for the full report.');
    if (run.move?.errors.some((failure) => failure.message === STORAGE_UNREACHABLE_MESSAGE)) {
      console.error('[startup] The file storage was unreachable or empty, so images could not be checked. Fix the uploads mount, '
        + 'then run pnpm drives:move. If the uploaded files are truly gone, pnpm drives:move --accept-missing-images moves every image as '
        + '"Image not available".');
    }
  }
  if (failed > 0) {
    throw new Error(`[startup] The notes move did not pass for ${logNumber(failed)} workspace(s). Refusing to listen: `
      + 'fix what the report names, then run pnpm drives:move.');
  }
  return { skipped: null, movedOrgs: orgIds.length };
}

/** A database that is still coming up gets a few tries before the start gives up. */
async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= 5) throw error;
      console.warn(`[startup] Checking for notes to move failed (attempt ${logNumber(attempt)}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
}
