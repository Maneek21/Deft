'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { ChevronDown, X, User, AlertTriangle, Tag, Calendar } from 'lucide-react';

export type Filters = {
  assigneeId: string | null;
  priorities: string[];
  labels: string[];
  dueDate: 'overdue' | 'today' | 'this_week' | null;
};

type Props = {
  filters: Filters;
  onChange: (filters: Filters) => void;
};

const PRIORITY_OPTIONS = [
  { value: 'p0', label: 'P0 — Urgent', color: '#DC2626' },
  { value: 'p1', label: 'P1 — High', color: '#F59E0B' },
  { value: 'p2', label: 'P2 — Medium', color: '#3B82F6' },
  { value: 'p3', label: 'P3 — Low', color: '#6B7280' },
];

const DUE_DATE_OPTIONS = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'this_week', label: 'This week' },
];

export function TaskFilters({ filters, onChange }: Props) {
  const { user } = useAuth();
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);

  const hasActive =
    filters.assigneeId !== null ||
    filters.priorities.length > 0 ||
    filters.labels.length > 0 ||
    filters.dueDate !== null;

  const clearAll = () => {
    onChange({ assigneeId: null, priorities: [], labels: [], dueDate: null });
  };

  const togglePriority = (p: string) => {
    const next = filters.priorities.includes(p)
      ? filters.priorities.filter((x) => x !== p)
      : [...filters.priorities, p];
    onChange({ ...filters, priorities: next });
  };

  return (
    <>
      {openDropdown && <div className="fixed inset-0 z-10" onClick={() => setOpenDropdown(null)} />}

      <div
        className="flex items-center gap-2 px-6 py-2 flex-shrink-0 flex-wrap"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        {/* My tasks toggle */}
        <button
          onClick={() => onChange({ ...filters, assigneeId: filters.assigneeId === 'me' ? null : 'me' })}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium"
          style={{
            background: filters.assigneeId === 'me' ? 'var(--accent-subtle)' : 'transparent',
            color: filters.assigneeId === 'me' ? 'var(--accent)' : 'var(--foreground-secondary)',
            border: `1px solid ${filters.assigneeId === 'me' ? 'var(--accent)' : 'var(--border)'}`,
            fontFamily: 'var(--font-heading)',
            transition: 'all 150ms',
          }}
        >
          <User size={12} />
          My tasks
        </button>

        {/* Priority dropdown */}
        <div className="relative">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'priority' ? null : 'priority')}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium"
            style={{
              background: filters.priorities.length > 0 ? 'var(--accent-subtle)' : 'transparent',
              color: filters.priorities.length > 0 ? 'var(--accent)' : 'var(--foreground-secondary)',
              border: `1px solid ${filters.priorities.length > 0 ? 'var(--accent)' : 'var(--border)'}`,
              fontFamily: 'var(--font-heading)',
              transition: 'all 150ms',
            }}
          >
            <AlertTriangle size={12} />
            Priority
            {filters.priorities.length > 0 && (
              <span className="text-[10px] px-1 rounded-full" style={{ background: 'var(--accent)', color: 'white' }}>
                {filters.priorities.length}
              </span>
            )}
            <ChevronDown size={11} />
          </button>
          {openDropdown === 'priority' && (
            <div
              className="absolute top-full left-0 mt-1 w-48 rounded-lg py-1 z-20"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
            >
              {PRIORITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => togglePriority(opt.value)}
                  className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px]"
                  style={{
                    color: filters.priorities.includes(opt.value) ? 'var(--accent)' : 'var(--foreground)',
                    fontFamily: 'var(--font-body)',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div
                    className="w-3.5 h-3.5 rounded border flex items-center justify-center"
                    style={{
                      borderColor: filters.priorities.includes(opt.value) ? 'var(--accent)' : 'var(--border)',
                      background: filters.priorities.includes(opt.value) ? 'var(--accent)' : 'transparent',
                    }}
                  >
                    {filters.priorities.includes(opt.value) && (
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                        <path d="M1 4L3 6L7 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                  <div className="w-2 h-2 rounded-full" style={{ background: opt.color }} />
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Due date dropdown */}
        <div className="relative">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'dueDate' ? null : 'dueDate')}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium"
            style={{
              background: filters.dueDate ? 'var(--accent-subtle)' : 'transparent',
              color: filters.dueDate ? 'var(--accent)' : 'var(--foreground-secondary)',
              border: `1px solid ${filters.dueDate ? 'var(--accent)' : 'var(--border)'}`,
              fontFamily: 'var(--font-heading)',
              transition: 'all 150ms',
            }}
          >
            <Calendar size={12} />
            {filters.dueDate ? DUE_DATE_OPTIONS.find((d) => d.value === filters.dueDate)?.label : 'Due date'}
            <ChevronDown size={11} />
          </button>
          {openDropdown === 'dueDate' && (
            <div
              className="absolute top-full left-0 mt-1 w-40 rounded-lg py-1 z-20"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
            >
              {DUE_DATE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    onChange({ ...filters, dueDate: filters.dueDate === opt.value ? null : opt.value as Filters['dueDate'] });
                    setOpenDropdown(null);
                  }}
                  className="w-full text-left px-3 py-1.5 text-[12px]"
                  style={{
                    color: filters.dueDate === opt.value ? 'var(--accent)' : 'var(--foreground)',
                    fontFamily: 'var(--font-body)',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Active filter pills */}
        {filters.priorities.length > 0 &&
          filters.priorities.map((p) => {
            const opt = PRIORITY_OPTIONS.find((o) => o.value === p);
            return (
              <div
                key={p}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
                style={{
                  background: 'var(--hover-tint)',
                  color: 'var(--foreground-secondary)',
                  fontFamily: 'var(--font-body)',
                }}
              >
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: opt?.color }} />
                {opt?.label.split(' ')[0]}
                <button
                  onClick={() => togglePriority(p)}
                  style={{ color: 'var(--muted)' }}
                  className="ml-0.5"
                >
                  <X size={10} />
                </button>
              </div>
            );
          })}

        {filters.dueDate && (
          <div
            className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
            style={{
              background: 'var(--hover-tint)',
              color: 'var(--foreground-secondary)',
              fontFamily: 'var(--font-body)',
            }}
          >
            {DUE_DATE_OPTIONS.find((d) => d.value === filters.dueDate)?.label}
            <button
              onClick={() => onChange({ ...filters, dueDate: null })}
              style={{ color: 'var(--muted)' }}
              className="ml-0.5"
            >
              <X size={10} />
            </button>
          </div>
        )}

        {/* Clear all */}
        {hasActive && (
          <button
            onClick={clearAll}
            className="text-[11px] font-medium px-2 py-0.5 rounded-md ml-1"
            style={{
              color: 'var(--muted)',
              fontFamily: 'var(--font-heading)',
              transition: 'color 150ms',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--foreground)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
          >
            Clear all
          </button>
        )}
      </div>
    </>
  );
}
