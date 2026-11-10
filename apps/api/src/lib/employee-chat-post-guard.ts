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
 *     handler runs; every other path calls `chargeEmployeeChatPost` after the
 *     non-charging `checkEmployeeChatPost`, once it will really post (the
 *     Agent Channel only after winning its idempotency claim, so replays and
 *     losing claimants never consume a slot).
 * Space membership / visibility is enforced by the write itself
 * (`executeSendMessage` / `executeMessagePost`), which every path uses.
 *
 * The canonical Defty system employee is not a BYOA employee: its activity,
 * health and approval behaviour are unchanged by this guard (only the
 * storm detector applies, as before).
 */
import { and, eq, sql } from 'drizzle-orm';
import { agentEmployees } from '@deft/db/schema';
import { db } from './db.js';
import {
  canonicalDeftyEmployeeCondition,
  isCanonicalDeftyEmployee,
  DEFTY_SYSTEM_RUNTIME_KIND,
} from './defty-identity.js';
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

/**
 * The non-charging rails: active, reply storm (on the thread the post will
 * actually be written to), circuit breaker. Has no side effects. A path that
 * is not already charged by MCP v1 `dispatchTool` must call
 * `chargeEmployeeChatPost` once it is certain it will execute the post (for
 * an idempotent path: only after winning its idempotency claim).
 */
export async function checkEmployeeChatPost(opts: {
  orgId: string;
  employeeId: string;
  /** Thread root the post replies to, if any (storm detector). */
  parentId: string | null | undefined;
  /** 'queue': the path has an approval queue (MCP). 'refuse': it has none. */
  onUnhealthy: 'queue' | 'refuse';
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

  return { ok: true, poster, requiresApproval: unhealthy };
}

/** Atomically reserve one daily action slot for an employee chat post. */
export async function chargeEmployeeChatPost(
  orgId: string,
  employeeId: string,
): Promise<{ ok: true } | EmployeeChatPostRefusal> {
  const budget = await consumeAgentDailyActionBudget(orgId, employeeId);
  if (budget.allowed) return { ok: true };
  return budget.error === EMPLOYEE_INACTIVE_MESSAGE
    ? { ok: false, code: 'EMPLOYEE_INACTIVE', message: budget.error, status: 403 }
    : { ok: false, code: 'DAILY_ACTION_LIMIT', message: budget.error, status: 409 };
}

const DAILY_ACTION_LIMIT_MESSAGE =
  'Daily action limit reached. Ask an admin to increase the limit or wait for the daily reset.';

/**
 * Charge at most ONE daily action slot per Agent Channel delivery attempt,
 * however many generations reclaim it. In one statement: mark the attempt
 * (`request_json.daily_action_charged`, only while this generation still owns
 * the started claim and it is not yet marked) and increment the counter only
 * if the mark was written. The counter predicate mirrors
 * `consumeAgentDailyActionBudget` (active, not deleted unless canonical
 * Defty, under the cap). If the mark is written but the cap refuses, the
 * caller must release its claim, which drops the mark with it.
 *
 * Returns `claim_lost` when this generation no longer owns the claim.
 */
export async function chargeEmployeeChatPostOncePerAttempt(opts: {
  orgId: string;
  employeeId: string;
  attemptId: string;
  attemptGeneration: string;
}): Promise<{ ok: true; charged: boolean } | EmployeeChatPostRefusal | { ok: false; code: 'CLAIM_LOST' }> {
  const ownsClaim = sql`id = ${opts.attemptId} and org_id = ${opts.orgId}
    and agent_employee_id = ${opts.employeeId} and status = 'started'
    and coalesce(request_json->>'attempt_generation', '') = ${opts.attemptGeneration}`;
  const result = await db.execute(sql`with mark as (
      update agent_channel_delivery_attempts
         set request_json = request_json || '{"daily_action_charged": true}'::jsonb
       where ${ownsClaim} and coalesce(request_json->>'daily_action_charged', '') <> 'true'
      returning id
    ), charge as (
      update agent_employees
         set daily_action_count = daily_action_count + 1
       where id = ${opts.employeeId} and org_id = ${opts.orgId} and is_active = true
         and (is_deleted = false or ${canonicalDeftyEmployeeCondition()})
         and daily_action_count < max_daily_actions
         and exists (select 1 from mark)
      returning id
    )
    select (select count(*) from mark)::int as marked, (select count(*) from charge)::int as charged`);
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{ marked: number; charged: number }>;
  const { marked = 0, charged = 0 } = rows[0] ?? {};
  if (marked > 0 && charged > 0) return { ok: true, charged: true };
  if (marked > 0) {
    const poster = await loadEmployeeChatPoster(opts.orgId, opts.employeeId);
    return !poster || (!poster.isDefty && !poster.active)
      ? { ok: false, code: 'EMPLOYEE_INACTIVE', message: EMPLOYEE_INACTIVE_MESSAGE, status: 403 }
      : { ok: false, code: 'DAILY_ACTION_LIMIT', message: DAILY_ACTION_LIMIT_MESSAGE, status: 409 };
  }
  // Not marked now: either an earlier generation already charged this
  // attempt (no second charge) or this generation lost the claim.
  const owned = await db.execute(sql`select coalesce(request_json->>'daily_action_charged', '') = 'true' as charged
    from agent_channel_delivery_attempts where ${ownsClaim} limit 1`);
  const ownedRows = (Array.isArray(owned) ? owned : (owned as { rows?: unknown[] }).rows ?? []) as Array<{ charged: boolean }>;
  return ownedRows[0]?.charged ? { ok: true, charged: false } : { ok: false, code: 'CLAIM_LOST' };
}
