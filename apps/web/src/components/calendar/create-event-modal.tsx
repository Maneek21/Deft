'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { X } from 'lucide-react';

export function CreateEventModal({
  onClose, onCreated, defaultDate, defaultStart, defaultEnd,
}: {
  onClose: () => void;
  onCreated?: () => void;
  defaultDate?: string;
  defaultStart?: string;
  defaultEnd?: string;
}) {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const [title, setTitle] = useState('');
  const [date, setDate] = useState(defaultDate || todayStr);
  const [startTime, setStartTime] = useState(defaultStart || '09:00');
  const [endTime, setEndTime] = useState(defaultEnd || '10:00');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !date || !startTime || !endTime) return;

    setSubmitting(true);
    setError('');

    try {
      const start = new Date(`${date}T${startTime}:00`).toISOString();
      const end = new Date(`${date}T${endTime}:00`).toISOString();

      const res = await api.post('/api/events', {
        title: title.trim(),
        start,
        end,
        description: description.trim() || undefined,
        location: location.trim() || undefined,
      });

      if (res.ok) {
        onCreated?.();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to create event');
      }
    } catch {
      setError('Failed to create event');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.5)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[calc(100vw-2rem)] max-w-[420px] rounded-xl overflow-hidden"
        style={{ background: 'var(--card-bg, var(--surface-container-low))', border: '1px solid var(--border-default)', boxShadow: '0 25px 50px -12px rgba(0,0,0,.25)' }}>
        {/* Header */}
        <div className="px-5 py-4 flex items-center justify-between"
          style={{ borderBottom: '1px solid var(--border-default)' }}>
          <h2 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>New event</h2>
          <button onClick={onClose} className="p-1 rounded hover:opacity-70"
            style={{ color: 'var(--text-tertiary)' }}>
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-3">
          <div>
            <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Title</label>
            <input ref={inputRef} value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="Event title"
              className="w-full px-3 py-2 rounded-lg text-[13px] outline-none transition-all"
              style={{ background: 'var(--surface-container-highest, var(--bg-surface))', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
              onBlur={(e) => { e.target.style.borderColor = 'var(--border-default)'; }}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
                style={{ background: 'var(--surface-container-highest, var(--bg-surface))', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Start</label>
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
                style={{ background: 'var(--surface-container-highest, var(--bg-surface))', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>End</label>
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
                style={{ background: 'var(--surface-container-highest, var(--bg-surface))', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Location</label>
            <input value={location} onChange={(e) => setLocation(e.target.value)}
              placeholder="Add location"
              className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
              style={{ background: 'var(--surface-container-highest, var(--bg-surface))', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Add description"
              rows={3}
              className="w-full px-3 py-2 rounded-lg text-[13px] outline-none resize-none"
              style={{ background: 'var(--surface-container-highest, var(--bg-surface))', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            />
          </div>

          {error && (
            <p className="text-[11px]" style={{ color: 'var(--status-red)' }}>{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-lg text-[12px] font-medium"
              style={{ color: 'var(--text-secondary)' }}>
              Cancel
            </button>
            <button type="submit" disabled={!title.trim() || submitting}
              className="px-4 py-2 rounded-lg text-[12px] font-medium transition-opacity"
              style={{ background: 'var(--accent)', color: 'white', opacity: !title.trim() || submitting ? 0.5 : 1 }}>
              {submitting ? 'Creating...' : 'Create event'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
