'use client';

import { CalEvent, DayBucket, ITEM_COLORS } from '@/lib/calendar';
import { formatFullDateLong, formatEventTime } from '@/lib/time';
import { X, ExternalLink, MapPin, Users, CheckCircle2, Circle, FileText } from 'lucide-react';
import Link from 'next/link';

const PRIORITY_COLORS: Record<string, string> = {
  p0: 'var(--status-red)', p1: 'var(--status-amber)', p2: 'var(--status-blue)', p3: 'var(--status-gray)',
};

export function DayDetailPanel({
  dateKey, bucket, onClose, briefs, onEventClick,
}: {
  dateKey: string;
  bucket: DayBucket | null;
  onClose: () => void;
  briefs?: Map<string, string>;
  onEventClick?: (event: CalEvent) => void;
}) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dateLabel = formatFullDateLong(date);
  const events = bucket?.events || [];
  const tasks = bucket?.tasks || [];
  const notes = bucket?.notes || [];
  const remindersList = bucket?.reminders || [];
  const isEmpty = events.length + tasks.length + notes.length + remindersList.length === 0;

  return (
    <div
      className="flex-shrink-0 w-[320px] h-full overflow-y-auto border-l"
      style={{
        background: 'var(--surface-container-low)',
        borderColor: 'var(--border-default)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b"
        style={{ borderColor: 'var(--border-default)' }}>
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {dateLabel}
        </span>
        <button onClick={onClose} className="p-1 rounded hover:opacity-70"
          style={{ color: 'var(--text-tertiary)' }}>
          <X size={14} />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {isEmpty && (
          <p className="text-[12px] text-center py-6" style={{ color: 'var(--text-tertiary)' }}>
            Nothing on this day
          </p>
        )}

        {/* Events */}
        {events.length > 0 && (
          <Section title="Events" color={ITEM_COLORS.event}>
            {events.map((e) => {
              const startTime = formatEventTime(e.metadata?.start || e.timestamp);
              const endTime = e.metadata?.end ? formatEventTime(e.metadata.end) : null;
              const briefText = briefs?.get(e.id);
              return (
                <div key={e.id}
                  className="space-y-1 py-2 border-b last:border-b-0 cursor-pointer hover:opacity-80"
                  style={{ borderColor: 'var(--border-default)' }}
                  onClick={() => onEventClick?.(e)}>
                  <div className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                      style={{ background: ITEM_COLORS.event }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                        {e.title}
                      </p>
                      <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        {startTime}{endTime ? ` – ${endTime}` : ''}
                        {e.metadata?.allDay ? ' (All day)' : ''}
                      </p>
                    </div>
                    {briefText && (
                      <FileText size={12} className="flex-shrink-0 mt-1" style={{ color: 'var(--accent)' }} />
                    )}
                    {e.url && (
                      <a href={e.url} target="_blank" rel="noopener noreferrer"
                        className="p-0.5 hover:opacity-70" style={{ color: 'var(--text-tertiary)' }}
                        onClick={(ev) => ev.stopPropagation()}>
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                  {e.metadata?.location && (
                    <div className="flex items-center gap-1.5 ml-3.5 text-[10px]"
                      style={{ color: 'var(--text-tertiary)' }}>
                      <MapPin size={10} />
                      <span>{e.metadata.location}</span>
                    </div>
                  )}
                  {e.metadata?.attendees?.length > 0 && (
                    <div className="flex items-center gap-1.5 ml-3.5 text-[10px]"
                      style={{ color: 'var(--text-tertiary)' }}>
                      <Users size={10} />
                      <span>{e.metadata.attendees.length} attendees</span>
                    </div>
                  )}
                  {briefText && (
                    <div className="ml-3.5 mt-1 p-2 rounded text-[10px] leading-relaxed"
                      style={{ background: 'var(--accent-muted, rgba(99,102,241,0.08))', color: 'var(--text-secondary)' }}>
                      <div className="flex items-center gap-1 mb-1 text-[9px] font-semibold uppercase tracking-wider"
                        style={{ color: 'var(--accent)' }}>
                        <FileText size={9} /> Meeting Prep
                      </div>
                      {briefText.slice(0, 200)}{briefText.length > 200 ? '...' : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </Section>
        )}

        {/* Tasks */}
        {tasks.length > 0 && (
          <Section title="Tasks" color={ITEM_COLORS.task}>
            {tasks.map((t) => (
              <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`}
                className="flex items-center gap-2 py-1.5 hover:opacity-80 border-b last:border-b-0"
                style={{ borderColor: 'var(--border-default)' }}>
                {t.status === 'done'
                  ? <CheckCircle2 size={12} style={{ color: 'var(--status-green)' }} />
                  : <Circle size={12} style={{ color: PRIORITY_COLORS[t.priority] || 'var(--text-tertiary)' }} />}
                <span className="text-[12px] truncate flex-1" style={{
                  color: 'var(--text-primary)',
                  textDecoration: t.status === 'done' ? 'line-through' : 'none',
                  opacity: t.status === 'done' ? 0.5 : 1,
                }}>
                  {t.title}
                </span>
                <span className="text-[9px] font-mono flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                  {t.project_prefix}-{t.number}
                </span>
              </Link>
            ))}
          </Section>
        )}

        {/* Notes */}
        {notes.length > 0 && (
          <Section title="Notes" color={ITEM_COLORS.note}>
            {notes.map((n) => (
              <Link key={n.id} href={`/notes?id=${n.id}`}
                className="flex items-center gap-2 py-1.5 hover:opacity-80 border-b last:border-b-0"
                style={{ borderColor: 'var(--border-default)' }}>
                <span className="text-[11px]">{n.icon || '\uD83D\uDCC4'}</span>
                <span className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>
                  {n.title || 'Untitled'}
                </span>
              </Link>
            ))}
          </Section>
        )}

        {/* Reminders */}
        {remindersList.length > 0 && (
          <Section title="Reminders" color={ITEM_COLORS.reminder}>
            {remindersList.map((r) => (
              <div key={r.id} className="flex items-center gap-2 py-1.5 border-b last:border-b-0"
                style={{ borderColor: 'var(--border-default)' }}>
                <span className="text-[11px]">⏰</span>
                <div className="flex-1 min-w-0">
                  <span className="text-[12px] truncate block" style={{ color: 'var(--text-primary)' }}>
                    {r.message}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                    {new Date(r.remind_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-2 h-2 rounded-full" style={{ background: color }} />
        <span className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-tertiary)' }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}
