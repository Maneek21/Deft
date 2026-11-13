import { appRuns, appVersions } from '@deft/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db.js';
import { safeRunSelection, type AppRunSafeView } from './app-run-repository.js';

/**
 * The App Run release rules shared by the approval endpoint (the App Run
 * approval resolver) and the review flags of approval rows: who may decide an
 * App Run approval, and whether a decision taken now would be a fresh one.
 */

type ApprovalFacts = Readonly<{ user_id: string; approval_status: string }>;
type RunFacts = Pick<AppRunSafeView,
  'provider_kind' | 'initiating_actor_type' | 'state' | 'execution_release_kind' | 'input_expires_at'>;

/**
 * True when only the approval's own user may take `decision` and `viewerId` is
 * someone else: reviewed public, native and agent-initiated Runtime releases
 * belong to their selected human owner; a public run is also rejected only by them.
 */
export function appRunOwnerRefuses(
  decision: 'approve' | 'reject',
  run: Pick<RunFacts, 'provider_kind' | 'initiating_actor_type'>,
  actionUserId: string,
  viewerId: string,
): boolean {
  if (actionUserId === viewerId) return false;
  if (run.initiating_actor_type === 'app_public') return true;
  return decision === 'approve' && (run.provider_kind === 'native'
    || (run.provider_kind === 'app_runtime' && run.initiating_actor_type === 'agent_employee'));
}

/**
 * What an approval taken now does: replay a decision already recorded, refuse,
 * or (`live`) release the run once its live authority and budget hold.
 */
export type AppRunApproveStep =
  'replay_approved' | 'replay_rejected' | 'terminal' | 'rejected' | 'expired' | 'stale' | 'live';

export function appRunApproveStep(run: RunFacts, action: ApprovalFacts, now: Date): AppRunApproveStep {
  if (run.execution_release_kind === 'approved') return 'replay_approved';
  if (run.state === 'cancelled') return 'replay_rejected';
  if (run.state === 'expired' || run.state === 'failed') return 'terminal';
  if (action.approval_status === 'rejected') return 'rejected';
  if (action.approval_status === 'expired') return 'expired';
  if (run.state !== 'pending_approval' || run.input_expires_at <= now) return 'stale';
  return 'live';
}

/** What a rejection taken now does: replay a recorded decision, refuse, or (`open`) cancel the run. */
export type AppRunRejectStep = 'replay_approved' | 'replay_rejected' | 'invalid' | 'open';

export function appRunRejectStep(run: RunFacts, action: ApprovalFacts): AppRunRejectStep {
  if (run.execution_release_kind === 'approved') return 'replay_approved';
  if (run.state === 'cancelled' || action.approval_status === 'rejected') return 'replay_rejected';
  if (run.state !== 'pending_approval') return 'invalid';
  return 'open';
}

/**
 * The review flags of one App Run approval before any live check: reject is
 * final; approve is false or `live` (true only if the live check passes).
 * Native and protocol-7 Runtime releases also need the approver's live web
 * session, which this read does not hold, so their approve answers false.
 */
export function appRunReviewSteps(
  run: RunFacts,
  protocolVersion: string | null,
  row: Pick<AppRunReviewRow, 'user_id' | 'approval_status' | 'approve' | 'reject'>,
  viewerId: string,
  now: Date,
): { approve: false | 'live'; reject: boolean } {
  const reject = row.reject && !appRunOwnerRefuses('reject', run, row.user_id, viewerId)
    && appRunRejectStep(run, row) === 'open';
  const needsWebSession = run.provider_kind === 'native' || (run.provider_kind === 'app_runtime' && protocolVersion === '7');
  const approve = row.approve && !needsWebSession && !appRunOwnerRefuses('approve', run, row.user_id, viewerId)
    && appRunApproveStep(run, row, now) === 'live';
  return { approve: approve ? 'live' : false, reject };
}

/** Exact approve checks per response; rows beyond it carry no approve flag. */
export const APP_RUN_APPROVE_CHECKS_PER_RESPONSE = 10;
/** Approve checks running at once in this process (each holds one pooled connection). */
export const APP_RUN_APPROVE_CHECKS_AT_ONCE = 2;

let checksRunning = 0;
const checkWaiters: Array<() => void> = [];

async function withCheckSlot<T>(check: () => Promise<T>): Promise<T> {
  while (checksRunning >= APP_RUN_APPROVE_CHECKS_AT_ONCE) {
    await new Promise<void>((resolve) => checkWaiters.push(resolve));
  }
  checksRunning += 1;
  try {
    return await check();
  } finally {
    checksRunning -= 1;
    checkWaiters.shift()?.();
  }
}

export type AppRunReviewRow = Readonly<{
  id: string;
  user_id: string;
  app_run_id: string | null;
  approval_status: string;
  /** Whether the resolver's general rule (gate, reviewer, source) admits each decision. */
  approve: boolean;
  reject: boolean;
}>;

export type AppRunReviewFlags = { viewer_can_approve?: boolean; viewer_can_reject: boolean };

/**
 * The review flags of App Run approvals for one viewer: true exactly when the
 * App Run approval resolver would take that decision freshly now. Approvals
 * that also need the approver's web session answer approve false. At most
 * `APP_RUN_APPROVE_CHECKS_PER_RESPONSE` rows, in the given order, get the
 * live approve check; later rows leave `viewer_can_approve` out.
 */
export async function appRunReviewAuthority(
  orgId: string,
  viewerId: string,
  rows: readonly AppRunReviewRow[],
  approvalRead: ((run: AppRunSafeView) => Promise<boolean>) | undefined,
  now: Date = new Date(),
): Promise<Map<string, AppRunReviewFlags>> {
  const flags = new Map<string, AppRunReviewFlags>();
  const runIds = [...new Set(rows.flatMap((row) => row.app_run_id ? [row.app_run_id] : []))];
  const runs = runIds.length === 0 ? [] : await db
    .select({ ...safeRunSelection, protocol_version: appVersions.protocol_version })
    .from(appRuns)
    .leftJoin(appVersions, and(eq(appVersions.org_id, appRuns.org_id), eq(appVersions.id, appRuns.origin_app_version_id)))
    .where(and(eq(appRuns.org_id, orgId), inArray(appRuns.id, runIds)));
  const runById = new Map(runs.map(({ protocol_version, ...run }) => [run.id, { run, protocol_version }]));
  const checks: Promise<void>[] = [];
  for (const row of rows) {
    const found = row.app_run_id ? runById.get(row.app_run_id) : undefined;
    if (!found) {
      flags.set(row.id, { viewer_can_approve: false, viewer_can_reject: false });
      continue;
    }
    const { run, protocol_version } = found;
    const steps = appRunReviewSteps(run, protocol_version, row, viewerId, now);
    const entry: AppRunReviewFlags = { viewer_can_reject: steps.reject };
    flags.set(row.id, entry);
    if (steps.approve !== 'live' || !approvalRead) {
      entry.viewer_can_approve = false;
    } else if (checks.length < APP_RUN_APPROVE_CHECKS_PER_RESPONSE) {
      const read = approvalRead;
      checks.push(withCheckSlot(() => read(run)).then(
        (authorized) => { entry.viewer_can_approve = authorized; },
        () => { entry.viewer_can_approve = false; },
      ));
    }
  }
  await Promise.all(checks);
  return flags;
}
