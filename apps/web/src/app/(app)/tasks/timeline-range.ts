export type TimelineRangeMode = 'fit' | '4w' | '8w';

export type TimelineDateTask = {
  start_date: string | null;
  due_date: string | null;
};

export type TimelineRange = {
  start: Date;
  end: Date;
  totalDays: number;
};

const DAY_MS = 86_400_000;

export function parseLocalDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
  return date;
}

export function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addLocalDays(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

export function localDayDiff(left: Date, right: Date): number {
  const leftUtc = Date.UTC(left.getFullYear(), left.getMonth(), left.getDate());
  const rightUtc = Date.UTC(right.getFullYear(), right.getMonth(), right.getDate());
  return Math.round((rightUtc - leftUtc) / DAY_MS);
}

function mondayOf(date: Date): Date {
  const day = date.getDay() || 7;
  return addLocalDays(date, 1 - day);
}

export function buildTimelineRange(tasks: TimelineDateTask[], mode: TimelineRangeMode, anchor = new Date()): TimelineRange {
  const today = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  let start: Date;
  let end: Date;

  if (mode === 'fit') {
    const dates = tasks.flatMap((task) => [parseLocalDate(task.start_date), parseLocalDate(task.due_date)]).filter((date): date is Date => Boolean(date));
    if (dates.length === 0) {
      start = addLocalDays(today, -7);
      end = addLocalDays(today, 20);
    } else {
      start = addLocalDays(new Date(Math.min(...dates.map((date) => date.getTime()))), -7);
      end = addLocalDays(new Date(Math.max(...dates.map((date) => date.getTime()))), 7);
      const missing = 28 - (localDayDiff(start, end) + 1);
      if (missing > 0) end = addLocalDays(end, missing);
    }
  } else {
    start = mondayOf(today);
    end = addLocalDays(start, mode === '4w' ? 27 : 55);
  }

  return { start, end, totalDays: localDayDiff(start, end) + 1 };
}

export function timelineBarGeometry(task: TimelineDateTask, range: TimelineRange) {
  let start = parseLocalDate(task.start_date) ?? parseLocalDate(task.due_date);
  let end = parseLocalDate(task.due_date) ?? start;
  if (!start || !end) return { visible: false, left: 0, width: 0, before: false, after: false };
  if (end < start) [start, end] = [end, start];
  const startOffset = localDayDiff(range.start, start);
  const endOffset = localDayDiff(range.start, end);
  const before = endOffset < 0;
  const after = startOffset >= range.totalDays;
  if (before || after) return { visible: false, left: 0, width: 0, before, after };
  const visibleStart = Math.max(0, startOffset);
  const visibleEnd = Math.min(range.totalDays, endOffset + 1);
  return {
    visible: true,
    left: (visibleStart / range.totalDays) * 100,
    width: Math.max((1 / range.totalDays) * 100, ((visibleEnd - visibleStart) / range.totalDays) * 100),
    before: startOffset < 0,
    after: endOffset >= range.totalDays,
  };
}

export function shiftTimelineDates(task: TimelineDateTask, dayDelta: number): TimelineDateTask {
  if (!dayDelta) return { start_date: task.start_date, due_date: task.due_date };
  const start = parseLocalDate(task.start_date);
  const due = parseLocalDate(task.due_date);
  return {
    start_date: start ? toLocalDateKey(addLocalDays(start, dayDelta)) : task.start_date,
    due_date: due ? toLocalDateKey(addLocalDays(due, dayDelta)) : task.due_date,
  };
}

export function resizeTimelineDates(task: TimelineDateTask, edge: 'start' | 'end', dayDelta: number): TimelineDateTask {
  const start = parseLocalDate(task.start_date);
  const due = parseLocalDate(task.due_date);
  const fallback = start ?? due;
  if (!fallback || !dayDelta) return { start_date: task.start_date, due_date: task.due_date };

  if (edge === 'start') {
    let nextStart = addLocalDays(start ?? fallback, dayDelta);
    if (due && nextStart > due) nextStart = due;
    return { start_date: toLocalDateKey(nextStart), due_date: task.due_date };
  }

  let nextDue = addLocalDays(due ?? fallback, dayDelta);
  if (start && nextDue < start) nextDue = start;
  return { start_date: task.start_date, due_date: toLocalDateKey(nextDue) };
}
