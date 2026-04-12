/**
 * Unified confidence indicator logic for agent messages.
 *
 * Replaces the divergent live-streaming vs reload-render code paths that
 * produced different strings for the same state. The rule:
 *   - Tool-backed answers (tool_calls > 0) → high confidence regardless of citations
 *   - ≥3 distinct citations → high
 *   - 1-2 citations → limited
 *   - 0 citations, no tools → low (training data only)
 */

export type ConfidenceLevel = 'high' | 'limited' | 'low';

export type ConfidenceDisplay = {
  level: ConfidenceLevel;
  label: string;
  /** CSS var name for the dot color (without the `var(--` wrapper). */
  colorVar: string;
};

type Message = {
  citations?: { id: string }[] | null;
  tool_calls?: { tool: string }[] | null;
  content?: string;
};

export function deriveConfidence(msg: Message): ConfidenceDisplay {
  const citationCount = msg.citations?.length ?? 0;
  const toolCount = msg.tool_calls?.length ?? 0;

  if (toolCount > 0) {
    return { level: 'high', label: 'High confidence', colorVar: 'success' };
  }
  if (citationCount >= 3) {
    return { level: 'high', label: 'High confidence', colorVar: 'success' };
  }
  if (citationCount >= 1) {
    return { level: 'limited', label: 'Based on limited data', colorVar: 'accent' };
  }
  return { level: 'low', label: 'Low confidence — no direct sources', colorVar: 'danger' };
}
