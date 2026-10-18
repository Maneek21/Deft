/** Validate the effective range, including the unchanged half of a partial edit. */
export function validateCalendarEventRange(start: string, end: string):
  | { ok: true; start: Date; end: Date }
  | { ok: false; error: string; code: 'INVALID_DATE' | 'INVALID_RANGE' } {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return { ok: false, error: 'Invalid date format', code: 'INVALID_DATE' };
  }
  if (endDate <= startDate) {
    return { ok: false, error: 'end must be after start', code: 'INVALID_RANGE' };
  }
  return { ok: true, start: startDate, end: endDate };
}
