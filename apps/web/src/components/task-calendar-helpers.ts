export type MonthCell = { date: Date | null; iso: string | null };

export function startOfLocalMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function toLocalISO(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function parseLocalISO(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
  return date;
}

export function buildMonthCells(cursor: Date): MonthCell[] {
  const first = startOfLocalMonth(cursor);
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const cells: MonthCell[] = Array.from({ length: first.getDay() }, () => ({ date: null, iso: null }));
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(cursor.getFullYear(), cursor.getMonth(), day);
    cells.push({ date, iso: toLocalISO(date) });
  }
  while (cells.length % 7 !== 0) cells.push({ date: null, iso: null });
  return cells;
}

export function isInCursorMonth(iso: string, cursor: Date): boolean {
  const date = parseLocalISO(iso);
  return Boolean(date && date.getFullYear() === cursor.getFullYear() && date.getMonth() === cursor.getMonth());
}
