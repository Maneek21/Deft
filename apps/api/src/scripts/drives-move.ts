/**
 * The notes move (plan Task F14, spec 5.11): notes, note folders and chat
 * canvases into drives and documents. Run by the upgrade container right
 * after `db:upgrade` (docker-compose.yml), and by an operator; the API also
 * runs the move before it listens (lib/drives-move/startup.ts).
 *
 *   pnpm drives:move [--org <id>] [--check-only]
 *
 * For each workspace (every one, or `--org`): runOrgMove, which moves it
 * (moveOrg, which also makes sure the Workspace drive exists), checks it
 * (postMoveCheck) and records the run in drives_move_runs; the API listens
 * only once every workspace has an ok run. A workspace whose run is already
 * ok is skipped (`skipped: "already_done"`), so a routine upgrade rerun never
 * re-checks or reopens it. With --check-only it moves nothing and writes no
 * run row: it only checks and reports. Prints one JSON report and exits 1
 * when any source failed to move or any check isn't ok. Idempotent: run it
 * again after fixing whatever it reported.
 *
 * Runbook (spec 5.11, R2): pause, back up, db:upgrade, drives:move,
 * drives:move --check-only, then unpause.
 */
import { sql } from 'drizzle-orm';
import { closeDb, db } from '../lib/db.js';
import { postMoveCheck, type PostMoveCheck } from '../lib/drives-move/check.js';
import type { MoveReport } from '../lib/drives-move/move-org.js';
import { rowsOf } from '../lib/drives-move/placement.js';
import { runOrgMove } from '../lib/drives-move/runs.js';

function parseArgs(argv: string[]): { orgId: string | null; checkOnly: boolean } {
  let orgId: string | null = null;
  let checkOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--check-only') checkOnly = true;
    else if (arg === '--org') {
      orgId = argv[i + 1] ?? null;
      if (!orgId) throw new Error('--org needs a workspace id');
      i += 1;
    } else if (arg !== '--') {
      throw new Error(`Unknown argument ${JSON.stringify(arg)}. Usage: pnpm drives:move [--org <id>] [--check-only]`);
    }
  }
  return { orgId, checkOnly };
}

async function main(): Promise<number> {
  const { orgId, checkOnly } = parseArgs(process.argv.slice(2));
  const orgIds = orgId ? [orgId] : rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM orgs ORDER BY created_at, id`)).map((row) => row.id);
  if (orgId && rowsOf(await db.execute(sql`SELECT 1 FROM orgs WHERE id = ${orgId}`)).length === 0) throw new Error('No workspace has that id');
  const orgs: Array<{ orgId: string; skipped: 'already_done' | null; move: MoveReport | null; check: PostMoveCheck | null; ok: boolean }> = [];
  for (const id of orgIds) {
    if (checkOnly) {
      // Reports only: never writes or changes a drives_move_runs row.
      const check = await postMoveCheck(id);
      orgs.push({ orgId: id, skipped: null, move: null, check, ok: check.ok });
    } else {
      // A workspace whose run is already ok is skipped, as the API start skips it (runs.ts).
      const run = await runOrgMove(id);
      orgs.push({ orgId: id, skipped: run.skipped, move: run.move, check: run.check, ok: run.ok });
    }
  }
  const failedMoves = orgs.filter((org) => (org.move?.errors.length ?? 0) > 0).length;
  const failedChecks = orgs.filter((org) => !org.ok).length;
  const ok = failedChecks === 0;
  console.log(JSON.stringify({ checkOnly, ok, workspaces: orgs.length, failedMoves, failedChecks, orgs }, null, 2));
  return ok ? 0 : 1;
}

main()
  .then(async (code) => {
    await closeDb().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(`[drives-move] failed: ${error instanceof Error ? error.message : 'unexpected error'}`);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
