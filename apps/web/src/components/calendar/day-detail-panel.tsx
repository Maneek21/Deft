'use client';

import { CalEvent, DayBucket, ITEM_COLORS, getEventSourceColor, getEventSourceLabel } from '@/lib/calendar';
import { formatFullDateLong, formatEventTime } from '@/lib/time';
import { X, ExternalLink, MapPin, Users, CheckCircle2, Circle, FileText, Bell } from 'lucide-react';
import Link from 'next/link';

const PRIORITY_COLORS: Record<string, string> = {
  p0: 'var(--status-red)',
  p1: 'var(--status-amber)',
  p2: 'var(--status-blue)',
  p3: 'var(--status-gray)',
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
    <>
      <button
        type="button"
        aria-label="Close day details"
        className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px] md:hidden"
        onClick={onClose}
      />
      <aside
        className="fixed inset-x-0 bottom-0 z-50 flex max-h-[82svh] flex-col overflow-hidden rounded-t-[24px] border-t shadow-2xl md:static md:z-auto md:h-full md:max-h-none md:w-[340px] md:flex-shrink-0 md:rounded-none md:border-l md:border-t-0 md:shadow-none"
        style={{
          background: 'var(--surface-container-low)',
          borderColor: 'var(--border-default)',
        }}
      >
        <div className="flex justify-center pt-2 md:hidden">
          <div className="h-1 w-10 rounded-full" style={{ background: 'var(--border-strong)' }} />
        </div>

        <div className="flex items-center justify-between border-b px-4 pb-3 pt-3 md:pt-4"
          style={{ borderColor: 'var(--border-default)' }}>
          <div className="min-w-0">
            <span className="block truncate text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {dateLabel}
            </span>
            <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              {events.length} events, {tasks.length} tasks, {notes.length} notes
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-colors hover:opacity-80"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {isEmpty && (
            <p className="py-6 text-center text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
              Nothing on this day
            </p>
          )}

          {events.length > 0 && (
            <Section title="Events" color={ITEM_COLORS.event}>
              {events.map((e) => {
                const startTime = formatEventTime(e.metadata?.start || e.timestamp);
                const endTime = e.metadata?.end ? formatEventTime(e.metadata.end) : null;
                const briefText = briefs?.get(e.id);
                const eventColor = getEventSourceColor(e.source);
                const attendeeCount = e.metadata?.attendees?.length || 0;

                return (
                  <div
                    key={e.id}
                    className="space-y-2 rounded-2xl border p-3 transition-colors hover:opacity-90"
                    style={{
                      borderColor: 'var(--border-default)',
                      background: 'var(--surface-container)',
                    }}
                    onClick={() => onEventClick?.(e)}
                  >
                    <div className="flex items-start gap-2">
                      <div className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full"
                        style={{ background: eventColor }} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>
                          {e.title}
                        </p>
                        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                          {startTime}{endTime ? ` - ${endTime}` : ''}
                          {e.metadata?.allDay ? ' (All day)' : ''}
                        </p>
                        <p className="text-[10px] font-medium" style={{ color: 'var(--text-tertiary)' }}>
                          {getEventSourceLabel(e)}
                        </p>
                      </div>
                      {briefText && (
                        <FileText size={12} className="mt-1 flex-shrink-0" style={{ color: 'var(--accent)' }} />
                      )}
                      {e.url && (
                        <a
                          href={e.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-0.5 hover:opacity-70"
                          style={{ color: 'var(--text-tertiary)' }}
                          onClick={(ev) => ev.stopPropagation()}
                        >
                          <ExternalLink size={12} />
                        </a>
                      )}
                    </div>

                    {e.metadata?.location && (
                      <div className="ml-4 flex items-center gap-1.5 text-[11px]"
                        style={{ color: 'var(--text-tertiary)' }}>
                        <MapPin size={10} />
                        <span>{e.metadata.location}</span>
                      </div>
                    )}
                    {attendeeCount > 0 && (
                      <div className="ml-4 flex items-center gap-1.5 text-[11px]"
                        style={{ color: 'var(--text-tertiary)' }}>
                        <Users size={10} />
                        <span>{attendeeCount} attendees</span>
                      </div>
                    )}
                    {briefText && (
                      <div className="ml-4 mt-1 rounded-xl p-2 text-[10px] leading-relaxed"
                        style={{ background: 'var(--accent-muted, rgba(99,102,241,0.08))', color: 'var(--text-secondary)' }}>
                        <div className="mb-1 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider"
                          style={{ color: 'var(--accent)' }}>
                          <FileText size={9} /> Meeting prep
                        </div>
                        {briefText.slice(0, 200)}{briefText.length > 200 ? '...' : ''}
                      </div>
                    )}
                  </div>
                );
              })}
            </Section>
          )}

          {tasks.length > 0 && (
            <Section title="Tasks" color={ITEM_COLORS.task}>
              {tasks.map((t) => (
                <Link
                  key={t.id}
                  href={`/tasks?task=${t.project_prefix}-${t.number}`}
                  className="flex items-center gap-2 rounded-2xl border p-3 transition-colors hover:opacity-90"
                  style={{ borderColor: 'var(--border-default)', background: 'var(--surface-container)' }}
                >
                  {t.status === 'done'
                    ? <CheckCircle2 size={12} style={{ color: 'var(--status-green)' }} />
                    : <Circle size={12} style={{ color: PRIORITY_COLORS[t.priority] || 'var(--text-tertiary)' }} />}
                  <span className="min-w-0 flex-1 truncate text-[12px]" style={{
                    color: 'var(--text-primary)',
                    textDecoration: t.status === 'done' ? 'line-through' : 'none',
                    opacity: t.status === 'done' ? 0.5 : 1,
                  }}>
                    {t.title}
                  </span>
                  <span className="flex-shrink-0 font-mono text-[9px]" style={{ color: 'var(--text-tertiary)' }}>
                    {t.project_prefix}-{t.number}
                  </span>
                </Link>
              ))}
            </Section>
          )}

          {notes.length > 0 && (
            <Section title="Notes" color={ITEM_COLORS.note}>
              {notes.map((n) => (
                <Link
                  key={n.id}
                  href={`/notes?id=${n.id}`}
                  className="flex items-center gap-2 rounded-2xl border p-3 transition-colors hover:opacity-90"
                  style={{ borderColor: 'var(--border-default)', background: 'var(--surface-container)' }}
                >
                  <span className="text-[11px]">{n.icon || '\uD83D\uDCC4'}</span>
                  <span className="truncate text-[12px]" style={{ color: 'var(--text-primary)' }}>
                    {n.title || 'Untitled'}
                  </span>
                </Link>
              ))}
            </Section>
          )}

          {remindersList.length > 0 && (
            <Section title="Reminders" color={ITEM_COLORS.reminder}>
              {remindersList.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-2 rounded-2xl border p-3"
                  style={{ borderColor: 'var(--border-default)', background: 'var(--surface-container)' }}
                >
                  <Bell size={12} style={{ color: ITEM_COLORS.reminder }} />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[12px]" style={{ color: 'var(--text-primary)' }}>
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
      </aside>
    </>
  );
}

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <div className="h-2 w-2 rounded-full" style={{ background: color }} />
        <span className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-tertiary)' }}>
          {title}
        </span>
      </div>
      <div className="space-y-2">
        {children}
      </div>
    </section>
  );
}
