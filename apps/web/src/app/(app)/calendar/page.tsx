'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import {
  CalendarView, CalendarData, CalEvent, DayBucket,
  bucketByDay, getDateRangeForView, toDateKey,
} from '@/lib/calendar';
import { CalendarHeader } from '@/components/calendar/calendar-header';
import { MonthView } from '@/components/calendar/month-view';
import { WeekView } from '@/components/calendar/week-view';
import { DayView } from '@/components/calendar/day-view';
import { DayDetailPanel } from '@/components/calendar/day-detail-panel';
import { CreateEventModal } from '@/components/calendar/create-event-modal';
import { EventDetailModal } from '@/components/calendar/event-detail-modal';
import { Loader2 } from 'lucide-react';

export default function CalendarPage() {
  const [view, setView] = useState<CalendarView>('month');
  const [anchor, setAnchor] = useState<Date>(() =>
    view === 'month'
      ? new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      : new Date()
  );
  const [calData, setCalData] = useState<CalendarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean | null>(null);

  // Feature 2: Sync
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Feature 3: Briefs
  const [briefs, setBriefs] = useState<Map<string, string>>(new Map());

  // Feature 4: Create event modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createDefaults, setCreateDefaults] = useState<{ date?: string; start?: string; end?: string }>({});

  // Feature 7: Event detail modal
  const [selectedEvent, setSelectedEvent] = useState<CalEvent | null>(null);

  // ── Data fetching ──

  const refetchCalData = useCallback(async () => {
    const { from, to } = getDateRangeForView(view, anchor);
    const res = await api.get(`/api/calendar?from=${from.toISOString()}&to=${to.toISOString()}`);
    if (res.ok) setCalData(await res.json());
  }, [view, anchor]);

  useEffect(() => {
    setLoading(true);
    refetchCalData().finally(() => setLoading(false));
  }, [refetchCalData]);

  // Check connection status once
  useEffect(() => {
    api.get('/api/connections').then(async (res) => {
      if (res.ok) {
        const conns = await res.json();
        setIsConnected(
          Array.isArray(conns) && conns.some(
            (c: any) => c.provider === 'google_calendar' && c.status === 'connected'
          )
        );
      }
    }).catch(() => {});
  }, []);

  // ── Feature 3: Fetch briefs for visible events ──

  useEffect(() => {
    if (!calData?.events.length) { setBriefs(new Map()); return; }
    const eventIds = calData.events.map((e) => e.id).join(',');
    api.get(`/api/calendar/briefs?event_ids=${eventIds}`).then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        const map = new Map<string, string>();
        for (const b of data.briefs) map.set(b.event_id, b.brief_text);
        setBriefs(map);
      }
    }).catch(() => {});
  }, [calData]);

  // Socket listener for real-time briefs
  useEffect(() => {
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);
    const handler = (data: { event_id: string; brief_text: string }) => {
      setBriefs((prev) => new Map(prev).set(data.event_id, data.brief_text));
    };
    socket.on('meeting-brief:new', handler);
    return () => { socket.off('meeting-brief:new', handler); };
  }, []);

  // ── Toast auto-dismiss ──

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // ── Computed ──

  const buckets = calData ? bucketByDay(calData) : new Map<string, DayBucket>();
  const selectedBucket = selectedDay ? buckets.get(selectedDay) || null : null;

  // ── Navigation ──

  const goPrev = useCallback(() => {
    setAnchor((prev) => {
      const d = new Date(prev);
      if (view === 'month') d.setMonth(d.getMonth() - 1);
      else if (view === 'week') d.setDate(d.getDate() - 7);
      else d.setDate(d.getDate() - 1);
      return d;
    });
    setSelectedDay(null);
  }, [view]);

  const goNext = useCallback(() => {
    setAnchor((prev) => {
      const d = new Date(prev);
      if (view === 'month') d.setMonth(d.getMonth() + 1);
      else if (view === 'week') d.setDate(d.getDate() + 7);
      else d.setDate(d.getDate() + 1);
      return d;
    });
    setSelectedDay(null);
  }, [view]);

  const goToday = useCallback(() => {
    const now = new Date();
    setAnchor(view === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1) : now);
    setSelectedDay(null);
  }, [view]);

  const handleViewChange = useCallback((v: CalendarView) => {
    setView(v);
    if (v === 'month') {
      setAnchor((prev) => new Date(prev.getFullYear(), prev.getMonth(), 1));
    } else {
      // When switching to week or day view, anchor on today
      setAnchor(new Date());
    }
    setSelectedDay(null);
  }, []);

  const handleSelectDay = useCallback((dateKey: string) => {
    setSelectedDay((prev) => (prev === dateKey ? null : dateKey));
  }, []);

  const handleDrillDown = useCallback((dateKey: string) => {
    const [y, m, d] = dateKey.split('-').map(Number);
    setAnchor(new Date(y, m - 1, d));
    setView('day');
    setSelectedDay(null);
  }, []);

  // ── Feature 2: Sync ──

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await api.post('/api/connections/google_calendar/sync');
      if (res.ok) {
        const data = await res.json();
        setToast(`Synced ${data.synced} events`);
        await refetchCalData();
      } else {
        setToast('Sync failed');
      }
    } catch { setToast('Sync failed'); }
    finally { setSyncing(false); }
  }, [refetchCalData]);

  // ── Feature 4: Create event ──

  const handleNewEvent = useCallback(() => {
    setCreateDefaults({});
    setShowCreateModal(true);
  }, []);

  const handleSlotClick = useCallback((dateKey: string, hour: number) => {
    setCreateDefaults({
      date: dateKey,
      start: `${String(hour).padStart(2, '0')}:00`,
      end: `${String(Math.min(hour + 1, 23)).padStart(2, '0')}:00`,
    });
    setShowCreateModal(true);
  }, []);

  const handleEventCreated = useCallback(async () => {
    setShowCreateModal(false);
    setToast('Event created');
    await refetchCalData();
  }, [refetchCalData]);

  // ── Feature 6: Drag to reschedule tasks ──

  const handleTaskReschedule = useCallback(async (taskId: string, newDateKey: string) => {
    const [y, m, d] = newDateKey.split('-').map(Number);
    const newDate = new Date(y, m - 1, d);
    const res = await api.patch(`/api/tasks/${taskId}`, { due_date: newDate.toISOString() });
    if (res.ok) {
      setCalData((prev) => {
        if (!prev) return prev;
        return { ...prev, tasks: prev.tasks.map((t) => t.id === taskId ? { ...t, due_date: newDate.toISOString() } : t) };
      });
      setToast('Task rescheduled');
    }
  }, []);

  // ── Feature 7: Event click ──

  const handleEventClick = useCallback((event: CalEvent) => {
    setSelectedEvent(event);
  }, []);

  const handleEventDeleted = useCallback(async () => {
    setSelectedEvent(null);
    setToast('Event deleted');
    await refetchCalData();
  }, [refetchCalData]);

  const handleEventUpdated = useCallback(async () => {
    setSelectedEvent(null);
    setToast('Event updated');
    await refetchCalData();
  }, [refetchCalData]);

  // ── Render ──

  return (
    <div className="flex flex-1 h-full min-h-0 overflow-hidden">
      {/* Main calendar area */}
      <div className="flex flex-col flex-1 min-w-0 p-4">
        <CalendarHeader
          view={view}
          anchor={anchor}
          onPrev={goPrev}
          onNext={goNext}
          onToday={goToday}
          onViewChange={handleViewChange}
          isConnected={isConnected}
          onSync={handleSync}
          syncing={syncing}
          onNewEvent={handleNewEvent}
        />

        {loading ? (
          <div className="flex items-center justify-center flex-1">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
          </div>
        ) : (
          <>
            {view === 'month' && (
              <MonthView
                anchor={anchor}
                buckets={buckets}
                selectedDay={selectedDay}
                onSelectDay={handleSelectDay}
                onDrillDown={handleDrillDown}
                briefs={briefs}
                onTaskReschedule={handleTaskReschedule}
                onEventClick={handleEventClick}
              />
            )}
            {view === 'week' && (
              <WeekView
                anchor={anchor}
                buckets={buckets}
                selectedDay={selectedDay}
                onSelectDay={handleSelectDay}
                onSlotClick={handleSlotClick}
                onEventClick={handleEventClick}
              />
            )}
            {view === 'day' && (
              <DayView
                anchor={anchor}
                bucket={buckets.get(toDateKey(anchor))}
                onSlotClick={handleSlotClick}
                onEventClick={handleEventClick}
              />
            )}
          </>
        )}
      </div>

      {/* Detail panel */}
      {selectedDay && (
        <DayDetailPanel
          dateKey={selectedDay}
          bucket={selectedBucket}
          onClose={() => setSelectedDay(null)}
          briefs={briefs}
          onEventClick={handleEventClick}
        />
      )}

      {/* Create event modal */}
      {showCreateModal && (
        <CreateEventModal
          onClose={() => setShowCreateModal(false)}
          onCreated={handleEventCreated}
          defaultDate={createDefaults.date}
          defaultStart={createDefaults.start}
          defaultEnd={createDefaults.end}
        />
      )}

      {/* Event detail modal */}
      {selectedEvent && (
        <EventDetailModal
          event={selectedEvent}
          briefText={briefs.get(selectedEvent.id)}
          onClose={() => setSelectedEvent(null)}
          onDeleted={handleEventDeleted}
          onUpdated={handleEventUpdated}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg text-[12px] font-medium"
          style={{ background: 'var(--foreground)', color: 'var(--background)' }}>
          {toast}
        </div>
      )}
    </div>
  );
}
