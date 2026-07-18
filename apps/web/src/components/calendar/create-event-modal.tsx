'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { calendarMemberDisplayName, calendarMemberMatches } from '@/lib/calendar-members';
import { X, Users } from 'lucide-react';
import { PersonAvatar } from '../person-avatar';

type OrgMember = { id: string; name: string | null; email: string | null; avatar_url: string | null };

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
  const [attendees, setAttendees] = useState<OrgMember[]>([]);
  const [allMembers, setAllMembers] = useState<OrgMember[]>([]);
  const [attendeeSearch, setAttendeeSearch] = useState('');
  const [showAttendeeDropdown, setShowAttendeeDropdown] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    api.get('/api/members').then(async res => {
      if (res.ok) setAllMembers(await res.json());
    }).catch(() => {});
  }, []);

  const filteredMembers = allMembers.filter(m =>
    !attendees.some(a => a.id === m.id) &&
    calendarMemberMatches(m, attendeeSearch)
  );

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
        metadata: attendees.length > 0 ? {
          attendees: attendees.map(a => ({
            name: calendarMemberDisplayName(a),
            email: a.email ?? '',
          })),
        } : undefined,
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

          {/* Attendees */}
          <div>
            <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              <Users size={11} className="inline mr-1" />Attendees
            </label>
            {attendees.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {attendees.map(a => (
                  <span key={a.id} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px]"
                    style={{ background: 'var(--surface-container-highest, var(--bg-surface))', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}>
                    {calendarMemberDisplayName(a)}
                    <button type="button" onClick={() => setAttendees(prev => prev.filter(x => x.id !== a.id))}
                      className="hover:opacity-70">
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="relative">
              <input
                value={attendeeSearch}
                onChange={e => { setAttendeeSearch(e.target.value); setShowAttendeeDropdown(true); }}
                onFocus={() => setShowAttendeeDropdown(true)}
                placeholder="Search members..."
                className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
                style={{ background: 'var(--surface-container-highest, var(--bg-surface))', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              />
              {showAttendeeDropdown && filteredMembers.length > 0 && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowAttendeeDropdown(false)} />
                  <div className="absolute left-0 right-0 top-full mt-1 max-h-32 overflow-y-auto rounded-lg py-1 z-20"
                    style={{ background: 'var(--card-bg, var(--surface-container-low))', border: '1px solid var(--border-default)', boxShadow: '0 8px 24px rgba(0,0,0,.15)' }}>
                    {filteredMembers.slice(0, 8).map(m => (
                      <button key={m.id} type="button"
                        onClick={() => { setAttendees(prev => [...prev, m]); setAttendeeSearch(''); setShowAttendeeDropdown(false); }}
                        className="w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2"
                        style={{ color: 'var(--text-primary)' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover-tint, rgba(255,255,255,0.05))')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <PersonAvatar name={calendarMemberDisplayName(m)} avatarUrl={m.avatar_url} size={20} fontSize={9} />
                        <span>{calendarMemberDisplayName(m)}</span>
                        <span className="ml-auto" style={{ color: 'var(--text-tertiary)' }}>{m.email}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
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
