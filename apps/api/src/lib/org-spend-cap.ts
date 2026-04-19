/**
 * Per-org LLM spend cap helper — Block 0.9 of OpenClaw Unlock plan.
 *
 * Two functions:
 *   checkOrgSpendCap(orgId)   — returns { allowed, reason? }. Call BEFORE
 *                               making the LLM / OpenClaw request.
 *   recordOrgSpend(orgId, cents) — increments current_*_cents atomically.
 *                                  Call AFTER a successful request.
 *
 * Counters reset lazily on each check: if daily_reset_at or monthly_reset_at
 * has elapsed past its period, the relevant current_*_cents is zeroed and
 * the reset_at is bumped forward.
 *
 * If an org has no row yet, checkOrgSpendCap auto-creates one with the
 * $100/mo default so the guard applies uniformly.
 */
import { db } from './db.js';
import { orgSpendCaps } from '@deft/db/schema';
import { eq, sql } from 'drizzle-orm';

export type SpendCapVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Is the instant at least one calendar day (UTC) past the reference?
 */
function isPastDayBoundary(ref: Date, now: Date): boolean {
  return now.getTime() - ref.getTime() >= MS_PER_DAY;
}

/**
 * Is the instant at least one calendar month past the reference (UTC)?
 */
function isPastMonthBoundary(ref: Date, now: Date): boolean {
  const refYear = ref.getUTCFullYear();
  const refMonth = ref.getUTCMonth();
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth();
  if (nowYear > refYear) return true;
  if (nowYear === refYear && nowMonth > refMonth) return true;
  return false;
}

/**
 * Look up or auto-create the spend cap row for this org, applying lazy
 * resets if a period has elapsed.
 */
async function ensureSpendCapRow(orgId: string) {
  const now = new Date();
  const [existing] = await db
    .select()
    .from(orgSpendCaps)
    .where(eq(orgSpendCaps.org_id, orgId))
    .limit(1);

  if (!existing) {
    // Auto-create with $100/mo default.
    const [row] = await db
      .insert(orgSpendCaps)
      .values({
        org_id: orgId,
        daily_cents: null,
        monthly_cents: 10000,
        current_daily_cents: 0,
        current_monthly_cents: 0,
        daily_reset_at: now,
        monthly_reset_at: now,
      })
      .returning();
    return row!;
  }

  // Lazy resets.
  const dailyNeedsReset = isPastDayBoundary(existing.daily_reset_at, now);
  const monthlyNeedsReset = isPastMonthBoundary(existing.monthly_reset_at, now);
  if (dailyNeedsReset || monthlyNeedsReset) {
    const [updated] = await db
      .update(orgSpendCaps)
      .set({
        current_daily_cents: dailyNeedsReset ? 0 : existing.current_daily_cents,
        current_monthly_cents: monthlyNeedsReset
          ? 0
          : existing.current_monthly_cents,
        daily_reset_at: dailyNeedsReset ? now : existing.daily_reset_at,
        monthly_reset_at: monthlyNeedsReset ? now : existing.monthly_reset_at,
      })
      .where(eq(orgSpendCaps.org_id, orgId))
      .returning();
    return updated!;
  }
  return existing;
}

export async function checkOrgSpendCap(orgId: string): Promise<SpendCapVerdict> {
  if (!orgId) return { allowed: true };
  try {
    const row = await ensureSpendCapRow(orgId);
    if (row.daily_cents != null && row.current_daily_cents >= row.daily_cents) {
      return {
        allowed: false,
        reason: `Daily spend cap reached ($${(row.daily_cents / 100).toFixed(2)}). Resets at UTC midnight.`,
      };
    }
    if (row.current_monthly_cents >= row.monthly_cents) {
      return {
        allowed: false,
        reason: `Monthly spend cap reached ($${(row.monthly_cents / 100).toFixed(2)}). Raise it in Settings → Spend Limits.`,
      };
    }
    return { allowed: true };
  } catch (err) {
    // If the check itself fails (DB down, etc.), fail-open rather than
    // block all AI calls. Log + allow.
    console.warn('[org-spend-cap] check failed, fail-open:', (err as Error).message);
    return { allowed: true };
  }
}

export async function recordOrgSpend(orgId: string, cents: number): Promise<void> {
  if (!orgId || !Number.isFinite(cents) || cents <= 0) return;
  try {
    await db
      .update(orgSpendCaps)
      .set({
        current_daily_cents: sql`${orgSpendCaps.current_daily_cents} + ${cents}`,
        current_monthly_cents: sql`${orgSpendCaps.current_monthly_cents} + ${cents}`,
        updated_at: new Date(),
      })
      .where(eq(orgSpendCaps.org_id, orgId));
  } catch (err) {
    console.warn('[org-spend-cap] record failed:', (err as Error).message);
  }
}

/**
 * Convenience wrapper used by llm() and openclaw-dispatch. Computes cost from
 * token counts + model pricing, then records.
 */
export async function recordOrgSpendFromUsage(
  orgId: string,
  modelName: string | undefined,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  if (!orgId) return;
  const cents = estimateCostCents(modelName, inputTokens, outputTokens);
  if (cents > 0) {
    await recordOrgSpend(orgId, cents);
  }
}

// ─── pricing (cents per 1M tokens, same table as agent/page.tsx + model-pricing.ts) ───
const MODEL_PRICING_CENTS_PER_M: Record<string, { input: number; output: number }> = {
  'anthropic/claude-opus-4-6': { input: 1500, output: 7500 },
  'anthropic/claude-sonnet-4-6': { input: 300, output: 1500 },
  'anthropic/claude-haiku-4-5-20251001': { input: 80, output: 400 },
  'openai/gpt-4o': { input: 250, output: 1000 },
  'openai/gpt-4o-mini': { input: 15, output: 60 },
};

function estimateCostCents(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!model) return 0;
  const p = MODEL_PRICING_CENTS_PER_M[model];
  if (!p) return 0;
  return Math.ceil(
    (inputTokens * p.input + outputTokens * p.output) / 1_000_000,
  );
}
