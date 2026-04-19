'use client';

import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { api } from '@/lib/api';

type TemplateTask = {
  title: string;
  due_offset_days?: number;
};

type Template = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  tasks: TemplateTask[];
};

export function TemplatePickerModal({
  projectId,
  onClose,
  onApplied,
}: {
  projectId: string;
  onClose: () => void;
  onApplied: (count: number) => void;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const res = await api.get('/api/task-templates');
      if (res.ok) {
        const body = await res.json();
        setTemplates(body.templates ?? []);
      }
      setLoading(false);
    }
    load();
  }, []);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const selected = templates.find((t) => t.id === selectedId) ?? null;

  async function apply() {
    if (!selectedId) return;
    setApplying(true);
    setErrorMsg(null);
    try {
      const res = await api.post(`/api/projects/${projectId}/apply-template`, {
        template_id: selectedId,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Failed' }));
        throw new Error(body.error ?? 'Failed to apply template');
      }
      const body = (await res.json()) as { count: number };
      onApplied(body.count);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl p-0"
        style={{
          background: 'var(--card-bg)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <h2
            className="text-[14px] font-semibold"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
          >
            Apply a template
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md"
            style={{ color: 'var(--muted)', transition: 'color 150ms' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--foreground)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex gap-0 p-5" style={{ minHeight: '280px' }}>
          {/* Template list */}
          <div className="flex-1 space-y-2 overflow-y-auto pr-4" style={{ maxHeight: '50vh' }}>
            {loading && (
              <p className="text-[12px]" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                Loading templates…
              </p>
            )}
            {!loading && templates.length === 0 && (
              <p className="text-[12px]" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                No templates available.
              </p>
            )}
            {templates.map((tpl) => {
              const isSelected = selectedId === tpl.id;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  className="w-full rounded-lg p-3 text-left transition-all"
                  style={{
                    border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                    background: isSelected ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
                    transition: 'all 150ms',
                  }}
                  onClick={() => setSelectedId(tpl.id)}
                  onMouseEnter={(e) => {
                    if (!isSelected) e.currentTarget.style.background = 'var(--hover-tint)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <div
                    className="text-[13px] font-medium"
                    style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
                  >
                    {tpl.name}
                  </div>
                  <div
                    className="text-[11px] mt-0.5"
                    style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}
                  >
                    {tpl.tasks.length} task{tpl.tasks.length !== 1 ? 's' : ''}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Divider */}
          <div style={{ width: '1px', background: 'var(--border)', margin: '0 16px', flexShrink: 0 }} />

          {/* Preview panel */}
          <div className="flex-1 overflow-y-auto" style={{ maxHeight: '50vh' }}>
            {selected ? (
              <>
                {selected.description && (
                  <p
                    className="text-[12px] mb-3"
                    style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
                  >
                    {selected.description}
                  </p>
                )}
                <ol className="space-y-1.5">
                  {selected.tasks.map((t, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span
                        className="text-[11px] font-medium mt-0.5 shrink-0"
                        style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)', minWidth: '18px' }}
                      >
                        {i + 1}.
                      </span>
                      <span
                        className="text-[12px]"
                        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                      >
                        {t.title}
                        {typeof t.due_offset_days === 'number' && (
                          <span
                            className="ml-1.5 text-[11px]"
                            style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}
                          >
                            +{t.due_offset_days}d
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p
                className="text-[12px]"
                style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}
              >
                Select a template to preview its tasks.
              </p>
            )}
          </div>
        </div>

        {/* Error */}
        {errorMsg && (
          <div className="px-5 pb-3">
            <p className="text-[12px]" style={{ color: 'var(--danger)' }} role="alert">
              {errorMsg}
            </p>
          </div>
        )}

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-[12px] font-medium"
            style={{
              color: 'var(--foreground-secondary)',
              border: '1px solid var(--border)',
              fontFamily: 'var(--font-heading)',
              transition: 'background 150ms',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!selectedId || applying}
            className="px-3 py-1.5 rounded-md text-[12px] font-medium text-white disabled:opacity-50"
            style={{
              background: 'var(--accent)',
              fontFamily: 'var(--font-heading)',
              transition: 'opacity 150ms',
            }}
          >
            {applying ? 'Applying…' : 'Apply template'}
          </button>
        </div>
      </div>
    </div>
  );
}
