/**
 * Phase 10 — hardcoded model_pricing lookup.
 *
 * Used by the session inspector to compute per-turn cost from
 * (model_name, tokens_in, tokens_out). Single source of truth for any UI
 * or metrics export that wants to attach a dollar figure to a turn.
 *
 * Prices are USD per 1,000,000 tokens. Any model not listed here returns
 * null and the UI should render a `—`.
 *
 * Update this table when pricing changes; do NOT parse it from the model
 * name at call time. The cost column is advisory, not transactional.
 */

export type ModelPriceUsdPerMTok = {
  input: number;
  output: number;
};

export const MODEL_PRICING: Record<string, ModelPriceUsdPerMTok> = {
  'anthropic/claude-opus-4-6': { input: 15, output: 75 },
  'anthropic/claude-sonnet-4-6': { input: 3, output: 15 },
  'anthropic/claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
};

/**
 * Compute the USD cost of a turn. Returns `null` when the model is not in
 * the pricing table so the caller can render "—" instead of "$0.00".
 */
export function computeTurnCostUsd(
  modelName: string | null | undefined,
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined,
): number | null {
  if (!modelName) return null;
  const price = MODEL_PRICING[modelName];
  if (!price) return null;
  const tin = typeof tokensIn === 'number' ? tokensIn : 0;
  const tout = typeof tokensOut === 'number' ? tokensOut : 0;
  return (tin / 1_000_000) * price.input + (tout / 1_000_000) * price.output;
}
