'use client';

/**
 * Task 4.10 — Pipeline view.
 *
 * Secondary business-stage view over the fixed task status vocabulary.
 * Wider cards can expose legacy/imported `contact_name` + `deal_value`
 * metadata inline. v1 is read-only: clicking a card opens the detail
 * panel, dragging between stages is NOT wired yet — the API accepts PATCH
 * status so follow-up work can add dnd-kit wiring.
 *
 * Column footer shows a sum of deal_value + task count when that metadata is
 * available; ordinary projects see only the count.
 *
 * Mobile (< md): collapses to a single-column view with a stage select
 * above, mirroring the Board view's status-tab pattern (Mobile-spillover P2-1).
 */

import { useMemo, useState, useEffect } from 'react';
import type { ResolvedStatus, PriorityVocab, CanonicalPriority } from '@/hooks/use-project-resolved-config';
import { priorityLabel } from '@/hooks/use-project-resolved-config';

// Minimum shape needed for pipeline rendering. Callers generally pass a
// wider Task; we only consume the fields below (metadata is optional).
type PipelineTask = {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  project_prefix: string;
  assignee_name: string | null;
  metadata?: Record<string, any> | null;
};

type Props<T extends PipelineTask> = {
  tasks: T[];
  projectPrefix: string;
  statuses?: ResolvedStatus[];
  hidePrefixIds?: boolean;
  priorityVocab?: PriorityVocab;
  onTaskClick: (task: T) => void;
};

const PRIORITY_STYLES: Record<string, { bg: string; color: string }> = {
  p0: { bg: 'rgba(220, 38, 38, 0.15)', color: '#DC2626' },
  p1: { bg: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B' },
  p2: { bg: 'rgba(59, 130, 246, 0.15)', color: '#3B82F6' },
  p3: { bg: 'rgba(107, 114, 128, 0.15)', color: '#6B7280' },
};

function fmtMoney(n: number): string {
  if (Number.isNaN(n)) return '';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return `$${n}`;
}

export function TaskPipelineView<T extends PipelineTask>({
  tasks,
  projectPrefix,
  statuses,
  hidePrefixIds,
  priorityVocab,
  onTaskClick,
}: Props<T>) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const stages = useMemo(() => {
    if (!statuses || statuses.length === 0) return [] as ResolvedStatus[];
    return [...statuses].sort((a, b) => a.order - b.order);
  }, [statuses]);

  const [activeStageId, setActiveStageId] = useState<string>(() => {
    if (!statuses || statuses.length === 0) return '';
    const sorted = [...statuses].sort((a, b) => a.order - b.order);
    return sorted[0]?.id ?? '';
  });

  // Keep activeStageId valid when statuses change
  useEffect(() => {
    if (stages.length === 0) return;
    const has = stages.some((s) => s.id === activeStageId);
    if (!has) setActiveStageId(stages[0]!.id);
  }, [stages, activeStageId]);

  const stageTasks = useMemo(() => {
    const map = new Map<string, T[]>();
    for (const s of stages) map.set(s.id, []);
    for (const t of tasks) {
      if (!map.has(t.status)) map.set(t.status, []);
      map.get(t.status)!.push(t);
    }
    return map;
  }, [stages, tasks]);

  if (stages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: 'var(--muted)' }}>
        <p className="text-[13px]" style={{ fontFamily: 'var(--font-body)' }}>
          No workflow stages are available for this project.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Mobile: stage select — hidden on md+ */}
      {isMobile && stages.length > 0 && (
        <div className="flex-shrink-0 px-4 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
          <select
            value={activeStageId}
            onChange={(e) => setActiveStageId(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-[13px] font-medium"
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              color: 'var(--foreground)',
              fontFamily: 'var(--font-heading)',
            }}
          >
            {stages.map((s) => {
              const count = (stageTasks.get(s.id) ?? []).length;
              return (
                <option key={s.id} value={s.id}>
                  {s.label} ({count})
                </option>
              );
            })}
          </select>
        </div>
      )}
      {/* Columns wrapper */}
      <div className={isMobile ? 'flex-1 overflow-y-auto px-4 py-4' : 'flex flex-1 overflow-x-auto px-4 py-4 gap-3'}>
      {stages.filter((s) => !isMobile || s.id === activeStageId).map((stage) => {
        const items = stageTasks.get(stage.id) ?? [];
        // Deal-value sum — only meaningful when at least one card has it set.
        let valueSum = 0;
        let hasValue = false;
        for (const t of items) {
          const v = t.metadata?.deal_value;
          const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
          if (!Number.isNaN(n)) {
            valueSum += n;
            hasValue = true;
          }
        }
        return (
          <div
            key={stage.id}
            className={`flex flex-col rounded-lg ${isMobile ? 'w-full' : 'w-[320px] min-w-[320px]'}`}
            style={{ background: 'var(--surface)' }}
          >
            {/* Stage header */}
            <div
              className="flex items-center gap-2 px-3 py-2.5 flex-shrink-0"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <div className="w-2 h-2 rounded-full" style={{ background: stage.color }} />
              <span
                className="text-[12px] font-semibold uppercase tracking-wide"
                style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-heading)' }}
              >
                {stage.label}
              </span>
              <span
                className="ml-auto text-[11px] font-medium px-1.5 py-0.5 rounded-full"
                style={{ color: 'var(--muted)', background: 'var(--hover-tint)' }}
              >
                {items.length}
              </span>
            </div>

            {/* Cards */}
            <div className="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-2">
              {items.length === 0 && (
                <p
                  className="text-[11px] text-center py-3"
                  style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}
                >
                  No tasks
                </p>
              )}
              {items.map((t) => {
                const priStyle = PRIORITY_STYLES[t.priority] ?? PRIORITY_STYLES.p2;
                const priText = priorityLabel(t.priority as CanonicalPriority, priorityVocab);
                const contact = t.metadata?.contact_name as string | undefined;
                const company = t.metadata?.company as string | undefined;
                const rawValue = t.metadata?.deal_value;
                const dealValueNum =
                  typeof rawValue === 'number'
                    ? rawValue
                    : typeof rawValue === 'string'
                      ? Number(rawValue)
                      : NaN;
                const dealValue = !Number.isNaN(dealValueNum) ? fmtMoney(dealValueNum) : null;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onTaskClick(t)}
                    className="rounded-lg p-3 text-left w-full"
                    style={{
                      background: 'var(--card-bg)',
                      border: '1px solid var(--border)',
                      cursor: 'pointer',
                      transition: 'border-color 150ms, box-shadow 150ms',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.boxShadow = 'none';
                    }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      {!hidePrefixIds && (
                        <span
                          className="text-[11px] font-medium"
                          style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
                        >
                          {projectPrefix || t.project_prefix}-{t.number}
                        </span>
                      )}
                      <span
                        className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded"
                        style={{ background: priStyle.bg, color: priStyle.color, fontFamily: 'var(--font-heading)' }}
                      >
                        {priText}
                      </span>
                    </div>
                    <p
                      className="text-[13px] font-medium leading-snug mb-1.5"
                      style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                    >
                      {t.title}
                    </p>
                    {(contact || company) && (
                      <p
                        className="text-[11px] mb-1"
                        style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
                      >
                        {[contact, company].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    <div className="flex items-center justify-between">
                      {dealValue ? (
                        <span
                          className="text-[12px] font-semibold"
                          style={{ color: 'var(--success, #10b981)', fontFamily: 'var(--font-heading)' }}
                        >
                          {dealValue}
                        </span>
                      ) : (
                        <span />
                      )}
                      {t.assignee_name && (
                        <div
                          className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium text-white"
                          style={{ background: 'var(--accent)' }}
                          title={t.assignee_name}
                        >
                          {t.assignee_name.charAt(0).toUpperCase()}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Footer with sum */}
            {hasValue && (
              <div
                className="flex items-center justify-between px-3 py-2 flex-shrink-0 text-[11px] font-medium"
                style={{
                  borderTop: '1px solid var(--border)',
                  color: 'var(--muted)',
                  fontFamily: 'var(--font-heading)',
                }}
              >
                <span>{items.length} deal{items.length === 1 ? '' : 's'}</span>
                <span style={{ color: 'var(--success, #10b981)' }}>{fmtMoney(valueSum)}</span>
              </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}
