'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
import { createNativeCreateIntent } from '@/lib/native-create-intent';
import { calendarMemberDisplayName, calendarMemberMatches } from '@/lib/calendar-members';
import type { CalEvent } from '@/lib/calendar';
import { eventFormDefaults, eventSaveTarget } from '@/lib/calendar-event-form';
import { dateKeyInUserTimezone, getUserTimezone, userWallTimeToIso } from '@/lib/time';
import { X, Users } from 'lucide-react';
import { PersonAvatar } from '../person-avatar';

type OrgMember = { id: string; name: string | null; email: string | null; avatar_url: string | null };

export function CreateEventModal({
  onClose, onCreated, defaultDate, defaultStart, defaultEnd, editEvent,
}: {
  onClose: () => void;
  onCreated?: () => void;
  defaultDate?: string;
  defaultStart?: string;
  defaultEnd?: string;
  editEvent?: CalEvent;
}) {
  const today = new Date();
  const todayStr = dateKeyInUserTimezone(today);

  const initial = editEvent ? eventFormDefaults(editEvent) : null;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [date, setDate] = useState(initial?.date ?? defaultDate ?? todayStr);
  const [endDate, setEndDate] = useState(initial?.endDate ?? defaultDate ?? todayStr);
  const [startTime, setStartTime] = useState(initial?.startTime ?? defaultStart ?? '09:00');
  const [endTime, setEndTime] = useState(initial?.endTime ?? defaultEnd ?? '10:00');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [attendees, setAttendees] = useState<OrgMember[]>(initial?.attendees ?? []);
  const [allMembers, setAllMembers] = useState<OrgMember[]>([]);
  const [attendeeSearch, setAttendeeSearch] = useState('');
  const [showAttendeeDropdown, setShowAttendeeDropdown] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const createIntentRef = useRef(createNativeCreateIntent('event:create-modal'));
  const handleClose = useCallback(() => {
    createIntentRef.current.cancel();
    onClose();
  }, [onClose]);

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
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !date || !endDate || !startTime || !endTime || submitting) return;

    setSubmitting(true);
    setError('');

    try {
      const start = userWallTimeToIso(date, startTime);
      const end = userWallTimeToIso(endDate, endTime);
      if (end <= start) throw new Error('End must be after start');

      const originalAttendeeEmails = editEvent
        ? (editEvent.metadata?.attendees ?? []).map((a: { email?: string }) => a.email ?? '').filter(Boolean).sort()
        : [];
      const attendeeEmails = attendees.map((a) => a.email ?? '').filter(Boolean).sort();
      const attendeesChanged = !editEvent || originalAttendeeEmails.join('\n') !== attendeeEmails.join('\n');

      const body = {
        title: title.trim(),
        start,
        end,
        description: editEvent ? description.trim() : description.trim() || undefined,
        location: editEvent ? location.trim() : location.trim() || undefined,
        metadata: attendeesChanged ? {
          attendees: attendees.map(a => ({
            name: calendarMemberDisplayName(a),
            email: a.email ?? '',
          })),
        } : undefined,
      };
      const target = eventSaveTarget(editEvent?.id);
      const intentKey = editEvent ? null : await createIntentRef.current.keyFor(body);
      const res = target.method === 'patch'
        ? await api.patch(target.path, body)
        : await api.post('/api/events', body, { headers: { 'Idempotency-Key': intentKey! } });

      if (res.ok) {
        if (intentKey) createIntentRef.current.acknowledgeSuccess(intentKey);
        onCreated?.();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to create event');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to save event');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.5)' }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className="w-[calc(100vw-2rem)] max-w-[420px] rounded-xl overflow-hidden"
        style={{ background: 'var(--card-bg, var(--surface-container-low))', border: '1px solid var(--border-default)', boxShadow: '0 25px 50px -12px rgba(0,0,0,.25)' }}>
        {/* Header */}
        <div className="px-5 py-4 flex items-center justify-between"
          style={{ borderBottom: '1px solid var(--border-default)' }}>
          <h2 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{editEvent ? 'Edit event' : 'New event'}</h2>
          <button onClick={handleClose} className="p-1 rounded hover:opacity-70"
            style={{ color: 'var(--text-tertiary)' }}>
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-3">
          <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>Times in {getUserTimezone()}</p>
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Date</label>
              <input type="date" value={date} onChange={(e) => {
                const nextDate = e.target.value;
                setEndDate((current) => current === date ? nextDate : current);
                setDate(nextDate);
              }}
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
              <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>End date</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
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
            <button type="button" onClick={handleClose}
              className="px-4 py-2 rounded-lg text-[12px] font-medium"
              style={{ color: 'var(--text-secondary)' }}>
              Cancel
            </button>
            <button type="submit" disabled={!title.trim() || submitting}
              className="px-4 py-2 rounded-lg text-[12px] font-medium transition-opacity"
              style={{ background: 'var(--accent)', color: 'white', opacity: !title.trim() || submitting ? 0.5 : 1 }}>
              {submitting ? (editEvent ? 'Saving...' : 'Creating...') : (editEvent ? 'Save changes' : 'Create event')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
