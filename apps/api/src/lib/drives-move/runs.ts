// The notes move (plan Task F14): one workspace's run, recorded in
// drives_move_runs (one row per workspace and DRIVES_MOVE_RELEASE).
//
// runOrgMove moves the workspace (moveOrg), then checks it (postMoveCheck):
// - a move with errors records the row with no completed_at and check_ok
//   false, and returns not ok;
// - a move that finished records completed_at before the check runs, with
//   check_ok false: a process that stops during the check leaves that row,
//   and the next run moves nothing new and checks again;
// - the check's result is then recorded: check_ok and the report (the move's
//   and the check's, ids and counts only).
// Only a row with completed_at and check_ok means the workspace is done
// (pending.ts orgsWithoutFinishedMove). Used by the API start and by
// `pnpm drives:move`; `--check-only` records nothing.
import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import { postMoveCheck, type PostMoveCheck } from './check.js';
import { moveOrg, type MoveReport } from './move-org.js';
import { DRIVES_MOVE_RELEASE } from './pending.js';

export type OrgMoveRun = { orgId: string; ok: boolean; move: MoveReport; check: PostMoveCheck | null };

async function recordRun(orgId: string, completed: boolean, checkOk: boolean, report: Record<string, unknown>): Promise<void> {
  await db.execute(sql`INSERT INTO drives_move_runs (id, org_id, release_version, completed_at, check_ok, report)
    VALUES (gen_random_uuid()::text, ${orgId}, ${DRIVES_MOVE_RELEASE}, ${completed ? sql`now() AT TIME ZONE 'UTC'` : null},
      ${checkOk}, ${JSON.stringify(report)}::jsonb)
    ON CONFLICT (org_id, release_version) DO UPDATE SET
      completed_at = coalesce(EXCLUDED.completed_at, drives_move_runs.completed_at),
      check_ok = EXCLUDED.check_ok, report = EXCLUDED.report, updated_at = now() AT TIME ZONE 'UTC'`);
}

export async function runOrgMove(orgId: string): Promise<OrgMoveRun> {
  const move = await moveOrg(orgId);
  if (move.errors.length > 0) {
    await recordRun(orgId, false, false, { move });
    return { orgId, ok: false, move, check: null };
  }
  await recordRun(orgId, true, false, { move });
  const check = await postMoveCheck(orgId);
  await recordRun(orgId, true, check.ok, { move, check });
  return { orgId, ok: check.ok, move, check };
}
