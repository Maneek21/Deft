/**
 * The notes move (plan Task F14, spec 5.11): notes, note folders and chat
 * canvases into drives and documents. Run by the upgrade container right
 * after `db:upgrade` (docker-compose.yml), and by an operator; the API also
 * runs the move before it listens (lib/drives-move/startup.ts).
 *
 *   pnpm drives:move [--org <id>] [--check-only | --accept-missing-images] [--help]
 *
 * For each workspace (every one, or `--org`): runOrgMove, which moves it
 * (moveOrg, which also makes sure the Workspace drive exists), checks it
 * (postMoveCheck) and records the run in drives_move_runs; the API listens
 * only once every workspace has an ok run. A workspace whose run is already
 * ok is skipped (`skipped: "already_done"`), so a routine upgrade rerun never
 * re-checks or reopens it. With --check-only it moves nothing and writes no
 * run row: it checks and prints the recorded run's move report with the
 * check. With --accept-missing-images (consult C6; never at the API start),
 * an empty or unreachable file storage counts every image's bytes as
 * missing: each becomes "Image not available", counted, and the run report
 * records `accepted_missing_images: true`. Prints one JSON report and exits 1
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
import { recordedRun, runOrgMove } from '../lib/drives-move/runs.js';

const USAGE = 'Usage: pnpm drives:move [--org <id>] [--check-only | --accept-missing-images] [--help]';

const HELP = [
  USAGE,
  '',
  'Moves notes, note folders and chat canvases into drives and documents, checks each workspace, and records',
  'the run. A workspace whose run is already ok is skipped. Prints one JSON report; exits 1 when any source',
  'failed to move or any check is not ok. Run it again after fixing what it reports.',
  '',
  '  --org <id>                Only this workspace.',
  '  --check-only              Move and write nothing: check each workspace, and print its recorded move report',
  '                            with the check.',
  '  --accept-missing-images   Only when the uploaded files are truly gone. An empty or unreachable file storage',
  '                            then counts every image\'s bytes as missing: each image becomes "Image not',
  '                            available" (counted in missingImageBytes) instead of the source being refused.',
  '                            The run report records accepted_missing_images: true. The API start never',
  '                            does this.',
  '  --help                    This text.',
].join('\n');

type Args = { orgId: string | null; checkOnly: boolean; acceptMissingImages: boolean; help: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { orgId: null, checkOnly: false, acceptMissingImages: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--check-only') args.checkOnly = true;
    else if (arg === '--accept-missing-images') args.acceptMissingImages = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--org') {
      args.orgId = argv[i + 1] ?? null;
      if (!args.orgId) throw new Error('--org needs a workspace id');
      i += 1;
    } else if (arg !== '--') {
      throw new Error(`Unknown argument ${JSON.stringify(arg)}. ${USAGE}`);
    }
  }
  if (args.checkOnly && args.acceptMissingImages) throw new Error(`--accept-missing-images moves, so it can't be used with --check-only. ${USAGE}`);
  return args;
}

type OrgReport = {
  orgId: string; skipped: 'already_done' | null; move: MoveReport | null; check: PostMoveCheck | null; ok: boolean;
  /** --check-only: the recorded run this release holds for the workspace (its move report is `move`). */
  recordedRun?: { completedAt: string | null; checkOk: boolean; acceptedMissingImages: boolean } | null;
};

async function main(): Promise<number> {
  const { orgId, checkOnly, acceptMissingImages, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(HELP);
    return 0;
  }
  const orgIds = orgId ? [orgId] : rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM orgs ORDER BY created_at, id`)).map((row) => row.id);
  if (orgId && rowsOf(await db.execute(sql`SELECT 1 FROM orgs WHERE id = ${orgId}`)).length === 0) throw new Error('No workspace has that id');
  const orgs: OrgReport[] = [];
  for (const id of orgIds) {
    if (checkOnly) {
      // Reports only: reads the recorded run, never writes or changes a drives_move_runs row.
      const recorded = await recordedRun(id);
      const check = await postMoveCheck(id);
      orgs.push({
        orgId: id, skipped: null, move: recorded?.report.move ?? null, check, ok: check.ok,
        recordedRun: recorded ? {
          completedAt: recorded.completedAt, checkOk: recorded.checkOk, acceptedMissingImages: recorded.report.accepted_missing_images === true,
        } : null,
      });
    } else {
      // A workspace whose run is already ok is skipped, as the API start skips it (runs.ts).
      const run = await runOrgMove(id, { acceptMissingImages });
      orgs.push({ orgId: id, skipped: run.skipped, move: run.move, check: run.check, ok: run.ok });
    }
  }
  const failedMoves = orgs.filter((org) => (org.move?.errors.length ?? 0) > 0).length;
  const failedChecks = orgs.filter((org) => !org.ok).length;
  const ok = failedChecks === 0;
  console.log(JSON.stringify({ checkOnly, acceptMissingImages, ok, workspaces: orgs.length, failedMoves, failedChecks, orgs }, null, 2));
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
