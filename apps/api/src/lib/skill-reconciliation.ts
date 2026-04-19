/**
 * Block 1.8 — skill reconciliation loop.
 *
 * Each heartbeat tick on an OpenClaw employee calls
 * `reconcileSkillsForEmployee(employee, gateway?)` which:
 *
 *   1. Loads the employee's expected skill set from `agent_employee_skills`
 *      (joined with `skills.slug` + `installed_version`).
 *   2. Asks the Gateway what's actually installed on the sidecar via
 *      `gateway.skills.list()`.
 *   3. Computes the diff: expected-but-missing → auto-reinstalls via
 *      `gateway.skills.install(slug, version)`.
 *   4. Tracks consecutive ticks where drift existed. After > 2 ticks of
 *      unresolved drift, emits a system notification to every org admin
 *      so a human can intervene.
 *
 * Drift counter is in-memory (process-local). A deploy resets it — that's
 * fine because drift rediscovers itself on the next tick, and two ticks
 * of drift is the smallest window we'd alert on anyway.
 *
 * Fail-quiet: gateway errors, decrypt errors, DB errors all return an
 * `error` outcome without throwing. The heartbeat path keeps moving.
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '@deft/db';
import { agentEmployeeSkills, skills, orgMembers, notifications } from '@deft/db';
import { decrypt } from './encryption.js';
import { getGatewayForDeployment, type OpenClawGateway } from './openclaw-gateway.js';

export type ReconcileOutcome = {
  outcome: 'in_sync' | 'reinstalled' | 'drift_persists' | 'error';
  expected: string[];
  installed: string[];
  missing: string[];
  reinstalled: string[];
  failed: string[];
  error?: string;
};

export type ReconcileEmployee = {
  id: string;
  org_id: string;
  connection_url: string | null;
  gateway_token_encrypted: string | null;
};

// Threshold: alert after > 2 consecutive drifting ticks (i.e. 3rd drift call).
const DRIFT_ALERT_THRESHOLD = 2;
// Dedupe alerts per employee for 24h.
const DRIFT_ALERT_DEDUPE_MS = 24 * 60 * 60 * 1000;

const driftCounters = new Map<string, number>();
const lastAlertAt = new Map<string, number>();

// Test seam: allow overriding how a gateway is resolved for an employee.
let _gatewayResolver: (
  employeeId: string,
  connectionUrl: string,
  token: string,
) => OpenClawGateway | null = (id, url, tok) => getGatewayForDeployment(id, url, tok);

export function _setReconcileGatewayResolver(
  fn: (
    employeeId: string,
    connectionUrl: string,
    token: string,
  ) => OpenClawGateway | null,
): void {
  _gatewayResolver = fn;
}

export function _resetReconcileGatewayResolver(): void {
  _gatewayResolver = (id, url, tok) => getGatewayForDeployment(id, url, tok);
}

/** Test-only: clear in-memory counters so tests don't leak between runs. */
export function _clearReconcileState(): void {
  driftCounters.clear();
  lastAlertAt.clear();
}

async function getExpectedSkills(
  employeeId: string,
): Promise<Array<{ slug: string; version: string }>> {
  // JOIN agent_employee_skills → skills via skill_id.
  const rows = await db
    .select({
      slug: skills.slug,
      version: agentEmployeeSkills.installed_version,
    })
    .from(agentEmployeeSkills)
    .innerJoin(skills, eq(agentEmployeeSkills.skill_id, skills.id))
    .where(eq(agentEmployeeSkills.agent_employee_id, employeeId));
  return rows;
}

async function emitDriftNotification(
  employee: ReconcileEmployee,
  missing: string[],
): Promise<void> {
  const last = lastAlertAt.get(employee.id) ?? 0;
  if (Date.now() - last < DRIFT_ALERT_DEDUPE_MS) return;

  // Find org admins (role='admin' or 'owner').
  const admins = await db
    .select({ user_id: orgMembers.user_id })
    .from(orgMembers)
    .where(inArray(orgMembers.role, ['admin', 'owner'] as any));
  const orgAdmins = admins.filter((a) => a.user_id);

  const payloadBase = {
    org_id: employee.org_id,
    type: 'system',
    title: `Agent skill drift persists on employee ${employee.id.slice(0, 8)}`,
    body: `Missing skills: ${missing.join(', ')}`,
    link: `/settings/agent-employees/${employee.id}`,
    metadata: { subtype: 'skill_drift', employee_id: employee.id, missing },
  } as const;

  for (const a of orgAdmins) {
    try {
      await db.insert(notifications).values({
        id: crypto.randomUUID(),
        org_id: employee.org_id,
        user_id: a.user_id,
        type: payloadBase.type,
        title: payloadBase.title,
        body: payloadBase.body,
        link: payloadBase.link,
        metadata: payloadBase.metadata as any,
      });
    } catch {
      // Best-effort per-admin; one failure shouldn't block others.
    }
  }
  lastAlertAt.set(employee.id, Date.now());
}

/**
 * Reconcile gateway-installed skills against DB-expected skills for one
 * employee. See module header for full semantics.
 */
export async function reconcileSkillsForEmployee(
  employee: ReconcileEmployee,
  gatewayOverride?: OpenClawGateway,
): Promise<ReconcileOutcome> {
  const base = {
    expected: [] as string[],
    installed: [] as string[],
    missing: [] as string[],
    reinstalled: [] as string[],
    failed: [] as string[],
  };

  // Resolve gateway
  let gateway = gatewayOverride;
  if (!gateway) {
    if (!employee.connection_url || !employee.gateway_token_encrypted) {
      return { ...base, outcome: 'error', error: 'no gateway connection' };
    }
    let token: string;
    try { token = decrypt(employee.gateway_token_encrypted); }
    catch { return { ...base, outcome: 'error', error: 'decrypt failed' }; }
    const g = _gatewayResolver(employee.id, employee.connection_url, token);
    if (!g) return { ...base, outcome: 'error', error: 'gateway unresolved' };
    gateway = g;
  }

  // Expected from DB
  let expectedRows: Array<{ slug: string; version: string }>;
  try {
    expectedRows = await getExpectedSkills(employee.id);
  } catch (err) {
    return { ...base, outcome: 'error', error: `db query failed: ${(err as Error).message}` };
  }
  const expected = expectedRows.map((r) => r.slug);

  // Installed from gateway
  let installedList: Array<{ slug: string; version: string; enabled: boolean }>;
  try {
    installedList = await gateway.skills.list();
  } catch (err) {
    return {
      ...base,
      expected,
      outcome: 'error',
      error: `gateway skills.list failed: ${(err as Error).message}`,
    };
  }
  const installed = installedList.map((s) => s.slug);
  const installedSet = new Set(installed);

  // Diff
  const missing = expected.filter((slug) => !installedSet.has(slug));
  if (missing.length === 0) {
    driftCounters.set(employee.id, 0);
    return { ...base, outcome: 'in_sync', expected, installed };
  }

  // Auto-reinstall missing
  const reinstalled: string[] = [];
  const failed: string[] = [];
  for (const slug of missing) {
    const row = expectedRows.find((r) => r.slug === slug);
    try {
      await gateway.skills.install(slug, row?.version);
      reinstalled.push(slug);
    } catch (err) {
      failed.push(slug);
      console.warn(`[skill-reconcile ${employee.id}] install ${slug} failed: ${(err as Error).message}`);
    }
  }

  // Drift counter + alert
  const nextCount = (driftCounters.get(employee.id) ?? 0) + 1;
  driftCounters.set(employee.id, nextCount);
  if (nextCount > DRIFT_ALERT_THRESHOLD && failed.length > 0) {
    await emitDriftNotification(employee, failed).catch(() => undefined);
    return {
      outcome: 'drift_persists',
      expected,
      installed,
      missing,
      reinstalled,
      failed,
    };
  }

  return {
    outcome: 'reinstalled',
    expected,
    installed,
    missing,
    reinstalled,
    failed,
  };
}
