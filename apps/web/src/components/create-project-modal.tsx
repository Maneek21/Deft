'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { X } from 'lucide-react';

const PRESET_COLORS = [
  '#D4A853', // amber
  '#3B82F6', // blue
  '#8B5CF6', // purple
  '#22C55E', // green
  '#EF4444', // red
  '#6B7280', // gray
];

type Project = {
  id: string;
  name: string;
  prefix: string;
  color: string | null;
  task_counter: number;
  total_tasks: number;
  done_tasks: number;
};

type Props = {
  onClose: () => void;
  onCreated: (project: Project) => void;
};

export function CreateProjectModal({ onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#D4A853');
  const [prefixManuallyEdited, setPrefixManuallyEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Auto-generate prefix from name
  useEffect(() => {
    if (name && !prefixManuallyEdited) {
      const words = name.split(/\s+/).filter(Boolean);
      let auto = words.map((w) => w[0]).join('').toUpperCase().slice(0, 4);
      // API requires min 2 chars — pad with next letters from the first word
      if (auto.length < 2 && words[0]) {
        auto = words[0].slice(0, 4).toUpperCase();
      }
      setPrefix(auto);
    }
  }, [name, prefixManuallyEdited]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (prefix.trim().length < 2) {
      setError('Prefix must be at least 2 characters');
      return;
    }
    if (prefix.trim().length > 6) {
      setError('Prefix must be 6 characters or fewer');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await api.post('/api/projects', {
        name: name.trim(),
        prefix: prefix.trim().toUpperCase(),
        description: description.trim() || undefined,
        color,
      });

      if (!res.ok) {
        const data = await res
          .json()
          .catch(() => ({ error: 'Failed to create project' }));
        throw new Error(data.error || 'Failed to create project');
      }

      const project = (await res.json()) as Project;

      const finalProject: Project = {
        ...project,
        total_tasks: 0,
        done_tasks: 0,
      };

      onCreated(finalProject);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.5)' }}
      onClick={onClose}
    >
      <div
        className="w-[calc(100vw-2rem)] max-w-[480px] max-h-[90vh] overflow-y-auto rounded-2xl"
        style={{
          background: 'var(--card-bg)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="px-5 py-4 flex items-center justify-between"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <h2
            className="text-[15px] font-semibold"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
          >
            Create a project
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md"
            style={{ color: 'var(--muted)' }}
            aria-label="Close"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5">
          {/* Name */}
          <div className="mb-3">
            <label
              className="text-[12px] font-medium mb-1 block"
              style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
            >
              Name
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mobile App"
              className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
              style={{
                background: 'var(--input-bg)',
                border: '1px solid var(--input-border)',
                color: 'var(--foreground)',
                fontFamily: 'var(--font-body)',
              }}
              onFocus={(e) => {
                (e.target as HTMLElement).style.borderColor = 'var(--accent)';
                (e.target as HTMLElement).style.boxShadow = '0 0 0 3px var(--input-focus)';
              }}
              onBlur={(e) => {
                (e.target as HTMLElement).style.borderColor = 'var(--input-border)';
                (e.target as HTMLElement).style.boxShadow = 'none';
              }}
            />
          </div>

          {/* Prefix */}
          <div className="mb-3">
            <label
              className="text-[12px] font-medium mb-1 block"
              style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
            >
              Prefix <span style={{ color: 'var(--muted)' }}>(used in task IDs like PRJ-1)</span>
            </label>
            <input
              type="text"
              value={prefix}
              onChange={(e) => {
                setPrefixManuallyEdited(true);
                setPrefix(e.target.value.toUpperCase().slice(0, 4));
              }}
              placeholder="e.g. MOB"
              maxLength={4}
              className="w-full px-3 py-2 rounded-lg text-[13px] outline-none uppercase"
              style={{
                background: 'var(--input-bg)',
                border: '1px solid var(--input-border)',
                color: 'var(--foreground)',
                fontFamily: 'var(--font-body)',
                letterSpacing: '0.05em',
              }}
              onFocus={(e) => {
                (e.target as HTMLElement).style.borderColor = 'var(--accent)';
                (e.target as HTMLElement).style.boxShadow = '0 0 0 3px var(--input-focus)';
              }}
              onBlur={(e) => {
                (e.target as HTMLElement).style.borderColor = 'var(--input-border)';
                (e.target as HTMLElement).style.boxShadow = 'none';
              }}
            />
          </div>

          {/* Description */}
          <div className="mb-4">
            <label
              className="text-[12px] font-medium mb-1 block"
              style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
            >
              Description <span style={{ color: 'var(--muted)' }}>(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this project about?"
              className="w-full px-3 py-2 rounded-lg text-[13px] outline-none resize-none"
              rows={2}
              style={{
                background: 'var(--input-bg)',
                border: '1px solid var(--input-border)',
                color: 'var(--foreground)',
                fontFamily: 'var(--font-body)',
              }}
              onFocus={(e) => {
                (e.target as HTMLElement).style.borderColor = 'var(--accent)';
                (e.target as HTMLElement).style.boxShadow = '0 0 0 3px var(--input-focus)';
              }}
              onBlur={(e) => {
                (e.target as HTMLElement).style.borderColor = 'var(--input-border)';
                (e.target as HTMLElement).style.boxShadow = 'none';
              }}
            />
          </div>

          {/* Color picker */}
          <div className="mb-4">
            <label
              className="text-[12px] font-medium mb-2 block"
              style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
            >
              Color
            </label>
            <div className="flex gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className="w-7 h-7 rounded-full flex items-center justify-center transition-transform"
                  style={{
                    background: c,
                    transform: color === c ? 'scale(1.15)' : 'scale(1)',
                    boxShadow: color === c ? `0 0 0 2px var(--card-bg), 0 0 0 4px ${c}` : 'none',
                  }}
                />
              ))}
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="text-[12px] mb-3" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting || !name.trim() || !prefix.trim()}
            className="w-full py-2 rounded-lg text-[13px] font-medium text-white transition-opacity"
            style={{
              background: 'var(--accent)',
              opacity: submitting || !name.trim() || !prefix.trim() ? 0.5 : 1,
              fontFamily: 'var(--font-heading)',
            }}
          >
            {submitting ? 'Creating...' : 'Create project'}
          </button>
        </form>
      </div>
    </div>
  );
}
