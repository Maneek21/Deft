'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { statusLabel } from '@/lib/task-status-labels';

type TaskResult = {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  project_prefix: string;
};

function formatStatus(status: string): string {
  return statusLabel(status);
}

const PRIORITY_COLORS: Record<string, string> = {
  p0: '#DC2626', p1: '#D4A853', p2: '#3B82F6', p3: '#6B7280',
};

type Props = {
  query: string;
  onSelect: (task: TaskResult) => void;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
};

export function TaskAutocomplete({ query, onSelect, onClose, anchorRef }: Props) {
  const [results, setResults] = useState<TaskResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!query) { setResults([]); return; }
    const timer = setTimeout(async () => {
      const res = await api.get(`/api/tasks/search?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data = await res.json();
        setResults(data.slice(0, 8));
        setSelectedIndex(0);
      }
    }, 150); // debounce
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, results.length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); }
      if (e.key === 'Enter' && results.length > 0) { e.preventDefault(); onSelect(results[selectedIndex]!); }
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [results, selectedIndex, onSelect, onClose]);

  if (results.length === 0) return null;

  // Position above the anchor
  let style: React.CSSProperties = { position: 'fixed', zIndex: 9999 };
  if (anchorRef?.current) {
    const rect = anchorRef.current.getBoundingClientRect();
    style.bottom = window.innerHeight - rect.top + 4;
    style.left = rect.left;
  }

  return (
    <div ref={ref} style={{ ...style, background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
      className="w-[360px] max-h-[300px] overflow-y-auto rounded-xl py-1">
      {results.map((task, i) => (
        <button key={task.id} onClick={() => onSelect(task)}
          className="w-full text-left px-3 py-2 flex items-center gap-2"
          style={{
            background: i === selectedIndex ? 'var(--hover-tint)' : 'transparent',
            color: 'var(--foreground)',
          }}>
          <span className="text-[12px] font-mono font-medium" style={{ color: 'var(--accent)' }}>
            {task.project_prefix}-{task.number}
          </span>
          <span className="text-[13px] flex-1 truncate" style={{ fontFamily: 'var(--font-body)' }}>
            {task.title}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
            {formatStatus(task.status)}
          </span>
          <span className="w-2 h-2 rounded-full" style={{ background: PRIORITY_COLORS[task.priority] || '#6B7280' }} />
        </button>
      ))}
    </div>
  );
}
