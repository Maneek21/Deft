'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { Plus, X } from 'lucide-react';

type Label = {
  id: string;
  name: string;
  color: string;
};

type Props = {
  taskId: string;
  appliedLabels: Label[];
  onLabelsChange: (labels: Label[]) => void;
};

const PALETTE = ['#DC2626', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899', '#14B8A6', '#6366F1'];

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export function LabelPicker({ taskId, appliedLabels, onLabelsChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.get('/api/tasks/labels').then(async res => {
      if (res.ok) {
        const data = await res.json();
        setAllLabels(data.map((l: any) => ({ id: l.id, name: l.name, color: l.color })));
      }
      setLoading(false);
    });
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const appliedIds = new Set(appliedLabels.map(l => l.id));
  const trimmed = query.trim();
  const filtered = allLabels.filter(l =>
    l.name.toLowerCase().includes(trimmed.toLowerCase()) && !appliedIds.has(l.id)
  );
  const exactExists = allLabels.some(l => l.name.toLowerCase() === trimmed.toLowerCase());
  const canCreate = trimmed.length > 0 && !exactExists;

  const applyLabel = async (label: Label) => {
    const res = await api.post(`/api/tasks/${taskId}/labels`, { label_id: label.id });
    if (res.ok) {
      onLabelsChange([...appliedLabels, label]);
    }
  };

  const removeLabel = async (label: Label) => {
    const res = await api.delete(`/api/tasks/${taskId}/labels/${label.id}`);
    if (res.ok) {
      onLabelsChange(appliedLabels.filter(l => l.id !== label.id));
    }
  };

  const createAndApply = async () => {
    if (!trimmed) return;
    const res = await api.post('/api/tasks/labels', { name: trimmed, color: colorFor(trimmed) });
    if (res.ok) {
      const created = await res.json();
      const label: Label = { id: created.id, name: created.name, color: created.color };
      const attached = await api.post(`/api/tasks/${taskId}/labels`, { label_id: label.id });
      if (attached.ok) {
        onLabelsChange([...appliedLabels, label]);
        setAllLabels(prev => [...prev, label]);
        setQuery('');
      }
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <div className="flex flex-wrap gap-1 items-center">
        {appliedLabels.map(label => (
          <span
            key={label.id}
            className="text-[11px] font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
            style={{ background: `${label.color}20`, color: label.color }}
          >
            {label.name}
            <button onClick={() => removeLabel(label)} className="hover:opacity-70" aria-label={`Remove ${label.name}`}>
              <X size={10} />
            </button>
          </span>
        ))}
        <button
          onClick={() => setOpen(!open)}
          className="inline-flex items-center gap-1 rounded-full transition-colors px-2 py-0.5 text-[11px]"
          style={{ color: 'var(--muted)', border: open ? '1px solid var(--accent)' : '1px dashed var(--border)' }}
        >
          <Plus size={10} />
          Label
        </button>
      </div>

      {open && (
        <div
          className="absolute top-full left-0 mt-1 w-56 rounded-lg py-1 z-50"
          style={{ background: 'var(--surface-container-highest)', boxShadow: 'var(--glass-shadow)' }}
        >
          <div className="px-2 py-1">
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && canCreate) createAndApply();
                if (e.key === 'Escape') setOpen(false);
              }}
              placeholder="Search or create label..."
              className="w-full h-7 px-2 text-[12px] rounded outline-none"
              style={{ background: 'var(--input-bg)', color: 'var(--foreground)', border: '1px solid var(--input-border)' }}
            />
          </div>

          <div className="max-h-40 overflow-y-auto">
            {filtered.map(label => (
              <button
                key={label.id}
                onClick={() => { void applyLabel(label); setQuery(''); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-white/5"
                style={{ color: 'var(--foreground-secondary)' }}
              >
                <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: label.color }} />
                {label.name}
              </button>
            ))}

            {canCreate && (
              <button
                onClick={createAndApply}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-white/5"
                style={{ color: 'var(--accent)' }}
              >
                <Plus size={12} />
                Create &ldquo;{trimmed}&rdquo;
              </button>
            )}

            {filtered.length === 0 && !canCreate && (
              <p className="px-3 py-2 text-[11px]" style={{ color: 'var(--muted)' }}>
                {loading ? 'Loading...' : 'No labels found'}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
