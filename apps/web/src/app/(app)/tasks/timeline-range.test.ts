import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTimelineRange, localDayDiff, parseLocalDate, resizeTimelineDates, shiftTimelineDates, timelineBarGeometry, toLocalDateKey } from './timeline-range';

test('parses date keys without timezone drift and rejects invalid dates', () => {
  assert.equal(toLocalDateKey(parseLocalDate('2026-03-08')!), '2026-03-08');
  assert.equal(parseLocalDate('2026-02-30'), null);
});

test('uses stable fallback and fixed four/eight week ranges', () => {
  const anchor = new Date(2026, 6, 14);
  assert.equal(buildTimelineRange([], 'fit', anchor).totalDays, 28);
  assert.equal(buildTimelineRange([], '4w', anchor).totalDays, 28);
  assert.equal(buildTimelineRange([], '8w', anchor).totalDays, 56);
});

test('fit range covers project work with padding and a 28-day minimum', () => {
  const range = buildTimelineRange([{ start_date: '2026-07-10', due_date: '2026-07-12' }], 'fit', new Date(2026, 6, 14));
  assert.equal(toLocalDateKey(range.start), '2026-07-03');
  assert.equal(range.totalDays, 28);
});

test('bar geometry clips work at both range edges', () => {
  const range = buildTimelineRange([], '4w', new Date(2026, 6, 14));
  const clipped = timelineBarGeometry({ start_date: '2026-07-01', due_date: '2026-07-15' }, range);
  assert.equal(clipped.visible, true);
  assert.equal(clipped.before, true);
  assert.ok(clipped.width > 0);
  assert.equal(timelineBarGeometry({ start_date: '2025-01-01', due_date: '2025-01-02' }, range).before, true);
});

test('rescheduling preserves duration across DST boundaries', () => {
  const shifted = shiftTimelineDates({ start_date: '2026-03-07', due_date: '2026-03-09' }, 2);
  assert.deepEqual(shifted, { start_date: '2026-03-09', due_date: '2026-03-11' });
  assert.equal(localDayDiff(parseLocalDate(shifted.start_date)!, parseLocalDate(shifted.due_date)!), 2);
});

test('a due-only task moves only its due date', () => {
  assert.deepEqual(shiftTimelineDates({ start_date: null, due_date: '2026-07-14' }, -3), { start_date: null, due_date: '2026-07-11' });
});

test('resizes start and due dates independently', () => {
  const task = { start_date: '2026-07-10', due_date: '2026-07-14' };
  assert.deepEqual(resizeTimelineDates(task, 'start', -2), { start_date: '2026-07-08', due_date: '2026-07-14' });
  assert.deepEqual(resizeTimelineDates(task, 'end', 3), { start_date: '2026-07-10', due_date: '2026-07-17' });
});

test('edge resizing cannot invert a task range', () => {
  const task = { start_date: '2026-07-10', due_date: '2026-07-14' };
  assert.deepEqual(resizeTimelineDates(task, 'start', 10), { start_date: '2026-07-14', due_date: '2026-07-14' });
  assert.deepEqual(resizeTimelineDates(task, 'end', -10), { start_date: '2026-07-10', due_date: '2026-07-10' });
});

test('resizing a single-ended task creates the missing boundary', () => {
  assert.deepEqual(resizeTimelineDates({ start_date: null, due_date: '2026-07-14' }, 'start', -3), { start_date: '2026-07-11', due_date: '2026-07-14' });
  assert.deepEqual(resizeTimelineDates({ start_date: '2026-07-10', due_date: null }, 'end', 4), { start_date: '2026-07-10', due_date: '2026-07-14' });
});
