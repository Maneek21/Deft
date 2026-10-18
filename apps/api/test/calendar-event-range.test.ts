import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCalendarEventRange } from '../src/lib/calendar-event-range.js';

test('rejects edits moving either endpoint across its unchanged counterpart', () => {
  assert.deepEqual(validateCalendarEventRange('2026-10-07T14:00:00Z', '2026-10-07T13:30:00Z'),
    { ok: false, error: 'end must be after start', code: 'INVALID_RANGE' });
  assert.equal(validateCalendarEventRange('2026-10-07T13:00:00Z', '2026-10-07T12:00:00Z').ok, false);
});
test('rejects zero duration and malformed endpoints before timestamp serialization', () => {
  for (const [start, end] of [['invalid', '2026-10-07T14:00:00Z'], ['2026-10-07T13:00:00Z', ''], ['2026-10-07T13:00:00Z', 'invalid']]) {
    const r = validateCalendarEventRange(start!, end!);
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.code, 'INVALID_DATE');
  }
  const same = validateCalendarEventRange('2026-10-07T13:00:00Z', '2026-10-07T13:00:00Z');
  assert.equal(same.ok, false); if (!same.ok) assert.equal(same.code, 'INVALID_RANGE');
});
test('compares timezone-aware instants and permits overnight meetings', () => {
  const r = validateCalendarEventRange('2026-10-07T23:30:00+05:30', '2026-10-08T00:30:00+05:30');
  assert.equal(r.ok, true); if (r.ok) assert.equal(r.end.getTime() - r.start.getTime(), 3600000);
  assert.equal(validateCalendarEventRange('2026-10-07T13:30:00+05:30', '2026-10-07T08:00:00Z').ok, false);
});
