'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { X, Hash, Lock } from 'lucide-react';
import { useChatContext } from '@/lib/chat-context';

type Props = {
  onClose: () => void;
  onCreated?: (space: { id: string; name: string; type: string }) => void;
};

export function CreateSpaceModal({ onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<'public' | 'private'>('public');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const { refreshSpaces, setActiveSpaceId } = useChatContext();

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await api.post('/api/spaces', {
        name: name.trim(),
        description: description.trim() || null,
        type,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to create space' }));
        throw new Error(data.error || 'Failed to create space');
      }

      const space = await res.json();
      refreshSpaces();
      setActiveSpaceId(space.id);
      onCreated?.(space);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create space');
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
        className="w-[calc(100vw-2rem)] max-w-[420px] max-h-[90vh] overflow-y-auto rounded-2xl"
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
            Create a space
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md"
            style={{ color: 'var(--muted)' }}
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5">
          {/* Type toggle */}
          <div className="flex gap-2 mb-4">
            {(['public', 'private'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors"
                style={{
                  background: type === t ? 'var(--accent)' : 'var(--surface)',
                  color: type === t ? 'white' : 'var(--foreground-secondary)',
                  fontFamily: 'var(--font-body)',
                }}
              >
                {t === 'public' ? <Hash size={13} strokeWidth={1.5} /> : <Lock size={13} strokeWidth={1.5} />}
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

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
              placeholder="e.g. engineering"
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
              placeholder="What's this space about?"
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

          {/* Error */}
          {error && (
            <p className="text-[12px] mb-3" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={!name.trim() || submitting}
            className="w-full py-2 rounded-lg text-[13px] font-medium text-white transition-opacity"
            style={{
              background: 'var(--accent)',
              opacity: !name.trim() || submitting ? 0.5 : 1,
              fontFamily: 'var(--font-heading)',
            }}
          >
            {submitting ? 'Creating...' : 'Create Space'}
          </button>
        </form>
      </div>
    </div>
  );
}
