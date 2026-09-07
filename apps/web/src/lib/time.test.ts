import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dateKeyInUserTimezone,
  formatCalendarDateLong,
  formatEventTime,
  setUserTimezone,
  timePartsInUserTimezone,
  userWallTimeToIso,
  wallTimePartsInUserTimezone,
} from './time';

test('calendar instants use the selected profile timezone consistently', () => {
  setUserTimezone('America/Los_Angeles');
  const instant = '2026-07-18T05:45:00.000Z';

  assert.equal(dateKeyInUserTimezone(instant), '2026-07-17');
  assert.equal(formatEventTime(instant), '10:45 PM');
  assert.deepEqual(timePartsInUserTimezone(instant), { hour: 22, minute: 45 });
  assert.equal(formatCalendarDateLong('2026-07-17'), 'Friday, July 17, 2026');
});

test('date-only calendar labels never roll into an adjacent timezone day', () => {
  setUserTimezone('Asia/Calcutta');
  assert.equal(formatCalendarDateLong('2026-07-18'), 'Saturday, July 18, 2026');
});

test('calendar wall time is persisted as an instant in the selected profile timezone', () => {
  setUserTimezone('Asia/Calcutta');
  const instant = userWallTimeToIso('2026-09-09', '09:00');

  assert.equal(instant, '2026-09-09T03:30:00.000Z');
  assert.deepEqual(wallTimePartsInUserTimezone(instant), {
    date: '2026-09-09',
    time: '09:00',
  });
});

test('calendar wall time conversion observes daylight-saving offsets', () => {
  setUserTimezone('America/Los_Angeles');
  assert.equal(userWallTimeToIso('2026-07-18', '09:00'), '2026-07-18T16:00:00.000Z');
});

test('calendar wall time handles UTC and rejects the daylight-saving gap', () => {
  setUserTimezone('UTC');
  assert.equal(userWallTimeToIso('2026-09-09', '09:00'), '2026-09-09T09:00:00.000Z');
  setUserTimezone('America/Los_Angeles');
  assert.throws(() => userWallTimeToIso('2026-03-08', '02:30'), /does not exist/);
  const repeated = userWallTimeToIso('2026-11-01', '01:30');
  assert.deepEqual(wallTimePartsInUserTimezone(repeated), { date: '2026-11-01', time: '01:30' });
});
