// ═══ Shared Calendar Types & Helpers ═══

export type CalTask = {
  id: string; number: number; title: string; status: string; priority: string;
  due_date: string; project_prefix: string; project_color: string | null;
};

export type CalEvent = {
  id: string; title: string; body?: string | null; event_type: string; url: string | null;
  timestamp: string; metadata: any; source: string;
};

export type CalNote = { id: string; title: string; icon: string | null; created_at: string };

export type CalReminder = { id: string; message: string; remind_at: string; is_sent: boolean };

export type DayBucket = { tasks: CalTask[]; events: CalEvent[]; notes: CalNote[]; reminders: CalReminder[] };

export type CalendarData = { tasks: CalTask[]; events: CalEvent[]; notes: CalNote[]; reminders?: CalReminder[] };

export type CalendarView = 'month' | 'week' | 'day';

export type CalBrief = { id: string; event_id: string; brief_text: string; created_at: string };

// ═══ Constants ═══

export const CAL_DAYS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const CAL_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const HOURS = Array.from({ length: 24 }, (_, i) => i);

export const ITEM_COLORS = {
  event: '#22c55e',
  task: '#3b82f6',
  note: '#f97316',
  reminder: '#a855f7',
} as const;

// ═══ Helpers ═══

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function buildMonthGrid(firstOfMonth: Date): Date[] {
  const startDow = firstOfMonth.getDay();
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - startDow);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push(d);
  }
  return cells;
}

export function buildWeekDates(dateInWeek: Date): Date[] {
  const d = new Date(dateInWeek);
  const dow = d.getDay();
  d.setDate(d.getDate() - dow); // Sunday
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(d);
    day.setDate(d.getDate() + i);
    days.push(day);
  }
  return days;
}

export function bucketByDay(data: CalendarData): Map<string, DayBucket> {
  const buckets = new Map<string, DayBucket>();
  const ensure = (k: string) => {
    if (!buckets.has(k)) buckets.set(k, { tasks: [], events: [], notes: [], reminders: [] });
    return buckets.get(k)!;
  };
  for (const t of data.tasks) {
    if (!t.due_date) continue;
    ensure(toDateKey(new Date(t.due_date))).tasks.push(t);
  }
  for (const e of data.events) {
    ensure(toDateKey(new Date(e.timestamp))).events.push(e);
  }
  for (const n of data.notes) {
    ensure(toDateKey(new Date(n.created_at))).notes.push(n);
  }
  for (const r of (data.reminders || [])) {
    ensure(toDateKey(new Date(r.remind_at))).reminders.push(r);
  }
  return buckets;
}

export function getDateRangeForView(view: CalendarView, anchor: Date): { from: Date; to: Date } {
  if (view === 'month') {
    const grid = buildMonthGrid(anchor);
    const from = new Date(grid[0]);
    from.setHours(0, 0, 0, 0);
    const to = new Date(grid[grid.length - 1]);
    to.setHours(23, 59, 59, 999);
    return { from, to };
  }
  if (view === 'week') {
    const week = buildWeekDates(anchor);
    const from = new Date(week[0]);
    from.setHours(0, 0, 0, 0);
    const to = new Date(week[6]);
    to.setHours(23, 59, 59, 999);
    return { from, to };
  }
  // day
  const from = new Date(anchor);
  from.setHours(0, 0, 0, 0);
  const to = new Date(anchor);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

/** Format hour number to label: 0 → "12 AM", 13 → "1 PM" */
export function formatHourLabel(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
}
