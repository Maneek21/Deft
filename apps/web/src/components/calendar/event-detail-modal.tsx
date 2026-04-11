'use client';

import { useState, useEffect } from 'react';
import { CalEvent, ITEM_COLORS } from '@/lib/calendar';
import { formatEventTime, formatFullDateLong } from '@/lib/time';
import { api } from '@/lib/api';
import {
  X, MapPin, ExternalLink, Users, Video, FileText,
  Clock, Edit2, Trash2,
} from 'lucide-react';
import { CreateEventModal } from './create-event-modal';

const RESPONSE_COLORS: Record<string, string> = {
  accepted: '#22c55e',
  declined: '#ef4444',
  tentative: '#f59e0b',
  needsAction: '#9ca3af',
};

export function EventDetailModal({
  event, briefText, onClose, onDeleted, onUpdated,
}: {
  event: CalEvent;
  briefText?: string;
  onClose: () => void;
  onDeleted?: () => void;
  onUpdated?: () => void;
}) {
  const [showEdit, setShowEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isNative = event.source === 'native';
  const meta = event.metadata || {};
  const startTime = formatEventTime(meta.start || event.timestamp);
  const endTime = meta.end ? formatEventTime(meta.end) : null;
  const dateLabel = formatFullDateLong(new Date(meta.start || event.timestamp));
  const attendees = meta.attendees || [];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleDelete = async () => {
    if (!confirm('Delete this event?')) return;
    setDeleting(true);
    try {
      const res = await api.delete(`/api/events/${event.id}`);
      if (res.ok) onDeleted?.();
    } catch {} finally { setDeleting(false); }
  };

  if (showEdit && isNative) {
    const startDate = meta.start ? new Date(meta.start) : new Date(event.timestamp);
    const endDate = meta.end ? new Date(meta.end) : new Date(startDate.getTime() + 3600000);
    return (
      <CreateEventModal
        onClose={() => setShowEdit(false)}
        onCreated={() => { setShowEdit(false); onUpdated?.(); }}
        defaultDate={`${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`}
        defaultStart={`${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`}
        defaultEnd={`${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}`}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.5)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[calc(100vw-2rem)] max-w-[480px] rounded-xl overflow-hidden max-h-[80vh] overflow-y-auto"
        style={{ background: 'var(--card-bg, var(--surface-container-low))', border: '1px solid var(--border-default)', boxShadow: '0 25px 50px -12px rgba(0,0,0,.25)' }}>

        {/* Header */}
        <div className="px-5 py-4 flex items-start justify-between gap-3"
          style={{ borderBottom: '1px solid var(--border-default)' }}>
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-3 h-3 rounded-full mt-1 flex-shrink-0"
              style={{ background: isNative ? ITEM_COLORS.event : ITEM_COLORS.event }} />
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {event.title}
              </h2>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                {isNative ? 'Deft Event' : 'Google Calendar'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:opacity-70 flex-shrink-0"
            style={{ color: 'var(--text-tertiary)' }}>
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Time */}
          <div className="flex items-center gap-2.5">
            <Clock size={14} style={{ color: 'var(--text-tertiary)' }} />
            <div>
              <p className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {dateLabel}
              </p>
              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {meta.allDay ? 'All day' : `${startTime}${endTime ? ` – ${endTime}` : ''}`}
              </p>
            </div>
          </div>

          {/* Location */}
          {meta.location && (
            <div className="flex items-center gap-2.5">
              <MapPin size={14} style={{ color: 'var(--text-tertiary)' }} />
              <p className="text-[12px]" style={{ color: 'var(--text-primary)' }}>{meta.location}</p>
            </div>
          )}

          {/* Google Meet */}
          {meta.hangoutLink && (
            <div className="flex items-center gap-2.5">
              <Video size={14} style={{ color: 'var(--accent)' }} />
              <a href={meta.hangoutLink} target="_blank" rel="noopener noreferrer"
                className="text-[12px] hover:underline" style={{ color: 'var(--accent)' }}>
                Join Google Meet
              </a>
            </div>
          )}

          {/* Attendees */}
          {attendees.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Users size={14} style={{ color: 'var(--text-tertiary)' }} />
                <span className="text-[11px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                  {attendees.length} Attendees
                </span>
              </div>
              <div className="ml-6 space-y-1.5">
                {attendees.map((a: any, i: number) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full"
                      style={{ background: RESPONSE_COLORS[a.responseStatus] || RESPONSE_COLORS.needsAction }} />
                    <span className="text-[11px]" style={{ color: 'var(--text-primary)' }}>
                      {a.displayName || a.email}
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                      {a.responseStatus === 'accepted' ? 'accepted'
                        : a.responseStatus === 'declined' ? 'declined'
                        : a.responseStatus === 'tentative' ? 'maybe'
                        : 'pending'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Meeting prep brief */}
          {briefText && (
            <div className="rounded-lg p-3"
              style={{ background: 'var(--accent-muted, rgba(99,102,241,0.08))', border: '1px solid var(--accent-muted, rgba(99,102,241,0.15))' }}>
              <div className="flex items-center gap-1.5 mb-2">
                <FileText size={12} style={{ color: 'var(--accent)' }} />
                <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--accent)' }}>
                  Meeting Prep
                </span>
              </div>
              <p className="text-[11px] leading-relaxed whitespace-pre-wrap"
                style={{ color: 'var(--text-secondary)' }}>
                {briefText}
              </p>
            </div>
          )}

          {/* Description */}
          {event.body && (
            <div>
              <p className="text-[11px] font-semibold mb-1" style={{ color: 'var(--text-tertiary)' }}>Description</p>
              <p className="text-[12px] leading-relaxed whitespace-pre-wrap"
                style={{ color: 'var(--text-secondary)' }}>
                {event.body}
              </p>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 py-3 flex items-center justify-between"
          style={{ borderTop: '1px solid var(--border-default)' }}>
          <div>
            {event.url && (
              <a href={event.url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-[11px] hover:underline"
                style={{ color: 'var(--accent)' }}>
                <ExternalLink size={11} />
                Open in Google Calendar
              </a>
            )}
          </div>
          {isNative && (
            <div className="flex items-center gap-2">
              <button onClick={() => setShowEdit(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium hover:opacity-80"
                style={{ color: 'var(--text-secondary)', background: 'var(--surface-container-highest, var(--bg-surface))' }}>
                <Edit2 size={11} />
                Edit
              </button>
              <button onClick={handleDelete} disabled={deleting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium hover:opacity-80"
                style={{ color: 'var(--status-red)', background: 'var(--surface-container-highest, var(--bg-surface))', opacity: deleting ? 0.5 : 1 }}>
                <Trash2 size={11} />
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
