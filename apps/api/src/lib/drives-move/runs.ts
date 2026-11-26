// The notes move (plan Task F14): one workspace's run, recorded in
// drives_move_runs (one row per workspace and DRIVES_MOVE_RELEASE).
//
// A workspace whose run is ok (completed_at set and check_ok) is done: it is
// never moved, checked or recorded again, by the API start or by
// `pnpm drives:move`, so an edit made after the move (a share added) can't
// turn it back to pending. No write turns an ok row back: the upsert below
// changes only a row that isn't ok.
//
// For a workspace not yet done, runOrgMove moves it (moveOrg), then checks it
// (postMoveCheck):
// - a move with errors records the row with no completed_at and check_ok
//   false, and returns not ok;
// - a move that finished records completed_at before the check runs, with
//   check_ok false: a process that stops during the check leaves that row,
//   and the next run moves nothing new and checks again;
// - the check's result is then recorded: check_ok and the report (the move's
//   and the check's, ids and counts only).
// `--check-only` only checks; it never writes a run row. A failure is
// reported only after the run row is read again: if another mover recorded
// this workspace as done meanwhile, it is done (consult S-F3).
import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import { postMoveCheck, type PostMoveCheck } from './check.js';
import { moveOrg, type MoveReport } from './move-org.js';
import { DRIVES_MOVE_RELEASE, orgsWithoutFinishedMove } from './pending.js';

export type OrgMoveRun = {
  orgId: string; ok: boolean; skipped: 'already_done' | null; move: MoveReport | null; check: PostMoveCheck | null;
};

async function recordRun(orgId: string, completed: boolean, checkOk: boolean, report: Record<string, unknown>): Promise<void> {
  await db.execute(sql`INSERT INTO drives_move_runs (id, org_id, release_version, completed_at, check_ok, report)
    VALUES (gen_random_uuid()::text, ${orgId}, ${DRIVES_MOVE_RELEASE}, ${completed ? sql`now() AT TIME ZONE 'UTC'` : null},
      ${checkOk}, ${JSON.stringify(report)}::jsonb)
    ON CONFLICT (org_id, release_version) DO UPDATE SET
      completed_at = coalesce(EXCLUDED.completed_at, drives_move_runs.completed_at),
      check_ok = EXCLUDED.check_ok, report = EXCLUDED.report, updated_at = now() AT TIME ZONE 'UTC'
    WHERE NOT (drives_move_runs.check_ok AND drives_move_runs.completed_at IS NOT NULL)`);
}

/** True when this workspace already has an ok run for this release. */
const finished = async (orgId: string) => (await orgsWithoutFinishedMove([orgId])).length === 0;

let beforeFailureReport: (() => Promise<void>) | null = null;

/** Test seam: runs just before a failure is reported (where a concurrent mover's ok run can land). */
export function _setBeforeFailureReportForTest(hook: (() => Promise<void>) | null): void {
  beforeFailureReport = hook;
}

/**
 * Before reporting a failure, the run row is read again (consult S-F3): if
 * another mover recorded this workspace's run as ok meanwhile, it is done,
 * whatever this mover saw (its own failed check may have met edits made
 * after the other mover finished and the API started serving).
 */
async function failedUnlessFinishedElsewhere(orgId: string, failed: OrgMoveRun): Promise<OrgMoveRun> {
  if (beforeFailureReport) await beforeFailureReport();
  return (await finished(orgId)) ? { orgId, ok: true, skipped: 'already_done', move: failed.move, check: failed.check } : failed;
}

export async function runOrgMove(orgId: string): Promise<OrgMoveRun> {
  if (await finished(orgId)) return { orgId, ok: true, skipped: 'already_done', move: null, check: null };
  const move = await moveOrg(orgId);
  if (move.errors.length > 0) {
    await recordRun(orgId, false, false, { move });
    return failedUnlessFinishedElsewhere(orgId, { orgId, ok: false, skipped: null, move, check: null });
  }
  await recordRun(orgId, true, false, { move });
  const check = await postMoveCheck(orgId);
  if (!check.ok) {
    const run = await failedUnlessFinishedElsewhere(orgId, { orgId, ok: false, skipped: null, move, check });
    if (run.ok) return run;
  }
  await recordRun(orgId, true, check.ok, { move, check });
  return { orgId, ok: check.ok, skipped: null, move, check };
}
