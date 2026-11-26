// The notes move at API startup (plan Task F14, consult change): server.ts
// awaits moveNotesBeforeListen before it calls serve(), so the API never
// serves a half-moved workspace.
// - While the start is paused (DEFT_PAUSED_START, rule C6) nothing is moved:
//   a paused install writes nothing at startup. The drive list says the notes
//   move when the workspace resumes (GET /api/drives notes_move_pending).
// - Otherwise every workspace that still has something to move
//   (pending.ts) is moved (move-org.ts). If any source failed, or anything is
//   still left, this throws and the API does not start: the operator runs
//   `pnpm drives:move` to read the report. The post-move check runs after a
//   move here and its result is logged; it doesn't stop the start, since the
//   move itself finished.
// The upgrade container normally moves everything first (`pnpm drives:move`
// after `db:upgrade`), so a start usually finds nothing to do. Logs carry
// counts only.
import { logNumber } from '../log-metadata.js';
import { isPausedStart } from '../paused-start.js';
import { postMoveCheck } from './check.js';
import { moveOrg } from './move-org.js';
import { orgsNeedingMove } from './pending.js';

export type StartupMove = { skipped: 'paused' | null; movedOrgs: number };

/** What to look at: every workspace by default (`orgIds` is for tests). */
export async function moveNotesBeforeListen(options: { orgIds?: readonly string[] } = {}): Promise<StartupMove> {
  if (isPausedStart()) {
    console.warn('[startup] Paused: notes and canvases move into drives when the workspace resumes');
    return { skipped: 'paused', movedOrgs: 0 };
  }
  const orgIds = await withRetries(() => orgsNeedingMove(options.orgIds));
  if (orgIds.length === 0) return { skipped: null, movedOrgs: 0 };
  console.log(`[startup] Moving notes and canvases into drives for ${logNumber(orgIds.length)} workspace(s) before listening`);
  let failures = 0;
  for (const orgId of orgIds) {
    const report = await moveOrg(orgId);
    failures += report.errors.length;
    console.log(`[startup] Notes move: ${logNumber(report.notes)} note(s), ${logNumber(report.folders)} folder(s), `
      + `${logNumber(report.canvases)} canvas(es) moved; ${logNumber(report.errors.length)} failed`);
  }
  const left = await orgsNeedingMove(orgIds);
  if (failures > 0 || left.length > 0) {
    throw new Error(`[startup] The notes move did not finish (${logNumber(failures)} source(s) failed, `
      + `${logNumber(left.length)} workspace(s) still to move). Refusing to listen: run pnpm drives:move for the report.`);
  }
  for (const orgId of orgIds) {
    const check = await postMoveCheck(orgId);
    if (!check.ok) {
      console.warn(`[startup] The post-move check found ${logNumber(check.mismatches.length)} mismatch(es) and `
        + `${logNumber(check.sampleFailed.length)} sample failure(s): run pnpm drives:move --check-only for the details`);
    }
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
