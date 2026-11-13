import { agentActions, appRuns, appVersions } from '@deft/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db.js';
import { safeRunSelection, type AppRunSafeView } from './app-run-repository.js';

// App Run release rules shared by the App Run approval resolver and the review flags of approval rows.
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

export function appRunApproveStep(run: RunFacts, action: ApprovalFacts, now: () => Date): AppRunApproveStep {
  if (run.execution_release_kind === 'approved') return 'replay_approved';
  if (run.state === 'cancelled') return 'replay_rejected';
  if (run.state === 'expired' || run.state === 'failed') return 'terminal';
  if (action.approval_status === 'rejected') return 'rejected';
  if (action.approval_status === 'expired') return 'expired';
  if (run.state !== 'pending_approval' || run.input_expires_at <= now()) return 'stale';
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
 * session, which this read does not hold: their approve is `unknown` (left
 * out of the row) unless a rule above already refuses it.
 */
export function appRunReviewSteps(
  run: RunFacts,
  protocolVersion: string | null,
  row: Pick<AppRunReviewRow, 'user_id' | 'approve' | 'reject'> & ApprovalFacts,
  viewerId: string,
  now: () => Date,
): { approve: false | 'live' | 'unknown'; reject: boolean } {
  const reject = row.reject && !appRunOwnerRefuses('reject', run, row.user_id, viewerId)
    && appRunRejectStep(run, row) === 'open';
  const open = row.approve && !appRunOwnerRefuses('approve', run, row.user_id, viewerId)
    && appRunApproveStep(run, row, now) === 'live';
  if (!open) return { approve: false, reject };
  const needsWebSession = run.provider_kind === 'native' || (run.provider_kind === 'app_runtime' && protocolVersion === '7');
  return { approve: needsWebSession ? 'unknown' : 'live', reject };
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
  /** Whether the resolver's general rule (gate, reviewer, source) admits each decision. */
  approve: boolean;
  reject: boolean;
}>;

export type AppRunReviewFlags = { viewer_can_approve?: boolean; viewer_can_reject: boolean };

/**
 * The run of each App Run approval with the approval's current status, in
 * the viewer's workspace. A run without an App version keeps a null protocol.
 */
async function loadReviewFacts(orgId: string, actionIds: readonly string[]) {
  const rows = actionIds.length === 0 ? [] : await db
    .select({ ...safeRunSelection, protocol_version: appVersions.protocol_version,
      action_id: agentActions.id, approval_status: agentActions.approval_status })
    .from(agentActions)
    .innerJoin(appRuns, and(eq(appRuns.org_id, agentActions.org_id), eq(appRuns.id, agentActions.app_run_id)))
    .leftJoin(appVersions, and(eq(appVersions.org_id, appRuns.org_id), eq(appVersions.id, appRuns.origin_app_version_id)))
    .where(and(eq(agentActions.org_id, orgId), inArray(agentActions.id, [...actionIds])));
  return new Map(rows.map(({ protocol_version, action_id, approval_status, ...run }) =>
    [action_id, { run: run as AppRunSafeView, protocol_version, approval_status }]));
}

/**
 * The review flags of App Run approvals for one viewer: true exactly when the
 * App Run approval resolver would take that decision freshly now. Approvals
 * that also need the approver's web session leave approve out. At most
 * `APP_RUN_APPROVE_CHECKS_PER_RESPONSE` rows, in the given order, get the
 * live approve check; later rows leave `viewer_can_approve` out, as does a
 * live check that could not run. A live check re-reads the run and approval
 * once it has its slot, so a decision taken meanwhile is not missed.
 */
export async function appRunReviewAuthority(
  orgId: string,
  viewerId: string,
  rows: readonly AppRunReviewRow[],
  approvalRead: ((run: AppRunSafeView) => Promise<boolean | undefined>) | undefined,
  clock: () => Date = () => new Date(),
): Promise<Map<string, AppRunReviewFlags>> {
  const flags = new Map<string, AppRunReviewFlags>();
  const facts = await loadReviewFacts(orgId, rows.map((row) => row.id));
  const now = clock();
  const checks: Promise<void>[] = [];
  for (const row of rows) {
    const found = facts.get(row.id);
    if (!found) {
      flags.set(row.id, { viewer_can_approve: false, viewer_can_reject: false });
      continue;
    }
    const steps = appRunReviewSteps(found.run, found.protocol_version, { ...row, approval_status: found.approval_status },
      viewerId, () => now);
    const entry: AppRunReviewFlags = { viewer_can_reject: steps.reject };
    flags.set(row.id, entry);
    if (steps.approve === 'unknown') continue;
    if (steps.approve !== 'live' || !approvalRead) {
      entry.viewer_can_approve = false;
    } else if (checks.length < APP_RUN_APPROVE_CHECKS_PER_RESPONSE) {
      const read = approvalRead;
      checks.push(withCheckSlot(async () => {
        const fresh = (await loadReviewFacts(orgId, [row.id])).get(row.id);
        if (!fresh) return false;
        const again = appRunReviewSteps(fresh.run, fresh.protocol_version, { ...row, approval_status: fresh.approval_status },
          viewerId, clock);
        entry.viewer_can_reject = again.reject;
        if (again.approve !== 'live') return again.approve === 'unknown' ? undefined : false;
        return read(fresh.run);
      }).then((authorized) => {
        if (authorized !== undefined) entry.viewer_can_approve = authorized;
      }, () => undefined));
    }
  }
  await Promise.all(checks);
  return flags;
}
