import { DollarSign } from 'lucide-react';

export type HeartbeatCostSummary = {
  total_cents: number;
  total_actions: number;
  turn_count: number;
};

export function fmtCost(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The last-24h tiles. Cost is shown only when some turn recorded a cost:
 * BYOA runtimes do not report per-turn cost, and a tile reading $0.00 would
 * suggest the agent was free to run.
 */
export function HeartbeatSummaryTiles({ summary }: { summary: HeartbeatCostSummary }) {
  const showCost = summary.total_cents > 0;
  return (
    <div className={`grid ${showCost ? 'grid-cols-3' : 'grid-cols-2'} gap-4 mb-6`}>
      <div className="border border-slate-200 rounded-lg p-4 bg-white">
        <div className="text-xs text-slate-500 uppercase tracking-wide">
          24h actions
        </div>
        <div className="text-2xl font-semibold mt-1">{summary.total_actions}</div>
      </div>
      {showCost && (
        <div className="border border-slate-200 rounded-lg p-4 bg-white">
          <div className="text-xs text-slate-500 uppercase tracking-wide flex items-center">
            <DollarSign size={12} className="mr-1" />
            24h cost
          </div>
          <div className="text-2xl font-semibold mt-1">{fmtCost(summary.total_cents)}</div>
        </div>
      )}
      <div className="border border-slate-200 rounded-lg p-4 bg-white">
        <div className="text-xs text-slate-500 uppercase tracking-wide">
          24h turns
        </div>
        <div className="text-2xl font-semibold mt-1">{summary.turn_count}</div>
      </div>
    </div>
  );
}
