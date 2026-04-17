'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { ArrowLeft, Activity, DollarSign, ChevronDown, ChevronRight } from 'lucide-react';

type HeartbeatTurn = {
  id: string;
  fired_at: string;
  cadence_minutes: number;
  prompt_sha: string;
  action_count: number;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_cents: number | null;
  outcome: string;
  outcome_reason: string | null;
  summary: string | null;
};

type CostSummary = {
  total_cents: number;
  total_actions: number;
  turn_count: number;
};

const OUTCOME_LABELS: Record<string, { label: string; tone: string }> = {
  dispatched: { label: 'Dispatched', tone: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
  no_op: { label: 'No-op', tone: 'text-slate-600 bg-slate-50 border-slate-200' },
  skipped_budget: { label: 'Skipped (budget)', tone: 'text-amber-600 bg-amber-50 border-amber-200' },
  skipped_idempotent: { label: 'Skipped (idempotent)', tone: 'text-slate-600 bg-slate-50 border-slate-200' },
  skipped_unhealthy: { label: 'Skipped (unhealthy)', tone: 'text-red-600 bg-red-50 border-red-200' },
  skipped_disconnected: { label: 'Skipped (disconnected)', tone: 'text-red-600 bg-red-50 border-red-200' },
  error: { label: 'Error', tone: 'text-red-700 bg-red-50 border-red-200' },
};

function fmtCost(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtWhen(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function HeartbeatsPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [turns, setTurns] = useState<HeartbeatTurn[]>([]);
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterOutcome, setFilterOutcome] = useState<string>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: '100' });
      if (filterOutcome !== 'all') qs.set('outcome', filterOutcome);
      const res = await api.get(`/api/agent-employees/${id}/heartbeats?${qs.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed with ${res.status}`);
      }
      const data = await res.json();
      setTurns(data.turns ?? []);
      setSummary(data.cost_summary_24h ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id, filterOutcome]);

  useEffect(() => {
    load();
  }, [load]);

  // Task 8.4 — the API emits `agent:heartbeat:turn` on every new row; the
  // page-owner wires a socket subscription at the app shell level, so we
  // just poll on window focus as a lightweight backup. Avoids pulling the
  // socket dependency into a leaf settings page.
  useEffect(() => {
    function onFocus() {
      load();
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <Link
        href="/settings/agent-employees"
        className="inline-flex items-center text-sm text-slate-600 hover:text-slate-900 mb-4"
      >
        <ArrowLeft size={14} className="mr-1" />
        All agent employees
      </Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 flex items-center">
            <Activity size={22} className="mr-2" />
            Heartbeats
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Autonomous wake-ups — one row per scheduled heartbeat tick.
          </p>
        </div>
        <select
          value={filterOutcome}
          onChange={(e) => setFilterOutcome(e.target.value)}
          className="border border-slate-300 rounded-md px-3 py-1.5 text-sm"
        >
          <option value="all">All outcomes</option>
          <option value="dispatched">Dispatched</option>
          <option value="no_op">No-op</option>
          <option value="skipped_budget">Skipped (budget)</option>
          <option value="skipped_idempotent">Skipped (idempotent)</option>
          <option value="skipped_unhealthy">Skipped (unhealthy)</option>
          <option value="skipped_disconnected">Skipped (disconnected)</option>
          <option value="error">Error</option>
        </select>
      </div>

      {summary && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="border border-slate-200 rounded-lg p-4 bg-white">
            <div className="text-xs text-slate-500 uppercase tracking-wide">
              24h actions
            </div>
            <div className="text-2xl font-semibold mt-1">{summary.total_actions}</div>
          </div>
          <div className="border border-slate-200 rounded-lg p-4 bg-white">
            <div className="text-xs text-slate-500 uppercase tracking-wide flex items-center">
              <DollarSign size={12} className="mr-1" />
              24h cost
            </div>
            <div className="text-2xl font-semibold mt-1">{fmtCost(summary.total_cents)}</div>
          </div>
          <div className="border border-slate-200 rounded-lg p-4 bg-white">
            <div className="text-xs text-slate-500 uppercase tracking-wide">
              24h turns
            </div>
            <div className="text-2xl font-semibold mt-1">{summary.turn_count}</div>
          </div>
        </div>
      )}

      {loading && <div className="text-sm text-slate-500">Loading heartbeats...</div>}
      {error && (
        <div className="border border-red-200 bg-red-50 rounded-md p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {!loading && !error && turns.length === 0 && (
        <div className="border border-dashed border-slate-300 rounded-lg p-12 text-center text-sm text-slate-500">
          No heartbeat turns yet. They will appear here after the next scheduled tick.
        </div>
      )}

      <div className="space-y-2">
        {turns.map((t) => {
          const o = OUTCOME_LABELS[t.outcome] ?? { label: t.outcome, tone: 'text-slate-600 bg-slate-50 border-slate-200' };
          const isOpen = !!expanded[t.id];
          return (
            <div
              key={t.id}
              className="border border-slate-200 rounded-md bg-white"
            >
              <button
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-50"
                onClick={() => setExpanded({ ...expanded, [t.id]: !isOpen })}
              >
                <div className="flex items-center gap-3">
                  {isOpen ? (
                    <ChevronDown size={14} className="text-slate-400" />
                  ) : (
                    <ChevronRight size={14} className="text-slate-400" />
                  )}
                  <span
                    className={`inline-flex items-center border text-xs rounded px-2 py-0.5 ${o.tone}`}
                  >
                    {o.label}
                  </span>
                  <span className="text-sm text-slate-700">
                    {fmtWhen(t.fired_at)}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-500">
                  <span>cadence: {t.cadence_minutes}m</span>
                  <span>{fmtCost(t.cost_cents)}</span>
                </div>
              </button>
              {isOpen && (
                <div className="border-t border-slate-100 px-4 py-3 bg-slate-50 space-y-2">
                  <div className="text-xs text-slate-500">
                    prompt_sha: <span className="font-mono">{t.prompt_sha}</span>
                  </div>
                  {t.outcome_reason && (
                    <div className="text-xs text-slate-600">
                      <span className="text-slate-500">reason:</span> {t.outcome_reason}
                    </div>
                  )}
                  {t.summary && (
                    <div className="text-xs">
                      <div className="text-slate-500 mb-1">summary:</div>
                      <pre className="whitespace-pre-wrap text-slate-700 text-xs bg-white border border-slate-200 rounded p-2 overflow-x-auto">
                        {t.summary}
                      </pre>
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-2 text-xs text-slate-500 pt-1">
                    <div>actions: {t.action_count}</div>
                    <div>tokens in: {t.tokens_in ?? '—'}</div>
                    <div>tokens out: {t.tokens_out ?? '—'}</div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
