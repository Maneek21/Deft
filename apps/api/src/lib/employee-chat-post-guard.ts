/**
 * One set of guard rails for every path by which an agent employee posts a
 * chat message as itself (owner decision 2026-11-10).
 *
 * An employee's own plain chat post needs no approval at any trust level,
 * but these rails always apply, on every path:
 *   - the employee must be active and not deleted;
 *   - the reply-storm detector, for thread replies;
 *   - the circuit breaker (`unhealthy`): the message never posts on its own.
 *     Paths with an approval queue (MCP) fall back to it; paths without one
 *     (the Agent Channel) refuse;
 *   - the daily action cap. MCP v1 charges it in `dispatchTool` before the
 *     handler runs, so MCP handlers pass `chargeDailyAction: false`; every
 *     other path asks this guard to charge it.
 * Space membership / visibility is enforced by the write itself
 * (`executeSendMessage` / `executeMessagePost`), which every path uses.
 *
 * The canonical Defty system employee is not a BYOA employee: its activity,
 * health and approval behaviour are unchanged by this guard (only the
 * storm detector applies, as before).
 */
import { and, eq } from 'drizzle-orm';
import { agentEmployees } from '@deft/db/schema';
import { db } from './db.js';
import { isCanonicalDeftyEmployee, DEFTY_SYSTEM_RUNTIME_KIND } from './defty-identity.js';
import { checkReplyStorm, STORM_THRESHOLD } from './storm-detector.js';
import { consumeAgentDailyActionBudget } from './agent-tool-policy.js';

export type EmployeeChatPoster = {
  employeeId: string;
  userId: string;
  slug: string;
  isDefty: boolean;
  active: boolean;
  unhealthy: boolean;
};

export type EmployeeChatPostRefusalCode =
  | 'EMPLOYEE_INACTIVE'
  | 'EMPLOYEE_UNHEALTHY'
  | 'STORM_DETECTED'
  | 'DAILY_ACTION_LIMIT';

export type EmployeeChatPostRefusal = {
  ok: false;
  code: EmployeeChatPostRefusalCode;
  message: string;
  /** HTTP status for paths that answer over HTTP. */
  status: 403 | 409;
};

export type EmployeeChatPostGuardResult =
  | {
      ok: true;
      poster: EmployeeChatPoster;
      /** True when the post must not run on its own (circuit breaker tripped):
       * the caller must queue it for approval. Never true for Defty. */
      requiresApproval: boolean;
    }
  | EmployeeChatPostRefusal;

export const EMPLOYEE_INACTIVE_MESSAGE = 'Agent employee is inactive, deleted, or outside this organization';
export const STORM_DETECTED_MESSAGE =
  `agent exceeded ${STORM_THRESHOLD} replies in this thread within the rate-limit window; backing off`;

export async function loadEmployeeChatPoster(
  orgId: string,
  employeeId: string,
): Promise<EmployeeChatPoster | null> {
  const [row] = await db
    .select({
      id: agentEmployees.id,
      user_id: agentEmployees.user_id,
      slug: agentEmployees.slug,
      runtime_kind: agentEmployees.runtime_kind,
      is_byoa: agentEmployees.is_byoa,
      is_active: agentEmployees.is_active,
      is_deleted: agentEmployees.is_deleted,
      unhealthy: agentEmployees.unhealthy,
    })
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, employeeId), eq(agentEmployees.org_id, orgId)))
    .limit(1);
  if (!row) return null;
  return {
    employeeId: row.id,
    userId: row.user_id,
    slug: row.slug,
    isDefty: isCanonicalDeftyEmployee(row) || row.runtime_kind === DEFTY_SYSTEM_RUNTIME_KIND,
    active: row.is_active && !row.is_deleted,
    unhealthy: row.unhealthy,
  };
}

/** The MCP tool-result text for a refusal (keeps the existing
 * `STORM_DETECTED: …` text the MCP tools have always returned). */
export function employeeChatPostToolError(refusal: EmployeeChatPostRefusal): string {
  return refusal.code === 'STORM_DETECTED' ? `STORM_DETECTED: ${refusal.message}` : refusal.message;
}

export async function checkEmployeeChatPost(opts: {
  orgId: string;
  employeeId: string;
  /** Thread root the post replies to, if any (storm detector). */
  parentId: string | null | undefined;
  /** 'queue': the path has an approval queue (MCP). 'refuse': it has none. */
  onUnhealthy: 'queue' | 'refuse';
  /** Charge one daily action slot. False only where the caller already did. */
  chargeDailyAction: boolean;
}): Promise<EmployeeChatPostGuardResult> {
  const poster = await loadEmployeeChatPoster(opts.orgId, opts.employeeId);
  if (!poster || (!poster.isDefty && !poster.active)) {
    return { ok: false, code: 'EMPLOYEE_INACTIVE', message: EMPLOYEE_INACTIVE_MESSAGE, status: 403 };
  }

  if (opts.parentId) {
    const storm = await checkReplyStorm(poster.userId, opts.parentId);
    if (storm.tripped) {
      return { ok: false, code: 'STORM_DETECTED', message: STORM_DETECTED_MESSAGE, status: 409 };
    }
  }

  const unhealthy = !poster.isDefty && poster.unhealthy;
  if (unhealthy && opts.onUnhealthy === 'refuse') {
    return {
      ok: false,
      code: 'EMPLOYEE_UNHEALTHY',
      message: 'Agent employee is unhealthy (circuit breaker tripped) and cannot post chat messages until an admin marks it healthy',
      status: 409,
    };
  }

  if (opts.chargeDailyAction) {
    const budget = await consumeAgentDailyActionBudget(opts.orgId, opts.employeeId);
    if (!budget.allowed) {
      return budget.error === EMPLOYEE_INACTIVE_MESSAGE
        ? { ok: false, code: 'EMPLOYEE_INACTIVE', message: budget.error, status: 403 }
        : { ok: false, code: 'DAILY_ACTION_LIMIT', message: budget.error, status: 409 };
    }
  }

  return { ok: true, poster, requiresApproval: unhealthy };
}
