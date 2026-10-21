import { and, eq, sql } from 'drizzle-orm';
import { orgs } from '@deft/db/schema';
import { hostRetainedSourceStorage } from './host-source-storage.js';
import type { AppRunTransaction } from './app-run-repository.js';

const budgets = hostRetainedSourceStorage.knowledge.budgetStorage;
const clamp = (value: unknown, fallback: number, max: number) => Number.isFinite(Number(value))
  ? Math.max(0, Math.min(max, Number(value))) : Math.min(fallback, max);

/** Either spelling may impose a cap during rollback. If both are configured the
 * lower value wins; moving a setting never resets an existing reservation. */
export function knowledgeCaptureBudgetLimits(config: Record<string, unknown>) {
  const retained = hostRetainedSourceStorage.knowledge.readBudgetConfig(config);
  const limit = (current: unknown, prior: unknown, fallback: number, max: number) => {
    if (current === undefined) return clamp(prior, fallback, max);
    if (prior === undefined) return clamp(current, fallback, max);
    return Math.min(clamp(current, fallback, max), clamp(prior, fallback, max));
  };
  const org = limit(config.knowledge_capture_daily_token_budget, retained.org, 500000, 1000000);
  return { org, account: limit(config.knowledge_capture_account_daily_token_budget, retained.account, 128000, org) };
}

/** The caller supplies one transaction: account refusal rolls back the org
 * increment too. Reservations remain charged after downstream model failure. */
export async function reserveKnowledgeCaptureBudget(tx: AppRunTransaction, input: {
  org_id: string; user_id: string; installation_id: string; account_ref: string; tokens: number; at: Date;
}) {
  if (!Number.isSafeInteger(input.tokens) || input.tokens < 1 || input.tokens > 100000) {
    throw new Error('APP_INTEGRATION_CAPTURE_CHANGED_OR_DENIED');
  }
  const [org] = await tx.select({ config: orgs.ai_config }).from(orgs).where(eq(orgs.id, input.org_id)).limit(1);
  if (!org) throw new Error('APP_INTEGRATION_CAPTURE_CHANGED_OR_DENIED');
  const config = org.config ?? {}, limits = knowledgeCaptureBudgetLimits(config);
  const day = input.at.toISOString().slice(0, 10);
  for (const [budget_key, limit] of [['org', limits.org],
    [`app-account:${input.user_id}:${input.installation_id}:${input.account_ref}`, limits.account]] as const) {
    await tx.insert(budgets).values({ org_id: input.org_id, day, budget_key }).onConflictDoNothing();
    const [reserved] = await tx.update(budgets).set({
      reserved_tokens: sql`${budgets.reserved_tokens}+${input.tokens}`, updated_at: input.at,
    }).where(and(eq(budgets.org_id, input.org_id), eq(budgets.day, day), eq(budgets.budget_key, budget_key),
      sql`${budgets.reserved_tokens}+${input.tokens}<=${limit}`)).returning({ key: budgets.budget_key });
    if (!reserved) throw new Error('APP_INTEGRATION_CAPTURE_BUDGET_EXCEEDED');
  }
  return config;
}
